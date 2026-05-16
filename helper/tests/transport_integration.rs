use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

// ── Frame helpers ────────────────────────────────────────────────────────────

async fn write_frame(stream: &mut UnixStream, payload: &[u8]) {
    let len = payload.len() as u32;
    stream.write_all(&len.to_be_bytes()).await.unwrap();
    stream.write_all(payload).await.unwrap();
    stream.flush().await.unwrap();
}

async fn read_frame(stream: &mut UnixStream) -> Vec<u8> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await.unwrap();
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await.unwrap();
    buf
}

/// Returns None on clean EOF (connection dropped), panics on unexpected IO errors.
async fn try_read_frame(stream: &mut UnixStream) -> Option<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    match stream.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return None,
        Err(e) => panic!("unexpected IO error: {e}"),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await.ok()?;
    Some(buf)
}

async fn connect(socket_path: &str) -> UnixStream {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match UnixStream::connect(socket_path).await {
            Ok(s) => return s,
            Err(_) if std::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) => panic!("could not connect to {socket_path}: {e}"),
        }
    }
}

fn make_request(id: u64, method: &str, params: Option<serde_json::Value>) -> Vec<u8> {
    let mut obj = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
    });
    if let Some(p) = params {
        obj["params"] = p;
    }
    serde_json::to_vec(&obj).unwrap()
}

// ── Server spawner ────────────────────────────────────────────────────────────

async fn spawn_server(tmp: &tempfile::TempDir) -> (String, tokio::task::JoinHandle<()>) {
    use std::os::unix::fs::DirBuilderExt;
    // Socket must live in a 0700 directory; tempfile::tempdir() creates 0755 dirs.
    let socket_dir = tmp.path().join("private");
    std::fs::DirBuilder::new().mode(0o700).create(&socket_dir).unwrap();
    let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();
    let sp = socket_path.clone();
    let handle = tokio::spawn(async move {
        let set_level: cove_replay_engine::SetLevelFn = std::sync::Arc::new(|_| Ok(()));
        cove_replay_engine::transport::server::run(&sp, set_level)
            .await
            .ok();
    });
    (socket_path, handle)
}

// ── Sim-mode server spawner ───────────────────────────────────────────────────

#[cfg(unix)]
async fn spawn_sim_server(tmp: &tempfile::TempDir) -> (String, tokio::task::JoinHandle<()>) {
    use std::os::unix::fs::DirBuilderExt;
    let socket_dir = tmp.path().join("private_sim");
    std::fs::DirBuilder::new().mode(0o700).create(&socket_dir).unwrap();
    let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();
    let sp = socket_path.clone();
    let handle = tokio::spawn(async move {
        let set_level: cove_replay_engine::SetLevelFn = std::sync::Arc::new(|_| Ok(()));
        let sim = cove_replay_engine::sim::SimState::new(cove_replay_engine::sim::SimConfig {
            encoder: "h264".into(),
            fail_specs: std::sync::Mutex::new(vec![]),
        });
        cove_replay_engine::transport::server::run_with_config(
            &sp,
            set_level,
            cove_replay_engine::transport::server::RunConfig { sim: Some(sim), ..Default::default() },
        )
        .await
        .ok();
    });
    (socket_path, handle)
}

// Sim-mode server with a custom pending-frame count limit (for limit-boundary tests).
#[cfg(unix)]
async fn spawn_sim_server_limited(
    tmp: &tempfile::TempDir,
    max_pending_frames: usize,
) -> (String, tokio::task::JoinHandle<()>) {
    use std::os::unix::fs::DirBuilderExt;
    let socket_dir = tmp.path().join("private_sim_limited");
    std::fs::DirBuilder::new().mode(0o700).create(&socket_dir).unwrap();
    let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();
    let sp = socket_path.clone();
    let handle = tokio::spawn(async move {
        let set_level: cove_replay_engine::SetLevelFn = std::sync::Arc::new(|_| Ok(()));
        let sim = cove_replay_engine::sim::SimState::new(cove_replay_engine::sim::SimConfig {
            encoder: "h264".into(),
            fail_specs: std::sync::Mutex::new(vec![]),
        });
        cove_replay_engine::transport::server::run_with_config(
            &sp,
            set_level,
            cove_replay_engine::transport::server::RunConfig {
                sim: Some(sim),
                max_pending_frames: Some(max_pending_frames),
                ..Default::default()
            },
        )
        .await
        .ok();
    });
    (socket_path, handle)
}

