import type { SiteGraph } from "../analysis/types.js";
import { interpret } from "../analysis/interpret.js";
import { projectSiteGraph } from "../analysis/graph.js";
import type { SiteTable } from "../analysis/sites.js";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { AskSpec } from "../engine/types.js";
import { canonicalJson } from "../engine/hash.js";
import type { JsonSchema } from "./types.js";

/**
 * The **submit profile** of each actor site: it decides which `submit_result` tool the actor's
 * subagent session gets.
 *
 * - `untyped`: every ask that can land on this actor is untyped (or it has no ask at all) ->
 *   do not register submit_result.
 * - `mono`: the schemas of the typed asks that can land on this actor are **all the same**
 *   (canonical JSON equal; untyped asks may be mixed in) -> the tool declaration is exactly
 *   `{ result: schema }`, frozen for that actor and unchanged across asks, hence cache-neutral.
 * - `generic`: the typed asks have more than one schema -> today's generic tool plus a per-ask
 *   schema footnote.
 *
 * Why compile time rather than runtime: the tool block is rendered at the very front of the
 * prompt, and switching the schema per ask would blow away that actor's entire cache prefix. A
 * typed tool is only free when "the schema does not change over the actor's whole lifetime" is
 * decidable at compile time; when it is not decidable, fall back to generic, which keeps the
 * behaviour byte-for-byte equivalent.
 */
export type ActorSubmitProfile =
  | { kind: "untyped" }
  | { kind: "mono"; schema: JsonSchema }
  | { kind: "generic" };

/** The profile for an absent / undecidable case: today's behaviour. */
export const GENERIC_SUBMIT_PROFILE: ActorSubmitProfile = { kind: "generic" };

/**
 * Derives the submit profile of each actor site from the site graph and the ask specs. A pure
 * function.
 *
 * **Soundness rule**: the ask->actor binding takes the may-set on the site graph
 * (`SiteNode.actors`). As soon as **any** ask site has an empty actor set (the receiver did not
 * resolve), the analysis cannot say who that ask will land on — so **every** actor is recorded as
 * `generic`. This is deliberate conservatism: if a typed ask landed on an `untyped` subagent it
 * would have no tool to submit with and could only burn out its nudges and fail; saving a little
 * cache is not worth taking the tool away on the strength of an incomplete graph. For the same
 * reason, when an ask's actor set has several members (a receiver on a conditional branch), its
 * schema counts towards every member.
 *
 * A missing ask site in askSpecs likewise falls back to generic as a whole: the site table and the
 * specs come from the same compile, so an absence can only be a wiring error, and this code does
 * not guess (the engine already hard-fails on that with MissingAskSpec; here it only has to not
 * amplify it).
 *
 * The returned table covers every actor site in `graph.actors`.
 */
export function deriveActorSubmitProfiles(
  graph: SiteGraph,
  askSpecs: ReadonlyMap<string, AskSpec>,
): Map<string, ActorSubmitProfile> {
  const profiles = new Map<string, ActorSubmitProfile>();
  const actorIds = graph.actors.map((actor) => actor.id);

  // The typed schema collected by each actor is deduplicated according to the standard JSON (the same schema object is synthesized on different ask sites)
  // Once, the references are different but the content is the same and must be compared by content).
  const schemasByActor = new Map<string, Map<string, JsonSchema>>();
  for (const id of actorIds) schemasByActor.set(id, new Map());

  for (const node of graph.nodes) {
    if (node.kind !== "ask") continue;
    const actors = node.actors ?? [];
    const spec = askSpecs.get(node.id);
    if (actors.length === 0 || spec === undefined) {
      for (const id of actorIds) profiles.set(id, GENERIC_SUBMIT_PROFILE);
      return profiles;
    }
    if (!spec.typed) continue;
    const schema = spec.schema as JsonSchema;
    const key = canonicalJson(schema);
    for (const actorId of actors) {
      // The actor id in the site graph must be in graph.actors; fill a bucket defensively instead of silently skipping it.
      let bucket = schemasByActor.get(actorId);
      if (bucket === undefined) {
        bucket = new Map();
        schemasByActor.set(actorId, bucket);
      }
      bucket.set(key, schema);
    }
  }

  for (const [actorId, bucket] of schemasByActor) {
    if (bucket.size === 0) profiles.set(actorId, { kind: "untyped" });
    else if (bucket.size === 1)
      profiles.set(actorId, { kind: "mono", schema: [...bucket.values()][0]! });
    else profiles.set(actorId, GENERIC_SUBMIT_PROFILE);
  }
  return profiles;
}

/**
 * A convenience entry point for "compile once": it runs the interpretation and the site graph
 * projection on the **same** {@link WorkflowProgram} that built the site table and synthesized the
 * schemas (exactly the two steps analyzeWorkflowScript runs), and then derives the profiles. It is
 * called from the run submit path so callers need not assemble interpret + projectSiteGraph
 * themselves (neither is on the package's public surface).
 */
export function deriveActorSubmitProfilesFor(
  workflow: WorkflowProgram,
  table: SiteTable,
  askSpecs: ReadonlyMap<string, AskSpec>,
): Map<string, ActorSubmitProfile> {
  return deriveActorSubmitProfiles(projectSiteGraph(interpret(workflow, table)), askSpecs);
}
