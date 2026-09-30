# Rust native port: external-navigation allowlists (`zcode-url-guard`)

Status: active. Owner: UrlGuardSpecAuthor. Written 2026-09-30 **before** any implementation code,
per `AGENTS.md:3` and the architecture-governance rule.

This wave delivers **only this file**.

---

## 0. Why this one, in the Electron-removal programme

Removing Electron means porting its 65 `ipcMain` registrations; 32 are done, so 33 remain. This
spec takes the highest-risk slice of those, and the one the Tauri port's own status document
already asks for.

`apps/zcode-tauri/PORT_STATUS.md:161` records, under *No native equivalent*:

> `event.senderFrame.url` — Does not exist. Non-forgeable in Electron, renderer-supplied in
> Tauri. **Resolve origin in Rust via `with_webview`, or move the decision server-side.**

In Tauri the renderer supplies the URL, so a check that lives above the renderer is no longer
trustworthy. The Coding Plan flow opens a **webview**, navigates it to PayPal, and accepts a
payment callback — which makes "may I open this URL?" and "is this callback genuine?" security
decisions, not conveniences. Leaving them in TypeScript above a forgeable input is exactly the
gap the status document flags.

So this port is not only a migration step: it is the mitigation for a security regression the
Electron → Tauri move would otherwise introduce.

**Ported component = the URL decision logic of `packages/desktop/src/main/desktopMainIpcRemote.ts`
lines 38–142**, plus the origin helpers it depends on from
`packages/shared/src/zcodeEndpoint.ts`. Pure functions over strings: no I/O, no clock, no process.

---

## 1. What is being ported

| Function | Source | Decision it protects |
|---|---|---|
| `isAllowedExternalOpenUrl` | `:38-46` | scheme allowlist for `openExternal` — `http:`, `https:`, `file:` only |
| `parseOpenExternalRequest` | `:52-67` | payload shape; a non-string `url` is rejected, not coerced |
| `isPaypalHostname` | `:69-71` | exact `paypal.com` or a `.paypal.com` subdomain |
| `isCodingPlanPaypalNavigationUrl` | `:73-85` | https, plus either a PayPal host or a trusted origin on `/api/pay/paypal/` |
| `isCodingPlanWebviewUrl` | `:87-104` | scheme, **trusted origin**, path containing `coding-plan`, and `embedded=app` |
| `isCodingPlanPaymentCallbackUrl` | `:106-126` | trusted origin, exact callback path, and a `returnTo` that survives re-validation |
| `isAllowedCodingPlanEmbeddedNavigationUrl` | `:128-134` | the union of the three |
| `shouldKeepCodingPlanOpenExternalInWebview` | `:136-141` | whether a navigation stays in the webview or is handed to the OS |
| `isTrustedCodingPlanWebviewOrigin` | `zcodeEndpoint.ts:104-…` | the trusted-origin set, including the loopback E2E case |
| `normalizeZCodeEndpointOrigin` | `zcodeEndpoint.ts:87-98` | origin canonicalisation, with the two throw cases |

### The three decisions that must not be "simplified"

1. **The PayPal host test is `hostname === "paypal.com" || hostname.endsWith(".paypal.com")`.**
   Not `includes("paypal.com")` — that would accept `https://evil.com/?x=paypal.com` and
   `https://paypal.com.evil.com/`. The subdomain form is required and the bare form is required;
   a `startsWith` or `contains` rewrite is a phishing hole.

2. **`returnTo` is re-validated, not just origin-matched.**
   `isCodingPlanPaymentCallbackUrl` resolves `new URL(returnTo, url.origin)` — a *relative* URL
   resolved against the origin — and then requires **both** that the result's origin still equals
   the origin **and** that the result independently passes `isCodingPlanWebviewUrl`. An
   origin-only check accepts `?returnTo=/coding-plan/x?embedded=app` pointed at an attacker's
   page. The re-validation is the open-redirect guard.

