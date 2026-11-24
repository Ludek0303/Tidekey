#![no_main]

use libfuzzer_sys::fuzz_target;

// The RIFF/AVI header goes in front, so the input reaches the AVI reader and not the signature check.
// The RIFF size is the largest, so the chunks run to the end of the input.
fuzz_target!(|data: &[u8]| {
    let mut input = b"RIFF\xFF\xFF\xFF\xFFAVI ".to_vec();
    input.extend_from_slice(data);
    let _ = notes_preview::video::video_first_keyframe(&input);
});
