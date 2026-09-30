import { loadDiff } from "@zcode/rust/diff";
import type { DiffHunk } from "@zcode/contracts";

const CONTEXT_LINES = 3;

// Local TS implementation has been migrated to the Rust native engine (spec: docs/specs/rust-native-diff.md).
// loadDiff() throws directly when the native binary is missing/corrupted (no JS fallback, spec invariant 1).
const nativeDiff = loadDiff();

export const createStructuredPatch = ({
  filePath,
  newContent,
  oldContent,
}: {
  filePath: string;
  newContent: string;
  oldContent: string;
}): DiffHunk[] => {
  // filePath 在旧实现中仅进入被丢弃的 patch 头（oldFileName/newFileName），
  // hunk 内容与文件名无关；保留签名以兼容调用方，此处不再使用。
  void filePath;
  return nativeDiff.structuredPatch(oldContent, newContent, CONTEXT_LINES);
};

export const countPatchLines = (
  structuredPatch: DiffHunk[],
): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;

  for (const hunk of structuredPatch) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }

  return { additions, deletions };
};
