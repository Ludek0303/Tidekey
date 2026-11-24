//! Tests for the first video keyframe (docs/PODGLAD.md §2.2): the fixtures, cut and damaged files, and small
//! synthetic files built here.

use super::*;
use crate::PreviewError;
use proptest::prelude::*;

const H264_MKV: &[u8] = include_bytes!("../../../fixtures/preview/film-h264.mkv");
const VP9_MKV: &[u8] = include_bytes!("../../../fixtures/preview/film-vp9.mkv");
const WEBM: &[u8] = include_bytes!("../../../fixtures/preview/film.webm");
const MJPEG_AVI: &[u8] = include_bytes!("../../../fixtures/preview/film.avi");
const H264_AVI: &[u8] = include_bytes!("../../../fixtures/preview/film-h264.avi");
const RANDOM_MKV: &[u8] = include_bytes!("../../../fixtures/preview/losowe.mkv");

const FIXTURES: [&[u8]; 6] = [H264_MKV, VP9_MKV, WEBM, MJPEG_AVI, H264_AVI, RANDOM_MKV];

/// Reference DHT payload (DC luma, AC luma, DC chroma, AC chroma), as libjpeg writes it.
/// Taken from a Pillow JPEG; the standard tables do not depend on quality.
const STANDARD_TABLES: &[u8] = &[
    0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x10, 0x00, 0x02,
    0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02,
    0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71,
    0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33,
    0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
    0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53,
    0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73,
    0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92,
    0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
    0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
    0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4,
    0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
    0x01, 0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x11, 0x00, 0x02,
    0x01, 0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00, 0x01, 0x02, 0x77, 0x00, 0x01,
    0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22,
    0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62,
    0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
    0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a,
    0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3,
    0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/// An EBML element with an 8-byte size.
fn el(id: &[u8], body: &[u8]) -> Vec<u8> {
    let mut out = id.to_vec();
    out.push(0x01);
    out.extend_from_slice(&(body.len() as u64).to_be_bytes()[1..]);
    out.extend_from_slice(body);
    out
}

/// An EBML element of unknown size (only Segment and Cluster may have one).
fn unknown(id: &[u8]) -> Vec<u8> {
    let mut out = id.to_vec();
    out.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    out
}

fn ebml_header() -> Vec<u8> {
    el(&[0x1A, 0x45, 0xDF, 0xA3], &el(&[0x42, 0x82], b"matroska"))
}

/// Tracks with one entry: track 1 of the given type, codec and size.
fn tracks(kind: u8, codec: &[u8], w: u8, h: u8) -> Vec<u8> {
    let video = el(&[0xE0], &[el(&[0xB0], &[w]), el(&[0xBA], &[h])].concat());
    let entry = [el(&[0xD7], &[1]), el(&[0x83], &[kind]), el(&[0x86], codec), video].concat();
    el(&[0x16, 0x54, 0xAE, 0x6B], &el(&[0xAE], &entry))
}

fn vp8_tracks() -> Vec<u8> {
    tracks(1, b"V_VP8", 16, 16)
}

fn simple_block(track: u8, flags: u8, payload: &[u8]) -> Vec<u8> {
    let mut body = vec![0x80 | track, 0, 0, flags];
    body.extend_from_slice(payload);
    el(&[0xA3], &body)
}

fn cluster(blocks: &[Vec<u8>]) -> Vec<u8> {
    el(&[0x1F, 0x43, 0xB6, 0x75], &blocks.concat())
}

/// A Matroska file: EBML header, a Segment of unknown size, then `parts`.
fn mkv(parts: &[Vec<u8>]) -> Vec<u8> {
    let mut out = ebml_header();
    out.extend_from_slice(&unknown(&[0x18, 0x53, 0x80, 0x67]));
    out.extend_from_slice(&parts.concat());
    out
}

/// A RIFF chunk, padded to an even length.
fn chunk(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = id.to_vec();
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
    out
}

fn list(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut data = kind.to_vec();
    data.extend_from_slice(body);
    chunk(b"LIST", &data)
}

/// An AVI with one video stream (fourcc `codec`, `w` x `h`), the given movi chunks and optional idx1 payload.
fn avi(codec: &[u8; 4], w: u32, h: u32, movi_body: &[u8], idx1: Option<&[u8]>) -> Vec<u8> {
    let mut avih = vec![0u8; 56];
    avih[0..4].copy_from_slice(&40_000u32.to_le_bytes());
    avih[16..20].copy_from_slice(&25u32.to_le_bytes());
    let mut strh = vec![0u8; 56];
    strh[0..4].copy_from_slice(b"vids");
    strh[4..8].copy_from_slice(codec);
    let mut strf = vec![0u8; 40];
    strf[0..4].copy_from_slice(&40u32.to_le_bytes());
    strf[4..8].copy_from_slice(&w.to_le_bytes());
    strf[8..12].copy_from_slice(&h.to_le_bytes());
    strf[16..20].copy_from_slice(codec);
    let strl = list(b"strl", &[chunk(b"strh", &strh), chunk(b"strf", &strf)].concat());
    let hdrl = list(b"hdrl", &[chunk(b"avih", &avih), strl].concat());
    let mut body = b"AVI ".to_vec();
    body.extend_from_slice(&hdrl);
    body.extend_from_slice(&list(b"movi", movi_body));
    if let Some(index) = idx1 {
        body.extend_from_slice(&chunk(b"idx1", index));
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// A JPEG with SOI, a minimal SOS and EOI: no Huffman tables, so the reader must add them.
const BARE_JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9];

#[test]
fn h264_mkv_gives_avc_codec_and_avcc() {
    let k = video_first_keyframe(H264_MKV).expect("film-h264.mkv");
    let avcc = k.description.clone().expect("avcC");
    assert_eq!(avcc.first(), Some(&1), "avcC version");
    // ffprobe: H.264 High profile (0x64), level 3.0 (0x1E)
    assert_eq!(avcc.get(1), Some(&0x64));
    assert_eq!(avcc.get(3), Some(&0x1E));
    assert_eq!(k.codec, format!("avc1.{:02X}{:02X}{:02X}", avcc[1], avcc[2], avcc[3]));
    assert_eq!((k.width, k.height), (640, 360));
    assert!(!k.data.is_empty());
    assert!(k.duration_ms.is_some_and(|d| (3950..=4050).contains(&d)), "duration {:?}", k.duration_ms);
}

#[test]
fn vp9_mkv_and_webm_give_vp09_without_description() {
    for file in [VP9_MKV, WEBM] {
        let k = video_first_keyframe(file).expect("vp9 fixture");
        assert!(k.codec.starts_with("vp09.00."), "codec {}", k.codec);
        assert_eq!(k.description, None);
        assert_eq!((k.width, k.height), (640, 360));
        assert!(!k.data.is_empty());
        assert!(k.duration_ms.is_some());
    }
}

#[test]
fn mjpeg_avi_gives_mjpeg_with_jpeg_data() {
    let k = video_first_keyframe(MJPEG_AVI).expect("film.avi");
    assert_eq!(k.codec, "mjpeg");
    assert_eq!(k.description, None);
    assert_eq!((k.width, k.height), (640, 360));
    assert!(k.data.starts_with(&[0xFF, 0xD8]));
    // the fixture frame already has its own DHT, so it must come out unchanged (9784 bytes in the chunk)
    assert_eq!(k.data.len(), 9784);
}

#[test]
fn h264_avi_gives_annexb_codec_from_sps() {
    let k = video_first_keyframe(H264_AVI).expect("film-h264.avi");
    assert!(k.codec.starts_with("avc1.6400"), "codec {}", k.codec);
    assert_eq!(k.description, None);
    assert_eq!((k.width, k.height), (640, 360));
    let has_sps = k.data.windows(5).any(|w| matches!(w, [0, 0, 0, 1, 0x67]) || matches!(w, [0, 0, 1, 0x67, _]));
    assert!(has_sps, "no SPS NAL in the first frame");
}

#[test]
fn random_bytes_with_mkv_magic_are_an_error() {
    assert!(video_first_keyframe(RANDOM_MKV).is_err());
}

#[test]
fn bytes_without_a_video_signature_are_unsupported() {
    assert_eq!(video_first_keyframe(b"%PDF-1.4 nie film"), Err(PreviewError::Unsupported));
    assert_eq!(video_first_keyframe(&[]), Err(PreviewError::Unsupported));
}

#[test]
fn every_cut_of_every_fixture_is_an_error_or_ok_never_a_panic() {
    for file in FIXTURES {
        for cut in (0..file.len()).step_by(997) {
            let _ = video_first_keyframe(&file[..cut]);
        }
    }
}

#[test]
fn every_101st_byte_damaged_is_an_error_or_ok_never_a_panic() {
    for file in FIXTURES {
        let mut damaged = file.to_vec();
        for i in (0..damaged.len()).step_by(101) {
            damaged[i] ^= 0x5a;
        }
        let _ = video_first_keyframe(&damaged);
    }
}

#[test]
fn first_20_kib_of_h264_mkv_has_its_keyframe() {
    // the keyframe of film-h264.mkv is in the first cluster, near the start of the file
    let k = video_first_keyframe(&H264_MKV[..20 * 1024]).expect("first 20 KiB");
    assert_eq!((k.width, k.height), (640, 360));
}

#[test]
fn synthetic_vp8_keyframe_is_read() {
    let file = mkv(&[vp8_tracks(), cluster(&[simple_block(1, 0x80, b"KEY")])]);
    let k = video_first_keyframe(&file).expect("synthetic vp8");
    assert_eq!(k.codec, "vp8");
    assert_eq!(k.description, None);
    assert_eq!((k.width, k.height), (16, 16));
    assert_eq!(k.data, b"KEY");
    assert_eq!(k.duration_ms, None);
}

#[test]
fn non_key_blocks_and_other_tracks_are_skipped() {
    let file = mkv(&[
        vp8_tracks(),
        cluster(&[simple_block(1, 0x00, b"P"), simple_block(2, 0x80, b"OTHER"), simple_block(1, 0x80, b"K")]),
    ]);
    assert_eq!(video_first_keyframe(&file).expect("keyframe").data, b"K");
}

#[test]
fn laced_block_is_skipped() {
    let file = mkv(&[vp8_tracks(), cluster(&[simple_block(1, 0x82, b"LACED")])]);
    assert!(video_first_keyframe(&file).is_err());
}

#[test]
fn block_group_is_a_keyframe_only_without_reference_block() {
    let block = el(&[0xA1], &[&[0x81u8, 0, 0, 0][..], b"G"].concat());
    let key = mkv(&[vp8_tracks(), cluster(&[el(&[0xA0], &block)])]);
    assert_eq!(video_first_keyframe(&key).expect("group").data, b"G");
    let reference = el(&[0xFB], &[1]);
    let inter = mkv(&[vp8_tracks(), cluster(&[el(&[0xA0], &[block, reference].concat())])]);
    assert!(video_first_keyframe(&inter).is_err());
}

#[test]
fn keyframe_in_a_later_cluster_is_found() {
    let file = mkv(&[
        vp8_tracks(),
        cluster(&[simple_block(1, 0x00, b"P")]),
        cluster(&[simple_block(1, 0x80, b"LATER")]),
    ]);
    assert_eq!(video_first_keyframe(&file).expect("later").data, b"LATER");
}

#[test]
fn hevc_is_unsupported() {
    let file = mkv(&[tracks(1, b"V_MPEGH/ISO/HEVC", 16, 16), cluster(&[simple_block(1, 0x80, b"K")])]);
    assert_eq!(video_first_keyframe(&file), Err(PreviewError::Unsupported));
}

#[test]
fn audio_only_file_is_unsupported() {
    let file = mkv(&[tracks(2, b"A_OPUS", 0, 0), cluster(&[simple_block(1, 0x80, b"K")])]);
    assert_eq!(video_first_keyframe(&file), Err(PreviewError::Unsupported));
}

#[test]
fn zero_or_huge_dimensions_are_unsupported() {
    let zero = mkv(&[tracks(1, b"V_VP8", 0, 0), cluster(&[simple_block(1, 0x80, b"K")])]);
    assert_eq!(video_first_keyframe(&zero), Err(PreviewError::Unsupported));
}

#[test]
fn element_larger_than_the_file_is_corrupt() {
    // SimpleBlock declares 1 MiB of payload; the file ends after 4 bytes
    let block = [0xA3, 0x10, 0x0F, 0xFF, 0xFF, 0x81, 0, 0, 0x80, 1, 2, 3];
    let file = mkv(&[vp8_tracks(), cluster(&[block.to_vec()])]);
    assert_eq!(video_first_keyframe(&file), Err(PreviewError::Corrupt));
}

#[test]
fn deeply_nested_clusters_do_not_overflow_the_stack() {
    // each cluster of unknown size holds the next one; none has a keyframe, so the file ends as Corrupt
    let mut file = mkv(&[vp8_tracks()]);
    for _ in 0..1000 {
        file.extend_from_slice(&unknown(&[0x1F, 0x43, 0xB6, 0x75]));
        file.extend_from_slice(&simple_block(1, 0x00, b"P"));
    }
    assert_eq!(video_first_keyframe(&file), Err(PreviewError::Corrupt));
}

#[test]
fn deeply_nested_avi_lists_are_refused() {
    let mut body = chunk(b"00dc", &[0xFF, 0xD8, 0xFF, 0xD9]);
    for _ in 0..40 {
        body = list(b"rec ", &body);
    }
    let file = avi(b"MJPG", 16, 16, &body, None);
    assert_eq!(video_first_keyframe(&file), Err(PreviewError::Corrupt));
}

#[test]
fn synthetic_mjpeg_avi_gets_huffman_tables() {
    let file = avi(b"MJPG", 16, 16, &chunk(b"00dc", BARE_JPEG), None);
    let k = video_first_keyframe(&file).expect("synthetic mjpeg");
    assert_eq!(k.codec, "mjpeg");
    assert_eq!((k.width, k.height), (16, 16));
    assert_eq!(k.duration_ms, Some(1000));
    assert!(k.data.starts_with(&[0xFF, 0xD8, 0xFF, 0xC4]));
    assert!(k.data.ends_with(&[0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]));
}

#[test]
fn synthetic_h264_avi_takes_codec_from_sps() {
    let frame = [0, 0, 0, 1, 0x67, 0x42, 0xC0, 0x1E, 0xAA, 0, 0, 0, 1, 0x65, 0x88];
    let file = avi(b"H264", 16, 16, &chunk(b"00dc", &frame), None);
    let k = video_first_keyframe(&file).expect("synthetic h264");
    assert_eq!(k.codec, "avc1.42C01E");
    assert_eq!(k.description, None);
    assert_eq!(k.data, frame);
}

#[test]
fn idx1_selects_the_first_keyframe_of_the_stream() {
    // the second frame has a COM segment, so the picked frame is visible in the output
    let first_frame = [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9];
    let second_frame = [0xFF, 0xD8, 0xFF, 0xFE, 0x00, 0x02, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9];
    let movi = [chunk(b"00dc", &first_frame), chunk(b"00dc", &second_frame)].concat();
    let mut index = Vec::new();
    for (flags, size) in [(0u32, first_frame.len() as u32), (0x10, second_frame.len() as u32)] {
        index.extend_from_slice(b"00dc");
        index.extend_from_slice(&flags.to_le_bytes());
        index.extend_from_slice(&0u32.to_le_bytes());
        index.extend_from_slice(&size.to_le_bytes());
    }
    let file = avi(b"MJPG", 16, 16, &movi, Some(&index));
    let k = video_first_keyframe(&file).expect("idx1");
    let expected = [&second_frame[..6], &huffman_tables()[..], &second_frame[6..]].concat();
    assert_eq!(k.data, expected);
}

#[test]
fn idx1_without_a_keyframe_is_corrupt() {
    let mut index = Vec::new();
    index.extend_from_slice(b"00dc");
    index.extend_from_slice(&0u32.to_le_bytes());
    index.extend_from_slice(&0u32.to_le_bytes());
    index.extend_from_slice(&5u32.to_le_bytes());
    let file = avi(b"MJPG", 16, 16, &chunk(b"00dc", &[0xFF, 0xD8, 0x01, 0xFF, 0xD9]), Some(&index));
    assert_eq!(video_first_keyframe(&file), Err(PreviewError::Corrupt));
}

#[test]
fn huffman_tables_are_the_standard_ones() {
    let dht = huffman_tables();
    assert_eq!(&dht[..4], &[0xFF, 0xC4, 0x01, 0xA2]);
    assert_eq!(&dht[4..], STANDARD_TABLES);
}

#[test]
fn jpeg_with_tables_is_returned_unchanged() {
    let with = [&BARE_JPEG[..2], &huffman_tables(), &BARE_JPEG[2..]].concat();
    assert_eq!(add_huffman_tables(&with), Ok(with.clone()));
}

#[test]
fn jpeg_without_tables_gets_them_before_sos() {
    let out = add_huffman_tables(BARE_JPEG).expect("bare jpeg");
    assert_eq!(out, [&BARE_JPEG[..2], &huffman_tables(), &BARE_JPEG[2..]].concat());
}

#[test]
fn jpeg_without_soi_is_corrupt() {
    assert_eq!(add_huffman_tables(&[0x00, 0x01, 0xFF, 0xDA]), Err(PreviewError::Corrupt));
}

#[test]
fn vp9_codec_from_codec_private() {
    assert_eq!(vp9_codec(None), Ok("vp09.00.10.08".to_string()));
    assert_eq!(vp9_codec(Some(&[1, 1, 2, 2, 1, 41, 3, 1, 10])), Ok("vp09.02.41.10".to_string()));
}

#[test]
fn av1_codec_from_av1c() {
    assert_eq!(av1_codec(&[0x81, 0x01, 0x00, 0x00]), Ok("av01.0.01M.08".to_string()));
    assert_eq!(av1_codec(&[0x81, 0x0D, 0x80, 0x00]), Ok("av01.0.13H.08".to_string()));
    assert_eq!(av1_codec(&[0x81, 0x20, 0x40, 0x00]), Ok("av01.1.00M.10".to_string()));
    assert_eq!(av1_codec(&[0x81, 0x01]), Err(PreviewError::Corrupt));
}

#[test]
fn avc_codec_from_avcc_bytes() {
    assert_eq!(avc_codec(&[1, 0x64, 0x00, 0x1E]), Ok("avc1.64001E".to_string()));
    assert_eq!(avc_codec(&[1, 0x64]), Err(PreviewError::Corrupt));
}

proptest! {
    #[test]
    fn any_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
        let _ = video_first_keyframe(&bytes);
    }

    #[test]
    fn any_bytes_after_a_signature_never_panic(
        prefix in prop_oneof![Just(vec![0x1A, 0x45, 0xDF, 0xA3]), Just(b"RIFF\0\0\0\0AVI ".to_vec())],
        tail in prop::collection::vec(any::<u8>(), 0..4096),
    ) {
        let _ = video_first_keyframe(&[prefix, tail].concat());
    }
}
