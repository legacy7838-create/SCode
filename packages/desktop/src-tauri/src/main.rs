// ZCode Tauri v2 shell — P0 foundation scaffold.
//
// This is a PARALLEL desktop shell to Electron (see ../PORTING.md). It intentionally does only the
// minimum: open one window that loads the existing Vite renderer (http://localhost:5174).
// No Electron code is affected. Platform capabilities (IPlatformService) are NOT yet implemented
// here, so the UI will render but native calls are no-op until Phase 2.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Phase 2 real (non-stub) commands: version, locale, device id, platform info, app name, the OS
// downloads/documents directories (the first fallible `Result` commands), the window-management
// group (minimize/maximize/unmaximize/toggle-fullscreen/close/focus/is-maximized), native
// file/save/message dialogs via `tauri-plugin-dialog`, the shell/open group (open-url /
// reveal-in-folder / open-path) via `tauri-plugin-opener`, and native OS notifications
// (`show_notification`) via `tauri-plugin-notification`. See ./commands.rs and
// ../tauri-port/BRIDGE.md for the contract.
mod commands;

/// Placeholder command to prove the `invoke()` seam exists for Phase 2.
#[tauri::command]
fn shell_kind() -> &'static str {
    "tauri"
}

fn main() {
    tauri::Builder::default()
        // Native dialog support for the slice-5 `show_*_dialog` commands.
        .plugin(tauri_plugin_dialog::init())
        // OS open/reveal support for the slice-6 `open_url` / `open_path` / `reveal_in_folder`
        // commands.
        .plugin(tauri_plugin_opener::init())
        // Native OS notification support for the slice-7 `show_notification` command.
        .plugin(tauri_plugin_notification::init())
        // Shell/sidecar support for the sidecar-runtime PoC `spawn_sidecar_echo` command.
        .plugin(tauri_plugin_shell::init())
        // OS clipboard support for the slice-8 `read_clipboard_text` / `write_clipboard_text` commands.
        .plugin(tauri_plugin_clipboard_manager::init())
        // Sidecar (external child process) support for the `spawn_sidecar_echo` PoC command.
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            shell_kind,
            commands::get_app_version,
            commands::get_system_locale,
            commands::get_device_id,
            commands::get_platform_info,
            commands::get_app_name,
            commands::get_download_directory,
            commands::get_documents_directory,
            commands::window_minimize,
            commands::window_maximize,
            commands::window_unmaximize,
            commands::window_toggle_fullscreen,
            commands::window_close,
            commands::window_set_focus,
            commands::window_is_maximized,
            commands::get_window_size,
            commands::get_window_position,
            commands::is_window_visible,
            commands::is_window_focused,
            commands::show_open_dialog,
            commands::show_save_dialog,
            commands::show_message_dialog,
            commands::open_url,
            commands::reveal_in_folder,
            commands::open_path,
            commands::show_notification,
            commands::spawn_sidecar_echo,
            commands::read_clipboard_text,
            commands::write_clipboard_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running the ZCode Tauri shell");
}
