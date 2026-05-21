//! Minimal fMP4 (ISOBMFF) writer for NVENC H.264 output.
//!
//! Produces:
//! - `init_segment()` → ftyp + moov with SPS/PPS in avcC record
//! - `encode_fragment()` → moof + mdat per encoded access unit

use std::io::Write;

fn write_box<W: Write>(w: &mut W, box_type: &[u8; 4], payload: &[u8]) {
    let size = (8 + payload.len()) as u32;
    w.write_all(&size.to_be_bytes()).unwrap();
    w.write_all(box_type).unwrap();
    w.write_all(payload).unwrap();
}

fn be32(v: u32) -> [u8; 4] { v.to_be_bytes() }
fn be16(v: u16) -> [u8; 2] { v.to_be_bytes() }
fn be64(v: u64) -> [u8; 8] { v.to_be_bytes() }

/// Build the fMP4 init segment (ftyp + moov) from SPS and PPS NAL units
/// (raw bytes, without start codes).
pub fn build_init_segment(
    width: u32,
    height: u32,
    timescale: u32,
    sps: &[u8],
    pps: &[u8],
) -> Vec<u8> {
    let mut out = Vec::new();

    // ftyp
    let ftyp_payload = {
        let mut p = Vec::new();
        p.extend_from_slice(b"isom"); // major brand
        p.extend_from_slice(&be32(0x200));  // minor version
        p.extend_from_slice(b"isom");
        p.extend_from_slice(b"iso2");
        p.extend_from_slice(b"avc1");
        p.extend_from_slice(b"mp41");
        p
    };
    write_box(&mut out, b"ftyp", &ftyp_payload);

    // moov → mvhd + trak + mvex
    let moov = build_moov(width, height, timescale, sps, pps);
    write_box(&mut out, b"moov", &moov);

    out
}

fn build_moov(width: u32, height: u32, timescale: u32, sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut p = Vec::new();

    // mvhd (version 0)
    let mvhd = {
        let mut b = Vec::new();
        b.push(0u8); b.extend_from_slice(&[0u8; 3]); // version + flags
        b.extend_from_slice(&be32(0)); // creation_time
        b.extend_from_slice(&be32(0)); // modification_time
        b.extend_from_slice(&be32(timescale));
        b.extend_from_slice(&be32(0)); // duration (live = 0)
        b.extend_from_slice(&be32(0x00010000)); // rate 1.0
        b.extend_from_slice(&be16(0x0100)); // volume 1.0
        b.extend_from_slice(&[0u8; 10]); // reserved
        // unity matrix
        b.extend_from_slice(&be32(0x00010000)); b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(&[0u8; 4]); b.extend_from_slice(&be32(0x00010000));
        b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(&[0u8; 4]); b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(&be32(0x40000000));
        b.extend_from_slice(&[0u8; 24]); // pre_defined
        b.extend_from_slice(&be32(2)); // next_track_ID
        b
    };
    write_box(&mut p, b"mvhd", &mvhd);

    // trak
    let trak = build_trak(width, height, timescale, sps, pps);
    write_box(&mut p, b"trak", &trak);

    // mvex → trex
    let trex = {
        let mut b = Vec::new();
        b.push(0u8); b.extend_from_slice(&[0u8; 3]); // version + flags
        b.extend_from_slice(&be32(1)); // track_ID
        b.extend_from_slice(&be32(1)); // default_sample_description_index
        b.extend_from_slice(&be32(0)); // default_sample_duration
        b.extend_from_slice(&be32(0)); // default_sample_size
        b.extend_from_slice(&be32(0)); // default_sample_flags
        b
    };
    let mut mvex = Vec::new();
    write_box(&mut mvex, b"trex", &trex);
    write_box(&mut p, b"mvex", &mvex);

    p
}

