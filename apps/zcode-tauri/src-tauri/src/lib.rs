//! Tauri application wiring — the replacement for `packages/desktop/src/main/index.ts`.
//!
//! ## Startup ordering, and why it differs
//!
//! Electron's `main/index.ts` had to split startup in two because several APIs
//! are only legal before `app.whenReady()`; those ran as import side effects at
//! the top of the file (data base dir, hardware acceleration, crash capture).
//! Tauri has no such split: `setup()` runs exactly once, after the runtime is
//! ready and before the event loop starts, and every window in this app is
//! created from inside it. That removes the macOS `activate`-vs-`ready` race the
//! Electron coordinator needed a pending-promise latch for.

pub mod app_state;
pub mod commands;
pub mod events;
pub mod rpc;
pub mod scheduler_store;
pub mod services;
pub mod supervisor;
pub mod tray;
pub mod window;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use app_state::{AppState, SharedAppState};
use commands::fs::AllowedRoots;
use supervisor::scheduler::TickOutcome;
use supervisor::Supervisor;

/// Where the scheduler store lives.
///
/// Electron's data base dir is `~/.zcode/v2` (`main/index.ts:528` derives the
/// settings file from it), and `ZCODE_DATA_BASE_DIR` overrides it exactly as
/// `setDataBaseDir` did — so tests and CI can point the whole store elsewhere.
fn scheduler_db_path() -> std::path::PathBuf {
    let configured = std::env::var("ZCODE_DATA_BASE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from);
    match configured {
        Some(dir) => dir.join("tasks-index.sqlite"),
        None => std::env::var("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default()
            .join(".zcode")
            .join("v2")
            .join("tasks-index.sqlite"),
    }
}

/// Build and run the application.
pub fn run() {
    init_tracing();

    let state: SharedAppState = Arc::new(AppState::new());
    let supervisor = Arc::new(Supervisor::new(state.clone()));
    let allowed_roots = AllowedRoots::from_env();
    // Started before the builder so the registry exists up front; the listener
    // itself is bound inside `setup()` (see below) and the state is managed there.
    let rpc_host = rpc::RpcHost::new();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        // Required by `commands::native::show_notification`; without this the
        // `app.notification()` lookup panics at first use.
        .plugin(tauri_plugin_notification::init())
        // Main-side zoom registry: `WebviewWindow::set_zoom` has no getter, so
        // `SurfaceState` is the only source of truth for reads.
        .manage(commands::surface::SurfaceState::default());

    // Deep-link handler. Electron routed `zcode://` through
    // `app.on("open-url")` plus a Linux `.desktop` registration
    // (`main/desktopLinuxDeepLinkRegistration.ts`); the plugin covers all three
    // platforms with one registration.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Mirrors `second-instance` in `main/index.ts:1873-1907`: focus the
            // existing window and forward the URL rather than starting a second.
            if let Some(window) = app.get_webview_window(window::PRIMARY_WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(url) = deep_link_url_from_argv(&argv) {
                let _ = app.emit(events::OAUTH_CALLBACK, url);
            }
        }));
    }

    builder
        .manage(state.clone())
        .manage(supervisor.clone())
        .manage(allowed_roots)
        .manage(rpc_host)
        .setup(move |app| {
            let handle = app.handle().clone();

            // 0. The in-process RPC listener. Bound first so its address is
            //    settled before anything can ask for it, and before the window
            //    that will ask. A bind failure is logged and tolerated: the UI is
            //    still served by `@zcode/server` until channels are ported, so a
            //    busy port must not stop the app from starting.
            match app.state::<rpc::RpcHost>().start() {
                Ok(endpoint) => tracing::info!(
                    address = %endpoint.address,
                    channels = endpoint.channel_count,
                    "in-process rpc listener ready"
                ),
                Err(error) => tracing::error!(
                    %error,
                    "in-process rpc listener unavailable; renderer stays on the node service"
                ),
            }

            // 1. The primary window. Electron created it last, after ~90 lines of
            //    `whenReady` bootstrap; here it is the first and only step, since
            //    nothing else gates it.
            let primary = window::ensure_primary_window(&handle, &state, &window::PrimaryWindowOptions::default())?;
            window::attach_window_events(&primary, &handle, state.clone());

            // 2. One Host per window surface.
            let (_host_id, _host_tx) = supervisor::host::spawn_host_for_window(
                &supervisor,
                state.clone(),
                window::PRIMARY_WINDOW_LABEL.to_string(),
            );

            // 3. The resident scheduler. Electron spawned this only after the
            //    database reported ready, because it opens the same SQLite file;
            //    here `setup()` runs before any dispatch can happen, so that race
            //    cannot occur. Opening is non-fatal: a failure logs and leaves the
            //    due-set empty rather than aborting startup, matching the Electron
            //    scheduler swallowing per-tick errors instead of dying.
            let scheduler_store = std::sync::Mutex::new(
                scheduler_store::SchedulerStore::open(
                    &scheduler_db_path().to_string_lossy(),
                )
                .map_err(|error| {
                    tracing::error!(%error, "scheduler store unavailable; dispatch disabled");
                    error
                })
                .ok(),
            );
            supervisor::scheduler::spawn_scheduler(&supervisor, "primary", move |now_ms| {
                let mut guard = scheduler_store
                    .lock()
                    .map_err(|_| "scheduler store poisoned".to_string())?;
                let Some(store) = guard.as_mut() else {
                    return Ok(Vec::new());
                };

                let mut outcomes = Vec::new();
                for automation in store.claim_due(now_ms).map_err(|e| e.to_string())? {
                    let automation_id = automation.automation_id.clone();
                    match automation.evaluate(now_ms) {
                        TickOutcome::Dispatched { run_id } => {
                            outcomes.push(TickOutcome::Dispatched { run_id });
                        }
                        skipped @ TickOutcome::Skipped { .. } => {
                            // Release the claim we just took. `next_run_at_ms` is
                            // `None` because `computeAutomationNextRunAt` has no
                            // Rust port: `skip_misfire` COALESCEs, so the claim is
                            // released and the schedule is left untouched rather
                            // than a timestamp being fabricated.
                            store
                                .skip_misfire(
                                    &automation_id,
                                    scheduler_store::MISFIRE_SKIP_REASON,
                                    None,
                                    now_ms,
                                )
                                .map_err(|e| e.to_string())?;
                            outcomes.push(skipped);
                        }
                        TickOutcome::NotDue => {}
                    }
                }
                Ok(outcomes)
            });

            // 4. Tray. Built last so it can reveal an already-created window
            //    rather than racing window creation.
            tray::build_tray(&handle)?;

            tracing::info!("zcode-tauri ready");
            Ok(())
        })
        .on_window_event(|_window, _event| {})
        .invoke_handler(tauri::generate_handler![
            commands::app::get_app_info,
            commands::app::show_current_window,
            commands::app::request_quit,
            commands::app::get_quit_kind,
            commands::app::describe_runtime,
            commands::window::notify_renderer_ready,
            commands::window::sync_window_tabs,
            commands::window::sync_window_unread_count,
            commands::window::sync_active_task_session,
            commands::window::get_window_state,
            commands::window::list_windows,
            commands::window::activate_or_set_workspace,
            commands::window::focus_tab,
            commands::fs::read_text_file,
            commands::fs::create_temp_text_attachment,
            commands::native::pick_directory,
            commands::native::pick_file,
            commands::native::save_file,
            commands::native::open_external,
            commands::native::open_in_file_manager,
            commands::native::show_notification,
            commands::surface::set_desktop_zoom,
            commands::surface::get_desktop_zoom,
            commands::surface::set_window_title,
            commands::surface::get_window_bounds,
            commands::surface::set_window_bounds,
            commands::rpc::get_rpc_endpoint,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build zcode-tauri")
        .run(move |app_handle, event| {
            // Orderly shutdown. Electron needed a two-phase barrier with a
            // deadline because `before-quit` is synchronous and could only be
            // prevented, not deferred; Tauri exposes `ExitRequested`, which can
            // be prevented once and then released cleanly.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app_handle.state::<SharedAppState>();
                // Drain exactly once, keyed on its own latch rather than
                // `quit_flag`. An explicit quit sets `quit_flag` first (otherwise
                // window.rs swallows the close as close-to-tray), so keying the
                // drain on that flag meant every explicit quit skipped it and the
                // supervised children never shut down cleanly.
                if state.take_shutdown_drain() {
                    app_handle.state::<Arc<Supervisor>>().shutdown_all();
                }
                let _ = api;
            }
        });
}

/// Extract the first `zcode://` URL from a process argv vector.
///
/// Electron's `desktopDeepLinkUrl.ts` concatenated adjacent argv entries and
/// applied repeated URL-decoding rounds because launchers split the URL across
/// arguments. That leniency is retained here, but the result is treated as
/// untrusted input: it is routed to the renderer as a callback event and never
/// acted on directly by the Rust side.
#[cfg(desktop)]
fn deep_link_url_from_argv(argv: &[String]) -> Option<String> {
    let joined = argv.join(" ");
    for segment in joined.split(|c: char| c.is_whitespace() || c == '\0') {
        if segment.starts_with("zcode://") {
            return Some(segment.to_string());
        }
    }
    None
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_env("ZCODE_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).with_target(true).try_init();
}
