import type { ZCodePersistedMessage, ZCodeTaskPersistStatus } from "@zcode/shared";

/** Import source identity: an external native CLI (Claude Code), unrelated to the agent runtime's ZCodeProvider. */
export type ClaudeNativeImportSourceProvider = "claude";

export interface ClaudeNativeImportedSessionSource {
  provider: ClaudeNativeImportSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  status?: ZCodeTaskPersistStatus;
  migrationSource?: "claudeCode";
  messages: ZCodePersistedMessage[];
}