fn build_trak(width: u32, height: u32, timescale: u32, sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut p = Vec::new();

    // tkhd (version 0, flags=3 enabled+in-movie)
    let tkhd = {
        let mut b = Vec::new();
        b.push(0u8);
        b.extend_from_slice(&[0u8, 0u8, 3u8]); // flags
        b.extend_from_slice(&be32(0)); // creation_time
        b.extend_from_slice(&be32(0)); // modification_time
        b.extend_from_slice(&be32(1)); // track_ID
        b.extend_from_slice(&be32(0)); // reserved
        b.extend_from_slice(&be32(0)); // duration
        b.extend_from_slice(&[0u8; 8]); // reserved
        b.extend_from_slice(&be16(0)); // layer
        b.extend_from_slice(&be16(0)); // alternate_group
        b.extend_from_slice(&be16(0)); // volume (video = 0)
        b.extend_from_slice(&be16(0)); // reserved
        // unity matrix
        b.extend_from_slice(&be32(0x00010000)); b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(&[0u8; 4]); b.extend_from_slice(&be32(0x00010000));
        b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(&[0u8; 4]); b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(&be32(0x40000000));
        b.extend_from_slice(&be32(width << 16));  // width  (16.16 fixed)
        b.extend_from_slice(&be32(height << 16)); // height (16.16 fixed)
        b
    };
    write_box(&mut p, b"tkhd", &tkhd);

    // mdia
    let mdia = build_mdia(width, height, timescale, sps, pps);
    write_box(&mut p, b"mdia", &mdia);

    p
}

fn build_mdia(width: u32, height: u32, timescale: u32, sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut p = Vec::new();

    // mdhd
    let mdhd = {
        let mut b = Vec::new();
        b.push(0u8); b.extend_from_slice(&[0u8; 3]);
        b.extend_from_slice(&be32(0)); // creation_time
        b.extend_from_slice(&be32(0)); // modification_time
        b.extend_from_slice(&be32(timescale));
        b.extend_from_slice(&be32(0)); // duration
        b.extend_from_slice(&be16(0x55c4)); // language: und
        b.extend_from_slice(&be16(0)); // pre_defined
        b
    };
    write_box(&mut p, b"mdhd", &mdhd);

    // hdlr (video)
    let hdlr = {
        let mut b = Vec::new();
        b.push(0u8); b.extend_from_slice(&[0u8; 3]);
        b.extend_from_slice(&be32(0)); // pre_defined
        b.extend_from_slice(b"vide");
        b.extend_from_slice(&[0u8; 12]); // reserved
        b.extend_from_slice(b"VideoHandler\0");
        b
    };
    write_box(&mut p, b"hdlr", &hdlr);

    // minf → smhd/vmhd + dinf + stbl
    let minf = build_minf(width, height, sps, pps);
    write_box(&mut p, b"minf", &minf);

    p
}

fn build_minf(width: u32, height: u32, sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut p = Vec::new();

    // vmhd
    let vmhd = {
        let mut b = Vec::new();
        b.push(0u8); b.extend_from_slice(&[0u8, 0u8, 1u8]); // flags=1
        b.extend_from_slice(&be16(0)); // graphicsMode
        b.extend_from_slice(&[0u8; 6]); // opcolor
        b
    };
    write_box(&mut p, b"vmhd", &vmhd);

    // dinf → dref → url
    let url = {
        let mut b = Vec::new();
        b.push(0u8); b.extend_from_slice(&[0u8, 0u8, 1u8]); // flags=1 (self-contained)
        b
    };
    let mut dref_payload = Vec::new();
    dref_payload.push(0u8); dref_payload.extend_from_slice(&[0u8; 3]);
    dref_payload.extend_from_slice(&be32(1)); // entry_count
    write_box(&mut dref_payload, b"url ", &url);
    let mut dinf = Vec::new();
    write_box(&mut dinf, b"dref", &dref_payload);
    write_box(&mut p, b"dinf", &dinf);

    // stbl (empty — fMP4 uses moof/mdat, stbl is a placeholder)
    let stbl = build_stbl(width, height, sps, pps);
    write_box(&mut p, b"stbl", &stbl);

    p
}

