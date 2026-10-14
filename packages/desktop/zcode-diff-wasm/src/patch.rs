//! Unified-diff text construction, ported from `packages/ui/src/lib/toolDiffPreview.ts`.
//!
//! This module owns everything that is pure string assembly: line splitting, shared prefix/suffix
//! detection, the body (` ` / `+` / `-` prefixed lines) and the file headers. The dynamic program
//! itself lives in [`crate::lcs`]; the anchor fallback in [`crate::anchor`].

use crate::anchor::find_anchors;
use crate::lcs::build_table;

/// The result of building a patch: the un-trimmed text plus the LCS length of the diffed middles.
///
/// `retained` is the shared unchanged-line count of the trimmed middles, exposed so a caller that
/// wants the `{added, removed}` view of *the same diff* does not have to run a second pass. The
/// standalone stat entry point ([`crate::lib::line_change_stat`]) uses its own logical-line split
/// (it pops a trailing empty line), so it is deliberately NOT derived from this.
pub struct PatchOutput {
    pub patch: String,
    pub retained: u32,
    pub before_middle_len: usize,
    pub after_middle_len: usize,
}

/// `text.length === 0 ? [] : text.split("\n")` — mirrors `splitLines`.
///
/// The JavaScript used `String.prototype.split`, which for a non-empty string with no newline
/// returns a single-element array, and for a non-empty string ending in `\n` returns a trailing
/// empty element. Rust's `split('\n')` has exactly the same shape, so the two agree on every case
/// including the trailing-newline one that `lineChangeStat` deliberately post-processes.
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

/// Number of identical leading lines — mirrors `countSharedPrefix`.
fn count_shared_prefix(before: &[&str], after: &[&str]) -> usize {
    let max_length = before.len().min(after.len());
    let mut index = 0;
    while index < max_length && before[index] == after[index] {
        index += 1;
    }
    index
}

/// Number of identical trailing lines, not overlapping the shared prefix — mirrors
/// `countSharedSuffix`.
fn count_shared_suffix(before: &[&str], after: &[&str], shared_prefix_count: usize) -> usize {
    let max_length = before.len().min(after.len()) - shared_prefix_count;
    let mut offset = 0;
    while offset < max_length
        && before[before.len() - 1 - offset] == after[after.len() - 1 - offset]
    {
        offset += 1;
    }
    offset
}

/// `content.split("\n")` then pop one trailing empty — mirrors `splitIntoLogicalLines`.
///
/// NOTE the difference from [`split_lines`]: `computeLineChangeStat` treats a trailing newline as
/// "the file ends with a newline" rather than "there is a final empty line", so it drops that one
/// empty. `buildUnifiedDiff` does **not**. The two entry points keep their own semantics; unifying
/// the split would change published `+N`/`-M` counts.
fn split_into_logical_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// The `{added, removed}` view — mirrors `computeLineChangeStat` (including its logical-line split).
///
/// Trims the shared prefix/suffix first (so only the changed middle feeds the DP), then counts every
/// non-LCS line on each side. Returns `(added, removed)`.
pub fn compute_line_change_stat(before: &str, after: &str) -> (u32, u32) {
    let before_lines = split_into_logical_lines(before);
    let after_lines = split_into_logical_lines(after);

    let prefix_index = count_shared_prefix(&before_lines, &after_lines);

    // The suffix walk here is the `lineChangeStat.ts` variant: it stops at `prefix_index` and does
    // not take a `shared_prefix_count` parameter, but the effect is identical for the slices it
    // produces. Implemented via the shared helper for one definition of "shared suffix".
    let shared_suffix_count = count_shared_suffix(&before_lines, &after_lines, prefix_index);

    let trimmed_before = &before_lines[prefix_index..before_lines.len() - shared_suffix_count];
    let trimmed_after = &after_lines[prefix_index..after_lines.len() - shared_suffix_count];

    if trimmed_before.is_empty() {
        return (trimmed_after.len() as u32, 0);
    }
    if trimmed_after.is_empty() {
        return (0, trimmed_before.len() as u32);
    }

    let retained = build_table(trimmed_before, trimmed_after)
        .map(|table| table.length())
        // If even the trimmed middle exceeds the ceiling, the anchor path has no stat meaning here;
        // mirror the old cap behavior by reporting the whole middle as changed. This keeps the
        // function total; the harness documents the divergence from the true LCS for such inputs.
        .unwrap_or(0);
    let retained = retained as usize;

    (
        (trimmed_after.len() - retained) as u32,
        (trimmed_before.len() - retained) as u32,
    )
}

