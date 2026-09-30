type DeliveryStatus = "http_received" | "unconfirmed";
const REQUEST_TIMEOUT_MS = 15_000;

/** Decorates the SDK's public `reporter.request`: it still uses the original filtering/sampling/serialization and does not send bare HTTP of its own. */
export function wrapStartupReporterRequest<C, B extends { events?: unknown[] }>(
  request: (context: C, bundle: B) => unknown,
  options: {
    acknowledged: (ids: string[], status: DeliveryStatus) => void;
    delay?: (ms: number) => Promise<void>;
  },
): (context: C, bundle: B) => Promise<unknown> {
  const delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (context, bundle) => {
    const ids = (bundle.events ?? []).flatMap((event) => {
      const id = (event as { properties?: { startup_event_id?: unknown } })?.properties
        ?.startup_event_id;
      return typeof id === "string" ? [id] : [];
    });
    if (ids.length === 0) return request(context, bundle);
    const report = (status: DeliveryStatus) => {
      try {
        options.acknowledged(ids, status);
      } catch {
        /* Diagnostic exit failures are not reported recursively. */
      }
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => request(context, bundle)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("Startup telemetry request timeout"));
            }, REQUEST_TIMEOUT_MS);
          }),
        ]);
        if (response && typeof response === "object" && "ok" in response && response.ok === true) {
          report("http_received");
          return response;
        }
      } catch {
        /* Telemetry network retry only; never calls the startup coordinator or database. */
      } finally {
        if (timer) clearTimeout(timer);
      }
      // AbortSignal is not exposed by the SDK. Unfinished requests will no longer be copied to avoid overlapping connections due to timeouts; only unconfirmed requests will be recorded.
      if (timedOut) break;
      if (attempt < 2) await delay(500 * 3 ** attempt);
    }
    report("unconfirmed");
    return undefined;
  };
}
