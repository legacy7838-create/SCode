import { create } from "zustand";
import {
  normalizeProviderFamilyDomain,
  type AppSettings,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateResult,
  type OffPeakTakeNumberAvailability,
  type ZCodeOffPeakTask,
  type ModelSelection,
} from "@zcode/shared";
import type {
  ICodingPlanSubscriptionService,
  IOffPeakTaskService,
  OffPeakClientConfig,
} from "@zcode/services";
import { logger } from "@/logger.js";

// Free time task management store (independent of automationManagementStore): use IOffPeakTaskService RPC.
// The position/status is refreshed by list polling (host offPeakTaskSync writes sqlite, renderer reads only snapshots).

interface CreateOffPeakTaskInput {
  title: string;
  prompt: string;
  /**
   * The four permission levels (build/edit/plan/yolo); the type narrowing happens where the server
   * arguments are accepted.
   */
  permissionMode: string;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface UpdateOffPeakTaskInput {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  modelSelection?: ModelSelection | null;
}

/**
 * The prefill draft carried from a New task page template card click into the Automations creation
 * form (template = prefill).
 */
export interface OffPeakCreateDraft {
  title?: string;
  prompt?: string;
  telemetrySource?: {
    eventRegion: "app.session" | "app.automations";
    templateId: string;
  };
}

/**
 * The request state of availability is separate from the server quota snapshot; only ready +
 * canTakeNumber=true lets a request through.
 */
export type OffPeakTakeNumberAvailabilityStatus = "idle" | "loading" | "ready" | "error";

interface OffPeakTaskState {
  tasks: ZCodeOffPeakTask[];
  loading: boolean;
  error: string | null;
  operationId: string | null;
  /**
   * Staged-rollout configuration: null = not loaded. On a miss or when off, the entry is not
   * rendered at all.
   */
  grayConfig: OffPeakClientConfig | null;
  /**
   * Redacted credential-support snapshot of the currently selected provider/connection; contains no
   * JWT/API Key.
   */
  codingPlanSupport: OffPeakCodingPlanSupport | null;
  /** Point-in-time snapshot of the server's number quota; null = no successful response yet. */
  takeNumberAvailability: OffPeakTakeNumberAvailability | null;
  /** loading/idle/error all forbid entry, so a dependency failure is not mistaken for "creatable". */
  takeNumberAvailabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  /**
   * Whether the user has already dismissed the New task page banner in this session (it comes back
   * at the next login/restart).
   */
  newTaskBannerDismissed: boolean;
  /** Prefill draft from template card to creation form (carried once across the view navigation). */
  pendingCreateDraft: OffPeakCreateDraft | null;
  initialize(deps: {
    offPeakTaskService: IOffPeakTaskService;
    codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  }): Promise<void>;
  refresh(service: IOffPeakTaskService): Promise<void>;
  refreshCodingPlanSupport(service: IOffPeakTaskService, freshnessKey?: string): Promise<void>;
  refreshTakeNumberAvailability(service: IOffPeakTaskService): Promise<void>;
  createTask(
    input: CreateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<OffPeakTaskCreateResult>;
  updateTask(
    offPeakTaskId: string,
    input: UpdateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<boolean>;
  pauseTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  continueTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  cancelTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteHistory(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  dismissNewTaskBanner(): void;
  /**
   * Template card click: stashes the prefill draft for the Automations creation form to consume
   * (cleared once consumed).
   */
  setPendingCreateDraft(draft: OffPeakCreateDraft): void;
  consumePendingCreateDraft(): OffPeakCreateDraft | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * support must still correspond to the renderer's current selection; a stale true snapshot from
 * before a connection switch must not briefly unlock creation.
 */
export function isCurrentOffPeakCodingPlanSupported(
  support: OffPeakCodingPlanSupport | null,
  settings:
    | Pick<AppSettings, "providerFamilyConnectionSelections" | "providerFamilyDomain">
    | null
    | undefined,
): boolean {
  if (!support?.supported || !settings) return false;
  const providerFamily = normalizeProviderFamilyDomain(settings.providerFamilyDomain);
  if (!providerFamily || providerFamily !== support.providerFamily) return false;
  const selection = settings.providerFamilyConnectionSelections?.[providerFamily];
  if (selection?.kind === "individual-coding-plan") {
    return support.kind === `${providerFamily}-personal`;
  }
  if (selection?.kind === "team-coding-plan") {
    return support.kind === `${providerFamily}-team`;
  }
  return false;
}

/**
 * The server's 3103 (number quota exceeded) is recognized only by its structured category, no
 * longer by parsing cross-RPC error text.
 */
function isOffPeakQuotaError(result: OffPeakTaskCreateResult | null | undefined): boolean {
  return (
    result?.ok === false && result.errorCategory === "quota_3103" && result.errorCode === "3103"
  );
}

type OffPeakCreateErrorMessageId =
  | "offPeak.error.quota"
  | "offPeak.error.unavailable"
  | "offPeak.error.generic";

/**
 * Creation failures are mapped only from the server's explicit business codes; the raw RPC text is
 * kept for logs and never shown to the user.
 */
export function resolveOffPeakCreateErrorMessageId(
  result: OffPeakTaskCreateResult | null | undefined,
): OffPeakCreateErrorMessageId {
  if (isOffPeakQuotaError(result)) return "offPeak.error.quota";
  if (
    result?.ok === false &&
    (result.errorCategory === "network" ||
      result.errorCategory === "invalid_response" ||
      result.errorCategory === "unknown")
  ) {
    return "offPeak.error.unavailable";
  }
  return "offPeak.error.generic";
}

let initializeInFlight: Promise<void> | null = null;
let initializationReady: Promise<void> = Promise.resolve();
let eligibilityInFlight: Promise<void> | null = null;
let eligibilityGeneration = 0;
let pendingEligibilityService: IOffPeakTaskService | null = null;
let lastEligibilityTrigger: { service: IOffPeakTaskService; key: string } | null = null;

export const useOffPeakTaskStore = create<OffPeakTaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  operationId: null,
  grayConfig: null,
  codingPlanSupport: null,
  takeNumberAvailability: null,
  takeNumberAvailabilityStatus: "idle",
  newTaskBannerDismissed: false,
  pendingCreateDraft: null,

  async initialize({ offPeakTaskService, codingPlanSubscriptionService }) {
    // Bug reason: New Task and Automations may be temporarily overlapped and mounted when switching pages. Two initializes
    // There will be concurrent requests for the same Team Plan availability, and a later global 429 may overwrite an earlier successful result.
    // Store-level single-flight ensures that all entrances share a complete access check.
    if (initializeInFlight) return initializeInFlight;
    set({ loading: true, error: null });
    // Initialization and subsequent notifications share the same qualification check; grayscale is ready first, and qualifications and quotas cannot be written separately by two asynchronous chains.
    initializationReady = Promise.all([
      codingPlanSubscriptionService
        .getOffPeakClientConfig({ forceRefresh: true })
        .catch((error) => {
          logger.warn("[off-peak] gray config load failed", toErrorMessage(error));
          return null;
        }),
      offPeakTaskService.list().catch((error) => {
        logger.warn("[off-peak] list failed", toErrorMessage(error));
        return [] as ZCodeOffPeakTask[];
      }),
    ]).then(([grayConfig, tasks]) => {
      set({ grayConfig, tasks });
    });
    const run = get().refreshCodingPlanSupport(offPeakTaskService);
    initializeInFlight = run;
    try {
      await run;
    } finally {
      if (initializeInFlight === run) {
        initializeInFlight = null;
        set({ loading: false });
      }
    }
  },

  async refresh(service) {
    try {
      const tasks = await service.list();
      set({ tasks, error: null });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  refreshCodingPlanSupport(service, freshnessKey) {
    // Two portals will only check once when receiving the same Registry/connection notification; manual refresh without key will always check again.
    if (
      freshnessKey !== undefined &&
      lastEligibilityTrigger?.service === service &&
      lastEligibilityTrigger.key === freshnessKey
    ) {
      return eligibilityInFlight ?? Promise.resolve();
    }
    lastEligibilityTrigger = freshnessKey === undefined ? null : { service, key: freshnessKey };
    eligibilityGeneration += 1;
    pendingEligibilityService = service;
    set({
      codingPlanSupport: null,
      takeNumberAvailability: null,
      takeNumberAvailabilityStatus: "loading",
    });
    if (eligibilityInFlight) return eligibilityInFlight;
    // Independent support/availability requests for old code will be overwritten out of order. Serial drain merges in-flight changes,
    // Old successes and old failures are discarded; only the complete qualifications and quotas of the first generation can be released together.
    eligibilityInFlight = Promise.resolve().then(async () => {
      try {
        while (pendingEligibilityService) {
          const currentService = pendingEligibilityService;
          const generation = eligibilityGeneration;
          pendingEligibilityService = null;
          await initializationReady;
          if (generation !== eligibilityGeneration) continue;
          try {
            const codingPlanSupport = await currentService.getCodingPlanSupport();
            if (generation !== eligibilityGeneration) continue;
            const grayConfig = get().grayConfig;
            const shouldReadAvailability =
              grayConfig?.enabled &&
              (grayConfig.codingPlanActive === true || codingPlanSupport.supported === true);
            const takeNumberAvailability = shouldReadAvailability
              ? await currentService.getTakeNumberAvailability()
              : null;
            if (generation !== eligibilityGeneration) continue;
            set({
              codingPlanSupport,
              takeNumberAvailability,
              takeNumberAvailabilityStatus: shouldReadAvailability ? "ready" : "idle",
            });
          } catch (error) {
            if (generation !== eligibilityGeneration) continue;
            set({
              codingPlanSupport: null,
              takeNumberAvailability: null,
              takeNumberAvailabilityStatus: "error",
            });
            logger.warn("[off-peak] eligibility refresh failed", toErrorMessage(error));
          }
        }
      } finally {
        // Release in the same drain microtask to avoid new requests hanging on completed checks during finally queuing.
        eligibilityInFlight = null;
      }
    });
    return eligibilityInFlight;
  },

  refreshTakeNumberAvailability(service) {
    return get().refreshCodingPlanSupport(service);
  },

  async createTask(input, service) {
    set({ operationId: "offpeak:create", error: null });
    try {
      const result = await service.createTask(
        input as Parameters<IOffPeakTaskService["createTask"]>[0],
      );
      if (result.ok) {
        await Promise.all([get().refresh(service), get().refreshTakeNumberAvailability(service)]);
        return result;
      }
      // Failure to create indicates that the previous admission snapshot is no longer sufficient for continued release; only the stable classification is saved and the raw error is not put into the UI state.
      set({
        error: result.errorCategory,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
      });
      logger.warn("[off-peak] create failed", {
        errorCategory: result.errorCategory,
        errorCode: result.errorCode,
        failureStage: result.failureStage,
      });
      if (isOffPeakQuotaError(result)) {
        await get().refreshTakeNumberAvailability(service);
      }
      return result;
    } catch (error) {
      // Host/RPC transport may still fail outside of structured service results; uniform convergence to network,
      // Toast only consumes stable categories and prohibits parsing raw errors.
      const result = {
        ok: false,
        failureStage: "ticket_request",
        errorCategory: "network",
        errorCode: "",
        providerName: "",
      } as const satisfies OffPeakTaskCreateResult;
      set({
        error: result.errorCategory,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
      });
      logger.warn("[off-peak] create RPC transport failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return result;
    } finally {
      set({ operationId: null });
    }
  },

  async updateTask(offPeakTaskId, input, service) {
    set({ operationId: `offpeak:update:${offPeakTaskId}`, error: null });
    try {
      const updated = await service.updateTask(offPeakTaskId, input);
      await get().refresh(service);
      return updated !== null;
    } catch (error) {
      set({ error: toErrorMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async pauseTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:pause:${offPeakTaskId}`, error: null });
    try {
      await service.pauseTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async continueTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:continue:${offPeakTaskId}`, error: null });
    try {
      await service.continueTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async cancelTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:cancel:${offPeakTaskId}`, error: null });
    try {
      await service.cancelTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:delete:${offPeakTaskId}`, error: null });
    try {
      await service.deleteTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteHistory(offPeakTaskId, service) {
    set({
      operationId: `offpeak:delete-history:${offPeakTaskId}`,
      error: null,
    });
    try {
      await service.deleteHistory(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  dismissNewTaskBanner() {
    set({ newTaskBannerDismissed: true });
  },

  setPendingCreateDraft(draft) {
    set({ pendingCreateDraft: draft });
  },

  consumePendingCreateDraft() {
    const draft = get().pendingCreateDraft;
    if (draft) set({ pendingCreateDraft: null });
    return draft;
  },
}));
