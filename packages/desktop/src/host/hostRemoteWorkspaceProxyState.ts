import type { IDisposable } from "@zcode/rpc";
import { resolveWorkspaceKey } from "@zcode/shared";

interface HostRemoteTaskMeta {
  taskId: string;
  traceId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface HostRemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Workspace resources held by the shared remote Host proxy layer.
 *
 * A dedicated Host exits with its tab, so historical task meta and event listeners are reclaimed
 * with the process; a WSL Host Pool is reused across workspaces, so cleanup must be driven per
 * workspace — otherwise the references keep growing for the lifetime of the Host.
 */
export function createHostRemoteWorkspaceProxyState(): {
  rememberTaskMeta: (meta: HostRemoteTaskMeta) => void;
  getTaskMeta: (taskId: string) => HostRemoteTaskMeta | undefined;
  ensureWorkspaceSubscription: (
    context: HostRemoteWorkspaceContext,
    subscribe: () => IDisposable,
  ) => boolean;
  trackTaskReady: (
    taskId: string,
    context: HostRemoteWorkspaceContext,
    subscribe: (listener: () => void) => IDisposable,
    onReady: () => void,
  ) => void;
  disposeTaskReadySubscription: (taskId: string) => void;
  clearWorkspace: (context: HostRemoteWorkspaceContext) => void;
} {
  const taskMetaById = new Map<string, HostRemoteTaskMeta>();
  const workspaceSubscriptions = new Map<string, IDisposable>();
  const taskReadySubscriptions = new Map<
    string,
    { workspaceKey: string; disposable: IDisposable }
  >();

  function disposeTaskReadySubscription(taskId: string): void {
    const entry = taskReadySubscriptions.get(taskId);
    if (!entry) {
      return;
    }
    taskReadySubscriptions.delete(taskId);
    entry.disposable.dispose();
  }

  return {
    rememberTaskMeta(meta) {
      taskMetaById.set(meta.taskId, meta);
    },

    getTaskMeta(taskId) {
      return taskMetaById.get(taskId);
    },

    ensureWorkspaceSubscription(context, subscribe) {
      const workspaceKey = resolveWorkspaceKey(context);
      if (workspaceSubscriptions.has(workspaceKey)) {
        return false;
      }
      workspaceSubscriptions.set(workspaceKey, subscribe());
      return true;
    },

    trackTaskReady(taskId, context, subscribe, onReady) {
      let readyBeforeRegistration = false;
      const disposable = subscribe(() => {
        readyBeforeRegistration = true;
        disposeTaskReadySubscription(taskId);
        onReady();
      });
      if (readyBeforeRegistration) {
        // Dynamic RPC events usually do not replay synchronously, but the synchronous implementation is handled here to avoid leaving the listener after ready is completed.
        disposable.dispose();
        return;
      }
      disposeTaskReadySubscription(taskId);
      taskReadySubscriptions.set(taskId, {
        workspaceKey: resolveWorkspaceKey(context),
        disposable,
      });
    },

    disposeTaskReadySubscription,

    clearWorkspace(context) {
      const workspaceKey = resolveWorkspaceKey(context);
      workspaceSubscriptions.get(workspaceKey)?.dispose();
      workspaceSubscriptions.delete(workspaceKey);

      for (const [taskId, meta] of taskMetaById) {
        if (resolveWorkspaceKey(meta) === workspaceKey) {
          taskMetaById.delete(taskId);
        }
      }
      for (const [taskId, entry] of taskReadySubscriptions) {
        if (entry.workspaceKey === workspaceKey) {
          disposeTaskReadySubscription(taskId);
        }
      }
    },
  };
}
