//! Replay snapshot pinning and stream-copy export pipeline (T-019).
//!
//! RPC methods handled here:
//! - `replay.save`                      — pin a snapshot from the rolling buffer
//! - `replay.snapshot_release`          — unpin a snapshot
//! - `replay.recoverable_sessions`      — list sessions found after a crash
//! - `replay.discard_recovered_session` — delete a crashed session from disk
//! - `replay.restore_recovered_session` — promote a crashed session to a snapshot
//! - `replay.export_start`              — start an ffmpeg stream-copy export
//! - `replay.export_cancel`             — cancel an in-flight export

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use libc;

use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;
use tracing::{info, warn};

use crate::engine::{ExportHandle, PinnedSnapshot, SharedState};
use crate::protocol::{
    envelope::{Request, Response, RpcError},
    events::{
        ExportCancelledEvent, ExportCompletedEvent, ExportFailedEvent, ExportProgressEvent,
        ExportQueuedEvent, ExportStartedEvent, SnapshotPinnedEvent, SnapshotReleasedEvent,
    },
    types::{ExportMode, PlanReport, PtsRange, ReplaySnapshot, VideoCodec},
};
use crate::segment::recovery::{discard_recovered_session, resolve_segments_root};
use crate::transport::notifier::Notifier;

// ── helpers ───────────────────────────────────────────────────────────────────

/// Rename `old` to `new` without replacing an existing `new`.
///
/// Primary strategy: `renameat2(RENAME_NOREPLACE)` — atomic and no-clobber.
/// Fallback when the kernel or filesystem does not support it (exFAT, FAT,
/// old kernels): atomically reserve `new` via `O_CREAT|O_EXCL`, then rename
/// `old` over the reservation we just created.  Because `rename(2)` replaces
/// only the directory entry (the inode we hold via the open FD is unlinked
/// atomically), this preserves the no-overwrite invariant: we never replace a
/// file we did not create ourselves.
#[cfg(target_os = "linux")]
fn rename_no_replace_sync(old: &std::path::Path, new: &std::path::Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    const RENAME_NOREPLACE: libc::c_uint = 1;
    let old_c = CString::new(old.as_os_str().as_bytes())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))?;
    let new_c = CString::new(new.as_os_str().as_bytes())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))?;
    let ret = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD as libc::c_long,
            old_c.as_ptr() as libc::c_long,
            libc::AT_FDCWD as libc::c_long,
            new_c.as_ptr() as libc::c_long,
            RENAME_NOREPLACE as libc::c_long,
        )
    };
    if ret == 0 {
        return Ok(());
    }
    let raw_err = std::io::Error::last_os_error();
    let unsupported = matches!(
        raw_err.raw_os_error(),
        Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::EOPNOTSUPP)
    );
    if !unsupported {
        // Meaningful error (EEXIST, EXDEV, EPERM, …): return it directly.
        return Err(raw_err);
    }
    // renameat2 not available on this kernel/filesystem.
    // Tier-2: hard_link(old, new) + unlink(old). link(2) is atomic and
    // returns EEXIST when `new` already exists — no-clobber guarantee without
    // pre-creating the final path. Returns EXDEV for cross-device moves so
    // the caller can use its copy path.
    match std::fs::hard_link(old, new) {
        Ok(()) => {
            let _ = std::fs::remove_file(old); // best-effort; new is already committed
            return Ok(());
        }
        // Destination already exists — no-clobber upheld.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(e),
        // Cross-device — caller's copy path handles it.
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => return Err(e),
        // hard_link unsupported (FAT/exFAT, certain tmpfs variants, …).
        // No atomic no-clobber mechanism is available. Return EOPNOTSUPP so
        // the caller can surface a clear diagnostic instead of risking a
        // TOCTOU-unsafe overwrite of an existing user file.
        Err(_) => return Err(std::io::Error::from_raw_os_error(libc::EOPNOTSUPP)),
    }
    unreachable!()
}

/// Tier-2 only (no `renameat2`). Used by non-Linux Unix targets (macOS, BSD).
#[cfg(all(unix, not(target_os = "linux")))]
fn rename_no_replace_sync(old: &std::path::Path, new: &std::path::Path) -> std::io::Result<()> {
    match std::fs::hard_link(old, new) {
        Ok(()) => {
            let _ = std::fs::remove_file(old);
            return Ok(());
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(e),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => return Err(e),
        Err(_) => return Err(std::io::Error::from_raw_os_error(libc::EOPNOTSUPP)),
    }
    unreachable!()
}

/// Non-Unix stub. Returns `Unsupported` so `run_export` surfaces a clear error
/// rather than failing to compile.
#[cfg(not(unix))]
fn rename_no_replace_sync(
    _old: &std::path::Path,
    _new: &std::path::Path,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-clobber rename is not supported on this platform",
    ))
}

/// Cross-platform predicate for "cross-device rename not possible".
#[inline]
fn is_exdev(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(not(unix))]
    {
        let _ = e;
        false
    }
}

// ── public API ────────────────────────────────────────────────────────────────

