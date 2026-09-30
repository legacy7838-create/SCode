// ============================================================
// Workflow draft path - Pure judgment of "Does this writing target fall in the draft directory?"
// ============================================================
//
// There are two reasons for forming a separate module: PermissionService only needs a Boolean value and does not need to know how to compare paths;
// This judgment is the **only** gate that does not require confirmation, and must be able to be tested case by case without service (including Windows semantics).
// The file system is not touched in the whole process: no realpath, no stat. Permission determination must be a pure function - the same input on any machine
// The same answer is given, and "not released" will not be misjudged as "released" because of a disk read failure.

import nodePath from "node:path";

import { WORKFLOW_DRAFTS_DIR } from "@zcode/contracts";

/**
 * The subset of `node:path` the decision needs. It is a parameter so that tests can inject `path.win32` / `path.posix`:
 * Windows semantics such as drive letters, backslashes, and casing only count as verified once they have been run through the win32 implementation.
 */
interface WorkflowDraftPathModule {
  isAbsolute: (path: string) => boolean;
  relative: (from: string, to: string) => string;
  resolve: (...paths: string[]) => string;
}

interface WorkflowDraftPathInput {
  /** The write target in the tool input; a relative path is resolved against workingDirectory, an absolute path is kept as-is. */
  filePath: string;
  /** The session working directory; absent (empty string) means the predicate does not hold, see below. */
  workingDirectory: string;
  /** The platform path implementation, defaulting to the current platform's `node:path`. */
  pathModule?: WorkflowDraftPathModule;
}

/**
 * The built-in file-writing tools that hit the draft no-confirmation rule. These two share the `edit` permission name, and both point at their
 * target through a single `file_path` — only then does it make sense to decide "is the target inside the draft directory". ApplyPatch, although it is also `edit`, is not on the list: its input is the
 * `patch_text` patch body, which can modify several files at once, so there is no single path to decide on.
 */
const WORKFLOW_DRAFT_PREAPPROVED_TOOL_NAMES = new Set(["Edit", "Write"]);

interface WorkflowDraftWriteInput {
  toolName: string;
  /** The tool input (not yet parsed against the specific tool's schema); only `file_path` is taken from it. */
  input: unknown;
  /** The session working directory; it may be absent when the caller cannot obtain it, and absent means no confirmation exemption. */
  workingDirectory?: string;
  pathModule?: WorkflowDraftPathModule;
}

/**
 * Whether this tool invocation is "writing into the draft directory", that is, whether the confirmation dialog can be skipped.
 *
 * Why it is safe: that directory belongs to the machine — the files inside are written by the tool itself, the directory carries a `*` .gitignore
 * and stays out of version control, users will not put anything in it that needs protecting, and changing a draft affects nothing in the project. And "let the script run" has a separate
 * gate: CreateWorkflow declares alwaysAsk, and the confirmation dialog looks at the script as submitted, no matter what that file was
 * edited into along the way. So letting writes through here is not the same as letting any execution through.
 *
 * Without a workingDirectory (the caller did not pass one) the predicate simply never holds: the precondition for skipping confirmation is being able to
 * compute where the target lands, and when that cannot be computed, the dialog that should appear still appears.
 */
export function isPreapprovedWorkflowDraftWrite(input: WorkflowDraftWriteInput): boolean {
  if (!WORKFLOW_DRAFT_PREAPPROVED_TOOL_NAMES.has(input.toolName)) return false;
  if (typeof input.workingDirectory !== "string") return false;
  if (!input.input || typeof input.input !== "object") return false;
  const filePath = (input.input as Record<string, unknown>).file_path;
  if (typeof filePath !== "string") return false;
  return isWorkflowDraftPath({
    filePath,
    pathModule: input.pathModule,
    workingDirectory: input.workingDirectory,
  });
}

/** Whether `filePath` lands inside `<workingDirectory>/.zcode/workflow-drafts/`. */
function isWorkflowDraftPath(input: WorkflowDraftPathInput): boolean {
  const path = input.pathModule ?? nodePath;
  // Without a working directory, there is no "draft directory for a project" at all. It is better not to release it: the premise of avoiding confirmation is that the target can be located.
  if (input.workingDirectory.length === 0 || input.filePath.length === 0) return false;

  const draftsDir = path.resolve(input.workingDirectory, WORKFLOW_DRAFTS_DIR);
  const resolved = path.resolve(input.workingDirectory, input.filePath);
  const relativePath = path.relative(draftsDir, resolved);

  // Three conditions are indispensable: non-empty excludes "the target is the directory itself", non-absolute excludes spanning drive letters (on Windows
  // `relative("C:\\a", "D:\\b")` returns the absolute path instead of `..`), not starting with `..` excludes traversal.
  // Only look at the path string, not the file system: `.zcode/workflow-drafts-other/x.ts` so it will not be affected by the prefix
  // The same is misjudged as being in the directory - `relative` gives `../workflow-drafts-other/x.ts`.
  return (
    relativePath.length > 0 && !path.isAbsolute(relativePath) && !relativePath.startsWith("..")
  );
}
