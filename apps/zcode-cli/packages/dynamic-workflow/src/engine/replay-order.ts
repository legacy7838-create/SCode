/**
 * The **settlement order gate** of replay.
 *
 * A site number is a counter taken when the call arrives, so every journal call a branch makes **after**
 * an await is numbered by the order in which the fan-out completed, not by the order in which the
 * script issued it. That order is wall-clock, and nothing in the node rows can reproduce it: releasing
 * cached settlements in admission order lets the replayed `Promise.all` run the continuations in
 * array order, so the first `report` after a join gets the number the journal handed to "the branch
 * that finished first", and the run dies inside its own defensive check (`InputHashMismatch`) — even
 * though the script itself is deterministic, it can still fail because the replay completed in a
 * different order.
 *
 * So resume replays the **scheduling**, not just the answers: this gate holds the settlement order of
 * the first run, and a cache-hit settlement is suspended at the release point until every one ahead of
 * it has been released. Instances outside the order table pass straight through — the gate only
 * constrains the ones it has evidence for, so it degrades to the previous behavior for old journals
 * (events predating this rule) and can never lock up a run it knows nothing about.
 */

import { isArtifactPresetOp } from "../facade/registry.js";
import type { InstanceRef, JournalStorePort, NodeRecord, RunEvent } from "./types.js";
import { refToString } from "./types.js";

export class ReplaySettleOrder {
  /** Instance key → its position in the first-run settlement order. */
  private readonly position: ReadonlyMap<string, number>;
  /** How far the release has progressed (the cursor of the order table). */
  private cursor = 0;
  /** A release action that has arrived and is waiting for its turn. */
  private readonly parked = new Map<string, () => void>();
  /** A release action whose turn has come, queued in a microtask waiting to be delivered (FIFO, see {@link enqueue}). */
  private queue: Array<() => void> = [];
  private flushing = false;
  /** The gate opens permanently once the run has settled (see {@link open}). */
  private opened = false;

  constructor(private readonly order: readonly string[] = []) {
    const position = new Map<string, number>();
    order.forEach((key, index) => position.set(key, index));
    this.position = position;
  }

  static empty(): ReplaySettleOrder {
    return new ReplaySettleOrder([]);
  }

  /** The settlement order of the first run (used for diagnostics). */
  recorded(): readonly string[] {
    return this.order;
  }

  /**
   * Releases one replay hit under the order constraint. It executes immediately when the instance is
   * not in the table (a brand-new call, an old journal), when the gate is already open, or when its
   * turn has already been passed; otherwise it is suspended until its turn comes.
   */
  hold(instance: InstanceRef, release: () => void): void {
    const key = refToString(instance);
    const at = this.position.get(key);
    if (this.opened || at === undefined || at < this.cursor) {
      release();
      return;
    }
    this.parked.set(key, release);
    this.pump();
  }

  /**
   * Delivery is always later than **the call that produced this promise**: the release action enters
   * the queue first and only executes one microtask later.
   *
   * Without this hop the order would be inverted: in a `Promise.all` every branch issues its own call
   * within the same synchronous slice, so the release of the queue head would happen synchronously
   * **inside its own `ask()`** — at that moment its `await` has not been attached yet, so its
   * continuation ends up behind the one that "attached earlier and was just fulfilled by this pump".
   * The microtask hop lets every `await` settle first, which makes the delivery order the release
   * order. This is not a clock: the hop is one deterministic step and the queue is FIFO.
   */
  private enqueue(release: () => void): void {
    this.queue.push(release);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => this.flush());
  }

  /** Executes the queued deliveries to completion in FIFO order (an empty queue is a no-op, so repeated calls are safe). */
  private flush(): void {
    this.flushing = false;
    const batch = this.queue;
    this.queue = [];
    for (const release of batch) release();
  }

  /**
   * Run settlement: the gate opens permanently and the suspended ones are released in the recorded
   * order.
   *
   * Not releasing them means the promise on the script side is never fulfilled — in the harness the
   * sandbox is shut down right away, but in an assembly that runs scripts in the same process (such as
   * `EvalWorkflowSnippet`) that is a hang. Releasing after settlement is safe:
   * the engine has already markSettled and every host path starts with `isRunSettled()`.
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    // Those that have been queued will be released in order first: the settlement path calls this method before `run-settled` ****, and the batch will be released simultaneously.
    // The hit event therefore does not fall behind the final state event. At this moment, the await of each pending item has already been stabilized, and there is no need to jump again.
    this.flush();
    for (let i = this.cursor; i < this.order.length; i++) {
      const key = this.order[i];
      if (key === undefined) continue;
      const release = this.parked.get(key);
      if (release === undefined) continue;
      this.parked.delete(key);
      release();
    }
    this.cursor = this.order.length;
    // Keys outside the sequence table are never parked, and this round is theoretically empty; all are cleared, and no unfulfilled promises are left.
    const leftovers = [...this.parked.values()];
    this.parked.clear();
    for (const release of leftovers) release();
  }

  /** The cursor advances as far as it can: once the queue head has arrived it is released, and the next position is examined. */
  private pump(): void {
    while (this.cursor < this.order.length) {
      const key = this.order[this.cursor];
      if (key === undefined) break;
      const release = this.parked.get(key);
      if (release === undefined) break;
      this.parked.delete(key);
      this.cursor++;
      this.enqueue(release);
    }
  }
}

