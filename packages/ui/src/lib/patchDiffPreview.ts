import { getFiletypeFromFileName, getSingularPatch, parsePatchFiles } from "@pierre/diffs";

const MAX_PATCH_DIFF_SAFE_LINE_COUNT = 1_200;
const MAX_PATCH_DIFF_SAFE_CHAR_COUNT = 180_000;
const MAX_PATCH_DIFF_SAFE_HUNK_LINE_NUMBER = 1_200;
const MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES = 800;
// You cannot directly splice and display copy here, otherwise the lib layer will hard-code English into the UI and destroy internationalization.
// Change it to an internal marker token to truly display the copy using intl rendering at the component layer.
const FALLBACK_TRUNCATED_MARKER_PREFIX = "\\ __ZCODE_DIFF_TRUNCATED__:";
const FALLBACK_TRUNCATED_MARKER_REGEX = /^\\ __ZCODE_DIFF_TRUNCATED__:(\d+)$/;
const PACKAGE_MANAGER_LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const PATCH_DIFF_FORCE_PLAIN_TEXT_FILE_TYPES = new Set(["zsh"]);
// Gradle scripts will be recognized as normal text by @pierre/diffs.
// This type of patch continues to run PatchDiff when some entries or workers are unavailable, and synchronous parsing may still block the main thread.
// Here, the file suffix is ​​downgraded to lightweight <pre> in advance to prevent the whole screen from becoming uninteractive after clicking the file chip.
const PATCH_DIFF_FORCE_PLAIN_TEXT_PATH_SUFFIXES = [".gradle", ".gradle.kts"];

function buildTruncatedMarkerLine(omittedLineCount: number): string {
  return `${FALLBACK_TRUNCATED_MARKER_PREFIX}${omittedLineCount}`;
}

export function countPatchFileDiffs(patch: string): number {
  const lines = patch.split(/\r?\n/);
  const gitDiffHeaderCount = lines.filter((line) => line.startsWith("diff --git ")).length;
  if (gitDiffHeaderCount > 0) {
    return gitDiffHeaderCount;
  }

  const parseHunkRange = (line: string): { oldLines: number; newLines: number } | null => {
    const match = line.match(/^@@\s-\d+(?:,(\d+))?\s\+\d+(?:,(\d+))?\s@@/);
    if (!match) {
      return null;
    }
    return {
      oldLines: Number(match[1] ?? "1"),
      newLines: Number(match[2] ?? "1"),
    };
  };

  const isFileHeaderPair = (index: number): boolean => {
    return (
      (lines[index]?.startsWith("--- ") ?? false) && (lines[index + 1]?.startsWith("+++ ") ?? false)
    );
  };

  const consumeHunkBody = (start: number, oldLines: number, newLines: number): number | null => {
    let cursor = start;
    let remainingOld = oldLines;
    let remainingNew = newLines;

    while (remainingOld > 0 || remainingNew > 0) {
      const line = lines[cursor];
      if (line === undefined) {
        return null;
      }

      // In a multi-file patch without the `diff --git` prefix,
      // The next file header is `--- a/x` followed by `+++ b/x`. These two lines happen to start with `-` / `+`,
      // If they are consumed as the deleted/newed rows of the current hunk - when the model takes the number of rows in the hunk header
      // When writing more than the main text (a common off-by-one in LLM), the extra quota just "eats" the next file header.
      // Subsequent `@@` is regarded as the next hunk of the same file, causing multi-file patches to be mistakenly counted as single files.
      // Here, when consuming the text, the complete `---`/`+++` file header pair is first detected: once encountered, the current hunk is terminated early.
      // Return control to the outer loop to identify the new file, rather than merging the file header into the body.
      if (isFileHeaderPair(cursor)) {
        return cursor;
      }

      if (line.startsWith("\\ ")) {
        cursor += 1;
        continue;
      }

      if (line.startsWith(" ")) {
        remainingOld -= 1;
        remainingNew -= 1;
      } else if (line.startsWith("-")) {
        remainingOld -= 1;
      } else if (line.startsWith("+")) {
        remainingNew -= 1;
      } else {
        return null;
      }

      if (remainingOld < 0 || remainingNew < 0) {
        return null;
      }
      cursor += 1;
    }

    while (lines[cursor]?.startsWith("\\ ")) {
      cursor += 1;
    }
    return cursor;
  };

  let diffCount = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const oldHeader = lines[cursor];
    const newHeader = lines[cursor + 1];
    if (!oldHeader?.startsWith("--- ") || !newHeader?.startsWith("+++ ")) {
      cursor += 1;
      continue;
    }

    let hunkCursor = cursor + 2;
    let hasHunk = false;
    let sawHunkHeader = false;

    while (hunkCursor < lines.length) {
      const hunkRange = parseHunkRange(lines[hunkCursor] ?? "");
      if (!hunkRange) {
        break;
      }
      sawHunkHeader = true;

      const nextCursor = consumeHunkBody(hunkCursor + 1, hunkRange.oldLines, hunkRange.newLines);
      if (nextCursor === null) {
        break;
      }

      hasHunk = true;
      hunkCursor = nextCursor;
    }

    if (!hasHunk && !sawHunkHeader) {
      cursor += 1;
      continue;
    }

    // The hunk body allows real text lines starting with `---` / `+++`,
    // You cannot just count by `---/+++`; but when the text is truncated after the hunk header appears, you should also count conservatively by "there is a file diff".
    // Here, the text is consumed according to the number of lines declared in the hunk header, and only the `---/+++` pairs that successfully parse out the hunk are recognized as file headers.
    // And conservative counting is performed in truncation scenarios to avoid misjudgment of multi-file patches as single files.
    diffCount += 1;
    cursor = hasHunk ? hunkCursor : cursor + 2;
  }

  return diffCount;
}

