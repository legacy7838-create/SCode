/**
 * Read rules for the CreateWorkflow tool input arguments.
 *
 * Split out from `create-workflow.tsx`: these are pure functions, while the card component itself
 * grows linearly with run state, diagnostics, and graph interaction; once the two are stacked in
 * one file that file exceeds oxlint max-lines(400) (`rows.ts → toolDisplay.ts` and
 * `ToolCallBlocks.tsx → resolveRenderer.ts` are precedents for the same move). This file contains
 * no JSX and does not touch rendering.
 *
 * Defined once, consumed in three places — the chat card, the run confirmation dialog, the run
 * detail page — so the same input arguments never resolve differently on any one of those surfaces.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * In-progress kind copy phases (while the run is not linked yet). "Validating" only holds in the
 * `running` phase — the script is analyzed once in `prepareApproval`, well before the confirmation
 * dialog appears, while the model's script-writing `inputStreaming` phase can last tens of seconds.
 * Phases recognize only the v4 state the adapter attaches verbatim to raw; when it is absent,
 * nothing is guessed.
 *
 * When `amend` is true the amend vocabulary is used instead: the same renderer, the same set of
 * phases, only the words differ — the model is not starting something, it is changing something the
 * user is looking at.
 */
export function readWorkflowKindMessageId(
  raw: unknown,
  isRunning: boolean,
  amend = false,
  /**
   * This call only retunes concurrency (`isWorkflowRetuneInput`): it writes no script and does not
   * compile, so not a single word of "validating" may appear while it is in flight. The amend
   * vocabulary's `writing` word "Amending workflow" is unconditionally true for it — whether the
   * end result takes effect in place or (once the run has settled) falls back to a real amendment —
   * so the whole in-flight period uses it, rather than minting a new word for a phase that only
   * lives a few hundred milliseconds. Awaiting confirmation is another matter: when that phase is
   * present, its own word carries more information.
   */
  retuning = false,
): string {
  const ids = amend ? AMEND_KIND_IDS : CREATE_KIND_IDS;
  if (!isRunning) {
    return ids.ran;
  }

  const v4Status = isPlainRecord(raw) ? raw.v4Status : undefined;
  if (v4Status === "pendingApproval") {
    return ids.awaitingConfirmation;
  }
  if (v4Status === "inputStreaming" || retuning) {
    return ids.writing;
  }

  return ids.running;
}

/**
 * Kind words for the pre-launch ToolLayout row:
 * - Compile errors (display present and `ok === false`) say "Workflow draft (Amendment draft)" —
 *   nothing ran, this is a draft waiting to be fixed;
 * - Failed but no display (rejected, tool error) still says "Workflow (Workflow amendment)";
 * - While writing it says "Amending workflow", and from the 2nd draft onward "Revising amendment" —
 *   the model is responding to feedback rather than starting over;
 * - Everything else is awaiting confirmation. The same word table as `readWorkflowKindMessageId`,
 *   only the phase has already been computed by the renderer and passed in.
 */
export function readWorkflowPrelaunchKindMessageId(
  phase: { compileErrors: boolean; failed: boolean; writing: boolean; revising: boolean },
  amend: boolean,
): string {
  const ids = amend ? AMEND_KIND_IDS : CREATE_KIND_IDS;
  if (phase.compileErrors) return ids.draft;
  if (phase.failed) return ids.ran;
  if (phase.writing) return phase.revising ? ids.revising : ids.writing;
  return ids.awaitingConfirmation;
}

interface WorkflowKindIds {
  writing: string;
  revising: string;
  awaitingConfirmation: string;
  running: string;
  ran: string;
  draft: string;
}

const CREATE_KIND_IDS: WorkflowKindIds = {
  writing: "chat.toolCall.workflow.writing",
  revising: "chat.toolCall.workflow.revising",
  awaitingConfirmation: "chat.toolCall.workflow.awaitingConfirmation",
  running: "chat.toolCall.workflow.running",
  ran: "chat.toolCall.workflow.ran",
  draft: "chat.toolCall.workflow.draft",
};

/**
 * Amend vocabulary. `running` (validating) has no dedicated word: validation and creation are the
 * same thing, so the existing word is reused.
 */
const AMEND_KIND_IDS: WorkflowKindIds = {
  writing: "chat.toolCall.workflow.amend.writing",
  revising: "chat.toolCall.workflow.amend.revising",
  awaitingConfirmation: "chat.toolCall.workflow.amend.awaitingConfirmation",
  running: "chat.toolCall.workflow.running",
  ran: "chat.toolCall.workflow.amend.ran",
  draft: "chat.toolCall.workflow.amend.draft",
};

/**
 * Optional display name in the CreateWorkflow tool input; the chat card and the run confirmation
 * dialog share the same read rule.
 */
