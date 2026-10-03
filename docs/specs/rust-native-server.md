# Spec: Rust-native server cutover (delete `@zcode/server` :3030)

## Goal

The Tauri desktop app currently boots a Node server (`@zcode/server`, `pnpm dev:tauri` →
`scripts/dev-tauri.mjs` → tsup watch → `node dist/entry-http.js` on :3030) so the renderer
can reach ~40 business-service channels over `/ws`. This spec defines the cutover to a
fully Rust-native host: every channel served in-process by the Tauri app, the Node server
deleted, and **no JavaScript fallback retained** — mirroring the Electron cutover
(commit `a55c2c2`), where `packages/desktop` was measured and deleted, not stubbed.

End state:

- `packages/server` is deleted (entry-http, http.ts, remote/ SSH-deploy stack, bundled
  provider materialization — the remote/ stack is web-mode only and goes with it).
- `scripts/dev-tauri.mjs` shrinks to `tauri dev` + process-group teardown; the
  `startServerIfNeeded` block is removed.
- `packages/services/src/node.ts` `createLocalServices` (2,829-line DI assembly, ~45
  services) has no Node host; its service logic is either ported or deleted with its
  channel.
- `packages/rpc` TS side remains only for the renderer client + shared protocol types;
  the server side lives entirely in `zcode-rpc-server`.

## Current state (measured)

| Layer | Today |
|---|---|
| Wire protocol | Shared: length-prefixed binary, `SocketProtocol`/`ChannelServer` (TS) ≈ `zcode-rpc-server` frame/message (Rust, ~2.5k LOC) — same wire format, loopback |
| Channels | 40 service channels (`packages/shared/src/channels.ts`; was 41 before the Workspace-Memory removal deleted the `memory` channel); **17 native**: exactly the `PORTED_CHANNELS` list in `rpc.rs`, which the Progress section below updates as each channel lands. Of those 17, `client-scenes` and `client-config` are still loud-error placeholders (rung 2 remainder) — registered, counted, but serving nothing |
| Tauri host | In-process listener on 127.0.0.1 (random port); `ProxyFallback` → `ZCODE_TAURI_RPC_UPSTREAM_PORT` exists but off by default (`ZCODE_TAURI_RPC_PROXY=1` opt-in) |
| Rust crates | 22 crates, ~60.5k LOC (fs, git, diff, cron, task-index, config, events, image, markdown, mcp-config, sysinfo, terminal-profile, url-guard, codec, browser, chrome-cookies, packaging, rpc-server, …) |
| Node mass | `packages/services/src` ~95.7k LOC TS (the real port), `packages/server/src` ~9.3k LOC (mostly remote/), `packages/rpc/src` ~3.6k LOC (mostly already mirrored) |

Hard dependencies that shape the plan:

1. **The agent is still Node.** `ZCodeAgentService` spawns `zcode-cli` (Node workspace)
   per workspace over stdio. The Rust port owns the *process manager + stdio protocol
   client*; the agent runtime itself stays a Node child process (this is not a JS
   fallback — it is the agent program, like git or ssh is a program).
2. **Bundled builtin provider config**: build-time tsup `define` injection + atomic
   materialization → Rust `include_str!` embed + identical materialization semantics.
3. **Sqlite repos** (`tasks-index.sqlite`: TaskIndexRepo, OffPeakTaskRepo, AutomationRepo)
   — `better-sqlite3`/`DatabaseSync` → rusqlite; task-index and cron are already specced
   (`docs/specs/rust-native-task-index.md`, `rust-native-cron.md`).
4. **CUA helper** (darwin/win32, Node-SEA helper app + broker socket) — large surface,
   only registered on those platforms; port behind platform gates or cut scope per phase.

## State & event ordering

- The Tauri in-process host becomes the **sole owner** of all service state (sqlite
  files under the app config dir, sessions, scheduler). No second write path: the Node
  server must be terminated *before* any phase's native handler claims ownership of its
  data files, and each cutover rung must state which sqlite tables / data dirs it owns.
- The renderer connects to the in-process listener only; `desktop-continuous`
  (trusted-host `/ws/host`) and mobile `web-remote-replayable` semantics must be
  preserved: after cutover the trusted-host capability check moves to the Rust host
  (capability token issue/consume moves from `/api/rpc-host-capability` into a native
  command), and remote-replayable session attach keeps its snapshot/replay semantics.
- ProxyFallback (`ZCODE_TAURI_RPC_PROXY=1`) is a **development aid only**: allowed per
  channel behind an opt-in flag during the port, deleted in the final rung. It must
  never be default-on and must not exist after cutover — that is the "no JS fallback"
  boundary.

## Acceptance scenarios

1. `pnpm dev:tauri` starts only Vite + cargo; the log contains no
   `starting @zcode/server on :3030…` and no `zcode-server:http` line; all 40 channels
   report native handlers (`unported channels` count = 0).
2. With `ZCODE_TAURI_RPC_PROXY` unset, every UI flow (chat/agent run, task list,
   settings, git, terminal, scheduler) works — no request silently proxies to Node.
