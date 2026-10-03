# Rust native port: configuration surface (`zcode-config`)

Status: active. Owner: PortConfig. Written 2026-10-01 **before** the crate, per `AGENTS.md:3`.

Crate: `packages/rust/crates/zcode-config` · Wrapper: `packages/rust/src/config.ts` · Subpath: `@zcode/rust/config`

---

## 1. Motivation

### 1.1 The security finding

`packages/services/src/hooks/hooksService.ts` holds the services-layer half of the Workspace Hook
trust model. The read half is `readPersistentWorkspaceHookTrustDigests` (`:154-212`). Two properties
of it are load-bearing, and neither is enforced anywhere else:

- **Fail-closed on a corrupt store.** `parseWorkspaceHookTrustStoreContent` is the single
  authoritative schema. A JSON syntax error *and* a schema violation are both `invalid`, and
  `invalid` means `{ digests: new Set(), corrupt: true }` — every hook is `pending_trust`, and the
  Runtime side hard-blocks it as `blocked_untrusted`. The file comment at `:133-153` records exactly
  why the function must not be wrapped in `try { … } catch { return new Set() }`: that would make
  "corrupt" indistinguishable from "no trust records", producing a **presentation/runtime
  divergence** — the UI says "trusted", the execution layer refuses forever, and nothing diagnoses
  it. The trust store is a permission boundary; every reader must reach the same conclusion about
  the same file.
- **A grant is bound to a human decision.** The store's write side
  (`FileWorkspaceHookTrustStore.grant`, `apps/zcode-cli/packages/adapters/src/storage/workspace-hook-trust-store.ts:196-206`)
  is a `Map` upsert keyed on `workspaceIdentity \0 hookDeclarationDigest`, and the schema's
  `superRefine` (`:64-75`) rejects duplicate keys. Granting the same digest twice is an **upsert,
  not an append** — that is what makes the grant idempotent, and the uniqueness rule is what stops a
  second, conflicting record for the same declaration from existing at all.

The analysis behind this port also found that `IZCodeAgentService.grantWorkspaceHookTrust` is
reachable on the same channel that authorizes the hooks, so on the unauthenticated server path a
peer can mint its own grant. **That finding is not fixed here** — the authorization wiring lives in
`apps/zcode-cli`, which `rust-native-program.md` §1.1 defers by user decision, and in
`packages/services/src/zcode-agent/`, which is not this port's surface. What this port does is make
a correct implementation *possible* by putting the three primitives it needs inside the native
boundary, where a call site cannot skip them:

1. the strict store parse and the fail-closed classification (§3.1);
2. the deterministic declaration/bundle digest (§3.2);
3. the trust projection that turns digests into `trustState` (§3.3).

### 1.2 The measured cost

`rust-native-ports.md` invariant 10 is a gate, not a formality. Measured on this repo's i5-8500 host,
median of 9 samples over the **predecessor**, from `tmp/zcode-config-bench-ts.mjs` (throwaway,
deleted after the run). The napi floor for an owned object argument plus a returned object is
**0.0002 ms** (`rust-native-ports.md` §10: 0.095 µs number→number, +0.12 µs per owned `Buffer`
reference, +0.19 µs for a returned owned value).

| Surface | TS median | FFI floor | Ratio | Async? |
| --- | --- | --- | --- | --- |
| `appSettingsSchema.safeParse`, 51 fields, 1 remote session | 0.0385 ms | 0.0002 ms | **190x** | yes |
| `appSettingsPatchSchema.parse`, 2-field patch | 0.0023 ms | 0.0002 ms | **11x** | no |
| `parseWorkspaceHookTrustStoreContent`, 1 record (1 KiB) | 0.0067 ms | 0.0002 ms | **33x** | no |
| `parseWorkspaceHookTrustStoreContent`, 25 records (18 KiB) | 0.1182 ms | 0.0002 ms | **590x** | yes |
| `parseWorkspaceHookTrustStoreContent`, 250 records (178 KiB) | **1.1139 ms** | 0.0002 ms | **5570x** | yes |
| `buildWorkspaceHookBundleSnapshot`, 3 hooks | 0.0291 ms | 0.0002 ms | **145x** | no |
| `buildWorkspaceHookBundleSnapshot`, 60 hooks | 0.2551 ms | 0.0002 ms | **1275x** | yes |
| `createWorkspaceHookDeclarationDigest`, single hook | 0.0021 ms | 0.0002 ms | **10x** | n/a — see §3.6 |
| `JSON.parse` of the same settings file (floor reference) | 0.0093 ms | — | — | — |

Two facts from that table drive the design:

- **The 250-record trust store exceeds 1 ms on its own.** Invariant 4 therefore applies: the store
  read must be a napi `AsyncTask`, not a synchronous call on the host event loop. A 250-record store
  is not exotic — the store accumulates one record per granted declaration per workspace and is
  never compacted unless the user runs the CLI.
- **A single declaration digest is only 10x the floor**, so the digest is *not* exported per hook.
  Exporting it per hook would pay 0.0002 ms of FFI to move 0.0021 ms of work, and a 60-hook bundle
  would pay that 60 times. The whole bundle is one call instead (§3.6). This is the
  `zcode-terminal-profile` "port the parsing, not the spawn" decision applied to a batch: the unit
  that crosses the boundary is the unit that is expensive.

---

## 2. Scope

### 2.1 Ported