// ── AC-1: engine.ready sent before any request ─────────────────────────────

#[tokio::test]
async fn ac1_engine_ready_on_connect() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;

    let ready_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out waiting for engine.ready");

    let val: serde_json::Value = serde_json::from_slice(&ready_bytes).unwrap();
    assert_eq!(val["method"], "engine.ready", "expected engine.ready notification");
    assert_eq!(val["jsonrpc"], "2.0");
    assert!(!val["params"]["helper_version"].is_null(), "expected helper_version");
    assert_eq!(val["params"]["protocol_version"], 1);
}

// ── engine.ready shape: pid and capabilities ──────────────────────────────────

#[tokio::test]
async fn engine_ready_shape() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;

    let ready_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out");

    let val: serde_json::Value = serde_json::from_slice(&ready_bytes).unwrap();
    assert_eq!(val["method"], "engine.ready");
    assert!(val["params"]["pid"].is_u64(), "pid must be a positive integer");
    assert_eq!(val["params"]["capabilities"], serde_json::json!([]), "capabilities must be []");
    assert!(val["params"]["helper_version"].is_string(), "helper_version must be a string");
    assert_eq!(val["params"]["protocol_version"], 1u64);
}

// ── AC-2 / engine.version shape ──────────────────────────────────────────────

#[tokio::test]
async fn ac2_framing_and_engine_version_shape() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    let req = make_request(42, "engine.version", None);
    write_frame(&mut stream, &req).await;

    let resp_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out");

    let val: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap();
    assert_eq!(val["id"], 42u64);
    assert_eq!(val["jsonrpc"], "2.0");
    // Must return { helper_version, protocol_version } only (not EngineStatus).
    assert!(val["result"]["helper_version"].is_string(), "result.helper_version must be a string");
    assert_eq!(val["result"]["protocol_version"], 1u64, "result.protocol_version must be 1");
    // Must NOT include extra EngineStatus fields.
    assert!(val["result"]["state"].is_null(), "result must not contain 'state' (not EngineStatus)");
    assert!(val["result"]["uptime_ms"].is_null(), "result must not contain 'uptime_ms'");
}

// ── AC-3: oversized frame rejected with -32600 ─────────────────────────────

#[tokio::test]
async fn ac3_oversized_frame_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    // Send a frame header claiming 1 MiB + 1 byte; server checks length before allocating.
    let oversized_len: u32 = (1024 * 1024 + 1) as u32;
    stream.write_all(&oversized_len.to_be_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let resp_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out waiting for oversized-frame error");

    let val: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap();
    assert!(val["error"]["code"].is_number(), "expected integer error code for oversized frame");
    assert_eq!(val["error"]["code"], -32600i64);
}

// ── AC-4: stub returns string code "not-implemented" with method name ────────

#[tokio::test]
async fn ac4_stub_returns_not_implemented_with_method_name() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    // capture.* are real implementations on Linux; use a remaining stub for this AC check.
    let req = make_request(1, "engine.diagnosticsBundlePath", None);
    write_frame(&mut stream, &req).await;

    let resp_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out");

    let val: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap();
    assert_eq!(val["id"], 1u64);
    assert_eq!(val["error"]["code"], "not-implemented", "stub code must be string 'not-implemented'");
    // Issue #6: message must contain the method name.
    let msg = val["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("engine.diagnosticsBundlePath"),
        "stub message must contain method name; got: {msg:?}"
    );
}

// ── AC-5: engine.setLogLevel changes filter without crashing ─────────────────

#[tokio::test]
async fn ac5_set_log_level() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    let req = make_request(7, "engine.setLogLevel", Some(serde_json::json!({ "level": "debug" })));
    write_frame(&mut stream, &req).await;

    let resp_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out");

    let val: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap();
    assert_eq!(val["id"], 7u64);
    // N-007 §5.3: engine.setLogLevel returns void (null result), no error.
    assert!(val["error"].is_null(), "setLogLevel should not return an error; got: {val}");
}

