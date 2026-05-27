//! Shared D3D11 device for capture↔encoder interop (T-057).
//!
//! Both DXGI Desktop Duplication and NVENC must use the same ID3D11Device so
//! that ID3D11Texture2D objects can be registered with the encoder without a
//! copy. This module holds a process-wide Arc<D3D11Device> that is initialised
//! once and reused for all encoder sessions.

use std::sync::{Arc, OnceLock};

use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, ID3D11Device,
    ID3D11DeviceContext,
};

pub struct D3D11Device {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
}

// SAFETY: D3D11 devices are COM objects with internal synchronisation and
// multi-threaded protection enabled at creation. They can be shared across
// threads.
unsafe impl Send for D3D11Device {}
unsafe impl Sync for D3D11Device {}

static SHARED: OnceLock<Arc<D3D11Device>> = OnceLock::new();

/// Returns the process-wide D3D11 device, creating it on the first call.
pub fn shared_device() -> windows::core::Result<Arc<D3D11Device>> {
    if let Some(dev) = SHARED.get() {
        return Ok(dev.clone());
    }
    let dev = create_device()?;
    let arc = Arc::new(dev);
    let _ = SHARED.set(arc.clone());
    Ok(SHARED.get().unwrap().clone())
}

fn create_device() -> windows::core::Result<D3D11Device> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            None,                             // padapter: use default adapter
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),               // software: null (hardware driver only)
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,                             // pfeaturelevels: accept any
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    Ok(D3D11Device {
        device: device.unwrap(),
        context: context.unwrap(),
    })
}
