import { Emitter } from "@zcode/rpc";
import type { IRemoteBackend } from "@zcode/server/remote";
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentStageResult,
  PromptAttachmentTransferProgress,
} from "@zcode/services";
import type { ZCodePromptAttachment } from "@zcode/shared";
import {
  cleanupRemotePromptAttachment,
  cleanupStaleRemotePromptAttachments,
  materializeRemotePromptAttachments,
} from "./remotePromptAttachments.js";

interface TransferRecord {
  controller: AbortController;
  ref?: string;
  bytes: number;
  adopted: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Eager staging implementation for remote workspaces. The record only lives in the current
 * workspace host; relay/main hold no attachment progress or staging lifecycle.
 */
export function createRemotePromptAttachmentTransferService(
  backend: Pick<IRemoteBackend, "exec" | "upload">,
  options: { onJanitorError?: (error: unknown) => void } = {},
): IPromptAttachmentTransferService {
  const records = new Map<string, TransferRecord>();
  const emitters = new Map<string, Emitter<PromptAttachmentTransferProgress>>();

  void cleanupStaleRemotePromptAttachments(backend).catch((error) => {
    options.onJanitorError?.(error);
  });

  const getEmitter = (operationId: string) => {
    const existing = emitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<PromptAttachmentTransferProgress>({
      onDidRemoveLastListener: () => {
        emitters.delete(operationId);
        emitter.dispose();
      },
    });
    emitters.set(operationId, emitter);
    return emitter;
  };

  const cleanup = async (operationId: string, includeAdopted: boolean) => {
    const record = records.get(operationId);
    if (!record) return;
    record.controller.abort();
    if (record.ref && (includeAdopted || !record.adopted)) {
      await cleanupRemotePromptAttachment(backend, record.ref);
    }
    records.delete(operationId);
  };

  return {
    async stage(params): Promise<PromptAttachmentStageResult> {
      await cleanup(params.operationId, false);
      const controller = new AbortController();
      const record: TransferRecord = {
        controller,
        bytes: Math.max(0, params.sizeBytes ?? 0),
        adopted: false,
      };
      records.set(params.operationId, record);
      const emitter = getEmitter(params.operationId);
      let lastPercent = -1;
      let lastEmittedAt = 0;
      let lastUploadedBytes = 0;
      const attachment: ZCodePromptAttachment = {
        kind: params.mime.startsWith("image/") ? "image" : "file",
        filename: params.fileName,
        localPath: params.localPath,
        mimeType: params.mime,
        sizeBytes: params.sizeBytes ?? 0,
      } as ZCodePromptAttachment;
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      try {
        const materialized = await materializeRemotePromptAttachments(
          {
            taskId: params.sessionId,
            // The temporary directory has both workspace identity and remote session dimensions to avoid the same path,
            // Eager attachments of different remote identities or attached sessions overwrite each other.
            traceId: `${workspaceKey}\u0000${params.remoteSessionId ?? ""}\u0000${params.operationId}`,
            content: "",
            attachments: [attachment],
          },
          {
            backend,
            uploadOptions: {
              signal: controller.signal,
              onProgress(progress) {
                const totalBytes = Math.max(progress.totalBytes, record.bytes);
                record.bytes = totalBytes;
                lastUploadedBytes = Math.max(lastUploadedBytes, progress.uploadedBytes);
                const percent =
                  totalBytes > 0 ? Math.floor((lastUploadedBytes / totalBytes) * 100) : 0;
                const now = Date.now();
                if (percent <= lastPercent && now - lastEmittedAt < 100) return;
                lastPercent = Math.max(lastPercent, percent);
                lastEmittedAt = now;
                emitter.fire({
                  operationId: params.operationId,
                  phase: "uploading",
                  uploadedBytes: lastUploadedBytes,
                  totalBytes,
                });
              },
            },
          },
        );
        const next = materialized.attachments?.[0];
        const ref = next?.localPath?.trim();
        if (!ref) throw new Error("Remote attachment staging returned no path");
        if (records.get(params.operationId) !== record || controller.signal.aborted) {
          throw Object.assign(new Error("Remote upload canceled"), { name: "AbortError" });
        }
        record.ref = ref;
        emitter.fire({
          operationId: params.operationId,
          phase: "committing",
          uploadedBytes: record.bytes,
          totalBytes: record.bytes,
        });
        emitter.fire({
          operationId: params.operationId,
          phase: "complete",
          uploadedBytes: record.bytes,
          totalBytes: record.bytes,
        });
        return {
          operationId: params.operationId,
          ref,
          bytes: record.bytes,
          staged: true,
        };
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          emitter.fire({
            operationId: params.operationId,
            phase: "canceled",
            uploadedBytes: 0,
            totalBytes: record.bytes,
          });
        }
        if (records.get(params.operationId) === record) {
          records.delete(params.operationId);
        }
        throw error;
      }
    },
    async adopt(operationId) {
      const record = records.get(operationId);
      if (record?.ref) {
        record.adopted = true;
        records.delete(operationId);
      }
    },
    async cancel(operationId) {
      await cleanup(operationId, false);
    },
    async cleanup(operationId) {
      await cleanup(operationId, false);
    },
    onDynamicProgress: (operationId) => getEmitter(operationId).event,
  };
}
