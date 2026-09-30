// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SAVED_WORKFLOW_MAX_NAME_CHARS, SavedWorkflowScopeSchema } from "./saved-workflow.js";

export const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";

/**
 * The name of the built-in skill that teaches the model to write workflows (apps/zcode-cli/packages/bundled-skills/skills/<name>/SKILL.md).
 * The resolveInput of the four authoring tools (Create/Amend/Save/EvalWorkflowSnippet) uses it as a gate: a session that has never
 * loaded that skill is refused a script submission.
 * It lives in contracts because core's gate and bootstrap's skill bundle both read it, and the two must not import each other.
 */
export const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

/** The violation message for "exactly one execution-body source". It is a constant because the model is its only reader, and all three paths use the same sentence. */
export const CREATE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one, or none, is ambiguous.";

/** The violation message for `args` belonging only to the `path` source (`saved` has its own `saved.args`, and an inline script declares nothing). */
export const CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR =
  "`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* zcode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.";

/**
 * The `saved` source. The model fills in `name`, optionally `args` and `scope` (for disambiguation); `path` is a fact **backfilled** after `resolveInput`
 * resolved it, and `scope` likewise becomes the one that hit after normalization, so both are optional.
 *
 * The normalized input is therefore a legal execution state in which `script` and `saved` are **present at the same time** — which is exactly why the XOR cannot be written
 * on zod (see {@link CreateWorkflowInputSchema}).
 */
export const CreateWorkflowSavedSourceSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("Name of a saved workflow (see ListSavedWorkflows)."),
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments the saved workflow declares."),
    /** Resolution backfill: where the saved file lands. The model does not fill this in. */
    path: z.string().min(1).optional(),
    /**
     * Disambiguation: which tier this workflow is taken from. By default the existing lookup order applies (a project-level definition shadows a global one of the same name).
     * After normalization `scope` becomes the one that **hit**; see create-workflow-source.ts.
     */
    scope: SavedWorkflowScopeSchema.optional().describe(
      "Which archive to take it from; omit for the normal lookup order.",
    ),
  })
  .strict();

export type CreateWorkflowSavedSource = z.infer<typeof CreateWorkflowSavedSourceSchema>;

/**
 * The runtime `saved` block: the model-facing fields plus `draft`.
 *
 * `draft` is the **landing spot** backfilled once `resolveInput` has written that working copy: a saved definition is never modified by a run, what the model wants to change is this copy. It stands in the
 * same posture as `AmendWorkflow.predecessor` — the fact is computed by the tool and is not listed in the model's JSON schema, so the model
 * never thinks it is supposed to fill in a path. When the draft cannot be written the field is absent entirely (drafting is best-effort).
 */
export const CreateWorkflowResolvedSavedSourceSchema = CreateWorkflowSavedSourceSchema.extend({
  draft: z.string().min(1).optional(),
}).strict();

export type CreateWorkflowResolvedSavedSource = z.infer<
  typeof CreateWorkflowResolvedSavedSourceSchema
>;

/**
 * The execution body has three sources and exactly one must be given — but this XOR is **deliberately not written on the schema**.
 *
 * The reason is normalization: once `resolveInput` has resolved the saved script (or the `path` file), the input carries
 * `script` (the bytes to run) and `saved` / `path` (where it came from) at the same time. A superRefine would blow this legal shape up in two places —
 * the handler's own `parse`, and the call-runner's second validation after a hook rewrote the input — and it
 * blows up **only on the non-inline paths**, the kind of bug that ships because nobody could test it. The XOR is therefore enforced by `entry.validateInput` on the
 * **model's arguments**, which is the one place where it is actually true. JSON schema could not express a refinement in the first place,
 * so the model is guided by the field descriptions instead.
 */
const CreateWorkflowModelInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Short run label in the user's language. Always pass it for an inline script; defaults to the saved workflow's name.",
      ),
    script: z
      .string()
      .optional()
      .describe("The whole workflow script, inline. Exactly one of `script`, `saved` and `path`."),
    saved: CreateWorkflowSavedSourceSchema.optional().describe(
      "A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`.",
    ),
    /**
     * The third source:
     * A script file on disk. It is the **return leg** of an inline submission — the tool writes a draft, the result names that file, and next time the model
     * changes one line and hands the same path back. A file carrying a `/* zcode-workflow` block is parsed as a saved definition (the block is stripped,
     * the body serves as the script, and `args` is validated against the declaration inside the block).
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.",
      ),
    /**
     * The arguments declared by the `path` file. `saved` has its own `saved.args` (the same validation rules), an inline script declares nothing,
     * so this field comes and goes with `path` — `validateInput` pins that down on the model's arguments.
     */
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments a `path` file declares. Only with `path`."),
    /**
     * The run's own concurrency ceiling. It only lowers, never raises:
     * `resolveInput` clamps it to `[1, ceiling]`, and the confirmation window and the handler see exactly the value that will take effect. Absent means the ceiling.
     * Set it only when the user asks for it — provider rate limiting adapts itself at runtime, and the model must not treat it as insurance.
     */
    max_concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Upper bound on subagents working at once. Only when the user asks to limit parallelism; never as a reaction to provider errors.",
      ),
    /**
     * Which model this run's subagent runs on. In the same
     * family as `max_concurrency`: the model surface takes a loose string, and `resolveInput` resolves it through the model catalog port into the
     * canonical form `providerId/modelId[$reasoningLevel]` — what the confirmation window and the handler read is the value that will take effect, and an
     * unresolvable value comes back as a business failure **before** the window opens. The main agent itself always stays on the session model; absent means the subagent does too.
     */
    subagent_model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model for the subagents (`providerId/modelId` or a model id). Only when the user asks; you stay on the session model.",
      ),
    // Revision continuation is not here: it is the work of `AmendWorkflow` (amend-workflow.ts). `.strict()` makes the old way of writing `resume_from` a visible schema error,
    // Rather than being silently ignored and then turned into a full-price rerun.
  })
  .strict();

/**
 * The runtime arguments: the model-facing fields plus the facts backfilled by `resolveInput`.
 *
 * The backfilled items stand in the same posture as `AmendWorkflow.predecessor` — the model's JSON schema does not list them, because they are not
 * fillable parameters but resolution results; if the model fills them in anyway, normalization overwrites them unconditionally.
 */
export const CreateWorkflowInputSchema = CreateWorkflowModelInputSchema.extend({
  saved: CreateWorkflowResolvedSavedSourceSchema.optional(),
  /**
   * The offset from body lines to file lines (non-zero only when the `path` / `saved` file carries a metadata block). Add it
   * when diagnostics are reported in file lines, so that the line number can be pasted straight into an `Edit` of that file.
   */
  script_line_offset: z.number().int().nonnegative().optional(),
}).strict();

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

/** The JSON schema handed to the model: no `script_line_offset`, and no `draft` inside `saved` either. */
export const CreateWorkflowInputJsonSchema = toToolJsonSchema(CreateWorkflowModelInputSchema);

export const CreateWorkflowDiagnosticSchema = z
  .object({
    code: z.number(),
    column: z.number(),
    line: z.number(),
    message: z.string(),
  })
  .strict();

export type CreateWorkflowDiagnostic = z.infer<typeof CreateWorkflowDiagnosticSchema>;

// CreateWorkflow display is a bounded projection independent of the model text: diagnostics may be numerous and must be bounded at protocol boundaries,
// Avoid type checking results from expanding continuous/replayable messages into unbounded payloads.
// The diagnostic display entry shape is displayed by both create_workflow and eval_workflow_snippet at the same time.
// Payload reuse (same TS diagnostic shape, same limit length), so defined here instead of tool-result-metadata.ts
// ——The latter needs to back-reference the schema in this file, which will form a loop.
export const CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS = 100;
export const CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS = 2_048;

export const createWorkflowToolResultDisplayDiagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
  })
  .strict();

// The Causality graph is a bounded projection of the display channel, but bounded directly at the tool output boundaries: persistent tool
// The output and real-time display payloads share the same contract to prevent the two from evolving different truncation semantics.
// The payload only loads the fields that the GUI actually reads: the side is
// `{from, to, back?}` A shape, region / certainty / edge type are all left in the analyzer. second floor
// Is subagent-oriented: participant card + handover edge at each stage;
// The step edge is therefore no longer loaded (no readers), and the step / lane is left as a key for the run state and inspector.
export const CREATE_WORKFLOW_GRAPH_MAX_STEPS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_LANES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS = 256;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES = 8;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES = 128;
export const CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS = 128;