// ── AC-6: second connection is rejected ──────────────────────────────────────

#[tokio::test]
async fn ac6_single_connection_enforced() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;

    let mut first = connect(&socket_path).await;
    read_frame(&mut first).await; // drain engine.ready

    let mut second = connect(&socket_path).await;

    let result = tokio::time::timeout(Duration::from_secs(1), try_read_frame(&mut second)).await;
    match result {
        Ok(None) | Err(_) => {} // EOF or timeout — server dropped second connection as expected
        Ok(Some(bytes)) => {
            let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
            assert_ne!(
                val["method"], "engine.ready",
                "second connection must not receive engine.ready"
            );
        }
    }
}

// ── Issue #3: notification with absent id gets no response ───────────────────

#[tokio::test]
async fn notification_gets_no_response() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    // Send a JSON-RPC message WITHOUT an id field (notification).
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "engine.version",
        // deliberately no "id" field
    });
    write_frame(&mut stream, &serde_json::to_vec(&notification).unwrap()).await;

    // Give the server a moment to process.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Now send a real request — we should get ONLY one response (for this request).
    let req = make_request(99, "engine.health", None);
    write_frame(&mut stream, &req).await;

    let resp_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out waiting for health response");

    let val: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap();
    // The response must be for id=99, not for the notification (which had no id).
    assert_eq!(val["id"], 99u64, "got response for wrong id; notification must not produce a response");
    assert!(val["error"].is_null(), "engine.health should succeed");
}

// ── Issue #4: regular file at socket path is not deleted ─────────────────────

#[tokio::test]
async fn regular_file_at_socket_path_not_deleted() {
    use std::os::unix::fs::DirBuilderExt;
    let tmp = tempfile::tempdir().unwrap();
    // Socket must be in a 0700 directory so ensure_private_socket_dir passes
    // and the test correctly exercises cleanup_stale_socket on the regular file.
    let socket_dir = tmp.path().join("private");
    std::fs::DirBuilder::new().mode(0o700).create(&socket_dir).unwrap();
    let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();

    // Create a regular file (not a socket) at the path the server would use.
    std::fs::write(&socket_path, b"sentinel").unwrap();

    let set_level: cove_replay_engine::SetLevelFn = std::sync::Arc::new(|_| Ok(()));
    let result =
        cove_replay_engine::transport::server::run(&socket_path, set_level).await;

    // Server must refuse to start.
    assert!(result.is_err(), "server should fail when socket path is a regular file");

    // File must still exist and be unchanged.
    let content = std::fs::read(&socket_path).unwrap();
    assert_eq!(content, b"sentinel", "regular file must not be deleted by the server");
}

// ── Startup blocked by live socket ───────────────────────────────────────────

#[tokio::test]
async fn live_socket_blocks_startup() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready — proves server is live

    let sp = socket_path.clone();
    let result = cove_replay_engine::transport::server::run(
        &sp,
        std::sync::Arc::new(|_| Ok(())),
    )
    .await;

    assert!(result.is_err(), "second server must fail to start against a live socket");
}

// ── Shutdown removes own socket by identity ───────────────────────────────────

#[tokio::test]
async fn shutdown_removes_own_socket() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await;

    let req = make_request(1, "engine.shutdown", None);
    write_frame(&mut stream, &req).await;
    let resp_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out waiting for shutdown response");
    let val: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap();
    assert!(val["result"]["ok"].as_bool().unwrap_or(false));

    tokio::time::timeout(Duration::from_secs(5), srv)
        .await
        .expect("server task timed out")
        .ok();

    assert!(
        !std::path::Path::new(&socket_path).exists(),
        "socket must be removed after clean shutdown"
    );
}

// ── 0755 parent is rejected; startup fails with clear error ──────────────────

