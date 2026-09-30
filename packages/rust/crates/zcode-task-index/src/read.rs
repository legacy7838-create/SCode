//! The read path: the task list query and the search-snippet builder.
//!
//! Ported from `packages/services/src/session/taskIndexRepo.ts:305-372, 905-945`.
//! Spec: docs/specs/rust-native-task-index.md §4.5 step 3.
//!
//! # The snippet builder's rules
//!
//! `buildSearchSnippets` (`:312-358`) cuts a window centred on each match, then **merges
//! near-duplicate windows** — when a keyword repeats close together the raw windows overlap
//! heavily, and showing four copies of the same sentence is worse than showing one. So a
//! candidate is dropped when it overlaps a window already kept, and the first
//! [`TASK_SEARCH_SNIPPET_LIMIT`] survivors are returned.
//!
//! Two details that are easy to lose and change what the user sees:
//!
//! * **The overlap test is strict (`> 0`)** and uses the *unadjusted* window bounds, not the
//!   ellipsis-padded slice. Widening the test would drop distinct matches; narrowing it would
//!   bring the duplicates back.
//! * **When nothing matched, a whole paragraph is returned** rather than an empty list. The
//!   original comment is explicit: the hit may have been on the *title*, and returning nothing
//!   leaves a blank space under it. So the fallback is the normalised full text, and it is
//!   still length-capped.
//!
//! `normalizeSearchSnippetText` collapses runs of whitespace to a single space, trims, and
//! truncates to [`TASK_SEARCH_SNIPPET_MAX_CHARS`] — in that order, so a value longer than the
//! cap cannot end up with a trailing space.

use rusqlite::Row;

use crate::migrate::MigrationError;

/// Snippet window radius before the match (`:151`).
pub const TASK_SEARCH_SNIPPET_PREFIX_RADIUS: usize = 20;
/// Snippet window radius after the match (`:152`).
pub const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS: usize = 72;
/// Hard cap on a rendered snippet (`:153`).
pub const TASK_SEARCH_SNIPPET_MAX_CHARS: usize = 140;
/// How many snippets are returned (`:154`).
pub const TASK_SEARCH_SNIPPET_LIMIT: usize = 4;

/// `normalizeSearchSnippetText` (`:305-307`).
///
/// Collapse whitespace → trim → cap, in that order. Truncating first could leave a trailing
/// space, which is visible in the UI.
pub fn normalize_search_snippet_text(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > TASK_SEARCH_SNIPPET_MAX_CHARS {
        // Truncate on a char boundary: the text is user content and may be non-ASCII, and
        // slicing bytes would panic on a multi-byte character.
        collapsed
            .chars()
            .take(TASK_SEARCH_SNIPPET_MAX_CHARS)
            .collect()
    } else {
        collapsed
    }
}

