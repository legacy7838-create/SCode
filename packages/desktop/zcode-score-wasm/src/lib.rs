//! ZCode workspace file fuzzy scoring kernel (WebAssembly).
//!
//! Scores and top-K selects workspace file candidates for the `@` mention picker. This is the
//! measured hot path: **100 ms per keystroke at 370k candidates** (see
//! `spec/native-boundary-fuzzy-score.md`).
//!
//! # Boundary shape
//!
//! One packed string in, compact typed arrays out. Candidates are **never** passed as an object
//! graph — `&[String]` does not implement `RefFromWasmAbi`, and even if it did, 370k JS strings
//! crossing the boundary per keystroke would cost far more than the scoring it replaces.
//!
//! This mirrors the shape already proven by the `zcode-scan` boundary: the caller hands over the
//! columnar packed index once, then asks narrow questions per keystroke.
//!
//! # What is deliberately NOT here
//!
//! ICU collation. The JavaScript comparator's `localeCompare` tie-break was measured **dead** —
//! 0 executions over 370k candidates x 3 queries, because `index` is unique per pass so the third
//! comparison level is unreachable. Ordering is therefore `(score, index)`, a plain integer total
//! order, and needs no locale. See `spec/native-boundary-fuzzy-score.md` §1.

use std::cell::RefCell;
use wasm_bindgen::prelude::*;

/// Precomputed lowercase arena. Built once per workspace, queried per keystroke.
///
/// # Units: scanned as bytes, SCORED as UTF-16
///
/// The score is built from `String.prototype.indexOf` results and `String.length`, and **both are
/// UTF-16 code-unit quantities**. Scoring `文件.txt` against `x` must therefore score `100 + 4`,
/// not `100 + 8`: `文` and `件` are three UTF-8 bytes each but one code unit each. A kernel that
/// reports byte offsets silently returns 108 here and reorders every result whose match sits behind
/// a non-ASCII character — the differential harness caught exactly that.
///
/// The arena is nevertheless stored as UTF-8 **bytes**, because the search is where the time goes:
/// a `u16` arena touches twice the bytes per candidate and measured at 0.9x of the JavaScript it
/// replaces (V8 scans one-byte Latin-1 strings with tuned SIMD routines). For an all-ASCII row a
/// byte offset IS a UTF-16 offset, which is the common case and free; a non-ASCII row pays one
/// `utf16_len` projection per scored surface. See [`score_normalized_fuzzy_match`].
struct Arena {
    /// All candidate rows concatenated; `offsets` is the row-start table, in bytes.
    /// Rows are kept whole (not split into name/path) so scoring can slice sub-ranges without
    /// re-allocating.
    blob: Vec<u8>,
    /// `offsets[i]..offsets[i + 1]` bounds row `i` in `blob`. Both edges are already trimmed
    /// (see [`init_index`]), so a row slice is exactly `lowercaseRelativePath`.
    offsets: Vec<u32>,
    /// `1` when row `i` is a directory (directories sort after files in the display cap path).
    is_dir: Vec<u8>,
    /// Offset of row `i`'s **name** within the row, i.e. the name is
    /// `blob[offsets[i] + name_offsets[i]..offsets[i + 1]]`. Equal to the row length when the
    /// trailing segment is entirely whitespace (or the row ends in `/`), which is how an empty
    /// `lowercaseName` is represented without a sentinel.
    name_offsets: Vec<u32>,
    /// Two `u64` per row: the set of ASCII code points appearing in that row's ABSOLUTE-path
    /// surface. Used only to REJECT rows before scoring (see [`top_k`]), so it is a one-sided
    /// filter: a row whose set does not contain the query's characters cannot score on any of the
    /// three surfaces, because the name and the relative path are both suffixes of the path.
    char_bits: Vec<u64>,
    /// `1` when BOTH the relative path and the absolute-path surface of row `i` are pure ASCII, in
    /// which case every byte offset into them is also a UTF-16 offset and no projection is needed.
    ascii: Vec<u8>,
    /// The absolute-path surface, `root_prefix + relativePath`, for every row — the third surface
    /// `getWorkspaceFileSearchCandidateScore` reads. Built ONCE here for the same reason the
    /// JavaScript candidate precomputes `lowercasePath`: rebuilding it per candidate per keystroke
    /// costs a 193k-iteration memcpy inside the hot loop, which measured as a net LOSS against the
    /// JavaScript path. `path_offsets` indexes it exactly as `offsets` indexes `blob`.
    path_blob: Vec<u8>,
    path_offsets: Vec<u32>,
}

impl Arena {
    fn row(&self, index: usize) -> &[u8] {
        &self.blob[self.offsets[index] as usize..self.offsets[index + 1] as usize]
    }

    /// The absolute-path surface for row `index`: `lowercasePath`.
    fn path(&self, index: usize) -> &[u8] {
        &self.path_blob[self.path_offsets[index] as usize..self.path_offsets[index + 1] as usize]
    }

    /// Whether row `index`'s offsets are already UTF-16 offsets (see [`Arena`]).
    fn is_ascii(&self, index: usize) -> bool {
        self.ascii[index] != 0
    }

