//! `zcode-packaging` — the sole decision owner for the `.node` payload.
//!
//! Spec: docs/specs/rust-native-packaging.md
//!
//! JavaScript and shell in the build chain may spawn this tool and move the files it
//! names. They may not enumerate crates, compute a platform suffix, decide whether a
//! binary ships, or decide whether a staged tree is acceptable (P1). If this tool
//! fails, the build fails — there is no JavaScript path that takes over, because there
//! is no JavaScript path that could (P2).

mod inventory;
mod plan;
mod target;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use inventory::Classification;
use plan::Surface;
use target::Target;

const USAGE: &str = "\
zcode-packaging — owner of the .node packaging contract

USAGE:
  zcode-packaging plan   --target <os>-<arch|host> --surface <surface> --out <plan.json>
                          [--release-dir <dir>] [--repo-root <dir>]
  zcode-packaging stage  --plan <plan.json> [--source-dir <dir>] [--dest <dir>]
  zcode-packaging verify --plan <plan.json> [--root <dir>]
  zcode-packaging gen-targets [--check]
  zcode-packaging inventory [--repo-root <dir>]
  zcode-packaging sea-assets --target <os>-<arch|host> --out-manifest <file> --assets-out <file>
                            [--repo-root <dir>] [--release-dir <dir>]

SURFACES: desktop-agent | sea | dev
TARGETS:  darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-arm64 win32-x64, or `host`

EXIT CODES:
  0  success
  1  unexpected failure
  2  a live crate has no artifact for the target
  3  a staged file did not match its source hash
  4  a staged tree does not satisfy the plan
 64  bad arguments or unsupported target
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(subcommand) = args.first().map(String::as_str) else {
        eprint!("{USAGE}");
        return ExitCode::from(plan::exit::USAGE as u8);
    };

    let result = match subcommand {
        "plan" => cmd_plan(&args[1..]),
        "stage" => cmd_stage(&args[1..]),
        "verify" => cmd_verify(&args[1..]),
        "gen-targets" => cmd_gen_targets(&args[1..]),
        "inventory" => cmd_inventory(&args[1..]),
        "sea-assets" => cmd_sea_assets(&args[1..]),
        "--help" | "-h" | "help" => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        "--version" | "-V" => {
            println!("zcode-packaging {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        other => {
            eprintln!("[zcode-packaging] unknown subcommand `{other}`\n\n{USAGE}");
            return ExitCode::from(plan::exit::USAGE as u8);
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::Usage(message)) => {
            eprintln!("[zcode-packaging] {message}\n\n{USAGE}");
            ExitCode::from(plan::exit::USAGE as u8)
        }
        Err(Failure::Inventory(source)) => {
            eprintln!("[zcode-packaging] inventory error: {source}");
            ExitCode::from(plan::exit::FAILURE as u8)
        }
        Err(Failure::Plan { code, source }) => {
            eprintln!("[zcode-packaging] {source}");
            ExitCode::from(code as u8)
        }
    }
}

/// A failure that already knows which exit code it maps to (§6).
enum Failure {
    Usage(String),
    Inventory(inventory::InventoryError),
    Plan {
        code: i32,
        source: plan::PlanError,
    },
}

impl From<inventory::InventoryError> for Failure {
    fn from(source: inventory::InventoryError) -> Self {
        Failure::Inventory(source)
    }
}

impl From<plan::PlanError> for Failure {
    fn from(source: plan::PlanError) -> Self {
        let code = match &source {
            plan::PlanError::MissingArtifact { .. } => plan::exit::MISSING_ARTIFACT,
            plan::PlanError::CopyMismatch { .. } => plan::exit::COPY_MISMATCH,
            plan::PlanError::Verify { .. } => plan::exit::VERIFY_FAILED,
            _ => plan::exit::FAILURE,
        };
        Failure::Plan { code, source }
    }
}

/// Parses `--key value` pairs. Deliberately hand-rolled: a clap dependency would be
/// the only new third-party crate in a tool whose whole point is to add none.
struct Args {
    values: Vec<(String, String)>,
    flags: Vec<String>,
}

