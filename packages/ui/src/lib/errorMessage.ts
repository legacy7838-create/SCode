export function getErrorMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  // Some errors in the remote connection link are prefixed with "Error: ...".
  // When the upper layer is packaged into Error or directly displayed as String(error), it will be stacked into "Error: Error: ...".
  // Here, repeated prefixes are stripped off uniformly, and only the truly meaningful error content is retained.
  return rawMessage.replace(/^(Error:\s*)+/i, "").trim();
}
