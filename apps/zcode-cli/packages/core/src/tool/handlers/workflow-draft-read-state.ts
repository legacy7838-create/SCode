// ============================================================
// Inline drafts are recorded as "documents written by the model"
// ============================================================
// Edit / Write rejects files that the session has not read (FILE_NOT_READ): the model cannot change bytes it has not seen. Inline draft happens to be
// This created file - its bytes are the `script` input parameters of the call that generated it. Don't remember this amount, NOTE requires it.
// The first `Edit` will inevitably fail. The remedy is to `Read` the entire 20,000 token script just written by the model itself, which is exactly the draft file.
// That expense to be saved.
//
// **Only called by inline branches**: saved copy (with metadata blocks not seen by the model), new draft that inherits the predecessor script (the script may
// The drafts written from other sessions or before compression), hub direct launch and GUI settings revision are not the bytes written by the model this time.
// Remembering it is to guarantee the model the content it has not seen.
//
// Just like the draft itself, **do your best**: if the stat is not reached, it will not be remembered. The first edit of the model will fall back to the old way of "read first".

import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../types.js";

export type WorkflowDraftAuthoringTool = "CreateWorkflow" | "AmendWorkflow";

const CRLF_PATTERN = /\r\n/gu;
const LF = "\n";

export async function recordAuthoredWorkflowDraft(
  context: ToolExecutionContext,
  draft: { path: string; source: string; toolName: WorkflowDraftAuthoringTool },
): Promise<void> {
  const { fileSystemPort, readFileState } = context;
  if (readFileState === undefined || fileSystemPort === undefined) return;

  let revision: { id: string; mtimeMs?: number; sizeBytes?: number } | undefined;
  try {
    // The stale verification after Edit/Write reads the same port, so the caliber of revision is the same. stat happens after writing:
    // The noted mtime is no earlier than the draft's real mtime, and any subsequent external changes will advance the mtime and become stale.
    const info = await fileSystemPort.stat(
      { path: draft.path, trace: context.traceContext },
      { signal: context.abortSignal },
    );
    revision = info.revision;
  } catch {
    return;
  }
  if (revision === undefined) return;

  const entry: ReadFileStateEntry = {
    path: draft.path,
    // The text read back by the port is unified into LF (FileSystemReadTextResult.content), and the snapshot follows the same caliber.
    content: draft.source.replace(CRLF_PATTERN, LF),
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: draft.toolName,
    revisionId: revision.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision.mtimeMs),
    sizeBytes: revision.sizeBytes ?? Buffer.byteLength(draft.source, "utf8"),
  };
  readFileState.set(createReadFileStateKey(draft.path, 1, undefined), entry);

  // resume only restores read-state (read-file-state-hydrator.ts) from tool part metadata, and does not fall into this category.
  // After the session is restored the same bug comes back unchanged.
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry.readAt,
    entry,
    toolName: draft.toolName,
  });
  if (metadata !== undefined) context.recordReadFileStateMetadata?.(metadata);
}
