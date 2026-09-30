/**
 * The single place where telemetry text and model identities are redacted.
 *
 * The exception / api / click events ARMS collects automatically, plus free-text fields on custom
 * events, may all contain local paths, emails, full URLs, and credentials. This provides pure
 * function implementations shared by desktop main's `beforeReport` and the renderer-side
 * instrumentation, so each call site doesn't write its own set of patterns.
 *
 * The patterns stay in sync with the CLI's `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts`;
 * the two live in different workspaces and may not depend on each other, so extending one side
 * requires updating the other.
 */

import { decodeCustomModelValue } from "./custom-model-value.js";
import { migrateLegacyModelProviderId } from "./legacy-model-provider-identity.js";
import { isBuiltinModelProviderId } from "./model-provider-types.js";
import { OFFICIAL_GLM_MODEL_IDS } from "./official-glm-model-id.js";

/** Default per-field cap; ARMS truncates or rejects overlong fields, so truncating up front guarantees the important header always gets through. */
export const TELEMETRY_TEXT_MAX_LENGTH = 2_048;

/** Input cap applied before redaction: an error may carry an entire response body, so truncate to a bound first and then run the regex cleanup, avoiding unbounded CPU cost. */
const TELEMETRY_TEXT_SCAN_LIMIT = 4_096;

/** The maximum length a route segment keeps verbatim; anything longer is always treated as untrusted content. */
const TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH = 128;

export interface RedactTelemetryTextOptions {
  /** Output cap, defaults to {@link TELEMETRY_TEXT_MAX_LENGTH}. */
  maxLength?: number;
}

/**
 * Cleans free text into a reportable form: URL queries are dropped, paths/emails/credentials are
 * normalized to placeholders, and the result is truncated to a bound.
 *
 * It only applies to the reported copy; error display, local logs, crash archives, and
 * classification logic must keep using the original values.
 */
export function redactTelemetryText(
  value: string | undefined | null,
  options: RedactTelemetryTextOptions = {},
): string {
  if (typeof value !== "string" || !value) {
    return "";
  }

  const maxLength = options.maxLength ?? TELEMETRY_TEXT_MAX_LENGTH;
  const redacted = value
    .slice(0, TELEMETRY_TEXT_SCAN_LIMIT)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (match) => redactTelemetryUrl(match))
    .replace(
      /(\bauthorization\b["']?\s*[:=])\s*(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}")
    .replace(/\b[^/@\s]+@[^/@\s]+\.[^/@\s]+\b/gu, "{email}")
    // Reason for repair: The absolute path in the crash/exception message will bring the local user name and workspace directory name, which must be normalized before leaving the local machine.
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:;,)\]}]+/gu, "{path}")
    .replace(
      /\/(?:Users|home|root|workspace|workspaces|Volumes)\/[^/\s]+(?:\/[^\s:;,)\]}]+)*/gu,
      "{path}",
    )
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s:;,)\]}]+)*/gu, "{path}")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return redacted.slice(0, maxLength);
}

/**
 * Cleans a URL into `protocol//host` plus a normalized route; query and fragment are discarded.
 *
 * `file://` and local absolute paths normalize to `local_file`; `blob:` / `data:` keep only the
 * protocol marker; an unparseable value returns `unknown` and never falls back to the original.
 */
export function redactTelemetryUrl(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "unknown";
  }
  if (/^blob:/iu.test(raw)) {
    return "blob";
  }
  if (/^data:/iu.test(raw)) {
    return "data";
  }
  // Root cause of the bug: Enumerating common root directories will miss legal POSIX absolute paths such as /opt, /root, /mnt, etc.
  if (/^file:/iu.test(raw) || /^[a-zA-Z]:[\\/]/u.test(raw) || raw.startsWith("/")) {
    return "local_file";
  }

  try {
    // Bug root cause: Unconditional complement of `https://` will cause ordinary text such as `!!!` to be parsed into host by the URL and then echoed as it is.
    // Only input that has a scheme or appears to be host[:port][/path] will be parsed.
    const candidate = raw.includes("://")
      ? raw
      : /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(?:[/?#]|$)/iu.test(raw)
        ? `https://${raw}`
        : "";
    if (!candidate) {
      return "unknown";
    }
    const parsed = new URL(candidate);
    if (parsed.protocol === "file:" || !parsed.host) {
      return "local_file";
    }
    const route = parsed.pathname
      .split("/")
      .map((segment) => redactTelemetryRouteSegment(segment))
      .join("/");
    return `${parsed.protocol}//${parsed.host}${route}`;
  } catch {
    return "unknown";
  }
}

function redactTelemetryRouteSegment(segment: string): string {
  if (!segment) {
    return segment;
  }
  if (
    // Emails, long numeric IDs, hashes, and UUIDs are all high-radix identities and cannot be left as is in routing.
    /@/u.test(segment) ||
    /^\d{7,}$/u.test(segment) ||
    /^[0-9a-f]{16,}$/iu.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)
  ) {
    return "{segment}";
  }
  return segment.slice(0, TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH);
}

/** Historical built-in models outside the official GLM list; they are still stable ids published by ZCode itself, not user-chosen names. */
const TELEMETRY_LEGACY_BUILTIN_MODEL_IDS: readonly string[] = ["charglm-4", "codegeex-4", "emohaa"];

