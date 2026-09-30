import type { CuaPermissionKind } from "@zcode/shared";
import type { CuaPermissionStatus } from "@zcode/services";

function isActionablePermissionState(state: CuaPermissionStatus["accessibility"]): boolean {
  return state === "denied" || state === "stale";
}

/**
 * After the modal or the click entry point re-queries, only the definite gaps in a fresh, usable
 * TCC snapshot are handed to one-click authorization. Probe failures and unknown only feed
 * verification/retry, and must never be back-inferred as missing system permissions.
 */
export function requiredCuaPermissionsForFreshStatus(
  status: CuaPermissionStatus | null,
): CuaPermissionKind[] {
  if (!status) return [];
  const required: CuaPermissionKind[] = [];
  if (isActionablePermissionState(status.accessibility)) {
    required.push("accessibility");
  }
  if (isActionablePermissionState(status.screenRecording)) {
    required.push("screen_recording");
  }
  return required;
}
