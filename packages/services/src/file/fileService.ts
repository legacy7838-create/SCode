/* eslint-disable max-lines */
import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileTextSlice,
  WorkspaceFileEntry,
} from "@zcode/shared";
import { getMediaPreviewFormat } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { IFileService, WorkspaceFileSearchParams } from "./file.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { buildHostFileSearchCandidates, searchHostFileCandidates } from "./workspaceFileSearch.js";
import {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchFilter,
} from "./workspaceFileMentionFilter.js";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
  readWorkspaceFileSearchIgnore,
  transformWorkspaceFileSearchIgnore,
  writeWorkspaceFileSearchIgnore,
} from "./workspaceFileIgnore.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getConversationWorkspaceDir } from "../paths.js";
const DEFAULT_TEXT_READ_BYTES = 128 * 1024;
const MAX_TEXT_READ_BYTES = 256 * 1024;
const DEFAULT_MEDIA_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_BYTES = 8 * 1024 * 1024;
const DEFAULT_BINARY_READ_BYTES = 256 * 1024;
const MAX_BINARY_READ_BYTES = 1024 * 1024;
const DEFAULT_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024;
const FILE_EXISTENCE_CACHE_TTL_MS = 60_000;
const FILE_EXISTENCE_CACHE_MAX_ENTRIES = 100;
const FILE_EXISTENCE_BATCH_LIMIT = 15;
const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
function clampReadLength(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_TEXT_READ_BYTES)
    : DEFAULT_TEXT_READ_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_TEXT_READ_BYTES);
}
function clampMediaPreviewBytes(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_MEDIA_PREVIEW_BYTES)
    : DEFAULT_MEDIA_PREVIEW_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_MEDIA_PREVIEW_BYTES);
}
function clampBinaryReadLength(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_BINARY_READ_BYTES)
    : DEFAULT_BINARY_READ_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_BINARY_READ_BYTES);
}
function clampBinaryPreviewBytes(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_BINARY_PREVIEW_BYTES)
    : DEFAULT_BINARY_PREVIEW_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_BINARY_PREVIEW_BYTES);
}
function inferMediaTypeFromPath(path: string): string {
  return (
    IMAGE_EXTENSION_TO_MEDIA_TYPE[extname(path).toLowerCase()] ??
    getMediaPreviewFormat(path)?.mediaType ??
    "application/octet-stream"
  );
}
function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  let suspiciousBytes = 0;
  for (const value of buffer) {
    if (value === 0) {
      return true;
    }
    const isCommonWhitespace = value === 9 || value === 10 || value === 12 || value === 13;
    const isControlChar =
      (value >= 1 && value <= 8) || (value >= 14 && value <= 31) || value === 127;
    if (!isCommonWhitespace && isControlChar) {
      suspiciousBytes += 1;
    }
  }
  return suspiciousBytes / buffer.length > 0.3;
}
const SCRATCH_WORKSPACE_ROOT_NAME = "ZCodeProject";
function validateScratchWorkspaceName(name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Workspace name is required.");
  }
  if (/[\\/]/.test(trimmedName)) {
    throw new Error("Workspace name cannot contain path separators.");
  }
  return trimmedName;
}
function normalizeRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join("/");
}
function isSkippableWorkspaceFileListError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

interface FileExistenceCacheEntry {
  exists: boolean;
  expiresAt: number;
}

class FileExistenceCache {
  private readonly entries = new Map<string, FileExistenceCacheEntry>();

  get size(): number {
    return this.entries.size;
  }

  get(path: string): boolean | undefined {
    const cached = this.entries.get(path);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.entries.delete(path);
      return undefined;
    }

