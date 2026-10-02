/* oxlint-disable eslint(max-lines) -- the provider card hosts name, connection, auth, model, and
 * mapping editing at once; this stage keeps a single component, and it will be split by form area
 * later.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getProviderFormApiKey,
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
  type ProviderSettingsFormModel,
} from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import {
  isApiKeyAccess,
  type ProviderApiType,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { resolvePendingProviderDraftSave, type ProviderDraftValues } from "./ProviderDraftSave.js";
import {
  ProviderApiKeySection,
  ProviderCardHeader,
  ProviderConnectionSection,
  ProviderModelsSection,
} from "./ProviderCardSections.js";
import { resolveModelProviderDisplayName } from "./constants.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { useIdleTrigger } from "./useIdleTrigger.js";
import { useOptimisticReorder } from "./useOptimisticReorder.js";

type ProviderNameEditKeyAction = "commit" | "cancel";
type ProviderDraftCleanupAction = "commit" | "skip-delete";
interface ProviderSaveNotificationTarget {
  modelId?: string;
  operation?: "delete";
  /**
   * The explicit dialog retries inside the original draft, so an external notification cannot start
   * a separate save outside the editing transaction.
   */
  draftOwnsRetry?: boolean;
}

function shouldApplyProviderSaveCompletion(
  currentRevision: number,
  completedRevision: number,
): boolean {
  return currentRevision === completedRevision;
}

