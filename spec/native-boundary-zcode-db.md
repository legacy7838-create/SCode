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

Additive only. For each heavy read a byte-returning twin is added, named `<base>_bytes`:

```rust
/// UTF-8 JSON bytes for the full transcript of `session_id`.
/// Same bytes as `messages_json`; returned as `Buffer` so napi does not re-encode
/// UTF-8 into a V8 UTF-16 string that JS must then re-parse.
#[napi]
pub fn messages_bytes(db_path: String, session_id: String) -> Result<Buffer>
```

Return type is `napi::Result<bindgen_prelude::Buffer>`; `serde_json::to_vec` replaces
`serde_json::to_string` inside the twin only.

Targets for twins, ordered by payload size:

| Existing fn                   | Location                      | Payload                    |
| ----------------------------- | ----------------------------- | -------------------------- |
| `messages_json`               | `lib.rs:1914`                 | whole transcript + parts   |
| `list_task_metas_json`        | `lib.rs:743`                  | task index for a workspace |
| `dwf_list_events_json`        | `session_journal_read.rs:680` | workflow run events        |
| `dwf_list_runs_json`          | `session_journal_read.rs:714` | workflow runs              |
| `dwf_list_artifact_rows_json` | `session_journal_read.rs:773` | artifact rows              |

The TS facade type for a twin is the same as its `*_json` twin, but accepting `Buffer | string` so a
caller can pass either during migration:

```ts
messagesBytes(dbPath: string, sessionId: string): Buffer | string;
```

## 4. Acceptance scenarios

- **A1 — byte-identical payload.** For a seeded DB, `JSON.parse(messages_bytes(...))` deep-equals
  `JSON.parse(messages_json(...))`. Runs in `tests/addon_contract.mts`.
- **A2 — no UTF-16 round trip.** `messages_bytes` must not appear in the String-family count; a
  returned `Buffer` is a `Uint8Array` in JS (`instanceof Uint8Array`).
- **A3 — existing surface frozen.** All 177 prior exports keep their exact names and return types.
  `addon_contract.mts` pins this; reverting the twins cannot break a caller.
- **A4 — concurrency preserved.** Two processes read and one writes the same DB file with
  `journal_mode=WAL` and `busy_timeout=5000` (`DB_BUSY_TIMEOUT_MS`, `lib.rs:56-58`) and no
  `SQLITE_BUSY` escapes as an error under the existing retry budget.
- **A5 — measurement is real.** `harness/read_parity.mts` records bytes and milliseconds per heavy call
  before and after; the win is reported only with numbers, per the pre-handoff rule.
- **A6 — no behavior change for a caller that does not opt in.** Any repo not switched to a twin is
  byte-for-byte unaffected.

## 5. Retained fallbacks (explicitly NOT removed)

| Fallback                                    | Location                                                                                 | Why retained                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*_json` string returns                     | 171 fns                                                                                  | the migration path's compatibility surface; removing them breaks the CLI layer and remote deploy simultaneously                                                |
| per-call `open_readonly` / `open_readwrite` | `lib.rs:62,74`                                                                           | multi-process safety across Host + CLI (`native-addon.ts`) loading the same `.node`                                                                            |
| `node:sqlite` / TS repositories             | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/` (2,477 lines) | **live**, reachable from `adapters/src/storage/session-store.ts` and `bootstrap/src/zcode-protocol/server-operations.ts`; consolidation is a separate decision |
| win32 shell `find`/`grep` prelude           | `embedded-search-prelude.ts:179`                                                         | win32 ships no `bfs` (`native-search-tools-config.mjs:96-100`); out of scope here but recorded so nobody deletes it while touching native boundaries           |

## 6. Deferred, gated decisions

- **`#[napi(async)]`**: currently impossible without re-enabling napi's async runtime (tokio) in
  `Cargo.toml:18`, a dependency change across all 6 build triples. Only taken if the land-and-measure
  gate leaves demonstrable event-loop blocking.
- **Cached `Mutex<Connection>` keyed by `db_path`**: additive, read-heavy paths only, `open_readonly`
  kept as fallback. Must not change WAL or busy-timeout semantics.
- **Collapsing the two `DbAddon` facades** into one re-export.

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
