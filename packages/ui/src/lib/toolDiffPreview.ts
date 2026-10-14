import { trimPatchContext } from "@pierre/diffs";
import { diffPatch } from "@/lib/diffWasm.js";

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

/**
 * Build a unified diff (mirrors the removed JavaScript implementation, now computed in Rust).
 *
 * The dynamic program, the line splitting, the shared prefix/suffix trim, the `@@` range numbers
 * and the `diff --git` / `--- /dev/null` / `+++` headers all live in `zcode-diff-wasm`; this function
 * only forwards to the kernel and applies `@pierre/diffs`' `trimPatchContext` when the caller asked
 * for a context limit. Trimming is a string hunk post-processor, not an LCS, so it stays here.
 *
 * `contextLines` omitted means "no context limit": the kernel returns the full patch and no
 * trimming happens. The removed JavaScript cell caps are gone — the kernel bounds itself with a
 * safety ceiling far above them, so files that used to degrade now diff correctly.
 *
 * There is no JavaScript fallback: if the kernel is not prepared, `diffPatch` throws.
 */
export function buildUnifiedDiff(
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
  // `-1` is the kernel's "no limit" sentinel; it must not be confused with `contextLines: 0`
  // (which is a real limit: zero context lines).
  const kernelContextLines = hasContextLimit ? normalizedContextLines : -1;

  const patch = diffPatch(before, after, fileLabel, kernelContextLines);

  if (hasContextLimit) {
    // 关键业务逻辑：上一轮更改使用整份 before/after 快照构造 patch。
    // 如果直接把整份 patch 交给预览器，像“大文件只改 1~2 行”这种场景会整页铺满，
    // 用户很难第一眼定位修改点。这里统一裁成“变更附近 + 固定上下文行数”的 diff，
    // 让消息摘要和 Git 面板都优先服务定位问题，而不是回放整份文件。
    return trimPatchContext(patch, normalizedContextLines);
  }

  return patch;
}