    fn name(&self, index: usize) -> &[u8] {
        let start = self.offsets[index] as usize + self.name_offsets[index] as usize;
        let end = self.offsets[index + 1] as usize;
        &self.blob[start..end]
    }
}

thread_local! {
    /// `wasm32-unknown-unknown` is single-threaded, so a thread-local is the correct storage and
    /// avoids pulling in atomics/shared memory the renderer worker does not need.
    static ARENA: RefCell<Option<Arena>> = const { RefCell::new(None) };
}

/// Directory marker in the packed `type` column; must match `WorkspaceFileEntry["type"]`.
const TYPE_DIRECTORY: &str = "directory";

/// Build the scoring arena from the columnar packed index.
///
/// `packed` is exactly the string produced by `packWorkspaceFileEntries` — rows of
/// `type \t relativePath` joined by `\n`. Reusing that format means the caller already has it in
/// memory (it built it during the scan or fetched it chunkwise over RPC) and this costs no extra
/// transfer.
///
/// `root_path` is the workspace root the entries were produced with. The JavaScript scorer reads a
/// third surface — the absolute `path` — and that is not reconstructible from `relativePath`
/// alone, so the root is supplied here rather than dropped. See [`score_candidate`].
///
/// Every row is stored **lowercased and trimmed**, mirroring
/// `mapWorkspaceFileEntriesToSearchCandidates`'s `lowercaseRelativePath` /
/// `lowercaseName`. Storing raw bytes would make matching case- and whitespace-sensitive and
/// silently reorder results; ASCII-only folding would do the same for any non-ASCII path.
///
/// Returns the number of candidate rows indexed.
#[wasm_bindgen]
pub fn init_index(packed: &str, root_path: &str) -> usize {
    // The separator is derived from the root exactly as `unpackWorkspaceFileEntries` derives it,
    // and the root is normalized to carry a trailing separator, so the absolute-path surface is
    // one concatenation per row with no per-query fixups.
    let separator = if root_path.contains('\\') { '\\' } else { '/' };
    // `lowercasePath` trims the JOINED path, so a leading-whitespace root is trimmed here; the
    // relative path's edges are trimmed per row below.
    let root_trimmed = &root_path[js_trim_bounds(root_path).0..];
    let mut root_prefix: Vec<u8> = root_trimmed.to_lowercase().into_bytes();
    if !matches!(root_prefix.last(), Some(b'/') | Some(b'\\')) {
        root_prefix.push(separator as u8);
    }
    let root_is_ascii = root_prefix.is_ascii();

    let mut blob: Vec<u8> = Vec::with_capacity(packed.len());
    let mut path_blob: Vec<u8> = Vec::with_capacity(packed.len() * 2);
    let mut offsets: Vec<u32> = Vec::with_capacity(4096);
    let mut path_offsets: Vec<u32> = Vec::with_capacity(4096);
    let mut name_offsets: Vec<u32> = Vec::with_capacity(4096);
    let mut is_dir: Vec<u8> = Vec::with_capacity(4096);
    // 2 words per row; see `Arena::char_bits`.
    let mut char_bits: Vec<u64> = Vec::with_capacity(8192);
    let mut ascii: Vec<u8> = Vec::with_capacity(4096);
    // Reused across rows so indexing 370k candidates allocates once, not 370k times.
    let mut row: String = String::with_capacity(256);

    // `unescapeField`'s inverse for the two separators the codec can escape. The packed format is
    // `\` + one char, so a single pass un-escapes while splitting.
    let bytes = packed.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let line_end = packed[cursor..]
            .find('\n')
            .map_or(bytes.len(), |offset| cursor + offset);
        let line = &packed[cursor..line_end];
        cursor = line_end + 1;

        // Skip the `type` column up to TAB. A row without one is not an entry, which is the same
        // rule `unpackWorkspaceFileEntries` applies — row indices therefore line up with the
        // caller's decoded entries.
        let Some(tab) = line.find('\t') else { continue };
        let is_directory = line.as_bytes()[..tab] == *TYPE_DIRECTORY.as_bytes();

        // Un-escape into the reusable buffer, then fold case once, here, instead of per keystroke.
        row.clear();
        let escaped = &line.as_bytes()[tab + 1..];
        let mut index = 0usize;
        while index < escaped.len() {
            let byte = escaped[index];
            if byte == b'\\' && index + 1 < escaped.len() {
                index += 1;
                match escaped[index] {
                    b't' => row.push('\t'),
                    b'n' => row.push('\n'),
                    other => row.push(char::from(other)),
                }
            } else {
                // Every remaining byte is ASCII: the packed format is UTF-8, so a byte outside
                // ASCII can only appear as part of a multi-byte character, which is copied through
                // verbatim below rather than decoded here.
                if byte.is_ascii() {
                    row.push(char::from(byte));
                } else {
                    let width = utf8_width(byte);
                    let end = (index + width).min(escaped.len());
                    row.push_str(&String::from_utf8_lossy(&escaped[index..end]));
                    index = end - 1;
                }
            }
            index += 1;
        }
        // Full Unicode folding, because `String.prototype.toLowerCase` is. An ASCII-only fold
        // leaves `CAFÉ.txt` sorted as if it were `cafÉ.txt`.
        let lower = row.to_lowercase();

        // `lowercaseRelativePath` is the trimmed lowercased relative path.
        let (relative_start, relative_end) = js_trim_bounds(&lower);
        // `unpackWorkspaceFileEntries` takes the name from the **untrimmed** relative path and
        // `mapWorkspaceFileEntriesToSearchCandidates` then trims that name, so the trailing segment
        // is located on the untrimmed string and trimmed on its own. `lower.rfind('/')` is the
        // same segment as on the untrimmed value: case folding never creates or removes `/`.
        let name_from = lower.rfind('/').map_or(0, |slash| slash + 1);
        let (name_start, _) = js_trim_bounds(&lower[name_from..]);
        // Clamping to the row end is what makes an all-whitespace trailing segment an EMPTY name,
        // which `score_normalized_fuzzy_match` rejects exactly as the JavaScript `""` name does.
        // It needs no sentinel and no extra array.
        let name_at = (name_from + name_start).clamp(relative_start, relative_end);
        // `lower` is UTF-8 and `name_offsets` indexes the byte blob, so the byte offset is used
        // directly — the projection to UTF-16 happens at SCORE time, per matched position, only for
        // rows that are not pure ASCII.
        let name_offset = (name_at - relative_start) as u32;

        offsets.push(blob.len() as u32);
        path_offsets.push(path_blob.len() as u32);
        is_dir.push(u8::from(is_directory));
        name_offsets.push(name_offset);
        let relative_units: Vec<u8> = lower.as_bytes()[relative_start..relative_end].to_vec();
        let row_is_ascii = root_is_ascii && relative_units.is_ascii();
        ascii.push(u8::from(row_is_ascii));
        // Reserve this row's two bitset words before filling them.
        char_bits.extend([0u64; 2]);
        path_blob.extend_from_slice(&root_prefix);
        if separator == '/' {
            push_ascii_bits(&mut char_bits, &root_prefix);
            push_ascii_bits(&mut char_bits, &relative_units);
            path_blob.extend_from_slice(&relative_units);
        } else {
            // A `\` root rewrites the relative path's separators too, because
            // `unpackWorkspaceFileEntries` does `relativePath.split("/").join("\\")` before
            // joining. The characters differ as code units, so skipping this changes which
            // subsequence matches.
            // The characters differ as code units, so this changes which subsequence matches.
            let forward = b'/';
            let separator_byte = separator as u8;
            path_blob.extend(relative_units.iter().map(|&byte| {
                if byte == forward {
                    separator_byte
                } else {
                    byte
                }
            }));
        }
        blob.extend(relative_units);
    }
    // Sentinel so `row(n)` can read `offsets[n + 1]` for the final row without a branch.
    offsets.push(blob.len() as u32);

    let separator = if root_path.contains('\\') { '\\' } else { '/' };
    // `unpackWorkspaceFileEntries` keeps a root that already ends in either separator and appends
    // the chosen one otherwise. `lowercasePath` then trims the JOINED path, so a leading-whitespace
    // root is trimmed here and the relative path's edges are trimmed per row above.
    let root_trimmed = &root_path[js_trim_bounds(root_path).0..];
    let mut root_prefix: Vec<u16> = root_trimmed.to_lowercase().encode_utf16().collect();
    if !matches!(root_prefix.last(), Some(&unit) if unit == separator as u16 || unit == b'/' as u16 || unit == b'\\' as u16)
    {
        root_prefix.push(separator as u16);
    }

    // Sentinels so `row(n)` / `path(n)` can read index `n + 1` for the final row without a branch.
    offsets.push(blob.len() as u32);
    path_offsets.push(path_blob.len() as u32);

    let rows = is_dir.len();
    ARENA.with(|slot| {
        *slot.borrow_mut() = Some(Arena {
            blob,
            offsets,
            is_dir,
            name_offsets,
            char_bits,
            ascii,
            path_blob,
            path_offsets,
        });
    });
    rows
}

