import type { SessionCreateSource } from "@zcode/shared";
/* eslint-disable max-lines -- Workspace-level state actions are concentrated in the same slice, and the lines are kept closed for maintenance. */
import {
  buildNativeSupplierKey,
  normalizeAgentProviderToZCodeAgent,
  type ZCodeConfigOption,
  type ModelSelectionResolution,
  type ZCodeProvider,
  type ZCodeSlashCommand,
  type ZCodeTaskMeta,
  type ZCodeTaskRuntimeStatus,
  type ZCodeWorkspaceInitStatus,
} from "@zcode/shared";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { pushNavEntry } from "@/lib/taskNavigationHistory.js";
import { resolveTaskRestorePreloadConfigOptions } from "@/lib/taskModelRecovery.js";
import type {
  ZCodeSessionStoreState,
  ConfigOptionsStatus,
  ComposerMentionPrefill,
  GroupedDraftTaskState,
  GroupedDraftTaskPlacement,
  ModelSwitchStage,
  WorkspaceZCodeUIState,
} from "@/store/zcodeSessionStoreTypes.js";
import {
  getTaskMeta,
  getWorkspaceState,
  getWorkspaceInitState,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

let groupedDraftSequence = 0;

function createGroupedDraftId(createdAt: number): string {
  groupedDraftSequence += 1;
  return `grouped-draft-${createdAt}-${groupedDraftSequence}`;
}

function normalizeThoughtLevelConfigOption(option: ZCodeConfigOption): ZCodeConfigOption {
  if (
    option.type !== "select" ||
    (option.id !== "thought_level" && option.category !== "thought_level")
  ) {
    return option;
  }
  const currentValue = typeof option.currentValue === "string" ? option.currentValue : "";
  if (option.options?.some((entry) => entry.value === currentValue)) {
    return option;
  }
  const fallbackValue = option.options?.[0]?.value;
  if (!fallbackValue) {
    return option;
  }
  // In the model switching race state, thought_level may be temporarily empty; the store is unified to prevent the toolbar Select from entering an empty selection state.
  return { ...option, currentValue: fallbackValue };
}

function normalizeConfigOptions(options: ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map(normalizeThoughtLevelConfigOption);
}

function cloneConfigOptions(options: readonly ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map((option) => ({
    ...option,
    options: option.options?.map((entry) => ({ ...entry })),
  }));
}

function isSameGroupedDraftPlacement(
  left: GroupedDraftTaskPlacement,
  right: GroupedDraftTaskPlacement,
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "top") {
    return true;
  }
  return right.type === "group" && left.groupId === right.groupId;
}

function isModeConfigOption(option: ZCodeConfigOption): boolean {
  return option.category === "mode" && option.type === "select";
}

function createFallbackModeOption(params: {
  currentModeId: string;
  options?: NonNullable<ZCodeConfigOption["options"]>;
}): ZCodeConfigOption {
  const options = params.options?.length
    ? params.options
    : [{ value: params.currentModeId, name: params.currentModeId }];
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: params.currentModeId,
    options,
  };
}

function replaceModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  nextModeOption: ZCodeConfigOption | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const modeIndex = options.findIndex(isModeConfigOption);
  if (modeIndex === -1) {
    if (!nextModeOption) {
      return currentOptions;
    }
    return normalizeConfigOptions([...options, nextModeOption]);
  }

  if (!nextModeOption) {
    return normalizeConfigOptions([
      ...options.slice(0, modeIndex),
      ...options.slice(modeIndex + 1),
    ]);
  }

  return normalizeConfigOptions([
    ...options.slice(0, modeIndex),
    nextModeOption,
    ...options.slice(modeIndex + 1),
  ]);
}

function updateCurrentModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  modeId: string | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const existingModeOption = options.find(isModeConfigOption);
  if (!modeId) {
    if (!existingModeOption) {
      return currentOptions;
    }
    if ((existingModeOption.options?.length ?? 0) === 0) {
      return replaceModeConfigOption(currentOptions, null);
    }
    return replaceModeConfigOption(currentOptions, {
      ...existingModeOption,
      currentValue: "",
    });
  }

  if (!existingModeOption) {
    return replaceModeConfigOption(
      currentOptions,
      createFallbackModeOption({ currentModeId: modeId }),
    );
  }

  return replaceModeConfigOption(currentOptions, {
    ...existingModeOption,
    currentValue: modeId,
  });
}

