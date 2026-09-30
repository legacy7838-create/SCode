import type {
  IWindowControllerService,
  WindowHostControllerFrame,
  WindowHostControllerTaskListResult,
  ZCodeTaskListQuery,
} from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  isWindowHostControllerFrameGap,
  matchesTaskListMembershipKind,
  type WindowHostControllerCursor,
  type WindowHostControllerTaskFrame,
  type WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

interface WindowControllerTaskListRegistry {
  subscribe(listener: () => void): () => void;
  getRevision(): number;
  list(
    queryKey: string,
    version: WindowControllerTaskListVersion,
    query: ZCodeTaskListQuery,
  ): Promise<WindowHostControllerTaskListResult>;
}

export interface WindowControllerTaskListVersion {
  controllerRevision: number;
  taskListVersionSignature: string;
  /**
   * Only used to invalidate the pre-connection cache when the remote session rotates; it takes no
   * part in workspace identity.
   */
  workspaceSourceGenerationSignature?: string;
  manualRefreshSerial?: number;
}

const registries = new WeakMap<object, WindowControllerTaskListRegistry>();

function taskAddressKey(address: WindowHostControllerTaskRow["address"]): string {
  return JSON.stringify([
    address.remoteSessionId ?? "local",
    address.workspaceIdentity?.trim() || address.workspacePath,
    address.taskId,
  ]);
}

function queryContainsWorkspace(
  query: ZCodeTaskListQuery,
  address: WindowHostControllerTaskRow["address"],
): boolean {
  const workspaceKey = address.workspaceIdentity?.trim() || address.workspacePath;
  return query.workspaceScopes.some(
    (scope) => (scope.workspaceIdentity?.trim() || scope.workspacePath) === workspaceKey,
  );
}

function cacheVersionKey(version: WindowControllerTaskListVersion): string {
  // The Controller frame is only responsible for triggering hook rereading; whether the specific query fails is determined by delta scope/membership.
  // If you put the global controllerRevision into the cache key, a timeline live delta will still make pinned/archived
  // All misses, remaking each frame multiple rounds of Host RPC. The legacy/manual version continues to retain forced refresh semantics.
  return JSON.stringify({
    taskListVersionSignature: version.taskListVersionSignature,
    workspaceSourceGenerationSignature: version.workspaceSourceGenerationSignature,
    manualRefreshSerial: version.manualRefreshSerial,
  });
}

/** One Controller proxy maps to one shared observer; every list hook only consumes its revision. */
export function getWindowControllerTaskListRegistry(
  controller: IWindowControllerService,
): WindowControllerTaskListRegistry {
  const key = controller as object;
  const existing = registries.get(key);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  const cursors = new Map<string, WindowHostControllerCursor>();
  const subscriptionIds = new Set<string>();
  const queryCache = new Map<
    string,
    {
      versionKey: string;
      promise: Promise<WindowHostControllerTaskListResult>;
      query: ZCodeTaskListQuery;
    }
  >();
  const taskRows = new Map<string, WindowHostControllerTaskRow>();
  let revision = 0;
  let started = false;
  let generation = 0;
  let notificationScheduled = false;
  let frameDisposable: { dispose(): void } | null = null;

  const notifyOnce = (): void => {
    if (notificationScheduled) return;
    notificationScheduled = true;
    queueMicrotask(() => {
      notificationScheduled = false;
      if (!started) return;
      revision += 1;
      for (const listener of listeners) listener();
    });
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    generation += 1;
    frameDisposable?.dispose();
    frameDisposable = null;
    cursors.clear();
    queryCache.clear();
    taskRows.clear();
    const ids = Array.from(subscriptionIds);
    subscriptionIds.clear();
    for (const subscriptionId of ids) {
      void controller.unsubscribeControllerV4({ subscriptionId }).catch(() => {});
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    const startGeneration = ++generation;
    frameDisposable = controller.onDynamicControllerFrame()((frame: WindowHostControllerFrame) => {
      if (!started || generation !== startGeneration) return;
      const cursor = cursors.get(frame.subscriptionId);
      if (
        cursor &&
        frame.payload.kind !== "snapshot" &&
        isWindowHostControllerFrameGap(cursor, frame)
      ) {
        void controller
          .resyncControllerV4({
            subscriptionId: frame.subscriptionId,
            base: { logEpoch: cursor.logEpoch, seq: cursor.seq },
            forceSnapshot: true,
          })
          .catch((error) =>
            logger.warn("[windowControllerTaskListRegistry] Controller gap resync failed", error),
          );
        return;
      }
      cursors.set(frame.subscriptionId, {
        subscriptionId: frame.subscriptionId,
        logEpoch: frame.logEpoch,
        seq: frame.toSeq,
      });
      if (frame.topic === CONTROLLER_WORKSPACES_TOPIC) {
        // Workspace facts do not appear in the task list result; when the source is offline/removed, another tasks-index delta will be issued.
        return;
      }
      const taskFrame = frame as WindowHostControllerTaskFrame;
      if (taskFrame.payload.kind === "snapshot") {
        taskRows.clear();
        for (const row of taskFrame.payload.snapshot.tasks) {
          taskRows.set(taskAddressKey(row.address), row);
        }
        queryCache.clear();
      } else {
        for (const delta of taskFrame.payload.deltas) {
          const address = delta.op === "task.upserted" ? delta.task.address : delta.address;
          const key = taskAddressKey(address);
          const previous = taskRows.get(key);
          const next = delta.op === "task.upserted" ? delta.task : undefined;
          if (next) taskRows.set(key, next);
          else taskRows.delete(key);

          for (const [queryKey, cached] of queryCache) {
            const touchesWorkspace = queryContainsWorkspace(cached.query, address);
            if (!touchesWorkspace) continue;
            // In the past, any task delta cleared all queries. Only when the old row is explicitly grasped,
            // The membership will be invalid before and after the change; when the old row is missing, it cannot be ruled out that it once belonged to another kind.
            // Therefore, the current workspace is conservatively invalidated to prevent timeline/active from leaving stale items.
            if (
              !previous ||
              matchesTaskListMembershipKind(previous.membership, cached.query.kind) ||
              (next && matchesTaskListMembershipKind(next.membership, cached.query.kind))
            ) {
              queryCache.delete(queryKey);
            }
          }
        }
      }
      // Consecutive task frames within the same JavaScript scheduling cycle are merged into one renderer revision.
      notifyOnce();
    });
    void Promise.all(
      [CONTROLLER_WORKSPACES_TOPIC, CONTROLLER_TASKS_INDEX_TOPIC].map(async (topic) => {
        const result = await controller.subscribeControllerV4({
          topic,
          visibility: "foreground",
        });
        if (!started || generation !== startGeneration) {
          await controller.unsubscribeControllerV4({
            subscriptionId: result.ack.subscriptionId,
          });
          return;
        }
        subscriptionIds.add(result.ack.subscriptionId);
      }),
    ).catch((error) =>
      logger.warn("[windowControllerTaskListRegistry] Controller subscribe failed", error),
    );
  };

  const registry: WindowControllerTaskListRegistry = {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getRevision() {
      return revision;
    },
    list(queryKey, version, query) {
      const versionKey = cacheVersionKey(version);
      const cached = queryCache.get(queryKey);
      if (cached?.versionKey === versionKey) return cached.promise;
      const promise = controller.listTaskList(query);
      const entry = { versionKey, promise, query };
      queryCache.set(queryKey, entry);
      void promise.catch(() => {
        if (queryCache.get(queryKey) === entry) queryCache.delete(queryKey);
      });
      return promise;
    },
  };
  registries.set(key, registry);
  return registry;
}
