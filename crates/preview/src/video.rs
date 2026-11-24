//! The first keyframe of a Matroska/WebM or AVI file, for the preview frame (docs/PODGLAD.md §2.2). Only the
//! headers and the first keyframe of the first video track are read; the rest of the file is never looked at.
//! Every offset comes from the file, so each one is checked, and each loop spends budget.

use crate::{check_input, slice, u32_le, Budget, PreviewError, Result, MAX_BLOB, MAX_DEPTH};
use std::ops::Range;
use wasm_bindgen::prelude::*;

const EBML_MAGIC: [u8; 4] = [0x1A, 0x45, 0xDF, 0xA3];
const EBML_HEADER: u32 = 0x1A45_DFA3;
const DOC_TYPE: u32 = 0x4282;
const SEGMENT: u32 = 0x1853_8067;
const INFO: u32 = 0x1549_A966;
const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const DURATION: u32 = 0x4489;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_TYPE: u32 = 0x83;
const CODEC_ID: u32 = 0x86;
const CODEC_PRIVATE: u32 = 0x63A2;
const VIDEO: u32 = 0xE0;
const PIXEL_WIDTH: u32 = 0xB0;
const PIXEL_HEIGHT: u32 = 0xBA;
const CLUSTER: u32 = 0x1F43_B675;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const REFERENCE_BLOCK: u32 = 0xFB;

const VIDEO_TRACK: u64 = 1;
const DEFAULT_TIMESTAMP_SCALE: u64 = 1_000_000;
const KEYFRAME_FLAG: u8 = 0x80;
const LACING_MASK: u8 = 0x06;
const MAX_CODEC_PRIVATE: usize = 1 << 20;
const MAX_DIMENSION: u64 = 8192;

const RIFF_HEADER: usize = 12;
const AVIIF_KEYFRAME: u32 = 0x10;
const INDEX_ENTRY: usize = 16;

/// Steps one reader may spend on a single file; the same on every machine.
const BUDGET: usize = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keyframe {
    /// Codec for WebCodecs `VideoDecoder.configure({codec})`, or "mjpeg" for AVI MJPG frames.
    pub codec: String,
    /// `description` for WebCodecs: avcC or av1C; None for Annex B H.264, VP8/VP9 and MJPEG.
    pub description: Option<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    pub duration_ms: Option<u64>,
}

