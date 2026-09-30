export type CodingPlanResetType = "FIVE_HOUR" | "WEEK";

export interface CodingPlanResetScopeRequest {
  preferredProviderId: string;
  /** Registry statically accesses the category, or calls the Team scope whose boundaries have been resolved. */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export interface CodingPlanResetOpportunitySnapshot {
  expireAt: number;
}

export interface CodingPlanResetHistorySnapshot {
  usedAt: number;
}

export interface CodingPlanResetStatusSnapshot {
  availableFiveHourResets: CodingPlanResetOpportunitySnapshot[];
  availableWeekResets: CodingPlanResetOpportunitySnapshot[];
  latestFiveHourResetHistory: CodingPlanResetHistorySnapshot | null;
  latestWeekResetHistory: CodingPlanResetHistorySnapshot | null;
  hasUnreadHistory: boolean;
}

export interface CodingPlanResetOpportunityRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
}

export interface CodingPlanResetOpportunityResult {
  granted: boolean;
  nextTryAt: number | null;
}

export interface CodingPlanResetUseRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
  resetType: CodingPlanResetType;
}

export interface CodingPlanResetUseResult {
  used: true;
}
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "./zcode-protocol/index.js";
