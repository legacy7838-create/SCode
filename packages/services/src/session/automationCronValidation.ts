/**
 * Cron expression validation.
 *
 * Spec: docs/specs/rust-native-cron.md §2.1 — the legacy implementation of this file was a
 * `try { new Cron(expr) } catch { return false }` over `croner`. The engine now lives in
 * `zcode-cron`, and `croner` is no longer a dependency of this package.
 *
 * The behaviour is deliberately unchanged: a 5-field expression the scheduler can act on is
 * valid, anything else is not, and the function never throws. The parse is delegated so the
 * accepted syntax cannot drift between "what validates" and "what can be scheduled" — the
 * two being different is exactly the D1 divergence the spec enumerates.
 */
import { isValidCronExpr as nativeIsValidCronExpr } from "@zcode/rust/cron";

/** Whether a cron expression is legal (5 fields, local time zone). */
export function isValidCronExpr(cronExpr: string): boolean {
  return nativeIsValidCronExpr(cronExpr);
}