export function parseTruncatedMarkerOmittedLineCount(line: string): number | null {
  const markerMatch = FALLBACK_TRUNCATED_MARKER_REGEX.exec(line);
  if (!markerMatch) {
    return null;
  }

  const omittedLineCount = Number.parseInt(markerMatch[1] ?? "", 10);
  if (!Number.isFinite(omittedLineCount) || omittedLineCount <= 0) {
    return null;
  }

  return omittedLineCount;
}

export function getPatchPreviewLineContent(line: string): string {
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return line.slice(1);
  }

  return line;
}

function isPatchHunkHeaderLine(line: string): boolean {
  return line === "@@" || line.startsWith("@@ ");
}

function getMaxHunkLineNumber(lines: readonly string[]): number {
  let maxLineNumber = 0;

  for (const line of lines) {
    if (!line.startsWith("@@ ")) {
      continue;
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }

    const oldStart = Number.parseInt(match[1] ?? "0", 10);
    const oldCount = Number.parseInt(match[2] ?? "1", 10);
    const newStart = Number.parseInt(match[3] ?? "0", 10);
    const newCount = Number.parseInt(match[4] ?? "1", 10);
    const oldEnd = oldStart + Math.max(0, Number.isNaN(oldCount) ? 1 : oldCount) - 1;
    const newEnd = newStart + Math.max(0, Number.isNaN(newCount) ? 1 : newCount) - 1;

    maxLineNumber = Math.max(maxLineNumber, oldEnd, newEnd);
  }

  return maxLineNumber;
}

function limitPlainTextPreviewLines(lines: readonly string[]): string[] {
  if (lines.length <= MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES) {
    return [...lines];
  }

  const keepCount = MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES - 1;
  const headCount = Math.ceil(keepCount / 2);
  const tailCount = keepCount - headCount;
  const omittedCount = lines.length - keepCount;

  return [
    ...lines.slice(0, headCount),
    buildTruncatedMarkerLine(omittedCount),
    ...lines.slice(lines.length - tailCount),
  ];
}

function getPatchContentFileName(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
      continue;
    }

    // The standard unified diff header allows appending a tab-delimited timestamp after the path.
    // If the timestamp is not stripped first, rules such as `.gradle` that downgrade by suffix will be bypassed by `test.gradle\t...`.
    const fileName = line.slice(4).trim().split("\t", 1)[0]?.trim() ?? "";
    if (!fileName || fileName === "/dev/null") {
      continue;
    }

    return fileName;
  }

  return null;
}

