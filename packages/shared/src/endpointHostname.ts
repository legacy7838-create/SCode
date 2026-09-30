/** Extracts a display-safe http(s) hostname from a URL; returns an empty string for non-http(s) schemes or parse failures. */
export function resolveSafeEndpointHostname(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}
