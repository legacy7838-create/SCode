//! The read-only policy evaluator for one parsed invocation.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3), ported from
//! `tool/handlers/bash-readonly-policy-argv.ts` (and its `-direct` / `-io` helpers).
//!
//! This is the function that decides "does this one command count as read-only" given an
//! already-parsed invocation. It is the seam above every table and callback, so porting it
//! moves the read-only *decision*; only the grammar parse (`analyzeBashCommand`, the `unbash`
//! package) stays in TypeScript.
//!
//! The contract has three outcomes, not two, and the difference matters:
//! - `Some(true)`  — read-only
//! - `Some(false)` — definitely NOT read-only (a write, a redirect, a dangerous flag)
//! - `None`        — no opinion; the caller keeps evaluating other commands in the line
//!
//! Collapsing `None` into `false` would make every unlisted command deny-safe-but-wrong, and
//! collapsing it into `true` would treat unknown commands as read-only. The three-way result is
//! the whole point of this seam.

use crate::tables::{matches_hostname, PolicyTables};

/// `Option<bool>` — `None` is "no opinion", which the caller must not confuse with a denial.
pub(crate) type PolicyVerdict = Option<bool>;

/// One redirect on the invocation.
#[derive(Debug, Clone)]
pub struct Redirect {
    pub operator: String,
    pub target: String,
}

/// The parsed invocation fields the policy reads.
#[derive(Debug, Clone, Default)]
pub struct Invocation {
    pub argv: Vec<String>,
    pub command_text: String,
    /// Names of leading `NAME=value` assignments. An entry that is `None` means the assignment
    /// could not be read statically, which the original treats as unsafe.
    pub env_assignments: Vec<Option<String>>,
    pub redirects: Vec<Redirect>,
}

fn tables() -> &'static PolicyTables {
    use std::sync::OnceLock;
    static TABLES: OnceLock<PolicyTables> = OnceLock::new();
    TABLES.get_or_init(|| {
        PolicyTables::load().expect("the embedded policy table is valid JSON")
    })
}

/// `isUnsafeWindowsUncPath`: a `//host` or `\\host` path.
fn is_unsafe_windows_unc_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 3 {
        return false;
    }
    let double = (bytes[0] == b'/' && bytes[1] == b'/') || (bytes[0] == b'\\' && bytes[1] == b'\\');
    double && bytes[2] != b'/' && bytes[2] != b'\\'
}

/// `isUnsafeDeviceRedirectTarget`: `/dev/tcp/…` / `/dev/udp/…` opens a socket.
fn is_unsafe_device_redirect_target(target: &str) -> bool {
    for prefix in ["/dev/tcp/", "/dev/udp/"] {
        if target.starts_with(prefix) {
            return true;
        }
    }
    false
}

const SAFE_INPUT_REDIRECTS: [&str; 4] = ["<", "<<", "<&", "<<<"];

fn are_redirects_allowed(invocation: &Invocation) -> bool {
    for redirect in &invocation.redirects {
        if is_unsafe_device_redirect_target(&redirect.target) {
            return false;
        }
        if redirect.operator == ">&" && redirect.target.chars().all(|c| c.is_ascii_digit())
            && !redirect.target.is_empty()
        {
            continue;
        }
        if redirect.target == "/dev/null" {
            continue;
        }
        if SAFE_INPUT_REDIRECTS.contains(&redirect.operator.as_str()) {
            if is_unsafe_windows_unc_path(&redirect.target) {
                return false;
            }
            continue;
        }
        return false;
    }
    true
}

const FIND_WRITE_OPTIONS: [&str; 10] = [
    "-delete", "-exec", "-execdir", "-files0-from", "-fls", "-fprint", "-fprint0", "-fprintf",
    "-ok", "-okdir",
];

const FIND_VALUE_OPTIONS: &[&str] = &[
    "-Bmin", "-Bnewer", "-Btime", "-D", "-amin", "-anewer", "-atime", "-cmin", "-cnewer",
    "-context", "-ctime", "-f", "-flags", "-fstype", "-gid", "-group", "-ilname", "-iname",
    "-inum", "-ipath", "-iregex", "-iwholename", "-lname", "-links", "-maxdepth", "-mindepth",
    "-mmin", "-mnewer", "-mtime", "-name", "-newer", "-path", "-perm", "-printf", "-regex",
    "-regextype", "-samefile", "-size", "-type", "-used", "-user", "-wholename", "-xattrname",
    "-xtype", "-uid",
];