/// The first keyframe of the first video track of a Matroska/WebM or AVI file.
pub fn video_first_keyframe(bytes: &[u8]) -> Result<Keyframe> {
    check_input(bytes)?;
    let mut budget = Budget::new(BUDGET);
    if bytes.starts_with(&EBML_MAGIC) {
        matroska(bytes, &mut budget)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(&b"AVI "[..]) {
        avi(bytes, &mut budget)
    } else {
        Err(PreviewError::Unsupported)
    }
}

/// A keyframe for JavaScript: the getters read the fields, and `data` copies the frame.
#[wasm_bindgen]
pub struct KeyframeJs {
    inner: Keyframe,
}

#[wasm_bindgen]
impl KeyframeJs {
    #[wasm_bindgen(getter)]
    pub fn codec(&self) -> String {
        self.inner.codec.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn description(&self) -> Option<Vec<u8>> {
        self.inner.description.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height
    }

    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<u8> {
        self.inner.data.clone()
    }

    #[wasm_bindgen(getter, js_name = durationMs)]
    pub fn duration_ms(&self) -> Option<f64> {
        self.inner.duration_ms.map(|ms| ms as f64)
    }
}

/// For JavaScript: the same as `video_first_keyframe`, with the error code as the JS error message.
#[wasm_bindgen(js_name = videoFirstKeyframe)]
pub fn video_first_keyframe_js(bytes: &[u8]) -> std::result::Result<KeyframeJs, JsError> {
    video_first_keyframe(bytes)
        .map(|inner| KeyframeJs { inner })
        .map_err(|e| JsError::new(e.code()))
}

// EBML: an element is ID (VINT) + size (VINT) + data. Only the element headers and the fields read below are
// decoded; anything else is skipped by its size.

/// A variable-length integer: `raw` keeps the length marker (IDs), `value` drops it (sizes, track numbers).
#[derive(Clone, Copy)]
struct Vint {
    raw: u64,
    len: usize,
    value: u64,
}

fn vint(bytes: &[u8], at: usize, limit: usize, max_len: usize) -> Result<Vint> {
    if at >= limit {
        return Err(PreviewError::Corrupt);
    }
    let first = *bytes.get(at).ok_or(PreviewError::Corrupt)?;
    if first == 0 {
        return Err(PreviewError::Corrupt);
    }
    let len = first.leading_zeros() as usize + 1;
    if len > max_len || at.checked_add(len).is_none_or(|end| end > limit) {
        return Err(PreviewError::Corrupt);
    }
    let raw = slice(bytes, at, len)?
        .iter()
        .fold(0u64, |acc, &b| (acc << 8) | u64::from(b));
    let value = raw & ((1u64 << (7 * len)) - 1);
    Ok(Vint { raw, len, value })
}

#[derive(Clone, Copy)]
struct Element {
    id: u32,
    /// Offset of the element's header.
    at: usize,
    start: usize,
    end: usize,
}

/// Reads the element header at `at`. Only Segment and Cluster may have an unknown size or run past `limit`
/// (a prefix of a file ends in the middle of them); any other element must fit.
fn element(bytes: &[u8], at: usize, limit: usize) -> Result<Element> {
    let id = vint(bytes, at, limit, 4)?;
    let size_at = at.checked_add(id.len).ok_or(PreviewError::Corrupt)?;
    let size = vint(bytes, size_at, limit, 8)?;
    let start = size_at.checked_add(size.len).ok_or(PreviewError::Corrupt)?;
    let id = u32::try_from(id.raw).map_err(|_| PreviewError::Corrupt)?;
    let streaming = id == SEGMENT || id == CLUSTER;
    let end = if size.value == (1u64 << (7 * size.len)) - 1 {
        if !streaming {
            return Err(PreviewError::Corrupt);
        }
        limit
    } else {
        let declared = usize::try_from(size.value).map_err(|_| PreviewError::Corrupt)?;
        let end = start.checked_add(declared).ok_or(PreviewError::Corrupt)?;
        if end <= limit {
            end
        } else if streaming {
            limit
        } else {
            return Err(PreviewError::Corrupt);
        }
    };
    Ok(Element { id, at, start, end })
}

/// The child elements of one master element, read one header at a time.
struct Children<'a> {
    bytes: &'a [u8],
    at: usize,
    end: usize,
}

impl<'a> Children<'a> {
    fn of(bytes: &'a [u8], parent: Element) -> Self {
        Children { bytes, at: parent.start, end: parent.end }
    }

    fn next_child(&mut self, budget: &mut Budget) -> Result<Option<Element>> {
        if self.at >= self.end {
            return Ok(None);
        }
        budget.spend(1)?;
        let el = element(self.bytes, self.at, self.end)?;
        self.at = el.end;
        Ok(Some(el))
    }

    /// Continues from an earlier child header (a Cluster found inside an unknown-size Cluster).
    fn seek(&mut self, at: usize) {
        self.at = at;
    }
}

/// A big-endian unsigned integer of up to 8 bytes; an empty body is 0.
fn uint(body: &[u8]) -> Option<u64> {
    if body.len() > 8 {
        return None;
    }
    Some(body.iter().fold(0, |acc, &b| (acc << 8) | u64::from(b)))
}

fn float(body: &[u8]) -> Option<f64> {
    match body.len() {
        4 => <[u8; 4]>::try_from(body).ok().map(|b| f64::from(f32::from_be_bytes(b))),
        8 => <[u8; 8]>::try_from(body).ok().map(f64::from_be_bytes),
        _ => None,
    }
}

fn matroska(bytes: &[u8], budget: &mut Budget) -> Result<Keyframe> {
    let mut top = Children { bytes, at: 0, end: bytes.len() };
    while let Some(el) = top.next_child(budget)? {
        match el.id {
            EBML_HEADER => check_doc_type(bytes, el, budget)?,
            SEGMENT => return segment(bytes, el, budget),
            _ => {}
        }
    }
    Err(PreviewError::Corrupt)
}

fn check_doc_type(bytes: &[u8], header: Element, budget: &mut Budget) -> Result<()> {
    let mut kids = Children::of(bytes, header);
    while let Some(el) = kids.next_child(budget)? {
        if el.id == DOC_TYPE {
            let name = bytes.get(el.start..el.end).ok_or(PreviewError::Corrupt)?;
            if !(name.starts_with(b"matroska") || name.starts_with(b"webm")) {
                return Err(PreviewError::Unsupported);
            }
        }
    }
    Ok(())
}

struct Info {
    scale: u64,
    duration: Option<f64>,
}

impl Info {
    /// The duration counts timestamp-scale ticks (nanoseconds each), so ms = duration * scale / 1e6.
    fn duration_ms(&self) -> Option<u64> {
        let ms = self.duration? * self.scale as f64 / 1_000_000.0;
        (ms.is_finite() && ms >= 0.0).then(|| ms.round() as u64)
    }
}

/// A video track: its number, codec ID, CodecPrivate and pixel size.
struct Track<'a> {
    number: u64,
    codec: &'a [u8],
    private: Option<&'a [u8]>,
    width: u64,
    height: u64,
}

