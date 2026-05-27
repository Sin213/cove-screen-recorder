//! Boot-time recovery scan for prior crash segments.
//!
//! On helper boot, scan the segments root for session directories left by
//! prior crashes. Discard `.partial` files; if at least one committed segment
//! exists, register it as recoverable and emit `replay.recoveryAvailable`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use tracing::{debug, info, warn};

use crate::protocol::types::SegmentRef;
use crate::segment::buffer::SegmentManifest;

/// Info about a recoverable session discovered on boot.
#[derive(Clone, Debug)]
pub struct RecoverableSessionInfo {
    pub session_id: String,
    pub session_dir: PathBuf,
    pub segments: Vec<SegmentRef>,
    pub total_bytes: u64,
    pub last_committed_index: u32,
    pub has_init_segment: bool,
}

fn read_manifest(session_dir: &Path) -> Option<SegmentManifest> {
    let manifest_path = session_dir.join("manifest.json");
    let data = std::fs::read(&manifest_path).ok()?;
    serde_json::from_slice(&data).ok()
}

/// Scan `segments_root` for directories left by prior sessions.
/// Each sub-directory name is treated as a session_id.
/// Discards `.partial` files and returns info for sessions with committed segments.
pub fn scan_recoverable_sessions(segments_root: &Path) -> Result<Vec<RecoverableSessionInfo>> {
    if !segments_root.exists() {
        return Ok(Vec::new());
    }

    let mut recovered = Vec::new();

    let entries = std::fs::read_dir(segments_root)?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let session_id = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        // Read manifest if present — it is authoritative for which segments
        // belong to the committed set. Files on disk not listed in the manifest
        // are stale orphans from failed evictions and must be cleaned up, not
        // recovered.
        let manifest = read_manifest(&path);
        let manifest_entries: HashMap<u32, crate::segment::buffer::ManifestEntry> = manifest
            .as_ref()
            .map(|m| m.segments.iter().cloned().map(|e| (e.index, e)).collect())
            .unwrap_or_default();
        let has_manifest = manifest.is_some();

        // Discard partial files and collect segment files on disk
        let mut partials_removed = 0u32;
        let mut committed = Vec::new();
        let mut orphan_files = Vec::new();

        let dir_entries = match std::fs::read_dir(&path) {
            Ok(e) => e,
            Err(e) => {
                warn!(session_id = %session_id, error = %e, "failed to read session dir");
                continue;
            }
        };

        for file_entry in dir_entries {
            let file_entry = match file_entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let fname = file_entry.file_name();
            let fname_str = fname.to_string_lossy();

            if fname_str.ends_with(".mp4.partial") {
                match std::fs::remove_file(file_entry.path()) {
                    Ok(()) => partials_removed += 1,
                    Err(e) => {
                        warn!(path = %file_entry.path().display(), error = %e, "failed to remove partial");
                    }
                }
            } else if fname_str.ends_with(".mp4")
                && !fname_str.contains("manifest")
                && fname_str != "init.mp4"
            {
                let index_str = fname_str.trim_end_matches(".mp4");
                let index = match index_str.parse::<u32>() {
                    Ok(i) => i,
                    Err(_) => continue,
                };

                // When a manifest exists, only include segments it lists.
                // Unlisted files are orphans from failed evictions.
                if has_manifest && !manifest_entries.contains_key(&index) {
                    orphan_files.push(file_entry.path());
                    continue;
                }

                let meta = match std::fs::metadata(file_entry.path()) {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                let entry = manifest_entries.get(&index);
                committed.push(SegmentRef {
                    index,
                    path: file_entry.path().to_string_lossy().into_owned(),
                    pts_start_90k: entry.map(|e| e.pts_start_90k).unwrap_or(0),
                    pts_end_90k: entry.map(|e| e.pts_end_90k).unwrap_or(0),
                    duration_90k: entry.map(|e| e.duration_90k).unwrap_or(0),
                    byte_size: meta.len(),
                    is_keyframe_first: entry.map(|e| e.is_keyframe_first).unwrap_or(true),
                    discontinuity: entry.map(|e| e.discontinuity).unwrap_or(false),
                    fragment_count: entry.map(|e| e.fragment_count).unwrap_or(0),
                });
            }
        }

        // Clean up orphan files from failed evictions
        for orphan in &orphan_files {
            if let Err(e) = std::fs::remove_file(orphan) {
                warn!(path = %orphan.display(), error = %e, "failed to remove orphan segment");
            }
        }
        if !orphan_files.is_empty() {
            debug!(
                session_id = %session_id,
                orphans_removed = orphan_files.len(),
                "cleaned up orphan segments not in manifest"
            );
        }

        if partials_removed > 0 {
            debug!(
                session_id = %session_id,
                partials_removed,
                "discarded partial segments"
            );
        }

        if committed.is_empty() {
            // No committed segments — remove the empty directory
            let _ = std::fs::remove_dir(&path);
            continue;
        }

        // Sort by index
        committed.sort_by_key(|s| s.index);
        let total_bytes = committed.iter().map(|s| s.byte_size).sum();
        let last_index = committed.last().map(|s| s.index).unwrap_or(0);
        let has_init = path.join("init.mp4").exists();

        info!(
            session_id = %session_id,
            segments = committed.len(),
            total_bytes,
            has_init,
            "discovered recoverable session"
        );

        recovered.push(RecoverableSessionInfo {
            session_id,
            session_dir: path,
            segments: committed,
            total_bytes,
            last_committed_index: last_index,
            has_init_segment: has_init,
        });
    }

    Ok(recovered)
}

