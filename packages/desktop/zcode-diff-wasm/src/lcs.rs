//! The line-level longest-common-subsequence dynamic program.
//!
//! This is the single LCS both views (`patch` and `{added, removed}`) are derived from, ported
//! verbatim from `packages/ui/src/lib/toolDiffPreview.ts` (`appendDiffBodyWithLcs`, the 2-D table)
//! and `packages/shared/src/lineChangeStat.ts` (the rolling-1-D table). The two JavaScript versions
//! were divergent implementations of the same recurrence and could disagree; here there is one.
//!
//! The recurrence, as the JavaScript wrote it (indices walk from the END backwards):
//!
//! ```text
//! lcs[i][j] = before[i] == after[j] ? lcs[i+1][j+1] + 1
//!                                   : max(lcs[i+1][j], lcs[i][j+1])
//! ```
//!
//! The table is `(before_len + 1) x (after_len + 1)`; the extra row/column is the empty-suffix
//! base case (all zero). [`MAX_DIFF_CELLS`] bounds it (see the spec §2).

/// Upper bound on `before_len * after_len` for the full table.
///
/// Above this the caller takes the unique-anchor pre-split path (`anchor.rs`) instead of allocating
/// a table. This is a **safety valve, not a behavior fork**: it exists so a pathological input
/// cannot allocate an enormous table, and it is set well above the old JavaScript caps (60_000 for
/// the patch, 400_000 for the stat) so ordinary files never reach it. 4_000_000 cells is 16 MB as a
/// `Vec<u32>`, which is safe for a renderer.
pub const MAX_DIFF_CELLS: usize = 4_000_000;

/// The full `(n+1) x (m+1)` LCS table, flattened row-major.
///
/// `table[i * (m + 1) + j]` is the LCS length of `before[i..]` and `after[j..]`, so the answer for
/// the whole input is `table[0]`.
pub struct LcsTable {
    cells: Vec<u32>,
    after_len: usize,
}

impl LcsTable {
    /// Length of the longest common subsequence of the two slices.
    pub fn length(&self) -> u32 {
        self.cells[0]
    }

    /// LCS length of `before[before_index..]` and `after[after_index..]`.
    #[inline]
    pub fn at(&self, before_index: usize, after_index: usize) -> u32 {
        self.cells[before_index * (self.after_len + 1) + after_index]
    }
}

/// Build the full LCS table for two line slices.
///
/// Returns `None` when the input exceeds [`MAX_DIFF_CELLS`]; the caller then uses the anchor path.
pub fn build_table(before: &[&str], after: &[&str]) -> Option<LcsTable> {
    let before_len = before.len();
    let after_len = after.len();

    // Guard the multiplication against overflow before allocating. `checked_mul` on values that can
    // never both exceed `usize::MAX / 1` is still the honest way to state "this may not fit".
    let cells = before_len.checked_mul(after_len)?;
    if cells > MAX_DIFF_CELLS {
        return None;
    }

    let stride = after_len + 1;
    let mut table = vec![0u32; (before_len + 1) * stride];

    // Walk from the end so each cell only needs the row below and the column to the right, which
    // the loop has already computed — exactly the JavaScript iteration order.
    for i in (0..before_len).rev() {
        for j in (0..after_len).rev() {
            let value = if before[i] == after[j] {
                table[(i + 1) * stride + (j + 1)] + 1
            } else {
                table[(i + 1) * stride + j].max(table[i * stride + (j + 1)])
            };
            table[i * stride + j] = value;
        }
    }

    Some(LcsTable {
        cells: table,
        after_len,
    })
}

/// The `{added, removed}` view, computed from a table the caller already built.
///
/// Mirrors `computeLineChangeStat`'s arithmetic exactly: every line that is not part of the LCS was
/// either added (on the `after` side) or removed (on the `before` side).
///
/// `retained` is `LcsTable::length()`, i.e. the number of unchanged lines. The two callers pass
/// slices of equal identity semantics (both already trimmed the shared prefix/suffix), so the same
/// `retained` applies to both sides — which is why the JavaScript `lineChangeStat` subtracts one
/// shared `unchangedLineCount` from both totals.
pub fn line_change_stat(len_before: usize, len_after: usize, retained: u32) -> (u32, u32) {
    let retained = retained as usize;
    (
        (len_after - retained) as u32,
        (len_before - retained) as u32,
    )
}