/// Where the reading of a Segment's clusters goes next.
enum Step {
    Found(Range<usize>),
    Next(usize),
}

fn segment(bytes: &[u8], seg: Element, budget: &mut Budget) -> Result<Keyframe> {
    let mut kids = Children::of(bytes, seg);
    let mut info = Info { scale: DEFAULT_TIMESTAMP_SCALE, duration: None };
    let mut video: Option<Track> = None;
    while let Some(el) = kids.next_child(budget)? {
        match el.id {
            INFO => info = info_of(bytes, el, budget)?,
            TRACKS => {
                video = Some(first_video_track(bytes, el, budget)?.ok_or(PreviewError::Unsupported)?);
            }
            CLUSTER => {
                let track = video.as_ref().ok_or(PreviewError::Corrupt)?;
                match cluster(bytes, el, track.number, budget)? {
                    Step::Found(frame) => return keyframe(bytes, track, &info, frame),
                    Step::Next(at) => kids.seek(at),
                }
            }
            _ => {}
        }
    }
    Err(PreviewError::Corrupt)
}

fn info_of(bytes: &[u8], info_el: Element, budget: &mut Budget) -> Result<Info> {
    let mut info = Info { scale: DEFAULT_TIMESTAMP_SCALE, duration: None };
    let mut kids = Children::of(bytes, info_el);
    while let Some(el) = kids.next_child(budget)? {
        let body = bytes.get(el.start..el.end).ok_or(PreviewError::Corrupt)?;
        match el.id {
            TIMESTAMP_SCALE => info.scale = uint(body).filter(|&s| s > 0).ok_or(PreviewError::Corrupt)?,
            DURATION => info.duration = float(body),
            _ => {}
        }
    }
    Ok(info)
}

fn first_video_track<'a>(bytes: &'a [u8], tracks: Element, budget: &mut Budget) -> Result<Option<Track<'a>>> {
    let mut kids = Children::of(bytes, tracks);
    while let Some(el) = kids.next_child(budget)? {
        if el.id == TRACK_ENTRY && let Some(track) = track_entry(bytes, el, budget)? {
            return Ok(Some(track));
        }
    }
    Ok(None)
}

fn track_entry<'a>(bytes: &'a [u8], entry: Element, budget: &mut Budget) -> Result<Option<Track<'a>>> {
    let mut kids = Children::of(bytes, entry);
    let mut number = 0;
    let mut kind = 0;
    let mut codec: &[u8] = &[];
    let mut private = None;
    let mut dims = (0, 0);
    while let Some(el) = kids.next_child(budget)? {
        let body = bytes.get(el.start..el.end).ok_or(PreviewError::Corrupt)?;
        match el.id {
            TRACK_NUMBER => number = uint(body).unwrap_or(0),
            TRACK_TYPE => kind = uint(body).unwrap_or(0),
            CODEC_ID => codec = body,
            CODEC_PRIVATE => {
                if body.len() > MAX_CODEC_PRIVATE {
                    return Err(PreviewError::Corrupt);
                }
                private = Some(body);
            }
            VIDEO => dims = video_size(bytes, el, budget)?,
            _ => {}
        }
    }
    if kind != VIDEO_TRACK || number == 0 {
        return Ok(None);
    }
    Ok(Some(Track { number, codec, private, width: dims.0, height: dims.1 }))
}

