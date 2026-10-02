//! Linux graphics environment for the WebKitGTK webview.
//!
//! Tauri renders through WebKitGTK on Linux, and with the NVIDIA proprietary
//! driver its DMA-BUF renderer trips NVIDIA's explicit-sync path. That aborts
//! the GDK display a few hundred milliseconds after `setup()` returns:
//!
//! ```text
//! INFO zcode_tauri_lib: zcode-tauri ready
//! Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
//! ```
//!
//! `__NV_DISABLE_EXPLICIT_SYNC=1` disables exactly that one sync mode. It is
//! documented upstream as fixing the abort *without* a performance cost — the
//! webview stays GPU-accelerated — and it is inert on Mesa-based drivers. So it
//! is set unconditionally on Linux, on every launch, rather than probed,
//! remembered, and retried. There is no automatic degraded tier here: a host
//! whose window cannot come up gets a native escape hatch (`ZCODE_WEBKIT_*`
//! below), not a silent switch to a slower renderer.
//!
//! Ordering matters and is why this lives in `run()` instead of a
//! `tauri::Builder` hook: `libEGL_nvidia` reads the variable when it initializes
//! the EGL display, which happens when the webview is created — after `run()`
//! starts but before `setup()` returns. A hook that runs at `setup()` time is
//! already too late for anything the GTK stack opened on the way in.
//!
//! See `apps/zcode-tauri/PORT_STATUS.md` §"GPU rendering (WebKitGTK on NVIDIA)".

/// NVIDIA's explicit-sync opt-out. Read by `libEGL_nvidia` at display init.
const NV_DISABLE_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";

/// Force CPU rendering from the start; for a host with no working GL at all.
const FORCE_SOFTWARE: &str = "ZCODE_WEBKIT_SOFTWARE";
/// Skip the NVIDIA workaround entirely so the stock hardware path can be tested.
const FORCE_HARDWARE: &str = "ZCODE_WEBKIT_HARDWARE";

/// The environment a WebKitGTK launch needs, given the caller's overrides.
///
/// Pure so it can be unit-tested without mutating the process environment:
/// `set_var` is process-global and the test harness runs in parallel.
fn webkit_graphics_env(get: impl Fn(&str) -> Option<String>) -> Vec<(&'static str, &'static str)> {
    if get(FORCE_SOFTWARE).is_some() {
        return vec![
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
            ("LIBGL_ALWAYS_SOFTWARE", "1"),
        ];
    }
    if get(FORCE_HARDWARE).is_some() {
        return Vec::new();
    }
    // Never clobber a value the operator already exported: they have made an
    // explicit decision about this process's graphics path.
    if get(NV_DISABLE_EXPLICIT_SYNC).is_none() {
        return vec![(NV_DISABLE_EXPLICIT_SYNC, "1")];
    }
    Vec::new()
}

/// Apply [`webkit_graphics_env`] to the process, before the first EGL display is
/// initialized. A no-op off Linux, where WebKitGTK is not the renderer.
pub fn apply_webkit_graphics_env() {
    #[cfg(target_os = "linux")]
    {
        for (key, value) in webkit_graphics_env(|key| std::env::var(key).ok()) {
            std::env::set_var(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_from<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn sets_the_nvidia_workaround_by_default() {
        let vars = webkit_graphics_env(env_from(&[]));
        assert_eq!(vars, vec![(NV_DISABLE_EXPLICIT_SYNC, "1")]);
    }

    #[test]
    fn never_clobbers_an_explicit_value() {
        let vars = webkit_graphics_env(env_from(&[(NV_DISABLE_EXPLICIT_SYNC, "0")]));
        assert!(vars.is_empty());
    }

    #[test]
    fn force_hardware_skips_the_workaround() {
        let vars = webkit_graphics_env(env_from(&[(FORCE_HARDWARE, "1")]));
        assert!(vars.is_empty());
    }

    #[test]
    fn force_software_wins_over_force_hardware() {
        let vars = webkit_graphics_env(env_from(&[(FORCE_SOFTWARE, "1"), (FORCE_HARDWARE, "1")]));
        assert_eq!(
            vars,
            vec![
                ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
                ("LIBGL_ALWAYS_SOFTWARE", "1"),
            ]
        );
    }
}
