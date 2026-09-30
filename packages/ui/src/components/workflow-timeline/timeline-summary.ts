import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { workflowSubagentModelCardLabel } from "./subagent-model-label.js";
import type { WorkflowTimelineModel } from "./timeline-model.js";

/**
 * Copy material for the card header detail and the footer summary line. The summary line in the
 * sidebar status header reads from here too — the same run must say the same thing on both
 * surfaces.
 *
 * Pure functions plus an injected formatMessage: this repo's lightweight intl has no ICU plurals,
 * so singular and plural each get their own key.
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface TimelineCounts {
  phases: number;
  /** The number of distinct subagent lanes (synthetic lanes do not count). */
  agents: number;
  steps: number;
}

export function timelineCounts(
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
): TimelineCounts {
  const lanes = new Set<string>();
  for (const station of model.stations) {
    for (const pill of station.pills) if (pill.laneClass === "agent") lanes.add(pill.lane.id);
  }
  // The draft does not draw pills, and the subagent number is given directly by the scanner.
  const agents = model.draft?.agents ?? lanes.size;
  return { agents, phases: model.stations.length, steps: graph?.steps.length ?? 0 };
}

/**
 * The highest round a station on a loop has reached; 0 when there is no loop or it has not been
 * reached yet.
 */
export function timelineRounds(model: WorkflowTimelineModel): number {
  let rounds = 0;
  for (const station of model.stations) {
    if (station.onLoop && station.rounds > rounds) rounds = station.rounds;
  }
  return rounds;
}

function count(format: FormatMessage, one: string, many: string, value: number): string {
  return format({ id: value === 1 ? one : many }, { count: value.toLocaleString() });
}

/**
 * The right side of the confirmation dialog header only states the phase count — the subagent count
 * and the step count are visible at a glance on the timeline below, so repeating them in the header
 * is just noise.
 */
export function workflowPhasesDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
): string {
  const counts = timelineCounts(model, graph);
  return count(
    format,
    "chat.toolCall.workflow.card.phase",
    "chat.toolCall.workflow.card.phases",
    counts.phases,
  );
}

/**
 * The subagent segment: while running it counts the ones working, after it ends it counts the total
 * (the larger of the projection and the static diagram).
 */
function agentsPart(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  run: WorkflowRunState | undefined,
): string {
  if (run !== undefined && (run.status === "pending" || run.status === "running")) {
    const working = run.actors.filter((actor) => actor.status === "running").length;
    return count(
      format,
      "chat.toolCall.workflow.card.agentWorking",
      "chat.toolCall.workflow.card.agentsWorking",
      working,
    );
  }
  const agents = Math.max(run?.actors.length ?? 0, timelineCounts(model, undefined).agents);
  return count(
    format,
    "chat.toolCall.workflow.card.agent",
    "chat.toolCall.workflow.card.agents",
    agents,
  );
}

/**
 * The detail on the right side of the card header: it **states only the phase count and the
 * subagent count** ("steps" must not appear on the card, only phases and subagents stay). While
 * writing / awaiting confirmation the counts come from the static diagram; once linked to a run the
 * phase count stays the same and the subagent part becomes "n working" (while running) or the total
 * (once finished). Steps, tokens, rounds, and artifact counts no longer go in the header — they
 * stay in the summary line of the run detail page (`workflowSummaryParts`).
 */
export function workflowHeaderDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
  run: WorkflowRunState | undefined,
  /**
   * The subagent model name (resolved, see subagent-model-label.ts): the detail string already says
   * "how many subagents", so the model name follows it as the last segment, in the same dim text —
   * no chip, no prefix. Strength and the spec string are left to the tooltip. A run that never
   * specified a model omits this segment.
   */
  subagentModelName?: string,
): string {
  const parts = [workflowPhasesDetail(format, model, graph), agentsPart(format, model, run)];
  if (subagentModelName !== undefined) {
    parts.push(subagentModelName);
  }
  return parts.join(" · ");
}

