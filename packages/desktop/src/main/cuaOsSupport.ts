import { release } from "node:os";
import type { CuaOsSupport } from "@zcode/shared";

// Promise Floor = max(Helper Info.plist LSMinimumSystemVersion 12.0, SEA Binary minos 11.0).
// 2026-08 Incident: When the floor check is missing, users of lower versions of macOS only see authorization repeatedly and no response.
// (The real reason is LaunchServices -10825 refusing to launch Helper).
const CUA_MINIMUM_MACOS_VERSION = "12.0";
// The floor is linked with the Info.plist LSMinimumSystemVersion(12.0) of the upstream zcode-cua helperAppBundle.ts,
// Either side of bump must synchronize the remaining constants.
const CUA_MINIMUM_DARWIN_MAJOR = 21; // Darwin major - 9 = macOS major (21↔12, 22↔13)

function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
): CuaOsSupport {
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
