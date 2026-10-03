//! The read-only argv flag policy.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3), ported from
//! `tool/handlers/bash-readonly-policy-argv-flags.ts`.
//!
//! ## The second half of the safety story
//!
//! After the git global-option gate, this decides whether the flags on an
//! otherwise-known command are all safe. Get it wrong in the permissive direction and a
//! write flag rides through on a read-only command — `git log --output=/etc/x`, `curl -o`,
//! `sed -i`. So the default throughout is **reject**, and an unrecognised flag is never
//! "probably fine".
//!
//! ## One rule, one owner
//!
//! The flags themselves are a table, not code: `SafeFlagValue` says what kind of value a
//! flag takes, and the walker decides how to read it. Porting the table means porting the
//! data too; the walker is the part that can be got subtly wrong, so that is what the
//! golden corpus pins, case by case.

use crate::tables::CommandPolicy;

/// Commands `xargs` may safely invoke. Anything else could be a write.
const XARGS_TARGET_COMMANDS: [&str; 8] = ["echo", "printf", "wc", "grep", "egrep", "fgrep", "head", "tail"];

/// `^-[a-zA-Z0-9_-]` — a word that looks like an option at all.
///
/// A word that does not match is a positional argument, and positionals are skipped: the
/// policy constrains flags, not file names. That is why `git log HEAD --oneline` passes
/// while `git log --force` does not.
const OPTION_PATTERN: fn(&str) -> bool = |word| {
    let bytes = word.as_bytes();
    bytes.len() > 1
        && bytes[0] == b'-'
        && (bytes[1].is_ascii_alphanumeric() || bytes[1] == b'_' || bytes[1] == b'-')
};

/// What a safe flag takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafeFlagValue {
    /// No value. An inline `=value` on such a flag is a REJECTION, not a value.
    None,
    Number,
    Char,
    Braces,
    Eof,
    OptionalString,
    String,
}

impl SafeFlagValue {
    pub fn from_json(value: &str) -> Option<Self> {
        Some(match value {
            "none" => Self::None,
            "number" => Self::Number,
            "char" => Self::Char,
            "{}" => Self::Braces,
            "EOF" => Self::Eof,
            "optionalString" => Self::OptionalString,
            "string" => Self::String,
            _ => return None,
        })
    }
}

// `CommandPolicy` is owned by `tables::CommandPolicy` — one definition of the policy shape,
// used by the table loader, the evaluator, and this flag walker. A second, parallel struct here
// is exactly how two copies drift.

/// Port of `isArgvAllowedByPolicy`.
pub fn is_argv_allowed_by_policy(
    argv: &[String],
    policy: &CommandPolicy,
    command_name: &str,
    start_index: usize,
) -> bool {
    if argv.is_empty() {
        return false;
    }
    if policy.allow_any_args {
        return true;
    }
    if policy.command_only {
        return argv.len() == start_index;
    }
    if policy.safe_flags.is_none() {
        return false;
    }
    flags_and_positionals_allowed(argv, policy, command_name, start_index)
}

fn flags_and_positionals_allowed(
    argv: &[String],
    policy: &CommandPolicy,
    command_name: &str,
    start_index: usize,
) -> bool {
    let mut index = start_index;
    while index < argv.len() {
        let Some(word) = argv.get(index).filter(|word| !word.is_empty()) else {
            index += 1;
            continue;
        };
        let word = word.as_str();

        // xargs runs its target command; the policy has to check the TARGET, not the flags.
        if command_name == "xargs" && (!word.starts_with('-') || word == "--") {
            let target: Option<&str> = if word == "--" {
                argv.get(index + 1).map(String::as_str)
            } else {
                Some(word)
            };
            return matches!(target, Some(target) if XARGS_TARGET_COMMANDS.contains(&target));
        }

        if word == "--" {
            // Some commands treat a later word as a file name, so scanning stops here.
            // `respectsDoubleDash === false` is the ONE case that skips instead — an ABSENT
            // value stops, which is what makes `git -- --output=/x` safe.
            if policy.respects_double_dash == Some(false) {
                index += 1;
                continue;
            }
            return true;
        }

        if is_head_tail_compact_count_flag(command_name, word) {
            index += 1;
            continue;
        }

        if policy.allow_compact_numeric_count_flag && is_compact_numeric_count_flag(word) {
            index += 1;
            continue;
        }

        if word.starts_with('-') && word.len() > 1 && OPTION_PATTERN(word) {
            let parsed = parse_option_word(word);
            let Some(flag_value) = policy.flag(parsed.flag) else {
                // Not in the table: try the attached-short-value and cluster forms before
                // rejecting, both of which are still constrained by the table.
                if let Some(short) = parse_short_flag_with_attached_value(word, policy) {
                    if !is_option_like_string_value_allowed(&short.value, command_name, &short.flag) {
                        return false;
                    }
                    if !matches_flag_value_kind(&short.value, short.kind) {
                        return false;
                    }
                    index += 1;
                    continue;
                }
                if is_short_flag_cluster_allowed(parsed.flag, policy) {
                    index += 1;
                    continue;
                }
                return false;
            };

            if flag_value == SafeFlagValue::None {
                // `--flag=x` on a flag that takes no value is a different flag's syntax
                // being smuggled in.
                if parsed.has_inline_value {
                    return false;
                }
                index += 1;
                continue;
            }

            if flag_value == SafeFlagValue::OptionalString {
                index += 1;
                continue;
            }

            let value = if parsed.has_inline_value {
                parsed.inline_value.clone()
            } else {
                match argv.get(index + 1) {
                    Some(value) => value.clone(),
                    None => return false,
                }
            };
            if flag_value == SafeFlagValue::String
                && !parsed.has_inline_value
                && !is_option_like_string_value_allowed(&value, command_name, parsed.flag)
            {
                return false;
            }
            if !matches_flag_value_kind(&value, flag_value) {
                return false;
            }
            index += if parsed.has_inline_value { 1 } else { 2 };
            continue;
        }

        // A positional argument, or a word that does not look like an option.
        index += 1;
    }

    true
}

