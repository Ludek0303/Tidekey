// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell of the notes app: the window and the IPC commands. Storage is in `notes-bridge`.

mod commands;
mod config;
mod smoke;
mod spaces;
mod tasks;
mod organization;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            organization::organization_snapshot,
            organization::organization_person,
            organization::organization_group,
            organization::external_task_note,
            organization::external_task_edit,
            organization::organization_records,
            organization::organization_import_module,
            organization::organization_save_record,
            organization::organization_movement,
            organization::organization_cancel_movement,
            organization::organization_global_records,
            commands::space_status,
            smoke::smoke_mode,
            smoke::smoke_report,
            commands::pick_folder,
            commands::create_space,
            commands::open_space,
            commands::recover_space,
            commands::confirm_phrase,
            spaces::list_spaces,
            spaces::open_known_space,
            spaces::close_space,
            spaces::forget_space,
            commands::space_name,
            commands::space_kind,
            commands::set_space_kind,
            tasks::my_handle,
            tasks::set_my_handle,
            tasks::save_task_cache,
            tasks::task_caches,
            commands::list_tree,
            commands::create_note,
            commands::create_folder,
            commands::rename,
            commands::rename_folder,
            commands::delete,
            commands::delete_folder,
            commands::list_trash,
            commands::restore_note,
            commands::purge_note,
            commands::open_note,
            commands::note_text,
            commands::apply_update,
            commands::search,
            commands::list_versions,
            commands::version_text,
            commands::restore_version,
            commands::list_conflicts,
            commands::conflict_texts,
            commands::resolve_conflict,
            commands::save_attachment,
            commands::read_attachment,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the notes app");
}
