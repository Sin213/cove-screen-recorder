//! Windows capture frame-pacing utilities — T-058.
//!
//! DXGI Desktop Duplication reports frame timestamps as QueryPerformanceCounter
//! (QPC) ticks via `DXGI_OUTDUPL_FRAME_INFO::LastPresentTime`.  The encoder
//! expects `FrameHandle::pts_ns` in nanoseconds.  This module provides the
//! conversion and the back-pressure skip strategy.

/// Convert a DXGI QPC tick count to nanoseconds.
///
/// `qpc_freq` is the value returned by `QueryPerformanceFrequency`.
/// Returns 0 for non-positive inputs or a zero frequency.
pub fn qpc_to_ns(qpc_ticks: i64, qpc_freq: u64) -> i64 {
    if qpc_ticks <= 0 || qpc_freq == 0 {
        return 0;
    }
    // Use i128 to avoid overflow for large tick values.
    let ns = (qpc_ticks as i128 * 1_000_000_000_i128) / qpc_freq as i128;
    ns.min(i64::MAX as i128) as i64
}

/// How the Windows session should drop frames when the encoder is back-pressured.
///
/// DXGI frames arrive at vsync cadence — if the encoder cannot keep up we must
/// explicitly skip frames rather than let the capture channel fill unbounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameSkipStrategy {
    /// Drop the newest arriving frame; the encoder finishes the frame it has.
    DropNewest,
    /// Drop the oldest buffered frame; always encode the freshest content.
    DropOldest,
}

impl Default for FrameSkipStrategy {
    fn default() -> Self {
        FrameSkipStrategy::DropNewest
    }
}

/// Per-session state for Windows capture frame pacing.
///
/// Converts successive DXGI `LastPresentTime` QPC values to **session-relative**
/// monotonic nanosecond PTS.  The first call to `frame_pts_ns` anchors the
/// session start; all subsequent PTS values are deltas from that anchor.
/// On Windows only — the struct is cfg-gated so it does not appear in Linux builds.
#[cfg(windows)]
#[derive(Debug)]
pub struct WindowsPacingState {
    pub qpc_freq: u64,
    pub skip_strategy: FrameSkipStrategy,
    /// QPC value at the start of the capture session; set lazily on first frame.
    session_start_qpc: Option<i64>,
    /// Last emitted PTS in ns; initialised to -1 so the first frame (delta=0)
    /// passes the monotonicity check and correctly emits PTS=0.
    last_pts_ns: i64,
}

#[cfg(windows)]
impl WindowsPacingState {
    pub fn new(qpc_freq: u64) -> Self {
        Self {
            qpc_freq,
            skip_strategy: FrameSkipStrategy::default(),
            session_start_qpc: None,
            last_pts_ns: -1,
        }
    }

    /// Convert a DXGI `LastPresentTime` QPC tick to a session-relative monotonic
    /// PTS in nanoseconds.
    ///
    /// The first call anchors the session start (`pts_ns = 0`).  Repeated or
    /// regressing QPC values advance by 1 ns to preserve strict monotonicity
    /// (mirrors `next_monotonic_pts` in the NVENC backend).
    pub fn frame_pts_ns(&mut self, present_qpc: i64) -> i64 {
        let start = *self.session_start_qpc.get_or_insert(present_qpc);
        let delta = present_qpc.saturating_sub(start);
        let candidate = qpc_to_ns(delta, self.qpc_freq);
        if candidate > self.last_pts_ns {
            self.last_pts_ns = candidate;
        } else {
            self.last_pts_ns = self.last_pts_ns.saturating_add(1);
        }
        self.last_pts_ns
    }
}
