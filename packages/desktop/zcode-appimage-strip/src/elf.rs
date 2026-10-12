//! ELF metadata readers, implemented by parsing `readelf` text output.
//!
//! Why shell out to `readelf` instead of using an ELF crate (`object`/`goblin`)? The safety gate's
//! behavior is defined by what `readelf` prints, including its quirks: the `Not an ELF file` exit
//! path maps to an empty dependency list, `.gnu.version_d` includes the `BASE` entry, and only
//! `Name: ... Flags:` lines count as version *needs*. Reproducing those semantics with a second
//! parser would create a divergent source of truth for no runtime win on a one-shot scan. This also
//! mirrors the ported script exactly (behavior parity over elegance).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

use crate::error::StripError;

/// Parse `readelf -d` for the `DT_NEEDED` SONAME list.
///
/// A non-ELF file makes `readelf` exit non-zero with `Not an ELF file` on stderr; that is treated as
/// "no dependencies" (the AppDir `usr/lib` scan visits non-library files too). Any other failure —
/// notably `readelf` itself missing — is a hard error, because it would leave the safety gate blind.
///
/// # Errors
/// Returns [`StripError::ReadelfNeededFailed`] when `readelf` cannot be run or fails for a reason
/// other than a non-ELF input.
pub fn read_needed(elf_path: &Path) -> Result<Vec<String>, StripError> {
    let output = Command::new("readelf").arg("-d").arg(elf_path).output();
    let output = match output {
        Ok(output) => output,
        Err(source) => {
            return Err(StripError::ReadelfNeededFailed {
                path: elf_path.to_path_buf(),
                source,
            })
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Not an ELF file") {
            return Ok(Vec::new());
        }
        return Err(StripError::ReadelfNeededFailed {
            path: elf_path.to_path_buf(),
            source: std::io::Error::other(format!(
                "readelf exited with {}: {}",
                output.status,
                stderr.trim()
            )),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut needed = Vec::new();
    for line in stdout.lines() {
        if let Some(soname) = parse_needed_line(line) {
            needed.push(soname);
        }
    }
    Ok(needed)
}

/// Extract the bracketed SONAME from a `(NEEDED) Shared library: [libfoo.so.1]` line.
fn parse_needed_line(line: &str) -> Option<String> {
    let marker = "(NEEDED)";
    let idx = line.find(marker)?;
    let after = &line[idx + marker.len()..];
    let open = after.find('[')?;
    let close = after[open..].find(']')?;
    Some(after[open + 1..open + close].to_string())
}

/// Parse `readelf -V`'s version-needs section: for each dependency SONAME, the set of version names
/// it requires.
///
/// A dependency with no versioned references (e.g. libglib referencing `libpcre2-8.so.0` by bare
/// symbol name) simply does not appear in the result map.
///
/// # Errors
/// Returns [`StripError::ReadelfVersionFailed`] when `readelf -V` cannot be run or fails.
pub fn read_version_needs(
    elf_path: &Path,
) -> Result<BTreeMap<String, BTreeSet<String>>, StripError> {
    let stdout = read_readelf_version(elf_path)?;
    Ok(parse_version_needs_text(&stdout))
}

/// Pure parser for the version-needs section, split out so it is unit-testable without a real ELF.
fn parse_version_needs_text(text: &str) -> BTreeMap<String, BTreeSet<String>> {
    let mut needs: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut current_file: Option<String> = None;
    for line in text.lines() {
        if let Some(file) = parse_version_file_line(line) {
            needs.entry(file.clone()).or_default();
            current_file = Some(file);
            continue;
        }
        if let (Some(file), Some(version)) = (current_file.as_ref(), parse_version_name_flags(line))
        {
            needs.entry(file.clone()).or_default().insert(version);
        }
    }
    needs
}

/// Parse a `Version: N  File: <name>` line, returning `<name>`.
fn parse_version_file_line(line: &str) -> Option<String> {
    let anchor = line.find("File:")?;
    // Only treat it as a file header when preceded by a `Version:` token on the same line.
    let before = &line[..anchor];
    if !before.contains("Version:") {
        return None;
    }
    let rest = line[anchor + "File:".len()..].trim();
    let name = rest.split_whitespace().next()?;
    Some(name.to_string())
}

/// Parse a `Name: <version>  Flags: ...` line (version-needs entries always carry `Flags:`).
fn parse_version_name_flags(line: &str) -> Option<String> {
    let name_idx = line.find("Name:")?;
    let after = &line[name_idx + "Name:".len()..];
    if !after.contains("Flags:") {
        return None;
    }
    let version = after.split_whitespace().next()?;
    Some(version.to_string())
}

/// Parse `readelf -V`'s version-definition section (`.gnu.version_d`): the set of version names this
/// library exports.
///
/// Only `Name:` lines inside the "Version definition section" are collected, so the version *needs*
/// that follow are never mistaken for definitions. The set includes the `BASE` entry (the library's
/// own SONAME); it is naturally excluded when compared against required version names.
///
/// # Errors
/// Returns [`StripError::ReadelfVersionFailed`] when `readelf -V` cannot be run or fails.
pub fn read_version_defines(elf_path: &Path) -> Result<BTreeSet<String>, StripError> {
    let stdout = read_readelf_version(elf_path)?;
    let mut defines = BTreeSet::new();
    let Some(start) = stdout.find("Version definition section") else {
        return Ok(defines);
    };
    let rest = &stdout[start..];
    let region = match rest.find("Version needs section") {
        Some(end) => &rest[..end],
        None => rest,
    };
    for line in region.lines() {
        if let Some(name) = parse_definition_name(line) {
            defines.insert(name);
        }
    }
    Ok(defines)
}

/// Parse a version-definition `Name: <version>` line where the name ends the line.
fn parse_definition_name(line: &str) -> Option<String> {
    let name_idx = line.find("Name:")?;
    let after = line[name_idx + "Name:".len()..].trim();
    if after.is_empty() {
        return None;
    }
    // The definition section puts the name last; take the final whitespace-separated token.
    after.split_whitespace().last().map(str::to_string)
}

/// Run `readelf -V` and return its stdout, mapping spawn/exit failures to the version error.
fn read_readelf_version(elf_path: &Path) -> Result<String, StripError> {
    let output = Command::new("readelf").arg("-V").arg(elf_path).output();
    let output = match output {
        Ok(output) => output,
        Err(source) => {
            return Err(StripError::ReadelfVersionFailed {
                path: elf_path.to_path_buf(),
                source,
            })
        }
    };
    if !output.status.success() {
        return Err(StripError::ReadelfVersionFailed {
            path: elf_path.to_path_buf(),
            source: std::io::Error::other(format!(
                "readelf -V exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_needed_entries() {
        let line = " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]";
        assert_eq!(parse_needed_line(line), Some("libc.so.6".to_string()));
        let line2 = " 0x0000000000000001 (NEEDED)             Shared library: [libpcre2-8.so.0]";
        assert_eq!(
            parse_needed_line(line2),
            Some("libpcre2-8.so.0".to_string())
        );
    }

    #[test]
    fn ignores_non_needed_dynamic_lines() {
        let line = " 0x000000000000000f (RPATH)              Library rpath: [/opt/lib]";
        assert_eq!(parse_needed_line(line), None);
    }

    #[test]
    fn parses_version_needs_blocks() {
        // A versioned need (libssl -> OPENSSL_3.0.0) and an unversioned-file block that must not
        // gain spurious needs.
        let text = "\
Version needs section '.gnu.version_r' contains 2 entries:
 Addr: 0x0000000000000000  Offset: 0x0000  Link: 5 (.dynstr)
  000: Version: 1  File: libssl.so.3  Cnt: 1
  0x0010:   Name: OPENSSL_3.0.0  Flags: none  Version: 3
  001: Version: 1  File: libc.so.6  Cnt: 1
  0x0020:   Name: GLIBC_2.34  Flags: none  Version: 2
";
        let map = parse_version_needs_text(text);
        assert_eq!(
            map["libssl.so.3"],
            BTreeSet::from(["OPENSSL_3.0.0".to_string()])
        );
        assert_eq!(map["libc.so.6"], BTreeSet::from(["GLIBC_2.34".to_string()]));
    }

    #[test]
    fn version_file_line_requires_version_token() {
        assert!(parse_version_file_line("  000: Version: 1  File: libssl.so.3  Cnt: 1").is_some());
        assert!(parse_version_file_line("  File: libssl.so.3").is_none());
    }

    #[test]
    fn version_name_flags_requires_flags_token() {
        assert_eq!(
            parse_version_name_flags("  0x0010:   Name: OPENSSL_3.0.0  Flags: none"),
            Some("OPENSSL_3.0.0".to_string())
        );
        // A definition-section `Name:` line has no Flags: and must not be read as a need.
        assert_eq!(
            parse_version_name_flags("  0x0010:   Name: PCRE2_10.47"),
            None
        );
    }

    #[test]
    fn definition_names_are_the_last_token() {
        assert_eq!(
            parse_definition_name("  0x0010: Name: PCRE2_10.47"),
            Some("PCRE2_10.47".to_string())
        );
        assert_eq!(parse_definition_name(" Addr: 0x0"), None);
    }
}
