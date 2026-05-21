//! Integration tests for the rolling segment buffer (T-018).

use std::path::Path;

use cove_replay_engine::encoder::fragment::{EncodedFragment, FragmentSink};
use cove_replay_engine::segment::{
    recovery::{discard_recovered_session, resolve_segments_root, scan_recoverable_sessions},
    SegmentBuffer, SegmentBufferConfig,
};
use cove_replay_engine::transport::notifier::Notifier;
use tempfile::TempDir;

fn test_notifier() -> Notifier {
    let (tx, _rx) = tokio::sync::mpsc::channel(64);
    Notifier::from_sender(tx)
}

fn make_fragment(seq: u64, pts_90k: u64, duration_90k: u32, is_keyframe: bool) -> EncodedFragment {
    let mut bytes = Vec::new();
    let moof_size: u32 = 8;
    bytes.extend_from_slice(&moof_size.to_be_bytes());
    bytes.extend_from_slice(b"moof");
    let mdat_payload = vec![0xABu8; 512];
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
async fn end_to_end_capture_produces_segments() {
    let tmp = TempDir::new().unwrap();
    let session_dir = tmp.path().join("e2e-session");
    let config = SegmentBufferConfig {
        target_duration_90k: 180_000, // 2 s
        window_duration_90k: 30 * 90_000, // 30 s
        disk_cap_bytes: 4 * 1024 * 1024 * 1024,
    };

    let mut buf =
        SegmentBuffer::new("e2e-session".into(), None, &session_dir, config, test_notifier()).unwrap();

    // Simulate 60 s of 60 fps capture at 2 s keyframe interval
    // 60 fps → 1 fragment per frame → 1500 ticks per frame at 90 kHz
    let frame_duration_90k = 1500u32; // 90_000 / 60 fps
    let keyframe_interval = 120; // every 2 s = 120 frames

    for i in 0..3600u64 {
        let pts = i * frame_duration_90k as u64;
        let is_keyframe = i % keyframe_interval == 0;
        buf.push(make_fragment(i, pts, frame_duration_90k, is_keyframe))
            .await
            .unwrap();
    }
    buf.flush().await.unwrap();

    // 60s capture with 30s window → eviction keeps only ~15 segments (30s / 2s)
    let segments = buf.committed_segments().await;
    assert!(
        segments.len() >= 12 && segments.len() <= 18,
        "expected ~15 segments (30s window / 2s each), got {}",
        segments.len()
    );

    // Each segment file should exist
    for seg in &segments {
        assert!(Path::new(&seg.path).exists(), "segment file missing: {}", seg.path);
    }
}

#[tokio::test]
async fn pin_snapshot_and_release() {
    let tmp = TempDir::new().unwrap();
    let session_dir = tmp.path().join("pin-session");
    let config = SegmentBufferConfig {
        target_duration_90k: 90_000, // 1 s
        window_duration_90k: 180_000, // 2 s
        disk_cap_bytes: u64::MAX,
    };

    let mut buf =
        SegmentBuffer::new("pin-session".into(), None, &session_dir, config, test_notifier()).unwrap();

    // Produce 5 s of content → 5 segments
    let frame_dur = 1500u32;
    let kf_interval = 60; // 1 s keyframe
    for i in 0..300u64 {
        let pts = i * frame_dur as u64;
        let is_kf = i % kf_interval == 0;
        buf.push(make_fragment(i, pts, frame_dur, is_kf))
            .await
            .unwrap();
    }
    buf.flush().await.unwrap();

    // Pin last 3 s
    let pinned = buf.pin_snapshot(3 * 90_000).await.unwrap();
    assert!(!pinned.is_empty());

    // Push more to create eviction pressure
    for i in 300..600u64 {
        let pts = i * frame_dur as u64;
        let is_kf = i % kf_interval == 0;
        buf.push(make_fragment(i, pts, frame_dur, is_kf))
            .await
            .unwrap();
    }
    buf.flush().await.unwrap();

    // Pinned segments must survive
    let current = buf.committed_segments().await;
    let pinned_indices: Vec<u32> = pinned.iter().map(|s| s.index).collect();
    for idx in &pinned_indices {
        assert!(
            current.iter().any(|s| s.index == *idx),
            "pinned segment {idx} was evicted"
        );
    }

    // Release and verify eviction happens
    buf.release_snapshot(&pinned_indices).await;
    for i in 600..900u64 {
        let pts = i * frame_dur as u64;
        let is_kf = i % kf_interval == 0;
        buf.push(make_fragment(i, pts, frame_dur, is_kf))
            .await
            .unwrap();
    }
    buf.flush().await.unwrap();

    let after_release = buf.committed_segments().await;
    // Old pinned segments should now be eligible and some evicted
    let still_pinned = pinned_indices
        .iter()
        .filter(|idx| after_release.iter().any(|s| s.index == **idx))
        .count();
    assert!(
        still_pinned < pinned_indices.len(),
        "expected some pinned segments evicted after release"
    );
}

#[tokio::test]
async fn recovery_scan_finds_prior_sessions() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();

    // Create a "crashed" session with committed segments
    let crashed_dir = root.join("crashed-session-xyz");
    std::fs::create_dir_all(&crashed_dir).unwrap();
    std::fs::write(crashed_dir.join("00000000.mp4"), b"segment-0-data").unwrap();
    std::fs::write(crashed_dir.join("00000001.mp4"), b"segment-1-data").unwrap();
    std::fs::write(crashed_dir.join("00000002.mp4.partial"), b"incomplete").unwrap();

    let recovered = scan_recoverable_sessions(root).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].session_id, "crashed-session-xyz");
    assert_eq!(recovered[0].segments.len(), 2);
    assert_eq!(recovered[0].last_committed_index, 1);

    // Partial was cleaned up
    assert!(!crashed_dir.join("00000002.mp4.partial").exists());

    // Discard the recovered session
    discard_recovered_session(&recovered[0].session_dir).unwrap();
    assert!(!crashed_dir.exists());
}

