// Saved workflow hub's read cache.
// Sharded by workspaceKey; disk is still the only authority (invariant 2) - the cache only serves re-renders within the same page,
// Always `bypass` refresh after changes (same lesson for skillStore: reusing in-flight Promise will get old scans).
import { create } from "zustand";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowInvalidEntry,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsListResult,
} from "@zcode/shared";
import type { IZCodeAgentService, ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import { logger } from "@/logger.js";

/**
 * How many runs a single page fetches at most in order to compute the "last run"; a project's
 * active workflows rarely exceed this number.
 */
const SAVED_WORKFLOW_RUNS_PAGE = 50;

/**
 * Needed for the declaration output: the return type of useSavedWorkflowGlobalGroup references it,
 * and tsc -d requires it to be nameable; knip cannot see this usage, hence it is marked public.
 * @public
 */
export interface SavedWorkflowWorkspaceState {
  entries: ZCodeSavedWorkflowEntry[];
  invalid: ZCodeSavedWorkflowInvalidEntry[];
  runs: ZCodeSavedWorkflowRun[];
  /**
   * The scanned directories (local absolute paths), which the global group watches; null while
   * nothing is loaded or the listing has not returned.
   */
  dir: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /**
   * The JSON-RPC error code of the listing call (filled in when there is one); the global group
   * uses -32602 to tell "an old agent does not support it" apart from other errors.
   */
  errorCode: number | null;
}

const EMPTY_SAVED_WORKFLOW_STATE: SavedWorkflowWorkspaceState = {
  entries: [],
  invalid: [],
  runs: [],
  dir: null,
  loading: false,
  loaded: false,
  error: null,
  errorCode: null,
};

interface SavedWorkflowStoreState {
  byWorkspaceKey: Record<string, SavedWorkflowWorkspaceState>;
  load: (
    target: ZCodeAgentSavedWorkflowTarget,
    agentService: IZCodeAgentService,
    options?: { bypassCache?: boolean },
  ) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * The shard key for cache reads: the global tier (`scope:"global"` and without a workspace) uses
 * the fixed key `"global"` — it spans projects and lets services pick their own carrier, so it must
 * not be confused with any single project's workspaceKey; project tiers are still sharded by
 * `resolveWorkspaceKey`.
 */
function savedWorkflowStoreKey(target: ZCodeAgentSavedWorkflowTarget): string {
  if (target.scope === "global" && !target.workspacePath) return "global";
  return resolveWorkspaceKey({
    workspacePath: target.workspacePath ?? "",
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  });
}

/**
 * Pull the JSON-RPC code out of a thrown error (ChannelClient preserves error.code); returns null
 * when there is none.
 */
function extractErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

async function fetchWorkspace(
  target: ZCodeAgentSavedWorkflowTarget,
  agentService: IZCodeAgentService,
): Promise<{ list: ZCodeWorkflowsListResult; runs: ZCodeSavedWorkflowRun[] }> {
  // The list is parallel to the running history; failure to run the history will not bring down the list (the hub can still read and manage the journal when it is absent).
  const [list, runs] = await Promise.all([
    agentService.listSavedWorkflows(target),
    agentService
      .listSavedWorkflowRuns({ ...target, limit: SAVED_WORKFLOW_RUNS_PAGE })
      .then((result) => result.runs)
      .catch((error: unknown) => {
        logger.warn("[savedWorkflowStore] failed to fetch run history, treating as no records", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as ZCodeSavedWorkflowRun[];
      }),
  ]);
  return { list, runs };
}

export const useSavedWorkflowStore = create<SavedWorkflowStoreState>((set) => ({
  byWorkspaceKey: {},
  async load(target, agentService, options = {}) {
    const key = savedWorkflowStoreKey(target);
    if (!options.bypassCache) {
      const current = inFlight.get(key);
      if (current) return current;
    }
    set((state) => ({
      byWorkspaceKey: {
        ...state.byWorkspaceKey,
        [key]: { ...(state.byWorkspaceKey[key] ?? EMPTY_SAVED_WORKFLOW_STATE), loading: true },
      },
    }));
    const request = fetchWorkspace(target, agentService)
      .then(({ list, runs }) => {
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              entries: list.workflows,
              invalid: list.invalid,
              runs,
              dir: list.dir,
              loading: false,
              loaded: true,
              error: null,
              errorCode: null,
            },
          },
        }));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[savedWorkflowStore] failed to fetch saved workflows", { error: message });
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              ...(state.byWorkspaceKey[key] ?? EMPTY_SAVED_WORKFLOW_STATE),
              loading: false,
              loaded: true,
              error: message,
              errorCode: extractErrorCode(error),
            },
          },
        }));
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  },
}));

export function selectSavedWorkflowState(
  state: SavedWorkflowStoreState,
  target: ZCodeAgentSavedWorkflowTarget | null,
): SavedWorkflowWorkspaceState {
  if (!target) return EMPTY_SAVED_WORKFLOW_STATE;
  return state.byWorkspaceKey[savedWorkflowStoreKey(target)] ?? EMPTY_SAVED_WORKFLOW_STATE;
}
