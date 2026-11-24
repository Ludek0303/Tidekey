//! Window smoke check (`scripts/smoke-app.sh`): with `NOTES_SMOKE` set, the page reports whether its WASM module
//! loaded, and the app exits with that result. It catches what tests in a browser cannot, such as the window's CSP
//! refusing the module. Without the variable both commands do nothing.

use tauri::AppHandle;

const VAR: &str = "NOTES_SMOKE";

fn on() -> bool {
    std::env::var_os(VAR).is_some()
}

#[tauri::command]
pub fn smoke_mode() -> bool {
    on()
}

#[tauri::command]
pub fn smoke_report(app: AppHandle, ok: bool, detail: String) {
    if !on() {
        return;
    }
    println!("SMOKE {} {detail}", if ok { "OK" } else { "FAIL" });
    app.exit(if ok { 0 } else { 1 });
}
