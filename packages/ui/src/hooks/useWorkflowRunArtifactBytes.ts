import { useEffect, useMemo, useRef, useState } from "react";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Byte reading for content artifacts (`file` / `markdown`).
 *
 * Follows the chunking idiom of `attachmentRead` verbatim: one chunk is ≤ 512 KiB, and a null
 * `nextOffset` means the read is complete. The upper bound on assembling everything in memory is
 * `ARTIFACT_CAPS.maxFileBytes` (= 20 MiB, the same tier as attachments); at that magnitude a single
 * Blob is far simpler than having every viewer do its own range reads — the viewers are all
 * existing leaf components, and what they want is a Blob / ArrayBuffer, not a cursor.
 *
 * ```
 * offset 0 ──read──▶ {dataBase64, mediaType, totalBytes, nextOffset}
 *        ◀──────────  decode into a Uint8Array and push it into chunks[]
 *   nextOffset ──read──▶ …  until null
 *        ▼
 *   concatenate into one Uint8Array ─▶ Blob ─▶ objectUrl (revoked on unmount / version change)
 * ```
 */

/**
 * The number of bytes in one chunk. It reuses the same constant as attachments instead of minting a
 * separate one — that is the bound on the gateway side.
 */
const CHUNK_BYTES = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;

/**
 * The maximum number of chunks read for one artifact. 20 MiB / 512 KiB = 40 chunks, with a
 * factor-of-two headroom serving as an infinite-loop brake: an implementation that refuses to
 * converge `nextOffset` to null must not be allowed to lock up the render thread.
 */
const MAX_CHUNKS = 96;

interface WorkflowRunArtifactBytesState {
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  /**
   * The object URL of the Blob, used by `<img src>` / PdfViewer. Automatically revoked on unmount
   * and on version change.
   */
  objectUrl: string | null;
  /**
   * The contentType on the journal record (not the one the store re-sniffs) — the exact-match
   * contract for renderer dispatch.
   */
  mediaType: string | null;
  totalBytes: number | null;
  loading: boolean;
  error: string | null;
}

function emptyState(): WorkflowRunArtifactBytesState {
  return {
    bytes: null,
    blob: null,
    objectUrl: null,
    mediaType: null,
    totalBytes: null,
    loading: false,
    error: null,
  };
}

/**
 * base64 → bytes. `atob` is always present in the renderer (Electron and the browser are both
 * Chromium).
 */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * bytes → base64. The office viewer only accepts `FileBinaryPreview.dataBase64`, so this return
 * path is necessary.
 *
 * Chunked (8 KiB) rather than `String.fromCharCode(...bytes)`: the latter blows up on 20 MiB with
 * "Maximum call stack size exceeded" — it spreads into 20 million arguments.
 */
export function encodeBytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  const step = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export function useWorkflowRunArtifactBytes(options: {
  sessionId: string;
  runId: string;
  artifactId: string;
  version: number;
  /**
   * When off, nothing is read and no object URL is left behind (preset boards and the collapsed
   * state both rely on it to skip the whole chain).
   */
  enabled?: boolean;
}): WorkflowRunArtifactBytesState {
  const { workflowRunArtifactRead } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactBytesState>(emptyState);
  // Issued object URLs: must be revoked on unmount and on version change, or every version flip leaks another 20 MiB.
  const objectUrlRef = useRef<string | null>(null);

  const { artifactId, runId, sessionId, version } = options;
  const enabled =
    options.enabled !== false &&
    sessionId.length > 0 &&
    runId.length > 0 &&
    artifactId.length > 0 &&
    version > 0;

  useEffect(() => {
    const revokePrevious = () => {
      if (objectUrlRef.current !== null) {
        if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = null;
      }
    };
    revokePrevious();
    setState(emptyState());
    if (!enabled) return;

    let alive = true;
    setState((current) => ({ ...current, loading: true }));
    void (async () => {
      try {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let offset = 0;
        let mediaType = "application/octet-stream";
        let totalBytes = 0;
        for (let index = 0; index < MAX_CHUNKS; index += 1) {
          const result = await workflowRunArtifactRead({
            sessionId,
            runId,
            artifactId,
            version,
            offset,
            limit: CHUNK_BYTES,
          });
          if (!alive) return;
          mediaType = result.mediaType;
          totalBytes = result.totalBytes;
          chunks.push(decodeBase64(result.dataBase64));
          if (result.nextOffset === null) break;
          offset = result.nextOffset;
        }
        if (!alive) return;
        const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(size);
        let cursor = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, cursor);
          cursor += chunk.length;
        }
        const blob = new Blob([bytes], { type: mediaType });
        // jsdom has no createObjectURL: not getting a URL is not an error, it just means the `<img>` path is unavailable;
        // the Blob / bytes paths still work (that is what the PdfViewer and office viewers read).
        const objectUrl =
          typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(blob)
            : null;
        objectUrlRef.current = objectUrl;
        setState({
          bytes,
          blob,
          objectUrl,
          mediaType,
          totalBytes,
          loading: false,
          error: null,
        });
      } catch (caught) {
        if (!alive) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[workflow-artifacts] failed to read artifact bytes", {
          artifactId,
          error: message,
          runId,
          sessionId,
          version,
        });
        setState({ ...emptyState(), error: message });
      }
    })();

    return () => {
      alive = false;
      revokePrevious();
    };
  }, [artifactId, enabled, runId, sessionId, version, workflowRunArtifactRead]);

  return useMemo(() => state, [state]);
}
