import { readFileSync } from "node:fs";

/**
 * Lightweight Markdown frontmatter extraction, supporting YAML block scalars (`>` folded / `|` literal, and the `+`/`-` chomping variants).
 *
 * The plugin marketplace detail view (plugins/describe) reads `name`/`description` with a one-line regex, and when it meets a block scalar like
 * `description: >` it takes the indicator `>` for the description itself, so every entry in the skill list ends up with a description that is just a `>`.
 * Here we reuse the same block scalar parsing rules as the skills adapter (see skills/index.ts) to correctly fold/join the following indented lines
 * into a complete description; when the frontmatter is missing or has no such key, it degrades gracefully by omission and never fabricates anything.
 *
 * Only the two scalar keys name / description are extracted (exactly what the skills/commands detail view needs); this is not a full YAML parser.
 */
export function readMarkdownFrontmatter(filePath: string): {
  name?: string;
  description?: string;
} {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  return parseMarkdownFrontmatter(content);
}

/** Pure-function version: parses the frontmatter of Markdown text directly, so unit tests can cover the block scalar branches. */
function parseMarkdownFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) return {};
  const values = parseFlatYamlScalars(frontmatter);
  const result: { name?: string; description?: string } = {};
  const name = parseScalar(values.name);
  if (name) result.name = name;
  const description = parseScalar(values.description);
  if (description) result.description = description;
  return result;
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

/** Parses top-level `key: value`; a block scalar (`>`/`|`) pulls the following indented lines into the same key. Only scalar string values are kept. */
function parseFlatYamlScalars(frontmatter: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    // Indent line contents belonging to the previous block scalar, skipping top-level scans.
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in values) continue;
    const blockStyle = parseBlockScalarStyle(value);
    if (blockStyle) {
      const block = readBlockScalar(lines, index + 1, blockStyle);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }
  return values;
}

function parseBlockScalarStyle(value: string): "folded" | "literal" | null {
  if (/^>[+-]?$/.test(value)) return "folded";
  if (/^\|[+-]?$/.test(value)) return "literal";
  return null;
}

function readBlockScalar(
  lines: string[],
  startIndex: number,
  style: "folded" | "literal",
): { value: string; nextIndex: number } {
  const rawLines: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    // A non-empty, non-indented line indicates the end of a block scalar (return to the top key).
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
    rawLines.push(line);
    index += 1;
  }
  const indent = rawLines.reduce<number | null>((current, line) => {
    if (line.trim().length === 0) return current;
    const lineIndent = leadingWhitespaceLength(line);
    return current === null ? lineIndent : Math.min(current, lineIndent);
  }, null);
  const contentLines = rawLines.map((line) =>
    line.trim().length === 0 ? "" : line.slice(indent ?? 0),
  );
  return {
    value: style === "folded" ? foldBlockScalarLines(contentLines) : contentLines.join("\n").trim(),
    nextIndex: index,
  };
}

function leadingWhitespaceLength(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1]?.length ?? 0;
}

/** Folded style (`>`): line breaks within the same paragraph fold into spaces, blank lines break paragraphs. */
function foldBlockScalarLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