function normalizePatchFileName(fileName: string): string {
  return fileName.replace(/^([ab])\//, "");
}

function isPackageManagerLockfile(fileName: string | null): boolean {
  if (!fileName) {
    return false;
  }

  return PACKAGE_MANAGER_LOCKFILE_NAMES.has(
    normalizePatchFileName(fileName).split("/").at(-1)?.toLocaleLowerCase() ?? "",
  );
}

function shouldForcePlainTextPatchPreviewByFileName(fileName: string | null): boolean {
  if (!fileName) {
    return false;
  }

  const normalizedFileName = normalizePatchFileName(fileName).toLocaleLowerCase();

  return PATCH_DIFF_FORCE_PLAIN_TEXT_PATH_SUFFIXES.some((suffix) =>
    normalizedFileName.endsWith(suffix),
  );
}

function shouldForcePlainTextPatchPreview(fileName: string | null): boolean {
  if (isPackageManagerLockfile(fileName)) {
    return true;
  }

  if (shouldForcePlainTextPatchPreviewByFileName(fileName)) {
    return true;
  }

  if (!fileName) {
    return false;
  }

  return PATCH_DIFF_FORCE_PLAIN_TEXT_FILE_TYPES.has(getFiletypeFromFileName(fileName));
}

function collectPatchMetadataPreviewLines(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return false;
    }

    return (
      !line.startsWith("diff --git ") &&
      !line.startsWith("index ") &&
      !line.startsWith("--- ") &&
      !line.startsWith("+++ ")
    );
  });
}

function collectPlainTextPreviewLines(lines: readonly string[]): string[] {
  const previewLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (!inHunk) {
      if (isPatchHunkHeaderLine(line)) {
        inHunk = true;
      }
      continue;
    }

    // Before, filter directly by `+++ / --- / @@` prefix,
    // The `++ ` / `-- ` lines that actually exist in the text will be deleted by mistake.
    // Here it is changed to only skip the hunk header itself; once entering the hunk, all subsequent content is retained as is.
    if (isPatchHunkHeaderLine(line)) {
      continue;
    }

    previewLines.push(line);
  }

  if (inHunk || previewLines.length > 0) {
    return previewLines;
  }

  // Git patches like rename-only / mode-only do not have @@ hunk.
  // But there is still change information that users need to see. It will continue to be handed over to PatchDiff before.
  // After packaging, some files will become blank when expanded; retain meta information here and use lightweight fallback.
  return collectPatchMetadataPreviewLines(lines);
}

function normalizePlainTextPreviewLines(lines: readonly string[]): string[] {
  const normalizedLines = limitPlainTextPreviewLines(lines);

  // The goal of fallback is to maintain readability and interactivity without continuing to expose `---/+++ / @@` protocol headers.
  while (normalizedLines.length > 0 && normalizedLines.at(-1) === "") {
    normalizedLines.pop();
  }

  return normalizedLines.length > 0 ? normalizedLines : [""];
}

export function getPlainTextPatchPreviewLines(patch: string): string[] {
  return normalizePlainTextPreviewLines(getPlainTextPatchContentLines(patch));
}

export function getPlainTextPatchContentLines(patch: string): string[] {
  return collectPlainTextPreviewLines(patch.split(/\r?\n/));
}