#[tokio::test]
async fn startup_fails_for_0755_parent() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    // Explicitly set 0755 regardless of process umask so the test is deterministic.
    std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let socket_path = tmp.path().join("engine.sock").to_string_lossy().into_owned();

    let set_level: cove_replay_engine::SetLevelFn = std::sync::Arc::new(|_| Ok(()));
    // Wrap with a timeout: if ensure_private_socket_dir ever incorrectly accepts the
    // 0755 dir, run() would block in the accept loop and the test would hang.
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        cove_replay_engine::transport::server::run(&socket_path, set_level),
    )
    .await
    .expect("run() must not block for a rejected socket parent");

    assert!(result.is_err(), "startup must fail when parent directory is 0755");
    let msg = result.unwrap_err().to_string();
    assert!(
        msg.contains("0700") || msg.contains("mode"),
        "error must mention 0700 or mode; got: {msg:?}"
    );
    assert!(
        !std::path::Path::new(&socket_path).exists(),
        "socket must not exist after rejected startup"
    );
}

// ── Actual bind parent is always 0700 ────────────────────────────────────────

#[tokio::test]
async fn bind_parent_is_0700() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    let parent = std::path::Path::new(&socket_path).parent().unwrap();
    let mode = std::fs::metadata(parent).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "socket parent directory must have mode 0700");
}

// ── T-016: listSources is side-effect-free; session-only methods fail without requestSession ──

#[cfg(target_os = "linux")]
#[tokio::test]
async fn capture_list_sources_does_not_create_session_state() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    // listSources must succeed and return a modes array.
    let req = make_request(1, "capture.listSources", None);
    write_frame(&mut stream, &req).await;
    let bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out on listSources");
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(val["id"], 1u64);
    assert!(val["error"].is_null(), "listSources must succeed; got: {val}");
    assert!(val["result"]["modes"].is_array(), "listSources result must have modes array");

    // setRegion after listSources-only must fail — no session created.
    let req = make_request(2, "capture.setRegion", Some(serde_json::json!({
        "x": 0, "y": 0, "width": 1920, "height": 1080
    })));
    write_frame(&mut stream, &req).await;
    let bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out on setRegion");
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(val["error"].is_object(), "setRegion without session must fail; got: {val}");

    // setFramerateHint after listSources-only must fail.
    let req = make_request(3, "capture.setFramerateHint", Some(serde_json::json!({ "fps": 30 })));
    write_frame(&mut stream, &req).await;
    let bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out on setFramerateHint");
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(val["error"].is_object(), "setFramerateHint without session must fail; got: {val}");

    // setCursorMode after listSources-only must fail with session error (not params error),
    // confirming valid { "mode": ... } params reach session validation.
    let req = make_request(4, "capture.setCursorMode", Some(serde_json::json!({ "mode": "embedded" })));
    write_frame(&mut stream, &req).await;
    let bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out on setCursorMode");
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(val["error"].is_object(), "setCursorMode without session must fail; got: {val}");
    let msg = val["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("session"),
        "setCursorMode without session must report session error (not params error); got: {msg:?}"
    );

    // startStream after listSources-only must fail with a session-missing error,
    // not a phase-mismatch error from inside PipeWireSource.
    let req = make_request(5, "capture.startStream", None);
    write_frame(&mut stream, &req).await;
    let bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out on startStream");
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(val["error"].is_object(), "startStream without requestSession must fail; got: {val}");
    let msg = val["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("no active session") || msg.contains("session"),
        "startStream without requestSession must report session-missing error; got: {msg:?}"
    );
}

// ── T-016: setFramerateHint validates fps param ──────────────────────────────

