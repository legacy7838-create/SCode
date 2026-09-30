import { create } from "zustand";
import type { Hook, HookConfig } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";

interface HooksStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspaceKey: string | null;
  hooks: Hook[];
  loading: boolean;
  error: string | null;
  operatingHookId: string | null;
  initialize: (
    workspacePath: string | undefined,
    workspaceIdentity: string | undefined,
    hooksService: IHooksService,
  ) => Promise<void>;
  /**
   * refresh must explicitly pass in the target when initiated (path/identity/service triplet).
   * The old signature only transmits the service, and reads the workspace from the store when loading - during the waiting period of Trust, the user reads from
   * When workspace A is switched to B, "A's service + B's path/identity" will be formed, and B's list
   * Contaminated into A's data. Triplets are now captured atomically at the call site, and store state is used only for drift guards.
   */
  refresh: (
    hooksService: IHooksService,
    target: { workspacePath?: string | null; workspaceIdentity?: string | null },
  ) => Promise<void>;
  addHook: (config: HookConfig, hooksService: IHooksService) => Promise<void>;
  updateHook: (id: string, config: HookConfig, hooksService: IHooksService) => Promise<void>;
  deleteHook: (id: string, hooksService: IHooksService) => Promise<void>;
  toggleHook: (id: string, enabled: boolean, hooksService: IHooksService) => Promise<void>;
  importHook: (id: string, hooksService: IHooksService) => Promise<void>;
}

type StoreSet = (state: Partial<HooksStoreState>) => void;
type StoreGet = () => HooksStoreState;

const inflightLoads = new Map<string, Promise<void>>();

