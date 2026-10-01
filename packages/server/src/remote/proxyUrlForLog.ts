import { isIP } from "node:net";

/**
 * Render a proxy URL for a log line with its credentials removed.
 *
 * Moved here from `wslProxy.ts` when the WSL backend was removed
 * (`docs/specs/remove-wsl.md`): the formatter is not WSL-specific — it is used
 * for `network.httpProxy` on every remote kind, and it is the only thing
 * standing between a proxy URL with an embedded password and the log file.
 * Keeping it under the WSL name would have meant deleting live credential
 * redaction along with the feature.
 */
export function formatProxyUrlForLog(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const displayHost = isIP(host) === 6 ? `[${host}]` : host;
    return `${url.protocol}//${displayHost}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "<invalid-proxy>";
  }
}