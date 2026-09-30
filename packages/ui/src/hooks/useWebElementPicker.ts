import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@/logger.js";
import {
  dispatchWebElementContextAddToChat,
  isWebElementContextPayload,
  type WebElementContextPayload,
} from "@/lib/webElementContext.js";
import {
  buildCancelWebElementPickerScript,
  buildWebElementPickerScript,
  type WebElementPickerScriptLabels,
  type WebElementPickerScriptResult,
} from "@/lib/webElementPickerScript.js";

interface UseWebElementPickerOptions {
  /**
   * Transport-agnostic script execution outlet: sends the picking script to the target page and returns the result.
   * UnifiedBrowserView goes through main IPC (executeJavaScript).
   */
  executeJs: (script: string) => Promise<unknown>;
  workspacePath: string;
  workspaceIdentity?: string;
  labels?: Partial<WebElementPickerScriptLabels>;
}

function isWebElementPickerScriptResult(result: unknown): result is WebElementPickerScriptResult {
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const candidate = result as WebElementPickerScriptResult;
  return (
    candidate.status === "cancelled" ||
    (candidate.status === "selected" &&
      typeof candidate.element === "object" &&
      candidate.element !== null)
  );
}

function buildPayload(params: {
  result: Extract<WebElementPickerScriptResult, { status: "selected" }>;
  workspacePath: string;
  workspaceIdentity?: string;
}): WebElementContextPayload | null {
  const payload: WebElementContextPayload = {
    ...params.result.element,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  };

  return isWebElementContextPayload(payload) ? payload : null;
}

function sanitizeUrlForLog(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/u)[0] ?? "";
  }
}

export function useWebElementPicker({
  executeJs,
  workspacePath,
  workspaceIdentity,
  labels,
}: UseWebElementPickerOptions) {
  const [isPicking, setIsPicking] = useState(false);
  const activePickerRunRef = useRef(0);
  // The executeJs reference may change on every render; pin it with a ref so useCallback does not depend on it and rebuild frequently.
  const executeJsRef = useRef(executeJs);
  executeJsRef.current = executeJs;

  const cancelPicking = useCallback(async () => {
    activePickerRunRef.current += 1;
    setIsPicking(false);

    try {
      await executeJsRef.current(buildCancelWebElementPickerScript());
    } catch (error) {
      logger.debug("[UnifiedBrowserView] failed to cancel web element picking", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const startPicking = useCallback(async () => {
    const runId = activePickerRunRef.current + 1;
    activePickerRunRef.current = runId;
    setIsPicking(true);
    logger.info("[UnifiedBrowserView] starting web element picking");

    try {
      const result = await executeJsRef.current(
        buildWebElementPickerScript(labels ? { labels } : {}),
      );
      if (activePickerRunRef.current !== runId) {
        return;
      }

      if (!isWebElementPickerScriptResult(result)) {
        logger.warn("[UnifiedBrowserView] web element picking returned an unrecognized result");
        return;
      }

      if (result.status === "cancelled") {
        logger.info("[UnifiedBrowserView] web element picking cancelled");
        return;
      }

      const payload = buildPayload({
        result,
        workspacePath,
        workspaceIdentity,
      });
      if (!payload) {
        logger.warn("[UnifiedBrowserView] web element context is invalid, dropped");
        return;
      }

      dispatchWebElementContextAddToChat(payload);
      logger.info("[UnifiedBrowserView] web element context added to chat", {
        tagName: payload.tagName,
        url: sanitizeUrlForLog(payload.pageUrl),
      });
    } catch (error) {
      logger.warn("[UnifiedBrowserView] web element picking failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (activePickerRunRef.current === runId) {
        setIsPicking(false);
      }
    }
  }, [labels, workspaceIdentity, workspacePath]);

  const togglePicking = useCallback(async () => {
    if (isPicking) {
      await cancelPicking();
      return;
    }
    await startPicking();
  }, [cancelPicking, isPicking, startPicking]);

  useEffect(() => {
    if (!isPicking) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      // When the controlled view has focus the injected script handles Esc; while focus is still on the outer toolbar,
      // cancel as a fallback here so the picking state cannot get stuck depending on where focus is.
      void cancelPicking();
    };

    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, [cancelPicking, isPicking]);

  useEffect(() => {
    return () => {
      void cancelPicking();
    };
  }, [cancelPicking]);

  return {
    cancelPicking,
    isPicking,
    startPicking,
    togglePicking,
  };
}
