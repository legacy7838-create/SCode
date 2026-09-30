import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";

function scrollRemoteConnectionLogsToLatest(
  viewport: Pick<HTMLElement, "scrollHeight" | "scrollTop">,
): void {
  viewport.scrollTop = viewport.scrollHeight;
}

function scheduleRemoteConnectionLogsScrollToLatest(
  viewport: Pick<HTMLElement, "scrollHeight" | "scrollTop">,
  scheduleFrame: (callback: () => void) => number = (callback) =>
    window.requestAnimationFrame(callback),
  cancelFrame: (frameId: number) => void = (frameId) => window.cancelAnimationFrame(frameId),
): () => void {
  scrollRemoteConnectionLogsToLatest(viewport);
  const frameId = scheduleFrame(() => scrollRemoteConnectionLogsToLatest(viewport));
  return () => cancelFrame(frameId);
}

export function ReconnectingRemoteWorkspaceLogTooltip({
  logs,
  children,
}: {
  logs: RemoteConnectionLogEntry[];
  children?: ReactElement;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const cancelScheduledScrollRef = useRef<() => void>(() => {});

  const scrollLogsToLatest = useCallback((viewport: HTMLDivElement) => {
    cancelScheduledScrollRef.current();

    // Tooltip will re-display the log floating layer every time it hovers. The browser starts from scrollTop=0 by default.
    // The connection log needs to see the latest progress first, so it is rolled once when the node is mounted, and then rolled again after the layout of the next frame is stable.
    cancelScheduledScrollRef.current = scheduleRemoteConnectionLogsScrollToLatest(viewport);
  }, []);

  const setLogViewportRef = useCallback(
    (viewport: HTMLDivElement | null) => {
      logViewportRef.current = viewport;
      if (viewport) {
        scrollLogsToLatest(viewport);
      }
    },
    [scrollLogsToLatest],
  );

  useEffect(() => {
    if (open && logViewportRef.current) {
      scrollLogsToLatest(logViewportRef.current);
    }

    return undefined;
  }, [logs.length, open, scrollLogsToLatest]);

  useEffect(() => () => cancelScheduledScrollRef.current(), []);

  return (
    <TooltipProvider>
      <Tooltip onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          {children ? (
            children
          ) : (
            // When the remote workspace reconnected in the background, the user could only see "Connecting" before.
            // It is impossible to determine whether it is currently stuck or which step it is stuck at. Here we add hover logs for instructions in the connection,
            // Allow users to see real-time progress without interrupting the flow.
            <div
              className="flex shrink-0 items-center gap-1 text-ui-base text-foreground-subtle"
              aria-label={intl.formatMessage({
                id: "workspaceSidebar.connecting",
              })}
            >
              <LoaderCircle className="h-3 w-3 animate-spin" />
              <span>{intl.formatMessage({ id: "workspaceSidebar.connecting" })}</span>
            </div>
          )}
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={6}
          className="w-[min(24rem,calc(100vw-1rem))] max-w-[min(24rem,calc(100vw-1rem))] overflow-hidden px-3 py-2"
        >
          <div className="space-y-2">
            <div className="text-ui-sm font-medium text-tooltip-foreground">
              {intl.formatMessage({ id: "remote.connectionLog" })}
            </div>
            <div
              ref={setLogViewportRef}
              className="max-h-56 space-y-1 overflow-x-hidden overflow-y-auto font-mono text-ui-sm"
            >
              {logs.length > 0 ? (
                logs.map((entry) => (
                  <div key={entry.id} className="flex min-w-0 items-start leading-5">
                    <span className="shrink-0 text-tooltip-foreground/60">{entry.timestamp}</span>
                    <span
                      className={cn(
                        "mx-2 shrink-0",
                        entry.level === "success"
                          ? "text-success"
                          : entry.level === "warn"
                            ? "text-warning"
                            : entry.level === "error"
                              ? "text-destructive"
                              : "text-tooltip-foreground/70",
                      )}
                    >
                      [{entry.level.toUpperCase()}]
                    </span>
                    <span className="min-w-0 flex-1 break-all whitespace-pre-wrap text-tooltip-foreground">
                      {entry.message}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-tooltip-foreground/70">
                  [INFO] {intl.formatMessage({ id: "remote.connectionLogEmpty" })}
                </div>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
