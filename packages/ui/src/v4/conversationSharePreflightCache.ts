import type {
  ConversationShareFailureIssue,
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
} from "@zcode/services";
import { extractConversationPreviewFileReferences } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

interface ConversationShareTurnFingerprintContext {
  capabilitiesFingerprint?: string;
  logEpoch?: string;
  productTurnId?: string;
  remoteSessionId?: string;
  revision?: number;
  sessionId?: string;
  workspaceKey?: string;
}

export function conversationShareTurnFingerprint(
  rows: readonly ConversationRow[],
  productTurnId: string,
  workspacePath = "",
  context: ConversationShareTurnFingerprintContext = {},
): string {
  const turnRows = rows.filter((row) => row.productTurnId === productTurnId);
  const assistantText = turnRows
    .filter((row): row is Extract<ConversationRow, { kind: "assistantText" }> => {
      return row.kind === "assistantText";
    })
    .map((row) => row.text)
    .join("\n\n");
  const candidateFingerprint = extractConversationPreviewFileReferences(
    assistantText,
    workspacePath,
  ).map((candidate) => ({
    kind: candidate.kind,
    path: candidate.path,
    start: candidate.start,
    end: candidate.end,
  }));
  const signature = turnRows.map((row) => ({
    rowId: row.rowId,
    kind: row.kind,
    state: "state" in row ? row.state : undefined,
    status: "status" in row ? row.status : undefined,
    text: "text" in row ? row.text : undefined,
    fileChanges: row.kind === "turnHeader" ? row.fileChanges : undefined,
    attachments:
      row.kind === "userInput"
        ? row.attachments?.map((attachment) => ({
            ref: attachment.ref,
            fileName: attachment.fileName,
            mime: attachment.mime,
            bytes: attachment.bytes,
          }))
        : undefined,
  }));
  return hashString(
    JSON.stringify({
      scope: {
        workspaceKey: context.workspaceKey ?? workspacePath,
        remoteSessionId: context.remoteSessionId ?? "",
        sessionId: context.sessionId ?? "",
      },
      productTurnId: context.productTurnId ?? productTurnId,
      revision: context.revision,
      logEpoch: context.logEpoch,
      capabilitiesFingerprint: context.capabilitiesFingerprint,
      rows: signature,
      previewCandidates: candidateFingerprint,
    }),
  );
}

export function conversationSharePreflightCacheKey(
  scopeKey: string,
  productTurnId: string,
): string {
  return `${scopeKey}\u0000${productTurnId}`;
}

/**
 * When aggregating preflight results across several turns, drop duplicate global errors that cannot
 * be located to a specific turn/file. Turn-level or file-level problems keep their own locator
 * fields, so that the several problems the user really has to act on are not merged away.
 */
export function dedupeConversationShareIssues(
  issues: readonly ConversationShareFailureIssue[],
): ConversationShareFailureIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const hasLocator =
      issue.rowId !== undefined ||
      issue.turnOrdinal !== undefined ||
      issue.artifactDisplayName !== undefined;
    // The transport/conversation question itself is the global state; when the turn/artifact question does not have a positioning field,
    // Even if the content is the same, it should be retained to avoid merging multiple pending rounds into one by mistake.
    if (!hasLocator && issue.scope !== "transport" && issue.scope !== "conversation") {
      return true;
    }
    const key = JSON.stringify({
      code: issue.code,
      scope: issue.scope,
      rowId: issue.rowId,
      turnOrdinal: issue.turnOrdinal,
      artifactDisplayName: issue.artifactDisplayName,
      artifactType: issue.artifactType,
      extension: issue.extension,
      mimeType: issue.mimeType,
      actual: issue.actual,
      limit: issue.limit,
      retryAfterMs: issue.retryAfterMs,
      phase: issue.phase,
      allowedFormats: issue.allowedFormats,
      allowedArtifacts: issue.allowedArtifacts,
      availability: issue.availability,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Splits one preflight result into per-turn cache entries.
 *
 * In dev the host process is not restarted when services are rebuilt, and a result from an old host
 * has no turnResults, so a caller that directly `.map`s it throws and the downstream catch reports
 * it as “server-side preflight failed”. This degrades gracefully on a missing field: when the
 * detail for some turn cannot be found, it falls back to the overall issues — coarser granularity
 * is acceptable, but a successful preflight must never be called a failure.
 */
export function buildConversationSharePreflightCacheEntries(
  result: ConversationSharePreflightResult,
  productTurnIds: readonly string[],
  turnFingerprints: ReadonlyMap<string, string>,
): ConversationShareTurnPreflightResult[] {
  const entriesByProductTurnId = new Map(
    (Array.isArray(result.turnResults) ? result.turnResults : []).map((entry) => [
      entry.productTurnId,
      entry,
    ]),
  );
  return productTurnIds.map((productTurnId) => {
    const entry = entriesByProductTurnId.get(productTurnId);
    return {
      ...(entry ?? {
        blockingIssues: result.blockingIssues,
        skippableWarnings: result.skippableWarnings,
        deferredIssues: result.deferredIssues,
      }),
      productTurnId,
      turnFingerprint: turnFingerprints.get(productTurnId),
    };
  });
}

export function getMissingConversationSharePreflightTurnIds(
  scopeKey: string,
  selectedProductTurnIds: readonly string[],
  cache: ReadonlyMap<string, ConversationShareTurnPreflightResult>,
  turnFingerprints?: ReadonlyMap<string, string>,
): string[] {
  return selectedProductTurnIds.filter((productTurnId) => {
    const entry = cache.get(conversationSharePreflightCacheKey(scopeKey, productTurnId));
    return (
      entry === undefined ||
      (turnFingerprints !== undefined &&
        entry.turnFingerprint !== turnFingerprints.get(productTurnId))
    );
  });
}
