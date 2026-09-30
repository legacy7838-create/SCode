import { useEffect, useRef, useState } from "react";
import type { RemoteConnectionRuntimeLog } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";

export interface RemoteConnectionLogEntry {
  id: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  timestamp: string;
}

export function normalizeRemoteConnectionLogMessage(message: string): string {
  return message
    .replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/u, "")
    .replace(/^\[pid:\d+\]\s*/u, "")
    .replace(/^(?:\[[^\]]+\]\s*)+/u, "")
    .trim();
}

function isRemoteDownloadProgressLog(message: string): boolean {
  return /^download progress:/iu.test(message);
}

function getRemoteTransferProgressKey(message: string): string | null {
  if (isRemoteDownloadProgressLog(message)) {
    return "download";
  }

  const uploadMatch = /^upload progress(?: \[([^\]]+)\])?(?: \((.+)\))?:/iu.exec(message);
  if (!uploadMatch) {
    return null;
  }

  return `upload:${uploadMatch[1]?.trim() ?? ""}:${uploadMatch[2]?.trim() ?? ""}`;
}

export function appendRemoteConnectionRuntimeLog(
  currentLogs: RemoteConnectionLogEntry[],
  incoming: {
    id: string;
    level: RemoteConnectionLogEntry["level"];
    message: string;
    timestamp: string;
  },
): RemoteConnectionLogEntry[] {
  const incomingProgressKey = getRemoteTransferProgressKey(incoming.message);
  if (incomingProgressKey) {
    let matchingProgressIndex = -1;
    for (let index = currentLogs.length - 1; index >= 0; index -= 1) {
      const currentLog = currentLogs[index];
      if (currentLog && getRemoteTransferProgressKey(currentLog.message) === incomingProgressKey) {
        matchingProgressIndex = index;
        break;
      }
    }

    if (matchingProgressIndex >= 0) {
      const matchingLog = currentLogs[matchingProgressIndex];
      if (matchingLog) {
        // When uploading multiple remote resources, progress from different files interleaves; merging only adjacent progress lines makes
        // later updates to the same file append into a long run of speed lines. Here we dedupe by "transfer type + file identity" across the whole log window,
        // moving the latest progress to the end so each active transfer occupies exactly one line and the newest speed stays near the bottom of the visible area.
        return [
          ...currentLogs.slice(0, matchingProgressIndex),
          ...currentLogs.slice(matchingProgressIndex + 1),
          {
            ...matchingLog,
            level: incoming.level,
            message: incoming.message,
            timestamp: incoming.timestamp,
          },
        ];
      }
    }
  }

  return [
    ...currentLogs,
    {
      id: incoming.id,
      level: incoming.level,
      message: incoming.message,
      timestamp: incoming.timestamp,
    },
  ];
}

function shouldAcceptRemoteConnectionRuntimeLog(
  entry: Pick<RemoteConnectionRuntimeLog, "requestId">,
  activeRequestId?: string | null,
): boolean {
  const normalizedActiveRequestId = activeRequestId?.trim();
  if (!normalizedActiveRequestId) {
    return true;
  }

  return entry.requestId?.trim() === normalizedActiveRequestId;
}

export function useRemoteConnectionLogs(activeRequestId?: string | null) {
  const platform = usePlatform();
  const activeRequestIdRef = useRef(activeRequestId);
  const [connectionLogs, setConnectionLogs] = useState<RemoteConnectionLogEntry[]>([]);

  useEffect(() => {
    activeRequestIdRef.current = activeRequestId;
  }, [activeRequestId]);

  useEffect(() => {
    const unsubscribe = platform.onRemoteConnectionLog((entry) => {
      if (!shouldAcceptRemoteConnectionRuntimeLog(entry, activeRequestIdRef.current)) {
        return;
      }

      const normalizedMessage = normalizeRemoteConnectionLogMessage(entry.message);
      if (!normalizedMessage) {
        return;
      }

      setConnectionLogs((currentLogs) =>
        appendRemoteConnectionRuntimeLog(currentLogs, {
          id: `${entry.label}-${entry.timestamp}-${currentLogs.length}`,
          level: entry.level,
          message: normalizedMessage,
          timestamp: entry.timestamp,
        }),
      );
    });

    return unsubscribe;
  }, [platform]);

  const resetConnectionLogs = () => {
    setConnectionLogs([]);
  };

  const appendConnectionLog = (level: RemoteConnectionLogEntry["level"], message: string) => {
    setConnectionLogs((currentLogs) => [
      ...currentLogs,
      {
        id: `${Date.now()}-${currentLogs.length}`,
        level,
        message,
        timestamp: new Date().toLocaleTimeString(undefined, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      },
    ]);
  };

  return {
    connectionLogs,
    resetConnectionLogs,
    appendConnectionLog,
  };
}
