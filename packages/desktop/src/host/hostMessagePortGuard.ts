import { hostIncomingMessageSchema } from "@zcode/shared";

interface CloseableTransferredPort {
  close(): void;
}

interface HostIncomingMessageEventLike {
  data: unknown;
  ports: readonly CloseableTransferredPort[];
}

function closeTransferredPort(port: CloseableTransferredPort | undefined): void {
  try {
    port?.close();
  } catch {
    // Rejection cleanup is best effort; close exceptions cannot mask original schema/initialization errors.
  }
}

/** When the schema is invalid no ChannelServer will ever take over the transferred port, so it must be closed right here. */
export function parseHostIncomingMessageEvent(
  event: HostIncomingMessageEventLike,
): ReturnType<typeof hostIncomingMessageSchema.safeParse> {
  // Under clean pnpm install, zod will be located in @zcode/shared private node_modules; if the export function
  // Depending on the inferred return type, .d.ts will reference the non-portable private ZodSafeParseResult path.
  const result = hostIncomingMessageSchema.safeParse(event.data);
  if (!result.success) {
    for (const port of event.ports) closeTransferredPort(port);
  }
  return result;
}

/** Reject and close when AttachServicePort arrives before activeServices is ready, so remote RPCs never stay pending forever. */
export function rejectUnavailableAttachedServicePort(
  port: CloseableTransferredPort,
  servicesReady: boolean,
): boolean {
  if (servicesReady) return false;
  closeTransferredPort(port);
  return true;
}
