// The Plugin conversation references the catalog's protocol handler.
// Separate files from plugins.ts (installation/market/start/stop, etc. management interface): This query is a read-only projection of the session/draft Picker.
// And plugins.ts is close to the max-lines gate.
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  zcodeProtocolNotifications,
  zcodePluginsReferenceCatalogParamsSchema,
  zcodePluginsResolveSuggestedReferenceParamsSchema,
  type ZCodePluginReferenceCatalogEntry,
  type ZCodePluginDiagnostic as SharedPluginDiagnostic,
  type ZCodePluginsReferenceCatalogResult,
  type ZCodePluginsResolveSuggestedReferenceResult,
} from "@zcode/shared";
import type { PluginReferenceCatalogEntry } from "@zcode/contracts";
import { buildPluginReferenceCatalog } from "@zcode/core";
import {
  getZCodePluginsOverview,
  resolveZCodePlugins,
  updateZCodePluginMarketplace,
} from "../plugins.js";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// Picker authority: with sessionId → the identity catalog (session-owned) frozen when the Session was created;
// Without → workspace current catalog (new draft). When the session does not exist, fail closed according to the protocol error.
// Disable silent rollback of workspace authority - otherwise draft/session authorities will be confused.
export async function getPluginReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  includeCategory = false,
): Promise<ZCodePluginsReferenceCatalogResult> {
  const params = parseParams(zcodePluginsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const displayByPluginId = resolveReferenceListingDisplayByPluginId(
      params.workspace.workspacePath,
    );
    return {
      authority: "session",
      plugins: record.app
        .getPluginReferenceCatalog()
        .plugins.map((entry) => toReferenceCatalogEntry(entry, displayByPluginId, includeCategory)),
    };
  }
  const outcome = resolveZCodePlugins({
    workingDirectory: params.workspace.workspacePath,
  });
  const displayByPluginId = resolveReferenceListingDisplayByPluginId(
    params.workspace.workspacePath,
  );
  return {
    authority: "workspace",
    plugins: buildPluginReferenceCatalog(outcome.plugins).plugins.map((entry) =>
      toReferenceCatalogEntry(entry, displayByPluginId, includeCategory),
    ),
  };
}

const SUGGESTED_PLUGIN_MARKETPLACE = ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID;
const SUGGESTED_PLUGIN_MARKETPLACE_REFRESH_TIMEOUT_MS = 10_000;

