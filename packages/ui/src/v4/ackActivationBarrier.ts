// subscribe ACK activation barrier: notification may arrive at renderer before RPC response.
// The transport first stores it temporarily by topic bounding, and the store writes the ACK subscriptionId and then activates it explicitly;
// Only physical wires are temporarily stored here; logical assembly is executed after ownership is activated.
interface PendingFrameSubscription<T> {
  topic: string;
  subscriptionId: string | null;
  frames: T[];
  stagedBytes: number;
  overflowReason: string | null;
}

const MAX_STAGED_FRAMES = 1024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
const STAGING_OVERFLOW_REASON = "fault.subscription.initialFrameStagingOverflow";

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

interface AckActivationBarrier<T extends { topic: string; subscriptionId: string }> {
  begin(topic: string): object;
  bind(token: object, subscriptionId: string): void;
  cancel(token: object): void;
  activate(
    subscriptionId: string,
  ): { topic: string; previousSubscriptionId: string | null } | undefined;
  forget(subscriptionId: string): void;
  accept(frame: T): void;
  /** runtime/attachment generation invalidation: drops all active/pending ownership. */
  clear(): void;
}

/**
 * A transport-local physical-wire barrier; concurrent pendings on the same topic each wait for the
 * ACK to decide the owner.
 */
export function createAckActivationBarrier<T extends { topic: string; subscriptionId: string }>(
  deliver: (frame: T) => void,
): AckActivationBarrier<T> {
  const pendingByTopic = new Map<string, Set<PendingFrameSubscription<T>>>();
  const pendingBySubscriptionId = new Map<string, PendingFrameSubscription<T>>();
  const activeByTopic = new Map<string, string>();
  const topicByActiveSubscription = new Map<string, string>();

  const removePending = (pending: PendingFrameSubscription<T>): void => {
    const group = pendingByTopic.get(pending.topic);
    group?.delete(pending);
    if (group?.size === 0) pendingByTopic.delete(pending.topic);
    if (pending.subscriptionId) {
      pendingBySubscriptionId.delete(pending.subscriptionId);
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  return {
    begin(topic) {
      const pending: PendingFrameSubscription<T> = {
        topic,
        subscriptionId: null,
        frames: [],
        stagedBytes: 0,
        overflowReason: null,
      };
      const group = pendingByTopic.get(topic) ?? new Set();
      group.add(pending);
      pendingByTopic.set(topic, group);
      return pending;
    },
    bind(token, subscriptionId) {
      const pending = token as PendingFrameSubscription<T>;
      if (pending.overflowReason) {
        const reason = pending.overflowReason;
        removePending(pending);
        throw new Error(reason);
      }
      pending.subscriptionId = subscriptionId;
      pendingBySubscriptionId.set(subscriptionId, pending);
    },
    cancel(token) {
      removePending(token as PendingFrameSubscription<T>);
    },
    activate(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (!pending) return;
      const previous = activeByTopic.get(pending.topic);
      if (previous && previous !== subscriptionId) {
        topicByActiveSubscription.delete(previous);
      }
      activeByTopic.set(pending.topic, subscriptionId);
      topicByActiveSubscription.set(subscriptionId, pending.topic);
      const frames = pending.frames.filter((frame) => frame.subscriptionId === subscriptionId);
      removePending(pending);
      for (const frame of frames) deliver(frame);
      return {
        topic: pending.topic,
        previousSubscriptionId: previous ?? null,
      };
    },
    forget(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (pending) removePending(pending);
      const topic = topicByActiveSubscription.get(subscriptionId);
      if (topic && activeByTopic.get(topic) === subscriptionId) {
        activeByTopic.delete(topic);
      }
      topicByActiveSubscription.delete(subscriptionId);
    },
    accept(frame) {
      if (activeByTopic.get(frame.topic) === frame.subscriptionId) {
        deliver(frame);
        return;
      }
      const group = pendingByTopic.get(frame.topic);
      if (!group) return;
      const bytes = encodedBytes(frame);
      for (const pending of group) {
        if (pending.overflowReason) continue;
        if (
          bytes > MAX_STAGED_BYTES ||
          pending.frames.length + 1 > MAX_STAGED_FRAMES ||
          pending.stagedBytes + bytes > MAX_STAGED_BYTES
        ) {
          // "Maintaining the cap" by shifting the head leaves a seemingly activatable,
          // The actual physical batch with missing slices. If the boundary is exceeded, the entire batch must be cleared and subscribe must fail explicitly.
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = STAGING_OVERFLOW_REASON;
          continue;
        }
        pending.frames.push(frame);
        pending.stagedBytes += bytes;
      }
    },
    clear() {
      for (const group of pendingByTopic.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
        }
      }
      pendingByTopic.clear();
      pendingBySubscriptionId.clear();
      activeByTopic.clear();
      topicByActiveSubscription.clear();
    },
  };
}
