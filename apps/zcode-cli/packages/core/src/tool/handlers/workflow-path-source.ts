// ============================================================
// `path` Source: Read a script file on disk into execution facts
// ============================================================
//
// Four tools share this section (`CreateWorkflow.path`, `AmendWorkflow.path`, `SaveWorkflow.script_path`,
// `EvalWorkflowSnippet.path`). The reason for sharing is not to save a few lines: they must give the same answer to "what is this file?"
// Answer, otherwise the same draft in Create is "save definition with metadata block", but in Save it becomes "The first line of the text is
// "Annotation" script - and that fork is only discovered once the user saves the draft as a definition.
//
// Read once, read only once: the read bytes are then brought all the way to hook, confirmation window and handler (contract of `resolveInput`),
// Modifying the document after it is approved will not change what will be executed.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SavedWorkflowMeta } from "@zcode/contracts";
import { SAVED_WORKFLOW_SENTINEL, parseSavedWorkflow } from "./saved-workflows/index.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";

/** A script file that was read successfully. */
interface WorkflowScriptFile {
  /** The absolute path (journal and model side each take what they need: the former stores it, the latter displays {@link described}). */
  path: string;
  /** The form the model side should see: a relative path when it is under the workspace, otherwise the absolute path. */
  described: string;
  /** The file's raw text, byte for byte. */
  source: string;
  /** The part that gets executed / saved: the body when there is a metadata block, otherwise the whole file. */
  script: string;
  /** The declarations parsed out of the metadata block; absent when the file has no block. */
  meta?: SavedWorkflowMeta;
  /** The number of lines before the body (0 when there is no block); added when diagnostics are reported by file line. */
  bodyLineOffset: number;
}

type WorkflowScriptFileResult =
  | { ok: true; file: WorkflowScriptFile }
  | { ok: false; message: string };

/**
 * A relative path is resolved against the session's working directory and an absolute path is
 * normalized as-is — the very same rule by which `Read` accepts a path (`resolveWorkspacePath`
 * in core/src/tool/path-policy.ts).
 *
 * That helper is deliberately not used here: it demands a `workspaceRoot`, while the context
 * of `resolveInput` (`ToolInputResolutionContext`) is deliberately narrowed to just
 * `workingDirectory`. The two behave identically for `operation: "read"` anyway — that
 * function currently does not hard-block paths outside the workspace, it only performs the
 * same resolve/normalize.
 */
function resolveWorkflowScriptFilePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
}

/**
 * Read a script file. When it cannot be read, or the metadata block is broken, return a
 * structured failure that **names the file** — without naming it, the model would just think
 * it mistyped something a moment ago and retry verbatim.
 *
 * `parseFrontmatter: false` is for `EvalWorkflowSnippet`: a snippet has none of the
 * saved-definition semantics, the whole file is code, and a snippet that happens to start
 * with `/* zcode-workflow` should not be swallowed as a declaration block either.
 */
export async function readWorkflowScriptFile(options: {
  cwd: string;
  inputPath: string;
  parseFrontmatter?: boolean;
}): Promise<WorkflowScriptFileResult> {
  const absolute = resolveWorkflowScriptFilePath(options.cwd, options.inputPath);
  const described = describeWorkflowScriptPath(absolute, options.cwd);

  let source: string;
  try {
    source = await readFile(absolute, "utf8");
  } catch (error) {
    return {
      ok: false,
      message: `The workflow script file ${described} could not be read: ${describeError(error)}. Pass \`path\` for a file that exists, or submit the script inline.`,
    };
  }

  const base = { path: absolute, described, source };
  if (options.parseFrontmatter === false || !startsWithSentinel(source)) {
    return { ok: true, file: { ...base, script: source, bodyLineOffset: 0 } };
  }

  const parsed = parseSavedWorkflow(source);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `The workflow script file ${described} starts with a \`${SAVED_WORKFLOW_SENTINEL}\` metadata block that could not be read (${parsed.reason}): ${parsed.detail}. Fix the block in that file, or remove it and pass the script alone.`,
    };
  }
  return {
    ok: true,
    file: {
      ...base,
      script: parsed.script,
      meta: parsed.meta,
      bodyLineOffset: parsed.bodyLineOffset,
    },
  };
}

/**
 * Whether the first non-blank line is the start marker. The criterion is word for word the
 * same as {@link parseSavedWorkflow}'s own entry check — if the two answer "is this a saved
 * definition?" differently, you get the corner case where "the tool says there is no block
 * but the parser says the block is broken".
 */
function startsWithSentinel(source: string): boolean {
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    return line.trim() === SAVED_WORKFLOW_SENTINEL;
  }
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
