// ============================================================
// AmendWorkflow - Which script should be run for this revision?
// ============================================================
//
// There are three sources of scripts, which are grouped into the same set of fields: `path` (normal: a script file modified in place), `script` (the entire inline copy),
// Neither will be given (the one saved by the precursor will be used). Split from resolveInput body (amend-workflow-resolve.ts)
// The reason is the same as `create-workflow-source.ts`: This is the place to **read the world** (script files, precursor archived scripts),
// The handler is the place that changes the world. When the two are mixed together, the next person will naturally read the disk again in the handler, and the confirmation window will see
// It is no longer the byte that will be executed.

import {
  AMEND_WORKFLOW_SOURCE_ERROR,
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type AmendWorkflowPredecessor,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
} from "@zcode/contracts";
import type { ToolHandlerFailure } from "../types.js";
import { clampWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";

/**
 * The local failure code table. The numbers are merely log positions (the executor projects them as `code: "N"`), the
 * discriminator lives in the message prefix; `run_not_found` reuses the same key and code from the introspection
 * table ("the referenced run does not exist" is one and the same thing across the three tools).
 * Numbering starts at 21 only so as not to collide visually with the introspection table (1/2) and
 * ResumeWorkflowRun (11-15).
 */
export const AMEND_WORKFLOW_ERROR_CODE = {
  AMEND_UNAVAILABLE: 21,
  MISSING_BOUNDARIES: 22,
  SUBAGENT_MODEL: 23,
  SCRIPT_UNCHANGED: 24,
  SCRIPT_FILE: 25,
  SCRIPT_UNAVAILABLE: 26,
  // Only change the three rejections of the concurrent route; none of the three will be run.
  RETUNE_UNCHANGED: 27,
  RUN_SETTLED: 28,
  NOT_RETUNABLE: 29,
} as const;

/** The code for an input-level violation (both sources given) — the same 400 as in `CreateWorkflow`. */
const AMEND_WORKFLOW_INPUT_FAILURE_CODE = 400;

/**
 * An amendment supplies the script **at most once**, and only for inputs coming from the model (same reasoning as
 * `validateCreateWorkflowSource`: after normalization, `script` and `path` being present together is a legal
 * execution state). Supplying neither is not a violation — that means "inherit the predecessor's script".
 */
export function validateAmendWorkflowSource(input: unknown): { result: true } | ToolHandlerFailure {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  if (parsed.data.script !== undefined && parsed.data.path !== undefined) {
    return {
      result: false,
      errorCode: AMEND_WORKFLOW_INPUT_FAILURE_CODE,
      message: AMEND_WORKFLOW_SOURCE_ERROR,
    };
  }
  return { result: true };
}

/**
 * Both sources were omitted, yet there is no script to inherit. Two causes share one discriminator key: for the
 * model the next step is the same thing — hand the script over.
 *
 *   - `record`: the predecessor's record holds no script (a run from before scripts were persisted);
 *   - `host`: this session has no run port, or the port carries no `getScript` (an old host).
 */
export function scriptUnavailableFailure(
  runId: string,
  cause: "record" | "host",
): ToolHandlerFailure {
  const why =
    cause === "record"
      ? `run ${runId} has no stored script to keep (it predates script persistence)`
      : `this host cannot read run ${runId}'s stored script`;
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_UNAVAILABLE,
    message: `workflow_amend_script_unavailable: ${why}, so the script cannot be omitted here — pass the whole script as \`script\`, or its file as \`path\`. Nothing was stopped or created.`,
  };
}

/**
 * Three-state normalization of the concurrency ceiling:
 *
 *   - a number -> clamped to `[1, the ceiling]`;
 *   - `null` -> cleared, and the key disappears entirely (the new run runs at the ceiling);
 *   - omitted -> inherit the predecessor's ceiling. The snapshot carries `maxConcurrency` **only when it is
 *     below the ceiling**, so "the predecessor never set it" and "the predecessor runs at the ceiling" are the
 *     same thing here: the key disappears as well. The inherited value gets clamped once more too — the
 *     predecessor may have been started on another machine (with another ceiling).
 *
 * The three states live only this far: past the confirmation window and the handler, what is left is only "a number or
 * nothing". **The one exception is the in-place concurrency route** (amend-workflow-retune.ts):
 * `retuneConcurrency` takes `number | null` itself, only the port knows the ceiling number,
 * and the tool should not guess it a second time.
 */
