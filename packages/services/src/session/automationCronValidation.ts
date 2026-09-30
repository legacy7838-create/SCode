import { Cron } from "croner";

/** Validates whether a cron expression is legal (5 fields, local time zone). */
export function isValidCronExpr(cronExpr: string): boolean {
  try {
    // Croner is parsed when it is constructed, and illegal expressions will throw an error.
    new Cron(cronExpr);
    return true;
  } catch {
    return false;
  }
}