impl Args {
    fn parse(raw: &[String]) -> Result<Self, Failure> {
        let mut values = Vec::new();
        let mut flags = Vec::new();
        let mut index = 0;
        while index < raw.len() {
            let arg = &raw[index];
            if !arg.starts_with("--") {
                return Err(Failure::Usage(format!("unexpected argument `{arg}`")));
            }
            if let Some((key, value)) = arg.split_once('=') {
                values.push((key.trim_start_matches('-').to_string(), value.to_string()));
                index += 1;
                continue;
            }
            let key = arg.trim_start_matches('-').to_string();
            match raw.get(index + 1) {
                Some(next) if !next.starts_with("--") => {
                    values.push((key, next.clone()));
                    index += 2;
                }
                _ => {
                    flags.push(key);
                    index += 1;
                }
            }
        }
        Ok(Args { values, flags })
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn require(&self, key: &str) -> Result<&str, Failure> {
        self.get(key)
            .ok_or_else(|| Failure::Usage(format!("missing required flag `--{key}`")))
    }

    fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }
}

/// The repository root, inferred from `--repo-root` or by walking up from the cwd.
///
/// The walk-up matters: `scripts/build-native.sh` runs with the cwd set to
/// `packages/rust`, and `stage` therefore has to find the *repository* root, not treat
/// `packages/rust` as the root. Deriving it from the located rust package makes every
/// surface path correct regardless of where the tool was invoked.
fn resolve_repo_root(args: &Args) -> Result<PathBuf, Failure> {
    if let Some(explicit) = args.get("repo-root") {
        let path = PathBuf::from(explicit);
        if !path.is_dir() {
            return Err(Failure::Usage(format!(
                "--repo-root {} is not a directory",
                path.display()
            )));
        }
        return Ok(path.canonicalize().unwrap_or(path));
    }
    let cwd = std::env::current_dir().map_err(|source| Failure::Plan {
        code: plan::exit::FAILURE,
        source: plan::PlanError::Io {
            path: PathBuf::from("."),
            source,
        },
    })?;
    let rust_root = inventory::find_rust_root(&cwd).map_err(Failure::Inventory)?;
    repo_root_from_rust_root(&rust_root)
}

/// `packages/rust` -> the directory that contains `packages/`.
fn repo_root_from_rust_root(rust_root: &Path) -> Result<PathBuf, Failure> {
    rust_root
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            Failure::Usage(format!(
                "cannot derive the repository root from {}",
                rust_root.display()
            ))
        })
}

/// The cargo release directory holding a target's artifacts.
///
/// Cargo writes to `target/<triple>/release` for a cross build and to plain
/// `target/release` for a native one. Both layouts exist in practice — `build-native.sh`
/// read `target/release`, and a cross build needs the triple-scoped path — so both are
/// probed, triple-scoped first.
///
/// This is layout resolution, not an artifact fallback: when neither directory exists,
/// or when the chosen one lacks a live crate's `.so`, `plan` still fails (P2). Nothing is
/// ever silently skipped to make a build pass.
fn resolve_release_dir(rust_root: &Path, target: &Target) -> Result<PathBuf, plan::PlanError> {
    let triple_scoped = rust_root.join("target").join(target.triple).join("release");
    if triple_scoped.is_dir() {
        return Ok(triple_scoped);
    }
    let native = rust_root.join("target").join("release");
    if native.is_dir() {
        return Ok(native);
    }
    Err(plan::PlanError::Io {
        path: rust_root.join("target"),
        source: std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "no cargo release directory for {} (looked in {} and {})",
                target.key,
                triple_scoped.display(),
                native.display()
            ),
        ),
    })
}

/// Default cargo release directory for a target.
fn default_release_dir(rust_root: &Path, target: &Target) -> Result<PathBuf, plan::PlanError> {
    resolve_release_dir(rust_root, target)
}

