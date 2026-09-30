/**
 * Observability for v4 command acks: renderer logging is off wholesale in production builds (see
 * ui/logger.ts), while e2e / on-site troubleshooting needs one place to probe. This writes a
 * summary of each command's ack into a bounded ring buffer on window (the same debugging surface as
 * __zcodeSessionStoreE2E), without heavy payloads such as message bodies.
 */
interface V4CommandAckSummary {
  type: string;
  status: string;
  reasonCode?: string;
  revisionAtDecision?: number;
  at: number;
}

const MAX_ACK_ENTRIES = 50;

type V4AckDebugWindow = Window & {
  __zcodeV4CommandAcksE2E?: V4CommandAckSummary[];
};

export function recordV4CommandAck(summary: V4CommandAckSummary): void {
  if (typeof window === "undefined") return;
  const host = window as V4AckDebugWindow;
  const buffer = (host.__zcodeV4CommandAcksE2E ??= []);
  buffer.push(summary);
  if (buffer.length > MAX_ACK_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ACK_ENTRIES);
  }
}