| Predecessor | Location | Native export |
| --- | --- | --- |
| `readSettingsWithMeta` schema half | `settingService.ts:116-184` | `parse_settings_content` |
| `appSettingsSchema` preprocess chain + object schema | `validationAppSettings.ts:118-459` | folded into `parse_settings_content` / `default_settings` |
| `appSettingsPatchSchema` | `validationAppSettings.ts:461-528` | `parse_settings_patch` |
| `normalizeSettingsPatch` | `normalizeSettingsPatch.ts:3-83` (deleted) | `normalize_settings_patch` |
| `update()` merge + `recentProjects` cap | `settingService.ts:314-325` | `merge_settings` |
| `writeSettings()` persist merge | `settingService.ts:206-213` | `build_persisted_settings` |
| `buildCorruptSettingsBackupPath` | `settingService.ts:67-70` | `build_corrupt_settings_backup_path` |
| `migrateLegacyAccountConnectionSettings` | `legacyAccountConnectionSettings.ts:64-96` | `migrate_legacy_account_connections` |
| `needsLegacyAccountConnectionMigration` | `:54-61` | `needs_legacy_account_connection_migration` |
| `readIncompleteLegacyTeamConnections` | `:20-41` | `read_incomplete_legacy_team_connections` |
| `retainLegacyAccountConnectionFields` | `:99-106` | `retain_legacy_account_connection_fields` |
| `readPersistentWorkspaceHookTrustDigests` | `hooksService.ts:154-212` | `read_workspace_hook_trust_store` (AsyncTask) |
| `parseWorkspaceHookTrustStoreContent` | `workspace-hook-trust-store-file.ts:87-99` | folded into `parse_workspace_hook_trust_store` |
| `resolveWorkspaceHookTrustStorePath` storage-dir resolution | `hooksService.ts:158-169` | folded into `read_workspace_hook_trust_store` |
| trust-store `grant` / `revoke` / `touch` / `compact` transitions | `workspace-hook-trust-store.ts:196-280` | `apply_workspace_hook_trust_grant` / `…_revoke` / `…_touch` / `…_compact` |
| `buildWorkspaceHookBundleSnapshot` + `resolveWorkspaceHookEntries` | `workspace-hook-digest.ts:62-190` | `build_workspace_hook_bundle_snapshot` |
| `createWorkspaceHookDeclarationDigest` | `workspace-hook-digest.ts:192-248` | folded into the snapshot build |
| `fromProjectSnapshot` | `workspaceHookSettingsModel.ts:161-193` | `project_hooks_to_service_hooks` |
| `fromUserZCodeSource` | `:195-214` | `user_zcode_source_to_hooks` |
| `fromLegacyHooksConfig` | `:216-249` | `legacy_hooks_config_to_hooks` |
| `toZCodeHooksEvents` + `getWritableHook` + `resolveWritableDeclarationEnabled` + `getCustomHookFields` | `:46-91, 251-267` | `hooks_to_zcode_events` |
| `resolveNextRootEnabled` | `:269-283` | `resolve_next_root_enabled` |
| `writeZCodeHooksConfig` merge | `hooksService.ts:270-285` | `build_zcode_hooks_config` |
| `resolveWorkspaceHookRuntimeRoot` | `workspace-hook-config.ts:130-152` | `resolve_workspace_hook_runtime_root` |
| `workspaceHooksConfigSchema` validation | `workspace-hook-config.ts:62-80` | folded into `validate_workspace_hooks_config` |
| `saveHooksImpl` user/project partition | `hooksService.ts:287-308` | `partition_writable_hooks` |
| settings-sync dedup/precedence core | `settingsSyncService.ts:997-1282` | `settings_sync_*` (§3.5) |
| settings-sync config merges | `settingsSyncService.ts:1107-1153` | `settings_sync_merge_*` |
| settings-sync skill frontmatter reader | `:823-889` | `settings_sync_read_skill_metadata` |

### 2.2 Out of scope (stated, not silently left behind)

- **`appSettingsSchema` itself** (`packages/shared/src/validationAppSettings.ts`). It is
  renderer-reachable: `packages/ui` reads `AppSettings` through `ISettingService`, and
  `validationAppSettings.ts` is re-exported from `packages/shared/src/validation.ts`, the barrel
  the renderer imports. It cannot statically import `@zcode/rust` (invariant 9). The schema is
  **reimplemented** in this crate rather than moved, and the reimplementation is the only
  implementation on the Node-only services path. The shared copy stays for the renderer, exactly as
  `rust-native-ports.md` §9 describes for the eight `zcode-protocol-v4` modules: *they are not a
  fallback, they are the single implementation for a platform that cannot host a native binary.*
- **`packages/shared/src/workspace-hook-{config,digest,trust-store-file,mutation}.ts`.** Same
  reason, plus `apps/zcode-cli` (deferred by user decision, `rust-native-program.md` §1.1) imports
  them directly and the CLI's own bundle is out of this programme's reach. The four modules are
  left byte-identical; §5 records the two implementations and the differential that proves they
  agree.
- **`settingService.ts`'s write queue, retry ladder, and atomic-write plumbing.**
  `withSettingsWriteQueueTimeout` (`settingsWriteQueue.ts`) is a *scheduling policy* — a 30 s
  pre-commit timeout with a `ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS` override and a
  generation-based stale-write veto. `atomicWriteText` (`fs/atomicFileUtils.ts`) is filesystem IO.
  Neither is compute. Both stay in TypeScript, and they now call the native parse/merge. See the
  `zcode-fs` §2.2 precedent for host policy staying on the host.
- **`settingsSyncService`'s filesystem orchestration** — `importSkillDirectory`,
  `importCommandFile`, `importPluginDirectory`, the `symlink`/`cp`/`link` calls, the bounded
  directory walks (`collectSkillMarkdownPaths`, `collectCommandMarkdownPaths`), and the
  `importMode` selection. That is IO, and `zcode-fs` already owns the traversal primitives. What
  moves is the *precedence* and *merge* logic: the name-key normalisation, the four skip-reason
  ladders, the discovery-summary rollup, and the three config-file merges. This is the
  `zcode-terminal-profile` split — parse and decide in Rust, spawn in TypeScript.
- **The `localeCompare`/`toLowerCase` collation question.** settings-sync normalises skill,
  command, plugin and MCP names with `name.trim().toLowerCase()`. `toLowerCase` is Unicode
  case-folding over the full code-point space; Rust's `str::to_lowercase` agrees for the whole
  Basic Multilingual Plane and the ASCII range, and this crate is the only consumer. The plugin id
  comparison additionally lowercases. §6 R5 records the residual risk rather than claiming parity.
- **`readWorkspaceHookProjectSources`** (`workspace-hook-config.ts:250-276`) — project config
  *discovery* (walking up for worktree markers, deduplicating candidate paths). It is IO and stays
  in the shared module; its output, `WorkspaceHookSourceInput[]`, is the native request.

---

