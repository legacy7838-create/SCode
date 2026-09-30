import { useEffect, useState } from "react";

/**
 * Reuses the 5-second operation deadline of the browser-use tab cursor icon. The icon and the
 * in-browser hint must share this one check, so that one side cannot consider the tool still
 * running while the other already considers it finished.
 */
export function useBrowserUseOperationActive(operationUntil = 0): boolean {
  const [expiredOperationUntil, setExpiredOperationUntil] = useState(0);
  const isActive = operationUntil > Date.now() && expiredOperationUntil !== operationUntil;

  useEffect(() => {
    const remainingMs = operationUntil - Date.now();
    if (remainingMs <= 0) return;
    const timer = window.setTimeout(() => setExpiredOperationUntil(operationUntil), remainingMs);
    return () => window.clearTimeout(timer);
  }, [operationUntil]);

  return isActive;
}