3. `grep -r "@zcode/server"` over the workspace yields no remaining references;
   `packages/server` is deleted; `pnpm knip` reports no orphans from it.
4. A session/task/schedule created before cutover is still visible after cutover (same
   sqlite files, same workspace identity keys; migration rung must verify task-index +
   automation tables round-trip).
5. Mobile remote attach to a desktop-attached host still reconnects and replays
   (`web-remote-replayable`) after cutover.

## Implementation rungs (port in dependency order)

Rung order follows the Electron cutover playbook: port, verify, delete the JS path, then
move to the next rung. Each rung lands native handlers in `zcode-rpc-server` behind the
existing `ChannelRegistry`, extends `PORTED_CHANNELS`, and deletes the TS handler it
replaces.

1. **Foundation**: embed + materialize builtin provider config in Rust; native
   trusted-host capability token (replaces `/api/rpc-host-capability`).
2. **Small channels**: port `client-scenes`, `client-config` (network-only over the
   ZCode API, no server state) and `onboarding-record` (json file; deps are native
   already — credential cipher + `zcode-task-index`). Independent and self-contained.
3. **Provider runtime**: port `provider-settings` + `model-selection` **together** —
   they share one runtime (registry, `provider_config.json` file lock + revision CAS,
   60s network refresh, account source over credential + API, `onDidChange` events).
   This is the config plane's bulk (~5k LOC backing). `testModelConnectivity` spawns
   the agent and therefore waits for rung 5; until then it returns an explicit
   "unsupported on native host" `HandlerError` — an error, never a silent fallback.
4. **File plane**: port `file`, `media-preview`, `file-watcher` on top of `zcode-fs`;
   port `git`, `git-checkpoint` on top of `zcode-git`/`zcode-diff`.
5. **Task/scheduler plane**: land `rust-native-task-index.md` + `rust-native-cron.md`;
   port `zcode-task`, `off-peak-task`, `broadcast`, `window-controller`,
   `conversation-share`. After this rung the scheduler actually advances (PORT_STATUS.md
   notes it currently never does).
6. **Agent plane (the core)**: port the `zcode-cli` process manager + stdio protocol
   client (spawning, per-workspace reuse/timeout recycle, owner/lease, stale-run
   protection) → native `zcode-agent`, `zcode-session`, `zcode-task` write paths,
   `subagents`, `commands`, `hooks`, `prompt-attachment-transfer`.
   (The `memory` catalog channel is gone with the feature removal in
   `docs/specs/workspace-memory-removal.md`, so it never reaches this ladder.)
7. **Provider plane**: port provider runtime + `oauth`, `usage-stats`,
   `coding-plan-subscription`, `skills`/`skill-sync`, `mcp-sync`/`plugin-sync`/
   `plugins`/`plugin-management` (reuse `zcode-mcp-config`), `settings-sync`,
   `feedback`, `bots`.
8. **Terminal + platform**: port `terminal` (PTY: portable-pty in Rust replacing the
   node-pty-like service) and `system` parity checks; darwin/win32 `cua-permission` +
   `cua-pip-session` (biggest platform surface — can ship last, platform-gated).
9. **Cutover/delete**: remove ProxyFallback, point every remaining channel native,
   switch the renderer's `resolveServiceWsUrl()` (`apps/zcode-tauri/src/main.tsx`)
   from the Vite `/ws` proxy to the native in-process endpoint (already published as
   `handshake.serviceEndpoint.wsUrl` in `apps/zcode-tauri/src/platform/session.ts` —
   nothing connects to it today), delete `packages/server`, shrink
   `scripts/dev-tauri.mjs`, delete `packages/services/src/node.ts` + dead service
   implementations, update `PORT_STATUS.md` and the remote-control specs
   (`desktop-continuous` / `web-remote-replayable` sections), run
   `pnpm verify:pre-push` + knip.

Mobile/web remote: `packages/web` + `packages/server` remote attach mode is out of scope
of the desktop cutover — if web-remote must keep a Node server, that decision belongs to
a separate spec; this spec's "no JS fallback" claim is scoped to the **desktop app**,
which is the only consumer `dev-tauri` boots today.

## Progress