// The store is a singleton, and the load initiated first after switching the workspace may arrive later. before any asynchronous results are written back to the store
// All must be compared with the target key when initiated, otherwise the hooks of the old workspace will overwrite the current projection and be dropped by subsequent write operations.
// to the current workspace.
function currentWorkspaceKey(get: StoreGet): string | null {
  const { workspacePath, workspaceIdentity } = get();
  return workspacePath ? getWorkspaceKey(workspacePath, workspaceIdentity) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildZCodeHookLocation(
  workspacePath: string,
  storageLevel: "user" | "project" = "user",
): Hook["location"] {
  return storageLevel === "project"
    ? {
        source: "zcode",
        scope: "project",
        directoryPath: "",
        projectPath: workspacePath,
      }
    : {
        source: "zcode",
        scope: "user",
        directoryPath: "",
      };
}

function isEditableHook(hook: Hook): boolean {
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

function hookFromConfig(config: HookConfig, workspacePath: string): Hook {
  return {
    id: `hook-${crypto.randomUUID()}`,
    event: config.event,
    matcher: config.matcher,
    type: config.type,
    command: config.command,
    ...(config.type === "process" ? { args: config.args ?? [] } : {}),
    ...(config.type === "command" && config.async !== undefined ? { async: config.async } : {}),
    ...(config.type === "command" && config.shell !== undefined ? { shell: config.shell } : {}),
    ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
    timeout: config.timeout ?? 60,
    enabled: config.enabled ?? true,
    custom: config.custom,
    location: buildZCodeHookLocation(workspacePath, config.storageLevel),
  };
}

function updateHookFromConfig(hook: Hook, config: HookConfig): Hook {
  return {
    ...hook,
    event: config.event,
    matcher: config.matcher,
    type: config.type,
    command: config.command,
    args: config.type === "process" ? (config.args ?? []) : undefined,
    async: config.type === "command" ? config.async : undefined,
    shell: config.type === "command" ? config.shell : undefined,
    statusMessage: config.statusMessage,
    timeout: config.timeout ?? 60,
    enabled: config.enabled ?? hook.enabled,
    custom: config.custom,
  };
}

async function loadCurrentHooks(get: StoreGet, set: StoreSet, hooksService: IHooksService) {
  const { workspacePath, workspaceIdentity } = get();
  if (!workspacePath) return;
  const key = getWorkspaceKey(workspacePath, workspaceIdentity);
  const result = await hooksService.loadHooks({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  if (currentWorkspaceKey(get) !== key) return;
  set({
    hooks: result.hooks,
    loadedWorkspaceKey: key,
  });
}

async function persistHooks(
  hooks: Hook[],
  get: StoreGet,
  set: StoreSet,
  hooksService: IHooksService,
): Promise<void> {
  const { workspacePath, workspaceIdentity } = get();
  if (!workspacePath) throw new Error("No workspace path set");
  await hooksService.saveHooks({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    hooks,
  });
  await loadCurrentHooks(get, set, hooksService);
}

// Five write operations share the same optimistic update → persistence → rollback process, converging to one place so that the stale guard only writes once.
async function applyHookMutation(
  get: StoreGet,
  set: StoreSet,
  hooksService: IHooksService,
  updatedHooks: Hook[],
  operatingHookId?: string,
): Promise<void> {
  const previousHooks = get().hooks;
  const key = currentWorkspaceKey(get);
  set({
    hooks: updatedHooks,
    error: null,
    ...(operatingHookId ? { operatingHookId } : {}),
  });
  try {
    await persistHooks(updatedHooks, get, set, hooksService);
    set({ operatingHookId: null });
  } catch (error) {
    // If the workspace has been switched when the save fails, rolling back the captured old hooks into the store will pollute the current workspace.
    set(
      currentWorkspaceKey(get) === key
        ? { hooks: previousHooks, operatingHookId: null, error: errorMessage(error) }
        : { operatingHookId: null },
    );
    throw error;
  }
}

export const useHooksStore = create<HooksStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspaceKey: null,
  hooks: [],
  loading: false,
  error: null,
  operatingHookId: null,

  initialize: async (workspacePath, workspaceIdentity, hooksService) => {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    set({ workspacePath: workspacePath ?? null, workspaceIdentity: normalizedIdentity });
    if (!workspacePath) {
      set({ hooks: [], loading: false, loadedWorkspaceKey: null });
      return;
    }
    const key = getWorkspaceKey(workspacePath, normalizedIdentity);
    // When switching to another workspace, immediately discard the previous projection to avoid displaying and operating other people's hooks before new data arrives.
    if (get().loadedWorkspaceKey !== key) {
      set({ hooks: [], loadedWorkspaceKey: null });
    }
    const existing = inflightLoads.get(key);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      set({ loading: true, error: null });
      try {
        const result = await hooksService.loadHooks({
          workspacePath,
          ...(normalizedIdentity ? { workspaceIdentity: normalizedIdentity } : {}),
        });
        if (currentWorkspaceKey(get) !== key) return;
        set({ hooks: result.hooks, loadedWorkspaceKey: key, loading: false });
      } catch (error) {
        if (currentWorkspaceKey(get) !== key) return;
        set({ error: errorMessage(error), loading: false });
      } finally {
        inflightLoads.delete(key);
      }
    })();
    inflightLoads.set(key, promise);
    await promise;
  },

  refresh: async (hooksService, target) => {
    // Triplets are captured atomically at the call site: service and path/identity must come from the same target at the same time.
    const targetPath = target.workspacePath ?? null;
    const targetIdentity = target.workspaceIdentity?.trim() || null;
    if (!targetPath) return;
    const key = getWorkspaceKey(targetPath, targetIdentity);
    // Before initiating, when the target is no longer the current workspace (the user has switched away while the Trust is waiting), it must be directly
    // Give up - loading/error is a global single field. If you still set({loading:true}), the result will be mismatched due to key
    // After being discarded, leave the current workspace with loading=true permanently.
    if (currentWorkspaceKey(get) !== key) return;
    set({ loading: true, error: null });
    try {
      const result = await hooksService.loadHooks({
        workspacePath: targetPath,
        ...(targetIdentity ? { workspaceIdentity: targetIdentity } : {}),
      });
      // During the waiting period, the store has been switched to another workspace → this result is invalid for the current projection and is silently discarded;
      // The loading life cycle is owned by the new workspace's own initialize and must not be touched here.
      if (currentWorkspaceKey(get) !== key) return;
      set({ hooks: result.hooks, loadedWorkspaceKey: key, loading: false });
    } catch (error) {
      if (currentWorkspaceKey(get) !== key) return;
      set({ error: errorMessage(error), loading: false });
    }
  },

  addHook: async (config, hooksService) => {
    const { workspacePath, hooks } = get();
    if (!workspacePath) throw new Error("No workspace path set");
    await applyHookMutation(get, set, hooksService, [
      ...hooks,
      hookFromConfig(config, workspacePath),
    ]);
  },

  updateHook: async (id, config, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.map((hook) => (hook.id === id ? updateHookFromConfig(hook, config) : hook)),
      id,
    );
  },

  deleteHook: async (id, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.filter((hook) => hook.id !== id),
      id,
    );
  },

  toggleHook: async (id, enabled, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.map((hook) => (hook.id === id ? { ...hook, enabled } : hook)),
      id,
    );
  },

  importHook: async (id, hooksService) => {
    const { hooks, workspacePath } = get();
    if (!workspacePath) throw new Error("No workspace path set");
    const source = hooks.find((hook) => hook.id === id);
    if (!source || source.location?.source === "zcode") throw new Error("Hook is not importable");
    const imported: Hook = {
      ...source,
      id: `hook-${crypto.randomUUID()}`,
      enabled: true,
      location: buildZCodeHookLocation(workspacePath, source.location?.scope ?? "user"),
    };
    await applyHookMutation(get, set, hooksService, [...hooks, imported], id);
  },
}));