/**
 * Recovers the first-run settlement order from the run's own event log.
 *
 * The source of truth is the events rather than a new column: the settlement order is **already**
 * recorded entry by entry in `dwf_event`, and it is persisted in the same write as the journal row;
 * reading it back needs no migration and immediately makes the journals produced before this rule
 * resumable (in the local database, 54 of the 258 runs are stuck in exactly this shape).
 * `recoverImportClosure` has already taken the same road (recovering the closure decision from the
 * event order with zero schema change).
 *
 * Only the **first** settlement of each instance is taken: a replayed life re-emits the cached
 * events in the order this gate releases them, and taking the first one is therefore stable across
 * lives, so the third life still recovers the same table.
 *
 * The table keeps only the terminal rows that "will fulfill a promise when replayed": `report` is
 * void and a preset artifact declaration is synchronous, so neither will ever come to claim, and
 * leaving them in the table would block the cursor; rows still `running` are treated as a fresh
 * live execution and are not claimed either.
 */
export function recoverSettleOrder(
  journal: JournalStorePort,
  runId: string,
  /** The already-read node rows (the engine's resume branch has to read them anyway, so passing them in saves a second full-table read). */
  nodes: readonly NodeRecord[] = journal.listNodes(runId),
): ReplaySettleOrder {
  const claimable = new Set<string>();
  for (const node of nodes) {
    if (node.status !== "completed" && node.status !== "failed") continue;
    if (!claimsOnReplay(node)) continue;
    claimable.add(refToString(node));
  }
  if (claimable.size === 0) return ReplaySettleOrder.empty();

  const order: string[] = [];
  const seen = new Set<string>();
  for (const { event } of journal.listEvents(runId)) {
    const key = settledInstanceKey(event);
    if (key === undefined || seen.has(key) || !claimable.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return new ReplaySettleOrder(order);
}

/** Settlement event → the instance key it settled; undefined when it is not a settlement event. */
function settledInstanceKey(event: RunEvent): string | undefined {
  if (
    event.type === "node-settled" ||
    event.type === "artifact-published" ||
    event.type === "artifact-failed"
  ) {
    return refToString(event.instance);
  }
  return undefined;
}

/**
 * Whether this row will fulfill a promise the script can await during replay.
 * ask / world nodes will; `report` will not (void); artifact rows depend on their member family — a
 * content member is an effect (async) and a preset declaration is synchronous, and only the former
 * comes to claim the gate. A failed artifact row can only come from a content member (a declaration
 * has no rejection path).
 */
function claimsOnReplay(node: NodeRecord): boolean {
  if (node.kind === "report") return false;
  if (node.kind !== "artifact") return true;
  if (node.status === "failed") return true;
  const kind = (node.result as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && !isArtifactPresetOp(kind);
}

/**
 * Fulfills one replay hit under the order gate: `settle` only executes when its turn comes, and the
 * promise is fulfilled / rejected according to its result.
 * What is handed in is a promise path (world nodes and content artifacts); the release of an ask is a
 * callback to begin with, so use {@link ReplaySettleOrder.hold} directly.
 */
export function heldResolution<T>(
  hold: (instance: InstanceRef, release: () => void) => void,
  instance: InstanceRef,
  settle: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    hold(instance, () => {
      try {
        resolve(settle());
      } catch (cause) {
        reject(cause);
      }
    });
  });
}
