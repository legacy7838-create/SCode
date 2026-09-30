import type { UsageEntitlementSnapshot } from "@zcode/shared";
import { hasActiveCodingPlanSnapshot } from "@/CodingPlanUsageRemainingPanel.js";

type SidebarFooterProfilePlanBadge =
  | {
      audience: "individual";
      snapshot: UsageEntitlementSnapshot;
    }
  | {
      audience: "team";
      snapshot?: never;
    };

export function resolveSidebarFooterProfilePlanBadge({
  hasTeamPlanEntitlement,
  individualEntitlements,
}: {
  hasTeamPlanEntitlement: boolean;
  individualEntitlements: Array<{
    providerId: string;
    snapshot: UsageEntitlementSnapshot | null;
    loading?: boolean;
  }>;
}): SidebarFooterProfilePlanBadge | null {
  const activeIndividualEntitlement = individualEntitlements.find((entitlement) =>
    hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
  );
  if (activeIndividualEntitlement?.snapshot) {
    return {
      audience: "individual",
      snapshot: activeIndividualEntitlement.snapshot,
    };
  }

  if (individualEntitlements.some((entitlement) => entitlement.loading)) {
    return null;
  }

  // The logo next to the avatar only shows confirmed rights and interests. Personal rights show the package level; teams are shown only when there are no personal rights but team rights.
  // The current connection method or historical selectedKey cannot be regarded as Team, otherwise Team will be displayed by mistake after switching family.
  return hasTeamPlanEntitlement ? { audience: "team" } : null;
}

export function resolveSidebarFooterPlanBadgeLabel(
  snapshot: UsageEntitlementSnapshot | null,
): string | null {
  if (!snapshot || snapshot.unavailableReason === "no_plan") {
    return null;
  }

  const rawLabel =
    snapshot.quota?.level?.trim() || snapshot.subscription?.details[0]?.productName?.trim() || null;
  if (!rawLabel) {
    return null;
  }

  const withoutPrefix = rawLabel.replace(/^glm\s+coding\s+/i, "").trim();
  const normalized = withoutPrefix || rawLabel;
  return normalized.length > 0 ? normalizePlanBadgeWordCasing(normalized) : null;
}

function normalizePlanBadgeWordCasing(label: string): string {
  if (!/^[a-z][a-z0-9 -]*$/i.test(label)) {
    return label;
  }

  return label.replace(/\b[a-z][a-z0-9]*\b/gi, (word) => {
    if (word.length <= 1) {
      return word.toUpperCase();
    }
    return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
  });
}
