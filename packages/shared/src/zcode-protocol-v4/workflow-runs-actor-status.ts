// ============================================================
// **Derivation** of actor three-state (a rule for workflowRuns reduction)
// ============================================================
// Pure function, deduced only from node and run status, does not read the clock or perform I/O.
//
// Why it must be derived: The engine's Boundary C does not emit any actor life cycle events except `actor-created`,
// Therefore, "Is this subagent moving, waiting, and finished?" There is no event to move, and it can only be determined by the phase of the node under its name and the run
// The final state is derived. This function must be re-run after each event that changes nodes or run.status.

import type { WorkflowRunActor, WorkflowRunState } from "./workflow-runs.js";

/**
 * Keys are joined with `\0` rather than any printable character: siteId is a string the engine
 * supplies, so a separator like `-` would make ("a-1", 2) collide with ("a", "1-2"). (In the
 * source this is written as the escape `\0` rather than a raw NUL byte — the same runtime
 * string, but the file is no longer a binary blob as far as grep is concerned.)
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

/**
 * The three-state derivation:
 *   running   a node is executing / repairing / nudged (the model request has been issued and
 *             is in flight)
 *   waiting   a live node exists (queued / dispatched / waiting), or there is no node at all yet
 *             and the run is not terminal
 *   completed everything else: all nodes have settled, or the run is terminal (terminal wins
 *             outright: nobody in a terminal run is still running or waiting, even if some
 *             node's settled event has not landed yet)
 * `dispatched` counts as waiting, not running: it is the brief "session ready, first request
 * not yet admitted" phase — node-executing is what says something is really running.
 *
 * Actors whose status did not change keep their **reference** — the key-level delta first asks
 * "did this one change?" by reference, and building a fresh object here every time would make
 * every node event ship the whole actors table back onto the wire.
 */
export function withDerivedWorkflowActorStatuses(run: WorkflowRunState): WorkflowRunState {
  const executing = new Set<string>();
  const live = new Set<string>();
  const owned = new Set<string>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    owned.add(key);
    switch (node.phase) {
      case "executing":
      case "repairing":
      case "nudged":
        executing.add(key);
        break;
      case "queued":
      case "dispatched":
      case "waiting":
        live.add(key);
        break;
      default:
        break;
    }
  }
  const runLive = run.status === "pending" || run.status === "running";
  return {
    ...run,
    actors: run.actors.map((actor) => {
      const key = actorKey(actor.siteId, actor.ordinal);
      const status: WorkflowRunActor["status"] = !runLive
        ? "completed"
        : executing.has(key)
          ? "running"
          : live.has(key) || !owned.has(key)
            ? "waiting"
            : "completed";
      return actor.status === status ? actor : { ...actor, status };
    }),
  };
}
