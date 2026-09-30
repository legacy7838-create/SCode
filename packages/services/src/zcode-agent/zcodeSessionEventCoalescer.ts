import type { ZCodeSessionEvent } from "@zcode/shared";
import { getCoalesceKey as nativeGetCoalesceKey, mergeSessionEvents as nativeMergeSessionEvents } from "@zcode/rust/event-coalescer";
import type { ZCodeAgentServiceEvent } from "#src/zcode-agent/zcodeAgent.js";

const DEFAULT_BACKGROUND_SESSION_EVENT_COALESCE_MS = 1_500;
const DEFAULT_BACKGROUND_SESSION_EVENT_MAX_ITEMS = 96;

type SessionServiceEvent = Extract<ZCodeAgentServiceEvent, { type: "session.event" }>;

interface PendingBackgroundSessionEvent {
  key: string;
  event: SessionServiceEvent;
}

interface BackgroundSessionEventCoalescer {
  accept(event: ZCodeAgentServiceEvent): void;
  flush(): void;
  dispose(): void;
}

function getBackgroundSessionEventCoalesceKey(event: ZCodeSessionEvent): string | null {
  return nativeGetCoalesceKey(event);
}

function mergeBackgroundSessionEvents(
  current: ZCodeSessionEvent,
  next: ZCodeSessionEvent,
): ZCodeSessionEvent {
  return nativeMergeSessionEvents(current, next) as ZCodeSessionEvent;
}

export function createBackgroundSessionEventCoalescer(params: {
  emit: (event: ZCodeAgentServiceEvent) => void;
  flushDelayMs?: number;
  maxItems?: number;
}): BackgroundSessionEventCoalescer {
  const flushDelayMs = params.flushDelayMs ?? DEFAULT_BACKGROUND_SESSION_EVENT_COALESCE_MS;
  const maxItems = params.maxItems ?? DEFAULT_BACKGROUND_SESSION_EVENT_MAX_ITEMS;
  let pendingEvents: PendingBackgroundSessionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearFlushTimer(): void {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function flushPending(): void {
    if (pendingEvents.length === 0) {
      clearFlushTimer();
      return;
    }
    const events = pendingEvents.map((item) => item.event);
    pendingEvents = [];
    clearFlushTimer();
    for (const event of events) {
      params.emit(event);
    }
  }

  function scheduleFlush(): void {
    if (disposed || flushTimer || flushDelayMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!disposed) {
        flushPending();
      }
    }, flushDelayMs);
  }

  function acceptSessionEvent(event: SessionServiceEvent): void {
    const key = getBackgroundSessionEventCoalesceKey(event.event);
    if (!key) {
      // Background throttling can only affect recombinable increments. Structured events such as permissions, final state, tool result, etc.
      // You must first complete the existing summary and then deliver it immediately, otherwise the interaction boundary of the task will be destroyed.
      flushPending();
      params.emit(event);
      return;
    }

    const existing = pendingEvents.find((item) => item.key === key);
    if (existing) {
      existing.event = {
        type: "session.event",
        event: mergeBackgroundSessionEvents(existing.event.event, event.event),
      };
    } else {
      pendingEvents.push({ key, event });
    }

    if (pendingEvents.length >= maxItems || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

  return {
    accept(event: ZCodeAgentServiceEvent): void {
      if (disposed) {
        return;
      }
      if (event.type !== "session.event") {
        flushPending();
        params.emit(event);
        return;
      }
      acceptSessionEvent(event);
    },

    flush(): void {
      flushPending();
    },

    dispose(): void {
      // desktop continuous background subscription will be disposed when it is taken over by the foreground.
      // The text/reasoning delta to be flushed is still visible to the user and cannot be discarded by normal cleaning;
      // Otherwise, after switching back to the session, running messages will start to be displayed from the next delta period.
      flushPending();
      disposed = true;
      clearFlushTimer();
    },
  };
}
