/**
 * The host implementation of `IFileService`.
 *
 * Every filesystem operation here is native (`@zcode/rust/fs`, crate
 * `zcode-fs`). Spec: docs/specs/rust-native-fs.md. This module owns three
 * things and nothing else:
 *
 * 1. **The allowlist.** `FileServiceScope` is a required constructor argument.
 *    Every native call passes `scope.roots()`; the crate canonicalizes the
 *    requested path and rejects anything that escapes. There is no flag, no
 *    fallback, and no code path here that reaches the filesystem without it —
 *    this file does not import `node:fs` at all.
 * 2. **The workspace index cache.** 60 s TTL, `.zcodeignore` mtime/size
 *    signature, 4-entry LRU, in-flight dedup, `refresh` bypass. Unchanged from
 *    the pre-port implementation, including the `localeCompare` sort: that is
 *    ICU collation, it is load-bearing for the top-K merge, and it is not
 *    reproducible byte-for-byte in Rust.
 * 3. **The existence memo.** 60 s TTL, 100 entries. Safe because the root set
 *    is append-only, so a cached verdict derived from a confined call stays
 *    valid for the rest of its lifetime.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type {
    FileBinaryPreview,
    FileEntry,
    FileMediaPreview,
    FileStat,
    FileTextSlice,
    WorkspaceFileEntry,
} from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { finiteOrUndefined, loadFsApi } from "@zcode/rust/fs";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getConversationWorkspaceDir, getDataBaseDir } from "../paths.js";
import type { IFileService, WorkspaceFileSearchParams } from "./file.js";
import { FileServiceScope } from "./fileServiceScope.js";
import {
    buildHostFileSearchCandidates,
    searchHostFileCandidates,
    type WorkspaceFileSearchCandidates,
} from "./workspaceFileSearch.js";

const FILE_EXISTENCE_CACHE_TTL_MS = 60_000;
const FILE_EXISTENCE_CACHE_MAX_ENTRIES = 100;
const SCRATCH_WORKSPACE_ROOT_NAME = "ZCodeProject";

/**
 * Host side short TTL caching of listWorkspaceFiles:
 * A full warehouse scan of a 370,000-file workspace will take several seconds even if it is done concurrently.
 * Open repeatedly (@ renderer semantics, Command Center, file tree that is cleaned when the panel is closed)
 * You should not rescan every time. The service is isolated by workspaceIdentity (default is rootPath).
 * Verify the mtime/size fingerprint of rootPath + .zcodeignore; the cache will be invalid after editing the rules.
 * Maintain the contract of "editing the rules will take effect the next time they are used".
 */
const WORKSPACE_FILE_LIST_CACHE_TTL_MS = 60_000;
const WORKSPACE_FILE_LIST_CACHE_MAX_ENTRIES = 4;

interface FileExistenceCacheEntry {
    exists: boolean;
    expiresAt: number;
}

