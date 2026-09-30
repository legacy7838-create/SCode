/**
 * Build-time switch: When true, the installation package uses the Preview identity, and the backend environment is still determined by `ZCODE_ENV` alone.
 * Typical usage is `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1` to get a connection to the production backend,
 * `ZCode Preview` that can be installed side by side with the official version.
 */
export const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "dev.zcode.app",
  productName: "ZCode",
  linuxExecutableName: "zcode",
  linuxPackageName: "zcode",
  cuaHelperInstallVariant: null,
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "dev.zcode.app.preview",
  productName: "ZCode Preview",
  linuxExecutableName: "zcode-preview",
  linuxPackageName: "zcode-preview",
  cuaHelperInstallVariant: "preview",
});

export const desktopProductIdentities = Object.freeze({
  production: PRODUCTION_IDENTITY,
  preview: PREVIEW_IDENTITY,
});

function normalizeDesktopZCodeEnv(env) {
  return env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * The switch has only one on spelling of `1` (`0` / null = off), as is the case with CI workflow rules and release gates
 * `$ZCODE_PREVIEW_IDENTITY == "1"` Exact comparisons maintain the same set of semantics. Other spellings simply fail during the build phase,
 * To prevent `true` from leaking matches at the YAML routing layer but being treated as enabled at the script layer, enter the Preview package into the production acceptance directory.
 */
export function isPreviewIdentityRequested(env = process.env) {
  const value = env[ZCODE_PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_PREVIEW_IDENTITY_ENV}=${env[ZCODE_PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * Product identity (flavor) and backend environment (`ZCODE_ENV`) are two axes:
 * - `ZCODE_ENV=test` is always Preview, and the test backend cannot cover the user's official installation with the official `ZCode` identity;
 * - `ZCODE_ENV=production` defaults to the official identity. When `ZCODE_PREVIEW_IDENTITY=1` is specified, the Preview identity is used instead.
 * Unknown `ZCODE_ENV` continues to be processed as test, which is consistent with the fail-safe default value of normalizeZCodeEnv in the shared layer.
 */
export function resolveDesktopProductFlavor(env = process.env) {
  if (isPreviewIdentityRequested(env)) {
    return "preview";
  }
  return normalizeDesktopZCodeEnv(env) === "production" ? "production" : "preview";
}

export function resolveDesktopProductIdentity(env = process.env) {
  return desktopProductIdentities[resolveDesktopProductFlavor(env)];
}

/**
 * The product file name suffix marks the backend environment rather than the identity: `_TEST` only appears on the installation package of the test backend.
 * The Preview package of the production backend is distinguished from the official package by productName (`ZCode Preview-<version>-...`).
 */
export function resolveDesktopArtifactSuffix(env = process.env) {
  return normalizeDesktopZCodeEnv(env) === "test" ? "_TEST" : "";
}

/**
 * Returns the AppUserModelId used by the Windows Shell.
 *
 * The packaged state must reuse the appId of electron-builder, otherwise the AUMID and start menu index in the shortcut
 * and a running Electron process will be treated as three different applications by Windows. The development state continues to retain its old identity.
 * Avoid mutual contamination of local debugging shortcuts and official/Preview installation packages.
 */
export function resolveWindowsAppUserModelIdForFlavor(flavor, runtime = { isPackaged: true }) {
  if (runtime.isPackaged === false) {
    return "cn.aminer.zcode";
  }
  return desktopProductIdentities[flavor === "preview" ? "preview" : "production"].appId;
}

export function resolveWindowsAppUserModelId(env = process.env, runtime = { isPackaged: true }) {
  return resolveWindowsAppUserModelIdForFlavor(resolveDesktopProductFlavor(env), runtime);
}
