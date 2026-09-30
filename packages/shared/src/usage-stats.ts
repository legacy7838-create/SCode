/* eslint-disable max-lines -- The cross-process protocols for Usage, Entitlement and Reset need to share one set of Account Access fields and runtime schemas, so they are kept together for now. */
import { z } from "zod";

// The quota type is in usage-quota.ts, see the header description of the file; here re-export keeps the existing import path unchanged.
export * from "./usage-quota.js";
import type { UsageMcpQuotaSnapshot, UsageQuotaSnapshot } from "./usage-quota.js";
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "./zcode-protocol/index.js";

export const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;

export type UsageStatsRange = "all" | "7d" | "30d";
export type CodingPlanUsageRange = "today" | "7d" | "30d" | "custom";
export type CodingPlanUsageGranularity = "hour" | "day";
export type CodingPlanUsageDetailMetric = "credits" | "usage";
export type CodingPlanUsageDetailSubject = "model" | "tool";

export interface UsageStatsRequest {
  range: UsageStatsRange;
  /** Source of the usage statistics. App Usage explicitly uses the local session aggregation; Coding Plan explicitly uses the monitor interface. */
  dataSource?: "local" | "monitor";
  /** The settings page may pass in the Z.AI / BigModel source the user currently has selected, so that when both are configured it does not silently read only the first one. */
  preferredProviderId?: string;
  /** A Registry static access kind, or a dynamic account access context already resolved at the call boundary. */
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  /** When a source is specified it must hit preferredProviderId; falling back to another provider or to local aggregation is not allowed. */
  requirePreferredProvider?: boolean;
  /** Whether host environment variables may override the provider key. Allowed by default; explicit-provider scenarios can turn it off. */
  allowEnvApiKey?: boolean;
  /**
   * Statistics are bucketed in the caller's time zone.
   * The UI passes the browser's current time zone by default; when absent, the host side falls back to the system time zone.
   */
  timeZone?: string;
}

export interface CodingPlanUsageRequest {
  range: CodingPlanUsageRange;
  /** Custom date range. Only takes effect when range=custom, interpreted as caller-side calendar days, at most 30 days. */
  customStartDate?: string | null;
  customEndDate?: string | null;
  preferredProviderId: string;
  /** A Registry static access kind, or the dynamic account access context bound to this Team query. */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  timeZone?: string;
}

export interface UsageEntitlementRequest {
  /** After a purchase or claim completes, invalidate the corresponding Start Plan balance short-term cache. */
  invalidateBalanceCache?: boolean;
  /** Kept for compatibility with older callers; Coding Plan entitlements must query the subscription and return a summary, and may no longer be inferred from the quota alone. */
  includeSubscription?: boolean;
  /** The chat input area may pass in the currently selected built-in provider, ensuring BigModel/Z.AI usage follows the model selection. */
  preferredProviderId?: string;
  /** A static access kind of the specified Account Provider, or a dynamic account access context already resolved at the call boundary. */
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  /** When the current model has explicitly selected that built-in provider, its key may be read even if the provider is hidden from the provider list. */
  allowDisabledPreferredProvider?: boolean;
  /** When a source is specified it must hit preferredProviderId; falling back to another provider is not allowed. */
  requirePreferredProvider?: boolean;
  /** Whether host environment variables may override the provider key. Allowed by default; explicit-provider scenarios can turn it off. */
  allowEnvApiKey?: boolean;
}

