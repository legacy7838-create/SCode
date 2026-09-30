import type { WorkspaceFileEntry } from "@zcode/shared";

/**
 * Columnar codec for workspace file entries (worker / cross-process transport only, zero runtime dependencies).
 * Each line is `type\trelativePath` — name is the last segment of relativePath and path is
 * rebuilt from rootPath, so neither is transmitted twice (370k entries measured 65.7MB → ~25MB).
 * Unix filenames may contain \t, \n, \\; they are escaped while packing and restored while unpacking.
 *
 * Why this wire shape (performance constraints):
 * - RPC returns a bare string at the top level to take the framework's String fast path
 *   (length prefix + raw bytes), avoiding the escaping cost that Object's JSON.stringify/parse
 *   pays on large strings containing \t\n (measured 6-9s);
 * - A single message never exceeds WORKSPACE_FILE_ENTRIES_CHUNK_SIZE (~4MB): reassembling a large
 *   message's frames on the renderer side is a multi-second main-thread long task (measured 4.6-6.3s);
 *   with chunked fetching plus yielding the event loop between chunks, the main thread only ever
 *   handles one small chunk (~50ms), so typing never freezes.
 */
const FIELD_SEPARATOR = "\t";
const LINE_SEPARATOR = "\n";

/** Target size of a single chunk (in characters); callers chunk their fetches by totalLength. */
export const WORKSPACE_FILE_ENTRIES_CHUNK_SIZE = 4_000_000;

function escapeField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

// Regular escapes can be restored at once (several times faster than character-by-character looping, saving seconds of worker time for 370,000 lines).
const UNESCAPE_PATTERN = /\\(.)/g;

function unescapeField(value: string): string {
  return value.replace(UNESCAPE_PATTERN, (match, char: string) => {
    if (char === "t") {
      return "\t";
    }
    if (char === "n") {
      return "\n";
    }
    return char;
  });
}

export function packWorkspaceFileEntries(entries: WorkspaceFileEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.type}${FIELD_SEPARATOR}${escapeField(entry.relativePath)}`);
  }
  return lines.join(LINE_SEPARATOR);
}

/**
 * Unpack and reassemble the complete entries: name is the last segment of relativePath, and path is
 * built from rootPath (works whether or not rootPath ends with a separator; \ on Windows, / elsewhere).
 */
export function unpackWorkspaceFileEntries(packed: string, rootPath: string): WorkspaceFileEntry[] {
  if (packed.length === 0) {
    return [];
  }
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const prefix =
    rootPath.endsWith("/") || rootPath.endsWith("\\") ? rootPath : `${rootPath}${separator}`;
  const lines = packed.split(LINE_SEPARATOR);
  const entries: WorkspaceFileEntry[] = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const tabAt = line.indexOf(FIELD_SEPARATOR);
    if (tabAt === -1) {
      continue;
    }
    const relativePath = unescapeField(line.slice(tabAt + 1));
    const lastSlash = relativePath.lastIndexOf("/");
    // Under Windows root, the delimiter of posix relative path is also changed back to \, keeping it consistent with node:path.join.
    const pathPart = separator === "/" ? relativePath : relativePath.split("/").join("\\");
    entries.push({
      name: lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1),
      path: `${prefix}${pathPart}`,
      relativePath,
      type: line.slice(0, tabAt) === "directory" ? "directory" : "file",
    });
  }
  return entries;
}
