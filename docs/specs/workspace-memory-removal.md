# Spec: Workspace Memory removal

Status: active. Owner: main session. Written before the edit, per `AGENTS.md:3`.

## Why

The product no longer ships Project/Workspace Memory. The settings page offers no control for
the `memory` RPC service, the onboarding no longer offers it, and the CLI no longer carries the
memory agent. This spec deletes that feature rather than leaving a UI-visible/feature-flag
switch behind, matching how the repo removed browser/computer-use/hooks/plugin settings pages
(see the `docs/specs/settings-section-*-removal.md` family) and the `WSL` feature before it
(see `docs/specs/remove-wsl.md`).

## What is removed

1. **Settings UI** — `packages/ui/src/settings/MemorySettingsSection.tsx` and its import /
   render in `packages/ui/src/SettingsPage.tsx`, including the `memoryEnabled` from shared
   settings read there and the `updateRecordPreferences({ memoryEnabled })` call. Any Settings
   copy that describes "Workspace Memory" (the i18n strings in
   `packages/ui/src/i18n/locales/en-US.ts`) goes with it; the `ProactiveSuggestionsSetting`
   surface is untouched.
2. **The scanner/reader service** — `packages/services/src/memory/**` (`memory.ts`,
   `memoryService.ts`, `projectMemoryStableRead.ts`) plus `ServiceChannels.Memory` in
   `packages/shared/src/channels.ts`, the `IMemoryService` accessor in
   `packages/services/src/accessor.ts` and `index.ts`, the `createMemoryService()`
   registration in `packages/services/src/node.ts`, the `memoryService` proxy in
   `packages/client/src/remoteServiceAccess.ts`, and all occurences in
   `packages/services/src/index.ts`.
3. **Onboarding** — the `memoryEnabled` question: the `memoryEnabled` field of
   `OnboardingRecordEntry`/`OnboardingRecordEntryInput` in `packages/shared/src/onboardingRecord.ts`,
   the `memoryEnabled` entry in the record schema comment in `onboardingRecordService.ts`
   (reads work because the record file stores the key but zod strips it — an old record still
   loads), the occupation wizard toggle in `OccupationOnboarding.tsx`, and
   `syncSettingsFromRecord()`'s `memoryEnabled` patch key. The persisted v2 schema keeps its
   version number so pre-existing `onboarding-record.json` files remain valid — their now-unknown
   `memoryEnabled` keys are stripped on read.
4. **Session envelope** — the `memoryEnabled` ack field carried from the agent to the UI:
   `packages/ui/src/v4/SessionPane.tsx`, the v4 command/telemetry contracts in
   `packages/shared/src/zcode-protocol-v4/*` and `packages/shared/src/*`, the agent-side
   `packages/services/src/zcode-agent/zcodeAgentService.ts`, and every telemetry emitter in
   `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` plus the CLI contract in
   `apps/zcode-cli/packages/contracts/src/telemetry/*`.
5. **Shared settings schema** — `memoryEnabled` in the app-settings schema
   (`packages/shared/src/validationAppSettings.ts`) and every writer/reader of it.
6. **CLI config layer** — `features.memory` and the whole `config.memory.*` block:
   `apps/zcode-cli/packages/adapters/src/config/{index,config-merger,schema}.ts`,
   `ConfigKey.FeatureMemory`/`ConfigKey.MemoryUse` and the memory keys in
   `apps/zcode-cli/packages/contracts/src/config/index.ts`, the `DefaultConfig` entries, the
   `AgentRuntimeConfig.memory` + `MemoryRuntimeConfig` types in
   `apps/zcode-cli/packages/core/src/runtime/types.ts`, and every
   `runtimeConfig.memory?.…` reader (`bootstrap/src/app/{create-app,paths,runtime-config}.ts`,
   `zcode-protocol/*`, `server-operations.ts` master-switch).
