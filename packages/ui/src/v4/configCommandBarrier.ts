interface ConfigCommandBarrier {
  enqueue<T>(command: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
}

/**
 * The ordering barrier between configuration commands and the send command.
 *
 * A mode/model selection optimistically updates the UI first and only then submits the CAS
 * asynchronously; if the user sends right afterwards, sendText may complete before the CAS retry,
 * so the interface shows the new configuration while the runtime still uses the old one.
 */
export function createConfigCommandBarrier(): ConfigCommandBarrier {
  let pending: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(command: () => Promise<T>): Promise<T> {
      const result = pending.then(command, command);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    wait(): Promise<void> {
      return pending;
    },
  };
}
