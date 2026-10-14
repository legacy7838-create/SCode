// The JavaScript line-diff implementations this boundary REMOVED, preserved verbatim so the
// differential harness can prove the Rust kernel reproduces them byte-for-byte.
//
// Two sources, both copied unchanged from the commit before the port:
//   - packages/ui/src/lib/toolDiffPreview.ts   (buildUnifiedDiff + its LCS/anchor/header helpers)
//   - packages/shared/src/lineChangeStat.ts    (computeLineChangeStat)
//
// Only three mechanical edits were made, none of which change behavior:
//   1. the `@pierre/diffs` import is dropped (the oracle compares UN-trimmed patches only, so
//      `trimPatchContext` is never called here);
//   2. `buildUnifiedDiff` -> `buildUnifiedDiffOracle` so it cannot be confused with the live one;
//   3. `computeLineChangeStat` -> `computeLineChangeStatOracle`.
// Everything else, including the caps that made the old path wrong, is untouched — the harness
// relies on those caps to show exactly where the kernel now differs (and is correct).
//
// This file is NOT shipped. It is the acceptance oracle. See spec/native-boundary-line-diff.md §4.
/* eslint-disable */
// @ts-nocheck

// @pierre/diffs is NOT needed by the oracle: this harness compares UN-trimmed patches only.

const MAX_DIFF_LCS_CELLS = 60_000;

