import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Unified listening for mouse, keyboard, and touch selections; after the scope changes, an old
 * selection must not be routed to the new task.
 */
export function useTextSelection<T>({
  rootRef,
  enabled,
  inspect,
  scopeKey,
  observeSelectionChange = false,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  inspect: () => T | null;
  scopeKey: unknown;
  observeSelectionChange?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ scopeKey: unknown; value: T } | null>(null);
  const frameRef = useRef(0);
  const close = useCallback(() => {
    window.cancelAnimationFrame(frameRef.current);
    setSnapshot(null);
  }, []);
  useEffect(() => {
    close();
    const root = rootRef.current;
    if (!root || !enabled) return;
    const schedule = () => {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => {
        const value = inspect();
        setSnapshot(value ? { scopeKey, value } : null);
      });
    };
    const onKey = (event: KeyboardEvent) => (event.key === "Escape" ? close() : schedule());
    const onSelection = () => {
      if (window.getSelection()?.isCollapsed) close();
      else if (observeSelectionChange) schedule();
    };
    root.addEventListener("mouseup", schedule);
    root.addEventListener("touchend", schedule, { passive: true });
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onSelection);
    root.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      window.cancelAnimationFrame(frameRef.current);
      root.removeEventListener("mouseup", schedule);
      root.removeEventListener("touchend", schedule);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onSelection);
      root.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [close, enabled, inspect, observeSelectionChange, rootRef, scopeKey]);
  return {
    state: enabled && snapshot && snapshot.scopeKey === scopeKey ? snapshot.value : null,
    close,
  };
}
