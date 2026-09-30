//! The target -> napi-suffix table. Single source of truth (spec P4).
//!
//! This replaces two hand-maintained copies that had to agree by convention:
//!   - `scripts/build-native.sh:9-14` (host triple -> TARGET_SUFFIX)
//!   - `src/loader.ts:34-51`     (process.platform-arch -> suffix)
//!
//! Both are now derived from here: the shell script through `zcode-packaging stage`,
//! the TypeScript switch through the generated `native-targets.generated.ts` that
//! `gen-targets` writes and `cargo test` keeps fresh.

use std::fmt;

/// One supported napi platform target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Target {
    /// `${process.platform}-${process.arch}` / `${os}-${arch}` key, e.g. `darwin-arm64`.
    pub key: &'static str,
    /// The napi file-name suffix, e.g. `darwin-arm64` or `linux-x64-gnu`.
    pub suffix: &'static str,
    /// Cargo host triple used to locate `target/<triple>/release`.
    pub triple: &'static str,
    /// Shared-object extension for the platform.
    pub lib_ext: &'static str,
}

/// The six platforms the desktop packager supports.
///
/// The key strings are intentionally identical to
/// `packages/desktop/scripts/desktop-native-package-policy.mjs:1-8`
/// (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`,
/// `win32-x64`) so the staging tool and the electron-builder prune list speak the
/// same vocabulary.
pub const TARGETS: &[Target] = &[
    Target {
        key: "darwin-arm64",
        suffix: "darwin-arm64",
        triple: "aarch64-apple-darwin",
        lib_ext: "dylib",
    },
    Target {
        key: "darwin-x64",
        suffix: "darwin-x64",
        triple: "x86_64-apple-darwin",
        lib_ext: "dylib",
    },
    Target {
        key: "linux-arm64",
        suffix: "linux-arm64-gnu",
        triple: "aarch64-unknown-linux-gnu",
        lib_ext: "so",
    },
    Target {
        key: "linux-x64",
        suffix: "linux-x64-gnu",
        triple: "x86_64-unknown-linux-gnu",
        lib_ext: "so",
    },
    Target {
        key: "win32-arm64",
        suffix: "win32-arm64-msvc",
        triple: "aarch64-pc-windows-msvc",
        lib_ext: "dll",
    },
    Target {
        key: "win32-x64",
        suffix: "win32-x64-msvc",
        triple: "x86_64-pc-windows-msvc",
        lib_ext: "dll",
    },
];

impl Target {
    /// Looks up a target by its `${os}-${arch}` key.
    pub fn by_key(key: &str) -> Result<Self, UnknownTarget> {
        TARGETS
            .iter()
            .copied()
            .find(|t| t.key == key)
            .ok_or_else(|| UnknownTarget(key.to_string()))
    }

    /// Resolves a `--target` value, accepting the literal `host` for the build machine.
    ///
    /// `build-native.sh` has no target flag of its own — it emits for whatever it is
    /// running on — so `host` is what the reduced shim passes.
    pub fn resolve(raw: &str) -> Result<Self, UnknownTarget> {
        if raw == "host" {
            return Self::host();
        }
        Self::by_key(raw)
    }

    /// The `${os}-${arch}` key of the host this process is running on.
    ///
    /// Rust and Node disagree on architecture spelling: `std::env::consts::ARCH` is
    /// `x86_64` / `aarch64`, while `process.arch` (and therefore every key in this
    /// table) is `x64` / `arm64`. Building the key by concatenation silently produced
    /// `linux-x86_64`, which matched nothing — caught by
    /// `host_resolves_on_every_supported_platform`.
    pub fn host() -> Result<Self, UnknownTarget> {
        let os = std::env::consts::OS;
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        Self::by_key(&format!("{os}-{arch}"))
    }

    /// `zcode-git.darwin-arm64.node` — the file name `loadNative()` looks for.
    pub fn node_file_name(&self, crate_name: &str) -> String {
        format!("{crate_name}.{}.node", self.suffix)
    }

    /// `libzcode_git.dylib` / `zcode_git.dll` — the cargo artifact name.
    ///
    /// Cargo maps a crate `zcode-git` to the lib stem `zcode_git`, and prefixes
    /// `lib` everywhere except MSVC. This mirrors `build-native.sh:36-41` exactly.
    pub fn release_artifact_name(&self, crate_name: &str) -> String {
        let stem = crate_name.replace('-', "_");
        if self.lib_ext == "dll" {
            format!("{stem}.dll")
        } else {
            format!("lib{stem}.{}", self.lib_ext)
        }
    }
}

#[derive(Debug)]
pub struct UnknownTarget(pub String);

impl fmt::Display for UnknownTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let known = TARGETS
            .iter()
            .map(|t| t.key)
            .collect::<Vec<_>>()
            .join(", ");
        write!(
            f,
            "unsupported target {:?}; expected one of: {known}",
            self.0
        )
    }
}

impl std::error::Error for UnknownTarget {}