/// `isSafeFindArgv`: `find` only reads unless a write option is present.
fn is_safe_find_argv(argv: &[String]) -> bool {
    let mut index = 1usize;
    while index < argv.len() {
        let word = &argv[index];
        if FIND_WRITE_OPTIONS.contains(&word.as_str()) {
            return false;
        }
        if FIND_VALUE_OPTIONS.contains(&word.as_str()) || is_find_newer_combo(word) {
            index += 2;
            continue;
        }
        index += 1;
    }
    true
}

const FIND_NEWER_COMBO_LAST: [char; 4] = ['a', 'B', 'c', 'm'];
const FIND_NEWER_COMBO_PENULT: [char; 5] = ['a', 'B', 'c', 'm', 't'];

/// `/^-newer[aBcm][aBcmt]$/`
fn is_find_newer_combo(word: &str) -> bool {
    let chars: Vec<char> = word.chars().collect();
    chars.len() == 8
        && chars[0] == '-'
        && chars[1..6] == ['n', 'e', 'w', 'e', 'r']
        && FIND_NEWER_COMBO_LAST.contains(&chars[6])
        && FIND_NEWER_COMBO_PENULT.contains(&chars[7])
}

const READONLY_EXACT_ARGV_COMMANDS: [&[&str]; 5] = [
    &["ip", "addr"],
    &["node", "-v"],
    &["node", "--version"],
    &["python", "--version"],
    &["python3", "--version"],
];

fn argv_matches_any(argv: &[String], expected: &[&[&str]]) -> bool {
    expected.iter().any(|candidate| {
        argv.len() == candidate.len() && candidate.iter().zip(argv).all(|(word, arg)| *word == arg.as_str())
    })
}

/// `isSafePrintfArgv`: a printf FORMAT that consumes arguments (`*`, `%n`, `%s` with a
/// variable width) can pull a following argument into a dangerous position, so those are only
/// safe when every consumed argument is a plain literal number.
fn is_safe_printf_argv(argv: &[String]) -> bool {
    let second = argv.get(1).map(String::as_str).unwrap_or("");
    if second.starts_with('-') && second != "--" {
        return false;
    }
    let format_index = if second == "--" { 2 } else { 1 };
    let format = argv.get(format_index).map(String::as_str).unwrap_or("");
    if format.contains('$') {
        return false;
    }
    let normalized = format.replace("%%", "");

    // `\%x`-style escapes and `%n` write memory / emit a format.
    if has_backslash_escape(&normalized) || has_percent_n(&normalized) {
        return false;
    }
    let numeric_format = has_numeric_format(&normalized) || has_star_width(&normalized);
    if numeric_format {
        // Every argument the format consumes must be a literal number.
        for value in argv.iter().skip(format_index + 1) {
            if value.contains('[') || value.contains('`') || value.contains("$(") {
                return false;
            }
            if !is_literal_number(value) {
                return false;
            }
        }
    }
    true
}

/// `/%[^%a-zA-Z]*(?:hh|ll|[lLhqjzZt])?\\[0-7xX]/`
fn has_backslash_escape(format: &str) -> bool {
    let bytes = format.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && bytes[j] != b'%' && !bytes[j].is_ascii_alphabetic() {
            j += 1;
        }
        if j < bytes.len() {
            j += 1; // consume the specifier
            for length in ["hh", "ll"] {
                if format[j..].starts_with(length) {
                    j += length.len();
                    break;
                }
            }
            if j < bytes.len() && matches!(bytes[j], b'l' | b'L' | b'h' | b'q' | b'j' | b'z' | b'Z' | b't') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'\\' {
                let next = bytes.get(j + 1).copied().unwrap_or(0);
                if (b'0'..=b'7').contains(&next) || matches!(next, b'x' | b'X') {
                    return true;
                }
            }
        }
        i = j.max(i + 1);
    }
    false
}

/// `/\\[uU]/`
fn has_percent_n(format: &str) -> bool {
    // The original tests for a literal backslash followed by u/U anywhere, which is a
    // conservative block: any such escape is rejected.
    format.contains("\\u") || format.contains("\\U")
}

