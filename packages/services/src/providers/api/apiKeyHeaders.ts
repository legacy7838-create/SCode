const STRUCTURED_API_KEY_PATTERN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const HEADER_VISIBLE_ASCII_PREFIX_PATTERN = /^[\x21-\x7e]+/;

export function normalizeApiKeyForHeader(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  const matchedStructuredKey = trimmed.match(STRUCTURED_API_KEY_PATTERN)?.[0];
  if (matchedStructuredKey) {
    return matchedStructuredKey;
  }

  const asciiPrefix = trimmed.match(HEADER_VISIBLE_ASCII_PREFIX_PATTERN)?.[0];
  if (!asciiPrefix) {
    return "";
  }

  // When users copy the API key, they may paste the Chinese remarks into the input box.
  // The fetch header value must be ByteString, and the sending link intercepts the ASCII key uniformly to avoid non-ASCII characters directly throwing errors when constructing Authorization.
  return asciiPrefix.trim();
}