/** Pre-install trusted resolution of a recommended Prompt; a missing entry must first refresh the official catalog, and installing from a stale snapshot is forbidden when that fails. */
export async function resolveSuggestedPluginReference(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodePluginsResolveSuggestedReferenceResult> {
  const params = parseParams(zcodePluginsResolveSuggestedReferenceParamsSchema, rawParams);
  const stableId = params.stableId.trim();
  const at = stableId.lastIndexOf("@");
  const pluginName = at > 0 ? stableId.slice(0, at) : "";
  const marketplace = at > 0 ? stableId.slice(at + 1) : "";
  const diagnostic = (code: string, message: string): SharedPluginDiagnostic => ({
    code,
    message,
    severity: "error",
    pluginId: stableId,
  });
  const unavailable = (code: string, message: string) => ({
    stableId,
    status: "unavailable" as const,
    diagnostics: [diagnostic(code, message)],
  });

  if (
    !pluginName ||
    marketplace !== SUGGESTED_PLUGIN_MARKETPLACE ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(stableId)
  ) {
    return unavailable(
      "plugin_suggested_reference_untrusted_source",
      "the suggested plugin is not from the trusted official zcode-plugins-official source",
    );
  }

  const workingDirectory = params.workspace.workspacePath;
  const readState = () => {
    const outcome = resolveZCodePlugins({ logger: context.logger, workingDirectory });
    const entry = buildPluginReferenceCatalog(outcome.plugins).plugins.find(
      (candidate) => candidate.pluginId === stableId,
    );
    return { outcome, entry };
  };
  let displayByPluginId: Map<string, PluginReferenceListingDisplay> | undefined;
  const resolveIcon = () => {
    // The icon only comes from the cached official listing of the target Host and is returned once with trusted resolution; the UI no longer reads it for it
    // workspace referenceCatalog. overview does not wait for the network, and will be downgraded by the None icon when missing.
    displayByPluginId ??= resolveReferenceListingDisplayByPluginId(workingDirectory);
    return displayByPluginId.get(stableId)?.icon;
  };
  const toResult = (entry: PluginReferenceCatalogEntry) => {
    const icon = resolveIcon();
    return {
      stableId,
      status: (entry.conflictingPluginIds.length > 0
        ? "conflict"
        : entry.enabled
          ? "ready"
          : "disabled") as "conflict" | "ready" | "disabled",
      marketplace,
      pluginName,
      sourceTrust: "official" as const,
      ...(icon ? { icon } : {}),
      diagnostics:
        entry.conflictingPluginIds.length > 0
          ? [
              diagnostic(
                "plugin_suggested_reference_conflict",
                "the suggested plugin conflicts with an existing plugin of the same name and cannot be installed or referenced automatically",
              ),
            ]
          : [],
    };
  };

  const initial = readState();
  if (initial.entry) return toResult(initial.entry);

  // The old process only returns the missing results to the UI after the official Marketplace refresh is completed. During the network waiting period
  // Without any feedback, users will mistakenly think that the click has not taken effect. After the first local check is missing, the same operation is notified to enter loading.
  context.notify({
    method: zcodeProtocolNotifications.pluginOperationProgress,
    params: { operationId: params.operationId, state: "refreshing" },
  });

  const refreshController = new AbortController();
  const abortRefresh = () => refreshController.abort(signal?.reason);
  if (signal?.aborted) abortRefresh();
  else signal?.addEventListener("abort", abortRefresh, { once: true });
  let refreshTimedOut = false;
  let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const refreshRequest = updateZCodePluginMarketplace({
      abortSignal: refreshController.signal,
      logger: context.logger,
      marketplace: SUGGESTED_PLUGIN_MARKETPLACE,
      workingDirectory,
    });
    const refreshTimeoutRequest = new Promise<never>((_, reject) => {
      // A refresh timeout must abort the underlying network/process; simply ending the protocol wait will allow old operations to continue overwriting the directory snapshot.
      refreshTimeout = setTimeout(() => {
        refreshTimedOut = true;
        const timeoutError = new Error("refreshing zcode-plugins-official timed out (10000 ms)");
        timeoutError.name = "TimeoutError";
        refreshController.abort(timeoutError);
        reject(timeoutError);
      }, SUGGESTED_PLUGIN_MARKETPLACE_REFRESH_TIMEOUT_MS);
    });
    const refreshed = await Promise.race([refreshRequest, refreshTimeoutRequest]);
    if (signal?.aborted)
      return unavailable("plugin_operation_cancelled", "plugin operation cancelled");
    const failure = refreshed.diagnostics.find(
      (item) => item.pluginId === SUGGESTED_PLUGIN_MARKETPLACE,
    );
    if (failure) return unavailable("marketplace_refresh_failed", failure.message);
  } catch (error) {
    if (refreshTimedOut) {
      return unavailable(
        "marketplace_refresh_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (signal?.aborted) {
      return unavailable("plugin_operation_cancelled", "plugin operation cancelled");
    }
    return unavailable(
      "marketplace_refresh_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (refreshTimeout !== undefined) clearTimeout(refreshTimeout);
    signal?.removeEventListener("abort", abortRefresh);
  }

  const afterRefresh = readState();
  if (afterRefresh.entry) return toResult(afterRefresh.entry);
  const overview = getZCodePluginsOverview({ logger: context.logger, workingDirectory });
  const candidate = overview.availablePlugins.find((item) => item.id === stableId);
  if (
    !candidate ||
    candidate.name !== pluginName ||
    candidate.marketplace !== SUGGESTED_PLUGIN_MARKETPLACE
  ) {
    return unavailable(
      "plugin_suggested_reference_not_listed",
      "the plugin was not found in the refreshed official catalog",
    );
  }
  const icon = candidate.listing?.icon?.trim();
  return {
    stableId,
    status: "missing",
    marketplace: SUGGESTED_PLUGIN_MARKETPLACE,
    pluginName: candidate.name,
    sourceTrust: "official",
    ...(icon ? { icon } : {}),
    ...(candidate.listing ? { listing: candidate.listing } : {}),
    diagnostics: [],
  };
}

/**
 * icon/displayName(I18n) are a mutable display projection of the target Host Marketplace listing, not part of the frozen
 * Session identity. Root cause: the store listing is the source of truth for the original icon / localized display name; the plugin
 * manifest/runtime metadata does not carry them. workingDirectory is only used to locate data along the existing Host/config
 * boundary; here the join is by stable ID and is used only for Picker/chip display and search,
 * while the reminder still consumes only the core identity catalog.
 */
interface PluginReferenceListingDisplay {
  category?: string;
  icon?: string;
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  description?: string;
  descriptionI18n?: Record<string, string>;
}

function resolveReferenceListingDisplayByPluginId(
  workspacePath: string,
): Map<string, PluginReferenceListingDisplay> {
  const overview = getZCodePluginsOverview({ workingDirectory: workspacePath });
  const displayByPluginId = new Map<string, PluginReferenceListingDisplay>();
  for (const plugin of [
    ...overview.availablePlugins,
    ...overview.installedPlugins,
    ...overview.restorableBuiltins,
  ]) {
    const category = plugin.listing?.category?.trim();
    const icon = plugin.listing?.icon?.trim();
    const displayName = plugin.listing?.displayName?.trim();
    const displayNameI18n = plugin.listing?.displayNameI18n;
    const description = plugin.description?.trim();
    const descriptionI18n = plugin.listing?.descriptionI18n;
    if (!category && !icon && !displayName && !displayNameI18n && !description && !descriptionI18n)
      continue;
    displayByPluginId.set(plugin.id, {
      ...displayByPluginId.get(plugin.id),
      ...(category ? { category } : {}),
      ...(icon ? { icon } : {}),
      ...(displayName ? { displayName } : {}),
      ...(displayNameI18n ? { displayNameI18n } : {}),
      ...(description ? { description } : {}),
      ...(descriptionI18n ? { descriptionI18n } : {}),
    });
  }
  return displayByPluginId;
}

// Identity/capability projection explicitly discards rootPath (only used by runtime internal provenance, the path does not exit the protocol);
// icon/displayName(I18n)/description(I18n) is for display only and does not change the identifiers-only reminder contract.
function toReferenceCatalogEntry(
  entry: PluginReferenceCatalogEntry,
  displayByPluginId: ReadonlyMap<string, PluginReferenceListingDisplay>,
  includeCategory = false,
): ZCodePluginReferenceCatalogEntry {
  const display = displayByPluginId.get(entry.pluginId);
  return {
    ...(includeCategory ? { category: display?.category ?? "other" } : {}),
    pluginId: entry.pluginId,
    name: entry.name,
    marketplace: entry.marketplace,
    ...(display?.icon ? { icon: display.icon } : {}),
    ...(display?.displayName ? { displayName: display.displayName } : {}),
    ...(display?.displayNameI18n ? { displayNameI18n: display.displayNameI18n } : {}),
    ...(display?.description ? { description: display.description } : {}),
    ...(display?.descriptionI18n ? { descriptionI18n: display.descriptionI18n } : {}),
    enabled: entry.enabled,
    conflictingPluginIds: entry.conflictingPluginIds,
    skillQualifiedNames: entry.skillQualifiedNames,
    mcpServerNames: entry.mcpServerNames,
    subagentNames: entry.subagentNames ?? [],
  };
}
