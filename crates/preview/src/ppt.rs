//! Old PowerPoint files (`.ppt`, PowerPoint 97-2003): the title, texts and pictures of each slide (docs/PODGLAD.md §2.1).
//! Spec: MS-PPT (records, persist directory, slides) and MS-ODRAW (pictures in the BStore).

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::cfbx::read_stream;
use crate::{check_input, slice, u16_le, u32_le, Budget, PreviewError, Result, MAX_BLOB, MAX_DEPTH, MAX_INPUT, MAX_SLIDES};

/// Work one file may cost, in records, entries and characters (see `Budget`).
const BUDGET: usize = 2_000_000;
/// Edits in the `offsetLastEdit` chain. Longer chains are not files PowerPoint writes.
const MAX_EDITS: usize = 64;
const MAX_PICTURES: usize = 500;
/// All pictures of one file together.
const MAX_PICTURES_BYTES: usize = 64 << 20;

const CURRENT_USER_ATOM: u16 = 0x0FF6;
const USER_EDIT_ATOM: u16 = 0x0FF5;
const PERSIST_DIRECTORY_ATOM: u16 = 0x1772;
const DOCUMENT: u16 = 0x03E8;
const SLIDE: u16 = 0x03EE;
const SLIDE_LIST_WITH_TEXT: u16 = 0x0FF0;
const SLIDE_PERSIST_ATOM: u16 = 0x03F3;
const TEXT_HEADER_ATOM: u16 = 0x0F9F;
const TEXT_CHARS_ATOM: u16 = 0x0FA0;
const TEXT_BYTES_ATOM: u16 = 0x0FA8;
const PP_DRAWING_GROUP: u16 = 0x040B;
const FBSE: u16 = 0xF007;
const FOPT: u16 = 0xF00B;
/// Property id of `pib`, the BStore index of a shape's picture (opid without the flag bits).
const PIB: u16 = 0x0104;
const BLIP_JPEG: u16 = 0xF01D;
const BLIP_JPEG_CMYK: u16 = 0xF02A;
const BLIP_PNG: u16 = 0xF01E;
const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// One slide: its title, its other texts, and indices into the picture list of `ppt_slides`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slide {
    pub title: Option<String>,
    pub texts: Vec<String>,
    pub pictures: Vec<usize>,
}

/// A picture the slides refer to: JPEG or PNG bytes, as stored in the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picture {
    pub mime: &'static str,
    pub data: Vec<u8>,
}

/// The slides and pictures of a presentation, for the frame.
#[wasm_bindgen]
pub struct PptJs {
    slides: Vec<Slide>,
    pictures: Vec<Picture>,
}

#[wasm_bindgen]
impl PptJs {
    /// `{"slides":[{"title":…|null,"texts":[…],"pictures":[0,2]}]}`
    pub fn slides_json(&self) -> String {
        let slides: Vec<serde_json::Value> =
            self.slides.iter().map(|s| json!({"title": s.title, "texts": s.texts, "pictures": s.pictures})).collect();
        json!({"slides": slides}).to_string()
    }

    pub fn picture_count(&self) -> usize {
        self.pictures.len()
    }

    pub fn picture_mime(&self, i: usize) -> String {
        self.pictures.get(i).map(|p| p.mime.to_string()).unwrap_or_default()
    }

    pub fn picture(&self, i: usize) -> Vec<u8> {
        self.pictures.get(i).map(|p| p.data.clone()).unwrap_or_default()
    }
}

