pub mod pipewire_audio;
pub mod wasapi;

use super::backend::AudioCaptureBackend;

pub fn default_backends() -> Vec<Box<dyn AudioCaptureBackend>> {
    #[allow(unused_mut)]
    let mut backends: Vec<Box<dyn AudioCaptureBackend>> = vec![];
    #[cfg(unix)]
    backends.push(Box::new(
        pipewire_audio::PipeWireAudioBackend::new(),
    ));
    #[cfg(windows)]
    backends.push(Box::new(wasapi::WasapiBackend::new()));
    backends
}
