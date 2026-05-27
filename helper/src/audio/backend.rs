//! `AudioCaptureBackend` trait surface — T-047.
//!
//! Defines the cross-platform audio capture interface.  Linux PipeWire/PA
//! path lands in T-060; Windows WASAPI path lands in T-057.  This module
//! delivers only the trait, types, and stub backends.

use async_trait::async_trait;
use tokio::sync::mpsc;

/// One PCM audio frame delivered by a capture backend.
///
/// Samples are interleaved f32, native-endian.
#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub data: Vec<f32>,
    pub channels: u16,
    pub sample_rate: u32,
    /// Capture timestamp in nanoseconds (monotonic).
    pub timestamp_ns: u64,
}

/// Capabilities reported by a probe.
///
/// This is a cheap yes/no gate — not full format negotiation.  Sample-rate
/// and channel-count details come back through `enumerate_devices()` and
/// are negotiated at `open_stream()` time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioCapabilities {
    pub supports_loopback: bool,
    pub supports_microphone: bool,
    /// True if the backend can enumerate and select individual devices.
    pub supports_device_selection: bool,
    /// True if the backend can mix loopback + microphone into one stream.
    pub supports_mixed_capture: bool,
}

#[derive(Debug, Clone)]
pub enum AudioProbeOutcome {
    Available {
        capabilities: AudioCapabilities,
        details: serde_json::Value,
    },
    Unavailable {
        reason: String,
        details: serde_json::Value,
    },
}

impl AudioProbeOutcome {
    pub fn is_available(&self) -> bool {
        matches!(self, AudioProbeOutcome::Available { .. })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("not yet implemented: {0}")]
    NotImplementedYet(String),
    #[error("device not found: {0}")]
    DeviceNotFound(String),
    #[error("runtime error: {0}")]
    Runtime(String),
}

/// Device enumeration entry.
#[derive(Debug, Clone)]
pub struct AudioDevice {
    /// Backend-internal identifier (opaque).
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    pub is_loopback: bool,
    pub is_microphone: bool,
    pub default_sample_rate: u32,
    pub default_channels: u16,
}

/// Configuration passed to `open_stream`.
#[derive(Debug, Clone)]
pub struct AudioStreamConfig {
    /// Which device to open.  `None` = default system loopback.
    pub device_id: Option<String>,
    /// Preferred sample rate; backend may choose nearest supported value.
    pub sample_rate_hint: u32,
    /// Preferred channel count (1 or 2).
    pub channels_hint: u16,
}

/// One pluggable audio capture backend.
///
/// **Cancellation contract:** call `stop_stream()` to halt frame delivery,
/// then close or drop the channel receiver.  Backends MUST NOT send on `tx`
/// after `stop_stream()` returns.  `stop_stream()` and `teardown()` are
/// idempotent — calling them before `open_stream` returns `Ok(())`.
#[async_trait]
pub trait AudioCaptureBackend: Send + Sync + 'static {
    /// Stable backend identifier (e.g. `"pipewire-audio"`, `"wasapi"`).
    fn name(&self) -> &'static str;

    /// Pure probe — must not open streams or hold resources.
    async fn probe(&self) -> AudioProbeOutcome;

    /// Enumerate available devices.
    async fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, AudioError>;

    /// Open a capture stream.  Delivers `AudioFrame`s on `tx` until
    /// `stop_stream` is called.  Ownership of `tx` transfers to the backend.
    async fn open_stream(
        &mut self,
        config: AudioStreamConfig,
        tx: mpsc::Sender<AudioFrame>,
    ) -> Result<(), AudioError>;

    /// Gracefully stop the capture stream.  Idempotent.
    async fn stop_stream(&mut self) -> Result<(), AudioError>;

    /// Release all backend resources.
    async fn teardown(&mut self) -> Result<(), AudioError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_outcome_available_predicate() {
        let avail = AudioProbeOutcome::Available {
            capabilities: AudioCapabilities {
                supports_loopback: true,
                supports_microphone: true,
                supports_device_selection: false,
                supports_mixed_capture: false,
            },
            details: serde_json::json!({}),
        };
        let unavail = AudioProbeOutcome::Unavailable {
            reason: "x".into(),
            details: serde_json::json!({}),
        };
        assert!(avail.is_available());
        assert!(!unavail.is_available());
    }
}
