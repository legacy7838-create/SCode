import { applyComposerPermissionGrant } from "@/v4/composer/composerPermissionGrant.js";
/* eslint-disable max-lines -- The composer draft owner closes over selection, body, and submission
 * lifecycle at once, keeping a single state boundary.
 */
// Composer's mode/model selection uses the same scope draft as the body; Session only provides an initialization seed once.
// Clicking the menu immediately saves the Renderer intent. Prewarm and Submission only consume it and do not overwrite it in reverse.
//
// Workspace presentation Hydration only provides mode and slash commands; model candidates, capabilities and preferred values
// Unified from target Host ModelSelectionView.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER, resolveExecutionState } from "@zcode/shared";
import { applyComposerPlanTransition } from "@/v4/composer/composerPlanTransition.js";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeProvider,
  ZCodeSlashCommand,
} from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * Single-flight catalog hydration (per workspaceKey): the draft, an existing session, and a
 * strict-mode double mount share one RPC.
 */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought is a subsidiary configuration of the model. Keeping the source after cutting the model will allow the barrier to be configured before the launch.
  // After the target model has been successfully cut, it will be written again as "same model explicit cut thought" and must be cleared first.
  delete next.thought;
  return next;
}

function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZCodeConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZCodeSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands belong to the workspace identity and will not be restored with the existing session projection.
  // Therefore, existing sessions must be hydrated independently as long as the directory is empty; the mode directory is no longer provided indirectly through the model directory.
  return params.slashCommands.length === 0 || !hasModePresentation;
}

interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /**
   * The config the Renderer submits next; Session only provides a seed when the scope is
   * initialized for the first time.
   */
  draftConfig: Partial<SessionConfigState>;
  /**
   * The config already selected in the draft (partial); carried through
   * buildDraftCreateConfigPayload at createSession time.
   */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /**
   * The initialization config frozen for the current draft lifecycle; used only when
   * prewarm/createSession is set up.
   */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /**
   * Once a new task is accepted, atomically transfer the current complete Root Draft into the real
   * Session scope.
   */
  promoteComposerDraft: (createdSessionId: string) => void;
  /**
   * Captures the original intent before submission; the returned function is called only after an
   * authoritative accepted.
   */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  /**
   * A session switch reads the corresponding scope; an already empty selection must still be
   * preserved.
   */
  sessionId: string | null;
  /**
   * Only the first projection matching the current Session may be used for initialization; null
   * means restoration has not finished yet.
   */
  sessionConfig?: Partial<SessionConfigState> | null;
  /**
   * An Agent may only be started after the provider registry has passed the renderer readiness
   * gate.
   */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const zcodeSessionService = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const scopeKey = JSON.stringify([workspaceKey, scopeId]);
  const loadedScope = useMemo(
    () => ({
      scopeKey,
      draft: readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId) ?? {
        text: "",
        updatedAt: 0,
      },
    }),
    [scopeKey],
  );
  const [storedState, setStoredState] = useState(loadedScope);
  let currentState = storedState.scopeKey === scopeKey ? storedState : loadedScope;
  let draft = currentState.draft;
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const initializeAsNewTask = sessionId === null || draft.initializeFromNewTask === true;
  if (!draft.mode && (initializeAsNewTask ? modelSelectionView !== null : sessionConfig != null)) {
    const mode = submissionModeSchema.safeParse(sessionConfig?.mode);
    // Recent is to initialize the original intention. If the old Provider is not still among the candidates, it will be deleted first. The next input will be read.
    // The same parsing entry corresponds to the current account, or it can be left blank temporarily. Otherwise, cold start will bypass the unified account corresponding rules.
    // mode is an initialized flag: an empty selection given by historical recovery is also a definite result and must not be filled by subsequent Snapshots.
    draft =
      initializeAsNewTask && modelSelectionView
        ? initializeNewTaskDraft(draft, workspacePath, workspaceIdentity, modelSelectionView)
        : {
            ...draft,
            mode: mode.success && mode.data !== "plan" ? mode.data : "build",
            planEnabled: resolveExecutionState(sessionConfig ?? {}).planEnabled,
            modelSelection: sessionConfig?.modelSelection,
          };
  }
  if (sessionConfig) {
    draft = applyComposerPlanTransition(draft, sessionConfig.planTransition);
    draft = applyComposerPermissionGrant(draft, sessionConfig.permissionGrant);
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // Reason: Pressing revision to clear the draft will permanently write an empty selection if it is temporarily unavailable. Only the current result is derived here,
  // Text/mode auto-save continues to save the original intent in the draft; display is retained when the read is not ready, and submission is blocked by View access.
  const effectiveSelection = modelSelectionView
    ? (modelSelectionView.effectiveSelection ?? undefined)
    : draft.modelSelection;
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode: draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [draft.mode, draft.planEnabled, effectiveSelection],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      (draft.mode || draft.initializeFromNewTask) &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, draft);
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // Delayed editor callbacks from the old scope cannot write to the session just switched to.
      if (stateRef.current.scopeKey !== scopeKey) return;
      const previous = stateRef.current.draft;
      const next = update(previous);
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, next);
      lastPersistedDraftRef.current = next;
    },
    [scopeKey, workspacePath, workspaceIdentity, scopeId],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        // This has been explicitly changed by the user and can no longer be overridden by the default initialization awaited on import.
        ...(current.initializeFromNewTask
          ? { mode: mode.success ? mode.data : "build", initializeFromNewTask: undefined }
          : {}),
      }));
    },
    [updateComposerDraft],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // Object key order is not selection identity; the protocol cannot therefore throw away accepted writebacks when reconstructing the same selection.
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // Automatic mapping is only fixed after this submission is accepted; old ACKs must not overwrite new intents or new scopes in the meantime.
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      // Undo the edit and replace the text/configuration, but do not forget the authorization that has been consumed, otherwise the old snapshot will overwrite the new selection again.
      updateComposerDraft((current) => ({
        ...replacement,
        lastPermissionGrantId: current.lastPermissionGrantId,
        updatedAt: Date.now(),
      }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (stateRef.current.scopeKey !== scopeKey || scopeId !== V4_DRAFT_SCOPE_ROOT) return;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return;
      // The Root scope was deleted directly after the initial launch, and the real Session did not have Composer Draft.
      // After remounting, initialize from Snapshot again. Write the target first, then delete the source, leaving the text/pattern/selection intact.
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        stateRef.current.draft,
      );
      if (!written) return;
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
    },
    [scopeId, scopeKey, workspaceIdentity, workspacePath],
  );

  // ── workspace directory hydration (see file header description)──
  // If the directory is ready (reload/broadcast/last hydration written), it will be skipped; otherwise, the minimum workspace presentation will be read.
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZCodeSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 directory hydration used to RPC directly without a model, although the Host would not launch the CLI,
      // The renderer will still record normal wait states as hydration errors. Remain idle when readiness fails;
      // After the registry is ready, dependency changes will automatically re-enter this effect.
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zcodeSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZCodeSessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useZCodeSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace catalog hydration failed: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeSessionService,
  ]);

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // The user clicks on the model only to determine the model identity; Reasoning has no default value and remains empty and waits for user selection.
      const modelSelection = modelSelectionView
        ? (completeNewModelSelection(modelSelectionView, parsedSelection) ?? parsedSelection)
        : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [modelSelectionView, updateDraftConfig, workspaceIdentity, workspacePath],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (mode === "plan" || mode === "plan-off") {
        updateComposerDraft((current) => ({
          ...current,
          mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
          planEnabled: mode === "plan",
          initializeFromNewTask: undefined,
        }));
        return;
      }
      // The mode and model belong to the current scope; global preferences are no longer written to avoid reverse overwriting by other tasks.
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
          initializeFromNewTask: undefined,
        }));
    },
    [updateComposerDraft],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
  };
}

/**
 * The draft config fragment of the createSession payload (returns an empty object with no config
 * key when nothing is selected).
 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
