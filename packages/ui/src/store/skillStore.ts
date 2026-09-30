import { create } from "zustand";
import {
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  type ZCodeProvider,
  type SkillSummary,
  type SkillsCapability,
} from "@zcode/shared";
import type { ISkillsService } from "@zcode/services";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { logger } from "@/logger.js";

interface SkillStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  provider: ZCodeProvider;
  loadedProvider: ZCodeProvider | null;
  skills: SkillSummary[];
  capability: SkillsCapability | null;
  loading: boolean;
  error: string | null;
  initialize: (
    workspacePath: string,
    providerOrSkillsService: ZCodeProvider | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (skillsService: ISkillsService, workspaceIdentity?: string) => Promise<void>;
  setEnabled: (
    skillId: string,
    providerOrEnabled: ZCodeProvider | boolean,
    scopeOrSkillsService: SkillSummary["scope"] | ISkillsService,
    enabledOrSkillsService?: boolean | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
}

const inFlightSkillLoads = new Map<string, ReturnType<ISkillsService["list"]>>();

function getSkillLoadKey(
  workspacePath: string,
  provider: ZCodeProvider,
  workspaceIdentity?: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}::${provider}`;
}

function loadSkillsOnce(
  workspacePath: string,
  provider: ZCodeProvider,
  skillsService: ISkillsService,
  workspaceIdentity?: string,
  options: { bypassCache?: boolean } = {},
): ReturnType<ISkillsService["list"]> {
  const key = getSkillLoadKey(workspacePath, provider, workspaceIdentity);
  if (!options.bypassCache) {
    const current = inFlightSkillLoads.get(key);
    if (current) {
      return current;
    }
  }
  // After copying/removing skills to the general directory, refresh must get the latest results.
  // If you reuse in-flight Promise, old scan results will be returned, causing chat mention to not be able to see the newly added skills.
  const request = skillsService.list({ workspacePath, workspaceIdentity, provider }).finally(() => {
    // Only clean up when you are currently active in-flight to avoid overwriting other concurrent requests.
    if (inFlightSkillLoads.get(key) === request) {
      inFlightSkillLoads.delete(key);
    }
  });
  inFlightSkillLoads.set(key, request);
  return request;
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  provider: ZCODE_AGENT_PROVIDER,
  loadedProvider: null,
  skills: [],
  capability: null,
  loading: false,
  error: null,
  async initialize(
    workspacePath: string,
    providerOrSkillsService: ZCodeProvider | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) {
    const currentState = get();
    const hasProvider = typeof providerOrSkillsService === "string";
    const provider = normalizeAgentProviderToZCodeAgent(
      hasProvider ? providerOrSkillsService : ZCODE_AGENT_PROVIDER,
    );
    const skillsService = hasProvider ? maybeSkillsService : providerOrSkillsService;
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    if (!skillsService) {
      set({
        workspacePath,
        workspaceIdentity: normalizedWorkspaceIdentity,
        provider,
        loading: false,
        error: "skillsService is required",
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
      return;
    }
    const hasCachedSkills =
      currentState.skills.length > 0 &&
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      currentState.loadedProvider === provider;
    // initialize is triggered when agent filtering is switched.
    // Previously, loading=true would be cleared to "Loading" before rendering the result, causing the list to flicker.
    // Here it is changed to "Only caches of the same workspace+provider are allowed to be reused" to prevent the previous set of skills from being mistakenly displayed in the current session.
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      provider,
      skills: hasCachedSkills ? currentState.skills : [],
      capability: hasCachedSkills ? currentState.capability : null,
      loading: !hasCachedSkills,
      error: null,
    });
    try {
      // The chat input area will mount multiple skill consumers at the same time (such as $ mention and / panel).
      // Previously, their first screens would trigger the same list request concurrently, thereby amplifying the service layer image synchronization competition into user-visible errors.
      // Here, press workspace+provider to remove duplicates, and only one request result will be reused in the same round.
      const result = await loadSkillsOnce(
        workspacePath,
        provider,
        skillsService,
        normalizedWorkspaceIdentity ?? undefined,
      );
      set({
        skills: result.skills,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    } catch (error) {
      logger.error("[skills] initialize failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    }
  },
  async refresh(skillsService: ISkillsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const provider = normalizeAgentProviderToZCodeAgent(get().provider);
    const hasCachedSkills = get().skills.length > 0;
    // After switching the skill on and off, refresh will be triggered. Before, loading was set to true every time.
    // The Settings list will first switch to "Loading" and then switch back to data, and the user will see the entire list flash.
    // Here it is changed to "Only display blocking loading when there is no cache for the first time". When there is cache, the background is refreshed and the current list is retained.
    set({ loading: !hasCachedSkills, error: null });
    // refresh must ensure that the "latest" server result is obtained.
    // Calling loadSkillsOnce directly will reuse the old in-flight request.
    // As a result, chat mention still sees the old list after copying the skill to the general directory.
    // Here, the in-flight cache is explicitly skipped during refresh, forcing a new request to be initiated.
    inFlightSkillLoads.delete(getSkillLoadKey(workspacePath, provider, workspaceIdentityFromState));
    try {
      const result = await loadSkillsOnce(
        workspacePath,
        provider,
        skillsService,
        workspaceIdentityFromState,
      );
      set({
        skills: result.skills,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    } catch (error) {
      logger.error("[skills] refresh failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    }
  },
  async setEnabled(
    skillId: string,
    providerOrEnabled: ZCodeProvider | boolean,
    scopeOrSkillsService: SkillSummary["scope"] | ISkillsService,
    enabledOrSkillsService?: boolean | ISkillsService,
    maybeSkillsService?: ISkillsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const legacyCall = typeof providerOrEnabled === "boolean";
    const provider = normalizeAgentProviderToZCodeAgent(
      legacyCall ? get().provider : providerOrEnabled,
    );
    const scope = legacyCall ? undefined : (scopeOrSkillsService as SkillSummary["scope"]);
    const enabled = legacyCall ? providerOrEnabled : (enabledOrSkillsService as boolean);
    const skillsService = legacyCall
      ? (scopeOrSkillsService as ISkillsService)
      : maybeSkillsService;
    if (!skillsService) {
      set({ error: "skillsService is required" });
      return;
    }
    try {
      await skillsService.setEnabled({
        workspacePath,
        workspaceIdentity: workspaceIdentityFromState,
        provider,
        ...(scope ? { scope } : {}),
        skillId,
        enabled,
      });
      await get().refresh(skillsService, workspaceIdentityFromState);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

type SkillStoreE2EBridge = typeof useSkillStore;

declare global {
  interface Window {
    __skillStoreE2E?: SkillStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // The E2E diagnostic entry must be opened explicitly by WDIO, and ZCODE_ENV=test cannot be reused to prevent the product test environment from exposing the variable global store.
  window.__skillStoreE2E = useSkillStore;
}
