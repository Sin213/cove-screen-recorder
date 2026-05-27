//! Capture backend auto-selection and fallback chain — T-052.
//!
//! Linux: always PipeWire.
//! Windows: DXGI Desktop Duplication (primary) → WGC (fallback on failure).

/// Which backend was chosen and why.
#[derive(Debug, Clone)]
pub enum CaptureBackendChoice {
    Primary { backend: &'static str },
    Fallback { backend: &'static str, primary_failed_reason: String },
    None { reasons: Vec<(&'static str, String)> },
}

/// Emitted to diagnostics on each capture session start.
#[derive(Debug, Clone)]
pub struct CaptureSelectionEvent {
    /// Stable backend identifier, or `None` if no backend is available.
    pub backend: Option<&'static str>,
    pub choice: CaptureBackendChoice,
    pub platform: &'static str,
}

impl CaptureSelectionEvent {
    pub fn backend_name(&self) -> Option<&'static str> {
        self.backend
    }
}

/// Linux: returns a selection event indicating PipeWire as the only backend.
/// Actual `PipeWireSource` construction is done by the engine dispatcher.
#[cfg(target_os = "linux")]
pub fn select_linux_capture() -> CaptureSelectionEvent {
    CaptureSelectionEvent {
        backend: Some("pipewire"),
        choice: CaptureBackendChoice::Primary { backend: "pipewire" },
        platform: "linux",
    }
}

/// Windows: returns (primary=DXGI, fallback=WGC, event).
///
/// The engine uses the primary backend first; on `start_stream` failure it
/// switches to the fallback and re-emits a `CaptureSelectionEvent` with a
/// `Fallback` choice.  Both backends are constructed eagerly so the engine
/// does not need to know their concrete types.
#[cfg(windows)]
pub fn select_windows_capture() -> (
    Box<dyn super::CaptureSource>,
    Box<dyn super::CaptureSource>,
    CaptureSelectionEvent,
) {
    let event = CaptureSelectionEvent {
        backend: Some("dxgi-dd"),
        choice: CaptureBackendChoice::Primary { backend: "dxgi-dd" },
        platform: "windows",
    };
    (
        Box::new(super::dxgi::DxgiCaptureSource::new()),
        Box::new(super::wgc::WgcCaptureSource::new()),
        event,
    )
}
