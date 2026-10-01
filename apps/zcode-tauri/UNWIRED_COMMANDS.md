# Registered Tauri commands with no renderer caller

`zcode-packaging inventory` reports every command listed in `generate_handler!` that no file under
`apps/zcode-tauri/src` names. That report is only useful if "uncalled" and "dead" are different
things, so a command may appear here with the reason it is still registered.

Two rules, both of which exist because this list was not needed until five commands had already gone
unnoticed:

1. **A reason is mandatory.** The parser drops an entry with no reason after the dash, so a bare
   allowlist cannot accrue. That is deliberate: the five commands deleted from
   `CUTOVER_SPEC.md` §8.1 were exactly the ones nobody had written a reason for.
2. **An entry expires with its reason.** If the thing being waited on lands, the entry is deleted in
   the same change that wires the command. A justification that outlives its consumer is a dead
   command with a good story.

---

## Awaiting the embedded browser (Wave B1)

These exist because the Coding Plan and payment flows have to make a navigation decision that Tauri
cannot derive from a renderer-supplied URL. Their consumer is the webview navigation handler, which
does not exist yet — `CUTOVER_SPEC.md` §4 records the redesign. Until it does, they are unreachable
by construction, and deleting them would delete the security boundary they carry.

- `decide_navigation` — resolves whether a navigation stays inside the trusted Coding Plan webview
- `decide_external_open` — resolves whether an `openExternal` request is an allowed scheme
- `is_coding_plan_webview` — trusted-origin test for the guest
- `is_payment_callback` — payment-callback test
- `is_trusted_webview_origin` — the origin allowlist itself

## A second layer, not a missing caller

`ITerminalService` (`packages/services/src/terminal/`) is the Node-side business service that spawns
terminals over RPC. These commands spawn a PTY **inside the Rust host** instead, which is the point:
confinement belongs on the Rust side of the boundary (`CUTOVER_SPEC.md` §3 A3), not above it. Wiring
them through `IPlatformService` would be wrong — that interface has no terminal member and should not
grow one.

- `terminal_create` — spawns a PTY under an `AllowedRoots` confinement check
- `terminal_write` — writes to the pty
- `terminal_resize` — resizes the pty
- `terminal_kill` — kills one pty
- `terminal_kill_all` — kills every pty for the window
- `terminal_list` — lists the window's ptys

## Consumed natively, not from the renderer

- `show_current_window` — emitted by the Rust side for the tray and the single-instance handler; the
  renderer is the *subject*, not the caller
- `request_quit` — the quit ladder lives in Rust (`app_state.rs`, `window.rs`)
- `get_window_state` — read by the Rust window coordinator, not by the renderer

## Deliberately not wired

- `get_renderer_session` — Rust owns the session identity and `session.ts` caches what it read.
  A second reader would be a second source of truth, not a wiring fix.

## Needing a decision (no entry here on purpose)

- `bind_remote_workspace_session_context` — binds a canonical workspace identity to a remote logical
  session. It belongs to the remote-connect flow, which is refused (`NO_NATIVE_EQUIV`) until the relay
  is ported. It is **not** justified yet: when the relay lands, this either gets a caller or gets
  deleted, and that choice has not been made.