/**
 * The header detail string plus its tooltip, computed in one pass: two cards (the v4 tail summary
 * and the legacy host run card) must say the same thing, so "whether to append the model name" and
 * "what goes into the tooltip" have exactly this one implementation. When no timeline model can be
 * built, the whole thing is absent.
 */
export function workflowCardDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel | undefined,
  graph: WorkflowCausalityGraphData | undefined,
  run: WorkflowRunState | undefined,
  /**
   * providerId → provider name; when absent the joined name falls back to the bare modelId (a
   * provider id is never shown).
   */
  providerName?: (providerId: string) => string | undefined,
): { detail: string; title?: string } | undefined {
  if (model === undefined) {
    return undefined;
  }
  const subagentModel = workflowSubagentModelCardLabel(run?.subagentModel, {
    formatMessage: format,
    ...(providerName === undefined ? {} : { providerName }),
  });
  return {
    detail: workflowHeaderDetail(format, model, graph, run, subagentModel?.name),
    ...(subagentModel === undefined ? {} : { title: subagentModel.title }),
  };
}

/**
 * The segments of the run detail page's summary line: `1 agent working · 4/7 steps · 42,118 tokens
 * · round 2`; in a terminal state it becomes `3 agents · 11/11 steps · … · 3 rounds · 2 artifacts`.
 * The return value is just strings, the separators are drawn by the renderer. The last segment
 * counts **artifacts** (what a script delivers to the user through `artifact.*`), not `report`
 * entries: the Results section has been removed, so "results" no longer has anywhere to land on
 * screen. Cards in chat (tool card footers, tail summaries) no longer use it — a card only states
 * phases and subagents (`workflowHeaderDetail`); only the detail page still reads this line.
 */
export function workflowSummaryParts(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  run: WorkflowRunState,
  options: {
    tokens?: boolean;
    /**
     * The subagent model name (resolved, see subagent-model-label.ts): when present it is the
     * **first segment** of the summary line — this line is the run's handful of numbers to begin
     * with, and the model is its first word. The status header therefore no longer shows a model
     * chip.
     */
    subagentModelName?: string;
  } = {},
): string[] {
  const parts: string[] = [];
  if (options.subagentModelName !== undefined) {
    parts.push(
      format(
        { id: "chat.toolCall.workflow.run.subagentModel.label" },
        { model: options.subagentModelName },
      ),
    );
  }
  const active = run.status === "pending" || run.status === "running";
  if (active) {
    const working = run.actors.filter((actor) => actor.status === "running").length;
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.agentWorking",
        "chat.toolCall.workflow.card.agentsWorking",
        working,
      ),
    );
  } else {
    const agents = Math.max(run.actors.length, timelineCounts(model, undefined).agents);
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.agent",
        "chat.toolCall.workflow.card.agents",
        agents,
      ),
    );
  }
  // The only implementation of step counting @zcode/shared: inside the table + outside the table (instances that do not enter the table after hitting the boundary are still counted as steps).
  const { settled, total } = workflowRunStepCounts(run);
  parts.push(format({ id: "chat.toolCall.workflow.card.steps" }, { done: settled, total }));
  if (options.tokens !== false) {
    parts.push(
      format(
        { id: "chat.toolCall.workflow.card.tokens" },
        { count: run.usage.spentTokens.toLocaleString() },
      ),
    );
  }
  const rounds = timelineRounds(model);
  if (rounds >= 2) {
    parts.push(
      active
        ? format({ id: "chat.toolCall.workflow.card.round" }, { count: rounds })
        : format({ id: "chat.toolCall.workflow.card.rounds" }, { count: rounds }),
    );
  }
  const artifacts = run.artifacts?.length ?? 0;
  if (artifacts > 0) {
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.artifact",
        "chat.toolCall.workflow.card.artifacts",
        artifacts,
      ),
    );
  }
  return parts;
}
