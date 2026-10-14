//! ZCode line-level diff / LCS kernel (WebAssembly).
//!
//! Two JavaScript dynamic programs used to run on the renderer main thread and freeze the UI on
//! large files: `buildUnifiedDiff` (a full 2-D LCS table) and `computeLineChangeStat` (a rolling
//! 1-D table). Both are the **same recurrence**; this crate is the one implementation, called
//! **synchronously** from the renderer (see `spec/native-boundary-line-diff.md`).
//!
//! # Boundary shape
//!
//! Strings in, a patch string and/or two counts out. There is no retained state: a diff is a pure
//! function of its arguments, so unlike the scoring arena there is no per-index lifetime to manage.
//!
//! # Two entry points, one LCS
//!
//! `diff_patch` and `line_change_stat` are NOT the same call, because the two JavaScript functions
//! did not use the same line split:
//!
//! - `buildUnifiedDiff` splits on `\n` and KEEPS a trailing empty line.
//! - `computeLineChangeStat` splits on `\n` and DROPS one trailing empty line.
//!
//! Unifying the split would change published `+N`/`-M` counts, so each entry point keeps its own
//! semantics and they share the recurrence in [`lcs`]. What is unified is the *algorithm*, which is
//! what let the two drift apart before.
//!
//! # No JavaScript fallback
//!
//! The renderer facade throws if this module is not loaded; it never recomputes the diff in JS.

pub mod anchor;
pub mod lcs;
pub mod patch;

use wasm_bindgen::prelude::*;

/// Build the unified diff (mirrors `buildUnifiedDiff`), returning only the patch text.
///
/// `file_label` is the path leaf Rust concatenates into the `diff --git` / `---` / `+++` headers;
/// the caller owns its derivation. `context_lines < 0` means "no context limit" and the caller does
/// not trim; `>= 0` clips the shared prefix/suffix to that many lines and the caller then runs
/// `trimPatchContext`.
///
/// The counts that belong to THIS patch are [`diff_counts`], not [`line_change_stat`] — see the
/// module docs for why the two have different line-split semantics.
#[wasm_bindgen]
pub fn diff_patch(before: &str, after: &str, file_label: &str, context_lines: i32) -> String {
    patch::build_unified_diff(before, after, file_label, context_lines).patch
}

/// The `{added, removed}` counts of the SAME diff [`diff_patch`] produces, from the same DP.
///
/// Returned as `[added, removed]` so the WASM ABI stays one allocation of primitives. A
/// `#[wasm_bindgen] struct` would force the generated nodejs glue into CommonJS (`exports.X =`),
/// which cannot be `require()`d from this repo's ESM packages; primitives keep it a clean ESM
/// module, exactly like `zcode-score-wasm`.
#[wasm_bindgen]
pub fn diff_counts(before: &str, after: &str, file_label: &str, context_lines: i32) -> Vec<u32> {
    let output = patch::build_unified_diff(before, after, file_label, context_lines);
    let retained = output.retained as usize;
    vec![
        (output.after_middle_len - retained) as u32,
        (output.before_middle_len - retained) as u32,
    ]
}

/// Compute the standalone `{added, removed}` counts (mirrors `computeLineChangeStat`), using that
/// function's logical-line split. Returns `[added, removed]`.
///
/// This is deliberately a separate entry point from [`diff_counts`]: `computeLineChangeStat` drops a
/// trailing empty line and `buildUnifiedDiff` does not, so unifying them would change published
/// `+N`/`-M` counts. What the two share is the LCS *algorithm*.
#[wasm_bindgen]
pub fn line_change_stat(before: &str, after: &str) -> Vec<u32> {
    let (added, removed) = patch::compute_line_change_stat(before, after);
    vec![added, removed]
}

