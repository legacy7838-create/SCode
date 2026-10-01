import { randomUUID } from "node:crypto";
import type {
  CollaborationMode,
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  CreateScriptWorkflowActivityInput,
  CreateScriptWorkflowRunInput,
  CreateSessionTaskLinkInput,
  CreateSessionInput,
  FileDiff,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  GoalStatus,
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  ListSessionsInput,
  AppUsageModelRow,
  AppUsageQueryInput,
  AppUsageQueryResult,
  AppUsageToolRow,
  LocalSettingStorePort,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  ModelUsageRecord,
  PartId,
  PermissionRuleset,
  ProjectId,
  SessionEntryInfo,
  SessionEntryType,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  ScriptWorkflowStorePort,
  SessionGoal,
  SessionId,
  SessionInfo,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionTaskLinkRecord,
  SessionRevert,
  SessionStorePort,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  TodoItem,
  ToolUsageRecord,
  TurnUsageRecord,
  UpsertScriptWorkflowDefinitionInput,
  UpdateSessionInput,
  UpdateScriptWorkflowActivityInput,
  UpdateScriptWorkflowRunInput,
  TurnInputIntentMetadata,
  UsageStorePort,
} from "@zcode/contracts";
import { SESSION_ENTRY_MODEL_SELECTION } from "@zcode/contracts";
// The port remains in the domain package @zcode/dynamic-workflow, where only type references are made: adapters do not depend on it at runtime.
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type { EventsScopeExec } from "@zcode/rust/events";
import { createEventsClient, type EventsClient } from "@zcode/rust/events";
import { SqliteSessionMigrationError } from "./errors.js";
import {
  DEFAULT_SQLITE_MIGRATION_WAIT_MS,
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrationsAsync,
  type AsyncSqliteMigrationOptions,
} from "./migration-runner.js";
import type { ForkCommitFaultStage, SqliteSessionStoreOptions } from "./options.js";
import { ensureParentDir, getDefaultSessionDbPath } from "./paths.js";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import { createDwfJournalStore, type SqliteDwfJournalStore } from "./repositories/dwf-journal.js";
import {
  decodeActivity,
  decodeDefinition,
  decodeEvent,
  decodeRun,
  decodeTaskLink,
  type WorkflowActivityRow,
  type WorkflowDefinitionRow,
  type WorkflowEventRow,
  type WorkflowRunRow,
  type SessionTaskLinkRow,
} from "./repositories/script-workflow-codecs.js";
import {
  decodeMessageRow,
  decodePartRow,
  decodeSessionEntryRow,
  decodeSessionRow,
  decodeTodoRow,
  isCollaborationMode,
  partCreatedAt,
} from "./codecs.js";
import { decodeJson, encodeJson } from "./json.js";
import type {
  InputHistoryRow,
  LocalSettingRow,
  MessageRow,
  PartRow,
  PermissionRow,
  SessionEntryRow,
  SessionRow,
  TodoRow,
} from "./rows.js";

function forkChildSessionId(entry: SessionEntryInfo): SessionId | null {
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return null;
  const ack = (entry.data as Record<string, unknown>).ack;
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) return null;
  const result = (ack as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const sessionId = (result as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? (sessionId as SessionId) : null;
}

function assertForkBundleChildLocal(bundle: ForkCommitBundle): void {
  const childId = String(bundle.child.id);
  const commandResult = bundle.commandFact.ack.result as unknown;
  const result =
    commandResult && typeof commandResult === "object" && !Array.isArray(commandResult)
      ? (commandResult as Record<string, unknown>)
      : null;
  const sessionId = typeof result?.sessionId === "string" ? result.sessionId.trim() : "";
  const isForkResult =
    result?.type === "forkAssistant" ||
    result?.type === "createSelectionSideSession" ||
    (result?.type === "editUserQuery" && result.disposition === "fork");
  if (!isForkResult || !sessionId || sessionId !== childId) {
    // Missing or non-forked command results leave the idempotent fact that cannot be replayed to the child.
    throw new Error("Fork bundle command result is missing, invalid, or not child-local");
  }
  const messageIds = new Set(bundle.messages.map((message) => String(message.info.id)));
  const assertMessage = (value: unknown, field: string) => {
    if (typeof value === "string" && !messageIds.has(value)) {
      throw new Error(`Fork bundle ${field} is not child-local: ${value}`);
    }
  };
  const targetIds = new Set<string>();
  if (bundle.goal) targetIds.add(bundle.goal.source.targetID);
  for (const message of bundle.messages) {
    if (String(message.info.sessionID) !== childId) {
      throw new Error("Fork bundle message session is not child-local");
    }
    if (message.info.role === "assistant" && !messageIds.has(String(message.info.parentID))) {
      throw new Error("Fork bundle assistant parent is not child-local");
    }
    const anchor = message.info.anchor;
    for (const id of anchor?.orderedMessageIds ?? []) {
      assertMessage(id, "anchor orderedMessageId");
    }
    assertMessage(anchor?.boundaryMessageId, "anchor boundaryMessageId");
    if (anchor?.goalBoundary?.kind === "snapshot") {
      if (String(anchor.goalBoundary.target.sessionID) !== childId) {
        throw new Error("Fork bundle anchor goal session is not child-local");
      }
      targetIds.add(anchor.goalBoundary.target.targetID);
    }
    for (const part of message.parts) {
      if (
        String(part.sessionID) !== childId ||
        String(part.messageID) !== String(message.info.id)
      ) {
        throw new Error("Fork bundle part owner is not child-local");
      }
      if (part.type === "timeline") {
        assertMessage(part.anchorMessageId, "timeline anchorMessageId");
        if (part.timelineType === "context_compaction") {
          assertMessage(part.summaryMessageId, "timeline summaryMessageId");
        }
        if (part.timelineType === "goal_verification") targetIds.add(part.targetId);
      }
      if (part.type === "compaction") {
        assertMessage(part.tail_start_id, "compaction tail_start_id");
        assertMessage(part.summaryMessageId, "compaction summaryMessageId");
        const boundary = part.compactBoundary;
        assertMessage(boundary?.lastSummarizedMessageId, "compact lastSummarizedMessageId");
        for (const id of boundary?.summaryMessageIds ?? []) {
          assertMessage(id, "compact summaryMessageId");
        }
        for (const id of boundary?.attachmentMessageIds ?? []) {
          assertMessage(id, "compact attachmentMessageId");
        }
        for (const id of boundary?.hookResultMessageIds ?? []) {
          assertMessage(id, "compact hookResultMessageId");
        }
        assertMessage(boundary?.preservedSegment?.headMessageId, "compact preserved head");
        assertMessage(boundary?.preservedSegment?.anchorMessageId, "compact preserved anchor");
        assertMessage(boundary?.preservedSegment?.tailMessageId, "compact preserved tail");
      }
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of part.state.attachments ?? []) {
          if (
            String(attachment.sessionID) !== childId ||
            String(attachment.messageID) !== String(message.info.id)
          ) {
            throw new Error("Fork bundle tool attachment owner is not child-local");
          }
        }
      }
    }
  }
  if (bundle.goal && String(bundle.goal.source.sessionID) !== childId) {
    throw new Error("Fork bundle goal session is not child-local");
  }
  for (const entry of bundle.entries) {
    if (String(entry.sessionID) !== childId) {
      throw new Error("Fork bundle verifier entry is not child-local");
    }
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : {};
    const payload =
      data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : {};
    assertMessage(payload.anchorAssistantMessageId, "verifier assistant anchor");
    if (typeof payload.targetId === "string" && !targetIds.has(payload.targetId)) {
      throw new Error("Fork bundle verifier target is not child-local");
    }
  }
}

// ── Legacy shaping helpers moved from the deleted repositories (§5.2: shape →
// client op → decode with unchanged codecs). ────────────────────────────────

/** `messages.ts:40-104` shaping: user.model projection + freeze timestamps. */
function shapeSaveMessage(
  input: MessageInfo,
  copyFrom: Parameters<SessionStorePort["saveMessage"]>[1],
  nowMs: number,
): string {
  const { id, sessionID, ...data } = input;
  // Freeze legacy protocol mappers that read user.model unconditionally; missing the entire object will also prevent the body from being opened.
  // Only required objects are complemented; the original model of the old row is still retained by conflicting update/copy logic and is not used by new versions of Reader.
  const storedData =
    input.role === "user"
      ? {
          ...data,
          model: input.modelSelection
            ? {
                providerID: input.modelSelection.providerId,
                modelID: input.modelSelection.modelId,
                ...(input.modelSelection.options?.reasoningLevel
                  ? { variant: input.modelSelection.options.reasoningLevel }
                  : {}),
              }
            : {},
        }
      : data;
  const timeCreated = input.time.created;
  const timeUpdated =
    input.role === "assistant" ? (input.time.completed ?? nowMs) : timeCreated;
  return JSON.stringify({
    id,
    sessionID,
    timeCreated,
    timeUpdated,
    dataJson: JSON.stringify(storedData),
    copyFrom: copyFrom ?? null,
  });
}