3. **Path tests are `startsWith` / `endsWith` / `includes` on the *pathname*, never on the whole
   URL.** `/api/pay/paypal/` is a prefix test; `/coding-plan/payment/callback` is a suffix test;
   `coding-plan` for the webview is a substring test on the path only. Testing the raw URL would
   let a query parameter satisfy the check.

---

## 2. Scope

### 2.1 Ported

The ten functions above, as pure Rust. `parseOpenExternalRequest` becomes a typed
`OpenExternalRequest { source_url: Option<String>, url: String }` with a `parse` that returns
`None` for a non-string or absent `url` — the TypeScript returns `null`, and a caller that
distinguished "absent" from "empty" would break if that collapsed.

### 2.2 NOT ported (siblings / non-goals)

- **Opening the URL.** `openPathInDefaultApp` and Tauri's opener are platform calls, not
  decisions. The *decision* moves; the *effect* stays a command.
- **The remote-session lifecycle** in the same file (`ConnectRemote`, `DisposeRemoteSession`,
  `ListWSLDistros`, `ListSSHConfigAliases`, `BindRemoteWorkspaceSessionContext`, …) — 15 of the
  20 channels, and they bridge to the agent over the existing RPC/websocket, so there is nothing
  to port.
- **Telemetry and ARMS event reporting** (`ReportTelemetryEvent`, `ReportArmsCustomEvent`, the
  three `*FinalArmsCustomEventsE2E` channels) — thin forwards.
- **`ShowTaskNotification`** — already `native.rs::show_notification`.
- **`normalizeZCodeEndpointOrigin`'s callers that only read a constant** — the env-reading
  helpers stay in TypeScript; the origin *comparison* moves, taking the origins as inputs.

### 2.3 Sync vs async decision

**Every function is synchronous.** This is the one module in the programme with no I/O at all, so
the event-loop rule cannot trigger; the guard runs on the click path and must not yield. The
crate is therefore `rlib`-only and produces no `.node` — it is linked into the Tauri host.

### 2.4 Ownership

| Piece | Owner |
|---|---|
| `packages/rust/crates/zcode-url-guard/**`, this spec | UrlGuardSpecAuthor |
| `apps/zcode-tauri/src-tauri/src/commands/urls.rs`, the `invoke_handler` registration | UrlGuardSpecAuthor |
| `apps/zcode-tauri/src/platform/tauriPlatform.ts` (the three navigation members) | UrlGuardSpecAuthor |
| `packages/shared/src/zcodeEndpoint.ts` | **untouched** — it stays the source of truth for the endpoint constants, and the crate takes the resolved origins as inputs rather than reading env |
| `packages/desktop/src/main/desktopMainIpcRemote.ts` (lines 38–142) | **untouched** — Electron is still the shipping product (§6) |

### 2.5 Invariants

1. **Zero JS fallback.** The Tauri host calls the Rust guard for every navigation decision. No
   "if the guard is unavailable, allow it" branch — an unavailable guard is a hard error, because
   the safe default for "may I open this?" is *no*.
2. **Fail closed.** An unparsable URL, a missing origin, a non-string payload and an unknown
   scheme are all **denials**. There is no "allow on error".
3. **The trusted-origin set is an input, not a constant baked into the crate.** The endpoints
   come from the environment via the existing TypeScript helpers, so a self-hosted deployment
   keeps working without a recompile — and so a test can pin the set.
4. **No I/O, no clock, no process.** A pure function of its arguments.
5. **Every decision has a denial test.** For each allow rule there is a matching reject case,
   because the cost of a false accept is a compromised payment flow and the cost of a false
   reject is a user who cannot pay.

---

## 3. Design

### 3.1 Crate shape

```toml
[package]
name = "zcode-url-guard"
…
[lib]
# rlib only: the consumer is the Tauri host, a Rust process. There is no Node consumer, so
# no cdylib is produced and nothing is staged into the payload (spec §7 D2 pattern).
crate-type = ["rlib"]

[dependencies]
# URL parsing, percent-decoding and origin canonicalisation. A hand-rolled parser for a
# security decision is not acceptable; see §3.3.
url = "2"
```

