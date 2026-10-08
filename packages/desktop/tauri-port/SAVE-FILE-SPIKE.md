# SAVE-FILE-SPIKE: `saveFile` (SSRF-hardened) port plan on Tauri

Read-only spike. Grounds a faithful Rust port of Electron's host "save file" IPC, which has **two**
discriminated-union variants — one trivial, one a security-critical remote downloader. This doc decides
how (and whether) `saveFile` lands in the parallel Tauri shell and records the invariants that MUST be
preserved so a future slice does not ship a degraded-but-shipping implementation.

## Contract (source of truth)

- Request/result types: `packages/shared/src/platform.ts` — `SaveFileRequest` (the discriminated union:
  `{ data: ArrayBuffer; suggestedName }` | `{ sourceUrl: string; suggestedName }`) and
  `SaveFileResult { success; canceled?; path?; error? }`. The `saveFile?(payload)` method signature is
  at `platform.ts:518` (optional method — non-Desktop platforms omit it).
- Electron behaviour (the port target): `packages/desktop/src/main/desktopSaveFile.ts`
  (`registerDesktopSaveFileIpcHandler` :183-230), over `PlatformChannels.SaveFile`.

## Two variants, two difficulty tiers

**Variant A — in-memory bytes (`{data, suggestedName}`)** — `desktopSaveFile.ts:196-201, 216`:
validate non-empty + ≤ `MAX_SAVE_FILE_BYTES` (50 MiB, :12), open the native Save dialog
(`dialog.showSaveDialog({ defaultPath: suggestedName })` :204-207), then `writeFile(filePath, bytes)`.
- Tauri primitive ALREADY LANDED: the `show_save_dialog` command (slice 5, see `BRIDGE.md`) → the dialog
  seam exists. Remaining work is the byte write, which mirrors the slice-40 `createTempTextAttachment`
  write (`std::fs` / `OpenOptions`). This variant is **LOW effort / LOW risk**, fully unit-testable (a
  temp-dir write with an injected path, exactly like `write_temp_text_attachment`).

**Variant B — remote URL (`{sourceUrl, suggestedName}`)** — `desktopSaveFile.ts:52-181`: a hardened
SSRF-resisting downloader. **HIGH effort / HIGH risk.** This is where a partial port is unsafe.

### The security invariants that MUST be ported (Variant B)

1. **Scheme allow-list** — only `http:`/`https:` accepted; anything else rejected
   (`parseRemoteImageUrl` :52-60). Blocks `file:`/`gopher:`/etc.
2. **Public-address resolution + private/loopback/link-local/multicast blocklist** — the IPv4/IPv6
   `BlockList` at :16-44 rejects `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`,
   `fc00::/7`, `fe80::/10`, and TEST-NET/multicast ranges (`resolvePublicRemoteUrl` :62-82; explicit
   `*.localhost` reject :64-66). Prevents the renderer's CORS boundary being enlarged into main
   reaching internal services.
3. **DNS-rebinding TOCTOU closure** — the validated addresses are PINNED into the connection via a
   custom resolver so the socket cannot re-resolve to a different (private) IP after the check
   (`pinnedLookup` + `new Agent({ connect: { lookup: pinnedLookup } })` :91-105; the code comment at
   :103-104 states the exact rationale).
4. **Redirect re-validation** — `redirect: "manual"`, ≤ `MAX_REMOTE_REDIRECTS` (5), and EVERY hop's
   target re-resolved + re-blocklisted (:89, :117-130). A first-legit-then-internal redirect is rejected.
5. **Size cap enforced during read** — `receivedBytes` checked inside the stream loop, not after buffering,
   so a lying `Content-Length` cannot OOM main (:161-166); plus the header pre-check (:150-152).
6. **Timeout + cancel + temp-dir cleanup** — `AbortController` + `REMOTE_DOWNLOAD_TIMEOUT_MS` 30s (:13,
   :141), and the download lands in an `mkdtemp` scratch then `copyFile` to the final path with a `finally`
   that cancels/clears (:136-179) so a failed download never leaves a partial file at the user path.

## Tauri/Rust approach (recommended)

