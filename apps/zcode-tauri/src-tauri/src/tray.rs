//! System tray — the Tauri replacement for `packages/desktop/src/main/desktopTray.ts`.
//!
//! Electron built a `Tray` with a `Menu` template; Tauri uses
//! `TrayIconBuilder` plus `tauri::menu`. The close-to-tray policy that lived in
//! `appShutdownPolicy.ts` is handled in `window.rs`, not here — this module only
//! owns the icon, its menu, and the callbacks those menu items invoke.
//!
//! ## Icon ownership
//!
//! `tauri.conf.json`'s `app.trayIcon` block makes Tauri's `Builder::build`
//! create the OS icon (id `zcode-tray`, `icons/32x32.png`, tooltip "ZCode")
//! *before* `setup()` runs. [`build_tray`] therefore reuses that icon when it
//! exists and only falls back to building one itself: registering a second
//! builder with the same id would create a *second* OS tray icon, because
//! `TrayManager` keeps a `Vec<(TrayIconId, ResourceId)>` and does not
//! deduplicate by id.
//!
//! ## Quit ordering
//!
//! The Quit item must set `AppState`'s quit flag *before* any window closes —
//! otherwise `window.rs` swallows the close as close-to-tray on Windows — and
//! it must drain the [`Supervisor`](crate::supervisor::Supervisor) itself,
//! because `lib.rs`'s `ExitRequested` drain only runs while that flag is still
//! unset.

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::app_state::{QuitKind, SharedAppState};
use crate::supervisor::Supervisor;

/// Tray icon id — must match `app.trayIcon.id` in `tauri.conf.json` so this
/// module attaches to the icon Tauri's `Builder::build` already created instead
/// of registering a duplicate.
const TRAY_ID: &str = "zcode-tray";

/// Electron set this via `Tray.setToolTip` (`desktopTray.ts:58`, string from
/// `desktopMenu.ts:107`). The config-created icon gets it from
/// `tauri.conf.json`; the fallback builder sets it here.
const TOOLTIP: &str = "ZCode";

const MENU_SHOW_ID: &str = "tray/show-window";
const MENU_QUIT_ID: &str = "tray/quit";

/// The actions the tray menu can trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayMenuAction {
    Show,
    Quit,
}