/// The slides of a `.ppt` file and the pictures they use.
pub fn ppt_slides(bytes: &[u8]) -> Result<(Vec<Slide>, Vec<Picture>)> {
    check_input(bytes)?;
    if read_stream(bytes, "EncryptedSummary", MAX_INPUT)?.is_some() {
        return Err(PreviewError::Unsupported);
    }
    let user = read_stream(bytes, "Current User", MAX_INPUT)?.ok_or(PreviewError::Corrupt)?;
    let ppt = read_stream(bytes, "PowerPoint Document", MAX_INPUT)?.ok_or(PreviewError::Corrupt)?;
    let pictures_stream = read_stream(bytes, "Pictures", MAX_INPUT)?;
    let mut budget = Budget::new(BUDGET);

    let current = record_at(&user, 0)?;
    if current.typ != CURRENT_USER_ATOM {
        return Err(PreviewError::Corrupt);
    }
    let edit = u32_le(current.body, 8)? as usize;

    let (persist, doc_id) = persist_table(&ppt, edit, &mut budget)?;
    let doc_at = *persist.get(&doc_id).ok_or(PreviewError::Corrupt)?;
    let doc = record_at(&ppt, doc_at)?;
    if doc.typ != DOCUMENT {
        return Err(PreviewError::Corrupt);
    }

    let listed = slide_list(doc.body, &mut budget)?;
    if listed.len() > MAX_SLIDES {
        return Err(PreviewError::TooLarge);
    }

    let mut groups = Vec::new();
    find(doc.body, PP_DRAWING_GROUP, 0, &mut budget, &mut groups)?;
    let mut fbse = Vec::new();
    for group in groups {
        find(group.body, FBSE, 0, &mut budget, &mut fbse)?;
    }
    // foDelay: where the picture starts in the Pictures stream
    let store: Vec<Option<u32>> = fbse.iter().map(|e| u32_le(e.body, 28).ok()).collect();

    let mut images = Images { stream: pictures_stream, store, seen: BTreeMap::new(), pictures: Vec::new(), total: 0 };
    let mut slides = Vec::new();
    let mut used = BTreeSet::new();
    for listed_slide in listed {
        let at = *persist.get(&listed_slide.persist).ok_or(PreviewError::Corrupt)?;
        let container = record_at(&ppt, at)?;
        if container.typ != SLIDE {
            return Err(PreviewError::Corrupt);
        }
        let mut parts = SlideParts::default();
        walk_slide(container.body, 0, &mut budget, &mut parts)?;

        // the list's texts come first, so the title is the list's title and drawing texts repeat nothing
        let mut seen = HashSet::new();
        let mut title = None;
        let mut texts = Vec::new();
        let all = listed_slide.texts.into_iter().chain(parts.texts.into_iter().map(|t| (t, false)));
        for (text, is_title) in all {
            budget.spend(1)?;
            if text.trim().is_empty() || !seen.insert(text.clone()) {
                continue;
            }
            if is_title && title.is_none() {
                title = Some(text);
            } else {
                texts.push(text);
            }
        }

        let mut pictures = Vec::new();
        for pib in parts.pibs {
            let picture = match (pib as usize).checked_sub(1) {
                Some(entry) => images.entry(entry, &mut budget)?,
                None => None,
            };
            if let Some(i) = picture {
                used.insert(i);
                if !pictures.contains(&i) {
                    pictures.push(i);
                }
            }
        }
        slides.push(Slide { title, texts, pictures });
    }

    // a picture in the store that no slide refers to is kept on the last slide: its slide cannot be known
    if let Some(last) = slides.last_mut() {
        for entry in 0..images.store.len() {
            if let Some(i) = images.entry(entry, &mut budget)? && used.insert(i) {
                last.pictures.push(i);
            }
        }
    }
    Ok((slides, images.pictures))
}

#[wasm_bindgen(js_name = pptSlides)]
pub fn ppt_slides_js(bytes: &[u8]) -> std::result::Result<PptJs, JsError> {
    match ppt_slides(bytes) {
        Ok((slides, pictures)) => Ok(PptJs { slides, pictures }),
        Err(err) => Err(JsError::new(err.code())),
    }
}

/// One record: `recVer` (4 bits) and `recInstance` (12 bits) in the first 2 bytes, `recType`, `recLen`, then the body.
#[derive(Clone, Copy)]
struct Record<'a> {
    ver: u16,
    instance: u16,
    typ: u16,
    body: &'a [u8],
}

impl Record<'_> {
    /// A container holds records; an atom holds data.
    fn is_container(&self) -> bool {
        self.ver == 0xF
    }
}

fn record_at(data: &[u8], at: usize) -> Result<Record<'_>> {
    let head = slice(data, at, 8)?;
    let ver_instance = u16_le(head, 0)?;
    let typ = u16_le(head, 2)?;
    let len = u32_le(head, 4)? as usize;
    let body_at = at.checked_add(8).ok_or(PreviewError::Corrupt)?;
    Ok(Record { ver: ver_instance & 0xF, instance: ver_instance >> 4, typ, body: slice(data, body_at, len)? })
}

/// The records one after another. An error ends the iteration.
struct Records<'a> {
    data: &'a [u8],
    at: usize,
    failed: bool,
}

impl<'a> Iterator for Records<'a> {
    type Item = Result<Record<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.at >= self.data.len() {
            return None;
        }
        match record_at(self.data, self.at) {
            Ok(rec) => {
                self.at += 8 + rec.body.len();
                Some(Ok(rec))
            }
            Err(err) => {
                self.failed = true;
                Some(Err(err))
            }
        }
    }
}

fn records(data: &[u8]) -> Records<'_> {
    Records { data, at: 0, failed: false }
}

