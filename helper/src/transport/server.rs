use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use anyhow::Result;
use tokio::{io::split, net::UnixListener, sync::watch};
use tracing::{debug, error, info, warn};

use crate::{
    engine::{HelperState, SharedState},
    protocol::envelope::{parse_request, Response, RpcError},
    transport::{
        codec::{read_frame, write_frame, FrameError},
        dispatcher::{dispatch, Notifier},
    },
    SetLevelFn,
};

pub struct RunConfig {
    pub sim: Option<std::sync::Arc<crate::sim::SimState>>,
}

#[cfg(unix)]
pub async fn run(socket_path: &str, set_level: SetLevelFn) -> Result<()> {
    run_with_config(socket_path, set_level, RunConfig { sim: None }).await
}

#[cfg(unix)]
pub async fn run_with_config(
    socket_path: &str,
    set_level: SetLevelFn,
    config: RunConfig,
) -> Result<()> {
    // Issue #2: parent directory must be private before anything touches the socket path.
    ensure_private_socket_dir(socket_path)?;

    // Issue #1: serialize stale-probe + unlink + bind atomically under a per-path flock.
    // Held until socket identity is captured; released before entering the accept loop.
    let _socket_lock = acquire_socket_lock(socket_path)?;

    // Issue #4: only remove a stale socket; refuse to touch other file types.
    cleanup_stale_socket(socket_path)?;

    // Issue #5: bind inside the private directory; fchmod is defense-in-depth.
    let listener = bind_with_restricted_umask(socket_path)?;
    let socket_id = socket_identity(socket_path).ok_or_else(|| {
        anyhow::anyhow!("failed to stat socket after bind: {socket_path:?}")
    })?;

    // Lock is no longer needed: any concurrent startup racing here will see a live socket.
    drop(_socket_lock);

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let shutdown_tx = Arc::new(shutdown_tx);

    let state: SharedState = Arc::new(HelperState {
        start_time: std::time::Instant::now(),
        set_level,
        shutdown_tx: Arc::clone(&shutdown_tx),
    });

    let connected = Arc::new(AtomicBool::new(false));

    info!(socket = socket_path, "listening");

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        if connected.swap(true, Ordering::SeqCst) {
                            warn!("second connection rejected (single-connection model)");
                            drop(stream);
                            continue;
                        }
                        let state_c = Arc::clone(&state);
                        let connected_c = Arc::clone(&connected);
                        let shutdown_rx_c = shutdown_rx.clone();
                        let sim_c = config.sim.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state_c, shutdown_rx_c, sim_c).await;
                            connected_c.store(false, Ordering::SeqCst);
                        });
                    }
                    Err(e) => error!(error = %e, "accept error"),
                }
            }
            _ = signal_shutdown() => {
                info!("signal received, shutting down");
                break;
            }
            _ = shutdown_rx.changed() => {
                info!("engine.shutdown requested");
                break;
            }
        }
    }

    // Give in-flight writes a moment to drain before closing the socket.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    remove_own_socket(socket_path, socket_id);
    Ok(())
}