/// Route a fired menu-item id to an action. Ids this module does not own (a
/// future application menu, Electron-only items such as `file/new-task`) map to
/// `None` and are ignored by the handler.
fn menu_action(id: &str) -> Option<TrayMenuAction> {
    match id {
        MENU_SHOW_ID => Some(TrayMenuAction::Show),
        MENU_QUIT_ID => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

/// The core left-click decision: only a left-button *release* reveals the
/// window. Press-state matters because Electron's `Tray.on("click")` fires on
/// release, and button matters because right-click is the context menu.
fn is_reveal_click(button: MouseButton, button_state: MouseButtonState) -> bool {
    button == MouseButton::Left && button_state == MouseButtonState::Up
}

/// Whether a tray icon event should reveal the primary window.
///
/// Windows/Linux mirror Electron's tray, which wired both `"click"` and
/// `"double-click"` to `showTrayWindow` (`desktopTray.ts:102-103`); a Tauri
/// double click emits the constituent left-up `Click` first, so no separate
/// `DoubleClick` arm is needed. macOS is deliberately excluded: a menu-bearing
/// status item there opens its menu on click (menu-only interaction), and the
/// Electron tray was never created on macOS at all (`desktopTray.ts:28` bails
/// unless `process.platform === "win32"`). Note also that Tauri does not emit
/// tray icon events on Linux at all (tauri 2.12 `tray/mod.rs:64-66`: the icon
/// shows and right-click still opens the context menu, but no `Click` is
/// delivered) — there the handler is simply inert.
fn reveals_on_tray_event(event: &TrayIconEvent) -> bool {
    if cfg!(target_os = "macos") {
        return false;
    }
    matches!(
        event,
        TrayIconEvent::Click { button, button_state, .. } if is_reveal_click(*button, *button_state)
    )
}

/// Reveal the primary window. This calls `commands::app::show_current_window`
/// (`commands/app.rs:38-47`: `show` + `set_focus` on `PRIMARY_WINDOW_LABEL`)
/// rather than reimplementing it, so the tray path and the IPC path cannot
/// drift apart. The command reports `Ok(false)` when no primary window exists,
/// and never fails, so there is nothing further to act on.
fn reveal_primary_window(app: &AppHandle) {
    let _ = crate::commands::app::show_current_window(app.clone());
}

/// Quit the application from the tray, mirroring Electron's `quitApp`
/// (`index.ts:2020-2023`: `markExplicitQuit("tray-quit")` then `app.quit()`).
fn quit_app(app: &AppHandle, state: &SharedAppState) {
    // 1. Mark the explicit quit *before* anything closes. `window.rs`'s
    //    `CloseRequested` handler hides the window instead of closing it on
    //    Windows unless this flag is set (close-to-tray), so a close issued
    //    first would be swallowed and the app would never exit.
    state.request_quit(QuitKind::Normal);

    // 2. Drain supervised children here, not in `lib.rs`: that handler only
    //    drains on the *first* exit request while the quit flag is still unset
    //    (`if !state.quit_requested()`), and step 1 just set it — without this
    //    call the tray quit path would skip the drain entirely. `shutdown_all`
    //    empties the child map, so it is idempotent and safe alongside a later
    //    `ExitRequested` pass in `lib.rs`.
    app.state::<Arc<Supervisor>>().shutdown_all();

    // 3. Close every window (Electron's `app.quit()` closed all windows too).
    //    With the flag set, `window.rs` lets each close through; when the last
    //    window is destroyed, Tauri fires `ExitRequested { code: None }` and the
    //    run loop in `lib.rs` ends the process. `app.exit` is only the fallback
    //    for a headless quit — with no window to close, nothing else would
    //    trigger the exit — and is safe because steps 1-2 already completed.
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    for window in windows.values() {
        let _ = window.close();
    }
}

/// Install the system tray icon and its context menu, wiring every menu item
/// and the left-click behaviour. The parent calls this exactly once from
/// `setup()`.
///
/// Menu structure mirrors `desktopTray.ts:59-98` — Show (`desktopTray.ts:61-64`),
/// separator (`:65`), Quit (`:93-96`) with labels from `desktopMenu.ts:106-109`
/// ("Show current window" / "Quit", rendered here as "Show Window"). Deliberately
/// absent: Electron's "Check for updates" item (`desktopTray.ts:75-83`, shown
/// only for the production flavor; application-menu equivalent at
/// `desktopApplicationMenu.ts:104-113,245-253`) — this crate has no updater to
/// reach (no `tauri-plugin-updater` dependency, no update command, and Cargo
/// dependencies are fixed for this port), so the item is reported as
/// `NO_NATIVE_EQUIV` rather than shipped as a dead or permanently disabled
/// entry. Electron's other tray items (New Task, Open Workspace, About, Clear
/// All Data, `desktopTray.ts:66-91`) are outside this slice's menu contract.
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, MENU_SHOW_ID, "Show Window", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    // Reuse the icon Tauri already created from `app.trayIcon` (same id, same
    // `icons/32x32.png`); building a second one with this id would show two OS
    // tray icons. The fallback covers a config that has no `trayIcon` block.
    let tray = match app.tray_by_id(TRAY_ID) {
        Some(existing) => existing,
        None => {
            let builder = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip(TOOLTIP)
                .show_menu_on_left_click(false);
            builder.build(app)?
        }
    };

    // Icon source of truth: `default_window_icon()` resolves `bundle.icon`'s
    // first PNG (`icons/32x32.png` in `tauri.conf.json`) which tauri-codegen
    // embeds at compile time, so it works identically in dev and packaged
    // builds. `set_icon(None)` would *remove* the icon, so a missing default
    // must leave the config-provided image alone instead of clearing it.
    match app.default_window_icon() {
        Some(icon) => tray.set_icon(Some(icon.clone()))?,
        None => tracing::warn!("no default window icon; keeping the tray icon as configured"),
    }

    // First menu attached to this icon; on Linux a tray menu cannot be replaced
    // after it is set, which is fine because the parent calls `build_tray` once.
    tray.set_menu(Some(menu))?;

    // Menu events fire asynchronously on the event loop, so the handler cannot
    // borrow the managed state — clone the `Arc` in before registering it.
    let state = app.state::<SharedAppState>().inner().clone();
    tray.on_menu_event(move |app, event| {
        let id: &str = event.id().as_ref();
        match menu_action(id) {
            Some(TrayMenuAction::Show) => reveal_primary_window(app),
            Some(TrayMenuAction::Quit) => quit_app(app, &state),
            None => {}
        }
    });

    // Left-click reveal (Windows/Linux). The config sets
    // `menuOnLeftClick: false`, so the menu stays right-click-only and the
    // click is free to mean "show the window", as in Electron.
    tray.on_tray_icon_event(|tray_icon, event| {
        if reveals_on_tray_event(&event) {
            reveal_primary_window(tray_icon.app_handle());
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_menu_ids_route_to_their_actions() {
        assert_eq!(menu_action(MENU_SHOW_ID), Some(TrayMenuAction::Show));
        assert_eq!(menu_action(MENU_QUIT_ID), Some(TrayMenuAction::Quit));
    }

    #[test]
    fn unowned_menu_ids_are_ignored() {
        // Bare, un-namespaced ids must not leak into this module's routing,
        // including the Electron tray items this slice does not implement.
        assert_eq!(menu_action("quit"), None);
        assert_eq!(menu_action("show-window"), None);
        assert_eq!(menu_action("file/new-task"), None);
        assert_eq!(menu_action(""), None);
    }

    #[test]
    fn only_a_left_button_release_reveals() {
        assert!(is_reveal_click(MouseButton::Left, MouseButtonState::Up));
        // Press must not fire: Electron revealed on click (release).
        assert!(!is_reveal_click(MouseButton::Left, MouseButtonState::Down));
        // Right/middle clicks belong to the context menu.
        assert!(!is_reveal_click(MouseButton::Right, MouseButtonState::Up));
        assert!(!is_reveal_click(MouseButton::Middle, MouseButtonState::Up));
    }
}
