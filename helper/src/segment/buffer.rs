//! Rolling fMP4 segment buffer implementing `FragmentSink`.
//!
//! Accumulates encoded fragments into ~2 s segments. On each keyframe boundary
//! (or when the current segment exceeds the target duration), the accumulated
//! data is committed atomically to disk. Old segments are evicted when they
//! fall outside the rolling window or the disk cap is exceeded.

use std::collections::VecDeque;
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex};
use tracing::warn;

use crate::encoder::fragment::{
    EncodedFragment, FragmentSink, FragmentSinkError, NV_ENC_PIC_TYPE_IDR,
};
use crate::protocol::events::{SegmentDiagnosticsEvent, SessionLostEvent};
use crate::protocol::types::SegmentRef;
use crate::transport::notifier::Notifier;

use super::writer::{fsync_dir, AtomicSegmentWriter};

/// Configuration for the segment buffer.
#[derive(Clone, Debug)]
pub struct SegmentBufferConfig {
    /// Target segment duration in 90 kHz units (default: 2 s = 180_000).
    pub target_duration_90k: u64,
    /// Maximum bytes on disk before forced eviction (default: 4 GiB).
    pub disk_cap_bytes: u64,
    /// Replay window in 90 kHz units. Segments older than this are eligible for eviction.
    pub window_duration_90k: u64,
}

impl Default for SegmentBufferConfig {
    fn default() -> Self {
        Self {
            target_duration_90k: 180_000, // 2 s at 90 kHz
            disk_cap_bytes: 4 * 1024 * 1024 * 1024, // 4 GiB
            window_duration_90k: 30 * 90_000, // 30 s default replay window
        }
    }
}

/// Metadata for a committed segment on disk.
#[derive(Clone, Debug)]
struct CommittedSegment {
    index: u32,
    path: PathBuf,
    pts_start_90k: i64,
    pts_end_90k: i64,
    duration_90k: i64,
    byte_size: u64,
    is_keyframe_first: bool,
    /// True for the first segment committed after a format-change boundary.
    /// Stream-copy export must reject snapshots that contain such segments.
    discontinuity: bool,
    fragment_count: u32,
    pin_count: u32,
}

/// In-progress segment accumulator.
struct PendingSegment {
    fragments: Vec<EncodedFragment>,
    pts_start_90k: Option<u64>,
    pts_end_90k: u64,
    total_duration_90k: u64,
    total_bytes: usize,
    is_keyframe_first: bool,
}

impl PendingSegment {
    fn new() -> Self {
        Self {
            fragments: Vec::new(),
            pts_start_90k: None,
            pts_end_90k: 0,
            total_duration_90k: 0,
            total_bytes: 0,
            is_keyframe_first: false,
        }
    }

    fn is_empty(&self) -> bool {
        self.fragments.is_empty()
    }

    fn push(&mut self, fragment: EncodedFragment) {
        if self.pts_start_90k.is_none() {
            self.pts_start_90k = Some(fragment.pts_90k);
            self.is_keyframe_first = fragment.is_keyframe;
        }
        self.pts_end_90k = fragment.pts_90k + fragment.duration_90k as u64;
        self.total_duration_90k += fragment.duration_90k as u64;
        self.total_bytes += fragment.bytes.len();
        self.fragments.push(fragment);
    }

    fn serialize(&self) -> Vec<u8> {
        // fMP4 segment: styp + concatenated moof+mdat from each fragment.
        // Each EncodedFragment.bytes already contains a valid fMP4 fragment
        // (moof+mdat pair) from the encoder. We prepend a segment type box.
        let mut buf = Vec::with_capacity(self.total_bytes + 24);
        // styp box: 8 bytes size+type + brands
        let styp_payload = b"msdhmsixmiso";
        let styp_size = (8 + styp_payload.len()) as u32;
        buf.extend_from_slice(&styp_size.to_be_bytes());
        buf.extend_from_slice(b"styp");
        buf.extend_from_slice(styp_payload);
        for frag in &self.fragments {
            buf.extend_from_slice(&frag.bytes);
        }
        buf
    }
}

/// Persisted segment metadata for crash recovery. Written to `manifest.json`
/// in the session directory after each commit.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub index: u32,
    pub pts_start_90k: i64,
    pub pts_end_90k: i64,
    pub duration_90k: i64,
    pub byte_size: u64,
    pub is_keyframe_first: bool,
    /// False by default for legacy manifests written before this field existed.
    #[serde(default)]
    pub discontinuity: bool,
    pub fragment_count: u32,
}

/// Full manifest persisted to disk.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SegmentManifest {
    pub session_id: String,
    pub segments: Vec<ManifestEntry>,
}

fn write_manifest(dir: &Path, manifest: &SegmentManifest) -> std::io::Result<()> {
    let path = dir.join("manifest.json");
    let tmp_path = dir.join("manifest.json.tmp");
    let data = serde_json::to_vec(manifest)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut f = std::fs::File::create(&tmp_path)?;
    f.write_all(&data)?;
    f.sync_all()?;
    std::fs::rename(&tmp_path, &path)?;
    fsync_dir(dir)?;
    Ok(())
}