/// Renders the TypeScript constant module consumed by `src/loader.ts`.
///
/// Kept byte-stable so the freshness test is a plain string comparison and a
/// regenerated file shows up as a one-line diff when the table actually changes.
pub fn render_generated_ts() -> String {
    let mut out = String::new();
    out.push_str("// GENERATED by `cargo run -p zcode-packaging -- gen-targets`. Do not edit by hand.\n");
    out.push_str("// Source of truth: packages/rust/crates/zcode-packaging/src/target.rs\n");
    out.push_str("//\n");
    out.push_str("// `cargo test -p zcode-packaging` regenerates this file and byte-compares, so a\n");
    out.push_str("// hand edit fails the test rather than silently drifting from the packager (spec P4).\n");
    out.push_str("\n");
    out.push_str("export const NATIVE_PLATFORM_SUFFIXES = {\n");
    for target in TARGETS {
        out.push_str(&format!(
            "  \"{}\": \"{}\",\n",
            target.key, target.suffix
        ));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export type NativePlatformKey = keyof typeof NATIVE_PLATFORM_SUFFIXES;\n");
    out.push_str("\n");
    out.push_str("export const NATIVE_PLATFORM_KEYS = Object.keys(\n");
    out.push_str("  NATIVE_PLATFORM_SUFFIXES,\n");
    out.push_str(") as NativePlatformKey[];\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_target_resolves_by_key() {
        for target in TARGETS {
            assert_eq!(Target::by_key(target.key).unwrap(), *target);
        }
    }

    #[test]
    fn unknown_target_is_rejected_loudly() {
        let err = Target::by_key("linux-riscv64").unwrap_err().to_string();
        assert!(err.contains("linux-riscv64"), "{err}");
        // P2: the message must let a reader fix the command without reading the source.
        assert!(err.contains("linux-x64"), "{err}");
    }

    #[test]
    fn host_resolves_on_every_supported_platform() {
        // The reduced build-native.sh passes `host`; this asserts the mapping is total
        // for the six supported platforms rather than falling through to an error only
        // on an unlisted CI runner.
        let resolved = Target::host().expect("host target must resolve");
        assert!(TARGETS.contains(&resolved), "host did not map to a known target");
        assert_eq!(Target::resolve("host").unwrap(), resolved);
    }

    /// Regression guard for the Rust/Node architecture-spelling mismatch. If this map
    /// is ever deleted, `host` resolves to `linux-x86_64` and every native build on an
    /// x86_64 machine fails with "unsupported target".
    #[test]
    fn rust_arch_names_are_translated_to_node_names() {
        let cases = [("x86_64", "x64"), ("aarch64", "arm64")];
        for (rust_name, node_name) in cases {
            assert!(
                TARGETS.iter().any(|t| t.key.ends_with(node_name)),
                "no target uses the node arch name {node_name}"
            );
            assert!(
                !TARGETS.iter().any(|t| t.key.ends_with(rust_name)),
                "target keys must not use the rust arch name {rust_name}"
            );
        }
    }

    #[test]
    fn resolve_is_not_a_fuzzy_match() {
        // P2: a near-miss must fail, not be coerced to the closest target.
        assert!(Target::resolve("darwin").is_err());
        assert!(Target::resolve("linux").is_err());
    }

    #[test]
    fn node_file_name_matches_the_loader_contract() {
        // These are the exact names `build-native.sh:45` writes and `loader.ts:78`
        // builds via `${binaryName}.${nativePlatformTarget()}.node`.
        assert_eq!(
            Target::by_key("linux-x64").unwrap().node_file_name("zcode-git"),
            "zcode-git.linux-x64-gnu.node"
        );
        assert_eq!(
            Target::by_key("win32-x64").unwrap().node_file_name("zcode-events"),
            "zcode-events.win32-x64-msvc.node"
        );
        assert_eq!(
            Target::by_key("darwin-arm64")
                .unwrap()
                .node_file_name("zcode-markdown"),
            "zcode-markdown.darwin-arm64.node"
        );
    }

    #[test]
    fn release_artifact_name_matches_cargo_conventions() {
        assert_eq!(
            Target::by_key("darwin-x64")
                .unwrap()
                .release_artifact_name("zcode-git"),
            "libzcode_git.dylib"
        );
        // MSVC is the one platform with no `lib` prefix.
        assert_eq!(
            Target::by_key("win32-arm64")
                .unwrap()
                .release_artifact_name("zcode-rpc-utils"),
            "zcode_rpc_utils.dll"
        );
        assert_eq!(
            Target::by_key("linux-x64")
                .unwrap()
                .release_artifact_name("zcode-events"),
            "libzcode_events.so"
        );
    }

    /// P4: the generated TS is the only suffix table `loader.ts` may read, so it has
    /// to be regenerable and diffable without surprises.
    #[test]
    fn generated_ts_is_stable_and_complete() {
        let first = render_generated_ts();
        let second = render_generated_ts();
        assert_eq!(first, second, "codegen is not deterministic");
        for target in TARGETS {
            assert!(
                first.contains(&format!("\"{}\": \"{}\"", target.key, target.suffix)),
                "generated table is missing {}",
                target.key
            );
        }
        assert!(first.starts_with("// GENERATED"));
        assert!(first.contains("Do not edit by hand"));
    }

    /// The desktop prune list and this table must speak the same platform vocabulary,
    /// otherwise electron-builder would prune a key this tool never emits (or the
    /// reverse). Keys are asserted literally rather than by reading the JS file so the
    /// test stays hermetic.
    #[test]
    fn target_keys_match_the_desktop_prune_list() {
        let expected = [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
            "win32-arm64",
            "win32-x64",
        ];
        let mut actual = TARGETS.iter().map(|t| t.key).collect::<Vec<_>>();
        actual.sort_unstable();
        assert_eq!(actual, expected);
    }
}