/** `messages.ts:113-190` shaping: timeline/subtask projections + partCreatedAt. */
function shapeSavePart(
  input: MessagePart,
  copyFrom: Parameters<SessionStorePort["savePart"]>[1],
  nowMs: number,
): string {
  const { id, sessionID, messageID, ...data } = input;
  let storedData: Record<string, unknown> = data;
  if (input.type === "timeline" && input.timelineType === "model_change") {
    const { fromModel, toModel, ...part } = data as typeof input;
    // Freeze legacy Reader from accessing toModel.providerID directly; only do minimal compatible writes to this one required object.
    const oldToModel = toModel
      ? {
          providerID: toModel.providerId,
          modelID: toModel.modelId,
          ...(toModel.options?.reasoningLevel ? { variant: toModel.options.reasoningLevel } : {}),
          label: toModel.label,
        }
      : {};
    storedData = {
      ...part,
      toModel: oldToModel,
      fromModelSelection: fromModel,
      toModelSelection: toModel,
    };
  } else if (input.type === "subtask") {
    const { model, ...part } = data as typeof input;
    storedData = { ...part, modelSelection: model };
  }
  return JSON.stringify({
    id,
    sessionID,
    messageID,
    timeCreated: partCreatedAt(input, nowMs),
    timeUpdated: nowMs,
    dataJson: JSON.stringify(storedData),
    copyFrom: copyFrom ?? null,
  });
}

/** `session-entries.ts:17-45` shaping incl. the model-selection wrap. */
function shapeSaveSessionEntry(input: SessionEntryInfo): string {
  const isModelSelection = input.type === SESSION_ENTRY_MODEL_SELECTION;
  const encoded = encodeJson(
    isModelSelection ? { modelSelection: input.data ?? null } : input.data,
  );
  if (!encoded) {
    throw new Error("Session entry data must be JSON-serializable");
  }
  return JSON.stringify({
    id: input.id,
    sessionID: input.sessionID,
    type: input.type,
    timeCreated: input.time.created,
    timeUpdated: input.time.updated,
    dataJson: encoded,
    isModelSelection,
    touchSession: input.touchSession !== false,
    touchTime: input.time.updated,
  });
}

function decodeSessionEntriesRaw(raw: string): SessionEntryInfo[] {
  const rows = JSON.parse(raw) as SessionEntryRow[];
  return rows.map(decodeSessionEntryRow);
}

/** Legacy `messages()` grouping (`messages.ts:247-259`) over `[messageRows, partRows]`. */
function decodeMessagesRaw(raw: string): MessageWithParts[] {
  const [messageRows, partRows] = JSON.parse(raw) as [MessageRow[], PartRow[]];
  const partsByMessage = new Map<string, MessagePart[]>();
  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }
  return messageRows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}

/** `sessions.ts:329-335` (verbatim filtering). */
function normalizeSessionTaskTypes(taskTypes: readonly string[] | undefined): string[] {
  if (!taskTypes || taskTypes.length === 0) return [];
  const valid = new Set<string>([
    "interactive",
    "fork",
    "selection_side_chat",
    "workflow_parent",
    "workflow_child",
    "subagent_child",
    "nested_workflow_child",
  ]);
  return [...new Set(taskTypes.filter((taskType) => valid.has(taskType)))];
}

// ── session_input row decode (session-inputs.ts:267-300, kept verbatim) ────

interface SessionInputRow {
  id: string;
  session_id: string;
  kind: string;
  delivery: string;
  payload: string;
  admitted_sequence: number;
  promoted_sequence: number | null;
  promoted_message_id: string | null;
  status: string;
  status_reason: string | null;
  time_created: number;
  time_updated: number;
}

function decodePayload(raw: string): { text: string; [key: string]: unknown } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? ({ text: "", ...(parsed as Record<string, unknown>) } as {
          text: string;
          [key: string]: unknown;
        })
      : { text: "" };
  } catch {
    return { text: "" };
  }
}

interface SessionInputPatch {
  delivery?: SessionInputDelivery;
  id: string;
  intent?: TurnInputIntentMetadata;
  text?: string;
  queuePosition?: number;
}

function patchObject(value: unknown, patch: SessionInputPatch): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const current = value as Record<string, unknown>;
  const order = current.order;
  const intent = patch.intent;
  return {
    ...current,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.queuePosition !== undefined || intent?.queuePosition !== undefined
      ? {
          order:
            order && typeof order === "object" && !Array.isArray(order)
              ? {
                  ...(order as Record<string, unknown>),
                  queuePosition: patch.queuePosition ?? intent?.queuePosition,
                }
              : { queuePosition: patch.queuePosition ?? intent?.queuePosition },
        }
      : {}),
    ...(intent
      ? {
          delivery: {
            requested: intent.requestedDelivery,
            admitted: intent.admittedDelivery,
            ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
          },
          steer: intent.fallbackReasonCode
            ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
            : current.steer,
        }
      : {}),
  };
}

function decodeSessionInputRow(row: SessionInputRow): SessionInputRecord {
  const payload = decodePayload(row.payload);
  return {
    id: row.id,
    sessionID: row.session_id as SessionId,
    kind: row.kind,
    delivery:
      row.delivery === "startNow" || row.delivery === "guide" || row.delivery === "queue"
        ? row.delivery
        : "queue",
    payload,
    admittedSequence: row.admitted_sequence,
    ...(row.promoted_sequence !== null ? { promotedSequence: row.promoted_sequence } : {}),
    ...(row.promoted_message_id !== null
      ? { promotedMessageID: row.promoted_message_id as SessionInputRecord["promotedMessageID"] }
      : {}),
    status: (["admitted", "promoted", "cancelled", "discarded", "failed"].includes(row.status)
      ? row.status
      : "admitted") as SessionInputStatus,
    ...(row.status_reason !== null ? { statusReason: row.status_reason } : {}),
    time: { created: row.time_created, updated: row.time_updated },
  };
}

// ── target row decode (session-target.ts:410-429, kept verbatim) ───────────

interface TargetRow {
  session_id: string;
  target_id: string;
  objective: string;
  summary_title: string | null;
  status: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  active_input_id: string | null;
  active_run_started_at: number | null;
  active_run_last_seen_at: number | null;
  time_created: number;
  time_updated: number;
}

function decodeTargetRow(row: TargetRow): SessionGoal {
  return {
    sessionID: row.session_id as SessionId,
    targetID: row.target_id,
    objective: row.objective,
    summaryTitle: row.summary_title,
    status: row.status as GoalStatus,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    activeInputId: row.active_input_id,
    activeRunStartedAtMs: row.active_run_started_at,
    activeRunLastSeenAtMs: row.active_run_last_seen_at,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  };
}

function decodeTargetResult(raw: string): SessionGoal | null {
  const rows = JSON.parse(raw) as TargetRow[];
  return rows[0] ? decodeTargetRow(rows[0]) : null;
}

function createStorageTargetId(): string {
  return `target_${Date.now().toString(36)}_${randomUUID()}`;
}

// ── usage shaping helpers (usage.ts:649-745, kept verbatim) ────────────────

const USAGE_RETENTION_DAYS = 30;
const USAGE_RETENTION_MS = USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function integer(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function boolean(value: boolean | undefined): number {
  return value ? 1 : 0;
}

function nullableBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : boolean(value);
}

function inputSideTokensFromNormalizedUsage(
  inputTokens: number | null | undefined,
  cacheCreationTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
): number {
  const input = integer(inputTokens);
  if (input > 0) {
    return input;
  }
  return integer(cacheCreationTokens) + integer(cacheReadTokens);
}

function inputSideTokensFromStoredUsage(row: {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  computedTotalTokens: number;
  inputTokens: number;
  outputTokens: number;
  providerTotalTokens: number | null;
}): number {
  const input = integer(row.inputTokens);
  const cache = integer(row.cacheCreationTokens) + integer(row.cacheReadTokens);
  if (input <= 0) {
    return cache;
  }
  if (cache <= 0) {
    return input;
  }

  const output = integer(row.outputTokens);
  const total = integer(row.providerTotalTokens ?? row.computedTotalTokens);
  if (total > 0) {
    const totalInputDistance = Math.abs(total - (input + output));
    const noCacheInputDistance = Math.abs(total - (input + cache + output));
    if (noCacheInputDistance < totalInputDistance) {
      return input + cache;
    }
  }

  // The inputTokens written by AI SDK v6 are already total input; the cache field in the history table is just breakdown.
  return input;
}

