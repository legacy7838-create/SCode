// Hide the console window that Windows would otherwise attach to a release
// build. Debug builds keep it so `println!` and panic messages stay visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zcode_tauri_lib::run()
}