## 3. Design

### 3.1 The trust store parse is one call and it is the fail-closed boundary

`read_workspace_hook_trust_store` takes `{ userConfigJson, home, workspaceIdentity, trustFilePath? }`
and returns `{ status, digests, corrupt, records }`. The storage-root resolution the predecessor
does inline (`hooksService.ts:158-169`: `storage.dir` is trimmed; `~/…` joins onto `home`; an
absolute path is `resolve`d; anything else is `resolve(home, configured)`; empty falls back to
`join(home, ".zcode")`; the file is `<root>/security/workspace-hook-trust-v1.json`) moves inside, so
the two readers cannot disagree about *which file* they are talking about — the exact failure the
file comment at `hooksService.ts:150-152` records as unresolved duplication.

The classification is a three-way `status`, mirroring the three states the store can be in:

| `status` | meaning | `corrupt` | `digests` |
| --- | --- | --- | --- |
| `missing` | `ENOENT` | `false` | empty |
| `ok` | strict schema passed, keys unique | `false` | the workspace's declaration digests |
| `corrupt` | any other read error, JSON syntax error, **or** schema violation | **`true`** | **empty** |

`corrupt` and a non-empty `digests` are **mutually exclusive by construction** — the Rust function
returns from three separate arms, and there is no third state a caller could observe. That is the
structural form of "preserve fail-closed exactly": the TypeScript predecessor had to be careful, and
a future edit to the Rust match arm that produced `{ corrupt: true, digests }` would be caught by
`T1` and `T2` below rather than by review.

**Why the whole schema, not a field check.** The predecessor's doc comment (`:142-148`) records the
bug this replaced: a hand-written `isRecord` + digest-regex check in the services layer and the
strict schema in runtime/adapters reached *different conclusions about the same file*. The schema
here is the strict one — `.strict()` records, `.strict()` root, `sha256` digest regex
`^[a-f0-9]{64}$`, `grantedAt`/`lastUsedAt` as ISO-8601 datetimes, `nonnegativeInteger` counters,
`decision` literal `"trusted"`, `digestAlgorithm` literal `"sha256"`, and the uniqueness
`superRefine` — because that is the schema both sides must agree on. Any relaxation would reopen
the divergence.

### 3.2 The digest is deterministic and batched

`createWorkspaceHookDeclarationDigest` is `sha256(JSON.stringify(payload))` over a canonical array
(`workspace-hook-digest.ts:211-248`). Two properties must be reproduced exactly:

- **Key order is not involved** — the payload is an *array*, so `serde_json`'s `preserve_order` is
  not load-bearing here. It *is* load-bearing for the settings and hook config objects, which are
  compared with `JSON.stringify` (`settingService.ts:308-309` compares
  `providerFamilyConnectionSelections` by stringified form; `hooksService.ts` round-trips config
  objects), so `serde_json` is used with the workspace's `preserve_order` feature.
- **`JSON.stringify` number and string formatting is the predecessor's**, and `serde_json` emits
  the same shortest-round-trip forms for the value classes that can appear here (integers, and the
  strings produced by `resolveWorkspaceHookTimeoutMs`, which is `Math.max(1, Math.round(x))`).
  `T7` pins the digest for a fixed payload against the value the predecessor computes.

The whole bundle is one export (§1.2). `build_workspace_hook_bundle_snapshot` takes the sources and
the runtime root and returns the entries, the source files, and the bundle digest — the same
`WorkspaceHookBundleSnapshotData` shape, so `workspaceHookSnapshot` crosses the RPC unchanged.

### 3.3 The trust projection

`project_hooks_to_service_hooks` is `fromProjectSnapshot` moved: for every canonical entry it looks
up the source, derives the writable `Hook` (`configuredState`, `custom` passthrough fields, the
`timeout` back-fill at `workspaceHookSettingsModel.ts:149-151`, which reads `raw.timeout` for
`command` and `Math.round(raw.timeoutMs) / 1000` otherwise), and sets
`workspaceHook.trustState` from the persistent digest set — `"trusted_persistent"` if the
declaration digest is in the set, `"pending_trust"` otherwise.

It takes the digest set as **data**, not as a file path, so the decision has exactly one input
source. There is no `catch` in the chain and no branch that can produce `"pending_trust"` for a
digest that was granted, because the set was produced by §3.1 and a corrupt store produces an
*empty* set.

### 3.4 Settings: the preprocess chain runs before validation, in the same order

`appSettingsSchema` is `z.preprocess(chain, appSettingsObjectSchema)` and the chain order is
load-bearing (`:447-457`):

```
sanitizeEmbeddedBrowserViewportPreference(
  sanitizeDesktopWindowSize(
    migrateMessageStreamShowReasoningDefault(
      migrateCloseToTrayOnWindowsDefault(
        sanitizeZCodeEndpointOrigin(migrateLegacyWorkspaceSession(value))))))
```

Each step is a whole-object rewrite, not a per-field coercion, and three of them **delete** a field
when it fails its own schema (`zcodeEndpointOrigin`, `desktopWindowSize`,
`embeddedBrowserViewportPreference`) while two **add** fields when a migration tag is absent. The
differential (§5) drives all six interactions, because the obvious port — a per-field normaliser —
gets "delete the field when the nested schema fails" wrong in exactly the way that silently
discards a user's window size.

`parse_settings_content` returns `{ status, settings, needsMigrationPersist, issues }`. `status` is
`"ok"`, `"invalid-json"` or `"schema-invalid"`; the last carries `issues` as
`{ path, message }[]`, which the host formats with the same
`formatZodError` shape (`"a.b: message; c: message"`, `<root>` for an empty path) so the existing
log line is unchanged.

### 3.5 Settings-sync: precedence and merges, not the filesystem

The settings-sync decision logic is four ladders, all of which are pure set membership over
normalised name keys:

| Candidate | Key | Precedence rule | Skip reason |
| --- | --- | --- | --- |
| skill | `name.trim().toLowerCase()` (frontmatter `name`, else directory name) | `targetExists` **before** `sameNameExists` | both |
| command | path-derived `/a/b/c` name, `.md` stripped, separators collapsed | `pathExists(targetPath)` before name check | both |
| plugin | manifest `id`, lowercased | `pathExists(targetPath)` before id check; a `null` config path is reported as `targetExists` | both |
| MCP | `name.trim().toLowerCase()` | **name only** — there is no `targetExists` row, because an MCP server is a map entry, not a path | `sameNameExists` |