export interface UsageEntitlementSnapshot {
  generatedAt: number;
  /** Server time of the current quota response (milliseconds); kept separate from the local snapshot generation time generatedAt. */
  serverTime?: number;
  authenticated: boolean;
  unavailableReason?: "not_authenticated" | "not_configured" | "no_plan" | "unavailable";
  /** When no Start Plan is available, keeps the explicit expiry reason for display. */
  startPlanExpired?: boolean;
  /** The reason the team subscription is explicitly invalid; returned only together with no_plan. */
  teamPlanUnavailableReason?: "expired" | "unassigned";
  /** The personal / team context of the current entitlement query; the primary decision for the connection mode in the settings page. */
  context?: UsageEntitlementContext | null;
  /** The model provider info currently used to query the quota. */
  provider: UsageEntitlementProviderInfo | null;
  remaining: UsageEntitlementRemaining | null;
  subscription: UsageEntitlementSubscription | null;
  quota: UsageQuotaSnapshot | null;
  /**
   * Call quota of the official ZCode Server MCP (`/api/v1/mcp/usage`).
   * It ships in the same snapshot as quota in order to inherit the caching / in-flight coalescing / TTL policy entitlement already has;
   * it is always null when the fetch fails, when Coding Plan is not enabled, or when this quota does not belong to the connection being queried (optional data plane).
   */
  mcpQuota?: UsageMcpQuotaSnapshot | null;
}

export interface UsageEntitlementContext {
  scope: "personal" | "team";
  organizationId?: string | null;
  projectId?: string | null;
  displayName?: string | null;
  productId?: string | null;
}

export type PlanIdentityStatus = "coding_plan" | "start_plan" | "no_plan" | "unknown";

export interface PlanIdentitySnapshot {
  generatedAt: number;
  planStatus: PlanIdentityStatus;
  planProductId: string;
}

export interface UsageEntitlementRemaining {
  count: number;
  isShow: boolean;
  percentage?: number;
  nextResetTime?: number | null;
}

export interface UsageEntitlementProviderInfo {
  id: string;
  name: string;
}

export interface UsageEntitlementSubscription {
  identityType: "email" | "phoneNumber" | "unknown";
  identityMasked: string | null;
  details: UsageEntitlementSubscriptionDetail[];
}

export interface UsageEntitlementSubscriptionDetail {
  productId: string;
  productName: string;
  purchaseTime: string | null;
  beginTime: string | null;
  billingCycle?: string | null;
  renewTime?: string | null;
  expireTime: string | null;
  /** When the entitlement takes effect under a Start Plan balance plan; other subscription types may omit it. */
  entitlements?: Array<{
    entitlementId: string;
    /** Server-side entitlement show_name, used for the "pending activation" notice. */
    showName?: string | null;
    effectiveTime: string | null;
  }>;
}

export interface UsageStatsSnapshot {
  range: UsageStatsRange;
  generatedAt: number;
  timeZone: string;
  estimatedTokenCharDivisor: number;
  summary: UsageStatsSummary;
  /** Daily series filled in contiguously by date, with missing dates filled as 0, ready to feed the trend chart directly. */
  daily: UsageStatsDaySummary[];
  heatmap: UsageStatsHeatmap;
  models: UsageStatsModelUsage[];
  /**
   * Data source identifier: lets the UI tell a provider monitor interface apart from local session aggregation data.
   * App Usage explicitly reads the local session aggregation; Coding Plan explicitly reads the current provider monitor.
   */
  source?: "bigmodel-monitor" | "local";
  /** The provider the remote usage came from, used by the UI to show sources such as BigModel / Z.AI. */
  sourceProvider?: UsageEntitlementProviderInfo | null;
  /** Tool-call dimension (only available from the BigModel tool-usage interface; left unset for local aggregation). */
  tools?: UsageStatsToolUsage[];
}

// ──App Usage (real statistics of agent database)────────────────────────────────
export const APP_USAGE_RANGES = ["all", "7d", "30d"] as const;
export type AppUsageRange = (typeof APP_USAGE_RANGES)[number];

export const appUsageFavoriteModelSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  share: z.number(),
});

export const appUsageSummarySchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheHitRate: z.number(),
  totalSessions: z.number(),
  totalTurns: z.number(),
  toolCallCount: z.number(),
  toolErrorRate: z.number(),
  modelErrorRate: z.number(),
  avgTimeToFirstTokenMs: z.number().nullable(),
  avgTurnDurationMs: z.number().nullable(),
  activeDays: z.number(),
  currentStreakDays: z.number(),
  longestSessionMs: z.number(),
  longestStreakDays: z.number(),
  peakDayTokens: z.number(),
  favoriteModel: appUsageFavoriteModelSchema.nullable(),
});

