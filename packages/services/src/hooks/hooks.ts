import type { Hook, ZCodeWorkspaceHookTrustGrantResult } from "@zcode/shared";
import type { WorkspaceHookBundleSnapshotData } from "@zcode/shared/workspace-hook-discovery";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IHooksService {
  /**
   * Load the hooks configuration of the workspace
   */
  loadHooks(params: { workspaceIdentity?: string; workspacePath: string }): Promise<{
    hooks: Hook[];
    hooksEnabled: boolean;
    workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
    /** True when the trust store file is damaged/unreadable (fail-closed: all hooks are treated as non-persistent trust) */
    trustStoreCorrupt?: boolean;
  }>;

  /**
   * Save hooks configuration
   */
  saveHooks(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    hooks: Hook[];
  }): Promise<void>;

  /**
   * Workspace Hook without task/session pre-trust.
   * The implementation must forward to the Agent authority to rediscover the canonical snapshot, and prohibit service/UI from directly writing to the store.
   */
  grantWorkspaceHookTrust?(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }): Promise<ZCodeWorkspaceHookTrustGrantResult>;
}

export const IHooksService = createServiceDescriptor<IHooksService>(ServiceChannels.Hooks);
