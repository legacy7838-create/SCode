interface ParentDisconnectSource {
  once(event: "disconnect", listener: () => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

/**
 * Registers a cleanup hook for the Core's Supervisor IPC disconnect.
 *
 * When the Supervisor is force-killed it sends no shutdown command, so Core still has to close out its own
 * HTTP/WebSocket and Agent resources by itself, otherwise it bypasses the data-root lock and becomes an orphan process.
 */
export function installParentDisconnectHandler(
  onDisconnect: () => void | Promise<void>,
  source: ParentDisconnectSource = process,
): () => void {
  const handler = (): void => {
    void onDisconnect();
  };
  source.once("disconnect", handler);
  return () => source.off("disconnect", handler);
}
