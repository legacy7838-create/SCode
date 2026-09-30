/**
 * A protocol process has exactly one diagnostic egress. The async error of the real stream must be
 * listened to, and not just the write caught:
 * otherwise EPIPE -> uncaughtException -> writing to stderr again forms a high-CPU self-exciting loop.
 */
export function installProtocolStderrBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalWrite = stderr.write;
  let unavailable = false;
  const onError = () => {
    unavailable = true;
  };
  stderr.on("error", onError);
  stderr.on("close", onError);
  stderr.write = ((chunk, encodingOrCallback, callback): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (!unavailable) {
      try {
        return originalWrite.call(stderr, chunk, encoding, (error) => {
          if (error) unavailable = true;
          writeCallback?.();
        });
      } catch {
        unavailable = true;
      }
    }
    // Diagnosis is best effort; the caller's flush is still completed after the exit fails, and it no longer writes bad streams or reports itself as a failure.
    if (writeCallback) queueMicrotask(() => writeCallback());
    return true;
  }) as typeof stderr.write;
  return () => {
    stderr.write = originalWrite;
    stderr.off("error", onError);
    stderr.off("close", onError);
  };
}