/// Every record of type `typ` below `data`, in file order.
fn find<'a>(data: &'a [u8], typ: u16, depth: usize, budget: &mut Budget, out: &mut Vec<Record<'a>>) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(PreviewError::Corrupt);
    }
    for rec in records(data) {
        let rec = rec?;
        budget.spend(1)?;
        if rec.typ == typ {
            out.push(rec);
        }
        if rec.is_container() {
            find(rec.body, typ, depth + 1, budget, out)?;
        }
    }
    Ok(())
}

/// Persist ids → offsets in the PowerPoint Document stream, read from the current edit and the edits before it.
/// The newest edit wins, so an id is taken from the first edit that lists it. Also returns the document's persist id.
fn persist_table(ppt: &[u8], edit: usize, budget: &mut Budget) -> Result<(BTreeMap<u32, usize>, u32)> {
    let mut table = BTreeMap::new();
    let mut doc_id = None;
    let mut at = edit;
    for _ in 0..MAX_EDITS {
        budget.spend(1)?;
        let rec = record_at(ppt, at)?;
        if rec.typ != USER_EDIT_ATOM {
            return Err(PreviewError::Corrupt);
        }
        let body = rec.body;
        // encryptSessionPersistIdRef: a file encrypted with CryptSession10Container names it here
        if body.len() >= 32 && u32_le(body, 28)? != 0 {
            return Err(PreviewError::Unsupported);
        }
        let last_edit = u32_le(body, 8)? as usize;
        let directory = u32_le(body, 12)? as usize;
        if doc_id.is_none() {
            doc_id = Some(u32_le(body, 16)?);
        }
        persist_directory(ppt, directory, &mut table, budget)?;
        if last_edit == 0 {
            return Ok((table, doc_id.ok_or(PreviewError::Corrupt)?));
        }
        // earlier edits lie before later ones; a pointer that does not go back could loop
        if last_edit >= at {
            return Err(PreviewError::Corrupt);
        }
        at = last_edit;
    }
    Err(PreviewError::Corrupt)
}

fn persist_directory(ppt: &[u8], at: usize, table: &mut BTreeMap<u32, usize>, budget: &mut Budget) -> Result<()> {
    let rec = record_at(ppt, at)?;
    if rec.typ != PERSIST_DIRECTORY_ATOM {
        return Err(PreviewError::Corrupt);
    }
    let body = rec.body;
    let mut p = 0usize;
    while p < body.len() {
        budget.spend(1)?;
        let head = u32_le(body, p)?;
        let first = head & 0xF_FFFF;
        let count = head >> 20;
        p += 4;
        for i in 0..count {
            budget.spend(1)?;
            let offset = u32_le(body, p)? as usize;
            p += 4;
            table.entry(first + i).or_insert(offset);
        }
    }
    Ok(())
}

/// A slide of the slide list, with its texts; the flag marks a title text (TextHeaderAtom type 0 or 6).
struct ListedSlide {
    persist: u32,
    texts: Vec<(String, bool)>,
}

