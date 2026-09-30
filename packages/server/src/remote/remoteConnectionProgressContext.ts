import { AsyncLocalStorage } from "node:async_hooks";

export type RemoteConnectionProgressLevel = "info" | "warn" | "error";

export interface RemoteConnectionProgressEvent {
  requestId: string;
  level: RemoteConnectionProgressLevel;
  args: unknown[];
}

interface RemoteConnectionProgressStore {
  requestId: string;
  active: boolean;
}

/**
 * Binds the remote connection logs produced concurrently inside a shared Host to their own
 * requestId.
 *
 * Once remote connections were folded into the window-scoped Host, the process label no longer
 * stands for any single remote connection, so Main can no longer tell from the shared stdout which
 * connection a log line belongs to. AsyncLocalStorage preserves the async call-chain context while
 * also switching reporting off once the connection Promise settles, so late log lines from a
 * long-lived stream cannot keep polluting the connection panel.
 */
export function createRemoteConnectionProgressContext(options: {
  emit: (event: RemoteConnectionProgressEvent) => void;
}) {
  const storage = new AsyncLocalStorage<RemoteConnectionProgressStore>();

  return {
    async run<T>(requestId: string, task: () => Promise<T>): Promise<T> {
      const store: RemoteConnectionProgressStore = { requestId, active: true };
      return storage.run(store, async () => {
        try {
          return await task();
        } finally {
          store.active = false;
        }
      });
    },

    report(level: RemoteConnectionProgressLevel, args: unknown[]): void {
      const store = storage.getStore();
      if (!store?.active) {
        return;
      }
      options.emit({ requestId: store.requestId, level, args });
    },
  };
}
