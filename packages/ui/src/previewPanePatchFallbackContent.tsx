import { useMemo } from "react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { HighlightedLightweightDiffPreview } from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import { getPlainTextPatchFallbackLines } from "@/lib/patchDiffPreview.js";
import type { CodePreviewSettings } from "@/store/index.js";

interface PatchFallbackContentProps {
  patch: string;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: "light" | "dark";
  sourcePath?: string;
  sourceTitle?: string;
}

export function PatchFallbackContent({
  patch,
  codePreviewSettings,
  resolvedTheme,
  sourcePath,
  sourceTitle,
}: PatchFallbackContentProps) {
  const plainTextFallbackLines = useMemo(() => getPlainTextPatchFallbackLines(patch), [patch]);
  const highlightPath = sourcePath ?? sourceTitle;
  const highlightLanguage = useMemo(
    () => inferCodeLanguage(highlightPath, patch),
    [highlightPath, patch],
  );
  const highlightTheme =
    resolvedTheme === "dark" ? codePreviewSettings.darkTheme : codePreviewSettings.lightTheme;

  if (plainTextFallbackLines) {
    // @pierre/diffs' PatchDiff only supports single-file patches. Too many files appear in the log
    // patch directly enters the preview on the right. During the production package rendering phase, errors will be thrown and the sidebar will be stuck, so it is downgraded to lightweight diff here.
    // The right Diff opened by edit will also use this lightweight fallback for adding/deleting files; before, it only rendered plain text.
    // This causes HTML/TS and other files to lose syntax highlighting on the right side. Asynchronous Shiki highlighting is reused here to retain a lightweight rendering path that does not stutter.
    return (
      <HighlightedLightweightDiffPreview
        className="h-full"
        codePreviewSettings={codePreviewSettings}
        data-patch-plain-text-preview
        language={highlightLanguage}
        lines={plainTextFallbackLines}
        path={highlightPath}
        theme={highlightTheme}
      />
    );
  }

  return (
    <DiffViewer
      patch={patch}
      diffClassName="block"
      fontSizePx={codePreviewSettings.fontSizePx}
      lightTheme={codePreviewSettings.lightTheme}
      darkTheme={codePreviewSettings.darkTheme}
      themeType={resolvedTheme}
    />
  );
}