/// `/%[-+ 0#']*[0-9.*]*(?:hh|ll|[lLhqjzZt])?[diouxXeEfFgGaAn]/`
fn has_numeric_format(format: &str) -> bool {
    let bytes = format.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && matches!(bytes[j], b'-' | b'+' | b' ' | b'0' | b'#' | b'\'') {
            j += 1;
        }
        while j < bytes.len() && (bytes[j].is_ascii_digit() || matches!(bytes[j], b'.' | b'*')) {
            j += 1;
        }
        if j < bytes.len() {
            j += 1;
            for length in ["hh", "ll"] {
                if format[j..].starts_with(length) {
                    j += length.len();
                    break;
                }
            }
            if j < bytes.len() && matches!(bytes[j], b'l' | b'L' | b'h' | b'q' | b'j' | b'z' | b'Z' | b't') {
                j += 1;
            }
            if j < bytes.len() && matches!(bytes[j],
                b'd' | b'i' | b'o' | b'u' | b'x' | b'X' | b'e' | b'E' | b'f' | b'F' | b'g' | b'G'
                | b'a' | b'A' | b'n') {
                return true;
            }
        }
        i = j.max(i + 1);
    }
    false
}

/// `/%[^%a-zA-Z]*\*/` — a `*` width pulls the next argument as a number.
fn has_star_width(format: &str) -> bool {
    let bytes = format.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && bytes[j] != b'%' && !bytes[j].is_ascii_alphabetic() {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'*' {
            return true;
        }
        i = j.max(i + 1);
    }
    false
}

/// `/^[-+]?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)$/`
fn is_literal_number(value: &str) -> bool {
    crate::callbacks::is_safe_test_number_public(value)
}

/// `evaluateDirectReadonlyArgv` — the shortcuts that decide before any table is consulted.
fn evaluate_direct_readonly_argv(argv: &[String]) -> PolicyVerdict {
    if argv_matches_any(argv, &READONLY_EXACT_ARGV_COMMANDS) {
        return Some(true);
    }
    let head = argv.first().map(String::as_str).unwrap_or("");
    if head == "printf" {
        return Some(is_safe_printf_argv(argv));
    }
    if head == "find" {
        return Some(is_safe_find_argv(argv));
    }
    if head == "history" {
        let numeric = argv.get(1).map(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit()));
        return Some(argv.len() == 1 || (argv.len() == 2 && numeric.unwrap_or(false)));
    }
    if head == "arch" {
        return Some(argv.len() == 1
            || (argv.len() == 2 && (argv[1] == "-h" || argv[1] == "--help")));
    }
    if head == "ifconfig" {
        let alphabetic = argv
            .get(1)
            .map(|a| a.chars().next().is_some_and(|c| c.is_ascii_alphabetic()))
            .unwrap_or(false);
        return Some(argv.len() == 1 || (argv.len() == 2 && alphabetic));
    }
    None
}

/// `argsContainUnsafeSafeFlagText`: `$…` or a brace range can expand into anything.
fn args_contain_unsafe_safe_flag_text(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg.contains('$') || (arg.contains('{') && (arg.contains(',') || arg.contains("..")))
    })
}

/// `stripSafeCommandWrappers`: unwrap `command`/`env` so the policy sees the real program.
fn strip_safe_command_wrappers(argv: &[String]) -> Vec<String> {
    let mut stripped = argv.to_vec();
    loop {
        if stripped.first().map(String::as_str) == Some("command") {
            let mut index = 1usize;
            while stripped.get(index).is_some_and(|word| {
                word.starts_with('-')
                    && word.len() > 1
                    && word[1..].bytes().all(|b| b == b'p')
            }) {
                index += 1;
            }
            if stripped.get(index).map(String::as_str) == Some("--") {
                index += 1;
            }
            if index >= stripped.len() || stripped[index].starts_with('-') {
                return stripped;
            }
            stripped = stripped[index..].to_vec();
            continue;
        }
        if stripped.first().map(String::as_str) == Some("builtin") {
            let index = if stripped.get(1).map(String::as_str) == Some("--") { 2 } else { 1 };
            if index >= stripped.len() {
                return stripped;
            }
            stripped = stripped[index..].to_vec();
            continue;
        }
        if stripped.first().map(String::as_str) == Some("noglob") {
            if stripped.len() <= 1 {
                return stripped;
            }
            stripped = stripped[1..].to_vec();
            continue;
        }
        return stripped;
    }
}