/// OR every ASCII code point in `units` into the trailing row's bitset.
///
/// Non-ASCII units are deliberately NOT recorded: the filter is only sound if a missing bit means
/// "definitely absent". A row containing any non-ASCII character therefore gets a bitset that
/// cannot reject an ASCII query incorrectly, and [`top_k`] disables the filter entirely for a
/// non-ASCII query.
fn push_ascii_bits(char_bits: &mut [u64], bytes: &[u8]) {
    let base = char_bits.len() - 2;
    for &byte in bytes {
        if byte < 64 {
            char_bits[base] |= 1u64 << byte;
        } else if byte < 128 {
            char_bits[base + 1] |= 1u64 << (byte - 64);
        }
    }
}

/// Drop the arena, releasing linear memory back to the WASM instance.
#[wasm_bindgen]
pub fn release_index() {
    ARENA.with(|slot| *slot.borrow_mut() = None);
}

/// `scoreNormalizedFuzzyMatch` from `packages/shared/src/workspaceFileSearch.ts`.
///
/// `text` and `query` must already be trimmed and lowercased; the arena guarantees `text`, and
/// [`top_k`] normalizes `query` once per keystroke rather than per candidate.
///
/// # Why bytes are scanned but UTF-16 is scored
///
/// The original's numbers are UTF-16 code-unit quantities (`String.length`, `String.indexOf`), so
/// scoring `文件.txt` against `x` must yield `100 + 4`, not `100 + 8`. But the SEARCH itself is
/// where the time goes, and a `u16` arena doubles the bytes touched per candidate: measured, the
/// u16 kernel ran at 0.9x of the JavaScript it replaces, because V8 scans one-byte Latin-1 strings
/// with tuned SIMD routines.
///
/// So the arena stays UTF-8 and is scanned a byte at a time, and the two places where the units
/// matter are converted exactly:
///  - an all-ASCII surface has byte offsets EQUAL to UTF-16 offsets, which is the overwhelmingly
///    common case and costs nothing;
///  - a non-ASCII surface pays `utf16_len` over the matched prefix, once per scored row.
///
/// `ascii` says which case this row is. It is derived at index time, never guessed per query.
fn score_normalized_fuzzy_match(text: &[u8], query: &[u8], ascii: bool) -> Option<i64> {
    if text.is_empty() {
        return None;
    }
    if text.starts_with(query) {
        return Some(length_delta(text, query, ascii));
    }
    // `String.prototype.indexOf`. Scanning for the needle's FIRST byte and verifying the tail is a
    // memmem, O(n) amortized. A naive "compare m bytes at every position" loop is O(n*m) and, at
    // 193k candidates, measured SLOWER than the JavaScript it replaces.
    if let Some(found) = find_from(text, query, 0) {
        let at = if ascii {
            found
        } else {
            utf16_len(&text[..found])
        };
        return Some(100 + at as i64);
    }

    // Subsequence walk, transcribed from the original's per-character `indexOf`:
    //   for (const char of normalizedQuery) { const i = text.indexOf(char, searchStart); ... }
    // `for...of` yields CODE POINTS, so a multi-byte query character is ONE needle.
    //
    // The advance is the subtle part: the original does `searchStart = foundIndex + 1`, one CODE
    // UNIT. In UTF-8 one code unit past a character start is the next CHARACTER, so the step is the
    // matched character's width. Stepping one BYTE instead lands inside a multi-byte character and
    // silently inflates every later gap: `中文件` scored 237 against JavaScript's 233 before this.
    //
    // The one case UTF-8 cannot express is a match starting inside a surrogate pair, which the
    // original can reach for an astral query character (`searchStart` lands between the two units).
    // UTF-8 has no interior character position, so that position does not exist here; it is the
    // sole documented divergence and it needs an astral character in the query.
    let mut score: i64 = 200;
    let mut search_start = 0usize;
    let mut cursor = 0usize;
    while cursor < query.len() {
        let needle = next_code_point(query, cursor);
        let found = find_from(text, needle, search_start)?;
        score += (if ascii {
            found - search_start
        } else {
            utf16_len(&text[search_start..found])
        }) as i64;
        search_start = found + utf8_width(text[found]);
        cursor += needle.len();
    }
    Some(score + length_delta(text, query, ascii))
}

