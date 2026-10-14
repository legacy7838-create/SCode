/* eslint-disable max-lines */
import { mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileTextSlice,
  WorkspaceFileEntry,
} from "@zcode/shared";
import { getMediaPreviewFormat } from "@zcode/shared";
import type { IFileService, WorkspaceFileSearchParams } from "./file.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { searchWorkspaceFilesByScore } from "./workspaceScoreNative.js";
import { scanWorkspaceFilesPacked, resolveWorkspaceScanLocale } from "./workspaceScanNative.js";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
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
// normalizeRelativePath / isSkippableWorkspaceFileListError were the retired JS scan's helpers;
// both now live inside the Rust addon (see spec/native-boundary-workspace-scan.md §5).

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

    // Map 保留插入顺序；命中后重新插入，让真正活跃的路径位于 LRU 队尾。
    this.entries.delete(path);
    this.entries.set(path, cached);
    return cached.exists;
  }

  set(path: string, exists: boolean): void {
    const now = Date.now();
    // 旧缓存只在同一路径再次读取时判断 TTL，不同路径的过期项会永久留在 Host 内存中。
    // 每次写入先清理全部过期项，再用固定容量兜住持续生成不同候选路径的长生命周期场景。
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
    // Node 的 Dirent 对软链接目录只返回 isSymbolicLink，不会返回 isDirectory。
    // 目录选择器只展示 directory 类型，远程 SSH 选目录时因此看不到指向目录的软链接；这里跟随目标重新分类。
    return targetStat.isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}

/**
 * Kept as an exported empty interface because `node.ts` re-exports it: removing the symbol would be
 * a public-surface break for an option that no longer exists.
 *
 * The old `workspaceFileSearchFilter?: WorkspaceFileSearchFilter` injection point is **removed, not
 * ported**. It had zero callers and zero tests (verified by grep across `packages/` and `apps/`),
 * and `ignoreRulesActive` was hardcoded `true` at its single call site, so its directory blacklist
 * was already dead code. Porting it would mean either a per-entry callback into JS — which would
 * erase the whole point of the native scan — or two filter implementations free to drift.
 */
export interface CreateFileServiceOptions {}

/**
 * listWorkspaceFiles 的 Host 侧短 TTL 缓存：
 * 37 万文件 workspace 的全仓扫描即使并发化也要数秒，同一 workspace 的
 * 反复打开（@ 面板关闭即清理的 renderer 语义、Command Center、文件树）
 * 不应每次都重扫。服务内按 workspaceIdentity（缺省为 rootPath）隔离，
 * 校验 rootPath + .zcodeignore 的 mtime/size 指纹；规则编辑后缓存失效，
 * 保持"编辑规则后下次使用生效"的契约。
 */
const WORKSPACE_FILE_LIST_CACHE_TTL_MS = 60_000;
const WORKSPACE_FILE_LIST_CACHE_MAX_ENTRIES = 4;
interface WorkspaceFileIndex {
  at: number;
  signature: string;
  packed: string;
}