The two config merges both preserve the destination's other keys:

- `settings_sync_merge_mcp_server`: `{...parsed, mcp: {...parsed.mcp, servers: {...servers, [name]: config}}}` — the new server wins on a name collision, and `parsed.mcp`'s other keys survive.
- `settings_sync_merge_plugin_dir`: appends the resolved plugin path to `plugins.dirs` unless a dir already resolves to the same path, and returns `undefined` (no write) in that case.

Both return the **file text** to write (`JSON.stringify(value, null, 2) + "\n"`, `settingsSyncService.ts:1133-1136`)
so the byte shape of the config file is produced by the same code that decided the merge.

### 3.6 Event loop, process, byte boundary, renderer

- **Event loop (rule 4).** Three exports are `AsyncTask` because §1.2 measured them above 1 ms:
  `read_workspace_hook_trust_store` (250-record store = 1.11 ms), and the two settings-file entry
  points once the file is large. `parse_settings_content`, `build_workspace_hook_bundle_snapshot` and
  the settings-sync exports are **synchronous**, and are the only synchronous exports: they are pure
  functions of values the caller already holds, and a 51-field settings parse measures well under
  the 1 ms line. The trust-store read is the one that reads a file, so it is the one that must not
  block.
- **Process (rule 5).** Zero child processes. The crate links `std`, `napi`, `serde`, `serde_json`
  and `sha2` only.
- **Byte boundary (rule 8).** No export moves raw bytes. Every payload is UTF-8 JSON or a string,
  and every value crossing the boundary is a `serde_json::Value` (a JS object/array) or a `String`.
  `smoke-byte-boundary.mjs` is therefore not applicable and this port is not in its scope; the
  wrapper declares no `Buffer` in any signature.
- **Renderer (rule 9).** `@zcode/rust/config` is imported only by `settingService.ts`,
  `settingsSyncService.ts`, `hooksService.ts` and `workspaceHookSettingsModel.ts` — all Node-only
  implementation modules behind `packages/services/src/node.ts`. The RPC contract files
  (`setting/setting.ts`, `settings-sync/settingsSync.ts`, `hooks/hooks.ts`) are pure TypeScript and
  import nothing native, which is what the renderer imports.
- **Renderer-safe duplicates.** `parse_settings_content` returns a plain settings object, and the
  renderer's `appSettingsSchema` is unaffected because the renderer never reaches the host's parse.

---

## 4. Failure semantics

Every row is covered by a `cargo test -p zcode-config` case.

