/**
 * Typed wrapper over the zcode-fs napi binary (spec: docs/specs/rust-native-fs.md).
 *
 * The one thing to read before using anything here: **every request that
 * touches a path carries a `roots` allowlist, and it is required.** The native
 * side canonicalizes the requested path — every symlink resolved, every `..`
 * folded — and rejects anything that lands outside a root. There is no
 * unconfined call to fall back to, so the TypeScript service cannot skip the
 * check even if it wanted to. `packages/services/src/file/fileService.ts` is the
 * only consumer and passes `scope.roots()` on every call.
 *
 * Load errors are thrown loudly by loadNative — there is no JS fallback here.
 */
import { loadNative } from "./loader.js";

/** `roots` is present on every path-touching request; omitting it is a binding error. */
export interface NativeFsRequest {
    roots: string[];
}

export type NativeFileEntryType = "file" | "directory";

export interface NativeFileEntry {
    name: string;
    path: string;
    type: NativeFileEntryType;
    isSymbolicLink: boolean;
}

export interface NativeFileStat {
    path: string;
    type: NativeFileEntryType;
    /** Absent for a directory, matching the wire contract. */
    size?: number;
    /** Absent for a directory, matching the wire contract. */
    mtimeMs?: number;
}

export interface NativePathExistence {
    path: string;
    exists: boolean;
}

export interface NativeTextSlice {
    path: string;
    content: string;
    offset: number;
    bytesRead: number;
    totalBytes: number;
    truncated: boolean;
    isBinary: boolean;
}

export interface NativeMediaPreview {
    path: string;
    mediaType: string;
    dataBase64: string;
    totalBytes: number;
}

export interface NativeBinaryPreview {
    path: string;
    dataBase64: string;
    totalBytes: number;
}

export interface NativeWorkspaceDirectory {
    path: string;
    created: boolean;
}

export type NativeIgnoreRulesSource =
    | "file"
    | "created-from-gitignore"
    | "created-from-template"
    | "fallback-gitignore"
    | "fallback-builtin";

export interface NativeLoadedIgnoreRules {
    content: string;
    source: NativeIgnoreRulesSource;
    created: boolean;
    /** Present when the load chain degraded; the host logs it once. */
    degradedReason?: string;
    /** `mtimeMs:size` of `.zcodeignore`, or `"none"`. The host cache signature. */
    fingerprint: string;
}

export interface NativeWorkspaceFileEntry {
    name: string;
    path: string;
    relativePath: string;
    type: NativeFileEntryType;
}

export interface NativeFileDecision {
    include: boolean;
    traverse: boolean;
}

export type NativeIgnoreTransform = "sync-gitignore" | "reset-defaults";

export interface NativeFsApi {
    readdir(request: { path: string; roots: string[]; includeHidden?: boolean }): Promise<NativeFileEntry[]>;
    stat(request: { path: string; roots: string[] }): Promise<NativeFileStat>;
    checkFilesExist(request: { paths: string[]; roots: string[] }): Promise<NativePathExistence[]>;
    resolvePath(request: { path: string; roots: string[] }): Promise<string>;
    readTextFile(request: {
        path: string;
        roots: string[];
        offset?: number;
        length?: number;
    }): Promise<NativeTextSlice>;
    /** Returns a real `Uint8Array` (napi `Buffer`, never a plain `Array`). */
    readFileRange(request: {
        path: string;
        roots: string[];
        offset?: number;
        length?: number;
    }): Promise<Uint8Array>;
    readMediaPreview(request: {
        path: string;
        roots: string[];
        maxBytes?: number;
    }): Promise<NativeMediaPreview>;
    readBinaryPreview(request: {
        path: string;
        roots: string[];
        maxBytes?: number;
    }): Promise<NativeBinaryPreview>;
    ensureWorkspaceDirectory(request: {
        baseDir: string;
        roots: string[];
        name?: string;
    }): Promise<NativeWorkspaceDirectory>;
    loadWorkspaceIgnoreRules(request: {
        rootPath: string;
        roots: string[];
    }): Promise<NativeLoadedIgnoreRules>;
    walkWorkspace(request: {
        rootPath: string;
        roots: string[];
        ignoreRules: string;
    }): Promise<NativeWorkspaceFileEntry[]>;
    readWorkspaceIgnore(request: { rootPath: string; roots: string[] }): Promise<{
        content: string;
        source: "file" | "template";
    }>;
    transformWorkspaceIgnore(request: {
        rootPath: string;
        roots: string[];
        transform: NativeIgnoreTransform;
    }): Promise<{ content: string }>;
    writeWorkspaceIgnore(request: {
        rootPath: string;
        roots: string[];
        content: string;
    }): Promise<boolean>;
    matchWorkspaceIgnorePath(request: {
        rules: string;
        relativePath: string;
        isDirectory: boolean;
    }): boolean;
    evaluateWorkspaceFileEntry(request: {
        name: string;
        relativePath: string;
        type: NativeFileEntryType;
        ignoreRulesActive: boolean;
    }): NativeFileDecision;
    /** Omit `gitignore` for the built-in template; the binding rejects an explicit `null`. */
    buildWorkspaceIgnoreTemplate(request: { gitignore?: string }): string;
}

let _cached: NativeFsApi | null = null;

export function loadFsApi(): NativeFsApi {
    if (!_cached) {
        _cached = loadNative<NativeFsApi>("zcode-fs");
    }
    return _cached;
}

/**
 * Normalizes an optional numeric parameter the way the predecessor's clamps did.
 *
 * `Number.isFinite(x) ? Math.trunc(x) : default` means a non-finite value (NaN,
 * Infinity, or a non-number that survived the RPC boundary) takes the default
 * rather than reaching the native clamp. Passing `undefined` here is exactly
 * that: the native side substitutes its own default, which is the same number.
 */
export function finiteOrUndefined(value: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
