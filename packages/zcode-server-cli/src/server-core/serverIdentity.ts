import { validateServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";

/**
 * Reads the installation-level Server identity. A real Supervisor launch must supply a server root; when it is absent
 * the HTTP factory stays compatible with embedded use and unit tests, leaving it to the caller to decide whether to use the hostname fallback.
 */
export async function resolveCoreServerId(
  serverRoot = process.env.ZCODE_SERVER_ROOT?.trim(),
): Promise<string | undefined> {
  if (!serverRoot) return undefined;
  const ownership = await validateServerInstallOwnership(resolveServerLayout(serverRoot));
  return ownership.installationId;
}
