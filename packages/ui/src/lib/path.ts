const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const UNC_PATH_RE = /^\\\\/;
const URI_ESCAPE_RE = /%[0-9A-Fa-f]{2}/;

export function getPathLeaf(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function getContainingDirectoryPath(path: string): string | null {
  const trimmedPath = path.trim().replace(/[\\/]+$/, "");
  if (!trimmedPath) {
    return null;
  }

  const lastSeparatorIndex = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));

  if (lastSeparatorIndex < 0) {
    return null;
  }

  if (lastSeparatorIndex === 0) {
    return trimmedPath[0] ?? null;
  }

  const parentPath = trimmedPath.slice(0, lastSeparatorIndex);
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}${trimmedPath[lastSeparatorIndex] ?? "\\"}`;
  }

  return parentPath || null;
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(path) || UNC_PATH_RE.test(path);
}

export function decodeFilePathUriEscapes(path: string): string {
  if (!URI_ESCAPE_RE.test(path)) {
    return path;
  }

  try {
    // Local file paths in markdown/tool output may be URI-encoded.
    // For example, a space in the workspace name will become %20. Use decodeURI here to restore only the path text,
    // Keep delimiter escapes such as %2F to avoid accidentally splitting the file name content into new path levels.
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function joinFilePath(basePath: string, childPath: string): string {
  if (!childPath) {
    return basePath;
  }

  if (isAbsoluteFilePath(childPath)) {
    return childPath;
  }

  const separator = basePath.includes("\\") && !basePath.includes("/") ? "\\" : "/";
  const normalizedBasePath = basePath.replace(/[\\/]+$/, "");
  const normalizedChildPath = childPath.replace(/^[\\/]+/, "");
  return `${normalizedBasePath}${separator}${normalizedChildPath}`;
}

// encodeURI does not escape # and ?, but they are fragment/query delimiters in the URL.
// The file URL generated when the file name contains # (such as index#v2.html) will be truncated by downstream URL parsing pathname
// (Only /E:/dir/index remains), shell opening will inevitably fail. Here add escaping after encodeURI.
function encodeUriPathForFileUrl(value: string): string {
  return encodeURI(value).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

export function toFileUrl(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");

  if (WINDOWS_ABSOLUTE_PATH_RE.test(path)) {
    return `file:///${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  if (UNC_PATH_RE.test(path)) {
    return `file:${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  return encodeUriPathForFileUrl(normalizedPath);
}