fn cmd_plan(raw: &[String]) -> Result<(), Failure> {
    let args = Args::parse(raw)?;
    let target = Target::resolve(args.require("target")?)
        .map_err(|source| Failure::Usage(source.to_string()))?;
    let surface_raw = args.require("surface")?;
    let surface = Surface::parse(surface_raw)
        .ok_or_else(|| Failure::Usage(format!("unknown surface `{surface_raw}`")))?;
    let out = PathBuf::from(args.require("out")?);

    let repo_root = resolve_repo_root(&args)?;
    let rust_root = inventory::find_rust_root(&repo_root)?;
    let release_dir = match args.get("release-dir") {
        Some(explicit) => PathBuf::from(explicit),
        None => default_release_dir(&rust_root, &target)?,
    };

    let inv = inventory::build(&repo_root)?;
    let plan = plan::build_plan(&target, surface, &inv, &release_dir)?;

    // P2: an empty payload is never correct. Either every live crate lost its consumer
    // in the same change that touched the build, or the importer scan failed to run from
    // this cwd. Both must stop the build rather than emit a valid-looking empty plan.
    if plan.entries.is_empty() {
        return Err(Failure::Plan {
            code: plan::exit::MISSING_ARTIFACT,
            source: plan::PlanError::Verify {
                problems: vec![
                    "the live set is empty: no crate has an importer of its @zcode/rust \
                     subpath. Refusing to write a plan that would package nothing."
                        .to_string(),
                ],
            },
        });
    }

    // Always print the decision, so a build log records what shipped and what did not.
    println!(
        "[zcode-packaging] plan {} / {} -> {}",
        plan.target,
        plan.surface.as_str(),
        out.display()
    );
    if matches!(surface, plan::Surface::Sea) {
        // The SEA build names its plan file with its own vocabulary (`win-x64` where this
        // crate says `win32-x64`), so the build log states the spelling the build must use.
        // `Target::resolve` accepts both, and the round trip is asserted in the sea_contract
        // tests; without this line a mismatch would only surface as a missing plan file.
        println!(
            "[zcode-packaging] the SEA build addresses this target as {:?}; \
             pass --target {:?} to sea-assets for a cross-platform build",
            target.sea_key(),
            target.sea_key(),
        );
    }
    for entry in &plan.entries {
        println!(
            "  ship   {:<24} {:>9} bytes  {}",
            entry.crate_name, entry.bytes, entry.dest
        );
    }
    for skip in &plan.skipped {
        println!("  skip   {:<24} {}", skip.crate_name, skip.reason);
    }
    if !inv.cdylib_without_subpath.is_empty() {
        println!(
            "[zcode-packaging] note: cdylib crate(s) with no @zcode/rust subpath export: {}",
            inv.cdylib_without_subpath.join(", ")
        );
    }

    plan::write_plan(&plan, &out)?;
    Ok(())
}

fn cmd_stage(raw: &[String]) -> Result<(), Failure> {
    let args = Args::parse(raw)?;
    let plan = plan::read_plan(&PathBuf::from(args.require("plan")?))?;

    let repo_root = resolve_repo_root(&args)?;
    let rust_root = inventory::find_rust_root(&repo_root)?;
    // A plan always records a concrete `${os}-${arch}` key, so `host` never appears here.
    let target = Target::by_key(&plan.target)
        .map_err(|source| Failure::Usage(source.to_string()))?;

    let source_dir = match args.get("source-dir") {
        Some(explicit) => PathBuf::from(explicit),
        None => default_release_dir(&rust_root, &target)?,
    };
    let dest = match args.get("dest") {
        Some(explicit) => PathBuf::from(explicit),
        None => plan.surface
            .destination_root(&repo_root, &target)
            .ok_or_else(|| {
                Failure::Usage(format!(
                    "the `{}` surface has no measured default destination; pass --dest <dir> \
                     (see docs/specs/rust-native-packaging.md risk R8)",
                    plan.surface.as_str()
                ))
            })?,
    };

    let written = plan::stage(&plan, &source_dir, &dest)?;
    println!(
        "[zcode-packaging] staged {} file(s) into {}",
        written.len(),
        dest.display()
    );
    Ok(())
}

