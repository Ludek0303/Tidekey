//! DWG to DXF through acadrust (MPL-2.0). The frame draws the DXF with its own reader, so this module only converts.

use std::io::Cursor;
use std::panic;

use acadrust::{DwgReadOptions, DwgReader, DxfWriter};
use wasm_bindgen::prelude::*;

use crate::{PreviewError, Result, check_input};

#[cfg(test)]
#[path = "dwg_tests.rs"]
mod dwg_tests;

/// The largest DWG the frame takes.
pub const MAX_DWG: usize = 30 << 20;
/// shortcut: one read may decompress 256 MiB of sections, not the frame's whole memory budget; raise it when real drawings need more.
const MAX_DECOMPRESSED: usize = 256 << 20;

/// DWG to DXF (ASCII). A panic inside acadrust is caught natively; on wasm32 it ends the call instead (see previewwasm.ts).
pub fn dwg_to_dxf(bytes: &[u8]) -> Result<Vec<u8>> {
    check_input(bytes)?;
    if bytes.len() > MAX_DWG {
        return Err(PreviewError::TooLarge);
    }
    if !is_dwg(bytes) {
        return Err(PreviewError::Unsupported);
    }
    panic::catch_unwind(|| convert(bytes)).unwrap_or(Err(PreviewError::Corrupt))
}

#[wasm_bindgen(js_name = dwgToDxf)]
pub fn dwg_to_dxf_js(bytes: &[u8]) -> std::result::Result<Vec<u8>, JsError> {
    dwg_to_dxf(bytes).map_err(|err| JsError::new(err.code()))
}

/// The signature "AC10" and two digits of version (AC1015, AC1018, AC1032, ...).
fn is_dwg(bytes: &[u8]) -> bool {
    bytes.get(..4) == Some(b"AC10") && bytes.get(4..6).is_some_and(|v| v.iter().all(u8::is_ascii_digit))
}

fn convert(bytes: &[u8]) -> Result<Vec<u8>> {
    let options = DwgReadOptions::default().with_max_decompressed_bytes(MAX_DECOMPRESSED);
    let mut reader = DwgReader::from_stream_with_options(Cursor::new(bytes), options);
    let document = reader.read().map_err(|_| PreviewError::Corrupt)?;
    DxfWriter::new(&document).write_to_vec().map_err(|_| PreviewError::Corrupt)
}
