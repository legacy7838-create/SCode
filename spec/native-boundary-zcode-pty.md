# Native Boundary Specification: `zcode-pty` Terminal Byte Path

## Overview

`packages/desktop/zcode-pty` is a `portable-pty` + `napi` cdylib that replaced `node-pty` outright; CI
hard-guards "0 node-pty fallback" (`.github/workflows/platform-build-and-test.yml:165`) and the crate
builds for 6 triples including win32-x64. Spawning, shell/cwd/env resolution and exit supervision are
correct. **The data path is not**: the callback is typed as a Rust `String`, so each PTY chunk is
transcoded three times and copied twice before it reaches xterm.

This spec governs the payload type and backpressure of that single stream. It does **not** authorize
relocating PTY ownership, and §5 records why that would be wrong.

### Measured starting state

Per chunk, from the PTY master to the terminal emulator:

| #   | Step                                      | Location                                                            | Kind                         |
| --- | ----------------------------------------- | ------------------------------------------------------------------- | ---------------------------- |
| 1   | `pending.extend_from_slice(&buf[..n])`    | `src/pty.rs:136`                                                    | copy                         |
| 2   | `drain_decodable` → `valid.to_string()`   | `src/pty.rs:152-189` (`:156`, `:168`, `:178`, `:182`)               | UTF-8 validate + copy        |
| 3   | `ThreadsafeFunction<String>` → V8         | `src/lib.rs:68`, `pty.rs:15` `type DataFn`                          | **UTF-8 → UTF-16 transcode** |
| 4   | `Emitter<string>` / `Event<string>`       | `packages/services/src/terminal/terminalService.ts:147`, `:198-200` | none                         |
| 5   | `VSBuffer.fromString` → `TextEncoder`     | `packages/rpc/src/serialization.ts:155-159`, `buffer.ts:30-33`      | **UTF-16 → UTF-8 transcode** |
| 6   | `VSBuffer.concat` into the outbound frame | `serialization.ts:51`, `buffer.ts:36-45`                            | copy                         |
| 7   | deserialize `TextDecoder`                 | `serialization.ts:200-202`, `buffer.ts:48-50`                       | **UTF-8 → UTF-16 transcode** |
| 8   | `term.write(string)` decodes again        | `packages/ui/src/terminal/TerminalSession.tsx:588`, `:923`          | **4th transcode**            |

Reads are `[0u8; 8192]` (`pty.rs:130`) with one `tsfn.call(..., NonBlocking)` per decodable prefix
(two on the invalid-byte branch, `pty.rs:178`+`:181`). `pending: Vec<u8>` is **uncapped** and
`NonBlocking` never throttles, so there is **no backpressure anywhere on this path**.

---

## 1. Product rules

1.1. PTY output crosses the native boundary as **raw bytes** (`Buffer` / `Uint8Array`). Steps 3, 5, 7 and
the second half of 8 are eliminated; step 1's extra copy is removed.

1.2. The transport format does **not** change. The RPC layer already defines `DataType.Buffer = 2` and
`DataType.VSBuffer = 3` (`serialization.ts:111-113`), serializes `Uint8Array` through them (`:160-168`)
and deserializes back to raw bytes (`:201-202`). Byte-exactness of those tags is **already proven** by
`packages/desktop/tauri-port/test/layer-a/a2-framing.test.ts:35-79`. No new framing may be invented and
no `packages/shared/src/zcode-protocol/index.ts` wire format change is needed — only the _payload type_
of the terminal event moves from `string` to `Uint8Array`, and its runtime validation must be updated to
match.

1.3. Partial-codepoint handling moves to the consumer that already implements it — xterm's own incremental
decoder, which `term.write(Uint8Array)` drives. `drain_decodable` is deleted, not reimplemented.