fn cmd_verify(raw: &[String]) -> Result<(), Failure> {
    let args = Args::parse(raw)?;
    let plan = plan::read_plan(&PathBuf::from(args.require("plan")?))?;

    let repo_root = resolve_repo_root(&args)?;
    let target = Target::by_key(&plan.target)
        .map_err(|source| Failure::Usage(source.to_string()))?;

    let root = match args.get("root") {
        Some(explicit) => PathBuf::from(explicit),
        None => plan.surface
            .destination_root(&repo_root, &target)
            .ok_or_else(|| {
                Failure::Usage(format!(
                    "the `{}` surface has no measured default destination; pass --root <dir> \
                     (see docs/specs/rust-native-packaging.md risk R8)",
                    plan.surface.as_str()
                ))
            })?,
    };

    plan::verify(&plan, &root)?;
    println!(
        "[zcode-packaging] verified {} entr(ies) in {}",
        plan.entries.len(),
        root.display()
    );
    Ok(())
}

/// Emits the SEA asset list and the manifest that makes runtime extraction verifiable.
///
/// A `.node` cannot be `require()`-d straight out of a SEA blob — the blob is reached via
/// `sea.getRawAsset()`, not the filesystem. The runtime therefore extracts the bytes to a
/// content-addressed cache before loading them, mirroring
/// `apps/zcode-cli/packages/cli/src/sea-playwright-runtime.ts`. This command is the
/// build-time half: the file list and every sha256 come from the verified plan (P1, P6).
fn cmd_sea_assets(raw: &[String]) -> Result<(), Failure> {
    let args = Args::parse(raw)?;
    let manifest_out = PathBuf::from(args.require("out-manifest")?);
    let assets_out = PathBuf::from(args.require("assets-out")?);

    let repo_root = resolve_repo_root(&args)?;
    let rust_root = inventory::find_rust_root(&repo_root)?;
    let target = Target::resolve(args.require("target")?)
        .map_err(|source| Failure::Usage(source.to_string()))?;

    // The plan is built here rather than read from a path the caller had to construct.
    // A caller-supplied plan path is exactly the seam where a stale or mismatched plan
    // slips in, and the SEA build already knows its target — so it should not have to
    // agree with a shell script about where the plan lives.
    let release_dir = match args.get("release-dir") {
        Some(explicit) => PathBuf::from(explicit),
        None => default_release_dir(&rust_root, &target)?,
    };
    let inv = inventory::build(&repo_root)?;
    let plan = plan::build_plan(&target, Surface::Sea, &inv, &release_dir)?;
    if plan.entries.is_empty() {
        return Err(Failure::Plan {
            code: plan::exit::MISSING_ARTIFACT,
            source: plan::PlanError::Verify {
                problems: vec![
                    "refusing to embed an empty native payload into a SEA blob".to_string(),
                ],
            },
        });
    }

    let (files, manifest) = plan::build_sea_assets(&plan);

    // The bytes to embed are the staged `.node` files (`build-native.sh` writes them to the
    // dev surface root), not the cargo `.so`/`.dylib` the plan was built from. Re-verify
    // each one against the plan before embedding: a stale plan must fail here rather than
    // ship a blob whose payload no longer matches its own manifest.
    let staged_root = Surface::Dev
        .destination_root(&repo_root, &target)
        .ok_or_else(|| {
            Failure::Usage("the dev surface must have a destination root".to_string())
        })?;
    for entry in &plan.entries {
        let path = staged_root.join(&entry.dest);
        let actual = plan::sha256_file(&path)?;
        if actual != entry.sha256 {
            return Err(Failure::Plan {
                code: plan::exit::COPY_MISMATCH,
                source: plan::PlanError::CopyMismatch {
                    dest: path,
                    expected_sha256: entry.sha256.clone(),
                    actual_sha256: actual,
                },
            });
        }
    }

    // The assets map shape the SEA config's `assets` field expects: key -> source path.
    let mut assets = serde_json::Map::new();
    for file in &files {
        assets.insert(
            file.key.clone(),
            serde_json::Value::String(staged_root.join(&file.name).display().to_string()),
        );
    }

    write_json_file(&manifest_out, &manifest)?;
    write_json_file(&assets_out, &serde_json::Value::Object(assets))?;

    println!(
        "[zcode-packaging] {} native asset(s) for {} -> {}",
        files.len(),
        plan.target,
        manifest_out.display()
    );
    println!(
        "[zcode-packaging] runtime must read the manifest under the asset key {:?} \
         (each binary under {:?}<name>); this string is also hardcoded in \
         apps/zcode-cli/packages/cli/src/sea-native-runtime.ts and asserted equal by the \
         sea_contract tests",
        plan::SEA_MANIFEST_ASSET_KEY,
        plan::SEA_NATIVE_ASSET_PREFIX,
    );
    println!(
        "[zcode-packaging] runtime cache key: {} (the extractor must create this directory)",
        manifest.cache_key
    );
    Ok(())
}

