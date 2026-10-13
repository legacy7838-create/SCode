# Native Boundary Specification: `zcode-db` N-API Return Shape

## Overview

`packages/desktop/zcode-db` is a `rusqlite` + `napi` cdylib that already owns ZCode's SQLite persistence
(sessions, tasks, journal, automations, off-peak, workflow, migrations). It is consumed from **two
processes through two near-duplicate TS facades**. The crate is correct; its **return shape is not** —
it hands JavaScript UTF-16 strings where it should hand bytes, forcing a transcode plus a re-parse on
every heavy read.

This spec governs the boundary shape only. It authorizes **additive** `Buffer`-returning variants for a
small set of heavy reads and an opt-in cached read connection. It does **not** authorize porting JS
logic into Rust, deleting any fallback, or changing the SQLite schema.

### Measured starting state (verified against the checkout)

| Property                                         | Value              | Evidence                                                                                                          |
| ------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Exported `#[napi]` functions                     | 177                | grep across `src/` (plus 2 `#[napi(object)]` structs: `TaskRow` `lib.rs:99`, `:163`)                              |
| Returning a String-family type                   | 119                | `napi::Result<String>` 64, `Result<String>` 49, `Result<String, Error>` 6                                         |
| Returning `Result<Option<String>>`               | 19                 | grep                                                                                                              |
| Already typed / primitive / void                 | 39                 | `Result<()>` 22, `Result<bool>` 8, `Result<i64>` 4, `Result<Vec<TaskRow>>` 2, others                              |
| Returning `Buffer` / `Uint8Array`                | **0**              | no `bindgen_prelude::Buffer` anywhere                                                                             |
| Async (`#[napi(async)]`, `Promise`, `AsyncTask`) | **0**              | `Cargo.toml:18` sets `napi` with `default-features = false, features = ["napi4"]`; no tokio                       |
| `serde_json::to_string` calls                    | 124                | grep `src/`                                                                                                       |
| Functions with a `_json` suffix                  | 171                | grep                                                                                                              |
| Connections opened per call                      | 1 fresh connection | `lib.rs:62 open_readonly`, `lib.rs:74 open_readwrite`; `open_readonly` used at ~65 sites, `open_readwrite` at ~54 |

The cost per heavy read is therefore: SQLite row → Rust `String` → **UTF-8→UTF-16 re-encode into a V8
string** → `JSON.parse` re-parsing UTF-16 into a fresh object graph. The first transcode is pure
boundary tax and is removable without touching any business logic.

---

## 1. Product rules

1.1. A read that returns a large payload must cross the N-API boundary as **bytes**, not as an
encoded-to-UTF-16 string. The bytes must be the _same_ UTF-8 JSON bytes produced today, so that
`JSON.parse(buf.toString("utf8"))` yields a result identical to the current string path.

1.2. Existing `*_json` functions are the **compatibility surface and stay untouched**. New byte-returning
variants are added alongside. No caller is forced to migrate in one change.

1.3. Byte variants are adopted by a caller only when payload size × call frequency justifies it.
Frequency is derived from call sites, not assumed: `taskIndexRepo.ts` (13 `JSON.parse`),
`automationRepo.ts` (12), `offPeakTaskRepo.ts` (3), plus the CLI `native-addon.ts` / `sqlite-session-store.ts` path.

1.4. The stateless per-call connection model is a **correctness property, not a defect**. It is what makes
concurrent access safe, because two processes load the same `zcode_db.node`
(Host via `packages/services/src/session/zcodeDb.ts`, CLI via
`apps/zcode-cli/packages/adapters/src/storage/session-store/native-addon.ts`). Any connection caching
must preserve identical WAL / busy-wait behaviour.

1.5. No new fallback branch may be introduced, and no existing load-bearing fallback may be removed
(root `AGENTS.md`: "新接口保留本地路径 fallback", "不不断增加兜底分支").

1.6. Every exported symbol keeps a doc comment; no `unwrap()` in library paths; `Result` propagated with
`?` (Part 1 Rust rules).

## 2. State ownership

- **SQLite file is the single source of truth.** The addon owns all reads and writes against it; no TS
  layer may keep a second accepted copy of persisted state.
- **`packages/services/src/session/zcodeDb.ts` is the consumer-side owner** of the addon interface.
  `packages/desktop/zcode-db/addon.ts` declares a parallel `DbAddon`; the two are drift risk. This spec
  records that collapsing them into a single re-export is a **follow-up**, not part of this change, and
  that any return-shape change must be applied to **both** facades in the same commit.
