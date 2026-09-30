/* eslint-disable max-lines -- The Hooks page aggregates Scope, plugin projections, search, and the
 * config write flow.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Hook, HookConfig, ZCodeInstalledPluginSummary, ZCodePluginInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForRuntimeChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useHooksStore } from "@/store/hooksStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { HookForm } from "./HookForm.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import { HooksList, type HookScope, type PluginHookRow } from "./HooksList.js";
import { useWorkspaceHookInlineTrust } from "./useWorkspaceHookInlineTrust.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";
import { PluginLoadingState, PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  shouldShowWorkspaceHookTrustNotice,
  WorkspaceHookTrustNotice,
} from "@/settings/WorkspaceHookTrustNotice.js";

interface HooksSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

function isEditableHook(hook: Hook): boolean {
  // workspace-hook-trust: Discovery will issue the editable flag at runtime (the workspace Hook is in
  // The configuration cannot be changed directly on the runtime side), priority is respected; when the local Settings finds that the path does not have this flag, it will fall back to the old rules.
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

// workspace-hook-trust: The line with editable=false and source=zcode is "upstream/ancestor zcode.json
// Read-only workspace Hook" in the. They are not external format compatible import sources, plugging into Legacy will make the Import button
// It will inevitably fail (importHook rejects source=zcode), and also violates the "read-only but trustable" agreement.
// Such rows should stay in the Installed group, gated by the trust state Switch, and go through the inner Trust process.
function isReadOnlyZCodeHook(hook: Hook): boolean {
  return hook.editable === false && (hook.location?.source ?? "zcode") === "zcode";
}

function isInCompatibilitySection(hook: Hook): boolean {
  return !isEditableHook(hook) && !isReadOnlyZCodeHook(hook);
}

/**
 * workspace-hook-trust: resolves the scope switch target for the "latest review binding". A pure
 * function (shared by HooksSection and the unit tests):
 * - Take the latest binding by request.createdAt (a generation bump on the same runtime flow also
 *   refreshes createdAt; the semantics are "the most recently appearing review");
 * - identity is tried first, matching the tab's scope key exactly; only legacy local bindings
 *   without an identity fall back to workspacePath (consistent with the fallback rule in
 *   matchesWorkspaceBinding);
 * - When no matching tab is found (the workspace is closed/unknown) return null — the caller must
 *   not switch there.
 */
function resolveLatestReviewScopeTarget(
  bindings: Record<
    string,
    {
      request: { interactionId: string; createdAt: number; workspaceIdentity?: string };
      workspacePath: string;
    }
  >,
  workspaceTabs: readonly { workspacePath: string; workspaceIdentity?: string }[],
): { interactionId: string; scopeKey: string } | null {
  let latest: {
    interactionId: string;
    createdAt: number;
    workspaceIdentity?: string;
    workspacePath: string;
  } | null = null;
  for (const binding of Object.values(bindings)) {
    if (!latest || binding.request.createdAt > latest.createdAt) {
      latest = {
        interactionId: binding.request.interactionId,
        createdAt: binding.request.createdAt,
        workspaceIdentity: binding.request.workspaceIdentity,
        workspacePath: binding.workspacePath,
      };
    }
  }
  if (!latest) return null;
  // The key rules are consistent with getPluginWorkspaceKey (identity takes precedence, fallback to workspacePath),
  // This is inlined rather than reused to avoid the helper relying on the complete type of WorkspaceTabState and to facilitate single testing.
  const scopeKeyOf = (tab: { workspacePath: string; workspaceIdentity?: string }) =>
    tab.workspaceIdentity?.trim() || tab.workspacePath;
  const identity = latest.workspaceIdentity?.trim();
  const tab = identity
    ? workspaceTabs.find((candidate) => scopeKeyOf(candidate) === identity)
    : workspaceTabs.find((candidate) => candidate.workspacePath === latest!.workspacePath);
  return tab ? { interactionId: latest.interactionId, scopeKey: scopeKeyOf(tab) } : null;
}

