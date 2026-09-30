import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CircleHelpIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import {
  pillActivity,
  type TimelinePill,
  type WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import {
  ROSTER_PINS_PANE,
  pillInstanceKey,
  rosterMore,
  rosterRestCounts,
  rosterRoll,
  stationRosterOf,
} from "@/components/workflow-timeline/roster-model.js";
import {
  WorkflowAgentPill,
  type WorkflowAgentPillOpen,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";
import { WorkflowRoll } from "@/components/workflow-timeline/WorkflowRoll.js";
import { RosterMeter } from "@/components/workflow-timeline/WorkflowRosterParts.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  AvatarCluster,
  Rounds,
  SpineLamp,
  SpinePieces,
} from "@/app-shell/WorkflowRunSpineParts.js";
import { spineSections } from "@/app-shell/workflowRunSpine.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The ridge of the run details page: the horizontal timeline on the card is at
 * Read it vertically here. A track is attached to the left edge from top to bottom. The stage is the light on the track. The ink mark on the track becomes darker as the control flow passes and enters.
 * The running phase progresses; the sub-agent is the pill (the same one on the card) hanging on the right side of the lamp that fills the column, and the upgrade problem hangs on
 * Below the questioner's line, take another step back. **Don’t draw back edges**: That’s a card issue. The `⟳ n` in the section header has already said how many rounds this station has run.
 *
 * The ink and status of track segments and lights all read the same model of `buildWorkflowTimeline` (invariant 1: one model, three places
 * consumption). Track segments are only drawn between two adjacent stations whose model has `rails` - the same rules as for cards, leaving empty adjacent edges.
 *
 * The parallel stages (the **band** of the model) are here read as indents: the branch tracks curve away from the main track from the top of the first section of the band, all the way up to the section.
 * Stand it up, go to the top of the node of the merging station and come back; the node head of the branch station moves 12px to the right together with the pill, and the main track passes through it as usual. every section
 * Which vertical rails and curves to draw are calculated by `workflowRunSpine.ts`, I just follow them here. **Do not draw back edges** (same as above).
 *
 * During the folding stage, there is a string of avatars (up to 3 + `+n`) at the head of the section: folding cannot make "who is at this station" invisible.
 * The running stage expands by itself: **Every station** that is running is opened (two tracks in the belt can be running at the same time), and the expanded ones are not moved.
 *
 * The station where participants have passed the threshold is the roster (note postscript "stage roster", "a door and a roll list"): nail 5 pills (asking → running →
 * failed → filling the spot), the sixth one is the door (closes the counting row with the rest of the people), behind the door is the list of the rest of the people - once for each person, grouped by status,
 * Two columns of `row` pills; the avatar string on the folded section header is replaced by a mini measuring bar. A sub-agent that is not listed in the world (`station.unlisted`) comes in.
 * There are no rows for the number of people, counting rows and measuring strips, so a line of plain text is used at the end of the list to explain the difference.
 *
 * Drop point: the line "n more" on the card or the station head. Give the station id to the host and bring it with the tab
 * `focusPhaseId` Go here - expand this station, open the door, roll the section header to the top, brighten the background color and then return. Open once and only drop once
 * (The key contains openedAt. If you click the same site again, it will drop again); after that, the user will run away without pursuing.
 */
const QUESTION_TICK_MS = 30_000;
/** The duration of the landing click: 400 ms, then 800 ms to return (`.wf-landed`). */
const LANDING_MS = 1200;

function questionKey(question: WorkflowRunPendingQuestion): string | undefined {
  return question.actorSiteId === undefined || question.actorOrdinal === undefined
    ? undefined
    : `${question.actorSiteId}@${question.actorOrdinal}`;
}

const pillKey = pillInstanceKey;

export const WorkflowRunPhaseList = memo(function WorkflowRunPhaseList({
  graph,
  landing,
  model,
  onOpenActor,
  onOpenWorkspace,
  pendingQuestions,
  run,
}: {
  graph: WorkflowCausalityGraphData;
  model: WorkflowTimelineModel;
  run: WorkflowRunState | undefined;
  pendingQuestions: readonly WorkflowRunPendingQuestion[];
  /** Open the actor transcript tab (slots without sessions are opened as placeholders). Its absence makes it impossible - the very existence of the callback is the gate. */
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  /** Open the transcript tab and go to this site; if it is absent, the script cannot be clicked. */
  onOpenWorkspace?: (phaseId: string) => void;
  /** Drop point: `key` is different every time it is opened (`phaseId@openedAt`). Clicking the same station again will not drop it again. */
  landing?: { phaseId: string; key: string };
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  // The running station unfolds itself - two tracks in the belt can be running at the same time, and each one must be open, not just the rightmost one.
  // Remember this group of ids with a stable key: the model changes its identity every time the projection moves, but this group usually does not change.
  const runningKey = model.stations
    .filter((station) => station.status === "running")
    .map((station) => station.id)
    .join("\u0000");
  const runningIds = useMemo(
    () => (runningKey === "" ? [] : runningKey.split("\u0000")),
    [runningKey],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(runningIds));
  useEffect(() => {
    setOpen((previous) =>
      runningIds.every((id) => previous.has(id)) ? previous : new Set([...previous, ...runningIds]),
    );
  }, [runningIds]);
  const toggle = useCallback((id: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // The door of the roster station: when it is opened, the list will be listed, the partial status of the list, and the station will be recorded.
  const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleListed = useCallback((id: string) => {
    setListed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Drop point: expand + open the door + light up; scrolling after the next submission (that section must be expanded first before the section header can be rolled).
  // `landed` means pressing the key of the landing point (not pressing the station): if the same station is landed again, the key changes, scrolling and lighting are repeated.
  const rootRef = useRef<HTMLDivElement>(null);
  const landedOnceRef = useRef<string | undefined>(undefined);
  const [landed, setLanded] = useState<{ phaseId: string; key: string } | undefined>(undefined);
  useEffect(() => {
    if (landing === undefined || landedOnceRef.current === landing.key) return undefined;
    landedOnceRef.current = landing.key;
    const { phaseId } = landing;
    setOpen((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setListed((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setLanded(landing);
    const timer = setTimeout(
      () => setLanded((current) => (current?.key === landing.key ? undefined : current)),
      LANDING_MS,
    );
    return () => clearTimeout(timer);
  }, [landing]);
  useEffect(() => {
    if (landed === undefined) return;
    const root = rootRef.current;
    if (root === null) return;
    const section = [...root.querySelectorAll<HTMLElement>("[data-phase-id]")].find(
      (candidate) => candidate.getAttribute("data-phase-id") === landed.phaseId,
    );
    const head = section?.querySelector<HTMLElement>('[data-testid="workflow-run-phase-toggle"]');
    if (head === undefined || head === null || typeof head.scrollIntoView !== "function") return;
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    head.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [landed]);

  // You have to wait for the length of time to go by yourself: a run that is waiting for an answer does not send an event. The timer only exists when there is a problem.
  const [now, setNow] = useState(() => Date.now());
  const hasQuestions = pendingQuestions.length > 0;
  useEffect(() => {
    if (!hasQuestions) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), QUESTION_TICK_MS);
    return () => clearInterval(timer);
  }, [hasQuestions]);

  const questionsByInstance = useMemo(() => {
    const byKey = new Map<string, WorkflowRunPendingQuestion[]>();
    for (const question of pendingQuestions) {
      const key = questionKey(question);
      if (key === undefined) continue;
      const list = byKey.get(key) ?? [];
      list.push(question);
      byKey.set(key, list);
    }
    return byKey;
  }, [pendingQuestions]);
  const attachedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const station of model.stations) {
      for (const pill of station.pills) {
        const key = pillKey(pill);
        if (key !== undefined) keys.add(key);
      }
    }
    return keys;
  }, [model]);
  const orphanQuestions = pendingQuestions.filter((question) => {
    const key = questionKey(question);
    return key === undefined || !attachedKeys.has(key);
  });
  // The vertical rails and curves to be drawn in each section (`workflowRunSpine.ts`): press **pairs** to check the track segments, do not press from——within
  // A stop can be the left end of both a double line segment and a main line segment.
  const sections = spineSections(model);
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const phaseNameOf = (phaseId: string) => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };

  // Then hand over the slot identity: if the session id is present, then go with it; if not, open the placeholder tab.
  const openActor = (pill: TimelinePill) => {
    const slot = pill.slot;
    if (onOpenActor === undefined || slot === undefined) return;
    const sessionId = pill.instance?.sessionId;
    onOpenActor({
      ordinal: slot.ordinal,
      ...(sessionId === undefined ? {} : { sessionId }),
      siteId: slot.siteId,
      status:
        pill.status === "running"
          ? "running"
          : pill.status === "done" || pill.status === "failed"
            ? "completed"
            : "waiting",
      ...(pill.runtimeName === undefined ? {} : { name: pill.runtimeName }),
    });
  };

  /** Common wiring for pills (name, status, openable); the entire row of pills is shared with the "List All" row of pills. */
  const pillProps = (pill: TimelinePill) => {
    const label = nameOf(pill);
    const openable = onOpenActor !== undefined && pill.slot !== undefined;
    // The same script line opens the syntax: open the entire run script transcript and fall to the first card of this station.
    const workspacePhaseId = onOpenWorkspace === undefined ? undefined : pill.workspace?.phaseId;
    const open: WorkflowAgentPillOpen | undefined = openable
      ? {
          data: {
            "data-agent-key": pillKey(pill) ?? "",
            "data-agent-session-id": pill.instance?.sessionId ?? "",
            "data-agent-status": pill.status ?? "pending",
          },
          label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
          onOpen: () => openActor(pill),
          testId: "workflow-run-agent-open",
        }
      : workspacePhaseId !== undefined
        ? {
            data: { "data-phase-id": workspacePhaseId },
            label: format(
              { id: "chat.toolCall.workflow.timeline.openScript" },
              { phase: phaseNameOf(workspacePhaseId) },
            ),
            onOpen: () => onOpenWorkspace?.(workspacePhaseId),
            testId: "workflow-run-workspace-open",
          }
        : undefined;
    return {
      avatarIndex: pill.avatarIndex,
      laneClass: pill.laneClass,
      name: label,
      status: pill.status,
      title: label,
      ...(open === undefined ? {} : { open }),
    };
  };

  const renderPill = (pill: TimelinePill) => {
    const activity = pillActivity(graph, run, pill);
    const key = pillKey(pill);
    const questions = key === undefined ? [] : (questionsByInstance.get(key) ?? []);
    const counts: string[] = [];
    if (activity.asks > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.tasks" }, { count: activity.asks }),
      );
    }
    if (activity.reads > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.reads" }, { count: activity.reads }),
      );
    }
    // The openable pill is <button>: it only wraps the content in the block-level parent element, and the line width will vary according to the length of the name.
    // Vertical flex containers allow each row to fill the width of its own column (the same mechanism used to create columns of pills above and below the card).
    return (
      <div className="flex min-w-0 flex-col" key={pill.key}>
        <WorkflowAgentPill {...pillProps(pill)}>
          {counts.length === 0 ? null : (
            <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
              {counts.join(" · ")}
            </span>
          )}
        </WorkflowAgentPill>
        {/* The question hangs below the questioner, and one step back (26px): it belongs to this row, not to this station. */}
        {questions.map((question) => (
          <WorkflowRunQuestionRow
            className="ml-[26px]"
            key={question.qid}
            now={now}
            question={question}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      className="wf-motion flex min-h-0 flex-1 flex-col overflow-auto pb-3 pt-2.5"
      data-testid="workflow-run-phases"
      ref={rootRef}
    >
      {model.stations.map((station, index) => {
        const expanded = open.has(station.id);
        const name = phaseDisplayName(station.naming, format);
        const status = station.status ?? "pending";
        const pending = status === "pending";
        const spine = sections[index] ?? { curves: [], rails: [] };
        // The entire section of the branch station is moved one space to the right: the section header, pills and lights are together, and there is 12px between the tracks.
        const indent = station.track === 0 ? undefined : { paddingLeft: 39 + 12 * station.track };
        const roster = stationRosterOf(station, ROSTER_PINS_PANE);
        return (
          <section
            className="relative"
            data-phase-id={station.id}
            data-phase-landed={landed?.phaseId === station.id ? "true" : undefined}
            data-phase-open={expanded ? "true" : "false"}
            data-phase-status={status}
            data-phase-track={station.track}
            data-testid="workflow-run-phase"
            key={station.id}
          >
            <SpinePieces section={spine} />
            <button
              aria-expanded={expanded}
              aria-label={intl.formatMessage(
                {
                  id: expanded
                    ? "chat.toolCall.workflow.run.phase.collapse"
                    : "chat.toolCall.workflow.run.phase.expand",
                },
                { name },
              )}
              className={cn(
                "wf-station-open relative flex h-9 w-full items-center gap-2 pl-[39px] pr-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40",
                landed?.phaseId === station.id && "wf-landed",
              )}
              data-testid="workflow-run-phase-toggle"
              // Change the key and re-hang the section header when falling again: the same class name will not cause the CSS animation to restart.
              key={landed?.phaseId === station.id ? landed.key : "head"}
              onClick={() => toggle(station.id)}
              style={indent}
              type="button"
            >
              <SpineLamp status={status} track={station.track} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-ui-base",
                  pending ? "text-foreground-subtle" : "font-medium text-foreground",
                )}
              >
                {name}
              </span>
              <span className="flex shrink-0 items-center gap-2.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                {expanded ? null : roster !== undefined ? (
                  <RosterMeter counts={roster.counts} mini />
                ) : (
                  <AvatarCluster nameOf={nameOf} pills={station.pills} />
                )}
                {station.fraction === undefined ? null : (
                  <span data-testid="workflow-run-phase-fraction">
                    {station.fraction.settled}/{station.fraction.observed}
                  </span>
                )}
                <Rounds station={station} />
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                />
              </span>
            </button>
            {expanded ? (
              <div
                className="wf-unfold flex flex-col gap-1.5 pb-3 pl-[39px] pr-3 pt-0.5"
                style={indent}
              >
                {roster === undefined ? (
                  station.pills.map(renderPill)
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5" data-testid="workflow-roster-pins">
                      {roster.pinned.map(renderPill)}
                    </div>
                    <WorkflowMoreRow
                      door={{
                        open: listed.has(station.id),
                        tally: rosterRestCounts(roster),
                      }}
                      more={rosterMore(roster)}
                      onOpen={() => toggleListed(station.id)}
                    />
                    {listed.has(station.id) ? (
                      <WorkflowRoll
                        groups={rosterRoll(roster)}
                        unlisted={roster.unlisted.actors}
                        renderRow={(pill, enterDelayMs) => (
                          <WorkflowAgentPill
                            enterDelayMs={enterDelayMs}
                            key={pill.key}
                            size="row"
                            {...pillProps(pill)}
                          >
                            {/* The sixth and subsequent questioners fall on the list: the one before the tail slot?, the question itself will not be repeated here. */}
                            {pill.asking === true ? (
                              <CircleHelpIcon
                                aria-hidden
                                className="size-3 shrink-0 text-warning"
                                data-testid="workflow-roll-asking"
                              />
                            ) : null}
                          </WorkflowAgentPill>
                        )}
                      />
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </section>
        );
      })}
      {orphanQuestions.length === 0 ? null : (
        <div
          className="flex flex-col gap-1 pl-[39px] pr-3 pt-2"
          data-testid="workflow-run-orphan-questions"
        >
          <span className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.questions.title" })}
          </span>
          {orphanQuestions.map((question) => (
            <WorkflowRunQuestionRow key={question.qid} now={now} question={question} showAsker />
          ))}
        </div>
      )}
    </div>
  );
});