| # | Condition | Behavior |
| --- | --- | --- |
| T1 | Trust store file missing (`ENOENT`) | `{ status: "missing", corrupt: false, digests: [] }`. No warn line, no quarantine. |
| T2 | Trust store unreadable (EACCES, EROFS, EISDIR, EIO) | `{ status: "corrupt", corrupt: true, digests: [] }` + `reason: "unreadable"`. **Fail-closed.** |
| T3 | Trust store is not valid JSON | `{ status: "corrupt", corrupt: true, digests: [] }` + `reason: "invalid-content"`. **Fail-closed.** |
| T4 | Trust store is valid JSON but violates the schema (missing `schemaVersion`, wrong `decision`, non-`[a-f0-9]{64}` digest, bad datetime, unknown field, duplicate `identity\0digest` key) | `{ status: "corrupt", corrupt: true, digests: [] }` + `reason: "invalid-content"`. **Fail-closed**, and *no partial digest set is ever returned*. |
| T5 | Trust store `ok`, records for several workspaces | `digests` contains **only** the records whose `workspaceIdentity` equals the request's. |
| T6 | Trust store `ok`, `records: []` | `{ status: "ok", corrupt: false, digests: [] }` — an empty store is *not* corrupt. |
| T7 | `build_workspace_hook_bundle_snapshot` with a fixed source set | Byte-identical `hookDeclarationDigest` and `bundleDigest` to the predecessor (`workspace-hook-digest.ts:192-248, 160-179`). |
| T8 | Snapshot for a source set with zero hooks | `None` — the predecessor returns `undefined` and the caller omits `workspaceHookSnapshot`. |
| T9 | `project_hooks_to_service_hooks` with `persistentTrustedDigests` containing a declaration digest | That hook's `workspaceHook.trustState` is `"trusted_persistent"`; every other is `"pending_trust"`. |
| T10 | `project_hooks_to_service_hooks` with an **empty** digest set (the corrupt case, T2–T4) | Every hook is `"pending_trust"`. There is no path that yields `"trusted_persistent"` with an empty set. |
| T11 | `project_hooks_to_service_hooks` with `snapshot` absent | `[]`, the predecessor's `if (!snapshot) return []`. |
| T12 | `apply_workspace_hook_trust_grant` with a record whose key already exists and identical content | The store is returned **unchanged and byte-identical** — the grant is idempotent. |
| T13 | `apply_workspace_hook_trust_grant` with a record whose key already exists and different content | The existing record is **replaced in place**, keeping its position in `records` (a `Map.set` upsert, not an append). |
| T14 | `apply_workspace_hook_trust_grant` on a **corrupt** store | Treated as `records: []` and the store is rewritten from scratch — the predecessor's `mutate()` (`workspace-hook-trust-store.ts:288-292`) does exactly this. Fail-closed: a corrupt store is never partially preserved. |
| T15 | `apply_workspace_hook_trust_grant` with a record that violates the record schema | Rejected before any write: `{ accepted: false, reason }`, no store returned. The predecessor `workspaceHookTrustRecordSchema.parse`s each record up front (`:197`). |
| T16 | `apply_workspace_hook_trust_grant` where the upsert would create a duplicate key | Impossible (T13 is an in-place replace), and the post-condition is re-checked: the returned store is validated against the uniqueness `superRefine` and a violation is an error, not a written file. |
| T17 | `apply_workspace_hook_trust_revoke` with `hookDeclarationDigests: []` | Rejected: `hookDeclarationDigests must be undefined or non-empty` (`:212-216`). The empty array is a distinct third state from "revoke all", and silently succeeding would make it indistinguishable. |
| T18 | `apply_workspace_hook_trust_revoke` with no `hookDeclarationDigests` | Revokes every record for that workspace, and **only** that workspace. |
| T19 | `apply_workspace_hook_trust_touch` | Sets `lastUsedAt` on the selected digests for that workspace; a digest not in the store is not added. Records for other workspaces are returned unchanged (identity, not equality). |
| T20 | `apply_workspace_hook_trust_compact` with `maxAgeMs` negative/NaN, or `maxRecords < 1`/non-integer | Rejected: `maxAgeMs must be a nonnegative finite number` / `maxRecords must be a positive integer` (`:249-254`). |
| T21 | `apply_workspace_hook_trust_compact` | Keeps every record in `current` regardless of age, then the newest non-current records up to `maxRecords - current.length`, in the predecessor's `[...currentRecords, ...nonCurrent.slice(0, available)]` order (`:270-277`). `available` is `max(0, …)`, so an over-full `current` is not an error. |
| T22 | `resolve_workspace_hook_trust_store_path` with `storage.dir` = `""`/absent | `<home>/.zcode/security/workspace-hook-trust-v1.json`. |
| T23 | … with `storage.dir` = `"~/data/x"` (leading `~/`) | `<home>/data/x/security/workspace-hook-trust-v1.json` — the `~/` is stripped, not treated as a literal directory. |
| T24 | … with an absolute `storage.dir` | `resolve(configured)`, home is not consulted. |
| T25 | … with a relative `storage.dir` | `resolve(home, configured)` — relative to the **home** directory, not the process cwd. |
| T26 | `parse_settings_content` on text that is not JSON | `{ status: "invalid-json", settings: null }`. The caller retries 3×/300 ms and then quarantines — the retry ladder and the `.corrupt-<ts>` rename stay in TypeScript (§2.2), only the parse verdict moves. |
| T27 | `parse_settings_content` on a JSON scalar / array / null | Same as T26 at the schema layer: `appSettingsSchema.safeParse(5)` fails, so `{ status: "schema-invalid" }` with the issue list. |
| T28 | `parse_settings_content` on an object with an unknown key | **Accepted and dropped.** `appSettingsObjectSchema` is a plain `z.object` (strip mode), so unknown keys never reach the output and never fail the parse. This is the "unknown-key handling" row and it is the reason a Rust port must strip rather than error. |
| T29 | `parse_settings_content` on an object whose `desktopWindowSize` is invalid | The **field is deleted** and the rest of the settings validate; the file is not quarantined (`sanitizeDesktopWindowSize`, `:150-166`). |
| T30 | `parse_settings_content` on an object whose `zcodeEndpointOrigin` is not a valid http(s) origin | The field is deleted (`:133-148`), and `defaultSettings().zcodeEndpointOrigin` stays absent. |
| T31 | `parse_settings_content` on an object without `closeToTrayOnWindowsMigrationInitialized` | `closeToTrayOnWindows: true` and `closeToTrayOnWindowsMigrationInitialized: true` are **injected** (`:188-203`), and `needsMigrationPersist` is `true`. |
| T32 | … without `messageStreamShowReasoningMigrationInitialized` | The same injection for `messageStreamShowReasoning` (`:205-220`). |
| T33 | … where both migration tags are present and the legacy account keys are absent | `needsMigrationPersist: false` — the predicate is the `||` of three clauses (`settingService.ts:100-109`). |
| T34 | … where legacy account keys are present **and** there is an incomplete team connection | `needsMigrationPersist: false` for the legacy clause: `readIncompleteLegacyTeamConnections(raw).length === 0` is part of the same `||`, and a pending team migration deliberately blocks the eager rewrite. |
| T35 | `normalize_settings_patch` with `terminalFontFamily: "   "` | Deleted from the patch (`undefined`). RPC swallows `undefined`, so the stale font does not survive. |
| T36 | `normalize_settings_patch` with `integratedTerminalShell.mode: "auto"` | The key is **deleted** (the user override is removed so platform auto-detection resumes), and the mode is not rewritten to `"shell"`. |
| T37 | `normalize_settings_patch` with `integratedTerminalShell.mode: "shell"` | `id`, `label` and `path` are each `.trim()`ed. A whitespace-only value becomes `""` here and is then rejected by `parse_settings_patch` — the normaliser does **not** delete them, which is the predecessor's exact split of responsibility. |
| T38 | `normalize_settings_patch` with `providerFamilyDomain: "  "` | Deleted — **and the assignment uses the untrimmed value on the keep branch** (`:79`: `trimmedProviderFamilyDomain.length > 0 ? normalizedPatch.providerFamilyDomain : undefined`), so `"  zai  "` is written through with its whitespace intact. This is a predecessor bug that is preserved verbatim, because fixing it is a behaviour fork. |
| T39 | `normalize_settings_patch` on a patch with no recognised key | Returned unchanged, including keys the patch schema does not know. The patch schema, not the normaliser, is what rejects an unknown key. |
| T40 | `parse_settings_patch` on an unknown key, or a wrong-typed known key | Rejected. `appSettingsPatchSchema` is a `z.object` in strip mode, so an unknown key is **stripped rather than rejected**; only a wrong-typed *known* key fails. This is the counterpart to T28 and the pair is the real "unknown-key handling" answer. |
| T41 | `parse_settings_patch` with `providerFamilyDomain: ""` | Accepted. The patch schema widens this one field to `z.union([domain, z.literal("")])` (`:492`) because "unbound" is expressed as the empty string on the patch path but as field-absence on the object path. |
| T42 | `merge_settings` with a `recentProjects` patch containing duplicates | Deduplicated by first occurrence, then capped at 10 (`settingService.ts:323-325`). |
| T43 | `merge_settings` where the patch omits `recentProjects` and the current settings have 10 | The current 10 are kept; the cap does not truncate an absent patch field. |
| T44 | `build_persisted_settings` with legacy account fields on disk and `commitAccountSelection: false` | `{...retainLegacyAccountConnectionFields(raw), ...settings}` — the **settings win** on a key collision, and the legacy fields are written back for rollback. |
| T45 | `build_persisted_settings` with incomplete legacy team connections and `commitAccountSelection: false` | `providerFamilyConnectionSelections` is **deleted** from the persisted object even though `settings` carries it (`settingService.ts:211-213`) — an ordinary preference save must not silently pick a new plan for the user. |
| T46 | `build_persisted_settings` with `commitAccountSelection: true` | The key is kept. |
| T47 | `build_persisted_settings` output | `JSON.stringify(persisted, null, 2)` with **no** trailing newline (`settingService.ts:214`) — deliberately different from the hooks and trust-store writes, which do add one. |
| T48 | `hooks_to_zcode_events` with two hooks sharing a matcher and two with `matcher: undefined` | The first matcher value wins the grouping; `undefined` is one group, not one group per hook. |
| T49 | `hooks_to_zcode_events` for a `command` hook | `timeout` is written back as `timeout` (seconds); for a `process` hook as `timeoutMs: timeout * 1000`. |
| T50 | `hooks_to_zcode_events` for a hook whose `enabled` equals `configuredState.configuredEnabled` | The **declaration** `enabled` is written, not the runtime `enabled` (`resolveWritableDeclarationEnabled`, `:62-68`). |
| T51 | `build_zcode_hooks_config` | `{...existing, hooks: {...existing.hooks, ...(enabled !== undefined ? { enabled } : {}), events }}` — `events` is always overwritten, `enabled` only when resolved, and every other key of `existing.hooks` survives. |
| T52 | `resolve_next_root_enabled` where no hook deviates from its configured state | `existingEnabled` is returned **unchanged**, including `undefined`. |
| T53 | `resolve_next_root_enabled` where one hook deviates | `true`. |
| T54 | `partition_writable_hooks` | A hook goes to the **user** config when it is editable and its location is absent or (`zcode` + `user`); to the **project** config when it is editable, (`zcode` + `project`), and its `configuredState.sourcePath` is absent or equals `resolve(workspacePath, ".zcode/config.json")`; otherwise to neither. |
| T55 | `resolve_workspace_hook_runtime_root` with `enabled: true` on a later root and `enabled: false` on an earlier one | `enabled: true` — the merge is a **logical OR**, not a last-wins (`workspace-hook-config.ts:144`). |
| T56 | `resolve_workspace_hook_runtime_root` with `timeoutMs` on two roots | The **last** defined value wins; `undefined` roots are skipped, they do not reset. |
| T57 | `resolve_workspace_hook_runtime_root` with `timeoutMs: 0.4` | `Math.max(1, Math.round(0.4))` = `1`. `Math.round` on a float is reproduced, not truncated toward zero. |
| T58 | `validate_workspace_hooks_config` on a config with an unknown key under `events` | Rejected — `workspaceHooksConfigSchema` is `.strict()` at both levels (`:62-80`), unlike the settings schema. |
| T59 | `settings_sync_*_skip_reason` precedence rows | The four ladders in §3.5, one test each, including the plugin `null`-config-path row and the MCP no-`targetExists` row. |
| T60 | `settings_sync_read_skill_metadata` frontmatter | `^name\s*:\s*(.+)$` / `^version\s*:\s*(.+)$` **multiline**, value YAML-scalar-quote-stripped (`'…'`, `"…"` or a bare `|`/`>` block stripped of one leading/trailing `|`/`>` and a newline — see `:827-836`), `version` absent when empty, and the **directory name** as the name fallback. |

