interface BrowserOperationResultLike {
  ok?: unknown;
  meta?: unknown;
  tab?: unknown;
}

/**
 * Only commands where the model explicitly opens, shows, activates, or changes the viewport may
 * rebuild the renderer size baseline. Ordinary navigate/locator/screenshot commands must return
 * false, otherwise a genuine user resize within the same operation cycle would be swallowed.
 */
export function browserOperationResetsResizeBaseline(command: unknown): boolean {
  if (!command || typeof command !== "object") return false;
  const method = Reflect.get(command, "method");
  if (method === "browserVisibilitySet") return Reflect.get(command, "visible") === true;
  return ["activateTab", "browserViewportReset", "browserViewportSet", "newTab"].includes(
    String(method),
  );
}

function readTabId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tabId = Reflect.get(value, "tabId");
  return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
}

/**
 * At the start of a browser command, prefer the explicit tabId; for new/default-tab calls without
 * one, the real tab identity resolved by the manager may only be read from a successful result —
 * the UI is forbidden from guessing on its own.
 */
export function resolveBrowserOperationTabId(
  command: unknown,
  result?: BrowserOperationResultLike,
): string | undefined {
  const requestedTabId = readTabId(command);
  if (requestedTabId) return requestedTabId;
  if (result?.ok !== true) return undefined;
  return readTabId(result.meta) ?? readTabId(result.tab);
}