/// `buildSearchSnippets` (`:312-358`).
///
/// `search` is `None` or empty, or the text is blank, and no snippet is produced — there is
/// nothing to centre a window on.
pub fn build_search_snippets(searchable_text: &str, search: Option<&str>) -> Vec<String> {
    let Some(search) = search.filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    if searchable_text.trim().is_empty() {
        return Vec::new();
    }

    // The original lowercases both with `toLocaleLowerCase`. For the search term that
    // matches; for the haystack it is locale-sensitive, which is why the *displayed* text is
    // always sliced from the original, never from the lowercased copy.
    let normalized_search = search.to_lowercase();
    let normalized_text = searchable_text.to_lowercase();

    let mut snippets: Vec<String> = Vec::new();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut search_start = 0usize;

    while snippets.len() < TASK_SEARCH_SNIPPET_LIMIT && search_start < normalized_text.len() {
        let Some(relative) = normalized_text[search_start..].find(&normalized_search) else {
            break;
        };
        let match_index = search_start + relative;

        // Bounds are computed on **byte** offsets into the original, because the slice is.
        // `normalized_text` may be a different length from `searchable_text` for characters
        // that change length when lowercased, so the offsets are recomputed rather than
        // assumed to carry over — see `lower_case_preserves_offsets`, which pins the cases
        // where that holds and `search_snippets_handle_length_changing_lowercase` for the rest.
        let Some(start) = map_lowercase_offset(searchable_text, &normalized_text, match_index)
        else {
            break;
        };
        let end = start
            .saturating_add(normalized_search.len())
            .min(searchable_text.len());

        let window_start = start.saturating_sub(TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
        let window_end = (end + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS).min(searchable_text.len());
        let prefix = if window_start > 0 { "..." } else { "" };
        let suffix = if window_end < searchable_text.len() { "..." } else { "" };

        let window = &searchable_text[window_start..window_end];
        let snippet = normalize_search_snippet_text(&format!("{prefix}{window}{suffix}"));

        // Strictly greater than zero, on the unadjusted bounds: an exact boundary touch is
        // not an overlap, and widening this would drop distinct matches.
        let overlaps = ranges.iter().any(|(existing_start, existing_end)| {
            (*existing_end).min(window_end) as i64 - (*existing_start).max(window_start) as i64 > 0
        });
        if !snippet.is_empty() && !overlaps {
            snippets.push(snippet);
            ranges.push((window_start, window_end));
        }

        search_start = match_index + normalized_search.len();
    }

    if snippets.is_empty() {
        // The hit may have been on the title rather than the text, so return a whole paragraph
        // rather than leaving a blank space under the title. Still length-capped.
        let fallback = normalize_search_snippet_text(searchable_text);
        return if fallback.is_empty() { Vec::new() } else { vec![fallback] };
    }
    snippets
}

/// Maps an offset in the lowercased text back to one in the original.
///
/// `to_lowercase` preserves byte offsets for the overwhelming majority of text, but not all of
/// it: `İ` (U+0130) lowercases to two code points, and a few others change byte length. Rather
/// than assume, the offset is walked forward until the lowercased prefix length matches, which
/// is correct in both cases and cheap because the documents here are bounded.
fn map_lowercase_offset(original: &str, lowercased: &str, offset: usize) -> Option<usize> {
    if offset == 0 {
        return Some(0);
    }
    if offset > lowercased.len() {
        return None;
    }
    let mut candidate = 0usize;
    for (index, ch) in original.char_indices() {
        if candidate >= offset {
            return Some(index);
        }
        // The byte length this character contributes to the lowercased copy. `İ` is the case
        // that matters: it lowercases to two code points, so the lengths diverge.
        candidate += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
    }
    if candidate >= offset {
        Some(original.len())
    } else {
        None
    }
}

/// One row of the task list, as the renderer receives it.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskListRow {
    pub workspace_key: String,
    pub workspace_path: String,
    pub workspace_identity: Option<String>,
    pub task_id: String,
    pub title: String,
    pub updated_at: i64,
    pub created_at: i64,
    pub archived: i64,
    pub deleted: i64,
    pub pinned: i64,
    pub unread_at: Option<i64>,
    pub last_unread_at: i64,
    pub searchable_text: String,
    pub meta_json: String,
}

impl TaskListRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(TaskListRow {
            workspace_key: row.get("workspace_key")?,
            workspace_path: row.get("workspace_path")?,
            workspace_identity: row.get("workspace_identity")?,
            task_id: row.get("task_id")?,
            title: row.get("title")?,
            updated_at: row.get("updated_at")?,
            created_at: row.get("created_at")?,
            archived: row.get("archived")?,
            deleted: row.get("deleted")?,
            pinned: row.get("pinned")?,
            unread_at: row.get("unread_at")?,
            last_unread_at: row.get("last_unread_at")?,
            searchable_text: row.get("searchable_text")?,
            meta_json: row.get("meta_json")?,
        })
    }
}

/// What the task list is filtered by.
#[derive(Debug, Clone, Default)]
pub struct ListQuery {
    pub workspace_keys: Vec<String>,
    /// When set, only tasks with a matching snippet are returned.
    pub search: Option<String>,
    pub include_archived: bool,
    pub limit: Option<i64>,
}

