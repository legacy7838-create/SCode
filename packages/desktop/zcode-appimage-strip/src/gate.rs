//! Host-library safety gate: decides whether a bundled system library can be removed because the
//! host's same-named library is a compatible (version) superset of everything the AppDir needs.
//!
//! Ported 1:1 from `scripts/strip-appimage-system-libs.mjs` (`verifyHostSatisfiesDependents`,
//! `collectDependentsNeeding`, `selectSafeToStrip`, `hostLibPath`). The gate is the reason it is
//! safe to delete `libcrypto.so.3` while `libpcre2-8.so.0` must stay: pcre2 is a hard dependency,
//! but its AppDir dependents require *no* versioned symbols, and the host copy is versioned — the
//! gate encodes exactly that.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::elf;
use crate::error::StripError;

/// Libraries the script considers for removal: bundled copies that shadow a host library via the
/// AppImage's `LD_LIBRARY_PATH` prepend. Only those that pass [`verify_host_satisfies_dependents`]
/// are actually deleted.
pub const SHADOWING_LIBS: &[&str] = &["libcrypto.so.3", "libpcre2-8.so.0"];

/// The AppDir library directories scanned for dependents, ported verbatim from the script. Note the
/// `x86_64-linux-gnu` name is x86_64-specific and the aarch64 multiarch dir is *not* scanned today;
/// this preserves current behavior rather than silently changing what gets checked (see PORTING.md).
const LIB_ROOTS: &[&str] = &["usr/lib", "usr/lib/x86_64-linux-gnu", "usr/bin"];