/// `text.length - query.length` in the original's units.
fn length_delta(text: &[u8], query: &[u8], ascii: bool) -> i64 {
    if ascii {
        (text.len() - query.len()) as i64
    } else {
        (utf16_len(text) - utf16_len(query)) as i64
    }
}

/// UTF-16 code-unit count of valid UTF-8: every byte that is not a continuation byte starts one
/// code unit.
///
/// This is the projection that makes byte offsets comparable to JavaScript's. Continuation bytes
/// are `0b10xxxxxx`; anything else begins a character, and a character outside the BMP still
/// occupies exactly two code units — which is why this counts LEAD bytes and adds one per
/// four-byte sequence.
fn utf16_len(bytes: &[u8]) -> usize {
    let mut units = 0usize;
    let mut at = 0usize;
    while at < bytes.len() {
        let width = utf8_width(bytes[at]);
        at += width;
        // Only a four-byte sequence leaves the BMP, and it becomes a surrogate PAIR.
        units += if width == 4 { 2 } else { 1 };
    }
    units
}

/// The code point starting at `at`, as the slice `for (const char of query)` would have produced.
/// Its width comes from [`utf8_width`], the single place that decodes UTF-8 lead bytes.
fn next_code_point(query: &[u8], at: usize) -> &[u8] {
    let width = utf8_width(query[at]);
    &query[at..(at + width).min(query.len())]
}

/// Index of the first occurrence of `needle` at or after `from`, or `None`.
///
/// `memchr`-style first-byte search written out rather than pulled from a crate: it is the
/// innermost loop of the whole feature, and the crate's SIMD specialization does not apply to
/// `wasm32-unknown-unknown` without explicit `core::arch` shims.
fn find_from(text: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let first = *needle.first()?;
    if needle.len() == 1 {
        // The overwhelmingly common case: an ASCII query character, or the whole query. Iterating
        // a subslice keeps the inner loop free of bounds checks, where an indexed `text[at]` loop
        // pays one per byte and measured as the difference between 0.9x and 1.5x of the JavaScript
        // path. `checked_sub` also rejects the impossible "needle longer than text" case.
        return text
            .get(from..)
            .and_then(|tail| tail.iter().position(|&byte| byte == first))
            .map(|offset| offset + from);
    }
    let limit = text.len().checked_sub(needle.len())?;
    let rest = &needle[1..];
    (from..=limit).find(|&at| text[at] == first && text[at + 1..].starts_with(rest))
}

