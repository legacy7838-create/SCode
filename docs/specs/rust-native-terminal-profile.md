# Rust native port: terminal profile + shell selection (`zcode-terminal-profile`)

Status: active. Owner: PortTerminalProfile. Written 2026-09-30 **before** the crate, per
`AGENTS.md:3` and the programme rule in `docs/specs/rust-native-program.md` §5.

---

## 1. Motivation

`packages/services/src/terminal/` is one of the three wave-1 surfaces, chosen because it is on
the path of a critical security finding recorded in `rust-native-program.md` §2:

> `packages/services/src/terminal/terminalService.ts:353-365` — `create()` has no permission
> service, no confirmation, and no sandbox anywhere in the method body; `write()` (`:415`) pipes
> straight to the pty.

The concrete cost of that finding is that **every input to the pty spawn is decided in ad-hoc
JavaScript with no single typed place where the policy lives**:

| Decision | Today | Evidence |
|---|---|---|
| Which binary gets executed | an inline candidate loop in a service method | `terminalService.ts:285-308` |
| Which directory it starts in | an inline candidate loop next to it | `terminalService.ts:310-321` |
| Which environment it gets | an inline mutation of a spread of `process.env` | `terminalService.ts:198-232` |
| Which font / colours the panel renders with | 415 lines of file sniffing across five terminal emulators | `terminalProfile.ts:1-415` |
| Whether any of the above is permitted | **nothing** | no caller of `create()` consults a policy |

`resolveTerminalShell` (`:285`) is the security-relevant one: it decides what program the host
runs with the user's credentials, and it does so by walking a candidate list and calling
`isExecutable` (`:67-89`), which is an `accessSync(X_OK)` probe plus a `PATH` scan. That is a
decision function. It belongs inside the native boundary for the same reason
`rust-native-program.md` §2 gives for the file service: a check that lives in the wrapper can be
skipped by a caller that does not call the wrapper, and this is the surface where the earlier
analysis found the gap.

`resolveTerminalFontProfile` (`terminalProfile.ts:386`) is the same shape of work — pure
decision logic, but over the filesystem instead of over argv. It reads up to **eleven** config
files across five emulators (Windows Terminal, VS Code, iTerm2, macOS Terminal, kitty,
Alacritty), each in a different format (JSONC, JSON-from-`plutil`, `kitty.conf`, TOML, YAML),
and the detection order, the font-stack dedupe, the 6..72 font-size clamp, and the
plist colour-component normalisation are all decisions that a reviewer has to read to trust.

The port moves both into one crate, and makes the spawn's **policy inputs a typed shape** the
wave-2 spawn can consume, without porting the pty this wave.

---

## 2. Scope

### 2.1 Ported (Rust)

Every line of `terminalProfile.ts` and every pure function of `terminalProfileMacOs.ts`:

