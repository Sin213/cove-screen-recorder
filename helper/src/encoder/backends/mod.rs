//! Encoder backend implementations.
//!
//! T-017 ships scaffolding only: both backends report `not-implemented-yet` at
//! probe time so the slot is reserved without lying about availability.  T-017a
//! flips the stubs to real implementations:
//!
//! - `nvenc`  → real CUDA external-memory import + NvEncodeAPI session creation
//! - `libx264` → real `ffmpeg-next` (or `x264-sys`) encode loop
//!
//! VAAPI / QSV / AMF land in follow-up tickets per T-017 out-of-scope.

pub mod amf;
pub mod nvenc;
pub mod qsv;
pub mod x264;

pub use amf::AmfBackend;
pub use nvenc::NvencBackend;
pub use qsv::QsvBackend;
pub use x264::X264Backend;
