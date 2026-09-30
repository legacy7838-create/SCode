import { decodeFilePathUriEscapes, isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { stripBalancedAssistantPathQuotes } from "@/lib/assistantPathQuotes.js";

interface ParsedMarkdownFileLink {
  path: string;
  lineNumber: number | null;
  columnNumber: number | null;
}

export interface MarkdownFileLinkResolveOptions {
  /** The user home reported by the current workspace Host; the Renderer does not read the local home itself. */
  homePath?: string;
}

const LINE_AND_COLUMN_SUFFIX_RE = /^(?<path>.+):(?<line>\d+):(?<column>\d+)$/;
const LINE_SUFFIX_RE = /^(?<path>.+):(?<line>\d+)$/;
const HASH_LINE_SUFFIX_RE = /^(?<path>.+)#L(?<line>\d+)(?:-L?\d+)?$/i;
const FILE_URL_PROTOCOL_RE = /^file:\/\//i;
const HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE = /^\/[a-zA-Z]:\//;
const COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS = new Set([
  "Applications",
  "Library",
  "System",
  "Users",
  "Volumes",
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "media",
  "mnt",
  "opt",
  "private",
  "proc",
  "root",
  "run",
  "sbin",
  "srv",
  "sys",
  "tmp",
  "usr",
  "var",
]);

function isWorkspaceRelativeFileHref(href: string): boolean {
  return href.startsWith("./");
}

function normalizeHomeRelativePath(path: string): string | null {
  if (path.startsWith("./~/") || path.startsWith("./~\\")) {
    return path.slice(2);
  }
  return /^~[\\/]/.test(path) ? path : null;
}

function isHomeRelativeFilePath(path: string): boolean {
  return normalizeHomeRelativePath(path) !== null;
}

function isUnsupportedNamedHomePath(path: string): boolean {
  return /^~[^\\/]+[\\/]/.test(path);
}

function resolveHomeRelativeFilePath(path: string, homePath: string | undefined): string | null {
  const homeRelativePath = normalizeHomeRelativePath(path);
  if (!homeRelativePath || !homePath || !isAbsoluteFilePath(homePath)) {
    return null;
  }

  const separator = homePath.includes("\\") && !homePath.includes("/") ? "\\" : "/";
  return joinFilePath(homePath, homeRelativePath.slice(2).replace(/[\\/]/g, separator));
}

function isBareWorkspaceRelativeFileHref(href: string): boolean {
  if (
    !href ||
    href.startsWith("/") ||
    href.startsWith("#") ||
    href.startsWith("../") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)
  ) {
    return false;
  }

  return href.includes("/") || href.includes("\\");
}

function isAbsoluteMarkdownFileHref(rawHref: string, normalizedHref: string): boolean {
  return (
    isAbsoluteFilePath(rawHref) ||
    isAbsoluteFilePath(normalizedHref) ||
    normalizedHref.startsWith("//")
  );
}

function isLikelyUnixAbsoluteFilePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }

  const firstSegment = path.slice(1).split("/")[0];
  return Boolean(firstSegment && COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS.has(firstSegment));
}

function isPathInsideWorkspaceRoot(path: string, workspacePath: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedWorkspacePath = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  return (
    normalizedPath === normalizedWorkspacePath ||
    normalizedPath.startsWith(`${normalizedWorkspacePath}/`)
  );
}

function parseFileUrlPath(path: string): string | null {
  if (!FILE_URL_PROTOCOL_RE.test(path)) {
    return null;
  }

  try {
    const url = new URL(path);
    if (url.protocol !== "file:") {
      return null;
    }

    const decodedPathname = decodeFilePathUriEscapes(url.pathname);
    if (/^\/[a-zA-Z]:\//.test(decodedPathname)) {
      return decodedPathname.slice(1);
    }

    if (url.hostname && url.hostname !== "localhost") {
      return `//${url.hostname}${decodedPathname}`;
    }

    return decodedPathname;
  } catch {
    return null;
  }
}

function normalizeMarkdownFilePath(path: string): string {
  return parseFileUrlPath(path) ?? decodeFilePathUriEscapes(path);
}