/// Shared interior state behind a mutex for the buffer.
struct BufferInner {
    session_id: String,
    stream_id: Option<String>,
    config: SegmentBufferConfig,
    writer: AtomicSegmentWriter,
    notifier: Notifier,
    committed: VecDeque<CommittedSegment>,
    pending: PendingSegment,
    next_index: u32,
    closed: bool,
    seen_first_keyframe: bool,
    /// Set when pending duration exceeds the target. Actual commit deferred
    /// until the next keyframe arrives so every segment starts on an IDR.
    duration_eligible: bool,
    // Diagnostics accumulators
    fragments_received: u64,
    segments_committed: u64,
    segments_evicted: u64,
    segments_pinned: u64,
    bytes_on_disk: u64,
    last_write_latency_us: u64,
    last_fsync_latency_us: u64,
    last_rename_latency_us: u64,
    back_pressure_sustained_us: u64,
    formatchange_segments: u64,
    last_diagnostics: Instant,
    format_changed: bool,
    keyframes_seen: u64,
    last_keyframe_at: Option<Instant>,
    // ISS-005 H1a/H1b diagnostics — latest fragment's NAL counts + pictureType.
    // Recorded for emission only; do not gate commit predicate or keyframe flag.
    last_fragment_idr_nal_count: u32,
    last_fragment_non_idr_slice_count: u32,
    last_fragment_sps_count: u32,
    last_fragment_pps_count: u32,
    last_fragment_sei_count: u32,
    last_fragment_other_nal_count: u32,
    last_fragment_picture_type: u32,
    // ISS-005 phase 2: cumulative counters across the session lifetime that
    // close the H1a sampling gap. Emit-only — they MUST NOT drive the commit
    // predicate, `seen_first_keyframe`, or any `replay.save` decision.
    //
    // - `idr_nal_count_total` increments per fragment whose Annex-B AU
    //   contained at least one IDR NAL (`nal_counts.idr > 0`).
    // - `picture_type_idr_count_total` increments per fragment whose NVENC
    //   `pictureType` was IDR (`NV_ENC_PIC_TYPE_IDR`).
    idr_nal_count_total: u64,
    picture_type_idr_count_total: u64,
}

impl BufferInner {
    fn write_manifest_to_disk(&self) -> Result<(), FragmentSinkError> {
        let manifest = SegmentManifest {
            session_id: self.session_id.clone(),
            segments: self
                .committed
                .iter()
                .map(|seg| ManifestEntry {
                    index: seg.index,
                    pts_start_90k: seg.pts_start_90k,
                    pts_end_90k: seg.pts_end_90k,
                    duration_90k: seg.duration_90k,
                    byte_size: seg.byte_size,
                    is_keyframe_first: seg.is_keyframe_first,
                    discontinuity: seg.discontinuity,
                    fragment_count: seg.fragment_count,
                })
                .collect(),
        };
        write_manifest(self.writer.dir(), &manifest)
            .map_err(|e| FragmentSinkError::Internal(e.to_string()))
    }

    fn evict_eligible(&mut self) -> bool {
        let now_pts = self
            .committed
            .back()
            .map(|s| s.pts_end_90k)
            .unwrap_or(0);

        // Collect indices of segments to evict. Pinned segments are skipped
        // but do not block eviction of unpinned segments beyond them.
        let mut evict_positions: Vec<usize> = Vec::new();
        for (i, seg) in self.committed.iter().enumerate() {
            if seg.pin_count > 0 {
                continue;
            }
            let age = now_pts - seg.pts_start_90k;
            if age > self.config.window_duration_90k as i64
                || self.bytes_on_disk.saturating_sub(
                    evict_positions.iter().map(|&j| self.committed[j].byte_size).sum::<u64>(),
                ) > self.config.disk_cap_bytes
            {
                evict_positions.push(i);
            }
        }

        if evict_positions.is_empty() {
            return false;
        }

        // Remove in reverse order to preserve index validity.
        // Only drop metadata after durable file removal succeeds.
        let mut any_removed = false;
        for &pos in evict_positions.iter().rev() {
            let index = self.committed[pos].index;
            match self.writer.remove(index) {
                Ok(()) => {
                    let seg = self.committed.remove(pos).unwrap();
                    self.bytes_on_disk = self.bytes_on_disk.saturating_sub(seg.byte_size);
                    self.segments_evicted += 1;
                    any_removed = true;
                }
                Err(e) => {
                    warn!(index, error = %e, "failed to remove evicted segment, keeping metadata");
                }
            }
        }

        if any_removed {
            // Fsync directory so removals are crash-durable
            let _ = fsync_dir(self.writer.dir());
        }

        any_removed
    }

    fn pinned_count(&self) -> u64 {
        self.committed.iter().filter(|s| s.pin_count > 0).count() as u64
    }

