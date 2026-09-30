function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeRemotePlatform(rawPlatform: string): string {
  const platform = normalizeToken(rawPlatform);

  if (platform === "darwin" || platform === "macos") {
    return "darwin";
  }

  if (platform === "linux" || platform === "gnu/linux") {
    return "linux";
  }

  if (
    platform === "windows_nt" ||
    platform.startsWith("mingw") ||
    platform.startsWith("msys") ||
    platform.startsWith("cygwin")
  ) {
    return "win32";
  }

  return platform;
}

export function normalizeRemoteArch(rawArch: string): string {
  const arch = normalizeToken(rawArch);

  if (arch === "x86_64" || arch === "amd64") {
    return "x64";
  }

  if (arch === "aarch64" || arch === "arm64e") {
    return "arm64";
  }

  return arch;
}

export function resolveRemotePlatform(reportedPlatform: string, kernelOstype: string): string {
  const normalizedReportedPlatform = normalizeRemotePlatform(reportedPlatform);
  const normalizedKernelOstype = normalizeRemotePlatform(kernelOstype);

  // Some SSH test containers will disguise `uname -s` as Darwin,
  // But the bottom layer is still the Linux kernel. Simply pressing Darwin to select the package will upload Mach-O and trigger an Exec format error in the container.
  // Here, priority is given to trusting the real kernel type exposed by /proc to avoid misjudgment of Linux containers as macOS.
  if (normalizedReportedPlatform === "darwin" && normalizedKernelOstype === "linux") {
    return "linux";
  }

  return normalizedReportedPlatform;
}