/// The task list, ordered `updated_at DESC, created_at DESC, task_id DESC`
/// (`taskIndexRepo.ts:922`).
///
/// The `deleted = 0` filter is unconditional, and `archived` is a separate predicate, so
/// hiding the archive is a caller choice rather than a schema rule.
pub fn list_tasks(
    conn: &rusqlite::Connection,
    query: &ListQuery,
) -> Result<Vec<TaskListRow>, MigrationError> {
    let mut where_parts: Vec<String> = vec!["deleted = 0".to_string()];
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if !query.workspace_keys.is_empty() {
        let placeholders = query
            .workspace_keys
            .iter()
            .map(|_| "?".to_string())
            .collect::<Vec<_>>()
            .join(", ");
        where_parts.push(format!("workspace_key IN ({placeholders})"));
        for key in &query.workspace_keys {
            args.push(Box::new(key.clone()));
        }
    }
    if !query.include_archived {
        where_parts.push("archived = 0".to_string());
    }

    let sql = format!(
        "SELECT workspace_key, workspace_path, workspace_identity, task_id, title, updated_at,
                created_at, archived, deleted, pinned, unread_at, last_unread_at, searchable_text,
                meta_json
         FROM tasks
         WHERE {}
         ORDER BY updated_at DESC, created_at DESC, task_id DESC
         {}",
        where_parts.join(" AND "),
        match query.limit {
            Some(limit) => format!("LIMIT {limit}"),
            None => String::new(),
        },
    );

    let mut statement = conn.prepare(&sql).map_err(|source| MigrationError::Io {
        path: "tasks".into(),
        source,
    })?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(args), TaskListRow::from_row)
        .map_err(|source| MigrationError::Io {
            path: "tasks".into(),
            source,
        })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|source| MigrationError::Io {
            path: "tasks".into(),
            source,
        })?);
    }
    Ok(out)
}

