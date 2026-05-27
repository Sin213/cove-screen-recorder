//! T-058 — Windows frame pacing utilities tests.
//! These are platform-neutral (qpc_to_ns is pure math).

use cove_replay_engine::capture::windows_pacing::{qpc_to_ns, FrameSkipStrategy};

#[test]
fn qpc_to_ns_one_second_at_10mhz() {
    assert_eq!(qpc_to_ns(10_000_000, 10_000_000), 1_000_000_000);
}

#[test]
fn qpc_to_ns_zero_input_returns_zero() {
    assert_eq!(qpc_to_ns(0, 10_000_000), 0);
    assert_eq!(qpc_to_ns(-1, 10_000_000), 0);
}

#[test]
fn qpc_to_ns_no_overflow_for_large_ticks() {
    // Values large enough to overflow i64 if computed in i64 are clamped to i64::MAX.
    let result = qpc_to_ns(i64::MAX, 1);
    assert_eq!(result, i64::MAX, "large tick must clamp to i64::MAX");
}

#[test]
fn qpc_to_ns_zero_freq_returns_zero() {
    assert_eq!(qpc_to_ns(1_000_000, 0), 0);
}

#[test]
fn frame_skip_strategy_default_is_drop_newest() {
    assert_eq!(FrameSkipStrategy::default(), FrameSkipStrategy::DropNewest);
}