export const CREATE_WORKFLOW_STEP_KINDS = ["ask", "world-read"] as const;

// The name is only the part that is statically available when it is formed at runtime (`` agent(`researcher${i + 1}`) ``): before the first hole
// The literal (head) and the literal after the last hole (tail). At least one of the two is present - if the analyzer can't get it, the whole
// If the field is absent, the empty pattern will not be emitted. **Move data only**: The ellipsis that renders it as "researcher..." is a decision of the rendering layer.
export const CreateWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    tail: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowNamePattern = z.infer<typeof CreateWorkflowNamePatternSchema>;

// a step = a facade operation to wait for (ask/files.*). lane is the actor executing it (or
// workspace / unknown); lanes only appears when the receiver is may-set. At this time, the step has been expanded into candidate lanes.
// One copy per lane (with source for each). repeat distinguishes two multiplicity cues: stack (instance coexistence, drawing stacked cards) and
// serial (succession of instances, already expressed by closed-loop arrows).
// Certainty / region does not load: the GUI does not draw them.
export const CreateWorkflowStepSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    kind: z.enum(CREATE_WORKFLOW_STEP_KINDS),
    label: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** The static shape of the name when `label` only gets the fallback string (the inline `agent()` receiver). */
    labelPattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lanes: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_LANES)
      .optional(),
    /**
     * The site id this was expanded from, present only on copies produced by may-set lane expansion (copy ids look like `ask#2~actor#1`).
     * It is a correlation key for the live overlay: a runtime instance reports a site id, so a card carrying the source collects state by
     * `(node.siteId === source, node.actorSiteId === lane)`. It deliberately takes no part in referential-integrity
     * convergence — it points at the site the copy replaced, and that node is not in the graph.
     */
    source: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    /**
     * The phase the author marked this into with `phase("…")` (`phase#2`, or the reserved `unphased`). It comes and goes together with the graph's
     * `phases` / `phaseEdges` / `exits`: either all four are present (then **every** step carries one and the partition is total),
     * or all are absent (a script with no markers).
     */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    repeat: z.enum(["stack", "serial"]).optional(),
  })
  .strict();

export type CreateWorkflowStep = z.infer<typeof CreateWorkflowStepSchema>;

// Lane = one actor (plus one workspace lane). Multiplicity no longer hangs in the driveway (it used to be families →
// nesting): lanes are no longer rendered, and the number of family members is expressed by the `member` / `many` of the participant.
export const CreateWorkflowLaneSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    /** The static shape when `name` is absent and the first argument of `agent()` is a template string with holes; mutually exclusive with `name`. */
    namePattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

export type CreateWorkflowLane = z.infer<typeof CreateWorkflowLaneSchema>;

// The edge only means one thing: runs after. The phase edge and the transition edge have the same shape. `back` marks the loop back edge - drawing method and others
// The edges are exactly the same, not labeled, only the layout ranking (the edges do not participate in the column order) and the frame header cycle count to read it. Analyzer's
// Kind / certainty / exact does not enter the load; both edges have undergone unified transitive reduction.
export const CreateWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    to: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    back: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowEdge = z.infer<typeof CreateWorkflowEdgeSchema>;

// Participant = a card on the second level of the board: the subagent (or workspace /
// not parsed). When the fan-out family is expanded according to the literal cardinality, there is one piece for each member (`member`), and when the cardinality is unknown, there is one piece of `many`
// The card represents all members. `steps` is its step in this phase - the run state is aggregated from it and the inspector is listed from ask.
// The order of the array is the handover order (determined by the analyzer): the folded surface is from top to bottom, the expanded surface is from left to right, and the first one is the starter.
export const CreateWorkflowParticipantSchema = z
  .object({
    /** `${phase}:${lane}`, and a family member is `${phase}:${lane}[${index}]`. */
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    /** The phase id; always `unphased` when the script has no phase vocabulary (`phases` is absent in that case). */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    steps: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_STEPS),
    member: z
      .object({
        index: z.number().int().nonnegative(),
        of: z.number().int().positive(),
      })
      .strict()
      .optional(),
    many: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowParticipant = z.infer<typeof CreateWorkflowParticipantSchema>;

// Handover = runs after between participants (what happens-before after reduction). `types` spans this edge
// Product type (data side of site map), only enter the viewer, no arrow.
export const CreateWorkflowHandoffSchema = CreateWorkflowEdgeSchema.extend({
  types: z
    .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS))
    .min(1)
    .max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES)
    .optional(),
}).strict();

