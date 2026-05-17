//! Atomic segment file writer: write → fsync → rename.

use std::io::Write;
use std::path::{Path, PathBuf};

use tokio::task;

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("disk full")]
    DiskFull(std::io::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Join(#[from] tokio::task::JoinError),
}

impl WriteError {
    pub fn is_disk_full(&self) -> bool {
        matches!(self, WriteError::DiskFull(_))
    }
}

pub fn fsync_dir(dir: &Path) -> std::io::Result<()> {
    let f = std::fs::File::open(dir)?;
    f.sync_all()
}

fn classify_io_error(e: std::io::Error) -> WriteError {
    #[cfg(unix)]
    {
        if e.raw_os_error() == Some(libc::ENOSPC) {
            return WriteError::DiskFull(e);
        }
    }
    if e.kind() == std::io::ErrorKind::StorageFull {
        return WriteError::DiskFull(e);
    }
    WriteError::Io(e)
}

pub struct AtomicSegmentWriter {
    dir: PathBuf,
}

impl AtomicSegmentWriter {
    pub fn new(dir: &Path) -> Result<Self, WriteError> {
        std::fs::create_dir_all(dir)?;
        Ok(Self { dir: dir.to_path_buf() })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Write `data` to `<index>.mp4` atomically via a `.partial` intermediate.
    /// Returns the committed path and write+fsync+rename latencies in microseconds.
    pub async fn commit(
        &self,
        index: u32,
        data: &[u8],
    ) -> Result<CommitResult, WriteError> {
        let partial_path = self.dir.join(format!("{index:08}.mp4.partial"));
        let final_path = self.dir.join(format!("{index:08}.mp4"));
        let data_owned = data.to_vec();
        let partial = partial_path.clone();
        let final_p = final_path.clone();

        let result = task::spawn_blocking(move || -> Result<CommitResult, WriteError> {
            use std::time::Instant;

            let t_write_start = Instant::now();
            let mut f = std::fs::File::create(&partial).map_err(classify_io_error)?;
            f.write_all(&data_owned).map_err(classify_io_error)?;
            let write_us = t_write_start.elapsed().as_micros() as u64;

            let t_fsync_start = Instant::now();
            f.sync_all().map_err(classify_io_error)?;
            let fsync_us = t_fsync_start.elapsed().as_micros() as u64;

            let t_rename_start = Instant::now();
            std::fs::rename(&partial, &final_p).map_err(classify_io_error)?;
            let rename_us = t_rename_start.elapsed().as_micros() as u64;

            if let Some(parent) = final_p.parent() {
                fsync_dir(parent).map_err(classify_io_error)?;
            }

            Ok(CommitResult {
                path: final_p,
                byte_size: data_owned.len() as u64,
                write_us,
                fsync_us,
                rename_us,
            })
        })
        .await??;

        Ok(result)
    }

    /// Remove a committed segment file. Idempotent.
    pub fn remove(&self, index: u32) -> Result<(), std::io::Error> {
        let path = self.dir.join(format!("{index:08}.mp4"));
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Remove any `.partial` files in the directory. Used during recovery.
    pub fn discard_partials(&self) -> Result<u32, std::io::Error> {
        let mut count = 0u32;
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if name.to_string_lossy().ends_with(".mp4.partial") {
                std::fs::remove_file(entry.path())?;
                count += 1;
            }
        }
        Ok(count)
    }
}

pub struct CommitResult {
    pub path: PathBuf,
    pub byte_size: u64,
    pub write_us: u64,
    pub fsync_us: u64,
    pub rename_us: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn commit_creates_final_file_not_partial() {
        let tmp = TempDir::new().unwrap();
        let writer = AtomicSegmentWriter::new(tmp.path()).unwrap();
        let data = b"fake-fmp4-content";
        let result = writer.commit(0, data).await.unwrap();

        assert!(result.path.exists());
        assert_eq!(result.byte_size, data.len() as u64);
        assert!(!tmp.path().join("00000000.mp4.partial").exists());
        assert!(tmp.path().join("00000000.mp4").exists());
    }

    #[tokio::test]
    async fn remove_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let writer = AtomicSegmentWriter::new(tmp.path()).unwrap();
        writer.commit(1, b"data").await.unwrap();
        writer.remove(1).unwrap();
        writer.remove(1).unwrap(); // no error on second removal
    }

    #[tokio::test]
    async fn discard_partials_removes_only_partial_files() {
        let tmp = TempDir::new().unwrap();
        let writer = AtomicSegmentWriter::new(tmp.path()).unwrap();
        writer.commit(0, b"committed").await.unwrap();
        std::fs::write(tmp.path().join("00000001.mp4.partial"), b"partial").unwrap();
        std::fs::write(tmp.path().join("00000002.mp4.partial"), b"partial2").unwrap();

        let removed = writer.discard_partials().unwrap();
        assert_eq!(removed, 2);
        assert!(tmp.path().join("00000000.mp4").exists());
        assert!(!tmp.path().join("00000001.mp4.partial").exists());
    }
}
