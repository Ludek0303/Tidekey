#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = notes_preview::ppt::ppt_slides(data);
});
