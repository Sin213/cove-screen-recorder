use std::sync::Arc;
use tokio::sync::watch;

use crate::segment::recovery::RecoverableSessionInfo;
use crate::SetLevelFn;

pub struct HelperState {
    pub start_time: std::time::Instant,
    pub set_level: SetLevelFn,
    pub shutdown_tx: Arc<watch::Sender<bool>>,
    #[cfg(target_os = "linux")]
    pub active_capture: tokio::sync::Mutex<
        Option<std::sync::Arc<crate::capture::pipewire::PipeWireSource>>,
    >,
    pub recoverable_sessions: tokio::sync::Mutex<Vec<RecoverableSessionInfo>>,
}

pub type SharedState = Arc<HelperState>;
