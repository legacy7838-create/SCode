// The argument form and metadata argument table of saved workflows.
// Pure functions: lay out the frontmatter's args declaration into editable fields, then fold the fields back into an argument bag / declaration;
// the validation rules share a source with the CLI's validateWorkflowArgs (required, per-type parsing, and default backfill are done by the server).
import type { ZCodeSavedWorkflowArgType, ZCodeSavedWorkflowArgsDeclaration } from "@zcode/shared";

export interface SavedWorkflowArgField {
  name: string;
  type: ZCodeSavedWorkflowArgType;
  description?: string;
  required: boolean;
  hasDefault: boolean;
  /** The text in the editor; booleans use "true" / "false". */
  value: string;
}

export type SavedWorkflowArgFieldError = "required" | "invalid_number" | "invalid_json";

/** Converts a default value / existing value into editor text according to its type. */
function formatSavedWorkflowArgValue(type: ZCodeSavedWorkflowArgType, value: unknown): string {
  if (value === undefined) return type === "boolean" ? "false" : "";
  switch (type) {
    case "string":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "number":
      return typeof value === "number" ? String(value) : String(value);
    case "boolean":
      return value === true ? "true" : "false";
    case "json":
      return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  }
}

export function buildSavedWorkflowArgFields(
  declaration: ZCodeSavedWorkflowArgsDeclaration | undefined,
): SavedWorkflowArgField[] {
  if (!declaration) return [];
  return Object.entries(declaration).map(([name, spec]) => ({
    name,
    type: spec.type,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    required: spec.required === true,
    hasDefault: spec.default !== undefined,
    value: formatSavedWorkflowArgValue(spec.type, spec.default),
  }));
}

type SavedWorkflowArgParse =
  | { ok: true; omitted: true }
  | { ok: true; omitted: false; value: unknown }
  | { ok: false; error: SavedWorkflowArgFieldError };

/**
 * A single field → an argument value. Empty text means "do not pass" for string / number / json:
 * one with a default is filled in by the server, and one with no default that is not required is
 * simply absent; required-but-empty is the only required error. A boolean always has a value.
 */
function parseSavedWorkflowArgField(field: SavedWorkflowArgField): SavedWorkflowArgParse {
  const raw = field.value;
  if (field.type === "boolean") {
    return { ok: true, omitted: false, value: raw === "true" };
  }
  if (raw.trim().length === 0) {
    if (field.required && !field.hasDefault) return { ok: false, error: "required" };
    return { ok: true, omitted: true };
  }
  switch (field.type) {
    case "string":
      return { ok: true, omitted: false, value: raw };
    case "number": {
      const parsed = Number(raw.trim());
      // NaN / Infinity pass neither JSON nor the CLI's number validation; block them right here.
      if (!Number.isFinite(parsed)) return { ok: false, error: "invalid_number" };
      return { ok: true, omitted: false, value: parsed };
    }
    case "json": {
      try {
        return { ok: true, omitted: false, value: JSON.parse(raw) as unknown };
      } catch {
        return { ok: false, error: "invalid_json" };
      }
    }
  }
}

type SavedWorkflowArgsCollect =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: Record<string, SavedWorkflowArgFieldError> };

/**
 * The whole form → the argument bag; all errors are gathered in one pass (following
 * validateWorkflowArgs' "do not report them one at a time").
 */
export function collectSavedWorkflowArgs(
  fields: readonly SavedWorkflowArgField[],
): SavedWorkflowArgsCollect {
  const args: Record<string, unknown> = {};
  const errors: Record<string, SavedWorkflowArgFieldError> = {};
  for (const field of fields) {
    const parsed = parseSavedWorkflowArgField(field);
    if (!parsed.ok) {
      errors[field.name] = parsed.error;
      continue;
    }
    if (!parsed.omitted) args[field.name] = parsed.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, args };
}

// ── Metadata editing: actual parameter declaration table ──

export interface SavedWorkflowArgRow {
  /** A row's stable identity (new rows need one too; the name may be empty). */
  key: string;
  name: string;
  type: ZCodeSavedWorkflowArgType;
  required: boolean;
  /**
   * The editor text for a default value; empty means no default (booleans use "" / "true" /
   * "false").
   */
  defaultText: string;
  description: string;
}

export type SavedWorkflowArgRowError = "empty_name" | "duplicate_name" | "invalid_default";

export function argsDeclarationToRows(
  declaration: ZCodeSavedWorkflowArgsDeclaration | undefined,
): SavedWorkflowArgRow[] {
  if (!declaration) return [];
  return Object.entries(declaration).map(([name, spec], index) => ({
    key: `${index}:${name}`,
    name,
    type: spec.type,
    required: spec.required === true,
    defaultText:
      spec.default === undefined
        ? ""
        : spec.type === "boolean"
          ? spec.default === true
            ? "true"
            : "false"
          : formatSavedWorkflowArgValue(spec.type, spec.default),
    description: spec.description ?? "",
  }));
}

function parseDefaultText(
  type: ZCodeSavedWorkflowArgType,
  text: string,
): { ok: true; value?: unknown } | { ok: false } {
  if (text.trim().length === 0) return { ok: true };
  switch (type) {
    case "string":
      return { ok: true, value: text };
    case "number": {
      const parsed = Number(text.trim());
      return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
    }
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false };
    case "json":
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false };
      }
  }
}

type SavedWorkflowArgRowsCollect =
  | { ok: true; args: ZCodeSavedWorkflowArgsDeclaration | undefined }
  | { ok: false; errors: Record<string, SavedWorkflowArgRowError> };

/**
 * Argument table → declaration. Names are only required to be non-empty and unique (a declaration
 * is a record to begin with, and reading `args.x` does not restrict the identifier); an empty table
 * yields undefined (no args key in the frontmatter at all, rather than `args: {}`).
 */
export function rowsToArgsDeclaration(
  rows: readonly SavedWorkflowArgRow[],
): SavedWorkflowArgRowsCollect {
  const errors: Record<string, SavedWorkflowArgRowError> = {};
  const seen = new Set<string>();
  const args: ZCodeSavedWorkflowArgsDeclaration = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name.length === 0) {
      errors[row.key] = "empty_name";
      continue;
    }
    if (seen.has(name)) {
      errors[row.key] = "duplicate_name";
      continue;
    }
    seen.add(name);
    const parsedDefault = parseDefaultText(row.type, row.defaultText);
    if (!parsedDefault.ok) {
      errors[row.key] = "invalid_default";
      continue;
    }
    const description = row.description.trim();
    args[name] = {
      type: row.type,
      ...(description.length === 0 ? {} : { description }),
      ...(row.required ? { required: true } : {}),
      ...(parsedDefault.value === undefined ? {} : { default: parsedDefault.value }),
    };
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, args: Object.keys(args).length === 0 ? undefined : args };
}
