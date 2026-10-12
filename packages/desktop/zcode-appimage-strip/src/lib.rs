//! ZCode Linux AppImage post-bundle fix, ported to Rust.
//!
//! The build pipeline previously ran `scripts/strip-appimage-system-libs.mjs` after
//! `tauri build --bundles appimage`. That script removed the system libraries linuxdeploy bundles
//! into the AppImage which then shadow a newer (or unversioned) host copy via the AppRun
//! `LD_LIBRARY_PATH` prepend, and repacked in place. This crate is the drop-in replacement so the
//! pipeline carries zero JavaScript for the step.
//!
//! Module map (mirrors the JS functions):
//! - [`elf`]   — `readelf` text parsers (`readElfNeeded`, `readElfVersionNeeds`, `readElfVersionDefines`)
//! - [`gate`]  — the host-safety gate (`hostLibPath`, `collectDependentsNeeding`,
//!   `verifyHostSatisfiesDependents`, `selectSafeToStrip`)
//! - [`appdir`] — filesystem ops (`findAppImage`, `extractAppImage`, `stripLibsFromAppDir`,
//!   `resolveAppimagetool`, `repackAppImage`, `inspectAppImage`)

pub mod appdir;
pub mod elf;
pub mod error;
pub mod gate;

pub use error::StripError;
