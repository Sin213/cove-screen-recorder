//! T-049 — WGC fallback capture backend stub tests.

use cove_replay_engine::capture::wgc::WgcCaptureSource;

/// Verify WgcCaptureSource can be constructed on all build platforms.
#[test]
fn wgc_capture_source_constructs() {
    let _ = WgcCaptureSource::new();
    let _ = WgcCaptureSource::default();
}

/// Module compilation guard.
#[test]
fn module_compiles_on_linux() {}
