import type { HostApiNetworkTransport } from "@zcode/services/node";
import { runHostShutdownPhases } from "./hostShutdownPhases.js";

const DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS = 3_500;

export async function initializeHostApiNetworkTransportOwner<T>(params: {
  transport: Pick<HostApiNetworkTransport, "disposeAndWait">;
  establishOwner: () => T;
  disposeTimeoutMs?: number;
  log: (message: string, details: Record<string, unknown>) => void;
}): Promise<T> {
  try {
    return await params.establishOwner();
  } catch (initializationError) {
    // The transport will be used by the preheating request before the ServiceCollection takes over; when an error occurs during initialization,
    // The global activeServices has not been assigned a value and process-level cleanup cannot find it. Here we hold temporary ownership from the point of creation and use
    // deadline avoids dispatcher closing fatal closures that get stuck on original initialization errors.
    await runHostShutdownPhases(
      [
        {
          name: "unowned-host-api-network-transport-dispose",
          run: async () => {
            await params.transport.disposeAndWait();
          },
          timeoutMs: params.disposeTimeoutMs ?? DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS,
        },
      ],
      {
        phaseTimeoutMs: DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS,
        log: params.log,
      },
    );
    throw initializationError;
  }
}
