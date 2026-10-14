//! The unique-anchor pre-split fallback, ported verbatim from
//! `packages/ui/src/lib/toolDiffPreview.ts:133-250`.
//!
//! When the full LCS table would be too large ([`crate::lcs::MAX_DIFF_CELLS`]), the JavaScript
//! fallback splits the two sides at lines that occur **exactly once on each side** and whose order
//! agrees — those must line up in any common subsequence — then diffs the small gaps between anchors
//! normally. This preserves real hunk boundaries instead of degenerating to "delete all, add all",
//! which is what the pre-anchor code did and what the comment at `toolDiffPreview.ts:222-225`
//! records as a regression ("像 cli.ts 这种前后各插几行、但跨度很远的场景，会把整段未改内容误渲染成红绿大块").
//!
//! The anchor selection is the classic patience-diff longest-increasing-subsequence over the
//! candidate matches (`findIncreasingAnchorMatches`), ported with the same binary-search piles.

/// A line that occurs once in `before` at `before_index` and once in `after` at `after_index`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineMatch {
    pub before_index: usize,
    pub after_index: usize,
}

/// Collect lines that appear **exactly once** on each side and pair them up.
///
/// Mirrors `collectUniqueLineMatches`. Uses a hash map keyed by the line content; a line seen more
/// than once on either side is dropped (its position is ambiguous and cannot anchor anything).
pub fn collect_unique_line_matches(before: &[&str], after: &[&str]) -> Vec<LineMatch> {
    use std::collections::HashMap;

    // (first index, count) per line, keeping the first occurrence so a later duplicate can mark it
    // ambiguous without a second pass.
    let mut before_occurrences: HashMap<&str, (usize, u32)> = HashMap::with_capacity(before.len());
    for (index, line) in before.iter().enumerate() {
        before_occurrences
            .entry(line)
            .and_modify(|entry| entry.1 += 1)
            .or_insert((index, 1));
    }

    let mut after_occurrences: HashMap<&str, (usize, u32)> = HashMap::with_capacity(after.len());
    for (index, line) in after.iter().enumerate() {
        after_occurrences
            .entry(line)
            .and_modify(|entry| entry.1 += 1)
            .or_insert((index, 1));
    }

    let mut matches: Vec<LineMatch> = Vec::new();
    for (line, (before_index, before_count)) in &before_occurrences {
        if *before_count != 1 {
            continue;
        }
        if let Some((after_index, 1)) = after_occurrences.get(line) {
            matches.push(LineMatch {
                before_index: *before_index,
                after_index: *after_index,
            });
        }
    }

    // The JavaScript sorted by `beforeIndex` before the patience pass; the LIS requires that order.
    matches.sort_by_key(|line_match| line_match.before_index);
    matches
}

/// Longest strictly-increasing-by-`after_index` subsequence of `matches` (their `before_index` is
/// already sorted), returned in original order.
///
/// Mirrors `findIncreasingAnchorMatches`: patience sorting with a binary search over pile tops,
/// then a predecessor walk to reconstruct the chain.
pub fn find_increasing_anchor_matches(matches: &[LineMatch]) -> Vec<LineMatch> {
    if matches.is_empty() {
        return Vec::new();
    }

    let mut predecessors: Vec<isize> = vec![-1; matches.len()];
    let mut pile_tops: Vec<usize> = Vec::new();

    for (index, line_match) in matches.iter().enumerate() {
        let mut low = 0usize;
        let mut high = pile_tops.len();

        while low < high {
            let middle = (low + high) / 2;
            if matches[pile_tops[middle]].after_index < line_match.after_index {
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        if low > 0 {
            predecessors[index] = pile_tops[low - 1] as isize;
        }
        if low == pile_tops.len() {
            pile_tops.push(index);
        } else {
            pile_tops[low] = index;
        }
    }

    let mut anchors: Vec<LineMatch> = Vec::new();
    // `pile_tops` is non-empty here because `matches` is non-empty.
    let mut current_index = pile_tops[pile_tops.len() - 1] as isize;
    while current_index >= 0 {
        anchors.push(matches[current_index as usize]);
        current_index = predecessors[current_index as usize];
    }

    anchors.reverse();
    anchors
}

/// Anchor matches in the order they should split the two sides.
///
/// Composes the two steps above; the caller walks consecutive anchors and diffs the gaps.
pub fn find_anchors(before: &[&str], after: &[&str]) -> Vec<LineMatch> {
    find_increasing_anchor_matches(&collect_unique_line_matches(before, after))
}
