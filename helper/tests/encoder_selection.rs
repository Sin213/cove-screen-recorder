//! T-017 — encoder probe / selection MVP.
//!
//! Verifies the trait-level contract the orchestrator must honour.  Real
//! encoder bindings (NVENC, libx264) are deferred to T-017a; these tests use
//! deterministic in-memory backends so the probe and selection logic can be
//! exercised without any FFI.

use async_trait::async_trait;
use cove_replay_engine::encoder::backend::{
    EncoderBackend, EncoderCapabilities, ProbeOutcome,
};
use cove_replay_engine::encoder::probe::{build_probe_event, run_probes, NegativeProbeCache};
use cove_replay_engine::protocol::types::CaptureFormat;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn nv12_1080p60() -> CaptureFormat {
    CaptureFormat {
        width: 1920,
        height: 1080,
        fps_num: 60,
        fps_den: 1,
        fourcc: "NV12".into(),
        modifier: None,
        color_primaries: None,
        transfer: None,
        range: None,
    }
}

struct CountingBackend {
    name: &'static str,
    codec: &'static str,
    outcome: ProbeOutcome,
    probes: Arc<AtomicUsize>,
}

impl CountingBackend {
    fn unavailable(name: &'static str, reason: &str) -> (Self, Arc<AtomicUsize>) {
        let probes = Arc::new(AtomicUsize::new(0));
        (
            Self {
                name,
                codec: "h264",
                outcome: ProbeOutcome::Unavailable {
                    reason: reason.to_string(),
                    details: serde_json::json!({}),
                },
                probes: Arc::clone(&probes),
            },
            probes,
        )
    }

    fn available(name: &'static str) -> (Self, Arc<AtomicUsize>) {
        let probes = Arc::new(AtomicUsize::new(0));
        (
            Self {
                name,
                codec: "h264",
                outcome: ProbeOutcome::Available {
                    capabilities: EncoderCapabilities {
                        accepts_dmabuf: true,
                        accepts_shm: true,
                        supported_codecs: vec!["h264".into()],
                    },
                    details: serde_json::json!({}),
                },
                probes: Arc::clone(&probes),
            },
            probes,
        )
    }
}

#[async_trait]
impl EncoderBackend for CountingBackend {
    fn name(&self) -> &'static str {
        self.name
    }

    fn codec(&self) -> &'static str {
        self.codec
    }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        self.probes.fetch_add(1, Ordering::Relaxed);
        self.outcome.clone()
    }

    #[cfg(unix)]
    async fn configure(
        &mut self,
        _cfg: cove_replay_engine::encoder::backend::EncoderConfig,
    ) -> Result<(), cove_replay_engine::encoder::backend::EncoderError> {
        unreachable!("configure not exercised in probe tests");
    }

    #[cfg(unix)]
    async fn push_frame(
        &mut self,
        _frame: cove_replay_engine::capture::FrameHandle,
    ) -> Result<(), cove_replay_engine::encoder::backend::EncoderError> {
        unreachable!("push_frame not exercised in probe tests");
    }

    #[cfg(unix)]
    async fn drain(
        &mut self,
    ) -> Result<
        Vec<cove_replay_engine::encoder::fragment::EncodedFragment>,
        cove_replay_engine::encoder::backend::EncoderError,
    > {
        unreachable!("drain not exercised in probe tests");
    }

    async fn teardown(
        &mut self,
    ) -> Result<(), cove_replay_engine::encoder::backend::EncoderError> {
        Ok(())
    }
}

#[tokio::test]
async fn probe_picks_first_available() {
    let (nv, nv_probes) = CountingBackend::available("nvenc");
    let (x2, x2_probes) = CountingBackend::available("libx264");
    let backends: Vec<Box<dyn EncoderBackend>> = vec![Box::new(nv), Box::new(x2)];
    let mut cache = NegativeProbeCache::new();
    let session = run_probes(&backends, &nv12_1080p60(), &mut cache).await;

    assert_eq!(session.selected_name(), Some("nvenc"));
    assert!(session.fallback_from.is_none());
    assert_eq!(nv_probes.load(Ordering::Relaxed), 1);
    assert_eq!(x2_probes.load(Ordering::Relaxed), 1);
    assert_eq!(cache.count_failed(), 0);
}

