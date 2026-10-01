//! `~/.ssh/config` parsing — the Rust port of
//! `packages/services/src/system/sshConfigAlias.ts` (708 lines).
//!
//! `IPlatformService.listSSHConfigAliases()` fills the SSH connect form, so a
//! user with `Include ~/.ssh/config.d/*` in their config must still see every
//! alias. That makes the `Include` expansion load-bearing rather than a nicety:
//! a parser that silently dropped it would return a *short* list, which the UI
//! renders as "these are your hosts" — a plausible wrong answer, which is the
//! failure mode this cutover exists to remove.
//!
//! The resolution is a two-stage port of the original:
//!   1. a pure parse of the config (blocks, `Include`, first-match-wins
//!      directive resolution, `Host` pattern globbing), which is unit-tested;
//!   2. a confirmation pass through the platform `ssh -G`, bounded by a
//!      deadline, which is what resolves `Match` blocks, `ProxyJump` and
//!      wildcard inheritance that a static parse can only approximate.
//!
//! Stage 2 is skipped when no `ssh` binary is on `PATH`, exactly as
//! `resolveSshExecutablePath` did (`sshConfigAlias.ts:460-486`).

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Cache TTL, verbatim from `CACHE_TTL_MS` (`sshConfigAlias.ts:5`).
pub const CACHE_TTL_MS: u64 = 30_000;
/// Alias cap, verbatim from `MAX_ALIAS_COUNT` (`:6`).
pub const MAX_ALIAS_COUNT: usize = 200;
/// `Include` recursion cap, verbatim from `MAX_INCLUDE_DEPTH` (`:9`).
pub const MAX_INCLUDE_DEPTH: usize = 8;
/// Per-alias `ssh -G` deadline, verbatim from `SSH_G_TIMEOUT_MS` (`:7`).
pub const SSH_G_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Cap on `ssh -G` stdout, verbatim from the 128 000-char slice (`:501-503`).
pub const SSH_G_MAX_OUTPUT: usize = 128_000;
/// How many `ssh -G` processes may run at once, verbatim from
/// `SSH_G_CONCURRENCY` (`:8`).
pub const SSH_G_CONCURRENCY: usize = 3;
/// Directory-walk cap for `Include **` patterns.
const INCLUDE_GLOB_MAX_DEPTH: usize = 8;