/// Remove a stale Unix socket at `path` so we can bind there.
///
/// Probes liveness before unlinking: if a process is actively listening on the socket,
/// startup is refused rather than stealing the path from a live helper.
/// Captures the socket identity before the connect probe and re-checks it before
/// unlinking to close the TOCTOU gap between stale detection and removal.
/// Returns an error (without touching the file) if `path` exists but is NOT a socket.
#[cfg(unix)]
fn cleanup_stale_socket(path: &str) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::fs::MetadataExt;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket() => {
            let probed_id = (meta.dev(), meta.ino());
            match std::os::unix::net::UnixStream::connect(path) {
                Ok(_) => {
                    return Err(anyhow::anyhow!(
                        "socket {path:?} has a live listener; refusing to start a second helper"
                    ));
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::ConnectionRefused
                        || e.kind() == std::io::ErrorKind::NotFound =>
                {
                    // Re-stat before unlinking to close the TOCTOU gap: if another helper
                    // already removed the stale socket and bound a new one, do not unlink it.
                    unlink_if_identity_matches(path, probed_id)?;
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(_) => {
            return Err(anyhow::anyhow!(
                "path {path:?} already exists as a non-socket file; refusing to overwrite"
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // nothing there, fine
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

/// Unlink `path` only if its current `(dev, ino)` identity still matches `probed_id`.
///
/// Returns:
/// - `Ok(true)`  — unlinked successfully.
/// - `Ok(false)` — path already gone before we tried; caller may proceed to bind.
/// - `Err`       — identity changed (another helper replaced the socket) or unlink failed.
#[cfg(unix)]
fn unlink_if_identity_matches(path: &str, probed_id: (u64, u64)) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let current_id = std::fs::symlink_metadata(path)
        .ok()
        .map(|m| (m.dev(), m.ino()));
    match current_id {
        None => Ok(false), // concurrently removed — fine, proceed to bind
        Some(id) if id == probed_id => match std::fs::remove_file(path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(anyhow::anyhow!("failed to remove stale socket {path:?}: {e}")),
        },
        Some(_) => Err(anyhow::anyhow!(
            "socket {path:?} was replaced during stale cleanup; refusing to proceed"
        )),
    }
}

/// Return the `(dev, ino)` identity of the file at `path` without following symlinks.
/// Used to prove ownership of a socket across a potential replacement race.
#[cfg(unix)]
fn socket_identity(path: &str) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path)
        .ok()
        .map(|m| (m.dev(), m.ino()))
}

/// Remove `path` only if it is still the exact socket this process bound.
///
/// Compares `(dev, ino)` identity so a replacement socket created by a newer helper
/// is never deleted by the old helper's shutdown path.
#[cfg(unix)]
fn remove_own_socket(path: &str, identity: (u64, u64)) {
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::fs::MetadataExt;
    let matches = std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_socket() && (m.dev(), m.ino()) == identity)
        .unwrap_or(false);
    if matches {
        let _ = std::fs::remove_file(path);
    }
}

/// Bind a `UnixListener` and immediately tighten its permissions to 0600 via `fchmod`.
///
/// Using `fchmod` on the file descriptor is inherently thread-safe: there is no
/// path-based TOCTOU race, and we don't mutate the process-wide umask (which would
/// race with other threads creating files/dirs in a multi-threaded process).
///
/// The socket exists briefly with the process's current umask permissions before
/// `fchmod` runs. On Linux this window is one `bind(2)` syscall — the fchmod failure
/// path is fatal so a misconfigured environment is surfaced loudly.
#[cfg(unix)]
fn bind_with_restricted_umask(path: &str) -> Result<UnixListener> {
    use std::os::unix::io::AsRawFd;
    let listener = UnixListener::bind(path)?;
    let ret = unsafe { libc::fchmod(listener.as_raw_fd(), 0o600) };
    if ret != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(listener)
}

/// Ensure the socket's parent directory exists and has mode exactly 0700.
///
/// Creates the directory with 0700 if absent. Rejects any pre-existing directory whose
/// mode is not exactly 0700: a traversable parent (e.g. 0755) lets other local users
/// reach the socket path during the bind/fchmod window and attempt a connection while
/// the socket still has default umask permissions.
#[cfg(unix)]
fn ensure_private_socket_dir(socket_path: &str) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let path = std::path::Path::new(socket_path);
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| anyhow::anyhow!("socket path must include a parent directory"))?;
    if !dir.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(dir)
            .map_err(|e| anyhow::anyhow!("failed to create socket directory {dir:?}: {e}"))?;
        return Ok(());
    }
    let meta = std::fs::symlink_metadata(dir)
        .map_err(|e| anyhow::anyhow!("failed to stat socket directory {dir:?}: {e}"))?;
    if !meta.is_dir() {
        return Err(anyhow::anyhow!(
            "socket parent path {dir:?} is not a directory"
        ));
    }
    // Require exactly 0700 for both new and pre-existing directories. A traversable
    // parent (0755) lets other local users reach the socket path during the one-syscall
    // bind/fchmod window while the socket's own mode has not yet been tightened.
    let mode = meta.permissions().mode() & 0o777;
    if mode != 0o700 {
        return Err(anyhow::anyhow!(
            "socket directory {dir:?} has mode 0{mode:o}, must be 0700"
        ));
    }
    Ok(())
}