export function normalizeWorkspaceRelativeFilePath(relativePath: string): string | null {
  const segments: string[] = [];
  for (const segment of relativePath.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        // Just checking if the path starts with ../ is not enough: nested fallbacks escape the workspace after splicing.
        // Here, cross-platform lexical normalization is performed before the Renderer initiates stat/checkFilesExist, and it is directly rejected when the root directory underflows.
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

function resolveContainedWorkspaceRelativePath(
  workspacePath: string,
  relativePath: string,
): string | null {
  const normalizedRelativePath = normalizeWorkspaceRelativeFilePath(relativePath);
  if (normalizedRelativePath === null) return null;

  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  return joinFilePath(workspacePath, normalizedRelativePath.replaceAll("/", separator));
}

export function parseMarkdownFileLinkTarget(href: string): ParsedMarkdownFileLink {
  // It is only decoded once during the path normalization phase; decoding the entry in advance will make `%2520` become `%20`.
  // Then normalizeMarkdownFilePath decodes it into spaces, destroying the literal percent-escape in the file name.
  const normalizedHref = stripBalancedAssistantPathQuotes(href).replace(/\\/g, "/");
  const withHashLineMatch = normalizedHref.match(HASH_LINE_SUFFIX_RE);
  if (withHashLineMatch?.groups) {
    const { path, line } = withHashLineMatch.groups;
    if (path && line) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: null,
      };
    }
  }

  const withLineAndColumnMatch = normalizedHref.match(LINE_AND_COLUMN_SUFFIX_RE);
  if (withLineAndColumnMatch?.groups) {
    const { path, line, column } = withLineAndColumnMatch.groups;
    if (path && line && column) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: Number.parseInt(column, 10),
      };
    }
  }

  const withLineMatch = normalizedHref.match(LINE_SUFFIX_RE);
  if (withLineMatch?.groups) {
    const { path, line } = withLineMatch.groups;
    if (path && line) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: null,
      };
    }
  }

  return {
    path: normalizeMarkdownFilePath(normalizedHref),
    lineNumber: null,
    columnNumber: null,
  };
}

export function resolveMarkdownFileLink(
  workspacePath: string | undefined,
  href: string,
  options: MarkdownFileLinkResolveOptions = {},
): ParsedMarkdownFileLink | null {
  // Local file links in chat messages may now be workspace relative paths such as `./src/app.ts`.
  // It may also be an absolute path + line number like `/abs/path/app.ts:30`.
  // If you only see the leading `/`, it will be treated as a workspace sub-path, which will cause the absolute path to be spelled with the workspace prefix again.
  // At the same time, `:30` will also be mixed into the file name. Here, the optional line numbers are removed first, and then the "relative path" and "absolute path" are parsed separately.
  const parsedTarget = parseMarkdownFileLinkTarget(href);

  if (isUnsupportedNamedHomePath(parsedTarget.path)) {
    return null;
  }

  const homePath = resolveHomeRelativeFilePath(parsedTarget.path, options.homePath);
  if (isHomeRelativeFilePath(parsedTarget.path)) {
    return homePath
      ? {
          ...parsedTarget,
          path: homePath,
        }
      : null;
  }

  if (HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE.test(parsedTarget.path)) {
    // `/C:/...` is just an internal format bypassing harden in the Windows Markdown rendering pipeline.
    // The old guard only regarded the drive letter workspace as Windows, and missed UNC, which is already supported by the unified path tool.
    // Windows workspace may be either a drive letter or a backslash UNC; Unix paths starting with `/` must still be rejected.
    if (!workspacePath || workspacePath.startsWith("/") || !isAbsoluteFilePath(workspacePath)) {
      return null;
    }
    return {
      ...parsedTarget,
      path: parsedTarget.path.slice(1),
    };
  }

  if (
    isWorkspaceRelativeFileHref(parsedTarget.path) ||
    isBareWorkspaceRelativeFileHref(parsedTarget.path)
  ) {
    if (!workspacePath) {
      return null;
    }

    const relativePath = isWorkspaceRelativeFileHref(parsedTarget.path)
      ? parsedTarget.path.slice(2)
      : parsedTarget.path;
    if (!relativePath) {
      return null;
    }

    const containedPath = resolveContainedWorkspaceRelativePath(workspacePath, relativePath);
    if (!containedPath) return null;

    return {
      ...parsedTarget,
      path: containedPath,
    };
  }

  if (
    workspacePath &&
    parsedTarget.path.startsWith("/") &&
    !isLikelyUnixAbsoluteFilePath(parsedTarget.path)
  ) {
    // Non-system root directories such as `/workspace` and `/repo` are common in remote workspaces.
    // If the link is already located in the current workspace, it cannot be spliced ​​again according to the Markdown root relative path.
    if (isPathInsideWorkspaceRoot(parsedTarget.path, workspacePath)) {
      return parsedTarget;
    }
    // Streamdown/rehype-harden will normalize `./flappy.html` to `/flappy.html`.
    // The leading `/` here represents the markdown root relative link, not the system root directory; otherwise, stat `/flappy.html` will be mistakenly retrieved.
    const containedPath = resolveContainedWorkspaceRelativePath(
      workspacePath,
      parsedTarget.path.slice(1),
    );
    if (!containedPath) return null;
    return {
      ...parsedTarget,
      path: containedPath,
    };
  }

  if (isAbsoluteMarkdownFileHref(href, parsedTarget.path)) {
    return parsedTarget;
  }

  return null;
}
