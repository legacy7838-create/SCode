// Convergence of platform capabilities: Thin service interface of "Plug-in Management" in the settings page.
//
// Background: pluginManagementStore / usePluginUninstall used to directly inject IZCodeAgentService.
// The UI layer is therefore scattered with 13 plugins/* consumption points for the old protocol words. After converging into an independent thin service, the UI only relies on
// This interface; the host-side consumption points of plugins/* vocabulary are gathered into pluginManagementService (plug-in
// The source of fact is in the zcode-cli process, and the service implementation is still round-trip via the agent protocol - the closure ownership of the plugins vocabulary
// The protocol evolution of the plug-in capability itself is not within the scope of the session v4 vocabulary).
// Note that it is different from the existing IPluginsService (retired marketplace pluginStore channel):
// That set of interfaces is addressed by pluginName+marketplace and the method semantics are outdated and are not reused to avoid signature conflicts.
import type { Event } from "@zcode/rpc";
import type {
  ZCodePluginOperationProgressNotification,
  ZCodePluginsConfigureResult,
  ZCodePluginsCancelOperationResult,
  ZCodePluginsDescribeResult,
  ZCodePluginsInstallResult,
  ZCodePluginsListResult,
  ZCodePluginsMarketplaceMutationResult,
  ZCodePluginsOverviewResult,
  ZCodePluginsReferenceCatalogResult,
  ZCodePluginsRestoreBuiltinResult,
  ZCodePluginsSetEnabledResult,
  ZCodePluginsUninstallResult,
  ZCodePluginsValidateResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentValidatePluginParams,
} from "../zcode-agent/zcodeAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsListResult>;
  /**
   * The Plugin dialog references the catalog:
   * With sessionId → session-owned frozen catalog; without → workspace current catalog.
   * Implement routing to the workspace-level agent client without using plug-ins to manage independent processes.
   */
  getPluginReferenceCatalog(
    params: ZCodeAgentPluginReferenceCatalogParams,
  ): Promise<ZCodePluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: ZCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@zcode/shared").ZCodePluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ZCodePluginOperationProgressNotification>;
  getPluginsOverview(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsOverviewResult>;
  addPluginMarketplace(
    params: ZCodeAgentAddPluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ZCodeAgentRemovePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ZCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  installPlugin(params: ZCodeAgentInstallPluginParams): Promise<ZCodePluginsInstallResult>;
  cancelPluginOperation(
    params: ZCodeAgentCancelPluginOperationParams,
  ): Promise<ZCodePluginsCancelOperationResult>;
  uninstallPlugin(params: ZCodeAgentUninstallPluginParams): Promise<ZCodePluginsUninstallResult>;
  updatePlugin(params: ZCodeAgentUpdatePluginParams): Promise<ZCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ZCodeAgentRestoreBuiltinPluginParams,
  ): Promise<ZCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: ZCodeAgentConfigurePluginParams): Promise<ZCodePluginsConfigureResult>;
  resetPluginConfig(
    params: ZCodeAgentResetPluginConfigParams,
  ): Promise<ZCodePluginsConfigureResult>;
  validatePlugin(params: ZCodeAgentValidatePluginParams): Promise<ZCodePluginsValidateResult>;
  describePlugin(params: ZCodeAgentDescribePluginParams): Promise<ZCodePluginsDescribeResult>;
  setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams): Promise<ZCodePluginsSetEnabledResult>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);
