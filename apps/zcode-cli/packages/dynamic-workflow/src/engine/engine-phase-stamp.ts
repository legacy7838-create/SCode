/**
 * Reading and stamping an instance's birth phase.
 * Both kinds of read share `instancePhases` (instance `siteId@ordinal` -> the phase name at birth):
 * filling in the phase for events, and filling in the phase for `ProviderStop` details.
 * The table is owned by the engine and written when an instance is created; this module only reads it.
 */

import type { RunEvent } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/** Instance key (`siteId@ordinal`) -> the phase name it was born in. A read-only view of the engine's `instancePhases`. */
export type InstancePhases = ReadonlyMap<string, string>;

/**
 * Fills in the birth phase for **birth events**: an actor's `actor-created` looks the table up by actor, a node's
 * `node-queued` by instance, and a cache-hit `node-settled { cached: true }` likewise by instance — a cache-hit
 * node has no queued, so that settle is its birth event. Every other event is **returned as-is**: the
 * scheduler's remaining emission sites are untouched, and the reducer carries forward following the
 * `actorSiteId` precedent.
 *
 * The `node-dispatched` of an ask is the one exception: it repeats its own birth fact (the same-named event in types.ts), so
 * both phase names are filled in here as well: `phaseName` by instance and `actorPhaseName` by its actor, both
 * lookups hitting the same birth table, so they are verbatim identical to that instance's `node-queued` and that
 * actor's `actor-created`. It is only filled in when an `actor` is present — a world-read dispatch carries
 * no subagent and stays bare.
 *
 * It is not "the current phase at the moment this event is emitted": a node-queued may be deferred by a hold rule until after the next
 * marker, while the birth moment lies in the previous phase; a dispatch can even get stuck behind the
 * concurrency ceiling until the script has walked through several markers.
 */
export function stampBirthPhase(event: RunEvent, instancePhases: InstancePhases): RunEvent {
  if (event.type === "actor-created") {
    const phaseName = instancePhases.get(refToString(event.actor));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-queued") {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-dispatched" && event.actor !== undefined) {
    const phaseName = instancePhases.get(refToString(event.instance));
    const actorPhaseName = instancePhases.get(refToString(event.actor));
    if (phaseName === undefined && actorPhaseName === undefined) return event;
    return {
      ...event,
      ...(phaseName === undefined ? {} : { phaseName }),
      ...(actorPhaseName === undefined ? {} : { actorPhaseName }),
    };
  }
  if (event.type === "node-settled" && event.cached === true) {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  return event;
}

/**
 * Fills in the **birth phase** of the subagent that triggered a `ProviderStop`: the driver only knows the actor ref, and only
 * the engine knows the phase (the same table that supplies `phaseName` on the event stream). No providerStop, no
 * subagent, a phase already present, or that ref having been born before any `phase()` marker -> returned as-is.
 */
export function enrichProviderStopPhase(
  error: WorkflowError,
  instancePhases: InstancePhases,
): WorkflowError {
  const details = error.providerStop;
  if (details === undefined || details.subagent === undefined || details.phase !== undefined) {
    return error;
  }
  const phase = instancePhases.get(details.subagent);
  if (phase === undefined) return error;
  return new WorkflowError(error.code, error.message, {
    providerStop: { ...details, phase },
    cause: (error as { cause?: unknown }).cause,
  });
}
