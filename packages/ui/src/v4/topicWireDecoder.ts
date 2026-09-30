import {
  TopicWireFrameAssembler,
  type TopicWireAssemblyEvent,
  type TopicWireAssemblyFault,
  type TopicFrameDeliveryKind,
  type TopicWireFrameCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

interface TopicWireDecoder {
  accept(wire: TopicWireFrameCandidate): void;
  /**
   * same-sub recovery: only the fail-closed flag is cleared; the assembler ordinal tombstone is
   * kept.
   */
  recover(topic: string, subscriptionId: string): void;
  discard(topic: string, subscriptionId: string): void;
  clear(): void;
}

/**
 * The renderer-side physical → logical atomic boundary. The assembler only emits a logical frame
 * when all pieces are present and the check passes; the 30s timeout is driven by a single
 * nearest-deadline timer, so that no timer is created per piece.
 */
export function createTopicWireDecoder<F extends { topic: string; subscriptionId: string }>(
  assembler: TopicWireFrameAssembler<F>,
  deliver: (frame: F, deliveryKind: TopicFrameDeliveryKind) => void,
  onFault?: (fault: TopicWireAssemblyFault) => void,
): TopicWireDecoder {
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const faultedRoutes = new Set<string>();
  const routeKey = (topic: string, subscriptionId: string) => `${topic}\0${subscriptionId}`;

  const handleEvents = (events: TopicWireAssemblyEvent<F>[]): void => {
    const faults = events.filter((event) => event.kind === "fault");
    const failedInBatch = new Set<string>();
    const healingRoutes = new Set<string>();
    for (const event of events) {
      if (event.kind === "complete" && event.deliveryKind === "recovery") {
        healingRoutes.add(routeKey(event.frame.topic, event.frame.subscriptionId));
      }
    }
    for (const { fault } of faults) {
      const key = routeKey(fault.topic, fault.subscriptionId);
      // assembler.accept will first expire the old assembly and then process the current wire. If the current wire is
      // Higher ordinal recovery has been fully verified, the same batch of old online timeout has been authoritatively overwritten by it,
      // Do not report the fault first and then discard the recovery.
      if (healingRoutes.has(key)) continue;
      failedInBatch.add(key);
      faultedRoutes.add(key);
      assembler.abort(fault.topic, fault.subscriptionId);
      logger.warn("[v4-topic-wire] physical assembly rejected", fault);
      onFault?.(fault);
    }
    for (const event of events) {
      if (event.kind !== "complete") continue;
      const key = routeKey(event.frame.topic, event.frame.subscriptionId);
      if (event.deliveryKind === "recovery") faultedRoutes.delete(key);
      // The same accept may be [superseded fault(A), complete(A)], and the same route must be
      // fail closed; but accept(B) will also expire other route A, so healthy B cannot be lost by mistake.
      if (failedInBatch.has(key) || faultedRoutes.has(key)) continue;
      deliver(event.frame, event.deliveryKind);
    }
  };

  const scheduleExpiry = (): void => {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    const nextExpiryAt = assembler.nextExpiryAt;
    if (nextExpiryAt === null) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        handleEvents(assembler.expire(Date.now()));
        scheduleExpiry();
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
  };

  return {
    accept(wire) {
      const key = routeKey(wire.topic, wire.subscriptionId);
      if (faultedRoutes.has(key)) {
        // When resync is late, old online fragments may still fault and close the route;
        // The real recovery will then be permanently swallowed by the old gate. deliveryKind is publisher
        // Authoritative envelope facts, so only exact recovery can solve gates atomically, never guesswork by RPC timing.
        if (wire.deliveryKind !== "recovery") return;
        faultedRoutes.delete(key);
        assembler.abort(wire.topic, wire.subscriptionId);
      }
      handleEvents(assembler.accept(wire));
      scheduleExpiry();
    },
    recover(topic, subscriptionId) {
      // faultedRoutes cannot be cleaned up by unsubscribe/discard alone: otherwise same-sub
      // The higher ordinal of recovery will be permanently swallowed. Here we only solve the fail-closed door, assembler
      // The settled ordinal is retained, and the late and old fragment will still be silently discarded.
      faultedRoutes.delete(routeKey(topic, subscriptionId));
      assembler.abort(topic, subscriptionId);
      scheduleExpiry();
    },
    discard(topic, subscriptionId) {
      faultedRoutes.delete(routeKey(topic, subscriptionId));
      assembler.discard(topic, subscriptionId);
      scheduleExpiry();
    },
    clear() {
      faultedRoutes.clear();
      assembler.clear();
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
    },
  };
}