export const appUsageHeatmapCellSchema = z.object({
  date: z.string(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  totalTokens: z.number(),
  turnCount: z.number(),
  toolCallCount: z.number(),
});

export const appUsageHeatmapWeekSchema = z.object({
  weekIndex: z.number(),
  days: z.array(appUsageHeatmapCellSchema.nullable()),
});

export const appUsageHeatmapSchema = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  maxTokens: z.number(),
  weeks: z.array(appUsageHeatmapWeekSchema),
});

export const appUsageDailyModelItemSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
});

export const appUsageDailyModelUsageSchema = z.object({
  date: z.string(),
  models: z.array(appUsageDailyModelItemSchema),
});

export const appUsageModelUsageSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  requestCount: z.number(),
  share: z.number(),
});

export const appUsageToolUsageSchema = z.object({
  toolName: z.string(),
  callCount: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
  avgDurationMs: z.number().nullable(),
});

export const appUsageSnapshotSchema = z.object({
  range: z.enum(APP_USAGE_RANGES),
  generatedAt: z.number(),
  timeZone: z.string(),
  source: z.literal("agent-db"),
  summary: appUsageSummarySchema,
  heatmap: appUsageHeatmapSchema,
  dailyModelUsage: z.array(appUsageDailyModelUsageSchema),
  models: z.array(appUsageModelUsageSchema),
  tools: z.array(appUsageToolUsageSchema),
});

export type AppUsageSummary = z.infer<typeof appUsageSummarySchema>;
export type AppUsageHeatmapCell = z.infer<typeof appUsageHeatmapCellSchema>;
export type AppUsageHeatmapWeek = z.infer<typeof appUsageHeatmapWeekSchema>;
export type AppUsageHeatmap = z.infer<typeof appUsageHeatmapSchema>;
export type AppUsageDailyModelItem = z.infer<typeof appUsageDailyModelItemSchema>;
export type AppUsageDailyModelUsage = z.infer<typeof appUsageDailyModelUsageSchema>;
export type AppUsageModelUsage = z.infer<typeof appUsageModelUsageSchema>;
export type AppUsageToolUsage = z.infer<typeof appUsageToolUsageSchema>;
export type AppUsageFavoriteModel = z.infer<typeof appUsageFavoriteModelSchema>;
export type AppUsageSnapshot = z.infer<typeof appUsageSnapshotSchema>;

export interface AppUsageRequest {
  range: AppUsageRange;
  timeZone?: string;
}

export interface CodingPlanUsageSnapshot {
  range: CodingPlanUsageRange;
  rangeStartDate: string;
  rangeEndDate: string;
  generatedAt: number;
  sourceProvider: UsageEntitlementProviderInfo;
  quota: UsageQuotaSnapshot | null;
  activity: CodingPlanActivitySnapshot;
  detail: CodingPlanUsageDetailSnapshot;
  modelUsage: CodingPlanModelUsageSnapshot;
  toolUsage: CodingPlanToolUsageSnapshot;
  health: CodingPlanHealthSnapshot;
}

export interface CodingPlanActivitySnapshot {
  summary: CodingPlanActivitySummary;
  heatmap: AppUsageHeatmap;
}

export interface CodingPlanActivitySummary {
  totalTokens: number;
  peakDailyTokens: number;
  peakDailyTokensDate: string | null;
  totalUsageDurationMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  favoriteModelName: string | null;
}

export interface CodingPlanUsageDetailSnapshot {
  model: CodingPlanUsageDetailSummary;
  tool: CodingPlanUsageDetailSummary;
}

export interface CodingPlanUsageDetailSummary {
  cacheHitRate: number | null;
  cacheHitRateTrend: number | null;
  totalCredits: number;
  totalCreditsTrend: number | null;
  averageDailyCredits: number;
  averageDailyCreditsTrend: number | null;
}

