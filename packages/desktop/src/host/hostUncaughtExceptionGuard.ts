interface HostUncaughtExceptionGuardOptions {
  onRecovered: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
  onFatal: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
}

function isRecoverableHostAllocationError(error: unknown): error is RangeError {
  return error instanceof RangeError && error.message === "Failed to allocate memory";
}

export function createHostUncaughtExceptionHandler({
  onRecovered,
  onFatal,
}: HostUncaughtExceptionGuardOptions): (
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
) => void {
  return (error, origin) => {
    if (!isRecoverableHostAllocationError(error)) {
      onFatal(error, origin);
      return;
    }

    try {
      // When Electron's built-in Node projects the peer certificate into a JS object in the TLS handshake,
      // Failure to allocate native Buffer will escape the socket callback; Utility Process will abort directly by default.
      // Similar allocation errors can be recycled by request timeout/retry in ordinary Promise chains, so only the explicit errors are isolated here.
      // Log reporting failure cannot be escalated to a process-level uncaught exception again.
      onRecovered(error, origin);
    } catch {
      // The diagnostic log itself may also fail to allocate when memory is tight, and guard boundaries must remain throw-free.
    }
  };
}
