/**
 * useTerminalService —— terminal service hooks
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { IDisposable } from "@zcode/rpc";
import { logger } from "@/logger.js";
import { useServices } from "./useServices.js";

/**
 * Terminal lifecycle management hook
 *
 * Wraps create/write/resize/dispose and the onDynamicData/onDynamicExit event subscriptions.
 * Terminals and event subscriptions are cleaned up automatically when the component unmounts.
 */
export function useTerminal(opts: {
  cols: number;
  rows: number;
  cwd?: string;
  onData?: (data: string) => void;
  onExit?: (code: number) => void;
}) {
  const { terminalService } = useServices();
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);

  // Keep a ref to the callbacks so the effect does not rerun
  const onDataRef = useRef(opts.onData);
  onDataRef.current = opts.onData;
  const onExitRef = useRef(opts.onExit);
  onExitRef.current = opts.onExit;

  useEffect(() => {
    let cancelled = false;
    let id: string | null = null;

    terminalService
      .create({ cols: opts.cols, rows: opts.rows, cwd: opts.cwd })
      .then(({ id: newId }) => {
        if (cancelled) {
          terminalService.dispose({ id: newId });
          return;
        }
        id = newId;
        setTerminalId(newId);

        // Subscribe to terminal output
        const dataSub = terminalService.onDynamicData(newId)((data) => {
          onDataRef.current?.(data);
        });
        disposablesRef.current.push(dataSub);

        // Subscribe to terminal exit
        const exitSub = terminalService.onDynamicExit(newId)((code) => {
          onExitRef.current?.(code);
        });
        disposablesRef.current.push(exitSub);
      })
      .catch((error) => {
        // The hook layer previously did not handle create() failure either, so any consumer would get an unhandled Promise.
        // Swallow the rejection uniformly and log it here, so callers without an error subscription are not interrupted by a global error.
        if (cancelled) return;
        logger.error("[terminal] failed to create terminal", error);
      });

    return () => {
      cancelled = true;
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      if (id) terminalService.dispose({ id });
    };
  }, [terminalService, opts.cols, opts.rows, opts.cwd]);

  const write = useCallback(
    (data: string) => {
      if (terminalId) terminalService.write({ id: terminalId, data });
    },
    [terminalService, terminalId],
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (terminalId) terminalService.resize({ id: terminalId, cols, rows });
    },
    [terminalService, terminalId],
  );

  return { terminalId, write, resize };
}
