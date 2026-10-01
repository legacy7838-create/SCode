# Candidate classification: the observability cluster

Written 2026-09-30, after measuring each of the four channels the cluster was proposed for. Three
of the four are **not portable**, and the reason is recorded here rather than discovered later.

Spec context: `docs/specs/rust-native-mcp-config.md` §2.2 used this same discipline — classify the
surface first, then scope only what genuinely moves.

## The four channels

| Channel | Delegates to | Verdict |
|---|---|---|
| `zcode:log` (`desktopMainIpcPlatform.ts:291`) | `options.logger.fromRenderer(level, args)` | **Not portable — a transport, not logic** |
| `zcode:get-desktop-session-activity` (`:345`) | `options.getDesktopSessionActivity()` → `getRunningAgentSessionCount()` (`index.ts:1304`) | **Not portable — the Tauri host does not own this state** |
| `zcode:capture-window-screenshot` (`:369`) | `senderWindow.webContents.capturePage()` | **Not portable — no Tauri equivalent** |
| `zcode:export-logs` (`:368`) | `exportLogs()` (`exportLogs.ts`, 1,234 lines) | **Portable, and the only one worth doing** |

### Why each of the three is not portable

**`zcode:log`** forwards validated renderer log lines into the host's logger. There is no
computation to move: the zod validation stays in the renderer-facing layer either way, and the
transport from renderer to host is whatever IPC the shell provides. In Tauri the renderer-side
emission is `console` capture, not a ported function. Porting this would move a `console.warn`
call and nothing else.

**`zcode:get-desktop-session-activity`** returns `{ runningAgentSessionCount }`, counted by the
Electron **main** process holding the agent runtime in-process (`index.ts:1304`). In the Tauri
architecture the agent runs in a separate `@zcode/server` Node process, which the renderer already
reaches over the WebSocket (`PORT_STATUS.md`, "UI status"). So the count is owned by the server, not
the host: asking the Rust host for it would mean asking a process that has no answer, and the
currently-returned `0` is the honest placeholder. The correct fix is for the renderer to read the
count from the service channel it already has, not to fabricate a Rust one.

**`zcode:capture-window-screenshot`** calls Electron's `webContents.capturePage()` and base64s the
PNG. Verified against the vendored Tauri source: `tauri-2.12.0/src/window/mod.rs` exposes **no
`screenshot` or `capture*` method at all**. This is a genuine platform gap, the same category
`PORT_STATUS.md` already records for `ipcRenderer.sendSync` and `setBadgeCount`. It needs either a
Tauri plugin or WebKitGTK-specific code behind a capability decision — an architecture choice, not
a port. It must not be faked with a partial-screenshot or a filesystem read of a cache.

## The one that is worth porting

`exportLogs.ts` is 1,234 lines of real, host-local work: filesystem walking with glob excludes, a
3-day lookback window, UTF-8/UTF-16 encoding detection with BOM handling, **credential redaction**,
and a zip with a directory fallback.

The redaction is the reason this has real value rather than being busywork. It is a layered
defence, and each layer exists because the one above it missed something:

- **key-name families** — a substring alternation (`password|secret|token|api(?:_|-)?key|auth|cookie|
  dsn|conn…`) so custom names like `db_password` or `my_secret` are caught without enumeration,
  with an **allowlist** so `input_tokens`, `max_tokens` and `author` are *not* redacted — the
  comment at `:176-180` is explicit that `*_tokens` must never be allowlisted, or
  `access_tokens` would ship in the clear;
- **value-shape redaction** for JSON, assignment and header styles, so a credential is caught by
  how it looks rather than only by what it is called;
- **Bearer tokens**, **query-string tokens**, and **connection-string credentials** —
  the last with a deliberate greedy-to-the-last-`@` rule so a password containing a naked `@`
  (`P@ssw0rd`) is fully removed instead of leaving a fragment.

`zcode-cron`'s port was justified as a capability port and this one is the same: the Tauri host
cannot serve `export-logs` at all today, and the fallback returns
`{ success: false, error: … }`, so a user reporting a bug cannot get their logs out of that build.

## Scope, and why it is not a single-commit job

The module does not divide into a portable half and an Electron half. The redaction is pure, but
its only Rust consumer is the same function that walks the tree and writes the archive — a port
that stopped after the redaction would have no caller, which is the same trap
`migrate_legacy_common_mcp` fell into before it was corrected.

Realistic decomposition, in dependency order:

1. **`zcode-logredact` crate** — the redaction and encoding detection as pure functions, with an
   exhaustive fixture corpus. No dependencies beyond a regex engine. Independently valuable and
   fully testable.
2. **Archive planning** — glob-to-regex, the exclude lists, the lookback window, and the encoding
   probe, producing a plan of `(source, dest, encoding, redacted)`.
3. **Archive writing** — the `zip` crate (a new dependency; not currently in the Rust lockfile) plus
   the directory fallback.
4. **Tauri command + `showItemInFolder`**, reusing the existing `open_in_file_manager` command.

Steps 1 and 2 are the security-relevant half and where a mistake actually leaks a credential.
Step 3 is mechanical. Step 4 is thin.

## Risks

- **R1 — a redaction regression leaks a credential into a file the user sends to support.** This is
  the highest-consequence risk in the entire Rust programme, and it is why step 1's fixture corpus
  has to be written from the *comments* explaining each rule, not from the regexes alone: several
  of the rules exist to catch a case the author already got wrong once.
- **R2 — the allowlist is a security hole if widened.** `max_tokens` must stay; `access_tokens`
  must not. A fixture that asserts both, in the same test, is the guard.
- **R3 — the `zip` crate is a new supply-chain dependency** in a project that already vendors
  `yazl` for the same job. It needs the same licence review and NOTICE update.
- **R4 — encoding detection has a scoring heuristic** (`TEXT_DETECTION_SAMPLE_BYTES`,
  preferred/invalid char ratios). Porting a heuristic without its calibration data risks
  mis-detecting a UTF-16 log and then corrupting it during redaction.

---

## Status 2026-10-01 — attempted, then reverted

`zcode-logredact` was written (31 tests, dependency-free) and wired into
`packages/desktop/src/main/exportLogs.ts`, deleting the predecessor redaction. It was then
**reverted in full**: the crate, the `@zcode/rust/logredact` subpath, the wrapper, the parity script,
and the `exportLogs.ts` edit.

**Reason: a product decision, not a technical failure.** The user does not send user logs to anyone,
so the export-then-redact path is not part of the product. Everything below stays valid reference if
that changes.

The attempt is recorded because of how it ended. The redaction itself was sound — a recorded
differential against the predecessor surfaced **7 real divergences, all defects in the port and none
in the predecessor**, including `api_key` not being classified as sensitive at all and a half-redacted
`db_password = ***REDACTED***hunter2`. Fixing them was attempted by patching `redact_line`
piecemeal and then rewriting it; the rewrite introduced a non-advancing loop, and because the line
scan allocated a `String` per iteration it grew until the machine was OOM-pressured. The guard that
fixes it is one line (`index = hit.value_end.max(index + 1)`), but the crate was already reverted by
the time it was written.

**The lesson is the one the spec already states.** `rust-native-program.md` §5 requires a port to be
one bounded step with a recorded differential *before* the predecessor is deleted. Here the
differential ran *after* the delete (reconstructing the predecessor from `git show HEAD:`), and the
fixes were attempted without tests in between. One divergence, one test, one fix, verify — in that
order — is the discipline that would have kept a working feature working.
