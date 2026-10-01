## Core Principles

- Before adding or modifying behavior, update the corresponding spec first; create directories as needed. Define product rules, state owners, interfaces, and acceptance scenarios before implementing code.
- Base work on the currently checked-out source code, `package.json`, and architecture policy. Only retain features, commands, and files provided by the current repository in documentation; when removing features, clean up references in instructions and skills accordingly.
- When diagnosing issues, investigate the root cause first unless code changes are explicitly requested. Use source code, logs, and runtime evidence to distinguish confirmed causes from hypotheses to be verified.
- Preserve local changes unrelated to the task; do not restore removed modules or internal dependencies on your own.

## Commands and Repository Structure

Run `node scripts/check-workspace-freshness.mjs` before starting work to check the baseline. Node version is governed by `mise.toml`.

The following commands are run from the repository root:

| Purpose               | Command                                              |
| --------------------- | ---------------------------------------------------- |
| Type checking         | `pnpm typecheck`                                     |
| Lint                  | `pnpm lint` / `pnpm lint:fix`                        |
| Format checking       | `pnpm fmt:check`                                     |
| Desktop development   | `pnpm dev:desktop` (= `pnpm dev:tauri`)              |
| Web development       | `pnpm dev:web`                                       |
| Pre-commit check      | `pnpm verify:pre-push` (Lint and architecture check) |
| Architecture check    | `pnpm architecture:check --changed`                  |
| Module reading pack   | `pnpm architecture:context <module-id>`              |
| Unused deps & exports | `pnpm knip`                                          |
| Export ref query      | `pnpm dep:refs --list-exports <file>`                |

Test entry points are based on the target package's current `package.json` and actual test files; do not assume a unified unit test or E2E command exists.

- The desktop app is `apps/zcode-tauri` (Tauri). `packages/desktop` — the Electron main, host and renderer — was deleted; there is no Electron left in this repository, and no JavaScript fallback may be introduced in its place.
- `packages/web`, `packages/server`: Web client and server.
- `packages/ui`: Shared React components, hooks, and Zustand store.
- `packages/services`: Business services; `packages/rpc`: RPC framework.
- `packages/shared`: Shared protocol and types; `packages/client`: Agent client SDK.
- `apps/zcode-cli`: Agent CLI and runtime.
- `CONTEXT.md`: Plugin store domain vocabulary; read before modifying related UI.
- `DESIGN.md`: UI design specification; read before modifying UI.

## Implementation and Verification

- Code changes use `.agents/skills/architecture-governance/SKILL.md`; run the architecture check first, then read the target module's controlled context.
- Avoid duplicate state and multiple write paths. Define the sole owner, interfaces, dependency direction, event ordering, and idempotency boundaries; do not mask synchronization issues with timeouts.
- When behavior changes, add corresponding tests first; interaction changes require E2E scenarios. Check that tests match implementation, and actually run available verifications. Report honestly when not executed or when environment is constrained.
- When fixing bugs, add Chinese comments explaining the reason and fix rationale. When design flaws are discovered, align with users first; do not keep adding fallback branches.
- For solutions involving state, timing, remote, or asynchronous synchronization, use diagrams to show owners and event ordering.
- Must run `pnpm typecheck` and `pnpm lint`; report actual results, do not report existing failures as passing.
- Use async file and network IO; cross-package imports use public entry points, respecting existing path aliases.
- UI must not directly call Repo, Service referencing Runtime concrete implementations, cross-domain importing implementation details, or circular dependencies.

## UI and Platform Boundaries

- Follow `DESIGN.md`, reuse existing components, and account for both desktop and mobile web layout, interaction, theming, and internationalization.
- Components access services through `packages/ui/src/hooks/`; platform operations go through `IPlatformService` (`packages/shared/src/platform.ts`), not by calling `window.zcode` directly.
- Handle differences between Desktop, Web, local, and remote environments through dependency injection, accounting for Windows, macOS, and Linux.
- Zustand state is located in `packages/ui/src/store/`. Broadcast-synced fields like theme and language need loop prevention; UI local state should not be mistaken for server-side facts.
- Hooks containing JSX use `.tsx` extension.

## Process, Protocol, and Remote Control

- The Desktop app communicates with the Agent via stdio. Protocol changes must synchronously update `packages/shared/src/zcode-protocol/index.ts`, providing strict types and runtime validation.
- Main is responsible for windows, native operations, process scheduling, and message forwarding; it does not carry task/session business state.
- Each window uses one window-scoped Local Host; the local workspace shares that Host. Remote workspaces are managed by the connection registry within the window, without creating a separate Desktop Remote Host.
- Mobile remote control connects to the existing Host attachment on the desktop, reusing the session runtime; do not start a separate Agent, Local Host, or remote session for mobile.
- The Desktop `desktop-continuous` real-time link and the mobile `web-remote-replayable` recovery link must be clearly distinguished. When modifying stream, snapshot, queue, or reconnection, verify both semantics simultaneously.
- External relay and Main only handle authentication, pairing, heartbeat, forwarding, and attachment scheduling; they do not persist task queues, snapshots, or other business state.
- Accepted busy/running input is serially admitted by the CLI/runtime `CommandInbox`; the Renderer only keeps unsubmitted drafts and pending optimistic overlays, with Host owner/lease responsible for routing.
- Preserve owner/lease, cross-Host routing, and stale run protection; do not remove boundary checks based on a single path.

## Workspace Identity

- `workspaceIdentity` is used for identity isolation; `workspacePath` is used for file operations, command cwd, Git, and path display.
- The identity key is uniformly `workspaceIdentity?.trim() || workspacePath`, applicable to deduplication, binding, caching, queuing, persistence, and request association.
- Remote links must pass `workspaceIdentity` and `remoteSessionId` end-to-end; do not match by path alone.
- New interfaces retain the local path fallback; remote identity reuses existing construction and parsing tools; do not hand-write formats in business code.

## Logging

- UI uses `packages/ui/src/logger.ts`, not `console.log` or `window.zcode?.log` directly.
- Agent/session/runtime related service logs use `createServiceLogger(scope)` (`packages/services/src/logger/serviceLogger.ts`).
- `debug` is for high-frequency diagnostics such as protocol raw data, streaming chunks, and per-tool updates; not persisted in production.
- `info` is for production-available events such as process and session lifecycle, permission results, and one-time initialization.
- `warn` is for recoverable exceptions; `error` is for unrecoverable failures such as crashes, handshake failures, and authentication loss.
- Do not write credentials, real user data, or internal service addresses in logs, examples, or commits.