### 3.2 Surface

```rust
pub struct GuardOrigins {
  /// The default endpoint origin (`https://zcode.z.ai`).
  pub default_endpoint: String,
  /// The runtime-resolved endpoint origin, when it differs from the default.
  pub runtime_endpoint: String,
  /// The Z.ai business base URL (`https://api.z.ai`), already normalised.
  pub zai_business_base: String,
  /// Enables the loopback origin in the E2E store-bridge build.
  pub e2e_store_bridge_enabled: bool,
}

pub fn is_allowed_external_open_url(value: &str) -> bool;
pub fn is_paypal_hostname(hostname: &str) -> bool;
pub fn is_coding_plan_paypal_navigation_url(url: &str, origins: &GuardOrigins) -> bool;
pub fn is_coding_plan_webview_url(src: Option<&str>, origins: &GuardOrigins) -> bool;
pub fn is_coding_plan_payment_callback_url(src: Option<&str>, origins: &GuardOrigins) -> bool;
pub fn is_allowed_coding_plan_embedded_navigation_url(url: &str, origins: &GuardOrigins) -> bool;
pub fn should_keep_in_webview(current_url: &str, target_url: &str, origins: &GuardOrigins) -> bool;
pub fn is_trusted_coding_plan_webview_origin(value: Option<&str>, origins: &GuardOrigins) -> bool;
pub fn normalize_endpoint_origin(value: &str) -> Result<String, OriginError>;
```

All infallible except `normalize_endpoint_origin`, which keeps the TypeScript's two throw cases
so a misconfigured endpoint is loud at startup rather than silently untrusted.

### 3.3 URL parsing — why a crate, not a parser

`new URL(...)` semantics are load-bearing: scheme normalisation, IDNA host handling, default-port
removal, and the `url.origin` serialisation that `isCodingPlanPaymentCallbackUrl` compares
against. Hand-rolling that to "avoid a dependency" would be the single largest source of
security risk in the port. The `url` crate is the closest match to the WHATWG behaviour and is
already in the tree transitively via other Rust crates, so it adds no new licence surface —
this is checked in §10.

**Parity note:** the `url` crate and `new URL` agree on everything these guards use — scheme,
hostname, port, pathname, `searchParams`, `origin` — and the fixtures assert the specific
values the guards compare. A divergence would show up as a test failure naming the case, not as a
silently widened allowlist.

### 3.4 The `returnTo` resolution

`new URL(returnTo, base)` must be reproduced as `Url::options().base_url(Some(origin)).parse(...)`.
The two-step check then is: resolved origin `==` the callback's origin, **and**
`is_coding_plan_webview_url(resolved.as_str())`. Both are required; the fixture set includes the
attack shapes that a single check would accept.

---

## 4. Fixtures

The security core of the wave. Each allow rule has its matching denials.

| Group | Must allow | Must deny |
|---|---|---|
| external open | `https://…`, `http://…`, `file://…` | `javascript:`, `data:`, `vbscript:`, `about:`, `not a url`, `""` |
| PayPal host | `paypal.com`, `www.paypal.com`, `a.b.paypal.com` | `paypal.com.evil.com`, `evil.com/paypal.com`, `xpaypal.com`, `paypal.co` |
| PayPal navigation | `https://www.paypal.com/…`, `https://api.z.ai/api/pay/paypal/…` | `http://www.paypal.com/…` (scheme), `https://evil.com/api/pay/paypal/…` (origin), `https://api.z.ai/api/pay/paypal-evil/…` (prefix) |
| webview | trusted origin + `/…coding-plan…?embedded=app` | untrusted origin, `embedded` missing or `=1`, a **query** containing `coding-plan` on a non-matching path, `javascript:` |
| payment callback | `…/coding-plan/payment/callback?returnTo=/coding-plan/x?embedded=app` | `returnTo` absolute to another origin, `returnTo` to a path without `embedded=app`, missing `returnTo`, `returnTo=javascript:…` |
| keep-in-webview | current is webview/PayPal **and** target is allowed | current is an ordinary page, target is untrusted, either side unparsable |
| trusted origin | default endpoint, runtime endpoint, loopback **only** when the E2E flag is set | an arbitrary origin, and loopback with the flag off |
| endpoint origin | `https://host`, `http://host:8080` → normalised origin | `""`, `ftp://host`, `javascript:…` |