interface LineMatch {
  beforeIndex: number;
  afterIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

export function extractBeforeAfter(value: unknown): { before: string; after: string } | null {
  if (!isRecord(value)) {
    return null;
  }

  const before = findStringField(value, ["before", "old_string", "oldText", "oldContent"]);
  const after = findStringField(value, ["after", "new_string", "newText", "newContent"]);
  if (before !== undefined && after !== undefined) {
    return { before, after };
  }

  return null;
}

function extractStructuredDiffBlock(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  if (!isRecord(value) || value.type !== "diff" || typeof value.newText !== "string") {
    return null;
  }

  return {
    path: typeof value.path === "string" && value.path.trim() ? value.path : undefined,
    oldText:
      typeof value.oldText === "string"
        ? value.oldText
        : value.oldText == null
          ? ""
          : String(value.oldText),
    newText: value.newText,
  };
}

export function extractStructuredDiff(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  const directDiff = extractStructuredDiffBlock(value);
  if (directDiff) {
    return directDiff;
  }

  if (!isRecord(value) || !Array.isArray(value.content)) {
    return null;
  }

  for (const item of value.content) {
    const diff = extractStructuredDiffBlock(item);
    if (diff) {
      return diff;
    }
  }

  return null;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

function formatDiffRange(lineCount: number): string {
  return lineCount === 0 ? "0,0" : `1,${lineCount}`;
}

function formatDiffRangeFromSliceStart(startIndex: number, lineCount: number): string {
  if (lineCount === 0) {
    return `${startIndex},0`;
  }

  return `${startIndex + 1},${lineCount}`;
}

function countSharedPrefix(beforeLines: readonly string[], afterLines: readonly string[]): number {
  const maxLength = Math.min(beforeLines.length, afterLines.length);
  let index = 0;
  while (index < maxLength && beforeLines[index] === afterLines[index]) {
    index += 1;
  }
  return index;
}

function countSharedSuffix(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  sharedPrefixCount: number,
): number {
  const maxLength = Math.min(beforeLines.length, afterLines.length) - sharedPrefixCount;
  let offset = 0;
  while (
    offset < maxLength &&
    beforeLines[beforeLines.length - 1 - offset] === afterLines[afterLines.length - 1 - offset]
  ) {
    offset += 1;
  }
  return offset;
}

function appendLinesWithPrefix(
  patchLines: string[],
  prefix: " " | "+" | "-",
  lines: readonly string[],
): void {
  patchLines.push(...lines.map((line) => `${prefix}${line}`));
}

function collectUniqueLineMatches(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): LineMatch[] {
  const beforeOccurrences = new Map<string, { count: number; firstIndex: number }>();
  const afterOccurrences = new Map<string, { count: number; firstIndex: number }>();

  for (let index = 0; index < beforeLines.length; index += 1) {
    const line = beforeLines[index]!;
    const existing = beforeOccurrences.get(line);
    if (existing) {
      existing.count += 1;
      continue;
    }
    beforeOccurrences.set(line, { count: 1, firstIndex: index });
  }

  for (let index = 0; index < afterLines.length; index += 1) {
    const line = afterLines[index]!;
    const existing = afterOccurrences.get(line);
    if (existing) {
      existing.count += 1;
      continue;
    }
    afterOccurrences.set(line, { count: 1, firstIndex: index });
  }

  const matches: LineMatch[] = [];
  for (const [line, beforeOccurrence] of beforeOccurrences) {
    const afterOccurrence = afterOccurrences.get(line);
    if (beforeOccurrence.count !== 1 || afterOccurrence?.count !== 1) {
      continue;
    }
    matches.push({
      beforeIndex: beforeOccurrence.firstIndex,
      afterIndex: afterOccurrence.firstIndex,
    });
  }

  matches.sort((left, right) => left.beforeIndex - right.beforeIndex);
  return matches;
}

function findIncreasingAnchorMatches(matches: readonly LineMatch[]): LineMatch[] {
  if (matches.length === 0) {
    return [];
  }

  const predecessors = Array<number>(matches.length).fill(-1);
  const pileTops: number[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    let low = 0;
    let high = pileTops.length;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const currentTop = pileTops[middle]!;
      if (matches[currentTop]!.afterIndex < match.afterIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    if (low > 0) {
      predecessors[index] = pileTops[low - 1]!;
    }
    pileTops[low] = index;
  }

  const anchors: LineMatch[] = [];
  let currentIndex = pileTops[pileTops.length - 1]!;
  while (currentIndex >= 0) {
    anchors.push(matches[currentIndex]!);
    currentIndex = predecessors[currentIndex] ?? -1;
  }

  return anchors.reverse();
}

function appendDiffBodyWithLargeSegmentFallback(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  const anchors = findIncreasingAnchorMatches(collectUniqueLineMatches(beforeLines, afterLines));

  if (anchors.length === 0) {
    // 之前大区间直接整块退化成“全删再全加”，
    // 像 cli.ts 这种前后各插几行、但跨度很远的场景，会把整段未改内容误渲染成红绿大块。
    // 这里优先用唯一行锚点把大区间拆成多个小段，再递归回到正常 diff，尽量保留真实 hunk 边界。
    appendLinesWithPrefix(patchLines, "-", beforeLines);
    appendLinesWithPrefix(patchLines, "+", afterLines);
    return;
  }

  let previousBeforeIndex = 0;
  let previousAfterIndex = 0;

  for (const anchor of anchors) {
    appendDiffBody(
      patchLines,
      beforeLines.slice(previousBeforeIndex, anchor.beforeIndex),
      afterLines.slice(previousAfterIndex, anchor.afterIndex),
    );
    patchLines.push(` ${beforeLines[anchor.beforeIndex]!}`);
    previousBeforeIndex = anchor.beforeIndex + 1;
    previousAfterIndex = anchor.afterIndex + 1;
  }

  appendDiffBody(
    patchLines,
    beforeLines.slice(previousBeforeIndex),
    afterLines.slice(previousAfterIndex),
  );
}

function appendDiffBodyWithLcs(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  if (beforeLines.length === 0) {
    appendLinesWithPrefix(patchLines, "+", afterLines);
    return;
  }

  if (afterLines.length === 0) {
    appendLinesWithPrefix(patchLines, "-", beforeLines);
    return;
  }

  if (beforeLines.length * afterLines.length > MAX_DIFF_LCS_CELLS) {
    appendDiffBodyWithLargeSegmentFallback(patchLines, beforeLines, afterLines);
    return;
  }

  const lcs = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0),
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex]![afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? (lcs[beforeIndex + 1]![afterIndex + 1] ?? 0) + 1
          : Math.max(
              lcs[beforeIndex + 1]![afterIndex] ?? 0,
              lcs[beforeIndex]![afterIndex + 1] ?? 0,
            );
    }
  }

  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    const beforeLine = beforeLines[beforeIndex];
    const afterLine = afterLines[afterIndex];

