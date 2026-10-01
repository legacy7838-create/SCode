# Spec: remove the WSL remote-workspace backend

Status: active. Owner: main session. Written before implementation, per `AGENTS.md:3`.

Removes WSL as a `RemoteTarget` kind, end to end. Requested by the user after the Rust port
surfaced that the WSL column parser was untested and broken (`CUTOVER_SPEC.md` §8.7); the port made
the cost of keeping it visible, and the decision is to drop the feature rather than fix it.

**Windows stays reachable over SSH.** PowerShell/WinRM is *not* a replacement here — a WSL distro is
a Linux environment reached from Windows, whereas PowerShell is a different remote kind needing its
own auth, transport and command-execution semantics. This removal deletes a kind; it does not
substitute one.

## 1. Scope

Measured 2026-10-01, excluding `node_modules`, `dist`, `target`, and lockfiles: **939 matches across
130 files**.

| Area | Files | Note |
| --- | --- | --- |
| `packages/ui` | 40 | distro pickers, connection-step copy, i18n strings |
| `packages/shared` | 17 | **foundation** — `RemoteTarget` union, `WSLDistro`, `listWSLDistros` |
| `packages/desktop` | 17 | Electron `wslProxy`/`wsl-detect` equivalents |
| `packages/server` | 15 | `wsl-backend.ts`, `wsl-detect.ts`, `wslProxy.ts`, `create-backend.ts` |
| `apps/zcode-cli` | 13 | protocol + adapters; deferred as a *port target*, but it consumes `RemoteTarget` so it must still compile |
| `packages/services` | 10 | zcode-agent remote wrappers |
| `apps/zcode-tauri` | 7 | `list_wsl_distros` command, `WslDistro`, `parse_wsl_distro_list` |
| `packages/rpc`, `web`, `rust`, `client`, `zcode-server-cli` | 6 | thin re-exports |
| docs / README / NOTICE | 4 | cleaned per `AGENTS.md` |

This contradicts the earlier "UI and `apps/zcode-cli` are out of scope" constraint for the Rust
programme. That constraint exists because `packages/ui` cannot host native code (invariant 9); it is
not a reason to leave a deleted backend wired into the UI. The two constraints were reconciled by
the user, who was shown this blast radius and confirmed the removal.

## 2. Product rule

`RemoteTarget` becomes `SSHConnectOptions`. The union has one member, so it is kept as a named type
rather than inlined — it is referenced across every layer, and a named alias means the rest of the
codebase keeps compiling unchanged while the second variant disappears.

Nothing becomes a fallback. There is no `try { wsl } catch { ssh }`: a persisted WSL remote target
fails to validate, which is the correct outcome for a removed kind.

## 3. Order

Leaves first, so each step is typechecked before the next.

1. `packages/shared` — the union, `WSLConnectOptions`, `WSLDistro`, `listWSLDistros`.
2. `packages/rpc`, `client`, `web`, `rust`, `zcode-server-cli` — thin re-exports.
3. `packages/services`, `packages/server` — backend selection, deploy, proxy.
4. `packages/desktop` — Electron-side WSL detection/proxy.
5. `apps/zcode-tauri` — delete `list_wsl_distros` from `generate_handler!` and the WSL parser.
6. `apps/zcode-cli` — protocol and adapters.
7. `packages/ui` — distro pickers and copy.
8. Docs, `README.md`, `NOTICE.md`.

### 3.1 Progress — typecheck is GREEN; only comments and i18n remain

`pnpm typecheck` reports **0 errors**. The WSL backend is gone from every executable path.

**The final stretch, this session:**

| Area | What |
| --- | --- |
| `desktop/host/windowRemoteConnectionRegistry.ts` | The whole WSL workspace-restore path. `startWorkspaceRelease` collapsed to returning the in-flight promise; `requestWorkspaceRelease` and `scheduleWslIdleDispose` deleted along with their five call sites; `prepareWorkspaceRuntime` reduced to marking the session ready; the `kind === "wsl"` idle-dispose arms and the WSL-only running-task bookkeeping loop removed; `buildConnectionKey` collapsed to its SSH arm. |
| `desktop/host/index.ts` | `resolveDesktopRemoteRuntimeNetwork` deleted (it only resolved the WSL host gateway), its argument now explicitly `undefined` |
| `apps/zcode-tauri` | `list_wsl_distros`, `WslDistro`, `decode_wsl_output`, `parse_wsl_distro_list`, the `WSL_CACHE`, `RemoteTarget::Wsl`, the WSL validation arm, the three WSL tests and the `list_wsl_distros` registration all removed; `tauriPlatform.ts` lost the member. This also removed the `"a l p h a"` parser that had three failing tests. |
| `server/remote/zcodeAgentWrapperDeploy.ts` | `isWslBackend` deleted — it read `backend.kind === "wsl"` and could only ever be `false` — plus the byte-by-byte upload branch and the two deploy guards that called it |
| Dead files | `shared/src/wslUserValidation.ts`, `ui/src/lib/wslUncWorkspace.ts`, `desktop/src/main/desktopWslTargetResolver.ts` deleted, and their `validation.ts` re-exports removed |

**No dead branch was left behind.** Each removal was the stronger option rather than the cheaper one:

- `useTaskListItemContextActions.ts` and `useRemoteWorkspaceHistory.ts` changed **behaviour**, not just shape — the WSL-only escape hatches are gone, so remote workspaces now fail closed to the local file manager and persist failures immediately. Keeping the old guards would have been a fallback.
- `desktop/host/windowRemoteConnectionRegistry.ts` lost a whole per-workspace runtime (generation counter, context, release wait) that only ever ran for WSL. Leaving it would have been unreachable code, not a working path.
- `resolveWorkspaceFileManagerEditor` and `resolveDesktopRemoteRuntimeNetwork` could each only return `null` / `undefined` afterwards, so they were deleted rather than kept as always-false shims.

**Still present, deliberately:** comments, i18n message strings (`wsl.*` keys in `ui/src/i18n/locales/`), telemetry enum values (`remote_kind: "wsl"` in `sessionCreateTelemetry.ts` / `rendererActionTrace.ts`), the `remoteUsageTelemetry.ts` error regex, the `TID_REMOTE_KIND_WSL` / `TID_WSL_DISTRO_SELECT` / `TID_WSL_USER_INPUT` test ids, `README.md` ("Remote Features (SSH/WSL)"), `NOTICE.md`, and the `zcode-cli` protocol/adapters. None of these is reachable behaviour — they are data and docs. The telemetry enums and test ids should go in the same pass as the i18n keys, so an analytics dashboard does not keep reporting a kind the app can no longer produce.

## 4. Risks

- **R1 — a persisted WSL remote target already exists in users' settings.** Removing the kind makes
  those entries invalid on load. The failure must be a clear validation error, not a silent
  downgrade to SSH, because the two are not equivalent (no host, no user, no port).
- **R2 — `stripRemoteTargetSecrets` had a second branch for the non-SSH variant.** Removing the
  variant makes the `if` dead and the function collapses to the SSH destructuring. It must not be
  deleted: it is still load-bearing for `password` / `privateKeyPassphrase`.
- **R3 — i18n strings.** The removal deletes message keys; stale keys in locale files are invisible
  to the compiler and will surface as raw IDs at runtime. Locales are cleaned in step 7.
- **R4 — scope creep into the Rust programme.** This spec removes a feature. It does not port
  anything new, and `zcode-wsl` must not appear as a crate.