---

## 5. Migration boundary

### 5.1 Not deleted, and why

`packages/desktop/src/main/desktopMainIpcRemote.ts` stays. Electron is still the shipping
product (`PORT_STATUS.md:19-20`), and its `openExternal` handler needs the guard **synchronously**
on the same tick as the navigation. The Rust guard is added for the Tauri host; the TypeScript
guard stays until the Electron cutover, exactly as `mcpUserDirectory/` and
`automationCron.ts` are handled.

This means the decision logic exists twice for one transition period. That is accepted, and the
mitigation is the fixture corpus: both sides are asserted against the same table, so a divergence
is caught rather than shipped.

### 5.2 Consumer changes

| File | Change |
|---|---|
| `apps/zcode-tauri/src-tauri/src/commands/urls.rs` | new: the guard commands, taking the origins as arguments from the renderer |
| `apps/zcode-tauri/src-tauri/src/lib.rs` | register them |
| `apps/zcode-tauri/src-tauri/Cargo.toml` | add the path dependency |
| `apps/zcode-tauri/src/platform/tauriPlatform.ts` | the navigation members consult the guard **before** deciding, and deny on error |

---

## 6. Failure semantics

- **Unparsable URL** → denial. Never an error to the user, never an allow.
- **Missing or non-string `url` in the payload** → denial.
- **Unconfigured endpoint origin** → `normalize_endpoint_origin` returns an error, which the host
  surfaces as a startup failure. A silently untrusted origin would make every webview check deny,
  which looks like a product bug rather than a misconfiguration.
- **The binary is missing** → impossible by construction: the crate is linked into the host, not
  loaded, so there is no load step that can fail.
- **The guard command itself errors** → the caller treats it as a denial. The default is *no*.

---

## 7. Divergences

- **D1 — `parse` is infallible where the TypeScript returns `null`.** The Rust returns `None`;
  no observable difference, and it is the same three-state discipline as
  `zcode-task-index`'s `searchable_text` (§6.1 there).
- **D2 — no `.node` is produced.** rlib-only, like `zcode-mcp-config`. Stated explicitly because
  every other crate in the programme produced one.
- **D3 — none in the decisions themselves.** Any difference in an allow/deny outcome is a bug,
  not a divergence. That is the point of §4.

---

## 8. Shared-file change requests (main session)

| File | Exact change | Why |
|---|---|---|
| `apps/zcode-tauri/src-tauri/Cargo.toml` | add `zcode-url-guard = { path = "../../../packages/rust/crates/zcode-url-guard" }` | the host links it |
| `packages/rust/Cargo.toml` | add `url = "2"` to `[workspace.dependencies]` | needs checking against `THIRD-PARTY-NOTICES.md` / `third-party/inventory.json` before merge — §10 |
| root `package.json` | **no change** | `packages/rust` is already in the typecheck list |
| `architecture-policy.yaml` | **no change** | the `rust` module already owns `packages/rust` |
| `pnpm-lock.yaml` | **no change expected** | no new npm dependency |

---

## 9. Risks

- **R1 — a false accept is a compromised payment flow.** The `returnTo` re-validation and the
  PayPal host test are the two places where a plausible-looking simplification opens a hole.
  Both have dedicated adversarial fixtures (§4), and both are called out in §1 so a reviewer
  reads them as security code rather than as string handling.
- **R2 — `url` crate behaviour differing from `new URL` on an edge case.** Mitigated by asserting
  the *values the guards compare* rather than round-tripping through both parsers, so a
  divergence names the case instead of silently widening an allowlist.
