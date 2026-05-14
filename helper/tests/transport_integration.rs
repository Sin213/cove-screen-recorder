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
    let socket_path = tmp.path().join("engine.sock").to_string_lossy().into_owned();
    let sp = socket_path.clone();
    let handle = tokio::spawn(async move {
        let set_level: cove_replay_engine::SetLevelFn = std::sync::Arc::new(|_| Ok(()));
        cove_replay_engine::transport::server::run(&sp, set_level)
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

    let req = make_request(1, "capture.listSources", None);
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
        msg.contains("capture.listSources"),
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
    let tmp = tempfile::tempdir().unwrap();
    let socket_path = tmp.path().join("engine.sock").to_string_lossy().into_owned();

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

// ── Stub method name appears in error message (all stubs) ────────────────────

#[tokio::test]
async fn all_stubs_include_method_name() {
    let stubs = &[
        "engine.diagnosticsBundlePath",
        "capture.listSources",
        "capture.requestSession",
        "capture.startStream",
        "capture.pauseStream",
        "capture.resumeStream",
        "capture.stopSession",
        "capture.setRegion",
        "capture.setFramerateHint",
        "capture.setCursorMode",
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