export type CreateWorkflowHandoff = z.infer<typeof CreateWorkflowHandoffSchema>;

// Phase = a set of steps marked by the author with `phase("…")`. The name is the key (two tags with the same name are the same stage),
// So `name` is the author's original word; in the synthesis stage `unphased` **no name**, the display name is localized by UI
// (Same pattern as the workspace/unknown lane). loc is the position of the first mark.
export const CreateWorkflowPhaseSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    /**
     * The other phases still **running** when this phase is entered: the strands they fanned out had not joined yet. In phase-table order,
     * listing phase ids, excluding itself, and the whole field is absent when empty (it comes and goes with the vocabulary).
     *
     * It is a **node fact** rather than an edge — control was not transferred from those phases, both sides are present at the same time, so it neither
     * goes into `phaseEdges` nor takes part in edge reduction (reduction would treat it as runs-after and cut the real edges away).
     * The reader is the timeline: it folds the adjacent phases it links into one forked "band", branching a side track off the main line;
     * the sidebar mini-track draws a double segment from it.
     */
    alongside: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
  })
  .strict();

export type CreateWorkflowPhase = z.infer<typeof CreateWorkflowPhaseSchema>;

// The name follows history (it once only housed cause and effect diagrams). Three layers: the step layer is the site (the key of the running state, no longer drawn); the participant layer
// It is the card and handover of each stage (the causal fact is quotient according to the card); the stage layer is the control flow fact (the stage quotient of the control flow graph). bridge between floors
// Is `Participant.phase` / `Participant.steps`, `Step.phase` and `exits`.
export const CreateWorkflowCausalityGraphSchema = z
  .object({
    steps: z.array(CreateWorkflowStepSchema).max(CREATE_WORKFLOW_GRAPH_MAX_STEPS),
    lanes: z.array(CreateWorkflowLaneSchema).max(CREATE_WORKFLOW_GRAPH_MAX_LANES),
    participants: z
      .array(CreateWorkflowParticipantSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS),
    handoffs: z.array(CreateWorkflowHandoffSchema).max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS),
    /**
     * The phase vocabulary, all-or-nothing with `phaseEdges`, `exits` and `Step.phase`: for a script with no markers all four are
     * absent, and "is the vocabulary present" is exactly the UI's view-toggle condition. On overflow it is absent as a whole too (plus `truncated`)
     * — a phase graph cut in half would lie. Phases with zero members (markers only, no steps) are in the table as well: control flow passes through them.
     */
    phases: z.array(CreateWorkflowPhaseSchema).max(CREATE_WORKFLOW_GRAPH_MAX_PHASES).optional(),
    phaseEdges: z
      .array(CreateWorkflowEdgeSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES)
      .optional(),
    /**
     * The phases after which control flow can complete normally (the sources of the edges that point at sink terminals in the control flow graph's phase quotient), in phase-table order.
     * The phase view's "phase → artifact" arrows read it, so that every arrow on that screen is control flow. The group may be empty
     * (the script has no normal completion path), but a member must never appear on its own outside the group.
     */
    exits: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
    /** Which steps supply the artifact (a data fact, for drill-down); absent when the script returns nothing. */
    sink: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_STEPS)
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export type CreateWorkflowCausalityGraph = z.infer<typeof CreateWorkflowCausalityGraphSchema>;

/**
 * The run's declared phase table: the **named** phases of the causality
 * graph, in declaration order. Run state only knows the phases already entered, so for the sidebar mini-track to draw "which stops are still ahead" this table has to be
 * handed to the engine at submit time to record in `run-launched`. Both submit paths (the `CreateWorkflow` tool, a hub direct launch) share this function,
 * so the same script draws the same track on both routes. No graph / no phase vocabulary / only the synthetic `unphased` → `undefined`
 * (the field is absent entirely rather than an empty array: the UI draws an implicit stop from the absence).
 */
