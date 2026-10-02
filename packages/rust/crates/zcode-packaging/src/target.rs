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
/// The key strings are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
/// `win32-arm64`, `win32-x64` — the same vocabulary the staging tool, the zcode-cli SEA
/// packaging and the CI build matrix all speak. They once matched a table in
/// `packages/desktop/scripts/desktop-native-package-policy.mjs`; that Electron packaging
/// script went with Electron, and the keys are kept here as the single source.
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

    /// Resolves a `--target` value, accepting the literal `host` and the SEA spelling.
    ///
    /// The SEA build uses `win-x64` where Node and this crate use `win32-x64`
    /// (`apps/zcode-cli/packages/cli/scripts/sea-targets.mjs` maps between them). The
    /// alias is resolved here rather than in a shell script, so the platform table stays in
    /// one place (P4) and a seventh platform cannot be spelled two ways.
    pub fn resolve(raw: &str) -> Result<Self, UnknownTarget> {
        match raw {
            "host" => return Self::host(),
            "win-x64" => return Self::by_key("win32-x64"),
            "win-arm64" => return Self::by_key("win32-arm64"),
            "windows-x64" => return Self::by_key("win32-x64"),
            "windows-arm64" => return Self::by_key("win32-arm64"),
            _ => {}
        }
        Self::by_key(raw)
    }

    /// The SEA release vocabulary for this target, as `sea-targets.mjs` spells it.
    ///
    /// Used when writing a plan file whose name is derived from the target, so the SEA
    /// build finds it without either side re-deriving the mapping.
    pub fn sea_key(&self) -> String {
        self.key.replace("win32-", "win-")
    }

    /// The `${os}-${arch}` key of the host this process is running on.
    ///
    /// Rust and Node disagree on architecture spelling: `std::env::consts::ARCH` is
    /// `x86_64` / `aarch64`, while `process.arch` (and therefore every key in this
    /// table) is `x64` / `arm64`. Building the key by concatenation silently produced
    /// `linux-x86_64`, which matched nothing — caught by
    /// `host_resolves_on_every_supported_platform`.
    pub fn host() -> Result<Self, UnknownTarget> {
        Self::from_consts(std::env::consts::OS, std::env::consts::ARCH)
    }

    /// Builds the contract key from raw `std::env::consts` spellings.
    ///
    /// Both vocabularies need translating: `consts::ARCH` is `x86_64`/`aarch64` where
    /// every key uses Node's `x64`/`arm64`, and `consts::OS` is `windows`/`macos` where
    /// every key uses `win32`/`darwin` (`linux` happens to be spelled the same in both).
    /// The arch half was fixed when `host_resolves_on_every_supported_platform` caught
    /// `linux-x86_64`; the OS half only manifests on a Windows/macOS host —
    /// `plan --target host` died with `unsupported target "windows-x64"` on the
    /// windows-2022 CI runner (run 37050820634, issue #2) because `host()` built the
    /// key by raw concatenation, bypassing the `windows-x64` aliases `resolve()`
    /// accepts.
    ///
    /// 中文：`std::env::consts` 的 OS/ARCH 拼写与契约词表不一致 —— OS 给出
    /// "windows"/"macos"，词表是 "win32-*"/"darwin-*"。架构一半早已修正，
    /// OS 一半从未归一化，只在 Windows/macOS 宿主上暴露：CI windows-2022 上
    /// `plan --target host` 拼出 "windows-x64" 直接 exit 64（issue #2 的
    /// 第二个阻塞点）。归一化只发生在这里一处（P4 平台表单一来源）。
    fn from_consts(os: &str, arch: &str) -> Result<Self, UnknownTarget> {
        let os = match os {
            "windows" => "win32",
            "macos" => "darwin",
            other => other,
        };
        let arch = match arch {
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

    /// Regression guard for the OS half of the same mismatch. `host()` tests only
    /// exercise the machine they run on (CI is all Linux), so the windows/macos
    /// spellings would never be asserted there — this pins all six keys directly.
    ///
    /// 中文：host() 的测试只在运行机器上生效（CI 全是 Linux），Windows/macOS 的
    /// OS 拼写因此从未被断言 —— 此测试直接钉死全部六个键，防回归。
    #[test]
    fn consts_os_names_are_translated_to_contract_names() {
        let cases = [
            (("windows", "x86_64"), "win32-x64"),
            (("windows", "aarch64"), "win32-arm64"),
            (("macos", "x86_64"), "darwin-x64"),
            (("macos", "aarch64"), "darwin-arm64"),
            (("linux", "x86_64"), "linux-x64"),
            (("linux", "aarch64"), "linux-arm64"),
        ];
        for ((os, arch), expected) in cases {
            let resolved = Target::from_consts(os, arch)
                .unwrap_or_else(|e| panic!("{os}-{arch} must resolve: {e}"));
            assert_eq!(resolved.key, expected, "{os}-{arch}");
        }
    }

    #[test]
    fn resolve_is_not_a_fuzzy_match() {
        // P2: a near-miss must fail, not be coerced to the closest target.
        assert!(Target::resolve("darwin").is_err());
        assert!(Target::resolve("linux").is_err());
        assert!(Target::resolve("win32").is_err());
    }

    /// The SEA build spells Windows targets `win-*`; the tool must accept that without a
    /// second table existing anywhere in JavaScript.
    #[test]
    fn sea_spellings_resolve_to_the_same_target() {
        for (sea, canonical) in [
            ("win-x64", "win32-x64"),
            ("win-arm64", "win32-arm64"),
            ("windows-x64", "win32-x64"),
            ("windows-arm64", "win32-arm64"),
        ] {
            assert_eq!(Target::resolve(sea).unwrap().key, canonical, "{sea}");
        }
        // Non-Windows targets keep their spelling on both sides.
        assert_eq!(Target::resolve("linux-x64").unwrap().sea_key(), "linux-x64");
    }

    #[test]
    fn sea_key_is_the_inverse_of_the_alias() {
        for target in TARGETS {
            let sea = target.sea_key();
            assert_eq!(
                Target::resolve(&sea).unwrap().key,
                target.key,
                "{sea} did not round-trip"
            );
        }
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
