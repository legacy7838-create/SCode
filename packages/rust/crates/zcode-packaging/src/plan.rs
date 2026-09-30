//! Plan generation, staging, and verification (spec §4.4, P2, P6, P7).
//!
//! The plan file is the single immutable handoff between the three phases (§4.5).
//! `plan` hashes the sources, `stage` copies and re-hashes, `verify` re-hashes the
//! destination. Each phase is a separate process, so a failure is attributable to
//! exactly one of them.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::inventory::Inventory;
use crate::target::Target;

/// Bumped whenever the plan shape changes. A plan written by an older tool is
/// rejected rather than half-understood.
pub const SCHEMA_VERSION: u32 = 1;

/// Process exit codes, one per failure class so CI can distinguish them (§6).
pub mod exit {
    /// Generic/unexpected failure.
    pub const FAILURE: i32 = 1;
    /// A live crate's artifact is absent for the target (`plan`).
    pub const MISSING_ARTIFACT: i32 = 2;
    /// A copy did not match its source hash (`stage`).
    pub const COPY_MISMATCH: i32 = 3;
    /// A staged tree does not satisfy the plan (`verify`).
    pub const VERIFY_FAILED: i32 = 4;
    /// Bad arguments / unsupported target.
    pub const USAGE: i32 = 64;
}

/// Where a packaged artifact keeps its binaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Surface {
    /// `bundled-agents/<os>-<arch>/native/` — the desktop agent bundle.
    ///
    /// Measured, not assumed: `zcode.cjs` is staged at
    /// `bundled-agents/<os>-<arch>/glm/zcode.cjs`, `@zcode/rust` is *inlined* into it
    /// (`apps/zcode-cli/packages/cli/scripts/build.mjs:19` excludes it from
    /// `resolveBuildExternal`), and `loader.ts:60` probes `join(here, "..", "native")`
    /// where `here` is the directory holding the bundle. That makes `native/` a
    /// **sibling of `glm/`**, not a child of it. See spec D2.
    DesktopAgent,
    /// The extracted single-file `zcode` SEA asset tree.
    ///
    /// Deliberately unresolved. Node's SEA embeds the assets from the generated config's
    /// `assets` map and extracts them **next to the executable**, not under
    /// `apps/zcode-cli/packages/cli/dist/`, and the extracted layout is flat rather than
    /// a `native/` subdirectory. The relationship between the bundle's `__filename` and
    /// the extracted assets is therefore not derivable from the source and has not been
    /// measured, so this tool refuses to invent a path: `--dest` is required (see
    /// `destination_root`). Spec risk R8.
    Sea,
    /// `packages/rust/` in place — the dev layout (`loader.ts:58`).
    Dev,
}

impl Surface {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "desktop-agent" => Some(Surface::DesktopAgent),
            "sea" => Some(Surface::Sea),
            "dev" => Some(Surface::Dev),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Surface::DesktopAgent => "desktop-agent",
            Surface::Sea => "sea",
            Surface::Dev => "dev",
        }
    }

    /// Destination root for a surface, relative to `repo_root`.
    ///
    /// `sea` returns `None` on purpose: the extraction layout is not yet measured, and
    /// guessing it would reproduce the exact class of bug this spec exists to prevent. The
    /// caller must pass `--dest`.
    pub fn destination_root(
        self,
        repo_root: &Path,
        target: &Target,
    ) -> Option<PathBuf> {
        match self {
            // Sibling of glm/, per the measurement in D2.
            Surface::DesktopAgent => Some(
                repo_root
                    .join("packages/desktop/bundled-agents")
                    .join(target.key)
                    .join("native"),
            ),
            Surface::Sea => None,
            Surface::Dev => Some(repo_root.join("packages/rust")),
        }
    }
}

/// One binary in the payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanEntry {
    /// Cargo package name, e.g. `zcode-git`.
    ///
    /// Serialized as `"crate"` to match the documented plan schema (§4.4); the Rust
    /// field cannot be named `crate` because that is a language keyword.
    #[serde(rename = "crate")]
    pub crate_name: String,
    /// Basename of the cargo artifact under `target/<triple>/release/`.
    pub source: String,
    /// Basename of the `.node` under the surface root.
    pub dest: String,
    pub bytes: u64,
    pub sha256: String,
}

/// A crate deliberately left out of the payload, with the reason.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkippedCrate {
    #[serde(rename = "crate")]
    pub crate_name: String,
    pub reason: String,
}