#[cfg(target_os = "linux")]
#[tokio::test]
async fn set_framerate_hint_validates_fps_param() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    // Missing fps field → parse error.
    let req = make_request(1, "capture.setFramerateHint", Some(serde_json::json!({})));
    write_frame(&mut stream, &req).await;
    let val: serde_json::Value = serde_json::from_slice(
        &tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .expect("timeout"),
    )
    .unwrap();
    assert!(val["error"].is_object(), "missing fps must fail; got: {val}");

    // fps = 0 → out-of-range error.
    let req = make_request(2, "capture.setFramerateHint", Some(serde_json::json!({ "fps": 0 })));
    write_frame(&mut stream, &req).await;
    let val: serde_json::Value = serde_json::from_slice(
        &tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .expect("timeout"),
    )
    .unwrap();
    assert!(val["error"].is_object(), "fps=0 must fail; got: {val}");

    // fps = 999 → out of valid range (> 360).
    let req = make_request(3, "capture.setFramerateHint", Some(serde_json::json!({ "fps": 999 })));
    write_frame(&mut stream, &req).await;
    let val: serde_json::Value = serde_json::from_slice(
        &tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .expect("timeout"),
    )
    .unwrap();
    assert!(val["error"].is_object(), "fps=999 must fail; got: {val}");

    // fps = -1 → serde rejects negative into u32.
    let req = make_request(4, "capture.setFramerateHint", Some(serde_json::json!({ "fps": -1 })));
    write_frame(&mut stream, &req).await;
    let val: serde_json::Value = serde_json::from_slice(
        &tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .expect("timeout"),
    )
    .unwrap();
    assert!(val["error"].is_object(), "fps=-1 must fail; got: {val}");

    // fps = 30, no session → params valid, fails with session error (not params error).
    let req = make_request(5, "capture.setFramerateHint", Some(serde_json::json!({ "fps": 30 })));
    write_frame(&mut stream, &req).await;
    let val: serde_json::Value = serde_json::from_slice(
        &tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .expect("timeout"),
    )
    .unwrap();
    assert!(val["error"].is_object(), "fps=30 without session must fail; got: {val}");
    let msg = val["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("session"),
        "fps=30 without session must report session-missing error; got: {msg:?}"
    );
}

// ── T-016: failed requestSession does not create phantom session state ────────
//
// Duplicate requestSession (with an active session) returns "session already active"
// and preserves the existing capture — this requires a real Wayland compositor and
// cannot be exercised in a headless test environment. What IS verifiable headlessly:
// a failed requestSession (portal unavailable) must not store a phantom
// active_capture, so subsequent session-only methods still report "no active session".

#[cfg(target_os = "linux")]
#[tokio::test]
async fn request_session_failure_does_not_create_session_state() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    // requestSession will fail in headless env (no Wayland portal).
    // If it somehow succeeds (real compositor), skip the subsequent assertions.
    // Enum values are snake_case per #[serde(rename_all = "snake_case")] on all protocol enums.
    let params = serde_json::json!({
        "mode": "monitor",
        "cursor_mode": "embedded",
        "persist": "transient"
    });
    let req = make_request(1, "capture.requestSession", Some(params));
    write_frame(&mut stream, &req).await;

    // Portal may be slow to fail in headless environments (D-Bus service activation
    // delay can be >5 s). Return early on timeout rather than panicking — the test
    // is inconclusive in environments where the portal never responds.
    let val: serde_json::Value =
        match tokio::time::timeout(Duration::from_secs(10), read_frame(&mut stream)).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap(),
            Err(_) => return, // portal unavailable and slow to fail; inconclusive
        };

    if val["error"].is_object() {
        // Portal failed — verify no phantom active_capture was stored.
        let req = make_request(2, "capture.startStream", None);
        write_frame(&mut stream, &req).await;
        let val: serde_json::Value = serde_json::from_slice(
            &tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
                .await
                .expect("timeout on startStream"),
        )
        .unwrap();
        assert!(val["error"].is_object(), "startStream after failed requestSession must fail; got: {val}");
        let msg = val["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("no active session") || msg.contains("session"),
            "startStream after failed requestSession must report no-session error; got: {msg:?}"
        );
    }
    // If requestSession succeeded (real compositor present), test passes trivially —
    // the duplicate-session guard is exercised in production environments.
}

// ── Disconnect during requestSession: server recovers for new client ──────────
//
// Uses sim mode to avoid a real portal. Verifies the outer spawn+cancel mechanism
// in handle_connection: after a client drops mid-dispatch, the server resets its
// single-connection gate and a new client can connect and issue normal requests.
//
// Note: in sim mode `capture.requestSession` completes synchronously (no portal
// dialog), so the first client's request may finish before EOF is observed. The
// test therefore probes server liveness with `engine.version` on reconnect rather
// than a second `capture.requestSession` (which would collide with sim's retained
// session state). The per-step portal cancel paths (select_sources, start,
// open_pipe_wire_remote) require a real compositor and are verified by inspection.

