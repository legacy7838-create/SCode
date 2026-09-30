// ============================================================
// Saved workflows - frontmatter codec
// ============================================================
//
// File shape:
//
//     /* zcode-workflow
//     description: ...
//     args:
//       pr: { type: string, required: true }
//     */
//     <plain dwf script>
//
// Why **block comments** instead of `---` fence like Markdown: The saved file extension is `.dwf.ts`,
// The user will open it in the editor or modify it manually. Block comments make the entire file still valid TypeScript, so highlighting,
// Bracket matching and formatting all work as usual; `---` will turn the first line of the file into a syntax error.
//
// The body uses YAML instead of JSON: `yaml` is already a direct dependency of @zcode/core (no new dependencies are added), and manual modification
// A piece of YAML is much more error-tolerant than hand-modifying a piece of JSON with quotes and commas - the readers of this file are humans.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SavedWorkflowMetaSchema, type SavedWorkflowMeta } from "@zcode/contracts";

/** The opening marker of the frontmatter. It must be the first non-blank content in the file. */
export const SAVED_WORKFLOW_SENTINEL = "/* zcode-workflow";

/** The closing marker of the frontmatter: a line holding only the block comment terminator. */
const SAVED_WORKFLOW_TERMINATOR = "*/";

export type SavedWorkflowParseErrorReason =
  | "missing_frontmatter"
  | "unterminated_frontmatter"
  | "invalid_yaml"
  | "invalid_metadata";

export type SavedWorkflowParseResult =
  | {
      ok: true;
      meta: SavedWorkflowMeta;
      script: string;
      /**
       * How many lines come before the body (leading blank lines + the opening marker + the YAML + the closing line). When a diagnostic is reported by **file line**
       * it is added: `fileLine = bodyLine + bodyLineOffset`. Compilation looks at the section after the closing line, so the two sets of line numbers necessarily differ by
       * this constant; making every call site count it for itself is the standard birthplace of bugs like "the diagnostic line number does not match the file".
       */
      bodyLineOffset: number;
    }
  | { ok: false; reason: SavedWorkflowParseErrorReason; detail: string };

/**
 * Metadata + script -> the file body.
 *
 * The script goes **byte for byte** after the closing line: saving and then reading it back must recover exactly what the author wrote, or the run's script hash
 * would not match what the user sees in their editor (resume's comparison base is precisely the script source text).
 */
export function serializeSavedWorkflow(meta: SavedWorkflowMeta, script: string): string {
  // The key order is fixed (description → whenToUse → args) instead of following the insertion order of object literals: save twice to get
  // Files that are the same byte by byte, otherwise SaveWorkflow will create a meaningless diff in git every time.
  const body: Record<string, unknown> = { description: meta.description };
  if (meta.whenToUse !== undefined) body.whenToUse = meta.whenToUse;
  if (meta.args !== undefined) body.args = meta.args;

  // stringify comes with a trailing newline, so the terminating line follows it directly.
  return `${SAVED_WORKFLOW_SENTINEL}\n${stringifyYaml(body)}${SAVED_WORKFLOW_TERMINATOR}\n${script}`;
}

/**
 * The file body -> metadata + script.
 *
 * The four failures each have their own name, because they need to give the user different advice: no frontmatter means "this is not a saved
 * workflow", a missing closing marker means "you deleted a line", broken YAML means "the indentation is wrong", and a schema mismatch means "a field name is wrong".
 * A generic "parse error" helps with none of those three cases.
 */
export function parseSavedWorkflow(source: string): SavedWorkflowParseResult {
  const lines = source.split("\n");

  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  if (start >= lines.length || lines[start]!.trim() !== SAVED_WORKFLOW_SENTINEL) {
    return {
      ok: false,
      reason: "missing_frontmatter",
      detail: `file does not start with the \`${SAVED_WORKFLOW_SENTINEL}\` metadata block`,
    };
  }

  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() !== SAVED_WORKFLOW_TERMINATOR) end += 1;
  if (end >= lines.length) {
    return {
      ok: false,
      reason: "unterminated_frontmatter",
      detail: `metadata block is never closed with \`${SAVED_WORKFLOW_TERMINATOR}\``,
    };
  }

  const bodyText = lines.slice(start + 1, end).join("\n");
  // Everything after the terminating line is script and left as is (the same holds true for files without a newline at the end: slice gives an empty array).
  const script = lines.slice(end + 1).join("\n");

  let body: unknown;
  try {
    body = parseYaml(bodyText);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_yaml",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = SavedWorkflowMetaSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_metadata",
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }

  // The text starts on the line next to the terminating line, so it is preceded by exactly `end + 1` lines.
  return { ok: true, meta: parsed.data, script, bodyLineOffset: end + 1 };
}
