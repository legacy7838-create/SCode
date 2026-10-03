//! The git global-option safety gate.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3), ported from
//! `tool/handlers/bash-readonly-policy-argv-git.ts`.
//!
//! ## Why this is a security boundary and not a convenience
//!
//! `git -c core.pager=<command>` and `git --exec-path=...` run an arbitrary command,
//! while every later policy check still sees only `git <subcommand>`. If this predicate
//! drifts, a destructive command is classified read-only and runs **without asking**. So
//! the rule is strict: an unrecognised global option is not "probably fine", it is
//! rejected.

/// Long-form global options that redirect git at something other than the repository.
const GIT_GLOBAL_DANGEROUS_FLAGS: [&str; 11] = [
    "-c",
    "-C",
    "--attr-source",
    "--bare",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--shallow-file",
    "--super-prefix",
    "--work-tree",
];

/// Short options that take a value glued to them, e.g. `-C/tmp/elsewhere`.
const GIT_ATTACHED_DANGEROUS_SHORT_FLAGS: [&str; 2] = ["-c", "-C"];

/// Does any word in this argv name a dangerous git global option?
///
/// Port of `hasDangerousGitGlobalOption`.
pub fn has_dangerous_git_global_option(argv: &[String]) -> bool {
    argv.iter().any(|word| has_dangerous_git_global_option_word(word))
}

/// The same rule for a single word.
///
/// `normalizeGitArgv` needs the word form, not the argv scan, and must not reimplement
/// the predicate — that is exactly how the two copies would drift.
pub fn has_dangerous_git_global_option_word(word: &str) -> bool {
    if has_dangerous_attached_git_short_option_word(word) {
        return true;
    }
    if GIT_GLOBAL_DANGEROUS_FLAGS.contains(&word) {
        return true;
    }
    // The `=` form: `--exec-path=/tmp/evil` is as dangerous as the spaced form.
    GIT_GLOBAL_DANGEROUS_FLAGS
        .iter()
        .any(|flag| word.starts_with(&format!("{flag}=")))
}

/// Port of `hasDangerousAttachedGitShortOptionWord`.
///
/// The asymmetry between the two short flags is deliberate in the original and is
/// preserved here: for `-C` the character after the flag is not inspected, for `-c` it
/// must not be another `-`. `-C--x` is rejected, `-c--x` is not — changing that would
/// either admit a redirect or reject a legitimate flag, so it is pinned by the golden
/// corpus rather than "simplified".
fn has_dangerous_attached_git_short_option_word(word: &str) -> bool {
    GIT_ATTACHED_DANGEROUS_SHORT_FLAGS.iter().any(|flag| {
        if word.len() <= flag.len() || !word.starts_with(flag) {
            return false;
        }
        let next = word[flag.len()..].chars().next();
        match next {
            Some(next) => *flag == "-C" || next != '-',
            // A multi-byte next char cannot be "-".
            None => *flag == "-C",
        }
    })
}
