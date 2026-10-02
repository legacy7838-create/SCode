# Spec: sessions-index restored-pane restore guard

Status: active. Owner: main session. Written before the behavior change, per `AGENTS.md:3`.

## 1. Scope

A workbench pane restored from persistence carries `restoredUnvalidated: true` until the
sessions-index of its own workspace confirms the bound session still exists. `PaneRestoredGuard`
(`packages/ui/src/v4/WorkbenchPane.tsx:204-259`) performs that verification by acquiring the shared
sessions-index store for the pane's scope and subscribing to it.

The subscribe path always uses `runtimePolicy: "existing-only"`
(`packages/ui/src/v4/agentSessionsIndexTransport.ts:116-151`) so that restoring N panes never spawns
N agent runtimes. When a workspace has no running runtime, the service rejects with
`ZCODE_AGENT_RUNTIME_UNAVAILABLE` and the store reacts in `handleRuntimeUnavailable()`
(`packages/ui/src/v4/sessionsIndexStore.ts:702-722`): it parks in `status = "dormant"`, clears the
projection, and holds `workspaceId === null`. No forward `available` lifecycle event ever arrives
for such a workspace (`agentSessionsIndexTransport.ts:220-245` filters events by `workspaceKey`), so
no further store emit is produced.

The guard previously settled **only** when `store.getState().workspaceId !== null`, which a dormant
store never reaches. A restored pane for a runtime-less workspace therefore stalled in
`restoredUnvalidated: true` forever and pinned the shared store's registry refCount. This spec
defines the settlement rule.

## 2. Product rules

1. **Two outcomes only.** Restore verification resolves to *confirmed* (strip `restoredUnvalidated`,
   keep the pane) or *missing* (a real snapshot arrived and the `sessionId` is absent, so the pane
   collapses). There is no third visible state.
2. **No-runtime is terminal-but-unconfirmed, not loading.** When the store reports `"dormant"` (or
   `"error"`) with no snapshot, the guard settles within a bounded grace window and **keeps** the
   pane. The timeout path resolves as *confirmed*; it never closes the pane.
3. **`"idle"` / `"connecting"` stay patient.** While the store is actively trying (or has not
   started), the guard reaches no verdict and starts no grace window.
4. **Dormant is distinguishable only via status.** `SessionsIndexStore.getState()` exposes
   `workspaceId` alone; the not-ready distinction lives in the public `getStatus()` accessor. The
   guard must read status, not infer from `workspaceId`.
5. **Never close on the timeout path.** `onMissing` stays reserved for the confirmed-absent case,
   because the primary pane cannot be closed (`paneLayoutTree.ts:344-355` is a no-op for
   `V4_PRIMARY_PANE_ID`) and would otherwise keep the flag set forever.

## 3. State owners and interfaces

- **Status owner:** `SessionsIndexStore.getStatus()` — public, returns
  `"idle" | "dormant" | "connecting" | "live" | "error"`. Status is intentionally not part of the
  state snapshot.
- **Grace-window owner:** the guard controller, created inside the pane effect and disposed with it.
  Not the store, not the registry. The store's dormant path deliberately schedules **no** retry timer
  (`sessionsIndexStore.ts:285-286`), and this change does not add one.
- **Re-run trigger:** the guard only re-evaluates on `store.subscribe` emits. For a runtime-less
  workspace the sole post-dormant emit is the dormant transition itself; the grace timer — not a
  lifecycle event — is the terminal backstop.
- **Interfaces unchanged:** no protocol change, no new transport method, no new store field. The
  settlement logic is extracted into a pure controller so it is unit-testable without React.

## 4. Out of scope

- No store-side retry timer or auto-restart on dormant.
- No closing of panes on the timeout path.
- No change to `useWorkspaceSessionsIndexItems` (its hydrating rule already treats dormant as
  settled).
- No JavaScript fallback: the touched files stay renderer TypeScript with no native/Node-only
  imports, per `rust-native-ports.md` invariant 9 and the renderer-graph gate.

## 5. Acceptance

- A restored pane whose workspace has no runtime clears `restoredUnvalidated` within the grace
  window and stays mounted with its `sessionId` intact.
- A restored pane whose session was genuinely deleted still collapses (`onMissing` unchanged).
- `"idle"` / `"connecting"` never settle prematurely and never start a grace timer.
- Unmount/dispose clears the pending timer; no callback fires after disposal, and repeated evaluates
  start at most one timer.
- `pnpm typecheck`, `pnpm lint`, and `node packages/shared/scripts/check-native-graph.mjs` stay green.