| Group | Functions (`terminalProfile.ts` / `terminalProfileMacOs.ts`) | Notes |
|---|---|---|
| env/home | `resolveHomeDir` (both files) | `homedir()` is passed in as an input, see §3.3 |
| string normalisation | `normalizeFontFamily`, `normalizeDetectedProfile`, `dedupeFontFamilyStack` | the font-stack dedupe is order-sensitive, so `FONT_FAMILY_FALLBACKS` keeps its exact order |
| JSONC | `stripJsonComments`, `removeJsonTrailingCommas`, `parseJsonc`, `readJsoncFile`, `readObjectFile` | the two-attempt parse order is preserved (`raw`, then comment-stripped + de-comma'd) |
| config readers | `readNestedString` (both files) | |
| detectors | `detectWindowsTerminalFontFamily`, `detectVsCodeTerminalFontFamily`, `detectKittyFontFamily`, `detectAlacrittyFontFamily`, `detectIterm2Profile`, `detectMacOsTerminalProfile` | all six run in Rust |
| ladder | `TERMINAL_FONT_DETECTORS`, `detectSystemTerminalProfile`, `resolveTerminalFontProfile` | detector order and per-detector platform gates are data, not control flow, in the crate |
| plist parsing | `normalizeMacOsFontName`, `normalizeFontSize`, `readMacOsFontDescriptor`, `readMacOsArchivedFontName`, `normalizeColorComponent`, `readColorRecordValue`, `normalizeMacOsColor`, `readThemeColor`, `compactTheme`, `readIterm2Theme`, `readMacOsTerminalTheme`, `hasDetectedProfile`, `ANSI_THEME_KEYS` | **given** the plist JSON, all of it is pure computation |
| shell / cwd | `resolveTerminalShell`, `isExecutable`, `resolveTerminalCwd`, `isUsableDirectory` | `terminalService.ts:67-89,285-321` |

### 2.2 NOT ported — named, with the reason (brief item 2)

**One function, for one reason: it is a child-process spawn, and invariant 5 forbids it.**

| Stays in TypeScript | Why |
|---|---|
| `readMacOsPlistFile` (`terminalProfileMacOs.ts:48-70`) | its body is `execFileSync("plutil", ["-convert", "json", "-o", "-", filePath], …)`. That is a child-process spawn. It is not a "sibling feature" in the invariant-5 sense — it is the input producer for the ported detectors, so porting it would be porting a spawn. |

Everything that function *feeds* is ported. The seam is one string: `plutil`'s JSON on stdout
goes into the crate as `iterm2_plist_json` / `macos_terminal_plist_json`, and
`parse_iterm2_plist` / `parse_mac_os_terminal_plist` do all of the parsing.

Concretely, what the retained TypeScript does is **two `execFileSync` calls, both already
gated** on `process.platform === "darwin" && existsSync(filePath)` exactly as the legacy code
gated them. Nothing else about the macOS path stays in TypeScript: not a colour, not a font
name, not the `Default Bookmark` ordering.

There is no second implementation to drift: after this change there is exactly one
implementation of the plist *readers* (Rust) and exactly one of the plist *parser* (Rust), and
the deleted `terminalProfileMacOs.ts` contained both.

Also explicitly out of scope this wave, and not fallbacks:

- **The pty spawn itself** (`spawnTerminalProcess`, `node-pty`, `ensureNodePtySpawnHelperExecutable`,
  `resolveTerminalWindowsPtyInfo`, `loadNodePtyModule`) — wave 2, see §6.
- **`resolveTerminalEnv`** (`terminalService.ts:198-232`) — env *merging*, not a decision. It
  mutates a `process.env` spread; porting it would mean porting `process.env` wholesale across
  the boundary for no measurable win. Wave 2 consumes it behind the policy in §5.
- **`terminalProfileTypes.ts` and `terminal.ts`** — unchanged by instruction, and by design:
  they are pure type declarations with no runtime weight, and `terminal.ts` is the service
  contract shared with the RPC layer.
- **The renderer panel** (`packages/ui/src/terminal/TerminalSession.tsx`) — invariant 9. It
  consumes the profile over RPC and must never import `@zcode/rust`; it is untouched.

### 2.3 Sync vs async (invariant 4)

- `resolve_terminal_font_profile` is an **async napi task**. It performs up to eleven
  `read`+parse cycles. On a Windows home directory under Defender, or any network home, a
  single `read` is routinely >1 ms, so this clears the invariant-4 threshold and the crate does
  not gamble on the common case. The only caller (`terminalService.create`) is already async.
- `resolve_terminal_shell`, `resolve_terminal_cwd`, `parse_iterm2_plist`,
  `parse_mac_os_terminal_plist` and the policy check are **synchronous**. Each is at most a
  handful of `access`/`stat` syscalls or a pure parse of a string already in memory, all far
  below 1 ms, and they sit on the same code path as a user action that is about to block on a
  process spawn.

### 2.4 Ownership

| Piece | Owner |
|---|---|
| `packages/rust/crates/zcode-terminal-profile/**`, `packages/rust/src/terminalProfile.ts`, this spec | PortTerminalProfile |
| `packages/services/src/terminal/terminalProfile.ts` (rewritten as the typed façade over the wrapper) | PortTerminalProfile |
| `packages/services/src/terminal/terminalService.ts` (import + the three call sites) | PortTerminalProfile |
| `packages/services/src/terminal/terminalProfileMacOs.ts` (**deleted**) | PortTerminalProfile |
| `packages/services/src/terminal/terminalProfileTypes.ts`, `terminal.ts` | **untouched** |
| `packages/rust/Cargo.toml`, `package.json`, `src/loader.ts`, `src/index.ts`, `scripts/build-native.sh` | main session |

---

## 3. Design

### 3.1 Crate shape

```toml
[package]
name = "zcode-terminal-profile"

[lib]
crate-type = ["cdylib", "rlib"]   # cdylib: the Node consumer loads zcode-terminal-profile.<target>.node

[dependencies]
napi, napi-derive, serde_json     # workspace
toml = "0.8"                      # replaces smol-toml for the alacritty.toml detector
yaml-rust2 = "0.10"               # replaces the `yaml` npm package for alacritty.yml/.yaml
libc = "0.2"                      # access(2) for isExecutable, so X_OK semantics match accessSync exactly
```

`toml` and `yaml-rust2` are new to the tree and are therefore declared **in this crate's own
manifest** rather than in `packages/rust/Cargo.toml`, which the main session owns; the
promotion request is §9. `libc` is already compiled in the tree as a transitive `napi`
dependency. `yaml-rust2` is chosen over `serde_yaml` because the latter is deprecated, and over
a serde-based fork because the extraction needs a value tree, not a typed deserialisation.

### 3.2 Boundary

`env` crosses as a **named projection**, not as `process.env`. Detection reads exactly eight
environment variables (`HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `XDG_CONFIG_HOME`,
`SHELL`, `PATH`, `ComSpec`); shipping all of `process.env` to move 8 strings would cost more
than the parse it replaces and would make the crate's inputs untyped. `os.homedir()` is
passed as `home_dir` rather than read in Rust: `homedir()` is a `getpwuid` on POSIX, and taking
it as an input keeps the fallback chain `HOME → USERPROFILE → homedir()` byte-identical without
adding a `dirs`/`home` dependency for one call.

```rust
#[napi(object)]
pub struct TerminalEnvInput {
  pub home: Option<String>,            // env.HOME
  pub user_profile: Option<String>,    // env.USERPROFILE
  pub local_app_data: Option<String>,  // env.LOCALAPPDATA
  pub app_data: Option<String>,        // env.APPDATA
  pub xdg_config_home: Option<String>, // env.XDG_CONFIG_HOME
  pub shell: Option<String>,           // env.SHELL
  pub path: Option<String>,            // env.PATH
  pub com_spec: Option<String>,        // env.ComSpec
  pub home_dir: String,                // os.homedir()
}

#[napi(object)]
pub struct TerminalFontProfileInput {
  pub platform: String,                        // process.platform
  pub env: TerminalEnvInput,
  pub terminal_font_family: Option<String>,    // settings.terminalFontFamily
  pub terminal_inherit_system_profile: Option<bool>,
  pub iterm2_plist_json: Option<String>,       // plutil stdout — §2.2 seam
  pub macos_terminal_plist_json: Option<String>,
}
```

Outputs mirror the TypeScript shapes one-for-one, including the `Option` → `undefined`
mapping: `TerminalFontProfile { font_family, font_size?, theme?, source }`,
`TerminalDetectedProfile { font_family?, font_size?, theme? }`, and
`TerminalThemeProfile` with the same 21 optional keys in the same declaration order.

### 3.3 Exported surface

| Rust | TS | Sync |
|---|---|---|
| `resolve_terminal_font_profile` | `resolveTerminalFontProfile` | async |
| `parse_iterm2_plist(json)` | — (feeds the above) | sync |
| `parse_mac_os_terminal_plist(json)` | — (feeds the above) | sync |
| `resolve_terminal_shell({ platform, shell, path })` | `resolveTerminalShell` | sync |
| `resolve_terminal_cwd({ cwd, home, home_dir })` | `resolveTerminalCwd` | sync |
| `check_terminal_spawn_policy(policy, request)` | — (wave 2, §5) | sync |

### 3.4 The shell order, recorded as a ported invariant (brief item 3)

`resolveTerminalShell` is a *ladder*, and the order is the security property — it is what makes
the host prefer a modern PowerShell over `cmd.exe` on Windows, and a real `$SHELL` over a
hard-coded `/bin/zsh` on POSIX. The crate encodes it as data so a test can assert the order
itself and not merely its first and last elements:

```
win32: pwsh.exe → powershell.exe → env.ComSpec → cmd.exe
posix: env.SHELL → /bin/zsh → /bin/bash → /bin/sh
```

Each candidate is tried in order and the first **executable** one wins; `env.SHELL` and
`env.ComSpec` are skipped when empty (the legacy `if (candidate && …)` guard). When every
candidate fails the call throws, and the two messages are preserved verbatim because they are
what a user sees when no shell exists:
`"No usable Windows shell found for terminal startup"` and
`"No usable shell found for terminal startup"`. A terminal that silently gets a different shell
than the ladder names is a behaviour fork; a terminal that spawns *nothing* is the safe failure.

`isExecutable` keeps the legacy shape: a candidate containing a path separator is probed
directly, otherwise each non-empty `PATH` entry is probed with the candidate appended. The
`PATH` split uses the **host** delimiter (`:` / `;`), because `path.delimiter` in the legacy
code is a host property — a differential that exercises the win32 branch on Linux must split on
`:` to agree with it. The executable test is `access(2)` with `X_OK` on Unix (not a mode-bit
test: those differ for an ACL-only grant) and plain existence on Windows, which is what
`fs.constants.X_OK` degrades to there.

`resolveTerminalCwd` is ported with it for the same reason: `cwd → $HOME → homedir() → /`, first
one that stats as a directory, else throw
`"No usable working directory found for terminal startup"`. It is the other half of the same
decision, and leaving it in the wrapper would leave half the spawn policy untyped.

### 3.5 Parity techniques that are not obvious

These are the places where a "reasonable" Rust translation silently diverges. Each is pinned by
a test named after it.

1. **Whitespace is not `str::trim`.** JS `String.prototype.trim` strips `WhiteSpace` +
   `LineTerminator` per ECMA-262, which **includes U+FEFF and excludes U+0085**. Rust's
   `str::trim` uses the Unicode `White_Space` property, which does the exact opposite on both
   of those. `js_trim` / `js_is_space` are implemented from the spec table, not from Rust's
   `char::is_whitespace`.
2. **`kitty.conf` uses the first regex match, not the first usable one.** The legacy
   `raw.match(/^\s*font_family\s+(.+)$/m)` takes the first *matching line*; if that line's
   capture trims to empty the detector gives up on the file rather than trying the next
   `font_family` line. Implemented as `first_match` + `normalize`, never as "scan for a
   non-empty one".
3. **`.replace(/^"|"$/g, "")` on the kitty value** strips a leading and/or a trailing `"`,
   and does so **after** the trim — so `"Fira Code"` → `Fira Code"`. Reproduced literally.
4. **`Number.parseFloat` is not `str::parse::<f64>`.** `parseFloat("12abc")` is `12`,
   `parseFloat("0x10")` is `0`, `parseFloat("")` is `NaN`, `parseFloat("Infinity")` is
   `Infinity` (which the 6..72 clamp then rejects). `js_parse_float` implements the
   `StrDecimalLiteral` prefix scan. This feeds both the font-size clamp and every plist colour
   component.
5. **`Math.round` is half-up, not half-away-from-zero.** Only reachable for negative values,
   which the 0..1 colour range excludes — but `js_round` is written as `(x + 0.5).floor()` so
   the difference cannot be introduced later.
6. **`alpha.toFixed(3)` then `+` then template-interpolate** is not "print with 3 decimals".
   The round trip through `Number` strips trailing zeros, so `0.500` interpolates as `0.5` and
   the emitted colour is `rgba(0, 0, 0, 0.5)`. Implemented as
   `format_fixed3_stripped`: shortest-round-trip decimal of the value, rounded half-up at the
   third place (the ECMAScript rule: ties pick the *larger* `n`), trailing zeros stripped.
7. **`Buffer.from(s, "base64")` is Node's lenient decoder.** It skips every character outside
   the alphabet, treats `=` as a terminator, and decodes a trailing 2- or 3-character group.
   The archived-font-name path (`readMacOsArchivedFontName`) depends on it, and a strict
   decoder would return a different string.
8. **The archived-font regex is leftmost-first with a greedy prefix.** It is transcribed as
   (a) leftmost start on `[A-Za-z]`, (b) the **largest** `m` in the class run where an
   alternative matches (greedy `*` backtracks from the longest), (c) then greedy class
   extension. Transcribing it as "longest match" or using a Rust regex crate with different
   leftmost-first semantics would change the captured span.
9. **Alacritty YAML/TOML documents that are not objects are rejected, and so is a
   multi-document YAML stream.** `yaml`'s `parse()` throws on multiple documents; a loader that
   returns the first document would accept a file the legacy code rejected. The Rust loader
   mirrors the throw.
10. **The two `parseJsonc` attempts are in order `raw`, then cleaned.** A file that is valid
    strict JSON takes attempt 1, so the comment stripper never runs on it; a file that is only
    valid after cleaning takes attempt 2. The order is observable through a file whose raw form
    parses to a *different* object than its cleaned form, which the differential includes.

---

## 4. Migration boundary

### 4.1 What is deleted

| File | Disposition |
|---|---|
| `packages/services/src/terminal/terminalProfileMacOs.ts` (367 lines) | **deleted**. Every function in it is either ported or is the one named spawn in §2.2. |
| `packages/services/src/terminal/terminalProfile.ts` (415 lines) | **rewritten**, not kept as a second implementation. What remains is a ~70-line typed façade: the two `plutil` calls, the env projection, and a call into `@zcode/rust/terminal-profile`. It exports the same `resolveTerminalFontProfile` plus the type re-exports that `terminal.ts:4` and `terminalService.ts:9-13` import, so neither of those files changes its import lines. |

`smol-toml` and `yaml` stay in `packages/services/package.json` — they are still imported by
`settings-sync`, `skill-sync`, `skills` and `subagents` — but this module's last use of each is
gone, which is why the crate needs Rust parsers for them at all.

### 4.2 Consumer changes

| File | Change |
|---|---|
| `packages/services/src/terminal/terminalService.ts:9-13` | import `resolveTerminalShell` / `resolveTerminalCwd` alongside the profile, drop the two local definitions at `:67-89,285-321` |
| `terminalService.ts:363-364,370-373` | call the wrapper; `await` the profile because the native call is an async task |
| `packages/rust/src/terminalProfile.ts` | **new** — the `@zcode/rust/terminal-profile` subpath, the only place that calls `loadNative("zcode-terminal-profile")` |

### 4.3 Divergences

- **D1 — `resolveTerminalFontProfile` returns a `Promise`.** The legacy function was
  synchronous. Invariant 4 forces the async napi task; the caller was already `async`. No
  consumer besides `create()` exists (grep: `packages/**` — `terminal.ts` and `terminal.tsx`
  only reference the *types*).
- **D2 — the plist is read before the ladder runs, not when the ladder reaches it.** In the
  legacy code `readMacOsPlistFile` was called lazily, so a VS Code match short-circuited before
  any `plutil` ran. The spawn is not ported (§2.2) and the ladder is in Rust, so the plists are
  fetched up front on `darwin` only, still behind the same `existsSync` gate. **Output is
  identical**; the cost differs only when both plists exist *and* an earlier detector would
  have matched. Recorded rather than hidden, because it is the price of the seam.
- **D3 — none in the detection results.** Any difference in a returned font, size, colour or
  `source` is a bug, discharged by the 41-case differential in §7.
- **D4 — the native object sets keys in napi's order, so the wrapper rebuilds the result in
  the legacy key order.** The values are identical; only the key order of a `JSON.stringify`d
  payload would have moved, and that payload is what the renderer consumes.
- **D5 — `readMacOsPlistJson` returns `undefined`, not `null`.** napi's `Option<String>`
  rejects an explicit `null`; `undefined` is the absent value. A latent crash, not a
  behaviour change: the legacy returned `null` into JavaScript and never crossed the boundary.

---

## 5. The terminal policy input shape (brief item 4)

`create()` today has no permission service, no confirmation and no sandbox. This wave does not
invent one — the pty spawn stays in `terminalService.ts` and is wave 2 — but the crate owns the
**typed shape** that spawn will have to be handed, so that the decision is made in one place,
inside the native boundary, for the desktop host, the server and the CLI alike.

```rust
#[napi(object)]
pub struct TerminalSpawnPolicy {
  /// Exact binaries `resolve_terminal_shell` may return. Compared with `==`, never by
  /// prefix or basename, so `/tmp/zsh` cannot satisfy an entry of `/bin/zsh`.
  pub allowed_shells: Vec<String>,
  /// Directories the pty may start in, after symlink resolution.
  pub allowed_cwd_roots: Vec<String>,
  /// Environment variable names stripped from the child env. Seeded with the
  /// loader-injection names (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`,
  /// `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`), because the child is
  /// spawned with an inherited environment and none of those should cross.
  pub env_denylist: Vec<String>,
  /// Whether the child inherits the parent env at all. `resolveTerminalEnv` is an
  /// allow-everything-else merge today; flipping this is the one-line change that stops it.
  pub inherit_env: bool,
  pub max_cols: f64,
  pub max_rows: f64,
}

#[napi(object)]
pub struct TerminalSpawnRequest {
  pub platform: String,
  pub shell: String,
  pub cwd: String,
  pub cols: f64,
  pub rows: f64,
}

#[napi(object)]
pub struct TerminalSpawnDecision {
  pub allowed: bool,
  /// Stable machine-readable reason: `shell-not-allowed`, `cwd-outside-roots`,
  /// `cwd-unresolvable`, `cols-out-of-range`, `rows-out-of-range`.
  pub reason: String,
}
```

`check_terminal_spawn_policy(policy, request) -> TerminalSpawnDecision` is implemented and
tested in this wave, and **not yet called**, because there is no spawn to gate. It is not a stub
and not a placeholder: it is a complete deny-by-default decision function with tests, and it is
the specified input to wave 2. Its rules, in order:

1. `shell` must equal an entry of `allowed_shells`. No match → `shell-not-allowed`, denied.
2. `cwd` must `canonicalize` (symlinks resolved **first**, so a symlink out of an allowed root
   is refused) and then be a directory under some `allowed_cwd_roots` entry, also
   canonicalized. Not a directory, unresolvable, or outside every root → denied.
3. `cols`/`rows` must be finite and within `1..=max_*`. Out of range → denied.
4. Anything the checker cannot evaluate is a **denial**. There is no `allowed: true` on error.

What wave 2 consumes from this crate, precisely: `resolve_terminal_shell` and
`resolve_terminal_cwd` to produce the request, `check_terminal_spawn_policy` to gate it, and
`TerminalSpawnPolicy` as the single place the allowlist and the confinement root are configured
— so a caller that forgets to configure them gets a denial, not an unrestricted pty.

---

## 6. Wave 2 (named, not promised here)

The pty spawn: `spawnTerminalProcess`, `node-pty` loading, the node-pty `spawn-helper`
`chmod` on macOS, the ConPTY-DLL retry ladder, and the env merge. Those are effects, not
decisions, and they need a Rust pty and a platform build story that this wave does not have.
What moves with them: the call to `check_terminal_spawn_policy` before `nodePty.spawn`, and
`resolveTerminalEnv` behind `inherit_env` / `env_denylist`.

---

## 7. Differential (recorded, per `rust-native-program.md` §5)

Both implementations were run over the same named cases against the same fixture tree and
the results compared as strings. **41/41 agree**, including the two cases that are supposed
to throw.

The harness replayed a verbatim copy of the pre-port `terminalProfile.ts` and
`terminalProfileMacOs.ts` (the only edit being the documented `plutil` spawn replaced by a
fixture read, because the port owns everything downstream of that string) against the new
crate, and a verbatim copy of the pre-port `terminalService.ts` shell/cwd helpers against the
new ladders. The harness and the copies were deleted once this table was recorded; the
file-based half of the same corpus lives on as `tests/profile_files.rs`.

| # | Case | Fixture | Result |
|---|---|---|---|
| 1 | `no-config` | empty `$HOME` | both `fallback`, the full 12-entry stack |
| 2 | `custom-font-only` | `terminalFontFamily: "Fira Code"` | both `custom`, `"Fira Code, ui-monospace, …"` |
| 3 | `custom-font-dedupes` | `"Menlo, monospace"` | both keep the user's order and omit the repeats |
| 4 | `custom-font-blank` | `"   "` | both `fallback` — a blank setting is not a custom font |
| 5 | `inherit-off` | `terminalInheritSystemProfile: false` + a matching kitty.conf | both `custom` with **no** size and **no** theme |
| 6 | `vscode-jsonc` | settings.json with `//`, `/* */` and a trailing comma | both `system`, `"JetBrains Mono, …"` |
| 7 | `vscode-strict-json` | the same file with the comments removed | identical to 6 (attempt 1 of `parseJsonc`) |
| 8 | `vscode-missing-key` | valid settings.json, no `terminal.integrated.fontFamily` | both `fallback` |
| 9 | `vscode-via-services-facade` | the same fixture, through the new TypeScript façade | identical — the env projection is right |
| 10 | `windows-terminal-guid` | `defaultProfile` matching the **second** list entry | both that entry's `font.face` |
| 11 | `windows-terminal-defaults` | no guid match; `profiles.defaults.font.face` present | both the defaults face |
| 12 | `windows-terminal-first-entry` | neither; first list entry has a face | both the first entry's face |
| 13 | `windows-terminal-no-appdata` | file present, `LOCALAPPDATA`/`APPDATA` absent | both `fallback` — no path can even be built |
| 14 | `windows-terminal-not-on-win32` | the same file, `platform: "linux"` | both `fallback` — the detector is platform-gated |
| 15 | `kitty-quoted` | `font_family  "Fira Code"` | both `"Fira Code, …"`; both quotes stripped |
| 16 | `kitty-blank-first-line` | `font_family␣␣␣\nfont_family␣␣MesloLGS NF` | both `"font_family  MesloLGS NF, …"` — see below |
| 17 | `kitty-missing-file` | no kitty.conf | both `fallback` |
| 18 | `alacritty-toml` | `[font.normal] family = "Iosevka"` | both `system` |
| 19 | `alacritty-yaml` | `font.normal.family: Berkeley Mono` | both `system` |
| 20 | `alacritty-yaml-multidoc` | a two-document stream | both `fallback` — the parser rejects it |
| 21 | `alacritty-non-string-family` | `family = 42` | both `fallback` |
| 22 | `kitty-beats-alacritty` | both configs present | both `system`, kitty's family — detector order |
| 23 | `iterm2-plist` | `Default Bookmark` on the 2nd entry, `Normal Font: "SFMono-Regular 12"`, hex + record + `rgba()` colours, an `Ansi 1` with `Alpha Component` | both: family `SFMono Regular`, size 12, and the identical 7-key theme including `#1a334d` and `rgba(128, 128, 128, 0.5)` |
| 24 | `iterm2-plist-font-size-clamp` | `"Normal Font": "Foo 80"` then `"Foo 4"` | both drop the sizes and keep the family — 6..72 |
| 25 | `iterm2-plist-dash-size` | `"Normal Font": "Monaco-10"` | both `"Monaco 10"` with **no** size — see below |
| 26 | `iterm2-plist-archived-font` | `Font: {NS: base64}` instead of `Normal Font` | both `fallback` — iTerm2 only reads `Normal Font` |
| 27 | `macos-terminal-plist` | `Startup Window Settings` + `Default Window Settings` both present | both use `Basic`: `Andale Mono`, 13, `foreground`/`black` |
| 28 | `macos-terminal-custom-font` | the same plist with a custom family | both `custom`, and both still carry size 13 and the theme |
| 29 | `macos-terminal-settings-order` | a plist naming no settings dict | both `fallback` |
| 30 | `macos-terminal-archived-font` | `Font: {NS: base64("SF Mono 13")}` | both `SF Mono` with **no** size — see below |
| 31 | `macos-no-plists` | neither plist supplied | both `fallback` |
| 32 | `shell-posix-shell-env` | `$SHELL` set and executable | both the same shell |
| 33 | `shell-posix-dead-shell-env` | `$SHELL=/nonexistent/zsh` | both the first standard shell that exists |
| 34 | `shell-posix-empty-shell-env` | `SHELL=""`, dead `PATH` | both a standard shell — the empty var is skipped |
| 35 | `shell-windows-pwsh` | a `PATH` dir with an executable `pwsh.exe` | both `"pwsh.exe"` — the candidate, not the resolved path |
| 36 | `shell-windows-powershell` | no `pwsh.exe`, dead `PATH` | both throw `No usable Windows shell found for terminal startup` |
| 37 | `shell-windows-comspec` | `ComSpec` set and executable | both `ComSpec`'s value |
| 38 | `shell-windows-empty-comspec` | `ComSpec: ""`, dead `PATH` | both throw the Windows message |
| 39 | `cwd-arg-wins` / `cwd-dead-cwd` / `cwd-root` | directory / missing directory / nothing | both the requested directory, then `$HOME`, then `/` |

### Three legacy quirks the port reproduces rather than fixes

Recording these because each one looks like a bug and a future reader will be tempted to
"fix" it in Rust, which would be a behaviour fork:

1. **`kitty.conf` with a blank value swallows the next line.** The regex is
   `^\s*font_family\s+(.+)$` and `\s` is the *regex* whitespace class, which includes `
`.
   So a blank value lets `\s+` run past the newline and `(.+)` captures the following line —
   key and all. `"font_family   
font_family  MesloLGS NF"` yields the font family
   `"font_family  MesloLGS NF"` (case 16). My first transcription matched per line and
   returned nothing; the differential caught it.
2. **`"Monaco-10"` keeps its digits in the family name.** The size regex is
   `\s+(\d+(?:\.\d+)?)$`, which needs whitespace before the digits, so a dash-separated size
   is not recognised: the family becomes `"Monaco 10"` and no size crosses (case 25).
3. **An archived `NSData` font yields a family but no size.** `readMacOsFontDescriptor` is
   given the `Font` *object* and stringifies it to `"[object Object]"` (case 30).

### Key order

The native object sets its keys in napi's order (`fontFamily, source, fontSize, theme`),
while the payload it replaces emitted `fontFamily, fontSize, theme, source`. That payload
reaches the renderer through `JSON.stringify`, where key order is bytes, so
`packages/rust/src/terminalProfile.ts` rebuilds the object in the legacy order. This is
D4 below.

## 8. Failure semantics

| Failure | Legacy | Rust | Test |
|---|---|---|---|
| config file missing | `existsSync` false → detector yields `null` | `read_to_string` `Err` → `null` | `missing_config_file_is_not_an_error` |
| config file unreadable / is a directory | `readFileSync` throws → caught → `null` | `Err` → `null` | same |
| malformed JSONC | both parse attempts fail → `null` | `serde_json` fails both → `None` | `malformed_jsonc_yields_no_profile` |
| comment stripper hits an unterminated `/*` | consumes to EOF, result is invalid JSON → attempt 2 also fails → `null` | identical | `unterminated_block_comment_is_rejected` |
| `plutil` missing / times out / non-zero | caught → `null` (and the whole macOS detector yields `null`) | **stays in TS**, unchanged | covered by the TS façade |
| plist JSON not an object | `null` | `None` | `plist_non_object_yields_nothing` |
| font size `< 6` or `> 72` or non-numeric | `null`, family may still be used | identical | `font_size_clamp_boundaries` |
| colour component out of 0..65535, or r/g/b missing | `null`, the whole colour is dropped | identical | `color_component_ranges` |
| `terminalInheritSystemProfile` absent | treated as `true` | `None` → `true` | `inherit_flag_defaults_to_true` |
| no detector matched | `{ fontFamily: <full fallback stack>, source: "fallback" }` | identical | `no_detector_yields_fallback_profile` |
| no usable shell | `throw new Error(<message>)` | `Err` with the identical message | `shell_ladder_throws_when_exhausted` |
| no usable cwd | `throw new Error(<message>)` | identical | `cwd_ladder_throws_when_exhausted` |
| native binary missing | n/a | `loadNative` throws — **no JS fallback**, invariant 1 | existing loader behaviour |
| policy cannot be evaluated | n/a | **denied** | `policy_denies_when_it_cannot_evaluate` |

---

## 9. Shared-file change requests (main session)

| File | Exact change | Why |
|---|---|---|
| `packages/rust/Cargo.toml` | add `toml = "0.8"`, `yaml-rust2 = "0.10"`, `libc = "0.2"` to `[workspace.dependencies]`, and point this crate at `{ workspace = true }` | every other crate declares its deps through the workspace table; these three are currently declared in the crate manifest so that the port could build without touching a file it does not own. Resolved versions at capture time: `toml 0.8.23`, `yaml-rust2 0.10.4`, `libc 0.2.x`. `toml` and `yaml-rust2` are new third-party crates — they need a `THIRD-PARTY-NOTICES.md` / `third-party/inventory.json` entry before merge. |
| `packages/rust/package.json` | **already staged** — `"./terminal-profile": "./src/terminalProfile.ts"` | no change needed |
| `packages/rust/src/loader.ts`, `src/index.ts`, `scripts/build-native.sh` | **no change** | `members = ["crates/*"]` is a glob and the staging set is computed, not declared |
| root `package.json` | **no change** | `packages/rust` is already in the typecheck list |
| `architecture-policy.yaml` | **no change** | the `rust` module already owns `packages/rust` |

---

## 10. Acceptance checklist

- [x] Spec written before the crate (`AGENTS.md:3`).
- [x] `cargo build --release -p zcode-terminal-profile` succeeds and emits
      `zcode-terminal-profile.linux-x64-gnu.node`.
- [x] Direct-load smoke: the `.node` is loaded with `node -e` and every export is exercised.
- [x] `cargo test -p zcode-terminal-profile` passes, with **one test per row of §8**.
- [x] Differential of 40 named cases (§7) with recorded results.
- [x] `terminalProfileMacOs.ts` deleted; `terminalProfile.ts` contains no detection logic.
- [x] No `try { native } catch { legacy }`, no env flag, no second implementation.
- [x] Zero child-process spawns in the crate (§2.2 names the one retained spawn and why).
- [x] `terminalProfileTypes.ts` and `terminal.ts` byte-unchanged.
- [x] Renderer graph untouched — nothing under `packages/ui` imports `@zcode/rust`.
- [x] The shell order is a ported invariant with an order-asserting test (§3.4).
- [x] The policy input shape is defined, implemented and tested (§5).

---

## 11. Risks

- **R1 — the two retained `plutil` spawns are now eager on darwin (D2).** Bounded by the
  `existsSync` gate and by the fact that both plists are tiny, but it is a real change in
  *when* a process is spawned. Wave 2 removes it by reading the plist in Rust.
- **R2 — YAML/TOML parser divergence.** `smol-toml` and the `yaml` npm package are
  high-quality parsers; `toml` and `yaml-rust2` are different implementations. The extraction
  is a single nested string key, and the corpus rows 16–19 cover the shapes that matter
  (nested table, nested mapping, multi-document rejection, non-string value). A file using an
  exotic YAML feature could still diverge; the failure mode is a different font family, not a
  wrong decision, and it is a one-line fix in the crate.
- **R3 — the regex transcriptions in §3.5.** Eight behaviours that a Rust regex crate would
  get subtly wrong. Each has a named test; the risk is a *new* regex-shaped rule added later
  without knowing the transcription rules exist, which is why they are documented rather than
  left in the code.
- **R4 — `access(2)` via `libc` is unix-only.** On Windows the executable test degrades to
  existence, which is what `accessSync(X_OK)` does there, but it means the Windows branch has
  no real permission semantics to preserve. Inherent to the platform, recorded not fixed.
- **R5 — `check_terminal_spawn_policy` has no caller until wave 2.** The honest risk is that
  wave 2 slips and the function sits unused while `create()` stays unguarded. The mitigation is
  that the type, the order of the rules, and the wave-2 contract are written down here, so the
  gap is a tracked one rather than an invisible one.
- **R6 — payload growth (programme R5).** A new `.node` per crate. This one is small: no image
  or database dependency, and `toml`/`yaml-rust2` add well under a megabyte.
