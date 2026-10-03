//! Golden parity: the Rust parser must reproduce the TypeScript parser exactly.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 0/1).
//!
//! `golden.json` is captured from the LIVE TypeScript parser by
//! `scripts/capture-agent-profile-golden.ts`. It is the oracle: if this test fails,
//! either the Rust port drifted or the TypeScript behaviour changed, and both need a
//! human decision. It is deliberately not auto-regenerated.

use std::path::PathBuf;

use serde_json::Value;
use zcode_subagent_profile::parse_agent_profile_from_markdown;

fn golden_path() -> PathBuf {
    // CARGO_MANIFEST_DIR = packages/rust/crates/zcode-subagent-profile
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/golden.json");
    path
}

fn golden() -> Value {
    let path = golden_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read golden corpus {}: {error}", path.display()));
    serde_json::from_str(&raw).expect("golden corpus must be valid JSON")
}

/// Remove values the TypeScript side derives after parsing.
fn strip_derived(profile: &Value) -> Value {
    let mut value = profile.clone();
    if let Some(map) = value.as_object_mut() {
        map.remove("modelSelection");
    }
    value
}

#[test]
fn golden_corpus_parses_identically_in_rust() {
    let corpus = golden();
    let cases = corpus.as_object().expect("golden corpus is an object");
    assert!(
        !cases.is_empty(),
        "golden corpus is empty: the TS oracle was never captured"
    );

    let mut failures: Vec<String> = Vec::new();

    for (name, case) in cases {
        let source = case["source"].as_str().expect("case has a source");
        let content = case["content"].as_str().expect("case has content");
        let expected = &case["parsed"];

        let actual = parse_agent_profile_from_markdown(content, source, Some(&format!("/golden/{name}.md")))
            .to_json();

        // Compare the fields that carry behaviour. `message` embeds the path and is
        // compared too, because a drifted message means a drifted rule.
        if actual["diagnostic"] != expected["diagnostic"] {
            failures.push(format!(
                "[{name}] diagnostic mismatch\n  rust: {}\n  ts:   {}",
                actual["diagnostic"], expected["diagnostic"]
            ));
        }
        // `modelSelection` is DERIVED, not parsed: TypeScript computes it from the raw
        // frontmatter map via `parseSubagentMarkdownSelection`. It stays in TypeScript
        // after the reader moves to Rust, so it is excluded from the comparison — but
        // the frontmatter that feeds it is compared below, so a drift in `model` or
        // `thoughtLevel` still fails the test.
        if strip_derived(&actual["profile"]) != strip_derived(&expected["profile"]) {
            failures.push(format!(
                "[{name}] profile mismatch\n  rust: {}\n  ts:   {}",
                actual["profile"], expected["profile"]
            ));
        }
        // `diagnostics` is the additive array; `diagnostic` above is the contract.
        // The TypeScript original only populates the array on its main return path,
        // so a `null` there means "not expressible", NOT "empty". Rust may always
        // populate it, but it must contain the primary diagnostic and must agree with
        // TypeScript wherever TypeScript is able to express a value.
        match &expected["diagnostics"] {
            Value::Null => {
                if let Value::Array(actual_items) = &actual["diagnostics"] {
                    if actual["diagnostic"] != Value::Null && !actual_items.contains(&actual["diagnostic"])
                    {
                        failures.push(format!(
                            "[{name}] Rust diagnostics array omits its own primary diagnostic: {actual_items:?}"
                        ));
                    }
                }
            }
            Value::Array(expected_items) => {
                let actual_items = actual["diagnostics"].as_array().cloned().unwrap_or_default();
                if expected_items != &actual_items {
                    failures.push(format!(
                        "[{name}] diagnostics mismatch\n  rust: {actual_items:?}\n  ts:   {expected_items:?}"
                    ));
                }
            }
            other => failures.push(format!("[{name}] golden diagnostics is not an array/null: {other}")),
        }
    }

    assert!(
        failures.is_empty(),
        "Rust/TypeScript profile parity broke in {} case(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// A model-pinned agent must still carry the raw frontmatter the model derivation
/// reads. Without this, deleting the TypeScript reader would silently unpin the model
/// of every agent that names one — a regression no other assertion would catch.
#[test]
fn model_pinning_survives_the_port_via_the_raw_frontmatter() {
    let outcome = parse_agent_profile_from_markdown(
        "---\nname: a\ndescription: d\nmodel: anthropic/claude-opus-5\nthoughtLevel: high\n---\nb",
        "user",
        None,
    );
    let profile = outcome.profile.expect("profile loads");
    let frontmatter = &profile.frontmatter;
    assert_eq!(frontmatter["model"], serde_json::json!("anthropic/claude-opus-5"));
    assert_eq!(frontmatter["thoughtLevel"], serde_json::json!("high"));
}

/// The yield contract is the part of the profile that gates a whole runtime path, so
/// it gets its own explicit assertions rather than only living in the corpus.
#[test]
fn yield_true_without_a_usable_schema_rejects_the_profile() {
    for content in [
        "---\nname: a\ndescription: d\nyield: true\n---\nbody",
        "---\nname: a\ndescription: d\nyield: true\noutputSchema: [1,2]\n---\nbody",
        "---\nname: a\ndescription: d\nyield: true\noutputSchema:\n  type: object\n---\nbody",
    ] {
        let outcome = parse_agent_profile_from_markdown(content, "user", Some("/x.md"));
        assert!(
            outcome.profile.is_none(),
            "profile must not load with an unenforceable contract: {content:?}"
        );
        assert_eq!(
            outcome.diagnostics.first().map(|d| d.code.as_str()),
            Some(zcode_subagent_profile::DIAGNOSTIC_INVALID_YIELD_SCHEMA),
            "expected agent_invalid_yield_schema for {content:?}"
        );
    }
}

#[test]
fn yield_with_an_object_schema_carries_the_contract() {
    let outcome = parse_agent_profile_from_markdown(
        "---\nname: a\ndescription: d\nyield: true\noutputSchema: {\"type\":\"object\"}\n---\nb",
        "user",
        None,
    );
    let profile = outcome.profile.expect("profile loads");
    assert_eq!(
        profile.yield_schema,
        Some(serde_json::json!({"type": "object"}))
    );
    assert!(outcome.diagnostics.is_empty());
}

#[test]
fn a_profile_without_yield_has_no_contract() {
    let outcome =
        parse_agent_profile_from_markdown("---\nname: a\ndescription: d\n---\nbody", "user", None);
    let profile = outcome.profile.expect("profile loads");
    assert!(profile.yield_schema.is_none());
    assert!(outcome.diagnostics.is_empty());
}
