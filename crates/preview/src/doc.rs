//! Old Word documents (.doc, Word 97–2003): the plain text with its paragraphs, table cells and page breaks
//! (docs/PODGLAD.md §2.1, MS-DOC). Formatting is stage 2 and is not read here.

use wasm_bindgen::prelude::*;

use crate::cfbx::read_stream;
use crate::{Budget, MAX_DEPTH, MAX_INPUT, MAX_ITEMS, MAX_TEXT, PreviewError, Result, check_input, slice, u16_le, u32_le};

#[cfg(test)]
#[path = "doc_tests.rs"]
mod doc_tests;

const FIB_IDENT: u16 = 0xA5EC;
/// Word 97 and later; older files use another layout.
const FIB_MIN_NFIB: u16 = 0x00C1;
const FIB_FLAGS_AT: usize = 0x0A;
const FLAG_ENCRYPTED: u16 = 1 << 8;
const FLAG_WHICH_TABLE: u16 = 1 << 9;
/// Index of `fcClx` in FibRgFcLcb97 (entries of fc and lcb, 8 bytes each).
const FC_CLX: usize = 33;
/// Index of `ccpText` in FibRgLw97 (u32 entries).
const CCP_TEXT: usize = 3;
const FC_COMPRESSED: u32 = 0x4000_0000;
const CLX_PRC: u8 = 0x01;
const CLX_PCDT: u8 = 0x02;
/// Steps of work for one document: the text and the paragraphs each take one step per character.
const BUDGET: usize = 4 * MAX_TEXT;

/// Windows-1252 for 0x80–0x9F, as MS-DOC 2.4.1 gives it. The five code points cp1252 leaves undefined map to
/// themselves.
const CP1252_HIGH: [u16; 32] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D,
    0x017D, 0x008F, 0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A,
    0x0153, 0x009D, 0x017E, 0x0178,
];

/// One piece of the text: `len` characters read from the WordDocument stream at byte `at`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Piece {
    pub len: usize,
    pub compressed: bool,
    pub at: usize,
}

/// What a paragraph ends with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParagraphKind {
    Normal,
    Cell,
    PageBreak,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paragraph {
    pub text: String,
    pub kind: ParagraphKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DocModel {
    pub paragraphs: Vec<Paragraph>,
}

pub fn doc_text(bytes: &[u8]) -> Result<DocModel> {
    check_input(bytes)?;
    let word = read_stream(bytes, "WordDocument", MAX_INPUT)?.ok_or(PreviewError::Corrupt)?;
    let fib = Fib::read(&word)?;
    let table_name = if fib.which_table { "1Table" } else { "0Table" };
    let table = read_stream(bytes, table_name, MAX_INPUT)?.ok_or(PreviewError::Corrupt)?;
    let pieces = piece_table(slice(&table, fib.fc_clx, fib.lcb_clx)?)?;
    let mut budget = Budget::new(BUDGET);
    let units = main_text_units(&word, &pieces, fib.ccp_text, &mut budget)?;
    paragraphs(&units, &mut budget)
}

#[wasm_bindgen(js_name = docTextJson)]
pub fn doc_text_json(bytes: &[u8]) -> std::result::Result<String, JsError> {
    let model = doc_text(bytes).map_err(|e| JsError::new(e.code()))?;
    let paragraphs: Vec<serde_json::Value> = model
        .paragraphs
        .iter()
        .map(|p| serde_json::json!({"text": p.text, "kind": kind_name(p.kind)}))
        .collect();
    serde_json::to_string(&serde_json::json!({ "paragraphs": paragraphs }))
        .map_err(|_| JsError::new(PreviewError::Corrupt.code()))
}

fn kind_name(kind: ParagraphKind) -> &'static str {
    match kind {
        ParagraphKind::Normal => "normal",
        ParagraphKind::Cell => "cell",
        ParagraphKind::PageBreak => "page",
    }
}

fn to_usize(v: u32) -> Result<usize> {
    usize::try_from(v).map_err(|_| PreviewError::Corrupt)
}

fn add(a: usize, b: usize) -> Result<usize> {
    a.checked_add(b).ok_or(PreviewError::Corrupt)
}

