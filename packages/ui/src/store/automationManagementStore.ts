/* eslint-disable max-lines -- the scheduled task management store centrally maintains the list /
 * run history / CRUD and operations such as run-now, and will be split once it stabilizes.
 */
import { create } from "zustand";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  isAutomationCreateLimitError,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationScheduleRule,
  type ModelSelection,
} from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";

// Scheduled task (automation) management store: use zcode-agent RPC (list/create/edit/start/stop/rerun/delete + running history).
// The same paradigm as pluginManagementStore: cached by workspace, refreshed in the background when switching to avoid flickering.

/** Run history cache for a single automation (loading/data/error recorded per automationId). */
export interface AutomationRunsEntry {
  status: "loading" | "loaded" | "error";
  runs?: ZCodeAutomationRun[];
  error?: string;
}

export type AutomationRunNowResult = "queued" | "duplicate" | "failed";

export interface CreateAutomationInput {
  title: string;
  cronExpr: string;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  // Target project; by default, store the project where the current list is located. Creating a full page can be changed under Project.
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface UpdateAutomationInput {
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

interface AutomationManagementState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  automations: ZCodeAutomation[];
  loading: boolean;
  error: string | null;
  // Flag of an ongoing write operation, used to disable the corresponding button (e.g. `automation:delete:<id>`).
  operationId: string | null;
  runsCache: Record<string, AutomationRunsEntry>;
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    agentService: IZCodeAgentService;
  }) => Promise<void>;
  refresh: (agentService: IZCodeAgentService) => Promise<void>;
  createAutomation: (
    input: CreateAutomationInput,
    agentService: IZCodeAgentService,
  ) => Promise<ZCodeAutomation | null>;
  updateAutomation: (
    automationId: string,
    input: UpdateAutomationInput,
    agentService: IZCodeAgentService,
  ) => Promise<boolean>;
  deleteAutomation: (automationId: string, agentService: IZCodeAgentService) => Promise<void>;
  setEnabled: (
    automationId: string,
    enabled: boolean,
    agentService: IZCodeAgentService,
  ) => Promise<void>;
  restartAutomation: (automationId: string, agentService: IZCodeAgentService) => Promise<void>;
  /** Runs once immediately; queued / duplicate / failed are all surfaced as a toast by the caller. */
  runAutomationNow: (
    automationId: string,
    agentService: IZCodeAgentService,
  ) => Promise<AutomationRunNowResult>;
  loadRuns: (
    automationId: string,
    agentService: IZCodeAgentService,
    force?: boolean,
  ) => Promise<void>;
  deleteRun: (
    automationId: string,
    runId: string,
    agentService: IZCodeAgentService,
  ) => Promise<void>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let automationLoadSeq = 0;
const inFlightRunNowAutomationIds = new Set<string>();

function sameWorkspace(
  current: Pick<AutomationManagementState, "workspacePath" | "workspaceIdentity">,
  workspacePath: string,
  workspaceIdentity: string | null,
): boolean {
  return current.workspacePath === workspacePath && current.workspaceIdentity === workspaceIdentity;
}

function resolveAutomationActionScope(
  state: Pick<AutomationManagementState, "automations" | "workspacePath" | "workspaceIdentity">,
  automationId: string,
): { workspacePath: string; workspaceIdentity: string | null } | null {
  const automation = state.automations.find((candidate) => candidate.automationId === automationId);
  const workspacePath = automation?.workspacePath ?? state.workspacePath;
  if (!workspacePath) return null;
  return {
    workspacePath,
    workspaceIdentity: automation?.workspaceIdentity ?? state.workspaceIdentity,
  };
}

async function loadInto(
  set: (partial: Partial<AutomationManagementState>) => void,
  get: () => AutomationManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    agentService: IZCodeAgentService;
    requestId: number;
  },
): Promise<void> {
  const { workspacePath, workspaceIdentity, agentService, requestId } = params;
  try {
    // The scheduled task management view displays tasks for all projects and is not filtered by the current workspace (creation/editing still includes projects).
    const automations = await agentService.listAllAutomations();
    if (
      requestId !== automationLoadSeq ||
      !sameWorkspace(get(), workspacePath, workspaceIdentity)
    ) {
      return;
    }
    set({ automations, loading: false });
  } catch (error) {
    if (
      requestId !== automationLoadSeq ||
      !sameWorkspace(get(), workspacePath, workspaceIdentity)
    ) {
      return;
    }
    logger.error("[automations] load failed", {
      workspacePath,
      error: toMessage(error),
    });
    set({ error: toMessage(error), loading: false });
  }
}

