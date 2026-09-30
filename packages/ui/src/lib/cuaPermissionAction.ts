import type { CuaAccessibilitySettingsResult } from "@zcode/shared";

function normalizeToolName(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/_/g, "-") ?? "";
}

export function isZCodeCuaToolName(value: string | null | undefined): boolean {
  const normalized = normalizeToolName(value);
  // The server key section is computer-use. feat: mcp__computer-use__*;
  // The plugin MCP naming convention of main v3.5.3 adds namespace to the plugin server:
  // mcp__plugin_zcode-cua_computer-use__* (after normalization, the server segment is preceded by a single hyphen cua-computer-use,
  // not a double hyphen). Both forms contain the "computer-use" string - compatible with includes, otherwise main's namespace
  // The prefix will cause cua tool recognition to fail and ToolCallBlock to degrade into fallback rendering. "computer-use" is specific enough
  // (Only cua server uses this key, and there will be no misjudgment of android-emulator/browser-use, etc.).
  return normalized === "computer-use" || normalized.includes("computer-use");
}

function didReturnFromCuaPermissionSettings(
  result: CuaAccessibilitySettingsResult | null | undefined,
): boolean {
  // main is only set to true after the entire set of staged panes has completed and ZCode application level returns have been observed. renderer focus
  // May come from TCC native prompt, another window or normal switch, and can no longer be used as authorization completion signal.
  return (
    result?.success === true &&
    result.returnedFromSettings === true &&
    typeof result.sessionId === "string" &&
    result.sessionId.length > 0
  );
}

export function shouldRestartHelperAfterCuaPermissionReturn(
  result: CuaAccessibilitySettingsResult | null | undefined,
): boolean {
  // restartHelperAfterReturn is additive main ABI. The old version of main does not return this field, and still uses the previous single-window owner
  // Processing; the new version of main only returns false for repeated joins of the same renderer/host, and independent Helpers in different windows are restored separately.
  return didReturnFromCuaPermissionSettings(result) && result?.restartHelperAfterReturn !== false;
}

export interface CuaPermissionReturnRecoveryState {
  /** Monotonically unique across open/workspace resets; local epochs cannot serve as asynchronous operation identities alone. */
  generation: number;
  contextKey: string;
  epoch: number;
  pending: boolean;
  automaticAttempted: boolean;
}

export interface CuaPermissionReturnRecoveryClaim {
  readonly state: CuaPermissionReturnRecoveryState;
  readonly generation: number;
  readonly contextKey: string;
  readonly epoch: number;
}

let nextCuaPermissionRecoveryGeneration = 0;

export function createCuaPermissionReturnRecoveryState(
  contextKey = "",
): CuaPermissionReturnRecoveryState {
  nextCuaPermissionRecoveryGeneration += 1;
  return {
    generation: nextCuaPermissionRecoveryGeneration,
    contextKey,
    epoch: 0,
    pending: false,
    automaticAttempted: false,
  };
}

function recoveryClaim(state: CuaPermissionReturnRecoveryState): CuaPermissionReturnRecoveryClaim {
  return {
    state,
    generation: state.generation,
    contextKey: state.contextKey,
    epoch: state.epoch,
  };
}

export function markCuaPermissionOnboardingOpened(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim {
  state.epoch += 1;
  state.pending = true;
  state.automaticAttempted = false;
  return recoveryClaim(state);
}

export function claimCuaPermissionReturnRecovery(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim | null {
  // Ordinary focus, intermediate focus of native prompt, and repeated focus of the same authorized action have no side effects.
  if (!state.pending || state.automaticAttempted) return null;
  state.automaticAttempted = true;
  return recoveryClaim(state);
}

export function captureCuaPermissionReturnRecovery(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim | null {
  return state.pending ? recoveryClaim(state) : null;
}

export function isCuaPermissionReturnRecoveryCurrent(
  current: CuaPermissionReturnRecoveryState,
  claim: CuaPermissionReturnRecoveryClaim,
): boolean {
  return (
    current === claim.state &&
    current.generation === claim.generation &&
    current.contextKey === claim.contextKey &&
    current.epoch === claim.epoch &&
    current.pending
  );
}

export function completeCuaPermissionReturnRecovery(
  claim: CuaPermissionReturnRecoveryClaim,
  restartSucceeded: boolean,
): void {
  // ref will point to the new state when workspace/open switches, and the local epoch restarts from 0. Old restart Ruona
  // `ref.current + epoch` is completed, and the event of the same number in the workspace will be mistakenly refreshed. claim state/context when permanent binding is initiated;
  // completion can only modify the old object, failure will still remain pending for manual retry in the same context.
  const state = claim.state;
  if (
    restartSucceeded &&
    state.pending &&
    state.generation === claim.generation &&
    state.contextKey === claim.contextKey &&
    state.epoch === claim.epoch
  ) {
    state.pending = false;
  }
}
