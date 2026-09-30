// composer parity: Ignore judgment of Esc → stop (pure function, no host dependencies).
export function shouldIgnoreEscapeForStopGeneration(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return true;
  }

  const path = event.composedPath();
  return path.some((target) => {
    if (!target || typeof target !== "object") {
      return false;
    }

    const maybeElement = target as {
      dataset?: { slot?: string };
      getAttribute?: (name: string) => string | null;
    };
    return (
      // The same event continues when the Cmd/Ctrl+P file selection popup is closed with Escape
      // Bubbles to the window; identifies the Radix/Dialog event path and skips the stop task to avoid accidental stop generation by "closing the pop-up window".
      maybeElement.dataset?.slot === "dialog-content" ||
      maybeElement.getAttribute?.("role") === "dialog"
    );
  });
}
