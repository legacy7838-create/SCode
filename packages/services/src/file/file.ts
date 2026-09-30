import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  WorkspaceFileEntry,
  FileTextSlice,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface WorkspaceFileSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  limit?: number;
  /** No-hit catch-up scan: Bypass the index of files that have not yet expired. */
  refresh?: boolean;
}

export interface IFileService {
  /** Host matches and returns bounded candidates, preventing the Renderer from downloading the full file index. */
  searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]>;
  readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  stat(params: { path: string }): Promise<FileStat>;
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
  resolvePath(params: { path: string }): Promise<string>;
  ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  createDefaultWorkspace(): Promise<{ path: string }>;
  createScratchWorkspace(params: { name: string }): Promise<{ path: string }>;
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
  readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview>;
  /**
   * Reads a segment of raw bytes from a file by offset for on-demand segmented loading of large binary files (such as PDFs).
   * The return value must remain the top-level Uint8Array: RPC serialization only uses the raw byte channel for the top-level binary.
   * Nested in object fields will degenerate into JSON+base64. Returns a short array on EOF.
   */
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
  readBinaryPreview(params: { path: string; maxBytes?: number }): Promise<FileBinaryPreview>;
  /**
   * Column packed length of the workspace file index in characters. Paired with listWorkspaceFilesRange,
   * The caller pulls in chunks by length (see fetchWorkspaceFileEntriesPacked).
   * Return number: RPC Int fast path.
   */
  listWorkspaceFilesLength(params: { rootPath: string }): Promise<number>;
  /**
   * Chunked returns columnar packed string (workspaceFileEntriesCodec format, [offset, offset+length)).
   * Must be a bare string top-level return: RPC String fast path (length prefix + raw bytes); Object will
   * JSON escapes large strings (measured 6-9s long main thread task). A single block does not exceed ~4MB: big news is here
   * The frame reorganization of the renderer receiver is a second-long task (actually measured 4.6-6.3s). After block + inter-block concession
   * The main thread only processes a small chunk at a time (~50ms), and the input never freezes.
   * The host side has a whole packet cache with 60s TTL + .zcodeignore fingerprint signature, and the chunking is just a slice.
   */
  listWorkspaceFilesRange(params: {
    rootPath: string;
    offset: number;
    length: number;
  }): Promise<string>;
  /**
   * The workspace search ignores the reading and writing of rules (.zcodeignore) for settings page editing.
   * source: "file" The file content already exists; "template" is the initial content preview when it has not been created (it will be downloaded when saved).
   */
  readWorkspaceFileSearchIgnore(params: {
    rootPath: string;
  }): Promise<{ content: string; source: "file" | "template" }>;
  /**
   * Set page partition operation (return to fill in the edit box with new content, save and then save):
   * "sync-gitignore" only rewrites the gitignore synchronization area (retaining the default segment and custom area);
   * "reset-defaults" only resets the default excluded sections (leaving gitignore areas and custom areas).
   */
  applyWorkspaceFileSearchIgnoreTransform(params: {
    rootPath: string;
    transform: "sync-gitignore" | "reset-defaults";
  }): Promise<{ content: string }>;
  writeWorkspaceFileSearchIgnore(params: { rootPath: string; content: string }): Promise<void>;
}

export const IFileService = createServiceDescriptor<IFileService>(ServiceChannels.File);