    async fn emit_diagnostics(&mut self) {
        let state = if self.closed {
            "stopped"
        } else if self.back_pressure_sustained_us > 0 {
            "backpressured"
        } else {
            "active"
        };

        let buffer_window_secs = self
            .committed
            .iter()
            .map(|s| s.duration_90k as f64)
            .sum::<f64>()
            / 90_000.0;

        let buffer_bytes_pct = if self.config.disk_cap_bytes > 0 {
            (self.bytes_on_disk as f64 / self.config.disk_cap_bytes as f64) * 100.0
        } else {
            0.0
        };

        let evt = SegmentDiagnosticsEvent {
            session_dir: self.writer.dir().to_string_lossy().into_owned(),
            state: state.into(),
            current_segment_index: self.next_index.saturating_sub(1),
            fragments_received: self.fragments_received,
            segments_committed: self.segments_committed,
            segments_evicted: self.segments_evicted,
            segments_pinned: self.pinned_count(),
            bytes_on_disk: self.bytes_on_disk,
            disk_write_latency_ms: self.last_write_latency_us as f64 / 1000.0,
            fsync_latency_ms: self.last_fsync_latency_us as f64 / 1000.0,
            rename_latency_ms: self.last_rename_latency_us as f64 / 1000.0,
            back_pressure_sustained_ms: self.back_pressure_sustained_us / 1000,
            partial_segment_recovered: false,
            formatchange_segments: self.formatchange_segments,
            buffer_window_seconds_observed: buffer_window_secs,
            buffer_bytes_pct_of_cap: buffer_bytes_pct,
            keyframes_seen: self.keyframes_seen,
            duration_eligible: self.duration_eligible,
            pending_duration_90k: self.pending.total_duration_90k,
            pending_bytes: self.pending.total_bytes as u64,
            last_keyframe_age_ms: self
                .last_keyframe_at
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(u64::MAX),
            last_fragment_idr_nal_count: self.last_fragment_idr_nal_count,
            last_fragment_non_idr_slice_count: self.last_fragment_non_idr_slice_count,
            last_fragment_sps_count: self.last_fragment_sps_count,
            last_fragment_pps_count: self.last_fragment_pps_count,
            last_fragment_sei_count: self.last_fragment_sei_count,
            last_fragment_other_nal_count: self.last_fragment_other_nal_count,
            last_fragment_picture_type: self.last_fragment_picture_type,
            idr_nal_count_total: self.idr_nal_count_total,
            picture_type_idr_count_total: self.picture_type_idr_count_total,
        };
        if let Ok(v) = serde_json::to_value(&evt) {
            let _ = self.notifier.try_notify("replay.segmentDiagnostics", v);
        }
        self.last_diagnostics = Instant::now();
    }

    async fn commit_pending(&mut self) -> Result<(), FragmentSinkError> {
        if self.pending.is_empty() {
            return Ok(());
        }

        let data = self.pending.serialize();
        let index = self.next_index;
        self.next_index += 1;

        let result = self.writer.commit(index, &data).await.map_err(|e| {
            if e.is_disk_full() {
                let evt = SessionLostEvent {
                    session_id: self.session_id.clone(),
                    stream_id: self.stream_id.clone(),
                    reason: "segment-sink-disk-full".into(),
                    details: e.to_string(),
                    diagnostics_path: self.writer.dir().to_string_lossy().into_owned(),
                };
                if let Ok(v) = serde_json::to_value(&evt) {
                    let _ = self.notifier.try_notify("capture.sessionLost", v);
                }
                FragmentSinkError::Closed
            } else {
                let msg = e.to_string();
                warn!(error = %msg, "segment commit failed");
                FragmentSinkError::Internal(msg)
            }
        })?;

        // All segments after a format change are marked discontinuous until
        // set_init_segment() stores a new init segment that matches their format.
        let is_discontinuity = self.format_changed;

        let seg = CommittedSegment {
            index,
            path: result.path,
            pts_start_90k: self.pending.pts_start_90k.unwrap_or(0) as i64,
            pts_end_90k: self.pending.pts_end_90k as i64,
            duration_90k: self.pending.total_duration_90k as i64,
            byte_size: result.byte_size,
            is_keyframe_first: self.pending.is_keyframe_first,
            discontinuity: is_discontinuity,
            fragment_count: self.pending.fragments.len() as u32,
            pin_count: 0,
        };

        self.last_write_latency_us = result.write_us;
        self.last_fsync_latency_us = result.fsync_us;
        self.last_rename_latency_us = result.rename_us;
        self.bytes_on_disk += seg.byte_size;
        self.segments_committed += 1;

        self.committed.push_back(seg);
        self.pending = PendingSegment::new();
        self.duration_eligible = false;

        self.evict_eligible();

        self.write_manifest_to_disk()?;

        Ok(())
    }
}

/// Rolling fMP4 segment buffer. Implements `FragmentSink` for use as the
/// encoder session's output sink.
pub struct SegmentBuffer {
    inner: Arc<Mutex<BufferInner>>,
    /// Sends `true` when the buffer is closed so callers can wait for tail
    /// segments to be committed (e.g. replay.save after capture.stopSession).
    close_tx: Arc<watch::Sender<bool>>,
    /// Set when the encoder begins teardown (before finalize). replay.save
    /// uses this to distinguish "still recording" from "stopping" so it
    /// only waits for the tail segment during the stop→finalize window.
    closing: Arc<AtomicBool>,
}

impl SegmentBuffer {
    pub fn new(
        session_id: String,
        stream_id: Option<String>,
        session_dir: &Path,
        config: SegmentBufferConfig,
        notifier: Notifier,
    ) -> Result<Self, super::writer::WriteError> {
        let writer = AtomicSegmentWriter::new(session_dir)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(BufferInner {
                session_id,
                stream_id,
                config,
                writer,
                notifier,
                committed: VecDeque::new(),
                pending: PendingSegment::new(),
                next_index: 0,
                closed: false,
                seen_first_keyframe: false,
                duration_eligible: false,
                fragments_received: 0,
                segments_committed: 0,
                segments_evicted: 0,
                segments_pinned: 0,
                bytes_on_disk: 0,
                last_write_latency_us: 0,
                last_fsync_latency_us: 0,
                last_rename_latency_us: 0,
                back_pressure_sustained_us: 0,
                formatchange_segments: 0,
                last_diagnostics: Instant::now(),
                format_changed: false,
                keyframes_seen: 0,
                last_keyframe_at: None,
                last_fragment_idr_nal_count: 0,
                last_fragment_non_idr_slice_count: 0,
                last_fragment_sps_count: 0,
                last_fragment_pps_count: 0,
                last_fragment_sei_count: 0,
                last_fragment_other_nal_count: 0,
                last_fragment_picture_type: 0,
                idr_nal_count_total: 0,
                picture_type_idr_count_total: 0,
            })),
            close_tx: Arc::new(watch::channel(false).0),
            closing: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Create a receiver that fires when the buffer is closed (finalized).
    /// Useful for waiting on tail segments after capture stop.
    pub fn subscribe_close(&self) -> watch::Receiver<bool> {
        self.close_tx.subscribe()
    }

