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

export function computeLineChangeStat(
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

  // Both the edit card and task summary of the UI require "the actual number of rows changed".
  // The total number of lines before/after cannot be directly regarded as +/-. Here we do a unified row-level LCS statistics.
  // Then each end reuses the same result to avoid different entries showing different counts.
  //
  // In addition, if a large file is forced to calculate the complete LCS, the list and message panel will be obviously stuck.
  // Therefore, when the threshold is exceeded, fall back to a conservative estimate and prioritize ensuring smooth interaction.
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