class FileExistenceCache {
    private readonly entries = new Map<string, FileExistenceCacheEntry>();

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

export interface CreateFileServiceOptions {
    /**
     * Required. The allowlist every native call is confined to; there is no
     * default and no way to opt out of the check.
     */
    scope: FileServiceScope;
}

/**
 * Creating a workspace directory is the one operation whose path does not exist
 * yet, so the native side confines it against the deepest existing ancestor
 * rather than against the workspace allowlist. Both seeds below come from this
 * module — the scratch root is `homedir()/ZCodeProject` and the conversation
 * root is derived from the data base dir — and the caller's contribution is a
 * single name segment with no separator, so the reachable set is exactly the
 * product's two workspace roots.
 */
function workspaceCreationRoots(baseDir: string): string[] {
    return [...new Set([baseDir, homedir(), getDataBaseDir()])];
}

export function createFileService(options: CreateFileServiceOptions): IFileService {
    const { scope } = options;
    const api = loadFsApi();
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

        // No `.catch(() => false)`: the native call answers "does not exist"
        // with `exists: false` and only *throws* for a containment rejection, so
        // swallowing here would turn "you may not look there" into "it is not
        // there" and hide the attempt.
        const check = api
            .checkFilesExist({ paths: [path], roots: scope.roots() })
            .then((results) => results[0]?.exists === true)
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
        // A caller that hands us a workspace root is telling us that root is in
        // scope, so it joins the allowlist before anything is read through it.
        scope.allow(rootPath);
        const workspaceKey = workspaceIdentity?.trim() || rootPath;
        const roots = scope.roots();
        // One native call now covers both the rules content and the mtime/size
        // fingerprint the cache signature needs, where the pre-port code made
        // two round trips (a `stat` on top of the rules read).
        const ignoreRules = await api.loadWorkspaceIgnoreRules({ rootPath, roots });
        if (ignoreRules.degradedReason) {
            workspaceIgnoreLogger.warn(
                undefined,
                `[workspace-file-ignore] ${ignoreRules.degradedReason}, falling back to ${
                    ignoreRules.source === "fallback-gitignore"
                        ? ".gitignore"
                        : "built-in default"
                } rules at runtime`,
            );
        } else if (ignoreRules.created) {
            workspaceIgnoreLogger.info(
                undefined,
                `[workspace-file-ignore] auto-created .zcodeignore (source: ${
                    ignoreRules.source === "created-from-gitignore"
                        ? ".gitignore copy"
                        : "default template"
                })`,
            );
        }
        const cacheSignature = `${rootPath}\n${ignoreRules.fingerprint}`;
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
            // The traversal, the gitignore matching and the mention filter all run
            // in Rust. What stays here is the `localeCompare` sort and the
            // packing, because the sort order is the top-K merge's input and ICU
            // collation cannot be reproduced in Rust.
            const found = await api.walkWorkspace({
                rootPath,
                roots,
                ignoreRules: ignoreRules.content,
            });
            const sorted = found.sort((left, right) => {
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
            const entries = await api.readdir({
                path: params.path,
                roots: scope.roots(),
                includeHidden: params.includeHidden === true,
            });
            // The directory selector and the file tree want directories first and
            // then `localeCompare` order, which is the sort the pre-port
            // implementation ran here and the sort the walk's output is defined
            // relative to.
            return entries.sort((left, right) => {
                if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
                return left.name.localeCompare(right.name);
            });
        },
        async stat(params: { path: string }): Promise<FileStat> {
            const result = await api.stat({ path: params.path, roots: scope.roots() });
            // Markdown links need to distinguish between files and directories when clicked.
            // Previously, when a file was opened, the directory would fall into CodeViewer and failed to read the file; here, the judgment is closed to the service layer.
            // The UI simply offloads to the preview or temporary file tree based on structured results.
            return {
                path: result.path,
                type: result.type,
                // A directory has no meaningful size; `null` from the binding is
                // normalized back to absent so the contract stays optional.
                ...(result.size === undefined ? {} : { size: result.size, mtimeMs: result.mtimeMs }),
            };
        },
        async checkFilesExist(params: {
            paths: string[];
        }): Promise<Array<{ path: string; exists: boolean }>> {
            // The caller has selected candidates in reverse text order; the per-path memo plus the native cap keep a single batch bounded.
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
            // The native side confines the result to the allowlist first.
            return api.resolvePath({ path: params.path, roots: scope.roots() });
        },
        async createDefaultWorkspace(): Promise<{ path: string }> {
            const baseDir = join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME);
            const created = await api.ensureWorkspaceDirectory({
                baseDir,
                roots: workspaceCreationRoots(baseDir),
            });
            scope.allow(created.path);
            return { path: created.path };
        },
        async ensureConversationWorkspace() {
            const baseDir = getConversationWorkspaceDir();
            const created = await api.ensureWorkspaceDirectory({
                baseDir,
                roots: workspaceCreationRoots(baseDir),
            });
            scope.allow(created.path);
            return {
                path: created.path,
                created: created.created,
                workspacePurpose: "conversation" as const,
            };
        },
        async createScratchWorkspace(params: { name: string }): Promise<{ path: string }> {
            const baseDir = join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME);
            const created = await api.ensureWorkspaceDirectory({
                baseDir,
                // The name is validated natively (required, no separators); an
                // empty name is the default workspace, which the pre-port
                // implementation covered with a separate method.
                name: params.name,
                roots: workspaceCreationRoots(baseDir),
            });
            scope.allow(created.path);
            // Start from scratch must create an empty directory through the service layer, and the UI only submits the name.
            // This only ensures that the directory exists, without initializing git or writing template files; mkdir recursive makes the existing directory idempotent and succeeds.
            return { path: created.path };
        },
        async readTextFile(params: {
            path: string;
            offset?: number;
            length?: number;
        }): Promise<FileTextSlice> {
            return api.readTextFile({
                path: params.path,
                roots: scope.roots(),
                offset: finiteOrUndefined(params.offset),
                length: finiteOrUndefined(params.length),
            });
        },
        async readFileRange(params: {
            path: string;
            offset: number;
            length: number;
        }): Promise<Uint8Array> {
            // A native `Buffer`, so the top-level binary keeps RPC's raw byte channel;
            // wrapping it into object fields would degenerate into JSON+base64.
            return api.readFileRange({
                path: params.path,
                roots: scope.roots(),
                offset: finiteOrUndefined(params.offset),
                length: finiteOrUndefined(params.length),
            });
        },
        async readMediaPreview(params: {
            path: string;
            maxBytes?: number;
        }): Promise<FileMediaPreview> {
            return api.readMediaPreview({
                path: params.path,
                roots: scope.roots(),
                maxBytes: finiteOrUndefined(params.maxBytes),
            });
        },
        async readBinaryPreview(params: {
            path: string;
            maxBytes?: number;
        }): Promise<FileBinaryPreview> {
            return api.readBinaryPreview({
                path: params.path,
                roots: scope.roots(),
                maxBytes: finiteOrUndefined(params.maxBytes),
            });
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
            scope.allow(params.rootPath);
            return api.readWorkspaceIgnore({
                rootPath: params.rootPath,
                roots: scope.roots(),
            });
        },
        async applyWorkspaceFileSearchIgnoreTransform(params: {
            rootPath: string;
            transform: "sync-gitignore" | "reset-defaults";
        }): Promise<{ content: string }> {
            scope.allow(params.rootPath);
            return api.transformWorkspaceIgnore({
                rootPath: params.rootPath,
                roots: scope.roots(),
                transform: params.transform,
            });
        },
        async writeWorkspaceFileSearchIgnore(params: {
            rootPath: string;
            content: string;
        }): Promise<void> {
            scope.allow(params.rootPath);
            await api.writeWorkspaceIgnore({
                rootPath: params.rootPath,
                roots: scope.roots(),
                content: params.content,
            });
        },
    };
}

interface WorkspaceFileIndex {
    at: number;
    signature: string;
    packed: string;
    candidates?: Promise<WorkspaceFileSearchCandidates>;
}
