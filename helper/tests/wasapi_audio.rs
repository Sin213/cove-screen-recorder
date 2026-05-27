//! T-050 — WASAPI loopback audio backend stub tests.

use cove_replay_engine::audio::backends::default_backends;
use cove_replay_engine::audio::backends::wasapi::WasapiBackend;

#[test]
fn wasapi_backend_constructs() {
    let _ = WasapiBackend::new();
    let _ = WasapiBackend::default();
}

#[tokio::test]
async fn wasapi_not_in_default_backends_on_non_windows() {
    let backends = default_backends();
    #[cfg(not(windows))]
    assert!(
        !backends.iter().any(|b| b.name() == "wasapi"),
        "wasapi must not appear in default_backends on non-Windows"
    );
    #[cfg(windows)]
    {
        let backend = backends
            .iter()
            .find(|b| b.name() == "wasapi")
            .expect("wasapi must be in default_backends on Windows");
        assert!(
            !backend.probe().await.is_available(),
            "wasapi stub must report Unavailable"
        );
    }
    let _ = backends;
}