fn mul(a: usize, b: usize) -> Result<usize> {
    a.checked_mul(b).ok_or(PreviewError::Corrupt)
}

/// The fields of the FIB that locate the text (MS-DOC 2.5).
struct Fib {
    which_table: bool,
    fc_clx: usize,
    lcb_clx: usize,
    ccp_text: usize,
}

impl Fib {
    fn read(word: &[u8]) -> Result<Fib> {
        if u16_le(word, 0)? != FIB_IDENT {
            return Err(PreviewError::Unsupported);
        }
        if u16_le(word, 2)? < FIB_MIN_NFIB {
            return Err(PreviewError::Unsupported);
        }
        let flags = u16_le(word, FIB_FLAGS_AT)?;
        if flags & FLAG_ENCRYPTED != 0 {
            return Err(PreviewError::Unsupported);
        }
        // Each array is preceded by its count, so the offsets follow the file's own layout.
        let csw = usize::from(u16_le(word, 0x20)?);
        let cslw_at = add(0x22, mul(csw, 2)?)?;
        let cslw = usize::from(u16_le(word, cslw_at)?);
        if cslw <= CCP_TEXT {
            return Err(PreviewError::Corrupt);
        }
        let lw = add(cslw_at, 2)?;
        let ccp_text = to_usize(u32_le(word, add(lw, mul(CCP_TEXT, 4)?)?)?)?;
        let cb_at = add(lw, mul(cslw, 4)?)?;
        let cb = usize::from(u16_le(word, cb_at)?);
        if cb <= FC_CLX {
            return Err(PreviewError::Corrupt);
        }
        let clx_at = add(add(cb_at, 2)?, mul(FC_CLX, 8)?)?;
        let fc_clx = to_usize(u32_le(word, clx_at)?)?;
        let lcb_clx = to_usize(u32_le(word, add(clx_at, 4)?)?)?;
        if ccp_text > MAX_TEXT {
            return Err(PreviewError::TooLarge);
        }
        Ok(Fib { which_table: flags & FLAG_WHICH_TABLE != 0, fc_clx, lcb_clx, ccp_text })
    }
}

/// The piece table: the Clx's Pcdt, after the property modifiers (Prc) that are skipped.
fn piece_table(clx: &[u8]) -> Result<Vec<Piece>> {
    let mut budget = Budget::new(MAX_ITEMS);
    let mut pos = 0usize;
    loop {
        budget.spend(1)?;
        match clx.get(pos).copied() {
            Some(CLX_PRC) => {
                let size = usize::from(u16_le(clx, add(pos, 1)?)?);
                pos = add(add(pos, 3)?, size)?;
            }
            Some(CLX_PCDT) => break,
            _ => return Err(PreviewError::Corrupt),
        }
    }
    let lcb = to_usize(u32_le(clx, add(pos, 1)?)?)?;
    let plc = slice(clx, add(pos, 5)?, lcb)?;
    // PlcPcd: n+1 character positions (u32), then n piece descriptors of 8 bytes, whose fc is at byte 2.
    let body = lcb.checked_sub(4).ok_or(PreviewError::Corrupt)?;
    if body % 12 != 0 {
        return Err(PreviewError::Corrupt);
    }
    let n = body / 12;
    if n > MAX_ITEMS {
        return Err(PreviewError::TooLarge);
    }
    let descriptors = mul(add(n, 1)?, 4)?;
    let mut pieces = Vec::with_capacity(n);
    for i in 0..n {
        budget.spend(1)?;
        let cp = u32_le(plc, mul(i, 4)?)?;
        let cp_next = u32_le(plc, mul(add(i, 1)?, 4)?)?;
        let len = cp_next.checked_sub(cp).ok_or(PreviewError::Corrupt)?;
        let fc = u32_le(plc, add(descriptors, add(mul(i, 8)?, 2)?)?)?;
        let compressed = fc & FC_COMPRESSED != 0;
        // a compressed piece stores one byte per character, at half its fc
        let at = if compressed { (fc & !FC_COMPRESSED) / 2 } else { fc };
        pieces.push(Piece { len: to_usize(len)?, compressed, at: to_usize(at)? });
    }
    Ok(pieces)
}

