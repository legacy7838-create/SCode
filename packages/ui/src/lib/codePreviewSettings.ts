/**
 * The types and defaults for code preview settings.
 *
 * A standalone neutral module: if these were defined in the zustand store (@/store/index.ts),
 * purely presentational components (ai-elements / ToolCallBlocks) would have to depend on the store
 * just to get the types and defaults. The store only re-exports, and the presentational components
 * take them as props with this module's defaults as the fallback.
 */
import type { BundledTheme } from "shiki";

export interface CodePreviewSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
}

export const DEFAULT_CODE_PREVIEW_SETTINGS: CodePreviewSettings = {
  lightTheme: "github-light",
  darkTheme: "github-dark",
  showLineNumbers: true,
  wrapLongLines: false,
  fontSizePx: 12,
};
