import type { AppSettings } from "@zcode/shared";

export function normalizeSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const normalizedPatch = { ...patch };

  if (
    "terminalFontFamily" in normalizedPatch &&
    typeof normalizedPatch.terminalFontFamily === "string"
  ) {
    // Terminal font overlay needs to support automatic detection after clearing and returning to the system profile.
    // RPC transmission will swallow undefined. Here, the empty string is normalized to undefined to prevent the old font from remaining.
    const trimmedTerminalFontFamily = normalizedPatch.terminalFontFamily.trim();
    normalizedPatch.terminalFontFamily =
      trimmedTerminalFontFamily.length > 0 ? trimmedTerminalFontFamily : undefined;
  }

  if ("integratedTerminalShell" in normalizedPatch) {
    const selection = normalizedPatch.integratedTerminalShell;
    if (selection?.mode === "auto") {
      // "Auto-select" on the settings page means to remove the user override and let the Bash execution layer continue to use the automatic detection of the current platform.
      normalizedPatch.integratedTerminalShell = undefined;
    } else if (selection?.mode === "shell") {
      normalizedPatch.integratedTerminalShell = {
        ...selection,
        id: selection.id.trim(),
        label: selection.label.trim(),
        path: selection.path.trim(),
      };
    }
  }

  if ("httpProxy" in normalizedPatch && typeof normalizedPatch.httpProxy === "string") {
    // Clearing the proxy now represents an explicit direct connection and no longer falls back on user shell environment variables.
    // RPC will swallow undefined. Here, the empty string is converted to undefined to prevent the old proxy from remaining in setting.json.
    const trimmedHttpProxy = normalizedPatch.httpProxy.trim();
    normalizedPatch.httpProxy = trimmedHttpProxy.length > 0 ? trimmedHttpProxy : undefined;
  }

  if (
    "httpProxyNoProxy" in normalizedPatch &&
    typeof normalizedPatch.httpProxyNoProxy === "string"
  ) {
    // No Proxy is part of the proxy policy, and the old value must be deleted when clearing.
    // Otherwise, the explicit proxy will still be bypassed next time the agent/renderer is started.
    const trimmedHttpProxyNoProxy = normalizedPatch.httpProxyNoProxy.trim();
    normalizedPatch.httpProxyNoProxy =
      trimmedHttpProxyNoProxy.length > 0 ? trimmedHttpProxyNoProxy : undefined;
  }

  if (
    "httpProxyCaCertPath" in normalizedPatch &&
    typeof normalizedPatch.httpProxyCaCertPath === "string"
  ) {
    // The custom CA must come from an explicit path on the settings page; old values are deleted when clearing the input.
    // Otherwise, the agent will continue to inject NODE_EXTRA_CA_CERTS after restarting.
    const trimmedHttpProxyCaCertPath = normalizedPatch.httpProxyCaCertPath.trim();
    normalizedPatch.httpProxyCaCertPath =
      trimmedHttpProxyCaCertPath.length > 0 ? trimmedHttpProxyCaCertPath : undefined;
  }

  if (
    "zcodeEndpointOrigin" in normalizedPatch &&
    typeof normalizedPatch.zcodeEndpointOrigin === "string"
  ) {
    // Non-production endpoint override needs to support Reset clearing; when RPC/JSON is unstable to undefined, you can use an empty string to return to the default production domain.
    const trimmedZCodeEndpointOrigin = normalizedPatch.zcodeEndpointOrigin.trim();
    normalizedPatch.zcodeEndpointOrigin =
      trimmedZCodeEndpointOrigin.length > 0 ? trimmedZCodeEndpointOrigin : undefined;
  }

  if (
    "providerFamilyDomain" in normalizedPatch &&
    typeof normalizedPatch.providerFamilyDomain === "string"
  ) {
    // When exiting/unbinding the current provider family, you need to clear the running domain.
    // RPC transmission will swallow undefined. Here, the empty string is normalized to undefined to prevent the old selection from continuing to affect the registry filtering.
    const trimmedProviderFamilyDomain = normalizedPatch.providerFamilyDomain.trim();
    normalizedPatch.providerFamilyDomain =
      trimmedProviderFamilyDomain.length > 0 ? normalizedPatch.providerFamilyDomain : undefined;
  }

  return normalizedPatch;
}
