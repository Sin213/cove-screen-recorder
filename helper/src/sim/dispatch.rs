use std::sync::Arc;

use serde_json::json;
use tokio::time::{sleep, Duration};

use crate::{
    engine::SharedState,
    protocol::{
        envelope::{Request, Response, RpcError},
        events::*,
        types::*,
    },
    sim::{FsmPhase, SimState},
    transport::dispatcher::Notifier,
};

pub async fn dispatch_sim(
    req: Request,
    _state: &SharedState,
    notifier: &Notifier,
    sim: &Arc<SimState>,
) -> Option<Response> {
    let id = req.id.clone();
    match req.method.as_str() {
        "capture.listSources" => Some(handle_list_sources(id)),
        "capture.requestSession" => Some(handle_request_session(id, sim).await),
        "capture.startStream" => Some(handle_start_stream(id, notifier, sim).await),
        "capture.pauseStream" => Some(handle_pause_stream(id, notifier, sim).await),
        "capture.resumeStream" => Some(handle_resume_stream(id, notifier, sim).await),
        "capture.stopSession" => Some(handle_stop_session(id, sim).await),
        "capture.setRegion" => Some(handle_session_setter(id, sim).await),
        "capture.setFramerateHint" => Some(handle_session_setter(id, sim).await),
        "capture.setCursorMode" => Some(handle_session_setter(id, sim).await),
        "replay.save" => Some(handle_replay_save(id, notifier, sim).await),
        "replay.snapshot_release" => {
            Some(handle_snapshot_release(id, req.params, notifier, sim).await)
        }
        "replay.recoverable_sessions" => Some(Response::result(id, json!({ "sessions": [] }))),
        "replay.discard_recovered_session" => Some(Response::result(id, json!({ "ok": true }))),
        "replay.restore_recovered_session" => Some(Response::result(id, json!({ "ok": true }))),
        "replay.export_start" => Some(handle_export_start(id, req.params, notifier, sim).await),
        "replay.export_cancel" => Some(handle_export_cancel(id, sim).await),
        "engine.diagnosticsBundlePath" => {
            Some(Response::result(id, json!({ "path": "/tmp/sim-diagnostics" })))
        }
        _ => Some(Response::error(id, RpcError::method_not_found())),
    }
}

fn handle_list_sources(id: Option<serde_json::Value>) -> Response {
    let descriptor = CaptureSourceDescriptor {
        modes: vec![CaptureMode::Monitor],
        known_restore_tokens: vec![],
    };
    Response::result(id, serde_json::to_value(descriptor).unwrap_or(json!(null)))
}

async fn handle_request_session(id: Option<serde_json::Value>, sim: &Arc<SimState>) -> Response {
    let mut inner = sim.inner.lock().await;
    if inner.phase != FsmPhase::Idle {
        return Response::error(id, RpcError::invalid_request("session already active"));
    }
    inner.session_id = Some(sim.next_session_id());
    inner.stream_id = Some(sim.next_stream_id());
    inner.stream_paused = false;
    inner.phase = FsmPhase::SessionRequested;
    Response::result(id, json!({ "ok": true }))
}

async fn handle_start_stream(
    id: Option<serde_json::Value>,
    notifier: &Notifier,
    sim: &Arc<SimState>,
) -> Response {
    let (session_id, stream_id, cancel_rx) = {
        let mut inner = sim.inner.lock().await;
        if inner.phase != FsmPhase::SessionRequested {
            return Response::error(
                id,
                RpcError::invalid_request("capture.startStream requires SessionRequested phase"),
            );
        }
        let session_id = inner.session_id.clone().unwrap_or_default();
        let stream_id = inner.stream_id.clone().unwrap_or_default();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        inner.session_cancel_tx = Some(cancel_tx);
        inner.phase = FsmPhase::Streaming;
        (session_id, stream_id, cancel_rx)
    };

    let notifier_c = notifier.clone();
    let sim_c = Arc::clone(sim);
    tokio::spawn(async move {
        run_session_task(session_id, stream_id, notifier_c, sim_c, cancel_rx).await;
    });

    Response::result(id, json!({ "ok": true }))
}