    /// Returns true once `mark_closing()` has been called (encoder is tearing down).
    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }

    /// Signal that this buffer's session is entering teardown. Can be called
    /// on any clone; all clones share the same Arc<AtomicBool>.
    pub fn mark_closing(&self) {
        self.closing.store(true, Ordering::Release);
    }

    /// Clone a shared handle to this buffer. Both handles share the same
    /// underlying `Arc<Mutex<BufferInner>>`, so all operations observe and
    /// modify the same state.
    pub fn clone_handle(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            close_tx: Arc::clone(&self.close_tx),
            closing: Arc::clone(&self.closing),
        }
    }

    /// Pin segments covering the last `duration_90k` for a replay save.
    /// Returns a snapshot of the pinned segments.
    pub async fn pin_snapshot(&self, duration_90k: u64) -> Option<Vec<SegmentRef>> {
        let mut inner = self.inner.lock().await;
        if inner.committed.is_empty() {
            return None;
        }

        let newest_pts = inner.committed.back().unwrap().pts_end_90k;
        let cutoff = newest_pts - duration_90k as i64;

        let mut refs = Vec::new();
        for seg in inner.committed.iter_mut().rev() {
            if seg.pts_end_90k <= cutoff {
                break;
            }
            seg.pin_count += 1;
            refs.push(SegmentRef {
                index: seg.index,
                path: seg.path.to_string_lossy().into_owned(),
                pts_start_90k: seg.pts_start_90k,
                pts_end_90k: seg.pts_end_90k,
                duration_90k: seg.duration_90k,
                byte_size: seg.byte_size,
                is_keyframe_first: seg.is_keyframe_first,
                discontinuity: seg.discontinuity,
                fragment_count: seg.fragment_count,
            });
        }
        refs.reverse();

        inner.segments_pinned = inner.pinned_count();
        Some(refs)
    }

    /// Release a previously pinned snapshot. Decrements refcount on each segment.
    pub async fn release_snapshot(&self, segment_indices: &[u32]) {
        let mut inner = self.inner.lock().await;
        for seg in inner.committed.iter_mut() {
            if segment_indices.contains(&seg.index) {
                seg.pin_count = seg.pin_count.saturating_sub(1);
            }
        }
        inner.segments_pinned = inner.pinned_count();
        if inner.evict_eligible() {
            let _ = inner.write_manifest_to_disk();
        }
    }

    /// Flush any remaining pending fragments as a final segment.
    pub async fn flush(&self) -> Result<(), FragmentSinkError> {
        let mut inner = self.inner.lock().await;
        inner.commit_pending().await
    }

    /// Mark the buffer as closed. No further pushes accepted.
    pub async fn close(&self) {
        let mut inner = self.inner.lock().await;
        let _ = inner.commit_pending().await;
        inner.closed = true;
        drop(inner);
        let _ = self.close_tx.send(true);
    }

    /// Get the session directory path.
    pub async fn session_dir(&self) -> PathBuf {
        let inner = self.inner.lock().await;
        inner.writer.dir().to_path_buf()
    }

    /// Get current bytes on disk.
    pub async fn bytes_on_disk(&self) -> u64 {
        let inner = self.inner.lock().await;
        inner.bytes_on_disk
    }

    /// Get all committed segment refs (for recovery/export).
    pub async fn committed_segments(&self) -> Vec<SegmentRef> {
        let inner = self.inner.lock().await;
        inner
            .committed
            .iter()
            .map(|seg| SegmentRef {
                index: seg.index,
                path: seg.path.to_string_lossy().into_owned(),
                pts_start_90k: seg.pts_start_90k,
                pts_end_90k: seg.pts_end_90k,
                duration_90k: seg.duration_90k,
                byte_size: seg.byte_size,
                is_keyframe_first: seg.is_keyframe_first,
                discontinuity: seg.discontinuity,
                fragment_count: seg.fragment_count,
            })
            .collect()
    }
}