fn slide_list(doc: &[u8], budget: &mut Budget) -> Result<Vec<ListedSlide>> {
    let mut slides: Vec<ListedSlide> = Vec::new();
    let mut header = None;
    for rec in records(doc) {
        let rec = rec?;
        budget.spend(1)?;
        if rec.typ != SLIDE_LIST_WITH_TEXT || rec.instance != 0 {
            continue;
        }
        for item in records(rec.body) {
            let item = item?;
            budget.spend(1)?;
            match item.typ {
                SLIDE_PERSIST_ATOM => slides.push(ListedSlide { persist: u32_le(item.body, 0)?, texts: Vec::new() }),
                TEXT_HEADER_ATOM => header = Some(u32_le(item.body, 0)?),
                TEXT_CHARS_ATOM | TEXT_BYTES_ATOM => {
                    let text = if item.typ == TEXT_CHARS_ATOM {
                        text_chars(item.body, budget)?
                    } else {
                        text_bytes(item.body, budget)?
                    };
                    let is_title = matches!(header.take(), Some(0 | 6));
                    if let Some(slide) = slides.last_mut() {
                        slide.texts.push((text, is_title));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(slides)
}

/// UTF-16LE text.
fn text_chars(body: &[u8], budget: &mut Budget) -> Result<String> {
    budget.spend(body.len() / 2)?;
    let units: Vec<u16> = body.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
    Ok(clean(&String::from_utf16_lossy(&units)))
}

/// 8-bit text, read as Latin-1.
fn text_bytes(body: &[u8], budget: &mut Budget) -> Result<String> {
    budget.spend(body.len())?;
    Ok(clean(&body.iter().map(|&b| char::from(b)).collect::<String>()))
}

/// `\r` and vertical tab are line breaks inside a text.
fn clean(text: &str) -> String {
    text.replace(['\r', '\u{b}'], "\n").trim_end_matches('\n').to_string()
}

#[derive(Default)]
struct SlideParts {
    texts: Vec<String>,
    /// `pib` values of the slide's shapes, 1-based BStore indices.
    pibs: Vec<u32>,
}

/// The texts and picture references below a SlideContainer, in file order.
fn walk_slide(data: &[u8], depth: usize, budget: &mut Budget, parts: &mut SlideParts) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(PreviewError::Corrupt);
    }
    for rec in records(data) {
        let rec = rec?;
        budget.spend(1)?;
        match rec.typ {
            TEXT_CHARS_ATOM => parts.texts.push(text_chars(rec.body, budget)?),
            TEXT_BYTES_ATOM => parts.texts.push(text_bytes(rec.body, budget)?),
            FOPT => pib_values(rec, &mut parts.pibs, budget)?,
            _ => {}
        }
        if rec.is_container() {
            walk_slide(rec.body, depth + 1, budget, parts)?;
        }
    }
    Ok(())
}

/// The `pib` properties of an OfficeArtFOPT: `recInstance` properties of 6 bytes each (opid, value).
fn pib_values(fopt: Record<'_>, out: &mut Vec<u32>, budget: &mut Budget) -> Result<()> {
    for i in 0..fopt.instance as usize {
        budget.spend(1)?;
        let at = i * 6;
        let opid = u16_le(fopt.body, at)?;
        let value = u32_le(fopt.body, at + 2)?;
        if opid & 0x3FFF == PIB {
            out.push(value);
        }
    }
    Ok(())
}

/// Pictures read from the `Pictures` stream. Each one is copied into `pictures` the first time a slide or the store
/// refers to it; `seen` keeps the result per offset, so a picture shared by slides is stored once.
struct Images {
    stream: Option<Vec<u8>>,
    /// Per BStore entry, the offset of its picture in the `Pictures` stream (if it has one).
    store: Vec<Option<u32>>,
    seen: BTreeMap<u32, Option<usize>>,
    pictures: Vec<Picture>,
    total: usize,
}

impl Images {
    /// The picture of BStore entry `entry` (0-based), if it is a usable JPEG or PNG.
    fn entry(&mut self, entry: usize, budget: &mut Budget) -> Result<Option<usize>> {
        let Some(Some(at)) = self.store.get(entry).copied() else {
            return Ok(None);
        };
        if let Some(known) = self.seen.get(&at) {
            return Ok(*known);
        }
        let found = match &self.stream {
            Some(stream) => blip(stream, at as usize, budget)?,
            None => None,
        };
        let index = match found {
            None => None,
            Some((mime, data)) => {
                if data.len() > MAX_BLOB || self.total + data.len() > MAX_PICTURES_BYTES || self.pictures.len() >= MAX_PICTURES {
                    return Err(PreviewError::TooLarge);
                }
                self.total += data.len();
                self.pictures.push(Picture { mime, data: data.to_vec() });
                Some(self.pictures.len() - 1)
            }
        };
        self.seen.insert(at, index);
        Ok(index)
    }
}

/// The JPEG or PNG file of the blip record at `at`, with its MIME type. `None` for other formats and for records that
/// are broken or are not a picture.
fn blip<'a>(stream: &'a [u8], at: usize, budget: &mut Budget) -> Result<Option<(&'static str, &'a [u8])>> {
    budget.spend(1)?;
    let Ok(rec) = record_at(stream, at) else {
        return Ok(None);
    };
    // the instance tells how many UIDs (16 bytes each) come before the 1-byte tag and the file
    let (mime, uids) = match (rec.typ, rec.instance) {
        (BLIP_JPEG, 0x46A) | (BLIP_JPEG_CMYK, 0x6E2) => ("image/jpeg", 1),
        (BLIP_JPEG, 0x46B) | (BLIP_JPEG_CMYK, 0x6E3) => ("image/jpeg", 2),
        (BLIP_PNG, 0x6E0) => ("image/png", 1),
        (BLIP_PNG, 0x6E1) => ("image/png", 2),
        _ => return Ok(None),
    };
    let Some(file) = rec.body.get(uids * 16 + 1..) else {
        return Ok(None);
    };
    let signed = if mime == "image/png" { file.starts_with(PNG_SIGNATURE) } else { file.starts_with(&[0xFF, 0xD8]) };
    Ok(if signed { Some((mime, file)) } else { None })
}

#[cfg(test)]
#[path = "ppt_tests.rs"]
mod ppt_tests;
