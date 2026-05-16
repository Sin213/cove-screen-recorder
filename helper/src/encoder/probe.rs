//! Probe orchestrator + negative cache (N-004 §6, N-008 §6.8).
//!
//! Backends are probed in fixed priority order.  The first backend whose
//! `probe` returns [`ProbeOutcome::Available`] is selected for the session.
//! Every backend that returns [`ProbeOutcome::Unavailable`] is recorded in the
//! per-session [`NegativeProbeCache`] and will not be re-probed for the rest of
//! the session — this is the "no in-session retry" rule from N-004 / N-008.

use std::collections::HashSet;

use crate::protocol::events::{BackendProbe, EncoderProbeResultEvent};
use crate::protocol::types::CaptureFormat;

use super::backend::{EncoderBackend, ProbeOutcome};

/// Per-session negative cache.  Insert-once, never cleared until the session
/// ends.  Mid-session encoder switching is forbidden (N-008 §6.8) so a failed
/// backend stays excluded for the lifetime of the session.
#[derive(Default)]
pub struct NegativeProbeCache {
    failed: HashSet<String>,
}

impl NegativeProbeCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_failure(&mut self, name: &str) {
        self.failed.insert(name.to_string());
    }

    pub fn is_excluded(&self, name: &str) -> bool {
        self.failed.contains(name)
    }

    pub fn count_failed(&self) -> usize {
        self.failed.len()
    }
}

/// Outcome of one probe sweep.
pub struct ProbeSession {
    /// One entry per backend, in probe order.  Backends excluded by the cache
    /// surface here too (with reason `"negative-cache-hit"`) so callers can
    /// build a complete `encoder.probeResult` event.
    pub results: Vec<(String, ProbeOutcome)>,
    /// Index into `results` of the selected backend, or `None` if nothing
    /// probed Available.
    pub selected: Option<usize>,
    /// Name of the first backend that failed before the selected one was
    /// reached.  Used to drive `encoder.fallbackEngaged.from_backend`.
    pub fallback_from: Option<String>,
}

impl ProbeSession {
    pub fn selected_name(&self) -> Option<&str> {
        self.selected
            .and_then(|i| self.results.get(i).map(|(name, _)| name.as_str()))
    }
}

/// Run probes in order.  The first Available backend is selected; later
/// backends are still probed only if they precede the selected one (the loop
/// short-circuits selection but every backend up to and past the selected one
/// gets a probe entry so the event payload is complete).
pub async fn run_probes(
    backends: &[Box<dyn EncoderBackend>],
    format: &CaptureFormat,
    cache: &mut NegativeProbeCache,
) -> ProbeSession {
    let mut results: Vec<(String, ProbeOutcome)> = Vec::with_capacity(backends.len());
    let mut selected: Option<usize> = None;
    let mut fallback_from: Option<String> = None;

    for (idx, backend) in backends.iter().enumerate() {
        let name = backend.name().to_string();

        if cache.is_excluded(&name) {
            results.push((
                name.clone(),
                ProbeOutcome::Unavailable {
                    reason: "negative-cache-hit".into(),
                    details: serde_json::json!({ "cached": true }),
                },
            ));
            if selected.is_none() && fallback_from.is_none() {
                fallback_from = Some(name);
            }
            continue;
        }

        let outcome = backend.probe(format).await;
        match &outcome {
            ProbeOutcome::Available { .. } => {
                if selected.is_none() {
                    selected = Some(idx);
                }
            }
            ProbeOutcome::Unavailable { .. } => {
                cache.record_failure(&name);
                if selected.is_none() && fallback_from.is_none() {
                    fallback_from = Some(name.clone());
                }
            }
        }
        results.push((name, outcome));
    }

    ProbeSession {
        results,
        selected,
        fallback_from,
    }
}

/// Assemble an `encoder.probeResult` event payload from a probe sweep.
/// The backend slice must be the same slice (same order) that was passed to
/// `run_probes` so codec lookups by index stay aligned.
pub fn build_probe_event(
    session: &ProbeSession,
    backends: &[Box<dyn EncoderBackend>],
) -> EncoderProbeResultEvent {
    let backends_payload = session
        .results
        .iter()
        .enumerate()
        .map(|(idx, (name, outcome))| {
            let codec = backends.get(idx).map(|b| b.codec().to_string());
            match outcome {
                ProbeOutcome::Available { details, .. } => BackendProbe {
                    backend: name.clone(),
                    available: true,
                    codec,
                    details: Some(details.clone()),
                },
                ProbeOutcome::Unavailable { reason, details } => {
                    let merged = merge_reason(details, reason);
                    BackendProbe {
                        backend: name.clone(),
                        available: false,
                        codec,
                        details: Some(merged),
                    }
                }
            }
        })
        .collect();
    EncoderProbeResultEvent {
        backends: backends_payload,
    }
}

fn merge_reason(details: &serde_json::Value, reason: &str) -> serde_json::Value {
    match details {
        serde_json::Value::Object(map) => {
            let mut out = map.clone();
            out.insert(
                "reason".to_string(),
                serde_json::Value::String(reason.to_string()),
            );
            serde_json::Value::Object(out)
        }
        _ => serde_json::json!({ "reason": reason }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_cache_dedups_failures() {
        let mut cache = NegativeProbeCache::new();
        cache.record_failure("nvenc");
        cache.record_failure("nvenc");
        cache.record_failure("libx264");
        assert!(cache.is_excluded("nvenc"));
        assert!(cache.is_excluded("libx264"));
        assert!(!cache.is_excluded("vaapi"));
        assert_eq!(cache.count_failed(), 2);
    }

    #[test]
    fn merge_reason_preserves_object_fields() {
        let merged = merge_reason(
            &serde_json::json!({ "ticket": "T-017a" }),
            "not-implemented-yet",
        );
        assert_eq!(merged["ticket"], "T-017a");
        assert_eq!(merged["reason"], "not-implemented-yet");
    }

    #[test]
    fn merge_reason_wraps_non_object() {
        let merged = merge_reason(&serde_json::Value::Null, "x");
        assert_eq!(merged["reason"], "x");
    }
}
