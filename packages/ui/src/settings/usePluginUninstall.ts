import { useCallback, useMemo, useState } from "react";
import type { ZCodeInstalledPluginSummary, ZCodePluginInfo } from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";

interface UsePluginUninstallInput {
  pluginService: IPluginManagementService;
  installedPlugins: ZCodeInstalledPluginSummary[];
  plugins: ZCodePluginInfo[];
  operationId: string | null;
  // Uninstalling will invalidate the skills/commands provided by the plug-in, and the caller passes in the unified "refresh after ability change" closing logic.
  onAfterUninstall: () => Promise<void>;
}

interface PluginUninstallController {
  pendingPlugin: ZCodePluginInfo | ZCodeInstalledPluginSummary | null;
  uninstalling: boolean;
  requestUninstall: (pluginId: string) => void;
  cancelUninstall: () => void;
  confirmUninstall: () => Promise<void>;
}

/**
 * Centralizes the confirmation flow for plugin uninstall: every UI entry point (installed details,
 * marketplace panel) starts an uninstall through it, sharing one pending state, one
 * confirmation-dialog target resolution, and one uninstall teardown path.
 */
export function usePluginUninstall({
  pluginService,
  installedPlugins,
  plugins,
  operationId,
  onAfterUninstall,
}: UsePluginUninstallInput): PluginUninstallController {
  const uninstallPlugin = usePluginManagementStore((state) => state.uninstallPlugin);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const pendingPlugin = useMemo(() => {
    if (!pendingId) return null;
    return (
      installedPlugins.find((item) => item.id === pendingId) ??
      plugins.find((item) => item.id === pendingId) ??
      null
    );
  }, [installedPlugins, pendingId, plugins]);

  const uninstalling = pendingId !== null && operationId === `plugin:uninstall:${pendingId}`;

  const requestUninstall = useCallback((pluginId: string) => {
    setPendingId(pluginId);
  }, []);

  const cancelUninstall = useCallback(() => {
    setPendingId(null);
  }, []);

  const confirmUninstall = useCallback(async () => {
    if (!pendingId) return;
    await uninstallPlugin(pendingId, pluginService);
    await onAfterUninstall();
    setPendingId(null);
  }, [pluginService, onAfterUninstall, pendingId, uninstallPlugin]);

  return { pendingPlugin, uninstalling, requestUninstall, cancelUninstall, confirmUninstall };
}
