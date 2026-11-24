//! Parsers for the preview window (docs/PODGLAD.md §2, docs/PODGLAD-PLAN.md §4.5). Every input is a file from someone
//! else: nothing here may panic on it, every size and offset is checked, and every parser stops at the limits below.
//! The JavaScript side only draws the neutral models these functions return.

#[cfg(feature = "dwg")]
pub mod dwg;
pub mod doc;

use std::fmt;

pub mod cfbx;
pub mod ppt;

/// The largest input any parser takes.
pub const MAX_INPUT: usize = 64 << 20;
/// Records, elements or entries one parser visits before it gives up.
pub const MAX_ITEMS: usize = 100_000;
/// Nesting depth of containers (EBML elements, PowerPoint records, CFB directory).
pub const MAX_DEPTH: usize = 32;
/// Text a document may produce.
pub const MAX_TEXT: usize = 16 << 20;
/// Slides a presentation may have.
pub const MAX_SLIDES: usize = 500;
/// One embedded picture or one video frame.
pub const MAX_BLOB: usize = 32 << 20;

/// Why a file cannot be shown. The frame turns it into its error code (`too-large`, `corrupt`, `unsupported`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewError {
    TooLarge,
    Corrupt,
    Unsupported,
}

impl PreviewError {
    /// The frame protocol's error code (docs/PODGLAD-PLAN.md §4.1).
    pub fn code(self) -> &'static str {
        match self {
            PreviewError::TooLarge => "too-large",
            PreviewError::Corrupt => "corrupt",
            PreviewError::Unsupported => "unsupported",
        }
    }
}

impl fmt::Display for PreviewError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.code()) }
}

impl std::error::Error for PreviewError {}

pub type Result<T> = std::result::Result<T, PreviewError>;

/// A work budget instead of a clock: each step of a parser spends one unit, and an exhausted budget is `TooLarge`.
/// It bounds the time a crafted file can take, the same on every machine.
pub struct Budget(usize);

impl Budget {
    pub fn new(steps: usize) -> Self { Budget(steps) }

    pub fn spend(&mut self, steps: usize) -> Result<()> {
        self.0 = self.0.checked_sub(steps).ok_or(PreviewError::TooLarge)?;
        Ok(())
    }
}

/// Refuses an input over `MAX_INPUT` before any parsing.
pub fn check_input(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_INPUT { Err(PreviewError::TooLarge) } else { Ok(()) }
}

/// `bytes[at..at + len]`, or `Corrupt` when that is outside the input (offsets come from the file).
pub fn slice(bytes: &[u8], at: usize, len: usize) -> Result<&[u8]> {
    let end = at.checked_add(len).ok_or(PreviewError::Corrupt)?;
    bytes.get(at..end).ok_or(PreviewError::Corrupt)
}

pub fn u16_le(bytes: &[u8], at: usize) -> Result<u16> {
    let b = slice(bytes, at, 2)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

pub fn u32_le(bytes: &[u8], at: usize) -> Result<u32> {
    let b = slice(bytes, at, 4)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

pub mod video;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_stay_inside_the_input() {
        let b = [1u8, 2, 3, 4, 5];
        assert_eq!(u16_le(&b, 0), Ok(0x0201));
        assert_eq!(u32_le(&b, 1), Ok(0x0504_0302));
        assert_eq!(u32_le(&b, 2), Err(PreviewError::Corrupt));
        assert_eq!(slice(&b, usize::MAX, 2), Err(PreviewError::Corrupt));
        assert_eq!(slice(&b, 5, 0), Ok(&[][..]));
    }

    #[test]
    fn the_budget_runs_out_as_too_large() {
        let mut budget = Budget::new(3);
        assert_eq!(budget.spend(2), Ok(()));
        assert_eq!(budget.spend(2), Err(PreviewError::TooLarge));
    }

    #[test]
    fn an_input_over_the_limit_is_refused() {
        assert_eq!(check_input(&vec![0u8; MAX_INPUT + 1]), Err(PreviewError::TooLarge));
        assert_eq!(check_input(&[]), Ok(()));
    }
}
