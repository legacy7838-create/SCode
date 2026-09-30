import type { HighlighterTypes } from "@pierre/diffs";
import type { WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import type { BundledTheme } from "shiki";

/**
 * @pierre/diffs uses shiki's JavaScript regex engine (shiki-js) by default. That engine translates
 * each TextMate grammar into a giant RegExp and holds it permanently in an engine-level cache; V8
 * compiles every executed regex to native code in code space, and double-byte text (Chinese
 * comments and the like) gets a second compiled copy. The main window and the 4 diff workers share
 * a single 256MB code range, so after long runs these regexes fill it and trigger a V8 OOM in the
 * renderer (CALL_AND_RETRY_LAST, with plenty of old-space still free and the code cage reporting
 * "ran out of reservation"). The oniguruma WASM engine keeps its regexes in wasm linear memory, so
 * they never occupy V8's code area, and it is the reference implementation for TextMate grammars.
 */
export const DIFFS_PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

interface DiffsHighlighterThemeSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
}

/**
 * Initialization parameters for the diff worker pool; the main-thread fallback rendering and the
 * workers must use the same engine choice.
 */
export function createDiffsWorkerHighlighterOptions(
  settings: DiffsHighlighterThemeSettings,
): WorkerInitializationRenderOptions {
  return {
    theme: {
      light: settings.lightTheme,
      dark: settings.darkTheme,
    },
    // The word-by-word difference calculation of different patches will additionally occupy the main thread; the library default threshold will be used first.
    // Subsequent tightening can be done individually based on the slow log to avoid the regression of "sudden disappearance of highlighted information" caused by one change.
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 1_000,
    useTokenTransformer: false,
    preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
  };
}
