//! Rolling fMP4 segment buffer (T-018).
//!
//! Receives `EncodedFragment` from the encoder session via `FragmentSink`,
//! accumulates fragments into ~2 s segments committed atomically to disk,
//! manages a rolling eviction window, supports pinning for replay save,
//! and discovers recoverable sessions from prior crashes on boot.

pub mod buffer;
pub mod recovery;
pub mod writer;

pub use buffer::{ManifestEntry, SegmentBuffer, SegmentBufferConfig, SegmentManifest};
pub use recovery::{scan_recoverable_sessions, RecoverableSessionInfo};
pub use writer::{AtomicSegmentWriter, WriteError};