- **Rung 1 — done (2026-10)**: `services/builtin_provider_config.rs` embeds
  `config/provider/zcode-builtin.json` via `include_str!`, validates the release shape,
  and atomically materialises it under `{appConfigDir}/runtime/provider/bundled/
  zcode-builtin.json` on host startup, exporting `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
  for spawned children. `services/host_capability.rs` ports `createHostCapabilityStore`
  (30 s TTL, single-use, consume-before-check) and the renderer obtains tickets through
  the `issue_rpc_host_capability` native command instead of `/api/rpc-host-capability`.
  Remaining rung-1 item: none in the desktop path — the consumption edge (Rust-side
  trusted-host check) lands with rung 6's continuous attach.
- **Rung 3 — done**: `provider-settings` and `model-selection` are registered
  against `RpcHost::new` and counted in `PORTED_CHANNELS` (6 → 8). The full
  renderer-facing stack lives in `zcode-provider-config` (34 tests); the two
  Tauri channel handlers (`services/provider_settings.rs`,
  `services/model_selection.rs`) dispatch each TS channel method to the matching
  operation, compute model membership host-side (the renderer never supplies
  it), and re-publish the settings / selection view after every mutation.
  `testModelConnectivity` returns a loud `HandlerError` (unsupported until the
  agent plane), never a silent empty success.
  - `packages/rust/crates/zcode-model-option-map` — restricted-CEL tokenizer/parser/
    evaluator ported; `compile_model_option_map` parity tests pass (8 tests). This
    unblocks schema validation of option maps at config-decode time.
  - `packages/rust/crates/zcode-private-file` — `with_file_lock` +
    `atomic_write_private_text_file` + corruption backup promoted out of the Tauri app
    into a crate so both the host and the new config crate share one write discipline.
  - `packages/rust/crates/zcode-provider-config` — the personal-config file plane:
    strict serde schema porting the zod rules (sparse fields, strict unknown-key
    rejection, super-refinements: duplicate provider ids, smart/manual identity
    collision, account-provider access rule, URL/pattern/option-map compilation), the
    config-file codec (schemaVersion, unknown-key rejection, legacy manual-rule
    normalisation), and `PersonalProviderConfigRepository` (lock + atomic write,
    revision CAS, polling, recovery event). **Byte-parity verified**: decode → encode
    of a real `~/.zcode/v2/provider_config.json` reproduces the file exactly.
  - The Rust host now has its own builtin-config materialiser (rung 1) and this
    personal-config file plane; the provider registry/resolver/facade and the Node
    `zcodeBuiltin` remote synchroniser remain, and are the rest of rung 3 (~3 kLOC).
  - **Additional rung-3 progress this session**:
    - `zcode-provider-config/src/domain.rs` — domain overlay surfaces ported from
      `packages/provider/src/config/provider-config.ts` and `model-config.ts`:
      recursive overlay semantics (sparse fields: absent→inherit, null→replace,
      object→recursive merge), ordered-duplicate-checked `ProviderConfigMap` /
      `ProviderTemplateMap`, and typed `ModelConfigRules` (exact-rule
      `get_exact`/`set_exact`/`rename_exact_model`/`delete_exact`,
      `compose_effective`, `resolve` with the TS precedence: exact > manual >
      template > model > model-api > provider-site).
    - `zcode-provider-config/src/config_service.rs` — the `ProviderConfigService`
      Rust analog with the single update boundary (`update_personal`),
      membership revision CAS check, account-provider access guardrails,
      duplicate-name rejection, owned-order normalisation, and all mutation
      methods (`createPersonalProvider`, `savePersonalProviderOverlay`,
      `deletePersonalProvider`, `reorderPersonal*`, `addPersonalModel`,
      `renamePersonalModel`, `setPersonalModelEnabled`, `savePersonalModelDraft`,
      `deletePersonalModel`). Tests drive the full create→add→rename→set→delete
      path against a real personal config file.
  - **More rung-3 progress this session**:
    - `builtin_source.rs` — `FileBuiltinSource`: the bundled+active builtin
      release source with `selectReleaseCandidate` semantics (same-revision
      content conflict → trusted bundled wins; newest valid release otherwise),
      active-file materialisation, and `apply_remote_release` with the
      updated/unchanged/stale outcomes. `source_key` is sha256 of the resolved
      active path, exactly like the TS `createHash("sha256")` cache identity.
    - `account.rs` — account provider facts: `AccountProviderState` /
      `Availability` / `AccountProviderUnavailableReason`,
      `resolve_account_provider_configs` (Start-plan authoritative model list,
      unknown-keeps-previous, reset-forces-fail-closed, connection validation),
      `create_fail_closed_account_provider_config_snapshot`, the
      `account:{builtinRevision}:{providers}:{states}` revision string, and
      `MutableAccountProviderConfigSource` with revision-guarded `replace`.
    - Sparse-field fidelity fix: serde's blanket `Option` deserialiser collapses
      absent and explicit `null`; `schema::sparse_opt` now keeps all three states
      so an explicit `null` in a config file round-trips unchanged. The
      byte-parity test against the live TS-written `provider_config.json` still
      passes after the change.
    - Canonical builtin release encode matches the TS
      `serializeZCodeBuiltinRelease(decode(...))` output byte-for-byte
      (`tests/_fixture_canonical_builtin.json`, generated from the real
      `config/provider/zcode-builtin.json`).
    - Speculative helpers that nothing used (`config_mut_overlays`,
      `overlay_rule`, `merge_manual`, `domain_to_base`) were deleted rather
      than kept as "soon".
  - **Rung 3 facades/registry/handlers**: `facades.rs` (the exact
    `ProviderSettingsView` / `ModelSelectionView` assembly, incl.
    `resolveInitialModelSelection`, `resolveEffectiveModelSelection`,
    membership CAS), `registry_service.rs` (cached snapshot + refresh
    coalescing), `resolver.rs` (Registry complete-type proof),
    `builtin_source.rs`, `account.rs`, `remote_sync.rs` — all byte-parity
    verified against the real `config/provider/zcode-builtin.json`. Speculative
    dead code (`config_mut_overlays`, `overlay_rule`, `merge_manual`,
    `domain_to_base`, `pending_reasons`, the `.pipe` hack) was deleted rather
    than kept as "soon".
  - **Pre-existing, unrelated test failures noted** (not touched, not fixed —
    in `editor`/`fs`/`window`/`session` modules with no provider references,
    failing in the working tree before this rung): window work-area clamping,
    ssh/remote path parsing, session alias/home-token resolution, one flaky rpc
    port-binding race. All `rpc` + provider tests pass (10/10 rpc, 34/34
    provider-config).
- **Rung 4 — partial (`file` channel)**: `file` is registered against
  `RpcHost::new` and counted in `PORTED_CHANNELS` (8 → 9). The handler
  (`services/file_channel.rs`) reuses the `zcode-fs` core linked as an **rlib**
  (crate-type `cdylib` + `rlib`, `reads`/`walk` made `pub`) — the identical
  native containment, not a second implementation. Served fully:
  `readdir`, `stat`, `checkFilesExist`, `resolvePath`, `readTextFile`,
  `readMediaPreview`, `readBinaryPreview`, `createDefaultWorkspace`,
  `ensureConversationWorkspace`, `createScratchWorkspace`. Two surfaces return
  loud errors, never a silent wrong answer: `readFileRange` (top-level binary —
  the Rust `ChannelHandler` is JSON-only) and the workspace-index/search-ignore
  methods (`searchWorkspaceFiles`, `listWorkspaceFiles*`, `*SearchIgnore`).
  The `the_node_proxy_is_off_by_default` test's unported-channel example moved
  from `file` (now ported) to `git`. Still open in rung 4: `git`,
  `git-checkpoint`, `media-preview` (channel), and the file binary-channel +
  workspace-index surfaces.
- **Rung 4 — partial (`file-watcher` channel)**: `file-watcher` is registered
  and counted in `PORTED_CHANNELS` (9 → 10). The handler
  (`services/file_watcher.rs`) uses the `notify` crate (std has no stable watch
  API) for cross-platform watching. `watch`/`unwatch`/`onDynamicChange(id)`
  (the dynamic-event subscription the rpc-server's `on_event_listen` forwards)
  work end-to-end — verified by a test that watches a temp dir, writes a file,
  and receives the `FileWatchEvent`. Events fan out to every subscriber of a
  watcher (multi-subscriber correct). A `recursive: true` watch is **refused**
  (std `notify` non-recursive on Linux), never silently downgraded. Still open
  in rung 4: `git`, `git-checkpoint`, `media-preview`, and the file
  binary-channel + workspace-index surfaces.
- **Rung 4 — partial (`git` channel)**: `git` is registered and counted in
  `PORTED_CHANNELS` (10 → 11). The handler (`services/git_channel.rs`) runs the
  git CLI through `std::process::Command` (the TS service's git-binary exec
  layer), matching the command shapes and parsing. Served: `getIdentity`,
  `getLocalBranches`, `getCommitGraph`, `getChanges`
  (`--porcelain=v2 -z` parsed), `refresh`, `getRepositorySummary`, `stagePaths`,
  `unstagePaths`, `commit`, `push`, `switchBranch`, `createBranchAndSwitch`.
  `generateCommitMessage` returns a loud error (needs the agent, rung 6); a
  non-repository is a loud error. Verified by a real-repo round-trip test
  (identity → getChanges → commit → getCommitGraph). Still open in rung 4:
  `git-checkpoint`, `media-preview`, and the file binary-channel +
  workspace-index surfaces.
- **Rung 4 — partial (`git-checkpoint` channel)**: `git-checkpoint` is
  registered and counted in `PORTED_CHANNELS` (11 → 12). The handler
  (`services/git_checkpoint_channel.rs`) reproduces the TS
  `gitCheckpointRepo`/`gitCheckpointStore`: a checkpoint is a hidden commit
  built via a temporary `GIT_INDEX_FILE` (`git add -A` → `write-tree` →
  `commit-tree` → `update-ref refs/zcode/checkpoints/<id>`) so the user's real
  index is untouched; metadata is a JSON manifest under
  `appConfigDir/checkpoints/<sha256(path)[..12]>/<id>.json`. Served:
  `createCheckpoint`, `diffCheckpoints`, `deleteCheckpoint` (verified by a
  real-repo test: create c1 → change file → create c2 → diff sees the change →
  delete c2 removes the ref). `restoreBetweenCheckpoints` (the
  three-way-merge restore) returns a loud error — a wrong restore silently
  corrupts the worktree, so it is refused rather than approximated. Still open
  in rung 4: `media-preview` and the file binary-channel + workspace-index
  surfaces.
- **Rung 4 — partial (`media-preview` channel)**: `media-preview` is registered
  and counted in `PORTED_CHANNELS` (12 → 13). The handler
  (`services/media_preview_channel.rs`) serves the TS `prepare`'s `inline`
  branch (the Tauri desktop host has no local-URL authorize — that is the
  web-remote surface): validate the media format/kind against the
  `MEDIA_PREVIEW_FORMATS` table, stat through the shared `zcode-fs`
  containment, and inline the bytes as base64 bounded by `inlineMaxBytes`
  (8 MB). A file over the bound or an unknown/mismatched format is a loud
  error, never a truncated preview; `refreshPlaybackUrl`/`release`
  (host-range-url surface) are refused, not fabricated. Verified by a test
  that inlines a real `.mp3` under an allowlist root. Rung 4's core channels
  are now all ported (`file`, `file-watcher`, `git`, `git-checkpoint`,
  `media-preview`); still open are the file `readFileRange` (binary) and
  workspace-index surfaces.
- **Rung 5 — started (`zcode-task` channel)**: `zcode-task` is registered and
  counted in `PORTED_CHANNELS` (13 → 14). The handler
  (`services/zcode_task_channel.rs`) serves the task-list core directly against
  the `zcode-task-index` crate on the same `tasks-index.sqlite` the scheduler
  owns (schema self-initialises via `build_migrations`/`run_migrations`,
  idempotent, matching the TS `ensureReady`). The workspace identity rule
  (`workspaceIdentity?.trim() || workspacePath`) is applied here, outside the
  engine. Served: `listTaskList` (→`query_task_list`), `listPinnedTasks`,
  `setTaskPinned`/`setTaskUnread` (→`update_task_state`/`clear_task_unread`),
  `listArchivedTasks`, `archiveStaleTasks`. The session/grouping/agent ops
  (snapshots, grouped-view ordering, agent process) return loud errors — they
  belong to the session runtime (rung 6). Verified by a real round-trip test
  (temp index → seed task → listTaskList → setTaskPinned → pinned list). The
  scheduler already advances (`claim_due` wired to the store). Still open in
  rung 5: `off-peak-task`, `broadcast`, `window-controller`,
  `conversation-share`, and the `zcode-task` session/grouping operations.
- **Rung 5 — `broadcast` channel**: `broadcast` is registered and counted in
  `PORTED_CHANNELS` (14 → 15). The Tauri host is ONE process shared by every
  window (a single `RpcHost`), so Electron's cross-process halves collapse:
  `send` fans out to every `onMessage` subscriber in-process, and the claim
  coordinator is the single local map (which already sees all windows' claims,
  so no Main round-trip). This matches the TS local-only branch (`parentPort =
  null`) exactly. Served: `send`, `acquireClaim` (committed/busy/acquired with
  the reservation TTL), `commitClaim`, `releaseClaim`, `tryClaim`, and the
  `onMessage` subscription. Verified by tests covering the claim lifecycle
  (acquired→committed→busy), tryClaim, and send fan-out. Still open in rung 5:
  `off-peak-task`, `window-controller` (not renderer-used), `conversation-share`
  (network upload → rung 6), and the `zcode-task` session/grouping ops.
- **Rung 5 — `off-peak-task` channel**: `off-peak-task` is registered and
  counted in `PORTED_CHANNELS` (15 → 16). The handler
  (`services/off_peak_task_channel.rs`) serves the local table lifecycle against
  the `zcode-task-index` crate's `off_peak_tasks`: `get`/`delete` (via
  `OffPeakStore`), `list` (per-workspace table read). `createTask` /
  `cancelTask` / `pauseTask` / `continueTask` / `updateTask` / `deleteHistory`
  return loud errors — they need the server ticket + the agent session
  dispatch, and faking them would silently strand a task rather than schedule
  it. Verified by a test that seeds a task, lists/gets/deletes it, and asserts
  every dispatch operation errors. The `the_node_proxy_is_off_by_default`
  unported example moved from `off-peak-task` (now registered) to
  `conversation-share`.
- **Rung 6 — started (`agent_process` foundation)**: `services/agent_process.rs`
  is the Rust zcode-cli process manager + stdio protocol transport — the process
  owner and stdio protocol client the spec calls for (the agent program itself
  stays a Node child, like git or ssh, which is not a JS fallback). `AgentProcess`
  spawns the agent (`std::process::Command`, piped stdin/stdout/stderr), reads
  stdout and splits on `\n` — each line is one JSON protocol message, exactly
  the TS `ZCodeStdioTransport.drainStdoutFrames` framing — writes newline-
  terminated JSON frames on stdin, and terminates on dispose (idempotent, and
  `Drop` kills so a host exit never orphans zcode-cli). `AgentProcessManager`
  is the per-workspace slot (reuse a live process, recycle a dead one, refuse
  a double-spawn honestly) with a spawn-admission gate. `AgentMessageBus`
  fans messages to every listener. Verified by tests that spawn a real process
  (`cat`) and round-trip a JSON frame, dispose twice, and reject a missing
  command loudly. Still open in rung 6: the session runtime on top of this
  (`zcode-agent`/`zcode-session` channels, owner/lease, stale-run protection,
  subagents/commands/hooks), and the `zcode-protocol` message validation.
- **Rung 6 — protocol message validation**: `services/zcode_protocol.rs` ports
  the `zcodeProtocolMessageSchema` union (Request | Notification | Response |
  Error) — the validation every inbound agent line passes before anything acts
  on it. Strict schemas (deny unknown keys) make the discrimination exact:
  matched in the union's order, first match wins, and an unknown key on a
  candidate rejects it so a later schema can claim it.
  `decode_protocol_message` validates ids (non-empty string ≤64 | int),
  non-empty methods, the trace object, and the Error `{code, message, data?}`
  body; `encode_request` builds a frame for the stdio transport. Verified by
  tests decoding each message kind, rejecting unknown keys / blank methods /
  empty ids, and a request round-trip. Still open in rung 6: the session
  runtime channels on top of the process manager + protocol (owner/lease,
  stale-run protection, subagents/commands/hooks).
- **Rung 6 — request/response correlation (`agent_client`)**:
  `services/agent_client.rs` is the session-runtime core — the Rust equivalent
  of the TS `client.request(...)`. `AgentClient` wraps a spawned agent, sends a
  typed request with a unique id, routes the matching response to its waiter,
  fans notifications to listeners, and treats a timeout as a loud error (never
  a silent hang). Verified against a real fake agent (a `node -e` script that
  replies to each request): correlation returns the sessions, a silent agent
  times out loudly, and an unknown method still gets a response. Rung 6's
  foundation (process manager + stdio framing + protocol validation +
  correlation) is complete; the remaining work is the typed
  `zcode-agent`/`zcode-session` channel surfaces (the dozens of
  `zcodeProtocolMethods`/`V4_METHODS` with their result schemas) that sit on
  top of this client.
- **Rung 6 — `zcode-agent` channel (read-only core)**:
  `services/zcode_agent_channel.rs` is the first channel on the agent client:
  `listSessions` spawns the agent (`zcode-cli`) for a workspace, sends the
  `session/list` protocol request with the correct `zcodeWorkspaceRef`
  (identity rule applied host-side), and returns the sessions. The rest of the
  `IZCodeAgentService` surface returns loud errors — a half-built guess would be
  a silent wrong answer. The agent command is injectable, so the tests drive a
  real fake agent (`node -e` that replies to `session/list`): the channel
  returns its two sessions, and unported methods error loudly. **Registered
  conditionally**: `resolve_agent_command()` mirrors the TS
  `resolveBundledWorkspaceZCodeAgentCommand` (the bundled
  `apps/zcode-cli/packages/cli/dist/zcode.cjs` run under node with
  `app-server --stdio`, else the `ZCODE_AGENT_SERVER_COMMAND` binary); when it
  resolves the channel registers, otherwise it stays unregistered and fails
  loudly at the call site rather than as a broken stub. The channel-count test
  now treats `PORTED_CHANNELS` as a floor (a conditional channel may add one),
  keeping the per-channel `contains` check as the real pin. The channel serves
  `listSessions` (`session/list`), `readSession` (`session/read`),
  `createSession` (`session/create`) and `resumeSession` (`session/resume`) —
  the core session lifecycle on the agent client, with the workflow/tool-surface
  flags delivered only when true (the TS grayscale shape). `readSessionMessages`
  (`session/messages`) and `readSessionDebug` (`session/debug`) are also served
  (read-only, map cleanly), as are `listSessionSubagents`
  (`session/subagents`) and `getAppUsageStats` (`v4/usage/stats`, answered by
  any connected workspace client since the usage store is global), plus the
  `onDynamicSessionEvent` subscription (`session/subscribe` → replay events +
  snapshot, then live `session/event` notifications routed per session and
  deduped by `eventId`; the background-summary coalescing is an optimization and
  is deferred, dedup is kept because a duplicate timeline event is a silent
  wrong answer), and `sendConversationCommand` (the chat send: a plain
  `sendText` envelope is forwarded to `v4/command` and the `CommandAck`
  returned; the automation/off-peak dispatch tool-denylist merging at the
  envelope boundary is now implemented faithfully (`automationToolPolicy`: an
  automation run denies the Cron mutation tools, an off-peak dispatch denies
  OffPeakCreate; idempotent union), verified by a test asserting the exact
  merged denylist reaches the agent — a wrong denylist would silently drop a
  tool, so the merge is exact rather than guessed). The
  cross-version
  compat-retry (an old app-server's strict schema) is deferred and documented:
  the desktop host runs a matching `zcode-cli`, so the schema matches and the
  retry path is not exercised. Still open in rung 6: the remaining typed
  `zcode-agent`/`zcode-session` surfaces (subagents, messages, debug), and the
  owner/lease + stale-run protection of the session runtime.
- **Rung 4 gap closed (`file` workspace-index)**: the `file` channel's
  workspace-index/search surface is now served. `workspace_index.rs` ports the
  columnar pack/unpack codec (`type\trelativePath`, `\\`/`\t`/`\n` escaped) and
  the fuzzy top-K search (name/relativePath/path tiers, `(score, index)` strict
  order, binary-search insertion) from `@zcode/shared`. The file channel builds
  the index exactly like `fileService.ensureWorkspaceFileIndex`: zcode-fs
  `walk_workspace` (gitignore matching in Rust) + `ignore_rules::load` →
  sort (directories first) → pack, cached by the `.zcodeignore` fingerprint.
  Served: `searchWorkspaceFiles`, `listWorkspaceFilesLength`,
  `listWorkspaceFilesRange`, `read/write/applyWorkspaceFileSearchIgnore`.
  Verified by a test that walks a real dir (a `.zcodeignore`d `node_modules`
  is excluded), fuzzy-searches `alpha.txt`, and range-fetches the packed
  index. The only remaining `file` gap is `readFileRange` (top-level binary —
  needs a zcode-codec binary-serialization extension).
- **Rung 4 gap closed (`file.readFileRange` binary)**: the `file` channel is now
  complete. `zcode-codec` gained `serialize_binary` (the `Buffer` type tag +
  raw bytes — the raw byte channel); the rpc-server `Response` carries an
  optional `binary` payload encoded instead of JSON, and the `ChannelHandler`
  trait gained an optional `call_binary` (default `None`, so the other handlers
  are untouched) that `on_promise` tries before the JSON `call`. The file
  channel implements `call_binary` for `readFileRange` → `reads::read_range`,
  returning the top-level bytes the client decodes as a `Uint8Array` (never a
  JSON+base64 object it would mis-decode). Verified by a test reading bytes
  2..6 of a real file and asserting `call_binary` answers only `readFileRange`.
  **Rung 4 `file` channel is fully served.**

- **Rung 2 — `onboarding-record` channel (first real rung-2 channel)**: the module
  `services/onboarding_record.rs` was a **38-line placeholder** that answered every method
  with `onboarding-record.<method> is not implemented by the Rust host` while still being
  counted in `PORTED_CHANNELS`. It is replaced by the real service, transcribed from
  `packages/services/src/onboarding/onboardingRecordService.ts` and the zod schemas in
  `packages/shared/src/onboardingRecord.ts`.
  - **Owner / state.** One owner for `{appConfigDir}/onboarding-record.json`:
    `OnboardingRecordService`. In-process writes are serialised by a `Mutex` — the TS
    `writeQueue`, so an `appendRecord` racing a `shouldOnboard` cannot lose a record.
    Cross-process writes take `with_file_lock` and land through
    `atomic_write_private_text_file`, which is the same protocol as the TS
    `atomicWriteText` default (`${file}.lock` directory of `owner-*.json`, temp + rename).
    Reads are lock-free and lock-free reads see either the old or the new file, never a
    half-written one.
  - **Schema parity (the reason this needed care).** The zod object schemas *strip*
    unknown keys, make every key **required** (a missing key is a parse error even when the
    field is `.nullable()`), enforce `min(1)` and the two enums, and emit keys in **schema
    shape order** — so `JSON.stringify(file, null, 2)` has a fixed key order regardless of
    how the caller built the object. The Rust types therefore: derive `Serialize` with the
    fields declared in the zod shape order (`version, deviceMid, entries, decisions` and
    `userId, occupation, interfaceMode, proactiveSuggestionsEnabled,
    completedAt, uploadState`), validate through a manual `Deserialize` over an
    all-`JsonValue` raw struct (a `JsonValue` field is what makes a *missing* key an error —
    `Option<T>` would silently accept it as `null`), and re-serialise with
    `serde_json::to_string_pretty` (2-space, no trailing newline — the same bytes as
    `JSON.stringify(_, null, 2)`). The v1/v2 file union is dispatched on the `version`
    literal with v1 first, exactly like `z.union([v1, v2])`, and a v1 file is normalised to
    `version: 2` with `decisions: []` (a `decisions` key present on a v1 file is dropped,
    because zod's v1 object strips it before the transform spreads it).
  - **Dependencies are both native, and both are shared rather than duplicated.**
    `loadUserId` reads the credential store — `oauth:active_provider` →
    `oauth:{provider}:user_info`, taking `.id` from the normalized profile shape or, for
    `zai`, from the raw backend shape (`user_id`, guarded by the same
    "name and email empty and id unknown ⇒ no profile" rule). It runs on **the same
    `CredentialService` instance** the `credential` channel serves, not a second copy.
    `hasExistingLocalTask` runs `listTaskMetas({})` (a full query, no scope, no deleted
    rows) on **the same `ZCodeTaskService` connection** the `zcode-task` channel serves
    (new `ZCodeTaskService::has_any_task`).
  - **Registration is now conditional**, like `credential` and `zcode-task`: if the cipher
    key cannot be derived or the task index cannot open, `onboarding-record` is *not*
    registered and the host logs why. An unregistered channel fails loudly at the call site;
    a registered stub that answers `not implemented` is what the placeholder did.
  - **Deliberate, documented non-port (not a fallback):** the OAuth *corrupt-session clear*
    that TS performs when a credential fails to decrypt (`clearCorruptOAuthSession` →
    `clearProvider` for every provider + `delete active_provider` + the
    `onCorruptOAuthSessionCleared` callback that deletes derived model-provider keys) is
    **not** run here. A partial clear would itself be a fork — TS clears the derived keys
    too, through a Node-only wiring. The immediate value matches TS (`null` = not signed
    in) and a `tracing::warn` records the decrypt failure; the clear lands with rung 7's
    oauth plane.
  - **File mode:** `atomic_write_private_text_file` creates the record 0600 where the TS
    `writeFile` used the umask (0644). Not observable through the JSON contract and read
    back by the same user only; the private-file discipline is the shared one.
  - **Input contract:** `deviceMid` is required to be a string. The typed client always
    sends one (`platform.getDeviceId()`); the TS original would have written a file with
    `deviceMid` omitted by `JSON.stringify` and made the next read treat it as corrupt,
    which is not worth reproducing at an untyped boundary.
  - Verified by tests in the module: byte-parity round trip against a fixture produced by
    the real zod schemas (decode → encode is the identical file), append/overwrite-per-user
    and `deviceMid` mismatch keeping the file's own value, corrupt/missing/missing-key reads
    returning `null`, the v1 → v2 normalisation, `shouldOnboard`'s three branches (identity
    record ⇒ false, no local task ⇒ true, existing local task ⇒ false + `existing_local_user`
    decision written), `claimAnonymousRecord` rewriting (not copying) the anonymous entry,
    `dismissOnboarding`, `getLatestEntry` / `syncSettingsFromRecord` (unknown occupation ⇒
    `other`, `null` preference ⇒ `false`), `updateRecordPreferences` writing back only the
    last matching entry, and `clearRecords`.
  - **Still open in rung 2:** `client-scenes` and `client-config` remain loud-error
    placeholders (they are counted in `PORTED_CHANNELS` but serve nothing). Both are the
    network plane — endpoint origin resolution + the api client + `readApiJson`, and for
    `client-config` the `parseClientConfigSnapshot` zod schema plus a 60 s TTL cache with
    in-flight dedup — and are the rest of this rung.

- **Rung 6 — `prompt-attachment-transfer` channel**: registered against `RpcHost::new` and
  counted in `PORTED_CHANNELS` (16 → 17). The host serves the **local** transfer service
  (`createLocalPromptAttachmentTransferService`, the only one `createLocalServices` ever
  registers — `node.ts:2617`; the remote staging wrapper is client-side in
  `packages/client/src/remoteServiceAccess.ts` and talks to the *remote* host's own local
  service).
  - **What the local service actually is:** a zero-copy pass-through. `stage` answers
    `{operationId, ref: localPath, bytes, staged: false}` — `bytes` is the caller's own
    `sizeBytes` when it is a number `> 0`, otherwise `stat(localPath).size`, otherwise `0` if
    the file cannot be stat'ed. `adopt`, `cancel` and `cleanup` are no-ops. It **never
    emits progress**: the `Emitter` it hands out is created per `operationId` and nothing in
    the file ever fires it. The renderer only subscribes/calls `stage` for a *remote*
    attachment target (and a `staged: false` answer there is the loud
    `RemoteAttachmentNotStagedError` the client already raises) — for a local target
    attachments are `localZeroCopy` and skip staging entirely.
  - **The subscription is a real subscription that never fires**, which is the same fact the
    TS emitter expresses: `subscribe("onDynamicProgress", arg = operationId)` returns a live
    receiver held in a per-operation map, so the rpc-server's pump stays up exactly as the JS
    listener does, and no frame is ever sent because no progress is ever produced. Returning
    `None` instead would have been indistinguishable to the client but would have logged a
    misleading `listener for an unknown event` for a listener that *is* known.
  - **Sender lifetime:** only `cleanup` releases the sender, which ends the pump. `adopt` and
    `cancel` are faithful no-ops, because they are no-ops in the Node original
    (`packages/services/src/prompt-attachment-transfer/promptAttachmentTransferService.ts:39-41`
    — `async adopt() {}`, `async cancel() {}`, `async cleanup() {}`); an earlier draft of this
    spec claimed `cancel` also released, which was wrong. A cancelled operation therefore keeps
    its pump alive until `cleanup` or the connection ends. The rpc-server gives native handlers no
    `on_dispose` hook (only the Node-forwarding fallback path takes one), so a subscription
    whose operation is never cleaned up keeps its sender until the connection ends — the same
    bound as `file-watcher`'s per-watcher subscriber list.
  - **Input contract:** `stage` requires `operationId` and `localPath` to be strings and
    errors otherwise. The TS original would have returned `ref: undefined`, which
    `JSON.stringify` drops — a result object with no `ref`, which the caller then stores as an
    attachment reference. A missing path is a contract violation, and failing it loudly is
    better than handing back a `ref` that names nothing.
  - Verified by tests: the stage result for a real file (bytes from `sizeBytes`, from
    `stat`, and `0` for a missing path), `staged` always `false`, `adopt`/`cancel`/`cleanup`
    answering `null`, an unknown event name subscribing to nothing, and an operation-scoped
    `onDynamicProgress` subscription that exists but delivers no frame.