- The Host process owns the connection lifecycle. Renderer and CLI never open the DB directly.

## 3. Interface

### 3.0 The `Buffer` proposal was measured and rejected

The first version of this spec proposed returning `napi::Result<bindgen_prelude::Buffer>` holding the
same UTF-8 JSON bytes, to avoid napi's UTF-8→UTF-16 encode. **Measurement refuted it.** On the real
11.19MB transcript: `JSON.parse(string)` = 38.4 ms, `JSON.parse(Buffer)` = **40.3 ms** — the Buffer form
is _slower_, because Node coerces `Buffer`→string inside `JSON.parse`, so the same UTF-8→UTF-16 decode
still happens, just later, plus an extra 11MB copy. Ceiling of that optimization: **−2%**. It is not
implemented and must not be reintroduced as "the Rust fix".

The cost breakdown that mattered:

| Path (real 229-message session)           | Latency  | Payload      |
| ----------------------------------------- | -------- | ------------ |
| `messagesJson` + `JSON.parse`             | 117.7 ms | 11,186,241 B |
| — of which part bodies                    |          | 10,796,617 B |
| — of which message `info`                 |          | 177,504 B    |
| `messageWithPartsJson` (single row by PK) | 0.65 ms  | 1,437 B      |
| `messagesInfoJson` (all rows, no parts)   | 4.9 ms   | 205,026 B    |

So the fix is **projection**, not encoding: stop shipping 10.8MB of part bodies to callers that read
only `info`.

### 3.1 Implemented: `messages_info_json`

Additive — `messages_json` and all other 177 exports are untouched.

```rust
/// `messagesInfo`: the session's message infos WITHOUT parts, in exactly the same order as
/// `messages`. Callers needing part bodies must use `messages` / `message_with_parts`.
#[napi]
pub fn messages_info_json(db_path: String, session_id: String) -> Result<String>
```

Backed by `session_messages::messages_info`, which reuses `decode_message_info` and the identical
`order by sequence is null, sequence, time_created, rowid` clause, so ordering cannot diverge.

TS surface (`SessionStorePort`, required — deliberately **not** optional, because an optional method
would force every consumer into a fallback branch):

```ts
messageInfos(input: { sessionID: SessionId }): Promise<MessageInfo[]>;
```

Consumers converted (each reads only `info`; verified by grep over the whole function body):

| Site                                         | Was                            | Now                                                                                                  |
| -------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `v4-bridge.ts` `forkConversationBeforeInput` | `messages()` + positional scan | `messageInfos()` — keeps the scan, `indexOf` identity preserved within one array                     |
| `v4-bridge.ts` `resolveUserMessageIdForRow`  | `messages()` + filter          | `messageInfos()`, predicate gets `{ info }` (`parts` is optional in `ConversationProjectionMessage`) |
| `v4-bridge.ts` `forkStableConversation`      | `messages()` + `.find(id)`     | `messageWithParts()` single PK read                                                                  |
| `v4-bridge.ts` `resolveTurnUserPrompt`       | `messages()` + two `.find(id)` | two `messageWithParts()` PK reads                                                                    |

Known remaining full-transcript caller, intentionally **not** converted in this change:
`resolveStableForkTarget` → `stable-fork-target.ts` takes `readonly MessageWithParts[]` and touches
`message.info.*` in ~20 places across 189 lines. It never reads `parts`, so it _should_ move to
`MessageInfo[]`, but that is a mechanical rewrite in a package with **no test suite in this checkout**
(zero `.test.ts` files, no `test` script) — a missed `.info` there would be a silent `undefined`. It is
left as a follow-up to be done with a test, not rushed.

`list_task_metas_json` / `dwf_list_*_json` get no twin: measured at ≤24KB and ≤1ms, and `dwf_run` /
`dwf_event` hold **0 rows** locally, so no payload evidence justifies them.

## 4. Acceptance scenarios

All of these run in `packages/desktop/zcode-db/tests/addon_contract.mts` (the CLI package has no test
suite in this checkout, so the boundary contract lives with the crate that owns it).

