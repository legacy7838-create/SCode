import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";

import type { IFileService } from "#src/file/file.js";

import { ConversationShareServiceError } from "./conversationShare.js";

export interface ConversationShareArtifactReadInput {
  workspacePath: string;
  ref: string;
  maxBytes: number;
}

export interface ConversationShareMaterializedArtifact {
  bytes: Uint8Array;
  canonicalPath: string;
}

export interface ConversationShareArtifactStat {
  canonicalPath: string;
  size: number;
  mtimeMs?: number;
}

export interface ConversationShareArtifactSource {
  read(input: ConversationShareArtifactReadInput): Promise<ConversationShareMaterializedArtifact>;
  stat?(
    input: Omit<ConversationShareArtifactReadInput, "maxBytes">,
  ): Promise<ConversationShareArtifactStat>;
}

const REMOTE_READ_CHUNK_BYTES = 512 * 1024;
const SKIPPABLE_ARTIFACT_READ_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

function isSkippableArtifactReadError(error: unknown): boolean {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof errno === "string" && SKIPPABLE_ARTIFACT_READ_ERRNOS.has(errno);
}

/**
 * A failed fallback read always carries artifact_read_failed plus the underlying errno:
 * the caller uses that to downgrade "a file referenced by the body no longer exists" into a
 * non-blocking skip instead of failing the whole publish. The errno goes through the
 * allow-listed diagnostics; paths never enter the error payload.
 */
function unreadableArtifactError(message: string, cause: unknown): ConversationShareServiceError {
  const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
  return new ConversationShareServiceError("invalid_conversation", message, {
    reasonCode: "artifact_read_failed",
    cause,
    ...(typeof errno === "string" ? { diagnostics: { errno } } : {}),
  });
}

function remotePathApi(path: string): typeof posix | typeof win32 {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") ? win32 : posix;
}

function isRemoteInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const pathApi = remotePathApi(workspacePath);
  const relativePath = pathApi.relative(workspacePath, targetPath);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath))
  );
}

/**
 * SSH/WSL uses the remote fileService for realpath/stat/range reads; JWT and HTTP upload stay in the Desktop Host.
 */