The `sourceUrl` write and the dialog are cheap; the crux is porting invariants 1-6 with a Rust HTTP stack
that exposes a **custom DNS resolver** (the non-negotiable one, #3).

- **Dialog**: reuse the landed `show_save_dialog` command. Pass `{ defaultPath: sanitized suggestedName }`.
- **Sanitize name**: port `basename(...).trim().slice(0,120)` (`desktopSaveFile.ts:190`) as a pure fn
  (`std::path::Path::new(..).file_name()` + char-count truncate). Unit-test the traversal strip.
- **Fetcher**: `reqwest` with a custom `resolve`/connector. Options considered:
  - `reqwest::ClientBuilder::resolve(domain, SocketAddrs)` pins a hostname → validated IPs, giving
    invariant #3 directly and cleanly. Preferred.
  - Fallback: a `hickory-dns`/`trust-dns`-resolver-backed custom `connect` resolver.
  - `tauri-plugin-http` (`fetch`) proxies through Rust but does **not** expose a per-request DNS pin →
    cannot satisfy #3 safely for arbitrary hosts. **Not sufficient.**
- **Blocklist**: `ip_network` crate (or `std::net::IpAddr` range checks) to mirror the `BlockList` sets.
  Encode the same ranges; unit-test each boundary.
- **Redirect policy**: `redirect::Policy::custom` running the resolve+blocklist check per hop (invariant 4).
- **Cap/timeout**: read as a stream with a running byte count (invariant 5) + `ClientBuilder::timeout`
  30s + drop the response body on abort (invariant 6); download to a `tempfile`, then `std::fs::rename`
  to the dialog path (rename fails across filesystems → fall back to a copy, matching `copyFile`).
- **Errors**: map to the same string codes (`remote_address_not_allowed`, `download_failed`,
  `file_too_large`, `invalid_file_payload`, `write_failed`) so the renderer's handling is unchanged.

## Fidelity / risk

- **#3 (DNS pin) is the whole ballgame**: pre-check-public-then-connect-private is the classic SSRF. If
  the chosen HTTP client cannot pin the resolved IP to the actual TCP connect, the port is INSECURE and
  Variant B must NOT ship.
- `reqwest` pulls a large dependency tree (hyper/tokio already present via tauri; `rustls`/`native-tls`
  adds a TLS backend) — a real bundle-size decision for the shell.
- Cross-OS `rename` semantics and the `mkdtemp` scratch location need parity with `copyFile`.
- Linux sandbox (AppImage/Flatpak) can restrict outbound + the chosen save path; measure under the CI
  packaging constraints (see `CI-PACKAGING.md`).

## Forbidden shortcut (explicit)

Do **NOT** add `saveFile` to the `tauriPlatform` `Pick` subset implementing only Variant A while
silently ignoring or `throw`-ing on `sourceUrl`. `createTempTextAttachment` was safe to port whole;
`saveFile` is a union whose B-variant is the security-sensitive path. Shipping the seam with B stubbed
would (a) violate the port no-stub rule, and (b) hand the UI a method that appears to work but cannot
save remote URLs — or worse, invites a naive "just fetch it" follow-up that drops invariants 1-6. If B
is not ported, the method stays unported (out of the `Pick`) exactly like every other unbacked method.

## Recommendation, effort, risk

- **Recommendation**: split delivery. **Ship Variant A alone as a command + a `saveFile` seam that
  returns `{ success:false, error:"remote_not_supported" }` for `sourceUrl` ONLY if the product accepts
  that gap as an explicit decision** — otherwise hold the whole method. Do NOT ship Variant A into the
  `Pick` as if `saveFile` were complete; wire it into the `Pick` only when B lands (the Pick means
  "fully backed"). Variant A can land first as a command + bridge wrapper (parity of the write path),
  with the union-level adapter wiring gated on B.
- **Effort**: Variant A **LOW** (reuses the slice-40 write pattern). Variant B **M-HIGH** (reqwest +
  custom resolver + blocklist + streaming cap, cross-OS tested).
- **Risk**: A **LOW**; B **HIGH** (SSRF correctness — treat as a security-sensitive component, fuzz the
  URL/redirect parser, and verify #3 with an actual rebinding test before it gates the cutover).
- **1-day PoC (B)**: (1) reqwest client with `resolve()` pinning the pre-checked public IP; assert a
  `localhost`/`169.254.169.254`/rebinding target is rejected; (2) stream a 60 MiB response and assert
  mid-read abort; (3) 3xx→private redirect rejected. Pass = all three fail closed.

## Files read

- `packages/desktop/src/main/desktopSaveFile.ts` (full)
- `packages/shared/src/platform.ts` (`SaveFileRequest`/`SaveFileResult`/`saveFile?` :518)
- `packages/desktop/src-tauri/src/commands.rs` (landed `show_save_dialog`; slice-40 write pattern)
- `packages/desktop/tauri-port/BRIDGE.md`, `PLATFORM-ADAPTER-PLAN.md`, `INVENTORY.md`, `CI-PACKAGING.md`

Sources (Rust capability grounding — verify versions at implementation time, marked ASSUMPTION here):
- `reqwest` `ClientBuilder::resolve` / `resolve_to_addrs` (per-host IP pinning for invariant #3).
- `reqwest` `redirect::Policy::custom` (per-hop re-validation, invariant #4).
- `ip_network` crate (private/link-local range checks mirroring the `BlockList`).
- `tempfile` crate (scratch download dir).