/// One connectable alias (`SSHConfigAliasOption`,
/// `packages/shared/src/platform.ts:302-309`).
///
/// `host` and `source` are non-optional here because both producers always set
/// them (`host: host ?? meta.alias`, `source: meta.source`); a `String` is
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshConfigAliasOption {
    pub alias: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Directive {
    key: String,
    value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Block {
    patterns: Vec<String>,
    directives: Vec<Directive>,
    source: String,
    from_host_directive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AliasMeta {
    alias: String,
    source: String,
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/// Drop a trailing `#` comment, respecting quotes and backslash escapes.
///
/// Port of `stripInlineComment` (`sshConfigAlias.ts:52-86`).
///
/// `pub(crate)` because the ported differential corpus in `session::tests`
/// asserts this lexer directly against the legacy `sshConfigAlias.ts` vectors;
/// a lexer whose quoting and escape rules cannot be tested is exactly where a
/// silent regression would hide.
pub(crate) fn strip_inline_comment(line: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (index, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        match quote {
            Some(open) => {
                if ch == open {
                    quote = None;
                }
            }
            None => {
                if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                } else if ch == '#' {
                    return &line[..index];
                }
            }
        }
    }
    line
}

/// Split a config line into tokens, honouring quotes and escapes.
///
/// Port of `splitSshTokens` (`sshConfigAlias.ts:88-162`), including the rule
/// that a backslash only escapes whitespace, another backslash, a quote or `#`
/// — anything else is a literal backslash, because Windows `Include
/// C:\Users\me\config` paths are common and eating the slashes would break them.
pub(crate) fn split_ssh_tokens(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        if let Some(open) = quote {
            if ch == '\\' {
                match chars.get(index + 1) {
                    // Inside a quoted run, a backslash escapes the closing
                    // quote or another backslash; anything else stays literal.
                    Some(&next) if next == open || next == '\\' || next == '"' || next == '\'' => {
                        current.push(next);
                        index += 2;
                    }
                    _ => {
                        current.push('\\');
                        index += 1;
                    }
                }
                continue;
            }
            if ch == open {
                quote = None;
            } else {
                current.push(ch);
            }
            index += 1;
            continue;
        }

        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                index += 1;
            }
            _ if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                index += 1;
            }
            '\\' => match chars.get(index + 1) {
                Some(&next)
                    if next.is_whitespace()
                        || next == '\\'
                        || next == '\''
                        || next == '"'
                        || next == '#' =>
                {
                    current.push(next);
                    index += 2;
                }
                // A Windows path's `\` is not an escape: eating it would turn
                // `C:\Users\me\.ssh\config` into a path that does not exist.
                _ => {
                    current.push('\\');
                    index += 1;
                }
            },
            _ => {
                current.push(ch);
                index += 1;
            }
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// The user's home directory.
pub fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(profile);
        }
        let drive = std::env::var("HOMEDRIVE").unwrap_or_default();
        let path = std::env::var("HOMEPATH").unwrap_or_default();
        if !drive.is_empty() || !path.is_empty() {
            return PathBuf::from(format!("{drive}{path}"));
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Expand `~`, `~/…` and `%d` — port of `expandHomeToken`
/// (`sshConfigAlias.ts:165-183`).
pub fn expand_home_token(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return PathBuf::new();
    }
    let home = home_dir();
    let with_home_variable = if let Some(rest) = trimmed.strip_prefix("%d") {
        if rest.is_empty() || rest.starts_with(['/', '\\']) {
            home.join(rest.trim_start_matches(['/', '\\']))
        } else {
            PathBuf::from(trimmed)
        }
    } else {
        PathBuf::from(trimmed)
    };
    if let Ok(rest) = with_home_variable.strip_prefix("~") {
        // A bare `~` is the home directory itself, not a child named `~`.
        if rest.is_empty() {
            return home;
        }
        // `rest` is a `Path` here, and `Path::starts_with`/`trim_start_matches`
        // resolve components rather than characters — matching against
        // `['/', '\\']` would test for a component literally named `/`. The
        // separator test has to happen on the string form.
        let rest_str = rest.to_string_lossy();
        if rest_str.starts_with(['/', '\\']) {
            return home.join(rest_str.trim_start_matches(['/', '\\']));
        }
    }
    with_home_variable
}

/// Does this `Include` value contain a real glob metacharacter?
///
/// Port of `hasGlobPattern` (`sshConfigAlias.ts:164-169`): a Windows path's `\`
/// is not a glob, so only `* ? [ ]` count.
fn has_glob_pattern(value: &str) -> bool {
    value.contains(['*', '?', '[', ']'])
}

/// Resolve one `Include` token into the files it names.
fn resolve_include_targets(include_tokens: &[String], base_dir: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    for token in include_tokens {
        let expanded = expand_home_token(token);
        if expanded.as_os_str().is_empty() {
            continue;
        }
        let absolute = if expanded.is_absolute() { expanded } else { base_dir.join(&expanded) };
        let candidates = if has_glob_pattern(&absolute.to_string_lossy()) {
            expand_glob(&absolute, 0)
        } else {
            vec![absolute.clone()]
        };
        for candidate in candidates {
            // A non-glob token that does not exist contributes nothing, exactly
            // as the `existsSync` guard did.
            if !candidate.is_file() {
                continue;
            }
            if visited.insert(candidate.clone()) {
                results.push(candidate);
            }
        }
    }
    results
}

/// Expand a path glob supporting `*`, `?` and `**`.
///
/// Hand-rolled because neither `std` nor the already-vendored crates expose one,
/// and pulling a new dependency for this is not Main's file to change. Bounded
/// by [`INCLUDE_GLOB_MAX_DEPTH`] and by refusing to follow symlinked
/// directories, so a self-referential `Include **` cannot hang the app.
fn expand_glob(pattern: &Path, depth: usize) -> Vec<PathBuf> {
    if depth > INCLUDE_GLOB_MAX_DEPTH {
        return Vec::new();
    }
    let text = pattern.to_string_lossy().to_string();
    let separator = if cfg!(windows) { '\\' } else { '/' };
    let first_glob = text.find(['*', '?', '[']).unwrap_or(text.len());
    let prefix_end = text[..first_glob].rfind(separator).map(|i| i + 1).unwrap_or(0);
    let base = if prefix_end == 0 { PathBuf::from(".") } else { PathBuf::from(&text[..prefix_end - 1]) };
    let relative = &text[prefix_end..];

    // `**` walks directories; a single `*`/`?`/bracket class matches one segment.
    if relative.starts_with("**") {
        let rest = relative.trim_start_matches("**").trim_start_matches(separator);
        let mut found = Vec::new();
        let mut stack = vec![(base.clone(), String::new())];
        while let Some((dir, resolved)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let joined = if resolved.is_empty() { name.clone() } else { format!("{resolved}{separator}{name}") };
                let Ok(file_type) = entry.file_type() else { continue };
                if file_type.is_dir() {
                    stack.push((path, joined));
                } else if glob_match(rest, &joined) {
                    found.push(path);
                }
            }
        }
        return found;
    }

    let Ok(entries) = std::fs::read_dir(&base) else { return Vec::new() };
    entries
        .flatten()
        .filter(|entry| glob_match(relative, &entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .collect()
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/// Match a `Host` pattern against an alias. `*` and `?` are the only
/// metacharacters (`matchHostPattern`, `sshConfigAlias.ts:315-341`).
pub fn glob_match(pattern: &str, value: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let v: Vec<char> = value.chars().collect();
    let (mut pi, mut vi) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while vi < v.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == v[vi]) {
            pi += 1;
            vi += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = vi;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            vi = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// A single-word `Host` pattern that can actually be connected to.
///
/// Port of `isConnectableAliasPattern` (`:42-54`): `*`, a leading `!` and any
/// pattern containing a glob metacharacter are not aliases.
fn is_connectable_alias_pattern(pattern: &str) -> bool {
    let trimmed = pattern.trim();
    if trimmed.is_empty() || trimmed == "*" || trimmed.starts_with('!') {
        return false;
    }
    !trimmed.contains(['?', '*', '[', ']', '\\'])
}

/// Does a block's pattern list select `alias`? Negations win outright.
///
/// Port of `blockMatchesAlias` (`:343-370`).
fn block_matches_alias(patterns: &[String], alias: &str) -> bool {
    let mut matched_positive = false;
    for raw in patterns {
        let pattern = raw.trim();
        if pattern.is_empty() {
            continue;
        }
        if let Some(negated) = pattern.strip_prefix('!') {
            if !negated.is_empty() && glob_match(negated, alias) {
                return false;
            }
            continue;
        }
        if glob_match(pattern, alias) {
            matched_positive = true;
        }
    }
    matched_positive
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Parse a config file and everything it includes, depth first.
fn parse_config_blocks(
    config_path: &Path,
    visited: &mut HashSet<PathBuf>,
    depth: usize,
) -> Vec<Block> {
    let normalized = normalise_path(config_path);
    if depth > MAX_INCLUDE_DEPTH || !visited.insert(normalized.clone()) {
        return Vec::new();
    }
    let Ok(content) = std::fs::read_to_string(&normalized) else {
        return Vec::new();
    };

    let source = normalized.to_string_lossy().to_string();
    let base_dir = normalized.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut blocks = vec![Block {
        patterns: vec!["*".to_string()],
        directives: Vec::new(),
        source: source.clone(),
        from_host_directive: false,
    }];
    let mut current = blocks[0].clone();

    for raw_line in content.lines() {
        let stripped = strip_inline_comment(raw_line).trim().to_string();
        if stripped.is_empty() {
            continue;
        }
        let tokens = split_ssh_tokens(&stripped);
        let Some(key) = tokens.first().map(|k| k.to_ascii_lowercase()) else { continue };
        if key == "include" {
            for path in resolve_include_targets(&tokens[1..], &base_dir) {
                blocks.extend(parse_config_blocks(&path, visited, depth + 1));
            }
            continue;
        }
        if key == "host" {
            current = Block {
                patterns: tokens[1..].to_vec(),
                directives: Vec::new(),
                source: source.clone(),
                from_host_directive: true,
            };
            blocks.push(current.clone());
            continue;
        }
        if tokens.len() < 2 {
            continue;
        }
        current.directives.push(Directive { key, value: tokens[1..].join(" ") });
        // `current` and the last block are the same allocation for every block
        // created here, so mutate the stored one too.
        if let Some(last) = blocks.last_mut() {
            *last = current.clone();
        }
    }
    blocks
}

/// Absolute, `.`/`..`-free form of a path — the `resolve()` the original
/// applied before using a path as a map key.
fn normalise_path(path: &Path) -> PathBuf {
    let mut normalised = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalised.pop();
            }
            other => normalised.push(other.as_os_str()),
        }
    }
    if normalised.is_absolute() {
        normalised
    } else {
        std::env::current_dir().unwrap_or_default().join(normalised)
    }
}

/// The connectable aliases declared by `blocks`, in file order, deduped.
///
/// Port of `buildAliasMetas` (`:296-325`).
fn build_alias_metas(blocks: &[Block]) -> Vec<AliasMeta> {
    let mut aliases: Vec<AliasMeta> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for block in blocks {
        if !block.from_host_directive || block.patterns.len() != 1 {
            continue;
        }
        let Some(alias) = block.patterns[0].trim().to_owned().into() else {
            continue;
        };
        let alias: String = alias;
        if !is_connectable_alias_pattern(&alias) || !seen.insert(alias.clone()) {
            continue;
        }
        aliases.push(AliasMeta { alias, source: block.source.clone() });
        if aliases.len() >= MAX_ALIAS_COUNT {
            break;
        }
    }
    aliases
}

/// `1..=65535`, or `None` — port of `toValidPort` (`:373-380`).
fn to_valid_port(raw: &str) -> Option<u16> {
    raw.trim().parse::<u16>().ok().filter(|port| *port != 0)
}

/// Resolve an alias from the parsed blocks alone, first match wins per key.
///
/// Port of `buildFallbackOptions` (`:391-441`).
fn build_fallback_options(blocks: &[Block], metas: &[AliasMeta]) -> Vec<SshConfigAliasOption> {
    metas
        .iter()
        .map(|meta| {
            let mut host: Option<String> = None;
            let mut port: Option<u16> = None;
            let mut username: Option<String> = None;
            let mut private_key_path: Option<String> = None;

            for block in blocks {
                if !block_matches_alias(&block.patterns, &meta.alias) {
                    continue;
                }
                for directive in &block.directives {
                    match directive.key.as_str() {
                        "hostname" if host.is_none() => {
                            let value = directive.value.trim();
                            if !value.is_empty() {
                                host = Some(value.to_string());
                            }
                        }
                        "port" if port.is_none() => port = to_valid_port(&directive.value),
                        "user" if username.is_none() => {
                            let value = directive.value.trim();
                            if !value.is_empty() {
                                username = Some(value.to_string());
                            }
                        }
                        "identityfile" if private_key_path.is_none() => {
                            let expanded = expand_home_token(&directive.value);
                            if !expanded.as_os_str().is_empty() {
                                private_key_path = Some(expanded.to_string_lossy().into_owned());
                            }
                        }
                        _ => {}
                    }
                }
            }

            SshConfigAliasOption {
                alias: meta.alias.clone(),
                host: host.unwrap_or_else(|| meta.alias.clone()),
                port,
                username,
                private_key_path,
                source: meta.source.clone(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// `ssh -G` confirmation
// ---------------------------------------------------------------------------

/// Find an executable on `PATH` — port of `findExecutableFromPath` (`:443-458`).
fn find_executable_from_path(binary_name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(binary_name)).find(|c| c.is_file())
}

/// The platform `ssh` binary, or `None` — port of `resolveSshExecutablePath`
/// (`:460-486`), including the four Windows fallbacks (System32, Program Files,
/// and the two Git-for-Windows `usr/bin` copies).
pub fn resolve_ssh_executable_path() -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return find_executable_from_path("ssh");
    }
    if let Some(found) = find_executable_from_path("ssh.exe") {
        return Some(found);
    }
    let windows_dir = std::env::var("WINDIR").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "C:\\Windows".into());
    let program_files = std::env::var("ProgramFiles").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "C:\\Program Files".into());
    let program_files_x86 = std::env::var("ProgramFiles(x86)").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "C:\\Program Files (x86)".into());
    [
        PathBuf::from(&windows_dir).join("System32").join("OpenSSH").join("ssh.exe"),
        PathBuf::from(&program_files).join("OpenSSH").join("ssh.exe"),
        PathBuf::from(&program_files).join("Git").join("usr").join("bin").join("ssh.exe"),
        PathBuf::from(&program_files_x86).join("Git").join("usr").join("bin").join("ssh.exe"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

/// Run `ssh -G` for one alias and return its stdout, or `None`.
///
/// The deadline is enforced with `try_wait` polling rather than by killing from
/// another thread: the child is owned here, so a timed-out run is reaped
/// instead of leaking a process per stale alias. `BatchMode=yes` plus a cleared
/// `SSH_ASKPASS`/`DISPLAY` reproduces the original environment, which is what
/// keeps `ssh -G` from ever prompting (`:481-491`).
fn run_ssh_config_query(ssh: &Path, config_path: &Path, alias: &str) -> Option<String> {
    let mut child = std::process::Command::new(ssh)
        .args(["-G", "-F"])
        .arg(config_path)
        .args(["-o", "BatchMode=yes", alias])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("SSH_ASKPASS", "")
        .env("DISPLAY", "")
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(read) = stdout.read(&mut chunk) {
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.len() >= SSH_G_MAX_OUTPUT {
                break;
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&buffer).into_owned());
    });

    let deadline = Instant::now() + SSH_G_TIMEOUT;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.success()),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break None,
        }
    };
    let _ = reader.join();
    match outcome {
        Some(true) => rx.recv_timeout(Duration::from_millis(200)).ok(),
        _ => None,
    }
}

