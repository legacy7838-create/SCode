import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

function normalizeQuotaModel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^model:/u, "")
    .replace(/_/gu, "-");
}

export function bucketMatchesModel(bucket: UsageQuotaLimit, modelId: string): boolean {
  return bucket.usageDetails.some(
    (detail) => normalizeQuotaModel(detail.modelCode) === normalizeQuotaModel(modelId),
  );
}

export function getActiveModelBuckets(
  snapshot: UsageEntitlementSnapshot,
  now = snapshot.serverTime ?? snapshot.generatedAt,
): UsageQuotaLimit[] {
  return (snapshot.quota?.limits ?? []).filter(
    (bucket) =>
      (!bucket.meter || bucket.meter === "model_usage") &&
      (bucket.nextResetTime === undefined || bucket.nextResetTime > now) &&
      (bucket.periodStart === undefined || bucket.periodStart <= now) &&
      (bucket.periodEnd === undefined || bucket.periodEnd > now),
  );
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function bucketRemainingRatio(bucket: UsageQuotaLimit): number | null {
  // Use the real remaining quota of the same bucket; available (minus pre-emption) cannot be regarded as remaining.
  if (finite(bucket.remaining) && finite(bucket.number) && bucket.number > 0) {
    return bucket.remaining / bucket.number;
  }
  return finite(bucket.percentage) ? bucket.percentage : null;
}

export function allBucketsExhausted(buckets: UsageQuotaLimit[]): boolean {
  // Only looking at the first bucket will falsely report "the active bucket is exhausted and the daily bucket still has quota" as model exhaustion; unknown values ​​cannot be treated as 0.
  return (
    buckets.length > 0 &&
    buckets.every((bucket) =>
      finite(bucket.remaining) ? bucket.remaining <= 0 : bucketRemainingRatio(bucket) === 0,
    )
  );
}

export function bucketReminderKey(bucket: UsageQuotaLimit): string | null {
  if (
    !bucket.bucketId?.trim() ||
    !finite(bucket.periodStart) ||
    !finite(bucket.periodEnd) ||
    bucket.periodStart < 0 ||
    bucket.periodEnd <= bucket.periodStart
  )
    return null;
  // Bucket identification isolates accounts/packages; when serving multiple models in the same bucket, it is only reminded once, and tasks and balances are not written into the key.
  return JSON.stringify([bucket.bucketId.trim(), bucket.periodStart, bucket.periodEnd]);
}
