//! Differential test: the Rust `cron` engine against captured `croner` output.
//!
//! Spec: docs/specs/rust-native-cron.md §6.2 and D1.
//!
//! `croner` is the engine being replaced, and the Rust `cron` crate is a *different*
//! implementation with different edge cases. Invariant 3 (no behaviour forks) is therefore
//! only credible if the two are actually compared — a comment claiming parity is not
//! evidence. This replays a corpus captured from `croner@10.0.1` (see
//! `scripts/capture-croner-corpus.mjs`) through the Rust engine and reports every divergence.
//!
//! The corpus is committed, so this test is hermetic and needs no npm package. It is captured
//! with `TZ=UTC`; the epoch comparison is therefore only meaningful when the test also runs in
//! UTC, which the local-time property is checked separately in `parity_dst.rs`.
//!
//! **A divergence here is a bug to fix or a divergence to enumerate in spec §9 — never a
//! silently accepted difference.** If this test fails, either the engine regressed or the
//! corpus is stale; both need a human.

use serde::Deserialize;

use zcode_cron::expr::compute_next_run_at;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    croner_version: String,
    row_count: usize,
    rows: Vec<Row>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    expression: String,
    anchor: String,
    anchor_ms: i64,
    croner_threw: bool,
    croner_next_run_at: Option<i64>,
}

fn corpus() -> Corpus {
    let raw = include_str!("fixtures/croner-corpus.json");
    serde_json::from_str(raw).expect("the croner corpus must parse")
}

fn running_in_utc() -> bool {
    std::env::var("TZ").map(|zone| zone == "UTC").unwrap_or(false)
}

#[test]
fn the_corpus_is_loaded_and_covers_the_intended_ground() {
    let corpus = corpus();
    assert_eq!(corpus.croner_version, "10.0.1", "the captured engine version is pinned");
    assert_eq!(corpus.rows.len(), corpus.row_count);
    assert!(
        corpus.rows.len() >= 400,
        "corpus shrank to {} rows; the differential would be weaker than intended",
        corpus.rows.len()
    );

    // Guard that the generator's intent is still met, so a regenerated-but-narrower corpus
    // cannot pass unnoticed.
    let expressions: std::collections::BTreeSet<&str> =
        corpus.rows.iter().map(|row| row.expression.as_str()).collect();
    for required in [
        "* * * * *",
        "0 0 29 2 *",  // leap day
        "0 0 31 * *",  // day 31 in short months
        "*/1 * * * *",  // smallest step
        "*/12 * * * *", // largest step
        "0 9-17 * * *", // range
        "0 0 1,15 * *", // list
        "0 0 * * ?",    // question-mark wildcard
    ] {
        assert!(expressions.contains(required), "corpus is missing `{required}`");
    }
    // And that the malformed cases are present, since "both engines say no fire" is half the
    // contract.
    let rejected = corpus.rows.iter().filter(|row| row.croner_threw).count();
    assert!(
        rejected >= 50,
        "expected the malformed expressions to be present, found {rejected} rejected rows"
    );
}

/// Divergences from `croner@10.0.1` that are **known, accepted and enumerated**.
///
/// Spec §9 D1 requires every engine difference to be either fixed or listed with a rationale.
/// The list is matched exactly: a divergence that is not here fails the test, and an entry
/// that no longer diverges fails too, so neither a new regression nor a stale exemption can
/// sit unnoticed.
///
/// Each entry is `(expression, anchor label, reason)`.
type KnownDivergence = (&'static str, &'static str, &'static str);

const KNOWN_DIVERGENCES: &[KnownDivergence] = &[
    (
        "0 0 29 2 *",
        "2100-03-01T00:00:00Z",
        "ROOT CAUSE: the `cron` crate's search lattice has a hard year ceiling and cannot \
         produce a fire time after 2100-12-31. Verified in isolation — from 2099-03-01 \
         `0 0 1 1 *` resolves to 2100-01-01, but from 2100-03-01 it returns nothing, while \
         `* * * * *` still fires within minutes. So this is a ceiling, not a leap-year rule \
         difference: every nearer anchor agrees exactly (2025 -> 2028, 2030 -> 2032, 2050 -> \
         2052, 2090 -> 2092). croner finds 2104-02-29. A schedule whose next fire falls in \
         2101 or later reports 'no future fire' instead. No user automation can be anchored \
         that far out: 2100 is roughly three generations past the lifetime of any deployment \
         that will run this build.",
    ),
    (
        "@annually",
        "2100-03-01T00:00:00Z",
        "The same year ceiling as the row above. `@annually` expands to `0 0 1 1 *`, whose \
         next fire from 2100-03-01 is 2101-01-01 — past the lattice ceiling, so it reports 'no \
         future fire' where croner finds 2101-01-01. The nickname itself is supported and \
         agrees at every other anchor; only the ceiling differs.",
    ),
    (
        "0 0 */3 * *",
        "2024-02-29T23:59:00Z",
        "`*/N` in the **day-of-month** field has a different base in each engine: croner \
         resolves `*/3` from 29 Feb to 4 Mar, the crate to 1 Mar. The product never relied \
         on it — the deleted `parseCronFields` explicitly disclaimed step syntax outside the \
         minute field (`automationCron.ts:270-272`: \"ignore non-numeric tokens (such as \
         `*/2`)\"), and the only step form the product itself generates is `*/N * * * *` in \
         the minute field, where both engines agree. Left divergent rather than \
         reverse-engineered, because matching it would mean emulating croner's undocumented \
         step anchor.",
    ),
    (
        "0 0 */3 * *",
        "2028-02-29T12:00:00Z",
        "Same day-of-month step-base difference as the row above; a different anchor simply \
         surfaces it again.",
    ),
];

/// Whether `expression`/`anchor` is an enumerated divergence.
fn is_known_divergence(expression: &str, anchor: &str) -> Option<&'static str> {
    KNOWN_DIVERGENCES
        .iter()
        .find(|(expr, anchor_label, _)| *expr == expression && *anchor_label == anchor)
        .map(|(_, _, reason)| *reason)
}

