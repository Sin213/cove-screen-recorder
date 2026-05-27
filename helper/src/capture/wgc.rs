//! Windows Graphics Capture (WGC) fallback backend — stub (T-049).
//! Real WinRT calls deferred to T-051 (Windows cross-compilation).
//!
//! WGC activates when DXGI Desktop Duplication is unavailable (Secure Desktop,
//! UAC prompts, some full-screen exclusive apps).  Also enables per-window
//! capture that DXGI cannot do.  Requires Windows 10 1903+ (build 18362).

#[cfg(windows)]
use async_trait::async_trait;

#[cfg(windows)]
use crate::protocol::types::{CaptureMode, CaptureSourceDescriptor, CursorMode, Rect, RequestSessionOpts};

#[cfg(windows)]
use super::CaptureSource;

/// Selects what WGC captures.
#[cfg(windows)]
#[derive(Debug, Clone)]
pub enum WgcCaptureTarget {
    /// Capture an entire monitor (HMONITOR handle value).
    Monitor { hmonitor: usize },
    /// Capture a specific window (HWND handle value).
    Window { hwnd: usize },
}

/// Configuration for a WGC capture session.
#[cfg(windows)]
#[derive(Debug, Clone)]
pub struct WgcCaptureConfig {
    pub target: WgcCaptureTarget,
    /// If false, DRM-protected content renders as black (WGC default behaviour).
    pub include_protected_content: bool,
    /// Hide the yellow capture border (Win11 22H2+ only; silently ignored on earlier builds).
    pub hide_capture_border: bool,
}

#[cfg(windows)]
impl Default for WgcCaptureConfig {
    fn default() -> Self {
        Self {
            target: WgcCaptureTarget::Monitor { hmonitor: 0 },
            include_protected_content: false,
            hide_capture_border: false,
        }
    }
}

/// Windows Graphics Capture backend.
///
/// Fallback when DXGI Desktop Duplication is unavailable.  Supports per-window
/// capture and handles DRM-protected content gracefully (renders as black).
/// Frame delivery uses `Direct3D11CaptureFramePool::CreateFreeThreaded`.
pub struct WgcCaptureSource {
    #[cfg(windows)]
    config: WgcCaptureConfig,
}

impl WgcCaptureSource {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            config: WgcCaptureConfig::default(),
        }
    }
}

impl Default for WgcCaptureSource {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
#[async_trait]
impl CaptureSource for WgcCaptureSource {
    async fn list_sources(&self) -> anyhow::Result<CaptureSourceDescriptor> {
        // Real WinRT/HMONITOR enumeration deferred to T-051 (Windows cross-compile).
        Ok(CaptureSourceDescriptor {
            modes: vec![CaptureMode::Monitor, CaptureMode::Window],
            known_restore_tokens: vec![],
            monitors: vec![],
        })
    }

    async fn request_session(&self, _opts: RequestSessionOpts) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: wgc-capture request_session")
    }

    async fn start_stream(&self) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: wgc-capture start_stream")
    }

    async fn pause_stream(&self) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: wgc-capture pause_stream")
    }

    async fn resume_stream(&self) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: wgc-capture resume_stream")
    }

    async fn stop_session(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn set_region(&self, _region: Rect) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: wgc-capture set_region")
    }

    async fn set_framerate_hint(&self, _fps: u32) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: wgc-capture set_framerate_hint")
    }

    async fn set_cursor_mode(&self, _mode: CursorMode) -> anyhow::Result<()> {
        anyhow::bail!("not-implemented-yet: wgc-capture set_cursor_mode")
    }
}