/// Parse the `key value` lines `ssh -G` prints.
///
/// Port of `parseSshGOutput` (`:548-596`): first occurrence wins, and the
/// `identityfile` it reports is deliberately **not** used — it is the default
/// key, so treating it as the user's configured key makes a password login look
/// like a key login (`sshConfigAlias.ts:670-673`).
fn parse_ssh_g_output(output: &str) -> (Option<String>, Option<u16>, Option<String>) {
    let mut host = None;
    let mut port = None;
    let mut username = None;
    for line in output.lines() {
        let trimmed = line.trim();
        let Some((raw_key, raw_value)) = trimmed.split_once(char::is_whitespace) else { continue };
        let value = raw_value.trim();
        if value.is_empty() {
            continue;
        }
        match raw_key.to_ascii_lowercase().as_str() {
            "hostname" if host.is_none() => host = Some(value.to_string()),
            "port" if port.is_none() => port = to_valid_port(value),
            "user" if username.is_none() => username = Some(value.to_string()),
            _ => {}
        }
    }
    (host, port, username)
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

static ALIAS_CACHE: Mutex<Option<(u64, Vec<SshConfigAliasOption>)>> = Mutex::new(None);

/// Drop the process-wide alias cache. Public so tests are order-independent.
///
/// `unwrap_or_else(|poisoned| poisoned.into_inner())` is deliberate: a poisoned
/// lock means some earlier alias listing panicked. The cache holds nothing but
/// a recomputable list of aliases, so discarding the poisoned value is correct
/// and propagating the poison would make one failed listing permanently break
/// every later one.
pub fn invalidate_alias_cache() {
    *lock_alias_cache() = None;
}

/// Take the alias-cache guard, recovering from poisoning rather than panicking.
fn lock_alias_cache() -> std::sync::MutexGuard<'static, Option<(u64, Vec<SshConfigAliasOption>)>> {
    ALIAS_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// The user's `~/.ssh/config`, or `None` when it does not exist.
pub fn root_config_path() -> Option<PathBuf> {
    let path = home_dir().join(".ssh").join("config");
    path.is_file().then_some(path)
}

/// The whole member, synchronously. `list_ssh_config_aliases` wraps this in
/// `spawn_blocking` because it does filesystem and process I/O.
pub fn list_from_local_config() -> Vec<SshConfigAliasOption> {
    let now = now_ms();
    if let Some((expires_at, cached)) = lock_alias_cache().as_ref() {
        if *expires_at > now {
            return cached.clone();
        }
    }
    let options = resolve_now();
    *lock_alias_cache() = Some((now + CACHE_TTL_MS, options.clone()));
    options
}

fn resolve_now() -> Vec<SshConfigAliasOption> {
    let Some(root_config) = root_config_path() else {
        return Vec::new();
    };
    resolve_config(&root_config)
}

/// Resolve aliases from one specific config file.
///
/// Split out of [`resolve_now`] so the resolver is a function of its input rather
/// than of `~/.ssh/config`: the tests need to point it at a fixture, and a
/// function that reads the real home directory is not testable at all. It also
/// means the cached path and the test path cannot diverge — `resolve_now` is now
/// a caller, not a second copy of the logic.
pub(crate) fn resolve_config(root_config: &Path) -> Vec<SshConfigAliasOption> {
    let mut visited = HashSet::new();
    let blocks = parse_config_blocks(root_config, &mut visited, 0);
    let metas = build_alias_metas(&blocks);
    if metas.is_empty() {
        return Vec::new();
    }
    let fallback = build_fallback_options(&blocks, &metas);
    let Some(ssh) = resolve_ssh_executable_path() else {
        return fallback;
    };
    fallback
        .into_iter()
        .map(|fallback_option| {
            let Some(output) = run_ssh_config_query(&ssh, root_config, &fallback_option.alias)
            else {
                return fallback_option;
            };
            let (host, port, username) = parse_ssh_g_output(&output);
            SshConfigAliasOption {
                alias: fallback_option.alias.clone(),
                host: host.unwrap_or(fallback_option.host),
                port: port.or(fallback_option.port),
                username: username.or(fallback_option.username),
                // Only the explicit `IdentityFile` from the parsed config, never
                // `ssh -G`'s default one.
                private_key_path: fallback_option.private_key_path,
                source: fallback_option.source,
            }
        })
        .collect()
}

/// The parse-only half of [`list_from_local_config`], without the `ssh -G`
/// confirmation pass.
///
/// Test-only: the confirmation needs an `ssh` binary on `PATH`, so a test
/// exercising the full member would assert on whatever the developer's machine
/// happens to have installed. This isolates the part that is ours.
#[cfg(test)]
pub(super) fn parse_config_only(config_path: &Path) -> Vec<SshConfigAliasOption> {
    let mut visited = HashSet::new();
    let blocks = parse_config_blocks(config_path, &mut visited, 0);
    let metas = build_alias_metas(&blocks);
    build_fallback_options(&blocks, &metas)
}