export interface CodingPlanModelUsageSnapshot {
  xTime: string[];
  granularity: CodingPlanUsageGranularity;
  totalModelCallCount: number;
  totalTokensUsage: number;
  modelDataList: CodingPlanModelData[];
  modelSummaryList: CodingPlanModelSummary[];
}

export interface CodingPlanModelData {
  modelName: string;
  sortOrder: number;
  tokensUsage: number[];
  creditsUsage?: number[];
  cachedInputTokensUsage?: number[];
  uncachedInputTokensUsage?: number[];
  outputTokensUsage?: number[];
  cachedInputCreditsUsage?: number[];
  uncachedInputCreditsUsage?: number[];
  outputCreditsUsage?: number[];
  totalTokens: number;
  totalCredits?: number;
}

export interface CodingPlanModelSummary {
  modelName: string;
  totalTokens: number;
  totalCredits?: number;
  sortOrder: number;
}

export interface CodingPlanToolUsageSnapshot {
  xTime: string[];
  granularity: CodingPlanUsageGranularity;
  toolDataList: CodingPlanToolData[];
  toolSummaryList: CodingPlanToolSummary[];
}

export interface CodingPlanToolData {
  toolCode: string;
  toolName: string;
  sortOrder: number;
  usageCount: number[];
  creditsUsage?: number[];
  totalUsageCount: number;
  totalCredits?: number;
}

export interface CodingPlanToolSummary {
  toolCode: string;
  toolName: string;
  totalUsageCount: number;
  totalCredits?: number;
  sortOrder: number;
}

export interface CodingPlanHealthSnapshot {
  xTime: string[];
  proMaxDecodeSpeed: number[];
  liteDecodeSpeed: number[];
}

export interface UsageStatsToolUsage {
  /** Internal tool code: search-prime / web-reader / zread / search-mcp, etc. */
  toolCode: string;
  /** Human-readable name used for display. */
  displayName: string;
  totalCalls: number;
  /** Call counts per day, the same length as daily, to make plotting the trend easy. */
  dailyCalls: number[];
}

export interface UsageStatsSummary {
  totalSessions: number;
  totalMessages: number;
  totalCharacters: number;
  totalEstimatedTokens: number;
  activeDays: number;
  mostActiveDay: UsageStatsDaySummary | null;
  favoriteModel: UsageStatsFavoriteModel | null;
  longestSessionMs: number;
  longestStreakDays: number;
  currentStreakDays: number;
  firstActivityDate: string | null;
  lastActivityDate: string | null;
  peakHour: UsageStatsPeakHour | null;
}

export interface UsageStatsPeakHour {
  hour: number;
  totalEstimatedTokens: number;
  messageCount: number;
}

export interface UsageStatsFavoriteModel {
  modelId: string | null;
  totalCharacters: number;
  totalEstimatedTokens: number;
  share: number;
}

export interface UsageStatsDaySummary {
  date: string;
  label: string;
  totalCharacters: number;
  totalEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  activityScore: number;
}

export interface UsageStatsHeatmap {
  startDate: string | null;
  endDate: string | null;
  maxActivityScore: number;
  weeks: UsageStatsHeatmapWeek[];
  monthLabels: UsageStatsHeatmapMonthLabel[];
}

export interface UsageStatsHeatmapWeek {
  weekIndex: number;
  days: Array<UsageStatsHeatmapCell | null>;
}

export interface UsageStatsHeatmapMonthLabel {
  weekIndex: number;
  date: string;
}

export interface UsageStatsHeatmapCell {
  date: string;
  level: 0 | 1 | 2 | 3 | 4;
  totalCharacters: number;
  totalEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  activityScore: number;
}

export interface UsageStatsModelUsage {
  modelId: string | null;
  totalCharacters: number;
  totalEstimatedTokens: number;
  inputCharacters: number;
  inputEstimatedTokens: number;
  outputCharacters: number;
  outputEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  share: number;
}
