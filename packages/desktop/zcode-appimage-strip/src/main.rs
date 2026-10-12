//! CLI entry point for the AppImage strip tool.
//!
//! Two modes, matching the ported script:
//! - default: extract → run the safety gate → strip safe libs → repack in place → re-verify.
//! - `--check`: verify only (no repack); non-zero exit when the artifact is wrong. CI runs this as
//!   a hard gate.
//!
//! stdout strings are kept identical to the JavaScript so CI logs are unchanged. Any error exits 1
//! with an `[appimage-strip] ...` message on stderr.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use zcode_appimage_strip::appdir;
use zcode_appimage_strip::gate;

/// Path to the AppImage bundle directory, relative to `packages/desktop` (the CI working dir).
const APPIMAGE_DIR_REL: &str = "src-tauri/target/release/bundle/appimage";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("[appimage-strip] {err:#}");
            ExitCode::FAILURE
        }
    }
}

/// Dispatch between check-only and the full strip+repack flow.
fn run() -> anyhow::Result<()> {
    let check_only = std::env::args().skip(1).any(|a| a == "--check");
    let appimage_dir = PathBuf::from(APPIMAGE_DIR_REL);
    let app_image = appdir::find_app_image(&appimage_dir)?;

    if check_only {
        let inspection = appdir::inspect_app_image(&app_image)?;
        if !inspection.stripped_found.is_empty() {
            let names = basenames(&inspection.stripped_found);
            anyhow::bail!(
                "shadowing libs still present in {}: {names}",
                file_name(&app_image)
            );
        }
        if !inspection.missing_host.is_empty() {
            anyhow::bail!(
                "host sidecar files missing in {}: {}",
                file_name(&app_image),
                inspection.missing_host.join(", ")
            );
        }
        println!("[appimage-strip] check OK: no shadowing libs, host sidecar intact");
        return Ok(());
    }

    // Extract once to run the gate, so the "read-only check" and the "real delete" cannot diverge.
    let (work_dir, app_dir) = appdir::extract_app_image(&app_image)?;
    let to_strip = gate::select_safe_to_strip(&app_dir)?;

    if to_strip.is_empty() {
        println!("[appimage-strip] nothing safely strippable; AppImage left as-is");
        drop(work_dir); // explicit: keep the TempDir alive until after the gate, then clean up
        return Ok(());
    }

    let removed = appdir::strip_libs_from_app_dir(&app_dir, &to_strip)?;
    println!(
        "[appimage-strip] removing {} shadowing lib(s): {}",
        removed.len(),
        basenames(&removed)
    );

    appdir::repack_app_image(&app_dir, &app_image)?;
    drop(work_dir);

    let inspection = appdir::inspect_app_image(&app_image)?;
    if !inspection.stripped_found.is_empty() || !inspection.missing_host.is_empty() {
        anyhow::bail!(
            "post-repack verification failed: remaining={}, missingHost={}",
            inspection.stripped_found.len(),
            inspection.missing_host.len()
        );
    }
    println!(
        "[appimage-strip] repacked {} without shadowing system libs",
        file_name(&app_image)
    );
    Ok(())
}

/// Basename of a path as a lossy string, for log messages.
fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// Comma-joined basenames of a path list.
fn basenames(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| file_name(p))
        .collect::<Vec<_>>()
        .join(", ")
}
