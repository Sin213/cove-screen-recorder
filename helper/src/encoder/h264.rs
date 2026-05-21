//! H.264 Annex-B NAL unit scanner for diagnostics.
//!
//! Counts NAL unit types in an Annex-B byte stream so the helper can
//! distinguish whether NVENC is emitting periodic IDR NAL units or only
//! marking the first fragment as keyframe. No dependencies; no decoding.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NalCounts {
    pub idr: u32,
    pub non_idr_slice: u32,
    pub sps: u32,
    pub pps: u32,
    pub sei: u32,
    pub other: u32,
}

/// Scan an Annex-B byte buffer and bucket each NAL unit by `nal_unit_type`.
///
/// Recognises both 3-byte (`0x00 0x00 0x01`) and 4-byte
/// (`0x00 0x00 0x00 0x01`) start codes. Each NAL header byte
/// (`forbidden_zero_bit | nal_ref_idc | nal_unit_type`) is the byte
/// immediately after the start code; the low 5 bits identify the type.
///
/// Bucketing:
///   1 -> non_idr_slice
///   5 -> idr
///   6 -> sei
///   7 -> sps
///   8 -> pps
///   anything else -> other
pub fn scan_nal_types(annex_b: &[u8]) -> NalCounts {
    let mut counts = NalCounts::default();
    let mut i = 0usize;
    let len = annex_b.len();

    while i + 3 <= len {
        // Look for a start code at position i.
        let (is_start, hdr_off) = if i + 4 <= len
            && annex_b[i] == 0
            && annex_b[i + 1] == 0
            && annex_b[i + 2] == 0
            && annex_b[i + 3] == 1
        {
            (true, i + 4)
        } else if annex_b[i] == 0 && annex_b[i + 1] == 0 && annex_b[i + 2] == 1 {
            (true, i + 3)
        } else {
            (false, 0)
        };

        if !is_start {
            i += 1;
            continue;
        }

        if hdr_off >= len {
            break;
        }

        let nal_type = annex_b[hdr_off] & 0x1f;
        match nal_type {
            1 => counts.non_idr_slice += 1,
            5 => counts.idr += 1,
            6 => counts.sei += 1,
            7 => counts.sps += 1,
            8 => counts.pps += 1,
            _ => counts.other += 1,
        }

        i = hdr_off + 1;
    }

    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nal(start_code: &[u8], header_byte: u8, payload_len: usize) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(start_code);
        v.push(header_byte);
        v.extend(std::iter::repeat(0x00u8).take(payload_len));
        v
    }

    fn header_for(nal_type: u8) -> u8 {
        // forbidden_zero_bit = 0, nal_ref_idc = 3 for IDR/SPS/PPS (high).
        // Diagnostic doesn't care about nal_ref_idc; just set 0x60 for slices.
        0x60 | (nal_type & 0x1f)
    }

    #[test]
    fn detects_idr_nal_type_5() {
        let buf = nal(&[0, 0, 0, 1], header_for(5), 16);
        let c = scan_nal_types(&buf);
        assert_eq!(c.idr, 1);
        assert_eq!(c.non_idr_slice, 0);
        assert_eq!(c.sps, 0);
        assert_eq!(c.pps, 0);
        assert_eq!(c.sei, 0);
        assert_eq!(c.other, 0);
    }

    #[test]
    fn detects_non_idr_slice_type_1() {
        let buf = nal(&[0, 0, 1], header_for(1), 8);
        let c = scan_nal_types(&buf);
        assert_eq!(c.non_idr_slice, 1);
        assert_eq!(c.idr, 0);
    }

    #[test]
    fn detects_sps_pps_sei() {
        let mut buf = Vec::new();
        buf.extend(nal(&[0, 0, 0, 1], header_for(7), 4)); // SPS
        buf.extend(nal(&[0, 0, 0, 1], header_for(8), 4)); // PPS
        buf.extend(nal(&[0, 0, 0, 1], header_for(6), 4)); // SEI
        let c = scan_nal_types(&buf);
        assert_eq!(c.sps, 1);
        assert_eq!(c.pps, 1);
        assert_eq!(c.sei, 1);
        assert_eq!(c.idr, 0);
        assert_eq!(c.non_idr_slice, 0);
    }

    #[test]
    fn handles_three_byte_and_four_byte_start_codes() {
        let mut buf = Vec::new();
        buf.extend(nal(&[0, 0, 0, 1], header_for(7), 4)); // 4-byte SPS
        buf.extend(nal(&[0, 0, 1], header_for(8), 4)); // 3-byte PPS
        buf.extend(nal(&[0, 0, 0, 1], header_for(5), 16)); // 4-byte IDR
        buf.extend(nal(&[0, 0, 1], header_for(1), 8)); // 3-byte slice
        let c = scan_nal_types(&buf);
        assert_eq!(c.sps, 1);
        assert_eq!(c.pps, 1);
        assert_eq!(c.idr, 1);
        assert_eq!(c.non_idr_slice, 1);
    }

    #[test]
    fn unknown_types_go_to_other() {
        let buf = nal(&[0, 0, 0, 1], header_for(9), 4); // 9 = AUD
        let c = scan_nal_types(&buf);
        assert_eq!(c.other, 1);
        assert_eq!(c.idr, 0);
    }

    #[test]
    fn empty_buffer_returns_zero_counts() {
        let c = scan_nal_types(&[]);
        assert_eq!(c, NalCounts::default());
    }

    #[test]
    fn buffer_without_start_code_returns_zero_counts() {
        let c = scan_nal_types(&[0xaa, 0xbb, 0xcc, 0xdd]);
        assert_eq!(c, NalCounts::default());
    }

    #[test]
    fn truncated_start_code_at_end_is_ignored() {
        // Trailing 0x00 0x00 with no 0x01 must not be misread.
        let mut buf = nal(&[0, 0, 0, 1], header_for(5), 4);
        buf.extend_from_slice(&[0, 0]);
        let c = scan_nal_types(&buf);
        assert_eq!(c.idr, 1);
        assert_eq!(c.other, 0);
    }
}
