// ZCode Tauri v2 shell — P0 foundation scaffold.
//
// This is a PARALLEL desktop shell to Electron (see ../PORTING.md). It intentionally does only the
// minimum: open one window that loads the existing Vite renderer (http://localhost:5174).
// No Electron code is affected. Platform capabilities (IPlatformService) are NOT yet implemented
// here, so the UI will render but native calls are no-op until Phase 2.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Placeholder command to prove the `invoke()` seam exists for Phase 2.
#[tauri::command]
fn shell_kind() -> &'static str {
    "tauri"
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![shell_kind])
        .run(tauri::generate_context!())
        .expect("error while running the ZCode Tauri shell");
}
