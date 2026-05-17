use anyhow::Result;
use tokio::sync::mpsc;

use crate::protocol::{
    envelope::{Notification, Response},
    events::EngineReadyEvent,
    version::{HELPER_VERSION, PROTOCOL_VERSION},
};

#[derive(Clone)]
pub struct Notifier {
    tx: mpsc::Sender<Vec<u8>>,
}

impl Notifier {
    pub fn new() -> (Self, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(64);
        (Notifier { tx }, rx)
    }

    pub async fn notify(&self, method: &str, params: serde_json::Value) -> Result<()> {
        let n = Notification::new(method, Some(params));
        let bytes = serde_json::to_vec(&n)?;
        self.tx.send(bytes).await?;
        Ok(())
    }

    /// Non-blocking variant.  Used by terminal cleanup paths in the encoder
    /// session — emission must NOT await transport progress, otherwise a
    /// stalled writer can defer receiver close / drain / `teardown`.  Drops
    /// the event silently if the bounded transport channel is full;
    /// terminal events are advisory, the renderer can recover from a missing
    /// `encoder.runtimeError` (the session ends regardless).
    pub fn try_notify(&self, method: &str, params: serde_json::Value) -> Result<()> {
        let n = Notification::new(method, Some(params));
        let bytes = serde_json::to_vec(&n)?;
        match self.tx.try_send(bytes) {
            Ok(()) => Ok(()),
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => Ok(()),
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => Ok(()),
        }
    }

    pub async fn send_response(&self, response: Response) -> Result<()> {
        let bytes = serde_json::to_vec(&response)?;
        self.tx.send(bytes).await?;
        Ok(())
    }

    pub async fn send_engine_ready(&self) -> Result<()> {
        let event = EngineReadyEvent {
            helper_version: HELPER_VERSION.to_string(),
            protocol_version: PROTOCOL_VERSION,
            pid: std::process::id(),
            capabilities: vec![],
        };
        self.notify("engine.ready", serde_json::to_value(event)?).await
    }
}