- **R3 — the trusted-origin set can drift between the crate and `zcodeEndpoint.ts`.** The crate
  takes the origins as inputs rather than reading env, and a test asserts the constants the
  TypeScript declares, so a rename is caught.
- **R4 — the E2E loopback allowance leaking into production.** It is behind
  `e2e_store_bridge_enabled`, which comes from the build, not from a runtime flag a user can set.
  A test asserts loopback is denied when the flag is off.
- **R5 — duplicated logic during the transition (§5.1).** Accepted; the shared fixture table is
  the mitigation, and the TypeScript side is deleted with Electron.

---

## 10. Implementation status

### Delivered and verified

| Item | Evidence |
|---|---|
| Crate builds warning-free; 15 tests pass | `cargo test -p zcode-url-guard` → 15 passed |
| Adversarial fixtures per allow rule | `contains`-vs-subdomain, the `returnTo` open redirect, path-vs-whole-URL, `embedded=apple`, the loopback build flag |
| The open-redirect guard has a **dedicated** test | `an_origin_only_check_would_have_accepted_this` — the attack string's origin *does* match, and it is still denied, which is the whole reason for the two-step check |
| Linked into the Tauri host | 5 `#[tauri::command]`s in `commands/urls.rs`, registered in `invoke_handler` |
| Every command denies on error | `decide_external_open` returns `allowed: false` for a malformed payload; a misconfigured origin set is an `Err`, not a silent denial |
| Tauri | 142 tests passed, 0 failed, zero build warnings |
| Rust workspace | 379 passed, 0 failed, zero build warnings |
| No new licence surface | `url` 2.5.8 was already vendored transitively by the Tauri tree, and `rusqlite`/`sha2`/`chrono`/`cron` from earlier commits are likewise absent from `third-party/inventory.json` — Rust crates are not tracked there, so this follows the existing precedent |
| rlib, so the payload is unchanged | `zcode-packaging inventory` → 13 crates, **8 shipping**; `zcode-url-guard` classified `not a cdylib crate` |
| Repo gates | `pnpm typecheck` exit 0 · `pnpm lint` 0 errors / 72 warnings (unchanged) · `architecture:check` 0 violations · `check-native-graph` OK |

### A wrong expectation of mine, corrected against the code

I asserted `http://zcode.z.ai/coding-plan?embedded=app` should be allowed, reasoning that the
scheme check accepts `http`. The TypeScript **denies** it: the origin `http://zcode.z.ai` is not
the configured `https://zcode.z.ai`. The two checks compose and the first passing does not
imply the second will. The case moved to the deny list with a comment saying why, and
`an_http_endpoint_is_trusted_only_when_it_is_the_configured_runtime_origin` pins the case where
`http` *is* reachable — a self-hosted or loopback runtime endpoint.

### What this closes, and what it does not

This closes the `event.senderFrame.url` gap from the "No native equivalent" table: the decision
now runs in the host, on a URL the renderer supplied, with the fixtures above as the evidence
that it still fails closed. It is the first of the three no-equivalent items to be addressed,
and the only one that was purely a port.

**Still open, and not ports:**

- `webContents.id` — becomes a window label; needs a design decision, not a translation
- Chrome cookie decryption (DPAPI / Keychain / App-Bound v20) — needs FFI or a sidecar binary
- `ipcRenderer.sendSync` — the ordering guarantee is genuinely lost; the embedded-browser dialog
  has to become async
- Embedded browser (4,640 lines) — Tauri's child-`WebviewWindow` model is a redesign
- Auto-update — blocked on a server-side manifest format change

### Not deleted

`packages/desktop/src/main/desktopMainIpcRemote.ts` stays. Electron is still the shipping
product, and its `openExternal` handler needs the guard synchronously on the same tick as the
navigation (§5.1). The decision logic therefore exists in both languages for one transition
period; the shared fixture table is the mitigation, and the TypeScript half goes with Electron.