/// The UTF-16 code units of the main text: the first `ccp` characters of the pieces, in order.
fn main_text_units(word: &[u8], pieces: &[Piece], ccp: usize, budget: &mut Budget) -> Result<Vec<u16>> {
    let mut units: Vec<u16> = Vec::new();
    for piece in pieces {
        let left = ccp.saturating_sub(units.len());
        if left == 0 {
            break;
        }
        let n = piece.len.min(left);
        budget.spend(n)?;
        if piece.compressed {
            for &b in slice(word, piece.at, n)? {
                units.push(cp1252(b));
            }
        } else {
            let bytes = slice(word, piece.at, mul(n, 2)?)?;
            for i in 0..n {
                units.push(u16_le(bytes, mul(i, 2)?)?);
            }
        }
    }
    if units.len() != ccp {
        return Err(PreviewError::Corrupt);
    }
    Ok(units)
}

fn cp1252(b: u8) -> u16 {
    // below 0x80 the index wraps past the table, and the value is the byte itself
    CP1252_HIGH.get(usize::from(b.wrapping_sub(0x80))).copied().unwrap_or(u16::from(b))
}

/// Collects the paragraphs while the main text is read.
#[derive(Default)]
struct Builder {
    paragraphs: Vec<Paragraph>,
    line: String,
    chars: usize,
    /// One entry per open field: true once its separator (\x14) has passed, so it shows its result.
    fields: Vec<bool>,
    /// Open fields still in their instruction part. Nothing is shown while this is above zero.
    hidden: usize,
}

impl Builder {
    fn push(&mut self, c: char) -> Result<()> {
        self.chars += 1;
        if self.chars > MAX_TEXT {
            return Err(PreviewError::TooLarge);
        }
        self.line.push(c);
        Ok(())
    }

    fn end(&mut self, kind: ParagraphKind) -> Result<()> {
        if self.paragraphs.len() >= MAX_ITEMS {
            return Err(PreviewError::TooLarge);
        }
        let text = std::mem::take(&mut self.line);
        self.paragraphs.push(Paragraph { text, kind });
        Ok(())
    }

    fn field_begin(&mut self) -> Result<()> {
        if self.fields.len() >= MAX_DEPTH {
            return Err(PreviewError::TooLarge);
        }
        self.fields.push(false);
        self.hidden += 1;
        Ok(())
    }

    fn field_separator(&mut self) {
        if let Some(in_result) = self.fields.last_mut()
            && !*in_result
        {
            *in_result = true;
            self.hidden = self.hidden.saturating_sub(1);
        }
    }

    fn field_end(&mut self) {
        if let Some(in_result) = self.fields.pop()
            && !in_result
        {
            self.hidden = self.hidden.saturating_sub(1);
        }
    }
}

/// The paragraphs of the main text. Paragraph marks end a paragraph, a cell mark ends a cell, and a page break is
/// its own empty paragraph. Field codes are dropped and their results kept.
fn paragraphs(units: &[u16], budget: &mut Budget) -> Result<DocModel> {
    let mut b = Builder::default();
    for decoded in char::decode_utf16(units.iter().copied()) {
        budget.spend(1)?;
        let c = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
        match c {
            '\u{13}' => b.field_begin()?,
            '\u{14}' => b.field_separator(),
            '\u{15}' => b.field_end(),
            _ if b.hidden > 0 => {}
            '\r' => b.end(ParagraphKind::Normal)?,
            '\u{07}' => b.end(ParagraphKind::Cell)?,
            '\u{0C}' => {
                if !b.line.is_empty() {
                    b.end(ParagraphKind::Normal)?;
                }
                b.end(ParagraphKind::PageBreak)?;
            }
            '\u{0B}' => b.push('\n')?,
            '\u{1E}' => b.push('-')?,
            // a tab stays (dropping it would glue the words on both sides together)
            '\t' => b.push('\t')?,
            // the rest of the control characters go: pictures, \x1F and anything else below 0x20
            c if u32::from(c) < 0x20 => {}
            c => b.push(c)?,
        }
    }
    if !b.line.is_empty() {
        b.end(ParagraphKind::Normal)?;
    }
    Ok(DocModel { paragraphs: b.paragraphs })
}