    if (beforeLine !== undefined && afterLine !== undefined && beforeLine === afterLine) {
      patchLines.push(` ${beforeLine}`);
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (beforeLine === undefined && afterLine !== undefined) {
      patchLines.push(`+${afterLine}`);
      afterIndex += 1;
      continue;
    }

    if (afterLine === undefined && beforeLine !== undefined) {
      patchLines.push(`-${beforeLine}`);
      beforeIndex += 1;
      continue;
    }

    const skipAfterScore = lcs[beforeIndex]![afterIndex + 1] ?? -1;
    const skipBeforeScore = lcs[beforeIndex + 1]![afterIndex] ?? -1;

    if (afterLine !== undefined && skipAfterScore >= skipBeforeScore) {
      patchLines.push(`+${afterLine}`);
      afterIndex += 1;
      continue;
    }

    if (beforeLine !== undefined) {
      patchLines.push(`-${beforeLine}`);
      beforeIndex += 1;
    }
  }
}

function appendDiffBody(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  appendDiffBodyWithLcs(patchLines, beforeLines, afterLines);
}

export function buildUnifiedDiffOracle(
  before: string,
  after: string,
  fileLabel: string,
  options?: {
    contextLines?: number;
  },
): string | null {
  const contextLines = options?.contextLines;
  const hasContextLimit =
    typeof contextLines === "number" && Number.isFinite(contextLines) && contextLines >= 0;
  const normalizedContextLines = hasContextLimit ? Math.max(0, Math.floor(contextLines)) : 0;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const sharedPrefixCount = countSharedPrefix(beforeLines, afterLines);
  const sharedSuffixCount = countSharedSuffix(beforeLines, afterLines, sharedPrefixCount);
  const beforeMiddle = beforeLines.slice(sharedPrefixCount, beforeLines.length - sharedSuffixCount);
  const afterMiddle = afterLines.slice(sharedPrefixCount, afterLines.length - sharedSuffixCount);
  const isCreatedFile = beforeLines.length === 0 && afterLines.length > 0;
  const isDeletedFile = beforeLines.length > 0 && afterLines.length === 0;

  const limitedPrefixCount = hasContextLimit
    ? Math.min(sharedPrefixCount, normalizedContextLines)
    : sharedPrefixCount;
  const limitedSuffixCount = hasContextLimit
    ? Math.min(sharedSuffixCount, normalizedContextLines)
    : sharedSuffixCount;

  const beforeSliceStart = sharedPrefixCount - limitedPrefixCount;
  const afterSliceStart = sharedPrefixCount - limitedPrefixCount;
  const beforeRangeLineCount = limitedPrefixCount + beforeMiddle.length + limitedSuffixCount;
  const afterRangeLineCount = limitedPrefixCount + afterMiddle.length + limitedSuffixCount;

  const patchLines = [
    // 仅有 `---/+++` 文件头时，删除一行 SQL 注释（`-- ...`）会生成 `--- ...` 正文。
    // @pierre/diffs 按该前缀切分 unified diff，会把正文误判为第二个文件并让 FileDiff 崩溃。
    // 补上 Git 文件边界后，解析器只按 `diff --git` 切分，正文不再参与文件数量判断。
    `diff --git a/${fileLabel} b/${fileLabel}`,
    // 新建文件之前会被输出成 --- a/file + @@ -0,0，PatchDiff 会把它当成
    // 普通 rename/change diff 处理；大文件新增时右侧面板可能在行映射和高亮里卡死。
    // 标准 unified diff 应该用 /dev/null 表示不存在的一侧，让解析器走新增/删除语义。
    isCreatedFile ? "--- /dev/null" : `--- a/${fileLabel}`,
    isDeletedFile ? "+++ /dev/null" : `+++ b/${fileLabel}`,
    hasContextLimit
      ? `@@ -${formatDiffRangeFromSliceStart(beforeSliceStart, beforeRangeLineCount)} +${formatDiffRangeFromSliceStart(afterSliceStart, afterRangeLineCount)} @@`
      : `@@ -${formatDiffRange(beforeLines.length)} +${formatDiffRange(afterLines.length)} @@`,
  ];

  // 消息摘要/Git pane 在 context 模式下只需要“改动附近”窗口。
  // 之前即使只看 3 行上下文，也会先把整份 shared prefix/suffix 塞进 patch 再 trim，
  // 大文件（如 1500+ 行 Dockerfile）点展开时会在主线程做大量无效字符串拼接，导致界面卡死。
  // 这里先按 context 截断前后公共区，再交给 trimPatchContext 做最终 hunk 规整。
  patchLines.push(
    ...beforeLines
      .slice(sharedPrefixCount - limitedPrefixCount, sharedPrefixCount)
      .map((line) => ` ${line}`),
  );
  appendDiffBody(patchLines, beforeMiddle, afterMiddle);
  if (limitedSuffixCount > 0) {
    patchLines.push(
      ...beforeLines
        .slice(
          beforeLines.length - sharedSuffixCount,
          beforeLines.length - sharedSuffixCount + limitedSuffixCount,
        )
        .map((line) => ` ${line}`),
    );
  }

  const patch = patchLines.join("\n");
  if (hasContextLimit) {
    // 关键业务逻辑：上一轮更改使用整份 before/after 快照构造 patch。
    // 如果直接把整份 patch 交给预览器，像“大文件只改 1~2 行”这种场景会整页铺满，
    // 用户很难第一眼定位修改点。这里统一裁成“变更附近 + 固定上下文行数”的 diff，
    // 让消息摘要和 Git 面板都优先服务定位问题，而不是回放整份文件。
    return patch; // oracle never trims
  }

  return patch;
}

