# DB → Rust Port — Plan (rusqlite, no JS fallback)

## Goal

Move the ZCode SQLite data layer (`packages/services/src/session/**`, ~5,500 LOC TypeScript,
`node:sqlite`) into Rust (`rusqlite`), with **no JavaScript in the DB path**. Owner directive:
single-language data layer for architectural reasons (NOT performance — SQLite is already native C;
the padding/`#[repr(C)]` concern does not apply to an on-disk SQLite DB).

## Reality / scope (measured)

- Public surface to port: `TaskIndexRepo` (~30+ methods: queryTaskList, grouped views, ordering,
  search snippets, syncTaskMeta, archive/delete, …), `AutomationRepo`, `OffPeakTaskRepo`, plus
  `tasksDatabase/{schema-v1, migrations, prepared, provider-selection-v2, official-glm-selection-v3, startup}`.
- 20 files consume these repos. The TS callers stay; the repos become thin facades over a native
  boundary. This is a multi-week, method-by-method port — not a single change.

## Boundary design (decision needed before slice 2)

The data layer lives in the **Node Host** process. Two options to expose Rust to it:

- **A. N-API addon** (`napi-rs`): a `zcode-db.node` the TS repos `require`. Synchronous/async calls,
  lowest overhead, keeps the Host in-process. Recommended.
- **B. Tauri IPC / separate Rust service**: heavier round-trips; only worth it if the DB must leave
  the Node process (it doesn't).
  Either way the TS repos keep their method signatures (behavior-preserving) and delegate to Rust.

## Behavior-parity requirements (must not regress)

- Same DB file + schema (`tasks-index.sqlite`); open with identical PRAGMAs (`foreign_keys=ON`,
  `busy_timeout`, WAL). READ_ONLY until the write path + locking parity is proven.
- Migrations: `tasks_schema_migration` versioning + the exact migration steps in `migrations.ts`
  must port 1:1 (byte-compatible schema so an Electron-era DB still opens).
- Transactions, upsert semantics, ordering/collation, and the `meta_json` validation (note: existing
  rows have `mode="default"` which the current TS enum rejects — port must not silently change this).

## Phased slices (each independently tested; no big-bang)

1. ✅ **Foundation** — `zcode-db` crate (rusqlite bundled) opens the real DB read-only + reads `tasks`.
   Verified: `cargo run` printed 55 rows from `~/.zcode/v2/tasks-index.sqlite`.
2. ✅ **Boundary** — add `napi-rs`, expose `tasks_count`/`list_tasks` to Node; load from a test.
3. ✅ **Read repos** — port `queryTaskList`, `listTaskMetas`, `getTaskMeta`, grouped-view queries;
   cross-check Rust output == TS output on the same fixture DB (golden tests).
4. ✅ **Write repos** — `syncTaskMeta`, `updateTaskState`, `applyAgentPatch`, archive/delete, groups;
   transaction + locking parity; test on a COPY of the DB, never the live file.
5. ✅ **Automations / off-peak** — `AutomationRepo`, `OffPeakTaskRepo`.
6. ✅ **Migrations + startup** — port `migrations.ts`/`startup.ts`; then the TS `node:sqlite` path is
   fully removed (no JS fallback).
7. ⬜ **Delete** the TS data layer once every consumer is on the Rust facade.

## Testing / evidence (RULES.md)

- Golden tests: run a query through BOTH the TS repo and the Rust crate on the same fixture DB,
  assert identical rows. Property tests for ordering/collation. Migration test: open an old-schema DB,
  run Rust migrations, compare to TS result.
- No claim of "port complete" until every repo method has a passing Rust↔TS parity test.

## Current status

Slices 1–6 are done. Slice 7 is **not**: the TS data layer still exists and is still live.

| Slice                      | State | Evidence                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Foundation               | ✅    | `rusqlite` bundled, read-only open + `tasks`                                                                                                                                                                                                                                                                                                                     |
| 2 Boundary                 | ✅    | `napi` + `napi-derive` in `Cargo.toml:18-19`, `cdylib`+`rlib`; 177 `#[napi]` exports loaded via `createRequire` from `packages/services/src/session/zcodeDb.ts` **and** `packages/desktop/zcode-db/addon.ts`                                                                                                                                                     |
| 3 Read repos               | ✅    | `tasks_count` (`lib.rs:89`), `list_recent_tasks` (`:108`), `list_task_metas_json` (`:743`), `messages_json` (`:1914`), `session_journal_read.rs`                                                                                                                                                                                                                 |
| 4 Write repos              | ✅    | 18 `session_write_*.rs` modules; `open_readwrite` applies `foreign_keys`/WAL/`synchronous` (`lib.rs:74-86`)                                                                                                                                                                                                                                                      |
| 5 Automations / off-peak   | ✅    | `automation.rs`, `automation_write.rs`, `offpeak.rs`, `offpeak_write.rs`, consumed by `automationRepo.ts` / `offPeakTaskRepo.ts`                                                                                                                                                                                                                                 |
| 6 Migrations + startup     | ✅    | `migrations.rs`, `session_bootstrap.rs`; no live `node:sqlite` import remains in any `src` tree (remaining mentions are comments recording the removal)                                                                                                                                                                                                          |
| 7 Delete the TS data layer | ⬜    | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/` (2,477 lines) is **live** — it loads the same `zcode_db.node` via `native-addon.ts` and is reachable from `adapters/src/storage/session-store.ts` and `bootstrap/src/zcode-protocol/server-operations.ts`. It is now a facade over the Rust addon rather than a second implementation |

Open boundary work is tracked in `spec/native-boundary-zcode-db.md`: the 177 exports are all
synchronous and 119 return UTF-16-encoded strings, which costs a transcode plus a re-parse per heavy
read.