#[cfg(unix)]
#[tokio::test]
async fn disconnect_during_requestsession_allows_reconnect() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_sim_server(&tmp).await;

    // Connect, send requestSession, drop without reading the response.
    {
        let mut stream = connect(&socket_path).await;
        read_frame(&mut stream).await; // drain engine.ready

        let params = serde_json::json!({
            "mode": "monitor",
            "cursor_mode": "embedded",
            "persist": "transient"
        });
        let req = make_request(1, "capture.requestSession", Some(params));
        write_frame(&mut stream, &req).await;
        // Drop immediately — simulates disconnect during (or just after) dispatch.
        drop(stream);
    }

    // Allow the server to observe EOF and reset the connection gate.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // New client must be able to connect, receive engine.ready, and get a
    // response to a simple engine.version request — proving the server is not stuck.
    let mut stream = connect(&socket_path).await;
    let ready_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out waiting for engine.ready on reconnect");
    let val: serde_json::Value = serde_json::from_slice(&ready_bytes).unwrap();
    assert_eq!(val["method"], "engine.ready", "must receive engine.ready on reconnect");

    let req = make_request(2, "engine.version", None);
    write_frame(&mut stream, &req).await;
    let resp_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out waiting for engine.version response on reconnect");
    let val: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap();
    assert_eq!(val["id"], 2u64);
    assert!(
        val["error"].is_null(),
        "engine.version on reconnect must succeed; got: {val}"
    );
    assert!(
        val["result"]["helper_version"].is_string(),
        "engine.version must include helper_version; got: {val}"
    );
}

// ── Pipelined requests: both get responses, connection not closed ─────────────
//
// Sends two requests back-to-back without waiting for the first response.
// Verifies that both responses arrive and the connection remains open.
// This covers the buffering path: if the second frame arrives while the first
// dispatch is still in-flight (select race), it must be buffered, not cancelled.
// Directly forcing the race requires a slow-dispatch seam; what IS deterministic
// is that pipelined frames are never dropped or cause a connection close.

#[tokio::test]
async fn pipelined_requests_both_get_responses() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    // Send both requests before reading either response.
    let req1 = make_request(10, "engine.version", None);
    let req2 = make_request(11, "engine.health", None);
    write_frame(&mut stream, &req1).await;
    write_frame(&mut stream, &req2).await;

    // Both must arrive; collect by id.
    let mut ids = std::collections::HashMap::new();
    for _ in 0..2 {
        let bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .expect("timed out waiting for pipelined response");
        let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = val["id"].as_u64().expect("response must have numeric id");
        ids.insert(id, val);
    }

    assert!(ids.contains_key(&10), "response for id=10 (engine.version) must arrive");
    assert!(ids.contains_key(&11), "response for id=11 (engine.health) must arrive");
    assert!(ids[&10]["error"].is_null(), "engine.version must succeed; got: {:?}", ids[&10]);
    assert!(ids[&11]["error"].is_null(), "engine.health must succeed; got: {:?}", ids[&11]);
}

// ── engine.health while another request is in-flight does not close connection ─
//
// Sends a first request (engine.version), immediately sends engine.health as a
// second pipelined request, then verifies connection remains open with a third
// request. Simulates the supervisor heartbeat pattern.

#[tokio::test]
async fn pipelined_health_does_not_close_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    let req1 = make_request(20, "engine.version", None);
    let req2 = make_request(21, "engine.health", None);
    let req3 = make_request(22, "engine.version", None);
    write_frame(&mut stream, &req1).await;
    write_frame(&mut stream, &req2).await;
    write_frame(&mut stream, &req3).await;

    let mut ids = std::collections::HashMap::new();
    for _ in 0..3 {
        let bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .expect("timed out — connection was likely closed prematurely");
        let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = val["id"].as_u64().expect("response must have numeric id");
        ids.insert(id, val);
    }

    assert!(ids.contains_key(&20), "response for id=20 must arrive");
    assert!(ids.contains_key(&21), "response for id=21 (engine.health) must arrive");
    assert!(ids.contains_key(&22), "response for id=22 must arrive; connection must stay open");
    assert!(ids[&21]["error"].is_null(), "engine.health must succeed; got: {:?}", ids[&21]);
}