    // Map preserves insertion order; reinserts after hits so that the truly active path is at the end of the LRU queue.
    this.entries.delete(path);
    this.entries.set(path, cached);
    return cached.exists;
  }

  set(path: string, exists: boolean): void {
    const now = Date.now();
    // The old cache only determines the TTL when the same path is read again, and expired items from different paths will remain in the Host memory permanently.
    // For each write, all expired items are first cleared, and then fixed capacity is used to cover long life cycle scenarios where different candidate paths are continuously generated.
    for (const [cachedPath, cached] of this.entries) {
      if (cached.expiresAt <= now) {
        this.entries.delete(cachedPath);
      }
    }

    this.entries.delete(path);
    this.entries.set(path, {
      exists,
      expiresAt: now + FILE_EXISTENCE_CACHE_TTL_MS,
    });
    while (this.entries.size > FILE_EXISTENCE_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}

async function resolveReaddirEntryType(
  entryPath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
): Promise<FileEntry["type"]> {
  if (isDirectory) {
    return "directory";
  }
  if (!isSymbolicLink) {
    return "file";
  }
  try {
    const targetStat = await stat(entryPath);
    // Node's Dirent only returns isSymbolicLink for soft link directories, but does not return isDirectory.
    // The directory selector only displays the directory type. Therefore, you cannot see the soft link pointing to the directory when selecting the directory through remote SSH; here it is reclassified following the target.
    return targetStat.isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}

export interface CreateFileServiceOptions {
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
}

/**
 * Host side short TTL caching of listWorkspaceFiles:
 * A full warehouse scan of a 370,000-file workspace will take several seconds even if it is done concurrently.
 * Open repeatedly (@ renderer semantics, Command Center, file tree that is cleaned when the panel is closed)
 * You should not rescan every time. The service is isolated by workspaceIdentity (default is rootPath).
 * Verify the mtime/size fingerprint of rootPath + .zcodeignore; the cache will be invalid after editing the rules.
 * Maintain the contract of "editing the rules will take effect the next time they are used".
 */
const WORKSPACE_FILE_LIST_CACHE_TTL_MS = 60_000;
const WORKSPACE_FILE_LIST_SCAN_CONCURRENCY = 8;
const WORKSPACE_FILE_LIST_CACHE_MAX_ENTRIES = 4;
interface WorkspaceFileIndex {
  at: number;
  signature: string;
  packed: string;
  candidates?: ReturnType<typeof buildHostFileSearchCandidates>;
}

async function statWorkspaceFileSearchIgnoreFingerprint(rootPath: string): Promise<string> {
  try {
    const fileStat = await stat(join(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME));
    return `${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    return "none";
  }
}

export function createFileService(options: CreateFileServiceOptions = {}): IFileService {
  const workspaceFileSearchFilter =
    options.workspaceFileSearchFilter ?? defaultWorkspaceFileSearchFilter;
  const workspaceIgnoreLogger = createServiceLogger("workspace-file-ignore");
  const fileExistenceCache = new FileExistenceCache();
  // The index belongs to the service instance; different hosts/injection filters cannot reuse the same path results through the module global cache.
  const workspaceFileListCache = new Map<string, WorkspaceFileIndex>();
  const pendingFileExistenceChecks = new Map<string, Promise<boolean>>();

  const checkFileExists = async (path: string): Promise<boolean> => {
    const cached = fileExistenceCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    const pending = pendingFileExistenceChecks.get(path);
    if (pending) {
      return pending;
    }

    const check = stat(path)
      .then((fileStat) => fileStat.isFile())
      .catch(() => false)
      .then((exists) => {
        // Both positive and negative results are cached: assistant natural language often mentions the same missing path repeatedly to avoid remote hosts
        // Repeatedly initiate SSH stat for the same candidate within one minute.
        fileExistenceCache.set(path, exists);
        return exists;
      })
      .finally(() => {
        pendingFileExistenceChecks.delete(path);
      });
    pendingFileExistenceChecks.set(path, check);
    return check;
  };

  // Full scan + packaging (with 60s TTL / .zcodeignore fingerprint cache). Chunked RPCs share the same packed.
  const workspaceFileListScanning = new Map<
    string,
    { signature: string; promise: Promise<WorkspaceFileIndex> }
  >();
  const ensureWorkspaceFileIndex = async (
    rootPath: string,
    workspaceIdentity?: string,
    refresh = false,
  ): Promise<WorkspaceFileIndex> => {
    const workspaceKey = workspaceIdentity?.trim() || rootPath;
    const ignoreRules = await loadWorkspaceFileSearchIgnoreRules(rootPath, workspaceIgnoreLogger);
    const cacheSignature = `${rootPath}\n${await statWorkspaceFileSearchIgnoreFingerprint(rootPath)}`;
    for (const [key, value] of workspaceFileListCache) {
      if (Date.now() - value.at >= WORKSPACE_FILE_LIST_CACHE_TTL_MS)
        workspaceFileListCache.delete(key);
    }
    const inFlight = workspaceFileListScanning.get(workspaceKey);
    // The same scope query in the refresh is waiting for the new index and cannot hit the old cache first and miss the newly created file.
    if (!refresh && inFlight?.signature === cacheSignature) return inFlight.promise;
    const cached = workspaceFileListCache.get(workspaceKey);
    if (!refresh && cached?.signature === cacheSignature) {
      workspaceFileListCache.delete(workspaceKey);
      workspaceFileListCache.set(workspaceKey, cached);
      return cached;
    }
    const scanning = (async () => {
      const entries: WorkspaceFileEntry[] = [];
      const pendingDirectories: string[] = [rootPath];
      // Single-threaded serial DFS only awaits one readdir at a time,
      // The Windows workspace with 370,000 files measured 21.8s; changed to limited concurrent traversal of the shared directory queue,
      // The results are still sorted according to the existing rules, and the traversal order does not affect the semantics.
      const traverseWorker = async (): Promise<void> => {
        for (;;) {
          const currentPath = pendingDirectories.pop();
          if (!currentPath) {
            return;
          }
          let children: Dirent[];
          try {
            children = await readdir(currentPath, { withFileTypes: true });
          } catch (error) {
            if (isSkippableWorkspaceFileListError(error)) {
              continue;
            }
            throw error;
          }
          for (const entry of children) {
            const entryPath = join(currentPath, entry.name);
            const relativePath = normalizeRelativePath(rootPath, entryPath);
            if (relativePath === WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME) {
              continue;
            }
            const type = await resolveReaddirEntryType(
              entryPath,
              entry.isDirectory(),
              entry.isSymbolicLink(),
            );
            if (isWorkspaceFileSearchPathIgnored(ignoreRules, relativePath, type)) {
              continue;
            }
            const decision = workspaceFileSearchFilter.evaluate(
              { name: entry.name, path: entryPath, relativePath, type },
              { ignoreRulesActive: true },
            );
            if (decision.include) {
              entries.push({ name: entry.name, path: entryPath, relativePath, type });
            }
            if (type === "directory" && !entry.isSymbolicLink() && decision.traverse) {
              pendingDirectories.push(entryPath);
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: WORKSPACE_FILE_LIST_SCAN_CONCURRENCY }, () => traverseWorker()),
      );
      const sorted = entries.sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "directory" ? -1 : 1;
        }
        return left.relativePath.localeCompare(right.relativePath);
      });
      const packed = packWorkspaceFileEntries(sorted);
      return { at: Date.now(), signature: cacheSignature, packed };
    })();
    workspaceFileListScanning.set(workspaceKey, { signature: cacheSignature, promise: scanning });
    try {
      const index = await scanning;
      // Explicit refresh/rule changes can replace in-flight scans. When the old scan is completed, only old requests will be served and new indexes will not be overwritten.
      if (workspaceFileListScanning.get(workspaceKey)?.promise === scanning) {
        workspaceFileListCache.delete(workspaceKey);
        workspaceFileListCache.set(workspaceKey, index);
        while (workspaceFileListCache.size > WORKSPACE_FILE_LIST_CACHE_MAX_ENTRIES) {
          const oldest = workspaceFileListCache.keys().next().value;
          if (oldest === undefined) break;
          workspaceFileListCache.delete(oldest);
        }
      }
      return index;
    } finally {
      if (workspaceFileListScanning.get(workspaceKey)?.promise === scanning)
        workspaceFileListScanning.delete(workspaceKey);
    }
  };

  return {
    async readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]> {
      const entries = await readdir(params.path, { withFileTypes: true });
      const visibleEntries = await Promise.all(
        entries
          .filter((e) => {
            // Fix: The workspace file tree needs to display project files such as .gitignore/.env/.github.
            // But old calls like directory selectors should still hide dotfiles by default to avoid a sudden increase in noise.
            return params.includeHidden === true || !e.name.startsWith(".");
          })
          .map(async (e) => {
            const entryPath = join(params.path, e.name);
            return {
              name: e.name,
              path: entryPath,
              type: await resolveReaddirEntryType(entryPath, e.isDirectory(), e.isSymbolicLink()),
              isSymbolicLink: e.isSymbolicLink(),
            };
          }),
      );
      return visibleEntries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    },
    async stat(params: { path: string }) {
      const fileStat = await stat(params.path);
      // Markdown links need to distinguish between files and directories when clicked.
      // Previously, when a file was opened, the directory would fall into CodeViewer and failed to read the file; here, the judgment is closed to the service layer.
      // The UI simply offloads to the preview or temporary file tree based on structured results.
      const isDirectory = fileStat.isDirectory();
      return {
        path: params.path,
        type: isDirectory ? ("directory" as const) : ("file" as const),
        // The size of the directory is meaningless and is only returned for files for the preview layer to determine the loading strategy of binary files.
        ...(isDirectory ? {} : { size: fileStat.size, mtimeMs: fileStat.mtimeMs }),
      };
    },
    async checkFilesExist(params: {
      paths: string[];
    }): Promise<Array<{ path: string; exists: boolean }>> {
      if (params.paths.length > FILE_EXISTENCE_BATCH_LIMIT) {
        throw new Error(
          `File existence check supports at most ${FILE_EXISTENCE_BATCH_LIMIT} paths.`,
        );
      }

      // The caller has selected candidates in reverse text order; Promise.all maintains input order and hard limits single-batch concurrency to 15.
      return Promise.all(
        params.paths.map(async (path) => ({
          path,
          exists: await checkFileExists(path),
        })),
      );
    },
    async resolvePath(params: { path: string }): Promise<string> {
      // The remote workspace may be entered via a symbolic link alias (/dev vs /home/dev).
      // Realpath is used here uniformly for the upper layer to perform stable identity calculations to prevent the same directory from being recognized as two workspaces.
      return realpath(params.path);
    },
    async createDefaultWorkspace(): Promise<{ path: string }> {
      const workspacePath = join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME);
      await mkdir(workspacePath, { recursive: true });
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      return { path: workspacePath };
    },
    async ensureConversationWorkspace() {
      const workspacePath = getConversationWorkspaceDir();
      let created = false;
      try {
        created = (await mkdir(workspacePath, { recursive: true })) !== undefined;
      } catch (error) {
        const workspaceStat = await stat(workspacePath).catch(() => null);
        if (!workspaceStat) {
          throw error;
        }
        if (!workspaceStat.isDirectory()) {
          throw new Error(`Workspace path is not a directory: ${workspacePath}`, {
            cause: error,
          });
        }
      }
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      return {
        path: workspacePath,
        created,
        workspacePurpose: "conversation" as const,
      };
    },
    async createScratchWorkspace(params: { name: string }): Promise<{ path: string }> {
      const workspaceName = validateScratchWorkspaceName(params.name);
      const workspacePath = join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME, workspaceName);
      await mkdir(workspacePath, { recursive: true });
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      // Start from scratch must create an empty directory through the service layer, and the UI only submits the name.
      // This only ensures that the directory exists, without initializing git or writing template files; mkdir recursive makes the existing directory idempotent and succeeds.
      return { path: workspacePath };
    },
    async readTextFile(params: {
      path: string;
      offset?: number;
      length?: number;
    }): Promise<FileTextSlice> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const offset = Math.max(0, Math.trunc(params.offset ?? 0));
      if (offset >= fileStat.size) {
        return {
          path: params.path,
          content: "",
          offset,
          bytesRead: 0,
          totalBytes: fileStat.size,
          truncated: false,
          isBinary: false,
        };
      }
      const targetLength = clampReadLength(params.length);
      const remainingBytes = fileStat.size - offset;
      const readLength = Math.min(targetLength, remainingBytes);
      const handle = await open(params.path, "r");
      try {
        const buffer = Buffer.allocUnsafe(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
        const chunk = buffer.subarray(0, bytesRead);
        const isBinary = isProbablyBinary(chunk);
        // Performance Note: Text reading is always subject to the 256KB hard limit, and the caller can decide whether to display it based on truncated.
        // Avoid a one-time readFile for large or remote files that slows down both the utility process and the renderer.
        return {
          path: params.path,
          content: isBinary ? "" : chunk.toString("utf-8"),
          offset,
          bytesRead,
          totalBytes: fileStat.size,
          truncated: offset + bytesRead < fileStat.size,
          isBinary,
        };
      } finally {
        await handle.close();
      }
    },
    async readFileRange(params: {
      path: string;
      offset: number;
      length: number;
    }): Promise<Uint8Array> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const offset = Math.max(0, Math.trunc(params.offset));
      if (offset >= fileStat.size) {
        return new Uint8Array(0);
      }
      const targetLength = clampBinaryReadLength(params.length);
      const readLength = Math.min(targetLength, fileStat.size - offset);
      const handle = await open(params.path, "r");
      try {
        const buffer = Buffer.allocUnsafe(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
        // Returning the top-level Uint8Array: RPC serialization only takes the raw byte channel for the top-level binary,
        // Wrapping it into object fields will degenerate into JSON+base64, and the volume gain of loading large files in sections will be lost.
        // This is copied into an independent buffer to prevent irrelevant bytes from the allocUnsafe shared pool from being cloned together.
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },
    async readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const maxBytes = clampMediaPreviewBytes(params.maxBytes);
      if (fileStat.size > maxBytes) {
        throw new Error(`File is too large to preview: ${params.path}`);
      }
      // Media preview continues to be compatible with desktop/web/remote through service abstraction instead of directly touching the file system at the UI layer.
      const content = await readFile(params.path);
      return {
        path: params.path,
        mediaType: inferMediaTypeFromPath(params.path),
        dataBase64: content.toString("base64"),
        totalBytes: fileStat.size,
      };
    },
    async readBinaryPreview(params: {
      path: string;
      maxBytes?: number;
    }): Promise<FileBinaryPreview> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const maxBytes = clampBinaryPreviewBytes(params.maxBytes);
      if (fileStat.size > maxBytes) {
        throw new Error(`File is too large to preview: ${params.path}`);
      }
      // Office parsers require full ZIP/OLE bytes and cannot reuse text chunked reads.
      // Here, a hard upper limit of 25 MB is first set at the service layer, and then returned across RPC in base64.
      // Keep desktop, web, and remote workspaces using the same file read boundaries.
      const content = await readFile(params.path);
      return {
        path: params.path,
        dataBase64: content.toString("base64"),
        totalBytes: fileStat.size,
      };
    },
    async searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]> {
      const requestedLimit = params.limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
      if (!Number.isFinite(requestedLimit) || typeof params.query !== "string") {
        throw new Error("Invalid workspace file search query or limit");
      }
      const limit = Math.min(
        WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
        Math.max(0, Math.trunc(requestedLimit)),
      );
      if (limit === 0) return [];
      const index = await ensureWorkspaceFileIndex(
        params.rootPath,
        params.workspaceIdentity,
        params.refresh,
      );
      index.candidates ??= buildHostFileSearchCandidates(index.packed, params.rootPath);
      return searchHostFileCandidates(await index.candidates, params.query, limit);
    },
    async listWorkspaceFilesLength(params: { rootPath: string }): Promise<number> {
      const { packed } = await ensureWorkspaceFileIndex(params.rootPath);
      return packed.length;
    },
    async listWorkspaceFilesRange(params: {
      rootPath: string;
      offset: number;
      length: number;
    }): Promise<string> {
      const { packed } = await ensureWorkspaceFileIndex(params.rootPath);
      const offset = Math.max(0, Math.trunc(params.offset));
      if (offset >= packed.length) {
        return "";
      }
      const length = Math.max(0, Math.trunc(params.length));
      return packed.slice(offset, Math.min(packed.length, offset + length));
    },
    async readWorkspaceFileSearchIgnore(params: {
      rootPath: string;
    }): Promise<{ content: string; source: "file" | "template" }> {
      return readWorkspaceFileSearchIgnore(params.rootPath);
    },
    async applyWorkspaceFileSearchIgnoreTransform(params: {
      rootPath: string;
      transform: "sync-gitignore" | "reset-defaults";
    }): Promise<{ content: string }> {
      return transformWorkspaceFileSearchIgnore(params.rootPath, params.transform);
    },
    async writeWorkspaceFileSearchIgnore(params: {
      rootPath: string;
      content: string;
    }): Promise<void> {
      await writeWorkspaceFileSearchIgnore(params.rootPath, params.content);
    },
  };
}