export function createWorkflowPhaseNames(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): string[] | undefined {
  return namedPhases(graph)?.map((phase) => phase.name);
}

/**
 * The "running alongside" table **positionally aligned** with {@link createWorkflowPhaseNames}: `out[i]` holds the indices of the other phases
 * whose strands are still running when the i-th named phase of the declaration table is entered (indices into that same named phase table).
 *
 * The index space is that of the **named phases**, not of the causality graph's original phase table: unnamed phases (the synthetic `unphased`) are skipped,
 * and references to them, to unlisted phases, or to itself are dropped as well — an out-of-range index would make the sidebar link "running alongside"
 * to the wrong stop. It enters `run-launched` as `DynamicWorkflowRunSubmitRequest.phaseAlongside`,
 * and the sidebar mini-track uses it to draw two adjacent stops inside a band as a double segment.
 *
 * No graph / no phase vocabulary / no phase carries alongside → `undefined` (the field is absent entirely rather than a list of empty
 * arrays: absence means "this track is a straight line").
 */
export function createWorkflowPhaseAlongside(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): number[][] | undefined {
  const named = namedPhases(graph);
  if (named === undefined) return undefined;
  const indexOf = new Map(named.map((phase, index) => [phase.id, index]));
  let any = false;
  const out = named.map((phase, self) => {
    const indexes: number[] = [];
    for (const id of phase.alongside ?? []) {
      const index = indexOf.get(id);
      if (index === undefined || index === self || indexes.includes(index)) continue;
      indexes.push(index);
    }
    any = any || indexes.length > 0;
    return indexes;
  });
  return any ? out : undefined;
}

/** The named phases (declaration order, truncated at the cap), with `name` already narrowed. */
type CreateWorkflowNamedPhase = CreateWorkflowPhase & { name: string };

/**
 * The table shared by the two functions above: the **named** phases of the causality graph, in declaration order, truncated at
 * `CREATE_WORKFLOW_GRAPH_MAX_PHASES`. Factoring it into one function is exactly so that both go through the same filter and land in the same
 * index space — what `phaseAlongside[i]` talks about must be the stop `phaseNames[i]`.
 */
function namedPhases(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): CreateWorkflowNamedPhase[] | undefined {
  if (graph?.phases === undefined) return undefined;
  const named: CreateWorkflowNamedPhase[] = [];
  for (const phase of graph.phases) {
    const name = phase.name;
    if (name === undefined) continue;
    named.push({ ...phase, name });
    if (named.length >= CREATE_WORKFLOW_GRAPH_MAX_PHASES) break;
  }
  return named.length === 0 ? undefined : named;
}

// The two new fields only appear if a run is actually started after confirmation; the results of diagnostic-only remain unchanged.
// Use explicit schema instead of raw entrainment: The meaning of .strict() is that the shape change must be an explicit commit.
export const CreateWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    /** Appears only when a background run was started; since it is not a general status field, only this single literal is accepted. */
    status: z.literal("backgrounded").optional(),
    /** The background task id ≡ taskId ≡ runId (cancellation and status queries are both keyed on it). */
    backgroundTaskId: z.string().min(1).optional(),
    /**
     * Present only when `AmendWorkflow` changes concurrency and takes effect in place: there is **no** new run, so there is neither `status: "backgrounded"` nor
     * `backgroundTaskId`, and the run is still the one from the call.
     *
     * It is an explicit block rather than letting consumers guess by shape: "ok and no status" has other origins on this tool
     * (the "typecheck only" case when there is no run port). The numbers are all absolute, and `maxConcurrency === ceiling` means
     * "this run has no ceiling of its own".
     *
     * ⚠ This fact **does not cross v4**: the protocol's `toolOutputSchema` carries only `text` / `display` / `truncated`,
     * so it serves the CLI/TUI and in-process consumers; the desktop UI cannot read it.
     */
    retuned: z
      .object({
        runId: z.string().min(1),
        maxConcurrency: z.number().int().positive(),
        previous: z.number().int().positive(),
        ceiling: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateWorkflowOutput = z.infer<typeof CreateWorkflowOutputSchema>;

export const CreateWorkflowOutputJsonSchema = toToolJsonSchema(CreateWorkflowOutputSchema);