/// `normalizeGitArgv`: rewrite a git argv into the canonical `[git, subcommand, …]` the table
/// expects, or `None` when an unrecognised global option makes it unsafe to reason about.
fn normalize_git_argv(argv: &[String]) -> Option<Vec<String>> {
    let mut normalized = vec!["git".to_string()];
    let mut index = 1usize;
    while index < argv.len() {
        let word = &argv[index];
        if word.is_empty() {
            index += 1;
            continue;
        }
        if is_no_value_git_global_flag(word) {
            index += 1;
            continue;
        }
        if crate::gitflags::has_dangerous_git_global_option_word(word) {
            return None;
        }
        // No git global flag takes a value in the current table, so any `-…` is unknown.
        if word.starts_with('-') {
            return None;
        }
        normalized.extend(argv[index..].iter().cloned());
        return Some(normalized);
    }
    None
}

fn is_no_value_git_global_flag(word: &str) -> bool {
    word == "--no-pager" || word == "--paginate"
}

/// `isGitReadOnlyCommand`.
fn is_git_read_only_command(argv: &[String]) -> bool {
    let Some(normalized) = normalize_git_argv(argv) else {
        return false;
    };
    for (prefix, policy) in tables().git_policies_by_length() {
        let prefix_words: Vec<&str> = prefix.split(' ').collect();
        if !prefix_words
            .iter()
            .enumerate()
            .all(|(index, word)| normalized.get(index).map(String::as_str) == Some(*word))
        {
            continue;
        }
        let rest: Vec<String> = normalized[prefix_words.len()..].to_vec();
        if let Some(callback) = &policy.additional_dangerous_callback {
            if run_callback(callback, &prefix, &rest) {
                return false;
            }
        }
        let command_name = normalized.first().cloned().unwrap_or_default();
        return crate::argvpolicy::is_argv_allowed_by_policy(
            &normalized,
            &policy,
            &command_name,
            prefix_words.len(),
        );
    }
    false
}

/// Dispatch a table callback by NAME — the same dispatcher the napi boundary uses.
fn run_callback(name: &str, command_text: &str, args: &[String]) -> bool {
    crate::run_danger_callback(name, args)
        .unwrap_or_else(|| panic!("policy table references unknown callback {name}"))
        && !command_text.is_empty()
}

fn policy_matches_regex(prefix: &str, command_text: &str) -> bool {
    tables().is_hostname_policy(prefix) && matches_hostname(command_text)
}

/// `evaluateBashReadonlyPolicy` — the port's centre.
pub fn evaluate_bash_readonly_policy(invocation: &Invocation) -> PolicyVerdict {
    // Gates first: an unsafe env assignment or redirect decides it before any table.
    for assignment in &invocation.env_assignments {
        match assignment {
            None => return Some(false),
            Some(name) if !is_safe_env_assignment(name) => return Some(false),
            Some(_) => {}
        }
    }
    if !are_redirects_allowed(invocation) {
        return Some(false);
    }

    let argv = strip_safe_command_wrappers(&invocation.argv);
    if argv.is_empty() {
        return Some(false);
    }
    if argv.iter().any(|word| is_unsafe_windows_unc_path(word)) {
        return Some(false);
    }
    if argv.first().map(String::as_str) == Some("git") {
        return Some(is_git_read_only_command(&argv));
    }

    if let Some(direct) = evaluate_direct_readonly_argv(&argv) {
        return Some(direct);
    }

    if let Some(prefix_result) = evaluate_readonly_prefix_policy(&argv, &invocation.command_text) {
        return Some(prefix_result);
    }

    let head = argv.first().map(String::as_str).unwrap_or("");
    if tables().is_allow_any_command(head) {
        return Some(true);
    }

    // `?` would be wrong here: a missing policy is the "no opinion" VERDICT, not an
    // error to propagate. `None` from a lookup and `None` from this function mean the same
    // thing, but only by accident — spelling it out keeps the two apart.
    #[allow(clippy::question_mark)]
    let Some(policy) = tables().lookup(head) else {
        return None;
    };
    if head == "cd" && argv.len() > 2 {
        return Some(false);
    }
    if let Some(callback) = &policy.additional_dangerous_callback {
        if run_callback(callback, &invocation.command_text, &argv[1..]) {
            return Some(false);
        }
    }
    if !crate::argvpolicy::is_argv_allowed_by_policy(&argv, &policy, head, 1) {
        return Some(false);
    }
    if tables().is_hostname_policy(head) && !matches_hostname(&invocation.command_text) {
        return Some(false);
    }
    Some(true)
}