Containment is not a concern for this port (it owns no path decision beyond §3.1's storage-root
resolution, which is a copy of the predecessor's), but the trust-store read is the one place where
the path comes from a config file, so §3.1's resolution is pinned by T22–T25 rather than left
implicit.

---

## 5. Differential plan

`tmp/zcode-config-differential.mjs` (throwaway; deleted after the run) drives the **predecessor**
TypeScript (from `packages/shared/dist` and the services sources) and the **ported** crate over one
corpus, and compares byte-for-byte.

### Named cases

- **Settings normalisation / validation (24 cases).** The full-field `setting.json` above; each of
  the six preprocess steps in isolation; each pair of two steps; all three migration tags absent
  (→ `needsMigrationPersist: true`); both present; a `desktopWindowSize` below the `min(480)`; a
  `desktopWindowSize` that is not an object; a `zcodeEndpointOrigin` of `""`, `"   "`,
  `"ftp://x"`, `"not a url"`, `"https://zcode.z.ai:8443/ignored/path"`; an
  `embeddedBrowserViewportPreference` with a `width` of 319 and one with a `zoom` of `"110"`; a
  `lastWorkspaceSession` mixing local/remote/`historyId` entries with a
  `remoteWorkspaceHistory` that does and does not resolve; an SSH target carrying
  `resourcePackages`; an unknown top-level key; a JSON array; a JSON scalar; truncated JSON.
- **Patch normalisation (18 cases).** Each of the six trimmed string fields with `""`, `"   "`,
  `" x "`, and a non-string; `integratedTerminalShell` `auto` / `shell` with padded fields /
  `shell` with padded fields **and** a padded `dialect` (the dialect is *not* trimmed); a patch with
  no recognised key; a patch with an unknown key; a patch carrying `providerFamilyDomain: ""`.
- **Merge precedence (16 cases).** `{...current, ...patch}` on overlapping and disjoint keys;
  `recentProjects` with duplicates / 12 entries / 3 entries; the account-expected mismatch
  comparison (`JSON.stringify` of `providerFamilyConnectionSelections`, key order included);
  `build_persisted_settings` with and without legacy account fields, with and without incomplete
  team connections, and with both commit flags.
- **Hook digest and snapshot (12 cases).** Bundle snapshots over 1, 3 and 12 hooks; a source set
  with zero hooks; a `process` hook with and without `args`; a `command` hook with
  `shell: true` / `shell: "/bin/bash"` / `shell` absent; a hook with `timeout` in seconds vs
  `timeoutMs` in ms; a hook with `statusMessage`; two source files with the same content but
  different `discoveryOrder`; an event key order permuted on disk.
- **Trust store (14 cases).** Missing, unreadable, truncated JSON, `{}`, wrong `schemaVersion`,
  non-strict extra field, a digest in upper case, a 63-char digest, `decision: "denied"`, a
  non-datetime `grantedAt`, a duplicate `identity\0digest` pair, three records across two
  workspaces, and a 250-record store.
- **Trust store transitions (10 cases).** grant-new, grant-same, grant-changed-in-place, grant-onto-
  corrupt, revoke-selected, revoke-all-workspace, revoke-other-workspace-only, touch-selected,
  touch-unknown-digest, compact-with-current-over-full.
- **Hook model (10 cases).** `fromProjectSnapshot` with 0/1/3 trusted digests; `fromUserZCodeSource`
  with and without a source; `fromLegacyHooksConfig` for `.agents` and `.claude` at project and user
  scope with a non-event key and a wrong-typed `type`; `toZCodeHooksEvents` grouping; the
  `resolveWritableDeclarationEnabled` both branches; `buildZCodeHooksConfig` with and without a
  pre-existing `hooks.enabled`.
- **Settings-sync (12 cases).** The four skip ladders, the MCP merge with and without a name
  collision, the plugin-dir merge with a resolved-path collision, the skill frontmatter reader over
  five frontmatter shapes.

### Result

Recorded in the port report. Zero divergences is the gate; any divergence is a defect in the first
implementation and is fixed before the port ships, with the case named here.

---

## 6. Risks

- **R1 — `Math.round` is not "round half away from zero" in every language.** `Math.round(-0.5)` is
  `-0` in JS, and `f64::round` in Rust is also half-away-from-zero, so they agree. The risk is
  elsewhere: `Math.round(x)` for `|x| >= 2^53` and `f64::round` for the same input agree, but
  `serde_json` and `JSON.stringify` can differ on number *formatting* for non-integers.
  `resolveWorkspaceHookTimeoutMs` and `resolveWorkspaceHookMaxOutputBytes` only ever see values that
  have already passed `z.number().finite().positive()`, and both return `max(1, round(x))`, so the
  only reachable output is an integer ≥ 1. T57 pins the smallest such case. Residual: a
  non-integer `hooks.maxOutputBytes` in a config file that reaches `bundleDigest` via
  `resolvedMaxOutputBytes` is a rounded integer by the time it is hashed, so the payload never
  contains a float.
- **R2 — `toLowerCase` vs `to_lowercase`.** settings-sync name keys and plugin ids. See §2.2; the
  residual is a skill or MCP server whose name differs only by a non-BMP case-folding pair. The
  consequence of a mismatch is a duplicated import, not a wrong write.
- **R3 — Two implementations of the trust-store schema now exist** (this crate and
  `packages/shared/src/workspace-hook-trust-store-file.ts`, which the deferred CLI uses). They are
  pinned by the same differential corpus. If they ever diverge, the divergence is a security
  defect, so `T2`–`T4` are written to fail on a *schema* mismatch, not just on a status flag.
- **R4 — `serde_json`'s `preserve_order` is required, not preferred.** Without it, `Map` is a
  `BTreeMap` and every settings object is re-serialized in sorted-key order, which changes the bytes
  of `setting.json` on the next write and changes `JSON.stringify` equality comparisons that
  `settingService.ts:308-309` and `settingService.ts:405-406` make. The workspace dependency
  already enables it (`packages/rust/Cargo.toml:15-21`); this crate inherits it, and
  `T44`/`T45` exercise the ordering through the persisted object.
- **R5 — The settings schema has 50+ fields and will grow.** Every field is a rule that has to be
  carried across by hand. The mitigation is the differential corpus, which is regenerated by
  re-running the replay script, and `T28`, which fails loudly if the Rust object schema ever
  becomes strict.
- **R6 — `apps/zcode-cli` is deferred, so the grant path stays split.** The grant/revoke/touch/
  compact transitions are ported here and exported, but the only caller in this programme is the
  services layer's own trust read. Wiring `FileWorkspaceHookTrustStore` to them is `apps/zcode-cli`
  work and is named in the REQUIRED-CHANGE block rather than done.
- **R7 — `.claude`/`.agents` legacy hook configs are read with a *different* schema than
  `.zcode/config.json`.** `fromLegacyHooksConfig` is permissive by construction (it filters rather
  than validates, `workspaceHookSettingsModel.ts:216-249`), and it is **not** routed through
  `validate_workspace_hooks_config`. Conflating the two would be a behaviour fork; the differential
  covers both.

---

## 7. Acceptance checklist

Status 2026-10-01: the **trust-store slice** (§3.1–§3.3, rows T1–T6 and T12–T25) is implemented.
The boxes below are per-slice, and the unchecked ones name what is still outstanding.

- [x] Spec file exists and precedes implementation. *(this file)*
- [x] `cargo build --release -p zcode-config` succeeds; `build:native` emits the `.node`
      (660 680 bytes on linux-x64, staged as #15).
- [x] Direct-load smoke against the built binary — all four exports exercised from a real Node
      process: `ok` / `other-workspace` / `corrupt` / `missing` / `wrong-schema-version` /
      `duplicate-keys`, plus path resolution and the async parse.
- [x] `cargo test -p zcode-config` green — **31 tests, 0 failed**; the whole workspace is 763.
- [x] Zero `catch` → legacy shape, zero env flag, zero `node:child_process`.
- [x] Renderer-graph gate: `check-native-graph.mjs` OK — `hooksService.ts` is not renderer-reachable.
- [x] The ported TypeScript is deleted, not disabled: `hooksService.ts` now calls
      `@zcode/rust/config`, and its inline storage-root resolution is gone in favour of the
      native one, which is what removes the duplication its own comment called unresolved.
- [x] **Recorded differential — trust store slice only.** `scripts/verify-hook-trust-parity.mts`
      compares the live predecessor against the crate over 80 checks; 1 enumerated divergence
      (lone surrogate, §5a). It caught five defects in the port that the Rust unit tests could not
      see. The settings/hook/settings-sync rows still have no replay — see the next box.
- [x] **Settings slice (rows T26–T47), implemented and verified.** `settings.rs` carries
      `parse_settings_content` / `parse_settings_patch` — the six-step preprocess chain, the
      object schema in exact shape order, and zod-v4's message vocabulary (`expected int`,
      `Invalid option: expected one of "a"|"b"`, discriminator issues at the discriminator
      field, `unrecognized_keys` pluralisation) — and `settings_persist.rs` carries the
      legacy-account functions, the eight normalisation rules, `merge_settings` and
      `build_persisted_settings`. The napi exports are `parseSettingsContent` /
      `parseSettingsPatch` (the wrapper returns a branch rather than throwing across the
      boundary). **Recorded differential: §5b — 94 checks, 0 divergences.**
      Consumer rewiring of `settingService`'s read/update paths and the
      `normalizeSettingsPatch.ts` deletion land with the remaining rows.
- [ ] **The remaining §4 rows.** T7–T11 (digest / bundle snapshot / trust projection),
      T48–T60 (hook events, config build, settings-sync).
- [ ] **`@zcode/rust/config` staged into the desktop/SEA payload** — the packager only ships a
      crate with a live importer, and today the only importer is the services layer.

## 2a. What the trust-store slice got wrong first

Recorded because both defects were invisible to the type checker and would have shipped a trust
store that rejected every real grant:

1. **The RFC 3339 check rejected fractional seconds.** It sliced the zone designator at a fixed
   byte 19, so `2026-01-02T03:04:05.000Z` — the shape `Date.toISOString()` emits, and therefore the
   shape most grants actually have — was classified corrupt. Fail-closed in the *wrong*
   direction: every hook on every workspace would read as `pending_trust` with no diagnostic.
2. **`split_once` searches for the first match and returns the text before it.** Used to find the
   zone after a fractional part, `"000Z".split_once(non-digit)` returned `("000", "")` and the `Z`
   was lost. The zone is what follows the leading *digit run*, so the prefix has to be taken
   explicitly.

A third defect was in the smoke harness rather than the crate: a fixture builder that returned
JSON *strings* produced a `records` array of strings, so a valid store was correctly rejected. The
fail-closed classification being right is what made that visible immediately instead of after
debugging the parser.

## 5b. Recorded differential — settings slice (2026-10-03)

`scripts/verify-settings-parity.mts` drives the live `appSettingsSchema` /
`appSettingsPatchSchema` against `parseSettingsContent` / `parseSettingsPatch` over the
committed corpus (74 settings inputs, 17 patch inputs, 3 raw-text inputs), comparing the
verdict, the full `{path, message}` issue sequence (order included — the schema's shape
order is part of the contract), the JSON-round-tripped output, and the output key
sequence (the order `JSON.stringify(persisted, null, 2)` writes).

**Result: 94 checks, 0 divergences.** The run caught one real defect before merge: a
valid `lastWorkspaceSession` remote entry validated `lastOpenedAt` /
`lastConnectionStatus` without inserting them, so a passing parse silently dropped both
fields — invisible to the Rust unit tests (which asserted issues rather than the happy
path's content), and exactly what the differential exists for. The probe harness that
pinned the message vocabulary (`scripts/.settings-probe*.mts`) is deleted after the run;
its corpus is committed as `tests/fixtures/settings-parity-cases.json`.

## 5a. Recorded differential — trust store slice

`scripts/verify-hook-trust-parity.mts` drives the **live** TypeScript predecessor and the Rust
crate over one shared fixture set and compares them. It is a live comparison rather than a recorded
transcript because the predecessor still exists — `apps/zcode-cli` imports
`workspace-hook-trust-store-file.ts` and is deferred (§1.1) — so it cannot drift from the code and
needs no regeneration step.

**80 checks, 1 divergence, which is enumerated and accepted.** Run:

```
ZCODE_NATIVE_DIR="$PWD/packages/rust" node_modules/.bin/tsx scripts/verify-hook-trust-parity.mts
```

### What the replay caught

Twelve divergences on the first run, of which **five were defects in the port that the Rust unit
tests could not see**, because each test asserted the intended behaviour rather than the
predecessor's:

| # | Defect | Consequence had it shipped |
| --- | --- | --- |
| 1 | Optional fields had no `skip_serializing_if` | Every absent optional was written back as `null`, so a store rewritten in place no longer byte-matched the one on disk. |
| 2 | `matcherAtGrant` was not type-constrained | An object was accepted where the schema is `z.string().nullable()` — a malformed store would have been trusted. |
| 3 | zod's `.trim()` rewrites the parsed value, and the port only used it for the emptiness check | `"ws-1"` and `"ws-1 "` became distinct keys here but the same key in the predecessor, so a file the predecessor rejects as a duplicate would have been **accepted**. |
| 4 | `matcherAtGrant` used `Option<Value>` | `skip_serializing_if` drops `Some(Null)` with `None`; without it the key is emitted for both. Neither spelling preserves "absent" vs "present but null", so the field became a dedicated tri-state enum. |
| 5 | `join_path` collapsed slashes but did not resolve `.` / `..` | A `storage.dir` containing `..` pointed the trust store at a **different file** than the predecessor read — the same two-readers-disagree class the shared schema was written to remove. |

Two of my own comments asserted the wrong thing and were corrected rather than the code: one claimed
`path.join` does not resolve `..` (it does), and one said `split_once` finds the last match (it finds
the first). A third reported divergence was in the harness itself — it rebuilt the predecessor's path
with string concatenation instead of `path.join` and so invented a `//` that does not occur.

### The one enumerated divergence

A JSON string containing a **lone surrogate escape** (`"\ud800"`). `JSON.parse` accepts it and yields
a JS string holding an unpaired surrogate; `serde_json` refuses to parse the document at all. A store
with such a character in `displayCommandAtGrant` therefore reads as `ok` in TypeScript and `corrupt`
here.

The direction is the safe one: `corrupt` is fail-closed, so the affected hook is `pending_trust` and
the runtime blocks it — the same as for every other untrustworthy store. Accepting it silently would
be worse than naming it, and "fixing" it would mean pre-scanning the file for a pattern no real grant
produces. The harness asserts that no *other* divergence appears, so a regression still fails.