fn video_size(bytes: &[u8], video: Element, budget: &mut Budget) -> Result<(u64, u64)> {
    let mut dims = (0, 0);
    let mut kids = Children::of(bytes, video);
    while let Some(el) = kids.next_child(budget)? {
        let body = bytes.get(el.start..el.end).ok_or(PreviewError::Corrupt)?;
        match el.id {
            PIXEL_WIDTH => dims.0 = uint(body).unwrap_or(0),
            PIXEL_HEIGHT => dims.1 = uint(body).unwrap_or(0),
            _ => {}
        }
    }
    Ok(dims)
}

/// Looks for the first keyframe of track `track` in one cluster. A cluster nested in this one (an unknown-size
/// cluster runs until the next one begins) ends the scan and returns the position of that next cluster.
fn cluster(bytes: &[u8], cl: Element, track: u64, budget: &mut Budget) -> Result<Step> {
    let mut kids = Children::of(bytes, cl);
    while let Some(el) = kids.next_child(budget)? {
        match el.id {
            CLUSTER => return Ok(Step::Next(el.at)),
            SIMPLE_BLOCK => {
                if let Some((flags, frame)) = block(bytes, el, track)?
                    && flags & KEYFRAME_FLAG != 0
                {
                    return Ok(Step::Found(frame));
                }
            }
            BLOCK_GROUP => {
                if let Some(frame) = block_group(bytes, el, track, budget)? {
                    return Ok(Step::Found(frame));
                }
            }
            _ => {}
        }
    }
    Ok(Step::Next(cl.end))
}

/// A Block in a BlockGroup is a keyframe when the group has no ReferenceBlock.
fn block_group(bytes: &[u8], group: Element, track: u64, budget: &mut Budget) -> Result<Option<Range<usize>>> {
    let mut kids = Children::of(bytes, group);
    let mut block_el = None;
    let mut has_reference = false;
    while let Some(el) = kids.next_child(budget)? {
        match el.id {
            BLOCK => block_el = Some(el),
            REFERENCE_BLOCK => has_reference = true,
            _ => {}
        }
    }
    match block_el {
        Some(el) if !has_reference => Ok(block(bytes, el, track)?.map(|(_, frame)| frame)),
        _ => Ok(None),
    }
}

/// The flags and frame range of a (Simple)Block of `track`; None for another track or a laced block.
fn block(bytes: &[u8], el: Element, track: u64) -> Result<Option<(u8, Range<usize>)>> {
    let body = bytes.get(el.start..el.end).ok_or(PreviewError::Corrupt)?;
    let number = vint(body, 0, body.len(), 8)?;
    if number.value != track {
        return Ok(None);
    }
    // after the track number: 2 bytes of timecode, then the flags
    let [_, _, flags, ..] = body.get(number.len..).ok_or(PreviewError::Corrupt)? else {
        return Err(PreviewError::Corrupt);
    };
    if *flags & LACING_MASK != 0 {
        return Ok(None);
    }
    let data_at = el.start.checked_add(number.len + 3).ok_or(PreviewError::Corrupt)?;
    Ok(Some((*flags, data_at..el.end)))
}

fn keyframe(bytes: &[u8], track: &Track, info: &Info, frame: Range<usize>) -> Result<Keyframe> {
    let (codec, description) = matroska_codec(track)?;
    Ok(Keyframe {
        codec,
        description,
        width: dimension(track.width)?,
        height: dimension(track.height)?,
        data: frame_bytes(bytes, frame)?,
        duration_ms: info.duration_ms(),
    })
}

fn matroska_codec(track: &Track) -> Result<(String, Option<Vec<u8>>)> {
    match track.codec {
        b"V_MPEG4/ISO/AVC" => {
            let config = track.private.ok_or(PreviewError::Corrupt)?;
            Ok((avc_codec(config)?, Some(config.to_vec())))
        }
        b"V_VP8" => Ok(("vp8".to_string(), None)),
        b"V_VP9" => Ok((vp9_codec(track.private)?, None)),
        b"V_AV1" => {
            let config = track.private.ok_or(PreviewError::Corrupt)?;
            Ok((av1_codec(config)?, Some(config.to_vec())))
        }
        _ => Err(PreviewError::Unsupported),
    }
}

