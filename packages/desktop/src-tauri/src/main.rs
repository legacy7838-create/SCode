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
// (`show_notification`) via `tauri-plugin-notification`, plus the window-state queries and the
// window-mutation group (set title/size/position, center, set/is fullscreen) via the existing
// (`WebviewWindow`) API, and the app-path group (home / temp / app-data / app-config directories via
// `app.path().resolve`, plus the current executable path via `std::env::current_exe`), and the
// window-theme group (get / set) via `WebviewWindow::theme` / `set_theme`, and the window
// visibility & protection group (show / hide / skip-taskbar / focusable / content-protected) via the
// existing `WebviewWindow` mutators. See ./commands.rs and
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
        // Sidecar child registry for the slice-20 lifecycle commands (spawn retains a child by pid,
        // kill reaps it). Managed exactly once — a second `.manage` of the same type would panic.
        .manage(commands::SidecarRegistry::default())
        // Last-set zoom factor per window, so slice 26 can read the zoom level back (Tauri has no
        // zoom getter). Distinct managed type from SidecarRegistry, so a second `.manage` is fine.
        .manage(commands::ZoomRegistry::default())
        .invoke_handler(tauri::generate_handler![
            shell_kind,
            commands::get_app_version,
            commands::get_system_locale,
            commands::get_device_id,
            commands::get_platform_info,
            commands::get_app_name,
            commands::relaunch_app,
            commands::exit_app,
            commands::get_download_directory,
            commands::get_documents_directory,
            commands::get_home_dir,
            commands::get_temp_dir,
            commands::get_app_data_dir,
            commands::get_app_config_dir,
            commands::get_exe_path,
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
            commands::set_window_title,
            commands::set_window_size,
            commands::set_window_position,
            commands::center_window,
            commands::set_fullscreen,
            commands::is_fullscreen,
            commands::get_window_theme,
            commands::set_window_theme,
            commands::set_desktop_zoom_level,
            commands::get_desktop_zoom_level,
            commands::get_window_scale_factor,
            commands::is_window_always_on_top,
            commands::set_window_always_on_top,
            commands::is_window_resizable,
            commands::set_window_resizable,
            commands::show_window,
            commands::hide_window,
            commands::set_window_skip_taskbar,
            commands::set_window_focusable,
            commands::set_window_content_protected,
            commands::window_unminimize,
            commands::is_window_minimized,
            commands::get_window_inner_position,
            commands::is_window_enabled,
            commands::set_window_enabled,
            commands::get_window_outer_size,
            commands::get_cursor_position,
            commands::get_window_current_monitor,
            commands::get_primary_monitor,
            commands::get_available_monitors,
            commands::set_window_decorations,
            commands::set_window_ignore_cursor_events,
            commands::set_window_min_size,
            commands::set_window_max_size,
            commands::clear_window_min_size,
            commands::clear_window_max_size,
            commands::set_window_background_color,
            commands::clear_window_background_color,
            commands::set_window_visible_on_all_workspaces,
            commands::set_window_cursor_grab,
            commands::set_window_cursor_visible,
            commands::show_open_dialog,
            commands::select_directory,
            commands::show_save_dialog,
            commands::show_message_dialog,
            commands::open_url,
            commands::reveal_in_folder,
            commands::open_path,
            commands::show_notification,
            commands::spawn_sidecar_echo,
            commands::spawn_sidecar_echo_discover_port,
            commands::kill_sidecar,
            commands::read_clipboard_text,
            commands::write_clipboard_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running the ZCode Tauri shell");
}