export function resolveAmendMaxConcurrency(
  requested: number | null | undefined,
  inherited: number | undefined,
  ceiling: number | undefined,
): { max_concurrency?: number } {
  if (requested === null) return {};
  const resolved = requested ?? inherited;
  if (resolved === undefined) return {};
  return { max_concurrency: clampWorkflowMaxConcurrency(resolved, ceiling) };
}

/**
 * The predecessor fact block. resolveInput and the fallback path of the in-place
 * concurrency change (re-reading the snapshot once inside a settlement race) share this one derivation, so the two
 * places never give different answers to "what state does this run count as right now".
 */
export function describePredecessor(
  snapshot: DynamicWorkflowRunSnapshot,
  sessionId: string | undefined,
): AmendWorkflowPredecessor {
  // The `status` of the snapshot is the common word for the tracker (stopped is folded into canceled...); the real word is in `runStatus`, only in
  // The final state is present - all non-final states are pronounced running (pending here is no different from running: both are stopped by amend).
  const status = snapshot.runStatus ?? "running";
  return {
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    status,
    ...(snapshot.stopReason === undefined ? {} : { stop_reason: snapshot.stopReason }),
    owned_by_this_session:
      sessionId !== undefined &&
      snapshot.parentSessionId !== undefined &&
      snapshot.parentSessionId === sessionId,
  };
}

/** The script fields produced by normalization (the same shape for all three sources), plus the file spelling the model side should see and whether it is inherited. */
type AmendScriptResolution =
  | {
      result: true;
      fields: { script: string; path?: string; script_line_offset?: number };
      described?: string;
      inherited: boolean;
    }
  | ToolHandlerFailure;

/**
 * Three sources normalized into one and the same set of fields.
 *
 *   - `path`: read the file. When it carries a metadata block the block is stripped and its **declaration
 *     ignored** — an amendment carries no arguments (the arguments are facts of the predecessor's run and travel
 *     with the journal), so there is nothing here to validate; the block still has to be stripped, otherwise it
 *     would be fed to the compiler as part of the script.
 *   - `script`: as-is.
 *   - both omitted: the archived copy of the predecessor's script, read through the port (the very same bytes a
 *     resume replays). The read happens in resolveInput and not in the handler: the confirmation window has to
 *     draw the script that is about to run, and the hook and project rules have to match it too, and both of
 *     those sit before the handler. An empty string means the same as absence — the runtime schema's
 *     `.min(1)` does not accept an empty script. An inherited script also has to be recognized at home once
 *     ({@link resolveKeptScriptFile}): if the predecessor's script file still holds these very bytes, the new run
 *     keeps recording it, otherwise `path` is absent and the handler writes a fresh draft by the rules for
 *     "a script that does not come from a file".
 *
 * When `port` is absent (an unwired host) the first two still work, the third has nothing to inherit from, and it fails on the spot.
 */
