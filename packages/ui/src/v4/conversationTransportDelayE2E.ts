import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";

interface DelayPlan {
  commandMs: number;
  ackMs: number;
  consumed?: boolean;
  ackReleased?: boolean;
}
/**
 * Fault injection on the public transport seam, E2E builds only; it only delays real commands/ACKs,
 * it never fabricates events.
 */
export async function sendWithConversationDelayE2E(
  send: () => Promise<CommandAck>,
): Promise<CommandAck> {
  const host =
    typeof window === "undefined"
      ? undefined
      : (window as Window & { __zcodeTransportDelayE2E?: DelayPlan });
  const plan = shouldExposeE2EStoreBridge() ? host?.__zcodeTransportDelayE2E : undefined;
  if (!plan || plan.consumed) return send();
  plan.consumed = true;
  const delay = (ms: number) =>
    new Promise<void>((resolve) =>
      setTimeout(resolve, Number.isFinite(ms) ? Math.min(10000, Math.max(0, ms)) : 0),
    );
  await delay(plan.commandMs);
  const ack = await send();
  await delay(plan.ackMs);
  plan.ackReleased = true;
  return ack;
}
