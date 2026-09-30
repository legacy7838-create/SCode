import { memo, useMemo } from "react";
import type { BundledTheme } from "shiki";
import {
  buildHighlightedLightweightDiffCode,
  getHighlightedLightweightDiffLine,
  HighlightedLightweightDiffPreview,
} from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { inferCodeLanguage, type PatchCodeViewerSource } from "@/lib/codeViewer.js";
import { getPlainTextPatchPreviewLines } from "@/lib/patchDiffPreview.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";

export {
  buildHighlightedLightweightDiffCode as buildInlineDiffHighlightCode,
  getHighlightedLightweightDiffLine as getInlineDiffHighlightLine,
};

function resolveInlineDiffHighlightTheme(
  theme: Theme | undefined,
  codePreviewSettings: CodePreviewSettings,
): BundledTheme {
  if (theme === "system") {
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? codePreviewSettings.darkTheme
        : codePreviewSettings.lightTheme;
    }

    return codePreviewSettings.lightTheme;
  }

  return theme === "dark" || theme === "zai-dark"
    ? codePreviewSettings.darkTheme
    : codePreviewSettings.lightTheme;
}

export const EditInlineDiffContent = memo(function EditInlineDiffContent({
  preview,
  theme = "system",
  codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
}: {
  preview: PatchCodeViewerSource;
  /**
   * Apply theme (store coupling stripping): Determine the light/dark theme for diff highlighting.
   * Passed in by the caller (tool call rendering context); the default "system" follows the operating system.
   */
  theme?: Theme;
  /** Code preview settings (store coupling stripping): passed in by the caller, the reference must be kept stable. */
  codePreviewSettings?: CodePreviewSettings;
}) {
  const previewLines = useMemo(() => getPlainTextPatchPreviewLines(preview.patch), [preview.patch]);
  const highlightLanguage = useMemo(
    () => inferCodeLanguage(preview.path ?? preview.title, preview.patch),
    [preview.patch, preview.path, preview.title],
  );
  const highlightTheme = useMemo(
    () => resolveInlineDiffHighlightTheme(theme, codePreviewSettings),
    [codePreviewSettings, theme],
  );

  return (
    <div className="space-y-3">
      <div
        className="mb-2 max-h-60 overflow-auto rounded-xl border border-border bg-card"
        data-inline-diff-preview
      >
        {/* When chat inline diff is expanded, mounting @pierre/diffs directly will push highlight and Shadow DOM summary rendering to the main thread.
        This causes the frame to drop for a long time after clicking to expand. Here, only lightweight hunk text is rendered in the first frame, and Shiki token is asynchronously added in the effect;
        Previously, keeping only plain text would cause the diff in the session to permanently lose syntax highlighting. */}
        <HighlightedLightweightDiffPreview
          className="h-full bg-card"
          codePreviewSettings={codePreviewSettings}
          data-inline-diff-highlight-language={highlightLanguage}
          data-inline-diff-highlight-theme={highlightTheme}
          language={highlightLanguage}
          lines={previewLines}
          path={preview.path ?? preview.title}
          theme={highlightTheme}
        />
      </div>
    </div>
  );
});
EditInlineDiffContent.displayName = "EditInlineDiffContent";