/// "avc1.PPCCLL" from the avcC bytes: version, profile_idc, constraint flags, level_idc.
fn avc_codec(config: &[u8]) -> Result<String> {
    let [_, profile, compat, level, ..] = config else {
        return Err(PreviewError::Corrupt);
    };
    Ok(format!("avc1.{profile:02X}{compat:02X}{level:02X}"))
}

/// "vp09.PP.LL.DD" from the VP9 CodecPrivate (ID/size/value triples); the defaults are profile 0, level 1.0, 8 bits.
fn vp9_codec(private: Option<&[u8]>) -> Result<String> {
    let (mut profile, mut level, mut depth) = (0u8, 10u8, 8u8);
    let mut budget = Budget::new(BUDGET);
    let mut rest = private.unwrap_or_default();
    while let [id, len, tail @ ..] = rest {
        budget.spend(1)?;
        let (value, next) = tail.split_at_checked(usize::from(*len)).ok_or(PreviewError::Corrupt)?;
        if let Some(&v) = value.first() {
            match *id {
                1 => profile = v,
                2 => level = v,
                3 => depth = v,
                _ => {}
            }
        }
        rest = next;
    }
    Ok(format!("vp09.{profile:02}.{level:02}.{depth:02}"))
}

/// "av01.P.LLT.DD" from the av1C box: profile and level in byte 1, tier and depth flags in byte 2.
fn av1_codec(config: &[u8]) -> Result<String> {
    let &[marker, seq, flags, ..] = config else {
        return Err(PreviewError::Corrupt);
    };
    if marker & 0x80 == 0 {
        return Err(PreviewError::Corrupt);
    }
    let profile = seq >> 5;
    let level = seq & 0x1F;
    let tier = if flags & 0x80 != 0 { 'H' } else { 'M' };
    let depth = if flags & 0x40 == 0 {
        8
    } else if flags & 0x20 != 0 {
        12
    } else {
        10
    };
    Ok(format!("av01.{profile}.{level:02}{tier}.{depth:02}"))
}

fn dimension(value: u64) -> Result<u32> {
    if value == 0 || value > MAX_DIMENSION {
        return Err(PreviewError::Unsupported);
    }
    u32::try_from(value).map_err(|_| PreviewError::Unsupported)
}

fn frame_bytes(bytes: &[u8], frame: Range<usize>) -> Result<Vec<u8>> {
    let data = bytes.get(frame).ok_or(PreviewError::Corrupt)?;
    if data.is_empty() {
        return Err(PreviewError::Corrupt);
    }
    if data.len() > MAX_BLOB {
        return Err(PreviewError::TooLarge);
    }
    Ok(data.to_vec())
}

// AVI (RIFF): chunks are FourCC + u32 size + data, padded to an even length; LIST chunks hold a type and chunks.

#[derive(Clone, Copy)]
struct Chunk {
    id: [u8; 4],
    start: usize,
    end: usize,
    next: usize,
}

fn data_len(c: Chunk) -> usize {
    c.end.saturating_sub(c.start)
}

/// A chunk at `at`. A LIST may run past `limit` (a prefix of a file ends in it); any other chunk must fit.
fn chunk(bytes: &[u8], at: usize, limit: usize) -> Result<Chunk> {
    let id = fourcc(bytes, at)?;
    let size = usize::try_from(u32_le(bytes, at.checked_add(4).ok_or(PreviewError::Corrupt)?)?)
        .map_err(|_| PreviewError::Corrupt)?;
    let start = at.checked_add(8).ok_or(PreviewError::Corrupt)?;
    if start > limit {
        return Err(PreviewError::Corrupt);
    }
    let declared = start.checked_add(size).ok_or(PreviewError::Corrupt)?;
    let end = if declared <= limit {
        declared
    } else if &id == b"LIST" {
        limit
    } else {
        return Err(PreviewError::Corrupt);
    };
    let next = end.checked_add(size & 1).ok_or(PreviewError::Corrupt)?;
    Ok(Chunk { id, start, end, next })
}