/// Route all `replay.*` RPC methods.
pub async fn dispatch_replay(
    req: Request,
    state: &SharedState,
    notifier: &Notifier,
) -> Response {
    let id = req.id.clone();
    match req.method.as_str() {
        "replay.save" => handle_replay_save(id, req.params, state, notifier).await,
        "replay.snapshot_release" => {
            handle_snapshot_release(id, req.params, state, notifier).await
        }
        "replay.recoverable_sessions" => handle_recoverable_sessions(id, state).await,
        "replay.discard_recovered_session" => {
            handle_discard_recovered(id, req.params, state).await
        }
        "replay.restore_recovered_session" => {
            handle_restore_recovered(id, req.params, state, notifier).await
        }
        "replay.export_start" => handle_export_start(id, req.params, state, notifier).await,
        "replay.export_cancel" => handle_export_cancel(id, req.params, state).await,
        _ => Response::error(id, RpcError::method_not_found()),
    }
}

/// Remove `.tmp` files and cross-device `.part` files left by a prior crash.
/// Must be called at helper boot before accepting connections.
/// Cross-device partial paths are recorded in `.xdev-hint` sidecar files in
/// the staging directory so this function can find them even though they live
/// in an arbitrary destination directory.
pub fn reap_orphaned_exports(staging_dir: &Path) {
    let entries = match std::fs::read_dir(staging_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s.ends_with(".tmp") {
            match std::fs::remove_file(entry.path()) {
                Ok(()) => {
                    info!(path = %entry.path().display(), "reaped orphaned export tmp file");
                }
                Err(e) => {
                    warn!(
                        path = %entry.path().display(),
                        error = %e,
                        "failed to reap orphaned export tmp"
                    );
                }
            }
        } else if name_s.ends_with(".xdev-hint") {
            // The hint file contains the path of a destination-side .part file
            // written during a cross-device export that did not complete.
            // Derive the expected basename from the hint file's own name so a
            // corrupted or tampered hint cannot direct deletion of arbitrary paths.
            let export_id = name_s.trim_end_matches(".xdev-hint");
            let expected_basename = format!("{export_id}.part");
            if let Ok(dest_part) = std::fs::read_to_string(entry.path()) {
                let dest_part = dest_part.trim();
                let basename_ok = std::path::Path::new(dest_part)
                    .file_name()
                    .map(|b| b == expected_basename.as_str())
                    .unwrap_or(false);
                if !dest_part.is_empty() && basename_ok {
                    let _ = std::fs::remove_file(dest_part);
                }
            }
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Resolve the export staging directory per XDG conventions.
/// Temporary `.tmp` files are always written here so `reap_orphaned_exports`
/// has one predictable directory to clean up on next boot.
pub fn resolve_export_staging_dir() -> PathBuf {
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(runtime_dir)
            .join("cove-screen-recorder")
            .join("exports");
    }
    if let Ok(cache_dir) = std::env::var("XDG_CACHE_HOME") {
        return PathBuf::from(cache_dir)
            .join("cove-screen-recorder")
            .join("exports");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".cache").join("cove-screen-recorder").join("exports")
}

// ── private helpers ───────────────────────────────────────────────────────────

fn new_id(prefix: &str) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}-{}{:09}-{:04}", prefix, dur.as_secs(), dur.subsec_nanos(), seq)
}

/// Compute hex-encoded SHA-256 of the file at `path`, streaming in 64 KiB chunks.
fn compute_sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Emit `export.failed` exactly once per export, guarded by `terminal_fired`.
async fn emit_export_failed(
    notifier: &Notifier,
    export_id: &str,
    stage: &str,
    reason_code: &str,
    details: &str,
    terminal_fired: &Arc<AtomicBool>,
) {
    if terminal_fired.swap(true, Ordering::SeqCst) {
        return;
    }
    let evt = ExportFailedEvent {
        export_id: export_id.to_string(),
        stage: stage.to_string(),
        reason_code: reason_code.to_string(),
        details: details.to_string(),
        diagnostics_path: String::new(),
    };
    let _ = notifier
        .notify("export.failed", serde_json::to_value(evt).unwrap_or(json!(null)))
        .await;
}

// ── replay.save ───────────────────────────────────────────────────────────────