/// `lineCount === 0 ? "0,0" : "1,{lineCount}"` — mirrors `formatDiffRange`.
fn format_diff_range(line_count: usize) -> String {
    if line_count == 0 {
        "0,0".to_string()
    } else {
        format!("1,{}", line_count)
    }
}

/// Mirrors `formatDiffRangeFromSliceStart` (the context-limited `@@` header form).
fn format_diff_range_from_slice_start(start_index: usize, line_count: usize) -> String {
    if line_count == 0 {
        format!("{},0", start_index)
    } else {
        format!("{},{}", start_index + 1, line_count)
    }
}

/// Append `lines` to `out`, each prefixed — mirrors `appendLinesWithPrefix`.
fn append_lines_with_prefix(out: &mut Vec<String>, prefix: char, lines: &[&str]) {
    for line in lines {
        let mut buffered = String::with_capacity(line.len() + 1);
        buffered.push(prefix);
        buffered.push_str(line);
        out.push(buffered);
    }
}

/// Build the body — mirrors `appendDiffBodyWithLcs`, the 2-D-table branch.
///
/// `before` and `after` are the already-trimmed middles. Emits ` ` / `+` / `-` lines into `out` and
/// returns the LCS length of the two middles, so the caller gets the retained-line count **from the
/// same table the body walked** (spec §1.2: one LCS, two views — never a second pass).
///
/// The anchor fallback is used only when the table would exceed [`crate::lcs::MAX_DIFF_CELLS`].
fn append_body_and_retained(out: &mut Vec<String>, before: &[&str], after: &[&str]) -> u32 {
    if before.is_empty() {
        append_lines_with_prefix(out, '+', after);
        return 0;
    }
    if after.is_empty() {
        append_lines_with_prefix(out, '-', before);
        return 0;
    }

    let Some(table) = build_table(before, after) else {
        return append_body_with_anchor_fallback(out, before, after);
    };

    let retained = table.length();
    append_body_with_table(out, before, after, &table);
    retained
}

/// Traceback over an already-built table — the loop body of `appendDiffBodyWithLcs`.
fn append_body_with_table(
    out: &mut Vec<String>,
    before: &[&str],
    after: &[&str],
    table: &crate::lcs::LcsTable,
) {
    let mut before_index = 0usize;
    let mut after_index = 0usize;
    while before_index < before.len() || after_index < after.len() {
        let before_line = before.get(before_index);
        let after_line = after.get(after_index);

        if let (Some(before_line), Some(after_line)) = (before_line, after_line) {
            if before_line == after_line {
                push_prefixed(out, ' ', before_line);
                before_index += 1;
                after_index += 1;
                continue;
            }
        }

        if before_line.is_none() {
            if let Some(after_line) = after_line {
                push_prefixed(out, '+', after_line);
                after_index += 1;
                continue;
            }
        }

        if after_line.is_none() {
            if let Some(before_line) = before_line {
                push_prefixed(out, '-', before_line);
                before_index += 1;
                continue;
            }
        }

        let skip_after_score = table.at(before_index, after_index + 1);
        let skip_before_score = table.at(before_index + 1, after_index);

        // The JavaScript preferred the `after` side on ties (`skipAfterScore >= skipBeforeScore`).
        // The `after_line` binding is known `Some` here: both `is_none` branches above returned.
        if let Some(after_line) = after_line {
            if skip_after_score >= skip_before_score {
                push_prefixed(out, '+', after_line);
                after_index += 1;
                continue;
            }
        }

        if let Some(before_line) = before_line {
            push_prefixed(out, '-', before_line);
            before_index += 1;
        }
    }
}

#[inline]
fn push_prefixed(out: &mut Vec<String>, prefix: char, line: &str) {
    let mut buffered = String::with_capacity(line.len() + 1);
    buffered.push(prefix);
    buffered.push_str(line);
    out.push(buffered);
}

