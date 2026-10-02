//! Workspace file index: pack, fuzzy search, and the index build.
//!
//! Rust port of `@zcode/shared/workspaceFileEntriesCodec` (columnar pack/unpack)
//! and `@zcode/shared/workspaceFileSearch` (the fuzzy top-K scoring the file
//! search uses). The index build mirrors `fileService.ensureWorkspaceFileIndex`:
//! zcode-fs walk + ignore rules → sort (directories first, then relative path)
//! → pack. The renderer pulls the packed index in ranges and searches against
//! it, so the packed bytes must match the TS codec exactly (escape `\\`, `\t`,
//! `\n` in relative paths; one `type\trelativePath` line per entry).

use serde::Serialize;

/// `WORKSPACE_FILE_SEARCH_DISPLAY_CAP`.
pub const SEARCH_DISPLAY_CAP: usize = 1000;

/// A workspace index entry (mirrors `WorkspaceFileEntry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub r#type: String,
}

fn escape_field(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\t', "\\t").replace('\n', "\\n")
}

fn unescape_field(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('t') => out.push('\t'),
                Some('n') => out.push('\n'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// `packWorkspaceFileEntries`: `type\trelativePath` per line, `\\`/`\t`/`\n` escaped.
pub fn pack_entries(entries: &[IndexEntry]) -> String {
    let mut lines = Vec::with_capacity(entries.len());
    for entry in entries {
        lines.push(format!("{}\t{}", entry.r#type, escape_field(&entry.relative_path)));
    }
    lines.join("\n")
}

/// `unpackWorkspaceFileEntries`: rebuild name/path from the relative path + root.
pub fn unpack_entries(packed: &str, root_path: &str) -> Vec<IndexEntry> {
    if packed.is_empty() {
        return Vec::new();
    }
    let separator = if root_path.contains('\\') { '\\' } else { '/' };
    let prefix = if root_path.ends_with('/') || root_path.ends_with('\\') {
        root_path.to_string()
    } else {
        format!("{root_path}{separator}")
    };
    let mut entries = Vec::new();
    for line in packed.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Some(tab_at) = line.find('\t') else { continue };
        let kind = &line[..tab_at];
        let relative_path = unescape_field(&line[tab_at + 1..]);
        let name = relative_path.rsplit(separator).next().unwrap_or(&relative_path).to_string();
        entries.push(IndexEntry {
            name,
            path: format!("{prefix}{relative_path}"),
            relative_path,
            r#type: kind.to_string(),
        });
    }
    entries
}

/// One search candidate with pre-computed lowercase forms.
struct Candidate {
    index: usize,
    name: String,
    path: String,
    relative_path: String,
    r#type: String,
    lowercase_name: String,
    lowercase_relative_path: String,
    lowercase_path: String,
}

fn to_candidates(entries: &[IndexEntry]) -> Vec<Candidate> {
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| Candidate {
            index,
            name: entry.name.clone(),
            path: entry.path.clone(),
            relative_path: entry.relative_path.clone(),
            r#type: entry.r#type.clone(),
            lowercase_name: entry.name.trim().to_lowercase(),
            lowercase_relative_path: entry.relative_path.trim().to_lowercase(),
            lowercase_path: entry.path.trim().to_lowercase(),
        })
        .collect()
}

/// `scoreNormalizedFuzzyMatch`: lower-is-better; `None` = no match.
fn score_normalized(normalized_text: &str, normalized_query: &str) -> Option<f64> {
    if normalized_text.is_empty() {
        return None;
    }
    if normalized_query.is_empty() {
        return Some(0.0);
    }
    if normalized_text.starts_with(normalized_query) {
        return Some((normalized_text.len() - normalized_query.len()) as f64);
    }
    if let Some(substring_index) = normalized_text.find(normalized_query) {
        return Some(100.0 + substring_index as f64);
    }
    let mut score = 200.0f64;
    let mut search_start = 0usize;
    for c in normalized_query.chars() {
        let found = normalized_text[search_start..].find(c).map(|i| i + search_start);
        let Some(found_index) = found else { return None };
        score += (found_index - search_start) as f64;
        search_start = found_index + 1;
    }
    Some(score + (normalized_text.len() - normalized_query.len()) as f64)
}

/// `getWorkspaceFileSearchCandidateScore`: the best (lowest) tier across name /
/// relativePath (+25) / path & relativePath keywords (+300).
fn candidate_score(candidate: &Candidate, normalized_query: &str) -> Option<f64> {
    if normalized_query.is_empty() {
        return Some(0.0);
    }
    let name_score = score_normalized(&candidate.lowercase_name, normalized_query);
    let relative_path_score = score_normalized(&candidate.lowercase_relative_path, normalized_query);
    let path_score = score_normalized(&candidate.lowercase_path, normalized_query);
    let keyword_score = relative_path_score
        .map(|s| s + 300.0)
        .unwrap_or(f64::INFINITY)
        .min(path_score.map(|s| s + 300.0).unwrap_or(f64::INFINITY));
    let best = name_score.unwrap_or(f64::INFINITY)
        .min(relative_path_score.map(|s| s + 25.0).unwrap_or(f64::INFINITY))
        .min(keyword_score);
    best.is_finite().then_some(best)
}

fn default_priority(candidate: &Candidate) -> u8 {
    if candidate.r#type == "directory" {
        1
    } else {
        0
    }
}

/// Compare two scored entries by (score, original index, name) — a strict total
/// order because the index is unique within one traversal.
fn compare_scored(
    candidates: &[Candidate],
    left: (usize, usize, f64),
    right: (usize, usize, f64),
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    left.2
        .partial_cmp(&right.2)
        .unwrap_or(Ordering::Equal)
        .then(left.1.cmp(&right.1))
        .then(candidates[left.0].name.cmp(&candidates[right.0].name))
}

/// `filterWorkspaceFileSearchCandidates`: fuzzy top-K (score, index) strict order.
fn filter_candidates(candidates: &[Candidate], query: &str, limit: usize) -> Vec<usize> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        // Empty query: directories first, then original order, capped.
        let mut indexed: Vec<usize> = (0..candidates.len()).collect();
        indexed.sort_by_key(|&i| (default_priority(&candidates[i]), i));
        indexed.truncate(limit);
        return indexed;
    }
    let mut best: Vec<(usize, usize, f64)> = Vec::new(); // (candidate index, original index, score)
    for (original_index, candidate) in candidates.iter().enumerate() {
        let Some(score) = candidate_score(candidate, &normalized_query) else {
            continue;
        };
        let scored = (candidate.index, original_index, score);
        if let Some(&worst) = best.last() {
            if best.len() >= limit && compare_scored(candidates, scored, worst) != std::cmp::Ordering::Less {
                continue;
            }
        }
        // Binary-search the insertion point by the (score, index, name) order.
        let insertion = best
            .binary_search_by(|existing| compare_scored(candidates, scored, *existing))
            .unwrap_or_else(|pos| pos);
        if insertion >= best.len() {
            if best.len() < limit {
                best.push(scored);
            }
            continue;
        }
        best.insert(insertion, scored);
        if best.len() > limit {
            best.pop();
        }
    }
    best.into_iter().map(|(candidate_index, ..)| candidate_index).collect()
}

/// `searchWorkspaceFiles`: fuzzy search against the index entries.
pub fn search(entries: &[IndexEntry], query: &str, limit: usize) -> Vec<IndexEntry> {
    let candidates = to_candidates(entries);
    let limit = if limit == 0 { SEARCH_DISPLAY_CAP } else { limit.min(SEARCH_DISPLAY_CAP) };
    filter_candidates(&candidates, query, limit)
        .into_iter()
        .map(|candidate_index| {
            let candidate = &candidates[candidate_index];
            IndexEntry {
                name: candidate.name.clone(),
                path: candidate.path.clone(),
                relative_path: candidate.relative_path.clone(),
                r#type: candidate.r#type.clone(),
            }
        })
        .collect()
}

/// Sort the walk result the way the TS index does: directories first, then
/// relative path. (TS uses `localeCompare`; this uses a plain byte compare —
/// identical for ASCII paths, which is what workspaces contain.)
pub fn sort_entries(entries: &mut [IndexEntry]) {
    entries.sort_by(|left, right| {
        let left_dir = left.r#type == "directory";
        let right_dir = right.r#type == "directory";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
}