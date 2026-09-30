import type { IFileService } from "@zcode/services";
import { WORKSPACE_FILE_ENTRIES_CHUNK_SIZE } from "@zcode/shared/workspaceFileEntriesCodec";

/**
 * Fetches the columnar packed strings of the workspace file index in chunks. Reassembling one large
 * RPC message (65MB) frame by frame at the renderer receiver is a 4.6-6.3s main-thread long task
 * that freezes input; with chunking (~4MB per chunk) plus a setTimeout(0) between chunks to yield
 * the event loop, the main thread handles only a small chunk at a time (~50ms), so key events can
 * always cut in. The total elapsed time is unchanged, but the UI never freezes.
 */
export async function fetchWorkspaceFileEntriesPacked(
  fileService: Pick<IFileService, "listWorkspaceFilesLength" | "listWorkspaceFilesRange">,
  rootPath: string,
): Promise<string> {
  const totalLength = await fileService.listWorkspaceFilesLength({ rootPath });
  let packed = "";
  for (let offset = 0; offset < totalLength; offset += WORKSPACE_FILE_ENTRIES_CHUNK_SIZE) {
    const chunk = await fileService.listWorkspaceFilesRange({
      rootPath,
      offset,
      length: WORKSPACE_FILE_ENTRIES_CHUNK_SIZE,
    });
    packed += chunk;
    // Yield between blocks: Release queued input/rendering tasks before processing the next block.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return packed;
}