1.4. **Lossy parity is a product rule, not an accident.** `drain_decodable` does two distinct jobs:
buffering an incomplete trailing sequence (`pty.rs:160-171`, documented at `:122-124` as "CJK/emoji split
across reads is never corrupted") **and** substituting a single U+FFFD for genuinely invalid byte
sequences while continuing to scan (`:174-186`). Any replacement must preserve _both_ behaviours, and
must be verified against the existing cases in `pty.rs:210-241`.

1.5. The stream must be bounded. `NonBlocking` + uncapped `pending` is replaced by a bounded queue with a
**documented drop-oldest policy** (§4 A6). Backpressure must not be "fixed" with a timeout — root
`AGENTS.md` forbids masking a sync problem with a timeout.

1.6. Terminal output must remain ordered and gap-free on the desktop `continuous` link and
replay-restorable on the mobile `replayable` link; the two semantics must stay distinguishable
(`zcode-docs/07-server-remote-integration.md:61-73`).

## 2. State ownership

- **The Host process owns the PTY.** The renderer attaches over loopback WebSocket
  (`packages/desktop/src/renderer/src/tauriHostConnection.ts:49-50`, `:64-70`; wired at
  `src/renderer/src/main.tsx:373-375`) and the addon is loaded inside the Host via `createRequire`
  (`terminalService.ts:46-63`, overridable through `ZCODE_PTY_NATIVE` at `:47`).
- **xterm owns the terminal screen buffer and the decode state.** The Rust side owns only bytes and the
  bounded queue. No third copy of terminal content may be retained.
- Scrollback retention is a JS-side policy (`TerminalSession.tsx:586`, `sidePaneTerminalSessionRegistry.ts`)
  and is explicitly out of scope here.

## 3. Interface

```rust
/// Raw bytes from the PTY master. Decoding and incomplete-codepoint handling belong to the
/// consumer (xterm's incremental decoder), so no UTF-8 → UTF-16 transcode happens here.
type DataFn = ThreadsafeFunction<Buffer, ErrorStrategy::Fatal>;
```

```ts
// packages/services/src/terminal/terminalService.ts
private readonly dataEmitter = new Emitter<Uint8Array>();
get onDynamicData(): Event<Uint8Array>;
```

`TerminalSession.tsx:588`/`:923` then call `term.write(bytes)` directly, **except** where a string is
still required: `normalizePowerShellReadlineRedraw(data: string)`
(`packages/ui/src/terminal/terminalDataTransform.ts:31`) is a load-bearing consumer of decoded text and
would otherwise break **silently** (see §5). A single `TextDecoder({ stream: true })` is held at the
service boundary and feeds that transform; it is the one remaining intentional decode.

## 4. Acceptance scenarios

- **A1 — round trip.** A PTY chunk containing ASCII, 2-, 3- and 4-byte codepoints plus a deliberately
  truncated trailing codepoint arrives at xterm byte-identical after reassembly, across two reads.
- **A2 — invalid bytes.** A genuinely invalid byte sequence yields exactly one U+FFFD and scanning
  continues, matching today's `Some(bad_len)` arm.
- **A3 — transcode count.** The measured path drops from 3 transcodes + 2 copies to 0 transcodes + 1
  copy for the raw stream; PowerShell-redraw path keeps exactly 1 decode.
- **A4 — burst.** `cat` of a large file and a `yes`-style unbounded producer stay responsive; input echo
  latency does not grow without bound; the drop policy engages and is observable in logs rather than
  silently corrupting the screen.
- **A5 — protocol.** `a2-framing.test.ts` extended to carry the terminal payload through the
  `DataType.Buffer` tag, plus a remote-attachment case; byte-exact.
- **A6 — backpressure.** With a bounded queue and a fast producer, the documented policy (drop oldest,
  count reported) is asserted rather than inferred.
- **A7 — no regression in `desktop-continuous` vs `web-remote-replayable`.** Both link semantics are
  exercised when the stream, snapshot, queue or reconnect logic is touched.

## 5. Retained boundaries and fallbacks (explicitly NOT removed)

| Item                                                | Location                                                              | Why retained                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTY lives in the **Host**, not the Tauri shell      | `terminalService.ts:46-63`                                            | Remote/SSH terminals stage the _same_ `zcode_pty.node` on the **target** host (`packages/server/build-remote.ts:13-14`, proven `packages/zcode-server-cli/scripts/verify-remote-ssh.mjs:269-273`); `ITerminalService` is registered against the remote connection (`remoteWorkspaceServiceCollection.ts:310`, `packages/server/src/http.ts:441`, `legacyRemoteWorkspaceRpcContract.ts:12`). Relocation would break remote terminals |
| `node-pty` stays absent                             | `packages/desktop/package.json`                                       | CI guard "0 node-pty fallback" (`platform-build-and-test.yml:165`); must never be reintroduced as a convenience fallback                                                                                                                                                                                                                                                                                                            |
| PowerShell redraw normalization                     | `terminalDataTransform.ts:31`                                         | shell-specific display fix; a byte path without a decoder would silently drop it                                                                                                                                                                                                                                                                                                                                                    |
| CJK IME composed-input fallback                     | `packages/ui/src/terminal/terminalComposedInputFallback.ts:58,78,173` | correctness for Sogou-style input, unrelated to transport                                                                                                                                                                                                                                                                                                                                                                           |
| `pending` tail buffer, if a Rust-side split is kept | `pty.rs:131`                                                          | only deletable once A1 proves the consumer decoder handles split codepoints identically                                                                                                                                                                                                                                                                                                                                             |

## 6. Rollback

Payload type is the only externally visible change and it is confined to one callback signature, one
emitter, and one event type. Reverting the commit restores `ThreadsafeFunction<String>` +
`Emitter<string>` with no schema, migration, or protocol-format change. The bounded-queue policy is
behind the same commit and reverts with it.

## 7. Verification and remaining platform risk

`pnpm typecheck` → `pnpm lint` → `pnpm fmt:check` → `pnpm test:tauri:rust` → `pnpm test:tauri:layer-a`
(incl. extended `a2-framing`) → `pnpm test:tauri:layer-b`, then driving the real app: `pnpm dev:tauri`,
an interactive shell, large-file `cat` for burst, CJK and emoji output split across reads, and a
PowerShell-style redraw case.

**Remaining risk, to be reported as unverified rather than as passing:** codepoint-substitution parity on
**win32-x64** (portable-pty's ConPTY may split sequences differently than `forkpty`), and the remote/SSH
terminal path, which cannot be exercised from this machine. Per `apps/zcode-cli/AGENTS.md`, behavior not
verifiable on the current system must be stated as residual risk, and cross-platform changes need tests
covering the differences.
