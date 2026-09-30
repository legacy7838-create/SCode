import type { IZCodeAgentService } from "@zcode/services";
import {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type ProcessResourceSampler,
} from "@zcode/services/node";
import {
  HostResponseTypes,
  type HostResourceUsageSnapshotRequestMessage,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";

interface CreateHostResourceUsageResponderOptions {
  getAgentService: () => Pick<IZCodeAgentService, "collectLocalRuntimeChildProcesses"> | undefined;
  postMessage: (message: HostResourceUsageSnapshotResultResponse) => void;
  hostPid?: number;
  sampler?: ProcessResourceSampler;
  /** Built-in plug-in process directly managed by Host (such as Windows CUA Helper): pid → plug-in name */
  getBuiltinPluginPids?: () => ReadonlyMap<number, string>;
  now?: () => number;
}

interface HostResourceUsageResponder {
  handleRequest(message: HostResourceUsageSnapshotRequestMessage): Promise<void>;
  cancelRequest(requestId: string): void;
}

/**
 * Host-side responder for the resource manager.
 * Samples exactly once, only when main sends a request: read the whole-machine process table → ask every local Agent for its MCP child process map → attribute by Host subtree → reply.
 * At most one round runs, and no sampling queue is kept; late results are never published after a window-close cancellation.
 */
export function createHostResourceUsageResponder(
  options: CreateHostResourceUsageResponderOptions,
): HostResourceUsageResponder {
  const hostPid = options.hostPid ?? process.pid;
  const now = options.now ?? Date.now;
  const sampler =
    options.sampler ??
    createProcessResourceSampler({ readTable: createProcessResourceTableReader() });
  let active: { requestId: string; controller: AbortController } | undefined;

  async function respond(
    message: HostResourceUsageSnapshotRequestMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const [samples, agents] = await Promise.all([
      sampler.sample(signal).catch(() => undefined),
      options
        .getAgentService()
        ?.collectLocalRuntimeChildProcesses(signal)
        .catch(() => []) ?? Promise.resolve([]),
    ]);
    if (signal.aborted) return;
    const processes = samples
      ? attributeHostProcessTree({
          samples,
          hostPid,
          agents,
          builtinPluginPids: options.getBuiltinPluginPids?.(),
        })
      : [];
    options.postMessage({
      type: HostResponseTypes.ResourceUsageSnapshotResult,
      requestId: message.requestId,
      sampledAt: now(),
      processes,
    });
  }

  return {
    async handleRequest(message) {
      let current: typeof active;
      try {
        // Main display timeout does not mean the end of the bottom layer, and queries per second cannot be turned into unbounded FIFO.
        if (active) {
          options.postMessage({
            type: HostResponseTypes.ResourceUsageSnapshotResult,
            requestId: message.requestId,
            sampledAt: now(),
            processes: [],
          });
          return;
        }
        current = { requestId: message.requestId, controller: new AbortController() };
        active = current;
        await respond(message, current.controller.signal);
      } catch {
        // If the observation fails or the reply fails when exiting, only the current round will be discarded, and the Host life cycle cannot be affected by unhandled exceptions.
      } finally {
        if (current && active === current) active = undefined;
      }
    },
    cancelRequest(requestId) {
      if (active?.requestId === requestId) active.controller.abort();
    },
  };
}
