interface RendererNavigationEntry {
  readonly type?: string;
}

function readRendererNavigationEntries(): RendererNavigationEntry[] {
  try {
    if (typeof globalThis.performance?.getEntriesByType !== "function") {
      return [];
    }
    return globalThis.performance.getEntriesByType("navigation") as RendererNavigationEntry[];
  } catch {
    return [];
  }
}

/**
 * Distinguish a cold app start from a refresh of the same renderer. The workspace/app entry should
 * show only the draft, but a renderer reload in the output still has to restore the current pane's
 * stream.
 */
export function isRendererReloadNavigation(
  entries: readonly RendererNavigationEntry[] = readRendererNavigationEntries(),
): boolean {
  return entries[0]?.type === "reload";
}
