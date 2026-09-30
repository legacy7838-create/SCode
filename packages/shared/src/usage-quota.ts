/**
 * Pure type definitions for Coding Plan quota.
 *
 * Split out of usage-stats.ts: once MCP quota landed, that file exceeded the oxlint max-lines(400) gate,
 * while quota is a set of types that can be described independently (it does not depend on the stats
 * aggregation structure), so after the split both sides are back under the gate.
 * This file only depends on itself; usage-stats.ts imports it one-way and re-exports, so there is no circular dependency.
 */

export interface UsageQuotaSnapshot {
  level: string | null;
  limits: UsageQuotaLimit[];
}

export interface UsageQuotaLimit {
  type: string;
  /** Server-side Start Plan quota bucket and its period identity; the period times are milliseconds, used to de-duplicate reminders. */
  bucketId?: string;
  userPlanId?: string;
  periodStart?: number;
  periodEnd?: number;
  /** Period type of the owning entitlement, e.g. daily / one_time. */
  period?: string;
  meter?: string;
  unitType?: string;
  /** Plan identity the Start Plan bucket belongs to, used only so the settings page can group the display by plan. */
  planId?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails: UsageQuotaUsageDetail[];
}

export interface UsageQuotaUsageDetail {
  modelCode: string;
  displayName?: string;
  usage: number;
}

/**
 * Synthetic value for `aggregate.type`.
 *
 * Deliberately not reusing TOKENS_LIMIT / TIME_LIMIT: `isSameLimitCategory` classifies TIME_LIMIT as a
 * tool-quota category, which would let the existing findCodingPlanQuotaLimit query falsely match the
 * MCP aggregate quota.
 */
export const MCP_USAGE_QUOTA_LIMIT_TYPE = "MCP_USAGE_LIMIT" as const;

/** The Coding Plan connection the MCP quota belongs to, so the UI can tell whether it can be shown under the current provider tab. */
export type UsageMcpQuotaScope =
  | {
      providerFamily: "zai" | "bigmodel";
      targetType: "PERSONAL";
    }
  | {
      providerFamily: "zai" | "bigmodel";
      targetType: "TEAM";
      organizationId: string;
      projectId: string;
    };

export interface UsageMcpQuotaSnapshot {
  /** Server-side server_time, in milliseconds (the API returns Unix seconds). */
  serverTime: number;
  level: string | null;
  scope: UsageMcpQuotaScope;
  /**
   * Equivalent expression of the server-side `total_usage` (total used / total quota / total remaining), which
   * reuses the existing quota bar / quota card display logic directly. Note that percentage follows the quota
   * API's convention: **fraction used**; the display side is responsible for inverting it to remaining.
   */
  aggregate: UsageQuotaLimit;
}