export function createRemoteConversationShareArtifactSource(
  fileService: Pick<IFileService, "readFileRange" | "resolvePath" | "stat">,
): ConversationShareArtifactSource {
  return {
    async stat(input) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a workspace path",
        );
      }
      try {
        const pathApi = remotePathApi(input.workspacePath);
        const workspaceRealPath = await fileService.resolvePath({ path: input.workspacePath });
        const requestedPath = pathApi.isAbsolute(input.ref)
          ? input.ref
          : pathApi.resolve(input.workspacePath, input.ref);
        const artifactRealPath = await fileService.resolvePath({ path: requestedPath });
        if (!isRemoteInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const artifactStat = await fileService.stat({ path: artifactRealPath });
        if (artifactStat.type !== "file" || artifactStat.size === undefined) {
          throw unreadableArtifactError("Conversation artifact source is not a readable file", {
            code: "ENOTDIR",
          });
        }
        return {
          canonicalPath: artifactRealPath,
          size: artifactStat.size,
          ...(artifactStat.mtimeMs === undefined ? {} : { mtimeMs: artifactStat.mtimeMs }),
        };
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError(
          "Conversation artifact cannot be read from the remote workspace",
          error,
        );
      }
    },
    async read(input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact byte limit is invalid",
        );
      }
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a workspace path",
        );
      }

      try {
        const pathApi = remotePathApi(input.workspacePath);
        const workspaceRealPath = await fileService.resolvePath({ path: input.workspacePath });
        const requestedPath = pathApi.isAbsolute(input.ref)
          ? input.ref
          : pathApi.resolve(input.workspacePath, input.ref);
        const artifactRealPath = await fileService.resolvePath({ path: requestedPath });
        if (!isRemoteInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }

        const before = await fileService.stat({ path: artifactRealPath });
        if (before.type !== "file" || before.size === undefined) {
          throw new ConversationShareServiceError(
            "invalid_conversation",
            "Conversation artifact source is not a readable file",
          );
        }
        if (before.size > input.maxBytes) {
          throw new ConversationShareServiceError(
            "limit_exceeded",
            "Conversation artifact exceeds the byte limit",
          );
        }

        const bytes = new Uint8Array(before.size);
        let offset = 0;
        while (offset < before.size) {
          const chunk = await fileService.readFileRange({
            path: artifactRealPath,
            offset,
            length: Math.min(REMOTE_READ_CHUNK_BYTES, before.size - offset),
          });
          if (chunk.byteLength === 0) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact ended during remote staging",
            );
          }
          if (offset + chunk.byteLength > before.size) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact changed during remote staging",
            );
          }
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const after = await fileService.stat({ path: artifactRealPath });
        if (
          after.type !== "file" ||
          after.size !== before.size ||
          (before.mtimeMs !== undefined && after.mtimeMs !== before.mtimeMs)
        ) {
          throw new ConversationShareServiceError(
            "invalid_conversation",
            "Conversation artifact changed during remote staging",
          );
        }
        return { bytes, canonicalPath: artifactRealPath };
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        // Only explicit "file does not exist/path is not a file" allows the discovery process to downgrade to warning.
        // Errors such as remote connection disconnection and insufficient permissions must continue to be thrown to avoid silent loss of results after successful publishing.
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError(
          "Conversation artifact cannot be read from the remote workspace",
          error,
        );
      }
    },
  };
}

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relativePath = relative(workspacePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function createLocalConversationShareArtifactSource(): ConversationShareArtifactSource {
  return {
    async stat(input) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a local workspace path",
        );
      }
      try {
        const workspaceRealPath = await realpath(input.workspacePath);
        const requestedPath = isAbsolute(input.ref)
          ? input.ref
          : resolve(input.workspacePath, input.ref);
        const artifactRealPath = await realpath(requestedPath);
        if (!isInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const handle = await open(artifactRealPath, "r");
        try {
          const artifactStat = await handle.stat();
          if (!artifactStat.isFile()) {
            throw unreadableArtifactError("Conversation artifact source is not a file", {
              code: "ENOTDIR",
            });
          }
          return {
            canonicalPath: artifactRealPath,
            size: artifactStat.size,
            mtimeMs: artifactStat.mtimeMs,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError("Conversation artifact cannot be read", error);
      }
    },
    async read(input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact byte limit is invalid",
        );
      }
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a local workspace path",
        );
      }

      try {
        const workspaceRealPath = await realpath(input.workspacePath);
        const requestedPath = isAbsolute(input.ref)
          ? input.ref
          : resolve(input.workspacePath, input.ref);
        const artifactRealPath = await realpath(requestedPath);
        // The ref of artifact Row comes from session data and cannot be trusted by default just because it currently only supports local publishing;
        // Workspace boundaries must be verified again after following symbolic links to avoid sharing reading of arbitrary native files.
        if (!isInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const handle = await open(artifactRealPath, "r");
        try {
          const artifactStat = await handle.stat();
          if (!artifactStat.isFile()) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact source is not a file",
            );
          }
          if (artifactStat.size > input.maxBytes) {
            throw new ConversationShareServiceError(
              "limit_exceeded",
              "Conversation artifact exceeds the byte limit",
            );
          }
          // The upper limit of the backend capability may be much larger than the current file, and allocation by maxBytes will cause small files to occupy large chunks of memory;
          // Reading only 1 byte more by stat size still recognizes file growth between stat/reads.
          const buffer = Buffer.allocUnsafe(artifactStat.size + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.byteLength) {
            const result = await handle.read(
              buffer,
              bytesRead,
              buffer.byteLength - bytesRead,
              bytesRead,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
          }
          if (bytesRead > input.maxBytes) {
            throw new ConversationShareServiceError(
              "limit_exceeded",
              "Conversation artifact exceeds the byte limit",
            );
          }
          return {
            bytes: new Uint8Array(buffer.subarray(0, bytesRead)),
            canonicalPath: artifactRealPath,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        // Only explicit "file does not exist/path is not a file" allows the discovery process to downgrade to warning.
        // Insufficient permissions or other IO errors need to block publishing and cannot be disguised as skippable missing files.
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError("Conversation artifact cannot be read", error);
      }
    },
  };
}