/// Discard a recovered session by removing its directory.
pub fn discard_recovered_session(session_dir: &Path) -> Result<()> {
    if session_dir.exists() {
        std::fs::remove_dir_all(session_dir)?;
    }
    Ok(())
}

/// Resolve the segments root path.
///
/// On Windows: `%LOCALAPPDATA%\Cove\segments` (falls back to `%TEMP%\Cove\segments`).
/// On Linux/macOS: XDG conventions — `$XDG_RUNTIME_DIR`, then `$XDG_CACHE_HOME`, then
/// `~/.cache/cove-screen-recorder/segments`.
#[cfg(windows)]
pub fn resolve_segments_root() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    PathBuf::from(base).join("Cove").join("segments")
}

#[cfg(not(windows))]
pub fn resolve_segments_root() -> PathBuf {
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(runtime_dir)
            .join("cove-screen-recorder")
            .join("segments");
    }
    if let Ok(cache_dir) = std::env::var("XDG_CACHE_HOME") {
        return PathBuf::from(cache_dir)
            .join("cove-screen-recorder")
            .join("segments");
    }
    // Final fallback: ~/.cache/cove-screen-recorder/segments/
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home)
        .join(".cache")
        .join("cove-screen-recorder")
        .join("segments")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn scan_discovers_committed_segments() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create a session dir with committed + partial files
        let session_dir = root.join("test-session-abc");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("00000000.mp4"), b"committed-seg-0").unwrap();
        std::fs::write(session_dir.join("00000001.mp4"), b"committed-seg-1").unwrap();
        std::fs::write(session_dir.join("00000002.mp4.partial"), b"partial").unwrap();

        let recovered = scan_recoverable_sessions(root).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].session_id, "test-session-abc");
        assert_eq!(recovered[0].segments.len(), 2);
        assert_eq!(recovered[0].last_committed_index, 1);
        // Partial should be removed
        assert!(!session_dir.join("00000002.mp4.partial").exists());
    }

    #[test]
    fn scan_removes_empty_session_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Session with only partials
        let session_dir = root.join("empty-session");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("00000000.mp4.partial"), b"partial").unwrap();

        let recovered = scan_recoverable_sessions(root).unwrap();
        assert_eq!(recovered.len(), 0);
        assert!(!session_dir.exists());
    }

    #[test]
    fn scan_handles_nonexistent_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("does-not-exist");
        let recovered = scan_recoverable_sessions(&root).unwrap();
        assert_eq!(recovered.len(), 0);
    }

    #[test]
    fn scan_detects_init_segment() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let session_dir = root.join("init-session");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("00000000.mp4"), b"seg-data").unwrap();
        std::fs::write(session_dir.join("init.mp4"), b"init-data").unwrap();

        let recovered = scan_recoverable_sessions(root).unwrap();
        assert_eq!(recovered.len(), 1);
        assert!(recovered[0].has_init_segment);
    }

    #[test]
    fn scan_reports_missing_init_segment() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let session_dir = root.join("no-init-session");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("00000000.mp4"), b"seg-data").unwrap();

        let recovered = scan_recoverable_sessions(root).unwrap();
        assert_eq!(recovered.len(), 1);
        assert!(!recovered[0].has_init_segment);
    }

    #[test]
    fn scan_removes_orphan_files_not_in_manifest() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let session_dir = root.join("orphan-session");
        std::fs::create_dir_all(&session_dir).unwrap();
        // Segment 0 is in manifest, segment 1 is an orphan (failed eviction)
        std::fs::write(session_dir.join("00000000.mp4"), b"seg-0").unwrap();
        std::fs::write(session_dir.join("00000001.mp4"), b"orphan-seg").unwrap();

        let manifest = crate::segment::buffer::SegmentManifest {
            session_id: "orphan-session".into(),
            segments: vec![crate::segment::buffer::ManifestEntry {
                index: 0,
                pts_start_90k: 0,
                pts_end_90k: 90_000,
                duration_90k: 90_000,
                byte_size: 5,
                is_keyframe_first: true,
                discontinuity: false,
                fragment_count: 1,
            }],
        };
        let manifest_data = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(session_dir.join("manifest.json"), &manifest_data).unwrap();

        let recovered = scan_recoverable_sessions(root).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].segments.len(), 1);
        assert_eq!(recovered[0].segments[0].index, 0);
        // Orphan file should be removed
        assert!(!session_dir.join("00000001.mp4").exists());
    }

    #[test]
    fn discard_removes_session_dir() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join("to-discard");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("00000000.mp4"), b"seg").unwrap();

        discard_recovered_session(&session_dir).unwrap();
        assert!(!session_dir.exists());
    }
}
