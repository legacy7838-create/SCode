import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type {
  GlmQuotaBannerBusinessCode,
  StartPlanConcurrentLimitBannerReason,
} from "@/lib/providerBusinessError.js";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";

import {
  allBucketsExhausted,
  bucketMatchesModel,
  bucketRemainingRatio,
  bucketReminderKey,
  getActiveModelBuckets,
} from "@/v4/startPlanQuotaBuckets.js";

export type SessionQuotaBannerKind =
  | "model-very-low"
  | "model-exhausted"
  | "daily-exhausted"
  | "concurrent-limit"
  | "provider-limited"
  | "mcp-quota-exhausted"
  | "mcp-plan-required";

export interface SessionQuotaBannerState {
  visible: boolean;
  kind: SessionQuotaBannerKind | null;
  concurrentLimitBusinessCode: "3008" | "3009" | "3010" | null;
  concurrentLimitReason: StartPlanConcurrentLimitBannerReason | null;
  providerLimitedBusinessCode: GlmQuotaBannerBusinessCode | null;
  providerLimitedMessage: string | null;
  modelName: string | null;
  /**
   * Official Server MCP notice only: the name of the MCP server that is failing, used to name it in
   * the copy.
   */
  mcpServerName: string | null;
  /**
   * Official Server MCP notice only: the tool row that produced this fact, which takes part in the
   * dedupe key.
   */
  mcpNoticeRowId: number | null;
  /**
   * Only the low-quota reminder carries a stable bucket-period key; it does not affect other
   * business-error dismissals.
   */
  reminderKey?: string;
  reminderExpiresAt?: number;
  /**
   * A snapshot time consistent with bucket validity; it must not be converted to the device clock.
   */
  reminderReferenceTime?: number;
  quotaPeriod?: string;
  remainingTokens: number | null;
  remainingPercent: number | null;
  dismissible: boolean;
  blocksSubmit: boolean;
  priority: number;
}

const HIDDEN_SESSION_QUOTA_BANNER_STATE: SessionQuotaBannerState = {
  visible: false,
  kind: null,
  concurrentLimitBusinessCode: null,
  concurrentLimitReason: null,
  providerLimitedBusinessCode: null,
  providerLimitedMessage: null,
  modelName: null,
  mcpServerName: null,
  mcpNoticeRowId: null,
  remainingTokens: null,
  remainingPercent: null,
  dismissible: false,
  blocksSubmit: false,
  priority: 0,
};

function isGlmQuotaBannerProviderId(providerId: string): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

function normalizeProviderLimitedBannerMessage(message: string | null | undefined): string | null {
  const normalizedMessage = message?.trim();
  if (!normalizedMessage) return null;
  const bracketParts = [...normalizedMessage.matchAll(/\[([^\]]*)\]/gu)].map(
    (match) => match[1]?.trim() ?? "",
  );
  return bracketParts.length >= 3 && bracketParts[1] ? bracketParts[1] : normalizedMessage;
}

/**
 * Quota business errors keep their original priority; for Start Plan a low quota is reported per
 * bucket, while exhaustion is judged across all valid buckets.
 */
