import { create } from "zustand";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";

export type ComposerAttachmentUploadStatus =
  | "waitingSession"
  | "queued"
  | "uploading"
  | "committing"
  | "ready"
  | "failed";

export interface ComposerAttachmentUploadItem extends ChatComposerAttachment {
  /**
   * composer-owned is still in the upload/staging lifecycle; session-owned is an existing ref
   * withdrawn from the authoritative queue. The latter has already been taken over by the session,
   * so runtime restart, cleanup, and resend must not process reference ownership again.
   */
  referenceOwnership: "composer" | "session";
  uploadStatus: ComposerAttachmentUploadStatus;
  uploadProgress: number;
  uploadError?: string;
  uploadErrorKind?: "transient" | "permanent" | "runtimeRestarted";
  attachmentRef?: AttachmentRef;
  operationId: string;
  autoRetryCount: number;
  /**
   * The number of re-transmissions triggered by a runtime generation change is counted separately
   * from upload-failure retries. A generation change is not an “upload failure”; sharing one
   * counter would let a single generation change burn the user-visible retry quota.
   */
  runtimeRebuildRetryCount: number;
  staged: boolean;
  adopted: boolean;
  showComplete: boolean;
  localZeroCopy: boolean;
}

interface ComposerAttachmentUploadStoreState {
  scopes: Record<string, ComposerAttachmentUploadItem[]>;
}

/**
 * In-memory renderer state: File/object URLs never touch disk, but they survive switching the
 * task/composer or a partial unmount. The upload controller is still held by the closure of the
 * hook that started the operation; relay/main keeps no business state.
 */
export const useComposerAttachmentUploadStore = create<ComposerAttachmentUploadStoreState>()(
  () => ({ scopes: {} }),
);

declare global {
  interface Window {
    __zcodeComposerAttachmentUploadStoreE2E?: typeof useComposerAttachmentUploadStore;
    __zcodeCurrentComposerAttachmentScopeKeyE2E?: string;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // E2E only exposes the current unique attachment owner for the scope to switch the use case preparation state; attachments are no longer stuffed back into the old Session Store.
  window.__zcodeComposerAttachmentUploadStoreE2E = useComposerAttachmentUploadStore;
}

export function exposeComposerAttachmentScopeKeyForE2E(scopeKey: string): void {
  if (window.__zcodeComposerAttachmentUploadStoreE2E) {
    window.__zcodeCurrentComposerAttachmentScopeKeyE2E = scopeKey;
  }
}

export function readComposerAttachmentScope(scopeKey: string): ComposerAttachmentUploadItem[] {
  return useComposerAttachmentUploadStore.getState().scopes[scopeKey] ?? [];
}

export function updateComposerAttachmentScope(
  scopeKey: string,
  update: (current: ComposerAttachmentUploadItem[]) => ComposerAttachmentUploadItem[],
): void {
  useComposerAttachmentUploadStore.setState((state) => {
    const next = update(state.scopes[scopeKey] ?? []);
    if (next.length === 0) {
      const { [scopeKey]: _removed, ...remainingScopes } = state.scopes;
      return { scopes: remainingScopes };
    }
    return {
      scopes: {
        ...state.scopes,
        [scopeKey]: next,
      },
    };
  });
}
