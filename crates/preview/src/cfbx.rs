//! Streams out of a Compound File Binary (OLE2) container, MS-CFB. Shared by the `.doc` and `.ppt` parsers.

use std::io::{Cursor, Read};

use crate::{PreviewError, Result};

/// The root-level stream `name` as bytes. `None` when the container has no such stream; `Corrupt` when the container
/// does not open; `TooLarge` when the stream is longer than `max`.
pub fn read_stream(bytes: &[u8], name: &str, max: usize) -> Result<Option<Vec<u8>>> {
    let mut file = cfb::CompoundFile::open(Cursor::new(bytes)).map_err(|_| PreviewError::Corrupt)?;
    let path = format!("/{name}");
    if !file.is_stream(&path) {
        return Ok(None);
    }
    let stream = file.open_stream(&path).map_err(|_| PreviewError::Corrupt)?;
    let mut out = Vec::new();
    // one byte past the limit is enough to tell "too long" from "exactly max"; the rest is never read
    stream.take((max as u64).saturating_add(1)).read_to_end(&mut out).map_err(|_| PreviewError::Corrupt)?;
    if out.len() > max {
        return Err(PreviewError::TooLarge);
    }
    Ok(Some(out))
}
