import type {
  CollaborationMode,
  ExecutionShellSelection,
  Model,
  ModelSelection,
  ModelToolContract,
  PermissionBrokerRequest,
  ProjectId,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  TraceContext,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
} from "../deps.js";
import { isInspectablePermissionBroker, projectIdFromDirectory } from "../helpers/index.js";
import {
  deriveChildClientPorts,
  type ChildClientPortsContext,
  type ClientFacingPorts,
} from "../helpers/child-client-ports.js";
import type { AgentRuntimeConfig, ActiveTurnInfo } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

import { orderProviderVisibleToolContracts } from "../../tool/provider-visible-order.js";
import { projectToolModelContract } from "../../tool/model-contract.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { filterEmbeddedSearchRuntimeVisibleTools } from "./embedded-search-branch.js";
import {
  getSessionShellSelection as readSessionShellSelection,
  initializeSessionShellEnvironmentIfNeeded as initializeSessionShellEnvironment,
  type SessionShellEnvironmentCandidate,
} from "./session-shell-environment.js";

export async function setExecutionState(
  this: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean },
  traceContext?: TraceContext,
): Promise<void> {
  await applyRuntimeExecutionState(this, input, { source: "command", traceContext });
}

export function updateConfig(
  this: AgentRuntimeInternal,
  patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
): void {
  if (patch.mode !== undefined || patch.planEnabled !== undefined) {
    const previous = resolveExecutionState(this.config);
    const next = resolveExecutionState(patch, previous);
    Object.assign(this.config, next);
    if (previous.planEnabled !== next.planEnabled)
      this.needsPlanModeExitReminder = !next.planEnabled;
  }
  if (patch.language !== undefined) {
    this.config.language = patch.language;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
  if ("outputStyle" in patch) {
    this.config.outputStyle = patch.outputStyle;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
}

export function initializeSessionShellEnvironmentIfNeeded(
  this: AgentRuntimeInternal,
  selection: SessionShellEnvironmentCandidate,
): boolean {
  return initializeSessionShellEnvironment(this, selection);
}

export function getSessionShellSelection(
  this: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return readSessionShellSelection(this);
}

export function getMode(this: AgentRuntimeInternal): CollaborationMode {
  return this.config.mode ?? "build";
}

export function getPlanEnabled(this: AgentRuntimeInternal): boolean {
  return resolveExecutionState(this.config).planEnabled;
}

export function getSessionModelSelection(this: AgentRuntimeInternal): ModelSelection | undefined {
  return this.sessionModelSelection && cloneModelSelection(this.sessionModelSelection);
}

export function setSessionModelSelection(
  this: AgentRuntimeInternal,
  selection: ModelSelection | undefined,
): void {
  // Restoration/configuration refresh can clear stale selections; unbound should not borrow the default model, nor affect the executing Active Model.
  this.sessionModelSelection = selection && cloneModelSelection(selection);
}

export function getProjectId(this: AgentRuntimeInternal): ProjectId {
  // Bash cd will change the execution cwd, but the project identity cannot drift with the cwd in the tool.
  return projectIdFromDirectory(this.workspaceRoot);
}

export function setWorkingDirectory(this: AgentRuntimeInternal, cwd: string): void {
  // Bash cwd persistence should only affect the current runtime session, not the workspace identity.
  this.workingDirectory = cwd;
}

export async function ensureSessionPersistedForExternalActivity(
  this: AgentRuntimeInternal,
  input: string,
  options?: { traceContext?: TraceContext },
): Promise<void> {
  await this.ensureSessionPersisted(input, options?.traceContext ?? this.rootTraceContext);
}

export function getActiveTurnInfo(this: AgentRuntimeInternal): ActiveTurnInfo | undefined {
  const activeTurn = this.activeTurn;
  if (!activeTurn) return undefined;
  return {
    kind: activeTurn.kind,
    ...(activeTurn.inputId === undefined ? {} : { inputId: activeTurn.inputId }),
    queueLength: activeTurn.pendingInputs.length,
    steerable: activeTurn.steerable,
    turnId: activeTurn.turnId,
  };
}

export function getTools(this: AgentRuntimeInternal, model?: Model): ModelToolContract[] {
  if (this.cachedTools === null) {
    this.cachedTools = filterRuntimeVisibleTools.call(this, this.registry.toContracts());
  }
  return this.cachedTools
    .filter((tool) => tool.name !== "WebSearch" || shouldExposeWebSearch.call(this, model))
    .map((tool) =>
      projectToolModelContract(tool, this.registry.get(tool.name), {
        model,
      }),
    );
}

export function invalidateToolCache(this: AgentRuntimeInternal): void {
  this.cachedTools = null;
}

export function getToolRegistry(this: AgentRuntimeInternal): ToolRegistry {
  return this.registry;
}

export function getToolExecutor(this: AgentRuntimeInternal): ToolExecutor {
  return this.executor;
}

export function subscribeEvents(this: AgentRuntimeInternal, sink: SessionEventSink): () => void {
  this.eventSinks.add(sink);
  return () => {
    this.eventSinks.delete(sink);
  };
}

/**
 * Seam (1) for an external child runtime: hands out this runtime's session event store.
 *
 * A child runtime constructed outside the class (bootstrap's dwf actor / legacy script workflow) must
 * share the same store as the parent runtime, otherwise the child session's events land only in a
 * private store that nobody can read and v4's `loadPersistedEvents(childSessionId)` is always empty —
 * leaving the transcript permanently blank. Child events are still persisted under the child's own
 * sessionId, so the two sessions never overwrite each other within one store (`eventStore:
 * this.eventStore` at `subagent.ts:280` is the very same convention).
 */
export function getSessionEventStore(this: AgentRuntimeInternal): SessionEventStorePort {
  return this.eventStore;
}

/**
 * Seam (2) for an external child runtime: fans the child session's raw events out to this runtime's
 * external sink set.
 *
 * The semantics are exactly those of `notifyEventSinks(event, {...trace, sessionId: childSessionId})`
 * at `subagent.ts:338`: the child sessionId is preserved (the protocol layer routes by it to the
 * detached live session), and it only notifies, never appends.
 *
 * A child runtime must install this call as its own `deps.eventSink` **at construction time**:
 * `ensureSessionPersistedForExternalActivity` writes SessionTitleUpdated as sequenceNumber 1, and the
 * v4 gateway only drains a continuous seq — a subscription attached after construction starts at
 * seq 2 and would wait forever for a seq 1 that is never going to come.
 */
export async function notifyExternalChildSessionEvent(
  this: AgentRuntimeInternal,
  input: { childSessionId: SessionId; event: SessionEvent; traceContext?: TraceContext },
): Promise<void> {
  // Only notify, never append: the child runtime has dropped this event according to its own sessionId.
  // Using the append link of the parent runtime will cause the same event to appear twice in the shared store.
  await this.notifyEventSinks(input.event, {
    ...(input.traceContext ?? this.rootTraceContext),
    sessionId: input.childSessionId,
  });
}

/**
 * Seam (3) for an external child runtime: mints the child runtime's **outbound interaction** ports.
 *
 * The child's ledger identity (the child sessionId) is not an identity the protocol client can answer
 * for. The dwf actor and the legacy workflow child used to take `providerRuntimeHeadersPort` /
 * `permissionBroker` straight from `appOptions`, so they asked the desktop carrying `sess_dwf-…`;
 * `requireSession` on the desktop's reply path throws, the response is never sent, and the subagent
 * hangs forever before its first model request (8 subagents, 80 minutes without a single event). The
 * core's built-in subagent worked around this with two private wrappers back then, and of the three
 * assemblies two were wrong and one was right — which shows that a rule scattered across call sites
 * will inevitably drift.
 *
 * The fix: the derivation is consolidated into `deriveChildClientPorts`, and it may only be called by
 * the **parent runtime** — the `parentSessionId` is filled in by the parent itself, so a caller cannot
 * supply a wrong value. Any assembly that constructs a child runtime outside the class (dwf actor,
 * legacy workflow child) must obtain its ports through here.
 */
export function createChildClientPorts(
  this: AgentRuntimeInternal,
  context: ChildClientPortsContext,
): ClientFacingPorts {
  return deriveChildClientPorts(
    {
      ...(this.permissionBroker === undefined ? {} : { permissionBroker: this.permissionBroker }),
      ...(this.providerRuntimeHeadersPort === undefined
        ? {}
        : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
    },
    { ...context, parentSessionId: this.sessionId },
  );
}

export function getContextBuilder(this: AgentRuntimeInternal): ContextBuilder {
  if (!this.contextBuilder) {
    this.contextBuilder = this.createContextBuilderFromSnapshot(
      this.createConfigOnlyContextSnapshot(this.workingDirectory),
      undefined,
      { persistEnvInfo: false },
    );
  }
  // This getter can only provide a synchronized preview builder and cannot initialize messageHistory.
  // Otherwise, the first round of executeTurn will skip the asynchronous context source parsing, causing the real workspace context to be lost.
  return this.contextBuilder;
}

export function getPendingPermissionRequests(
  this: AgentRuntimeInternal,
): PermissionBrokerRequest[] {
  if (!isInspectablePermissionBroker(this.permissionBroker)) return [];
  return this.permissionBroker.listPendingRequests();
}

export async function getProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  return this.rebuildProjection();
}

export function getSessionId(this: AgentRuntimeInternal): SessionId {
  return this.sessionId;
}

function filterRuntimeVisibleTools(
  this: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  const visibleTools = filterEmbeddedSearchRuntimeVisibleTools(this, tools);
  // The provider-visible tool order belongs to the final output boundary; toolset only determines the set of visible tools.
  return orderProviderVisibleToolContracts(visibleTools);
}

function shouldExposeWebSearch(this: AgentRuntimeInternal, model?: Model): boolean {
  // Model-less calls only enumerate the complete registry for persistence and UI metadata; real execution is always passed in
  // The current Active Model and only reads its frozen full capability facts.
  if (!model) return true;
  return model.properties.supportsNativeWebSearch;
}
import { resolveExecutionState } from "@zcode/shared";