fn fourcc(bytes: &[u8], at: usize) -> Result<[u8; 4]> {
    <[u8; 4]>::try_from(slice(bytes, at, 4)?).map_err(|_| PreviewError::Corrupt)
}

/// The type of a LIST chunk, and the offset where its child chunks start.
fn list_parts(bytes: &[u8], list: Chunk) -> Result<([u8; 4], usize)> {
    let children = list.start.checked_add(4).ok_or(PreviewError::Corrupt)?;
    if children > list.end {
        return Err(PreviewError::Corrupt);
    }
    Ok((fourcc(bytes, list.start)?, children))
}

#[derive(Clone, Copy)]
struct VideoStream {
    index: usize,
    width: u64,
    height: u64,
    fourcc: [u8; 4],
}

struct AviHeader {
    frame_us: u64,
    frames: u64,
    video: Option<VideoStream>,
}

impl AviHeader {
    fn duration_ms(&self) -> Option<u64> {
        if self.frame_us == 0 || self.frames == 0 {
            None
        } else {
            Some(self.frames * self.frame_us / 1000)
        }
    }
}

fn avi(bytes: &[u8], budget: &mut Budget) -> Result<Keyframe> {
    let riff_end = usize::try_from(u64::from(u32_le(bytes, 4)?) + 8)
        .unwrap_or(usize::MAX)
        .min(bytes.len());
    let mut hdrl = None;
    let mut movi = None;
    let mut idx1 = None;
    let mut at = RIFF_HEADER;
    while at < riff_end {
        budget.spend(1)?;
        let c = chunk(bytes, at, riff_end)?;
        at = c.next;
        match &c.id {
            b"LIST" => match &list_parts(bytes, c)?.0 {
                b"hdrl" => hdrl = Some(c),
                b"movi" => movi = Some(c),
                _ => {}
            },
            b"idx1" => idx1 = Some(c),
            _ => {}
        }
    }
    let header = avi_header(bytes, hdrl.ok_or(PreviewError::Corrupt)?, budget)?;
    let video = header.video.ok_or(PreviewError::Unsupported)?;
    let codec = match &video.fourcc {
        b"H264" | b"h264" | b"X264" | b"x264" | b"avc1" => AviCodec::Avc,
        b"MJPG" | b"mjpg" => AviCodec::Mjpeg,
        _ => return Err(PreviewError::Unsupported),
    };
    let tag = stream_tag(video.index).ok_or(PreviewError::Unsupported)?;
    let wanted = match idx1 {
        Some(index) => keyframe_ordinal(bytes, index, tag, budget)?,
        None => 0,
    };
    let movi = movi.ok_or(PreviewError::Corrupt)?;
    let (_, children) = list_parts(bytes, movi)?;
    let mut pick = Pick { tag, wanted, seen: 0 };
    let frame = find_frame(bytes, children, movi.end, &mut pick, 0, budget)?.ok_or(PreviewError::Corrupt)?;
    let data = frame_bytes(bytes, frame)?;
    let (codec, data) = match codec {
        AviCodec::Avc => (avc_from_annexb(&data)?, data),
        AviCodec::Mjpeg => ("mjpeg".to_string(), add_huffman_tables(&data)?),
    };
    Ok(Keyframe {
        codec,
        description: None,
        width: dimension(video.width)?,
        height: dimension(video.height)?,
        data,
        duration_ms: header.duration_ms(),
    })
}

enum AviCodec {
    Avc,
    Mjpeg,
}

fn avi_header(bytes: &[u8], hdrl: Chunk, budget: &mut Budget) -> Result<AviHeader> {
    let (_, mut at) = list_parts(bytes, hdrl)?;
    let mut header = AviHeader { frame_us: 0, frames: 0, video: None };
    let mut streams = 0;
    while at < hdrl.end {
        budget.spend(1)?;
        let c = chunk(bytes, at, hdrl.end)?;
        at = c.next;
        match &c.id {
            b"avih" => {
                if data_len(c) < 20 {
                    return Err(PreviewError::Corrupt);
                }
                header.frame_us = u64::from(u32_le(bytes, c.start)?);
                header.frames = u64::from(u32_le(bytes, c.start + 16)?);
            }
            b"LIST" => {
                let (kind, children) = list_parts(bytes, c)?;
                if &kind == b"strl" {
                    if header.video.is_none() {
                        header.video = video_stream(bytes, children, c.end, streams, budget)?;
                    }
                    streams += 1;
                }
            }
            _ => {}
        }
    }
    Ok(header)
}