/// Acquire an exclusive, non-blocking flock on `<socket_path>.lock`.
///
/// The returned `File` holds the lock until dropped. Keeping the file alive (via a named
/// `let _socket_lock = …` binding) serializes the entire stale-probe + unlink + bind
/// sequence so that two concurrent helper startups cannot race on the same socket path.
#[cfg(unix)]
fn acquire_socket_lock(socket_path: &str) -> Result<std::fs::File> {
    use std::os::unix::io::AsRawFd;
    let lock_path = format!("{}.lock", socket_path);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| anyhow::anyhow!("failed to open socket lock {lock_path:?}: {e}"))?;
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if ret != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(file)
}

async fn handle_connection(
    stream: tokio::net::UnixStream,
    state: SharedState,
    mut shutdown_rx: watch::Receiver<bool>,
    sim: Option<std::sync::Arc<crate::sim::SimState>>,
) {
    let (mut reader, writer) = split(stream);
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    let (notifier, mut notify_rx) = Notifier::new();

    // Writer task: drains the Notifier channel until it is closed.
    let writer_c = Arc::clone(&writer);
    let writer_task = tokio::spawn(async move {
        while let Some(bytes) = notify_rx.recv().await {
            let mut w = writer_c.lock().await;
            if let Err(e) = write_frame(&mut *w, &bytes).await {
                error!(error = %e, "write error");
                break;
            }
        }
    });

    // Send engine.ready before reading any client bytes.
    if let Err(e) = notifier.send_engine_ready().await {
        error!(error = %e, "failed to send engine.ready");
        drop(notifier);
        writer_task.await.ok();
        return;
    }

    loop {
        tokio::select! {
            frame_result = read_frame(&mut reader) => {
                match frame_result {
                    Ok(bytes) => {
                        // Issue #3: distinguish notifications (no id) from requests.
                        match parse_request(&bytes) {
                            Ok(req) => {
                                debug!(method = %req.method, "incoming message");
                                if req.is_notification {
                                    // JSON-RPC notifications never get a response.
                                    debug!(method = %req.method, "notification — no response");
                                    continue;
                                }
                                let notifier_c = notifier.clone();
                                let state_c = Arc::clone(&state);
                                match dispatch(req, &state_c, &notifier_c, sim.as_ref()).await {
                                    Some(resp) => {
                                        if let Err(e) = notifier_c.send_response(resp).await {
                                            error!(error = %e, "notifier send error");
                                            break;
                                        }
                                    }
                                    // None = engine.shutdown: response already queued, break.
                                    None => break,
                                }
                            }
                            Err(e) => {
                                let err_resp = Response::error(
                                    None,
                                    RpcError::invalid_request(format!("parse error: {e}")),
                                );
                                let _ = notifier.send_response(err_resp).await;
                            }
                        }
                    }
                    Err(FrameError::TooLarge(n)) => {
                        warn!(bytes = n, "frame too large, closing connection");
                        let err_resp = Response::error(
                            None,
                            RpcError::invalid_request(format!("frame too large: {n} bytes")),
                        );
                        let _ = notifier.send_response(err_resp).await;
                        break;
                    }
                    Err(FrameError::Io(e)) => {
                        if e.kind() != std::io::ErrorKind::UnexpectedEof
                            && e.kind() != std::io::ErrorKind::ConnectionReset
                        {
                            error!(error = %e, "read error");
                        }
                        break;
                    }
                }
            }
            _ = shutdown_rx.changed() => {
                info!("shutdown signaled, closing connection");
                break;
            }
        }
    }

    // Drop Notifier so the writer task drains remaining queued bytes and exits.
    drop(notifier);
    tokio::time::timeout(std::time::Duration::from_secs(2), writer_task)
        .await
        .ok();
}

#[cfg(unix)]
async fn signal_shutdown() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = sigint.recv() => {}
        _ = sigterm.recv() => {}
    }
}

