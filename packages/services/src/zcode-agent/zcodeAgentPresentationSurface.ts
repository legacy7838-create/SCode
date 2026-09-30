import type { ServiceAuthorityMode } from "@zcode/shared";

export type ZCodeAgentPresentationSurface = "desktop";

interface ZCodeAgentPresentationHostFacts {
  runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  serviceAuthorityMode?: ServiceAuthorityMode;
  /** Main has completed the server-side single-function grayscale decision; if not provided, the historical Host assembly semantics will be maintained. */
  desktopContextPromptEnabled?: boolean;
}

export function resolveZCodeAgentPresentationSurface(
  facts: ZCodeAgentPresentationHostFacts,
): ZCodeAgentPresentationSurface | undefined {
  // Desktop rendering capabilities must be derived from the Host's existing trusted assembly facts and cannot have each caller repeatedly pass independent switches.
  // Ordinary HTTP/manual app-server does not have these two facts and continues to maintain the terminal to avoid spreading the Desktop prompt.
  const isDesktopHost =
    facts.runtimeSurface === "desktop_local_host" ||
    facts.serviceAuthorityMode === "desktop-attached-remote";
  if (!isDesktopHost || facts.desktopContextPromptEnabled === false) {
    return undefined;
  }
  return "desktop";
}
