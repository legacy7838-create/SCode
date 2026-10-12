# PORTING.md — strip-appimage-system-libs: JS → Rust

Mechanical port of `packages/desktop/scripts/strip-appimage-system-libs.mjs` to the
`zcode-appimage-strip` crate. Goal: the Linux AppImage build step carries **zero JavaScript**.
Behavior parity, not redesign.

Source of truth for behavior was the **working-tree** version of the `.mjs` (527 lines), which is
newer than `HEAD` (361 lines) and adds the `verifyHostSatisfiesDependents` gate, the
`libpcre2-8.so.0` consideration, and the reworked `inspectAppImage`. Port the working-tree logic.

## Function map

| JS function                     | Rust                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| `findAppImage`                  | `appdir::find_app_image`                                           |
| `readElfNeeded`                 | `elf::read_needed`                                                 |
| `readElfVersionNeeds`           | `elf::read_version_needs` (+ pure `parse_version_needs_text`)      |
| `readElfVersionDefines`         | `elf::read_version_defines`                                        |
| `hostLibPath`                   | `gate::host_lib_path` (+ pure `parse_ldconfig_for`)                |
| `collectDependentsNeeding`      | `gate::collect_dependents_needing`                                 |
| `verifyHostSatisfiesDependents` | `gate::verify_host_satisfies_dependents` (+ pure `host_satisfies`) |
| `selectSafeToStrip`             | `gate::select_safe_to_strip`                                       |
| `stripLibsFromAppDir`           | `appdir::strip_libs_from_app_dir`                                  |
| `extractAppImage`               | `appdir::extract_app_image`                                        |
| `resolveAppimagetool`           | `appdir::resolve_appimagetool` (+ `find_on_path` replaces `which`) |
| `repackAppImage`                | `appdir::repack_app_image`                                         |
| `inspectAppImage`               | `appdir::inspect_app_image`                                        |
| `main` (`--check`)              | `src/main.rs::run`                                                 |

## Design decisions

- **Shell out to `readelf`/`ldconfig`, do not parse ELF directly.** The gate's semantics are defined
  by `readelf` text output, including its quirks (`Not an ELF file` → empty dependency list;
  `.gnu.version_d` includes the `BASE` entry; only `Name: ... Flags:` lines count as version
  _needs_). An ELF crate would be a second, divergent implementation of those rules for no runtime
  win on a one-shot scan. Using the same external tools keeps parity and the same failure modes.
- **`tempfile::TempDir` replaces `mkdtempSync` + `finally { rmSync }`.** Cleanup is RAII, so an early
  `?` return still removes the extract directory.
- **`thiserror` `StripError`** carries the same message text as the JS `throw`s so operators see
  identical `[appimage-strip] ...` diagnostics. The `[appimage-strip]` prefix is added once in
  `main.rs`, exactly as before.

## Parity notes (deliberately preserved, not "fixed")

- **`.gnu.version_d` BASE inclusion** — `read_version_defines` collects every `Name:` inside the
  definition section, including `BASE`. The `host_defines.len() <= 1` test treats "only BASE" as an
  unversioned host, matching the JS.
- **`ldconfig -p` first-match-wins** — `parse_ldconfig_for` returns the first matching line.
- **Exact SONAME token match** — the JS regex anchors the SONAME before `=>`; the Rust parser also
  requires the token before the ABI paren to equal the SONAME, so `libcrypto.so.3` never matches
  `libcrypto.so.30` (the JS regex `\s<soname>\s` already implied a boundary; this makes it explicit
  and adds a test).
- **`stdio: inherit` vs capture** — the AppImage and `appimagetool` children inherit stdout/stderr
  (`Command::status()`); `readelf`/`ldconfig` are captured (`Command::output()`), as in JS.
- **Repack write-then-rename** — `<out>.stripped` then `fs::rename` over the original, matching
  `renameSync`'s same-filesystem atomic replace.
- **aarch64 multiarch lib dir is NOT scanned** — `LIB_ROOTS` is the x86_64 path list verbatim. This
  is current behavior; preserved rather than silently changed. If aarch64 AppImage builds are added,
  revisit this list.
- **Hardcoded `ARCH` selection** — the JS used `process.arch === "arm64"`; the Rust uses
  `cfg!(target_arch = "aarch64")`, which is equivalent for a natively-built tool.

## Verification

- `cargo test` — 16 unit tests over the pure parsers, the host-satisfies verdict, `ldconfig`
  parsing, `find_app_image`, and `strip_libs_from_app_dir`. No real AppImage or `readelf` needed.
- `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` — clean.
- End-to-end (extract → gate → strip → repack → verify) requires a built AppImage and
  `appimagetool`; not exercised in this environment (no `appimagetool` on `PATH`). The CI `appimage`
  job is the end-to-end gate.