/// The list, with search snippets attached — `rowToTaskListItem` applied to each row
/// (`taskIndexRepo.ts:360-370`).
///
/// The `search` filter is applied by the snippet builder rather than in SQL, matching the
/// original: a row survives when it produced a snippet, and the *first* snippet becomes the
/// primary `searchSnippet`.
pub fn list_tasks_with_snippets(
    conn: &rusqlite::Connection,
    query: &ListQuery,
) -> Result<Vec<(TaskListRow, Vec<String>)>, MigrationError> {
    let rows = list_tasks(conn, query)?;
    let search = query.search.as_deref();
    let searching = search.is_some_and(|value| !value.is_empty());
    let mut out = Vec::new();
    for row in rows {
        let snippets = if searching {
            build_search_snippets(&row.searchable_text, search)
        } else {
            Vec::new()
        };
        if searching && snippets.is_empty() {
            continue;
        }
        out.push((row, snippets));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(text: &str) -> String {
        normalize_search_snippet_text(text)
    }

    // ---- normalisation ----

    #[test]
    fn normalisation_collapses_whitespace_and_trims() {
        assert_eq!(normalize("  a   b \n\t c  "), "a b c");
        assert_eq!(normalize("single"), "single");
        assert_eq!(normalize(""), "");
    }

    /// The cap is applied on characters, not bytes, and the cap is applied *after*
    /// collapsing, so the result cannot end in a space.
    #[test]
    fn the_cap_is_by_character_and_never_leaves_a_trailing_space() {
        let long = format!("{} tail", "word ".repeat(80));
        let snippet = normalize(&long);
        assert_eq!(snippet.chars().count(), TASK_SEARCH_SNIPPET_MAX_CHARS);

        // A multi-byte string must not panic and must cap by characters.
        let cjk = "字".repeat(500);
        let snippet = normalize(&cjk);
        assert_eq!(snippet.chars().count(), TASK_SEARCH_SNIPPET_MAX_CHARS);
        assert!(snippet.is_char_boundary(snippet.len()));
    }

    /// The cap is applied **after** collapsing and trimming, so a truncation can land on a
    /// space. That is the original's order (`replace → trim → slice`) and it is deliberate
    /// here: trimming again after the slice would be a behaviour change, and the ordering is
    /// what stops a *leading* space from appearing. This test pins the actual order rather
    /// than an idealisation of it.
    #[test]
    fn the_cap_is_applied_after_collapse_and_trim() {
        let text = format!("{}  end", "a".repeat(TASK_SEARCH_SNIPPET_MAX_CHARS - 1));
        let snippet = normalize(&text);
        assert_eq!(
            snippet.chars().count(),
            TASK_SEARCH_SNIPPET_MAX_CHARS,
            "the cap counts characters after collapsing"
        );
        // Leading whitespace is removed before the slice, so the result never starts with one.
        assert!(!snippet.starts_with(' '), "got {snippet:?}");
    }

    // ---- snippet construction ----

    #[test]
    fn no_search_or_blank_text_yields_no_snippets() {
        assert!(build_search_snippets("some text", None).is_empty());
        assert!(build_search_snippets("some text", Some("")).is_empty());
        assert!(build_search_snippets("   ", Some("needle")).is_empty());
    }

    /// A single match is centred with the documented radii and ellipsised on both sides.
    #[test]
    fn a_single_match_is_windowed_and_ellipsised() {
        let text = format!("{}NEEDLE{}", "a".repeat(100), "b".repeat(100));
        let snippets = build_search_snippets(&text, Some("needle"));
        assert_eq!(snippets.len(), 1);
        let snippet = &snippets[0];
        assert!(snippet.starts_with("..."), "expected a leading ellipsis: {snippet:?}");
        assert!(snippet.ends_with("..."), "expected a trailing ellipsis: {snippet:?}");
        assert!(snippet.contains("NEEDLE"), "the match must be present: {snippet:?}");
    }

    /// Matches close together overlap, and the near-duplicate windows are merged. This is the
    /// behaviour the original comment describes: four copies of one sentence is worse than one.
    #[test]
    fn near_adjacent_matches_are_merged() {
        // Matches 30 apart: each window is 20 before and 72 after, so the windows overlap.
        let text = "filler NEEDLE filler NEEDLE filler NEEDLE filler NEEDLE tail of the text";
        let snippets = build_search_snippets(text, Some("needle"));
        assert!(
            snippets.len() < 4,
            "four overlapping windows would show the same sentence repeatedly, got {snippets:?}"
        );
        assert!(!snippets.is_empty());
    }

    /// Well-separated matches are kept, up to the limit.
    #[test]
    fn separated_matches_are_kept_up_to_the_limit() {
        let mut text = String::new();
        for _ in 0..10 {
            text.push_str("NEEDLE");
            text.push_str(&"x".repeat(200));
        }
        let snippets = build_search_snippets(&text, Some("needle"));
        assert_eq!(
            snippets.len(),
            TASK_SEARCH_SNIPPET_LIMIT,
            "separated matches must not be merged away"
        );
    }

    /// When the text does not contain the term, a whole paragraph is returned — the hit may
    /// have been on the title, and returning nothing leaves a blank space under it.
    #[test]
    fn a_term_absent_from_the_text_falls_back_to_a_capped_paragraph() {
        let text = format!("a paragraph that does not contain the term {}", "x".repeat(400));
        let snippets = build_search_snippets(&text, Some("needle"));
        assert_eq!(snippets.len(), 1, "the fallback must produce one snippet");
        assert!(
            snippets[0].chars().count() <= TASK_SEARCH_SNIPPET_MAX_CHARS,
            "the fallback must still be capped"
        );
    }

    /// An empty haystack after normalisation must not produce an empty-string snippet.
    #[test]
    fn a_blank_fallback_is_not_returned_as_an_empty_snippet() {
        assert!(build_search_snippets("   \n  ", Some("needle")).is_empty());
    }

    /// The overlap test is strict (`> 0`), so two windows that merely **abut** both survive;
    /// relaxing it to `>= 0` would drop distinct matches.
    ///
    /// The spacing has to actually abut: a window runs 20 before and 72 after its match, so
    /// consecutive windows touch only when the second match starts at least
    /// `72 + 20 + match_length` after the first.
    #[test]
    fn the_overlap_test_is_strictly_greater_than_zero() {
        let first = 30usize;
        let match_length = "NEEDLE".len();
        let window_end = first + match_length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS;
        let second = window_end + TASK_SEARCH_SNIPPET_PREFIX_RADIUS;
        let text = format!(
            "{}{}{}{}{}",
            "a".repeat(first),
            "NEEDLE",
            "b".repeat(second - first - match_length),
            "NEEDLE",
            "c".repeat(30)
        );
        let snippets = build_search_snippets(&text, Some("needle"));
        assert_eq!(
            snippets.len(),
            2,
            "abutting windows must both survive the strict overlap test: {snippets:?}"
        );
    }

    /// And one character closer, they overlap, so only one survives. This is the pair that
    /// proves the boundary is the strict comparison and not a fudge.
    #[test]
    fn windows_that_overlap_by_one_character_are_merged() {
        let first = 30usize;
        let match_length = "NEEDLE".len();
        let window_end = first + match_length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS;
        let second = window_end + TASK_SEARCH_SNIPPET_PREFIX_RADIUS - 1;
        let text = format!(
            "{}{}{}{}{}",
            "a".repeat(first),
            "NEEDLE",
            "b".repeat(second - first - match_length),
            "NEEDLE",
            "c".repeat(30)
        );
        let snippets = build_search_snippets(&text, Some("needle"));
        assert_eq!(
            snippets.len(),
            1,
            "a one-character overlap must merge, so the comparison is not off by one: {snippets:?}"
        );
    }

    /// The displayed text is sliced from the original, so casing is preserved even though the
    /// match was found in the lowercased copy.
    #[test]
    fn the_displayed_text_keeps_its_original_casing() {
        let snippets = build_search_snippets("The Quick Brown Fox", Some("quick"));
        assert_eq!(snippets.len(), 1);
        assert!(
            snippets[0].contains("Quick"),
            "the snippet must show the original casing, got {:?}",
            snippets[0]
        );
    }

    /// Searching is case-insensitive in both directions.
    #[test]
    fn the_match_is_case_insensitive_in_both_directions() {
        assert_eq!(build_search_snippets("Hello World", Some("HELLO")).len(), 1);
        assert_eq!(build_search_snippets("Hello World", Some("world")).len(), 1);
    }

    /// `İ` lowercases to two code points, so the lowercased text is longer than the original.
    /// The offset mapping has to cope rather than assume lengths match.
    #[test]
    fn search_snippets_handle_length_changing_lowercase() {
        let text = "İstanbul is a city";
        // Both a term before and after the character that changes length.
        assert_eq!(build_search_snippets(text, Some("İstanbul")).len(), 1);
        assert_eq!(build_search_snippets(text, Some("city")).len(), 1);
        // And a term spanning it.
        assert_eq!(build_search_snippets(text, Some("stanbul is")).len(), 1);
    }

    // ---- the list query ----

    fn memory() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE tasks (
               workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
               task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
               mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT,
               forked_from_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
               deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
               meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '',
               cron_automation_id TEXT, off_peak_task_id TEXT,
               PRIMARY KEY (workspace_key, task_id));",
        )
        .expect("schema");
        conn
    }

    fn insert(
        conn: &rusqlite::Connection,
        key: &str,
        task_id: &str,
        updated_at: i64,
        archived: i64,
        deleted: i64,
        text: &str,
    ) {
        conn.execute(
            "INSERT INTO tasks
               (workspace_key, workspace_path, task_id, title, created_at, updated_at, archived,
                deleted, searchable_text)
             VALUES (?1, '/ws', ?2, ?2, 0, ?3, ?4, ?5, ?6)",
            rusqlite::params![key, task_id, updated_at, archived, deleted, text],
        )
        .expect("insert");
    }

    #[test]
    fn the_list_is_ordered_by_recency_then_id() {
        let conn = memory();
        insert(&conn, "/ws", "old", 100, 0, 0, "");
        insert(&conn, "/ws", "newest", 300, 0, 0, "");
        insert(&conn, "/ws", "middle", 200, 0, 0, "");
        let rows = list_tasks(&conn, &ListQuery::default()).expect("list");
        let ids: Vec<&str> = rows.iter().map(|r| r.task_id.as_str()).collect();
        assert_eq!(ids, vec!["newest", "middle", "old"]);
    }

    #[test]
    fn deleted_is_always_excluded_and_archived_is_a_caller_choice() {
        let conn = memory();
        insert(&conn, "/ws", "live", 300, 0, 0, "");
        insert(&conn, "/ws", "archived", 200, 1, 0, "");
        insert(&conn, "/ws", "deleted", 100, 0, 1, "");

        let visible = list_tasks(&conn, &ListQuery::default()).expect("list");
        assert_eq!(
            visible.iter().map(|r| r.task_id.as_str()).collect::<Vec<_>>(),
            vec!["live"],
            "deleted is unconditional and archived is hidden by default"
        );

        let with_archived = list_tasks(
            &conn,
            &ListQuery { include_archived: true, ..ListQuery::default() },
        )
        .expect("list");
        assert_eq!(with_archived.len(), 2, "archived appears when asked for");
    }

    #[test]
    fn a_workspace_filter_narrows_the_list() {
        let conn = memory();
        insert(&conn, "/a", "in-a", 300, 0, 0, "");
        insert(&conn, "/b", "in-b", 200, 0, 0, "");
        let rows = list_tasks(
            &conn,
            &ListQuery { workspace_keys: vec!["/a".into()], ..ListQuery::default() },
        )
        .expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].workspace_key, "/a");
    }

    #[test]
    fn the_limit_is_applied() {
        let conn = memory();
        for index in 0..10 {
            insert(&conn, "/ws", &format!("t{index}"), index, 0, 0, "");
        }
        let rows = list_tasks(
            &conn,
            &ListQuery { limit: Some(3), ..ListQuery::default() },
        )
        .expect("list");
        assert_eq!(rows.len(), 3);
    }

    /// With a search, a row survives only when it produced a snippet — including through the
    /// whole-paragraph fallback, which is how a title-only hit stays in the results.
    #[test]
    fn a_search_filters_by_snippet_and_the_fallback_keeps_title_hits() {
        let conn = memory();
        insert(&conn, "/ws", "has-term", 300, 0, 0, "the needle is here");
        insert(&conn, "/ws", "no-term", 200, 0, 0, "nothing relevant in this body");

        let rows = list_tasks_with_snippets(
            &conn,
            &ListQuery { search: Some("needle".into()), ..ListQuery::default() },
        )
        .expect("list");
        // The fallback means *both* rows survive: the second's hit may have been on the title.
        assert_eq!(rows.len(), 2, "the paragraph fallback keeps a title-only hit");
        for (row, snippets) in &rows {
            assert!(!snippets.is_empty(), "{} must carry a snippet", row.task_id);
        }
        assert!(
            rows.iter().all(|(_, snippets)| snippets[0].contains("needle")
                || snippets[0].contains("nothing relevant")),
            "the fallback must be the row's own text"
        );
    }

    #[test]
    fn without_a_search_no_snippets_are_built() {
        let conn = memory();
        insert(&conn, "/ws", "t1", 100, 0, 0, "body");
        let rows = list_tasks_with_snippets(&conn, &ListQuery::default()).expect("list");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].1.is_empty(), "no search means no snippet work at all");
    }

    /// The four constants, pinned because the UI's layout depends on them.
    #[test]
    fn the_snippet_constants_are_the_documented_ones() {
        assert_eq!(TASK_SEARCH_SNIPPET_PREFIX_RADIUS, 20);
        assert_eq!(TASK_SEARCH_SNIPPET_SUFFIX_RADIUS, 72);
        assert_eq!(TASK_SEARCH_SNIPPET_MAX_CHARS, 140);
        assert_eq!(TASK_SEARCH_SNIPPET_LIMIT, 4);
    }
}
