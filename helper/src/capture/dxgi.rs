//! DXGI Desktop Duplication capture backend — stub (T-048).
//! Real implementation requires T-051 (Windows cross-compilation + Windows SDK).
//!
//! Recovery contract: DXGI_ERROR_ACCESS_LOST (desktop switch, UAC elevation,
//! full-screen exclusive takeover) causes the backend to signal
//! `SessionLostReason::DxgiAccessLost`; the engine must re-request and restart.

#[cfg(windows)]
use async_trait::async_trait;

#[cfg(windows)]
use crate::protocol::types::{CaptureSourceDescriptor, CursorMode, Rect, RequestSessionOpts};

#[cfg(windows)]
use super::CaptureSource;

/// Identifies a monitor output by DXGI adapter+output index.
#[cfg(windows)]
#[derive(Debug, Clone)]
pub struct DxgiOutputId {
    /// Zero-based adapter index (IDXGIFactory::EnumAdapters ordinal).
    pub adapter_index: u32,
    /// Zero-based output index on that adapter.
    pub output_index: u32,
    /// Human-readable display name (DXGI_OUTPUT_DESC.DeviceName, UTF-8).
    pub display_name: String,
}

/// Configuration for a DXGI Desktop Duplication session.
#[cfg(windows)]
#[derive(Debug, Clone)]
pub struct DxgiCaptureConfig {
    pub output_id: DxgiOutputId,
    /// Milliseconds to block in AcquireNextFrame before yielding (default ≈ 60fps).
    pub acquire_timeout_ms: u32,
    /// Whether to composite the hardware cursor into the delivered frame.
    pub include_cursor: bool,
}

#[cfg(windows)]
impl Default for DxgiCaptureConfig {
    fn default() -> Self {
        Self {
            output_id: DxgiOutputId {
                adapter_index: 0,
                output_index: 0,
                display_name: String::new(),
            },
            acquire_timeout_ms: 17,
            include_cursor: true,
        }
    }
}

/// DXGI Desktop Duplication capture backend.
///
/// Wraps `IDXGIOutputDuplication` on Windows and delivers GPU-resident
/// `ID3D11Texture2D` frames as `FramePayload::D3D11Texture`.  Cursor
/// compositing and desktop-switch recovery are handled internally.
pub struct DxgiCaptureSource {
    #[cfg(windows)]
    config: DxgiCaptureConfig,
}

impl DxgiCaptureSource {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            config: DxgiCaptureConfig::default(),
        }
    }
}

impl Default for DxgiCaptureSource {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
#[async_trait]
impl CaptureSource for DxgiCaptureSource {
    async fn list_sources(&self) -> anyhow::Result<CaptureSourceDescriptor> {
        anyhow::bail!("not-implemented-yet: dxgi-capture list_sources")
    }

    async fn request_session(&self, _opts: RequestSessionOpts) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: dxgi-capture request_session")
    }

    async fn start_stream(&self) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: dxgi-capture start_stream")
    }

    async fn pause_stream(&self) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: dxgi-capture pause_stream")
    }

    async fn resume_stream(&self) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: dxgi-capture resume_stream")
    }

    async fn stop_session(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn set_region(&self, _region: Rect) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: dxgi-capture set_region")
    }

    async fn set_framerate_hint(&self, _fps: u32) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: dxgi-capture set_framerate_hint")
    }

    async fn set_cursor_mode(&self, _mode: CursorMode) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: dxgi-capture set_cursor_mode")
    }
}