/// The plan document. `schemaVersion` first so a reader can dispatch on it.
///
/// `camelCase` + `deny_unknown_fields` are deliberate: the wire shape in §4.4 is
/// `schemaVersion`, not serde's default `schema_version`, and a plan carrying keys this
/// version does not understand is a stale artifact that must be rejected (P2) rather
/// than half-applied.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub schema_version: u32,
    pub target: String,
    pub suffix: String,
    pub surface: Surface,
    /// Every live binary, in stable (sorted) order.
    pub entries: Vec<PlanEntry>,
    pub skipped: Vec<SkippedCrate>,
    /// Consumers recorded for each live crate, so a reviewer can see the payload is
    /// justified without re-running the scan.
    pub consumers: BTreeMap<String, Vec<String>>,
}

#[derive(Debug)]
pub enum PlanError {
    MissingArtifact {
        crate_name: String,
        expected: PathBuf,
        found_in: Vec<String>,
    },
    CopyMismatch {
        dest: PathBuf,
        expected_sha256: String,
        actual_sha256: String,
    },
    Verify {
        problems: Vec<String>,
    },
    Io { path: PathBuf, source: std::io::Error },
    Json { path: PathBuf, source: serde_json::Error },
    SchemaVersion { found: u32 },
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::MissingArtifact {
                crate_name,
                expected,
                found_in,
            } => {
                write!(
                    f,
                    "live crate `{crate_name}` has no artifact for this target.\n  expected: {}\n  looked in: {}",
                    expected.display(),
                    if found_in.is_empty() {
                        "<empty release directory>".to_string()
                    } else {
                        found_in.join(", ")
                    }
                )
            }
            PlanError::CopyMismatch {
                dest,
                expected_sha256,
                actual_sha256,
            } => write!(
                f,
                "staged file does not match its source.\n  path: {}\n  expected sha256: {expected_sha256}\n  actual sha256:   {actual_sha256}",
                dest.display()
            ),
            PlanError::Verify { problems } => {
                write!(f, "{} verification problem(s):", problems.len())?;
                for problem in problems {
                    write!(f, "\n  - {problem}")?;
                }
                Ok(())
            }
            PlanError::Io { path, source } => {
                write!(f, "cannot access {}: {source}", path.display())
            }
            PlanError::Json { path, source } => {
                write!(f, "cannot parse {}: {source}", path.display())
            }
            PlanError::SchemaVersion { found } => write!(
                f,
                "plan schemaVersion {found} is not supported by this tool (expected {SCHEMA_VERSION}); regenerate it"
            ),
        }
    }
}

impl std::error::Error for PlanError {}