export const useAutomationManagementStore = create<AutomationManagementState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  automations: [],
  loading: false,
  error: null,
  operationId: null,
  runsCache: {},

  async initialize({ workspacePath, workspaceIdentity, agentService }) {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const requestId = ++automationLoadSeq;
    const current = get();
    const hasCache =
      current.automations.length > 0 &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === normalizedIdentity;
    set({
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      // When there is cache, the background refreshes and retains the list to avoid flickering when switching workspaces; only when there is no cache, blocking loading is displayed.
      loading: !hasCache,
      error: null,
      operationId: null,
      automations: hasCache ? current.automations : [],
      // Clear the running history cache when switching workspaces (history is recorded by automationId, meaningless across workspaces).
      ...(hasCache ? {} : { runsCache: {} }),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      agentService,
      requestId,
    });
  },

  async refresh(agentService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return;
    const requestId = ++automationLoadSeq;
    set({ error: null });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      agentService,
      requestId,
    });
  },

  async createAutomation(input, agentService) {
    const { automations, workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return null;
    if (automations.length >= AUTOMATION_CREATE_LIMIT) {
      // Entries are created in forms, templates, and sessions, and can still be bypassed by disabling a button individually.
      // The store uses the full list of management pages for quick rejection, and the service layer transactions continue to bear the final consistency check.
      set({
        error: `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] automation limit reached`,
      });
      return null;
    }
    set({ operationId: `automation:create:${input.title}`, error: null });
    try {
      const created = await agentService.createAutomation({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...input,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath,
        workspaceIdentity,
        agentService,
        requestId,
      });
      return created;
    } catch (error) {
      const message = toMessage(error);
      if (isAutomationCreateLimitError(error)) {
        logger.warn("[automations] create blocked by limit", {
          limit: AUTOMATION_CREATE_LIMIT,
        });
      } else {
        logger.error("[automations] create failed", { error: message });
      }
      set({ error: message });
      return null;
    } finally {
      set({ operationId: null });
    }
  },

  async updateAutomation(automationId, input, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return false;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return false;
    set({ operationId: `automation:update:${automationId}`, error: null });
    try {
      await agentService.updateAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
        ...input,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return true;
    } catch (error) {
      logger.error("[automations] update failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async deleteAutomation(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:delete:${automationId}`, error: null });
    try {
      await agentService.deleteAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] delete failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async setEnabled(automationId, enabled, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({
      operationId: `automation:setEnabled:${automationId}`,
      error: null,
    });
    try {
      await agentService.setAutomationEnabled({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
        enabled,
      });
      // The edit page holds the automation object when it is opened; if you just wait for listAllAutomations
      // Back to the source, the menu copy will continue to display the old state after clicking Pause/Resume.
      set({
        automations: get().automations.map((automation) =>
          automation.automationId === automationId
            ? {
                ...automation,
                enabled,
                lifecycleStatus: enabled ? "active" : "paused",
              }
            : automation,
        ),
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] setEnabled failed", {
        automationId,
        enabled,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async restartAutomation(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:restart:${automationId}`, error: null });
    try {
      await agentService.restartAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] restart failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async runAutomationNow(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return "failed";
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return "failed";
    if (inFlightRunNowAutomationIds.has(automationId)) {
      return "duplicate";
    }
    // There is a rendering delay in the React disabled button, and continuous clicks will reenter before the UI is updated.
    // Synchronous memory locks are only used here during the current RPC request; the entry is restored after the request returns.
    // Repeated triggering of activity run continues to be handed over to host single-flight to return duplicate.
    inFlightRunNowAutomationIds.add(automationId);
    set({ operationId: `automation:runNow:${automationId}`, error: null });
    try {
      const result = await agentService.runAutomationNow({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      if (result.status === "duplicate") {
        return "duplicate";
      }
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return "queued";
    } catch (error) {
      logger.error("[automations] runNow failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
      return "failed";
    } finally {
      inFlightRunNowAutomationIds.delete(automationId);
      set({ operationId: null });
    }
  },

  async loadRuns(automationId, agentService, force = false) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    const { runsCache } = state;
    const cached = runsCache[automationId];
    if (!force && cached && cached.status !== "error") return;
    set({
      runsCache: {
        ...get().runsCache,
        [automationId]: { status: "loading" },
      },
    });
    try {
      const runs = await agentService.listAutomationRuns({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      if (!sameWorkspace(get(), viewWorkspacePath, state.workspaceIdentity)) {
        return;
      }
      set({
        runsCache: {
          ...get().runsCache,
          [automationId]: { status: "loaded", runs },
        },
      });
    } catch (error) {
      if (!sameWorkspace(get(), viewWorkspacePath, state.workspaceIdentity)) {
        return;
      }
      logger.error("[automations] load runs failed", {
        automationId,
        error: toMessage(error),
      });
      set({
        runsCache: {
          ...get().runsCache,
          [automationId]: { status: "error", error: toMessage(error) },
        },
      });
    }
  },

  async deleteRun(automationId, runId, agentService) {
    const state = get();
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:deleteRun:${runId}`, error: null });
    try {
      await agentService.deleteAutomationRun({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        runId,
      });
      await get().loadRuns(automationId, agentService, true);
    } catch (error) {
      logger.error("[automations] delete run failed", {
        runId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },
}));
