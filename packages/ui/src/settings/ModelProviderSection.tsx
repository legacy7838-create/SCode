/* eslint-disable max-lines -- The Model Provider settings page needs to orchestrate the navigation,
 * forms and OAuth interactions in one place; they will be converged when the whole thing is split
 * up later.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getProviderFormApiKey,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  DesktopCommandIds,
  isStartPlanModelProviderId,
  type BuiltinModelProviderId,
  type ModelConnectivityResult,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type OAuthProviderId,
  resolveModelProviderFamilyIdByProviderId,
  resolveModelProviderFamilySpecByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import {
  PRESET_PROVIDER_SPECS,
  PRESET_SUBSCRIPTION_TIMEOUT_MS,
  BIGMODEL_REGISTRATION_URL,
  type CodingPlanStatus,
  type ModelProviderNavGroup,
} from "./model-provider-section/constants.js";
import { ModelProviderSectionDetail } from "./model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import type { CodingPlanLoginOptions } from "./model-provider-section/codingPlanPricingCards.js";
import { useModelProviderNavigation } from "./model-provider-section/useModelProviderNavigation.js";
import { reportPresetSubscriptionSuccess } from "./model-provider-section/oauthActions.js";
import {
  createCodingPlanProviderNodeKey,
  createCustomProviderNodeKey,
  createPresetProviderNodeKey,
} from "./model-provider-section/utils.js";
import {
  confirmAndDeleteModelProvider,
  refreshModelProviderSection,
  refreshProviderPanelAfterAuthChange as refreshModelProviderPanelAfterAuthChange,
} from "./model-provider-section/modelProviderActions.js";
import {
  useCodingPlanAccessRefresh,
  useCodingPlanEntitlements,
} from "./model-provider-section/useCodingPlanEntitlements.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

type CodingPlanConnectionNavItem = Extract<
  ModelProviderNavGroup["items"][number],
  { type: "codingPlan" | "teamPlan" }
>;

function resolveCodingPlanProviderSyncAttemptKey({
  activeOAuthProvider,
  oauthProviderId,
  providerId,
}: {
  activeOAuthProvider: OAuthProviderId | null;
  oauthProviderId: OAuthProviderId;
  providerId: BuiltinModelProviderId;
}): string | null {
  if (activeOAuthProvider !== oauthProviderId) {
    return null;
  }
  // The operation identity only consists of stable provider/auth facts, and it is prohibited to put display status such as checking into the key.
  return `${providerId}:${activeOAuthProvider}`;
}

function shouldRetryUnchangedCodingPlanProviderSync({
  attemptKey,
  attemptStatus,
  modeUnchanged,
  selectedKeyUnchanged,
}: {
  attemptKey: string | null;
  attemptStatus: "inFlight" | "succeeded" | "failed" | undefined;
  modeUnchanged: boolean;
  selectedKeyUnchanged: boolean;
}): boolean {
  return modeUnchanged && selectedKeyUnchanged && attemptKey !== null && attemptStatus === "failed";
}

function resolveCodingPlanIntentProviderId(
  target: SettingsModelProviderTarget | undefined,
): BuiltinModelProviderId | null {
  switch (target?.providerId) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return target.providerId;
    default:
      return null;
  }
}

function shouldRefreshCodingPlanEntitlementsAfterSave(
  previousProvider: ProviderSettingsFormProvider | undefined,
  nextProvider: ProviderSettingsFormProvider,
): boolean {
  const isCodingPlanProvider =
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  if (!isCodingPlanProvider) {
    return false;
  }

  // UI configurations such as enabled/name/models do not change the entitlement query credentials.
  // Saving any Coding Plan field before will refresh the state, causing the sidebar to briefly enter loading and flush the current selection.
  return (
    (previousProvider ? getProviderFormApiKey(previousProvider).trim() : "") !==
    getProviderFormApiKey(nextProvider).trim()
  );
}

function resolveBuiltinPresetOAuthProvider(
  presetId: BuiltinModelProviderId,
): OAuthProviderId | null {
  if (
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  ) {
    return ZAI_PROVIDER_ID;
  }
  if (
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  ) {
    return BIGMODEL_PROVIDER_ID;
  }
  return null;
}

function shouldShowPresetProviderForActiveOAuth(
  presetId: BuiltinModelProviderId,
  providerFamilyDomain: ProviderFamilyDomain | null | undefined,
): boolean {
  const presetOAuthProvider = resolveBuiltinPresetOAuthProvider(presetId);
  if (!providerFamilyDomain || !presetOAuthProvider) {
    return true;
  }
  return resolveModelProviderFamilyIdByProviderId(presetId) === providerFamilyDomain;
}

function clearPendingProviderFamilyConnectionSelection(
  selections: ProviderFamilyConnectionSelectionSettings,
  familyId: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
): ProviderFamilyConnectionSelectionSettings {
  if (JSON.stringify(selections[familyId]) !== JSON.stringify(selection)) {
    return selections;
  }
  const { [familyId]: _removed, ...rest } = selections;
  return rest;
}

function resolveProviderFamilySideNodeKey(providerId: BuiltinModelProviderId): string | null {
  if (isStartPlanModelProviderId(providerId)) return createCodingPlanProviderNodeKey(providerId);
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  return familySpec ? createPresetProviderNodeKey(familySpec.startPlanProviderId) : null;
}

function resolveConnectionSelectionForNavItem(
  item: Extract<
    ModelProviderNavGroup["items"][number],
    { type: "preset" | "codingPlan" | "teamPlan" }
  >,
): ProviderFamilyConnectionSelection | null {
  if (item.type === "preset") return null;
  if (item.type === "teamPlan") {
    const productId = item.currentProductId?.trim() ?? "";
    const organizationId = item.organizationId?.trim() ?? "";
    const projectId = item.projectId?.trim() ?? "";
    return productId && organizationId && projectId
      ? { kind: "team-coding-plan", productId, organizationId, projectId }
      : null;
  }
  return isStartPlanModelProviderId(item.presetId) ? null : { kind: "individual-coding-plan" };
}

function resolveModelProviderSideSelectionKey(
  item: ModelProviderNavGroup["items"][number],
): string {
  if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
    return item.key;
  }
  if (
    item.type === "preset" ||
    (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId))
  )
    return item.key;
  return resolveProviderFamilySideNodeKey(item.presetId) ?? item.key;
}

/**
 * The Model Provider settings only receive a Local Host injected by SettingsPage; this component
 * does not take a workspaceIdentity, so that a remote workspace cannot mistakenly route Provider
 * Settings reads/writes to a remote Environment.
 */
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const { modelSelectionService, oauthService, credentialService } = useServices();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing: modelProvidersRefreshing,
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
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const entitledAccountProviderIds = useMemo<ReadonlySet<string>>(() => {
    return new Set(
      (providerSettingsView?.providers ?? [])
        .filter(
          (provider) =>
            provider.effectiveConfig.access?.type === "zhipu-account" &&
            provider.effectiveConfig.access.entitled === true,
        )
        .map((provider) => provider.providerId),
    );
  }, [providerSettingsView]);
  const providerConnectionRefreshSignal = providerSettingsView?.revision;
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [invalidProviderTarget, setInvalidProviderTarget] = useState(() =>
    Boolean(
      initialModelProviderTarget && !resolveCodingPlanIntentProviderId(initialModelProviderTarget),
    ),
  );
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(() => {
    const providerId = resolveCodingPlanIntentProviderId(initialModelProviderTarget);
    return providerId ? resolveProviderFamilySideNodeKey(providerId) : null;
  });
  const [presetSubscriptionProviderId, setPresetSubscriptionProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const [codingPlanStatusSyncProviderId, setCodingPlanStatusSyncProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const [codingPlanDisconnectProviderId, setCodingPlanDisconnectProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  // Dead code cleanup: refreshToken is only consumed by the offline native purchase panel, and only setters are retained here.
  // refreshCodingPlanProducts contract call after login/unbinding (keeping shared helper signature unchanged).
  const [, setCodingPlanProductsRefreshToken] = useState(0);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);

  useEffect(() => {
    if (
      !pendingCreatedProviderId ||
      !modelProviders.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      return;
    }
    // saveProvider will first publish the shared snapshot and then asynchronously download it; React may submit first under high load
    // selectedNodeKey, then submit the provider list. Navigation correction will roll back the custom key that does not exist temporarily.
    // New providers that appear subsequently will no longer be automatically selected. Selection and draft cleanup are only done after the list fact is visible.
    setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
    setPendingCreatedProviderId(null);
  }, [modelProviders, pendingCreatedProviderId]);

  const applyModelProviderTarget = useCallback(
    (target: SettingsModelProviderTarget | undefined) => {
      if (!target) return false;
      const providerId = resolveCodingPlanIntentProviderId(target);
      if (!providerId) {
        // Unknown IDs cannot just be silently ignored: if the pending directive is not consumed, external input errors will trap navigation.
        // Only errors are displayed, the current operable page and persistent connection are retained, and subsequent legal navigation/manual selection can be restored.
        logger.warn("[ModelProviderSection] cannot open target provider", {
          providerId: target.providerId,
        });
        setInvalidProviderTarget(true);
        setTemplatePickerOpen(false);
        return true;
      }

      setInvalidProviderTarget(false);
      setTemplatePickerOpen(false);
      setSelectedNodeKey(resolveProviderFamilySideNodeKey(providerId));
      return true;
    },
    [],
  );

  useEffect(() => {
    if (!pendingModelProviderTarget) {
      return;
    }
    if (applyModelProviderTarget(pendingModelProviderTarget)) {
      onConsumePendingModelProviderTarget?.();
    }
  }, [applyModelProviderTarget, onConsumePendingModelProviderTarget, pendingModelProviderTarget]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section !== "modelProvider") {
          return;
        }
        applyModelProviderTarget(
          detail?.modelProviderId
            ? {
                providerId: detail.modelProviderId,
              }
            : undefined,
        );
      }),
    [applyModelProviderTarget],
  );
  const [
    codingPlanPurchaseTokenAuthenticatedByProviderId,
    setCodingPlanPurchaseTokenAuthenticatedByProviderId,
  ] = useState<Partial<Record<BuiltinModelProviderId, boolean>>>({});
  const [activeOAuthProvider, setActiveOAuthProvider] = useState<OAuthProviderId | null>(null);
  const [pendingConnectionSelections, setPendingConnectionSelections] =
    useState<ProviderFamilyConnectionSelectionSettings>({});
  const presetSubscriptionCompletionProviderIdRef = useRef<BuiltinModelProviderId | null>(null);
  const codingPlanStatusSyncAttemptsRef = useRef(
    new Map<string, "inFlight" | "succeeded" | "failed">(),
  );
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const setUser = useZCodeStore((state) => state.setUser);
  const oauthError = useZCodeStore((state) => state.oauthError);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const {
    settings: sharedSettings,
    loading: sharedSettingsLoading,
    error: sharedSettingsError,
    update: updateSharedSettings,
  } = useSettings();
  const authenticatedEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "bigmodel",
  });
  // zai and bigmodel Team Plan symmetrization. Originally, only bigmodel adjusted hooks.
  // The zai team subscription can never pull in or display the corresponding team.
  // Zai adjusts the hook independently (zai family uses zai provider), and the subscription products of the two families are merged downstream.
  const authenticatedZaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "zai",
  });
  const refreshAuthenticatedEnterpriseProducts = useCallback(async () => {
    await Promise.all([
      authenticatedEnterpriseProducts.refresh(),
      authenticatedZaiEnterpriseProducts.refresh(),
    ]);
  }, [authenticatedEnterpriseProducts, authenticatedZaiEnterpriseProducts]);
  const subscribedTeamProducts = useMemo(
    () => [
      ...(authenticatedEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(authenticatedZaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [
      authenticatedEnterpriseProducts.snapshot?.productList,
      authenticatedZaiEnterpriseProducts.snapshot?.productList,
    ],
  );
  const connectionSelections = sharedSettings?.providerFamilyConnectionSelections ?? {};
  const familyConnectionSettingsFailed = sharedSettingsError !== null && sharedSettings === null;
  const effectiveConnectionSelections = useMemo(
    () => ({
      ...connectionSelections,
      ...pendingConnectionSelections,
    }),
    [connectionSelections, pendingConnectionSelections],
  );
  // Originally only checked whether bigmodel selectedKey is team plan, zai team key
  // Purchased team fallback will never be triggered. Change to any family that has a persistent team key and it will be displayed.
  const showPurchasedTeamPlanFallback = Boolean(
    effectiveConnectionSelections.bigmodel?.kind === "team-coding-plan" ||
    effectiveConnectionSelections.zai?.kind === "team-coding-plan",
  );
  const effectiveProviderFamilyDomain =
    sharedSettings?.providerFamilyDomain ??
    resolveProviderFamilyDomainFromOAuthProvider(activeOAuthProvider);
  const { entitlements: codingPlanEntitlements, refresh: refreshCodingPlanEntitlements } =
    useCodingPlanEntitlements({
      providerSettingsView,
      connectionSelections: effectiveConnectionSelections,
      suppressProviderFingerprintAutoRefresh: codingPlanStatusSyncProviderId !== null,
    });
  useEffect(() => {
    setPendingConnectionSelections((current) => {
      let next = current;
      for (const [familyId, selection] of Object.entries(current) as Array<
        [ProviderFamilyDomain, ProviderFamilyConnectionSelection]
      >) {
        if (JSON.stringify(connectionSelections[familyId]) !== JSON.stringify(selection)) {
          continue;
        }
        // After clicking the API Key/Coding Plan tab, settings placement and hook refresh are asynchronous.
        // Wait until the persistent snapshot has really caught up before clearing pending to avoid the old mode temporarily correcting the selected item back and causing flickering.
        next = clearPendingProviderFamilyConnectionSelection(next, familyId, selection);
      }
      return next;
    });
  }, [connectionSelections]);

  const refreshCodingPlanProducts = useCallback(() => {
    setCodingPlanProductsRefreshToken((current) => current + 1);
  }, []);

  const refreshCodingPlanPurchaseTokenState = useCallback(
    async (
      options: {
        clearUserWhenLoggedOut?: boolean;
        shouldApply?: () => boolean;
      } = {},
    ) => {
      const [activeProvider, zaiToken, bigmodelToken] = await Promise.all([
        credentialService.load("oauth:active_provider"),
        credentialService.load(`oauth:${ZAI_PROVIDER_ID}:access_token`),
        credentialService.load(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`),
      ]);
      if (options.shouldApply && !options.shouldApply()) {
        return null;
      }
      const normalizedActiveProvider =
        activeProvider === ZAI_PROVIDER_ID || activeProvider === BIGMODEL_PROVIDER_ID
          ? activeProvider
          : null;
      setActiveOAuthProvider(normalizedActiveProvider);
      setCodingPlanPurchaseTokenAuthenticatedByProviderId({
        [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]:
          normalizedActiveProvider === ZAI_PROVIDER_ID && (zaiToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]:
          normalizedActiveProvider === BIGMODEL_PROVIDER_ID &&
          (bigmodelToken?.trim().length ?? 0) > 0,
      });
      if (!normalizedActiveProvider && options.clearUserWhenLoggedOut) {
        // provider Unlink is equivalent to App logout.
        // After the server token has been cleared, the Zustand user must also be cleared on the settings page, otherwise the sidebar will always display the old login status until restarted.
        setUser(null);
        setOAuthError(null);
      }
      return normalizedActiveProvider;
    },
    [credentialService, setOAuthError, setUser],
  );

  const refreshProviderPanelAfterAuthChange = useCallback(
    async ({
      refreshPlanSnapshots = true,
      refreshReason = "auth",
    }: {
      refreshPlanSnapshots?: boolean;
      refreshReason?: "auth" | "purchase";
    }) => {
      await refreshModelProviderPanelAfterAuthChange({
        refreshModelProviders: refresh,
        refreshCodingPlanEntitlements: () =>
          refreshCodingPlanEntitlements({ force: true, reason: refreshReason }),
        refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
        refreshCodingPlanProducts,
        refreshPurchaseTokenState: refreshCodingPlanPurchaseTokenState,
        refreshPlanSnapshots,
      });
    },
    [
      refresh,
      refreshAuthenticatedEnterpriseProducts,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
      refreshModelProviderPanelAfterAuthChange,
    ],
  );

  const syncCodingPlanProviderOnce = useCallback(
    async (
      item: CodingPlanConnectionNavItem,
      options: { userTransition?: boolean; refreshPlanSnapshots?: boolean } = {},
    ) => {
      const attemptKey = resolveCodingPlanProviderSyncAttemptKey({
        activeOAuthProvider,
        oauthProviderId: item.oauthProviderId,
        providerId: item.presetId,
      });
      if (!attemptKey) {
        return;
      }
      if (
        options.userTransition !== true &&
        codingPlanStatusSyncAttemptsRef.current.has(attemptKey)
      ) {
        return;
      }
      codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "inFlight");
      setCodingPlanStatusSyncProviderId(item.presetId);
      try {
        await refreshProviderPanelAfterAuthChange({
          refreshPlanSnapshots: options.refreshPlanSnapshots,
        });
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "succeeded");
      } catch (error) {
        // Failure status must be retained explicitly. Automatic hydration will not retry after seeing failed.
        // When the user clicks the same connection item again, it can automatically restore according to the failed status.
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "failed");
        throw error;
      } finally {
        setCodingPlanStatusSyncProviderId((current) =>
          current === item.presetId ? null : current,
        );
      }
    },
    [activeOAuthProvider, refreshProviderPanelAfterAuthChange],
  );

  useEffect(() => {
    let disposed = false;

    void refreshCodingPlanPurchaseTokenState({
      shouldApply: () => !disposed,
    });

    return () => {
      disposed = true;
    };
  }, [providerConnectionRefreshSignal, refreshCodingPlanPurchaseTokenState]);

  const presetProviders = useMemo(
    () =>
      PRESET_PROVIDER_SPECS.filter((preset) =>
        shouldShowPresetProviderForActiveOAuth(preset.id, effectiveProviderFamilyDomain),
      ).map((preset) => ({
        ...preset,
        provider: modelProviders.find((provider) => provider.providerId === preset.id) ?? null,
      })),
    [effectiveProviderFamilyDomain, modelProviders],
  );

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    const accountEntitled = Boolean(
      resolveEntitledAccountProviderAccess(providerSettingsView, presetSubscriptionProviderId),
    );
    if (accountEntitled) {
      if (presetSubscriptionCompletionProviderIdRef.current === presetSubscriptionProviderId) {
        return;
      }

      presetSubscriptionCompletionProviderIdRef.current = presetSubscriptionProviderId;
      void (async () => {
        void reportPresetSubscriptionSuccess({
          platform,
          presetId: presetSubscriptionProviderId,
        });
        try {
          // After the connection/re-authorization is successful, the provider apiKey will be placed before the equity interface results.
          // Pending must wait until this round of equity refresh is completed before clearing it, otherwise the Plan Card will briefly display the old package status or non-loading status.
          await refreshProviderPanelAfterAuthChange({});
        } finally {
          presetSubscriptionCompletionProviderIdRef.current = null;
          setCodingPlanStatusSyncProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
          setPresetSubscriptionProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
        }
      })();
    }
  }, [
    platform,
    presetSubscriptionProviderId,
    providerSettingsView,
    refreshProviderPanelAfterAuthChange,
  ]);

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setCodingPlanStatusSyncProviderId((current) =>
        current === presetSubscriptionProviderId ? null : current,
      );
      setPresetSubscriptionProviderId((current) => {
        if (current !== presetSubscriptionProviderId) {
          return current;
        }
        return null;
      });
    }, PRESET_SUBSCRIPTION_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [presetSubscriptionProviderId]);

  const { navigationGroups, navigationItems, selectedNavItem, navigationUnavailable } =
    useModelProviderNavigation({
      presetProviders,
      modelProviders,
      entitledAccountProviderIds,
      modelProvidersLoading: loading,
      displayOrder,
      codingPlanEntitlements,
      subscribedTeamProducts,
      providerFamilyDomain: effectiveProviderFamilyDomain,
      connectionSelections: effectiveConnectionSelections,
      pendingConnectionSelections,
      showPurchasedTeamPlanFallback,
      familyConnectionSettingsLoading: sharedSettingsLoading && sharedSettings === null,
      familyConnectionSettingsFailed,
      selectedNodeKey,
      setSelectedNodeKey,
      intl,
    });
  const selectedPlanAccessKey =
    selectedNavItem?.type === "codingPlan" || selectedNavItem?.type === "teamPlan"
      ? selectedNavItem.key
      : null;
  // The package card is corrected on demand every time it is opened by the user; the shared freshness window is guaranteed to be switched back within one minute.
  // Quota requests will not be amplified. Benefit display update does not mean that the user reopens the package.
  useCodingPlanAccessRefresh({
    refresh: refreshCodingPlanEntitlements,
    selectedPlanKey: selectedPlanAccessKey,
  });

  useEffect(() => {
    if (selectedNavItem?.type !== "codingPlan" && selectedNavItem?.type !== "teamPlan") {
      return;
    }
    if (
      activeOAuthProvider !== selectedNavItem.oauthProviderId ||
      presetSubscriptionProviderId === selectedNavItem.presetId ||
      codingPlanDisconnectProviderId === selectedNavItem.presetId
    ) {
      return;
    }

    const accountEntitled = selectedNavItem.accountEntitled === true;
    if (accountEntitled) {
      return;
    }

    // This is the first hydration correction and is not a state machine driven by the detail status.
    // The same provider/OAuth combination is only executed once, and switching back and forth between checking and the final state cannot be restarted and refreshed.
    void syncCodingPlanProviderOnce(selectedNavItem).catch((error) => {
      logger.warn("[ModelProviderSection] auto sync coding plan provider failed", {
        providerId: selectedNavItem.presetId,
        error,
      });
    });
  }, [
    activeOAuthProvider,
    codingPlanDisconnectProviderId,
    presetSubscriptionProviderId,
    selectedNavItem,
    syncCodingPlanProviderOnce,
  ]);

  const handleSave = useCallback(
    async (config: ProviderSettingsFormProvider) => {
      try {
        const previousProvider = modelProviders.find(
          (provider) => provider.providerId === config.providerId,
        );
        // The non-executable configuration does not mean that the user logs out of the account; the account domain must not be cleared when saving, otherwise the package will not be ready for reselection.
        await saveProvider(config);
        if (shouldRefreshCodingPlanEntitlementsAfterSave(previousProvider, config)) {
          refreshCodingPlanEntitlements();
        }
      } catch (error) {
        logger.error("[ModelProviderSection] save model provider failed", error);
        throw error;
      }
    },
    [modelProviders, refreshCodingPlanEntitlements, saveProvider],
  );

  const handleDelete = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await confirmAndDeleteModelProvider({
        provider,
        confirmDialog,
        intl,
        deleteProvider,
      });
    },
    [confirmDialog, deleteProvider, intl],
  );

  const handleOpenApiKeyUrl = useCallback(
    (url: string) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }
      platform.openExternal(normalizedUrl);
    },
    [platform],
  );

  const handleCodingPlanLogin = useCallback(
    (
      presetId: BuiltinModelProviderId,
      providerId: OAuthProviderId,
      providerName: string,
      status: CodingPlanStatus,
      options?: CodingPlanLoginOptions,
    ) => {
      setPresetSubscriptionProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      logger.info(
        "[ModelProviderSection] request sign in through unified login entry and connect coding plan",
        {
          presetId,
          providerId,
          providerName,
          status,
          forceOAuth: options?.forceOAuth === true,
        },
      );
      if (activeOAuthProvider === providerId && options?.forceOAuth !== true) {
        void refreshProviderPanelAfterAuthChange({}).finally(() => {
          setPresetSubscriptionProviderId((current) => (current === presetId ? null : current));
          setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
        });
        return;
      }
      // ZAI/BigModel provider no longer has an independent connection, and Connect must switch App active provider.
      return requestLoginEntry(providerId);
    },
    [activeOAuthProvider, refreshProviderPanelAfterAuthChange, requestLoginEntry],
  );

  const handleCodingPlanDisconnect = useCallback(
    async (presetId: BuiltinModelProviderId, providerId: OAuthProviderId, providerName: string) => {
      if (providerId !== BIGMODEL_PROVIDER_ID && providerId !== ZAI_PROVIDER_ID) {
        return;
      }

      setCodingPlanDisconnectProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      try {
        logger.info("[ModelProviderSection] request disconnect coding plan provider", {
          presetId,
          providerId,
          providerName,
        });
        // ZAI/BigModel provider has been reverted to the App login image.
        // The Unlink here must go through provider logout, exit the current active provider and trigger another set of providers to resume Connect.
        const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
          currentDomain: sharedSettings?.providerFamilyDomain,
        });
        await oauthService.logout(providerId);
        // Coding Plan official website webview uses independent persistent partition, provider Unlink also belongs to the account boundary.
        if (typeof platform.executeDesktopCommand === "function") {
          await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
        }
        await updateSharedSettings({
          providerFamilyDomain: (nextProviderFamilyDomain ?? "") as never,
          providerFamilyDomainUpdatedAt: Date.now(),
          providerFamilyDomainMigrated: true,
        });
        await refreshCodingPlanPurchaseTokenState({ clearUserWhenLoggedOut: true });
        await refresh();
        // After unbinding, the subscription/authentication status of batch-preview has expired, and the internal cache of the package card must be refreshed.
        // Otherwise, the button will continue to use the purchased or authenticated state before unbinding.
        refreshCodingPlanProducts();
        // The old Start/Coding provider key may still be retained in the React closure before unlinking.
        // The unbind button only waits for the local logout and provider list to be refreshed; the equity hook will clear the old state after the new provider snapshot is landed.
      } catch (error) {
        logger.error("[ModelProviderSection] disconnect coding plan provider failed", {
          presetId,
          providerId,
          providerName,
          error,
        });
      } finally {
        setCodingPlanDisconnectProviderId((current) => (current === presetId ? null : current));
        setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
      }
    },
    [
      oauthService,
      platform,
      updateSharedSettings,
      sharedSettings?.providerFamilyDomain,
      modelSelectionService,
      refresh,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
    ],
  );

  const persistProviderFamilyModeForNavItem = useCallback(
    async (item: (typeof navigationItems)[number]) => {
      if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
        return;
      }
      const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
      if (!familySpec) {
        return;
      }
      const selection = resolveConnectionSelectionForNavItem(item);
      if (!selection) return;
      const selectionUnchanged =
        JSON.stringify(connectionSelections[familySpec.id]) === JSON.stringify(selection);
      // The same package may still lack the persistent account field; user reselection must be completed, and the page display cannot be used to remove duplicates.
      const modeUnchanged = sharedSettings?.providerFamilyDomain === familySpec.id;
      const selectedKeyUnchanged = selectionUnchanged;
      const planSyncAttemptKey =
        item.type === "codingPlan" || item.type === "teamPlan"
          ? resolveCodingPlanProviderSyncAttemptKey({
              activeOAuthProvider,
              oauthProviderId: item.oauthProviderId,
              providerId: item.presetId,
            })
          : null;
      if (modeUnchanged && selectedKeyUnchanged) {
        const isPlanItem = item.type === "codingPlan" || item.type === "teamPlan";
        const planSyncAttemptStatus = planSyncAttemptKey
          ? codingPlanStatusSyncAttemptsRef.current.get(planSyncAttemptKey)
          : undefined;
        if (
          isPlanItem &&
          shouldRetryUnchangedCodingPlanProviderSync({
            attemptKey: planSyncAttemptKey,
            attemptStatus: planSyncAttemptStatus,
            modeUnchanged,
            selectedKeyUnchanged,
          })
        ) {
          try {
            await syncCodingPlanProviderOnce(item, {
              userTransition: true,
              refreshPlanSnapshots: false,
            });
          } catch (error) {
            logger.warn("[ModelProviderSection] retry sync coding plan provider failed", {
              providerId: item.presetId,
              error,
            });
          }
        }
        return;
      }
      setPendingConnectionSelections((current) => ({
        ...current,
        [familySpec.id]: selection,
      }));
      if (planSyncAttemptKey) {
        // The pending state will trigger rendering first; it will occupy the space first to prevent the hydration effect from repeatedly initiating synchronization before setting the disk.
        codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "inFlight");
      }
      try {
        await updateSharedSettings({
          providerFamilyDomain: familySpec.id,
          providerFamilyDomainUpdatedAt: Date.now(),
          providerFamilyDomainMigrated: true,
          providerFamilyConnectionSelections: {
            ...connectionSelections,
            [familySpec.id]: selection,
          },
        });
        if (item.type === "codingPlan" || item.type === "teamPlan") {
          // User actions have connection mode transition: set the target Plan provider to be refreshed only once after placing the order.
          await syncCodingPlanProviderOnce(item, {
            userTransition: true,
            refreshPlanSnapshots: false,
          });
        }
      } catch (error) {
        if (planSyncAttemptKey) {
          // When setting the disk or subsequent provider synchronization fails, the same item must be allowed to be retried.
          codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "failed");
        }
        logger.warn("[ModelProviderSection] save model provider connection method failed", {
          familyId: familySpec.id,
          error,
        });
        setPendingConnectionSelections((current) =>
          clearPendingProviderFamilyConnectionSelection(current, familySpec.id, selection),
        );
      }
    },
    [
      activeOAuthProvider,
      connectionSelections,
      sharedSettings?.providerFamilyDomain,
      syncCodingPlanProviderOnce,
      updateSharedSettings,
    ],
  );

  const handleSelectNavItem = useCallback(
    (item: (typeof navigationItems)[number]) => {
      setInvalidProviderTarget(false);
      setSelectedNodeKey(resolveModelProviderSideSelectionKey(item));
      setTemplatePickerOpen(false);
      void persistProviderFamilyModeForNavItem(item);
    },
    [persistProviderFamilyModeForNavItem],
  );

  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        const created = await createPersonalProvider({ ...input, locale });
        setPendingCreatedProviderId(created.providerId);
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        setPendingCreatedProviderId(null);
        throw error;
      } finally {
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = sortModelProvidersForDisplay(modelProviders, displayOrder).map(
        (provider) => provider.providerId,
      );
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) {
        return;
      }
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({
        providerIds: nextProviderIds,
      });
    },
    [displayOrder, modelProviders, saveDisplayOrder],
  );

  const handleTestModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      return testModelConnectivity(providerId, modelId);
    },
    [testModelConnectivity],
  );

  // When the first screen is connected to a slow network, null is returned directly before, causing the entire model supplier page to be blank.
  // The existing left group loading and refresh button loading have no chance to render.
  // Here, the layout shell is always rendered first, and then the loading is displayed in groups to prevent users from mistakenly thinking that the page is broken.
  const presetLoading = loading || modelProvidersRefreshing;
  const customLoading = loading || modelProvidersRefreshing;

  if (loadError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <Button type="button" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={presetLoading}
      customLoading={customLoading}
      onRefresh={() => {
        void refreshModelProviderSection({
          refresh,
          // When manually refreshing the settings page, you must also refresh the Z.ai / BigModel Team Plan snapshot;
          // Originally only the BigModel was refreshed, Z.ai Team Plan will continue to display old projects after purchasing or subscribing to changes.
          refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
        });
        refreshCodingPlanEntitlements();
      }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      onSelectNavItem={handleSelectNavItem}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={reorderableProviderIds}
    >
      {(invalidProviderTarget || navigationUnavailable) && !templatePickerOpen ? (
        <p role="alert" className="mb-3 text-ui-base text-destructive">
          {intl.formatMessage({
            id: invalidProviderTarget
              ? "settings.modelProvider.navigationUnavailable"
              : "settings.modelProvider.connectionUnavailable",
          })}
        </p>
      ) : null}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => {
            return handleCreateProvider({ templateId });
          }}
          onCreateCustom={(label) => {
            return handleCreateProvider({ providerName: label });
          }}
        />
      ) : (
        <ModelProviderSectionDetail
          connectionSelections={effectiveConnectionSelections}
          providerSettingsView={providerSettingsView}
          selectedNavItem={selectedNavItem}
          navigationItems={navigationItems}
          connectionSettingsFailed={familyConnectionSettingsFailed}
          startPlanSubscriptionCount={(() => {
            const providerId =
              selectedNavItem && "presetId" in selectedNavItem ? selectedNavItem.presetId : null;
            const family = providerId
              ? resolveModelProviderFamilySpecByProviderId(providerId)
              : null;
            const entitlement = family ? codingPlanEntitlements[family.startPlanProviderId] : null;
            // Only the queried interests of the current Family will be displayed, regardless of whether Start is currently selected instead of the number owned.
            return entitlement?.error
              ? 0
              : (entitlement?.snapshot?.subscription?.details.length ?? 0);
          })()}
          presetLoading={presetLoading}
          codingPlanAuthError={oauthError}
          codingPlanPurchaseTokenAuthenticatedByProviderId={
            codingPlanPurchaseTokenAuthenticatedByProviderId
          }
          presetSubscriptionProviderId={presetSubscriptionProviderId}
          codingPlanStatusSyncProviderId={codingPlanStatusSyncProviderId}
          codingPlanDisconnectProviderId={codingPlanDisconnectProviderId}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          // Provider's left column sorting permission was mistakenly reused as model sorting access, resulting in Built-in/Account
          // Provider's Effective model cannot be written to Personal modelOrder. Model ordering is independent of member origin.
          onReorderProviderModels={reorderProviderModels}
          onTestModel={handleTestModel}
          onCodingPlanLogin={handleCodingPlanLogin}
          onRetryCodingPlan={() => {
            // Failure to obtain the Key does not mean that the login is invalid; use the Host to manually refresh without clearing OAuth or logging in again.
            logger.info("[ModelProviderSection] retry fetch plan status");
            return refresh().then(() =>
              refreshCodingPlanEntitlements({ force: true, reason: "manual" }),
            );
          }}
          onCodingPlanDisconnect={handleCodingPlanDisconnect}
          onOpenApiKeyUrl={handleOpenApiKeyUrl}
          onSelectNavItem={handleSelectNavItem}
          onOpenBigModelRegistration={() => {
            // The unregistered prompt comes from a failed OAuth checking state; after jumping to registration, it must be restored to the normal state to avoid the prompt getting stuck.
            setOAuthError(null);
            setPresetSubscriptionProviderId((current) =>
              current === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ? null : current,
            );
            platform.openExternal(BIGMODEL_REGISTRATION_URL);
          }}
          onCodingPlanPurchaseComplete={async () => {
            await refreshProviderPanelAfterAuthChange({ refreshReason: "purchase" });
          }}
        />
      )}
    </ModelProviderSectionLayout>
  );
}
