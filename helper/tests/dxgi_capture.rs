//! T-048 — DXGI Desktop Duplication capture backend stub tests.
//!
//! All tests are platform-agnostic: they verify the type can be constructed
//! and the module compiles on Linux without any OS resources.

use cove_replay_engine::capture::dxgi::DxgiCaptureSource;

/// Verify DxgiCaptureSource can be constructed on all build platforms.
#[test]
fn dxgi_capture_source_constructs() {
    let _ = DxgiCaptureSource::new();
    let _ = DxgiCaptureSource::default();
}

/// Module compilation guard — if this test is reached, the dxgi module
/// compiled on the current platform (Linux or Windows).
#[test]
fn module_compiles_on_linux() {
    // Compile-time check: no runtime assertion needed.
}
