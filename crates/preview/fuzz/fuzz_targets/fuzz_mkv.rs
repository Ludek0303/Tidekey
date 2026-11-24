#![no_main]

use libfuzzer_sys::fuzz_target;

// The EBML signature goes in front, so the input reaches the Matroska reader and not the signature check.
fuzz_target!(|data: &[u8]| {
    let mut input = vec![0x1A, 0x45, 0xDF, 0xA3];
    input.extend_from_slice(data);
    let _ = notes_preview::video::video_first_keyframe(&input);
});