export function readWorkflowName(input: unknown): string | undefined {
  if (isPlainRecord(input) && typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

/**
 * Raw script text in the CreateWorkflow tool input; the chat card and the run confirmation dialog
 * share the same read rule.
 */
export function readWorkflowScript(input: unknown): string | undefined {
  if (isPlainRecord(input) && typeof input.script === "string" && input.script.length > 0) {
    return input.script;
  }

  return undefined;
}

/**
 * The predecessor run being amended, from the AmendWorkflow input arguments (`run_id`). Its
 * presence means this call supersedes: a new run is minted from the new script, caches are imported
 * from this predecessor, and if the predecessor is still running it is stopped first.
 *
 * The same discipline as `readWorkflowScript`: it travels through the **input argument channel**
 * rather than display, so lineage facts add zero new payload. It only matters for AmendWorkflow
 * rows — CreateWorkflow's input arguments have no `run_id`.
 */
export function readWorkflowAmendTarget(input: unknown): string | undefined {
  return isPlainRecord(input) ? readTrimmedString(input.run_id) : undefined;
}

/**
 * The block of predecessor facts that the CLI's `resolveInput` backfills into the AmendWorkflow
 * input arguments: the confirmation dialog uses `status` to decide whether to say "still running,
 * will be stopped". It reads only the two fields the confirmation dialog uses; the
 * `owned_by_this_session` field that drives permission decisions lives on the CLI side, and the UI
 * never looks at it.
 */
interface WorkflowAmendPredecessor {
  status: string | undefined;
  name: string | undefined;
}

export function readWorkflowAmendPredecessor(input: unknown): WorkflowAmendPredecessor | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.predecessor)) {
    return undefined;
  }
  const predecessor = input.predecessor;
  return {
    status: readTrimmedString(predecessor.status),
    name: readTrimmedString(predecessor.name),
  };
}

/**
 * `max_concurrency`: how many subagents the user asked this run to run at the same time. Create and
 * Amend use the same field name, so there is only one read rule.
 *
 * Only positive integers count: Amend's `null` (dropping the cap) and absence mean the same thing
 * in the confirmation dialog — there is no cap to report, so the row is not shown. The value
 * arriving here **is already the one that will take effect**: both tools' `resolveInput` clamp
 * requests over the ceiling before the confirmation dialog opens. So the clamp is not redone here —
 * it can neither reach the ceiling nor needs to. (Once the run is going, the concurrency chip in
 * the run header shows min(this bound, the shared cap), which is a separate concern.)
 */