export function getPlainTextPatchFallbackLines(patch: string): string[] | null {
  const lines = patch.split(/\r?\n/);
  const patchFileDiffCount = countPatchFileDiffs(patch);
  const hasMultipleFileDiffs = patchFileDiffCount > 1;
  const hasNoFileDiff = patchFileDiffCount === 0;
  const isCreatedFile = lines.some((line) => line === "--- /dev/null");
  const isDeletedFile = lines.some((line) => line === "+++ /dev/null");
  const maxHunkLineNumber = getMaxHunkLineNumber(lines);
  const isOversizedPatch =
    lines.length > MAX_PATCH_DIFF_SAFE_LINE_COUNT || patch.length > MAX_PATCH_DIFF_SAFE_CHAR_COUNT;
  const isDeepHunkLinePatch = maxHunkLineNumber > MAX_PATCH_DIFF_SAFE_HUNK_LINE_NUMBER;
  const patchFileName = getPatchContentFileName(lines);
  const shouldForcePlainTextPreview = shouldForcePlainTextPatchPreview(patchFileName);

  const metadataOnlyPreviewLines = collectPatchMetadataPreviewLines(lines);
  const isMetadataOnlyPatch =
    metadataOnlyPreviewLines.length > 0 && !lines.some(isPatchHunkHeaderLine);

  if (
    !hasNoFileDiff &&
    !hasMultipleFileDiffs &&
    !isCreatedFile &&
    !isDeletedFile &&
    !isOversizedPatch &&
    !isDeepHunkLinePatch &&
    !isMetadataOnlyPatch &&
    !shouldForcePlainTextPreview
  ) {
    try {
      // The own counter can judge that this is a logical single file based on the number of hunk lines, but the actual parser of PatchDiff
      // The deleted SQL comments (the patch text is in the form of `---...`) will be mistakenly cut into the second file. Ultimately, safety must be based on
      // The parsing result of @pierre/diffs that is actually responsible for rendering shall prevail, and the two sets of parsing semantics cannot cause leakage input again.
      // getSingularPatch cannot be called here: it will first console.error(files) and then throw an error on the expected multi-file result,
      // Expose user code to the console. Use throwOnError parsing instead and determine the number yourself, allowing normal downgrades to remain without logging side effects.
      const parsedPatches = parsePatchFiles(patch, undefined, true);
      if (parsedPatches.length === 1 && parsedPatches[0]?.files.length === 1) {
        return null;
      }
    } catch {
      // Parsing failure and parsing multiple files are both expected downgrade conditions, and a lightweight text preview is returned below.
    }
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (isMetadataOnlyPatch) {
    return normalizePlainTextPreviewLines(metadataOnlyPreviewLines);
  }

  if (hasNoFileDiff) {
    // You may get apply_patch fragments or bare hunk in summary/tool ​​playback.
    // These inputs do not have standard file diff headers, and PatchDiff will throw
    // "Provided patch must contain exactly 1 file diff", so it must be downgraded directly.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (shouldForcePlainTextPreview) {
    // For files such as lockfile/shell script, the highlighted worker path of PatchDiff in the production package is unstable.
    // It has been observed that the diff loads but fails to expand the content. Light text preview is fixed here, and priority is given to ensuring that the content is visible.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if ((isCreatedFile || isDeletedFile) && !isOversizedPatch && !isDeepHunkLinePatch) {
    // When the file change panel is expanded to add/delete files in "Non-plain text", PatchDiff may only render empty shells.
    // What the user sees is that there is no content after expansion. Adding/deleting files is inherently a snapshot of the entire file.
    // Here, we no longer divide the content by extension, but adopt lightweight text fallback. The priority is to ensure that the expanded state always has readable content.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (!hasMultipleFileDiffs && !isOversizedPatch && !isDeepHunkLinePatch) {
    try {
      const resolvedPatchFileName = patchFileName ?? getSingularPatch(patch).name;
      const patchFileType = getFiletypeFromFileName(resolvedPatchFileName);

      // New/deleted plain text files even if the patch is small,
      // `@pierre/diffs` may also block the main thread during the synchronous rendering phase, causing the entire interface to become immobile.
      // In addition, if the text in the deleted file happens to start with `---`, `getSingularPatch()` will mistakenly split it into a new file header.
      // Here, priority is given to using the first real file header to extract the path, and then falling back to library analysis to avoid file type judgment being interfered by the text.
      // Unknown suffixes will fall back to text, so they are intercepted according to the parsed file type instead of only matching fixed extensions.
      if (patchFileType !== "text") {
        return null;
      }
    } catch {
      // Single file quantity detection can only filter out obviously malformed input; it must still be respected before actually handing it over to @pierre/diffs
      // parser results. Failure to parse means that it cannot confirm "exactly one file diff" and continuing to render will trigger an error boundary.
      return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
    }
  }

  // PatchDiff of `@pierre/diffs` can only render single file patches.
  // Some tool chains will combine the unified diff of multiple files into the same field, and continuing to hand it over to PatchDiff will throw an error during the rendering phase.
  // "Provided patch must contain exactly 1 file diff", eventually triggering a full page error boundary.
  // Here, like large files/deep line numbers, it is downgraded to plain text preview to preserve the usability of the chat interface.
  // Very large patches will trigger PatchDiff's synchronous parsing when expanded.
  // The UI main thread will be occupied for a long time, which is manifested as the entire page freezing after clicking "Expand diff".
  // In addition, when only one line of some large files is changed, the hunk line number will fall in a very deep position (such as 1500+).
  // PatchDiff may also suffer from long periods of lag on this type of input.
  // Here, it is uniformly reduced to lightweight plain text rendering, with priority on ensuring interactive usability.

  return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
}