- **A1 — single-row read equivalence.** For a seeded session, `messages(...).find(info.id === X)`
  deep-equals `messageWithParts(X)` for a present row and for an absent row (both `null`), and a row is
  never readable under a different `sessionID`. This is the precondition for the PK conversions in §3.1.
- **A2 — projection equivalence.** `messages_info_json(...)` has the same row count and order as
  `messages_json(...)`, each element deep-equals the corresponding `.info`, and no element carries a
  `parts` key.
- **A3 — export surface pinned by count and type.** The manifest pins each heavy/typed read's boundary
  type and the total export count (178 = 177 prior + `messages_info_json`). Verified sensitive: flipping
  a pin from `string` to `bytes` fails with `expected bytes at the boundary, got string`, and adding an
  export without updating the file fails the count.
- **A4 — concurrency preserved.** Two processes read and one writes the same DB file with
  `journal_mode=WAL` and `busy_timeout=5000` (`DB_BUSY_TIMEOUT_MS`, `lib.rs:56-58`) and no
  `SQLITE_BUSY` escapes as an error under the existing retry budget. Unaffected by this change because
  the per-call connection model was not touched; it is the gate for §6's cached connection.
- **A5 — measurement is real.** Payload bytes and ms are recorded before/after with the figures in §3.0;
  the win is reported only with numbers, per the pre-handoff rule.
- **A6 — no behavior change for a caller that does not opt in.** `messages_json` and the other 176
  exports are byte-for-byte unchanged, so any repo not switched to `messageInfos()` behaves exactly as
  before.

## 5. Retained fallbacks (explicitly NOT removed)

| Fallback                                    | Location                                                                                 | Why retained                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*_json` string returns                     | 171 fns                                                                                  | the migration path's compatibility surface; removing them breaks the CLI layer and remote deploy simultaneously                                                |
| per-call `open_readonly` / `open_readwrite` | `lib.rs:62,74`                                                                           | multi-process safety across Host + CLI (`native-addon.ts`) loading the same `.node`                                                                            |
| `node:sqlite` / TS repositories             | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/` (2,477 lines) | **live**, reachable from `adapters/src/storage/session-store.ts` and `bootstrap/src/zcode-protocol/server-operations.ts`; consolidation is a separate decision |
| win32 shell `find`/`grep` prelude           | `embedded-search-prelude.ts:179`                                                         | win32 ships no `bfs` (`native-search-tools-config.mjs:96-100`); out of scope here but recorded so nobody deletes it while touching native boundaries           |

## 6. Deferred, gated decisions

- **Cached `Mutex<Connection>` keyed by `db_path`**: **demoted by measurement.** Per-call open + PRAGMAs
  costs 0.34 ms (`tasksCount`) to 0.93 ms (`areSessionMigrationsApplied`), which is noise against the
  92 ms it would shadow, and the per-call model is what makes Host+CLI concurrent access safe. Only
  worth revisiting if a hot loop is proven to be dominated by connection opens.
- **`#[napi(async)]`**: still gated. Not needed for the wins above, and the remaining event-loop exposure
  is best closed by not loading 10.8MB at all rather than by loading it off-thread. Requires re-enabling
  napi's async runtime (`Cargo.toml:18` has `default-features = false`, no tokio) across 6 triples.
- **Collapsing the two `DbAddon` facades** into one re-export.
- **`resolveStableForkTarget` → `MessageInfo[]`** (see §3.1), with a test.

## 7. Governance note

Neither `packages/desktop/zcode-db` nor `packages/desktop/zcode-pty` falls inside any module root in
`architecture-policy.yaml` (`desktop` covers only `packages/desktop/src`), so `pnpm architecture:check`
**cannot** guard this boundary. This spec is the only control, which is why the return-shape rules are
written as testable scenarios in §4 rather than prose.

## 8. Rollback

Each step is one revertable commit. Twins are additive, so reverting a commit restores the pure
`*_json` path with no caller left stranded. Connection caching is behind an opt-in and reverts by
dropping the cache. No schema, protocol, or UI change is involved, so no migration rollback is needed.

## 9. Verification

`node scripts/check-workspace-freshness.mjs` → `pnpm architecture:check --changed` → `pnpm typecheck` →
`pnpm lint` → `pnpm fmt:check` → `pnpm test:tauri:rust` → `packages/desktop/zcode-db/tests/addon_contract.mts`
→ `harness/read_parity.mts`. Results must be reported truthfully, with existing failures distinguished
from newly introduced ones.
