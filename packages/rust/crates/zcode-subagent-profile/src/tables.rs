//! The read-only command policy table.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3).
//!
//! The table is **data**, and the data is the single source of truth shared with the TypeScript
//! original: `readonly-tables-golden.json` is captured from the live tables by
//! `scripts/capture-readonly-tables-golden.ts` and embedded verbatim at compile time. It is not
//! transcribed by hand — 106 policies hand-copied would be a second source that silently
//! disagrees, which is the exact failure the golden harness exists to prevent.
//!
//! The one non-literal field is `additionalCommandIsDangerousCallback`, a function reference in
//! TypeScript. In the captured data it is a NAME, dispatched by `callbacks.rs`.
//!
//! ## The one regex
//!
//! `hostname` carries `^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$` — the only policy with a
//! `RegExp`. The workspace has no `regex` dependency, and this pattern is an anchored literal
//! plus a repeated flag group, so it is written out directly in `matches_hostname` rather than
//! pulling in an engine. Its behaviour is pinned by the golden corpus.

use serde_json::Value;

/// One policy entry. Absent fields mean the corresponding branch does not apply — the same
/// distinction the TypeScript `if (policy.safeFlags)` relies on.
#[derive(Debug, Clone, Default)]
pub struct CommandPolicy {
    pub allow_any_args: bool,
    pub command_only: bool,
    pub allow_compact_numeric_count_flag: bool,
    /// `Option` for the same reason as `safe_flags`: the original tests
    /// `policy.respectsDoubleDash === false`, so ABSENT (break here) and `false` (skip this
    /// word and keep scanning) are different behaviours.
    pub respects_double_dash: Option<bool>,
    /// `Option` because **absent** and **present-but-empty** are different states:
    /// `if (policy.safeFlags)` is truthy for `{}`, so an empty table still goes to the walker,
    /// while an absent one rejects outright. Collapsing them rejects `head -20`.
    pub safe_flags: Option<Vec<(String, crate::argvpolicy::SafeFlagValue)>>,
    /// The callback NAME, dispatched through `callbacks.rs`.
    pub additional_dangerous_callback: Option<String>,
}

impl CommandPolicy {
    fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let safe_flags = object
            .get("safeFlags")
            .and_then(Value::as_object)
            .map(|flags| {
                flags
                    .iter()
                    .filter_map(|(key, kind)| {
                        Some((
                            key.clone(),
                            crate::argvpolicy::SafeFlagValue::from_json(kind.as_str()?)?,
                        ))
                    })
                    .collect()
            });
        // `safeFlags` is optional: an `allowAnyArgs` or `commandOnly` policy has none, and
        // the original treats "no safeFlags" as "no flag branch", not "not a policy".
        Some(CommandPolicy {
            allow_any_args: object.get("allowAnyArgs").and_then(Value::as_bool).unwrap_or(false),
            command_only: object.get("commandOnly").and_then(Value::as_bool).unwrap_or(false),
            allow_compact_numeric_count_flag: object
                .get("allowCompactNumericCountFlag")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            respects_double_dash: object.get("respectsDoubleDash").and_then(Value::as_bool),
            safe_flags,
            additional_dangerous_callback: object
                .get("additionalCommandIsDangerousCallback")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// Look up a flag's value kind in the safe table.
    pub fn flag(&self, name: &str) -> Option<crate::argvpolicy::SafeFlagValue> {
        self.safe_flags
            .as_ref()?
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, kind)| *kind)
    }
}

/// The captured table, parsed once and shared.
pub struct PolicyTables {
    git: Value,
    multiword: Value,
    simple: Value,
    allow_any_commands: Vec<String>,
    allow_any_prefixes: Vec<String>,
}

fn tables_json() -> &'static str {
    // Embedded so the crate has no runtime file dependency and cannot drift from the build.
    include_str!(
        "../../../../../apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-tables-golden.json"
    )
}

