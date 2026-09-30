import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderSettingsConnectivityTester } from "./providerFacadeServices.js";

interface FormalModelConnectivityInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly selection: {
    readonly providerId: string;
    readonly modelId: string;
  };
}

type FormalModelConnectivityExecutor = (
  input: FormalModelConnectivityInput,
) => Promise<{ readonly success: true }>;

/**
 * The settings page is only responsible for handing the already-persisted, Registry-entered
 * ModelSelection to the target Environment.
 * Provider auth, headers, reasoning mapping and stream consumption are all handled by the formal
 * Model execution chain.
 */
export function createProviderSettingsConnectivityTester(dependencies: {
  readonly testModelConnectivity: FormalModelConnectivityExecutor;
}): ProviderSettingsConnectivityTester {
  return async (input) => {
    try {
      await dependencies.testModelConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        selection: {
          providerId: input.providerId,
          modelId: input.modelId,
        },
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  };
}

export type { ModelConnectivityResult };
