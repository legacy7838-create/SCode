// ============================================================
// Writing to Workflow draft directory
// ============================================================
// Every script accepted by the tool must have a home on the disk, and that file is the handle between two submissions of the model: diagnosis to
// is the file line number. You only need `path` for the next submission. You don’t have to reflow the script worth 20,000 tokens to change one line. inline text therefore
// Just a door - `CreateWorkflow` / `AmendWorkflow` / The hub starts directly as soon as a script is received that does not come from a file.
// Write one here.
//
// Drop point `<cwd>/.zcode/workflow-drafts/`, and `.zcode/workflows/` (user-saved definition),
// `.zcode/workflow-runs/` (compilation entry for each run) is flat. The directory comes with a copy of `.gitignore: *`, written in the same way
// dynamic-workflow-runtime/src/child-entry-file.ts verbatim isomorphism (comment there notes the verdict): only in absence
// Write it once, and the user will not touch it again after making changes, and the project's own `.gitignore` will not touch a word.
//
// **Best effort**: unable to write (read-only checkout, `.zcode` is an ordinary file, the disk is full) does not allow the call to fail and return
// `undefined`, the model reads the old saying of "correct the script and then submit it inline". Deliberately **not** fall back to the temporary directory - a
// Drafts that users can't find in the project don't deserve a path.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SAVED_WORKFLOW_FILE_EXTENSION,
  WORKFLOW_DRAFTS_DIR,
  createWorkflowPhaseNames,
  type CreateWorkflowCausalityGraph,
} from "@zcode/contracts";

/**
 * The characters **not** kept in a draft file name: everything outside Unicode letters / digits and `_ . -`.
 *
 * Deliberately different from the name used for saving (pure ASCII): a saved name has to work as a CLI argument and as a URL fragment, while a draft name only has to
 * exist on the file systems of all three platforms and let a human and a model recognize which workflow it is — and in practice run names and phase names
 * are almost always in Chinese (measured: the ASCII version squashed every draft into `workflow-N`, leaving two completely different
 * workflows indistinguishable in the directory). What gets dropped outside the alphabet is exactly the path separators and the reserved Windows characters
 * (`/ \ : * ? " < > |`), whitespace and control characters, so path traversal remains impossible.
 */
const WORKFLOW_DRAFT_SLUG_DROP_PATTERN = /[^\p{L}\p{N}_.-]/gu;

/** Runs of whitespace collapse into a single `-`: `PR review #12` → `PR-review-12`, which is easier to make out than the crammed-together `PRreview12`. */
const WORKFLOW_DRAFT_WHITESPACE_PATTERN = /\s+/gu;

/** The file name length limit, the same number as `SAVED_WORKFLOW_MAX_NAME_CHARS` and for the same reason (PATH_MAX on every platform). */
const WORKFLOW_DRAFT_MAX_SLUG_CHARS = 64;

/**
 * The fallback for when not a single usable character is left in the name (a Chinese name is the most common such case).
 */
const WORKFLOW_DRAFT_FALLBACK_SLUG = "workflow";

/**
 * The upper bound of the suffix used on a name collision. Filling it up that many times can only mean someone is spamming submissions under the same name, and giving up on writing a draft then (returning
 * `undefined`) is more dignified than an endless loop — a draft is a convenience, not part of correctness.
 */
const WORKFLOW_DRAFT_MAX_ATTEMPTS = 1_000;

interface WriteWorkflowDraftInput {
  /**
   * The session working directory; drafts land under its `.zcode/workflow-drafts/`. Absent means the host has no concept of a working directory
   * (port stub / no session context), so there is nowhere to write, which is the same thing as a failed write.
   */
  cwd: string | undefined;
  /** The display name of the run, used to mint the file name. */
  name: string;
  /** The bytes to be written, unchanged verbatim (a saved source brings its metadata block along too). */
  source: string;
}

/**
 * Writes one draft and returns its absolute path; returns `undefined` when it cannot be written (it never throws).
 *
 * **Every inline submission mints a new file**, including a submission that should have gone through `path`: a draft is never overwritten behind the model's back,
 * otherwise one accidental duplicate submission would wipe out the copy the user is currently editing. Name collisions continue with `-2`, `-3`… and land on disk
 * with `wx` (exclusive create) — so two concurrent submissions can never end up in the same file, which "stat first, then write" would allow.
 */
export async function writeWorkflowDraft(
  input: WriteWorkflowDraftInput,
): Promise<{ path: string } | undefined> {
  if (input.cwd === undefined || input.cwd === "") return undefined;
  try {
    const dir = path.join(input.cwd, WORKFLOW_DRAFTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeDraftGitignore(dir);
    const slug = workflowDraftSlug(input.name);
    for (let attempt = 1; attempt <= WORKFLOW_DRAFT_MAX_ATTEMPTS; attempt += 1) {
      const fileName = `${attempt === 1 ? slug : `${slug}-${attempt}`}${SAVED_WORKFLOW_FILE_EXTENSION}`;
      const filePath = path.join(dir, fileName);
      try {
        // `wx`: Report EEXIST if the file already exists, so "name" and "name" are the same atomic action.
        await writeFile(filePath, input.source, { encoding: "utf8", flag: "wx" });
        return { path: filePath };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    return undefined;
  } catch {
    // Try your best: the directory cannot be written, `.zcode` is a file, the disk is full... all will be treated as "there is no draft this time". The caller accordingly
    // The old copy is returned and the tool call itself is completed as usual.
    return undefined;
  }
}

/**
 * What the draft should be called: the model's `name` wins; without one, take the literal of the script's first `phase("…")` — a phase is something every
 * script must write, and it is written for the user in the user's own language (the Phases rule of the `CreateWorkflow` description), so it is the closest thing to
 * a name when there is none; only when there is no phase either does it fall back to the placeholder word.
 *
 * Deliberately not using the run label fallback (the script's first line): in practice that first line is most often a comment banner like `// ==== result type ====`.
 */
export function resolveWorkflowDraftName(
  name: string | undefined,
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): string {
  if (name !== undefined && name.trim() !== "") return name;
  return createWorkflowPhaseNames(graph)?.[0] ?? WORKFLOW_DRAFT_FALLBACK_SLUG;
}

/**
 * Name → file name stem. Runs of whitespace collapse into `-`, anything outside the alphabet (Unicode letters / digits / `_ . -`) is dropped outright,
 * and the result is truncated at the limit (by code point, not by UTF-16 unit, so a character is never cut into half a surrogate pair); when nothing is left, or only dots
 * (`.` / `..` are directory entries, not file names), the placeholder word is used.
 */
function workflowDraftSlug(name: string): string {
  const reduced = Array.from(
    name
      .trim()
      .replace(WORKFLOW_DRAFT_WHITESPACE_PATTERN, "-")
      .replace(WORKFLOW_DRAFT_SLUG_DROP_PATTERN, ""),
  )
    .slice(0, WORKFLOW_DRAFT_MAX_SLUG_CHARS)
    .join("")
    .replace(/^[.-]+|[.-]+$/gu, "");
  if (reduced === "" || /^\.+$/u.test(reduced)) return WORKFLOW_DRAFT_FALLBACK_SLUG;
  return reduced;
}

/** The `.gitignore` inside the drafts directory, written once only when absent (once the user has edited it, it is left alone). */
async function writeDraftGitignore(dir: string): Promise<void> {
  try {
    await writeFile(path.join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
