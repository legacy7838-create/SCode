import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "#src/memory/memory.js";

const PROJECT_MEMORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export async function readProjectMemoryFileFromStableHandle(params: {
  fileName: string;
  filePath: string;
  validatePath: () => Promise<void>;
}): Promise<{ content: string; updatedAt: number }> {
  const preOpenStat = await lstat(params.filePath, { bigint: true });
  if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${params.filePath}`);
  }

  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  // After path checking, readFile(path) will re-parse the path and may follow the link of concurrent replacement to read the external file.
  // Read-only handles are not locked and do not acquire ownership; atomic updates to Memory can continue to rename, and the text is always read from the verified handle.
  const handle = await open(params.filePath, constants.O_RDONLY | noFollowFlag);
  try {
    const openedStat = await handle.stat({ bigint: true });
    await params.validatePath();
    const postOpenStat = await lstat(params.filePath, { bigint: true });
    if (
      !openedStat.isFile() ||
      !postOpenStat.isFile() ||
      postOpenStat.isSymbolicLink() ||
      !isSameFileSnapshot(openedStat, preOpenStat) ||
      !isSameFileSnapshot(openedStat, postOpenStat)
    ) {
      throwFileChangedError(params.fileName);
    }

    if (openedStat.size > BigInt(PROJECT_MEMORY_PREVIEW_MAX_BYTES)) {
      throwPreviewLimitError(params.fileName);
    }

    const content = await readBoundedFile(handle, PROJECT_MEMORY_PREVIEW_MAX_BYTES + 1);
    const finalStat = await handle.stat({ bigint: true });
    // When atomic rename fails, writing will degenerate into in-place overwriting of the same inode. Only reading the file identity cannot identify content changes.
    if (!isSameFileSnapshot(openedStat, finalStat)) {
      throwFileChangedError(params.fileName);
    }
    if (
      content.length > PROJECT_MEMORY_PREVIEW_MAX_BYTES ||
      finalStat.size > BigInt(PROJECT_MEMORY_PREVIEW_MAX_BYTES)
    ) {
      throwPreviewLimitError(params.fileName);
    }
    return {
      content: content.toString("utf-8"),
      updatedAt: Number(finalStat.mtimeNs) / 1_000_000,
    };
  } finally {
    await handle.close();
  }
}

function isSameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedFile(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function throwPreviewLimitError(fileName: string): never {
  throw Object.assign(
    new Error(`Project Memory file exceeds the 5 MiB preview limit: ${fileName}`),
    { code: PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE },
  );
}

function throwFileChangedError(fileName: string): never {
  throw Object.assign(new Error(`Project Memory file changed during preview: ${fileName}`), {
    code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  });
}
