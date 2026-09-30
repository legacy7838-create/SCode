// Conversation topic publisher (transmission shell).
// CLI side authoritative runtime: memory bounded delta log (logEpoch + retention window) + subscribe(base)
// Judgment (resume/snapshot) + per-subscriber flush pipeline (filter → coalesce → frame).
//
// Boundaries of Responsibilities:
// - This class only does authoritative accounting of "event → frame" and does not do network IO/timer - the flush timing is driven by the host
//   (The host channel layer is scheduled according to profile.flushWindowMs; manually called in the test) to maintain measurable pure advancement.
// - Recovery and resume flow share the same pipeline: initial frame of resume = delta within the retention window (base.seq, current]
//   Filter through the subscriber profile and then coalesce,
//   Therefore, the golden test of "snapshot(W)+continuous streaming ≡ full replay" can directly cover the recovery path.
// - Resubscribe = Replace: Repeat subscribe with the same connectionId to invalidate the old subscription and clear it
//   flush buffer, the old subscriptionId no longer generates frames, and the client discards old intergenerational frames based on subId.
import { Buffer } from "node:buffer";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type {
  CommandEnvelope,
  ConversationDelta,
  ConversationRowTarget,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfile,
  DeliveryProfileName,
  QueueItem,
  SubscribeAck,
  TopicFrameDeliveryKind,
  ToolCallRow,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  clampWorkflowRunsForLegacy,
  coalesceConversationDeltas,
  filterConversationDeltasForProfile,
  filterConversationRowsForProfile,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import {
  encodeConversationDeltasForLegacy,
  workflowRunDeltaGrowthUpperBound,
} from "./conversation-workflow-run-deltas.js";
import {
  ProductProjection,
  type StableForkCandidateResolution,
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type SessionConfigSeed,
  type SessionSubagentsSeed,
  type SessionUsageSeed,
} from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

interface LogEntry {
  seq: number;
  deltas: ConversationDelta[];
}

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

/**
 * Cold replay will measure temporary delta at high frequency; TextEncoder will reallocate a complete Uint8Array for each measurement.
 * The CLI has been fixed to run in Node, where the exact number of UTF-8 bytes is calculated directly for the same JSON text without making an approximate estimate.
 */
function coldHydrationJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPlanMarkdown(row: ToolCallRow): boolean {
  if (isRecord(row.input)) {
    const plan = row.input.plan;
    if (typeof plan === "string" && plan.trim().length > 0) return true;
  }
  if (!row.inputText.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(row.inputText);
    return isRecord(parsed) && typeof parsed.plan === "string" && parsed.plan.trim().length > 0;
  } catch {
    return false;
  }
}

interface Subscription {
  subscriptionId: string;
  connectionId: string;
  profile: DeliveryProfile;
  /**
   * Whether this subscription recognizes `workflowRun.*` key-level increments (handshake capability bits, injected by trusted host).
   * false = old consumer: deltas are folded into integer patches and snapshots are clipped to the old bounds (conversation-workflow-run-deltas.ts).
   */
  workflowRunDeltas: boolean;
  /** Flush buffer: The profile filtering and encoding of the subscription have been passed when pushing, and the coalesce frame is used when flushing. */
  buffer: ConversationDelta[];
  bufferBytes: number;
  /** After the buffer exceeds the limit, only the recovery intention is retained and the delta is not continued to be backlogged for slow subscribers. */
  resyncRequired: boolean;
  /** Frame interval accounting water level: next frame fromSeq ((fromSeq, toSeq] semantics). */
  sentSeq: number;
  /** Stable logical frame retained during encoding/writing. */
  inFlight: TopicFrameReservation<ConversationTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

interface ConversationSubscribeParams {
  connectionId: string;
  base?: { logEpoch: string; seq: number };
  /** Default replayable (ws default; MessagePort host explicitly passes continuous). */
  deliveryProfile?: DeliveryProfileName;
  /**
   * The connection's clientHello declaration recognizes `workflowRun.*` increments. Same family as deliveryProfile: trusted host
   * Injection, UI-oriented subscribe cannot be selected. Default is false - if the capability bit is absent, the old consumer will be used.
   */
  workflowRunDeltas?: boolean;
}

interface ConversationSubscribeResult {
  ack: SubscribeAck;
  reservation: TopicFrameReservation<ConversationTopicFrame> | null;
  /** When initial encode fails and ACK is not admitted, the replaced old subscription is atomically restored. */
  rollback(): boolean;
  /** snapshot frame or resume frame; null when resume and no new frame is added (client water level is aligned). */
  readonly frame: ConversationTopicFrame | null;
}

interface ConversationResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

interface ConversationTopicPublisherOptions {
  /** CLI clock (frame.sentAt / clockOffset estimate source). */
  now?: () => number;
  /** Event retention window (bar), default PROTOCOL_V4_LIMITS.eventRetentionPerSession. */
  retention?: number;
  /** The upper limit of ops after coalesce per subscriber; mainly used for protocol configuration and boundary testing. */
  subscriberBufferMaxOps?: number;
  /** UTF-8 byte upper limit for logical deltas payload per subscriber. */
  subscriberBufferMaxBytes?: number;
}

interface ConversationSubscriberBufferLimits {
  maxOps?: number;
  maxBytes?: number;
}

export class ProjectionPayloadTooLargeError extends Error {
  readonly reasonCode = "proto.payloadTooLarge";

  constructor(readonly logicalBytes: number) {
    super(
      `conversation projection exceeds ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
    );
    this.name = "ProjectionPayloadTooLargeError";
  }
}

// The running text must leave space for the bounded terminal patch of TurnError/TurnComplete; otherwise the text
// After exactly 16MiB is occupied, the final state of stopping the turn itself cannot enter the transferable snapshot.
const PROJECTION_TERMINAL_RESERVE_BYTES = 64 * 1024;

// schema for row.actions only has 4 true booleans and a short enum; insufficient JSON key/parent wrapper
// 128 bytes. Each line of wire tail is completely reserved between batch checkpoints to ensure delayed materialize
// Will not let the payload upper bound be underestimated.
const HYDRATION_ACTION_BYTES_PER_WIRE_ROW = 128;
const HYDRATION_EVENT_WIRE_OVERHEAD_BYTES = 64;
// The sequence number in the logical snapshot frame appears in both frame.toSeq and snapshot.seq.
const HYDRATION_SEQUENCE_NUMBER_OCCURRENCES = 2;

function hydrationSequenceNumberBytes(sequenceNumber: number): number {
  return String(sequenceNumber).length * HYDRATION_SEQUENCE_NUMBER_OCCURRENCES;
}

type ConversationSubscriberBufferResult =
  | {
      kind: "buffered";
      deltas: ConversationDelta[];
      encodedBytes: number;
    }
  | { kind: "overflow" };

function nonNegativeHardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

/**
 * The delta after profile filter enters this pure function; first merge with the existing buffer and coalesce,
 * Then press op/UTF-8 bytes double limit ruling - the limit must be actually implemented, and only bare delta[] will be saved. If not,
 * Slow subscribers will continue to pile up and eventually generate uncontrollably large frames.
 */
function appendConversationSubscriberBuffer(
  current: readonly ConversationDelta[],
  incoming: readonly ConversationDelta[],
  limits: ConversationSubscriberBufferLimits = {},
): ConversationSubscriberBufferResult {
  const maxOps = nonNegativeHardBound(
    limits.maxOps,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
    "maxOps",
  );
  const maxBytes = nonNegativeHardBound(
    limits.maxBytes,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    "maxBytes",
  );
  const deltas = coalesceConversationDeltas([...current, ...incoming]);
  if (deltas.length > maxOps) return { kind: "overflow" };
  const encodedBytes = utf8JsonByteLength({ kind: "deltas", deltas });
  if (encodedBytes > maxBytes) return { kind: "overflow" };
  return { kind: "buffered", deltas, encodedBytes };
}

export class ConversationTopicPublisher {
  readonly topic: string;
  private projection: ProductProjection;
  private readonly now: () => number;
  private readonly retention: number;
  private readonly subscriberBufferMaxOps: number;
  private readonly subscriberBufferMaxBytes: number;
  /** Bounded log: seq in ascending order; resume is only valid within (floorSeq, currentSeq]. */
  private readonly log: LogEntry[] = [];
  /** The lower bound of the retention window: base.seq < floorSeq The recovery request cannot be resumed losslessly → only snapshot. */
  private floorSeq = 0;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscriptionIdByConnection = new Map<string, string>();
  private nextSubscriptionSerial = 1;
  private nextLogicalFrameSerial = 1;
  /** The conservative upper bound of the current snapshot logical frame; streaming append only accumulates increments, and is accurately serialized when it approaches the upper limit. */
  private wireSnapshotBytesUpperBound: number;

  constructor(
    private readonly sessionId: string,
    private readonly logEpoch: string,
    options: ConversationTopicPublisherOptions = {},
  ) {
    this.topic = `conversation/${sessionId}`;
    this.projection = new ProductProjection(sessionId, logEpoch);
    this.now = options.now ?? Date.now;
    this.retention = options.retention ?? PROTOCOL_V4_LIMITS.eventRetentionPerSession;
    this.subscriberBufferMaxOps = nonNegativeHardBound(
      options.subscriberBufferMaxOps,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
      "subscriberBufferMaxOps",
    );
    this.subscriberBufferMaxBytes = nonNegativeHardBound(
      options.subscriberBufferMaxBytes,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
      "subscriberBufferMaxBytes",
    );
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  getSnapshot(): ConversationSnapshot {
    return this.projection.getSnapshot();
  }

  /** Logical TopicFrame byte size common to tests/gates (not raw snapshot size). */
  getWireSnapshotLogicalBytes(): number {
    return this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    return this.projection.resolveStableForkCandidate(rowId);
  }

  /** config seed injection: directly change the initial value of the projection, no delta is generated/no event log is entered. See ProductProjection.seedConfig for semantics. */
  seedConfig(seed: SessionConfigSeed): void {
    this.projection.seedConfig(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** The shared import prompt is static read-only metadata and does not enter delta/revision; it can be reseeded idempotently after hydration. */
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    this.projection.seedSharedContextImport(source);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** Usage seed injection: Cold recovery uses the persistence token water level to overwrite the 0 placeholder synthesized by transcript. */
  seedUsage(seed: SessionUsageSeed): void {
    this.projection.seedUsage(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** Cold hydration's store-verified subagent manifest does not produce delta. */
  seedSubagents(seed: SessionSubagentsSeed): void {
    this.projection.seedSubagents(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /**
   * Snapshot for delivery: rows only with tail window (snapshotTailWindowRows),
   * totalCount/firstRowId retains the total ordering caliber - the client uses `window[0].rowId === firstRowId`
   * It is judged that it has reached the top, and the earlier history is pulled through the rows/range cursor. Projected internal snapshots remain at full volume
   * (rows/range data source + findRow/messageId anchor points all rely on it), only truncated at frame boundaries.
   */
  private getWireSnapshot(snapshot = this.projection.getSnapshot()): ConversationSnapshot {
    return this.getWireSnapshotForProfile(DELIVERY_PROFILES.continuous, snapshot);
  }

  private getWireSnapshotForProfile(
    profile: DeliveryProfile,
    snapshot = this.projection.getSnapshot(),
  ): ConversationSnapshot {
    const visibleRows = filterConversationRowsForProfile(snapshot.rows.window, profile);
    const visibleSnapshot: ConversationSnapshot = {
      ...snapshot,
      rows: {
        ...snapshot.rows,
        window: visibleRows,
        totalCount: visibleRows.length,
        firstRowId: visibleRows[0]?.rowId ?? null,
      },
    };
    const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
    if (visibleRows.length <= limit) return visibleSnapshot;
    return {
      ...visibleSnapshot,
      rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-limit) },
    };
  }

  /**
   * A subscriber's snapshot frame: the profile determines the row visibility, and the capability bit determines whether `workflowRuns` sends full volume or old bounds.
   *
   * The snapshot and the increment must be in the same file: a client that receives the old-world whole-key patch, if 512 nodes suddenly appear in the snapshot,
   * Its `.max(256)` will fail parsing for the entire frame (parsing errors on keys are known to not strip just one key).
   */
  private getWireSnapshotForSubscription(subscription: Subscription): ConversationSnapshot {
    const snapshot = this.getWireSnapshotForProfile(subscription.profile);
    if (subscription.workflowRunDeltas || snapshot.workflowRuns === undefined) return snapshot;
    const workflowRuns = clampWorkflowRunsForLegacy(snapshot.workflowRuns);
    return workflowRuns === snapshot.workflowRuns ? snapshot : { ...snapshot, workflowRuns };
  }

  /**
   * **Per-subscriber** encoding of a batch of delta: profile filtering + integer folding of old consumers.
   *
   * Folding takes the **current** projection state, so the historical increment on resume playback will be folded into the final state - the intermediate state is skipped, and the final state is the same.
   * Conforms to the existing behavior of coalesce (header of conversation-workflow-run-deltas.ts).
   */
  private encodeDeltasForSubscription(
    deltas: readonly ConversationDelta[],
    subscription: Subscription,
  ): readonly ConversationDelta[] {
    const filtered = filterConversationDeltasForProfile(deltas, subscription.profile);
    if (subscription.workflowRunDeltas) return filtered;
    return encodeConversationDeltasForLegacy(filtered, this.projection.getSnapshot().workflowRuns);
  }

  /**
   * Candidate projection for input admission: expressing the same intent as a complete QueueItem, covering text and attachment references.
   * QueueItem metadata is not smaller than the user row immediately after startup, so input through this gate will not be
   * The snapshot becomes non-transferable. This method is read-only and does not write to the admission / event log.
   */
  measureInputAdmissionProjectionBytes(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): number | null {
    const raw = envelope.payload as {
      text?: string;
      displayText?: string;
      attachments?: QueueItem["attachments"];
      firstInput?: { text: string; attachments?: QueueItem["attachments"] };
    };
    const input = envelope.type === "createSession" ? raw.firstInput : raw;
    if (
      !input ||
      (envelope.type !== "createSession" &&
        envelope.type !== "sendText" &&
        envelope.type !== "sendGoalCommand" &&
        envelope.type !== "compact")
    ) {
      return null;
    }
    const snapshot = this.projection.getSnapshot();
    const queueItem: QueueItem = {
      sourceCommandId: envelope.commandId,
      queueItemId: admission.queueItemId,
      clientId: envelope.clientId || "cli",
      kind:
        envelope.type === "compact"
          ? "compact"
          : envelope.type === "sendGoalCommand"
            ? "sendGoalCommand"
            : "sendText",
      text:
        envelope.type === "compact"
          ? "/compact"
          : envelope.type === "sendGoalCommand"
            ? raw.displayText?.trim() || `/goal ${(input.text ?? "").trim()}`
            : (input.text ?? ""),
      attachments: input.attachments ?? [],
      delivery: { requested: "queue", admitted: "queue" },
      order: {
        admissionSeq: admission.admissionSeq,
        queuePosition: snapshot.queue.items.length,
      },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: admission.admittedAt,
    };
    const candidate: ConversationSnapshot = {
      ...snapshot,
      queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
    };
    return this.measureWireSnapshotBytes(this.getWireSnapshot(candidate));
  }

  private measureWireSnapshotBytes(snapshot: ConversationSnapshot): number {
    // subscriptionId/time/seq Use the longest regular representation this publisher can produce, ensuring that the measurement is not just the payload.
    const frame: ConversationTopicFrame = {
      topic: this.topic,
      subscriptionId: `sub-${this.logEpoch}-${Number.MAX_SAFE_INTEGER}`,
      fromSeq: 0,
      toSeq: snapshot.seq,
      sentAt: Number.MAX_SAFE_INTEGER,
      payload: { kind: "snapshot", snapshot },
    };
    return utf8JsonByteLength(frame);
  }

  /**
   * rows/range (cursor system): take the last limit rows with rowId < beforeRowId
   * (rowId is returned in ascending order). data source = projected full rows (event replay/transcript hydration poured in),
   * It comes from the same reduction as the subscription flow, and is naturally "consistent with the full replay prefix byte by byte".
   * Read-only, stateless, timeout retransmission safe; atLogEpoch allows the client to discard all stale reads.
   */
  getRowsRange(
    params: { beforeRowId?: number; limit: number },
    deliveryProfile: DeliveryProfileName = "replayable",
  ): V4ConversationRowsRangeResult {
    const snapshot = this.projection.getSnapshot();
    const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
    const visibleRows = filterConversationRowsForProfile(
      snapshot.rows.window,
      DELIVERY_PROFILES[deliveryProfile],
    );
    const eligible =
      params.beforeRowId === undefined
        ? visibleRows
        : visibleRows.filter((row) => row.rowId < (params.beforeRowId as number));
    const rows = eligible.slice(-limit);
    return {
      rows,
      atSeq: snapshot.seq,
      atRevision: snapshot.revision,
      atLogEpoch: this.logEpoch,
      hasMore: eligible.length > rows.length,
    };
  }

  /**
   * Returns the complete final plan directory in the currently active branch.
   * The wire snapshot only retains the tail window; the renderer scans the visible rows and misses the early plans.
   * After edit/retry, old directory entries that have been trimmed by the authoritative projection may be retained.
   */
  getPlans(): V4ConversationPlansResult {
    const snapshot = this.projection.getSnapshot();
    const plans = snapshot.rows.window
      .filter(
        (row): row is ToolCallRow =>
          row.kind === "toolCall" &&
          row.toolName === "ExitPlanMode" &&
          TERMINAL_PLAN_STATUSES.has(row.status) &&
          hasPlanMarkdown(row),
      )
      .toSorted((left, right) => right.rowId - left.rowId);
    return {
      plans,
      atSeq: snapshot.seq,
      atLogEpoch: this.logEpoch,
    };
  }

  /** rowId → authoritative messageId (forkAssistant/editUserQuery bridge translation). */
  getMessageIdForRow(rowId: number): string | null {
    return this.projection.getMessageIdForRow(rowId);
  }

  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    return this.projection.resolveRowActionTarget(target, action);
  }

  /** rowId → all transcript messageIds in the same product turn. */
  getMessageIdsForTurnRow(rowId: number): string[] {
    return this.projection.getMessageIdsForTurnRow(rowId);
  }

  /** The fork target must be the last segment of assistantText in the corresponding round. */
  isLatestAssistantSegmentRow(rowId: number): boolean {
    return this.projection.isLatestAssistantSegmentRow(rowId);
  }

  /** latestAssistantRetryOnly: The retry target must be the latest assistantText in the entire timeline and have realUser cause. */
  isLatestRetryAssistantRow(rowId: number): boolean {
    return this.projection.isLatestRetryAssistantRow(rowId);
  }

  /** latestQueryEditOnly: Only the last round of realUser userInput row can be edited. */
  isLatestEditableUserRow(rowId: number): boolean {
    return this.projection.isLatestEditableUserRow(rowId);
  }

  /** rowId → product turnId (check user messageId when editUserQuery has no assistant anchor). */
  getTurnIdForRow(rowId: number): string | null {
    return this.projection.getTurnIdForRow(rowId);
  }

  /** Assistant Conservation: Number of rejected text stream events (>0 = projection may be missing segments). */
  getDroppedContentStreamEventCount(): number {
    return this.projection.getDroppedContentStreamEventCount();
  }

  /** rowId → its turn's rewind anchor messageId (editUserQuery user row positioning). */
  getTurnRewindAnchor(rowId: number): string | null {
    return this.projection.getTurnRewindAnchor(rowId);
  }

  private get currentSeq(): number {
    return this.projection.getSnapshot().seq;
  }

  /** Application authoritative events: projection advancement + logging + fanout to each subscriber flush buffer. */
  ingest(event: SessionEvent): void {
    const projectionLimit =
      event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
        ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
        : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
    const streamingAppend = this.projection.establishedStreamingAppend(event);
    const streamingUpperBound =
      streamingAppend === null ? null : utf8JsonByteLength(streamingAppend) + 64;
    let deltas: ConversationDelta[] | null;
    if (
      streamingUpperBound !== null &&
      this.wireSnapshotBytesUpperBound + streamingUpperBound <= projectionLimit
    ) {
      deltas = this.projection.applyEvent(event);
      this.wireSnapshotBytesUpperBound += streamingUpperBound;
    } else {
      let candidateBytes = 0;
      let nextUpperBound = 0;
      deltas = this.projection.applyEventAtomically(event, (snapshot, produced) => {
        // DWF fast path: When this event only produces key-level increments, their number of bytes is the upper bound of snapshot growth (an upsert
        // At most, add your own content, removed will only make the snapshot smaller), there is no need to serialize the entire snapshot again.
        // ——That time JSON.stringify was a MB-level overhead paid for each engine event, and it was also the other half of this transformation.
        // The criterion uses **actual output** rather than preview, so the whole key patch degraded by diff naturally falls back to the exact path.
        const growth = workflowRunDeltaGrowthUpperBound(produced);
        if (growth !== null && this.wireSnapshotBytesUpperBound + growth <= projectionLimit) {
          nextUpperBound = this.wireSnapshotBytesUpperBound + growth;
          return true;
        }
        candidateBytes = this.measureWireSnapshotBytes(this.getWireSnapshot(snapshot));
        nextUpperBound = candidateBytes;
        return candidateBytes <= projectionLimit;
      });
      if (deltas === null) throw new ProjectionPayloadTooLargeError(candidateBytes);
      this.wireSnapshotBytesUpperBound = nextUpperBound;
    }
    this.log.push({ seq: event.sequenceNumber, deltas });
    while (this.log.length > this.retention) {
      const evicted = this.log.shift();
      if (evicted) this.floorSeq = evicted.seq;
    }
    if (deltas.length === 0) return;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.resyncRequired) continue;
      const filtered = this.encodeDeltasForSubscription(deltas, subscription);
      const next = appendConversationSubscriberBuffer(subscription.buffer, filtered, {
        maxOps: this.subscriberBufferMaxOps,
        maxBytes: this.subscriberBufferMaxBytes,
      });
      if (next.kind === "overflow") {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
        continue;
      }
      subscription.buffer = next.deltas;
      subscription.bufferBytes = next.encodedBytes;
    }
  }

  /**
   * Rematerialize the projection within the existing publisher, retaining connection-owned subscriptions.
   *
   * Gateway created a new instance after deleting publisher. Although projection was restored, the old instance
   * The subscription registry / ownership / in-flight reservation is lost together. Heavy materialization belongs to
   * The status replacement of the same topic authority should only resync the existing subscription and should not change the publisher identity.
   */
  rehydrate(
    events: readonly SessionEvent[],
    options: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void } = {},
  ): void {
    // Replay cannot clear the current projection/log/subscription delivery first, and then replay one by one:
    // Any ordinary reducer exception will leave the topic in a semi-replay state. The candidate publisher does not accept subscriptions,
    // Adopt the authoritative data plane only once after a complete replay (including logical size verification) is successful.
    let candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
      now: this.now,
      retention: this.retention,
      subscriberBufferMaxOps: this.subscriberBufferMaxOps,
      subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
    });
    const usedBatchHydration = candidate.tryBatchHydration(events);
    if (!usedBatchHydration) {
      // Exceeding the conservative upper bound does not mean that the authoritative projection must exceed the limit; re-select the original event atoms from the empty candidate
      // admission, retaining the old semantics of 16MiB fail-closed and "continue final state after rejecting a single oversize".
      candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
        now: this.now,
        retention: this.retention,
        subscriberBufferMaxOps: this.subscriberBufferMaxOps,
        subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
      });
      for (const event of events) {
        try {
          candidate.ingest(event);
        } catch (error) {
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          if (!options.onPayloadTooLarge) throw error;
          options.onPayloadTooLarge(error);
        }
      }
    }

    this.projection = candidate.projection;
    if (usedBatchHydration) {
      // Batch replay will delay derived actions until final materialization; if the client is allowed
      // This log is continued with the intermediate base of the old snapshot event-by-event. Old canEdit/canRetry that the batch never held cannot be
      // Fixed point cancellation. rehydrate inherently requires all existing subscriptions to resync, so create a snapshot in the current seq
      // recovery boundary; thereafter, new events will still resume normally from this water level, without changing the replayable recovery semantics.
      this.log.splice(0, this.log.length);
      this.floorSeq = candidate.currentSeq;
    } else {
      // Strict fallback does not delay materialization and completely retains the original retained-log recovery semantics.
      this.log.splice(0, this.log.length, ...candidate.log);
      this.floorSeq = candidate.floorSeq;
    }
    this.wireSnapshotBytesUpperBound = candidate.wireSnapshotBytesUpperBound;
    for (const subscription of this.subscriptions.values()) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      subscription.sentSeq = 0;
      // Frames reserved on the old projection after adopt can no longer be committed; failed replay never touches the reservation.
      subscription.inFlight = null;
    }
  }

  /**
   * Cold recovery fast path: only modify candidates that have not yet been released. The protocol wire snapshot is fixed to only contain the last 60 lines.
   * Therefore, the row update only accumulates the delta still in tail, and then reserves rows for actions that have not yet been materialized.
   * Full schema upper bound; conservative growth that has slipped out of the tail is eliminated by precise measurement when the payload limit is hit.
   * In the end, only one action for the entire row converges, and the overall cost increases linearly with the number of events/rows.
   */
  private tryBatchHydration(events: readonly SessionEvent[]): boolean {
    this.projection.beginHydrationReplay();
    let measuredBytes = this.wireSnapshotBytesUpperBound;
    let measuredSequenceNumberBytes = hydrationSequenceNumberBytes(
      this.projection.getSnapshot().seq,
    );
    let encodedGrowthSinceMeasurement = 0;

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const deltas = this.projection.applyHydrationEvent(event);
      const finalEvent = index === events.length - 1;
      const projectionLimit = this.projectionLimitForEvent(event);
      const mustMeasureSnapshot = finalEvent || deltas.some((delta) => delta.op === "row.removed");

      if (finalEvent) this.projection.completeHydrationReplay();
      const snapshot = this.projection.getSnapshot();
      if (!mustMeasureSnapshot && deltas.length > 0) {
        let wireRowIds: Set<number> | undefined;
        const wireDeltas = deltas.filter((delta) => {
          if (delta.op === "state.updated" || delta.op === "row.appended") return true;
          if (delta.op === "row.removed") return false;
          // The key-level increment acts on the status key, not in the 60-line wire tail - there is no such thing as "it has slid out of the window, so it is not counted".
          // Same as state.updated.
          if (delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed") return true;
          wireRowIds ??= new Set(
            snapshot.rows.window
              .slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
              .map((row) => row.rowId),
          );
          const rowId = delta.op === "row.upserted" ? delta.row.rowId : delta.rowId;
          return wireRowIds.has(rowId);
        });
        if (wireDeltas.length > 0) {
          encodedGrowthSinceMeasurement +=
            coldHydrationJsonByteLength({ kind: "deltas", deltas: wireDeltas }) +
            HYDRATION_EVENT_WIRE_OVERHEAD_BYTES;
        }
      }

      const actionBytesUpperBound = finalEvent
        ? 0
        : Math.min(snapshot.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows) *
          HYDRATION_ACTION_BYTES_PER_WIRE_ROW;
      const currentSequenceNumberBytes = hydrationSequenceNumberBytes(snapshot.seq);
      const sequenceNumberGrowth = Math.max(
        0,
        currentSequenceNumberBytes - measuredSequenceNumberBytes,
      );
      let upperBound =
        measuredBytes +
        encodedGrowthSinceMeasurement +
        sequenceNumberGrowth +
        actionBytesUpperBound;
      if (mustMeasureSnapshot || upperBound > projectionLimit) {
        // If the conservative delta cumulative value exceeds the limit, it will directly fall back to strict. Repeat the upsert.
        // Even if the snapshot is not increased, it will be rolled back by mistake; fixed 32-event retest will also serialize the checkpoint repeatedly.
        measuredBytes = this.measureWireSnapshotBytes(this.getWireSnapshot());
        measuredSequenceNumberBytes = currentSequenceNumberBytes;
        encodedGrowthSinceMeasurement = 0;
        upperBound = measuredBytes + actionBytesUpperBound;
      }
      if (upperBound > projectionLimit) return false;
    }

    if (events.length === 0) {
      this.projection.completeHydrationReplay();
      measuredBytes = this.measureWireSnapshotBytes(this.getWireSnapshot());
    }
    this.wireSnapshotBytesUpperBound = measuredBytes;
    return true;
  }

  private projectionLimitForEvent(event: SessionEvent): number {
    return event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
      ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
  }

  /**
   * Subscription ruling: base.logEpoch matches and base.seq is within the retention window → resume,
   * Otherwise snapshot. Same connectionId resubscription = replace the old subscription and clear its flush buffer.
   */
  subscribe(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const result = this.subscribeReserved(params);
    result.reservation?.commit();
    return result;
  }

  /** Production gateway entry: The initial frame must also wait until the physical batch is fully accepted before committing. */
  subscribeReserved(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const previousId = this.subscriptionIdByConnection.get(params.connectionId);
    const previousSubscription =
      previousId === undefined ? undefined : this.subscriptions.get(previousId);
    if (previousId !== undefined) this.subscriptions.delete(previousId);

    const profile = DELIVERY_PROFILES[params.deliveryProfile ?? "replayable"];
    const subscription: Subscription = {
      subscriptionId: `sub-${this.logEpoch}-${this.nextSubscriptionSerial++}`,
      connectionId: params.connectionId,
      profile,
      workflowRunDeltas: params.workflowRunDeltas === true,
      buffer: [],
      bufferBytes: 0,
      resyncRequired: false,
      sentSeq: 0,
      inFlight: null,
      nextLogicalFrameOrdinal: 1,
    };
    this.subscriptions.set(subscription.subscriptionId, subscription);
    this.subscriptionIdByConnection.set(params.connectionId, subscription.subscriptionId);
    const rollback = (): boolean => {
      // After the initial reservation commit, replacement has been admitted, and late rollback is prohibited.
      if (
        subscription.inFlight === null ||
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        this.subscriptionIdByConnection.get(params.connectionId) !== subscription.subscriptionId
      ) {
        return false;
      }
      this.subscriptions.delete(subscription.subscriptionId);
      if (previousId !== undefined && previousSubscription) {
        this.subscriptions.set(previousId, previousSubscription);
        this.subscriptionIdByConnection.set(params.connectionId, previousId);
      } else {
        this.subscriptionIdByConnection.delete(params.connectionId);
      }
      return true;
    };

    const base = params.base;
    const resumable =
      base !== undefined &&
      base.logEpoch === this.logEpoch &&
      base.seq >= this.floorSeq &&
      base.seq <= this.currentSeq;

    if (!resumable) {
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        false,
        "initial",
      );
      return this.subscribeResult(this.ackFor(subscription, "snapshot"), reservation, rollback);
    }

    // resume: Replay within the retention window (base.seq, current], the same filter→encoding→coalesce pipeline as the online resume.
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(
        this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
        subscription,
      ),
    );
    if (base.seq === this.currentSeq) {
      subscription.sentSeq = base.seq;
      return this.subscribeResult(this.ackFor(subscription, "resume"), null, () => false);
    }
    subscription.sentSeq = base.seq;
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.currentSeq,
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "initial",
    );
    return this.subscribeResult(this.ackFor(subscription, "resume"), reservation, rollback);
  }

  unsubscribe(subscriptionId: string, connectionId?: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (connectionId !== undefined && subscription.connectionId !== connectionId) {
      return;
    }
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
      this.subscriptionIdByConnection.delete(subscription.connectionId);
    }
  }

  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return Boolean(
      subscription && (connectionId === undefined || subscription.connectionId === connectionId),
    );
  }

  /** Resident recycling judgment: The session cannot be deactivated while there are still any subscribers. */
  hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
  }

  /**
   * Empty a subscriber's flush buffer into one frame (the host is driven by flushWindowMs).
   * If there is no new content, return null; the frame interval (sentSeq, currentSeq] overwrites the seq that was filtered out in the middle,
   * Ensure that the client's continuity determination of `frame.fromSeq === store.seq` is not affected by profile filtering.
   */
  reserveFlush(subscriptionId: string): TopicFrameReservation<ConversationTopicFrame> | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    if (subscription.inFlight) return subscription.inFlight;
    if (subscription.resyncRequired) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      return this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        true,
        "online",
      );
    }
    if (subscription.buffer.length === 0 && subscription.sentSeq === this.currentSeq) {
      return null;
    }
    const deltas = subscription.buffer;
    const frame: ConversationTopicFrame = {
      ...this.frameShell(subscription),
      fromSeq: subscription.sentSeq,
      toSeq: this.currentSeq,
      payload: { kind: "deltas", deltas },
    };
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    return this.reserveFrame(subscription, frame, false, "online");
  }

  /** Old single test convenience; the production gateway must be reserved and then committed only after emit-all succeeds. */
  flush(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.reserveFlush(subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * Active subscription same-sub recovery: client base is the only recovery starting point, and sentSeq cannot be used
   * Guess where the client has been applied. The new recovery admission will invalidate the old reservation; late commit
   * Returns false because the inFlight identity no longer matches.
   */
  resyncReserved(
    subscriptionId: string,
    request: ConversationResyncRequest,
  ): ConversationSubscribeResult | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;

    const previous = {
      buffer: subscription.buffer,
      bufferBytes: subscription.bufferBytes,
      resyncRequired: subscription.resyncRequired,
      sentSeq: subscription.sentSeq,
      inFlight: subscription.inFlight,
    };

    // The old resync will first commit the current reservation, and then send a snapshot based on the server sentSeq.
    // This will mistakenly mark frames not received by the client as delivered. Same-sub recovery must be superseded directly.
    subscription.inFlight = null;
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    subscription.resyncRequired = false;

    const base = request.base;
    const resumable =
      !request.forceSnapshot &&
      base !== null &&
      base.logEpoch === this.logEpoch &&
      base.seq >= this.floorSeq &&
      base.seq <= this.currentSeq;

    if (!resumable) {
      subscription.sentSeq = 0;
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        false,
        "recovery",
      );
      return this.subscribeResult(
        this.ackFor(subscription, "snapshot"),
        reservation,
        this.resyncRollback(subscription, reservation, previous),
      );
    }

    subscription.sentSeq = base.seq;
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(
        this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
        subscription,
      ),
    );
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.currentSeq,
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "recovery",
    );
    return this.subscribeResult(
      this.ackFor(subscription, "resume"),
      reservation,
      this.resyncRollback(subscription, reservation, previous),
    );
  }

  private resyncRollback(
    subscription: Subscription,
    reservation: TopicFrameReservation<ConversationTopicFrame>,
    previous: Pick<
      Subscription,
      "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
    >,
  ): () => boolean {
    let rolledBack = false;
    return (): boolean => {
      if (rolledBack) return true;
      if (
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      const recoveryBuffer = subscription.buffer;
      const recoveryResyncRequired = subscription.resyncRequired;
      const merged = appendConversationSubscriberBuffer(previous.buffer, recoveryBuffer, {
        maxOps: this.subscriberBufferMaxOps,
        maxBytes: this.subscriberBufferMaxBytes,
      });
      if (merged.kind === "overflow" || previous.resyncRequired || recoveryResyncRequired) {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
      } else {
        subscription.buffer = merged.deltas;
        subscription.bufferBytes = merged.encodedBytes;
        subscription.resyncRequired = false;
      }
      subscription.sentSeq = previous.sentSeq;
      subscription.inFlight = previous.inFlight;
      rolledBack = true;
      return true;
    };
  }

  /** Overflow degradation: clear buffer, send back snapshot frame and realign. */
  resync(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.resyncReserved(subscriptionId, {
      base: null,
      forceSnapshot: true,
    })?.reservation;
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  private reserveFrame(
    subscription: Subscription,
    frame: ConversationTopicFrame,
    snapshotRecovery: boolean,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<ConversationTopicFrame> {
    let committed = false;
    const reservation: TopicFrameReservation<ConversationTopicFrame> = {
      deliveryKind,
      logicalFrameId: `${subscription.subscriptionId}-lf-${this.nextLogicalFrameSerial++}`,
      logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
      frame,
      commit: () => {
        if (committed) return true;
        if (
          this.subscriptions.get(subscription.subscriptionId) !== subscription ||
          subscription.inFlight !== reservation
        ) {
          return false;
        }
        subscription.sentSeq = frame.toSeq;
        subscription.inFlight = null;
        if (snapshotRecovery) {
          // resyncRequired will stop collecting delta when the snapshot is in progress.
          // If the authority water level increases again, the latest snapshot must be sent for the next reservation.
          subscription.resyncRequired = this.currentSeq > frame.toSeq;
        }
        committed = true;
        return true;
      },
    };
    subscription.inFlight = reservation;
    return reservation;
  }

  private subscribeResult(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<ConversationTopicFrame> | null,
    rollback: () => boolean,
  ): ConversationSubscribeResult {
    return {
      ack,
      reservation,
      rollback,
      // Compatible with old publisher unit test: reading frame means that the local transport has been accepted.
      // The production gateway is a read-only reservation and does not trigger this getter.
      get frame() {
        reservation?.commit();
        return reservation?.frame ?? null;
      },
    };
  }

  private ackFor(subscription: Subscription, mode: SubscribeAck["mode"]): SubscribeAck {
    return {
      subscriptionId: subscription.subscriptionId,
      mode,
      logEpoch: this.logEpoch,
    };
  }

  private frameShell(
    subscription: Subscription,
  ): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt"> {
    return {
      topic: this.topic,
      subscriptionId: subscription.subscriptionId,
      sentAt: this.now(),
    };
  }
}
