import { useState, useCallback, useMemo, useRef } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import {
  projectProviderSettingsViewToFormProviders,
  resolveProviderSettingsFormProviders,
  resolveProviderOrdering,
} from "@/lib/providerSettingsFormProjection.js";
import { persistProviderDisplayOrder } from "@/lib/providerDisplayOrderPersistence.js";
import { persistPersonalProviderDeletion } from "@/lib/providerPersonalPersistence.js";
import { persistPersonalProvider } from "@/lib/providerPersonalSave.js";
import type { ProviderOrderView } from "@/lib/modelProviderOrdering.js";

export function useModelProviders(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Local cwd used by the local Provider Settings connectivity test; the remote activation path is not reused. */
  connectivityWorkspacePath?: string;
  /** Under remote activation with no local cwd, fail closed instead of falling back to the remote workspacePath. */
  connectivityWorkspaceRequired?: boolean;
  /** Localized message shown to the user when no local workspace is available. */
  connectivityUnavailableMessage?: string;
}) {
  const { providerSettingsService } = useServices();
  const providerSettingsRead = useProviderSettingsServiceView(providerSettingsService);
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const effectiveModelProviders = useMemo(
    () =>
      resolveProviderSettingsFormProviders({
        view: providerSettingsView,
      }),
    [providerSettingsView],
  );
  const providerOrdering = useMemo(
    () =>
      resolveProviderOrdering({
        view: providerSettingsView,
        providers: effectiveModelProviders,
      }),
    [effectiveModelProviders, providerSettingsView],
  );
  const commitProviderSettingsView = useCallback(
    (view: ProviderSettingsView): void => {
      // The mutation's returned view is the authoritative view of the refreshed target Environment;
      // relying only on onDidChange leaves a pre-deletion UI snapshot when the attachment is swapped or the event is lost.
      // Commit the returned view uniformly at the hook boundary; useProviderSettingsServiceView still does the Service/revision guard.
      providerSettingsRead.commit(view);
    },
    [providerSettingsRead.commit],
  );
  const [refreshing, setRefreshing] = useState(false);
  const latestRefreshTokenRef = useRef(0);

  const refresh = useCallback(async () => {
    const refreshToken = latestRefreshTokenRef.current + 1;
    latestRefreshTokenRef.current = refreshToken;
    setRefreshing(true);
    try {
      const view = await providerSettingsService.refresh("settings-manual");
      commitProviderSettingsView(view);
    } catch (err) {
      logger.error("[useModelProviders] failed to load model providers", err);
    } finally {
      // When the user triggers refresh repeatedly, an older request may return first.
      // Without a token guard, the older request's finally would clear refreshing early, making the title's loading hint flicker off.
      if (refreshToken === latestRefreshTokenRef.current) {
        setRefreshing(false);
      }
    }
  }, [commitProviderSettingsView, providerSettingsService]);

  const saveProvider = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      // A newly created Provider is not yet in the Registry, so it naturally does not appear in the current Settings View.
      // The save boundary allows a missing inheritance layer and builds the full config directly from the new-provider form.
      const savedView = await persistPersonalProvider({ provider, providerSettingsService });
      commitProviderSettingsView(savedView);
      return projectProviderSettingsViewToFormProviders(savedView);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const createPersonalProvider = useCallback(
    async (input?: Parameters<typeof providerSettingsService.createPersonalProvider>[0]) => {
      const created = await providerSettingsService.createPersonalProvider(input);
      commitProviderSettingsView(created.view);
      return created;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const addPersonalModel = useCallback(
    (
      providerId: string,
      modelId: string,
      config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
      useRecommendedConfig?: boolean,
    ) =>
      providerSettingsService
        .addPersonalModel(providerId, modelId, config, useRecommendedConfig)
        .then((view) => {
          commitProviderSettingsView(view);
          return view;
        }),
    [commitProviderSettingsView, providerSettingsService],
  );

  const savePersonalModelDraft = useCallback(
    async (input: Parameters<typeof providerSettingsService.savePersonalModelDraft>[0]) => {
      const view = await providerSettingsService.savePersonalModelDraft(input);
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const setPersonalModelEnabled = useCallback(
    async (providerId: string, modelId: string, enabled: boolean) => {
      const view = await providerSettingsService.setPersonalModelEnabled(
        providerId,
        modelId,
        enabled,
      );
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const deletePersonalModel = useCallback(
    async (providerId: string, modelId: string) => {
      const view = await providerSettingsService.deletePersonalModel(providerId, modelId);
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      const view = await persistPersonalProviderDeletion({
        providerId: id,
        providerSettingsService,
      });
      commitProviderSettingsView(view);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const reorderProviderModels = useCallback(
    async (providerId: string, modelIds: readonly string[]) => {
      const view = await providerSettingsService.reorderPersonalModels(providerId, modelIds);
      commitProviderSettingsView(view);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const saveDisplayOrder = useCallback(
    async (state: ProviderOrderView) => {
      const normalizedState: ProviderOrderView = {
        providerIds: [...new Set(state.providerIds.map((id) => id.trim()).filter(Boolean))],
      };
      try {
        const view = await persistProviderDisplayOrder({
          state: normalizedState,
          providerSettingsService,
        });
        commitProviderSettingsView(view);
      } catch (err) {
        logger.warn("[useModelProviders] failed to save Personal Provider order", err);
        throw err;
      }
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const testModelConnectivity = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      const connectivityWorkspacePath = target.connectivityWorkspacePath?.trim();
      if (
        !connectivityWorkspacePath &&
        (target.connectivityWorkspaceRequired || target.workspaceIdentity?.trim())
      ) {
        return {
          success: false,
          error: {
            message:
              target.connectivityUnavailableMessage ??
              "A local workspace is unavailable for connectivity testing.",
          },
        };
      }
      return providerSettingsService.testModelConnectivity({
        workspacePath: connectivityWorkspacePath || target.workspacePath,
        providerId,
        modelId,
      });
    },
    [
      providerSettingsService,
      target.connectivityUnavailableMessage,
      target.connectivityWorkspacePath,
      target.connectivityWorkspaceRequired,
      target.workspacePath,
      target.workspaceIdentity,
    ],
  );

  return {
    modelProviders: effectiveModelProviders,
    providerTemplates: providerSettingsView?.providerTemplates ?? [],
    displayOrder: providerOrdering.displayOrder,
    reorderableProviderIds: providerOrdering.reorderableProviderIds,
    loading: providerSettingsRead.state.status === "loading",
    loadError:
      providerSettingsRead.state.status === "error" ? providerSettingsRead.state.error : null,
    reload: providerSettingsRead.reload,
    refreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    testModelConnectivity,
    providerSettingsView,
  };
}
