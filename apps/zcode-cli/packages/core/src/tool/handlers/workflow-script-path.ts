// ============================================================
// How to write the workflow script file on the model side
// ============================================================
// What is stored in the journal is always an absolute path: it is part of the run identity, and the working directory of the session will change (`cd`,
// If another session reads the same run), the relative path will point to other files elsewhere if saved.
//
// But what the model sees should be the workspace form: its next step is to `Edit` this file, and the workspace-relative path
// Just the one it uses when reading and writing files elsewhere. The two differ only by this one pure function — minted once, shared by all three model-facing surfaces
// (final-state notification, `GetWorkflowRun`, tool response), so it cannot diverge among the three.

import path from "node:path";

/**
 * Writes the script file's absolute path in the form the model side should see: a workspace
 * relative path when it is under the session's working directory, otherwise the absolute path
 * unchanged.
 *
 * The criterion for "under the working directory" is that the result of `path.relative` neither
 * starts with `..` nor is absolute - that one rule blocks both cases that must not be made
 * relative: a sibling path outside the directory (`../other/x.dwf.ts`, whose relative form reads
 * as if the workspace contained such a thing), and a cross-drive path on Windows (`C:` -> `D:`,
 * where `path.relative` simply hands back an absolute path). An empty result (a path exactly
 * equal to the working directory) likewise falls back to the absolute path: the empty string is
 * not a filename anything can `Edit`.
 *
 * An absent `cwd` means the host has no notion of a working directory (some port stubs / no
 * session context), and then there is nothing to make relative.
 */
export function describeWorkflowScriptPath(absolutePath: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return absolutePath;
  const relative = path.relative(cwd, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
}
