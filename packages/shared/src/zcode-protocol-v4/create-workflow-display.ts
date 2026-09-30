// ============================================================
// CreateWorkflow's tool card display load (toolCallDisplaySchema member of rows.ts)
// ============================================================
// Detached from rows.ts: workflow display + two-segment cause-and-effect diagram schema to make rows.ts exceed the max-lines upper limit,
// And they are a self-consistent vocabulary (the same precedent as workspace-hook-review.ts - feature-level schema is separated into modules).

import { z } from "zod";

// CreateWorkflow display is a bounded projection independent of the model text; both the number of diagnoses and the length of a single message must be within
// The protocol boundary is longer to avoid type checking results from expanding continuous/replayable messages into unbounded payloads.
// The same goes for causalityGraph: the number of steps/lanes/edges and the label length are limited at the tool output boundary, mirrored here
// The same set of upper bounds. The vocabulary of graphs is intentionally small: participant cards + a type of arrow (runs after, `back` only marks back edges) +
// Stage module + return tag; parser's kind / certainty / exact / region do not load. The handover edge is the quotient of causal facts according to sub-agents, and the stage layer
// The edge is the stage quotient of the control flow graph; the step / lane is only used as a key for the running status and viewer, and is no longer drawn into the graph.
//
// The name is only shaped at runtime (`` agent(`researcher${i + 1}`) ``). The shape is statically available: before the first hole.
// The literal (head) and the literal after the last hole (tail). At least one is present, both are trimmed and contain meaningful characters.
// Only move **data**: The ellipsis rendered as "researcher..." is added by name-pattern.ts during rendering, and the copy is not saved in the projection.
// (Same as anonymous divulging - see lane-name.ts header).
const namePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// An edge = runs after; the transition edge is the same shape as the stage edge. `back` only marks the loop back edge (layout ranking and cycle count reading),
// The drawing method is the same as the other sides.
const workflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    back: z.literal(true).optional(),
  })
  .strict();

const toolCallCreateWorkflowCausalityGraphSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            kind: z.enum(["ask", "world-read"]),
            label: z.string().min(1).max(128),
            // Inline `agent()` receiver gives the static shape of the name when label falls into the string.
            labelPattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // The site id expanded from, only appears on the copy of the may-set lane expansion (the associated key of the real-time overlay);
            // The added field is additive, and old payloads without it pass .strict() as usual.
            source: z.string().min(1).max(64).optional(),
            // The author uses `phase("…")` to mark the divided phases.
            // Advance and exit simultaneously with the phases / phaseEdges / exits of the diagram: all present or all absent.
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
          })
          .strict(),
      )
      .max(64),
    lanes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            // Static shape when `name` is absent and the first parameter of agent() is a template string with holes; mutually exclusive with name.
            namePattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // Participants = one sub-agent card per stage (workspace/unresolved isomorphic); the order of the array is the handover order, and the first one is the starter.
    // The fan-out family is expanded into member according to the literal cardinality. When the cardinality is unknown, it is a many card.
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            phase: z.string().min(1).max(64),
            lane: z.string().min(1).max(64),
            steps: z.array(z.string().min(1).max(64)).min(1).max(64),
            member: z
              .object({ index: z.number().int().nonnegative(), of: z.number().int().positive() })
              .strict()
              .optional(),
            many: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(64),
    // Handover = runs after between participants; types are the product types across it (inspector material, not up arrow).
    handoffs: z
      .array(
        workflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // Stage vocabulary: The grouping structure imposed by the author, with the main screen as a node. with phaseEdges/exits/Step.phase
    // All or Nothing - The zero flag script is completely absent and the UI falls back to the step/lane view. The zero-member stage is also inside and outside.
    // `unphased` No name, the display name is localized by the UI.
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // Other stages that are still running when entering this stage (their strands have not yet been joined), stage table order, excluding itself,
            // Absent when empty. It's the node fact rather than the edge - control is not transferred from there, so phaseEdges are not entered.
            // The timeline folds adjacent stages into a bifurcated "belt" and the sidebar mini-track is drawn as a double line segment.
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(workflowEdgeSchema).max(128).optional(),
    // The stage in which the control flow can be completed normally (the "stage → return object" arrow in the stage view); the group can be an empty array.
    exits: z.array(z.string().min(1).max(64)).max(32).optional(),
    sink: z.array(z.string().min(1).max(64)).max(64).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallCreateWorkflowCausalityGraph = z.infer<
  typeof toolCallCreateWorkflowCausalityGraphSchema
>;

export const toolCallCreateWorkflowDisplaySchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z
          .object({
            line: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            code: z.number().int().nonnegative(),
            message: z.string().min(1).max(2_048),
          })
          .strict(),
      )
      .max(100),
    causalityGraph: toolCallCreateWorkflowCausalityGraphSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallCreateWorkflowDisplay = z.infer<typeof toolCallCreateWorkflowDisplaySchema>;
