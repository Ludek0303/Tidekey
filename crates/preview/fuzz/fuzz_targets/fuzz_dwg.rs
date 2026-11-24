#![no_main]

use std::sync::Once;

use libfuzzer_sys::fuzz_target;

static QUIET_PANICS: Once = Once::new();

// acadrust is not our code and panics on some inputs (an overflowing shift in its handle reader, found here); dwg_to_dxf
// catches that with catch_unwind and returns an error, as it does in the app. libfuzzer-sys installs a hook that aborts
// on any panic before it can unwind, so the hook is replaced: what this target checks is that no panic gets past
// dwg_to_dxf, and that nothing hangs, aborts or runs out of memory.
fuzz_target!(|data: &[u8]| {
    QUIET_PANICS.call_once(|| std::panic::set_hook(Box::new(|_| {})));
    let _ = notes_preview::dwg::dwg_to_dxf(data);
});
