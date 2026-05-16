mod simulate {
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    use cove_replay_engine::{
        sim::{parse_fail_specs, SimConfig, SimState},
        transport::server::{run_with_config, RunConfig},
    };

    async fn write_frame(stream: &mut UnixStream, payload: &[u8]) {
        let len = payload.len() as u32;
        stream.write_all(&len.to_be_bytes()).await.unwrap();
        stream.write_all(payload).await.unwrap();
        stream.flush().await.unwrap();
    }

    async fn read_frame(stream: &mut UnixStream) -> serde_json::Value {
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).await.unwrap();
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut buf = vec![0u8; len];
        stream.read_exact(&mut buf).await.unwrap();
        serde_json::from_slice(&buf).unwrap()
    }

    /// Read frames until one has the given method; panics after 15 s.
    async fn drain_until(stream: &mut UnixStream, method: &str) -> serde_json::Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline - tokio::time::Instant::now();
            let msg = tokio::time::timeout(remaining, read_frame(stream))
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {method}"));
            if msg.get("method").and_then(|m| m.as_str()) == Some(method) {
                return msg;
            }
        }
    }

    async fn rpc(
        stream: &mut UnixStream,
        id: u32,
        method: &str,
        params: serde_json::Value,
    ) -> serde_json::Value {
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let bytes = serde_json::to_vec(&req).unwrap();
        write_frame(stream, &bytes).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline - tokio::time::Instant::now();
            let msg = tokio::time::timeout(remaining, read_frame(stream))
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for response to {method}"));
            if msg.get("id").and_then(|v| v.as_u64()) == Some(id as u64) {
                return msg;
            }
        }
    }

    async fn spawn_sim_server(
        tmp: &tempfile::TempDir,
        sim: Arc<SimState>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use std::os::unix::fs::DirBuilderExt;
        let socket_dir = tmp.path().join("private");
        std::fs::DirBuilder::new().mode(0o700).create(&socket_dir).unwrap();
        let socket_path = socket_dir.join("engine.sock").to_string_lossy().into_owned();
        let sp = socket_path.clone();
        let handle = tokio::spawn(async move {
            let set_level: cove_replay_engine::SetLevelFn = Arc::new(|_| Ok(()));
            run_with_config(&sp, set_level, RunConfig { sim: Some(sim), ..Default::default() }).await.ok();
        });
        for _ in 0..40 {
            if std::path::Path::new(&socket_path).exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        (socket_path, handle)
    }

    #[tokio::test]
    async fn round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let sim = SimState::new(SimConfig::default());
        let (socket_path, server) = spawn_sim_server(&tmp, Arc::clone(&sim)).await;

        let mut stream = UnixStream::connect(&socket_path).await.unwrap();

        // Server immediately sends engine.ready.
        let ready = read_frame(&mut stream).await;
        assert_eq!(
            ready["method"].as_str(),
            Some("engine.ready"),
            "expected engine.ready, got {ready}"
        );

        // capture.requestSession
        let resp = rpc(
            &mut stream,
            1,
            "capture.requestSession",
            serde_json::json!({ "mode": "monitor", "cursor_mode": "embedded", "persist": "transient" }),
        )
        .await;
        assert!(resp.get("result").is_some(), "requestSession failed: {resp}");

        // capture.startStream — required before sessionReady fires.
        let resp = rpc(&mut stream, 2, "capture.startStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "startStream failed: {resp}");

        // Verify the deterministic probe backend list: nvenc, vaapi, qsv, libx264.
        let probe = drain_until(&mut stream, "encoder.probeResult").await;
        let probe_backends: Vec<&str> = probe["params"]["backends"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["backend"].as_str().unwrap())
            .collect();
        assert_eq!(
            probe_backends,
            &["nvenc", "vaapi", "qsv", "libx264"],
            "unexpected probe backends: {probe_backends:?}"
        );

        // capture.sessionReady must arrive before encoder.selected (T-015 ordering).
        let sr = drain_until(&mut stream, "capture.sessionReady").await;
        let session_id = sr["params"]["session_id"].as_str().unwrap().to_string();
        let stream_id = sr["params"]["stream_id"].as_str().unwrap().to_string();
        assert!(!session_id.is_empty());

        // encoder.selected fires 50 ms after sessionReady; draining for it after
        // sessionReady verifies ordering — if it had arrived before sessionReady it
        // would have been consumed above and this drain would timeout.
        let selected = drain_until(&mut stream, "encoder.selected").await;
        assert_eq!(
            selected["params"]["backend"].as_str(),
            Some("nvenc"),
            "unexpected selected backend: {selected}"
        );

        // Let one diagnostics tick fire at 1 Hz (capture + encoder + segment diagnostics).
        tokio::time::sleep(Duration::from_millis(1100)).await;

        // Pause the stream while recording.
        let resp = rpc(&mut stream, 3, "capture.pauseStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "pauseStream failed: {resp}");
        let paused = drain_until(&mut stream, "capture.streamPaused").await;
        assert_eq!(
            paused["params"]["stream_id"].as_str(),
            Some(stream_id.as_str()),
            "streamPaused stream_id mismatch"
        );

        // Resume the stream.
        let resp = rpc(&mut stream, 4, "capture.resumeStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "resumeStream failed: {resp}");
        drain_until(&mut stream, "capture.streamResumed").await;

        // Stop the session.
        let resp = rpc(
            &mut stream,
            5,
            "capture.stopSession",
            serde_json::json!({ "session_id": session_id }),
        )
        .await;
        assert!(resp.get("result").is_some(), "stopSession failed: {resp}");

        // replay.save — response carries the snapshot; event fires separately.
        let resp = rpc(
            &mut stream,
            6,
            "replay.save",
            serde_json::json!({ "session_id": session_id }),
        )
        .await;
        assert!(resp.get("result").is_some(), "replay.save failed: {resp}");
        let snapshot_id = resp["result"]["snapshot_id"].as_str().unwrap().to_string();
        assert!(!snapshot_id.is_empty());

        drain_until(&mut stream, "replay.snapshotPinned").await;

        // replay.export_start
        let resp = rpc(
            &mut stream,
            7,
            "replay.export_start",
            serde_json::json!({
                "snapshot_id": snapshot_id,
                "options": { "max_compat": false, "audio_mode": "default" }
            }),
        )
        .await;
        assert!(resp.get("result").is_some(), "export_start failed: {resp}");
        let export_id = resp["result"]["export_id"].as_str().unwrap().to_string();
        assert!(!export_id.is_empty());

        // Wait for export.completed and verify the artifact was created on disk.
        let completed = drain_until(&mut stream, "export.completed").await;
        assert_eq!(
            completed["params"]["export_id"].as_str(),
            Some(export_id.as_str()),
            "export_id mismatch"
        );
        let final_path = completed["params"]["final_path"].as_str().unwrap();
        let meta = std::fs::metadata(final_path)
            .unwrap_or_else(|_| panic!("export artifact not found at {final_path}"));
        assert!(meta.len() > 0, "export artifact is empty");

        // replay.snapshot_release
        let resp = rpc(
            &mut stream,
            8,
            "replay.snapshot_release",
            serde_json::json!({ "snapshot_id": snapshot_id }),
        )
        .await;
        assert!(resp.get("result").is_some(), "snapshot_release failed: {resp}");
        drain_until(&mut stream, "replay.snapshotReleased").await;

        // Graceful shutdown.
        let _resp = rpc(&mut stream, 9, "engine.shutdown", serde_json::json!({})).await;

        server.abort();
        let _ = std::fs::remove_file(&socket_path);
    }

    /// Verify that capture.startStream failure injection transitions back to Idle,
    /// allowing a subsequent session to be requested.
    #[tokio::test]
    async fn failure_injection() {
        let specs =
            parse_fail_specs(&["capture.startStream=pipewire-state-error".to_string()]).unwrap();
        let config = SimConfig { encoder: "software".to_string(), fail_specs: std::sync::Mutex::new(specs) };
        let sim = SimState::new(config);

        let tmp = tempfile::tempdir().unwrap();
        let (socket_path, server) = spawn_sim_server(&tmp, Arc::clone(&sim)).await;

        let mut stream = UnixStream::connect(&socket_path).await.unwrap();

        // Discard engine.ready.
        let _ = read_frame(&mut stream).await;

        // requestSession → ok (SessionRequested).
        let resp = rpc(
            &mut stream,
            1,
            "capture.requestSession",
            serde_json::json!({ "mode": "monitor", "cursor_mode": "embedded", "persist": "transient" }),
        )
        .await;
        assert!(resp.get("result").is_some(), "requestSession failed: {resp}");

        // startStream → ok (Streaming; triggers background task).
        let resp = rpc(&mut stream, 2, "capture.startStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "startStream failed: {resp}");

        // Task fires sessionLost instead of sessionReady.
        let lost = drain_until(&mut stream, "capture.sessionLost").await;
        assert_eq!(
            lost["params"]["reason"].as_str(),
            Some("pipewire-state-error"),
            "unexpected reason: {lost}"
        );

        // FSM is back to Idle — a new session must succeed.
        let resp = rpc(
            &mut stream,
            3,
            "capture.requestSession",
            serde_json::json!({ "mode": "monitor", "cursor_mode": "embedded", "persist": "transient" }),
        )
        .await;
        assert!(
            resp.get("result").is_some(),
            "second requestSession failed (FSM did not return to Idle): {resp}"
        );

        server.abort();
        let _ = std::fs::remove_file(&socket_path);
    }

    /// Verify that two same-target failure specs are consumed in order, allowing
    /// a third attempt (with no specs remaining) to succeed.
    #[tokio::test]
    async fn chained_failure() {
        let specs = parse_fail_specs(&[
            "capture.startStream=reason-a".to_string(),
            "capture.startStream=reason-b".to_string(),
        ])
        .unwrap();
        let config = SimConfig {
            encoder: "nvenc".to_string(),
            fail_specs: std::sync::Mutex::new(specs),
        };
        let sim = SimState::new(config);

        let tmp = tempfile::tempdir().unwrap();
        let (socket_path, server) = spawn_sim_server(&tmp, Arc::clone(&sim)).await;

        let mut stream = UnixStream::connect(&socket_path).await.unwrap();
        let _ = read_frame(&mut stream).await; // discard engine.ready

        // Attempt 1: consumes reason-a.
        let resp = rpc(
            &mut stream,
            1,
            "capture.requestSession",
            serde_json::json!({ "mode": "monitor", "cursor_mode": "embedded", "persist": "transient" }),
        )
        .await;
        assert!(resp.get("result").is_some(), "attempt 1 requestSession failed: {resp}");
        let resp = rpc(&mut stream, 2, "capture.startStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "attempt 1 startStream failed: {resp}");
        let lost = drain_until(&mut stream, "capture.sessionLost").await;
        assert_eq!(
            lost["params"]["reason"].as_str(),
            Some("reason-a"),
            "attempt 1: unexpected reason: {lost}"
        );

        // Attempt 2: consumes reason-b.
        let resp = rpc(
            &mut stream,
            3,
            "capture.requestSession",
            serde_json::json!({ "mode": "monitor", "cursor_mode": "embedded", "persist": "transient" }),
        )
        .await;
        assert!(resp.get("result").is_some(), "attempt 2 requestSession failed: {resp}");
        let resp = rpc(&mut stream, 4, "capture.startStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "attempt 2 startStream failed: {resp}");
        let lost = drain_until(&mut stream, "capture.sessionLost").await;
        assert_eq!(
            lost["params"]["reason"].as_str(),
            Some("reason-b"),
            "attempt 2: unexpected reason: {lost}"
        );

        // Attempt 3: no specs remaining — must reach sessionReady.
        let resp = rpc(
            &mut stream,
            5,
            "capture.requestSession",
            serde_json::json!({ "mode": "monitor", "cursor_mode": "embedded", "persist": "transient" }),
        )
        .await;
        assert!(resp.get("result").is_some(), "attempt 3 requestSession failed: {resp}");
        let resp = rpc(&mut stream, 6, "capture.startStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "attempt 3 startStream failed: {resp}");
        drain_until(&mut stream, "capture.sessionReady").await;

        server.abort();
        let _ = std::fs::remove_file(&socket_path);
    }

    /// Verify that stream_paused is cleared at session boundaries: a session that
    /// ends while paused must not poison the pause state for the next session.
    #[tokio::test]
    async fn paused_session_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let sim = SimState::new(SimConfig::default());
        let (socket_path, server) = spawn_sim_server(&tmp, Arc::clone(&sim)).await;

        let mut stream = UnixStream::connect(&socket_path).await.unwrap();
        let _ = read_frame(&mut stream).await; // discard engine.ready

        // Session 1: reach Recording, pause, stop without resuming, save.
        let resp = rpc(
            &mut stream,
            1,
            "capture.requestSession",
            serde_json::json!({ "mode": "monitor", "cursor_mode": "embedded", "persist": "transient" }),
        )
        .await;
        assert!(resp.get("result").is_some(), "s1 requestSession failed: {resp}");

        let resp = rpc(&mut stream, 2, "capture.startStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "s1 startStream failed: {resp}");

        let sr = drain_until(&mut stream, "capture.sessionReady").await;
        let session_id_1 = sr["params"]["session_id"].as_str().unwrap().to_string();

        // Pause the stream — do NOT resume.
        let resp = rpc(&mut stream, 3, "capture.pauseStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "s1 pauseStream failed: {resp}");
        drain_until(&mut stream, "capture.streamPaused").await;

        // Stop while still paused.
        let resp = rpc(
            &mut stream,
            4,
            "capture.stopSession",
            serde_json::json!({ "session_id": session_id_1 }),
        )
        .await;
        assert!(resp.get("result").is_some(), "s1 stopSession failed: {resp}");

        // Save.
        let resp = rpc(
            &mut stream,
            5,
            "replay.save",
            serde_json::json!({ "session_id": session_id_1 }),
        )
        .await;
        assert!(resp.get("result").is_some(), "s1 replay.save failed: {resp}");
        let snapshot_id = resp["result"]["snapshot_id"].as_str().unwrap().to_string();
        drain_until(&mut stream, "replay.snapshotPinned").await;

        // Release the snapshot so FSM is clean.
        let resp = rpc(
            &mut stream,
            6,
            "replay.snapshot_release",
            serde_json::json!({ "snapshot_id": snapshot_id }),
        )
        .await;
        assert!(resp.get("result").is_some(), "s1 snapshot_release failed: {resp}");
        drain_until(&mut stream, "replay.snapshotReleased").await;

        // Session 2: must be able to pause successfully.
        let resp = rpc(
            &mut stream,
            7,
            "capture.requestSession",
            serde_json::json!({ "mode": "monitor", "cursor_mode": "embedded", "persist": "transient" }),
        )
        .await;
        assert!(resp.get("result").is_some(), "s2 requestSession failed: {resp}");

        let resp = rpc(&mut stream, 8, "capture.startStream", serde_json::json!({})).await;
        assert!(resp.get("result").is_some(), "s2 startStream failed: {resp}");

        drain_until(&mut stream, "capture.sessionReady").await;

        // This must succeed — prior paused state must not have leaked.
        let resp = rpc(&mut stream, 9, "capture.pauseStream", serde_json::json!({})).await;
        assert!(
            resp.get("result").is_some(),
            "s2 pauseStream failed (paused state leaked from prior session): {resp}"
        );
        drain_until(&mut stream, "capture.streamPaused").await;

        server.abort();
        let _ = std::fs::remove_file(&socket_path);
    }
}
