import { create } from "zustand";
import type {
  CommandAck,
  CommandEnvelope,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
// review monotonicity rules single source; store's application strategy is cross_flow accepts new Runtime authority
// (The renderer obeys the latest delivery of the canonical snapshot).
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";

export interface WorkspaceHookCommandBinding {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

interface WorkspaceHookReviewBinding {
  request: WorkspaceHookReviewRequestPayload;
  workspacePath: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

interface WorkspaceHookReviewState {
  bindings: Record<string, WorkspaceHookReviewBinding>;
  commandBindings: Record<string, WorkspaceHookCommandBinding>;
  connect(sessionId: string, binding: WorkspaceHookCommandBinding): void;
  disconnect(sessionId: string, sendCommand: WorkspaceHookCommandBinding["sendCommand"]): void;
  upsert(sessionId: string, binding: WorkspaceHookReviewBinding): void;
  clear(sessionId: string, interactionId?: string): void;
}

export const useWorkspaceHookReviewStore = create<WorkspaceHookReviewState>((set) => ({
  bindings: {},
  commandBindings: {},
  connect: (sessionId, binding) =>
    set((state) => ({
      commandBindings: { ...state.commandBindings, [sessionId]: binding },
    })),
  disconnect: (sessionId, sendCommand) =>
    set((state) => {
      const current = state.commandBindings[sessionId];
      if (!current || current.sendCommand !== sendCommand) return state;
      const commandBindings = { ...state.commandBindings };
      delete commandBindings[sessionId];
      const review = state.bindings[sessionId];
      if (!review || review.sendCommand !== sendCommand) return { commandBindings };
      // After the command channel is disconnected, the review binding of the same connection cannot be retained; otherwise Settings
      // Will get the disposed client. sendCommand identity guard prevents old connections cleanup from clearing new connections.
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings, commandBindings };
    }),
  upsert: (sessionId, binding) =>
    set((state) => {
      const commandBinding = state.commandBindings[sessionId];
      if (commandBinding && commandBinding.sendCommand !== binding.sendCommand) {
        // Old effects may be late when the renderer reconnects; only the current session command channel can be refreshed
        // Review binding to avoid equal-generation replay and replace the new client with the disposed client.
        return state;
      }
      const current = state.bindings[sessionId];
      if (current) {
        const verdict = verdictWorkspaceHookReviewRequest(current.request, binding.request);
        // Generations are only comparable within a Runtime flow. A new Runtime will generate a new
        // reviewFlowId and recalculate from 1; cross-flow (cross_flow) must obey the canonical snapshot
        // The latest delivery, otherwise the high generation of the old runtime will permanently block new authoritative requests. Same as flow, strict
        // The generation is required to be monotonic, and replay/conflict/stale must not overwrite the current binding.
        if (
          verdict === "same_flow_stale" ||
          verdict === "same_flow_replay" ||
          verdict === "same_flow_conflict"
        ) {
          return state;
        }
      }
      return { bindings: { ...state.bindings, [sessionId]: binding } };
    }),
  clear: (sessionId, interactionId) =>
    set((state) => {
      const current = state.bindings[sessionId];
      if (!current || (interactionId && current.request.interactionId !== interactionId)) {
        return state;
      }
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings };
    }),
}));

export function findWorkspaceHookReviewBinding(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
): WorkspaceHookReviewBinding | undefined {
  return Object.values(bindings)
    .filter((binding) =>
      matchesWorkspaceBinding({
        bindingWorkspaceIdentity: binding.request.workspaceIdentity,
        bindingWorkspacePath: binding.workspacePath,
        workspaceIdentity,
        workspacePath,
      }),
    )
    .sort((left, right) => right.request.createdAt - left.request.createdAt)[0];
}

const TRUSTABLE_WORKSPACE_HOOK_STATES = new Set(["pending_trust", "revoked", "stale_digest"]);

/**
 * Finds the exact immutable review binding that can authorize a given static Settings row.
 *
 * The trustState in Settings is only for display and must never become the mutation authority;
 * before an actual commit the workspace, bundle and opaque reviewItemId all have to match, so that
 * a pending request is never wrongly reused across a generation/bundle while waiting.
 */
export function findWorkspaceHookReviewBindingForItem(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
): WorkspaceHookReviewBinding | undefined {
  return Object.values(bindings)
    .filter(
      (binding) =>
        matchesWorkspaceBinding({
          bindingWorkspaceIdentity: binding.request.workspaceIdentity,
          bindingWorkspacePath: binding.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          workspacePath: input.workspacePath,
        }) &&
        binding.request.bundleDigest === input.bundleDigest &&
        binding.request.items.some(
          (item) =>
            item.reviewItemId === input.reviewItemId &&
            TRUSTABLE_WORKSPACE_HOOK_STATES.has(item.trustState),
        ),
    )
    .sort((left, right) => right.request.createdAt - left.request.createdAt)[0];
}

export function waitForWorkspaceHookReviewBindingForItem(
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
  timeoutMs: number,
): Promise<WorkspaceHookReviewBinding | undefined> {
  const current = findWorkspaceHookReviewBindingForItem(
    useWorkspaceHookReviewStore.getState().bindings,
    input,
  );
  if (current) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const timer = globalThis.setTimeout(() => finish(undefined), timeoutMs);
    const finish = (binding: WorkspaceHookReviewBinding | undefined) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(binding);
    };
    unsubscribe = useWorkspaceHookReviewStore.subscribe((state) => {
      const binding = findWorkspaceHookReviewBindingForItem(state.bindings, input);
      if (binding) finish(binding);
    });

    // A synchronous upsert may still occur between subscribe and the first read; check for closing race conditions again after the subscription is completed.
    const afterSubscribe = findWorkspaceHookReviewBindingForItem(
      useWorkspaceHookReviewStore.getState().bindings,
      input,
    );
    if (afterSubscribe) finish(afterSubscribe);
  });
}

export function findWorkspaceHookCommandBinding(
  bindings: Record<string, WorkspaceHookCommandBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
): WorkspaceHookCommandBinding | undefined {
  return Object.values(bindings).find((binding) =>
    matchesWorkspaceBinding({
      bindingWorkspaceIdentity: binding.workspaceIdentity,
      bindingWorkspacePath: binding.workspacePath,
      workspaceIdentity,
      workspacePath,
    }),
  );
}

function matchesWorkspaceBinding(input: {
  bindingWorkspaceIdentity?: string;
  bindingWorkspacePath: string;
  workspaceIdentity?: string;
  workspacePath?: string | null;
}): boolean {
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceKey) return false;
  const bindingWorkspaceIdentity = input.bindingWorkspaceIdentity?.trim();
  if (bindingWorkspaceIdentity) {
    // The OR determination of identity hit or path hit is not enough: the remote tab of the same path is due to path
    // Equality will be selected as a trusted submission channel by the local Settings, resulting in incorrect authorization across workspaces.
    // Correction: Once binding contains identity, it can only strictly match workspaceKey; only itself cannot
    // The old local binding of identity only allows path fallback.
    return bindingWorkspaceIdentity === workspaceKey;
  }
  // When the current query itself carries identity, it is also prohibited to downgrade to path; otherwise, the unknown remote identity will be mistakenly selected.
  // A local old binding without identity.
  return !input.workspaceIdentity?.trim() && input.bindingWorkspacePath === input.workspacePath;
}