async fn run_session_task(
    session_id: String,
    stream_id: String,
    notifier: Notifier,
    sim: Arc<SimState>,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    tokio::select! {
        _ = sleep(Duration::from_millis(50)) => {}
        _ = cancel_rx.changed() => return,
    }

    // Failure injection: capture.startStream target fires before any probe events.
    if let Some(reason) = sim.config.fail_for("capture.startStream") {
        let event = SessionLostEvent {
            session_id: session_id.clone(),
            stream_id: Some(stream_id.clone()),
            reason,
            details: "simulated failure".into(),
            diagnostics_path: String::new(),
        };
        let _ = notifier
            .notify("capture.sessionLost", serde_json::to_value(event).unwrap())
            .await;
        sim.inner.lock().await.phase = FsmPhase::Idle;
        return;
    }

    // Deterministic four-backend probe result.
    let probe_fail = sim.config.fail_for("encoder.probe");
    let backends = vec![
        BackendProbe {
            backend: "nvenc".into(),
            available: probe_fail.is_none(),
            codec: if probe_fail.is_none() { Some("h264".into()) } else { None },
            details: None,
        },
        BackendProbe {
            backend: "vaapi".into(),
            available: probe_fail.is_none(),
            codec: if probe_fail.is_none() { Some("h264".into()) } else { None },
            details: None,
        },
        BackendProbe {
            backend: "qsv".into(),
            available: probe_fail.is_none(),
            codec: if probe_fail.is_none() { Some("h264".into()) } else { None },
            details: None,
        },
        BackendProbe {
            backend: "libx264".into(),
            available: probe_fail.is_none(),
            codec: if probe_fail.is_none() { Some("h264".into()) } else { None },
            details: None,
        },
    ];
    let _ = notifier
        .notify(
            "encoder.probeResult",
            serde_json::to_value(EncoderProbeResultEvent { backends }).unwrap(),
        )
        .await;

    if let Some(reason) = probe_fail {
        let event = SessionLostEvent {
            session_id: session_id.clone(),
            stream_id: Some(stream_id.clone()),
            reason,
            details: "simulated failure".into(),
            diagnostics_path: String::new(),
        };
        let _ = notifier
            .notify("capture.sessionLost", serde_json::to_value(event).unwrap())
            .await;
        sim.inner.lock().await.phase = FsmPhase::Idle;
        return;
    }

    let format = CaptureFormat {
        width: 1920,
        height: 1080,
        fps_num: 60,
        fps_den: 1,
        fourcc: "NV12".into(),
        modifier: None,
        color_primaries: Some("bt709".into()),
        transfer: Some("bt709".into()),
        range: Some(PixelRange::Limited),
    };
    let event = SessionReadyEvent {
        session_id: session_id.clone(),
        stream_id: stream_id.clone(),
        format,
        restore_token: None,
        compositor_name: "sim".into(),
    };
    let _ = notifier
        .notify("capture.sessionReady", serde_json::to_value(event).unwrap())
        .await;
    sim.inner.lock().await.phase = FsmPhase::Recording;

    // encoder.selected fires 50 ms after session is ready (T-015 contract).
    tokio::select! {
        _ = sleep(Duration::from_millis(50)) => {}
        _ = cancel_rx.changed() => return,
    }

    let selected = EncoderSelectedEvent {
        backend: sim.config.encoder.clone(),
        codec: "h264".into(),
        parameters: json!({ "preset": "ultrafast" }),
        reason_for_choice: "simulation".into(),
    };
    let _ = notifier
        .notify("encoder.selected", serde_json::to_value(selected).unwrap())
        .await;

    let mut tick: u64 = 0;
    loop {
        tokio::select! {
            _ = sleep(Duration::from_millis(1000)) => {}
            _ = cancel_rx.changed() => return,
        }
        if sim.inner.lock().await.phase != FsmPhase::Recording {
            return;
        }

        // Segment failure injection fires on first diagnostics tick.
        if let Some(reason) = sim.config.fail_for("segment") {
            let event = SessionLostEvent {
                session_id: session_id.clone(),
                stream_id: Some(stream_id.clone()),
                reason,
                details: "simulated segment failure".into(),
                diagnostics_path: String::new(),
            };
            let _ = notifier
                .notify("capture.sessionLost", serde_json::to_value(event).unwrap())
                .await;
            let mut inner = sim.inner.lock().await;
            inner.stream_paused = false;
            inner.phase = FsmPhase::Idle;
            return;
        }

        tick += 1;

        let diag = CaptureDiagnosticsEvent {
            stream_id: stream_id.clone(),
            state: "active".into(),
            format: CaptureFormat {
                width: 1920,
                height: 1080,
                fps_num: 60,
                fps_den: 1,
                fourcc: "NV12".into(),
                modifier: None,
                color_primaries: None,
                transfer: None,
                range: None,
            },
            buffers: json!({}),
            cadence: json!({}),
            cursor_mode: "embedded".into(),
            compositor: "sim".into(),
            pipewire: json!({}),
            last_negotiation_ms: 0,
            uptime_ms: tick * 1000,
        };
        let _ = notifier
            .notify("capture.diagnostics", serde_json::to_value(diag).unwrap())
            .await;

        let enc_diag = EncoderDiagnosticsEvent {
            backend: sim.config.encoder.clone(),
            state: "encoding".into(),
            frames_in: tick * 60,
            frames_encoded: tick * 60,
            frames_dropped: 0,
            encode_latency_ms: 2.5,
            bitrate_observed: 4_000_000.0,
            vbv_underruns: 0,
            dmabuf_imports: tick * 60,
            shm_copy_bytes: 0,
            hwenc_runtime_errors: 0,
        };
        let _ = notifier
            .notify("encoder.diagnostics", serde_json::to_value(enc_diag).unwrap())
            .await;

        let seg_diag = SegmentDiagnosticsEvent {
            session_dir: format!("/tmp/sim/{session_id}"),
            state: "active".into(),
            current_segment_index: (tick / 2) as u32,
            fragments_received: tick * 60,
            segments_committed: tick / 2,
            segments_evicted: 0,
            segments_pinned: 0,
            bytes_on_disk: tick * 100_000,
            disk_write_latency_ms: 5.0,
            fsync_latency_ms: 1.0,
            rename_latency_ms: 0.2,
            back_pressure_sustained_ms: 0,
            partial_segment_recovered: false,
            formatchange_segments: 0,
            buffer_window_seconds_observed: (tick as f64) * 1.0,
            buffer_bytes_pct_of_cap: 20.0,
            keyframes_seen: tick * 2,
            duration_eligible: tick > 0,
            pending_duration_90k: 45_000,
            pending_bytes: 50_000,
            last_keyframe_age_ms: 500,
            // ISS-005 H1a/H1b sim values — plausible, diagnostic-only.
            // NVENC NV_ENC_PIC_TYPE: P=0, B=1, I=2, IDR=3, BI=4 (raw u32).
            // Even ticks simulate IDR (3); odd ticks simulate P (0).
            last_fragment_idr_nal_count: if tick % 2 == 0 { 1 } else { 0 },
            last_fragment_non_idr_slice_count: if tick % 2 == 0 { 0 } else { 1 },
            last_fragment_sps_count: if tick % 2 == 0 { 1 } else { 0 },
            last_fragment_pps_count: if tick % 2 == 0 { 1 } else { 0 },
            last_fragment_sei_count: 0,
            last_fragment_other_nal_count: 0,
            last_fragment_picture_type: if tick % 2 == 0 { 3 } else { 0 },
        };
        let _ = notifier
            .notify("replay.segmentDiagnostics", serde_json::to_value(seg_diag).unwrap())
            .await;
    }
}