/// Pretty-prints `value` to `path`, creating the parent directory.
///
/// The SEA staging directory is created by the caller, but the tool must not depend on
/// that: writing into a directory that does not exist yet is the normal case for a fresh
/// build, and failing with a bare `No such file or directory` would name neither the
/// payload nor the tool.
fn write_json_file<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), plan::PlanError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|source| plan::PlanError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|source| plan::PlanError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    std::fs::write(path, format!("{text}\n")).map_err(|source| plan::PlanError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn cmd_gen_targets(raw: &[String]) -> Result<(), Failure> {
    let args = Args::parse(raw)?;
    let rendered = target::render_generated_ts();
    let out = PathBuf::from(
        args.get("out")
            .unwrap_or("packages/rust/src/native-targets.generated.ts"),
    );

    if args.has("check") {
        let existing = std::fs::read_to_string(&out).map_err(|source| Failure::Plan {
            code: plan::exit::FAILURE,
            source: plan::PlanError::Io {
                path: out.clone(),
                source,
            },
        })?;
        if existing != rendered {
            eprintln!(
                "[zcode-packaging] {} is stale.\n  run: cargo run -p zcode-packaging -- gen-targets",
                out.display()
            );
            // Show the first differing line so the fix is obvious.
            for (index, (want, have)) in rendered.lines().zip(existing.lines()).enumerate() {
                if want != have {
                    eprintln!("  line {}: expected `{want}`, found `{have}`", index + 1);
                    break;
                }
            }
            return Err(Failure::Plan {
                code: plan::exit::VERIFY_FAILED,
                source: plan::PlanError::Verify {
                    problems: vec![format!("{} is out of date", out.display())],
                },
            });
        }
        println!("[zcode-packaging] {} is up to date", out.display());
        return Ok(());
    }

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|source| Failure::Plan {
            code: plan::exit::FAILURE,
            source: plan::PlanError::Io {
                path: parent.to_path_buf(),
                source,
            },
        })?;
    }
    std::fs::write(&out, &rendered).map_err(|source| Failure::Plan {
        code: plan::exit::FAILURE,
        source: plan::PlanError::Io {
            path: out.clone(),
            source,
        },
    })?;
    println!("[zcode-packaging] wrote {}", out.display());
    Ok(())
}

fn cmd_inventory(raw: &[String]) -> Result<(), Failure> {
    let args = Args::parse(raw)?;
    let repo_root = resolve_repo_root(&args)?;
    let inv = inventory::build(&repo_root)?;

    let live = inv.live_binaries();
    println!(
        "[zcode-packaging] {} crate(s), {} shipping",
        inv.crates.len(),
        live.len()
    );
    for crate_info in &inv.crates {
        match inv.classifications.get(&crate_info.name) {
            Some(Classification::Live { importers, .. }) => {
                println!(
                    "  ship   {:<24} {} importer(s): {}",
                    crate_info.name,
                    importers.len(),
                    importers.join(", ")
                );
            }
            Some(Classification::NoConsumer { subpath }) => {
                println!(
                    "  skip   {:<24} no importer of @zcode/rust/{subpath}  ({})",
                    crate_info.name, crate_info.manifest
                );
            }
            Some(Classification::NotCdylib) => {
                println!(
                    "  skip   {:<24} not a cdylib crate  ({})",
                    crate_info.name, crate_info.manifest
                );
            }
            Some(Classification::NoSubpath) => {
                println!(
                    "  skip   {:<24} no @zcode/rust subpath export  ({})",
                    crate_info.name, crate_info.manifest
                );
            }
            // Unreachable in practice: `build` classifies every workspace crate. Kept
            // so a future crate kind shows up as a real line rather than vanishing.
            None => {
                println!(
                    "  ??     {:<24} unclassified  ({})",
                    crate_info.name, crate_info.manifest
                );
            }
        }
    }
    if !inv.cdylib_without_subpath.is_empty() {
        println!(
            "[zcode-packaging] note: cdylib crate(s) reachable from TypeScript only if a subpath is added: {}",
            inv.cdylib_without_subpath.join(", ")
        );
    }
    Ok(())
}