/// The video stream described by one strl list (`index` is its position among the streams).
fn video_stream(
    bytes: &[u8],
    mut at: usize,
    end: usize,
    index: usize,
    budget: &mut Budget,
) -> Result<Option<VideoStream>> {
    let mut is_video = false;
    let mut format = None;
    while at < end {
        budget.spend(1)?;
        let c = chunk(bytes, at, end)?;
        at = c.next;
        match &c.id {
            b"strh" => {
                if data_len(c) < 4 {
                    return Err(PreviewError::Corrupt);
                }
                is_video = slice(bytes, c.start, 4)? == &b"vids"[..];
            }
            b"strf" => format = Some(c),
            _ => {}
        }
    }
    if !is_video {
        return Ok(None);
    }
    let format = format.ok_or(PreviewError::Corrupt)?;
    if data_len(format) < 20 {
        return Err(PreviewError::Corrupt);
    }
    // BITMAPINFOHEADER: biWidth, biHeight (signed; the sign gives the row order), biCompression
    let width = u64::from((u32_le(bytes, format.start + 4)? as i32).unsigned_abs());
    let height = u64::from((u32_le(bytes, format.start + 8)? as i32).unsigned_abs());
    Ok(Some(VideoStream { index, width, height, fourcc: fourcc(bytes, format.start + 16)? }))
}

fn stream_tag(index: usize) -> Option<[u8; 2]> {
    if index > 99 {
        return None;
    }
    Some([b'0' + (index / 10) as u8, b'0' + (index % 10) as u8])
}

/// True for the chunks of one stream: "NNdc" (compressed) and "NNdb" (uncompressed).
fn is_stream_chunk(id: [u8; 4], tag: [u8; 2]) -> bool {
    let [a, b, c, d] = id;
    let [t0, t1] = tag;
    a == t0 && b == t1 && c == b'd' && (d == b'c' || d == b'b')
}

/// The position among one stream's non-empty chunks of the first keyframe, from idx1 (16-byte entries:
/// ckid, flags, offset, size). The k-th such chunk in movi is the k-th entry of that stream in idx1.
fn keyframe_ordinal(bytes: &[u8], index: Chunk, tag: [u8; 2], budget: &mut Budget) -> Result<usize> {
    let mut ordinal = 0;
    let mut at = index.start;
    while at.checked_add(INDEX_ENTRY).is_some_and(|end| end <= index.end) {
        budget.spend(1)?;
        let entry_id = fourcc(bytes, at)?;
        let flags = u32_le(bytes, at + 4)?;
        let size = u32_le(bytes, at + 12)?;
        if is_stream_chunk(entry_id, tag) && size != 0 {
            if flags & AVIIF_KEYFRAME != 0 {
                return Ok(ordinal);
            }
            ordinal += 1;
        }
        at += INDEX_ENTRY;
    }
    Err(PreviewError::Corrupt)
}

/// What `find_frame` looks for: the stream's chunks, and how many of them to pass first.
struct Pick {
    tag: [u8; 2],
    wanted: usize,
    seen: usize,
}

/// The frame chunk of the stream: the `wanted`-th non-empty chunk, looking inside "rec " lists too.
fn find_frame(
    bytes: &[u8],
    mut at: usize,
    end: usize,
    pick: &mut Pick,
    depth: usize,
    budget: &mut Budget,
) -> Result<Option<Range<usize>>> {
    if depth > MAX_DEPTH {
        return Err(PreviewError::Corrupt);
    }
    while at < end {
        budget.spend(1)?;
        let c = chunk(bytes, at, end)?;
        at = c.next;
        if &c.id == b"LIST" {
            let (kind, children) = list_parts(bytes, c)?;
            if &kind == b"rec "
                && let Some(frame) = find_frame(bytes, children, c.end, pick, depth + 1, budget)?
            {
                return Ok(Some(frame));
            }
        } else if is_stream_chunk(c.id, pick.tag) && data_len(c) > 0 {
            if pick.seen == pick.wanted {
                return Ok(Some(c.start..c.end));
            }
            pick.seen += 1;
        }
    }
    Ok(None)
}