async fn handle_pause_stream(
    id: Option<serde_json::Value>,
    notifier: &Notifier,
    sim: &Arc<SimState>,
) -> Response {
    let stream_id = {
        let mut inner = sim.inner.lock().await;
        if inner.phase != FsmPhase::Recording {
            return Response::error(
                id,
                RpcError::invalid_request("capture.pauseStream requires Recording phase"),
            );
        }
        if inner.stream_paused {
            return Response::error(id, RpcError::invalid_request("stream already paused"));
        }
        inner.stream_paused = true;
        inner.stream_id.clone().unwrap_or_default()
    };

    let event = StreamPausedEvent { stream_id, reason: "client-request".into() };
    let notifier_c = notifier.clone();
    tokio::spawn(async move {
        tokio::task::yield_now().await;
        let _ = notifier_c
            .notify("capture.streamPaused", serde_json::to_value(event).unwrap())
            .await;
    });
    Response::result(id, json!({ "ok": true }))
}

async fn handle_resume_stream(
    id: Option<serde_json::Value>,
    notifier: &Notifier,
    sim: &Arc<SimState>,
) -> Response {
    let stream_id = {
        let mut inner = sim.inner.lock().await;
        if inner.phase != FsmPhase::Recording {
            return Response::error(
                id,
                RpcError::invalid_request("capture.resumeStream requires Recording phase"),
            );
        }
        if !inner.stream_paused {
            return Response::error(id, RpcError::invalid_request("stream not paused"));
        }
        inner.stream_paused = false;
        inner.stream_id.clone().unwrap_or_default()
    };

    let event = StreamResumedEvent { stream_id };
    let notifier_c = notifier.clone();
    tokio::spawn(async move {
        tokio::task::yield_now().await;
        let _ = notifier_c
            .notify("capture.streamResumed", serde_json::to_value(event).unwrap())
            .await;
    });
    Response::result(id, json!({ "ok": true }))
}