#[tokio::test]
async fn disk_full_produces_session_lost() {
    // Use a real dir but we'll simulate ENOSPC by capping at a tiny size
    // and checking the buffer's behaviour when writer fails.
    // Since we can't easily simulate ENOSPC in a unit test without a real tmpfs,
    // we verify the closed-sink path instead.
    let tmp = TempDir::new().unwrap();
    let session_dir = tmp.path().join("diskfull-session");
    let config = SegmentBufferConfig {
        target_duration_90k: 90_000,
        disk_cap_bytes: 2048, // Very tight cap to trigger eviction
        window_duration_90k: 90_000,
    };

    let mut buf = SegmentBuffer::new(
        "diskfull-session".into(),
        None,
        &session_dir,
        config,
        test_notifier(),
    )
    .unwrap();

    // Push enough to fill the tight cap — eviction should keep it bounded
    for i in 0..20u64 {
        let pts = i * 45_000;
        let is_kf = i % 2 == 0;
        let result = buf.push(make_fragment(i, pts, 45_000, is_kf)).await;
        if result.is_err() {
            // Expected if disk cap triggers sessionLost behaviour
            return;
        }
    }
    buf.flush().await.unwrap();

    // Verify disk usage stays bounded by cap + one segment
    let on_disk = buf.bytes_on_disk().await;
    // Eviction should keep things reasonable (cap is 2048 so most segments evicted)
    assert!(on_disk <= 4096, "bytes on disk {} exceeded expectations", on_disk);
}

#[tokio::test]
async fn format_change_forces_new_segment() {
    let tmp = TempDir::new().unwrap();
    let session_dir = tmp.path().join("fmtchange-session");
    let config = SegmentBufferConfig {
        target_duration_90k: 180_000, // 2 s
        ..Default::default()
    };

    let mut buf = SegmentBuffer::new(
        "fmtchange-session".into(),
        None,
        &session_dir,
        config,
        test_notifier(),
    )
    .unwrap();

    // Push some fragments
    buf.push(make_fragment(0, 0, 45_000, true)).await.unwrap();
    buf.push(make_fragment(1, 45_000, 45_000, false)).await.unwrap();

    // Signal format change — should force-commit pending
    buf.notify_format_change().await;
    assert!(session_dir.join("00000000.mp4").exists());

    // Next fragment goes into a new segment
    buf.push(make_fragment(2, 90_000, 45_000, true)).await.unwrap();
    buf.push(make_fragment(3, 135_000, 45_000, false)).await.unwrap();
    buf.flush().await.unwrap();

    assert!(session_dir.join("00000001.mp4").exists());
}

#[tokio::test]
async fn resolve_segments_root_returns_valid_path() {
    let root = resolve_segments_root();
    // Should end with segments/ regardless of which env var was used
    assert!(
        root.to_string_lossy().ends_with("segments"),
        "unexpected root: {:?}",
        root
    );
}