/**
 * The telemetry model allowlist: only the stable built-in model ids listed here may enter
 * telemetry verbatim.
 *
 * The allowlist is independent of the runtime catalog returned for an account, but it is derived
 * from the hand-maintained official GLM list. Why the fix: an earlier hand-copied list missed
 * GLM-5.3 / GLM-5.3-Flash / GLM-5V-Turbo, so the flagship models ended up written as `custom`
 * throughout plan_* / perf_ui_*. Derived from the official list, the two can no longer drift apart.
 */
export const TELEMETRY_SAFE_BUILTIN_MODEL_IDS: ReadonlySet<string> = new Set([
  ...OFFICIAL_GLM_MODEL_IDS.map((id) => id.toLowerCase()),
  ...TELEMETRY_LEGACY_BUILTIN_MODEL_IDS,
]);

export type TelemetryProviderScope = "builtin" | "custom" | "unknown";

export interface TelemetryProviderIdentity {
  providerId: string;
  providerScope: TelemetryProviderScope;
}

/**
 * Legacy reporting identities (`builtin:zai` / `builtin:zai-start-plan` etc.) are ZCode's own
 * fixed ids.
 *
 * Why the fix: when the V4 supervisor projects /report detail it uses legacyTelemetryProviderId to
 * map the runtime `account:*` onto these legacy identities, and plan_ttft / perf_ui_* reuse that
 * same detail. Recognising only `account:*` would make every built-in user be treated as a custom
 * provider and normalized to `custom`. Reusing the shared one-way migration table for the
 * decision, unknown `builtin:` prefixes are still treated as custom and cannot sneak in via the
 * prefix.
 */
function isLegacyBuiltinTelemetryProviderId(providerId: string): boolean {
  const migrated = migrateLegacyModelProviderId(providerId);
  return migrated !== undefined && migrated !== providerId;
}

/** Built-in providers keep their stable ids; custom providers are named by the user, and reporting those names verbatim would leak private names and create high cardinality. */
export function resolveTelemetryProviderScope(
  providerId: string | undefined | null,
): TelemetryProviderIdentity {
  const normalized = providerId?.trim();
  if (!normalized) {
    return { providerId: "", providerScope: "unknown" };
  }
  if (isBuiltinModelProviderId(normalized) || isLegacyBuiltinTelemetryProviderId(normalized)) {
    return { providerId: normalized, providerScope: "builtin" };
  }
  return { providerId: "custom", providerScope: "custom" };
}

/**
 * Peels the bare model id out of an encoded `custom:<providerId>:<modelName>` value or a
 * composite `<providerId>/<modelId>` value. The bare id is only used to look up the allowlist and
 * never enters telemetry verbatim, whatever the provider part happens to be.
 */
function extractBareModelId(value: string): string {
  const decoded = decodeCustomModelValue(value);
  if (decoded) {
    return decoded.modelName ?? "";
  }
  const separator = value.indexOf("/");
  return separator > 0 ? value.slice(separator + 1) : value;
}

/**
 * Keeps only the built-in model ids that are on the allowlist.
 *
 * Models of custom providers, and models under a built-in provider that miss the allowlist, are
 * both written as `custom`; when the provider scope is unknown or the model is missing, an empty
 * string is written, matching the existing leave-blank convention.
 */
export function resolveTelemetryModelId(
  providerScope: TelemetryProviderScope,
  modelId: string | undefined | null,
): string {
  const normalized = modelId?.trim();
  if (!normalized || providerScope === "unknown") {
    return "";
  }
  if (providerScope === "custom") {
    return "custom";
  }
  // Reason for repair: detail.model_name projected by supervisor is a `<providerId>/<modelId>` composite value or
  // `custom:` encoded value, direct whitelist search will inevitably fail; first peel off the bare model ID and then judge.
  const bareModelId = extractBareModelId(normalized).toLowerCase();
  return TELEMETRY_SAFE_BUILTIN_MODEL_IDS.has(bareModelId) ? bareModelId : "custom";
}

/**
 * Normalizes the case where "only a model value was received, with no separate provider field".
 *
 * Three shapes are supported: the encoded `custom:<providerId>[:<modelName>]` value, the composite
 * `<providerId>/<modelId>` value, and a bare model id. A bare id is judged directly against the
 * allowlist and anything that misses is downgraded to `custom` — which is exactly the "a newly
 * added built-in model that has not entered the allowlist must be downgraded by default"
 * requirement, so callers need not pass a provider.
 */
export function sanitizeTelemetryModelValue(value: string | undefined | null): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "";
  }

  // The `custom:` prefix itself indicates a non-built-in provider, which can be determined without decoding the user name.
  const decoded = decodeCustomModelValue(normalized);
  if (decoded) {
    return resolveTelemetryModelId(
      resolveTelemetryProviderScope(decoded.providerId).providerScope,
      decoded.modelName,
    );
  }

  const separator = normalized.indexOf("/");
  if (separator > 0) {
    const { providerScope } = resolveTelemetryProviderScope(normalized.slice(0, separator));
    return resolveTelemetryModelId(providerScope, normalized.slice(separator + 1));
  }

  return resolveTelemetryModelId("builtin", normalized);
}
