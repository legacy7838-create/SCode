// ============================================================
// Dynamic Workflow Grayscale: Server-side feature key value range and client-side snapshot
// ============================================================
// The server `/api/v1/client/configs` delivers `data.configs.dynamicWorkflow.mode`.

// Here only the value range, normalization and snapshot shape common to the three terminals (Host services, Desktop main, UI) are shown;
// Reading the remote end, overwriting and delivering are all in their respective owners, and no requests are made at the shared layer.

export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/**
 * Environment variable for the local override. Its semantics split into three tiers by build
 * flavor, and Desktop main **rewrites or removes** it before forking the Host
 * (buildHostProcessEnv in desktopRuntimeEnv.ts); the Host only consumes it and no longer
 * distinguishes the source:
 *   - unpackaged dev: pass through valid values from the developer's shell;
 *   - packaged preview: always write `alwaysOn`, ignoring the shell;
 *   - packaged production: remove the inherited value, never write it.
 * Web/server Hosts without a main read the process environment directly (operator/developer setting).
 */
export const ZCODE_DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/** Value used when the server omits it, the format is invalid, or the request fails: fail-closed, consistent with the off-peak task rollout. */
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

/**
 * Resolves the three states that preserve the server contract; consumers uniformly convert it into
 * a boolean switch. When onDemand gains behavior of its own later, only the consumer side changes.
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** Source of the snapshot: for observability only, letting the UI and logs tell "server turned it off" apart from "local override". */
export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";

export interface DynamicWorkflowClientConfig {
  readonly mode: DynamicWorkflowMode;
  /** Equals isDynamicWorkflowModeEnabled(mode); kept as its own field so each consumer doesn't have to re-implement the collapse rule. */
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
}

export function createDynamicWorkflowClientConfig(
  mode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return { mode, enabled: isDynamicWorkflowModeEnabled(mode), source };
}

/**
 * Pure function: collapses the remote envelope's `configs.dynamicWorkflow` and the local override
 * environment variable into a single snapshot. Priority: override > valid remote value > default.
 * A successful remote response that **omits** the key also counts as disabled — the server dropping
 * the key means "off", so an old snapshot must not be reused (same ruling as desktopContextPromptRollout).
 */
export function resolveDynamicWorkflowClientConfig(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
}): DynamicWorkflowClientConfig {
  const override = normalizeDynamicWorkflowMode(input.env?.[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]);
  if (override) return createDynamicWorkflowClientConfig(override, "override");
  const remoteMode = normalizeDynamicWorkflowMode(
    typeof input.remote === "object" && input.remote !== null
      ? (input.remote as { mode?: unknown }).mode
      : undefined,
  );
  if (remoteMode) return createDynamicWorkflowClientConfig(remoteMode, "remote");
  return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
}