async function statWorkspaceFileSearchIgnoreFingerprint(rootPath: string): Promise<string> {
  try {
    const fileStat = await stat(join(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME));
    return `${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    return "none";
  }
}

export function createFileService(_options: CreateFileServiceOptions = {}): IFileService {
  const workspaceIgnoreLogger = createServiceLogger("workspace-file-ignore");
  const fileExistenceCache = new FileExistenceCache();
  // 索引归服务实例；不同 Host/注入过滤器不能通过模块全局缓存复用同路径结果。
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
        // 正负结果都缓存：assistant 自然语言经常重复提到同一缺失路径，避免远程 Host
        // 在一分钟内为同一候选重复发起 SSH stat。
        fileExistenceCache.set(path, exists);
        return exists;
      })
      .finally(() => {
        pendingFileExistenceChecks.delete(path);
      });
    pendingFileExistenceChecks.set(path, check);
    return check;
  };

  // 全量扫描 + 打包（带 60s TTL / .zcodeignore 指纹缓存）。分块 RPC 共享同一份 packed。
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
    // 刷新中的同作用域查询等待新索引，不能先命中旧缓存而遗漏刚创建的文件。
    if (!refresh && inFlight?.signature === cacheSignature) return inFlight.promise;
    const cached = workspaceFileListCache.get(workspaceKey);
    if (!refresh && cached?.signature === cacheSignature) {
      workspaceFileListCache.delete(workspaceKey);
      workspaceFileListCache.set(workspaceKey, cached);
      return cached;
    }
    // 扫描已整体下沉到 Rust `zcode-scan` addon：递归遍历、.zcodeignore 剪枝、目录优先 + ICU 排序、
    // 列式打包全部在 native 侧一次完成（spec/native-boundary-workspace-scan.md）。
    //
    // 为什么零 JS fallback：旧实现在这条路上对**每个**目录项都 await 一次
    // （resolveReaddirEntryType 对非软链接是同步返回，await 仍是白付一次微任务），
    // 37 万文件的 workspace 实测要 21.8s（串行）/ 2.3s（8 并发，本机 161859 行）。
    // addon 是唯一实现：缺失时 workspaceScanNative 直接抛，不降级为慢速 JS 扫描，
    // 否则「能用」会静默变成「慢十倍」而无人发现。
    //
    // 跨界传的是**规则文本**而非 ignore matcher：matcher 是编译产物无法序列化，
    // 文本才是单一事实。addon 不读也不建 .zcodeignore（§1.3）。
    // locale 必须是调用方解析出的 Intl.Collator locale：Node 裸 localeCompare 用的是运行时
    // 默认 locale，而 Rust 侧只写死了 Strength::Tertiary，locale 不一致就会静默重排 @ 面板。
    const scanning = Promise.resolve().then(() => {
      const packed = scanWorkspaceFilesPacked({
        rootPath,
        ignoreRuleText: ignoreRules.content,
        locale: resolveWorkspaceScanLocale(),
      });
      return { at: Date.now(), signature: cacheSignature, packed };
    });
    workspaceFileListScanning.set(workspaceKey, { signature: cacheSignature, promise: scanning });
    try {
      const index = await scanning;
      // 显式刷新/规则变化可替换在途扫描，旧扫描完成时只服务旧请求，不覆盖新索引。
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
            // 修复：workspace 文件树需要展示 .gitignore/.env/.github 等项目文件，
            // 但目录选择器等旧调用仍应默认隐藏 dotfiles，避免突然增加噪音。
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
      // markdown 链接点击时需要区分文件和目录。
      // 之前统一当文件打开，目录会落到 CodeViewer 里读文件失败；这里把判断收口到服务层，
      // UI 只根据结构化结果分流到预览或临时文件树。
      const isDirectory = fileStat.isDirectory();
      return {
        path: params.path,
        type: isDirectory ? ("directory" as const) : ("file" as const),
        // 目录的 size 无意义，只对文件返回，供预览层决定二进制文件的加载策略
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

      // 调用方已按正文逆序选出候选；Promise.all 保持输入顺序，并把单批并发硬限制在 15。
      return Promise.all(
        params.paths.map(async (path) => ({
          path,
          exists: await checkFileExists(path),
        })),
      );
    },
    async resolvePath(params: { path: string }): Promise<string> {
      // 远程 workspace 可能通过符号链接别名输入（/dev vs /home/dev）。
      // 这里统一走 realpath，供上层做稳定身份计算，避免同目录被识别成两个 workspace。
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
      // Start from scratch 必须通过 service 层创建空目录，UI 只提交名称。
      // 这里仅确保目录存在，不初始化 git、不写模板文件；mkdir recursive 让已存在目录幂等成功。
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
        // 性能说明：文本读取始终受 256KB 硬上限约束，调用方可据 truncated 决定是否展示，
        // 避免大文件或远程文件一次性 readFile 把 utility process 和 renderer 一起拖慢。
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
        // 返回顶层 Uint8Array：RPC 序列化只有顶层二进制走原始字节通道，
        // 包成对象字段会退化成 JSON+base64，大文件分段加载的体积收益就没了。
        // 这里拷贝成独立 buffer，避免 allocUnsafe 共享池的无关字节被一起克隆出去。
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
      // 媒体预览继续通过 service 抽象兼容 desktop / web / remote，而不是在 UI 层直接碰文件系统。
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
      // Office 解析器需要完整的 ZIP / OLE 字节，不能复用文本分块读取。
      // 这里在 service 层先做 25 MB 硬上限，再以 base64 跨 RPC 返回，
      // 保持 desktop、Web 和远程 workspace 使用同一文件读取边界。
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
      // 打分与 top-K 整体在 Rust/WASM 侧（spec/native-boundary-fuzzy-score.md）：Host 不再把 37 万
      // 条 packed 索引物化成 JS candidate 对象，每键只在 WASM 里排一次序再解回 ≤limit 条 entry。
      // 零 JS fallback：artifact 缺失时 workspaceScoreNative 直接抛，不降级成逐候选的 JS 打分，
      // 否则「能用」会静默变成「慢十倍」而无人发现。
      return searchWorkspaceFilesByScore({
        packed: index.packed,
        rootPath: params.rootPath,
        query: params.query,
        limit,
      });
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