/// The safety ceiling on `before_len * after_len` for the full table, exposed so the harness can
/// assert the anchor path is exercised at the documented threshold.
#[wasm_bindgen]
pub fn max_diff_cells() -> u32 {
    lcs::MAX_DIFF_CELLS as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patch::{build_unified_diff, compute_line_change_stat};

    /// A created file (empty before) diffs to all additions and no deletions.
    #[test]
    fn created_file_is_all_added() {
        let (added, removed) = compute_line_change_stat("", "a\nb\nc");
        assert_eq!((added, removed), (3, 0));
    }

    /// A deleted file (empty after) diffs to all removals and no additions.
    #[test]
    fn deleted_file_is_all_removed() {
        let (added, removed) = compute_line_change_stat("a\nb\nc", "");
        assert_eq!((added, removed), (0, 3));
    }

    /// A single changed line in the middle is one add and one remove.
    #[test]
    fn one_changed_line() {
        let (added, removed) = compute_line_change_stat("a\nb\nc", "a\nB\nc");
        assert_eq!((added, removed), (1, 1));
    }

    /// The logical-line split drops exactly one trailing empty line, so a trailing newline is not a
    /// phantom added/removed line. This is the `lineChangeStat` semantics, not `buildUnifiedDiff`'s.
    #[test]
    fn trailing_newline_is_not_a_change() {
        let (added, removed) = compute_line_change_stat("a\nb\n", "a\nb\n");
        assert_eq!((added, removed), (0, 0));
    }

    /// Identical inputs have no changed middle at all: the whole file is shared prefix, so
    /// `retained` is 0 (the middles are empty) and the counts are 0. The patch still carries the
    /// full-file `@@` header the JS emitted.
    #[test]
    fn identical_inputs_are_empty() {
        let output = build_unified_diff("a\nb", "a\nb", "f.txt", -1);
        assert_eq!(output.before_middle_len, 0);
        assert_eq!(output.after_middle_len, 0);
        assert_eq!(output.retained, 0);
        assert!(output.patch.starts_with("diff --git a/f.txt b/f.txt\n"));
        assert!(output.patch.contains("@@ -1,2 +1,2 @@"));

        let counts = diff_counts("a\nb", "a\nb", "f.txt", -1);
        assert_eq!(counts, vec![0, 0]);
    }

    /// A pure create uses `/dev/null` on the before side and the whole-file header form.
    #[test]
    fn create_uses_dev_null_before() {
        let output = build_unified_diff("", "x\ny", "new.txt", -1);
        assert!(output.patch.contains("--- /dev/null"));
        assert!(output.patch.contains("+++ b/new.txt"));
        assert!(output.patch.contains("@@ -0,0 +1,2 @@"));
    }

    /// A pure delete uses `/dev/null` on the after side.
    #[test]
    fn delete_uses_dev_null_after() {
        let output = build_unified_diff("x\ny", "", "gone.txt", -1);
        assert!(output.patch.contains("--- a/gone.txt"));
        assert!(output.patch.contains("+++ /dev/null"));
    }

    /// The context-limited header uses the slice-start form, distinct from the whole-file form.
    #[test]
    fn context_limit_uses_slice_start_header() {
        let before = "a\nb\nc\nd\ne";
        let after = "a\nb\nC\nd\ne";
        let output = build_unified_diff(before, after, "f.txt", 1);
        // One line of clipped context on each side => the header is not the whole-file `1,5` form.
        assert!(output.patch.contains("@@ -2,3 +2,3 @@"));
    }

    /// The `diff_patch` wrapper agrees with the counts from the same DP.
    #[test]
    fn diff_patch_matches_diff_counts() {
        let result_patch = diff_patch("a\nb\nc", "a\nB\nc", "f.txt", -1);
        let counts = diff_counts("a\nb\nc", "a\nB\nc", "f.txt", -1);
        assert_eq!(counts, vec![1, 1]);
        assert!(result_patch.contains("+B"));
        assert!(result_patch.contains("-b"));
    }

    /// A large-but-fittable input still takes the full-table path and round-trips the counts.
    #[test]
    fn large_input_matches_its_own_lcs() {
        let before: String = (0..2000)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut after = before.clone();
        after.push_str("\nappended");
        let (added, removed) = compute_line_change_stat(&before, &after);
        assert_eq!((added, removed), (1, 0));
    }

    /// Non-ASCII lines are compared as whole lines and survive the round trip.
    #[test]
    fn non_ascii_lines_round_trip() {
        let (added, removed) = compute_line_change_stat("文件.txt\n第二行", "文件.txt\n第三行");
        assert_eq!((added, removed), (1, 1));
    }
}