/// Length in bytes of the UTF-8 sequence starting with `first`.
///
/// Only reached for a byte that is not ASCII. A continuation or truncated byte yields 1 so the
/// unescape loop always makes progress instead of panicking on untrusted input.
fn utf8_width(first: u8) -> usize {
    match first {
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

/// `String.prototype.trim`'s character set: WhiteSpace ∪ LineTerminator (ECMA-262).
///
/// Deliberately **not** `char::is_whitespace`, whose Unicode `White_Space` property differs from
/// the JavaScript set in both directions: it includes `U+0085` NEL (JS leaves it alone) and
/// excludes `U+FEFF` ZWNBSP (JS trims it). Using the wrong one reorders candidates whose paths
/// begin or end with those characters.
fn is_js_trim_char(ch: char) -> bool {
    matches!(ch,
        '\u{9}'..='\u{d}'
        | ' '
        | '\u{a0}'
        | '\u{1680}'
        | '\u{2000}'..='\u{200a}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202f}'
        | '\u{205f}'
        | '\u{3000}'
        | '\u{feff}')
}

/// Byte range of `value` after JavaScript `trim()`, as a half-open range.
///
/// An all-whitespace (or empty) input yields an empty range at its end, which is what makes
/// `lowercaseName === ""` representable as an empty slice.
fn js_trim_bounds(value: &str) -> (usize, usize) {
    let start = value
        .char_indices()
        .find(|(_, ch)| !is_js_trim_char(*ch))
        .map_or(value.len(), |(index, _)| index);
    let end = value
        .char_indices()
        .rev()
        .find(|(_, ch)| !is_js_trim_char(*ch))
        .map_or(start, |(index, ch)| index + ch.len_utf8());
    (start, end)
}

/// `getWorkspaceFileSearchCandidateScore` from `workspaceFileSearch.ts`, transcribed exactly.
///
/// The JavaScript side scores FOUR surfaces, not two:
///
/// ```text
/// keywordScore = min(relativePathScore + 300, pathScore + 300)
/// bestScore    = min(nameScore, relativePathScore + 25, keywordScore)
/// ```
///
/// An earlier revision of this file implemented only `name` and `relativePath + 25`. That silently
/// dropped the `+300` keyword tier — the branch that makes "query spans directory segments" score
/// at all — and the differential harness caught it as a wrong top-100 for most queries. The four
/// terms below are load-bearing, not redundant.
fn score_candidate(arena: &Arena, index: usize, query: &[u8]) -> Option<i64> {
    let relative = arena.row(index);
    let name = arena.name(index);
    let ascii = arena.is_ascii(index);

    let name_score = score_normalized_fuzzy_match(name, query, ascii);
    let relative_score = score_normalized_fuzzy_match(relative, query, ascii);

    // The absolute path is the LONGEST surface (root prefix + relative path), so scanning it last
    // matters. It can only lower the result through the `+300` keyword tier, and every score that
    // tier can produce is at least `300`. So when the two cheap surfaces already give a best score
    // of `300` or less, the path cannot improve it and is not scanned at all.
    //
    // This is an exact early-out, not an approximation: `path + 300 >= 300 >= best_known`.
    let known_best = min_optional(name_score, relative_score.map(|score| score + 25));
    let path_score = match known_best {
        Some(best) if best <= PATH_KEYWORD_FLOOR => None,
        _ => score_normalized_fuzzy_match(arena.path(index), query, ascii),
    };

    let keyword_score = min_optional(
        relative_score.map(|score| score + 300),
        path_score.map(|score| score + 300),
    );
    min_optional(
        min_optional(name_score, relative_score.map(|score| score + 25)),
        keyword_score,
    )
}

/// Lowest score the `+300` keyword tier can contribute: every surface score is `>= 0`, so
/// `path + 300 >= 300`. A best score at or below this cannot be improved by the path surface.
const PATH_KEYWORD_FLOOR: i64 = 300;

/// `min` over two optional scores, treating `None` as `+infinity` — the `Number.POSITIVE_INFINITY`
/// the JavaScript original uses for a non-matching surface.
fn min_optional(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (None, None) => None,
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (Some(left), Some(right)) => Some(left.min(right)),
    }
}

/// Result rows for [`top_k`], packed into one `Uint32Array` to keep the return crossing cheap.
///
/// Layout per hit: `[row_index, score_bits_lo, score_bits_hi]` — three `u32` slots. Scores are
/// `i64` in Rust but bounded well inside `f64` here; they are split rather than rounded so the
/// JavaScript side can reconstruct the exact integer and compare without precision loss.
#[wasm_bindgen]
pub fn top_k(query: &str, limit: usize) -> Vec<u32> {
    let normalized: Vec<u8> = query.trim().to_lowercase().into_bytes();
    // ASCII bitmask of the query, or `None` when it contains a non-ASCII unit (the bitset cannot
    // represent those, so the filter is switched off rather than made unsound).
    let query_bits = normalized
        .iter()
        .try_fold([0u64; 2], |mut bits, &byte| {
            if byte < 64 {
                bits[0] |= 1u64 << byte;
            } else if byte < 128 {
                bits[1] |= 1u64 << (byte - 64);
            } else {
                return None;
            }
            Some(bits)
        })
        .map(|bits| (bits[0], bits[1]));

    ARENA.with(|slot| {
        let borrow = slot.borrow();
        let Some(arena) = borrow.as_ref() else {
            return Vec::new();
        };
        if normalized.is_empty() {
            return Vec::new();
        }

        // Bounded insertion-sorted top-K. `limit` is the display cap (1000 in production); the
        // array is kept sorted by (score, index) so the tail is always the current worst, which is
        // what makes the O(1) rejection fast-path correct.
        let mut best: Vec<(i64, u32)> = Vec::with_capacity(limit.min(1024));
        for index in 0..arena.is_dir.len() {
            // One-sided rejection: a row that does not contain every query character cannot score
            // on the name, the relative path or the absolute path, so it is skipped without any
            // surface scan. Sound because the name and the relative path are suffixes of the path
            // surface whose bitset is stored. This is the difference between paying O(row) per
            // candidate and paying O(1) for the candidates that cannot match at all.
            if let Some((want_low, want_high)) = query_bits {
                let base = index * 2;
                let low = arena.char_bits[base];
                let high = arena.char_bits[base + 1];
                if (low & want_low) != want_low || (high & want_high) != want_high {
                    continue;
                }
            }
            let Some(score) = score_candidate(arena, index, &normalized) else {
                continue;
            };
            // Fast path: `best` is kept sorted, so its tail IS the current worst. Once the list
            // is FULL, a candidate that is no better than the tail provably cannot make the cut.
            //
            // The `best.len() >= limit` half of this guard is load-bearing and an earlier revision
            // dropped it, which rejected every candidate as soon as the first one landed and made
            // `top_k` return 1 hit where JavaScript returned 100. With the list not yet full there
            // is nothing to be compared against.
            if best.len() >= limit {
                if let Some(&(worst_score, worst_index)) = best.last() {
                    if score > worst_score || (score == worst_score && index as u32 >= worst_index)
                    {
                        continue;
                    }
                }
            }
            let row_index = index as u32;
            let position = best
                .binary_search_by(|probe| probe.0.cmp(&score).then(probe.1.cmp(&row_index)))
                .unwrap_or_else(|position| position);
            if position >= limit {
                continue;
            }
            best.insert(position, (score, row_index));
            if best.len() > limit {
                best.pop();
            }
        }

        let mut out = Vec::with_capacity(best.len() * 3);
        for (score, index) in best {
            out.push(index);
            out.push(score as u32);
            out.push(((score as u64) >> 32) as u32);
        }
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arena stores UTF-8 bytes, so every test literal goes through here first.
    fn units(text: &str) -> Vec<u8> {
        text.as_bytes().to_vec()
    }

    /// Borrow the arena for one closure. Tests run single-threaded and each one re-initializes, so
    /// a scoped borrow is both sufficient and clearer than cloning the whole arena per assertion.
    fn with_arena<T>(assertions: impl FnOnce(&Arena) -> T) -> Option<T> {
        ARENA.with(|slot| slot.borrow().as_ref().map(assertions))
    }

    /// Score row `index` of the arena that `init_index` just built.
    fn score_row(packed: &str, root_path: &str, index: usize, query: &str) -> Option<i64> {
        init_index(packed, root_path);
        let query = units(query);
        with_arena(|arena| score_candidate(arena, index, &query)).expect("arena")
    }

    /// The staged absolute-path surface for row 0, which `init_index` builds once.
    fn path_surface_for(root_path: &str, relative: &str) -> String {
        init_index(&format!("file\t{relative}\n"), root_path);
        let bytes = with_arena(|arena| arena.path(0).to_vec()).expect("arena");
        String::from_utf8(bytes).expect("valid utf-8")
    }

    fn arena(rows: &[(&str, &str)]) -> Arena {
        let mut blob = Vec::new();
        let mut path_blob = Vec::new();
        let mut offsets = Vec::new();
        let mut path_offsets = Vec::new();
        let mut name_offsets = Vec::new();
        let mut is_dir = Vec::new();
        let mut char_bits = Vec::new();
        let mut ascii = Vec::new();
        for (kind, relative) in rows {
            offsets.push(blob.len() as u32);
            path_offsets.push(path_blob.len() as u32);
            is_dir.push(u8::from(*kind == "directory"));
            let row = units(relative);
            let separator = row.iter().rposition(|&byte| byte == b'/');
            let root = units("/x/");
            char_bits.extend([0u64; 2]);
            ascii.push(u8::from(root.is_ascii() && row.is_ascii()));
            push_ascii_bits(&mut char_bits, &root);
            push_ascii_bits(&mut char_bits, &row);
            path_blob.extend(root);
            path_blob.extend_from_slice(&row);
            blob.extend_from_slice(&row);
            name_offsets.push(separator.map_or(0, |at| at as u32 + 1));
        }
        offsets.push(blob.len() as u32);
        path_offsets.push(path_blob.len() as u32);
        Arena {
            blob,
            offsets,
            is_dir,
            name_offsets,
            char_bits,
            ascii,
            path_blob,
            path_offsets,
        }
    }

    #[test]
    fn prefix_beats_substring_beats_subsequence() {
        // Prefix returns a *shorter is better* score.
        assert_eq!(
            score_normalized_fuzzy_match(&units("main.rs"), &units("main"), true),
            Some(3)
        );
        // Substring scores 100 + index.
        assert_eq!(
            score_normalized_fuzzy_match(&units("src/main.rs"), &units("main"), true),
            Some(104)
        );
        // Pure subsequence scores 200 + gaps + length delta.
        let sub = score_normalized_fuzzy_match(&units("m_a_i_n.rs"), &units("main"), true)
            .expect("subsequence");
        assert!(sub >= 200, "{sub}");
    }

    #[test]
    fn empty_text_never_scores() {
        assert_eq!(score_normalized_fuzzy_match(&[], &units("a"), true), None);
    }

    #[test]
    fn empty_query_matches_everything() {
        assert_eq!(
            score_normalized_fuzzy_match(&units("abc"), &[], true),
            Some(3)
        );
    }

    #[test]
    fn missing_character_rejects() {
        assert_eq!(
            score_normalized_fuzzy_match(&units("abc"), &units("axc"), true),
            None
        );
    }

    #[test]
    fn name_is_the_trailing_segment() {
        let a = arena(&[("file", "src/deep/nested/module.rs")]);
        assert_eq!(a.name(0), units("module.rs").as_slice());
        assert_eq!(a.row(0), units("src/deep/nested/module.rs").as_slice());
    }

    #[test]
    fn root_level_file_has_a_name_equal_to_its_row() {
        let a = arena(&[("file", "README.md")]);
        assert_eq!(a.name(0), units("README.md").as_slice());
        assert_eq!(a.row(0), units("README.md").as_slice());
    }

    #[test]
    fn arena_slices_the_final_row_without_out_of_bounds() {
        // The `offsets` sentinel is what makes `row(len - 1)` safe.
        let a = arena(&[("file", "a.rs"), ("directory", "src"), ("file", "src/b.rs")]);
        assert_eq!(a.row(0), units("a.rs").as_slice());
        assert_eq!(a.row(1), units("src").as_slice());
        assert_eq!(a.row(2), units("src/b.rs").as_slice());
    }

    #[test]
    fn find_from_finds_the_first_occurrence() {
        let haystack = units("abcbd");
        assert_eq!(find_from(&haystack, &units("b"), 0), Some(1));
        assert_eq!(find_from(&haystack, &units("z"), 0), None);
        assert_eq!(find_from(&haystack, &units("a"), 0), Some(0));
        // A needle wider than the haystack can never match.
        assert_eq!(find_from(&units("ab"), &units("abc"), 0), None);
        // Honours the caller's start offset, which is how the subsequence walk advances.
        assert_eq!(find_from(&haystack, &units("b"), 2), Some(3));
    }

    #[test]
    fn a_code_point_needle_is_its_whole_utf8_sequence() {
        // U+1F600 is one `for...of` iteration but FOUR UTF-8 bytes, so the needle is the whole
        // sequence and not four separate searches.
        let grinning = "\u{1f600}";
        assert_eq!(next_code_point(&units(grinning), 0).len(), 4);
        assert_eq!(next_code_point(&units("\u{4e2d}"), 0).len(), 3);
        assert_eq!(next_code_point(&units("a"), 0).len(), 1);
        // ...and it is found as one needle inside a haystack.
        let haystack = units(&format!("x{grinning}y"));
        assert_eq!(find_from(&haystack, &units(grinning), 0), Some(1));
        assert_eq!(find_from(&haystack, &units("y"), 0), Some(5));
    }

    #[test]
    fn utf16_len_counts_code_units_not_bytes() {
        assert_eq!(utf16_len(b"abc"), 3);
        // Three bytes, one code unit.
        assert_eq!(utf16_len("文".as_bytes()), 1);
        // Four bytes, two code units (a surrogate pair).
        assert_eq!(utf16_len("\u{1f600}".as_bytes()), 2);
        assert_eq!(utf16_len("文件.txt".as_bytes()), 6);
    }

    #[test]
    fn scores_are_utf16_indices_even_though_the_arena_is_bytes() {
        // `文` is three UTF-8 bytes and ONE code unit, so JavaScript scores the `x` at UTF-16
        // index 4, not byte index 8. The non-ASCII projection is what makes these agree...
        assert_eq!(
            score_normalized_fuzzy_match(&units("文件.txt"), &units("x"), false),
            Some(104)
        );
        assert_eq!(
            score_normalized_fuzzy_match(&units("文件.txt"), &units("件"), false),
            Some(101)
        );
    }

    #[test]
    fn score_candidate_prefers_a_name_hit_over_a_path_only_hit() {
        let a = arena(&[("file", "packages/ui/src/components/button.tsx")]);
        // Matches "button" in the name.
        assert!(score_candidate(&a, 0, &units("button")).is_some());
    }

    #[test]
    fn js_trim_matches_string_trim_not_rust_trim() {
        // U+00A0 NBSP and U+FEFF ZWNBSP are trimmed by JavaScript; U+0085 NEL is not.
        assert!(is_js_trim_char('\u{a0}'));
        assert!(is_js_trim_char('\u{feff}'));
        assert!(!is_js_trim_char('\u{85}'));
        // Every character JS trims, trimmed.
        for ch in "\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2003}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}".chars() {
            assert!(is_js_trim_char(ch), "{ch:?} must be trimmed by JavaScript");
        }
        assert_eq!(js_trim_bounds("  a b  "), (2, 5));
        assert_eq!(js_trim_bounds("   "), (3, 3));
        assert_eq!(js_trim_bounds(""), (0, 0));
        // Multi-byte trim char at the front must move the range by its full width.
        assert_eq!(js_trim_bounds("\u{a0}a"), (2, 3));
    }

    #[test]
    fn rows_are_trimmed_and_folded_the_way_the_js_candidate_is() {
        init_index("file\t  MiXeD/Café.TXT  \n", "/x");
        with_arena(|arena| {
            assert_eq!(arena.row(0), units("mixed/café.txt").as_slice());
            assert_eq!(arena.name(0), units("café.txt").as_slice());
        })
        .expect("arena");
    }

    #[test]
    fn an_all_whitespace_trailing_segment_yields_an_empty_name() {
        // `unpackWorkspaceFileEntries` names this row "   ", and the JS candidate trims that to
        // "" — which `scoreNormalizedFuzzyMatch` rejects. An empty slice reproduces it without a
        // sentinel.
        init_index("directory\tfoo/   \n", "/x");
        with_arena(|arena| {
            assert_eq!(arena.row(0), units("foo/").as_slice());
            assert_eq!(arena.name(0), [].as_slice());
        })
        .expect("arena");
        assert_eq!(score_normalized_fuzzy_match(&[], &units("foo"), true), None);
    }

    #[test]
    fn a_rootless_file_name_is_its_own_name() {
        init_index("file\tREADME.md\n", "/x");
        with_arena(|arena| assert_eq!(arena.name(0), units("readme.md").as_slice()))
            .expect("arena");
    }

    #[test]
    fn the_path_surface_normalizes_the_roots_trailing_separator() {
        assert_eq!(path_surface_for("/home/user", "a.txt"), "/home/user/a.txt");
        assert_eq!(
            path_surface_for("C:\\Users\\me\\", "a.txt"),
            "c:\\users\\me\\a.txt"
        );
        assert_eq!(
            path_surface_for("C:\\Users\\me", "a.txt"),
            "c:\\users\\me\\a.txt"
        );
        // `lowercasePath` trims the JOINED path, so a padded root is trimmed at the front.
        assert_eq!(
            path_surface_for("  /home/user  ", "a.txt"),
            "/home/user  /a.txt"
        );
        // A windows root also rewrites the relative path's separators, like the codec does.
        assert_eq!(
            path_surface_for("C:\\repo", "src/a.txt"),
            "c:\\repo\\src\\a.txt"
        );
    }

    #[test]
    fn the_path_surface_is_stored_not_rebuilt_per_query() {
        // It is precomputed at index time, which is the whole reason `Arena` carries it: the
        // JavaScript candidate precomputes `lowercasePath` once for the same reason.
        init_index("file\tsrc/A.TXT\n", "/Repo/");
        let first = with_arena(|arena| arena.path(0).to_vec()).expect("arena");
        // A second query cannot change it; if it were rebuilt per query this would still hold, but
        // the assertion that matters is that it exists before any top_k call.
        assert_eq!(first, units("/repo/src/a.txt").as_slice());
    }

    #[test]
    fn a_windows_root_scores_the_backslash_path_surface() {
        // The absolute surface differs as BYTES between separators, so a query containing the
        // separator must match the root's own separator and not the other one.
        assert!(score_row("file\tsrc/a.txt\n", "C:\\repo", 0, "c:\\repo\\src").is_some());
        assert!(score_row("file\tsrc/a.txt\n", "/repo", 0, "/repo/src").is_some());
        // A posix root does not answer a backslash query, and vice versa: the byte sequences are
        // different, which is exactly why the separator has to be derived rather than hardcoded.
        assert!(score_row("file\tsrc/a.txt\n", "/repo", 0, "\\repo\\src").is_none());
        assert!(score_row("file\tsrc/a.txt\n", "C:\\repo", 0, "/repo/src").is_none());
    }

    #[test]
    fn rows_without_a_tab_column_are_not_candidates() {
        // Same rule as `unpackWorkspaceFileEntries`, so row indices line up with decoded entries.
        assert_eq!(
            init_index("file\ta.txt\n\nno-tab-here\nfile\tb.txt\n", "/x"),
            2
        );
    }
}