7. **The agent-side memory feature** — the context injection and the extraction pipeline:
   `apps/zcode-cli/packages/core/src/context/sections/memory.ts`, the `buildMemorySection`
   call in `context/builder.ts` (and the index's re-export),
   `context/sections/request-user-context.ts`'s memory reference,
   `core/src/runtime/helpers/project-memory*.ts`, the `memory/` subtree (`memory-agent-loop`,
   `extraction`, `index-content`, `project-root`, `memory-file-path`, `directory`, `recall/**`,
   `origin-session`), and every invocation/call site in `runtime/{agent-runtime,internal,internal-methods,methods/*}.ts`
   and `create-app`/`server-operations` where the extraction agent and the persistent-memory
   prompt were scheduled. The system prompt therefore never mentions a memory directory
   again, and no `~/.zcode/cli/memories` write is triggered.
8. **Prompt-command reference** — the `--memory-bench` flag is **removed entirely**
   (`arguments.ts`, `run.ts`, `GlobalOptions`, and the `i18n` help block). An earlier draft of
   this spec said the flag was kept; it was not. Removal fails loudly, which is the intended
   behaviour: `node:util` `parseArgs` is strict, so `--memory-bench` now throws rather than
   silently doing nothing.
9. **A related helper** — `resolveEnabledProjectMemoryRoot`/`isMainMemoryTaskType` helpers are
   deleted; `core/src/index.ts` re-exports of the `memory/` module are removed;
   `MemoryRuntimeConfig` is **kept** — it is the config gate for *subagent* persistent memory
   (`AgentProfile.memory: user|project|local`, `features.memory`, `memory.use`), which this
   removal deliberately does not touch. An earlier draft of this spec contradicted itself on
   this point; the kept state is the intended one.

## What is NOT removed / kept

- **`core/src/subagent/persistent-memory*.ts` and the `MemoryRuntimeConfig` it needs** — a
  subagent profile may opt into *its own* persistent memory under `.zcode/agent-memory*`
  (per-profile `memory: "user" | "project" | "project-local"`). That is a different product
  surface and it **keeps working**: the requirement is that subagents are unaffected by this
  removal. Consequently these stay, even though Project Memory shares their plumbing:
  - `core/src/memory/directory.ts` (`ensureMemoryDirectoryExists`) and
    `core/src/memory/index-content.ts` (`formatMemoryIndexContent`) are retained; only their
    Project-Memory exports (`formatProjectMemoryIndexContent`) go.
  - `MemoryRuntimeConfig` and `AgentRuntimeConfig.memory` stay, because the subagent gate reads
    `memory.enabled`, `memory.use` and `memory.storageRoot` (`isPersistentAgentMemoryEnabled`).
    Removing them would silently disable persistent memory for every subagent.
  - `ConfigKey.FeatureMemory` (`features.memory`), `ConfigKey.MemoryUse` (`memory.use`) and
    their defaults stay as that gate's inputs; nothing in the CLI reads them for Project Memory
    any more.
  - `projectPersistentAgentMemoryTools` / `loadPersistentAgentMemory` are untouched.
- The `~/.zcode/cli/memories` files already on disk stay; nothing reads or writes them.
- The Rust Tauri port never implemented Project Memory (no `memory_channel.rs` exists), so
  there is no native code to delete; the accidentally started spec row was reverted.
- `proactiveSuggestionsEnabled` stays — it is a different toggle.

## Acceptance gate

- `grep` for the feature tokens (`FeatureMemory`, `features.memory`, `config.memory`,
  `runtimeConfig.memory`, `memoryEnabled`, `memoryExtractionEnabled`, `memoryUse`,
  `IMemoryService`, `memoryService`, `createMemoryService`, `resolveEnabledProjectMemoryRoot`,
  `buildMemorySection`, `~/.zcode/cli/memories`, `MEMORY.md` outside specs/docs, `memory-bench`,
  `MEMORY_ROOT`, `projectMemory`) returns zero hits outside this spec and existing tests marked
  for deletion in the same change.
- `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm architecture:check --changed` (0 new
  violations), and the CLI build (`node apps/zcode-cli/packages/cli/scripts/build.mjs`) all
  pass.
- The remaining agent flow does not inject a memory section into the system prompt (grep the
  built `context/builder` output path in a render test).
