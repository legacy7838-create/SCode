/**
 * Remote images in the UI are only allowed over HTTPS; on failure each presentational component
 * falls back to a local icon.
 */
export function isTrustedImageUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}
