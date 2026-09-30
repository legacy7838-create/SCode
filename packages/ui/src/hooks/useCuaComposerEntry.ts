/**
 * Data orchestration for the always-present entry button of the CUA composer.
 *
 * It does only three things: aggregate the three data sources, gate the permission query, and hand
 * the result to a pure function for derivation. All of the decision rules themselves live in
 * lib/cuaComposerEntryState.ts; not a single branch is duplicated here.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isRemoteWorkspaceIdentity, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useCuaPermissionStatus } from "@/hooks/useCuaPermissionStatus.js";
import {
  resolveCuaComposerEntryView,
  type CuaComposerEntryView,
} from "@/lib/cuaComposerEntryState.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getVisibleTaskMetas, getWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

/** Same yardstick as isRunningStatus in zcodeSessionStoreTaskSlice. */
const RUNNING_TASK_STATUSES = new Set(["creating", "restoring", "streaming"]);

export interface UseCuaComposerEntryParams {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /**
   * The mobile web remote-control shell; under the remote-control protection constraint the local
   * CUA entry is not rendered.
   */
  /**
   * v4 snapshot.control.canStop of the current composer, used as the low-latency authority on the
   * running state.
   */
  currentSessionBusy?: boolean;
}

interface CuaComposerEntryController {
  view: CuaComposerEntryView;
  /** Button click; it only produces a side effect when view.clickAction === "open-settings". */
  onActivate: () => void;
}

export function useCuaComposerEntry({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  currentSessionBusy = false,
}: UseCuaComposerEntryParams): CuaComposerEntryController {
  const platform = usePlatform();
  const services = useServices();
  const { settings } = useSettings();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);

  const macLocalDesktop = supportsLocalMacCuaPermissionOnboarding(platform);
  const windowsLocalDesktop = supportsLocalWindowsCuaEntry(platform);
  // Local-workspace check using the same criteria as ComputerUseSection: CUA on a remote workspace would operate
  // the remote machine's screen, which the product does not offer.
  const isLocalWorkspace =
    !remoteSessionId &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));

  // Hidden by default: show only when false was explicitly stored.
  // Use !== false rather than === true because settings not yet loaded (null) or legacy users missing the field should both be
  // treated as hidden — defaulting to visible instead would flash the button for new users before it disappears, plus waste a background permission query.
  const hiddenBySettings = settings?.computerUseComposerEntryHidden !== false;

  const plugins = usePluginManagementStore((state) => state.plugins);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const pluginStoreError = usePluginManagementStore((state) => state.error);
  // store.error is a shared plugin-surface field (written by marketplace/validate/load/any plugin setEnabled
  // failure). Only map it to this button's error state when the failing operation targeted zcode-cua;
  // the attribution is recorded by the store's lastFailedPluginId.
  const lastFailedPluginId = usePluginManagementStore((state) => state.lastFailedPluginId);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const pluginEnabled = cuaPlugin?.enabled === true;

  const pluginManagementService = services.pluginManagementService;
  const platformSupported = (macLocalDesktop || windowsLocalDesktop) && isLocalWorkspace;
  // The plugin list is a necessary input to the button state. The store is a global singleton and initialize dedupes in-flight calls
  // and reuses caches by workspaceKey internally, so sharing the same initialization path with the settings page does not amplify plugins/list requests.
  const initializedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!platformSupported || hiddenBySettings || !workspacePath || !pluginManagementService) {
      return;
    }
    const key = `${workspacePath}\0${workspaceIdentity ?? ""}`;
    if (initializedKeyRef.current === key) return;
    initializedKeyRef.current = key;
    void initializePlugins({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginService: pluginManagementService,
    });
  }, [
    hiddenBySettings,
    initializePlugins,
    platformSupported,
    pluginManagementService,
    workspaceIdentity,
    workspacePath,
  ]);

  // The composer entry carries no status display (no colored dot, always navigates to Settings), so **it no longer queries permissions at all** — a permission query
  // lazily starts the Helper on demand (the getStatus launch chain), and querying on mount equals "launch the Helper as soon as the app opens", violating the lazy-start
  // semantics. Even gating on "button visible + mac + plugin enabled" doesn't change this: enabling the plugin doesn't mean the user wants to pay the Helper-start cost now.
  // The permission truth is only read in two places: the Settings page (queried on open) and the explicit authorization flow.
  // permissionStatus is always null; resolveUiState folds null into the neutral idle state (not error).
  const { status: permissionStatus } = useCuaPermissionStatus(null, workspaceIdentity);

  // The session-busy check is workspace-granular: toggling the plugin changes the toolset of every session in that workspace and invalidates prompt caches, so the
  // blast radius and the disabled scope must match — looking only at the current task isn't enough.
  // Reuses getWorkspaceState's identity→path fallback instead of re-implementing a workspaceKey rule here.
  const workspaceSessionBusy = useZCodeSessionStore((state) => {
    const workspaceState = getWorkspaceState(state, workspacePath, workspaceIdentity);
    const runtimeBusy = Object.values(workspaceState.taskRuntimeByTaskId ?? {}).some(
      (runtime) =>
        RUNNING_TASK_STATUSES.has(runtime.status) || Boolean(runtime.activeInputId?.trim()),
    );
    if (runtimeBusy) return true;
    // Root cause: once the V4 snapshot has entered a stoppable model turn, the workspace runtime projection may briefly
    // return to ready while the task index still authoritatively records persist status=running. Looking at runtime alone keeps
    // the CUA entry clickable mid-execution. Merge the two existing sources of truth: any running locks it.
    return getVisibleTaskMetas(workspaceState).some((task) => task.status === "running");
  });
  // The current pane's snapshot.control.canStop arrives earlier than the workspace projection; OR-ing both
  // locks this composer immediately while preserving the shared lock across other composers in the same workspace.
  const sessionBusy = currentSessionBusy || workspaceSessionBusy;

  const view = useMemo(
    () =>
      resolveCuaComposerEntryView({
        macLocalDesktop: macLocalDesktop && isLocalWorkspace,
        windowsLocalDesktop: windowsLocalDesktop && isLocalWorkspace,
        hiddenBySettings,
        permissionServiceAvailable: Boolean(services.cuaPermissionService),
        pluginEnabled,
        pluginToggling: togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
        pluginError:
          Boolean(pluginStoreError) && lastFailedPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
        permissionStatus: permissionStatus ?? null,
        sessionBusy,
      }),
    [
      cuaPlugin,
      hiddenBySettings,
      lastFailedPluginId,
      isLocalWorkspace,
      macLocalDesktop,
      permissionStatus,
      pluginEnabled,
      pluginStoreError,
      sessionBusy,
      services.cuaPermissionService,
      togglingPluginId,
      windowsLocalDesktop,
    ],
  );

  const onActivate = useCallback(() => {
    if (!view.visible || view.clickAction !== "open-settings") return;
    setPendingSettingsSectionIntent("computerUse");
    openSettingsTab();
  }, [openSettingsTab, view]);

  return { view, onActivate };
}