async fn handle_replay_save(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    state: &SharedState,
    notifier: &Notifier,
) -> Response {
    let duration_s = params
        .as_ref()
        .and_then(|p| p.get("duration_s").or_else(|| p.get("durationSeconds")))
        .and_then(|v| v.as_f64())
        .unwrap_or(30.0);
    if !duration_s.is_finite() || duration_s <= 0.0 {
        return Response::error(
            id,
            RpcError::invalid_request("duration_s must be a positive finite number"),
        );
    }
    let duration_90k = (duration_s * 90_000.0) as u64;

    // Clone buffer handle out of the lock so we can await on pin_snapshot
    // without holding the Mutex guard across an await point.
    let (buffer_clone, session_id, codec, width, height, fps_num, fps_den) = {
        let guard = state.active_segment_buffer.lock().await;
        match guard.as_ref() {
            Some(info) => (
                info.buffer.clone_handle(),
                info.session_id.clone(),
                info.codec.clone(),
                info.width,
                info.height,
                info.fps_num,
                info.fps_den,
            ),
            None => return Response::error(id, RpcError::invalid_request("no active capture session")),
        }
    };

    // If the encoder is in the stop→finalize window, wait for the tail segment
    // to be committed before pinning. Skip during active recording to avoid a
    // latency regression on every live save. On timeout, return a retryable
    // error rather than pinning a partial segment set.
    if buffer_clone.is_closing() {
        let mut close_rx = buffer_clone.subscribe_close();
        if !*close_rx.borrow() {
            let timed_out = tokio::time::timeout(
                std::time::Duration::from_millis(300),
                close_rx.wait_for(|v| *v),
            )
            .await
            .is_err();
            if timed_out {
                return Response::error(id, RpcError::invalid_request("still-finalizing"));
            }
        }
    }

    let segments = match buffer_clone.pin_snapshot(duration_90k).await {
        Some(segs) if !segs.is_empty() => segs,
        Some(_) => {
            return Response::error(
                id,
                RpcError::invalid_request("no segments fall within the requested duration"),
            )
        }
        None => {
            return Response::error(
                id,
                RpcError::invalid_request("no committed segments available to pin"),
            )
        }
    };

    let segments_root = resolve_segments_root();
    let init_path = segments_root.join(&session_id).join("init.mp4");
    let init_bytes = std::fs::metadata(&init_path).map(|m| m.len()).unwrap_or(0);

    let pts_start = segments.first().map(|s| s.pts_start_90k).unwrap_or(0);
    let pts_end = segments.last().map(|s| s.pts_end_90k).unwrap_or(0);
    let has_discontinuity = segments.iter().any(|s| s.discontinuity);
    let discontinuity_at_pts_90k: Vec<i64> = segments
        .iter()
        .filter(|s| s.discontinuity)
        .map(|s| s.pts_start_90k)
        .collect();
    let bytes_pinned: u64 = segments.iter().map(|s| s.byte_size).sum();
    let framerate_hint = if fps_den > 0 { fps_num / fps_den } else { 60 };

    let snapshot_id = new_id("snap");
    let snapshot = ReplaySnapshot {
        snapshot_id: snapshot_id.clone(),
        session_id: session_id.clone(),
        init_segment_path: init_path.to_string_lossy().into_owned(),
        init_segment_bytes: init_bytes,
        segments: segments.clone(),
        trim_start_pts_90k: pts_start,
        trim_end_pts_90k: pts_end,
        codec,
        timescale: 90_000,
        width,
        height,
        framerate_hint,
        has_discontinuity,
        discontinuity_at_pts_90k,
    };

    state.active_snapshots.lock().await.insert(
        snapshot_id.clone(),
        PinnedSnapshot { snapshot: snapshot.clone(), buffer: Some(buffer_clone), recovered_session: None },
    );

    let pinned_evt = SnapshotPinnedEvent {
        snapshot_id: snapshot_id.clone(),
        session_id,
        segments_count: segments.len() as u32,
        bytes_pinned,
    };
    let _ = notifier
        .notify(
            "replay.snapshotPinned",
            serde_json::to_value(pinned_evt).unwrap_or(json!(null)),
        )
        .await;

    Response::result(id, serde_json::to_value(snapshot).unwrap_or(json!(null)))
}

// ── replay.snapshot_release ───────────────────────────────────────────────────

