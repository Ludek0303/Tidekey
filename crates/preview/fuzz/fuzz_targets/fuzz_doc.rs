#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // any input must give a result or an error, never a panic
    let _ = notes_preview::doc::doc_text(data);
});
