import {
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
} from "@zcode/zcode-cua/broker/server";

type CuaHelperInstallerFactory = (options: CuaHelperInstallerOptions) => CuaHelperInstaller;

/**
 * macOS `lipo -archs` reports `x86_64` for Intel binaries, while Node's runtime architecture
 * name is `x64`. Both denote the same architecture; comparing the strings directly would make
 * a legitimate Intel Helper be judged unavailable.
 */
export function normalizeCuaHelperArch(rawArch: string): string {
  switch (rawArch.trim().toLowerCase()) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return rawArch.trim();
  }
}

export function normalizeCuaHelperArchs(archs: readonly string[]): string[] {
  return [...new Set(archs.map(normalizeCuaHelperArch).filter(Boolean))];
}

export function canonicalizeCuaHelperInstallerOptions(
  options: CuaHelperInstallerOptions,
): CuaHelperInstallerOptions {
  const readExecutableArchs =
    options.dependencies?.readExecutableArchs ??
    defaultCuaHelperVerifierDependencies.readExecutableArchs;
  return {
    ...options,
    dependencies: {
      ...options.dependencies,
      readExecutableArchs: async (executablePath) =>
        normalizeCuaHelperArchs(await readExecutableArchs(executablePath)),
    },
  };
}

export function createCanonicalCuaHelperInstaller(
  options: CuaHelperInstallerOptions,
  createInstaller: CuaHelperInstallerFactory = createCuaHelperInstaller,
): CuaHelperInstaller {
  return createInstaller(canonicalizeCuaHelperInstallerOptions(options));
}
