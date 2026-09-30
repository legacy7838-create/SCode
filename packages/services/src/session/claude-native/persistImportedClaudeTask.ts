import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath } from "#src/paths.js";
import {
  parseLegacyTaskSessionFile,
  type LegacyTaskSessionFile,
} from "#src/session/legacyTaskSessionFile.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

export function buildSearchableTextFromMessages(messages: ZCodeSessionFile["messages"]): string {
  const parts: string[] = [];
  let total = 0;
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    const next = total > 0 ? `\n${content}` : content;
    if (total + next.length > TASK_SEARCH_TEXT_MAX_CHARS) {
      parts.push(next.slice(0, TASK_SEARCH_TEXT_MAX_CHARS - total));
      break;
    }
    parts.push(next);
    total += next.length;
  }
  return parts.join("");
}

async function writeSessionFileAtomic(
  filePath: string,
  sessionFile: LegacyTaskSessionFile,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  const serialized = JSON.stringify(sessionFile, null, 2);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${serialized}\n`, "utf-8");
  await rename(tempPath, filePath);
}

export async function persistImportedClaudeTask(params: {
  taskIndexRepo: TaskIndexRepo;
  sessionFile: LegacyTaskSessionFile;
  /** Only write when the import target workspace is consistent with the filtered workspace to avoid copying the identity of the current tab to other paths. */
  workspaceIdentity?: string;
}): Promise<ZCodeTaskMeta> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const meta: LegacyTaskSessionFile["meta"] = {
    ...parsed.meta,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  };
  const indexMeta: ZCodeTaskMeta = {
    ...meta,
    // The mode column of the SQLite task index is still NOT NULL; the imported snapshot itself maintains the filtered default.
    mode: meta.mode ?? "build",
  };

  await writeImportedClaudeTaskSnapshot({ sessionFile: { ...parsed, meta } });
  return params.taskIndexRepo.syncTaskMeta({
    meta: indexMeta,
    // When a user deletes/archives an imported session and then imports it again, the old index rows remain archived/deleted.
    // The reimport semantics is to restore this session to the list, so the hidden state is explicitly unhidden here.
    archived: false,
    deleted: false,
    searchableText: buildSearchableTextFromMessages(parsed.messages),
  });
}

export async function writeImportedClaudeTaskSnapshot(params: {
  sessionFile: LegacyTaskSessionFile;
}): Promise<void> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const filePath = getLegacyTaskSessionSnapshotPath(
    parsed.meta.workspacePath,
    parsed.meta.taskId,
    parsed.meta.workspaceIdentity,
  );

  // After legacy ACP goes offline, importClaudeSessions becomes empty. Although jsonl is copied in the import, it is not written.
  // ~/.zcode/v2/sessions/{hash}/{taskId}.json. Now the real ZCode session is responsible for continuing the conversation and legacy snapshot
  // Only save filtered migration backups to prevent Claude's source running state from contaminating the current model selection.
  await writeSessionFileAtomic(filePath, parsed);
}
