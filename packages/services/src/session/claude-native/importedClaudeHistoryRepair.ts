import { readFile } from "node:fs/promises";
import type {
  ZCodeAgentMcpServer,
  ZCodeSessionImportHistory,
  ZCodeSessionImportMessage,
  ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import {
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "#src/paths.js";
import { buildImportedClaudeTaskId } from "#src/session/claude-native/buildImportedClaudeTaskFile.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { parseClaudeNativeSessionFile } from "#src/session/claude-native/claudeNativeSessionImportParser.js";
import { safeParseLegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";

interface ImportedClaudeHistoryRepairTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

interface ImportedClaudeHistoryRepairResult {
  traceId?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ZCodeSessionImportMessage[];
  source: "legacySnapshot" | "nativeJsonl";
}

interface ImportedClaudeSessionRepairTarget extends ImportedClaudeHistoryRepairTarget {
  mcpServers?: ZCodeAgentMcpServer[];
}

interface ImportedClaudeSessionRepairCreateParams {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  mode: ZCodeSessionStateSnapshot["session"]["mode"];
  model: ZCodeSessionStateSnapshot["settings"]["model"]["current"];
  thoughtLevel?: string;
  persistence: "immediate";
  mcpServers?: ZCodeAgentMcpServer[];
  importedHistory: ZCodeSessionImportHistory;
}

function toImportMessages(
  messages: readonly { role: string; content: string; timestamp?: number }[],
): ZCodeSessionImportMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
      timestamp: message.timestamp,
    }));
}

function countAssistantMessages(messages: readonly ZCodeSessionImportMessage[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

function shouldRepairImportedClaudeSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "runtime" | "session">,
): boolean {
  if (snapshot.session.status === "running" || snapshot.runtime.activeTurnId) {
    return false;
  }
  const hasLegacyFixedMessageIds = snapshot.messages.some((message) =>
    /^msg_import_\d+$/u.test(message.info.messageId),
  );
  if (!snapshot.session.sessionId.startsWith("claude-import-") && !hasLegacyFixedMessageIds) {
    // user-only / assistant-first are just abnormal forms and are not equal to Claude import.
    // Only stable import taskId or legacy global msg_import_* contamination can prove that it falls within the migration-fix boundary,
    // Prevent ordinary ZCode sessions from being accidentally backfilled into Claude history by legacy backups with the same name.
    return false;
  }
  const hasAssistant = snapshot.messages.some((message) => message.info.role === "assistant");
  if (!hasAssistant) {
    return true;
  }
  if (snapshot.messages[0]?.info.role === "assistant") {
    return true;
  }
  // The old protocol import writes all Claude sessions as msg_import_0/msg_import_1.
  // These IDs are global primary keys. Subsequent imports will bind the messages of the previous session to the new session.
  // Even if there is an assistant in the current snapshot, it must be backfilled according to the original Claude jsonl, and the string session and reverse order must be corrected.
  return hasLegacyFixedMessageIds;
}

export async function readLegacyImportedClaudeHistory(
  target: ImportedClaudeHistoryRepairTarget,
): Promise<ImportedClaudeHistoryRepairResult | null> {
  const snapshotPaths = [
    getLegacyTaskSessionSnapshotPath(target.workspacePath, target.taskId, target.workspaceIdentity),
    getLegacyDeletedTaskSessionSnapshotPath(
      target.workspacePath,
      target.taskId,
      target.workspaceIdentity,
    ),
  ];
  let raw: string | undefined;
  for (const path of snapshotPaths) {
    try {
      raw = await readFile(path, "utf-8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (raw === undefined) return null;

  const parsed = safeParseLegacyTaskSessionFile(JSON.parse(raw) as unknown);
  if (!parsed.success || parsed.data.meta.migrationSource !== "claudeCode") {
    return null;
  }
  const messages = toImportMessages(parsed.data.messages);
  return messages.length > 0
    ? {
        traceId: parsed.data.meta.traceId,
        title: parsed.data.meta.title,
        createdAt: parsed.data.meta.createdAt,
        updatedAt: parsed.data.meta.updatedAt,
        messages,
        source: "legacySnapshot",
      }
    : null;
}

async function readNativeImportedClaudeHistory(
  target: ImportedClaudeHistoryRepairTarget,
): Promise<ImportedClaudeHistoryRepairResult | null> {
  const candidates = await claudeNativeSessionImportRepo.scanImportableSessions({
    workspacePath: target.workspacePath,
  });
  const candidate = candidates.find(
    (item) => buildImportedClaudeTaskId(item.workspacePath, item.sessionId) === target.taskId,
  );
  if (!candidate) {
    return null;
  }

  const importedSource = await parseClaudeNativeSessionFile({
    filePath: candidate.sourcePath,
    workspacePath: candidate.workspacePath,
    sessionId: candidate.sessionId,
    sourcePath: candidate.sourcePath,
    fallbackCreatedAt: candidate.createdAt,
    fallbackUpdatedAt: candidate.updatedAt,
  });
  const messages = toImportMessages(importedSource.messages);
  return messages.length > 0
    ? {
        title: importedSource.title,
        createdAt: importedSource.createdAt,
        updatedAt: importedSource.updatedAt,
        messages,
        source: "nativeJsonl",
      }
    : null;
}

async function resolveImportedClaudeHistoryForRepair(
  target: ImportedClaudeHistoryRepairTarget,
): Promise<ImportedClaudeHistoryRepairResult | null> {
  const legacyHistory = await readLegacyImportedClaudeHistory(target);
  if (legacyHistory && countAssistantMessages(legacyHistory.messages) > 0) {
    return legacyHistory;
  }

  const nativeHistory = await readNativeImportedClaudeHistory(target);
  if (
    nativeHistory &&
    countAssistantMessages(nativeHistory.messages) >=
      countAssistantMessages(legacyHistory?.messages ?? [])
  ) {
    // Older versions may have corrupted user-only legacy backups.
    // At this time, legacy can no longer be used as an authoritative source. You need to reverse check the original Claude jsonl by taskId and rebuild the assistant.
    return nativeHistory;
  }

  return legacyHistory;
}

export async function repairImportedClaudeSessionSnapshot<T>(params: {
  snapshot: ZCodeSessionStateSnapshot;
  target: ImportedClaudeSessionRepairTarget;
  createSession(input: ImportedClaudeSessionRepairCreateParams): Promise<T>;
  onRepair?(history: ImportedClaudeHistoryRepairResult): void;
}): Promise<T | null> {
  if (!shouldRepairImportedClaudeSnapshot(params.snapshot)) {
    return null;
  }
  const history = await resolveImportedClaudeHistoryForRepair(params.target);
  if (!history) {
    return null;
  }

  params.onRepair?.(history);
  // An early import may have created a real ZCode session, but not written Claude history
  // zcode-cli sessionStore, or use global msg_import_* to cause stringed sessions. The sessionId with the same name is used here.
  // Idempotent backfill importedHistory, allowing session/read, task snapshot and remote control recovery paths to follow the same set of repairs.
  return params.createSession({
    workspacePath: params.target.workspacePath,
    workspaceIdentity: params.target.workspaceIdentity,
    sessionId: params.target.taskId,
    mode: params.snapshot.session.mode,
    model: params.snapshot.settings.model.current,
    thoughtLevel: params.snapshot.settings.thoughtLevel.current,
    persistence: "immediate",
    mcpServers: params.target.mcpServers,
    importedHistory: {
      source: "claudeCode",
      title: history.title,
      createdAt: history.createdAt,
      updatedAt: history.updatedAt,
      messages: history.messages,
    },
  });
}
