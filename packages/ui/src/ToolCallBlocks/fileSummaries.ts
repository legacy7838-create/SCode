import { computeLineChangeStat } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { buildUnifiedDiff } from "@/lib/toolDiffPreview.js";
import {
  buildFallbackRawToolCallFileSummary,
  hasWritableToolSemantic,
  inferEditOperation,
  type EditKindSource,
} from "@/ToolCallBlocks/fileSummaryHeuristics.js";
import {
  type EditOperationKind,
  type RawToolCallFileSummary,
  isPlainRecord,
  normalizeSingleFilePatch,
  readRawToolCallInput,
  readRawToolCallChanges,
  readStringField,
  readStructuredDiffBlock,
  readUnifiedDiffField,
} from "@/ToolCallBlocks/fileSummaryTypes.js";

export { inferEditOperation } from "@/ToolCallBlocks/fileSummaryHeuristics.js";

function readFileDiffDisplays(value: unknown): Record<string, unknown>[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const display = isPlainRecord(value.display) ? value.display : value;
  if (display.kind === "file_diff") {
    return [display];
  }
  if (display.kind !== "file_diffs" || !Array.isArray(display.files)) {
    return [];
  }
  return display.files.filter(isPlainRecord);
}

function readDisplayStructuredPatch(display: Record<string, unknown>, fileLabel: string) {
  const structuredPatch = display.structuredPatch;
  if (!Array.isArray(structuredPatch)) {
    return null;
  }

  const hunks: string[] = [];
  for (const hunk of structuredPatch) {
    if (!isPlainRecord(hunk) || !Array.isArray(hunk.lines)) {
      continue;
    }

    const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : 1;
    const oldLines = typeof hunk.oldLines === "number" ? hunk.oldLines : 1;
    const newStart = typeof hunk.newStart === "number" ? hunk.newStart : 1;
    const newLines = typeof hunk.newLines === "number" ? hunk.newLines : 1;
    const lines = hunk.lines.filter((line): line is string => typeof line === "string");
    hunks.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    hunks.push(...lines);
  }

  return hunks.length > 0
    ? [`--- a/${fileLabel}`, `+++ b/${fileLabel}`, ...hunks].join("\n")
    : null;
}

function readDisplayFileDiffSummaries(...values: unknown[]): RawToolCallFileSummary[] {
  const summaries: RawToolCallFileSummary[] = [];
  const seenPaths = new Set<string>();

  for (const value of values) {
    for (const display of readFileDiffDisplays(value)) {
      const path = readStringField(display, ["filePath", "file_path", "path"]);
      if (!path || seenPaths.has(path)) {
        continue;
      }

      seenPaths.add(path);
      const descriptor = resolveFileDisplayDescriptor(path);
      // ZCode agent's edit/write/apply_patch tool will put the real diff in
      // rawOutput.display(file_diff/file_diffs). summary and tool trajectories must reuse this structured fact,
      // Otherwise, there will be a fork where the toolbar can expand diff, but the bottom summary can only show "cannot preview".
      summaries.push({
        path,
        actionLabel: "Edited",
        operationKind: "edit",
        fileName: descriptor.fileName,
        filePath: descriptor.filePath,
        fileIconSrc: descriptor.fileIconSrc,
        changeStat: {
          added:
            typeof display.additions === "number" ? Math.max(0, Math.round(display.additions)) : 0,
          removed:
            typeof display.deletions === "number" ? Math.max(0, Math.round(display.deletions)) : 0,
        },
        patch: readDisplayStructuredPatch(display, getPathLeaf(path)),
      });
    }
  }

  return summaries;
}