export async function resolveAmendScript(options: {
  model: AmendWorkflowInput;
  cwd: string;
  port: DynamicWorkflowRunPort | undefined;
  /** The script file on the predecessor's snapshot (an absolute path); used to recognize the home of an inherited script. */
  predecessorScriptPath: string | undefined;
}): Promise<AmendScriptResolution> {
  const { model, cwd, port } = options;
  if (model.path !== undefined) {
    const read = await readWorkflowScriptFile({ cwd, inputPath: model.path });
    if (!read.ok) {
      return {
        result: false,
        errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_FILE,
        message: `workflow_script_file_unreadable: ${read.message} Nothing was stopped or created.`,
      };
    }
    return {
      result: true,
      inherited: false,
      described: read.file.described,
      fields: {
        script: read.file.script,
        path: read.file.path,
        ...(read.file.bodyLineOffset === 0 ? {} : { script_line_offset: read.file.bodyLineOffset }),
      },
    };
  }
  if (model.script !== undefined) {
    return { result: true, inherited: false, fields: { script: model.script } };
  }
  if (port === undefined || typeof port.getScript !== "function") {
    return scriptUnavailableFailure(model.run_id, "host");
  }
  const stored = await port.getScript(model.run_id);
  if (stored === undefined || stored.length === 0) {
    return scriptUnavailableFailure(model.run_id, "record");
  }
  const kept = await resolveKeptScriptFile({
    cwd,
    scriptPath: options.predecessorScriptPath,
    script: stored,
  });
  return {
    result: true,
    inherited: true,
    ...(kept === undefined ? {} : { described: kept.described }),
    fields: {
      script: stored,
      ...(kept === undefined
        ? {}
        : {
            path: kept.path,
            ...(kept.lineOffset === 0 ? {} : { script_line_offset: kept.lineOffset }),
          }),
    },
  };
}

/**
 * Recognizing the home of an inherited script: if the script file the predecessor recorded still **at this very
 * moment** reads back as the very bytes being inherited, the new run keeps recording that file — the script has
 * not changed, the file has not changed, so it is the new run's script file and the model still edits it on its
 * next amendment. The tool's inheritance and the GUI's "configure" share exactly this rule.
 *
 * Any mismatch at all (the predecessor recorded no file, the file is gone, it cannot be read, or it has already
 * been edited) returns `undefined`: the caller then writes a fresh draft by the rules for "a script that does
 * not come from a file". It never records a file on a new run whose contents are no longer that script — that
 * would make both the diagnostic line numbers and the "go edit that file" instruction point at different code.
 */
export async function resolveKeptScriptFile(options: {
  cwd: string;
  scriptPath: string | undefined;
  script: string;
}): Promise<{ path: string; described: string; lineOffset: number } | undefined> {
  if (options.scriptPath === undefined) return undefined;
  const read = await readWorkflowScriptFile({ cwd: options.cwd, inputPath: options.scriptPath });
  if (!read.ok || read.file.script !== options.script) return undefined;
  return {
    path: read.file.path,
    described: read.file.described,
    lineOffset: read.file.bodyLineOffset,
  };
}

/**
 * The pre-check for "the file was not edited".
 *
 * It only holds for a `path` **given by the model**: what this net catches is **forgetting to edit**, while
 * pasting the script in again, or stating outright that the script stays as it is
 * (both sources omitted), is not that mistake. It also only holds when this call changes nothing else — an
 * amendment that also sets `max_concurrency` or `subagent_model` has a meaning of its own, and leaving the
 * script untouched is entirely legitimate there (`null` counts as "given": it is an explicit clearing).
 *
 * `getScript` is an optional member of the port, and when it is absent this pre-check is skipped: it is a
 * convenience, not a gate on correctness.
 */
export async function refuseUnchangedScript(options: {
  port: DynamicWorkflowRunPort;
  /** The inputs coming from the model (before normalization): a `path` backfilled during inheritance does not count as "given by the model". */
  model: AmendWorkflowInput;
  resolvedScript: string;
  described: string | undefined;
}): Promise<ToolHandlerFailure | undefined> {
  const { port, model, resolvedScript, described } = options;
  if (model.path === undefined) return undefined;
  if (model.max_concurrency !== undefined || model.subagent_model !== undefined) return undefined;
  if (typeof port.getScript !== "function") return undefined;

  const previous = await port.getScript(model.run_id);
  if (previous === undefined || previous !== resolvedScript) return undefined;
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_UNCHANGED,
    message: `workflow_script_unchanged: ${described ?? model.path} is byte-for-byte the script run ${model.run_id} was started with, so amending it would repeat that run exactly. Edit the file first, then call AmendWorkflow again with the same \`path\`; to change only the settings, pass them and omit \`path\`; to continue a stopped run under the same script, use ResumeWorkflowRun. Nothing was stopped or created.`,
  };
}