#[tokio::test]
async fn probe_falls_back_when_first_unavailable() {
    let (nv, _) = CountingBackend::unavailable("nvenc", "no-cuda");
    let (x2, _) = CountingBackend::available("libx264");
    let backends: Vec<Box<dyn EncoderBackend>> = vec![Box::new(nv), Box::new(x2)];
    let mut cache = NegativeProbeCache::new();
    let session = run_probes(&backends, &nv12_1080p60(), &mut cache).await;

    assert_eq!(session.selected_name(), Some("libx264"));
    assert_eq!(session.fallback_from.as_deref(), Some("nvenc"));
    assert!(cache.is_excluded("nvenc"));
    assert!(!cache.is_excluded("libx264"));
    assert_eq!(cache.count_failed(), 1);
}

#[tokio::test]
async fn no_backend_available_yields_no_selection() {
    let (nv, _) = CountingBackend::unavailable("nvenc", "not-implemented-yet");
    let (x2, _) = CountingBackend::unavailable("libx264", "not-implemented-yet");
    let backends: Vec<Box<dyn EncoderBackend>> = vec![Box::new(nv), Box::new(x2)];
    let mut cache = NegativeProbeCache::new();
    let session = run_probes(&backends, &nv12_1080p60(), &mut cache).await;

    assert!(session.selected.is_none());
    assert_eq!(session.fallback_from.as_deref(), Some("nvenc"));
    assert_eq!(cache.count_failed(), 2);
}

#[tokio::test]
async fn negative_cache_prevents_in_session_retry() {
    let (nv, nv_probes) = CountingBackend::unavailable("nvenc", "no-cuda");
    let (x2, x2_probes) = CountingBackend::available("libx264");
    let backends: Vec<Box<dyn EncoderBackend>> = vec![Box::new(nv), Box::new(x2)];

    let mut cache = NegativeProbeCache::new();
    let first = run_probes(&backends, &nv12_1080p60(), &mut cache).await;
    assert_eq!(first.selected_name(), Some("libx264"));
    assert!(cache.is_excluded("nvenc"));

    // Second sweep on the same cache: nvenc must be excluded *without* the
    // backend's probe() being called again.  N-008 §6.8 forbids in-session
    // re-probing once a backend has been marked failed.
    let second = run_probes(&backends, &nv12_1080p60(), &mut cache).await;
    assert_eq!(second.selected_name(), Some("libx264"));
    assert_eq!(
        nv_probes.load(Ordering::Relaxed),
        1,
        "nvenc must not be re-probed after it was cached as failed"
    );
    assert_eq!(x2_probes.load(Ordering::Relaxed), 2);

    let nv_entry = second
        .results
        .iter()
        .find(|(n, _)| n == "nvenc")
        .expect("nvenc entry present");
    let reason = match &nv_entry.1 {
        ProbeOutcome::Unavailable { reason, .. } => reason.clone(),
        other => panic!("expected Unavailable, got {other:?}"),
    };
    assert_eq!(reason, "negative-cache-hit");
}

#[tokio::test]
async fn probe_event_payload_carries_every_backend() {
    let (nv, _) = CountingBackend::unavailable("nvenc", "no-cuda");
    let (x2, _) = CountingBackend::available("libx264");
    let backends: Vec<Box<dyn EncoderBackend>> = vec![Box::new(nv), Box::new(x2)];
    let mut cache = NegativeProbeCache::new();
    let session = run_probes(&backends, &nv12_1080p60(), &mut cache).await;
    let event = build_probe_event(&session, &backends);

    assert_eq!(event.backends.len(), 2);
    assert_eq!(event.backends[0].backend, "nvenc");
    assert!(!event.backends[0].available);
    assert_eq!(
        event.backends[0]
            .details
            .as_ref()
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str()),
        Some("no-cuda"),
    );
    assert_eq!(event.backends[1].backend, "libx264");
    assert!(event.backends[1].available);
    assert_eq!(event.backends[1].codec.as_deref(), Some("h264"));
}

#[tokio::test]
async fn default_backends_probe_unavailable_with_t017a_marker() {
    let backends = cove_replay_engine::encoder::default_backends();
    let mut cache = NegativeProbeCache::new();
    let session = run_probes(&backends, &nv12_1080p60(), &mut cache).await;

    assert_eq!(backends.len(), 2);
    assert_eq!(backends[0].name(), "nvenc");
    assert_eq!(backends[1].name(), "libx264");
    assert!(
        session.selected.is_none(),
        "T-017 skeleton must leave both backends Unavailable; real bindings land in T-017a"
    );
    for (name, outcome) in &session.results {
        match outcome {
            ProbeOutcome::Unavailable { reason, details } => {
                assert_eq!(reason, "not-implemented-yet", "backend {name}");
                assert_eq!(
                    details.get("follow_up_ticket").and_then(|v| v.as_str()),
                    Some("T-017a"),
                    "backend {name}",
                );
            }
            other => panic!("expected Unavailable, got {other:?} for {name}"),
        }
    }
}