#[async_trait]
impl FragmentSink for SegmentBuffer {
    async fn set_init_segment(&mut self, data: Vec<u8>) -> Result<(), FragmentSinkError> {
        let dir = {
            let inner = self.inner.lock().await;
            inner.writer.dir().to_path_buf()
        };

        let partial = dir.join("init.mp4.partial");
        let final_path = dir.join("init.mp4");
        tokio::task::spawn_blocking(move || -> Result<(), FragmentSinkError> {
            use std::io::Write;
            let mut f = std::fs::File::create(&partial)
                .map_err(|e| FragmentSinkError::Internal(e.to_string()))?;
            f.write_all(&data)
                .map_err(|e| FragmentSinkError::Internal(e.to_string()))?;
            f.sync_all()
                .map_err(|e| FragmentSinkError::Internal(e.to_string()))?;
            std::fs::rename(&partial, &final_path)
                .map_err(|e| FragmentSinkError::Internal(e.to_string()))?;
            fsync_dir(final_path.parent().unwrap())
                .map_err(|e| FragmentSinkError::Internal(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|e| FragmentSinkError::Internal(e.to_string()))??;

        // New init segment persisted — segments from here forward are compatible.
        self.inner.lock().await.format_changed = false;
        Ok(())
    }

    async fn notify_format_change(&mut self) -> Result<(), FragmentSinkError> {
        let mut inner = self.inner.lock().await;
        if !inner.pending.is_empty() {
            inner.commit_pending().await?;
        }
        inner.formatchange_segments += 1;
        inner.format_changed = true;
        inner.seen_first_keyframe = false;
        Ok(())
    }

    fn set_closing(&mut self) {
        self.mark_closing();
    }

    async fn finalize(&mut self) -> Result<(), FragmentSinkError> {
        let mut inner = self.inner.lock().await;
        inner.commit_pending().await?;
        inner.closed = true;
        drop(inner);
        let _ = self.close_tx.send(true);
        Ok(())
    }

    async fn push(&mut self, fragment: EncodedFragment) -> Result<(), FragmentSinkError> {
        let mut inner = self.inner.lock().await;
        if inner.closed {
            return Err(FragmentSinkError::Closed);
        }

        inner.fragments_received += 1;

        // ISS-005 H1a/H1b diagnostics — record the latest fragment's NAL
        // counts + pictureType for emission on the next diagnostics tick.
        // Recorded for every observed fragment so we can see whether NVENC
        // emits periodic IDR NALs (or signals IDR via pictureType) even when
        // is_keyframe is only flipped once. MUST NOT influence decisions.
        let d = &fragment.diagnostics;
        inner.last_fragment_idr_nal_count = d.nal_counts.idr;
        inner.last_fragment_non_idr_slice_count = d.nal_counts.non_idr_slice;
        inner.last_fragment_sps_count = d.nal_counts.sps;
        inner.last_fragment_pps_count = d.nal_counts.pps;
        inner.last_fragment_sei_count = d.nal_counts.sei;
        inner.last_fragment_other_nal_count = d.nal_counts.other;
        inner.last_fragment_picture_type = d.picture_type;

        // ISS-005 phase 2: cumulative IDR observability. Diagnostic-only;
        // these counters MUST NOT influence the commit predicate,
        // `seen_first_keyframe`, or `replay.save` behaviour.
        if d.nal_counts.idr > 0 {
            inner.idr_nal_count_total = inner.idr_nal_count_total.saturating_add(1);
        }
        if d.picture_type == NV_ENC_PIC_TYPE_IDR {
            inner.picture_type_idr_count_total =
                inner.picture_type_idr_count_total.saturating_add(1);
        }

        if !inner.seen_first_keyframe {
            if fragment.is_keyframe {
                inner.seen_first_keyframe = true;
            } else {
                return Ok(());
            }
        }

        if fragment.is_keyframe {
            inner.keyframes_seen += 1;
            inner.last_keyframe_at = Some(Instant::now());
        }

        if fragment.is_keyframe && !inner.pending.is_empty() && inner.duration_eligible {
            inner.commit_pending().await?;
        }

        inner.pending.push(fragment);

        // Mark eligible to close once we reach the target duration.
        // Actual commit is deferred until the next keyframe so every segment
        // starts on an IDR and is independently decodable.
        if inner.pending.total_duration_90k >= inner.config.target_duration_90k {
            inner.duration_eligible = true;
        }

        // Emit diagnostics at ~1 Hz independent of segment commits
        if inner.last_diagnostics.elapsed().as_secs() >= 1 {
            inner.emit_diagnostics().await;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_notifier() -> Notifier {
        let (tx, _rx) = tokio::sync::mpsc::channel(64);
        Notifier::from_sender(tx)
    }

    fn make_fragment(seq: u64, pts_90k: u64, duration_90k: u32, is_keyframe: bool) -> EncodedFragment {
        // Minimal valid-ish fMP4 moof+mdat content for testing
        let mut bytes = Vec::new();
        // moof box (minimal)
        let moof_size: u32 = 8;
        bytes.extend_from_slice(&moof_size.to_be_bytes());
        bytes.extend_from_slice(b"moof");
        // mdat box
        let mdat_payload = vec![0xABu8; 1024];
        let mdat_size = (8 + mdat_payload.len()) as u32;
        bytes.extend_from_slice(&mdat_size.to_be_bytes());
        bytes.extend_from_slice(b"mdat");
        bytes.extend_from_slice(&mdat_payload);
        EncodedFragment {
            seq,
            pts_90k,
            duration_90k,
            is_keyframe,
            bytes,
            diagnostics: Default::default(),
        }
    }

    #[tokio::test]
    async fn commits_on_keyframe_after_duration_eligible() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-1");
        let config = SegmentBufferConfig {
            target_duration_90k: 180_000, // 2 s
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-1".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        // Push keyframe + 3 non-keyframes (~2 s total, reaches target)
        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(2, 90_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(3, 135_000, 45_000, false)).await.unwrap();

        // Duration eligible but no keyframe yet — no commit
        assert_eq!(buf.bytes_on_disk().await, 0);

        // Next keyframe triggers commit
        buf.push(make_fragment(4, 180_000, 45_000, true)).await.unwrap();
        assert!(buf.bytes_on_disk().await > 0);
        assert!(session_dir.join("00000000.mp4").exists());
    }

    #[tokio::test]
    async fn scene_cut_keyframe_before_duration_does_not_commit() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-sc");
        let config = SegmentBufferConfig {
            target_duration_90k: 180_000, // 2 s
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-sc".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        // Push a short segment then a scene-cut keyframe before target
        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();

        // Scene-cut keyframe at 1 s — should NOT commit (under 2 s target)
        buf.push(make_fragment(2, 90_000, 45_000, true)).await.unwrap();
        assert_eq!(buf.bytes_on_disk().await, 0, "scene-cut keyframe before duration target must not commit");
    }

    #[tokio::test]
    async fn commits_deferred_to_next_keyframe_after_duration() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-2");
        let config = SegmentBufferConfig {
            target_duration_90k: 90_000, // 1 s for faster test
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-2".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        // Push fragments past the 1 s target — no commit yet (waiting for keyframe)
        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(2, 90_000, 45_000, false)).await.unwrap();
        assert!(!session_dir.join("00000000.mp4").exists(), "should not commit without keyframe");

        // Next keyframe triggers the deferred commit
        buf.push(make_fragment(3, 135_000, 45_000, true)).await.unwrap();
        assert!(session_dir.join("00000000.mp4").exists(), "keyframe should trigger deferred commit");
    }

    #[tokio::test]
    async fn eviction_respects_window() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-3");
        let config = SegmentBufferConfig {
            target_duration_90k: 90_000,
            window_duration_90k: 180_000, // 2 s window
            disk_cap_bytes: u64::MAX,
        };
        let mut buf = SegmentBuffer::new(
            "session-3".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        // Create 4 segments of 1 s each (total 4 s, window is 2 s)
        for i in 0..8 {
            let pts = i as u64 * 45_000;
            let is_kf = i % 2 == 0;
            buf.push(make_fragment(i, pts, 45_000, is_kf)).await.unwrap();
        }
        // Flush remaining
        buf.flush().await.unwrap();

        // Oldest segments should be evicted (beyond 2 s window)
        let segs = buf.committed_segments().await;
        let total_dur: i64 = segs.iter().map(|s| s.duration_90k).sum();
        // Remaining segments should fit within ~window + 1 segment
        assert!(total_dur <= 270_000, "remaining duration {total_dur} exceeds window + buffer");
    }

    #[tokio::test]
    async fn pinning_prevents_eviction() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-4");
        let config = SegmentBufferConfig {
            target_duration_90k: 90_000,
            window_duration_90k: 90_000, // 1 s window (tight)
            disk_cap_bytes: u64::MAX,
        };
        let mut buf = SegmentBuffer::new(
            "session-4".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        // Create 2 segments
        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(2, 90_000, 45_000, true)).await.unwrap();
        buf.push(make_fragment(3, 135_000, 45_000, false)).await.unwrap();
        buf.flush().await.unwrap();

        // Pin all segments
        let pinned = buf.pin_snapshot(180_000).await.unwrap();
        assert!(!pinned.is_empty());

        // Push more to trigger eviction pressure
        buf.push(make_fragment(4, 180_000, 45_000, true)).await.unwrap();
        buf.push(make_fragment(5, 225_000, 45_000, false)).await.unwrap();
        buf.flush().await.unwrap();

        // Pinned segments should still exist
        let segs = buf.committed_segments().await;
        let indices: Vec<u32> = pinned.iter().map(|s| s.index).collect();
        for idx in &indices {
            assert!(segs.iter().any(|s| s.index == *idx), "pinned segment {idx} was evicted");
        }

        // Release and push more to trigger eviction
        buf.release_snapshot(&indices).await;
        buf.push(make_fragment(6, 270_000, 45_000, true)).await.unwrap();
        buf.push(make_fragment(7, 315_000, 45_000, false)).await.unwrap();
        buf.flush().await.unwrap();

        // Now old segments should be evicted
        let segs_after = buf.committed_segments().await;
        assert!(
            segs_after.len() < segs.len() + 2,
            "expected eviction after release"
        );
    }

    #[tokio::test]
    async fn closed_buffer_rejects_push() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-5");
        let mut buf = SegmentBuffer::new(
            "session-5".into(),
            None,
            &session_dir,
            SegmentBufferConfig::default(),
            test_notifier(),
        ).unwrap();

        buf.close().await;
        let result = buf.push(make_fragment(0, 0, 45_000, true)).await;
        assert!(matches!(result, Err(FragmentSinkError::Closed)));
    }

    #[tokio::test]
    async fn finalize_commits_tail_segment() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-fin");
        let mut buf = SegmentBuffer::new(
            "session-fin".into(),
            None,
            &session_dir,
            SegmentBufferConfig {
                target_duration_90k: 180_000,
                ..Default::default()
            },
            test_notifier(),
        ).unwrap();

        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        assert_eq!(buf.bytes_on_disk().await, 0);

        buf.finalize().await.unwrap();
        assert!(buf.bytes_on_disk().await > 0, "tail segment not committed by finalize");
        assert!(session_dir.join("00000000.mp4").exists());

        let result = buf.push(make_fragment(2, 90_000, 45_000, true)).await;
        assert!(matches!(result, Err(FragmentSinkError::Closed)));
    }

    #[tokio::test]
    async fn pre_keyframe_fragments_are_dropped() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-gate");
        let mut buf = SegmentBuffer::new(
            "session-gate".into(),
            None,
            &session_dir,
            SegmentBufferConfig {
                target_duration_90k: 90_000,
                ..Default::default()
            },
            test_notifier(),
        ).unwrap();

        buf.push(make_fragment(0, 0, 45_000, false)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(2, 90_000, 45_000, true)).await.unwrap();
        buf.push(make_fragment(3, 135_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(4, 180_000, 45_000, true)).await.unwrap();

        let segs = buf.committed_segments().await;
        assert_eq!(segs.len(), 1);
        assert!(segs[0].is_keyframe_first, "committed segment must start with keyframe");
    }

    #[tokio::test]
    async fn pre_keyframe_only_stream_produces_no_segments() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-nokf");
        let mut buf = SegmentBuffer::new(
            "session-nokf".into(),
            None,
            &session_dir,
            SegmentBufferConfig::default(),
            test_notifier(),
        ).unwrap();

        buf.push(make_fragment(0, 0, 45_000, false)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        buf.finalize().await.unwrap();

        assert_eq!(buf.bytes_on_disk().await, 0);
        assert!(buf.committed_segments().await.is_empty());
    }

    #[tokio::test]
    async fn stream_id_propagated_to_buffer() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-sid");
        let buf = SegmentBuffer::new(
            "session-sid".into(),
            Some("stream-42".into()),
            &session_dir,
            SegmentBufferConfig::default(),
            test_notifier(),
        ).unwrap();

        let inner = buf.inner.lock().await;
        assert_eq!(inner.stream_id.as_deref(), Some("stream-42"));
    }