function updateActiveTaskConfigOptions(
  current: WorkspaceZCodeUIState,
  updater: (options: ZCodeConfigOption[] | null) => ZCodeConfigOption[] | null,
): Pick<WorkspaceZCodeUIState, "taskConfigOptionsByTaskId"> | null {
  const activeTaskId = current.activeTaskId;
  if (!activeTaskId) {
    return null;
  }

  const currentTaskOptions = current.taskConfigOptionsByTaskId[activeTaskId];
  if (!currentTaskOptions) {
    return null;
  }

  const nextTaskOptions = updater(currentTaskOptions);
  if (nextTaskOptions === currentTaskOptions || !nextTaskOptions) {
    return null;
  }

  return {
    taskConfigOptionsByTaskId: {
      ...current.taskConfigOptionsByTaskId,
      [activeTaskId]: nextTaskOptions,
    },
  };
}

function resolveActiveTaskConfigOptionsOnSwitch(
  current: WorkspaceZCodeUIState,
  taskId: string,
): { configOptions: ZCodeConfigOption[]; status: ConfigOptionsStatus } | null {
  const cachedTaskConfigOptions = current.taskConfigOptionsByTaskId[taskId];
  if (cachedTaskConfigOptions) {
    return {
      configOptions: cachedTaskConfigOptions,
      status: current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready",
    };
  }

  const taskMeta = getTaskMeta(current, taskId);
  // When switching to a historical task, the toolbar model and context usage come from different status buckets.
  // When there is no task-level settings cache, first use task meta to warm up the model, and enter loading to wait for the running state settings to be backfilled.
  // Avoid continuing to display the model of the previous task (such as glm-0531[1m]) with the contextWindow of the current task.
  const preloadedOptions = normalizeConfigOptions(
    resolveTaskRestorePreloadConfigOptions({
      taskMeta: {
        provider: taskMeta?.provider ?? current.selectedProvider,
        model: taskMeta?.model,
        mode: taskMeta?.mode,
        thoughtLevel: taskMeta?.thoughtLevel,
      },
    }),
  );
  if (preloadedOptions.length === 0) {
    return null;
  }

  return {
    configOptions: preloadedOptions,
    status: "loading",
  };
}