export function readWorkflowMaxConcurrency(input: unknown): number | undefined {
  if (!isPlainRecord(input)) {
    return undefined;
  }
  const value = input.max_concurrency;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * This `AmendWorkflow` call **only retunes concurrency**: `run_id` + `max_concurrency`, with no
 * script source, no model change, and no name change. Such a call takes effect in place while the
 * run is still in flight: it does not stop this run, does not mint a new run, and does not compile
 * — the outcome is one sentence, and there is not even a display for it.
 *
 * **The input arguments are the only landing place for this fact on the wire**: the tool's
 * structured output does not go through v4 (it only has `text` and `display`), and all three
 * `create_workflow` display schemas are `.strict()` frozen field sets — one extra key makes an old
 * client drop the entire tool result. So the rendering is trimmed to the shape of the input
 * arguments, with zero protocol change.
 *
 * It looks only at the **shape** and does not predict the outcome: once the run has settled, the
 * same call falls back to a real amendment (carrying the predecessor's script into compilation).
 * That path leaves a display behind and mints a run that can be linked by toolCallId — both of them
 * are wiring-layer signals. While streaming, the input arguments match this shape only halfway (the
 * script has not streamed in yet), so in flight it is used solely to pick a word that is genuinely
 * correct for both outcomes, and never to change the shape of the row.
 */
export interface WorkflowRetuneCall {
  runId: string;
  /**
   * The cap the user asked for; `null` = drop this run's own bound (back to the local ceiling).
   *
   * ⚠ **Not clamped**: the CLI's `resolveInput` clamps it into `[1, ceiling]`, while what is read
   * here is the number the model emitted. So the display must compare it against the local ceiling,
   * and must never read this number out verbatim as the "concurrency actually in effect".
   */
  requested: number | null;
}

export function readWorkflowRetuneCall(input: unknown): WorkflowRetuneCall | undefined {
  if (!isPlainRecord(input)) return undefined;
  const runId = readWorkflowAmendTarget(input);
  if (runId === undefined) return undefined;
  const bound = input.max_concurrency;
  const requested = bound === null ? null : readWorkflowMaxConcurrency(input);
  if (requested === undefined) return undefined;
  // Any other intention is not to "just adjust the concurrency limit": the script and path need to be compiled, and the model and name need to be changed to a run.
  if (readWorkflowScript(input) !== undefined || readTrimmedString(input.path) !== undefined) {
    return undefined;
  }
  if (input.subagent_model !== undefined || input.name !== undefined) return undefined;
  return { runId, requested };
}

/**
 * `subagent_model`: which model this run's **subagents** run on. The same discipline as
 * `max_concurrency`: Create and Amend use the same field name, so there is only one read rule.
 *
 * Only non-empty strings count: Amend's `null` (falling back to the session model) and absence mean
 * the same thing in the confirmation dialog — subagents follow the session model, there is no
 * second model to report, so the row is not shown. The value arriving here **is already the one
 * that will take effect**: both tools' `resolveInput` resolve the user-supplied name into the
 * canonical string `providerId/modelId[$level]` before the confirmation dialog opens, so a call
 * that cannot be resolved never reaches the dialog. So no shape validation is done here — the UI is
 * not a second resolver.
 */
export function readWorkflowSubagentModel(input: unknown): string | undefined {
  return isPlainRecord(input) ? readTrimmedString(input.subagent_model) : undefined;
}

/**
 * This amendment reuses the predecessor's script. Each of the two surfaces has its own piece of
 * evidence, and there is only this one way of reading them:
 *
 * - The confirmation dialog reads the input arguments backfilled by the CLI's `resolveInput`: the
 *   script is already in there, and `predecessor.script_inherited` says it was carried over;
 * - The chat card reads the input arguments **as emitted by the model** (the row's input comes from
 *   the streaming arguments, and the backfill happens after that): neither script source `script`
 *   nor `path` being present is what means the script was omitted. A missing `script` alone does
 *   not count — a `path` amendment (the common case of "Script files") also carries no `script`,
 *   yet what it hands over is an edited script.
 *
 * The second piece of evidence only holds once the input arguments are **fully written** — while
 * streaming, the script may not have arrived yet, and callers are responsible for asking only
 * outside `inputStreaming`. When the input arguments are not a record (snapshotted down to a
 * preview, shape unknown), nothing is asserted at all.
 */
export function readWorkflowAmendScriptInherited(input: unknown): boolean {
  if (!isPlainRecord(input)) {
    return false;
  }
  if (isPlainRecord(input.predecessor) && input.predecessor.script_inherited === true) {
    return true;
  }
  return readWorkflowScript(input) === undefined && readTrimmedString(input.path) === undefined;
}

/**
 * The chat card's check: this row's input arguments say "reuses the predecessor's script". Nothing
 * is said when the input arguments are snapshotted down to a preview — what is missing then is
 * bytes, not the script. Callers are separately responsible for asking only about **fully written**
 * amend rows (while streaming, the script may not have arrived yet).
 */
export function readWorkflowCardKeptScript(toolCall: {
  input: unknown;
  snapshotRefs?: readonly { field: string }[];
}): boolean {
  const trimmed = (toolCall.snapshotRefs ?? []).some((ref) => ref.field === "input");
  return !trimmed && readWorkflowAmendScriptInherited(toolCall.input);
}

/** The predecessor is still in flight (pending / running): the amendment stops it first. */
export function isWorkflowAmendPredecessorLive(
  predecessor: WorkflowAmendPredecessor | undefined,
): boolean {
  return predecessor?.status === "running" || predecessor?.status === "pending";
}

/**
 * The saved source in CreateWorkflow's normalized input arguments (the "normalized shape" of the
 * reusable workflow spec: `{name, script, saved: {name, args, path, scope}}`).
 *
 * The same discipline as `readWorkflowScript`: these fields travel through the **input argument
 * channel** rather than display, so the chat card and the run confirmation dialog share this one
 * read rule instead of each parsing its own. An absent `saved` means an inline submission, not a
 * downgrade — the inline path keeps today's shape verbatim.
 */
export interface WorkflowSavedSource {
  name: string;
  path: string | undefined;
  scope: string | undefined;
  /**
   * The argument bag after validation backfill. An empty object when it is absent or malformed,
   * never undefined.
   */
  args: Record<string, unknown>;
}

export function readWorkflowSaved(input: unknown): WorkflowSavedSource | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.saved)) {
    return undefined;
  }

  const saved = input.saved;
  // The name is the source's identity: an unpronounceable name is treated as if there is no source, rather than rendering an empty logo.
  const name = typeof saved.name === "string" ? saved.name.trim() : "";
  if (name.length === 0) {
    return undefined;
  }

  return {
    name,
    path: readTrimmedString(saved.path),
    scope: readTrimmedString(saved.scope),
    args: isPlainRecord(saved.args) ? saved.args : {},
  };
}

/**
 * Display shape for argument / default values: strings verbatim (quotes would only add noise around
 * Chinese arguments), everything else as JSON — which keeps all four declared types (string /
 * number / boolean / json) readable.
 */
export function formatWorkflowArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Non-serializable values ​​such as circular references should not cause the entire confirmation window to collapse.
    return String(value);
  }
}