impl PolicyTables {
    pub fn load() -> Result<Self, serde_json::Error> {
        let raw: Value = serde_json::from_str(tables_json())?;
        let list = |key: &str| -> Vec<String> {
            raw.get(key)
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default()
        };
        Ok(PolicyTables {
            git: raw.get("gitReadonlySubcommandPolicies").cloned().unwrap_or(Value::Null),
            multiword: raw
                .get("readonlyMultiwordCommandPolicies")
                .cloned()
                .unwrap_or(Value::Null),
            simple: raw.get("readonlyCommandPolicies").cloned().unwrap_or(Value::Null),
            allow_any_commands: list("readonlyAllowAnyArgCommands"),
            allow_any_prefixes: list("readonlyAllowAnyArgCommandPrefixes"),
        })
    }

    /// Look up a policy by its full command prefix, checking the multiword table first
    /// (longer prefixes win, as in the original's sort-by-length lookup).
    pub fn lookup(&self, prefix: &str) -> Option<CommandPolicy> {
        for table in [&self.multiword, &self.git, &self.simple] {
            if let Some(policy) = table.get(prefix).and_then(CommandPolicy::from_json) {
                return Some(policy);
            }
        }
        None
    }

    /// The git subcommand policies, longest prefix first — the order `isGitReadOnlyCommand`
    /// iterates.
    pub fn git_policies_by_length(&self) -> Vec<(String, CommandPolicy)> {
        let mut out: Vec<(String, CommandPolicy)> = self
            .git
            .as_object()
            .map(|map| {
                map.iter()
                    .filter_map(|(key, value)| Some((key.clone(), CommandPolicy::from_json(value)?)))
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|left, right| {
            right.0.split(' ').count().cmp(&left.0.split(' ').count())
        });
        out
    }

    /// The multiword policies (e.g. `gh auth status`), in table order.
    pub fn multiword_policies(&self) -> Vec<(String, CommandPolicy)> {
        self.multiword
            .as_object()
            .map(|map| {
                map.iter()
                    .filter_map(|(key, value)| Some((key.clone(), CommandPolicy::from_json(value)?)))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn is_allow_any_command(&self, command: &str) -> bool {
        self.allow_any_commands.iter().any(|name| name == command)
    }

    pub fn is_allow_any_prefix(&self, prefix: &str) -> bool {
        self.allow_any_prefixes.iter().any(|name| name == prefix)
    }

    /// Is this the single `hostname` policy? Kept as a helper so the regex branch in the
    /// evaluator has one owner.
    pub fn is_hostname_policy(&self, prefix: &str) -> bool {
        prefix == "hostname"
    }
}

/// `^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$`
pub fn matches_hostname(text: &str) -> bool {
    let trimmed = text.trim_start();
    let Some(rest) = trimmed.strip_prefix("hostname") else {
        return false;
    };
    // After the literal, zero or more ` <flag>` groups, then only whitespace may remain.
    let mut rest = rest;
    loop {
        // Trailing whitespace (and nothing else) ends the match.
        if rest.trim().is_empty() {
            return true;
        }
        if !rest.starts_with(' ') {
            return false;
        }
        // Skip exactly one space: the group is `\s+` in the pattern, and any further
        // whitespace is consumed by the next iteration's own separator.
        let after_space = rest[1..].trim_start_matches(' ');
        if after_space.starts_with("--") {
            let end = after_space
                .find(|c: char| !(c.is_ascii_alphabetic() || c == '-'))
                .unwrap_or(after_space.len());
            let flag = &after_space[..end];
            if flag.len() > 2 && flag[2..].bytes().all(|b| b.is_ascii_alphabetic() || b == b'-') {
                rest = &after_space[end..];
                continue;
            }
            return false;
        }
        if after_space.starts_with('-') && after_space.len() > 1 {
            let c = after_space.as_bytes()[1];
            if c.is_ascii_alphabetic() {
                rest = &after_space[2..];
                continue;
            }
        }
        return false;
    }
}
