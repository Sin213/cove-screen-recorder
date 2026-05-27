//! T-052 — Capture backend selector tests.

use cove_replay_engine::capture::selector::{CaptureBackendChoice, CaptureSelectionEvent};
#[cfg(target_os = "linux")]
use cove_replay_engine::capture::selector::select_linux_capture;

#[test]
fn capture_selection_event_backend_name_none_variant() {
    let event = CaptureSelectionEvent {
        backend: None,
        choice: CaptureBackendChoice::None { reasons: vec![] },
        platform: "test",
    };
    assert!(event.backend_name().is_none());
}

#[test]
fn capture_selection_event_backend_name_primary() {
    let event = CaptureSelectionEvent {
        backend: Some("test-backend"),
        choice: CaptureBackendChoice::Primary { backend: "test-backend" },
        platform: "test",
    };
    assert_eq!(event.backend_name(), Some("test-backend"));
}

#[test]
fn capture_selection_event_backend_name_fallback() {
    let event = CaptureSelectionEvent {
        backend: Some("wgc"),
        choice: CaptureBackendChoice::Fallback {
            backend: "wgc",
            primary_failed_reason: "access-denied".into(),
        },
        platform: "windows",
    };
    assert_eq!(event.backend_name(), Some("wgc"));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_selector_picks_pipewire() {
    let event = select_linux_capture();
    assert_eq!(event.backend_name(), Some("pipewire"));
    assert_eq!(event.platform, "linux");
    assert!(matches!(event.choice, CaptureBackendChoice::Primary { .. }));
}

#[cfg(windows)]
#[test]
fn windows_selector_returns_dxgi_primary_and_wgc_fallback() {
    use cove_replay_engine::capture::selector::select_windows_capture;
    let (_primary, _fallback, event) = select_windows_capture();
    assert_eq!(event.backend_name(), Some("dxgi-dd"));
    assert_eq!(event.platform, "windows");
    assert!(matches!(event.choice, CaptureBackendChoice::Primary { .. }));
}