/// SHA-256 of a file, streamed so a 5 MB binary never lands in memory whole.
pub fn sha256_file(path: &Path) -> Result<String, PlanError> {
    let mut file = fs::File::open(path).map_err(|source| PlanError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .map_err(|source| PlanError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Builds a plan for `target`/`surface`.
///
/// P2: a live crate with no artifact is a hard error. The function collects *all*
/// missing crates before returning so one run reports the full set rather than making
/// the caller iterate.
pub fn build_plan(
    target: &Target,
    surface: Surface,
    inventory: &Inventory,
    release_dir: &Path,
) -> Result<Plan, PlanError> {
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    let mut consumers = BTreeMap::new();
    let mut missing: Vec<(String, PathBuf)> = Vec::new();
    let mut found_in: Vec<String> = Vec::new();

    for name in inventory.live_binaries() {
        let source_name = target.release_artifact_name(&name);
        let source_path = release_dir.join(&source_name);
        if !source_path.is_file() {
            missing.push((name.clone(), source_path.clone()));
            continue;
        }
        let bytes = fs::metadata(&source_path)
            .map_err(|source| PlanError::Io {
                path: source_path.clone(),
                source,
            })?
            .len();
        let sha256 = sha256_file(&source_path)?;
        entries.push(PlanEntry {
            dest: target.node_file_name(&name),
            crate_name: name.clone(),
            source: source_name,
            bytes,
            sha256,
        });
        if let Some(files) = importer_list(inventory, &name) {
            consumers.insert(name, files);
        }
    }

    // Report the directory listing alongside the failure so the operator can tell
    // "built for a different target" from "never built".
    if !missing.is_empty() {
        if let Ok(read) = fs::read_dir(release_dir) {
            found_in = read
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".so") || n.ends_with(".dylib") || n.ends_with(".dll"))
                .take(8)
                .collect();
        }
        let missing_artifact = PlanError::MissingArtifact {
            crate_name: missing[0].0.clone(),
            expected: missing[0].1.clone(),
            found_in,
        };
        return Err(missing_artifact);
    }

    for crate_info in &inventory.crates {
        if entries.iter().any(|e| e.crate_name == crate_info.name) {
            continue;
        }
        skipped.push(SkippedCrate {
            crate_name: crate_info.name.clone(),
            reason: inventory.skip_reason(&crate_info.name),
        });
    }
    skipped.sort_by(|a, b| a.crate_name.cmp(&b.crate_name));

    Ok(Plan {
        schema_version: SCHEMA_VERSION,
        target: target.key.to_string(),
        suffix: target.suffix.to_string(),
        surface,
        entries,
        skipped,
        consumers,
    })
}

fn importer_list(inventory: &Inventory, name: &str) -> Option<Vec<String>> {
    match inventory.classifications.get(name) {
        Some(crate::inventory::Classification::Live { importers, .. }) => Some(importers.clone()),
        _ => None,
    }
}

/// Serializes a plan. `preserve_order` in the workspace's serde_json keeps key order
/// as written, so two runs on different hosts produce identical bytes (P7).
pub fn write_plan(plan: &Plan, path: &Path) -> Result<(), PlanError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| PlanError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let mut text = serde_json::to_string_pretty(plan).map_err(|source| PlanError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    text.push('\n');
    fs::write(path, text).map_err(|source| PlanError::Io {
        path: path.to_path_buf(),
        source,
    })
}

pub fn read_plan(path: &Path) -> Result<Plan, PlanError> {
    let text = fs::read_to_string(path).map_err(|source| PlanError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let plan: Plan =
        serde_json::from_str(&text).map_err(|source| PlanError::Json {
            path: path.to_path_buf(),
            source,
        })?;
    if plan.schema_version != SCHEMA_VERSION {
        return Err(PlanError::SchemaVersion {
            found: plan.schema_version,
        });
    }
    Ok(plan)
}

/// Copies every planned entry into `dest_root` and re-verifies each copy (P6).
///
/// Idempotent: re-running overwrites by copy and re-hashes, yielding the same bytes.
pub fn stage(plan: &Plan, source_root: &Path, dest_root: &Path) -> Result<Vec<PathBuf>, PlanError> {
    fs::create_dir_all(dest_root).map_err(|source| PlanError::Io {
        path: dest_root.to_path_buf(),
        source,
    })?;
    let mut written = Vec::new();
    for entry in &plan.entries {
        let source_path = source_root.join(&entry.source);
        let dest_path = dest_root.join(&entry.dest);
        fs::copy(&source_path, &dest_path).map_err(|source| PlanError::Io {
            path: dest_path.clone(),
            source,
        })?;
        let actual = sha256_file(&dest_path)?;
        if actual != entry.sha256 {
            return Err(PlanError::CopyMismatch {
                dest: dest_path,
                expected_sha256: entry.sha256.clone(),
                actual_sha256: actual,
            });
        }
        written.push(dest_path);
    }
    Ok(written)
}

/// Checks a staged tree against the plan.
///
/// Two failure classes, both fatal (P2/P5):
///   - a planned entry is missing, wrong-sized, or hash-mismatched
///   - the root contains a `zcode-*.node` that the plan does not list, which is how a
///     zero-consumer crate creeps back into the payload
pub fn verify(plan: &Plan, root: &Path) -> Result<(), PlanError> {
    let mut problems: Vec<String> = Vec::new();

    for entry in &plan.entries {
        let path = root.join(&entry.dest);
        if !path.is_file() {
            problems.push(format!("missing: {}", entry.dest));
            continue;
        }
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(source) => {
                problems.push(format!("unreadable: {} ({source})", entry.dest));
                continue;
            }
        };
        if metadata.len() != entry.bytes {
            problems.push(format!(
                "size-mismatch: {} (plan {} bytes, staged {} bytes)",
                entry.dest,
                entry.bytes,
                metadata.len()
            ));
            continue;
        }
        match sha256_file(&path) {
            Ok(actual) if actual == entry.sha256 => {}
            Ok(actual) => problems.push(format!(
                "sha256-mismatch: {} (plan {}, staged {actual})",
                entry.dest, entry.sha256
            )),
            Err(_) => problems.push(format!("unreadable: {} (hash failed)", entry.dest)),
        }
    }

    // P5: an unplanned binary in the payload root is an error, not a note. This is the
    // check that keeps `zcode-projection.node` and friends out of every installer.
    if let Ok(read) = fs::read_dir(root) {
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("zcode-") || !name.ends_with(".node") {
                continue;
            }
            if !plan.entries.iter().any(|e| e.dest == name) {
                problems.push(format!(
                    "unexpected: {name} is in the payload but not in the plan \
                     (a crate with no consumer must not ship)"
                ));
            }
        }
    }

    if problems.is_empty() {
        Ok(())
    } else {
        problems.sort();
        Err(PlanError::Verify { problems })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(dest: &str, bytes: u64, sha256: &str) -> PlanEntry {
        PlanEntry {
            crate_name: "zcode-test".to_string(),
            source: "libzcode_test.so".to_string(),
            dest: dest.to_string(),
            bytes,
            sha256: sha256.to_string(),
        }
    }

    fn plan_with(entries: Vec<PlanEntry>) -> Plan {
        Plan {
            schema_version: SCHEMA_VERSION,
            target: "linux-x64".to_string(),
            suffix: "linux-x64-gnu".to_string(),
            surface: Surface::Dev,
            entries,
            skipped: Vec::new(),
            consumers: BTreeMap::new(),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zcode-packaging-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn surface_names_round_trip() {
        for surface in [Surface::DesktopAgent, Surface::Sea, Surface::Dev] {
            assert_eq!(Surface::parse(surface.as_str()), Some(surface));
        }
        assert_eq!(Surface::parse("nope"), None);
    }

    /// R2's measured answer, pinned so a future refactor cannot quietly move the
    /// destination back inside `glm/` where `loadNative()` would never look.
    #[test]
    fn desktop_destination_is_a_sibling_of_glm_not_a_child() {
        let repo = Path::new("/repo");
        let target = Target::by_key("linux-x64").unwrap();
        let root = Surface::DesktopAgent
            .destination_root(repo, &target)
            .expect("desktop-agent has a measured destination");
        assert_eq!(
            root,
            Path::new("/repo/packages/desktop/bundled-agents/linux-x64/native")
        );
        assert!(
            !root.starts_with("/repo/packages/desktop/bundled-agents/linux-x64/glm"),
            "native/ must not live under glm/: zcode.cjs is the file in glm/, and the \
             loader probes join(dirname(zcode.cjs), \"..\", \"native\")"
        );
    }

    /// R8: the SEA extraction layout is unmeasured, so the tool must demand `--dest`
    /// rather than ship a guessed path.
    #[test]
    fn sea_surface_refuses_to_guess_its_destination() {
        let repo = Path::new("/repo");
        let target = Target::by_key("linux-x64").unwrap();
        assert_eq!(Surface::Sea.destination_root(repo, &target), None);
    }

    #[test]
    fn verify_accepts_a_matching_tree() {
        let root = temp_dir("verify-ok");
        let file = root.join("zcode-test.linux-x64-gnu.node");
        fs::write(&file, b"hello").unwrap();
        let plan = plan_with(vec![entry(
            "zcode-test.linux-x64-gnu.node",
            5,
            &sha256_file(&file).unwrap(),
        )]);
        assert!(verify(&plan, &root).is_ok());
    }

    #[test]
    fn verify_reports_a_missing_entry() {
        let root = temp_dir("verify-missing");
        let plan = plan_with(vec![entry("zcode-test.linux-x64-gnu.node", 5, "deadbeef")]);
        let err = verify(&plan, &root).unwrap_err().to_string();
        assert!(err.contains("missing: zcode-test.linux-x64-gnu.node"), "{err}");
    }

    #[test]
    fn verify_reports_a_size_mismatch() {
        let root = temp_dir("verify-size");
        let file = root.join("zcode-test.linux-x64-gnu.node");
        fs::write(&file, b"hello").unwrap();
        let plan = plan_with(vec![entry(
            "zcode-test.linux-x64-gnu.node",
            999, // deliberately wrong
            &sha256_file(&file).unwrap(),
        )]);
        let err = verify(&plan, &root).unwrap_err().to_string();
        assert!(err.contains("size-mismatch"), "{err}");
    }

    #[test]
    fn verify_reports_a_hash_mismatch_at_the_right_size() {
        let root = temp_dir("verify-sha");
        let file = root.join("zcode-test.linux-x64-gnu.node");
        fs::write(&file, b"hello").unwrap();
        let plan = plan_with(vec![entry(
            "zcode-test.linux-x64-gnu.node",
            5,
            "0000000000000000000000000000000000000000000000000000000000000000",
        )]);
        let err = verify(&plan, &root).unwrap_err().to_string();
        assert!(err.contains("sha256-mismatch"), "{err}");
    }

    /// P5: the check that keeps a zero-consumer crate out of every installer.
    #[test]
    fn verify_rejects_an_unplanned_binary() {
        let root = temp_dir("verify-extra");
        let file = root.join("zcode-test.linux-x64-gnu.node");
        fs::write(&file, b"hello").unwrap();
        fs::write(root.join("zcode-projection.linux-x64-gnu.node"), b"dead").unwrap();
        let plan = plan_with(vec![entry(
            "zcode-test.linux-x64-gnu.node",
            5,
            &sha256_file(&file).unwrap(),
        )]);
        let err = verify(&plan, &root).unwrap_err().to_string();
        assert!(
            err.contains("unexpected: zcode-projection.linux-x64-gnu.node"),
            "{err}"
        );
        assert!(err.contains("no consumer must not ship"), "{err}");
    }

    #[test]
    fn verify_ignores_unrelated_files_in_the_root() {
        let root = temp_dir("verify-foreign");
        let file = root.join("zcode-test.linux-x64-gnu.node");
        fs::write(&file, b"hello").unwrap();
        fs::write(root.join("README.txt"), b"notes").unwrap();
        fs::write(root.join("index.js"), b"module.exports={}").unwrap();
        let plan = plan_with(vec![entry(
            "zcode-test.linux-x64-gnu.node",
            5,
            &sha256_file(&file).unwrap(),
        )]);
        assert!(verify(&plan, &root).is_ok());
    }

    #[test]
    fn stage_copies_byte_identically_and_is_idempotent() {
        let source_root = temp_dir("stage-src");
        let dest_root = temp_dir("stage-dest");
        let source = source_root.join("libzcode_test.so");
        fs::write(&source, b"payload bytes").unwrap();
        let plan = plan_with(vec![entry(
            "zcode-test.linux-x64-gnu.node",
            13,
            &sha256_file(&source).unwrap(),
        )]);

        stage(&plan, &source_root, &dest_root).expect("first stage");
        let first = fs::read(dest_root.join("zcode-test.linux-x64-gnu.node")).unwrap();
        stage(&plan, &source_root, &dest_root).expect("second stage");
        let second = fs::read(dest_root.join("zcode-test.linux-x64-gnu.node")).unwrap();
        assert_eq!(first, second);
        assert_eq!(first, b"payload bytes");
        assert!(verify(&plan, &dest_root).is_ok());
    }

    #[test]
    fn stage_fails_loudly_when_a_source_is_absent() {
        let source_root = temp_dir("stage-missing-src");
        let dest_root = temp_dir("stage-missing-dest");
        let plan = plan_with(vec![entry("zcode-test.linux-x64-gnu.node", 5, "deadbeef")]);
        assert!(stage(&plan, &source_root, &dest_root).is_err());
    }

    #[test]
    fn a_plan_from_a_future_schema_is_rejected() {
        let path = temp_dir("schema").join("plan.json");
        let plan = plan_with(Vec::new());
        write_plan(&plan, &path).unwrap();

        // The emitted document must use the §4.4 wire shape, not serde's default.
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"schemaVersion\": 1"), "{text}");
        assert!(!text.contains("schema_version"), "{text}");

        // Bump the version to simulate a newer producer; reading must refuse it.
        let bumped = text.replacen("\"schemaVersion\": 1", "\"schemaVersion\": 99", 1);
        assert_ne!(bumped, text, "the replace did not apply");
        fs::write(&path, bumped).unwrap();
        let err = read_plan(&path).unwrap_err().to_string();
        assert!(err.contains("schemaVersion 99"), "{err}");
    }

    /// `deny_unknown_fields`: a plan written by a newer tool must not be silently
    /// half-understood by an older one.
    #[test]
    fn an_unknown_key_in_a_plan_is_rejected() {
        let path = temp_dir("unknown-key").join("plan.json");
        let plan = plan_with(Vec::new());
        write_plan(&plan, &path).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        fs::write(&path, text.replacen('{', "{\n  \"futureField\": 1,", 1)).unwrap();
        assert!(read_plan(&path).is_err());
    }

    #[test]
    fn plan_serialisation_is_deterministic() {
        // P7: same input, same bytes, so a plan diff means something.
        let plan = plan_with(vec![entry("zcode-a.node", 1, "aa"), entry("zcode-b.node", 2, "bb")]);
        let path = temp_dir("determinism").join("plan.json");
        write_plan(&plan, &path).unwrap();
        let first = fs::read_to_string(&path).unwrap();
        write_plan(&plan, &path).unwrap();
        assert_eq!(first, fs::read_to_string(&path).unwrap());
    }
}