function buildPluginHookRows(
  plugins: readonly Pick<ZCodePluginInfo, "enabled" | "hookDetails" | "id" | "name">[],
  installedPlugins: readonly Pick<ZCodeInstalledPluginSummary, "id" | "scope">[],
  scopeMetadataKnown: boolean,
): PluginHookRow[] {
  const scopeByPluginId = new Map(
    installedPlugins.map((plugin) => [plugin.id, plugin.scope] as const),
  );
  return plugins.flatMap((plugin) =>
    (plugin.hookDetails ?? []).map((detail) => ({
      detail,
      pluginEnabled: plugin.enabled,
      pluginId: plugin.id,
      pluginName: plugin.name,
      // When overview is downgraded, installedPlugins=[] means that the scope is unknown and cannot be forged as User.
      pluginScope: scopeMetadataKnown ? scopeByPluginId.get(plugin.id) : undefined,
    })),
  );
}

function filterPluginHooksByScope(
  pluginHooks: readonly PluginHookRow[],
  scope: HookScope,
): PluginHookRow[] {
  const expectedScope = scope === "project" ? "workspace" : "user";
  // Unknown scope is retained in both Tabs and marked by a list to avoid hiding the real plug-in Hook when downgrading.
  return pluginHooks.filter(
    (hook) => hook.pluginScope === undefined || hook.pluginScope === expectedScope,
  );
}