#[cfg(test)]
mod sea_contract {
    //! The Rust constants the TypeScript SEA wrapper hardcodes must stay equal.
    //!
    //! `zcode-packaging` owns the SEA asset keys and the SEA spelling of a target, but the
    //! consumer of both is `packages/rust/src/sea-native-runtime.ts`, which cannot import a
    //! Rust constant. That makes silent drift possible: the manifest would be written under
    //! one key and read under another, and every packaged binary would fail its first
    //! `loadNative()` with "no such asset".
    //!
    //! These tests are what the two `dead_code` warnings on `plan.rs` and `target.rs` were
    //! really pointing at — the constants *are* used, by the TypeScript, and nothing was
    //! checking that.

    use std::path::{Path, PathBuf};

    use super::*;

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(4)
            .expect("crates/zcode-packaging is four levels below the repo root")
            .to_path_buf()
    }

    fn read(relative: &str) -> String {
        let path = repo_root().join(relative);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
    }

    #[test]
    fn the_runtime_wrapper_agrees_with_the_rust_manifest_key() {
        let runtime = read("apps/zcode-cli/packages/cli/src/sea-native-runtime.ts");
        let expected = plan::SEA_MANIFEST_ASSET_KEY;
        assert!(
            runtime.contains(&format!("\"{expected}\"")),
            "sea-native-runtime.ts does not name the manifest key {expected:?}; a mismatch \
             means every packaged binary fails its first loadNative()"
        );
    }

    #[test]
    fn the_runtime_wrapper_agrees_with_the_rust_asset_prefix() {
        let runtime = read("apps/zcode-cli/packages/cli/src/sea-native-runtime.ts");
        let expected = plan::SEA_NATIVE_ASSET_PREFIX;
        assert!(
            runtime.contains(&format!("\"{expected}\"")),
            "sea-native-runtime.ts does not name the asset prefix {expected:?}"
        );
    }

    #[test]
    fn the_sea_build_helper_agrees_with_the_rust_manifest_key() {
        let helper = read("apps/zcode-cli/packages/cli/scripts/sea-native-assets.mjs");
        let expected = plan::SEA_MANIFEST_ASSET_KEY;
        assert!(
            helper.contains(expected),
            "sea-native-assets.mjs does not name the manifest key {expected:?}"
        );
    }

    /// The SEA target spelling must round-trip, or the build writes a plan the tool will
    /// not look for. `win32-x64` on the Rust side, `win-x64` on the SEA side.
    #[test]
    fn the_sea_target_spelling_is_the_inverse_of_the_alias() {
        for target in target::TARGETS {
            let sea = target.sea_key();
            // Only Windows is spelled differently: the tool says `win32-x64` because that
            // is `process.platform`, while the SEA build says `win-x64`. Darwin and Linux
            // are identical in both vocabularies, so asserting they differ would be wrong.
            if target.key.starts_with("win32-") {
                assert_ne!(sea, target.key, "{sea} should differ from the Node spelling");
            } else {
                assert_eq!(sea, target.key, "{sea} should be spelled identically");
            }
            assert_eq!(
                target::Target::resolve(&sea).unwrap().key,
                target.key,
                "{sea} must resolve back to {}",
                target.key
            );
        }
        // And the SEA build's own vocabulary must be a subset of what the tool accepts.
        let sea_targets = read("apps/zcode-cli/packages/cli/scripts/sea-targets.mjs");
        for raw in [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
            "win-arm64",
            "win-x64",
        ] {
            assert!(
                sea_targets.contains(raw),
                "sea-targets.mjs no longer lists {raw}"
            );
            assert!(
                target::Target::resolve(raw).is_ok(),
                "zcode-packaging cannot resolve the SEA target {raw}"
            );
        }
    }
}
