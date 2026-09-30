export const REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE = "ZCODE_REMOTE_WORKSPACE_DISCONNECTED";

export function createRemoteWorkspaceDisconnectedError(): Error & {
  code: typeof REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
} {
  const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
    code: typeof REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
  };
  error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
  return error;
}

export function isRemoteWorkspaceDisconnectedError(error: unknown): boolean {
  // The RPC/Proxy boundary may hold Error or just the code/message field.
  // Only accept accurate error codes to avoid using includes to misjudge real business errors into initialization waiting states.
  if (error === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE ||
    candidate.message === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE
  );
}
