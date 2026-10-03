//! The bash permission rule matcher.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3), ported from
//! `tool/handlers/bash-command-rule-evaluator.ts`.
//!
//! ## Why this is the permission decision
//!
//! `evaluateBashRules` decides whether a user's saved rule (allow / deny / ask) matches the
//! command about to run. Drift in either direction is a real failure: matching too eagerly
//! lets an `allow` rule cover a destructive command, and matching too loosely means a saved
//! `deny` stops firing. It is the part of the Bash permission flow that the whole rule
//! surface depends on.
//!
//! ## Why wildcard matching is not a regex here
//!
//! The TypeScript builds `^…$` from a pattern split on `*` with the pieces escaped. The
//! workspace has no `regex` dependency, and re-expressing that escape step without an engine
//! is precisely where the two would diverge. Matching the wildcard grammar directly — split
//! on `*`, literal segments, `.*` between — is both smaller and harder to get subtly wrong.

/// Does a subject match a rule, using the same three shapes the original does?
///
/// - a rule ending in `:*` is a **prefix** rule; the subject must equal it, or continue with
///   a space or tab (so `git` does not match `gitx`)
/// - a rule containing `*` is a **wildcard**
/// - otherwise it is an **exact** string match
pub fn matches_invocation_rule(subject: &str, rule_content: Option<&str>) -> bool {
    let Some(rule) = rule_content else {
        // No content at all: the rule applies to every invocation of its tool.
        return true;
    };
    if rule.is_empty() {
        // Same branch, for the `?? ""` fallback the original reads in every path: an empty
        // rule is falsy in JavaScript, so it is a catch-all rather than a literal that
        // matches nothing.
        return true;
    }
    if let Some(prefix) = rule.strip_suffix(":*") {
        return subject == prefix
            || subject.starts_with(&format!("{prefix} "))
            || subject.starts_with(&format!("{prefix}\t"));
    }
    if rule.contains('*') {
        return wildcard_match(rule, subject);
    }
    subject == rule
}

/// `*` is the only metacharacter; every other character, including `?`, is literal.
///
/// Standard greedy glob with backtracking: `*` remembers where it was and grows one byte at
/// a time on mismatch. That is what the JavaScript `^…$` RegExp produced here — the original
/// escapes every other metacharacter before joining on `.*`, so nothing but `*` is special.
fn wildcard_match(pattern: &str, subject: &str) -> bool {
    let pattern = pattern.as_bytes();
    let subject = subject.as_bytes();
    let mut pi = 0usize;
    let mut si = 0usize;
    let mut star_pi: Option<usize> = None;
    let mut star_si = 0usize;

    while si < subject.len() {
        if pi < pattern.len() && pattern[pi] == subject[si] {
            pi += 1;
            si += 1;
        } else if pi < pattern.len() && pattern[pi] == b'*' {
            star_pi = Some(pi);
            pi += 1;
            star_si = si;
        } else if let Some(sp) = star_pi {
            pi = sp + 1;
            star_si += 1;
            si = star_si;
        } else {
            return false;
        }
    }
    // Trailing pattern must be stars only.
    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }
    pi == pattern.len()
}

/// Port of `evaluateBashRules`.
///
/// `all_subject_groups` / `required_subject_groups` are one group per command in the line;
/// `exact_commands` short-circuits to true on a direct hit, which is how a user's pinned
/// "always allow this exact command" rule keeps working even when the analysis says the
/// command is not safe.
pub fn evaluate_bash_rules(input: &BashRuleEvaluationInput) -> bool {
    if input.rules.iter().any(|rule| rule.is_empty()) {
        return true;
    }
    // The original requires at least one NON-EMPTY exact command before the short-circuit.
    if input.exact_commands.iter().any(|command| !command.is_empty())
        && input
            .rules
            .iter()
            .any(|rule| input.exact_commands.iter().any(|command| command == rule))
    {
        return true;
    }
    if !input.safe {
        return false;
    }

    let groups: &[Vec<String>] = if input.behavior == "allow" {
        &input.required_subject_groups
    } else {
        &input.all_subject_groups
    };
    if groups.is_empty() {
        return false;
    }

    if input.behavior != "allow" {
        // deny / ask: one matching group is enough to decide.
        return groups.iter().any(|subjects| {
            subjects
                .iter()
                .any(|subject| input.rules.iter().any(|rule| matches_invocation_rule(subject, Some(rule))))
        });
    }

    // allow: EVERY group must be covered.
    groups.iter().all(|subjects| {
        subjects
            .iter()
            .any(|subject| input.rules.iter().any(|rule| matches_invocation_rule(subject, Some(rule))))
    })
}

/// The rule table handed in, with `ruleContent` collapsed to `Option<&str>` semantics by
/// the caller: an absent `ruleContent` is `None` and an empty string is `Some("")`, matching
/// how the original reads `rule.ruleContent`.
pub struct BashRuleEvaluationInput {
    pub all_subject_groups: Vec<Vec<String>>,
    pub behavior: String,
    pub exact_commands: Vec<String>,
    pub required_subject_groups: Vec<Vec<String>>,
    /// `ruleContent ?? ""` — the original reads `rule.ruleContent ?? ""` in every branch.
    pub rules: Vec<String>,
    pub safe: bool,
}
