import {
  InsufficientScopeError,
  SdkErrorCode,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

/**
 * A stable identity for "interactive authorization required".
 *
 * Registered into the global symbol registry with `Symbol.for`: when a bundler double install or a version skew leaves two
 * copies of the adapter code in one process, both copies resolve to the same symbol, which `instanceof` cannot do. The SDK uses
 * the same trick on the transport auth seam (`Symbol.for("mcp.authSeamEscape")`), and `markAuthSeamEscape()` is
 * identity-preserving, so our brand passes through the SDK unchanged and bubbles up to the orchestration layer.
 */
const INTERACTIVE_REQUIRED_BRAND = Symbol.for("zcode.mcp.oauth.interactiveAuthorizationRequired");
const TEMPORARY_REFRESH_FAILURE_BRAND = Symbol.for("zcode.mcp.oauth.temporaryRefreshFailure");

const MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE = "MCP_OAUTH_INTERACTIVE_REQUIRED";
const MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE = "MCP_OAUTH_TEMPORARY_REFRESH_FAILURE";

export type McpOAuthInteractiveRequiredReason =
  | "no_credentials"
  | "no_refresh_token"
  | "invalid_grant"
  | "invalid_client"
  | "insufficient_scope"
  | "unauthorized"
  | "legacy_provider_seam";

interface McpOAuthInteractiveRequiredError extends Error {
  code: typeof MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

interface McpOAuthTemporaryRefreshFailureError extends Error {
  code: typeof MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
}

export function createInteractiveAuthorizationRequiredError(input: {
  cause?: unknown;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
  serverName: string;
}): McpOAuthInteractiveRequiredError {
  const error = new Error(
    `MCP server ${input.serverName} requires interactive OAuth authorization (${input.reason})`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthInteractiveRequiredError;
  Object.defineProperty(error, INTERACTIVE_REQUIRED_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  error.reason = input.reason;
  if (input.requiredScope) error.requiredScope = input.requiredScope;
  if (input.resourceMetadataUrl) error.resourceMetadataUrl = input.resourceMetadataUrl;
  return error;
}

/**
 * A network / 5xx failure during reactive refresh.
 *
 * Must be distinguished from `interactiveRequired`: a transient AS outage does not mean the grant has expired, and
 * misclassifying it as interactive authorization interrupts the user for nothing; handing back the old token that the
 * resource server already rejected would necessarily produce a second 401.
 */
export function createTemporaryRefreshFailureError(input: {
  cause?: unknown;
  serverName: string;
}): McpOAuthTemporaryRefreshFailureError {
  const error = new Error(
    `MCP server ${input.serverName} OAuth token refresh failed temporarily`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthTemporaryRefreshFailureError;
  Object.defineProperty(error, TEMPORARY_REFRESH_FAILURE_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
  return error;
}

function isInteractiveAuthorizationRequiredError(
  error: unknown,
): error is McpOAuthInteractiveRequiredError {
  return hasBrand(error, INTERACTIVE_REQUIRED_BRAND);
}

function isTemporaryRefreshFailureError(
  error: unknown,
): error is McpOAuthTemporaryRefreshFailureError {
  return hasBrand(error, TEMPORARY_REFRESH_FAILURE_BRAND);
}

export interface InteractiveAuthorizationTrigger {
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

/**
 * Classify connection-time / runtime errors as "interactive authorization required".
 *
 * Under a pure AuthProvider the SDK can only produce these deterministic authentication errors:
 * - the `interactiveRequired` we throw ourselves (token missing, invalid_grant, invalid_client);
 * - `SdkHttpError(ClientHttpAuthentication)` that is still 401 after retries;
 * - `UnauthorizedError` when there is no `onUnauthorized` (the defensive path);
 * - `InsufficientScopeError` for a Streamable HTTP 403 (carrying requiredScope).
 *
 * `temporaryRefreshFailure` is explicitly not in this list: it must keep the credentials and fail as-is.
 */
export function classifyInteractiveAuthorizationTrigger(
  error: unknown,
): InteractiveAuthorizationTrigger | undefined {
  if (isTemporaryRefreshFailureError(error)) return undefined;
  if (isInteractiveAuthorizationRequiredError(error)) {
    return {
      reason: error.reason,
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl ? { resourceMetadataUrl: error.resourceMetadataUrl } : {}),
    };
  }
  if (error instanceof InsufficientScopeError) {
    return {
      reason: "insufficient_scope",
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl
        ? { resourceMetadataUrl: String(error.resourceMetadataUrl) }
        : {}),
    };
  }
  if (error instanceof UnauthorizedError) return { reason: "unauthorized" };
  if (isSdkAuthenticationHttpError(error)) return { reason: "unauthorized" };
  // Cause chain: The SDK is packaged incorrectly on several seams. The classification cannot only look at the outermost layer.
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return classifyInteractiveAuthorizationTrigger(cause);
  }
  return undefined;
}

/** Still 401 after retries: `SdkHttpError(SdkErrorCode.ClientHttpAuthentication)`. Compared by code, not via instanceof. */
function isSdkAuthenticationHttpError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === SdkErrorCode.ClientHttpAuthentication;
}

function hasBrand(error: unknown, brand: symbol): boolean {
  return (typeof error === "object" && error !== null) || typeof error === "function"
    ? (error as Record<symbol, unknown>)[brand] === true
    : false;
}