/// Locate the host copy of `soname` via `ldconfig -p` (first match wins).
///
/// # Errors
/// Returns [`StripError::LdconfigFailed`] if `ldconfig` cannot be run.
pub fn host_lib_path(soname: &str) -> Result<Option<PathBuf>, StripError> {
    let output = Command::new("ldconfig").arg("-p").output();
    let output = match output {
        Ok(output) => output,
        Err(source) => {
            return Err(StripError::LdconfigFailed {
                soname: soname.to_string(),
                source,
            })
        }
    };
    if !output.status.success() {
        return Err(StripError::LdconfigFailed {
            soname: soname.to_string(),
            source: std::io::Error::other(format!("ldconfig exited with {}", output.status)),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_ldconfig_for(stdout.as_ref(), soname))
}

/// Pure parser for `ldconfig -p` output: find the first `\t<soname> (<abi>) => <path>` line for
/// `soname`. Matching is exact on the SONAME token so `libcrypto.so.3` never matches `.so.30`.
fn parse_ldconfig_for(text: &str, soname: &str) -> Option<PathBuf> {
    for line in text.lines() {
        // Format: "	libcrypto.so.3 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libcrypto.so.3"
        let Some((left, right)) = line.split_once("=>") else {
            continue;
        };
        if !left.contains(soname) {
            continue;
        }
        // Guard against a substring hit (`libcrypto.so.3` inside `libcrypto.so.30`): the token
        // immediately before the ABI paren must equal the SONAME.
        let token = left.split_whitespace().next().unwrap_or("");
        if token != soname {
            continue;
        }
        let path = right.trim();
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    None
}

/// Find every ELF in the AppDir that has `soname` in its `DT_NEEDED`, paired with the set of version
/// names it requires from that library (empty when it references it only by bare symbol).
///
/// # Errors
/// Propagates [`elf::read_needed`]/[`elf::read_version_needs`] errors, since a gate run on partial
/// data would be unsound.
pub fn collect_dependents_needing(
    app_dir: &Path,
    soname: &str,
) -> Result<Vec<(PathBuf, BTreeSet<String>)>, StripError> {
    let mut dependents = Vec::new();
    for root in LIB_ROOTS {
        let dir = app_dir.join(root);
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue, // root absent -> nothing to scan here
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let needed = elf::read_needed(&path)?;
            if !needed.iter().any(|n| n == soname) {
                continue;
            }
            let version_needs = elf::read_version_needs(&path)?;
            let required = version_needs.get(soname).cloned().unwrap_or_default();
            dependents.push((path, required));
        }
    }
    Ok(dependents)
}

/// Outcome of comparing a host library's defined versions against the version needs of every
/// AppDir dependent.
#[derive(Debug, PartialEq, Eq)]
pub enum HostVerdict {
    /// Host satisfies all dependents.
    Satisfied,
    /// Host genuinely lacks versions that a dependent requires.
    Missing(BTreeSet<String>),
}

/// Decide whether `defines` (host library's version names) satisfies all `requirement_sets` (the
/// version needs of every AppDir dependent).
///
/// An unversioned host (`defines` empty) fails only if some dependent actually requires a version;
/// otherwise it is a legitimate fallback (bare-SONAME bind), which is the everyday libpcre2 case.
pub fn host_satisfies<'a, I>(defines: &BTreeSet<String>, requirement_sets: I) -> HostVerdict
where
    I: IntoIterator<Item = &'a BTreeSet<String>>,
{
    let mut missing: BTreeSet<String> = BTreeSet::new();
    for required in requirement_sets {
        for version in required {
            if !defines.contains(version) {
                missing.insert(version.clone());
            }
        }
    }
    if missing.is_empty() {
        HostVerdict::Satisfied
    } else {
        HostVerdict::Missing(missing)
    }
}

/// The safety gate: confirm that deleting the bundled `soname` and falling back to the host copy
/// will not break the app. Returns the host library path when safe.
///
/// # Errors
/// - [`StripError::HostLibMissing`] when the host has no such library at all.
/// - [`StripError::UnversionedHostRequiresVersions`] when the host is unversioned but a dependent
///   needs versioned symbols (the mirror of the fatal libcrypto case).
/// - [`StripError::HostMissingVersions`] when the host is missing a required version.
pub fn verify_host_satisfies_dependents(
    app_dir: &Path,
    soname: &str,
) -> Result<PathBuf, StripError> {
    let Some(host_path) = host_lib_path(soname)? else {
        return Err(StripError::HostLibMissing {
            soname: soname.to_string(),
        });
    };
    let host_defines = elf::read_version_defines(&host_path)?;
    let dependents = collect_dependents_needing(app_dir, soname)?;

    // `host_defines.len() <= 1` means the host is effectively unversioned (at most the BASE entry).
    if host_defines.len() <= 1 {
        if dependents.iter().any(|(_, needed)| !needed.is_empty()) {
            return Err(StripError::UnversionedHostRequiresVersions {
                soname: soname.to_string(),
            });
        }
        return Ok(host_path);
    }

    let verdict = host_satisfies(&host_defines, dependents.iter().map(|(_, needed)| needed));
    if let HostVerdict::Missing(missing) = verdict {
        let dependent = dependents
            .iter()
            .find(|(_, needed)| needed.iter().any(|v| missing.contains(v)))
            .map(|(path, _)| path)
            .expect("a missing version must come from some dependent");
        return Err(StripError::HostMissingVersions {
            soname: soname.to_string(),
            missing: missing.into_iter().collect::<Vec<_>>().join(", "),
            dependent: dependent
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        });
    }
    Ok(host_path)
}

/// Filter [`SHADOWING_LIBS`] down to the ones actually present in the AppDir and safe to remove.
///
/// # Errors
/// Propagates gate errors: a library that cannot be proven safe is a hard failure, never a silent
/// skip — matching the script's "refuse rather than ship a broken AppImage" stance.
pub fn select_safe_to_strip(app_dir: &Path) -> Result<Vec<String>, StripError> {
    let mut safe = Vec::new();
    for lib in SHADOWING_LIBS {
        let present = [
            app_dir.join("usr/lib"),
            app_dir.join("usr/lib/x86_64-linux-gnu"),
        ]
        .iter()
        .any(|dir| dir.join(lib).exists());
        if !present {
            continue;
        }
        verify_host_satisfies_dependents(app_dir, lib)?;
        safe.push((*lib).to_string());
    }
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ldconfig_parse_matches_exact_soname() {
        let text = "\
	libcrypto.so.3 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libcrypto.so.3
	libcrypto.so.30 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libcrypto.so.30
";
        assert_eq!(
            parse_ldconfig_for(text, "libcrypto.so.3"),
            Some(PathBuf::from("/usr/lib/x86_64-linux-gnu/libcrypto.so.3"))
        );
    }

    #[test]
    fn ldconfig_parse_ignores_substring_hits() {
        // Only `libpcre2-8.so.0` is listed; a query for the shorter `libpcre2-8.so` must not match
        // the longer SONAME, and vice versa an exact longer query misses the shorter entry.
        let text = "\tlibpcre2-8.so.0 (libc6,x86-64) => /usr/lib/libpcre2-8.so.0\n";
        assert_eq!(
            parse_ldconfig_for(text, "libpcre2-8.so.0"),
            Some(PathBuf::from("/usr/lib/libpcre2-8.so.0"))
        );
        assert_eq!(parse_ldconfig_for(text, "libpcre2-8.so"), None);
    }

    #[test]
    fn host_satisfies_accepts_superset() {
        let defines = BTreeSet::from(["OPENSSL_3.0.0".to_string(), "OPENSSL_3.6.0".to_string()]);
        let req = BTreeSet::from(["OPENSSL_3.0.0".to_string()]);
        assert_eq!(host_satisfies(&defines, [&req]), HostVerdict::Satisfied);
    }

    #[test]
    fn host_satisfies_reports_missing_version() {
        // The fatal libcrypto scenario: host defines 3.0.0, dependent needs 3.6.0.
        let defines = BTreeSet::from(["OPENSSL_3.0.0".to_string()]);
        let req = BTreeSet::from(["OPENSSL_3.6.0".to_string()]);
        assert_eq!(
            host_satisfies(&defines, [&req]),
            HostVerdict::Missing(BTreeSet::from(["OPENSSL_3.6.0".to_string()]))
        );
    }

    #[test]
    fn unversioned_host_ok_when_nothing_requires_versions() {
        // The libpcre2 case: host defines only BASE, dependent requires no versions.
        let defines = BTreeSet::from(["libpcre2-8.so.0".to_string()]);
        let empty = BTreeSet::new();
        assert_eq!(host_satisfies(&defines, [&empty]), HostVerdict::Satisfied);
    }

    #[test]
    fn unversioned_host_fails_when_versions_required() {
        let defines = BTreeSet::new();
        let req = BTreeSet::from(["PCRE2_10.47".to_string()]);
        assert_eq!(
            host_satisfies(&defines, [&req]),
            HostVerdict::Missing(BTreeSet::from(["PCRE2_10.47".to_string()]))
        );
    }
}
