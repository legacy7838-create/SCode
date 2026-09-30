// TUI resident session event relay.
//
// The purpose of forming a separate module is to allow the property of "rehang when changing apps" to be directly tested: if it is buried in tui-prompt-handler
// In the closure, it can only be verified by a complete set of app factory fakes, and the consequences of the leak are very quiet - after changing the session, the TUI will no longer work.
// No out-of-turn events (dwf progress, notification-driven rounds) are received, and the interface looks completely normal.
import type { SessionEvent } from "@zcode/contracts";

/** Read the subscription function from the runtime; if it cannot be read, it will return undefined (the ability is not in the static type). */
type SessionEventSubscriberReader = (
  runtime: unknown,
) => ((sink: { onSessionEvent: (event: SessionEvent) => void }) => () => void) | undefined;

interface TuiSessionEventRelay {
  /** Register a sink; return to unsubscribe. The first sink will trigger the real transaction. */
  addSink: (sink: (event: SessionEvent) => void) => () => void;
  /** Reinstall after changing app: Disconnect the old one first, and then reinstall it in the current runtime. No hang when there is no sink. */
  reattach: () => void;
  /** Tear down the current subscription (without clearing the sink registry). */
  detach: () => void;
  /** Whether it is currently hanging (for testing and diagnosis). */
  isAttached: () => boolean;
}

export function createTuiSessionEventRelay(input: {
  /** Read the runtime of the current app every time it is resuspended - the closure reads instead of passing a value to keep up with replaceApp. */
  currentRuntime: () => unknown;
  readSubscriber: SessionEventSubscriberReader;
}): TuiSessionEventRelay {
  const sinks = new Set<(event: SessionEvent) => void>();
  let detachCurrent: (() => void) | undefined;

  const detach = (): void => {
    detachCurrent?.();
    detachCurrent = undefined;
  };

  const reattach = (): void => {
    detach();
    if (sinks.size === 0) return;
    const subscribe = input.readSubscriber(input.currentRuntime());
    detachCurrent = subscribe?.({
      onSessionEvent: (event) => {
        // Directly traverse Set: JS's Set iteration is safe for "deletion during traversal" (deleted and unvisited items will be skipped),
        // Therefore, sink's unsubscription in the callback will not destroy this fanout, and it should not receive this message again.
        for (const sink of sinks) sink(event);
      },
    });
  };

  return {
    addSink: (sink) => {
      sinks.add(sink);
      if (sinks.size === 1) reattach();
      return () => {
        sinks.delete(sink);
        if (sinks.size === 0) detach();
      };
    },
    reattach,
    detach,
    isAttached: () => detachCurrent !== undefined,
  };
}