#[cfg(not(unix))]
async fn signal_shutdown() {
    tokio::signal::ctrl_c().await.ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── unlink_if_identity_matches ────────────────────────────────────────────

    #[test]
    fn unlink_if_identity_matches_removes_same_socket() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.sock").to_string_lossy().into_owned();
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let id = socket_identity(&path).unwrap();

        let result = unlink_if_identity_matches(&path, id);
        assert!(result.is_ok(), "must succeed when identity matches");
        assert!(
            std::fs::symlink_metadata(&path).is_err(),
            "socket must be removed when identity matches"
        );
    }

    #[test]
    fn unlink_if_identity_matches_skips_replacement_socket() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.sock").to_string_lossy().into_owned();

        let old = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let old_id = socket_identity(&path).unwrap();

        // Simulate the race: another helper removed the stale socket and bound a new one.
        drop(old);
        std::fs::remove_file(&path).unwrap();
        let _new = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let new_id = socket_identity(&path).unwrap();
        assert_ne!(old_id, new_id, "test invariant: replacement must have different inode");

        // Calling with the old identity must fail, not unlink the replacement.
        let result = unlink_if_identity_matches(&path, old_id);
        assert!(result.is_err(), "must return error when identity changed");
        assert!(
            std::fs::symlink_metadata(&path).is_ok(),
            "replacement socket must survive"
        );
    }

    #[test]
    fn unlink_if_identity_matches_handles_already_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.sock").to_string_lossy().into_owned();
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let id = socket_identity(&path).unwrap();
        drop(listener);
        std::fs::remove_file(&path).unwrap(); // concurrently removed before we act

        let result = unlink_if_identity_matches(&path, id);
        assert!(matches!(result, Ok(false)), "must return Ok(false) when already gone");
    }

    // ── remove_own_socket ─────────────────────────────────────────────────────

    #[test]
    fn remove_own_socket_skips_replacement_socket() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.sock").to_string_lossy().into_owned();

        let old = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let old_id = socket_identity(&path).unwrap();

        drop(old);
        std::fs::remove_file(&path).unwrap();
        let _new = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let new_id = socket_identity(&path).unwrap();
        assert_ne!(old_id, new_id, "test invariant: replacement must have different inode");

        remove_own_socket(&path, old_id);
        assert!(
            std::fs::symlink_metadata(&path).is_ok(),
            "replacement socket must survive old helper's cleanup"
        );
    }

    // ── acquire_socket_lock ───────────────────────────────────────────────────

    #[test]
    fn socket_lock_is_exclusive() {
        use std::os::unix::io::AsRawFd;
        let tmp = tempfile::tempdir().unwrap();
        let socket_path = tmp.path().join("engine.sock").to_string_lossy().into_owned();
        let lock = acquire_socket_lock(&socket_path).unwrap();

        let lock_path = format!("{}.lock", &socket_path);
        let file2 = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        let ret = unsafe { libc::flock(file2.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_ne!(ret, 0, "second lock must fail while first is held");

        drop(lock);
        let ret = unsafe { libc::flock(file2.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(ret, 0, "second lock must succeed after first is released");
    }

    // ── ensure_private_socket_dir ─────────────────────────────────────────────

    #[test]
    fn private_socket_dir_created_with_0700() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let socket_dir = tmp.path().join("cove");
        let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();
        assert!(!socket_dir.exists());
        ensure_private_socket_dir(&socket_path).unwrap();
        let mode = std::fs::metadata(&socket_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "created directory must have mode 0700");
    }

    #[test]
    fn socket_dir_0700_existing_accepted() {
        use std::os::unix::fs::DirBuilderExt;
        let tmp = tempfile::tempdir().unwrap();
        let socket_dir = tmp.path().join("private_dir");
        std::fs::DirBuilder::new().mode(0o700).create(&socket_dir).unwrap();
        let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();
        let result = ensure_private_socket_dir(&socket_path);
        assert!(result.is_ok(), "must succeed for existing 0700 directory");
    }

    #[test]
    fn socket_dir_non_0700_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let socket_dir = tmp.path().join("traversable_dir");
        std::fs::create_dir(&socket_dir).unwrap();
        // 0o755 is traversable by others — must be rejected even though not writable.
        std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();
        let result = ensure_private_socket_dir(&socket_path);
        assert!(result.is_err(), "must fail when directory is not 0700 (got 0755)");
    }

    #[test]
    fn socket_dir_world_writable_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let socket_dir = tmp.path().join("dangerous_dir");
        std::fs::create_dir(&socket_dir).unwrap();
        std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();
        let result = ensure_private_socket_dir(&socket_path);
        assert!(result.is_err(), "must fail when directory is world-writable (0777)");
    }

    #[test]
    fn remove_own_socket_removes_matching_socket() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.sock").to_string_lossy().into_owned();
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let identity = socket_identity(&path).unwrap();
        drop(listener);

        remove_own_socket(&path, identity);
        assert!(
            std::fs::symlink_metadata(&path).is_err(),
            "socket must be removed when identity matches"
        );
    }
}
