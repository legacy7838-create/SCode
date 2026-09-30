#!/usr/bin/env node
/**
 * Captures JavaScript `Date` ground truth for the zcode-cron parity fixtures.
 *
 * The point of generating this rather than hand-writing it: two of the expectations originally
 * written by hand in `tests/parity_dates.rs` were wrong. `new Date(2025, 1, 0).getDate()` is
 * 31 (the last day of *January*, not February), and `new Date(2025, 0, -3)` is 28 December,
 * not 29 December. Running Node is the only reliable way to pin `Date` semantics, and the
 * legacy TypeScript this port replaces is defined in terms of them.
 *
 * Run with TZ pinned, because the fixture records local-time behaviour:
 *   TZ=UTC node packages/rust/crates/zcode-cron/scripts/capture-date-ground-truth.mjs
 *
 * See docs/specs/rust-native-cron.md §3 and §6.1.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, "..", "tests", "fixtures", "date-ground-truth.json");

if (process.env.TZ !== "UTC") {
  console.warn(
    `[capture-date-ground-truth] TZ is ${process.env.TZ ?? "unset"}; the fixture records ` +
      "local-time behaviour, so re-run with TZ=UTC to keep it comparable.",
  );
}

/**
 * Each case is a `(year, month0, day, hour, minute)` tuple passed to
 * `new Date(y, m, d, h, mi, 0, 0)`, which is the `atTime` helper at
 * `automationCron.ts:129` and the `day_in_month` rollover.
 */
const CASES = [
  // Hour/minute overflow must roll the date, not be reduced into range.
  ["hour_overflow_rolls_day", 2025, 0, 1, 25, 0],
  ["minute_overflow_rolls_hour", 2025, 0, 1, 0, 70],
  // The February case the yearly branch's `getMonth() !== targetMonth` guard depends on.
  ["feb29_non_leap_rolls_to_march", 2025, 1, 29, 9, 30],
  ["feb29_leap_stays", 2024, 1, 29, 9, 30],
  ["feb31_rolls_far", 2025, 1, 31, 0, 0],
  // Day 0 is the last day of the *previous* month, and negative days roll further back.
  ["day_zero_feb_is_jan31", 2025, 1, 0, 0, 0],
  ["day_zero_mar_is_feb28", 2025, 2, 0, 0, 0],
  ["negative_day", 2025, 0, -3, 0, 0],
  // Month overflow, and the two century leap-year rules.
  ["month_overflow", 2025, 12, 1, 0, 0],
  ["leap_day_boundary", 2000, 1, 29, 12, 0],
  ["non_leap_century", 1900, 1, 29, 0, 0],
];

const rows = CASES.map(([name, year, month0, day, hour, minute]) => {
  const at = new Date(year, month0, day, hour, minute, 0, 0);
  return {
    name,
    input: { year, month0, day, hour, minute },
    expect: {
      year: at.getFullYear(),
      month0: at.getMonth(),
      day: at.getDate(),
      hour: at.getHours(),
      minute: at.getMinutes(),
      epochMs: at.getTime(),
    },
  };
});

writeFileSync(outputPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(`[capture-date-ground-truth] wrote ${rows.length} rows to ${outputPath}`);
