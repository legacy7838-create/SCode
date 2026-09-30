# @zcode/dynamic-workflow-runtime

Sandbox harness (dynamic workflow execution engine). Run a workflow script in a controlled sub-process,
Use NDJSON to bridge the child process's `__host.*` calls to the pure engine core of `@zcode/dynamic-workflow`.

## Dependency boundaries

**Only** depends on `@zcode/dynamic-workflow` (workspace) and node builtins. **Never** import `@zcode/core` /
`@zcode/contracts` / `@zcode/bootstrap` / `@zcode/adapters`——This package is "the entire sandbox↔engine"
Proof that the pipeline is “app-free and runnable”.

## Usage

```ts
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";

const settlement = await runWorkflowScript({
  scriptText, // or lowered: <async function body>
  caps: { maxConcurrency: 16 },
  askSpecs, // site id ∈ synthesized schemas record is typed
  validate, // @zcode/dynamic-workflow's validate (adapted to ValidateFn)
  makeDriver: (sink) => driver, // driver comes with journal + emit; sink is the upward return surface of the engine
  signal, // optional: AbortSignal
  timeoutMs, // Optional: wall clock timeout
});
// settlement: { status: "completed", artifact } | { status: "failed", error } | { status: "cancelled" }
```

## Architecture

```
┌─ parent (harness) ──────────────┐  NDJSON  ┌─ child (vm.createContext) ──────┐
│ runWorkflowScript │ stdio │ only ES intrinsics + __host │
│ - lower(scriptText) │◀────────▶│ createActor returns local handle synchronously │
│ - WorkflowEngine(driver,...) │ │ ask/worldRead → Request the parent process │
│ - Bridge __host.* ↔ engine │ │ args freezes the global (crosses the boundary once when spawning) │
│ - spawn/kill/timeout/abort │ │ Date.now/Math.random runtime ban │
└─────────────────────────────────┘          └──────────────────────────────────┘
```

## NDJSON wire protocol

See `src/protocol.ts` (single source of truth). child→parent: `create-actor` (fire and forget) / `request` (ask,
world-read) / `event` (log) / `complete`; parent→child: `response`.

## Build order

Testing and typecheck pass `@zcode/dynamic-workflow`’s **built dist** to resolve dependencies, so `pretest` /
`pretypecheck` will first `pnpm --filter @zcode/dynamic-workflow build`. Just run a new checkout with `pnpm test`.
Won't step on stale-dist.

## Failure Judgment and Choices

- The decision of run belongs to the engine. Termination failure (script error/child process crash/timeout/protocol damage) are all called
  `engine.fail(error)`——Settlement `failed`, driver side cancellation on fly ask, journal record `dwf_run.status =
  "failed"` + `failure_json`, journal is consistent with the result seen by the caller. The abort signal is the only "true cancellation",
  Call `engine.cancel()` (settlement `cancelled`, can be resumed). The first-wins finalize on the harness side only takes care of
  Child process cleanup (clear timer, turn off stdin, kill child), do not create settlement by itself.
