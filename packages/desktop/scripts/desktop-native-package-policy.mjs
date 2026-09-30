const SUPPORTED_DESKTOP_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

function assertSupportedTargetPlatformKey(targetPlatformKey) {
  if (!SUPPORTED_DESKTOP_PLATFORM_KEYS.includes(targetPlatformKey)) {
    throw new Error(`Unsupported desktop target platform: ${targetPlatformKey}`);
  }
}

export function createDesktopNativePackagePrunePatterns(targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);

  return [
    // PDF preview has been built into the renderer by Vite, the Canvas optional dependency of pdfjs-dist
    // Only serves Node rendering; the 8 sets of Canvas native installed by pnpm cross-platform should not be brought into the desktop installation package.
    "!node_modules/@napi-rs/canvas/**",
    "!node_modules/@napi-rs/canvas-*/**",
    // Linux prebuilds are copied into node-pty beforePack; the source platform package itself is not part of the desktop runtime.
    "!node_modules/@lydell/node-pty-*/**",
    // The desktop runtime uses the target prebuild uniformly, and it is prohibited to bring the installation machine on-site compilation or ABI bin cache into the cross-platform package.
    "!node_modules/node-pty/build/**",
    "!node_modules/node-pty/bin/**",
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/node-pty/prebuilds/${key}/**`,
    ),
  ];
}

function normalizeAsarPath(path) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function parseAsarListWithPackState(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(pack|unpack)\s*:\s*(.+)$/.exec(line);
      if (!match) {
        throw new Error(`Unable to parse asar pack state: ${line}`);
      }
      return { packState: match[1], path: normalizeAsarPath(match[2]) };
    });
}

function isNativeRuntimeFile(path, targetPlatformKey) {
  if (/\.(?:node|dll|dylib|exe)$/i.test(path)) return true;
  return path === `/node_modules/node-pty/prebuilds/${targetPlatformKey}/spawn-helper`;
}

export function findDesktopNativePackageViolations(entries, targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);
  const violations = [];

  for (const entry of entries) {
    const { packState, path } = entry;

    if (
      path === "/node_modules/@napi-rs/canvas" ||
      path.startsWith("/node_modules/@napi-rs/canvas/") ||
      path.startsWith("/node_modules/@napi-rs/canvas-")
    ) {
      violations.push(
        `Canvas native: ${path} should not be packaged unless the renderer is required`,
      );
      continue;
    }

    if (path.startsWith("/node_modules/@lydell/node-pty-")) {
      violations.push(
        `Platform source packages used only for prebuild preparation should not be packaged: ${path}`,
      );
      continue;
    }

    if (
      path.startsWith("/node_modules/node-pty/build/") ||
      path.startsWith("/node_modules/node-pty/bin/")
    ) {
      violations.push(`Installer-generated node-pty artifacts should not be packaged: ${path}`);
      continue;
    }

    const nodePtyPrebuildMatch = /^\/node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(path);
    if (nodePtyPrebuildMatch && nodePtyPrebuildMatch[1] !== targetPlatformKey) {
      violations.push(`node-pty contains non-target platform prebuild: ${path}`);
      continue;
    }

    if (isNativeRuntimeFile(path, targetPlatformKey) && packState !== "unpack") {
      violations.push(`The native file remains as packed payload in app.asar: ${path}`);
    }
  }

  return violations;
}
