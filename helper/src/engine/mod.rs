use std::sync::Arc;
use tokio::sync::watch;

use crate::SetLevelFn;

pub struct HelperState {
    pub start_time: std::time::Instant,
    pub set_level: SetLevelFn,
    pub shutdown_tx: Arc<watch::Sender<bool>>,
    #[cfg(target_os = "linux")]
    pub active_capture: tokio::sync::Mutex<
        Option<std::sync::Arc<crate::capture::pipewire::PipeWireSource>>,
    >,
}

pub type SharedState = Arc<HelperState>;
