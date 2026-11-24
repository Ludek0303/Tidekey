use crate::commands::{AppState, with_space};
use notes_bridge::BridgeError;
use notes_bridge::{Backend, OsKeyStore};
use serde_json::Value;
use std::path::Path;
use tauri::State;
use tauri::{AppHandle, Manager};

fn other_space<T>(
    app: &AppHandle,
    state: &AppState,
    path: &str,
    run: impl FnOnce(&mut Backend) -> Result<T, BridgeError>,
) -> Result<T, BridgeError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| BridgeError::new("config", e.to_string()))?;
    let target = crate::spaces::known_among(&crate::config::spaces(&dir), Path::new(path))?;
    // Serialize against switching/current-space writes. Never hold two backends for the same folder.
    let mut guard = crate::commands::lock(state);
    let current = crate::commands::lock_path(&state.current).clone();
    if current.as_ref().and_then(|p| p.canonicalize().ok()) == target.canonicalize().ok() {
        return run(guard
            .as_mut()
            .ok_or_else(|| BridgeError::new("no_space", "Nie otwarto przestrzeni."))?);
    }
    let mut backend = Backend::open(&target, &mut OsKeyStore)?;
    if backend.space_kind() != notes_core::KIND_ORGANIZATION {
        return Err(BridgeError::new(
            "not_organization",
            "To nie jest przestrzeń organizacji.",
        ));
    }
    run(&mut backend)
}

#[tauri::command]
pub fn external_task_note(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<String, BridgeError> {
    other_space(&app, &state, &path, |s| s.note_text(&id))
}

#[tauri::command]
pub fn external_task_edit(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    id: String,
    expected: String,
    replacement: String,
) -> Result<(), BridgeError> {
    other_space(&app, &state, &path, |s| {
        s.replace_task_note_checked(&id, &expected, &replacement)
    })?;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| BridgeError::new("config", e.to_string()))?;
    let listed = crate::spaces::known_among(&crate::config::spaces(&dir), Path::new(&path))?;
    if let Some(mut cache) = crate::tasks::read_cache(&dir, &listed) {
        if let Some(rows) = cache.get_mut("rows").and_then(Value::as_array_mut) {
            let tasks = notes_core::index::parse_note(&replacement).tasks;
            for row in rows.iter_mut().filter(|row| row["note"] == id) {
                if let Some(task) = tasks.iter().find(|t| {
                    t.id.as_deref()
                        .is_some_and(|b| row["block"].as_str() == Some(b))
                }) {
                    row["done"] = serde_json::json!(task.done);
                    row["done_on"] = serde_json::json!(task.done_on);
                    row["due"] = serde_json::json!(task.due);
                    row["difficulty"] = serde_json::json!(task.difficulty);
                    row["reminder"] = serde_json::json!(task.reminder);
                    row["supervisor"] = serde_json::json!(task.supervisor);
                    row["assignees"] = serde_json::json!(task.assignees);
                    row["line"] = serde_json::json!(task.line);
                    row["text"] = serde_json::json!(task.text);
                }
            }
        }
        crate::tasks::write_cache(&dir, &listed, &cache)?;
    }
    Ok(())
}

#[tauri::command]
pub fn organization_snapshot(state: State<'_, AppState>) -> Result<Value, BridgeError> {
    with_space(&state, |s| s.organization_snapshot())
}

#[tauri::command]
pub fn organization_person(
    state: State<'_, AppState>,
    user_id: String,
    name: String,
) -> Result<(), BridgeError> {
    with_space(&state, |s| s.organization_person(&user_id, &name))
}

#[tauri::command]
pub fn organization_group(state: State<'_, AppState>, group: Value) -> Result<(), BridgeError> {
    with_space(&state, |s| s.organization_group(group))
}

#[tauri::command]
pub fn organization_records(state: State<'_, AppState>) -> Result<Value, BridgeError> {
    with_space(&state, |s| s.organization_records())
}

#[tauri::command]
pub fn organization_import_module(
    state: State<'_, AppState>,
    text: String,
    expected: Option<String>,
    commit: bool,
) -> Result<Value, BridgeError> {
    with_space(&state, |s| {
        s.organization_import_module(&text, expected.as_deref(), commit)
    })
}

#[tauri::command]
pub fn organization_save_record(
    app: AppHandle,
    state: State<'_, AppState>,
    record: Value,
    expected: String,
    path: Option<String>,
) -> Result<Value, BridgeError> {
    if let Some(path) = path {
        other_space(&app, &state, &path, |s| {
            s.organization_save_record(record, &expected)
        })
    } else {
        with_space(&state, |s| s.organization_save_record(record, &expected))
    }
}

#[tauri::command]
pub fn organization_movement(
    state: State<'_, AppState>,
    id: String,
    item_id: String,
    quantity: f64,
    issue: bool,
    borrower: String,
) -> Result<Value, BridgeError> {
    with_space(&state, |s| {
        s.organization_movement(&id, &item_id, quantity, issue, &borrower)
    })
}

#[tauri::command]
pub fn organization_cancel_movement(
    state: State<'_, AppState>,
    target_id: String,
    reason: String,
) -> Result<Value, BridgeError> {
    with_space(&state, |s| {
        s.organization_cancel_movement(&target_id, &reason)
    })
}

#[tauri::command]
pub fn organization_global_records(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, BridgeError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| BridgeError::new("config", e.to_string()))?;
    let mut sources = Vec::new();
    for path in crate::config::spaces(&dir) {
        let path_text = path.to_string_lossy().to_string();
        // Missing keys, revoked membership and unavailable folders never contribute cached plaintext.
        if let Ok(data) = other_space(&app, &state, &path_text, |s| {
            Ok(
                serde_json::json!({"data": s.organization_records()?, "identity": s.organization_snapshot()?}),
            )
        }) {
            sources.push(serde_json::json!({"path": path_text, "name": path.file_name().unwrap_or_default().to_string_lossy(), "data": data["data"], "identity": data["identity"]}));
        }
    }
    Ok(serde_json::json!(sources))
}
