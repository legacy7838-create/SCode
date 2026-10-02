import { createHash, randomUUID } from "node:crypto";

const OPENCODE_ROOT_DOMAIN = "opencode.ai";
const OPENCODE_GO_PATH = "/zen/go/v1";
const OPENCODE_ZEN_PATH = "/zen/v1";

/**
 * The OpenCode Zen anonymous free lane authenticates with this literal marker instead of a user key;
 * the official client sends the same value when no account or API key is configured. It is not a
 * secret, so it lives in the Provider Template config and is only matched here.
 */
const OPENCODE_ANONYMOUS_API_KEY = "public";

/**
 * OpenCode's free-tier gate accepts only its canonical descending identifiers:
 * `ses_`/`msg_` + 12 lowercase hex + 14 base62 characters (30 characters total).
 */
const OPENCODE_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const OPENCODE_REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function matchesOpenCodeHostPath(baseURL: string | undefined, expectedPath: string): boolean {
  const trimmed = baseURL?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "").toLowerCase();
    return (
      (hostname === OPENCODE_ROOT_DOMAIN || hostname.endsWith(`.${OPENCODE_ROOT_DOMAIN}`)) &&
      path === expectedPath
    );
  } catch {
    return false;
  }
}

export function isOpenCodeGoBaseUrl(baseURL: string | undefined): boolean {
  return matchesOpenCodeHostPath(baseURL, OPENCODE_GO_PATH);
}

/** The Zen root hosts the keyed `opencode-zen-*` providers and the anonymous Free lane; `/zen/go/v1` must not match. */
export function isOpenCodeZenBaseUrl(baseURL: string | undefined): boolean {
  return matchesOpenCodeHostPath(baseURL, OPENCODE_ZEN_PATH);
}

/**
 * The Free lane is identified by the Zen root plus the built-in anonymous credential. The keyed Zen
 * providers share the same base URL and must keep their untouched request path.
 */
export function isOpencodeFreeProvider(input: {
  readonly baseURL?: string;
  readonly apiKey?: string;
}): boolean {
  return input.apiKey === OPENCODE_ANONYMOUS_API_KEY && isOpenCodeZenBaseUrl(input.baseURL);
}

// Sidecar flows (title generation, verification, ...) have no conversation to derive an identity
// from. One process-stable canonical session is still a single upstream identity, while minting a
// fresh session per request would burn the per-session free quota on every call.
let anonymousSessionSeed: string | undefined;

function canonicalId(prefix: "ses_" | "msg_", seed: string): string {
  // 26 hex characters satisfy `{12 hex}{14 base62}` because hex is a base62 subset.
  return `${prefix}${createHash("sha256").update(seed).digest("hex").slice(0, 26)}`;
}

/**
 * Translate any ZCode conversation identity into the canonical `ses_` shape, deterministically: the
 * same conversation must reuse one upstream session so quota and prompt cache stay attached to it.
 * Already-canonical values pass through unchanged.
 */
export function toOpenCodeSessionId(sessionId: string | undefined): string {
  const trimmed = sessionId?.trim();
  if (trimmed && OPENCODE_SESSION_PATTERN.test(trimmed)) return trimmed;
  if (!trimmed) anonymousSessionSeed ??= randomUUID();
  return canonicalId("ses_", `opencode-session\0${trimmed || anonymousSessionSeed}`);
}

/**
 * `x-opencode-request` identifies one logical request round. The ZCode request id is reused across
 * retries of the same round, so translating it keeps the id stable on retry like the official client.
 */
export function toOpenCodeRequestId(requestId: string | undefined): string {
  const trimmed = requestId?.trim();
  if (trimmed && OPENCODE_REQUEST_PATTERN.test(trimmed)) return trimmed;
  return canonicalId("msg_", `opencode-request\0${trimmed || randomUUID()}`);
}