function taskUsageInputBaselineSource(querySource: string): string | undefined {
  if (
    querySource === "main_turn" ||
    querySource === "subagent" ||
    querySource === "workflow_child"
  ) {
    return querySource;
  }
  return undefined;
}

function toolUsageValues(input: ToolUsageRecord): (string | number | null)[] {
  return [
    input.id,
    input.sessionID,
    input.turnID ?? null,
    input.traceID ?? null,
    input.toolCallID,
    input.toolName,
    input.sideEffectScope ?? null,
    nullableBoolean(input.readOnly),
    nullableBoolean(input.destructive),
    input.approvalStatus ?? null,
    input.status,
    input.startedAt,
    input.firstOutputAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstOutputMs ?? null,
    input.exitCode ?? null,
    integer(input.outputBytes),
    integer(input.stdoutBytes),
    integer(input.stderrBytes),
    boolean(input.truncated),
    integer(input.retryCount),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    input.errorType ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
  ];
}

// ── input history shaping (input-history.ts:17-171, kept verbatim) ─────────

function normalizedInputHistoryAttachments(
  attachments: InputHistoryAttachment[] | undefined,
): InputHistoryAttachment[] | undefined {
  const normalized = (attachments ?? [])
    .map((attachment): InputHistoryAttachment | undefined => {
      if (
        attachment.type !== "file" &&
        attachment.type !== "image" &&
        attachment.type !== "pdf" &&
        attachment.type !== "url"
      ) {
        return undefined;
      }
      const path = normalizedOptionalString(attachment.path);
      const content = normalizedAttachmentContent(attachment.content);
      if (!path && !content) return undefined;
      return {
        type: attachment.type,
        ...(path ? { path } : {}),
        ...(content ? { content } : {}),
      };
    })
    .filter((attachment): attachment is InputHistoryAttachment => attachment !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizedOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizedAttachmentContent(value: string | undefined): string | undefined {
  const normalized = normalizedOptionalString(value);
  if (!normalized) return undefined;
  return normalized.startsWith("data:") ? undefined : normalized;
}

function stableInputHistoryAttachments(attachments: InputHistoryAttachment[] | undefined): string {
  return JSON.stringify(normalizedInputHistoryAttachments(attachments) ?? []);
}

function createStorageInputHistoryId(): InputHistoryEntry["id"] {
  return `input_${Date.now().toString(36)}_${randomUUID()}` as InputHistoryEntry["id"];
}

function decodeInputHistoryRow(row: InputHistoryRow): InputHistoryEntry {
  const attachments = normalizedInputHistoryAttachments(
    decodeJson<InputHistoryAttachment[]>(row.attachments),
  );
  return {
    id: row.id as InputHistoryEntry["id"],
    projectID: row.project_id as ProjectId,
    sessionID: row.session_id ? (row.session_id as SessionId) : undefined,
    text: row.text,
    ...(attachments ? { attachments } : {}),
    kind: row.kind as InputHistoryKind,
    time: {
      created: row.time_created,
    },
  };
}

export class SqliteSessionStore
  implements
    SessionStorePort,
    InputHistoryStorePort,
    LocalSettingStorePort,
    ScriptWorkflowStorePort,
    UsageStorePort
{
  private readonly client: EventsClient;
  private readonly dbPath: string;
  private readonly forkCommitFaultAt?: ForkCommitFaultStage;
  private dwfJournalStore?: SqliteDwfJournalStore;

  private constructor(options: SqliteSessionStoreOptions, migrationLockWaitMs: number) {
    this.dbPath = options.dbPath ?? getDefaultSessionDbPath();
    this.forkCommitFaultAt = options.forkCommitFaultAt;
    try {
      ensureParentDir(this.dbPath);
      maybeThrowStorageFsFault({ operation: "sqliteOpen", path: this.dbPath });
    } catch (error) {
      throw new SqliteSessionMigrationError(
        `Failed to open SQLite session database at ${this.dbPath}`,
        { cause: error, dbPath: this.dbPath, kind: "open_failed" },
      );
    }
    // No I/O happens here: the native connection opens lazily on the first task
    // (migrate_step), which surfaces open failures through the migration driver.
    this.client = createEventsClient({
      dbPath: this.dbPath,
      startupLockTimeoutMs:
        options.startupLockTimeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
      migrationLockWaitMs,
      forkCommitFaultAt: options.forkCommitFaultAt,
    });
  }

  static async openStartup(
    options: SqliteSessionStoreOptions = {},
    migrationOptions: AsyncSqliteMigrationOptions = {},
  ): Promise<SqliteSessionStore> {
    // Unmigrated instances only remain within this factory; all Repo/businesses can only get connections after COMMIT.
    const store = new SqliteSessionStore(
      options,
      migrationOptions.lockWaitTimeoutMs ?? DEFAULT_SQLITE_MIGRATION_WAIT_MS,
    );
    try {
      await runSqliteSessionMigrationsAsync(store.client, store.dbPath, migrationOptions);
      return store;
    } catch (error) {
      // close may also fail due to IO; the original cause of the migration is the reason the user should deal with.
      try {
        store.close();
      } catch {
        /* Keep original migration failed. */
      }
      throw error;
    }
  }

  close(): void {
    // Sync by contract (§5.3): releases the dispatcher + native store; the
    // dwf journal runs on its own connection and closes with the store.
    this.client.close();
    if (this.dwfJournalStore) {
      try {
        this.dwfJournalStore.close();
      } catch {
        /* Connection may already be unusable; close stays sync and loud-free. */
      }
      this.dwfJournalStore = undefined;
    }
  }

  private throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }

  private maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void {
    if (this.forkCommitFaultAt === stage) {
      throw new Error(`injected fork commit fault: ${stage}`);
    }
  }

  private async readRows(kind: string, payload: unknown): Promise<string> {
    return this.client.read(kind, JSON.stringify(payload));
  }

  private async writeOp(kind: string, payload: unknown): Promise<string> {
    return this.client.write(kind, JSON.stringify(payload));
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    const raw = await this.writeOp("createSession", { input, nowMs });
    return decodeSessionRow((JSON.parse(raw) as SessionRow[])[0]!);
  }

  async createForkedSessionWithMetadata(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    if (!input.parentID || String(input.parentID) !== metadata.parentSessionId) {
      throw new Error("Fork child metadata parent does not match session parentID");
    }
    const orderedMessageIds = metadata.forkTarget.orderedMessageIds;
    // When compact covers the first round of query, the stable prefix before input is empty; boundaryMessageId is still recorded
    // Edited input, for idempotent facts to be located, but not copied into the child.
    const validBoundary =
      metadata.forkTarget.boundaryMessageId.trim().length > 0 &&
      (orderedMessageIds.length === 0 ||
        orderedMessageIds.at(-1) === metadata.forkTarget.boundaryMessageId);
    if (!metadata.sourceCommandId.trim() || !validBoundary) {
      throw new Error("Fork child metadata is invalid");
    }

    // command key is (parentSessionId, sourceCommandId); session_entry.id is the primary key of the whole database,
    // Parent must be included in the id to avoid overwriting each other when two sessions happen to reuse commandId.
    const entryId = `v4_command_fact:child:${metadata.parentSessionId}:${metadata.sourceCommandId}`;
    // Legacy narrowed `input.parentID` with the throw-guard above inside one
    // function body; capture it so the scope callback keeps the narrowed type.
    const parentID: SessionId = input.parentID;
    const nowMs = Date.now();
    return this.client.scope(async (tx) => {
      const entries = decodeSessionEntriesRaw(
        await tx.exec("sessionEntries", {
          sessionID: parentID,
          type: "v4/command_fact",
        }),
      );
      const existing = entries.find((entry) => entry.id === entryId);
      if (existing) {
        const childSessionId = forkChildSessionId(existing);
        if (!childSessionId) {
          throw new Error(`Fork child command fact is corrupt: ${entryId}`);
        }
        const child = await this.getSessionInScope(tx, childSessionId);
        if (!child) {
          throw new Error(`Fork child session is missing: ${childSessionId}`);
        }
        return child;
      }

      const child = await tx
        .exec("createSession", { input, nowMs })
        .then((raw) => decodeSessionRow((JSON.parse(raw) as SessionRow[])[0]!));
      await tx.exec(
        "saveSessionEntry",
        JSON.parse(
          shapeSaveSessionEntry({
            id: entryId,
            sessionID: parentID,
            type: "v4/command_fact",
            time: { created: nowMs, updated: nowMs },
            data: {
              source: "child",
              ack: {
                commandId: metadata.sourceCommandId,
                status: "accepted",
                revisionAtDecision: 0,
                result: { type: "forkAssistant", sessionId: String(child.id) },
              },
              metadata,
            },
          }),
        ),
      );
      return child;
    });
  }

  private async getSessionInScope(
    tx: EventsScopeExec,
    sessionID: SessionId,
  ): Promise<SessionInfo | null> {
    const rows = JSON.parse(await tx.exec("getSession", { v: [sessionID] })) as SessionRow[];
    return rows[0] ? decodeSessionRow(rows[0]) : null;
  }

  private async saveMessageInScope(
    tx: EventsScopeExec,
    input: MessageInfo,
    copyFrom: Parameters<SessionStorePort["saveMessage"]>[1],
    nowMs: number,
  ): Promise<void> {
    await tx.exec("saveMessage", JSON.parse(shapeSaveMessage(input, copyFrom, nowMs)));
  }

  private async savePartInScope(
    tx: EventsScopeExec,
    input: MessagePart,
    copyFrom: Parameters<SessionStorePort["savePart"]>[1],
    nowMs: number,
  ): Promise<void> {
    await tx.exec("savePart", JSON.parse(shapeSavePart(input, copyFrom, nowMs)));
  }

  async commitForkBundle(bundle: ForkCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { child, commandFact, initialInput } = bundle;
    if (
      !child.parentID ||
      String(child.parentID) !== commandFact.parentSessionId ||
      (initialInput && String(initialInput.sessionID) !== String(child.id)) ||
      commandFact.ack.commandId !== commandFact.sourceCommandId
    ) {
      throw new Error("Fork commit bundle identity is invalid");
    }
    const entryId = `v4_command_fact:child:${commandFact.parentSessionId}:${commandFact.sourceCommandId}`;
    // Identity guard above guarantees child.parentID (legacy narrowed it in the
    // same function body); capture it for the scope callback.
    const childParentID: SessionId = child.parentID;
    const nowMs = Date.now();
    return this.client.scope(async (tx) => {
      const entries = decodeSessionEntriesRaw(
        await tx.exec("sessionEntries", {
          sessionID: child.parentID,
          type: "v4/command_fact",
        }),
      );
      const existing = entries.find((entry) => entry.id === entryId);
      if (existing) {
        const existingChildId = forkChildSessionId(existing);
        const existingChild = existingChildId ? await this.getSessionInScope(tx, existingChildId) : null;
        if (!existingChild) throw new Error(`Fork bundle command fact is corrupt: ${entryId}`);
        return existingChild;
      }

      assertForkBundleChildLocal(bundle);
      const persistedChild = await tx
        .exec("createSession", { input: child, nowMs })
        .then((raw) => decodeSessionRow((JSON.parse(raw) as SessionRow[])[0]!));
      this.maybeThrowForkCommitFault("afterChild");
      for (const message of bundle.messages) {
        const messageSource = bundle.copySources?.messages[message.info.id];
        await this.saveMessageInScope(
          tx,
          message.info,
          messageSource ? { sessionID: childParentID, id: messageSource } : undefined,
          nowMs,
        );
        for (const part of message.parts) {
          const partSource = bundle.copySources?.parts[part.id];
          await this.savePartInScope(
            tx,
            part,
            partSource ? { sessionID: childParentID, id: partSource } : undefined,
            nowMs,
          );
        }
      }
      this.maybeThrowForkCommitFault("afterMessages");
      if (bundle.goal) {
        await tx.exec(
          "cloneTargetForFork",
          JSON.stringify({
            sessionID: child.id,
            targetID: bundle.goal.source.targetID,
            objective: bundle.goal.source.objective,
            summaryTitle: bundle.goal.source.summaryTitle,
            status: bundle.goal.status,
            tokenBudget: bundle.goal.source.tokenBudget,
            tokensUsed: bundle.goal.source.tokensUsed,
            timeUsedSeconds: bundle.goal.source.timeUsedSeconds,
            timeCreated: bundle.goal.source.time.created,
            timeUpdated: bundle.goal.source.time.updated,
            nowMs,
          }),
        );
      }
      this.maybeThrowForkCommitFault("afterGoal");
      for (const entry of bundle.entries) {
        await tx.exec("saveSessionEntry", JSON.parse(shapeSaveSessionEntry(entry)));
      }
      this.maybeThrowForkCommitFault("afterEntries");
      if (initialInput) {
        await tx.exec(
          "saveSessionInput",
          {
            v: [
              initialInput.id,
              initialInput.sessionID,
              initialInput.kind,
              initialInput.delivery,
              encodeJson(initialInput.payload) ?? "{}",
              initialInput.sessionID,
              nowMs,
              nowMs,
            ],
          },
        );
      }
      this.maybeThrowForkCommitFault("afterInput");
      await tx.exec(
        "saveSessionEntry",
        JSON.parse(
          shapeSaveSessionEntry({
            id: entryId,
            sessionID: childParentID,
            type: "v4/command_fact",
            time: { created: nowMs, updated: nowMs },
            data: {
              source: "child",
              ack: commandFact.ack,
              metadata: commandFact.metadata,
            },
          }),
        ),
      );
      this.maybeThrowForkCommitFault("afterCommandFact");
      this.maybeThrowForkCommitFault("beforeCommit");
      return persistedChild;
    });
  }

  async commitSharedContextImportBundle(
    bundle: SharedContextImportCommitBundle,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { session, contextMessage, provenance } = bundle;
    if (
      String(contextMessage.info.sessionID) !== String(session.id) ||
      String(provenance.sessionID) !== String(session.id) ||
      !provenance.id.includes(String(session.id)) ||
      contextMessage.info.role !== "user" ||
      contextMessage.info.visibility !== "model-only" ||
      contextMessage.info.source !== "shared_context"
    ) {
      throw new Error("Shared context import bundle identity is invalid");
    }
    const nowMs = Date.now();
    return this.client.scope(async (tx) => {
      const existing = await this.getSessionInScope(tx, session.id);
      if (existing) {
        const entry = decodeSessionEntriesRaw(
          await tx.exec("sessionEntries", { sessionID: session.id, type: provenance.type }),
        ).find((candidate) => candidate.id === provenance.id);
        if (!entry) throw new Error("Shared context import session is incomplete");
        return existing;
      }
      const persisted = await tx
        .exec("createSession", { input: session, nowMs })
        .then((raw) => decodeSessionRow((JSON.parse(raw) as SessionRow[])[0]!));
      await this.saveMessageInScope(tx, contextMessage.info, undefined, nowMs);
      for (const part of contextMessage.parts) {
        await this.savePartInScope(tx, part, undefined, nowMs);
      }
      await tx.exec("saveSessionEntry", JSON.parse(shapeSaveSessionEntry(provenance)));
      return persisted;
    });
  }

  async transitionSharedContextImport(input: SharedContextImportTransition): Promise<boolean> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    return this.client.scope(async (tx) => {
      const entry = decodeSessionEntriesRaw(
        await tx.exec("sessionEntries", {
          sessionID: input.sessionID,
          type: "v4/shared_context_import",
        }),
      ).find((candidate) => {
        const data = candidate.data;
        return Boolean(
          data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === input.contextId,
        );
      });
      if (!entry) {
        return false;
      }
      const data = entry.data as Record<string, unknown>;
      const expected = Array.isArray(input.expectedStatus)
        ? input.expectedStatus
        : [input.expectedStatus];
      if (!expected.includes(data.status as SharedContextImportTransition["status"])) {
        return false;
      }
      await tx.exec(
        "saveSessionEntry",
        JSON.parse(
          shapeSaveSessionEntry({
            ...entry,
            time: { ...entry.time, updated: nowMs },
            data: {
              ...data,
              status: input.status,
              ...(input.sourceId ? { sourceId: input.sourceId } : {}),
            },
          }),
        ),
      );
      const contextMessage = decodeMessagesRaw(
        await tx.exec("messages", { sessionID: input.sessionID }),
      ).find((message) => {
        const metadata = message.info.metadata;
        return Boolean(
          metadata &&
            typeof metadata === "object" &&
            (metadata as Record<string, unknown>).contextId === input.contextId,
        );
      });
      if (contextMessage) {
        await this.saveMessageInScope(
          tx,
          {
            ...contextMessage.info,
            metadata: {
              ...(contextMessage.info.metadata ?? {}),
              sharedContextStatus: input.status,
            },
          },
          undefined,
          nowMs,
        );
      }
      return true;
    });
  }

  async updateSession(input: UpdateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    const raw = await this.writeOp("updateSession", { input, nowMs });
    return decodeSessionRow((JSON.parse(raw) as SessionRow[])[0]!);
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    const rows = JSON.parse(await this.readRows("getSession", { v: [sessionID] })) as SessionRow[];
    return rows[0] ? decodeSessionRow(rows[0]) : null;
  }

  async listSessions(input: ListSessionsInput = {}): Promise<SessionInfo[]> {
    const taskTypes = normalizeSessionTaskTypes(input.taskTypes);
    const raw = await this.readRows("listSessions", {
      input: { ...input, limit: undefined, ...(taskTypes.length > 0 ? { taskTypes } : {}) },
      limit: input.limit && input.limit > 0 ? input.limit : null,
    });
    return (JSON.parse(raw) as SessionRow[]).map(decodeSessionRow);
  }

  async claimLegacySessionWorkspace(input: ClaimLegacySessionWorkspaceInput): Promise<number> {
    this.throwBeforeWrite();
    const raw = await this.writeOp("claimLegacySessionWorkspace", {
      workspaceID: input.workspaceID,
      directory: input.directory,
      sessionIDs: [...new Set(input.sessionIDs)],
    });
    return Number(JSON.parse(raw));
  }

  async repairLegacyRemoteSessionWorkspace(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    const raw = await this.writeOp("repairLegacyRemoteSessionWorkspace", { v: [
      input.projectID,
      input.workspaceID,
      input.workspacePath,
      input.workspacePath,
      input.sessionID,
      input.legacyWorkspaceDirectory,
      input.legacyWorkspaceDirectory,
    ] });
    return JSON.parse(raw) === true;
  }

  async repairRemoteSessionPaths(input: RepairRemoteSessionPathsInput): Promise<boolean> {
    this.throwBeforeWrite();
    const raw = await this.writeOp("repairRemoteSessionPaths", { v: [
      input.directory,
      input.path,
      input.timeUpdated,
      input.sessionID,
      input.workspaceID,
      input.expectedDirectory,
      input.expectedPath,
      input.expectedPath,
    ] });
    return JSON.parse(raw) === true;
  }

  async setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("setRevert", {
      input: {
        id: input.sessionID,
        revert: input.revert,
        summary: input.summary
          ? {
              additions: input.summary.additions,
              deletions: input.summary.deletions,
              files: input.summary.files,
              diffs: input.summary.diffs,
            }
          : undefined,
      },
      nowMs,
    });
  }

  async clearRevert(sessionID: SessionId): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("clearRevert", {
      input: { id: sessionID, revert: null, summary: null },
      nowMs,
    });
  }

  // ── messages / parts ──────────────────────────────────────────────────────

  async saveMessage(
    input: MessageInfo,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("saveMessage", JSON.parse(shapeSaveMessage(input, copyFrom, nowMs)));
  }

  async removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void> {
    this.throwBeforeWrite();
    await this.writeOp("removeMessage", input);
  }

  async savePart(
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("savePart", JSON.parse(shapeSavePart(input, copyFrom, nowMs)));
  }

  async removePart(input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  }): Promise<void> {
    this.throwBeforeWrite();
    await this.writeOp("removePart", input);
  }

  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null> {
    const raw = await this.readRows("messageWithParts", input);
    const [messageRows, partRows] = JSON.parse(raw) as [MessageRow[], PartRow[]];
    const messageRow = messageRows[0];
    if (!messageRow) return null;
    return {
      info: decodeMessageRow(messageRow),
      parts: partRows.map(decodePartRow),
    };
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    const raw = await this.readRows("messages", input);
    return decodeMessagesRaw(raw);
  }

  // ── session entries ───────────────────────────────────────────────────────

  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    this.throwBeforeWrite();
    await this.writeOp("saveSessionEntry", JSON.parse(shapeSaveSessionEntry(input)));
  }

  async sessionEntries(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]> {
    const raw = await this.readRows("sessionEntries", input);
    return decodeSessionEntriesRaw(raw);
  }

  // ── session_input ledger ──────────────────────────────────────────────────

  async saveSessionInput(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("saveSessionInput", { v: [
      input.id,
      input.sessionID,
      input.kind,
      input.delivery,
      encodeJson(input.payload) ?? "{}",
      input.sessionID,
      nowMs,
      nowMs,
    ] });
  }

  async commitPermissionFullAccess(
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    // Legacy: `signal.throwIfAborted()` at entry, then a fully synchronous
    // transaction — the port re-checks at scope dispatch, never afterwards (§6).
    input.signal?.throwIfAborted();
    if (
      input.execution.sessionID !== input.sessionID ||
      input.receipt.sessionID !== input.sessionID
    ) {
      throw new Error("Permission commit session mismatch");
    }
    const nowMs = Date.now();
    await this.client.scope(
      async (tx) => {
        const receiptRows = JSON.parse(
          await tx.exec("getSessionEntrySessionId", { v: [input.receipt.id] }),
        ) as Array<{ session_id: string }>;
        if (receiptRows[0]) {
          if (receiptRows[0].session_id !== input.sessionID) {
            throw new Error("Permission receipt session mismatch");
          }
          return;
        }
        for (const id of input.queueItemIds) {
          const rows = JSON.parse(
            await tx.exec("getAdmittedSessionInputRow", { v: [id, input.sessionID] }),
          ) as Array<{ delivery: SessionInputDelivery; payload: string }>;
          const row = rows[0];
          if (!row || typeof row.payload !== "string") {
            throw new Error(`Pending input unavailable: ${id}`);
          }
          const payload = JSON.parse(row.payload) as Record<string, unknown>;
          for (const key of ["intent", "conversationInputIntent"]) {
            const intent = payload[key];
            if (intent && typeof intent === "object" && !Array.isArray(intent)) {
              payload[key] = { ...intent, mode: "yolo" };
            }
          }
          await tx.exec("setAdmittedSessionInputRow", {
            v: [JSON.stringify(payload), nowMs, id, input.sessionID],
            setDelivery: false,
          });
        }
        await tx.exec("saveSessionEntry", JSON.parse(shapeSaveSessionEntry(input.execution)));
        await tx.exec("saveSessionEntry", JSON.parse(shapeSaveSessionEntry(input.receipt)));
      },
      () => input.signal?.throwIfAborted(),
    );
  }

  async updateSessionInputs(
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    if (input.updates.length === 0) return;
    const nowMs = Date.now();
    await this.client.scope(async (tx) => {
      for (const update of input.updates) {
        const rows = JSON.parse(
          await tx.exec("getAdmittedSessionInputRow", { v: [update.id, input.sessionID] }),
        ) as Array<{ delivery: SessionInputDelivery; payload: string }>;
        const row = rows[0];
        if (!row) continue;
        const payload = decodePayload(row.payload);
        if (update.text !== undefined) payload.text = update.text;
        if ("conversationInputIntent" in payload) {
          payload.conversationInputIntent = patchObject(payload.conversationInputIntent, update);
        }
        // Compatible with current runtime metadata; the new writing authoritative format is still conversationInputIntent.
        if (update.intent) {
          payload.intent = update.intent;
        } else if ("intent" in payload && update.queuePosition !== undefined) {
          const intent = payload.intent;
          if (intent && typeof intent === "object" && !Array.isArray(intent)) {
            payload.intent = {
              ...(intent as Record<string, unknown>),
              queuePosition: update.queuePosition,
            };
          }
        }
        await tx.exec("setAdmittedSessionInputRow", {
          v: [encodeJson(payload) ?? "{}", nowMs, update.id, input.sessionID],
          setDelivery: true,
          delivery: update.delivery ?? row.delivery,
        });
      }
    });
  }

  async promoteSessionInput(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.client.scope(async (tx) => {
      await this.saveMessageInScope(tx, input.message, undefined, nowMs);
      for (const part of input.parts) {
        await this.savePartInScope(tx, part, undefined, nowMs);
      }
      const refs =
        input.message.metadata && typeof input.message.metadata === "object"
          ? (input.message.metadata as Record<string, unknown>).inputIntent &&
            typeof (input.message.metadata as Record<string, unknown>).inputIntent === "object"
            ? (
                (input.message.metadata as Record<string, unknown>).inputIntent as Record<
                  string,
                  unknown
                >
              ).sharedContextRefs
            : undefined
          : undefined;
      if (Array.isArray(refs)) {
        for (const ref of refs) {
          if (
            !ref ||
            typeof ref !== "object" ||
            (ref as Record<string, unknown>).kind !== "shared_context_import"
          )
            continue;
          const contextId = (ref as Record<string, unknown>).context_id;
          if (typeof contextId !== "string") continue;
          const entry = decodeSessionEntriesRaw(
            await tx.exec("sessionEntries", {
              sessionID: input.sessionID,
              type: "v4/shared_context_import",
            }),
          ).find((candidate) => {
            const data = candidate.data;
            return Boolean(
              data &&
                typeof data === "object" &&
                !Array.isArray(data) &&
                (data as Record<string, unknown>).contextId === contextId,
            );
          });
          if (!entry) throw new Error("shared context import is missing");
          const data = entry.data as Record<string, unknown>;
          if (!["pending", "reserved"].includes(String(data.status))) {
            throw new Error("shared context import is no longer attachable");
          }
          await tx.exec(
            "saveSessionEntry",
            JSON.parse(
              shapeSaveSessionEntry({
                ...entry,
                time: { ...entry.time, updated: nowMs },
                data: { ...data, status: "attached", attachedMessageId: String(input.message.id) },
              }),
            ),
          );
          const contextMessage = decodeMessagesRaw(
            await tx.exec("messages", { sessionID: input.sessionID }),
          ).find((candidate) => {
            const metadata = candidate.info.metadata;
            return Boolean(
              metadata &&
                typeof metadata === "object" &&
                (metadata as Record<string, unknown>).contextId === contextId,
            );
          });
          if (contextMessage) {
            await this.saveMessageInScope(
              tx,
              {
                ...contextMessage.info,
                metadata: {
                  ...(contextMessage.info.metadata ?? {}),
                  sharedContextStatus: "attached",
                },
              },
              undefined,
              nowMs,
            );
          }
        }
      }
      await tx.exec("promoteSessionInputStatus", {
        v: [String(input.message.id), input.sessionID, nowMs, input.id, input.sessionID],
      });
    });
  }

  async markSessionInputPromoted(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("markSessionInputPromoted", {
      v: [input.promotedMessageID, input.sessionID, nowMs, input.id, input.sessionID],
    });
  }

  async settleSessionInput(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("settleSessionInput", {
      v: [input.status, input.reason ?? null, nowMs, input.id, input.sessionID],
    });
  }

  async listSessionInputs(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]> {
    const raw = await this.readRows("listSessionInputs", input);
    return (JSON.parse(raw) as SessionInputRow[]).map(decodeSessionInputRow);
  }

  async getSessionInputById(id: string): Promise<SessionInputRecord | null> {
    const raw = await this.readRows("getSessionInputById", { v: [id] });
    const rows = JSON.parse(raw) as SessionInputRow[];
    return rows[0] ? decodeSessionInputRow(rows[0]) : null;
  }

  // ── todos ─────────────────────────────────────────────────────────────────

  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    const raw = await this.readRows("readTodos", { v: [input.sessionID] });
    return (JSON.parse(raw) as TodoRow[]).map(decodeTodoRow);
  }

  async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("updateTodos", {
      sessionID: input.sessionID,
      todos: input.todos,
      nowMs,
    });
  }

  // ── targets ───────────────────────────────────────────────────────────────

  async readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return decodeTargetResult(await this.readRows("readTarget", input));
  }

  async setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal> {
    const nowMs = Date.now();
    const goal = decodeTargetResult(
      await this.writeOp("setTarget", {
        sessionID: input.sessionID,
        targetID: createStorageTargetId(),
        objective: input.objective,
        status: input.status ?? "active",
        tokenBudget: input.tokenBudget,
        nowMs,
      }),
    );
    if (!goal) throw new Error(`Session target not found after write: ${input.sessionID}`);
    return goal;
  }

  async cloneTargetForFork(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    const goal = decodeTargetResult(
      await this.writeOp("cloneTargetForFork", {
        sessionID: input.sessionID,
        targetID: input.source.targetID,
        objective: input.source.objective,
        summaryTitle: input.source.summaryTitle,
        status: input.status ?? input.source.status,
        tokenBudget: input.source.tokenBudget,
        tokensUsed: input.source.tokensUsed,
        timeUsedSeconds: input.source.timeUsedSeconds,
        timeCreated: input.source.time.created,
        timeUpdated: input.source.time.updated,
        nowMs,
      }),
    );
    if (!goal) throw new Error(`Session target not found after write: ${input.sessionID}`);
    return goal;
  }

  async createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null> {
    const nowMs = Date.now();
    return decodeTargetResult(
      await this.writeOp("createTarget", {
        sessionID: input.sessionID,
        targetID: createStorageTargetId(),
        objective: input.objective,
        tokenBudget: input.tokenBudget,
        nowMs,
      }),
    );
  }

  async updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null> {
    const nowMs = Date.now();
    return decodeTargetResult(
      await this.writeOp("updateTargetStatus", {
        sessionID: input.sessionID,
        status: input.status,
        nowMs,
      }),
    );
  }

  async startTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null> {
    return decodeTargetResult(await this.writeOp("startTargetRun", input));
  }

  async heartbeatTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null> {
    return decodeTargetResult(await this.writeOp("heartbeatTargetRun", input));
  }

  async finishTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null> {
    return decodeTargetResult(await this.writeOp("finishTargetRun", input));
  }

  async recoverInterruptedTargetRun(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return decodeTargetResult(await this.writeOp("recoverInterruptedTargetRun", input));
  }

  async accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null> {
    const nowMs = Date.now();
    return decodeTargetResult(
      await this.writeOp("accountTargetUsage", { ...input, nowMs }),
    );
  }

  async updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null> {
    const nowMs = Date.now();
    return decodeTargetResult(
      await this.writeOp("updateTargetSummaryTitle", { ...input, nowMs }),
    );
  }

  async clearTarget(input: { sessionID: SessionId }): Promise<boolean> {
    const nowMs = Date.now();
    const raw = await this.writeOp("clearTarget", { ...input, nowMs });
    return JSON.parse(raw) === true;
  }

  // ── usage ─────────────────────────────────────────────────────────────────

  async recordModelUsage(input: ModelUsageRecord): Promise<void> {
    const computedTotalTokens =
      input.computedTotalTokens ??
      inputSideTokensFromNormalizedUsage(
        input.inputTokens,
        input.cacheCreationInputTokens,
        input.cacheReadInputTokens,
      ) + integer(input.outputTokens);

    // The database inherits the historical column names created by 0010; the domain layer uses the more accurate reasoningLevel.
    await this.writeOp("recordModelUsage", { v: [
      input.id,
      input.logicalRequestId,
      integer(input.attemptIndex),
      input.sessionID,
      input.turnID ?? null,
      input.traceID ?? null,
      input.spanID ?? null,
      input.assistantMessageID ?? null,
      input.parentUserMessageID ?? null,
      input.querySource,
      input.providerId,
      input.modelId,
      input.reasoningLevel ?? null,
      input.agent ?? null,
      input.mode ?? null,
      input.taskType ?? null,
      input.status,
      input.startedAt,
      input.firstTokenAt ?? null,
      input.completedAt ?? null,
      input.durationMs ?? null,
      input.timeToFirstTokenMs ?? null,
      input.finishReason ?? null,
      integer(input.toolCallCount),
      integer(input.inputTokens),
      integer(input.outputTokens),
      integer(input.reasoningTokens),
      integer(input.cacheCreationInputTokens),
      integer(input.cacheReadInputTokens),
      input.providerTotalTokens ?? null,
      computedTotalTokens,
      integer(input.retryCount),
      boolean(input.retryable),
      boolean(input.cancelledByUser),
      boolean(input.contextExceeded),
      input.errorType ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      encodeJson(input.rawUsage),
      encodeJson(input.providerMetadata),
    ] });
  }

  async upsertTurnUsage(input: TurnUsageRecord): Promise<void> {
    await this.writeOp("upsertTurnUsage", { v: [
      input.sessionID,
      input.turnID,
      input.traceID ?? null,
      input.userMessageID ?? null,
      input.status,
      input.startedAt,
      input.firstModelStartAt ?? null,
      input.firstTokenAt ?? null,
      input.completedAt ?? null,
      input.durationMs ?? null,
      input.timeToFirstTokenMs ?? null,
      integer(input.modelRequestCount),
      integer(input.modelRetryCount),
      integer(input.toolCallCount),
      integer(input.toolErrorCount),
      integer(input.inputTokens),
      integer(input.outputTokens),
      integer(input.reasoningTokens),
      integer(input.cacheCreationInputTokens),
      integer(input.cacheReadInputTokens),
      integer(input.computedTotalTokens),
      boolean(input.retryable),
      boolean(input.cancelledByUser),
      boolean(input.contextExceeded),
      input.errorType ?? null,
      input.errorCode ?? null,
    ] });
  }

  async upsertToolUsage(input: ToolUsageRecord): Promise<void> {
    await this.writeOp("upsertToolUsage", { v: toolUsageValues(input) });
  }

  async pruneUsage(input?: { beforeTime?: number }): Promise<void> {
    const beforeTime = input?.beforeTime ?? Date.now() - USAGE_RETENTION_MS;
    await this.writeOp("pruneUsage", { v: [beforeTime] });
  }

  async queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult> {
    const { since, until, tzOffsetMs } = input;
    const pieces = JSON.parse(
      await this.readRows("queryAppUsage", { v: [since, until, tzOffsetMs] }),
    ) as {
      totals: Array<Record<string, number | null>>;
      turnTotals: Array<Record<string, number | null>>;
      longestSession: Array<Record<string, number | null>>;
      toolTotals: Array<Record<string, number>>;
      models: AppUsageModelRow[];
      tools: AppUsageToolRow[];
      days: Array<{ dayIndex: number; totalTokens: number }>;
      turnDays: Array<{ dayIndex: number; turnCount: number }>;
      toolDays: Array<{ dayIndex: number; toolCallCount: number }>;
      dayModels: Array<{ dayIndex: number; modelId: string | null; totalTokens: number }>;
    };
    const totals = pieces.totals[0] ?? {};
    const turnTotals = pieces.turnTotals[0] ?? {};
    const longestSession = pieces.longestSession[0] ?? {};
    const toolTotals = pieces.toolTotals[0] ?? { toolCallCount: 0, toolErrorCount: 0 };

    // Merge three categories of daily statistics into the same dayIndex
    const dayMap = new Map<number, { dayIndex: number; totalTokens: number; turnCount: number; toolCallCount: number }>();
    for (const row of pieces.days) {
      dayMap.set(row.dayIndex, {
        dayIndex: row.dayIndex,
        totalTokens: Number(row.totalTokens),
        turnCount: 0,
        toolCallCount: 0,
      });
    }
    for (const row of pieces.turnDays) {
      const existing = dayMap.get(row.dayIndex) ?? {
        dayIndex: row.dayIndex,
        totalTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
      };
      existing.turnCount = Number(row.turnCount);
      dayMap.set(row.dayIndex, existing);
    }
    for (const row of pieces.toolDays) {
      const existing = dayMap.get(row.dayIndex) ?? {
        dayIndex: row.dayIndex,
        totalTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
      };
      existing.toolCallCount = Number(row.toolCallCount);
      dayMap.set(row.dayIndex, existing);
    }

    return {
      totals: {
        totalTokens: Number(totals.totalTokens ?? 0),
        inputTokens: Number(totals.inputTokens ?? 0),
        outputTokens: Number(totals.outputTokens ?? 0),
        reasoningTokens: Number(totals.reasoningTokens ?? 0),
        cacheCreationTokens: Number(totals.cacheCreationTokens ?? 0),
        cacheReadTokens: Number(totals.cacheReadTokens ?? 0),
        modelRequestCount: Number(totals.modelRequestCount ?? 0),
        modelErrorCount: Number(totals.modelErrorCount ?? 0),
        avgTimeToFirstTokenMs:
          totals.avgTimeToFirstTokenMs == null ? null : Number(totals.avgTimeToFirstTokenMs),
      },
      turnTotals: {
        totalSessions: Number(turnTotals.totalSessions ?? 0),
        totalTurns: Number(turnTotals.totalTurns ?? 0),
        avgTurnDurationMs:
          turnTotals.avgTurnDurationMs == null ? null : Number(turnTotals.avgTurnDurationMs),
        longestSessionMs: Number(longestSession.longestSessionMs ?? 0),
      },
      toolTotals: {
        toolCallCount: Number(toolTotals.toolCallCount ?? 0),
        toolErrorCount: Number(toolTotals.toolErrorCount ?? 0),
      },
      models: pieces.models.map((m) => ({
        modelId: m.modelId ?? null,
        totalTokens: Number(m.totalTokens),
        inputTokens: Number(m.inputTokens),
        outputTokens: Number(m.outputTokens),
        requestCount: Number(m.requestCount),
      })),
      tools: pieces.tools.map((t) => ({
        toolName: t.toolName,
        callCount: Number(t.callCount),
        errorCount: Number(t.errorCount),
        avgDurationMs: t.avgDurationMs == null ? null : Number(t.avgDurationMs),
      })),
      days: [...dayMap.values()].sort((a, b) => a.dayIndex - b.dayIndex),
      dayModels: pieces.dayModels.map((d) => ({
        dayIndex: Number(d.dayIndex),
        modelId: d.modelId ?? null,
        totalTokens: Number(d.totalTokens),
      })),
    };
  }

  async queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult> {
    const rows = JSON.parse(await this.readRows("queryTaskUsage", { v: [input.sessionID] })) as Array<{
      cacheCreationTokens: number;
      cacheReadTokens: number;
      computedTotalTokens: number;
      inputTokens: number;
      outputTokens: number;
      providerTotalTokens: number | null;
      querySource: string;
      reasoningTokens: number;
      status: string;
    }>;

    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let modelErrorCount = 0;
    const inputBaselineBySource: Record<string, number> = {};

    for (const row of rows) {
      const rawTotalTokens = Number(row.providerTotalTokens ?? row.computedTotalTokens ?? 0);
      const inputSideTokens = inputSideTokensFromStoredUsage(row);
      const source = taskUsageInputBaselineSource(row.querySource);
      const incrementalInputTokens =
        source === undefined
          ? inputSideTokens
          : Math.max(0, inputSideTokens - (inputBaselineBySource[source] ?? 0));
      if (source !== undefined) {
        // Compression will make subsequent context input smaller; the cumulative consumption cannot be deducted from history.
        // However, the baseline must be reduced to the compressed value before subsequent new rounds can continue to be calculated incrementally.
        inputBaselineBySource[source] = inputSideTokens;
      }

      const nonInputTokens = Math.max(0, rawTotalTokens - inputSideTokens);
      const rowOutputTokens = Number(row.outputTokens ?? 0);
      const rowReasoningTokens = Number(row.reasoningTokens ?? 0);
      totalTokens += incrementalInputTokens + nonInputTokens;
      inputTokens += incrementalInputTokens;
      outputTokens += rowOutputTokens;
      reasoningTokens += rowReasoningTokens;
      if (source === undefined) {
        cacheCreationTokens += Number(row.cacheCreationTokens ?? 0);
        cacheReadTokens += Number(row.cacheReadTokens ?? 0);
      }
      if (row.status === "error") {
        modelErrorCount += 1;
      }
    }

    return {
      sessionID: input.sessionID,
      totalTokens,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheCreationTokens,
      cacheReadTokens,
      modelRequestCount: rows.length,
      modelErrorCount,
      inputBaselineBySource,
    };
  }

  // ── input history ─────────────────────────────────────────────────────────

  async recordInputHistory(input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  }): Promise<InputHistoryEntry | null> {
    const text = input.text.trim();
    if (text.length === 0) return null;
    const attachments = normalizedInputHistoryAttachments(input.attachments);

    const latest = await this.recallPreviousInputHistory({ projectID: input.projectID });
    if (
      latest?.text === text &&
      stableInputHistoryAttachments(latest.attachments) === stableInputHistoryAttachments(attachments)
    ) {
      return null;
    }

    const id = createStorageInputHistoryId();
    const timeCreated = input.time?.created ?? Date.now();

    await this.writeOp("recordInputHistory", {
      id,
      projectID: input.projectID,
      sessionID: input.sessionID ?? null,
      text,
      attachmentsJson: encodeJson(attachments),
      kind: input.kind,
      timeCreated,
      limit: 100,
    });

    return {
      id,
      projectID: input.projectID,
      sessionID: input.sessionID,
      text,
      ...(attachments ? { attachments } : {}),
      kind: input.kind,
      time: {
        created: timeCreated,
      },
    };
  }

  async recallPreviousInputHistory(input: {
    projectID: ProjectId;
    skip?: number;
  }): Promise<InputHistoryEntry | null> {
    const raw = await this.readRows("recallPreviousInputHistory", {
      v: [input.projectID, input.skip ?? 0],
    });
    const rows = JSON.parse(raw) as InputHistoryRow[];
    return rows[0] ? decodeInputHistoryRow(rows[0]) : null;
  }

  // ── local settings / permissions ──────────────────────────────────────────

  private decodePermissionResult(raw: string): PermissionRuleset | null {
    const [settingRows, permissionRows] = JSON.parse(raw) as [
      LocalSettingRow[],
      PermissionRow[],
    ];
    if (settingRows[0]) {
      return decodeJson<PermissionRuleset>(settingRows[0].value) ?? null;
    }
    return permissionRows[0]
      ? decodeJson<PermissionRuleset>(permissionRows[0].data) ?? null
      : null;
  }

  async getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null> {
    return this.decodePermissionResult(await this.readRows("getProjectPermission", { v: [projectID] }));
  }

  async saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    const raw = await this.writeOp("saveProjectPermission", {
      v: [input.projectID, JSON.stringify(input.permission), nowMs],
    });
    const saved = this.decodePermissionResult(raw);
    if (!saved) {
      throw new Error(`Project permission not found after write: ${input.projectID}`);
    }
    return saved;
  }

  async getProjectPermissionMode(projectID: ProjectId): Promise<CollaborationMode | null> {
    const raw = await this.readRows("getProjectPermissionMode", { v: [projectID] });
    const rows = JSON.parse(raw) as LocalSettingRow[];
    if (!rows[0]) return null;
    const value = decodeJson<{ mode?: unknown }>(rows[0].value);
    return isCollaborationMode(value?.mode) ? value.mode : null;
  }

  async saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): Promise<CollaborationMode> {
    this.throwBeforeWrite();
    const nowMs = Date.now();
    await this.writeOp("saveProjectPermissionMode", {
      v: [input.projectID, JSON.stringify({ mode: input.mode }), nowMs],
    });
    return input.mode;
  }

  // ── script workflow ───────────────────────────────────────────────────────

  async upsertScriptWorkflowDefinition(
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord> {
    const nowMs = Date.now();
    const raw = await this.writeOp("upsertScriptWorkflowDefinition", { v: [
      input.id,
      input.name,
      input.source,
      input.scope ?? (input.source === "builtin" ? "builtin" : "explicit"),
      input.trusted === true ? 1 : 0,
      input.enabled === false ? 0 : 1,
      input.scriptPath ?? null,
      input.scriptHash,
      JSON.stringify(input.meta),
      nowMs,
      nowMs,
    ] });
    return decodeDefinition((JSON.parse(raw) as WorkflowDefinitionRow[])[0]!);
  }

  async createScriptWorkflowRun(
    input: CreateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    const nowMs = Date.now();
    const raw = await this.writeOp("createScriptWorkflowRun", { v: [
      input.id,
      input.definitionId ?? null,
      input.name,
      input.parentSessionId ?? null,
      input.cwd,
      input.scriptPath ?? null,
      input.scriptHash,
      encodeJson(input.args),
      input.argsHash ?? null,
      input.status ?? "pending",
      input.budgetTotal ?? null,
      encodeJson(input.stats),
      nowMs,
      nowMs,
    ] });
    return decodeRun((JSON.parse(raw) as WorkflowRunRow[])[0]!);
  }

  async updateScriptWorkflowRun(
    input: UpdateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    const nowMs = Date.now();
    const raw = await this.writeOp("updateScriptWorkflowRun", { input, nowMs });
    return decodeRun((JSON.parse(raw) as WorkflowRunRow[])[0]!);
  }

  async getScriptWorkflowRun(runId: string): Promise<ScriptWorkflowRunRecord | null> {
    const raw = await this.readRows("getScriptWorkflowRun", { v: [runId] });
    const rows = JSON.parse(raw) as WorkflowRunRow[];
    return rows[0] ? decodeRun(rows[0]) : null;
  }

  async listScriptWorkflowRuns(input?: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  }): Promise<ScriptWorkflowRunRecord[]> {
    const raw = await this.readRows("listScriptWorkflowRuns", {
      cwd: input?.cwd,
      statuses: input?.statuses ? [...input.statuses] : undefined,
      limit: input?.limit && input.limit > 0 ? input.limit : null,
    });
    return (JSON.parse(raw) as WorkflowRunRow[]).map(decodeRun);
  }

  async createScriptWorkflowActivity(
    input: CreateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    const nowMs = Date.now();
    const raw = await this.writeOp("createScriptWorkflowActivity", {
      id: input.id,
      runId: input.runId,
      parentActivityId: input.parentActivityId ?? null,
      callIndex: input.callIndex,
      callPath: input.callPath,
      type: input.type,
      phase: input.phase ?? null,
      label: input.label ?? null,
      inputHash: input.inputHash,
      prompt: input.prompt ?? null,
      optsJson: encodeJson(input.opts),
      status: input.status ?? "queued",
      nowMs,
    });
    return decodeActivity((JSON.parse(raw) as WorkflowActivityRow[])[0]!);
  }

  async updateScriptWorkflowActivity(
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    const nowMs = Date.now();
    const raw = await this.writeOp("updateScriptWorkflowActivity", { input, nowMs });
    return decodeActivity((JSON.parse(raw) as WorkflowActivityRow[])[0]!);
  }

  async findCachedScriptWorkflowActivity(input: {
    callPath: string;
    inputHash: string;
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord | null> {
    const raw = await this.readRows("findCachedScriptWorkflowActivity", {
      v: [input.runId, input.callPath, input.inputHash],
    });
    const rows = JSON.parse(raw) as WorkflowActivityRow[];
    return rows[0] ? decodeActivity(rows[0]) : null;
  }

  async listScriptWorkflowActivities(input: {
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord[]> {
    const raw = await this.readRows("listScriptWorkflowActivities", { v: [input.runId] });
    return (JSON.parse(raw) as WorkflowActivityRow[]).map(decodeActivity);
  }

  async appendScriptWorkflowEvent(input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  }): Promise<ScriptWorkflowEventRecord> {
    const nowMs = Date.now();
    const raw = await this.writeOp("appendScriptWorkflowEvent", {
      id: input.id,
      runId: input.runId,
      type: input.type,
      phase: input.phase ?? null,
      activityId: input.activityId ?? null,
      payloadJson: encodeJson(input.payload),
      nowMs,
    });
    return decodeEvent((JSON.parse(raw) as WorkflowEventRow[])[0]!);
  }

  async listScriptWorkflowEvents(input: {
    limit?: number;
    runId: string;
  }): Promise<ScriptWorkflowEventRecord[]> {
    const raw = await this.readRows("listScriptWorkflowEvents", {
      runId: input.runId,
      limit: input.limit && input.limit > 0 ? input.limit : null,
    });
    return (JSON.parse(raw) as WorkflowEventRow[]).map(decodeEvent);
  }

  async createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<SessionTaskLinkRecord> {
    const nowMs = Date.now();
    const raw = await this.writeOp("createSessionTaskLink", { v: [
      input.id,
      input.rootWorkflowRunId ?? null,
      input.parentLinkId ?? null,
      input.activityId ?? null,
      input.parentSessionId ?? null,
      input.childSessionId,
      input.role,
      input.depth ?? 0,
      input.path,
      input.phase ?? null,
      input.label ?? null,
      input.agentType ?? null,
      input.model ?? null,
      input.status,
      nowMs,
      nowMs,
    ] });
    return decodeTaskLink((JSON.parse(raw) as SessionTaskLinkRow[])[0]!);
  }

  /**
   * The dynamic-workflow execution engine's durable journal (dwf_* tables). The port is synchronous, so here returns
   * The port object itself rather than being forwarded method by method - the engine holds it and reads and writes it at its own pace.
   *
   * The journal has its own native connection (spec §14.2): the ported store no
   * longer owns a DatabaseSync, and the journal's synchronous domain contract is
   * served by the `zcode-events` crate's sync `DwfJournal` surface.
   */
  workflowJournalStore(): JournalStorePort {
    if (!this.dwfJournalStore) {
      this.dwfJournalStore = createDwfJournalStore(this.dbPath);
    }
    return this.dwfJournalStore;
  }
}

/** Async by contract now: the synchronous open (ctor + Atomics-wait migrations) no longer exists (§5.3). */
export async function openStartupSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
  migrationOptions: AsyncSqliteMigrationOptions = {},
): Promise<SqliteSessionStore> {
  return SqliteSessionStore.openStartup(options, migrationOptions);
}

export { getDefaultSessionDbPath };
