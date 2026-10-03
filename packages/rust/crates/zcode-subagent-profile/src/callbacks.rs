//! Read-only command danger callbacks.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 3), ported from
//! `tool/handlers/bash-readonly-policy-callbacks.ts`.
//!
//! Each of these closes a real vector: `sed -i` rewrites the file, `sed 'w out'` writes it,
//! `date -f FILE` writes it, `jq --rawfile` reads an arbitrary path, `lsof -i @host` reaches
//! a remote host. Wrong in the permissive direction and a write runs with no permission
//! prompt, so the default is **reject** and an unrecognised form is never assumed safe.
//!
//! ## No regex crate
//!
//! The workspace has no `regex` dependency and takes a deliberate minimal-dependency
//! position (`Cargo.toml` documents the same reasoning for `napi` and `serde_json`). Every
//! pattern here is an anchored literal set or a two-boundary scan, so each is written out
//! directly; the golden corpus is what keeps that honest.

fn is_word_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `(?:^|[^A-Za-z0-9_$.])env(?=$|[^A-Za-z0-9_])`
///
/// The leading class deliberately excludes `$` and `.`, so `.environment` and `$ENVIRONMENT`
/// are not `env` — only a bare `env` call is.
fn filter_contains_bare_env(filter: &str) -> bool {
    let bytes = filter.as_bytes();
    for index in 0..bytes.len() {
        if !filter[index..].starts_with("env") {
            continue;
        }
        let before_ok = index == 0
            || !(is_word_char(bytes[index - 1]) || bytes[index - 1] == b'$' || bytes[index - 1] == b'.');
        let after = index + 3;
        let after_ok = after == bytes.len() || !is_word_char(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

/// `(^|[^A-Za-z0-9_])(?:include|import)(?=$|[^A-Za-z0-9_])`
fn filter_contains_include_or_import(filter: &str) -> bool {
    for keyword in ["include", "import"] {
        let mut from = 0usize;
        while let Some(found) = filter[from..].find(keyword) {
            let index = from + found;
            let before_ok = index == 0 || !is_word_char(filter.as_bytes()[index - 1]);
            let after = index + keyword.len();
            let after_ok = after == filter.len() || !is_word_char(filter.as_bytes()[after]);
            if before_ok && after_ok {
                return true;
            }
            from = index + 1;
            if from >= filter.len() {
                break;
            }
        }
    }
    false
}

/// `/\$ENV\b/`
fn filter_contains_env_variable(filter: &str) -> bool {
    let bytes = filter.as_bytes();
    let mut from = 0usize;
    while let Some(found) = filter[from..].find("$ENV") {
        let index = from + found;
        let after = index + 4;
        if after == bytes.len() || !is_word_char(bytes[after]) {
            return true;
        }
        from = index + 1;
        if from >= filter.len() {
            break;
        }
    }
    false
}

fn jq_filter_is_dangerous(filter: &str) -> bool {
    filter_contains_env_variable(filter)
        || filter_contains_bare_env(filter)
        || filter_contains_include_or_import(filter)
}

/// The exact and prefix forms jq treats as "reaches a path or runs code".
fn is_jq_dangerous_option(word: &str) -> bool {
    // `-f`/`-L` are dangerous in any spelling: `-fFILE` is the same flag as `-f FILE`.
    if word.starts_with("-f") || word.starts_with("-L") {
        return true;
    }
    // The long options are dangerous BOTH as `--opt VALUE` and as `--opt=VALUE`. Matching
    // only the `=` form let the spaced form through, which is the one a person types.
    const LONG: [&str; 6] = [
        "--argfile",
        "--from-file",
        "--library-path",
        "--rawfile",
        "--run-tests",
        "--slurpfile",
    ];
    LONG.iter().any(|base| {
        word == *base
            || word
                .strip_prefix(base)
                .is_some_and(|rest| rest.starts_with('='))
    })
}

/// `jqCommandIsDangerous`.
pub fn jq_command_is_dangerous(args: &[String]) -> bool {
    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");
        if arg.is_empty() {
            index += 1;
            continue;
        }
        if is_jq_dangerous_option(arg) {
            return true;
        }
        if arg == "--" {
            return jq_filter_is_dangerous(args.get(index + 1).map(String::as_str).unwrap_or(""));
        }
        if arg == "--indent" {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        return jq_filter_is_dangerous(arg);
    }
    false
}

/// `-i`, `--in-place`, `--in-place=SUFFIX`.
pub fn is_sed_in_place_option(word: &str) -> bool {
    word.starts_with("-i") || word == "--in-place" || word.starts_with("--in-place=")
}

/// `(?:^|[;{\n])\s*(?:[0-9,$!+~-]+)?\s*w(?:\s|$)`
///
/// A `w` command only counts at the start of a sed command — after a start, a `;`, `{` or
/// newline, an optional address, and optional whitespace. That is what keeps `s/w/word/`
/// clean: the `w` there is inside a word, not a command.
fn sed_script_writes_to_file(script: &str) -> bool {
    let bytes = script.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        // The `w` we are looking for.
        if bytes[index] != b'w' {
            index += 1;
            continue;
        }
        let after = index + 1;
        let after_ok = after == bytes.len() || (bytes[after] as char).is_whitespace();
        if !after_ok {
            index += 1;
            continue;
        }
        // Walk backwards over the optional parts, which is simpler than a full automaton.
        let mut cursor = index;
        while cursor > 0 && (bytes[cursor - 1] as char).is_whitespace() {
            cursor -= 1;
        }
        while cursor > 0 && matches!(bytes[cursor - 1], b'0'..=b'9' | b',' | b'$' | b'!' | b'+' | b'~' | b'-') {
            cursor -= 1;
        }
        // The LAST whitespace run must be able to swallow the newline itself. Without this
        // the cursor stops on it and the check below sees a plain character instead of the
        // required `[;{\n]`, so every multi-line script walked the whole string without
        // ever deciding — an O(n^2) scan that reads as a hang.
        while cursor > 0 && bytes[cursor - 1].is_ascii_whitespace() {
            cursor -= 1;
        }
        if cursor == 0 || matches!(bytes[cursor - 1], b';' | b'{' | b'\n') {
            return true;
        }
        index += 1;
    }
    false
}

/// `sedCommandIsDangerous`.
pub fn sed_command_is_dangerous(args: &[String]) -> bool {
    let mut first_script_seen = false;
    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");
        if arg.is_empty() {
            index += 1;
            continue;
        }
        if is_sed_in_place_option(arg) {
            return true;
        }
        if arg == "-e" || arg == "--expression" {
            index += 1;
            if sed_script_writes_to_file(args.get(index).map(String::as_str).unwrap_or("")) {
                return true;
            }
            continue;
        }
        if let Some(inline) = arg.strip_prefix("--expression=") {
            if sed_script_writes_to_file(inline) {
                return true;
            }
            index += 1;
            continue;
        }
        if arg == "-l" || arg == "--line-length" {
            index += 2;
            continue;
        }
        if arg.starts_with("--line-length=") {
            index += 1;
            continue;
        }
        if arg == "--" {
            return sed_script_writes_to_file(args.get(index + 1).map(String::as_str).unwrap_or(""));
        }
        if !arg.starts_with('-') && !first_script_seen {
            first_script_seen = true;
            if sed_script_writes_to_file(arg) {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// `dateCommandIsDangerous`: any operand that is not a `+FORMAT` writes the file named by
/// it, so `date /etc/passwd` rewrites that path.
pub fn date_command_is_dangerous(args: &[String]) -> bool {
    const VALUE_FLAGS: [&str; 5] = ["-d", "--date", "-r", "--reference", "--rfc-3339"];
    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");
        if arg.starts_with("--") && arg.contains('=') {
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            index += if VALUE_FLAGS.contains(&arg) { 2 } else { 1 };
            continue;
        }
        if !arg.starts_with('+') {
            return true;
        }
        index += 1;
    }
    false
}

/// `lsofCommandIsDangerous`: `+m`, and any `-i…@host` whose host has a letter in it.
///
/// The original's first pattern is `^-[a-zA-Z]*i\S*@`: the `@` may sit **anywhere** after
/// the `i`, not immediately after it — `\S*` is greedy and backtracks. Reading it as
/// "an `@` right after the flag" let `-i@host` through, which is exactly the remote-host
/// case the check exists for.
pub fn lsof_command_is_dangerous(args: &[String]) -> bool {
    fn host_is_remote(host: &str) -> bool {
        host.bytes().any(|byte| byte.is_ascii_alphabetic())
    }
    // The host part of `@host:port`.
    fn host_from(rest: &str) -> &str {
        rest.split(':').next().unwrap_or("")
    }

    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");

        if arg == "+m" || arg.starts_with("+m") {
            return true;
        }

        let bytes = arg.as_bytes();
        if bytes.first() == Some(&b'-') {
            // The alphabetic part of the flag cluster.
            let mut cursor = 1usize;
            while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
                cursor += 1;
            }
            let has_i = bytes[1..cursor].contains(&b'i');

            if has_i {
                // `-i…@host`: an `@` later in the same word, with no space before it.
                if let Some(offset) = arg[cursor..].find('@') {
                    let at = cursor + offset;
                    if !arg[cursor..at].chars().any(char::is_whitespace) && host_is_remote(host_from(&arg[at + 1..])) {
                        return true;
                    }
                } else if cursor == bytes.len() {
                    // `-i` exactly: the HOST may be the next argument.
                    if let Some(next) = args.get(index + 1) {
                        if let Some(at) = next.find('@') {
                            if host_is_remote(host_from(&next[at + 1..])) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        index += 1;
    }
    false
}

/// `psCommandIsDangerous`: a bare `e` (or a cluster of letters containing `e`) makes ps
/// execute its argument.
pub fn ps_command_is_dangerous(args: &[String]) -> bool {
    args.iter().any(|arg| {
        if arg.starts_with('-') {
            return false;
        }
        !arg.is_empty()
            && arg.bytes().all(|byte| byte.is_ascii_alphabetic())
            && arg.contains('e')
    })
}

/// `pyrightCommandIsDangerous`: watch mode never returns.
pub fn pyright_command_is_dangerous(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--watch" || arg == "-w")
}

/// `^-?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]+)$`
fn is_safe_test_number(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('-') else {
        return matches_safe_number_body(value);
    };
    matches_safe_number_body(rest)
}

fn matches_safe_number_body(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'0' && (bytes[1] == b'x' || bytes[1] == b'X') {
        return bytes[2..].iter().all(|b| b.is_ascii_hexdigit());
    }
    if let Some(at) = value.find('#') {
        // `[0-9]+#[0-9a-zA-Z]+`
        return at != 0
            && value[..at].bytes().all(|b| b.is_ascii_digit())
            && value[at + 1..].bytes().all(|b| b.is_ascii_alphanumeric());
    }
    !value.is_empty() && bytes.iter().all(|b| b.is_ascii_digit())
}

/// The safe-number shape, shared with the printf policy: `^-?(0x…|…#…|…)$`.
pub fn is_safe_test_number_public(value: &str) -> bool {
    is_safe_test_number(value)
}

/// `testCommandIsDangerous`: `[`, `-a`/`-o` and friends chain commands, and a numeric
/// operator with a non-numeric operand evaluates it as a command substitution.
pub fn test_command_is_dangerous(args: &[String]) -> bool {
    const NUMERIC_OPERATORS: [&str; 6] = ["-eq", "-ne", "-lt", "-le", "-gt", "-ge"];
    if args.iter().any(|arg| {
        arg == "-v" || arg == "-R" || arg == "-a" || arg == "-o" || arg.contains('[')
    }) {
        return true;
    }
    for (index, arg) in args.iter().enumerate() {
        if NUMERIC_OPERATORS.contains(&arg.as_str()) {
            for value in [index.checked_sub(1).map(|i| &args[i]), args.get(index + 1)]
                .into_iter()
                .flatten()
            {
                if !is_safe_test_number(value) {
                    return true;
                }
            }
        }
        if arg == "-t" {
            if let Some(value) = args.get(index + 1) {
                if !is_safe_test_number(value) {
                    return true;
                }
            }
        }
    }
    false
}

/// `manCommandIsDangerous`.
///
/// A path operand means a rendered man page from outside the standard tree; `-k` (apropos)
/// turns that into a search instead, which is why the path is allowed in that one case.
pub fn man_command_is_dangerous(args: &[String]) -> bool {
    const APROPOS_FLAGS: [&str; 4] = ["-k", "-f", "--apropos", "--whatis"];
    const VALUE_FLAGS: [&str; 2] = ["-S", "-s"];
    let mut is_apropos = false;
    let mut after_double_dash = false;
    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            index += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') && arg != "-" {
            if APROPOS_FLAGS.contains(&arg) {
                is_apropos = true;
            }
            if VALUE_FLAGS.contains(&arg) {
                index += 1;
            }
            index += 1;
            continue;
        }
        after_double_dash = true;
        if arg.contains('/') {
            return !is_apropos;
        }
        index += 1;
    }
    false
}

/// Terminal capabilities that move the cursor, clear the screen or reset the terminal.
const TPUT_DANGEROUS_CAPABILITIES: [&str; 22] = [
    "clear", "flash", "if", "init", "iprog", "is1", "is2", "is3", "mc0", "mc4", "mc5", "mc5i",
    "mc5p", "pfkey", "pfloc", "pfx", "pfxl", "reset", "rf", "rmcup", "rs1", "rs2",
];

/// `tputCommandIsDangerous`: `-S` stores into the terminal, and the capabilities above move
/// or erase what is on screen.
pub fn tput_command_is_dangerous(args: &[String]) -> bool {
    let mut after_double_dash = false;
    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");
        if arg == "--" {
            after_double_dash = true;
            index += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') {
            if arg == "-S" {
                return true;
            }
            // An attached short option that carries an `S` is `-S` with a value glued on.
            if !arg.starts_with("--") && arg.len() > 2 && arg.contains('S') {
                return true;
            }
            index += if arg == "-T" { 2 } else { 1 };
            continue;
        }
        if TPUT_DANGEROUS_CAPABILITIES.contains(&arg) {
            return true;
        }
        index += 1;
    }
    false
}

const SS_KEYWORDS: [&str; 19] = [
    "dst", "src", "dport", "sport", "and", "or", "not", "eq", "ne", "ge", "le", "gt", "lt",
    "autobound", "state", "exclude", "dev", "fwmark", "cgroup",
];

const SS_VALUE_KEYWORDS: [&str; 7] =
    ["state", "exclude", "dport", "sport", "dev", "fwmark", "cgroup"];

const SS_VALUE_FLAGS: [&str; 5] = ["-f", "--family", "-A", "--query", "--socket"];

/// `ssCommandIsDangerous`.
///
/// The original rejects any token containing `g-z` (or an `a-f` letter with no `:`), which is
/// how a raw socket mask is caught. That rule is deliberately blunt: it also rejects
/// `ss -t tcp`, because `c` is in `a-f` and `tcp` has no colon. That false positive is part of
/// the behaviour and is reproduced here — "fixing" it would open a decision this port does not
/// own.
pub fn ss_command_is_dangerous(args: &[String]) -> bool {
    let mut positional: Vec<&str> = Vec::new();
    let mut after_double_dash = false;
    let mut index = 0usize;
    while index < args.len() {
        let arg = args.get(index).map(String::as_str).unwrap_or("");
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            index += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') {
            if SS_VALUE_FLAGS.contains(&arg) {
                index += 1;
            }
            index += 1;
            continue;
        }
        positional.push(arg);
        index += 1;
    }

    let joined = positional.join(" ");
    let mut skip_value = false;
    for token in joined.split(|c: char| {
        c.is_whitespace() || matches!(c, '(' | ')' | '=' | '!' | '<' | '>' | '&' | '|' | ',')
    }) {
        if token.is_empty() {
            continue;
        }
        if skip_value {
            skip_value = false;
            continue;
        }
        if SS_KEYWORDS.contains(&token) {
            skip_value = SS_VALUE_KEYWORDS.contains(&token);
            continue;
        }
        let has_high = token.bytes().any(|b| b.is_ascii_alphabetic() && !b.is_ascii_lowercase() || (b'g'..=b'z').contains(&b));
        let has_hex_letter = token.bytes().any(|b| b.is_ascii_hexdigit() && !b.is_ascii_digit());
        if has_high || (has_hex_letter && (!token.contains('.') || token.contains(':'))) {
            return true;
        }
    }
    false
}

/// Commands `xargs` may safely invoke.
pub const XARGS_TARGET_COMMANDS: [&str; 8] =
    ["echo", "printf", "wc", "grep", "egrep", "fgrep", "head", "tail"];

const XARGS_VALUE_FLAGS: [&str; 7] = ["-I", "-n", "-P", "-L", "-s", "-E", "-d"];

/// `xargsCommandIsDangerous`: the first non-flag argument is the command that will run.
pub fn xargs_command_is_dangerous(args: &[String]) -> bool {
    let mut index = 0usize;
    while index < args.len() {
        let mut arg = args.get(index).map(String::as_str).unwrap_or("");
        if arg.is_empty() {
            index += 1;
            continue;
        }
        if arg == "--" && index + 1 < args.len() {
            index += 1;
            arg = args.get(index).map(String::as_str).unwrap_or("");
        }
        if arg.starts_with('-') && arg != "-" {
            if XARGS_VALUE_FLAGS.contains(&arg) {
                index += 1;
            }
            index += 1;
            continue;
        }
        return !XARGS_TARGET_COMMANDS.contains(&arg);
    }
    false
}

/// `ghCommandIsDangerous` — the last of the danger callbacks.
///
/// `gh auth status` is on the read-only list, but a `gh` argument naming another
/// `owner/repo`, a URL, or `user@host` can point the CLI at a different host. An argument that
/// starts with `-` only counts when it carries an `=value`; a bare `--json` is a flag, not a
/// target.
pub fn gh_command_is_dangerous(args: &[String]) -> bool {
    for arg in args {
        if arg.is_empty() {
            continue;
        }
        let mut value = arg.as_str();
        if value.starts_with('-') {
            let Some(at) = value.find('=') else {
                continue;
            };
            value = &value[at + 1..];
            if value.is_empty() {
                continue;
            }
        }
        if !value.contains('/') && !value.contains("://") && !value.contains('@') {
            continue;
        }
        if value.contains("://") || value.contains('@') {
            return true;
        }
        // Two or more slashes: `owner/repo/path`, not a local path.
        if value.matches('/').count() >= 2 {
            return true;
        }
    }
    false
}