fn build_stbl(width: u32, height: u32, sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut p = Vec::new();

    // stsd → avc1
    let avcc = build_avcc(sps, pps);
    let avc1 = {
        let mut b = Vec::new();
        b.extend_from_slice(&[0u8; 6]); // reserved
        b.extend_from_slice(&be16(1)); // data_reference_index
        b.extend_from_slice(&[0u8; 16]); // pre_defined + reserved
        b.extend_from_slice(&be16(width as u16));
        b.extend_from_slice(&be16(height as u16));
        b.extend_from_slice(&be32(0x00480000)); // horiz resolution 72dpi
        b.extend_from_slice(&be32(0x00480000)); // vert resolution 72dpi
        b.extend_from_slice(&be32(0)); // reserved
        b.extend_from_slice(&be16(1)); // frame_count
        b.extend_from_slice(&[0u8; 32]); // compressorname
        b.extend_from_slice(&be16(0x0018)); // depth
        b.extend_from_slice(&[0xff, 0xff]); // pre_defined = -1
        // avcC
        write_box(&mut b, b"avcC", &avcc);
        b
    };
    let mut stsd_payload = Vec::new();
    stsd_payload.push(0u8); stsd_payload.extend_from_slice(&[0u8; 3]);
    stsd_payload.extend_from_slice(&be32(1)); // entry_count
    write_box(&mut stsd_payload, b"avc1", &avc1);
    write_box(&mut p, b"stsd", &stsd_payload);

    // stts (empty)
    let stts = { let mut b = Vec::new(); b.push(0u8); b.extend_from_slice(&[0u8; 3]); b.extend_from_slice(&be32(0)); b };
    write_box(&mut p, b"stts", &stts);

    // stsc (empty)
    let stsc = { let mut b = Vec::new(); b.push(0u8); b.extend_from_slice(&[0u8; 3]); b.extend_from_slice(&be32(0)); b };
    write_box(&mut p, b"stsc", &stsc);

    // stsz (empty)
    let stsz = { let mut b = Vec::new(); b.push(0u8); b.extend_from_slice(&[0u8; 3]); b.extend_from_slice(&be32(0)); b.extend_from_slice(&be32(0)); b };
    write_box(&mut p, b"stsz", &stsz);

    // stco (empty)
    let stco = { let mut b = Vec::new(); b.push(0u8); b.extend_from_slice(&[0u8; 3]); b.extend_from_slice(&be32(0)); b };
    write_box(&mut p, b"stco", &stco);

    p
}

fn build_avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    b.push(1); // configurationVersion
    // profile_idc, profile_compatibility, level_idc from SPS bytes 1-3
    if sps.len() >= 4 {
        b.push(sps[1]);
        b.push(sps[2]);
        b.push(sps[3]);
    } else {
        b.extend_from_slice(&[0x42, 0xc0, 0x28]); // baseline 4.0 fallback
    }
    b.push(0xff); // lengthSizeMinusOne = 3 (4-byte NAL lengths)
    b.push(0xe1); // numSequenceParameterSets = 1
    b.extend_from_slice(&be16(sps.len() as u16));
    b.extend_from_slice(sps);
    b.push(1); // numPictureParameterSets
    b.extend_from_slice(&be16(pps.len() as u16));
    b.extend_from_slice(pps);
    b
}

/// Build a single fMP4 fragment (moof + mdat) for one access unit.
///
/// `au_bytes` is the raw H.264 bitstream in Annex-B format (with start codes).
/// We convert to AVCC length-prefixed format inside mdat.
/// `seq` is the 1-based sequence_number for the moof header.
/// `pts_90k` and `duration_90k` are in 90 kHz ticks.
/// `is_keyframe` sets the sample flags to indicate a sync sample.
pub fn build_fragment(
    seq: u64,
    pts_90k: u64,
    duration_90k: u32,
    is_keyframe: bool,
    au_bytes: &[u8],
) -> Vec<u8> {
    // Convert Annex-B → AVCC length-prefixed
    let avcc_bytes = annex_b_to_avcc(au_bytes);
    let mdat_size = 8 + avcc_bytes.len();
    let data_offset: i32 = {
        // moof size (computed below) + 8 (mdat header)
        let moof_size = compute_moof_size();
        (moof_size + 8) as i32
    };

    let moof = build_moof(seq, pts_90k, duration_90k, is_keyframe, data_offset, avcc_bytes.len() as u32);

    let mut out = Vec::with_capacity(moof.len() + mdat_size);
    out.extend_from_slice(&moof);
    // mdat
    out.extend_from_slice(&(mdat_size as u32).to_be_bytes());
    out.extend_from_slice(b"mdat");
    out.extend_from_slice(&avcc_bytes);
    out
}