export function readRawToolCallFileSummaries(
  raw: unknown,
  source?: EditKindSource,
): RawToolCallFileSummary[] {
  if (source && !hasWritableToolSemantic(source)) {
    // The renderer stream will treat the presence of rawFileSummaries as proof of edit.
    // If non-writing tools also extract summaries from raw.changes, search/explore/execute will be misdirected to edit/delete.
    // Here, filter by kind/toolName first, allowing only explicit writing tools to continue reading file change summaries.
    return [];
  }

  if (!isPlainRecord(raw)) {
    const displaySummaries = readDisplayFileDiffSummaries(source?.output);
    return displaySummaries.length > 0
      ? displaySummaries
      : buildFallbackRawToolCallFileSummary(source);
  }

  const rawInput = readRawToolCallInput(raw);
  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const displaySummaries = readDisplayFileDiffSummaries(raw, rawInput, rawOutput, source?.output);
  if (displaySummaries.length > 0) {
    return displaySummaries;
  }

  const rawDiffs = Array.isArray(raw.content)
    ? raw.content
        .map((item) => readStructuredDiffBlock(item))
        .filter(
          (diff): diff is { path?: string; oldText: string; newText: string } =>
            diff !== null && typeof diff.path === "string",
        )
    : [];

  const { directChanges, rawInputChanges, rawOutputChanges } = readRawToolCallChanges(raw);

  const orderedPaths = new Set<string>();
  for (const diff of rawDiffs) {
    if (diff.path) {
      orderedPaths.add(diff.path);
    }
  }
  if (directChanges) {
    for (const path of Object.keys(directChanges)) {
      orderedPaths.add(path);
    }
  }
  if (rawInputChanges) {
    for (const path of Object.keys(rawInputChanges)) {
      orderedPaths.add(path);
    }
  }
  if (rawOutputChanges) {
    for (const path of Object.keys(rawOutputChanges)) {
      orderedPaths.add(path);
    }
  }

  const summaries: RawToolCallFileSummary[] = [];
  for (const path of orderedPaths) {
    const diff = rawDiffs.find((item) => item.path === path);
    const change = rawOutputChanges?.[path] ?? rawInputChanges?.[path] ?? directChanges?.[path];
    const changeType =
      isPlainRecord(change) && typeof change.type === "string" ? change.type : undefined;
    const operationKind: EditOperationKind =
      changeType === "add"
        ? "write"
        : changeType === "update"
          ? "update"
          : changeType === "delete"
            ? "delete"
            : "edit";
    const actionLabel =
      changeType === "add" ? "Created" : changeType === "delete" ? "Deleted" : "Edited";
    const oldText =
      diff?.oldText ??
      (isPlainRecord(change)
        ? readStringField(change, [
            "oldText",
            "old_string",
            "oldString",
            "before",
            "old_content",
            "oldContent",
          ])
        : undefined);
    const newText =
      diff?.newText ??
      (isPlainRecord(change)
        ? readStringField(change, [
            "newText",
            "new_string",
            "newString",
            "after",
            "new_content",
            "newContent",
            "content",
          ])
        : undefined);
    const descriptor = resolveFileDisplayDescriptor(path);
    let changeStat: { added: number; removed: number } | undefined;
    if (oldText !== undefined && newText !== undefined) {
      changeStat = computeLineChangeStat(oldText, newText);
    } else if (changeType === "add" && newText !== undefined) {
      changeStat = computeLineChangeStat(null, newText);
    } else if (changeType === "delete" && oldText !== undefined) {
      changeStat = computeLineChangeStat(oldText, "");
    }
    const explicitPatch = normalizeSingleFilePatch(readUnifiedDiffField(change), getPathLeaf(path));
    const patch =
      explicitPatch ??
      (oldText !== undefined || newText !== undefined
        ? buildUnifiedDiff(oldText ?? "", newText ?? "", getPathLeaf(path))
        : null);

    summaries.push({
      path,
      actionLabel,
      operationKind,
      fileName: descriptor.fileName,
      filePath: descriptor.filePath,
      fileIconSrc: descriptor.fileIconSrc,
      changeStat,
      patch,
    });
  }

  return summaries.length > 0 ? summaries : buildFallbackRawToolCallFileSummary(source);
}