/// The core differential. Every row must agree, except the enumerated divergences above.
#[test]
fn the_rust_engine_agrees_with_croner_on_every_row() {
    if !running_in_utc() {
        // Epoch comparison across zones is meaningless. The local-time behaviour is covered
        // zone-by-zone in `parity_dst.rs`; skip rather than fail on a developer's machine.
        eprintln!(
            "[differential] skipping: the corpus is TZ=UTC and this process is not. \
             Re-run with TZ=UTC for the epoch comparison."
        );
        return;
    }

    let corpus = corpus();
    let mut unexplained: Vec<String> = Vec::new();
    let mut explained: Vec<String> = Vec::new();
    let mut seen_known: Vec<(&str, &str)> = Vec::new();

    for row in &corpus.rows {
        let actual = compute_next_run_at(&row.expression, row.anchor_ms);
        let expected = row.croner_next_run_at;
        if actual == expected {
            // A known divergence that has been *fixed* must be removed from the list, or the
            // exemption rots.
            if let Some(reason) = is_known_divergence(&row.expression, &row.anchor) {
                unexplained.push(format!(
                    "{:?} from {} now agrees (expected {:?}); remove it from \
                     KNOWN_DIVERGENCES.\n  reason was: {reason}",
                    row.expression, row.anchor, expected
                ));
            }
            continue;
        }
        match is_known_divergence(&row.expression, &row.anchor) {
            Some(reason) => {
                explained.push(format!(
                    "  KNOWN {:?} @ {}: croner={} rust={}\n    {reason}",
                    row.expression,
                    row.anchor,
                    expected.map(|v| v.to_string()).unwrap_or("null".into()),
                    actual.map(|v| v.to_string()).unwrap_or("null".into()),
                ));
                seen_known.push((row.expression.as_str(), row.anchor.as_str()));
            }
            None => unexplained.push(format!(
                "  UNEXPLAINED {:?} from {} (epoch {}): croner={} rust={}{}",
                row.expression,
                row.anchor,
                row.anchor_ms,
                expected.map(|v| v.to_string()).unwrap_or("null".into()),
                actual.map(|v| v.to_string()).unwrap_or("null".into()),
                if row.croner_threw { "  [croner rejected this expression]" } else { "" },
            )),
        }
    }

    if !explained.is_empty() {
        println!("[differential] {} enumerated divergence(s):", explained.len());
        for note in &explained {
            println!("{note}");
        }
    }

    assert!(
        unexplained.is_empty(),
        "{} row(s) diverge without an enumerated reason:\n{}",
        unexplained.len(),
        unexplained.join("\n")
    );

    // Every exemption must actually be exercised, so a typo in an expression or anchor cannot
    // silently disable the check.
    for (expression, anchor, _) in KNOWN_DIVERGENCES {
        assert!(
            seen_known.contains(&(*expression, *anchor)),
            "KNOWN_DIVERGENCES lists {expression:?} @ {anchor:?} but that row no longer \
             diverges; the entry is dead weight and should be deleted"
        );
    }
}

/// A stricter view of the same corpus, split by outcome, so a failure says *which* behaviour
/// broke rather than just "something did".
#[test]
fn the_differential_covers_both_the_fire_and_the_no_fire_paths() {
    if !running_in_utc() {
        return;
    }
    let corpus = corpus();
    let mut fired = 0usize;
    let mut no_fire = 0usize;
    for row in &corpus.rows {
        match compute_next_run_at(&row.expression, row.anchor_ms) {
            Some(_) => fired += 1,
            None => no_fire += 1,
        }
    }
    // Both paths must be genuinely exercised, otherwise a regression in one of them would be
    // invisible: a corpus where everything "fires" would never notice a parser that accepts
    // garbage.
    assert!(fired > 300, "only {fired} rows produced a fire time");
    assert!(
        no_fire >= 50,
        "only {no_fire} rows produced 'no future fire'; the rejection path is untested"
    );
}

/// Every fire the Rust engine reports must be genuinely in the future. A `Some` value at or
/// before the probe would be a `compute_next_run_at` contract violation independent of what
/// croner happened to return.
#[test]
fn every_reported_fire_is_strictly_in_the_future() {
    let corpus = corpus();
    for row in &corpus.rows {
        if let Some(next) = compute_next_run_at(&row.expression, row.anchor_ms) {
            assert!(
                next > row.anchor_ms,
                "{:?} from {} returned {next}, which is not after the probe",
                row.expression,
                row.anchor
            );
        }
    }
}