fn compute_moof_size() -> usize {
    // mfhd: 8 (box) + 4 (ver+flags) + 4 (seq) = 16
    // tfhd: 8 (box) + 4 (ver+flags) + 4 (track_ID) = 16
    // tfdt: 8 (box) + 4 (ver+flags) + 8 (baseMediaDecodeTime v1 64-bit) = 20
    // trun: 8 + 4 (ver+flags) + 4 (count) + 4 (data_offset) + 4 (first_sample_flags) + 12 (dur+size+flags) = 36
    // traf: 8 + 16 (tfhd) + 20 (tfdt) + 36 (trun) = 80
    // moof: 8 + 16 (mfhd) + 80 (traf) = 104
    104
}

fn build_moof(seq: u64, pts_90k: u64, duration_90k: u32, is_keyframe: bool, data_offset: i32, sample_size: u32) -> Vec<u8> {
    let mut p = Vec::new();

    // mfhd
    let mfhd = {
        let mut b = Vec::new();
        b.push(0u8); b.extend_from_slice(&[0u8; 3]);
        b.extend_from_slice(&be32(seq as u32));
        b
    };
    write_box(&mut p, b"mfhd", &mfhd);

    // traf → tfhd + tfdt + trun
    let traf = build_traf(pts_90k, duration_90k, is_keyframe, data_offset, sample_size);
    write_box(&mut p, b"traf", &traf);

    let mut out = Vec::new();
    write_box(&mut out, b"moof", &p);
    out
}

fn build_traf(pts_90k: u64, duration_90k: u32, is_keyframe: bool, data_offset: i32, sample_size: u32) -> Vec<u8> {
    let mut p = Vec::new();

    // tfhd (track_ID=1, base-data-offset absent, default-base-is-moof)
    let tfhd = {
        let mut b = Vec::new();
        b.push(0u8);
        // flags: 0x020000 = default-base-is-moof
        b.extend_from_slice(&[0x02, 0x00, 0x00]);
        b.extend_from_slice(&be32(1)); // track_ID
        b
    };
    write_box(&mut p, b"tfhd", &tfhd);

    // tfdt (version 1 = 64-bit baseMediaDecodeTime)
    let tfdt = {
        let mut b = Vec::new();
        b.push(1u8); b.extend_from_slice(&[0u8; 3]);
        b.extend_from_slice(&be64(pts_90k));
        b
    };
    write_box(&mut p, b"tfdt", &tfdt);

    // trun (version 0)
    // flags: 0x000705 = data-offset-present (0x01) + first-sample-flags-present (0x04) +
    //                   sample-duration-present (0x100) + sample-size-present (0x200) +
    //                   sample-flags-present (0x400)
    let trun = {
        let mut b = Vec::new();
        b.push(0u8);
        b.extend_from_slice(&[0x00, 0x07, 0x05]); // flags
        b.extend_from_slice(&be32(1)); // sample_count
        b.extend_from_slice(&data_offset.to_be_bytes()); // data_offset
        // first_sample_flags: 0x02000000 = sync (keyframe), 0x01010000 = non-sync
        let sample_flags: u32 = if is_keyframe { 0x02000000 } else { 0x01010000 };
        b.extend_from_slice(&be32(sample_flags));
        b.extend_from_slice(&be32(duration_90k));
        b.extend_from_slice(&be32(sample_size));
        b.extend_from_slice(&be32(sample_flags)); // per-sample flags (same)
        b
    };
    write_box(&mut p, b"trun", &trun);

    p
}

/// Convert Annex-B (start-code delimited) H.264 to AVCC (4-byte length prefix).
fn annex_b_to_avcc(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        // Skip start code (00 00 01 or 00 00 00 01)
        if i + 3 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1 {
            i += 4;
        } else if i + 2 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            i += 3;
        } else {
            i += 1;
            continue;
        }
        // Find end of NAL unit
        let start = i;
        let end = find_next_start_code(data, i).unwrap_or(data.len());
        let nal = &data[start..end];
        out.extend_from_slice(&be32(nal.len() as u32));
        out.extend_from_slice(nal);
        i = end;
    }
    out
}