export function HooksSection({ workspacePath, workspaceIdentity }: HooksSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const hooksState = useHooksStore();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const pluginsLoading = usePluginManagementStore((state) => state.loading);
  const pluginsError = usePluginManagementStore((state) => state.error);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const [viewMode, setViewMode] = useState<"list" | "form">("list");
  const [editingHook, setEditingHook] = useState<Hook | null>(null);
  const [query, setQuery] = useState("");
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => {
    const seen = new Set<string>();
    return tabs
      .filter(isWorkspaceTab)
      .filter(isPluginScopeWorkspaceConnected)
      .filter((tab) => {
        const key = getPluginWorkspaceKey(tab);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [tabs]);
  const [selectedScopeKey, setSelectedScopeKey] = useState("user");
  const deferredQuery = useDeferredValue(query);
  const selectedWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === selectedScopeKey,
  );
  const activeScope: HookScope = selectedWorkspace ? "project" : "user";
  const targetWorkspacePath = selectedWorkspace?.workspacePath ?? workspacePath;
  const targetWorkspaceIdentity = selectedWorkspace?.workspaceIdentity ?? workspaceIdentity;
  const targetWorkspaceKey = targetWorkspacePath
    ? getWorkspaceKey(targetWorkspacePath, targetWorkspaceIdentity)
    : null;
  const targetServiceResolution = useWorkspaceServicesResolution(
    targetWorkspacePath,
    selectedWorkspace?.remoteSessionId,
    targetWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
  );
  // After Scope switches to another remote workspace, the path has been switched but the hooks/plugin service still comes from
  // Currently active workspace. Here, the service host and target have the same identity, and no out-of-bounds RPC is sent while waiting for connection.
  const { hooksService, pluginManagementService } = targetServiceResolution.services;
  const zcodeSessionService = useZCodeSessionService(
    targetWorkspacePath ?? undefined,
    undefined,
    targetWorkspaceIdentity,
  );
  // workspace-hook-trust: The trust operation is bound to the currently selected workspace (multiple workspace scope scenarios
  // The next review binding may belong to other workspaces. In this case, switch the scope menu to the corresponding workspace).
  // hooksService must pass the target parsing result: when the scope selects the remote workspace, the context service points to
  // If the host of the tab is activated, out-of-bounds RPC will hit the wrong host.
  const { trustActionAvailable, trustingHookId, trustHook } = useWorkspaceHookInlineTrust({
    workspacePath: targetWorkspacePath,
    workspaceIdentity: targetWorkspaceIdentity,
    hooksService: targetServiceResolution.rpcReady ? hooksService : undefined,
    rpcReady: targetServiceResolution.rpcReady,
  });
  const reviewBindings = useWorkspaceHookReviewStore((state) => state.bindings);

  const editableHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          (isEditableHook(hook) || isReadOnlyZCodeHook(hook)) &&
          (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const compatibilityHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          isInCompatibilitySection(hook) && (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const pluginHooks = useMemo(
    () => buildPluginHookRows(plugins, installedPlugins, marketplaceAvailabilityKnown),
    [installedPlugins, marketplaceAvailabilityKnown, plugins],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const scopedPluginHooks = useMemo(
    () =>
      filterPluginHooksByScope(pluginHooks, activeScope).map((hook) => ({
        ...hook,
        pluginIconItem: {
          name: hook.pluginName,
          listing: pluginListingById.get(hook.pluginId),
        },
      })),
    [activeScope, pluginHooks, pluginListingById],
  );
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredEditableHooks = useMemo(
    () => editableHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [editableHooks, normalizedQuery],
  );
  const filteredCompatibilityHooks = useMemo(
    () => compatibilityHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [compatibilityHooks, normalizedQuery],
  );
  const filteredPluginHooks = useMemo(
    () =>
      scopedPluginHooks.filter((hook) =>
        [
          hook.pluginName,
          hook.detail.event,
          hook.detail.type,
          hook.detail.matcher,
          hook.detail.command,
          hook.detail.sourcePath,
        ].some((value) => value?.toLowerCase().includes(normalizedQuery)),
      ),
    [normalizedQuery, scopedPluginHooks],
  );

  useEffect(() => {
    if (!targetServiceResolution.rpcReady) return;
    void hooksState.initialize(
      targetWorkspacePath ?? undefined,
      targetWorkspaceIdentity,
      hooksService,
    );
  }, [
    hooksService,
    hooksState.initialize,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  useEffect(() => {
    if (!targetWorkspacePath || !targetServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  const handleRefresh = useCallback(async () => {
    if (!targetServiceResolution.rpcReady) return;
    await Promise.all([
      hooksState.initialize(
        targetWorkspacePath ?? undefined,
        targetWorkspaceIdentity,
        hooksService,
      ),
      targetWorkspacePath
        ? initializePlugins({
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            pluginService: pluginManagementService,
          })
        : Promise.resolve(),
    ]);
  }, [
    hooksService,
    hooksState.initialize,
    initializePlugins,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  useEffect(() => {
    if (
      selectedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => getPluginWorkspaceKey(tab) === selectedScopeKey)
    ) {
      setSelectedScopeKey("user");
    }
  }, [selectedScopeKey, workspaceTabs]);

  // workspace-hook-trust (fix): When the session area initiates an audit of workspace B, the scope menu
  // Automatically cut to B once. Two hard constraints:
  // 1. Only switch when "new interaction appears" - the user manually switches when B's review is still pending
  //    A/User is an active selection and cannot be continuously retrieved (otherwise the setting page will be locked at B during the pending period).
  // 2. The target workspace must still exist in workspaceTabs - the binding points to the closed/disconnected
  //    When switching to the workspace, it will only stop at Connecting, and it will also interact with the "invalid scope reset user" above.
  //    The effect forms a ping-pong loop.
  const latestReviewScopeTarget = useMemo(
    () => resolveLatestReviewScopeTarget(reviewBindings, workspaceTabs),
    [reviewBindings, workspaceTabs],
  );
  const handledReviewInteractionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!latestReviewScopeTarget) return;
    if (handledReviewInteractionRef.current === latestReviewScopeTarget.interactionId) return;
    handledReviewInteractionRef.current = latestReviewScopeTarget.interactionId;
    if (latestReviewScopeTarget.scopeKey !== selectedScopeKey) {
      setSelectedScopeKey(latestReviewScopeTarget.scopeKey);
    }
  }, [latestReviewScopeTarget, selectedScopeKey]);

  const invalidateDraft = useCallback(
    async (reason: string) => {
      await invalidateDeferredDraftSessionForRuntimeChange({
        logScope: "hooks",
        reason,
        workspaceIdentity: targetWorkspaceIdentity,
        workspacePath: targetWorkspacePath,
        zcodeSessionService,
      });
    },
    [targetWorkspaceIdentity, targetWorkspacePath, zcodeSessionService],
  );

  const handleSaveHook = useCallback(
    async (config: HookConfig) => {
      try {
        if (editingHook) {
          await hooksState.updateHook(editingHook.id, config, hooksService);
          await invalidateDraft("hook-updated");
        } else {
          await hooksState.addHook(config, hooksService);
          await invalidateDraft("hook-added");
        }
        setViewMode("list");
        setEditingHook(null);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [editingHook, hooksService, hooksState.addHook, hooksState.updateHook, invalidateDraft],
  );
  const handleCreateHook = useCallback(() => {
    setEditingHook(null);
    setViewMode("form");
  }, []);

  const handleDelete = useCallback(
    async (hook: Hook) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.hooks.delete" }),
        description: intl.formatMessage(
          { id: "settings.hooks.deleteDescription" },
          { event: hook.event },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) return;
      try {
        await hooksState.deleteHook(hook.id, hooksService);
        await invalidateDraft("hook-deleted");
        setEditingHook(null);
        setViewMode("list");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [confirmDialog, hooksService, hooksState.deleteHook, intl, invalidateDraft],
  );

  const handleToggle = useCallback(
    async (hook: Hook, enabled: boolean) => {
      try {
        await hooksState.toggleHook(hook.id, enabled, hooksService);
        await invalidateDraft(enabled ? "hook-enabled" : "hook-disabled");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.toggleHook, invalidateDraft],
  );

  const handleImport = useCallback(
    async (hook: Hook) => {
      try {
        await hooksState.importHook(hook.id, hooksService);
        await invalidateDraft("hook-imported");
        toast(intl.formatMessage({ id: "settings.hooks.imported" }));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.importHook, intl, invalidateDraft],
  );

  if (viewMode === "form" && targetServiceResolution.rpcReady) {
    return (
      <>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingHook?.event ?? intl.formatMessage({ id: "settings.hooks.add" }),
            },
          ]}
          onSectionSelect={() => {
            setEditingHook(null);
            setViewMode("list");
          }}
        />
        <HookForm
          hook={editingHook ?? undefined}
          workspaceAvailable={Boolean(targetWorkspacePath)}
          defaultStorageLevel={activeScope}
          selectedScopeKey={selectedScopeKey}
          workspaceTabs={workspaceTabs}
          onScopeKeyChange={setSelectedScopeKey}
          onSave={handleSaveHook}
          onDelete={editingHook ? handleDelete : undefined}
          onCancel={() => {
            setEditingHook(null);
            setViewMode("list");
          }}
          isEditing={Boolean(editingHook)}
        />
      </>
    );
  }

  const loading = hooksState.loading || pluginsLoading;
  const error = hooksState.error || pluginsError;
  const visibleCount =
    filteredEditableHooks.length + filteredCompatibilityHooks.length + filteredPluginHooks.length;
  const totalCount = editableHooks.length + compatibilityHooks.length + scopedPluginHooks.length;
  const hasSearchResultEmpty = Boolean(normalizedQuery) && visibleCount === 0;
  const showWorkspaceHookTrustNotice = shouldShowWorkspaceHookTrustNotice({
    hooks: editableHooks,
    loadedWorkspaceKey: hooksState.loadedWorkspaceKey,
    rpcReady: targetServiceResolution.rpcReady,
    targetWorkspaceKey,
  });
  return (
    <div className="space-y-6" data-testid="hooks-settings-section">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            align="start"
            selectedScopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div
            data-independent-capability-count="true"
            className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
          >
            <span>{intl.formatMessage({ id: "settings.hooks.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{visibleCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.hooks.searchPlaceholder",
          })}
        />
      </div>

      {showWorkspaceHookTrustNotice ? <WorkspaceHookTrustNotice hooks={editableHooks} /> : null}

      {targetServiceResolution.rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading && totalCount === 0 ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.hooks.searchEmpty" })} />
      ) : (
        <HooksList
          compatibilityHooks={filteredCompatibilityHooks}
          editableHooks={filteredEditableHooks}
          operatingHookId={hooksState.operatingHookId}
          pluginHooks={filteredPluginHooks}
          showInstalledSection={!normalizedQuery}
          installedEmptyTitle={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledTitle",
          })}
          installedEmptyDescription={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledDescription",
          })}
          installedEmptyActions={
            <Button type="button" variant="default" size="lg" onClick={handleCreateHook}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.hooks.add" })}
            </Button>
          }
          installedAction={
            <SettingsResourceHeaderActions
              onRefresh={() => void handleRefresh()}
              onNew={handleCreateHook}
              newActionId="settings.hooks.add"
            />
          }
          formatPluginName={(name, pluginId) =>
            resolvePluginDisplayName(
              {
                name,
                listing:
                  (pluginId ? pluginListingById.get(pluginId) : undefined) ??
                  resolveUniquePluginListingByName(availablePlugins, name),
              },
              locale,
            )
          }
          onEdit={(target) => {
            setEditingHook(target);
            setViewMode("form");
          }}
          onImport={handleImport}
          onTrust={trustHook}
          trustActionAvailable={trustActionAvailable}
          trustingHookId={trustingHookId}
          onToggle={handleToggle}
        />
      )}
    </div>
  );
}

function hookMatchesQuery(hook: Hook, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [
    hook.event,
    hook.type,
    hook.matcher,
    hook.command,
    ...(hook.args ?? []),
    hook.location?.directoryPath,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}