export function createWorkspaceSlice(set: SetFn) {
  return {
    setActiveTaskId: (workspacePath: string, id: string | null, workspaceIdentity?: string) => {
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [id ?? ""]: _ignoredUnreadTask, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const optimisticTask = id ? current.optimisticTaskListByTaskId[id] : undefined;
            const nextOptimisticTaskListByTaskId =
              id && typeof optimisticTask?.unreadAt === "number"
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [id]: {
                      ...optimisticTask,
                      // Right-clicking to mark unread will write unreadAt to the optimistic task at the same time;
                      // Previously, when the current task was repeatedly opened, only the old unread map was cleared, and the list was merged from the optimistic task
                      // Write the blue dot back. This projection must be cleared in the same workspace transaction when opening a task.
                      unreadAt: undefined,
                    },
                  }
                : current.optimisticTaskListByTaskId;
            const activeTaskId = id;
            const activeTaskConfig = activeTaskId
              ? resolveActiveTaskConfigOptionsOnSwitch(current, activeTaskId)
              : null;
            const nextState = {
              ...current,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              activeTaskId: id,
              // The grouped New task draft line is just the current draft state anchor.
              // Once the user selects a real task, it means leaving this temporary entity and must be cleared immediately to avoid leaving inoperable fake rows in the sidebar.
              groupedDraftTask: id ? null : current.groupedDraftTask,
            };
            return activeTaskId && activeTaskConfig
              ? {
                  ...nextState,
                  taskConfigOptionsByTaskId: {
                    ...current.taskConfigOptionsByTaskId,
                    [activeTaskId]: activeTaskConfig.configOptions,
                  },
                  taskConfigOptionsStatusByTaskId: {
                    ...current.taskConfigOptionsStatusByTaskId,
                    [activeTaskId]: activeTaskConfig.status,
                  },
                }
              : nextState;
          },
          workspaceIdentity,
        );

        const navUpdate = id
          ? {
              taskNavHistory: pushNavEntry(
                state.taskNavHistory,
                workspacePath,
                id,
                workspaceIdentity,
              ),
            }
          : {};

        return { ...workspaceUpdate, ...navUpdate };
      });
    },

    promoteGroupedDraftTask: (
      workspacePath: string,
      taskId: string,
      draft: GroupedDraftTaskState,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTask: ZCodeTaskMeta = {
              taskId,
              traceId: `session-${taskId}` as ZCodeTaskMeta["traceId"],
              title: "",
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              createdAt: draft.createdAt,
              // This is a renderer placeholder line only used to fill the ACK gap, not the session reality.
              // updatedAt uses the lowest sentinel value to ensure that any sessions-index authoritative meta will be in
              // Win in mergeTaskWithOptimisticMeta to prevent the local clock from suppressing fields such as mode/provider/status.
              updatedAt: 0,
              mode: "build",
              provider: current.selectedProvider,
            };
            // Task navigation and draft session creation are different state transitions. Only create success boundaries
            // Only in this way can the grouped placement captured when initiating the command be bound to the new task. ACK return period user
            // Another draft may have been entered, so the current draft is only cleared if identity still matches.
            // In the past, the draft row was cleared first, but the real task meta could not be found until sessions-index.
            // A gap will pop up between create/send ACK and authoritative projection. Promote transactions while writing minimal optimistic metadata,
            // But the conversation state is not faked, and the follow-up is still closed by desktop continuous / web replayable authoritative projection.
            return {
              ...current,
              groupedDraftTask:
                current.groupedDraftTask?.draftId === draft.draftId
                  ? null
                  : current.groupedDraftTask,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // task_created may arrive at the renderer earlier than command ACK; if more complete optimistic metadata is available,
                // Cannot be reverse degraded by this minimal line which is only used for gap filling.
                [taskId]: current.optimisticTaskListByTaskId[taskId] ?? optimisticTask,
              },
              promotedGroupedDraftTaskByTaskId: {
                ...current.promotedGroupedDraftTaskByTaskId,
                [taskId]: draft,
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    clearPromotedGroupedDraftTask: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (!current.promotedGroupedDraftTaskByTaskId[taskId]) {
              return current;
            }
            // Promoted placement is only responsible for a single transaction before draft promotion to SQLite sorting convergence.
            // It must be consumed after being dropped into the library to avoid being pulled back to the original group by the old placement when the user manually drags the task later.
            const { [taskId]: _consumedPromotedDraft, ...restPromotedGroupedDraftTaskByTaskId } =
              current.promotedGroupedDraftTaskByTaskId;
            return {
              ...current,
              promotedGroupedDraftTaskByTaskId: restPromotedGroupedDraftTaskByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setDraftSessionId: (
      workspacePath: string,
      sessionId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.draftSessionId === sessionId) {
              return current;
            }
            return { ...current, draftSessionId: sessionId };
          },
          workspaceIdentity,
        ),
      );
    },

    invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // The protocol-v4 draft warm-up session only exists in the SessionPane and cannot be cleared.
            // legacy draftSessionId. The incremental version lets the pane accurately recycle unpromoted warmup sessions and rebuild the capacity snapshot.
            draftRuntimeInvalidationVersion: current.draftRuntimeInvalidationVersion + 1,
            draftSessionId: null,
          }),
          workspaceIdentity,
        ),
      );
    },

    requestComposerTextInsert: (
      workspacePath: string,
      text: string,
      workspaceIdentity?: string,
      mention?: ComposerMentionPrefill,
      mode?: "replace" | "prepend-if-missing",
    ) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.composerTextInsertVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              composerTextInsertVersion: requestId,
              composerTextInsertRequest: {
                requestId,
                text,
                ...(mention ? { mention } : {}),
                ...(mode ? { mode } : {}),
              },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearComposerTextInsertRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.composerTextInsertRequest?.requestId === requestId
              ? { ...current, composerTextInsertRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    requestTimelineBottom: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.timelineBottomRequestVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              timelineBottomRequestVersion: requestId,
              timelineBottomRequest: { requestId, taskId },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearTimelineBottomRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.timelineBottomRequest?.requestId === requestId
              ? { ...current, timelineBottomRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    startDraft: (
      workspacePath: string,
      provider?: ZCodeProvider,
      workspaceIdentity?: string,
      options?: {
        groupedDraftPlacement?: GroupedDraftTaskPlacement;
        createSource?: SessionCreateSource;
      },
    ) => {
      const normalizedProvider = provider
        ? normalizeAgentProviderToZCodeAgent(provider)
        : undefined;

      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextSelectedProvider = normalizeAgentProviderToZCodeAgent(
              normalizedProvider ?? current.selectedProvider,
            );
            const shouldResetSupplierForDraftProvider =
              Boolean(normalizedProvider) && nextSelectedProvider !== current.selectedProvider;
            const shouldClearSlashCommands =
              current.activeTaskId !== null || shouldResetSupplierForDraftProvider;
            const shouldInheritActiveTaskConfig =
              current.activeTaskId !== null && !shouldResetSupplierForDraftProvider;
            const activeTaskIdForInheritance = shouldInheritActiveTaskConfig
              ? current.activeTaskId
              : null;
            const cachedActiveTaskConfigOptions = activeTaskIdForInheritance
              ? current.taskConfigOptionsByTaskId[activeTaskIdForInheritance]
              : null;
            const inheritedConfigOptions = activeTaskIdForInheritance
              ? cachedActiveTaskConfigOptions && cachedActiveTaskConfigOptions.length > 0
                ? cachedActiveTaskConfigOptions
                : // The configuration of the current task of protocol-v4 may only complete the workspace projection.
                  // The legacy task cache has not been written yet or is still an empty array for the first frame. The toolbar is now displayed
                  // current.configOptions, the new draft must inherit from the current projection and cannot be seedless.
                  current.configOptions
              : null;
            const inheritedDraftConfigOptions =
              inheritedConfigOptions && inheritedConfigOptions.length > 0
                ? cloneConfigOptions(inheritedConfigOptions)
                : null;
            const inheritedConfigOptionsStatus =
              current.activeTaskId && inheritedDraftConfigOptions
                ? (current.taskConfigOptionsStatusByTaskId[current.activeTaskId] ?? "ready")
                : current.configOptionsStatus;
            const nextGroupedDraftTask = (() => {
              const placement = options?.groupedDraftPlacement;
              if (!placement) {
                return null;
              }
              if (
                current.activeTaskId === null &&
                current.groupedDraftTask &&
                isSameGroupedDraftPlacement(current.groupedDraftTask.placement, placement)
              ) {
                return current.groupedDraftTask;
              }
              if (current.activeTaskId === null && current.groupedDraftTask) {
                // The same grouped draft can be repositioned by different New task entries.
                // Continuously clicking on the same entry will reuse the temporary entity, but when switching from the global entry to the group entry, the creation position must follow the latest entry.
                return {
                  ...current.groupedDraftTask,
                  workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  placement,
                };
              }
              const createdAt = Date.now();
              return {
                draftId: createGroupedDraftId(createdAt),
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                placement,
                createdAt,
              };
            })();
            return {
              ...current,
              activeTaskId: null,
              groupedDraftTask: nextGroupedDraftTask,
              draftCreateSource:
                options?.createSource ?? (options?.groupedDraftPlacement ? "group" : "session"),
              draftRuntime: { status: "idle", error: null },
              // When clicking New Task from an existing task, the draft input box must inherit the complete configuration of the current task.
              // Otherwise, the subsequent workspace prepare will rebuild the draft according to the Team Plan/default model and bounce deepseek into GLM.
              ...(inheritedDraftConfigOptions
                ? {
                    configOptions: inheritedDraftConfigOptions,
                    configOptionsStatus: inheritedConfigOptionsStatus,
                    // Old deferred draft sessions may still be stuck at the last default model.
                    // After inheriting the active task, the draft session must be re-created to prevent the old session from overwriting the new draft.
                    draftSessionId: null,
                  }
                : {}),
              draftError: null,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
              // Cmd/Ctrl+N or "New Task" in the task list only switched the store state before and did not explicitly return the focus to the input box.
              // Electron menu and button clicks take focus away first, causing the user to see that Draft is open, but the cursor takes a beat to come back.
              // Here, the version number is incremented each time it enters the draft state, so that ChatView can actively focus on the Lexical input box after the state switch is completed.
              draftFocusVersion: current.draftFocusVersion + 1,
              optimisticMessages: [],
              // The new task state (taskId=null) now also has its own unsent draft.
              // When switching to the draft state here, it only resets the "transient state of this created task" and does not actively clear the null scope draft.
              // In this way, when the user switches back to "New Task" from taskA/B/C, he can continue to edit the content that was not sent just now.
              // If you continue to use the slashCommands of the previous session when creating a new draft, you will see the commands left over from the old task when you enter `/`.
              // But in the past, every time "New Task" was unconditionally cleared here, repeated clicks in the draft state would clear the command list and would not trigger backfill.
              // Only clear it when "switching from task to draft" or "really switching provider" to avoid accidental damage by repeated clicks on the same draft state.
              ...(shouldClearSlashCommands ? { slashCommands: [] } : {}),
              ...(normalizedProvider ? { selectedProvider: nextSelectedProvider } : {}),
              ...(shouldResetSupplierForDraftProvider
                ? {
                    // Some "New Task" entries will transparently pass the current selectedProvider back to startDraft.
                    // If the provider does not actually change but the supplier is forcibly reset, a tearing state of "the custom model is displayed but the custom option is locked" will appear.
                    // Here, we only return to native when the provider is actually switched to avoid accidentally damaging the existing supplier context by creating a new draft with the same provider.
                    selectedSupplierKey: buildNativeSupplierKey(nextSelectedProvider),
                    isGhostSupplier: false,
                    supplierMismatchReason: null,
                  }
                : {}),
            };
          },
          workspaceIdentity,
        ),
      );
    },

    clearGroupedDraftTask: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.groupedDraftTask ? { ...current, groupedDraftTask: null } : current,
          workspaceIdentity,
        ),
      );
    },

    bindRuntimeProvider: (
      workspacePath: string,
      provider: ZCodeProvider,
      workspaceIdentity?: string,
    ) =>
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedProvider: normalizeAgentProviderToZCodeAgent(provider),
          }),
          workspaceIdentity,
        ),
      ),

    setModelSelectionResolution: (
      workspacePath: string,
      resolution: Pick<
        ModelSelectionResolution,
        "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
      >,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedSupplierKey: resolution.selectedSupplierKey,
            isGhostSupplier: resolution.isGhostSupplier,
            supplierMismatchReason: resolution.supplierMismatchReason,
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitState: (
      workspacePath: string,
      status: ZCodeWorkspaceInitStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitAttempts: (
      workspacePath: string,
      attempts: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              attempts,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskState: (
      workspacePath: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            draftRuntime: {
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setDraftError: (
      workspacePath: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // When the draft state first fails, there is no taskId. If the error only remains in the component memory,
            // If you switch to another page and come back, you won't be able to see it. Save a separate copy of workspace-level draftError,
            // Ensure that "error of uncreated task" can continue to be displayed in the current workspace.
            draftError: error,
          }),
          workspaceIdentity,
        ),
      );
    },

    startModelSwitch: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage = "settingModel",
      workspaceIdentity?: string,
      options?: { pending?: boolean },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            modelSwitchRequestId: requestId,
            // Ordinary session/setModel already updates the UI optimistically first, and only needs the requestId to prevent the old return packet from overwriting the new selection.
            // Only heavy paths such as custom provider and runtime restart need to set the toolbar to loading.
            modelSwitchPending: options?.pending ?? true,
            modelSwitchStage: stage,
          }),
          workspaceIdentity,
        ),
      );
    },

    updateModelSwitchStage: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchStage: stage,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setConfigOptions: (
      workspacePath: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const normalizedOptions = normalizeConfigOptions(options);
        const skipped = areConfigOptionsEquivalent(current.configOptions, normalizedOptions);
        if (skipped) {
          // When there is no API key/the old model is unavailable, the toolbar recovery effect will submit the same empty model configuration multiple times.
          // Equivalent configurations should not trigger workspace-level store notifications, otherwise ChatInputToolbar will setConfigOptions again in the effect.
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // startDraft first saves the warm-up seed of the active task, and then the asynchronous directory hydration will go here.
            // Directory refresh is not the end of the draft life cycle, and the seed cannot be cleared, otherwise createSession will fall back to the global default model.
            configOptions: normalizedOptions,
          }),
          workspaceIdentity,
        );
      });
    },

    setConfigOptionsStatus: (
      workspacePath: string,
      status: "idle" | "loading" | "ready" | "error",
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            configOptionsStatus: status,
          }),
          workspaceIdentity,
        ),
      );
    },

    setSlashCommands: (
      workspacePath: string,
      commands: ZCodeSlashCommand[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            slashCommands: commands,
          }),
          workspaceIdentity,
        ),
      );
    },

    setCurrentModeId: (
      workspacePath: string,
      modeId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextConfigOptions = updateCurrentModeConfigOption(current.configOptions, modeId);
            const activeTaskPatch = updateActiveTaskConfigOptions(current, (options) =>
              updateCurrentModeConfigOption(options, modeId),
            );
            if (nextConfigOptions === current.configOptions && !activeTaskPatch) {
              return current;
            }
            return {
              ...current,
              configOptions: nextConfigOptions,
              // The active task running state will ignore workspace_config_options_update.
              // First-send/restore may first write the task configuration containing only the model.
              // mode_update is the session fact source and must be synchronized to the task configuration bucket, otherwise the mode entry will disappear after being sent.
              ...activeTaskPatch,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListVersion: current.taskListVersion + 1,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskListCache: (
      workspacePath: string,
      tasks: ZCodeTaskMeta[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListCache: tasks,
            // The true source of unread has been uniformly converged to task meta.unreadAt.
            // Here, the list cache is no longer rebuilt into another "unread truth source" to avoid cache refresh and partial optimistic update from fighting each other.
            taskUnreadByTaskId: current.taskUnreadByTaskId,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskUnreadIndicator: (
      workspacePath: string,
      taskId: string,
      hasUnread: boolean,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTaskMeta = current.optimisticTaskListByTaskId[taskId];
            const cachedTaskMeta = current.taskListCache?.find((task) => task.taskId === taskId);
            const baseTaskMeta = optimisticTaskMeta ?? cachedTaskMeta;
            const currentHasUnread = current.taskUnreadByTaskId[taskId] === true;
            const currentUnreadAt = optimisticTaskMeta?.unreadAt ?? cachedTaskMeta?.unreadAt;

            if (hasUnread) {
              const nextUnreadAt = baseTaskMeta?.unreadAt ?? Date.now();
              if (currentHasUnread && currentUnreadAt === nextUnreadAt) {
                return current;
              }

              const nextOptimisticTaskListByTaskId = baseTaskMeta
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [taskId]: {
                      ...baseTaskMeta,
                      unreadAt: nextUnreadAt,
                    },
                  }
                : current.optimisticTaskListByTaskId;

              return {
                ...current,
                optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
                taskUnreadByTaskId: {
                  ...current.taskUnreadByTaskId,
                  [taskId]: true,
                },
              };
            }

            if (!currentHasUnread && currentUnreadAt === undefined) {
              // After the permission is confirmed, both the local response and the stream response will be cleared as unread.
              // When it has been read, directly reuse the workspace state to avoid meaningless refresh of the task list and ChatView.
              return current;
            }

            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const nextOptimisticTaskListByTaskId = baseTaskMeta
              ? {
                  ...current.optimisticTaskListByTaskId,
                  [taskId]: {
                    ...baseTaskMeta,
                    unreadAt: undefined,
                  },
                }
              : current.optimisticTaskListByTaskId;

            return {
              ...current,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