export function buildSessionQuotaBannerState(params: {
  activeProviderId: string | null;
  snapshot: UsageEntitlementSnapshot | null;
  modelId: string | null;
  serverQuotaExhausted?: boolean;
  isReminderHidden?: (key: string, referenceTime: number) => boolean;
  serverConcurrentLimited?: boolean;
  serverConcurrentLimitBusinessCode?: "3008" | "3009" | "3010";
  serverConcurrentLimitReason?: StartPlanConcurrentLimitBannerReason;
  serverProviderLimitedBusinessCode?: GlmQuotaBannerBusinessCode;
  serverProviderLimitedMessage?: string | null;
  /**
   * The fact that the official Server MCP was judged unavailable within this session (from the tool
   * row's structured marker).
   */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}): SessionQuotaBannerState {
  if (
    params.serverConcurrentLimited === true &&
    params.activeProviderId &&
    isStartPlanModelProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "concurrent-limit",
      concurrentLimitBusinessCode: params.serverConcurrentLimitBusinessCode ?? null,
      concurrentLimitReason: params.serverConcurrentLimitReason ?? "initial-busy",
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 60,
    };
  }

  if (
    params.serverQuotaExhausted === true &&
    params.activeProviderId &&
    isStartPlanModelProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "daily-exhausted",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: null,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: 0,
      dismissible: false,
      blocksSubmit: false,
      priority: 50,
    };
  }

  if (
    params.serverProviderLimitedBusinessCode &&
    params.activeProviderId &&
    isGlmQuotaBannerProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "provider-limited",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: params.serverProviderLimitedBusinessCode,
      providerLimitedMessage: normalizeProviderLimitedBannerMessage(
        params.serverProviderLimitedMessage,
      ),
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 45,
    };
  }

  // The official Server MCP is unavailable (limit exhausted/no Coding Plan).
  //
  // Location requirements: Must be after the above server-side business errors (model-side problems are more urgent and cannot be blocked by MCP prompts),
  // And it must be before the following Start-Plan-only early exit - the Coding Plan session must hit that early exit.
  // This branch will never take effect if placed after it.
  if (params.mcpUnavailableNotice) {
    const mcpQuotaExhausted = params.mcpUnavailableNotice.code === "quota_exceeded";
    return {
      visible: true,
      kind: mcpQuotaExhausted ? "mcp-quota-exhausted" : "mcp-plan-required",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: null,
      mcpServerName: params.mcpUnavailableNotice.serverName,
      mcpNoticeRowId: params.mcpUnavailableNotice.rowId,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      // Unavailability of MCP does not affect model dialogue and in no way blocks input.
      blocksSubmit: false,
      priority: mcpQuotaExhausted ? 6 : 8,
    };
  }

  if (
    !params.activeProviderId ||
    !isStartPlanModelProviderId(params.activeProviderId) ||
    params.snapshot?.provider?.id !== params.activeProviderId
  ) {
    return HIDDEN_SESSION_QUOTA_BANNER_STATE;
  }

  const referenceTime = params.snapshot.serverTime ?? params.snapshot.generatedAt;
  const buckets = getActiveModelBuckets(params.snapshot);
  if (allBucketsExhausted(buckets)) {
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "daily-exhausted",
      remainingTokens: 0,
      remainingPercent: 0,
      priority: 50,
    };
  }
  const modelId = params.modelId?.trim() ?? "";
  const modelBuckets = modelId
    ? buckets.filter((bucket) => bucketMatchesModel(bucket, modelId))
    : [];
  const modelName =
    modelBuckets.flatMap((bucket) => bucket.usageDetails).find((detail) => detail.displayName)
      ?.displayName ?? modelId;
  if (allBucketsExhausted(modelBuckets)) {
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "model-exhausted",
      modelName,
      remainingTokens: 0,
      remainingPercent: 0,
      priority: 40,
    };
  }
  for (const bucket of modelBuckets) {
    const ratio = bucketRemainingRatio(bucket);
    const key = bucketReminderKey(bucket);
    if (
      ratio === null ||
      ratio <= 0 ||
      ratio > 0.1 ||
      !key ||
      params.isReminderHidden?.(key, referenceTime)
    )
      continue;
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "model-very-low",
      modelName,
      remainingTokens: bucket.remaining ?? null,
      remainingPercent: ratio * 100,
      reminderKey: key,
      reminderReferenceTime: referenceTime,
      reminderExpiresAt: Math.min(bucket.periodEnd!, bucket.nextResetTime ?? Infinity),
      quotaPeriod: bucket.period,
      dismissible: true,
      priority: 30,
    };
  }
  return HIDDEN_SESSION_QUOTA_BANNER_STATE;
}

export function buildSessionQuotaBannerDismissKey(
  state: SessionQuotaBannerState,
  serverErrorKey?: string | null,
): string | null {
  if (!state.visible || !state.kind) return null;
  if (state.reminderKey) return state.reminderKey;
  return [
    state.kind,
    state.concurrentLimitBusinessCode ?? "",
    state.concurrentLimitReason ?? "",
    state.providerLimitedBusinessCode ?? "",
    state.providerLimitedMessage ?? "",
    state.modelName ?? "",
    // MCP prompts to press server + specific call deduplication: after closing once, the same call will no longer be played.
    // After that, if there is a new failed call (new rowId), it will pop up again.
    state.mcpServerName ?? "",
    state.mcpNoticeRowId ?? "",
    state.remainingTokens ?? "",
    state.remainingPercent ?? "",
    state.blocksSubmit ? "blocked" : "unblocked",
    serverErrorKey ?? "",
  ].join(":");
}

export function resolveQuotaBannerUpgradeProviderId(providerId: string | null): string | null {
  return providerId;
}

/**
 * Whether this notice should carry an upgrade entry point.
 *
 * `mcp-quota-exhausted` explicitly does not: once today's quota is spent it can only wait for the
 * natural day reset, and an upgrade button would make users think that spending money lets them
 * continue right away, which is misleading. A missing entitlement (`mcp-plan-required`) is what an
 * upgrade can actually solve.
 */
export function shouldOfferQuotaBannerUpgrade(kind: SessionQuotaBannerKind | null): boolean {
  return kind !== "mcp-quota-exhausted";
}
