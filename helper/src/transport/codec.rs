use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_FRAME: usize = 1024 * 1024; // 1 MiB

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame too large: {0} bytes (max 1 MiB)")]
    TooLarge(u32),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub async fn read_frame<R>(reader: &mut R) -> Result<Vec<u8>, FrameError>
where
    R: AsyncReadExt + Unpin,
{
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf);
    if len as usize > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf).await?;
    Ok(buf)
}

pub async fn write_frame<W>(writer: &mut W, payload: &[u8]) -> Result<(), std::io::Error>
where
    W: AsyncWriteExt + Unpin,
{
    let len = payload.len() as u32;
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}