struct ParsedOption<'a> {
    flag: &'a str,
    has_inline_value: bool,
    inline_value: String,
}

fn parse_option_word(word: &str) -> ParsedOption<'_> {
    match word.find('=') {
        None => ParsedOption { flag: word, has_inline_value: false, inline_value: String::new() },
        Some(at) => ParsedOption {
            flag: &word[..at],
            has_inline_value: true,
            inline_value: word[at + 1..].to_string(),
        },
    }
}

struct ShortAttached {
    flag: String,
    kind: SafeFlagValue,
    value: String,
}

fn parse_short_flag_with_attached_value(word: &str, policy: &CommandPolicy) -> Option<ShortAttached> {
    if !word.starts_with('-') || word.starts_with("--") || word.len() <= 2 {
        return None;
    }
    let flag = &word[..2];
    let kind = policy.flag(flag)?;
    if kind == SafeFlagValue::None {
        return None;
    }
    Some(ShortAttached { flag: flag.to_string(), kind, value: word[2..].to_string() })
}

/// `head -20` / `tail -5` are counts, not unknown flags.
fn is_head_tail_compact_count_flag(command_name: &str, word: &str) -> bool {
    (command_name == "head" || command_name == "tail") && is_compact_numeric_count_flag(word)
}

fn is_compact_numeric_count_flag(word: &str) -> bool {
    let Some(digits) = word.strip_prefix('-') else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// `-abc` where every letter is a known valueless flag.
fn is_short_flag_cluster_allowed(flag: &str, policy: &CommandPolicy) -> bool {
    if !flag.starts_with('-') || flag.starts_with("--") || flag.len() <= 2 {
        return false;
    }
    flag[1..].chars().all(|name| policy.flag(&format!("-{name}")) == Some(SafeFlagValue::None))
}

/// A value that itself looks like an option is only allowed where the original allows it:
/// `git --sort -v` is legitimate, `grep -e --help` is not.
fn is_option_like_string_value_allowed(value: &str, command_name: &str, flag: &str) -> bool {
    if !value.starts_with('-') || value.len() <= 1 || !OPTION_PATTERN(value) {
        return true;
    }
    command_name == "git" && flag == "--sort" && value[1..].starts_with(|c: char| c.is_ascii_alphabetic())
}

fn matches_flag_value_kind(value: &str, kind: SafeFlagValue) -> bool {
    match kind {
        SafeFlagValue::None => false,
        SafeFlagValue::Number => !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
        SafeFlagValue::OptionalString => true,
        SafeFlagValue::String => true,
        SafeFlagValue::Char => value.chars().count() == 1,
        SafeFlagValue::Braces => value == "{}",
        SafeFlagValue::Eof => value == "EOF",
    }
}

/// Build a `CommandPolicy` from the wire shape the golden corpus stores.
pub fn policy_from_json(value: &serde_json::Value) -> Option<CommandPolicy> {
    let object = value.as_object()?;
    let safe_flags = object.get("safeFlags").and_then(serde_json::Value::as_object).map(|flags| {
        flags
            .iter()
            .filter_map(|(key, kind)| Some((key.clone(), SafeFlagValue::from_json(kind.as_str()?)?)))
            .collect()
    });
    Some(CommandPolicy {
        allow_any_args: object.get("allowAnyArgs").and_then(serde_json::Value::as_bool).unwrap_or(false),
        command_only: object.get("commandOnly").and_then(serde_json::Value::as_bool).unwrap_or(false),
        allow_compact_numeric_count_flag: object
            .get("allowCompactNumericCountFlag")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        respects_double_dash: object.get("respectsDoubleDash").and_then(serde_json::Value::as_bool),
        safe_flags,
        additional_dangerous_callback: object
            .get("additionalCommandIsDangerousCallback")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    })
}