/// "avc1.PPCCLL" from the first SPS NAL unit (type 7) of an Annex B frame: profile, constraints, level.
fn avc_from_annexb(data: &[u8]) -> Result<String> {
    let mut budget = Budget::new(BUDGET);
    let mut at = 0;
    loop {
        let tail = data.get(at..).unwrap_or_default();
        let rel = tail.windows(3).position(|w| matches!(w, [0, 0, 1])).ok_or(PreviewError::Corrupt)?;
        budget.spend(rel + 1)?;
        let start = at + rel + 3;
        if let [header, profile, compat, level, ..] = data.get(start..).unwrap_or_default()
            && *header & 0x1F == 7
        {
            return Ok(format!("avc1.{profile:02X}{compat:02X}{level:02X}"));
        }
        at = start;
    }
}

/// Standard Huffman tables (ITU-T T.81 Annex K) for an MJPEG frame that has none.
/// Motion JPEG from some encoders has no DHT, and a browser cannot decode such a frame.
/// Returns the frame unchanged when it has its own tables.
fn add_huffman_tables(jpeg: &[u8]) -> Result<Vec<u8>> {
    if !jpeg.starts_with(&[0xFF, 0xD8]) {
        return Err(PreviewError::Corrupt);
    }
    let mut budget = Budget::new(BUDGET);
    let mut at = 2;
    let mut has_tables = false;
    loop {
        budget.spend(1)?;
        let [0xFF, marker] = slice(jpeg, at, 2)? else {
            return Err(PreviewError::Corrupt);
        };
        if *marker == 0xDA {
            break;
        }
        let len = usize::from(u16_be(jpeg, at + 2)?);
        if len < 2 {
            return Err(PreviewError::Corrupt);
        }
        has_tables |= *marker == 0xC4;
        at = at.checked_add(2 + len).ok_or(PreviewError::Corrupt)?;
    }
    if has_tables {
        return Ok(jpeg.to_vec());
    }
    let out_len = jpeg.len().checked_add(huffman_tables().len()).ok_or(PreviewError::TooLarge)?;
    if out_len > MAX_BLOB {
        return Err(PreviewError::TooLarge);
    }
    let mut out = jpeg.get(..at).ok_or(PreviewError::Corrupt)?.to_vec();
    out.extend_from_slice(&huffman_tables());
    out.extend_from_slice(jpeg.get(at..).ok_or(PreviewError::Corrupt)?);
    Ok(out)
}

fn u16_be(bytes: &[u8], at: usize) -> Result<u16> {
    Ok(u16::from_be_bytes(<[u8; 2]>::try_from(slice(bytes, at, 2)?).map_err(|_| PreviewError::Corrupt)?))
}

/// One DHT segment with the four standard tables: DC luma, AC luma, DC chroma, AC chroma.
fn huffman_tables() -> Vec<u8> {
    let mut out = vec![0xFF, 0xC4, 0x01, 0xA2];
    let tables: [(u8, &[u8], &[u8]); 4] = [
        (0x00, &DC_LUMA_BITS, &DC_LUMA_VALS),
        (0x10, &AC_LUMA_BITS, &AC_LUMA_VALS),
        (0x01, &DC_CHROMA_BITS, &DC_CHROMA_VALS),
        (0x11, &AC_CHROMA_BITS, &AC_CHROMA_VALS),
    ];
    for (class, bits, values) in tables {
        out.push(class);
        out.extend_from_slice(bits);
        out.extend_from_slice(values);
    }
    out
}

const DC_LUMA_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS: [u8; 12] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
];
const AC_LUMA_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125];
const AC_LUMA_VALS: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const DC_CHROMA_BITS: [u8; 16] = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS: [u8; 12] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
];
const AC_CHROMA_BITS: [u8; 16] = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119];
const AC_CHROMA_VALS: [u8; 162] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41,
    0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1,
    0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
    0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a,
    0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
    0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

#[cfg(test)]
#[path = "video_tests.rs"]
mod video_tests;

