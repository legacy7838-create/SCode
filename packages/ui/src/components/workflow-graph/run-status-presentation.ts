import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

/**
 * Every shape and color of the status lamp. Consumers bring their own size and `rounded-full`; this
 * only supplies the shape differences (pulse / solid dot / halo / empty ring) and the colors. The
 * timeline station lamps, the sidebar list, the run directory and the task list share them — a
 * feature has exactly one way of drawing "running".
 *
 * running uses warning (the activity color) rather than primary: primary inverts across themes
 * (nearly black in light mode), so it reads as "emphasis" rather than "in motion"; the activity
 * color is left to things that are genuinely moving (lamps, marching dashes, spinners).
 */
export const STATUS_DOT: Record<StepRunStatus, string> = {
  done: "bg-success",
  failed: "bg-destructive ring-2 ring-destructive/30",
  pending: "border-[1.5px] border-foreground-subtlest bg-transparent",
  running: "animate-pulse bg-warning motion-reduce:animate-none",
};

/**
 * The empty-ring lamp for compile feedback rows. The shape is the same empty ring as "compiled" and
 * as a station that is about to start: nothing ran. The color only says whether attention is still
 * pending — `open` is the newest draft of that lineage (the loop is still going, or the model
 * stopped here), `settled` is a draft that a later one has superseded. Never destructive: in this
 * feature red belongs only to errored runs.
 */
export const DRAFT_FEEDBACK_DOT = {
  open: "border-[1.5px] border-warning bg-transparent",
  settled: STATUS_DOT.pending,
} as const;

/**
 * Visual vocabulary for the run's **overall** state (five values), derived from the four-value
 * `STATUS_DOT` (terminal states = completed / errored / stopped). `stopped` takes a neutral color
 * rather than destructive: stopping (user cancellation, the process dying, a model-side error) is a
 * recoverable state, not a script failure; only `errored` is destructive.
 */
export const RUN_STATUS_DOT: Record<WorkflowRunState["status"], string> = {
  pending: STATUS_DOT.pending,
  running: STATUS_DOT.running,
  completed: STATUS_DOT.done,
  errored: STATUS_DOT.failed,
  stopped: STATUS_DOT.pending,
};

/**
 * Semantic color of the status word. The same decisions as the status dot, only carried by the text
 * channel (a state always has a word, never color alone).
 */
export const RUN_STATUS_TEXT: Record<WorkflowRunState["status"], string> = {
  pending: "text-foreground-subtle",
  running: "text-warning",
  completed: "text-success",
  errored: "text-destructive",
  stopped: "text-foreground-subtle",
};

/**
 * The reason word for `stopped` (reuses the cancelled presentation plus one line of reason). The
 * object being read may be a projected run, a discovery query summary, or a tool card display — the
 * three schemas evolve independently in different protocol layers, so this reads one optional key
 * structurally rather than binding to any single type.
 */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  // Stopped and replaced by an AmendWorkflow:
  // The light is still the neutral empty ring of stopped, the difference lies in the word and the link that points to the successor.
  "superseded",
] as const;
export type WorkflowRunStopReason = (typeof WORKFLOW_RUN_STOP_REASONS)[number];

export function readWorkflowRunStopReason(run: {
  status?: string;
  stopReason?: unknown;
}): WorkflowRunStopReason | undefined {
  if (run.status !== "stopped") return undefined;
  const reason = run.stopReason;
  return typeof reason === "string" &&
    (WORKFLOW_RUN_STOP_REASONS as readonly string[]).includes(reason)
    ? (reason as WorkflowRunStopReason)
    : undefined;
}

/** i18n key of the reason word (`chat.toolCall.workflow.run.stopReason.*`). */
export function workflowRunStopReasonMessageId(reason: WorkflowRunStopReason): string {
  return `chat.toolCall.workflow.run.stopReason.${reason}`;
}

/**
 * Whether the run was stopped and superseded by a revision: the card and the details page use this
 * to switch the kind word, hide the Resume slot, and draw a link to the successor.
 */
export function isWorkflowRunSuperseded(run: { status?: string; stopReason?: unknown }): boolean {
  return readWorkflowRunStopReason(run) === "superseded";
}