    #[tokio::test]
    async fn set_init_segment_persists_init_mp4() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-init");
        let mut buf = SegmentBuffer::new(
            "session-init".into(),
            None,
            &session_dir,
            SegmentBufferConfig::default(),
            test_notifier(),
        ).unwrap();

        let init_data = b"fake-ftyp-moov-init-segment".to_vec();
        buf.set_init_segment(init_data.clone()).await.unwrap();

        let written = std::fs::read(session_dir.join("init.mp4")).unwrap();
        assert_eq!(written, init_data);
        assert!(!session_dir.join("init.mp4.partial").exists());
    }

    #[tokio::test]
    async fn format_change_resets_duration_eligible() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-fmtchg");
        let config = SegmentBufferConfig {
            target_duration_90k: 180_000,
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-fmtchg".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        // Push enough to make duration_eligible = true, then trigger format change
        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(2, 90_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(3, 135_000, 45_000, false)).await.unwrap();
        // duration_eligible is now true (180_000 >= target)

        // Format change commits the pending segment and resets duration_eligible
        buf.notify_format_change().await.unwrap();
        let segs = buf.committed_segments().await;
        assert_eq!(segs.len(), 1, "format change should commit pending");

        // Now push a short segment — keyframe should NOT commit because
        // duration_eligible was reset by commit_pending()
        buf.push(make_fragment(4, 180_000, 45_000, true)).await.unwrap();
        buf.push(make_fragment(5, 225_000, 45_000, false)).await.unwrap();
        // Push a keyframe — should NOT trigger commit (only 90_000 ticks, under 180_000 target)
        buf.push(make_fragment(6, 270_000, 45_000, true)).await.unwrap();

        let segs = buf.committed_segments().await;
        assert_eq!(segs.len(), 1, "short segment after format-change should not commit on keyframe");
    }

    #[tokio::test]
    async fn format_change_resets_keyframe_gate() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-kfgate");
        let config = SegmentBufferConfig {
            target_duration_90k: 90_000,
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-kfgate".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        // Push a keyframe + non-keyframe, then trigger format change
        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(2, 90_000, 45_000, false)).await.unwrap();
        buf.notify_format_change().await.unwrap();
        let segs = buf.committed_segments().await;
        assert_eq!(segs.len(), 1);

        // Non-keyframe after format change should be dropped (keyframe gate reset)
        buf.push(make_fragment(3, 135_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(4, 180_000, 45_000, false)).await.unwrap();

        // These should NOT appear in pending since they lack a keyframe
        buf.flush().await.unwrap();
        let segs = buf.committed_segments().await;
        assert_eq!(segs.len(), 1, "non-keyframe fragments after format change should be dropped");

        // Now push a keyframe — should be accepted
        buf.push(make_fragment(5, 225_000, 45_000, true)).await.unwrap();
        buf.flush().await.unwrap();
        let segs = buf.committed_segments().await;
        assert_eq!(segs.len(), 2, "keyframe after format change should start new segment");
    }

    #[tokio::test]
    async fn diagnostics_event_includes_keyframe_metrics() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-diag");
        let config = SegmentBufferConfig {
            target_duration_90k: 180_000,
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-diag".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();
        buf.push(make_fragment(2, 90_000, 45_000, true)).await.unwrap();

        let inner = buf.inner.lock().await;
        assert_eq!(inner.keyframes_seen, 2);
        assert!(inner.last_keyframe_at.is_some());
        assert!(inner.last_keyframe_at.unwrap().elapsed().as_millis() < 5000);
        assert_eq!(inner.pending.total_duration_90k, 135_000);
        assert!(!inner.duration_eligible);
    }

    #[tokio::test]
    async fn diagnostics_event_after_commit_resets_pending() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-diag-reset");
        let config = SegmentBufferConfig {
            target_duration_90k: 90_000,
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-diag-reset".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        ).unwrap();

        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
        buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();

        {
            let inner = buf.inner.lock().await;
            assert_eq!(inner.keyframes_seen, 1);
            assert_eq!(inner.pending.total_duration_90k, 90_000);
            assert!(inner.duration_eligible);
        }

        buf.push(make_fragment(2, 90_000, 45_000, true)).await.unwrap();

        {
            let inner = buf.inner.lock().await;
            assert_eq!(inner.keyframes_seen, 2);
            assert_eq!(inner.pending.total_duration_90k, 45_000);
            assert!(!inner.duration_eligible);
            assert!(inner.last_keyframe_at.is_some());
        }

        assert!(session_dir.join("00000000.mp4").exists());
    }

    // ── ISS-005 H1a/H1b diagnostic forwarding ────────────────────────────
    //
    // These two tests prove:
    //   (1) the segment diagnostics surface forwards the LATEST observed
    //       fragment's NAL counts + raw pictureType (additive fields only);
    //   (2) the commit predicate is UNCHANGED — diagnostic payloads (even
    //       ones shaped like an IDR) cannot trigger a commit on a fragment
    //       whose `is_keyframe` flag is false.

    use crate::encoder::fragment::FragmentDiagnostics;
    use crate::encoder::h264::NalCounts;

    fn make_fragment_with_diag(
        seq: u64,
        pts_90k: u64,
        duration_90k: u32,
        is_keyframe: bool,
        diagnostics: FragmentDiagnostics,
    ) -> EncodedFragment {
        let mut f = make_fragment(seq, pts_90k, duration_90k, is_keyframe);
        f.diagnostics = diagnostics;
        f
    }

    #[tokio::test]
    async fn diagnostics_forwards_latest_fragment_nal_counts_and_picture_type() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-iss005-fwd");
        let config = SegmentBufferConfig {
            target_duration_90k: 180_000,
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-iss005-fwd".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        )
        .unwrap();

        // First fragment: NVENC reports IDR with SPS/PPS bring-up + SEI.
        let d_idr = FragmentDiagnostics {
            nal_counts: NalCounts {
                idr: 1,
                non_idr_slice: 0,
                sps: 1,
                pps: 1,
                sei: 1,
                other: 0,
            },
            picture_type: 3, // raw NV_ENC_PIC_TYPE_IDR (P=0,B=1,I=2,IDR=3,BI=4)
        };
        buf.push(make_fragment_with_diag(0, 0, 45_000, true, d_idr))
            .await
            .unwrap();

        {
            let inner = buf.inner.lock().await;
            assert_eq!(inner.last_fragment_idr_nal_count, 1);
            assert_eq!(inner.last_fragment_non_idr_slice_count, 0);
            assert_eq!(inner.last_fragment_sps_count, 1);
            assert_eq!(inner.last_fragment_pps_count, 1);
            assert_eq!(inner.last_fragment_sei_count, 1);
            assert_eq!(inner.last_fragment_other_nal_count, 0);
            assert_eq!(inner.last_fragment_picture_type, 3);
        }

        // Second fragment: non-IDR slice (P-frame), no parameter sets.
        let d_p = FragmentDiagnostics {
            nal_counts: NalCounts {
                idr: 0,
                non_idr_slice: 1,
                sps: 0,
                pps: 0,
                sei: 0,
                other: 0,
            },
            picture_type: 0, // raw NV_ENC_PIC_TYPE_P
        };
        buf.push(make_fragment_with_diag(1, 45_000, 45_000, false, d_p))
            .await
            .unwrap();

        let inner = buf.inner.lock().await;
        // Latest observed fragment was the P-frame — its values surface now.
        assert_eq!(inner.last_fragment_idr_nal_count, 0);
        assert_eq!(inner.last_fragment_non_idr_slice_count, 1);
        assert_eq!(inner.last_fragment_sps_count, 0);
        assert_eq!(inner.last_fragment_pps_count, 0);
        assert_eq!(inner.last_fragment_sei_count, 0);
        assert_eq!(inner.last_fragment_other_nal_count, 0);
        assert_eq!(inner.last_fragment_picture_type, 0);
    }

    #[tokio::test]
    async fn diagnostic_payload_does_not_change_commit_predicate() {
        // Commit predicate is `is_keyframe && !pending.is_empty() &&
        // duration_eligible`. A non-keyframe fragment carrying IDR-shaped
        // diagnostic NAL counts MUST NOT cause a commit.
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("session-iss005-commit");
        let config = SegmentBufferConfig {
            target_duration_90k: 90_000,
            ..Default::default()
        };
        let mut buf = SegmentBuffer::new(
            "session-iss005-commit".into(),
            None,
            &session_dir,
            config,
            test_notifier(),
        )
        .unwrap();

        // Real keyframe to flip seen_first_keyframe.
        buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();

        // Fragments past the duration target, carrying IDR-claiming
        // diagnostics, but with is_keyframe=false. Must NOT commit.
        let idr_diag = FragmentDiagnostics {
            nal_counts: NalCounts {
                idr: 1,
                non_idr_slice: 0,
                sps: 1,
                pps: 1,
                sei: 0,
                other: 0,
            },
            picture_type: 3,
        };
        for seq in 1..=3u64 {
            buf.push(make_fragment_with_diag(
                seq,
                seq * 45_000,
                45_000,
                false,
                idr_diag,
            ))
            .await
            .unwrap();
        }

        {
            let inner = buf.inner.lock().await;
            assert!(inner.duration_eligible, "duration target reached");
            assert_eq!(inner.keyframes_seen, 1, "no new keyframe pushed yet");
        }
        assert!(
            !session_dir.join("00000000.mp4").exists(),
            "must not commit while is_keyframe stays false"
        );

        // Real keyframe — commit fires as before.
        buf.push(make_fragment(4, 4 * 45_000, 45_000, true))
            .await
            .unwrap();
        assert!(session_dir.join("00000000.mp4").exists());
    }
}
