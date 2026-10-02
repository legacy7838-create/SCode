# Spec: Window Host Controller availability

Status: active. Owner: main session. Written before the behavior change, per `AGENTS.md:3`.

## 1. Behavior in this repository

`IServiceAccessor.windowControllerService` is the Window Host list-projection and cross-source
routing surface (`packages/services/src/window-controller/windowController.ts`,
`ServiceChannels.WindowController`). Its only implementation lived in the Electron host
(`packages/desktop/src/host/windowHostControllerService.ts` + projection + sessions-index
observer + attachment/remote-connection registries) and was deleted with the Electron cutover
(`a55c2c2`). No current host registers the channel:

- `@zcode/server` / `packages/services/src/node.ts` → `createLocalServices` does not register
  `IWindowControllerService`.
- `apps/zcode-tauri` `generate_handler!` exposes the OS-window surface (`sync_window_tabs`,
  `sync_window_unread_count`, `get_window_state`), which is a different transport and does not
  carry task/session business state.
- `zcode-rpc-server` (Rust) registers no service channels yet.

`packages/client/src/remoteServiceAccess.ts` used to construct a `ProxyChannel.toService` proxy
for the unregistered channel unconditionally. Every `listTaskList` / `subscribeControllerV4`
therefore waited out the RPC deadline and was answered `Unknown channel`, and because the function
swallowed the failure the surface failed silently.

## 2. Rules

1. **No fabricated proxy.** `RemoteServiceAccess` leaves `windowControllerService` undefined when
   the host does not provide the channel; it never constructs a proxy that can only time out.
2. **No JavaScript fallback or stub.** The surface must not be reimplemented as a JavaScript
   stub, an "unavailable" no-op service, or a `try { native } catch { js }` branch. The zero-JS
   fallback rule of `rust-native-ports.md` / `rust-native-program.md` applies.
3. **Explicit unavailability.** Consumers read the optional accessor and follow their documented
   unavailable path: `useGlobalTaskList` keeps the last trustworthy list, reports the gap once,
   and never leaves a loading gate open; `useGroupedTaskView` keeps rendering from
   `zcodeTaskService` (tasks-index), losing only sessions-index activity enrichment.
4. **Single restoration point.** When a real Window Host Controller lands (native port or the
   service host's own implementation), the client proxy is restored in the same change, and only
   then. The renderer-side aggregation path (`useWorkspaceSessionsIndexItems`,
   `remoteTimelineTaskStore`, per-endpoint `zcodeTaskService.listTaskList`) stays authoritative
   for clients that build rows per endpoint.

## 3. Resolution (2026-10-02): consumers migrate to per-endpoint aggregation

The archived-list bug decided the open item: with no host registering
`ServiceChannels.WindowController`, every `useGlobalTaskList` query answered empty, so archiving a
task removed it from the sidebar while the archived view permanently showed "No archived tasks" —
an archive looked like a delete.

The chosen restoration path is the migration branch of rule 4, not a native Controller port:

1. **`useGlobalTaskList` aggregates per endpoint.** Each workspace scope resolves its own services
   (`resolveWorkspaceServices`, remote scopes to their endpoint's `zcodeTaskService`) and queries
   `zcodeTaskService.listTaskList({ kind, workspaceScopes: [scope], sortBy, search, limit })`.
   Results merge across scopes, sort by `compareZCodeTaskListItems`, and slice to the query limit;
   `total` is the sum of per-scope totals, `hasMore` is true when any scope reports more. This is a
   real query against the owning endpoint's tasks-index (Rust `zcode-task-index` SQLite for local
   scopes) — it is the documented authoritative renderer aggregation path of rule 4, not a
   JavaScript fallback: nothing simulates the Window Controller contract.
2. **Reactivity.** The hook re-queries on task-list version changes, remote-session rotation, and
   `workspace_task_list_changed` events from each resolved scope's `onDynamicWorkspaceEvent`.
3. **The Window Controller contract stays optional and unimplemented.** No proxy is fabricated
   (rule 1); `packages/ui/src/v4/windowControllerTaskListRegistry.ts` — the renderer-side registry
   that only existed to consume the missing controller — is deleted with its last consumer.
4. **Per-endpoint write paths are unchanged.** Archive/unarchive/pin/delete still go through each
   row's own resolved `zcodeTaskService`; the hook is read-only.

## 4. Out of scope (carried)

A native Window Host Controller port (projection + frame subscriptions + sessions-index observer)
or deleting the now unconsumed JS contract. If a host later registers
`ServiceChannels.WindowController`, this spec's rules 1–2 still govern the client surface.

## 5. Acceptance

- `rg "window-controller|WindowController" packages/client/src` shows no proxy construction.
- `useGlobalTaskList` builds every list from per-scope `zcodeTaskService.listTaskList`; archiving a
  task makes it appear in the archived view (and unarchive restores it) without any host-side
  Window Controller.
- `packages/ui/src/v4/windowControllerTaskListRegistry.ts` is deleted; no renderer file imports it.
- `pnpm typecheck`, `pnpm lint`, and `pnpm architecture:check --changed` stay green.