fn find_next_start_code(data: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                return Some(i);
            }
            if i + 3 < data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_segment_starts_with_ftyp() {
        let sps = [0x67, 0x42, 0xc0, 0x28, 0xd9, 0x00, 0xa0, 0x47, 0xfe, 0xc8];
        let pps = [0x68, 0xce, 0x38, 0x80];
        let seg = build_init_segment(1280, 720, 90000, &sps, &pps);
        assert!(seg.len() > 16, "init segment too short");
        assert_eq!(&seg[4..8], b"ftyp", "first box must be ftyp");
    }

    #[test]
    fn fragment_starts_with_moof() {
        let data = [0u8, 0, 0, 1, 0x65, 0xAA, 0xBB]; // fake IDR start code + NAL
        let frag = build_fragment(1, 0, 3000, true, &data);
        assert!(frag.len() > 16);
        assert_eq!(&frag[4..8], b"moof", "first box must be moof");
    }

    fn find_box(data: &[u8], target: &[u8; 4]) -> Option<(usize, usize)> {
        let mut pos = 0;
        while pos + 8 <= data.len() {
            let size = u32::from_be_bytes([data[pos], data[pos+1], data[pos+2], data[pos+3]]) as usize;
            if size < 8 || pos + size > data.len() { break; }
            if &data[pos+4..pos+8] == target {
                return Some((pos, size));
            }
            pos += size;
        }
        None
    }

    fn find_box_nested(data: &[u8], path: &[&[u8; 4]]) -> Option<(usize, usize)> {
        let mut region = data;
        let mut abs_offset = 0usize;
        for (i, target) in path.iter().enumerate() {
            let (rel, size) = find_box(region, target)?;
            if i + 1 < path.len() {
                let inner_start = rel + 8;
                let inner_end = rel + size;
                region = &region[inner_start..inner_end];
                abs_offset += inner_start;
            } else {
                return Some((abs_offset + rel, size));
            }
        }
        None
    }

    #[test]
    fn trun_ver_flags_is_000705() {
        let data = [0u8, 0, 0, 1, 0x65, 0xAA, 0xBB];
        let frag = build_fragment(1, 0, 3000, true, &data);
        let (trun_off, _) = find_box_nested(&frag, &[b"moof", b"traf", b"trun"])
            .expect("trun box not found");
        let ver_flags = &frag[trun_off+8..trun_off+12];
        assert_eq!(ver_flags, &[0x00, 0x00, 0x07, 0x05],
            "trun ver+flags must be 00 00 07 05, got {:02x} {:02x} {:02x} {:02x}",
            ver_flags[0], ver_flags[1], ver_flags[2], ver_flags[3]);
    }

    #[test]
    fn trun_data_offset_equals_moof_size_plus_8() {
        let data = [0u8, 0, 0, 1, 0x65, 0xAA, 0xBB];
        let frag = build_fragment(1, 0, 3000, true, &data);
        let (moof_off, moof_size) = find_box(&frag, b"moof").expect("moof not found");
        let (trun_off, _) = find_box_nested(&frag, &[b"moof", b"traf", b"trun"])
            .expect("trun box not found");
        // data_offset is after ver+flags(4) + sample_count(4) = offset +8+8 = +16
        let do_off = trun_off + 8 + 4 + 4;
        let data_offset = i32::from_be_bytes([frag[do_off], frag[do_off+1], frag[do_off+2], frag[do_off+3]]);
        let expected = (moof_size + 8) as i32; // moof box size + mdat header
        assert_eq!(data_offset, expected,
            "trun data_offset should be moof_size({}) + 8 = {}, got {}",
            moof_size, expected, data_offset);
        let _ = moof_off;
    }

    #[test]
    fn compute_moof_size_matches_actual() {
        let data = [0u8, 0, 0, 1, 0x65, 0xAA, 0xBB];
        let frag = build_fragment(1, 0, 3000, true, &data);
        let (_, actual_moof_size) = find_box(&frag, b"moof").expect("moof not found");
        assert_eq!(compute_moof_size(), actual_moof_size,
            "compute_moof_size() = {} but actual moof box is {} bytes",
            compute_moof_size(), actual_moof_size);
    }
}
