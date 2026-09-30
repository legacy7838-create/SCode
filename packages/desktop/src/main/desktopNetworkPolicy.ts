import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProxyConfig, Session } from "electron";
import { EMBEDDED_BROWSER_PARTITION } from "./browserDataManager.js";

interface DesktopNetworkPolicySettings {
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  embeddedBrowserAllowInsecureCertificates?: boolean;
}

/**
 * Sets back-up mode when page proxy is left empty.
 *
 * `direct` is Electron's "never use proxy", which will block the local system proxy together;
 * `system` reads OS network settings (macOS network preferences / Windows Internet options),
 * It has nothing to do with environment variables such as `HTTP_PROXY` in the shell, so it does not violate the boundary of "not inheriting shell environment variables".
 */
type ProxyFallbackMode = "direct" | "system";

interface DesktopSessionNetworkPolicyOptions {
  /** Whether to allow all certificate errors for this Session. Only built-in browser exits can be opened. */
  allowInsecureCertificates?: boolean;
  /** Sets the backend mode to use when the page proxy is left blank. Defaults to `direct`. */
  fallbackProxyMode?: ProxyFallbackMode;
}

interface DesktopNetworkPolicyLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface DesktopSessionProvider {
  readonly defaultSession: Session;
  fromPartition(partition: string): Session;
}

type CertificateVerifyProc = NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>;

interface CertificateLike {
  data?: string;
  fingerprint?: string;
  issuerCert?: CertificateLike | null;
}

const USE_CHROMIUM_DEFAULT_VERIFICATION = -3;
const ACCEPT_CERTIFICATE = 0;
const MAX_CERTIFICATE_CHAIN_DEPTH = 16;

export async function applyDesktopChromiumNetworkPolicies(
  sessionProvider: DesktopSessionProvider,
  settings: DesktopNetworkPolicySettings,
  logger: DesktopNetworkPolicyLogger,
): Promise<void> {
  const targets = [
    {
      name: "default-session",
      session: sessionProvider.defaultSession,
      allowInsecure: false,
      // ZCode's own export of backend and model APIs converges to explicit configuration on the settings page and is not influenced by native system proxies.
      fallbackProxyMode: "direct" as const,
    },
    {
      name: "embedded-browser",
      session: sessionProvider.fromPartition(EMBEDDED_BROWSER_PARTITION),
      // Self-signed release is only enabled in the built-in browser exit: defaultSession hosts renderer for ZCode backend and model API
      // If the traffic is released there, it means that the entire application loses TLS protection, which is disproportionate to the request of "accessing the intranet test site".
      allowInsecure: settings.embeddedBrowserAllowInsecureCertificates === true,
      // The built-in browser is the user's own browsing outlet. When left blank, it follows the system proxy and is consistent with the local browser;
      // Otherwise, sites that require a proxy to access will only get ERR_CONNECTION_TIMED_OUT, and users will have no way to start.
      fallbackProxyMode: "system" as const,
    },
  ] as const;

  await Promise.all(
    targets.map(async (target) => {
      try {
        await applyDesktopSessionNetworkPolicy(target.session, settings, logger, {
          allowInsecureCertificates: target.allowInsecure,
          fallbackProxyMode: target.fallbackProxyMode,
        });
      } catch (error) {
        // The built-in Browser uses an independent partition. In the past, only defaultSession was configured; at the same time
        // Failure to start a single Session cannot block another exit, otherwise the renderer and Browser will drift again.
        logger.warn(`[desktop-network] ${target.name} network policy apply failed:`, error);
      }
    }),
  );
}

async function applyDesktopSessionNetworkPolicy(
  targetSession: Session,
  settings: DesktopNetworkPolicySettings,
  logger: DesktopNetworkPolicyLogger,
  options: DesktopSessionNetworkPolicyOptions = {},
): Promise<void> {
  const proxyConfig = buildElectronProxyConfig(
    settings.httpProxy,
    settings.httpProxyNoProxy,
    options.fallbackProxyMode,
  );
  await targetSession.setProxy(proxyConfig);
  await targetSession.closeAllConnections();

  // Full release is more relaxed than custom CA. When both are configured at the same time, the former will take effect to avoid the confusion of "turning on the switch but still being rejected".
  const verifyProc = options.allowInsecureCertificates
    ? createInsecureCertificateVerifyProc()
    : createCustomCaCertificateVerifyProcFromFile(settings.httpProxyCaCertPath, logger);
  targetSession.setCertificateVerifyProc(verifyProc);

  const bypassState = proxyConfig.proxyBypassRules ? "enabled" : "disabled";
  const customCaState = verifyProc ? "enabled" : "disabled";
  logger.info(
    `[desktop-network] renderer proxy mode=${proxyConfig.mode ?? "fixed_servers"} bypass=${bypassState} customCa=${customCaState} insecureCerts=${options.allowInsecureCertificates ? "allowed" : "rejected"}`,
  );
}

