import type {
  CodingPlanQuotaResetAutoPlayReservation,
  CodingPlanQuotaResetAutoPlayReservationAttempt,
} from "@/store/codingPlanQuotaResetState.js";

type CodingPlanQuotaResetAutoPlayCoordinationResult =
  | { status: "committed" }
  | { status: "released" }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };

/**
 * Bridges the async reservation and the component display boundary.
 *
 * By the time Main returns a winner the Composer may already be unmounted or have switched source,
 * so isCurrent must re-verify before played is committed. A voided winner only releases its token
 * and must not consume the global autoplay eligibility.
 */
export async function coordinateCodingPlanQuotaResetAutoPlay(params: {
  reserve: () => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  isCurrent: () => boolean;
  commit: (reservation: CodingPlanQuotaResetAutoPlayReservation) => boolean;
  release: (reservation: CodingPlanQuotaResetAutoPlayReservation) => Promise<void>;
  onCommitted: (reservation: CodingPlanQuotaResetAutoPlayReservation) => void;
}): Promise<CodingPlanQuotaResetAutoPlayCoordinationResult> {
  const attempt = await params.reserve();
  if (attempt.status === "retry") {
    return attempt;
  }
  if (attempt.status === "blocked") {
    return attempt;
  }

  const { reservation } = attempt;
  if (!params.isCurrent()) {
    await params.release(reservation);
    return { status: "released" };
  }
  if (!params.commit(reservation)) {
    await params.release(reservation);
    return { status: "released" };
  }

  params.onCommitted(reservation);
  return { status: "committed" };
}