async fn handle_session_setter(id: Option<serde_json::Value>, sim: &Arc<SimState>) -> Response {
    if sim.inner.lock().await.phase != FsmPhase::Recording {
        return Response::error(id, RpcError::invalid_request("requires Recording phase"));
    }
    Response::result(id, json!({ "ok": true }))
}

async fn handle_stop_session(id: Option<serde_json::Value>, sim: &Arc<SimState>) -> Response {
    let mut inner = sim.inner.lock().await;
    if inner.phase != FsmPhase::Recording {
        return Response::error(id, RpcError::invalid_request("no active session"));
    }
    if let Some(ref tx) = inner.session_cancel_tx {
        let _ = tx.send(true);
    }
    inner.session_cancel_tx = None;
    inner.stream_paused = false;
    inner.phase = FsmPhase::Saving;
    Response::result(id, json!({ "ok": true }))
}

async fn handle_replay_save(
    id: Option<serde_json::Value>,
    notifier: &Notifier,
    sim: &Arc<SimState>,
) -> Response {
    let session_id = {
        let inner = sim.inner.lock().await;
        if inner.phase != FsmPhase::Saving {
            return Response::error(
                id,
                RpcError::invalid_request("replay.save requires Saving phase"),
            );
        }
        match inner.session_id.clone() {
            Some(s) => s,
            None => return Response::error(id, RpcError::invalid_request("no session to save")),
        }
    };

    let snapshot_id = sim.next_snapshot_id();
    let snapshot = ReplaySnapshot {
        snapshot_id: snapshot_id.clone(),
        session_id: session_id.clone(),
        init_segment_path: format!("/tmp/sim/{session_id}/init.mp4"),
        init_segment_bytes: 4096,
        segments: vec![],
        trim_start_pts_90k: 0,
        trim_end_pts_90k: 270_000,
        codec: VideoCodec::H264,
        timescale: 90_000,
        width: 1920,
        height: 1080,
        framerate_hint: 60,
        has_discontinuity: false,
        discontinuity_at_pts_90k: vec![],
    };

    {
        let mut inner = sim.inner.lock().await;
        inner.snapshot_id = Some(snapshot_id.clone());
        inner.phase = FsmPhase::Idle;
    }

    let pinned = SnapshotPinnedEvent {
        snapshot_id: snapshot_id.clone(),
        session_id,
        segments_count: 0,
        bytes_pinned: 4096,
    };
    let notifier_c = notifier.clone();
    tokio::spawn(async move {
        tokio::task::yield_now().await;
        let _ = notifier_c
            .notify("replay.snapshotPinned", serde_json::to_value(pinned).unwrap())
            .await;
    });

    Response::result(id, serde_json::to_value(snapshot).unwrap_or(json!(null)))
}