/// `SAFE_ENV_ASSIGNMENTS` — a FIXED set. There is deliberately no prefix rule: an earlier
/// draft guessed `ZCODE_*` / `PATH` style prefixes, which both admitted assignments the
/// original rejects and (because the list was wrong) rejected ones it accepts.
const SAFE_ENV_ASSIGNMENTS: [&str; 39] = [
    "ANTHROPIC_API_KEY", "BLOCK_SIZE", "BLOCKSIZE", "CGO_ENABLED", "CHARSET", "CI", "CLICOLOR",
    "CLICOLOR_FORCE", "COLORTERM", "COLUMNS", "DEBIAN_FRONTEND", "FORCE_COLOR", "GCC_COLORS",
    "GIT_TERMINAL_PROMPT", "GO111MODULE", "GOARCH", "GOEXPERIMENT", "GOOS", "GREP_COLOR",
    "GREP_COLORS", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_TIME", "LINES", "LSCOLORS",
    "LS_COLORS", "NO_COLOR", "NODE_ENV", "PYTEST_DEBUG", "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
    "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "RUST_BACKTRACE", "RUST_LOG", "TERM",
    "TIME_STYLE", "TZ",
];

fn is_safe_env_assignment(name: &str) -> bool {
    SAFE_ENV_ASSIGNMENTS.contains(&name)
}

fn evaluate_readonly_prefix_policy(argv: &[String], command_text: &str) -> PolicyVerdict {
    // Longest prefix wins, as in the original's sort-by-length lookup.
    let mut candidates: Vec<(String, crate::tables::CommandPolicy)> = tables()
        .multiword_policies()
        .into_iter()
        .collect();
    candidates.sort_by(|left, right| {
        right.0.split(' ').count().cmp(&left.0.split(' ').count())
    });

    for (prefix, policy) in candidates {
        let prefix_words: Vec<&str> = prefix.split(' ').collect();
        if !prefix_words
            .iter()
            .enumerate()
            .all(|(index, word)| argv.get(index).map(String::as_str) == Some(*word))
        {
            continue;
        }
        let rest: Vec<String> = argv[prefix_words.len()..].to_vec();
        if args_contain_unsafe_safe_flag_text(&rest) {
            return Some(false);
        }
        if let Some(callback) = &policy.additional_dangerous_callback {
            if run_callback(callback, &prefix, &rest) {
                return Some(false);
            }
        }
        let head = argv.first().cloned().unwrap_or_default();
        if !crate::argvpolicy::is_argv_allowed_by_policy(argv, &policy, &head, prefix_words.len()) {
            return Some(false);
        }
        if policy_matches_regex(&prefix, command_text) && !matches_hostname(command_text) {
            return Some(false);
        }
        return Some(true);
    }
    None
}

/// `treeArgvHasOutputOption`: `tree -o` writes an image file.
fn tree_argv_has_output_option(argv: &[String]) -> bool {
    for word in argv.iter().skip(1) {
        if word.is_empty() {
            continue;
        }
        if word == "--" {
            return false;
        }
        if word == "-o" || word == "--output" || word.starts_with("--output=") {
            return true;
        }
        if word.starts_with('-') && !word.starts_with("--") && word[1..].contains('o') {
            return true;
        }
    }
    false
}

/// `hasKnownBashWriteOption` — the write detection the permission flow asks before the
/// policy tables. Returns true when the command is KNOWN to write, which is different from
/// "not known to be read-only".
pub fn has_known_bash_write_option(argv: &[String]) -> bool {
    let argv = strip_safe_command_wrappers(argv);
    let Some(head) = argv.first().map(String::as_str) else {
        return false;
    };
    match head {
        "sed" => argv.iter().any(|word| crate::callbacks::is_sed_in_place_option(word)),
        "find" => argv.iter().any(|word| FIND_WRITE_OPTIONS.contains(&word.as_str())),
        "tree" => tree_argv_has_output_option(&argv),
        "git" => crate::gitflags::has_dangerous_git_global_option(&argv),
        _ => false,
    }
}
