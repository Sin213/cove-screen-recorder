//! `FragmentSink` trait + counting sink terminator.
//!
//! T-017 produces encoded fMP4 fragments through this trait.  The MVP slice
//! ships a counting sink only; T-018 replaces the counting sink with the rolling
//! segment buffer that writes `seg-XXXXXXXX.m4s` files to disk.

use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;

/// One encoded fMP4 fragment (moof + mdat).  Wire format is opaque to the sink.
#[derive(Debug, Clone)]
pub struct EncodedFragment {
    pub seq: u64,
    pub pts_90k: u64,
    pub duration_90k: u32,
    pub is_keyframe: bool,
    pub bytes: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum FragmentSinkError {
    #[error("sink closed")]
    Closed,
    #[error("back-pressure")]
    BackPressure,
    #[error("internal: {0}")]
    Internal(String),
}

#[async_trait]
pub trait FragmentSink: Send + Sync + 'static {
    async fn push(&mut self, fragment: EncodedFragment) -> Result<(), FragmentSinkError>;
}

/// Terminator for the T-017 skeleton slice — counts fragments and bytes without
/// writing to disk.  T-018 replaces this with a `SegmentBufferSink`.
pub struct CountingFragmentSink {
    fragments: AtomicU64,
    bytes: AtomicU64,
}

impl CountingFragmentSink {
    pub fn new() -> Self {
        Self {
            fragments: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        }
    }

    pub fn fragments_count(&self) -> u64 {
        self.fragments.load(Ordering::Relaxed)
    }

    pub fn bytes_count(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
}

impl Default for CountingFragmentSink {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl FragmentSink for CountingFragmentSink {
    async fn push(&mut self, fragment: EncodedFragment) -> Result<(), FragmentSinkError> {
        self.fragments.fetch_add(1, Ordering::Relaxed);
        self.bytes
            .fetch_add(fragment.bytes.len() as u64, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn counting_sink_tracks_count_and_bytes() {
        let mut sink = CountingFragmentSink::new();
        sink.push(EncodedFragment {
            seq: 0,
            pts_90k: 0,
            duration_90k: 1500,
            is_keyframe: true,
            bytes: vec![0u8; 1024],
        })
        .await
        .unwrap();
        sink.push(EncodedFragment {
            seq: 1,
            pts_90k: 1500,
            duration_90k: 1500,
            is_keyframe: false,
            bytes: vec![0u8; 2048],
        })
        .await
        .unwrap();
        assert_eq!(sink.fragments_count(), 2);
        assert_eq!(sink.bytes_count(), 3072);
    }
}
