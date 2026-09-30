import type { TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";

/**
 * Streaming draft: while the model is still writing the script and the analyzer has not run yet,
 * the card first draws the **phase line** — only stations and faint ink track segments, no pills,
 * no arcs, no states; sub-agents are only counted (the `N phases · M agents` in the header),
 * leaving the picture to the analyzer. This is a **regex-level scanner**, not a parser — it only
 * recognizes `phase("…")` and `agent("…")`, and a misreading does no harm: as soon as the display
 * arrives, the whole model is replaced by the analyzer's (invariant 10).
 *
 * A second `phase("implement")` with the same name is a return to that station (the analyzer folds
 * it into a back edge), not a new station — the draft only adds and never removes, so its station
 * count matches the analyzer's and no station disappears at handoff. The last unclosed `phase("ver`
 * gives the final station `typing`.
 */
export interface WorkflowDraftPhase {
  name: string;
  typing?: true;
}

export interface WorkflowDraft {
  phases: WorkflowDraftPhase[];
  /** Sub-agent names deduplicated in order of appearance (counted only, not drawn). */
  agents: string[];
}

const TOKEN = /\b(phase|agent)\(\s*(?:(["'`])([^"'`\n]*)(\2)?)?/gu;

export function scanWorkflowDraft(script: string): WorkflowDraft {
  const phases: WorkflowDraftPhase[] = [];
  const agents: string[] = [];
  for (const match of script.matchAll(TOKEN)) {
    const [, kind, quote, body, closing] = match;
    if (quote === undefined) continue;
    // The interpolation in the template literal only takes the header: `researcher${i}` is recorded as "researcher" - the shape of the name is better than leaving it empty.
    const name = (body ?? "").split("${")[0]!.trim();
    const closed = closing !== undefined;
    if (kind === "phase") {
      // The station that is already typing is the mark itself: the same place will be scanned multiple times under streaming mode, naming it instead of opening another station.
      const last = phases[phases.length - 1];
      if (last?.typing === true) {
        last.name = name;
        if (closed) delete last.typing;
        continue;
      }
      if (closed && phases.some((phase) => phase.name === name)) continue;
      phases.push({ name, ...(closed ? {} : { typing: true }) });
      continue;
    }
    if (!closed || name.length === 0) continue;
    if (!agents.includes(name)) agents.push(name);
  }
  return { agents, phases };
}

/**
 * Draft → timeline model: only stations and faint ink track segments, no pills, no arcs, no states.
 */
export function draftTimeline(draft: WorkflowDraft): WorkflowTimelineModel {
  const stations: TimelineStation[] = draft.phases.map((phase, i) => ({
    id: `draft:${i}`,
    naming: { id: `draft:${i}`, name: phase.name },
    onLoop: false,
    pills: [],
    rounds: 0,
    status: undefined,
    track: 0,
    visited: false,
    ...(phase.typing === true ? { typing: true as const } : {}),
  }));
  return {
    arcs: [],
    bands: [],
    draft: { agents: draft.agents.length },
    live: false,
    rails: stations.slice(1).map((_, i) => ({ from: i, ink: "faint" as const, to: i + 1 })),
    runningIndex: undefined,
    stations,
  };
}