/**
 * Release the verification process for all certificate errors.
 *
 * Only for the built-in browser partition: the intranet test site of the self-signed certificate is in Electron `<webview>`
 * Chrome's security insert cannot be obtained. After being rejected, only an empty chrome-error page is left, and the user has no way to release it.
 */
function createInsecureCertificateVerifyProc(): CertificateVerifyProc {
  return (_request, callback) => {
    callback(ACCEPT_CERTIFICATE);
  };
}

function buildElectronProxyConfig(
  httpProxy: string | undefined,
  noProxy?: string | undefined,
  fallbackMode: ProxyFallbackMode = "direct",
): ProxyConfig {
  const proxyRules = normalizeProxyRules(httpProxy);
  if (!proxyRules) {
    // Leave blank without proxyBypassRules: bypass rules are only meaningful for fixed_servers.
    // The exception list in `system` mode is maintained by the OS itself (such as macOS's "ignore these hosts").
    return { mode: fallbackMode };
  }
  const proxyConfig: ProxyConfig = {
    mode: "fixed_servers",
    proxyRules,
  };
  const proxyBypassRules = normalizeProxyBypassRules(noProxy);
  if (proxyBypassRules) {
    proxyConfig.proxyBypassRules = proxyBypassRules;
  }
  return proxyConfig;
}

function createCustomCaCertificateVerifyProcFromFile(
  caCertPath: string | undefined,
  logger: Pick<DesktopNetworkPolicyLogger, "warn">,
): CertificateVerifyProc | null {
  const trimmed = caCertPath?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const trustedFingerprints = readCustomCaFingerprintsFromPem(readFileSync(trimmed, "utf8"));
    if (trustedFingerprints.size === 0) {
      logger.warn(`[desktop-network] custom CA file contains no certificates: ${trimmed}`);
      return null;
    }
    return createCustomCaCertificateVerifyProc(trustedFingerprints);
  } catch (error) {
    logger.warn(`[desktop-network] failed to load custom CA file: ${trimmed}`, error);
    return null;
  }
}

function createCustomCaCertificateVerifyProc(
  trustedFingerprints: ReadonlySet<string>,
): CertificateVerifyProc | null {
  if (trustedFingerprints.size === 0) {
    return null;
  }

  return (request, callback) => {
    if (request.verificationResult === "OK") {
      callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
      return;
    }

    if (
      certificateChainMatchesCustomCa(request.certificate, trustedFingerprints) ||
      certificateChainMatchesCustomCa(request.validatedCertificate, trustedFingerprints)
    ) {
      // The renderer's Chromium network stack does not read NODE_EXTRA_CA_CERTS.
      // The custom CA can only be entered here from the explicit path on the settings page, and is released only after hitting the link to avoid bypassing all certificate errors.
      callback(ACCEPT_CERTIFICATE);
      return;
    }

    callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
  };
}

function readCustomCaFingerprintsFromPem(pem: string): Set<string> {
  const fingerprints = new Set<string>();
  const certBlocks =
    pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];

  for (const block of certBlocks) {
    fingerprints.add(normalizeFingerprint(new X509Certificate(block).fingerprint256));
  }
  return fingerprints;
}

function certificateChainMatchesCustomCa(
  certificate: CertificateLike,
  trustedFingerprints: ReadonlySet<string>,
): boolean {
  let current: CertificateLike | null | undefined = certificate;
  const seen = new Set<string>();

  for (let depth = 0; current && depth < MAX_CERTIFICATE_CHAIN_DEPTH; depth += 1) {
    const fingerprint = readCertificateFingerprint(current);
    if (fingerprint) {
      if (trustedFingerprints.has(fingerprint)) {
        return true;
      }
      if (seen.has(fingerprint)) {
        return false;
      }
      seen.add(fingerprint);
    }
    current = current.issuerCert;
  }
  return false;
}

function normalizeProxyRules(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
    return `${url.protocol}//${auth}${url.host}`;
  } catch {
    return undefined;
  }
}

function normalizeProxyBypassRules(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}

function readCertificateFingerprint(certificate: CertificateLike): string | undefined {
  if (certificate.data) {
    try {
      return normalizeFingerprint(new X509Certificate(certificate.data).fingerprint256);
    } catch {
      // Electron also provides a fingerprint field; this field is returned for compatibility when PEM parsing fails.
    }
  }
  return certificate.fingerprint ? normalizeFingerprint(certificate.fingerprint) : undefined;
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-f0-9]/gi, "").toLowerCase();
}