const MAX_LCS_CELLS = 400_000;

function splitIntoLogicalLines(content: string | null): string[] {
  if (!content) {
    return [];
  }

  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export interface LineChangeStat {
  added: number;
  removed: number;
}

export function computeLineChangeStatOracle(
  beforeContent: string | null,
  afterContent: string,
): LineChangeStat {
  const beforeLines = splitIntoLogicalLines(beforeContent);
  const afterLines = splitIntoLogicalLines(afterContent);

  let prefixIndex = 0;
  while (
    prefixIndex < beforeLines.length &&
    prefixIndex < afterLines.length &&
    beforeLines[prefixIndex] === afterLines[prefixIndex]
  ) {
    prefixIndex += 1;
  }

  let beforeTailIndex = beforeLines.length - 1;
  let afterTailIndex = afterLines.length - 1;
  while (
    beforeTailIndex >= prefixIndex &&
    afterTailIndex >= prefixIndex &&
    beforeLines[beforeTailIndex] === afterLines[afterTailIndex]
  ) {
    beforeTailIndex -= 1;
    afterTailIndex -= 1;
  }

  const trimmedBefore = beforeLines.slice(prefixIndex, beforeTailIndex + 1);
  const trimmedAfter = afterLines.slice(prefixIndex, afterTailIndex + 1);

  if (trimmedBefore.length === 0) {
    return { added: trimmedAfter.length, removed: 0 };
  }

  if (trimmedAfter.length === 0) {
    return { added: 0, removed: trimmedBefore.length };
  }

  // UI 的 edit 卡片和任务摘要都需要“真实改动行数”，
  // 不能把 before/after 总行数直接当成 +/-。这里统一做一次行级 LCS 统计，
  // 再由各端复用同一份结果，避免不同入口展示出不同计数。
  //
  // 另外超大文件如果强行算完整 LCS，会让列表和消息面板明显卡顿，
  // 所以超过阈值时退回到保守估算，优先保证交互流畅。
  if (trimmedBefore.length * trimmedAfter.length > MAX_LCS_CELLS) {
    return { added: trimmedAfter.length, removed: trimmedBefore.length };
  }

  const lcs = Array.from({ length: trimmedAfter.length + 1 }, () => 0);
  for (let beforeIndex = 1; beforeIndex <= trimmedBefore.length; beforeIndex += 1) {
    let previousDiagonal = 0;
    for (let afterIndex = 1; afterIndex <= trimmedAfter.length; afterIndex += 1) {
      const previousRow = lcs[afterIndex]!;
      if (trimmedBefore[beforeIndex - 1] === trimmedAfter[afterIndex - 1]) {
        lcs[afterIndex] = previousDiagonal + 1;
      } else {
        lcs[afterIndex] = Math.max(lcs[afterIndex]!, lcs[afterIndex - 1]!);
      }
      previousDiagonal = previousRow;
    }
  }

  const unchangedLineCount = lcs[trimmedAfter.length] ?? 0;
  return {
    added: trimmedAfter.length - unchangedLineCount,
    removed: trimmedBefore.length - unchangedLineCount,
  };
}
