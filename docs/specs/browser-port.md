# Browser automation: Playwright → pure Rust (Option A)

Status: **accepted by product**. Chromium + a Rust CDP client replaces Playwright.
Scope: `packages/desktop/src/main/browserView/**` (13,051 lines) and the agent-facing browser
commands that reach it.

## 1. Why this is not a port

Playwright is a JavaScript library. There is no way to keep it and satisfy the zero-app-side-JS rule,
so it is **replaced**, not translated. The two decisions below were explicit.

| Decision | Choice | Consequence accepted |
| --- | --- | --- |
| Engine | **ship Chromium** | Tauri keeps WebKit for the app shell; the browser tab runs a *second* engine, Chromium. Two engines, two cookie stores — accepted. |
| Client | `chromiumoxide` | Pure-Rust async CDP. No Playwright, no injected-Page-JS library. |

### The Playwright locator problem

Playwright's locator API (`page.locator("...").click()`) is not a CDP primitive. It is Playwright's
own resolver: it injects a script into the page, waits for the engine to resolve, and returns
handles. CDP exposes `DOM.querySelector`, `Runtime.evaluate`, `Input.dispatchMouseEvent` — a lower
level with **no** auto-waiting and no actionability checks.

Consequence: **the agent-facing browser tools change shape.** Any port that keeps a `locator` tool
with the same signature is lying about what it can do. The replacement toolset is specified in §4.

### Invariant interaction (read before "fixing" this later)

Invariant 1 bans **app-side** JavaScript fallback: a native implementation that silently degrades to
a TS implementation when it fails. Page-side evaluation (`Runtime.evaluate`) is *not* that. It is a
remote code execution primitive that CDP has no alternative to — there is no Rust-only way to ask a
browser "what is in this element". A page is not a ZCode surface and cannot fail over to a
TS implementation.

So the rule for this subsystem is narrower and stated once: **one implementation, in Rust, no second
reader, no TS twin.** Not "no JavaScript anywhere".

## 2. Ownership

```
┌─ Rust: zcode-browser ────────────────────────────────────────────────┐
│ chromiumoxide (CDP) · tab/session registry · screenshot (CDP)         │
│ webm recording · virtual clipboard · DOM snapshot → agent events      │
└───────────────▲───────────────────────────────────────────────────────┘
                │ CDP over pipe (no --remote-debugging-port)
                ▼
        Chromium (shipped binary, separate process)
```

The registry — which tab is live, which window owns it, what the agent may do — moves to Rust as the
single owner. `browserGuestManager.ts` (4,640 lines) is deleted, not wrapped.

## 3. Engine distribution — the open engineering decision

The browser engine must reach the user. Four options, none free:

| Option | Size | Auto-updates | Notes |
| --- | --- | --- | --- |
| **Download at first run** | small installer | yes | Needs a CDN endpoint that does not exist in this tree; offline users break. |
| **Bundle in installer** | +~150 MB per platform | with the app | Simplest; installer is no longer "small". |
| **Reuse system Chromium** | none | user-managed | Only finds Chrome/Edge/Chromium, not a guaranteed Chromium; version drift breaks CDP. |
| **`playwright install` equivalent** | +~130 MB | yes | Reuses a proven layout, but drags a JS tool into the Rust release path. |

**Recommendation: bundle per-platform, one Chromium version per release, pinned.** It is the only
option with no runtime dependency on an endpoint outside this repository — which is what killed
auto-update (§ cutover). Cost is installer size.

This also lands the CI matrix for free: `build.yml` already builds six targets natively, so each
target downloads its Chromium at the same pinned version.

## 4. Agent-facing tool surface (what replaces the Playwright commands)

Current commands, from `browserGuestManager.ts`: `playwright` (`locator`, `evaluate`),
`playwrightWaitForTimeout`, `playwright.downloadPath`, plus screenshot/clipboard/recording.

| Old | New (CDP) | Behaviour change the agent must learn |
| --- | --- | --- |
| `playwright.locator(sel).click()` | `browser.find(sel)` → handle; `browser.click(handle)` | resolves immediately, **does not auto-wait** |
| `playwright.evaluate(fn)` | `browser.evaluate(expr)` | expression string, not a serialised function |
| `playwright.domSnapshot` | unchanged | now served from Rust |
| screenshots / clipboard / webm | unchanged | now served from Rust |

`browser.find` returns a **handle** (`{nodeId, backendNodeId}`), not a live locator. The agent holds
the handle; the page invalidating it is an error, not a silent retry. This is the honest cost of
leaving Playwright's resolver, and it is what the model prompt must document.

## 5. Invariants this subsystem must not break

- **9 (renderer barrier)** — the browser commands keep going over the existing CHANNEL 1 WebSocket to
  `@zcode/server`. Rust serves them; `packages/ui` does not import `zcode-browser`.
- **8 (byte boundary)** — screenshots and DOM snapshots cross into TypeScript as bytes. Same
  `zcode-codec` path as today, plus the byte-boundary smoke.
- **1 (zero fallback)** — one Rust implementation. The Playwright TS path is deleted, not disabled.

## 6. Ladder

Each rung is independently shippable and leaves the Electron browser working until the last one.

1. ~~**`zcode-browser` crate** — Chromium launch over pipe, tab registry, `Runtime.evaluate` +
   `DOM.querySelector`, `Input.dispatch*`.~~ **Done** — `packages/rust/crates/zcode-browser`,
   38 tests, clippy clean. It is `rlib` only, so invariant 9 holds by construction.

   What rung 1 settled, all asserted in tests rather than described:

   - `LaunchMode::Pipe` is the default and the two modes are mutually exclusive. A launch that
     carries both flags makes Chromium honour the port, which silently deletes the pipe's
     security property.
   - `--user-data-dir` is required, not optional. Omitting it would put automation tabs in the
     user's own Chromium profile.
   - `TabRegistry` ids are never reused, so a late event naming a closed tab cannot reach the
     tab that took its slot. This replaces the four maps in `browserGuestManager.ts`.
   - `find` counts matches *before* resolving. `DOM.querySelector` returns the first of many and
     says nothing about the rest; that count is the one behaviour Playwright's resolver gave for
     free and a naive port would drop.
   - Selectors are JSON-encoded before entering an `evaluate` expression. The selector is
     agent-supplied, so raw interpolation would be injection into a page holding the session.
   - `click` sends mouseMoved → mousePressed → mouseReleased in order, and refuses non-finite
     coordinates, because NaN serialises to `null` and the browser drops the event — a click
     that reports success while doing nothing.

   `type_text` is a stub returning an error, deliberately not `todo!()`: a caller reaching it
   gets a boundary error, not a panic inside the host process.
2. **`find`/`click`/snapshot tools** over the existing command path, behind the existing Electron
   browser for comparison.
3. **Screenshot, clipboard, webm recorder, tab recovery** moved to Rust.
4. **Delete `browserView/**`** — 13,051 lines of Playwright TS.
5. **`packages/desktop` delete** (CUTOVER_SPEC §8.0.1) — now unblocked: the browser was its last
   unported subsystem.

## 7. Not decided here

Whether the shipped Chromium is branded or headless-shell, and its exact version pin, are release
decisions. They do not change the architecture.
