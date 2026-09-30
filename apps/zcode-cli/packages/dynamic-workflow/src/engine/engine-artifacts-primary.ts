/**
 * The primary marking of a deliverable: at most one ID per run carries it.
 * Content members and predefined members share the same set of admission criteria.
 *
 * These functions only read `state.artifacts`; they write nothing to the store and emit no events; the state is derived from the journal, so it stays consistent after resume.
 * The caller uses the criteria to decide between rejecting the publication and failing the whole run.
 */

import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString } from "./types.js";

/** The run's current primary id (at most one); undefined when there is none. Derived from `state.artifacts`, so it is consistent after resume by construction. */
export function primaryArtifactId(state: EngineState): string | undefined {
  for (const [id, idState] of state.artifacts) if (idState.primary) return id;
  return undefined;
}

/** `id` wants to be primary but a **different** id already is ⇒ returns that id; otherwise undefined (it does not want to be / it is that id itself). */
export function primaryConflict(
  state: EngineState,
  id: string,
  primary: boolean,
): string | undefined {
  if (!primary) return undefined;
  const holder = primaryArtifactId(state);
  return holder === undefined || holder === id ? undefined : holder;
}

export function primaryConflictMessage(
  id: string,
  holder: string,
  fix: string,
  instance: InstanceRef | undefined,
): string {
  const where = instance === undefined ? "" : ` (at ${refToString(instance)})`;
  return (
    `Cannot mark "${id}" as primary${where}: "${holder}" is already this run's primary artifact. ` +
    `A run has one deliverable; ${fix}, or publish it as a new version of "${holder}".`
  );
}
