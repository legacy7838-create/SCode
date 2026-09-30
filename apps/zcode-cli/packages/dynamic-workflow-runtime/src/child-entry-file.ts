/**
 * Writing the sandbox entry file to disk.
 *
 * Why this file exists: the Windows command line limit is 32,767 characters, so the payload can no longer travel through argv. The harness writes
 * the ESM rendered by {@link import("./child-source.js").renderChildEntry} to
 * `<cwd>/.zcode/workflow-runs/<runId>.mjs`, so at spawn time the command line holds nothing but this path.
 *
 * Ruling:
 *   - Location `.zcode/workflow-runs/`, a sibling of the project-level saved workflows' `.zcode/workflows/` rather than mixed in with it;
 *   - the file is **kept**, not deleted (the same runId overwrites in place), and the directory doubles as the archive of what each run actually executed;
 *   - this module writes a `.gitignore` (`*`) into the directory, only once when it is absent, and never touches the project's own `.gitignore`;
 *   - when the project directory cannot be written to (read-only checkout, missing cwd, `.zcode` is a regular file, …) → fall back to
 *     `os.tmpdir()/zcode-workflow-runs/` and report it once through `onWarning`; the run starts as usual. If the fallback also fails, throw,
 *     and let the harness normalize it into a failed settlement.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A non-fatal condition the harness reports to the caller; bootstrap turns it into a warn log. */
export interface HarnessWarning {
  kind: "entry_file_fallback";
  /** The project directory we wanted to write to (`<cwd>/.zcode/workflow-runs`). */
  projectDir: string;
  /** The directory actually fallen back to. */
  fallbackDir: string;
  /** The error text for a failed write into the project directory. */
  error: string;
}

export interface WriteChildEntryFileInput {
  cwd: string;
  runId: string;
  /** The source code of the rendered entry file. */
  source: string;
  onWarning?: (warning: HarnessWarning) => void;
}

export interface ChildEntryFile {
  path: string;
  location: "project" | "tmpdir";
}

/** The entry file directory inside the project. */
export function workflowRunsDir(cwd: string): string {
  return join(cwd, ".zcode", "workflow-runs");
}

/** The fallback directory (under the OS temp dir, shared across projects). */
export function fallbackWorkflowRunsDir(): string {
  return join(tmpdir(), "zcode-workflow-runs");
}

/** Anything outside runId's safe character set is replaced with `_`, so that path separators and the like can never slip into a file name. */
export function childEntryFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.mjs`;
}

export function writeChildEntryFile(input: WriteChildEntryFileInput): ChildEntryFile {
  const projectDir = workflowRunsDir(input.cwd);
  const fileName = childEntryFileName(input.runId);
  try {
    return { path: writeInto(projectDir, fileName, input.source), location: "project" };
  } catch (error) {
    const fallbackDir = fallbackWorkflowRunsDir();
    input.onWarning?.({
      kind: "entry_file_fallback",
      projectDir,
      fallbackDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return { path: writeInto(fallbackDir, fileName, input.source), location: "tmpdir" };
  }
}

function writeInto(dir: string, fileName: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  try {
    // `wx`: Only created in absence. If the user changes this .gitignore, it will not be touched again.
    writeFileSync(join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }
  const path = join(dir, fileName);
  writeFileSync(path, source, "utf8");
  return path;
}
