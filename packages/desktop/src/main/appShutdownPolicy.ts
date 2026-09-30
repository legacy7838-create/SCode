export type AppShutdownKind = "normal" | "update-install";

interface AppShutdownPolicy {
  forceKillDelayMs: number;
  waitTimeoutMs: number;
}

interface AppShutdownPolicySelection {
  kind: AppShutdownKind;
  policy: AppShutdownPolicy;
  upgraded: boolean;
}

const STRICT_SHUTDOWN_POLICY: AppShutdownPolicy = {
  forceKillDelayMs: 7_500,
  waitTimeoutMs: 9_000,
};

const WINDOWS_NORMAL_SHUTDOWN_POLICY: AppShutdownPolicy = {
  // Ordinary exit still leaves 3.5 seconds of execution time for the process tree inside the Host.
  // However, it no longer bears the additional margin required for resource lock scanning before updating.
  forceKillDelayMs: 4_000,
  waitTimeoutMs: 4_500,
};

export function resolveAppShutdownPolicy(
  kind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicy {
  if (platform === "win32" && kind === "normal") {
    return WINDOWS_NORMAL_SHUTDOWN_POLICY;
  }
  return STRICT_SHUTDOWN_POLICY;
}

export function selectAppShutdownPolicy(
  activeKind: AppShutdownKind | null,
  requestedKind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicySelection {
  // The priority of update installation is only increasing: the created ordinary exit short timer does not do destructive reconstruction, and the update is still
  // After the existing barrier, fail-open enters the resource scanning and installer to ensure that "possible remaining" will not be upgraded to "unupdateable".
  const kind =
    activeKind === "update-install" || requestedKind === "update-install"
      ? "update-install"
      : "normal";
  return {
    kind,
    policy: resolveAppShutdownPolicy(kind, platform),
    upgraded: activeKind === "normal" && kind === "update-install",
  };
}
