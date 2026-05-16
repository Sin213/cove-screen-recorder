//! `EncoderBackend` trait surface per N-004.
//!
//! The trait consumes [`FrameHandle`](crate::capture::FrameHandle) only — it must
//! never depend on PipeWire / SPA / DRM types directly, so the same backend
//! implementations remain valid on non-Linux platforms once Windows WGC lands.

use async_trait::async_trait;

use crate::protocol::types::CaptureFormat;

#[cfg(unix)]
use super::fragment::EncodedFragment;
#[cfg(unix)]
use crate::capture::FrameHandle;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderCapabilities {
    pub accepts_dmabuf: bool,
    pub accepts_shm: bool,
    pub supported_codecs: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum ProbeOutcome {
    Available {
        capabilities: EncoderCapabilities,
        details: serde_json::Value,
    },
    Unavailable {
        reason: String,
        details: serde_json::Value,
    },
}

impl ProbeOutcome {
    pub fn is_available(&self) -> bool {
        matches!(self, ProbeOutcome::Available { .. })
    }
}

#[derive(Debug, Clone)]
pub struct EncoderConfig {
    pub format: CaptureFormat,
    pub target_bitrate_bps: u32,
    pub gop_seconds: f32,
}

#[derive(Debug, thiserror::Error)]
pub enum EncoderError {
    #[error("not yet implemented: {0}")]
    NotImplementedYet(String),
    #[error("runtime error: {0}")]
    Runtime(String),
    #[error("back-pressure: encoder cannot keep up")]
    BackPressure,
}

/// One pluggable encoder backend.  N-004 §4 / N-007 §6.
///
/// Probe results are pure: they take an immutable `&self` and return an outcome,
/// without mutating backend state, so the probe orchestrator can run them inside
/// `run_probes` without owning the backend mutably.
#[async_trait]
pub trait EncoderBackend: Send + Sync + 'static {
    /// Stable backend identifier (e.g. `"nvenc"`, `"libx264"`).  Used in events,
    /// the negative probe cache, and `encoder.selected.backend`.
    fn name(&self) -> &'static str;

    /// Codec identifier surfaced in `encoder.selected.codec` (e.g. `"h264"`).
    fn codec(&self) -> &'static str;

    /// Pure probe — must not allocate encoder sessions or hold resources.
    async fn probe(&self, format: &CaptureFormat) -> ProbeOutcome;

    /// Configure the encoder before any `push_frame` call.  Must be idempotent.
    #[cfg(unix)]
    async fn configure(&mut self, cfg: EncoderConfig) -> Result<(), EncoderError>;

    /// Submit one captured frame for encoding.  Producers MUST hold the frame's
    /// `ReleaseToken` until `push_frame` returns so DMA-BUF imports stay valid.
    #[cfg(unix)]
    async fn push_frame(&mut self, frame: FrameHandle) -> Result<(), EncoderError>;

    /// Pull any fragments the encoder has flushed since the last call.
    #[cfg(unix)]
    async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError>;

    /// Release all encoder resources.  After this returns, the backend instance is
    /// dead — callers must drop it.
    async fn teardown(&mut self) -> Result<(), EncoderError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_outcome_available_predicate() {
        let avail = ProbeOutcome::Available {
            capabilities: EncoderCapabilities {
                accepts_dmabuf: true,
                accepts_shm: true,
                supported_codecs: vec!["h264".into()],
            },
            details: serde_json::json!({}),
        };
        let unavail = ProbeOutcome::Unavailable {
            reason: "x".into(),
            details: serde_json::json!({}),
        };
        assert!(avail.is_available());
        assert!(!unavail.is_available());
    }
}
