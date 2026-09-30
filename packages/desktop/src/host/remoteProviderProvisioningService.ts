import { randomUUID } from "node:crypto";
import type { ProviderProvisioningResult } from "@zcode/shared";
import type { IProviderProvisioningTargetService, IServiceAccessor } from "@zcode/services";
import {
  getProviderProvisioningSource,
  type ProviderProvisioningSource,
} from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";

interface RemoteProviderProvisioningExecutor {
  syncLocalToRemote(): Promise<ProviderProvisioningResult>;
}

const executors = new WeakMap<ServiceCollection, RemoteProviderProvisioningExecutor>();

/** Window-host private execution capability; never exposed to renderer RPC through the ServiceCollection. */
export function getRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
): RemoteProviderProvisioningExecutor | undefined {
  return executors.get(services);
}

export function registerRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
  executor: RemoteProviderProvisioningExecutor,
): void {
  executors.set(services, executor);
}

function createRemoteProviderProvisioningExecutor(options: {
  source?: ProviderProvisioningSource;
  target?: IProviderProvisioningTargetService;
}): RemoteProviderProvisioningExecutor {
  const syncLocalToRemote = async (): Promise<ProviderProvisioningResult> => {
    const syncId = randomUUID();
    if (!options.source || !options.target) {
      return unsupportedResult(
        syncId,
        "Local/Remote Provider Provisioning capability is unavailable",
      );
    }
    try {
      const envelope = await options.source.read(syncId);
      return await options.target.apply(envelope);
    } catch (error) {
      return {
        syncId,
        status: "failed",
        personalProviderCount: 0,
        credentialCount: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
        rolledBack: true,
      } satisfies ProviderProvisioningResult;
    }
  };

  return { syncLocalToRemote };
}

export function createRemoteProviderProvisioningExecutorFromWorkspace(options: {
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
}): RemoteProviderProvisioningExecutor {
  const source = options.sourceServices
    ? getProviderProvisioningSource(options.sourceServices)
    : undefined;
  const target = (
    options.connectionServices as IServiceAccessor & {
      providerProvisioningTargetService?: IProviderProvisioningTargetService;
    }
  ).providerProvisioningTargetService;
  return createRemoteProviderProvisioningExecutor({ source, target });
}

function unsupportedResult(syncId: string, errorMessage: string): ProviderProvisioningResult {
  return {
    syncId,
    status: "unsupported",
    personalProviderCount: 0,
    credentialCount: 0,
    errorMessage,
    rolledBack: false,
  };
}