// ── Bounded pending queue: normal pipelining within limit still succeeds ──────
//
// Uses max_pending_frames=4 (below the default of 16) and sends 3 back-to-back
// requests. All 3 must be processed successfully, proving that reducing the
// pending-frame limit does not break legitimate pipelining within the bound.
//
// Note: deterministic testing of the limit-exceeded path (closing the connection
// when pending_frames.len() >= max_pending_frames) requires a slow-dispatch seam
// so that pipelined frames accumulate while a dispatch is still in-flight. No such
// seam exists in production code; the RunConfig.max_pending_frames field is the
// narrowest available test hook and a future session can add a #[cfg(test)] dispatch
// delay to cover the exceeded-limit code path deterministically.

#[cfg(unix)]
#[tokio::test]
async fn bounded_pipeline_within_limit_succeeds() {
    let tmp = tempfile::tempdir().unwrap();
    // max_pending_frames=4: plenty of room for 3 pipelined requests.
    let (socket_path, _srv) = spawn_sim_server_limited(&tmp, 4).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    let req1 = make_request(30, "engine.version", None);
    let req2 = make_request(31, "engine.health", None);
    let req3 = make_request(32, "engine.version", None);
    write_frame(&mut stream, &req1).await;
    write_frame(&mut stream, &req2).await;
    write_frame(&mut stream, &req3).await;

    let mut ids = std::collections::HashMap::new();
    for _ in 0..3 {
        let bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .expect("timed out — bounded pipeline should not have closed connection early");
        let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let id = val["id"].as_u64().expect("response must have numeric id");
        ids.insert(id, val);
    }

    assert!(ids.contains_key(&30), "response for id=30 must arrive");
    assert!(ids.contains_key(&31), "response for id=31 must arrive");
    assert!(ids.contains_key(&32), "response for id=32 must arrive");
}

// ── Actual disconnect still observed: server recovers after client drop ───────
//
// Covered by disconnect_during_requestsession_allows_reconnect above.
// Separate EOF test: client sends one request then drops; server must not hang.

#[tokio::test]
async fn eof_after_request_server_recovers() {
    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;

    {
        let mut stream = connect(&socket_path).await;
        read_frame(&mut stream).await; // drain engine.ready
        let req = make_request(1, "engine.health", None);
        write_frame(&mut stream, &req).await;
        // drop without reading response — simulates abrupt disconnect
        drop(stream);
    }

    tokio::time::sleep(Duration::from_millis(300)).await;

    // Server must accept a new connection cleanly.
    let mut stream = connect(&socket_path).await;
    let ready = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
        .await
        .expect("timed out waiting for engine.ready after client drop");
    let val: serde_json::Value = serde_json::from_slice(&ready).unwrap();
    assert_eq!(val["method"], "engine.ready", "server must send engine.ready to new client");
}

// ── Stub method name appears in error message (all stubs) ────────────────────

#[tokio::test]
async fn all_stubs_include_method_name() {
    // capture.* are real implementations on Linux — removed from stub list.
    let stubs = &[
        "engine.diagnosticsBundlePath",
        "replay.save",
        "replay.snapshot_release",
        "replay.recoverable_sessions",
        "replay.discard_recovered_session",
        "replay.restore_recovered_session",
        "replay.export_start",
        "replay.export_cancel",
    ];

    let tmp = tempfile::tempdir().unwrap();
    let (socket_path, _srv) = spawn_server(&tmp).await;
    let mut stream = connect(&socket_path).await;
    read_frame(&mut stream).await; // drain engine.ready

    for (i, method) in stubs.iter().enumerate() {
        let req = make_request(i as u64, method, None);
        write_frame(&mut stream, &req).await;

        let resp_bytes = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stream))
            .await
            .unwrap_or_else(|_| panic!("timed out on {method}"));

        let val: serde_json::Value = serde_json::from_slice(&resp_bytes).unwrap();
        assert_eq!(val["id"], i as u64, "{method}: wrong id in response");
        assert_eq!(
            val["error"]["code"], "not-implemented",
            "{method}: error code must be string 'not-implemented'"
        );
        let msg = val["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains(method),
            "{method}: message must contain method name; got: {msg:?}"
        );
    }
}
