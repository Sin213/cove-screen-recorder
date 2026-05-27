pub mod audio;
pub mod capture;
pub mod diagnostics;
pub mod encoder;
pub mod engine;
pub mod export;
pub mod protocol;
pub mod segment;
pub mod sim;
pub mod transport;

pub type SetLevelFn = std::sync::Arc<dyn Fn(tracing::Level) -> anyhow::Result<()> + Send + Sync>;
