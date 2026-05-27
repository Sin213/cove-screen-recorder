//! DXGI-based GPU vendor detection for Windows encoder ordering (T-056).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdapterInfo {
    pub vendor: GpuVendor,
    pub description: String,
    pub dedicated_video_mb: u64,
}

/// Enumerate DXGI adapters (Windows only). Returns empty vec on non-Windows.
#[cfg(windows)]
pub fn detect_gpu_adapters() -> Vec<AdapterInfo> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory, IDXGIFactory};

    let mut out = Vec::new();
    unsafe {
        let factory: IDXGIFactory = match CreateDXGIFactory() {
            Ok(f) => f,
            Err(_) => return out,
        };
        let mut i = 0u32;
        loop {
            let adapter = match factory.EnumAdapters(i) {
                Ok(a) => a,
                Err(_) => break,
            };
            i += 1;
            let Ok(desc) = adapter.GetDesc() else { continue };
            let vendor = match desc.VendorId {
                0x10DE => GpuVendor::Nvidia,
                0x1002 => GpuVendor::Amd,
                0x8086 => GpuVendor::Intel,
                _ => GpuVendor::Unknown,
            };
            let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(128);
            let description = String::from_utf16_lossy(&desc.Description[..end]);
            out.push(AdapterInfo {
                vendor,
                description,
                dedicated_video_mb: desc.DedicatedVideoMemory as u64 / (1024 * 1024),
            });
        }
    }
    out
}

#[cfg(not(windows))]
pub fn detect_gpu_adapters() -> Vec<AdapterInfo> {
    vec![]
}

/// Returns the vendor of the primary (index 0) DXGI adapter, or Unknown.
pub fn primary_gpu_vendor() -> GpuVendor {
    detect_gpu_adapters()
        .first()
        .map(|a| a.vendor)
        .unwrap_or(GpuVendor::Unknown)
}