/// The anchor pre-split body — mirrors `appendDiffBodyWithLargeSegmentFallback`.
///
/// Splits at unique anchors and diffs each gap with the full-table builder. When there are no
/// anchors at all it degrades to "delete all, add all", exactly as the JavaScript did.
///
/// Returns the total number of retained (` `-prefixed) lines, i.e. the LCS length of the whole
/// input, summed across the gaps plus the anchors themselves — so the `{added, removed}` view stays
/// the same single pass even on the fallback route.
fn append_body_with_anchor_fallback(out: &mut Vec<String>, before: &[&str], after: &[&str]) -> u32 {
    let anchors = find_anchors(before, after);

    if anchors.is_empty() {
        append_lines_with_prefix(out, '-', before);
        append_lines_with_prefix(out, '+', after);
        return 0;
    }

    let mut previous_before_index = 0usize;
    let mut previous_after_index = 0usize;
    let mut retained: u32 = 0;

    for anchor in &anchors {
        retained += append_body_and_retained(
            out,
            &before[previous_before_index..anchor.before_index],
            &after[previous_after_index..anchor.after_index],
        );
        push_prefixed(out, ' ', before[anchor.before_index]);
        retained += 1;
        previous_before_index = anchor.before_index + 1;
        previous_after_index = anchor.after_index + 1;
    }

    retained
        + append_body_and_retained(
            out,
            &before[previous_before_index..],
            &after[previous_after_index..],
        )
}

/// Build the whole unified diff — mirrors `buildUnifiedDiff`.
///
/// `context_lines < 0` means "no context limit": the `@@` header is the whole-file form and the
/// caller does not trim. Otherwise the shared prefix/suffix are clipped to `context_lines` and the
/// `@@` header uses the slice-start form; the caller still runs `trimPatchContext` afterwards.
pub fn build_unified_diff(
    before: &str,
    after: &str,
    file_label: &str,
    context_lines: i32,
) -> PatchOutput {
    let before_lines = split_lines(before);
    let after_lines = split_lines(after);

    let shared_prefix_count = count_shared_prefix(&before_lines, &after_lines);
    let shared_suffix_count = count_shared_suffix(&before_lines, &after_lines, shared_prefix_count);

    let before_middle =
        &before_lines[shared_prefix_count..before_lines.len() - shared_suffix_count];
    let after_middle = &after_lines[shared_prefix_count..after_lines.len() - shared_suffix_count];

    let is_created_file = before_lines.is_empty() && !after_lines.is_empty();
    let is_deleted_file = !before_lines.is_empty() && after_lines.is_empty();

    let has_context_limit = context_lines >= 0;
    let normalized_context_lines = if has_context_limit {
        context_lines as usize
    } else {
        0
    };

    let limited_prefix_count = if has_context_limit {
        shared_prefix_count.min(normalized_context_lines)
    } else {
        shared_prefix_count
    };
    let limited_suffix_count = if has_context_limit {
        shared_suffix_count.min(normalized_context_lines)
    } else {
        shared_suffix_count
    };

    let before_slice_start = shared_prefix_count - limited_prefix_count;
    let after_slice_start = shared_prefix_count - limited_prefix_count;
    let before_range_line_count = limited_prefix_count + before_middle.len() + limited_suffix_count;
    let after_range_line_count = limited_prefix_count + after_middle.len() + limited_suffix_count;

    let mut patch_lines: Vec<String> = Vec::new();

    // The `diff --git` boundary is required: a deleted SQL comment line (`-- ...`) would otherwise
    // produce a `--- ...` body line that `@pierre/diffs` splits as a second file and crashes on.
    patch_lines.push(format!("diff --git a/{0} b/{0}", file_label));
    // Standard unified diff uses /dev/null for the absent side so the parser treats a pure create /
    // delete as such, instead of a rename/change with a 0-line side.
    patch_lines.push(if is_created_file {
        "--- /dev/null".to_string()
    } else {
        format!("--- a/{}", file_label)
    });
    patch_lines.push(if is_deleted_file {
        "+++ /dev/null".to_string()
    } else {
        format!("+++ b/{}", file_label)
    });
    patch_lines.push(if has_context_limit {
        format!(
            "@@ -{} +{} @@",
            format_diff_range_from_slice_start(before_slice_start, before_range_line_count),
            format_diff_range_from_slice_start(after_slice_start, after_range_line_count)
        )
    } else {
        format!(
            "@@ -{} +{} @@",
            format_diff_range(before_lines.len()),
            format_diff_range(after_lines.len())
        )
    });

    // Prefix context (clipped), then the diff body, then suffix context (clipped).
    for line in &before_lines[shared_prefix_count - limited_prefix_count..shared_prefix_count] {
        patch_lines.push(format!(" {}", line));
    }

    let retained = append_body_and_retained(&mut patch_lines, before_middle, after_middle);

    if limited_suffix_count > 0 {
        let suffix_start = before_lines.len() - shared_suffix_count;
        for line in &before_lines[suffix_start..suffix_start + limited_suffix_count] {
            patch_lines.push(format!(" {}", line));
        }
    }

    PatchOutput {
        patch: patch_lines.join("\n"),
        retained,
        before_middle_len: before_middle.len(),
        after_middle_len: after_middle.len(),
    }
}