function resolveProviderDraftCleanupAction({
  deleteRequested,
}: {
  deleteRequested: boolean;
}): ProviderDraftCleanupAction {
  return deleteRequested ? "skip-delete" : "commit";
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function runProviderDeleteWithDraftCleanupGuard({
  deleteRequestedRef,
  onDelete,
}: {
  deleteRequestedRef: { current: boolean };
  onDelete?: () => void | Promise<void>;
}) {
  if (!onDelete) {
    return;
  }

  deleteRequestedRef.current = true;
  try {
    const result = onDelete();
    if (isPromiseLike(result)) {
      void Promise.resolve(result)
        .catch(() => undefined)
        .finally(() => {
          deleteRequestedRef.current = false;
        });
      return;
    }
  } catch (error) {
    deleteRequestedRef.current = false;
    throw error;
  }

  deleteRequestedRef.current = false;
}

function resolveProviderNameEditKeyAction(event: {
  key: string;
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): ProviderNameEditKeyAction | null {
  // The Chinese input method is still in the composition stage when using Enter to confirm the candidate.
  // The keydown flag of some platforms will be restored to false first, so the local composition status will be read at the same time.
  // Avoid interrupting candidate submissions with blur in advance, causing the original pinyin keys to be left in the name.
  if (isImeComposingKeyEvent(event)) {
    return null;
  }

  if (event.key === "Enter") {
    return "commit";
  }

  if (event.key === "Escape") {
    return "cancel";
  }

  return null;
}

function resolveVisibleProviderModelsForEdit(
  provider: ProviderSettingsFormProvider,
): ProviderSettingsFormModel[] {
  return provider.models.map((model) => structuredClone(model));
}

function projectModelsToOrder(
  models: readonly ProviderSettingsFormModel[],
  modelIds: readonly string[],
): ProviderSettingsFormModel[] {
  const byId = new Map(models.map((model) => [model.modelId, model]));
  const ordered = modelIds.flatMap((modelId) => {
    const model = byId.get(modelId);
    return model ? [model] : [];
  });
  const orderedIds = new Set(ordered.map((model) => model.modelId));
  return [...ordered, ...models.filter((model) => !orderedIds.has(model.modelId))];
}

export function InlineEditableProviderCard({
  provider,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onTestModel,
  onReorderModelIds,
  readOnlyEndpoints,
  presetApiKeyUrl,
  onOpenPresetApiKey,
  statusSection,
  nameEditable,
  headerVisible = true,
  headerActionsVisible,
  settingsRevision,
}: {
  provider: ProviderSettingsFormProvider;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormModel["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete?: () => void | Promise<void>;
  onTestModel?: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onReorderModelIds?: (modelIds: string[]) => Promise<void>;
  readOnlyEndpoints?: boolean;
  presetApiKeyUrl?: string;
  onOpenPresetApiKey?: () => void;
  statusSection?: ReactNode;
  nameEditable?: boolean;
  headerVisible?: boolean;
  headerActionsVisible?: boolean;
  settingsRevision?: number;
}) {
  const { intl } = useZCodeIntl();
  const { dismissFeedback, showFeedback } = useProviderDetailFeedback();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(getProviderFormLabel(provider));
  const [apiFormat, setApiFormat] = useState<ProviderApiType>(
    provider.config.api?.type ?? "anthropic-messages",
  );
  const [baseUrlValue, setBaseUrlValue] = useState(provider.config.api?.baseUrl ?? "");
  const [apiKeyValue, setApiKeyValue] = useState(getProviderFormApiKey(provider));
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const authoritativeModels = useMemo(
    () => resolveVisibleProviderModelsForEdit(provider),
    [provider],
  );
  const authoritativeModelIds = useMemo(
    () => authoritativeModels.map((model) => model.modelId),
    [authoritativeModels],
  );
  const reorderModelIdsTargetRef = useRef(onReorderModelIds);
  reorderModelIdsTargetRef.current = onReorderModelIds;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const nameCompositionActiveRef = useRef(false);
  const nameEditProviderIdRef = useRef<string | null>(null);
  const technicalInputCompositionActiveRef = useRef(false);
  const deleteRequestedRef = useRef(false);
  const selfSaveRequestedRef = useRef(false);
  const providerIdRef = useRef(provider.providerId);
  const dirtyProviderFieldsRef = useRef(new Set<keyof ProviderDraftValues>());
  const draftRevisionRef = useRef(0);
  const lastSubmittedDraftSignatureRef = useRef<string | null>(null);
  const providerDisplayName = resolveModelProviderDisplayName(provider);
  const saveNotificationRef = useRef({
    providerId: provider.providerId,
    providerDisplayName,
    formatMessage: intl.formatMessage,
    dismissFeedback,
    showFeedback,
  });
  saveNotificationRef.current = {
    providerId: provider.providerId,
    providerDisplayName,
    formatMessage: intl.formatMessage,
    dismissFeedback,
    showFeedback,
  };
  const draftRef = useRef<ProviderDraftValues>({
    nameValue: getProviderFormLabel(provider),
    apiFormat: provider.config.api?.type ?? "anthropic-messages",
    baseUrlValue: provider.config.api?.baseUrl ?? "",
    apiKeyValue: getProviderFormApiKey(provider),
  });

  useEffect(() => {
    const resolvedApiFormat = provider.config.api?.type ?? "anthropic-messages";
    const resolvedBaseUrl = provider.config.api?.baseUrl ?? "";
    const resolvedApiKey = getProviderFormApiKey(provider);
    const resolvedLabel = getProviderFormLabel(provider);
    if (providerIdRef.current !== provider.providerId) {
      providerIdRef.current = provider.providerId;
      nameEditProviderIdRef.current = null;
      nameCompositionActiveRef.current = false;
      setEditingName(false);
      draftRevisionRef.current += 1;
      dirtyProviderFieldsRef.current.clear();
      lastSubmittedDraftSignatureRef.current = null;
    }
    const syncField = <TKey extends keyof ProviderDraftValues>(
      key: TKey,
      value: ProviderDraftValues[TKey],
      apply: (next: ProviderDraftValues[TKey]) => void,
    ) => {
      if (dirtyProviderFieldsRef.current.has(key) && draftRef.current[key] !== value) return;
      dirtyProviderFieldsRef.current.delete(key);
      draftRef.current[key] = value;
      apply(value);
    };
    syncField("nameValue", resolvedLabel, setNameValue);
    syncField("apiFormat", resolvedApiFormat, setApiFormat);
    syncField("baseUrlValue", resolvedBaseUrl, setBaseUrlValue);
    syncField("apiKeyValue", resolvedApiKey, setApiKeyValue);
  }, [provider]);

  const markDraftDirty = useCallback((field: keyof ProviderDraftValues) => {
    dirtyProviderFieldsRef.current.add(field);
    selfSaveRequestedRef.current = false;
    draftRevisionRef.current += 1;
    saveNotificationRef.current.dismissFeedback(`provider-save:${providerIdRef.current}`);
  }, []);

  const runSaveOperation = useCallback(
    async (operation: () => Promise<void>, target: ProviderSaveNotificationTarget = {}) => {
      selfSaveRequestedRef.current = true;
      const revision = draftRevisionRef.current + 1;
      draftRevisionRef.current = revision;
      const notification = saveNotificationRef.current;
      const dedupeKey = target.modelId
        ? `model-save:${notification.providerId}:${target.modelId}`
        : `provider-save:${notification.providerId}`;
      const messageValues = {
        provider: notification.providerDisplayName,
        model: target.modelId ?? "",
      };
      const messageIds = target.modelId
        ? target.operation === "delete"
          ? {
              pending: "settings.modelProvider.modelDeleting",
              success: "settings.modelProvider.modelDeleteSuccess",
              failure: "settings.modelProvider.modelDeleteFailure",
            }
          : {
              pending: "settings.modelProvider.modelSaving",
              success: "settings.modelProvider.modelSaveSuccess",
              failure: "settings.modelProvider.modelSaveFailure",
            }
        : {
            pending: "settings.modelProvider.providerSaving",
            success: "settings.modelProvider.providerSaveSuccess",
            failure: "settings.modelProvider.providerSaveFailure",
          };
      notification.showFeedback({
        key: dedupeKey,
        message: notification.formatMessage(
          {
            id: messageIds.pending,
          },
          messageValues,
        ),
        state: "pending",
        durationMs: 0,
      });
      try {
        await operation();
        if (!shouldApplyProviderSaveCompletion(draftRevisionRef.current, revision)) return;
        notification.showFeedback({
          key: dedupeKey,
          message: notification.formatMessage(
            {
              id: messageIds.success,
            },
            messageValues,
          ),
          state: "success",
        });
      } catch (error) {
        selfSaveRequestedRef.current = false;
        if (shouldApplyProviderSaveCompletion(draftRevisionRef.current, revision)) {
          notification.showFeedback({
            key: dedupeKey,
            message: notification.formatMessage(
              {
                id: messageIds.failure,
              },
              {
                ...messageValues,
                error: error instanceof Error ? error.message : String(error),
              },
            ),
            state: "failure",
            durationMs: 8_000,
            ...(target.draftOwnsRetry
              ? {}
              : {
                  actionLabel: notification.formatMessage({ id: "common.retry" }),
                  onAction: () => {
                    void runSaveOperation(operation, target).catch(() => undefined);
                  },
                }),
            dismissible: true,
            dismissLabel: notification.formatMessage({ id: "common.close" }),
          });
        }
        throw error;
      }
    },
    // runSaveOperation participates in uninstalling the dependency chain of the saved effect. When intl/provider changes references with rendering,
    // If the callback also changes the reference, the old effect cleanup will be executed first, and then saved again to form a loop; the notification identity is read through ref.
    [],
  );

  const persistModelOrder = useCallback(
    async (modelIds: readonly string[]) => {
      const target = reorderModelIdsTargetRef.current;
      if (!target)
        throw new Error("The current settings entry is not wired with model reordering support");
      await runSaveOperation(async () => {
        await target([...modelIds]);
      });
    },
    [provider.providerId, runSaveOperation],
  );
  const optimisticModelOrder = useOptimisticReorder({
    authoritativeIds: authoritativeModelIds,
    persist: persistModelOrder,
  });

  // Members and configurations have only one copy of the Host View. The old local copy overwrites the new View on async success/failure,
  // Even briefly remove the model being edited. Keep only the explicit pending intent of the drag sequence.
  const models = useMemo(
    () => projectModelsToOrder(authoritativeModels, optimisticModelOrder.renderedIds),
    [authoritativeModels, optimisticModelOrder.renderedIds],
  );

  const saveProviderWithCleanupGuard = useCallback(
    async (nextProvider: ProviderSettingsFormProvider, onFailure?: () => void): Promise<void> => {
      const operation = async () => {
        await onSave(nextProvider);
      };
      await runSaveOperation(operation).catch((error) => {
        logger.warn("[ModelProviderSection] auto save provider draft failed", {
          providerId: provider.providerId,
          error,
        });
        onFailure?.();
        throw error;
      });
    },
    [onSave, provider.providerId, runSaveOperation],
  );

  const cancelIdleDraftSaveRef = useRef<() => void>(() => undefined);

  const commitPendingDraft = useCallback(
    async (reason: string, nameConfirmed = false): Promise<void> => {
      cancelIdleDraftSaveRef.current();
      const nextProvider = resolvePendingProviderDraftSave({
        provider,
        draft: draftRef.current,
        readOnlyEndpoints,
        nameConfirmed,
        now: Date.now,
      });
      if (!nextProvider) {
        return;
      }
      const signature = JSON.stringify({
        ...draftRef.current,
        nameValue: nameConfirmed ? draftRef.current.nameValue : getProviderFormLabel(provider),
      });
      if (lastSubmittedDraftSignatureRef.current === signature) return;
      lastSubmittedDraftSignatureRef.current = signature;

      // When clicking on the left side to switch suppliers under Linux, the input box blur and Popover closing sequence are unstable.
      // The connection draft may not be blur saved before the component is unloaded. Submit it here before switching/uninstalling.
      // Avoid "the new supplier interface address will return to empty after every move".
      logger.info("[ModelProviderSection] save unsubmitted provider draft before switching", {
        providerId: provider.providerId,
        reason,
      });
      await saveProviderWithCleanupGuard(nextProvider, () => {
        if (lastSubmittedDraftSignatureRef.current === signature) {
          lastSubmittedDraftSignatureRef.current = null;
        }
      });
    },
    [provider, readOnlyEndpoints, saveProviderWithCleanupGuard],
  );

  const idleDraftSave = useIdleTrigger(() => {
    void commitPendingDraft("idle").catch(() => undefined);
  });
  cancelIdleDraftSaveRef.current = idleDraftSave.cancel;
  const scheduleIdleDraftSave = idleDraftSave.schedule;
  const cancelIdleDraftSave = idleDraftSave.cancel;

  const handleProviderEnabledChange = async (enabled: boolean) => {
    if (savingEnabled) return;
    cancelIdleDraftSave();
    setSavingEnabled(true);
    // The same save brings the unsubmitted connection draft to avoid switching the save from overwriting the newly entered Key back to the old value.
    const draft =
      resolvePendingProviderDraftSave({
        provider,
        draft: draftRef.current,
        readOnlyEndpoints,
        now: Date.now,
      }) ?? provider;
    try {
      await saveProviderWithCleanupGuard({ ...draft, enabledUpdate: enabled });
    } catch {
      // Unified save entry has recorded errors and retry feedback; not optimistic about overwriting authority enabled.
    } finally {
      setSavingEnabled(false);
    }
  };

  useEffect(() => {
    return () => {
      cancelIdleDraftSave();
      const cleanupAction = resolveProviderDraftCleanupAction({
        deleteRequested: deleteRequestedRef.current,
      });
      if (cleanupAction === "skip-delete") {
        // Confirming the deletion will trigger the uninstallation of the details card; if cleanup continues to save the draft,
        // The deleted provider will be recreated by save after delete.
        logger.info("[ModelProviderSection] provider pending delete skips cleanup draft save", {
          providerId: provider.providerId,
        });
        return;
      }
      if (selfSaveRequestedRef.current) {
        selfSaveRequestedRef.current = false;
        // Model editing will first save the new valid model list, and then the optimistic update of the parent layer will trigger cleanup of this component.
        // If you resave the old draft at this time, the model list just submitted will be overwritten.
        logger.info("[ModelProviderSection] refresh from internal save skips cleanup draft save", {
          providerId: provider.providerId,
        });
        return;
      }
      void commitPendingDraft("cleanup").catch(() => undefined);
    };
  }, [cancelIdleDraftSave, commitPendingDraft, provider.providerId]);

  const handleNameValueChange = useCallback(
    (value: string) => {
      markDraftDirty("nameValue");
      draftRef.current.nameValue = value;
      setNameValue(value);
    },
    [markDraftDirty],
  );

  const handleBaseUrlValueChange = useCallback(
    (value: string) => {
      markDraftDirty("baseUrlValue");
      draftRef.current.baseUrlValue = value;
      setBaseUrlValue(value);
      scheduleIdleDraftSave();
    },
    [markDraftDirty, scheduleIdleDraftSave],
  );

  const handleApiKeyValueChange = useCallback(
    (value: string) => {
      markDraftDirty("apiKeyValue");
      draftRef.current.apiKeyValue = value;
      setApiKeyValue(value);
      scheduleIdleDraftSave();
    },
    [markDraftDirty, scheduleIdleDraftSave],
  );

  const handleNameBlur = useCallback(() => {
    // Esc/switch provider first cancels the editing intention, and the subsequent blur cannot be reissued and saved.
    if (nameEditProviderIdRef.current !== provider.providerId) return;
    nameEditProviderIdRef.current = null;
    setEditingName(false);
    const trimmed = draftRef.current.nameValue.trim();
    const currentLabel = getProviderFormLabel(provider);
    if (trimmed && trimmed !== currentLabel) {
      void commitPendingDraft("name-blur", true).catch(() => undefined);
    } else {
      draftRef.current.nameValue = currentLabel;
      setNameValue(currentLabel);
      dirtyProviderFieldsRef.current.delete("nameValue");
    }
  }, [commitPendingDraft, provider]);

  const handleNameKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const action = resolveProviderNameEditKeyAction({
        key: event.key,
        compositionActive: nameCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      });
      if (action === "commit") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      } else if (action === "cancel") {
        event.preventDefault();
        nameEditProviderIdRef.current = null;
        nameCompositionActiveRef.current = false;
        const label = getProviderFormLabel(provider);
        draftRef.current.nameValue = label;
        dirtyProviderFieldsRef.current.delete("nameValue");
        setNameValue(label);
        setEditingName(false);
      }
    },
    [provider],
  );

  const handleStartEditName = useCallback(() => {
    nameEditProviderIdRef.current = provider.providerId;
    nameCompositionActiveRef.current = false;
    setEditingName(true);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [provider.providerId]);

  const saveConnection = useCallback(
    () => void commitPendingDraft("connection-blur").catch(() => undefined),
    [commitPendingDraft],
  );

  const handleApiFormatChange = useCallback(
    (value: ProviderApiType) => {
      markDraftDirty("apiFormat");
      draftRef.current.apiFormat = value;
      setApiFormat(value);
      void commitPendingDraft("api-format-change").catch(() => undefined);
    },
    [commitPendingDraft, markDraftDirty],
  );

  const handleApiKeyBlur = useCallback(() => {
    void commitPendingDraft("api-key-blur").catch(() => undefined);
  }, [commitPendingDraft]);

  const handleTextCommitKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    // Enter for candidate confirmation cannot be treated as a form submission. local ref override
    // Timing of nativeEvent.isComposing changing back to false prematurely on Electron/macOS.
    if (
      isImeComposingKeyEvent({
        compositionActive: technicalInputCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      })
    ) {
      return;
    }
    event.currentTarget.blur();
  }, []);
  const handleTechnicalInputCompositionStart = useCallback(() => {
    technicalInputCompositionActiveRef.current = true;
  }, []);
  const handleTechnicalInputCompositionEnd = useCallback(() => {
    technicalInputCompositionActiveRef.current = false;
  }, []);

  const handleTestModel = useCallback(
    async (model: string): Promise<ModelConnectivityResult> => {
      if (!onTestModel) {
        return Promise.resolve({
          success: false,
          error: { message: "Model connectivity test is unavailable" },
        });
      }

      // The connection test once handed the Renderer model snapshot to the outer layer for re-save, bypassing the model draft.
      // revision boundary. Now only the draft of the only Provider of this card is flushed; the Service will wait for the same Provider
      // After the operation queue and Registry are refreshed, create a Model based on the official providerId/modelId.
      await commitPendingDraft("connectivity-test");
      return onTestModel(provider.providerId, model);
    },
    [commitPendingDraft, onTestModel, provider.providerId],
  );

  const handleModelCommit = useCallback(
    async (
      originalModelId: string,
      nextModel: ProviderSettingsFormModel,
      basedOnRevision: number,
    ): Promise<void> => {
      const trimmed = nextModel.modelId.trim();
      const index = models.findIndex((model) => model.modelId === originalModelId);
      const currentModel = models[index];
      if (!currentModel || !trimmed || !onSavePersonalModelDraft) {
        throw new Error(
          "The current settings entry is not wired with atomic model draft saving support",
        );
      }
      const next = [...models];
      next[index] = { ...nextModel, modelId: trimmed, hasPersonalConfig: true };
      if (JSON.stringify(next) === JSON.stringify(models)) {
        return;
      }
      await runSaveOperation(
        async () => {
          await onSavePersonalModelDraft({
            providerId: provider.providerId,
            originalModelId: currentModel.modelId,
            nextModelId: trimmed,
            personalConfig: structuredClone(nextModel.personalConfig),
            ...(nextModel.useRecommendedConfig === undefined
              ? {}
              : { useRecommendedConfig: nextModel.useRecommendedConfig }),
            basedOnRevision,
          });
        },
        { modelId: trimmed, draftOwnsRetry: true },
      );
    },
    [models, onSavePersonalModelDraft, provider.providerId, runSaveOperation],
  );

  const handleDeleteModel = useCallback(
    (modelId: string) => {
      const index = models.findIndex((model) => model.modelId === modelId);
      const model = models[index];
      if (!model) {
        return;
      }
      if (!model.builtin) {
        void runSaveOperation(
          async () => {
            if (!onDeletePersonalModel)
              throw new Error(
                "The current settings entry is not wired with personal model deletion support",
              );
            await onDeletePersonalModel(provider.providerId, model.modelId);
          },
          { modelId: model.modelId, operation: "delete" },
        ).catch((error) => {
          logger.warn("[ModelProviderSection] delete personal model failed", {
            providerId: provider.providerId,
            modelId: model.modelId,
            error,
          });
        });
        return;
      }
    },
    [models, onDeletePersonalModel, provider.providerId, runSaveOperation],
  );

  const handleModelEnabledChange = useCallback(
    async (modelId: string, enabled: boolean) => {
      if (!onSetPersonalModelEnabled)
        throw new Error(
          "The current settings entry is not wired with model enable/disable support",
        );
      await runSaveOperation(
        () =>
          onSetPersonalModelEnabled(provider.providerId, modelId, enabled).then(() => undefined),
        { modelId },
      );
    },
    [onSetPersonalModelEnabled, provider.providerId, runSaveOperation],
  );

  const handleAddModel = useCallback(
    async (model: ProviderSettingsFormModel) => {
      if (!onAddPersonalModel)
        throw new Error(
          "The current settings entry is not wired with personal model adding support",
        );
      const added = { ...model, modelId: model.modelId.trim(), hasPersonalConfig: true };
      if (!added.modelId) return;
      await runSaveOperation(
        async () => {
          await onAddPersonalModel(
            provider.providerId,
            added.modelId,
            structuredClone(added.personalConfig),
            added.useRecommendedConfig,
          );
        },
        { modelId: added.modelId, draftOwnsRetry: true },
      );
    },
    [onAddPersonalModel, provider.providerId, runSaveOperation],
  );

  const handleReorderModelIds = useCallback(
    (modelIds: string[]) => {
      if (!onReorderModelIds) return;
      void optimisticModelOrder.commit(modelIds).catch((error) => {
        logger.warn("[ModelProviderSection] save personal model order failed", {
          providerId: provider.providerId,
          error,
        });
      });
    },
    [onReorderModelIds, optimisticModelOrder, provider.providerId],
  );

  const handleDeleteProvider = useCallback(() => {
    runProviderDeleteWithDraftCleanupGuard({
      deleteRequestedRef,
      onDelete,
    });
  }, [onDelete]);

  const headerProviderName = providerDisplayName;
  const isAccountProvider = provider.config.access?.type === "zhipu-account";
  // A Template can pin a built-in credential (e.g. the OpenCode Free anonymous `public` key). Such a
  // Provider is usable without any user-supplied key, so the card must not offer an API-key input at
  // all — editing it would silently swap the built-in credential for a broken one.
  const isApiKeyProvider =
    isApiKeyAccess(provider.config.access) && provider.config.access.apiKeyEditable !== false;
  const effectiveHeaderVisible = headerVisible && statusSection === undefined;

  return (
    <div className="space-y-3">
      {effectiveHeaderVisible ? (
        <ProviderCardHeader
          providerName={headerProviderName}
          logo={provider.config.logo}
          editingName={editingName}
          nameValue={nameValue}
          nameInputRef={nameInputRef}
          nameEditable={nameEditable}
          onNameChange={handleNameValueChange}
          onNameBlur={handleNameBlur}
          onNameKeyDown={handleNameKeyDown}
          onNameCompositionStart={() => {
            nameCompositionActiveRef.current = true;
          }}
          onNameCompositionEnd={() => {
            nameCompositionActiveRef.current = false;
          }}
          onStartEditName={handleStartEditName}
          onDelete={onDelete ? handleDeleteProvider : undefined}
          actionsVisible={headerActionsVisible}
          providerToggle={
            isAccountProvider ? undefined : (
              <ControlHintTooltip
                standalone
                title={intl.formatMessage({
                  id: provider.enabled
                    ? "settings.modelProvider.disableProvider"
                    : "settings.modelProvider.enableProvider",
                })}
              >
                {/* The Tooltip's data-state must not overwrite the Switch's checked state, otherwise the track styling disappears. */}
                <span className="inline-flex">
                  <Switch
                    // The sharing switch is expanded by 12px on the left and right sides, which will cover the adjacent menu; this title bar only retains a 4px horizontal hot zone.
                    className="after:-inset-x-1"
                    data-testid="model-provider-enabled-switch"
                    aria-label={intl.formatMessage({
                      id: provider.enabled
                        ? "settings.modelProvider.disableProvider"
                        : "settings.modelProvider.enableProvider",
                    })}
                    checked={provider.enabled}
                    disabled={savingEnabled}
                    onCheckedChange={(enabled) => {
                      void handleProviderEnabledChange(enabled);
                    }}
                  />
                </span>
              </ControlHintTooltip>
            )
          }
        />
      ) : null}

      {statusSection}

      <div className="space-y-3">
        {isAccountProvider ? null : (
          <ProviderConnectionSection
            provider={provider}
            readOnly={readOnlyEndpoints}
            apiFormat={apiFormat}
            baseUrlValue={baseUrlValue}
            onApiFormatChange={handleApiFormatChange}
            onBaseUrlChange={handleBaseUrlValueChange}
            onBaseUrlBlur={saveConnection}
            onBaseUrlKeyDown={handleTextCommitKeyDown}
            onBaseUrlCompositionStart={handleTechnicalInputCompositionStart}
            onBaseUrlCompositionEnd={handleTechnicalInputCompositionEnd}
          />
        )}

        {isApiKeyProvider ? (
          <ProviderApiKeySection
            apiKeyValue={apiKeyValue}
            apiKeyVisible={apiKeyVisible}
            presetApiKeyUrl={presetApiKeyUrl}
            onOpenPresetApiKey={onOpenPresetApiKey}
            onApiKeyChange={handleApiKeyValueChange}
            onApiKeyBlur={handleApiKeyBlur}
            onApiKeyKeyDown={handleTextCommitKeyDown}
            onApiKeyCompositionStart={handleTechnicalInputCompositionStart}
            onApiKeyCompositionEnd={handleTechnicalInputCompositionEnd}
            onToggleApiKeyVisibility={() => setApiKeyVisible((value) => !value)}
          />
        ) : null}

        <ProviderModelsSection
          // Different Providers can have models with the same name; open drafts and versions from the previous provider cannot be reused.
          key={provider.providerId}
          providerId={provider.providerId}
          providerName={getProviderFormLabel(provider)}
          providerEnabled={provider.enabled}
          providerAccess={provider.config.access}
          models={models}
          onTestModel={onTestModel ? handleTestModel : undefined}
          onModelCommit={handleModelCommit}
          onModelEnabledChange={handleModelEnabledChange}
          onDeleteModel={handleDeleteModel}
          onAddModel={handleAddModel}
          onReorderModelIds={onReorderModelIds ? handleReorderModelIds : undefined}
          settingsRevision={settingsRevision ?? 0}
        />
      </div>
    </div>
  );
}
