/* eslint-disable max-lines -- The plugin store container orchestrates list/detail, the marketplace
 * source dialog, uninstall confirmation, trial navigation, and the tail end of the skill refresh in
 * one place; keeping it together guarantees consistent interaction.
 */
import { PluginAddMenu } from "@/settings/PluginAddMenu.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Settings } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import { PluginStoreListView, type PluginStoreSegment } from "@/settings/PluginStoreListView.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import { PluginStoreSourcesDialog } from "@/settings/PluginStoreSourcesDialog.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import {
  buildStoreItems,
  canUpdatePluginItem,
  isPluginUpdatePending,
  resolveItemDisplayName,
  resolvePluginDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import { claimMarketplaceAutoRefresh } from "@/settings/officialMarketplaceAutoRefresh.js";
import { consumePluginStoreOpenTarget } from "@/lib/pluginStoreNavigation.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";

interface PluginStorePageProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onManageInstalled: () => void;
}

type PluginStoreView = "store" | "detail";

export function PluginStorePage({
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onManageInstalled,
}: PluginStorePageProps) {
  const { intl, locale } = useZCodeIntl();
  const { order: storeOrder, refresh: refreshStoreOrder } = usePluginStoreOrder();
  const { pluginManagementService, skillsService } = useServices();
  const zcodeSessionService = useZCodeSessionService(
    workspacePath ?? undefined,
    undefined,
    workspaceIdentity,
  );
  const plugins = usePluginManagementStore((state) => state.plugins);
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  const loadedWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const loadedWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const error = usePluginManagementStore((state) => state.error);
  const operationId = usePluginManagementStore((state) => state.operationId);
  const describeCache = usePluginManagementStore((state) => state.describeCache);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const updateMarketplace = usePluginManagementStore((state) => state.updateMarketplace);
  const addMarketplace = usePluginManagementStore((state) => state.addMarketplace);
  const removeMarketplace = usePluginManagementStore((state) => state.removeMarketplace);
  const installPlugin = usePluginManagementStore((state) => state.installPlugin);
  const describePlugin = usePluginManagementStore((state) => state.describePlugin);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const restoreBuiltin = usePluginManagementStore((state) => state.restoreBuiltin);

  const [view, setView] = useState<PluginStoreView>("store");
  const [detailPluginId, setDetailPluginId] = useState<string | null>(null);
  const [segment, setSegment] = useState<PluginStoreSegment>("public");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [addMarketplaceError, setAddMarketplaceError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // When returning to the list page, restore the scroll position before entering the details (settings page main container scrolling).
  const storeScrollTopRef = useRef(0);
  const [initialNavigationTarget] = useState(() => consumePluginStoreOpenTarget());
  const initialNavigationTargetRef = useRef(initialNavigationTarget);
  useEffect(() => {
    if (initialNavigationTarget?.intent === "add-marketplace") setAddSourceOpen(true);
  }, [initialNavigationTarget]);

  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;

  useEffect(() => {
    if (!workspacePath) {
      return;
    }
    // Marketplace only manages Host User inventory; even if it is opened from the current window of Workspace, it cannot
    // Workspace config projection is brought to market, which would otherwise make the project configuration look like the installation scope.
    void initialize({
      workspacePath,
      workspaceIdentity,
      configScope: "user",
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, workspaceIdentity, workspacePath]);

  // Catalog Auto-Refresh: only for ZCode official market. Refresh the CDN directory every time you enter the store page.
  // Otherwise, the newly launched plug-ins will not be visible until the user manually clicks refresh; throttling with a 10-minute window, and occupying space for anti-shake when launched (failure/in-flight will not be repeated),
  // See officialMarketplaceAutoRefresh for criteria. The state is placed at the module level instead of the component ref, because each entry is a remount.
  useEffect(() => {
    const official = marketplaces.find((item) => item.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID);
    if (
      official &&
      claimMarketplaceAutoRefresh(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, official.lastUpdated)
    ) {
      void updateMarketplace(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, pluginManagementService);
    }
  }, [marketplaces, pluginManagementService, updateMarketplace]);

  const items = useMemo(
    () =>
      buildStoreItems({
        marketplaces,
        marketplaceAvailabilityKnown,
        availablePlugins,
        installedPlugins,
        plugins,
        restorableBuiltins,
      }),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const detailItem = detailPluginId ? (itemById.get(detailPluginId) ?? null) : null;
  // Plug-in's own warning diagnosis (for example, the declared skill path scan is empty): Details are displayed in the advanced area to avoid silent failure.
  const detailPluginInfo = detailItem?.info;
  const detailPluginWarnings = detailPluginInfo
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === detailPluginInfo.id && diagnostic.severity === "warning",
      )
    : [];

  // Details page data completion: For entries without runtime information (no installation candidates) describe on demand, get the component list + manifest fallback field.
  useEffect(() => {
    if (view !== "detail" || !detailItem || detailItem.info) return;
    void describePlugin(
      detailItem.id,
      detailItem.name,
      detailItem.marketplace,
      pluginManagementService,
    );
  }, [describePlugin, detailItem, pluginManagementService, view]);

  // Return to the list when the detail entry disappears (the restorable record is removed after uninstalling the restorable built-in, etc.) to avoid empty details.
  useEffect(() => {
    if (view === "detail" && detailPluginId && !itemById.has(detailPluginId)) {
      setView("store");
      setDetailPluginId(null);
    }
  }, [detailPluginId, itemById, view]);

  const scrollContainer = (): HTMLElement | null => rootRef.current?.closest("main") ?? null;

  const openDetail = useCallback((pluginId: string) => {
    storeScrollTopRef.current =
      (rootRef.current?.closest("main") as HTMLElement | null)?.scrollTop ?? 0;
    setDetailPluginId(pluginId);
    setView("detail");
    requestAnimationFrame(() => {
      const main = rootRef.current?.closest("main");
      if (main) main.scrollTop = 0;
    });
  }, []);

  useEffect(() => {
    const target = initialNavigationTargetRef.current;
    if (
      !target?.pluginId ||
      loading ||
      loadedWorkspacePath !== workspacePath ||
      loadedWorkspaceIdentity !== normalizedWorkspaceIdentity
    ) {
      return;
    }
    initialNavigationTargetRef.current = null;
    if (itemById.has(target.pluginId)) {
      openDetail(target.pluginId);
      return;
    }
    // Preserve stable ID searches when candidates still don't exist after a refresh, so users see clear empty results instead of error details.
    setView("store");
    setQuery(target.pluginId);
  }, [
    itemById,
    loadedWorkspaceIdentity,
    loadedWorkspacePath,
    loading,
    normalizedWorkspaceIdentity,
    openDetail,
    workspacePath,
  ]);

  const backToStore = useCallback(() => {
    setView("store");
    setDetailPluginId(null);
    requestAnimationFrame(() => {
      const main = scrollContainer();
      if (main) main.scrollTop = storeScrollTopRef.current;
    });
  }, []);

  // Top bar refresh = real network update: updateMarketplace(null) re-pull all market manifests (including CDN and git sources,
  // After the operation is completed, the overview will be reloaded), and then press the update logo number to give a completion prompt. When only doing local reloading,
  // The user cannot see the new CDN plug-in when they click refresh (does not comply with the specification "Refresh→update(null)").
  const handleRefresh = async () => {
    void refreshStoreOrder(true);
    setRefreshing(true);
    try {
      await handleCheckForUpdates();
    } finally {
      setRefreshing(false);
    }
  };

  // Unified ending after plug-in package changes (installation/uninstallation/update): invalidate draft session and refresh skills,
  // Avoid hanging or old version capabilities remaining in the session.
  const refreshAfterPluginChange = useCallback(async () => {
    await invalidateDeferredDraftSessionForSkillChange({
      zcodeSessionService,
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity ?? undefined,
      reason: "settings-plugin-enabled",
    });
    await refreshSharedSkillStoreForWorkspace({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      skillsService,
    });
  }, [normalizedWorkspaceIdentity, skillsService, workspacePath, zcodeSessionService]);

  const uninstall = usePluginUninstall({
    pluginService: pluginManagementService,
    installedPlugins,
    plugins,
    operationId,
    onAfterUninstall: async () => {
      await refreshAfterPluginChange();
    },
  });

  const handleInstall = useCallback(
    async (item: StorePluginItem) => {
      if (item.restorable) {
        await restoreBuiltin(item.id, pluginManagementService);
      } else {
        await installPlugin(item.name, item.marketplace, pluginManagementService, "user");
      }
      // Installation/restoration will introduce new skills and commands, and perform a final refresh like start/stop/uninstall.
      await refreshAfterPluginChange();
    },
    [installPlugin, pluginManagementService, refreshAfterPluginChange, restoreBuiltin],
  );

  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, pluginManagementService);
      if (usePluginManagementStore.getState().error) {
        return;
      }
      // The upgrade will replace Skill, Command and MCP definitions at the same time; the old entrance only refreshes the store list.
      // Warmed draft sessions continue to carry old versions or even empty capabilities, causing new sessions to remain unavailable after "upgrade successful".
      await refreshAfterPluginChange();
    },
    [pluginManagementService, refreshAfterPluginChange, updatePlugin],
  );

  const handleCheckForUpdates = useCallback(async () => {
    const succeeded = await updateMarketplace(null, pluginManagementService);
    if (!succeeded) {
      const message = usePluginManagementStore.getState().error;
      if (message) {
        toast(message);
      }
      return;
    }
    const pendingCount = usePluginManagementStore
      .getState()
      .installedPlugins.filter((item) => isPluginUpdatePending(item.updateStatus)).length;
    if (pendingCount > 0) {
      toast(
        intl.formatMessage(
          { id: "settings.plugins.checkForUpdates.found" },
          { count: String(pendingCount) },
        ),
      );
      return;
    }
    toast(intl.formatMessage({ id: "settings.plugins.checkForUpdates.none" }));
  }, [intl, pluginManagementService, updateMarketplace]);

  const handleAddMarketplace = useCallback(
    async (source: string) => {
      const succeeded = await addMarketplace(source, pluginManagementService);
      // Errors when adding market sources must be displayed on the same layer as the submission entry; otherwise, the global error bar will be pushed below by the Dialog mask.
      setAddMarketplaceError(
        succeeded ? null : (usePluginManagementStore.getState().error ?? null),
      );
      // The custom market does not belong to the public segment; after successful addition, switch directly to "Personal" so that users can immediately see the newly added source.
      if (succeeded) setSegment("personal");
      return succeeded;
    },
    [addMarketplace, pluginManagementService],
  );

  const handleUsePrompt = useCallback(
    (item: StorePluginItem, prompt: string) => {
      // If it is not installed, click the prompt word to guide the installation first, and no new session will be created.
      if (!item.installed) {
        void handleInstall(item);
        return;
      }
      if (!workspacePath || !onCreateTask) {
        return;
      }
      // The original entry bypasses Root's standard new task arrangement and only writes the session store.
      // Settings mask will not exit, composer remount may also overwrite prefill. Now delegate Root uniformly,
      // At the same time, the canonical Plugin link of @ Picker is reused without adding a second set of reference semantics.
      onCreateTask({
        initialPrompt: buildPluginStoreTryPrompt({ item, locale, prompt }),
        initialPromptMention: buildPluginStoreTryMention({ item, locale }),
      });
    },
    [handleInstall, locale, onCreateTask, workspacePath],
  );

  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: openDetail,
      onInstall: (item) => void handleInstall(item),
      onUninstall: uninstall.requestUninstall,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      operationId,
      togglingPluginId: null,
    }),
    [handleInstall, handleUpdatePlugin, openDetail, operationId, uninstall.requestUninstall],
  );

  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.noWorkspace" })}
      </div>
    );
  }

  const detailUpdatePending = canUpdatePluginItem(detailItem);

  return (
    <div ref={rootRef} className="space-y-5" data-testid="plugin-store-root" data-view={view}>
      <SettingsBreadcrumbReporter
        items={
          view === "detail" && detailItem
            ? [{ label: resolveItemDisplayName(detailItem, locale) }]
            : []
        }
        onSectionSelect={backToStore}
      />
      {view === "store" ? (
        <h1
          data-testid="plugin-store-title"
          className="text-2xl font-semibold tracking-tight text-foreground lg:text-3xl"
        >
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </h1>
      ) : null}
      {view === "store" ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.store.subtitle" })}
          </p>
          {/* Top bar actions: refresh / manage marketplace sources (gear) / add marketplace source. */}
          <div className="flex shrink-0 items-center gap-2">
            <ControlHintTooltip
              title={
                refreshing
                  ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                  : intl.formatMessage({ id: "settings.plugins.refresh" })
              }
            >
              <Button
                type="button"
                data-testid="plugin-store-refresh"
                variant="outline"
                size="icon-lg"
                aria-label={
                  refreshing
                    ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                    : intl.formatMessage({ id: "settings.plugins.refresh" })
                }
                onClick={() => void handleRefresh()}
                disabled={refreshing}
              >
                <RefreshCw
                  className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
                  aria-hidden="true"
                />
              </Button>
            </ControlHintTooltip>
            <ControlHintTooltip
              title={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
            >
              <Button
                type="button"
                data-testid="plugin-store-sources-open"
                variant="outline"
                size="icon-lg"
                aria-label={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
                onClick={() => setSourcesOpen(true)}
              >
                <Settings className="size-3.5" aria-hidden="true" />
              </Button>
            </ControlHintTooltip>
            <PluginAddMenu
              testId="plugin-store-create"
              onCreateTask={onCreateTask}
              onAddMarketplace={() => {
                setAddMarketplaceError(null);
                setAddSourceOpen(true);
              }}
            />
          </div>
        </div>
      ) : null}

      {error && !addSourceOpen ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
          data-testid="plugin-store-error"
        >
          {error}
        </div>
      ) : null}

      {view === "detail" && detailItem ? (
        <PluginStoreDetailView
          item={detailItem}
          actions={actions}
          describeEntry={describeCache[detailItem.id]}
          onRetryDescribe={() =>
            void describePlugin(
              detailItem.id,
              detailItem.name,
              detailItem.marketplace,
              pluginManagementService,
              true,
            )
          }
          onUsePrompt={handleUsePrompt}
          advanced={
            detailItem.info ? (
              <div className="space-y-4">
                {detailUpdatePending ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-ui-base font-medium text-foreground">
                        {detailItem.installedMeta?.updateStatus === "update-available"
                          ? intl.formatMessage(
                              { id: "settings.plugins.detail.updateAvailable" },
                              { version: detailItem.installedMeta?.latestVersion ?? "" },
                            )
                          : intl.formatMessage({ id: "settings.plugins.detail.versionChanged" })}
                      </p>
                      <p className="text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({
                          id: "settings.plugins.detail.updateNewSessionsNote",
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      data-testid="plugin-store-detail-update"
                      variant="outline"
                      size="sm"
                      disabled={operationId === `plugin:update:${detailItem.id}`}
                      onClick={() => void handleUpdatePlugin(detailItem.id)}
                    >
                      {intl.formatMessage({ id: "settings.plugins.detail.update" })}
                    </Button>
                  </div>
                ) : null}
                <PluginStoreAdvancedSection>
                  {detailPluginWarnings.length > 0 ? (
                    <div>
                      <div className="mb-2 text-ui-xs font-medium text-foreground">
                        {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                      </div>
                      <PluginWarningList warnings={detailPluginWarnings} />
                    </div>
                  ) : null}
                  <PluginDetailRow
                    label={intl.formatMessage({ id: "settings.plugins.detail.rootPath" })}
                    value={detailItem.info.rootPath}
                  />
                  {(detailItem.info.hookDetails ?? []).length > 0 ? (
                    <PluginHookDetails hooks={detailItem.info.hookDetails ?? []} />
                  ) : null}
                </PluginStoreAdvancedSection>
              </div>
            ) : undefined
          }
        />
      ) : (
        <PluginStoreListView
          order={storeOrder}
          items={items}
          marketplaces={marketplaces}
          actions={actions}
          loading={loading || (operationId?.startsWith("marketplace:update:") ?? false)}
          query={query}
          onQueryChange={setQuery}
          segment={segment}
          onSegmentChange={setSegment}
          onOpenManage={onManageInstalled}
        />
      )}

      <PluginUninstallConfirmDialog
        open={uninstall.pendingPlugin !== null}
        pluginName={
          uninstall.pendingPlugin
            ? resolvePluginDisplayName(
                itemById.get(uninstall.pendingPlugin.id) ?? {
                  name: uninstall.pendingPlugin.name,
                },
                locale,
              )
            : ""
        }
        pending={uninstall.uninstalling}
        onCancel={uninstall.cancelUninstall}
        onConfirm={() => void uninstall.confirmUninstall()}
      />
      <PluginStoreSourcesDialog
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        marketplaces={marketplaces}
        onUpdateMarketplace={(marketplace) =>
          void updateMarketplace(marketplace, pluginManagementService)
        }
        onRemoveMarketplace={(marketplace) =>
          void removeMarketplace(marketplace, pluginManagementService)
        }
        operationId={operationId}
      />
      <AddMarketplaceSourceDialog
        open={addSourceOpen}
        onOpenChange={setAddSourceOpen}
        onAddMarketplace={handleAddMarketplace}
        operationId={operationId}
        error={addMarketplaceError}
      />
    </div>
  );
}
