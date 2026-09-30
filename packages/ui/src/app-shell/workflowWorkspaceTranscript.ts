// ============================================================
// Pure model of script transcript
// ============================================================
// One line of journal node → Material of a tool card: type (Read / Search / Git / Terminal), main text, command line,
// The stage and round, status words, and footer numbers. No React, no DOM, no access.
//
// Types are assigned by **op**, not by kind: `kind` is only divided into world-read / world-run, and the card requires "reading files"
// The four verbs of "finding things", "git" and "running commands" - they are exactly how the three facade containers of files / git / world are divided.
// There is no op in the history line before the upgrade (`input_json` is NULL), and the step label on the static image is returned. The type is the general "step".

import type { WorkflowRunState, WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { PhaseNaming } from "@/components/workflow-graph/phase-name.js";

export type WorkspaceCardKind = "read" | "search" | "git" | "terminal" | "step";

/**
 * Static material for one card (no state — state lives in `workspaceCardStatus`, because it also
 * has to overlay the live projection).
 */
export interface WorkspaceCardModel {
  /** React key, and the toolId / expanded-state memory key for ToolLayout. */
  key: string;
  node: WorkflowRunWorkspaceNode;
  kind: WorkspaceCardKind;
  op: string | undefined;
  /**
   * Read: path; Search: pattern (glob / grep); Git: subcommand + arguments; Terminal: command line;
   * Step: step label.
   */
  primary: string;
  /** The second Search argument (the glob scope for grep); the path for a Git diff. */
  secondary?: string;
  /** Terminal: `cmd arg…` (the line after the `$` in the expanded panel). */
  command?: string;
  /**
   * The phase it belongs to (looked up by station in the static graph); absent when the graph is
   * unavailable or the station is not on it.
   */
  phase?: PhaseNaming;
  /**
   * Which invocation of that station this is (journal sequence number); the source chip carries ⟳n
   * when > 1.
   */
  round: number;
}

interface WorkspaceCardStatus {
  status: WorkflowRunWorkspaceNode["status"];
  /** The live projection says this step was a cache hit on resume (the `replayed` chip). */
  replayed: boolean;
}

function argString(args: readonly unknown[] | undefined, index: number): string | undefined {
  const value = args?.[index];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function argList(args: readonly unknown[] | undefined, index: number): string[] {
  const value = args?.[index];
  if (Array.isArray(value)) return value.map((item) => String(item));
  // In truncation mode, the array actual parameter is already the JSON preview text.
  if (typeof value === "string" && value.startsWith("[")) return [value];
  return [];
}

/**
 * Display form of one argv: arguments containing spaces are quoted, matching how they are typed in
 * a terminal.
 */
function formatCommandLine(cmd: string, args: readonly string[]): string {
  const quote = (part: string) => (/[\s"']/.test(part) ? JSON.stringify(part) : part);
  return [cmd, ...args].map(quote).join(" ");
}

function workspaceCardKindOf(op: string | undefined): WorkspaceCardKind {
  if (op === undefined) return "step";
  if (op === "read") return "read";
  if (op === "glob" || op === "grep") return "search";
  if (op.startsWith("git-")) return "git";
  if (op === "run") return "terminal";
  return "step";
}

/** `git-changed-files` → `changed-files`; both the source chip and the main text use it. */
function gitSubcommand(op: string): string {
  return op.slice("git-".length);
}

/**
 * Station → phase lookup table. Steps in the static graph carry `phase`; `source ?? id` is the
 * station id (the copy expanded by may-set carries `source`). Scripts without a `phase()` marker
 * have no phases, so the table is empty and no card carries a source chip.
 */
function phaseBySiteId(graph: WorkflowCausalityGraphData | undefined): Map<string, PhaseNaming> {
  const table = new Map<string, PhaseNaming>();
  if (graph === undefined) return table;
  const phases = new Map((graph.phases ?? []).map((phase) => [phase.id, phase] as const));
  for (const step of graph.steps) {
    if (step.phase === undefined) continue;
    const phase = phases.get(step.phase);
    if (phase === undefined) continue;
    table.set(step.source ?? step.id, { id: phase.id, name: phase.name });
  }
  return table;
}

/** Station → static step label (the fallback main text for history rows). */
function stepLabelBySiteId(graph: WorkflowCausalityGraphData | undefined): Map<string, string> {
  const table = new Map<string, string>();
  for (const step of graph?.steps ?? []) table.set(step.source ?? step.id, step.label);
  return table;
}

export function buildWorkspaceCards(
  nodes: readonly WorkflowRunWorkspaceNode[],
  graph: WorkflowCausalityGraphData | undefined,
): WorkspaceCardModel[] {
  const phases = phaseBySiteId(graph);
  const labels = stepLabelBySiteId(graph);
  return nodes.map((node) => {
    const op = node.op;
    const kind = workspaceCardKindOf(op);
    const phase = phases.get(node.siteId);
    const base = {
      key: `${node.siteId}@${node.ordinal}`,
      node,
      kind,
      op,
      round: node.ordinal,
      ...(phase === undefined ? {} : { phase }),
    };
    const fallback = labels.get(node.siteId) ?? node.siteId;
    switch (kind) {
      case "read":
        return { ...base, primary: argString(node.args, 0) ?? fallback };
      case "search": {
        const scope = argString(node.args, 1);
        return {
          ...base,
          primary: argString(node.args, 0) ?? fallback,
          ...(scope === undefined ? {} : { secondary: scope }),
        };
      }
      case "git": {
        const sub = gitSubcommand(op!);
        const target = argString(node.args, 0);
        const shown = node.args?.map((arg) =>
          typeof arg === "string" ? arg : JSON.stringify(arg),
        );
        return {
          ...base,
          primary: `git ${formatCommandLine(sub, shown ?? [])}`,
          ...(target === undefined ? {} : { secondary: target }),
        };
      }
      case "terminal": {
        const cmd = argString(node.args, 0) ?? fallback;
        const command = formatCommandLine(cmd, argList(node.args, 1));
        return { ...base, primary: command, command };
      }
      default:
        return { ...base, primary: fallback };
    }
  });
}

/**
 * The live projection overlay: it only fills in `cached` (the replayed chip). State is
 * authoritative from the journal row — the moment the projection says settled while the journal
 * still says running is query lag, and the next `lastEventSequence` bump catches up; conversely,
 * when the journal is ahead of the projection (admission persists before the event is emitted) the
 * node is simply absent from the projection.
 */
export function workspaceCardStatus(
  node: WorkflowRunWorkspaceNode,
  run: WorkflowRunState | undefined,
): WorkspaceCardStatus {
  const live = run?.nodes.find(
    (candidate) => candidate.siteId === node.siteId && candidate.ordinal === node.ordinal,
  );
  return { status: node.status, replayed: live?.cached === true };
}

/**
 * Landing spot: the index of the first card of that phase; when the phase has not arrived yet (no
 * card) → -1 (the panel scrolls to the end).
 */
export function firstCardIndexOfPhase(
  cards: readonly WorkspaceCardModel[],
  phaseId: string,
): number {
  return cards.findIndex((card) => card.phase?.id === phaseId);
}

/** `1.3s` / `840ms` / `2m 05s`: how long one step took. */
export function formatWorkspaceDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** `4.1 KB` / `312 B` / `1.2 MB`: the size of the body text. */
export function formatWorkspaceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Criterion for the status word on a failure row: the driver's timeout code reads "timed out",
 * anything else reads the code itself.
 */
export function isTimeoutError(error: { code: string; message: string } | undefined): boolean {
  if (error === undefined) return false;
  return /timeout|timed ?out/i.test(error.code) || /timed out|timeout/i.test(error.message);
}