async fn handle_snapshot_release(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    notifier: &Notifier,
    sim: &Arc<SimState>,
) -> Response {
    let snapshot_id = {
        let mut inner = sim.inner.lock().await;
        match inner.snapshot_id.clone() {
            Some(stored) => {
                let param = params
                    .as_ref()
                    .and_then(|p| p.get("snapshot_id"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                if let Some(ref pid) = param {
                    if *pid != stored {
                        return Response::error(
                            id,
                            RpcError::invalid_request("snapshot_id does not match pinned snapshot"),
                        );
                    }
                }
                inner.snapshot_id = None;
                param.unwrap_or(stored)
            }
            None => return Response::error(id, RpcError::invalid_request("no pinned snapshot")),
        }
    };

    let event = SnapshotReleasedEvent { snapshot_id, age_ms: 1000 };
    let notifier_c = notifier.clone();
    tokio::spawn(async move {
        tokio::task::yield_now().await;
        let _ = notifier_c
            .notify("replay.snapshotReleased", serde_json::to_value(event).unwrap())
            .await;
    });
    Response::result(id, json!({ "ok": true }))
}

async fn handle_export_start(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    notifier: &Notifier,
    sim: &Arc<SimState>,
) -> Response {
    let snapshot_id = {
        let inner = sim.inner.lock().await;
        if inner.phase != FsmPhase::Idle {
            return Response::error(id, RpcError::invalid_request("export requires Idle phase"));
        }
        let stored = match inner.snapshot_id.clone() {
            Some(s) => s,
            None => {
                return Response::error(id, RpcError::invalid_request("no snapshot to export"))
            }
        };
        let param = params
            .as_ref()
            .and_then(|p| p.get("snapshot_id"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        if let Some(ref pid) = param {
            if *pid != stored {
                return Response::error(
                    id,
                    RpcError::invalid_request("snapshot_id does not match stored snapshot"),
                );
            }
        }
        param.unwrap_or(stored)
    };

    let fail_code = sim.config.fail_for("export");
    let export_id = sim.next_export_id();
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut inner = sim.inner.lock().await;
        inner.export_id = Some(export_id.clone());
        inner.export_cancel_tx = Some(cancel_tx);
        inner.phase = FsmPhase::Exporting;
    }

    let queued = ExportQueuedEvent {
        export_id: export_id.clone(),
        snapshot_id,
        requested_duration_s: 3.0,
    };
    let _ = notifier.notify("export.queued", serde_json::to_value(queued).unwrap()).await;

    let notifier_c = notifier.clone();
    let sim_c = Arc::clone(sim);
    let eid = export_id.clone();
    tokio::spawn(async move {
        run_export_task(eid, notifier_c, sim_c, cancel_rx, fail_code).await;
    });

    Response::result(id, json!({ "export_id": export_id }))
}

async fn run_export_task(
    export_id: String,
    notifier: Notifier,
    sim: Arc<SimState>,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    fail_code: Option<String>,
) {
    let plan = PlanReport {
        mode: ExportMode::Fast,
        copy_ranges: vec![],
        reencode_ranges: vec![],
        est_output_bytes: 1_000_000,
        est_duration_s: 3.0,
        expected_fps: 60.0,
    };
    let started = ExportStartedEvent {
        export_id: export_id.clone(),
        mode: "stream-copy".into(),
        plan,
        est_duration_s: 3.0,
        est_output_bytes: 1_000_000,
    };
    let _ = notifier.notify("export.started", serde_json::to_value(started).unwrap()).await;

    for i in 1u32..=5 {
        tokio::select! {
            _ = sleep(Duration::from_millis(1000)) => {}
            _ = cancel_rx.changed() => {
                let event = ExportCancelledEvent {
                    export_id: export_id.clone(),
                    stage: "mux".into(),
                    partial_bytes: (i as u64) * 200_000,
                };
                let _ = notifier
                    .notify("export.cancelled", serde_json::to_value(event).unwrap())
                    .await;
                let mut inner = sim.inner.lock().await;
                inner.phase = FsmPhase::Idle;
                inner.export_cancel_tx = None;
                return;
            }
        }
        let progress = ExportProgressEvent {
            export_id: export_id.clone(),
            stage: "mux".into(),
            pct: (i as f32) * 20.0,
            bytes_in: 1_000_000,
            bytes_out: (i as u64) * 200_000,
            samples_processed: (i as u64) * 90,
            samples_total: 450,
            eta_ms: ((5 - i) as u64) * 1000,
        };
        let _ = notifier.notify("export.progress", serde_json::to_value(progress).unwrap()).await;
    }

    if let Some(code) = fail_code {
        let event = ExportFailedEvent {
            export_id: export_id.clone(),
            stage: "mux".into(),
            reason_code: code,
            details: "simulated failure".into(),
            diagnostics_path: String::new(),
        };
        let _ = notifier.notify("export.failed", serde_json::to_value(event).unwrap()).await;
    } else {
        let final_path = format!("/tmp/sim/{export_id}.mp4");
        std::fs::create_dir_all("/tmp/sim").ok();
        if std::fs::write(&final_path, b"SIM\n").is_ok() {
            let event = ExportCompletedEvent {
                export_id: export_id.clone(),
                final_path,
                bytes: 4,
                sha256: "sim-sha256-placeholder".into(),
                duration_s: 3.0,
                mode: "stream-copy".into(),
                fps_observed_out: 60.0,
            };
            let _ = notifier
                .notify("export.completed", serde_json::to_value(event).unwrap())
                .await;
        } else {
            let event = ExportFailedEvent {
                export_id: export_id.clone(),
                stage: "mux".into(),
                reason_code: "sim-write-failed".into(),
                details: format!("could not write {final_path}"),
                diagnostics_path: String::new(),
            };
            let _ = notifier.notify("export.failed", serde_json::to_value(event).unwrap()).await;
        }
    }

    let mut inner = sim.inner.lock().await;
    inner.phase = FsmPhase::Idle;
    inner.export_cancel_tx = None;
}

async fn handle_export_cancel(id: Option<serde_json::Value>, sim: &Arc<SimState>) -> Response {
    let inner = sim.inner.lock().await;
    if inner.phase != FsmPhase::Exporting {
        return Response::error(id, RpcError::invalid_request("no active export"));
    }
    if let Some(ref tx) = inner.export_cancel_tx {
        let _ = tx.send(true);
    }
    Response::result(id, json!({ "ok": true }))
}