async fn handle_snapshot_release(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    state: &SharedState,
    notifier: &Notifier,
) -> Response {
    let snapshot_id = match params
        .as_ref()
        .and_then(|p| p.get("snapshot_id"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s.to_string(),
        None => return Response::error(id, RpcError::invalid_request("snapshot_id required")),
    };

    // Hold the exports lock across the check AND the snapshot removal so that a
    // concurrent export_start cannot register between the two steps.
    // Lock order everywhere: active_exports → active_snapshots.
    let exports = state.active_exports.lock().await;
    if exports.values().any(|h| h.snapshot_id == snapshot_id) {
        return Response::error(
            id,
            RpcError::invalid_request("snapshot is referenced by an active export"),
        );
    }
    let pinned = state.active_snapshots.lock().await.remove(&snapshot_id);
    drop(exports);

    let pinned = match pinned {
        Some(p) => p,
        None => {
            return Response::error(id, RpcError::invalid_request("snapshot_id not found"))
        }
    };

    // Attempt recovered-session cleanup first while pinned is fully intact.
    // On failure: reinsert the snapshot so the caller can retry, then error.
    if let Some(ref recovered) = pinned.recovered_session {
        if let Err(e) = discard_recovered_session(&recovered.session_dir) {
            warn!(error = %e, "failed to clean up recovered session files on snapshot release");
            state.active_snapshots.lock().await.insert(snapshot_id.clone(), pinned);
            return Response::error(
                id,
                RpcError::invalid_request(format!("cleanup failed: {e}")),
            );
        }
    }

    // Release pin refcounts now that cleanup is committed (or not needed).
    if let Some(buf) = pinned.buffer {
        let indices: Vec<u32> = pinned.snapshot.segments.iter().map(|s| s.index).collect();
        buf.release_snapshot(&indices).await;
    }

    let evt = SnapshotReleasedEvent { snapshot_id: snapshot_id.clone(), age_ms: 0 };
    let _ = notifier
        .notify("replay.snapshotReleased", serde_json::to_value(evt).unwrap_or(json!(null)))
        .await;

    Response::result(id, json!({ "ok": true }))
}

// ── replay.recoverable_sessions ───────────────────────────────────────────────

async fn handle_recoverable_sessions(
    id: Option<serde_json::Value>,
    state: &SharedState,
) -> Response {
    let guard = state.recoverable_sessions.lock().await;
    let sessions: Vec<crate::protocol::types::RecoverableSession> = guard
        .iter()
        .map(|r| {
            let duration_90k: i64 = r.segments.iter().map(|s| s.duration_90k).sum();
            crate::protocol::types::RecoverableSession {
                session_id: r.session_id.clone(),
                started_at: 0,
                duration_s: duration_90k as f64 / 90_000.0,
                bytes_on_disk: r.total_bytes,
                segments_count: r.segments.len() as u32,
                has_discontinuity: r.segments.iter().any(|s| s.discontinuity),
            }
        })
        .collect();
    Response::result(id, json!({ "sessions": sessions }))
}

// ── replay.discard_recovered_session ─────────────────────────────────────────

async fn handle_discard_recovered(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    state: &SharedState,
) -> Response {
    let session_id = match params
        .as_ref()
        .and_then(|p| p.get("session_id"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s.to_string(),
        None => return Response::error(id, RpcError::invalid_request("session_id required")),
    };

    // Atomically claim (remove) the session from shared state before any file
    // operation so restore cannot race and create a snapshot backed by files
    // that discard is concurrently deleting. On deletion failure, reinsert so
    // the caller can retry — the session entry remains valid as long as the
    // directory still exists (even partially).
    let info = {
        let mut guard = state.recoverable_sessions.lock().await;
        match guard.iter().position(|r| r.session_id == session_id) {
            Some(i) => guard.remove(i),
            None => return Response::error(id, RpcError::invalid_request("session_id not found")),
        }
    };

    if let Err(e) = discard_recovered_session(&info.session_dir) {
        warn!(error = %e, "failed to remove recovered session directory");
        // Reinsert so the caller can retry.
        state.recoverable_sessions.lock().await.push(info);
        return Response::error(
            id,
            RpcError::invalid_request(&format!("discard failed: {e}")),
        );
    }

    Response::result(id, json!({ "ok": true }))
}

// ── replay.restore_recovered_session ─────────────────────────────────────────

async fn handle_restore_recovered(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    state: &SharedState,
    notifier: &Notifier,
) -> Response {
    let session_id = match params
        .as_ref()
        .and_then(|p| p.get("session_id"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s.to_string(),
        None => return Response::error(id, RpcError::invalid_request("session_id required")),
    };

    // Remove from the recoverable list so `replay.discard_recovered_session`
    // cannot delete the backing files while the restored snapshot is active.
    let info = {
        let mut guard = state.recoverable_sessions.lock().await;
        let pos = guard.iter().position(|r| r.session_id == session_id);
        match pos {
            Some(i) => {
                // Reject sessions without an init segment before claiming them —
                // they cannot be stream-copy exported and will remain in the list
                // so the caller can inspect or discard them explicitly.
                if !guard[i].has_init_segment {
                    return Response::error(
                        id,
                        RpcError::invalid_request(
                            "recovered session has no init.mp4 and cannot be exported",
                        ),
                    );
                }
                Some(guard.remove(i))
            }
            None => None,
        }
    };
    let info = match info {
        Some(i) => i,
        None => return Response::error(id, RpcError::invalid_request("session_id not found")),
    };

    let init_path = info.session_dir.join("init.mp4");
    let init_bytes = std::fs::metadata(&init_path).map(|m| m.len()).unwrap_or(0);

    let pts_start = info.segments.first().map(|s| s.pts_start_90k).unwrap_or(0);
    let pts_end = info.segments.last().map(|s| s.pts_end_90k).unwrap_or(0);
    let has_discontinuity = info.segments.iter().any(|s| s.discontinuity);
    let discontinuity_at_pts_90k: Vec<i64> = info
        .segments
        .iter()
        .filter(|s| s.discontinuity)
        .map(|s| s.pts_start_90k)
        .collect();
    let bytes_pinned: u64 = info.segments.iter().map(|s| s.byte_size).sum();

    let snapshot_id = new_id("snap");
    let snapshot = ReplaySnapshot {
        snapshot_id: snapshot_id.clone(),
        session_id: session_id.clone(),
        init_segment_path: init_path.to_string_lossy().into_owned(),
        init_segment_bytes: init_bytes,
        segments: info.segments.clone(),
        trim_start_pts_90k: pts_start,
        trim_end_pts_90k: pts_end,
        codec: VideoCodec::H264,
        timescale: 90_000,
        width: 0,
        height: 0,
        framerate_hint: 0,
        has_discontinuity,
        discontinuity_at_pts_90k,
    };

    let segments_count = info.segments.len() as u32;

    // Recovered session segments are on disk; no live buffer to unpin against.
    // Store info so snapshot_release can clean up the recovered session dir.
    state.active_snapshots.lock().await.insert(
        snapshot_id.clone(),
        PinnedSnapshot { snapshot: snapshot.clone(), buffer: None, recovered_session: Some(info) },
    );

    let pinned_evt = SnapshotPinnedEvent {
        snapshot_id: snapshot_id.clone(),
        session_id,
        segments_count,
        bytes_pinned,
    };
    let _ = notifier
        .notify(
            "replay.snapshotPinned",
            serde_json::to_value(pinned_evt).unwrap_or(json!(null)),
        )
        .await;

    Response::result(id, serde_json::to_value(snapshot).unwrap_or(json!(null)))
}

// ── replay.export_start ───────────────────────────────────────────────────────

async fn handle_export_start(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    state: &SharedState,
    notifier: &Notifier,
) -> Response {
    if !state.ffmpeg_available {
        return Response::error(
            id,
            RpcError::invalid_request("ffmpeg not found; export unavailable"),
        );
    }

    let p = params.as_ref();

    // Primary wire format: { snapshot: { snapshot_id, … }, options: { … } }
    // Fallback: top-level snapshot_id for backward compat.
    let snapshot_id = p
        .and_then(|p| p.get("snapshot"))
        .and_then(|s| s.get("snapshot_id"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            p.and_then(|p| p.get("snapshot_id"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    let snapshot_id = match snapshot_id {
        Some(s) => s,
        None => return Response::error(id, RpcError::invalid_request("snapshot_id required")),
    };

    // Accept output_path from the nested `options` object (primary wire format)
    // or from the top level (fallback / legacy callers).
    let output_path = p
        .and_then(|p| p.get("options"))
        .and_then(|o| o.get("output_path"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            p.and_then(|p| p.get("output_path"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });

    let export_id = new_id("exp");
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let in_muxing = Arc::new(AtomicBool::new(false));
    let terminal_fired = Arc::new(AtomicBool::new(false));

    // Register in active_exports BEFORE reading the snapshot so that a
    // concurrent snapshot_release cannot remove the snapshot between our
    // existence check and the export task starting to read it.
    state.active_exports.lock().await.insert(
        export_id.clone(),
        ExportHandle { cancel_tx, in_muxing: Arc::clone(&in_muxing), snapshot_id: snapshot_id.clone() },
    );

    let snapshot = {
        let guard = state.active_snapshots.lock().await;
        guard.get(&snapshot_id).map(|ps| ps.snapshot.clone())
    };
    let snapshot = match snapshot {
        Some(s) => s,
        None => {
            // Snapshot was already released; clean up the export registration.
            state.active_exports.lock().await.remove(&export_id);
            return Response::error(id, RpcError::invalid_request("snapshot_id not found"));
        }
    };

    let requested_duration_s =
        (snapshot.trim_end_pts_90k - snapshot.trim_start_pts_90k) as f64 / 90_000.0;

    let queued = ExportQueuedEvent {
        export_id: export_id.clone(),
        snapshot_id,
        requested_duration_s,
    };
    let _ = notifier
        .notify("export.queued", serde_json::to_value(queued).unwrap_or(json!(null)))
        .await;

    let staging_dir = resolve_export_staging_dir();
    let notifier_c = notifier.clone();
    let eid = export_id.clone();
    let state_c = Arc::clone(state);

    tokio::spawn(async move {
        run_export(
            eid.clone(),
            snapshot,
            output_path,
            staging_dir,
            notifier_c,
            cancel_rx,
            in_muxing,
            terminal_fired,
        )
        .await;
        state_c.active_exports.lock().await.remove(&eid);
    });

    Response::result(id, json!({ "export_id": export_id }))
}

// ── replay.export_cancel ──────────────────────────────────────────────────────

async fn handle_export_cancel(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    state: &SharedState,
) -> Response {
    let export_id = match params
        .as_ref()
        .and_then(|p| p.get("export_id"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s.to_string(),
        None => return Response::error(id, RpcError::invalid_request("export_id required")),
    };

    let guard = state.active_exports.lock().await;
    let handle = match guard.get(&export_id) {
        Some(h) => h,
        None => return Response::error(id, RpcError::invalid_request("export_id not found")),
    };

    if handle.in_muxing.load(Ordering::SeqCst) {
        return Response::result(
            id,
            json!({ "ok": false, "reason": "past-cancel-boundary" }),
        );
    }

    let _ = handle.cancel_tx.send(true);
    Response::result(id, json!({ "ok": true }))
}

// ── export task ───────────────────────────────────────────────────────────────

async fn run_export(
    export_id: String,
    snapshot: ReplaySnapshot,
    output_path: Option<String>,
    staging_dir: PathBuf,
    notifier: Notifier,
    mut cancel_rx: watch::Receiver<bool>,
    in_muxing: Arc<AtomicBool>,
    terminal_fired: Arc<AtomicBool>,
) {
    // Reject snapshots that span a format-change boundary: stream-copy requires
    // all segments to be format-compatible. Re-encode (T-020) handles these.
    if snapshot.has_discontinuity {
        emit_export_failed(
            &notifier,
            &export_id,
            "copy",
            "stream-copy-requires-reencode",
            "snapshot contains a format-change discontinuity; re-encode not yet implemented",
            &terminal_fired,
        )
        .await;
        return;
    }

    // Ensure staging directory exists.
    if let Err(e) = tokio::fs::create_dir_all(&staging_dir).await {
        emit_export_failed(
            &notifier,
            &export_id,
            "copy",
            "staging-dir-unwritable",
            &e.to_string(),
            &terminal_fired,
        )
        .await;
        return;
    }

    // Temporary file always lives in staging_dir so reap_orphaned_exports finds it.
    let tmp_path = staging_dir.join(format!("{}.tmp", export_id));
    let final_path = output_path.unwrap_or_else(|| {
        staging_dir.join(format!("{}.mp4", export_id)).to_string_lossy().into_owned()
    });

    // Build the fMP4 concat input: init segment followed by media segments.
    let mut concat_parts = vec![snapshot.init_segment_path.clone()];
    for seg in &snapshot.segments {
        concat_parts.push(seg.path.clone());
    }
    let concat_input = format!("concat:{}", concat_parts.join("|"));

    let est_bytes: u64 =
        snapshot.init_segment_bytes + snapshot.segments.iter().map(|s| s.byte_size).sum::<u64>();
    let est_duration_s =
        (snapshot.trim_end_pts_90k - snapshot.trim_start_pts_90k) as f64 / 90_000.0;

    let plan = PlanReport {
        mode: ExportMode::Fast,
        copy_ranges: vec![PtsRange {
            start_pts_90k: snapshot.trim_start_pts_90k,
            end_pts_90k: snapshot.trim_end_pts_90k,
        }],
        reencode_ranges: vec![],
        est_output_bytes: est_bytes,
        est_duration_s,
        expected_fps: snapshot.framerate_hint as f64,
    };

    let started = ExportStartedEvent {
        export_id: export_id.clone(),
        mode: "stream-copy".into(),
        plan,
        est_duration_s,
        est_output_bytes: est_bytes,
    };
    let _ = notifier
        .notify("export.started", serde_json::to_value(started).unwrap_or(json!(null)))
        .await;

    // Spawn ffmpeg: `-progress pipe:1` writes structured key=value progress to
    // stdout; stderr is suppressed to keep the notifier channel clean.
    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.args([
        "-y",
        "-i",
        &concat_input,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
    ])
    .arg(tmp_path.to_str().unwrap_or("/dev/null"))
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_export_failed(
                &notifier,
                &export_id,
                "copy",
                "ffmpeg-spawn-failed",
                &e.to_string(),
                &terminal_fired,
            )
            .await;
            return;
        }
    };

    let stdout = child.stdout.take().expect("piped stdout missing");
    let mut lines = BufReader::new(stdout).lines();

    let total_samples = (snapshot.trim_end_pts_90k - snapshot.trim_start_pts_90k).max(0) as u64;
    let mut out_time_us: u64 = 0;
    let mut bytes_out: u64 = 0;
    let start_time = Instant::now();
    let mut last_progress_emit = Instant::now();

    // COPY stage: drive the ffmpeg subprocess until it exits or a cancel fires.
    let exit_status = loop {
        tokio::select! {
            line_result = lines.next_line() => {
                match line_result {
                    Ok(Some(line)) => {
                        if let Some((key, val)) = line.split_once('=') {
                            match key {
                                "out_time_us" => {
                                    out_time_us = val.trim().parse().unwrap_or(out_time_us);
                                }
                                "total_size" => {
                                    bytes_out = val.trim().parse().unwrap_or(bytes_out);
                                }
                                "progress" => {
                                    let is_end = val.trim() == "end";
                                    if is_end || last_progress_emit.elapsed() >= Duration::from_millis(500) {
                                        let encoded_samples =
                                            (out_time_us as f64 / 1_000_000.0 * 90_000.0) as u64;
                                        let pct = if total_samples > 0 {
                                            (encoded_samples as f64 / total_samples as f64 * 100.0)
                                                .min(100.0) as f32
                                        } else {
                                            0.0
                                        };
                                        let elapsed_ms = start_time.elapsed().as_millis() as u64;
                                        let eta_ms = if pct > 0.0 && pct < 100.0 && elapsed_ms > 0 {
                                            ((elapsed_ms as f64 / pct as f64)
                                                * (100.0 - pct as f64))
                                                .max(0.0) as u64
                                        } else {
                                            0
                                        };
                                        let prog = ExportProgressEvent {
                                            export_id: export_id.clone(),
                                            stage: "copy".into(),
                                            pct,
                                            bytes_in: est_bytes,
                                            bytes_out,
                                            samples_processed: encoded_samples,
                                            samples_total: total_samples,
                                            eta_ms,
                                        };
                                        let _ = notifier
                                            .notify(
                                                "export.progress",
                                                serde_json::to_value(prog).unwrap_or(json!(null)),
                                            )
                                            .await;
                                        last_progress_emit = Instant::now();
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    // stdout EOF: ffmpeg closed its write end; wait for exit.
                    Ok(None) | Err(_) => match child.wait().await {
                        Ok(status) => break status,
                        Err(e) => {
                            let _ = tokio::fs::remove_file(&tmp_path).await;
                            emit_export_failed(
                                &notifier,
                                &export_id,
                                "copy",
                                "ffmpeg-wait-error",
                                &e.to_string(),
                                &terminal_fired,
                            )
                            .await;
                            return;
                        }
                    },
                }
            }
            result = child.wait() => {
                match result {
                    Ok(status) => break status,
                    Err(e) => {
                        let _ = tokio::fs::remove_file(&tmp_path).await;
                        emit_export_failed(
                            &notifier,
                            &export_id,
                            "copy",
                            "ffmpeg-wait-error",
                            &e.to_string(),
                            &terminal_fired,
                        )
                        .await;
                        return;
                    }
                }
            }
            _ = cancel_rx.changed() => {
                child.kill().await.ok();
                child.wait().await.ok();
                let partial_bytes =
                    tokio::fs::metadata(&tmp_path).await.map(|m| m.len()).unwrap_or(0);
                let _ = tokio::fs::remove_file(&tmp_path).await;
                if terminal_fired.swap(true, Ordering::SeqCst) {
                    return;
                }
                let evt = ExportCancelledEvent {
                    export_id: export_id.clone(),
                    stage: "copy".into(),
                    partial_bytes,
                };
                let _ = notifier
                    .notify(
                        "export.cancelled",
                        serde_json::to_value(evt).unwrap_or(json!(null)),
                    )
                    .await;
                return;
            }
        }
    };

    if !exit_status.success() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        emit_export_failed(
            &notifier,
            &export_id,
            "copy",
            "ffmpeg-nonzero-exit",
            &format!("exit code: {:?}", exit_status.code()),
            &terminal_fired,
        )
        .await;
        return;
    }

    // MUXING stage: set in_muxing BEFORE checking cancel so the handler
    // cannot accept a cancel that arrives after this store — closing the
    // race where the handler returns ok=true while the task continues to publish.
    in_muxing.store(true, Ordering::SeqCst);

    // Now honour any cancel that arrived before the store above.
    if *cancel_rx.borrow() {
        let partial_bytes = tokio::fs::metadata(&tmp_path).await.map(|m| m.len()).unwrap_or(0);
        let _ = tokio::fs::remove_file(&tmp_path).await;
        if terminal_fired.swap(true, Ordering::SeqCst) {
            return;
        }
        let evt = ExportCancelledEvent {
            export_id: export_id.clone(),
            stage: "copy".into(),
            partial_bytes,
        };
        let _ = notifier
            .notify("export.cancelled", serde_json::to_value(evt).unwrap_or(json!(null)))
            .await;
        return;
    }

    // Fsync tmp before rename so ffmpeg output is durable on the source side.
    {
        let tmp_for_sync = tmp_path.clone();
        let sync_result = tokio::task::spawn_blocking(move || {
            std::fs::File::open(&tmp_for_sync).and_then(|f| f.sync_all())
        })
        .await;
        match sync_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let _ = tokio::fs::remove_file(&tmp_path).await;
                emit_export_failed(
                    &notifier, &export_id, "mux", "fsync-failed", &e.to_string(), &terminal_fired,
                ).await;
                return;
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp_path).await;
                emit_export_failed(
                    &notifier, &export_id, "mux", "fsync-task-panicked", &e.to_string(), &terminal_fired,
                ).await;
                return;
            }
        }
    }

    // Publish tmp → final. Uses renameat2(RENAME_NOREPLACE) to detect an
    // existing destination atomically. Falls back to a regular rename on
    // filesystems that don't support RENAME_NOREPLACE (exFAT, FAT, old
    // kernels). On EXDEV, copies to a destination-side temp first so the
    // final publish stays on the target filesystem.
    let dest_dir_for_fsync = std::path::Path::new(&final_path)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_owned();
    let rename_err = {
        let tp = tmp_path.clone();
        let fp = final_path.clone();
        tokio::task::spawn_blocking(move || rename_no_replace_sync(&tp, std::path::Path::new(&fp)))
            .await
            .unwrap_or_else(|e| Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))
    };
    match rename_err {
        Ok(()) => {} // same-device success — proceed to fsync dest dir
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            emit_export_failed(
                &notifier, &export_id, "mux", "output-path-exists", &final_path, &terminal_fired,
            ).await;
            return;
        }
        Err(ref e) if is_exdev(e) => {
            // Cross-device: copy to destination-side temp, then no-replace rename.
            let dest_tmp = dest_dir_for_fsync.join(format!("{}.part", export_id));
            let hint_path = staging_dir.join(format!("{}.xdev-hint", export_id));
            let _ = tokio::fs::write(&hint_path, dest_tmp.to_string_lossy().as_bytes()).await;

            // Probe for hard link support on the destination filesystem before
            // the expensive copy so we fail fast on FAT/exFAT destinations.
            // Creates and immediately removes a tiny probe file; if hard_link
            // fails the probe, the destination cannot support the atomic
            // no-replace publish step that follows.
            {
                let probe_src = dest_dir_for_fsync.join(format!("{}.hlink-probe", export_id));
                let probe_dst = dest_dir_for_fsync.join(format!("{}.hlink-probe-link", export_id));
                let ps = probe_src.clone();
                let pd = probe_dst.clone();
                let probe_result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                    std::fs::write(&ps, b"")?;
                    let r = std::fs::hard_link(&ps, &pd);
                    let _ = std::fs::remove_file(&ps);
                    let _ = std::fs::remove_file(&pd);
                    r
                })
                .await
                .unwrap_or_else(|e| Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())));
                if let Err(e) = probe_result {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    let _ = tokio::fs::remove_file(&hint_path).await;
                    emit_export_failed(
                        &notifier, &export_id, "mux", "destination-filesystem-not-supported",
                        &e.to_string(), &terminal_fired,
                    ).await;
                    return;
                }
            }

            // Exclusively create dest_tmp, copy content, and fsync in one
            // blocking task. Using create_new ensures we never clobber an
            // existing .part file or follow a symlink at that path.
            let tp = tmp_path.clone();
            let dt = dest_tmp.clone();
            let copy_result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                let mut src = std::fs::File::open(&tp)?;
                let mut dst = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&dt)?;
                std::io::copy(&mut src, &mut dst)?;
                dst.sync_all()?;
                Ok(())
            })
            .await;
            match copy_result {
                Ok(Ok(())) => {}
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    let _ = tokio::fs::remove_file(&hint_path).await;
                    emit_export_failed(
                        &notifier, &export_id, "mux", "cross-device-temp-exists", &e.to_string(), &terminal_fired,
                    ).await;
                    return;
                }
                Ok(Err(e)) => {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    let _ = tokio::fs::remove_file(&dest_tmp).await;
                    let _ = tokio::fs::remove_file(&hint_path).await;
                    emit_export_failed(
                        &notifier, &export_id, "mux", "cross-device-copy-failed", &e.to_string(), &terminal_fired,
                    ).await;
                    return;
                }
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    let _ = tokio::fs::remove_file(&dest_tmp).await;
                    let _ = tokio::fs::remove_file(&hint_path).await;
                    emit_export_failed(
                        &notifier, &export_id, "mux", "fsync-task-panicked", &e.to_string(), &terminal_fired,
                    ).await;
                    return;
                }
            }
            let _ = tokio::fs::remove_file(&tmp_path).await;
            // dest_tmp and final_path are on the same filesystem: use no-replace rename.
            let dt = dest_tmp.clone();
            let fp = final_path.clone();
            let xd_rename = tokio::task::spawn_blocking(move || {
                rename_no_replace_sync(&dt, std::path::Path::new(&fp))
            }).await.unwrap_or_else(|e| Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())));
            match xd_rename {
                Ok(()) => {
                    let _ = tokio::fs::remove_file(&hint_path).await;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let _ = tokio::fs::remove_file(&dest_tmp).await;
                    let _ = tokio::fs::remove_file(&hint_path).await;
                    emit_export_failed(
                        &notifier, &export_id, "mux", "output-path-exists", &final_path, &terminal_fired,
                    ).await;
                    return;
                }
                Err(e) => {
                    let _ = tokio::fs::remove_file(&dest_tmp).await;
                    let _ = tokio::fs::remove_file(&hint_path).await;
                    emit_export_failed(
                        &notifier, &export_id, "mux", "cross-device-rename-failed", &e.to_string(), &terminal_fired,
                    ).await;
                    return;
                }
            }
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            emit_export_failed(
                &notifier, &export_id, "mux", "rename-failed", &e.to_string(), &terminal_fired,
            ).await;
            return;
        }
    }

    // Fsync destination directory so the rename is durably visible.
    {
        let dir = dest_dir_for_fsync.clone();
        let fsync_result = tokio::task::spawn_blocking(move || {
            crate::segment::writer::fsync_dir(&dir)
        })
        .await;
        match fsync_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                emit_export_failed(
                    &notifier, &export_id, "mux", "fsync-dir-failed", &e.to_string(), &terminal_fired,
                ).await;
                return;
            }
            Err(e) => {
                emit_export_failed(
                    &notifier, &export_id, "mux", "fsync-dir-task-panicked", &e.to_string(), &terminal_fired,
                ).await;
                return;
            }
        }
    }

    let final_path_clone = final_path.clone();
    let sha_result =
        tokio::task::spawn_blocking(move || compute_sha256_file(Path::new(&final_path_clone)))
            .await;

    let (file_bytes, sha256) = match sha_result {
        Ok(Ok(hex)) => {
            let bytes = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
            (bytes, hex)
        }
        Ok(Err(e)) => {
            emit_export_failed(
                &notifier,
                &export_id,
                "mux",
                "sha256-io-error",
                &e.to_string(),
                &terminal_fired,
            )
            .await;
            return;
        }
        Err(e) => {
            emit_export_failed(
                &notifier,
                &export_id,
                "mux",
                "sha256-task-panicked",
                &e.to_string(),
                &terminal_fired,
            )
            .await;
            return;
        }
    };

    if terminal_fired.swap(true, Ordering::SeqCst) {
        return;
    }

    let completed = ExportCompletedEvent {
        export_id: export_id.clone(),
        final_path,
        bytes: file_bytes,
        sha256,
        duration_s: est_duration_s,
        mode: "stream-copy".into(),
        fps_observed_out: snapshot.framerate_hint as f64,
    };
    let _ = notifier
        .notify("export.completed", serde_json::to_value(completed).unwrap_or(json!(null)))
        .await;
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_id_has_prefix() {
        let id = new_id("snap");
        assert!(id.starts_with("snap-"), "expected prefix 'snap-', got {id}");
    }

    #[test]
    fn resolve_export_staging_dir_contains_cove() {
        let dir = resolve_export_staging_dir();
        assert!(
            dir.to_string_lossy().contains("cove-screen-recorder"),
            "staging dir must be under cove-screen-recorder"
        );
    }

    #[test]
    fn reap_removes_tmp_preserves_mp4() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path();
        std::fs::write(staging.join("exp-123.tmp"), b"orphan").unwrap();
        std::fs::write(staging.join("exp-456.mp4"), b"final").unwrap();
        reap_orphaned_exports(staging);
        assert!(!staging.join("exp-123.tmp").exists(), ".tmp must be removed");
        assert!(staging.join("exp-456.mp4").exists(), ".mp4 must survive");
    }

    #[test]
    fn compute_sha256_file_returns_64_char_hex() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("test.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let hex = compute_sha256_file(&path).unwrap();
        assert_eq!(hex.len(), 64, "sha256 must be 64 hex chars");
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()), "must be valid hex");
    }
}
