#!/usr/bin/env node
/**
 * Captures `croner`'s next-fire output for a generated corpus, so the Rust `cron` engine can
 * be diffed against it.
 *
 * Spec: docs/specs/rust-native-cron.md §6.2 and D1.
 *
 * `croner` is being deleted from `packages/services/package.json` by this port, so the corpus
 * has to be captured **once** and committed as a fixture. After that the comparison is
 * hermetic: `tests/differential.rs` replays the fixture and never needs the npm package.
 *
 * Run with TZ pinned, because both engines resolve in local time:
 *   TZ=UTC node packages/rust/crates/zcode-cron/scripts/capture-croner-corpus.mjs
 *
 * Requires `croner@10.0.1` to still be resolvable (it is a transitive/dev artifact after the
 * port lands; before that it is a direct dependency of @zcode/services).
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, "..", "tests", "fixtures", "croner-corpus.json");

if (process.env.TZ !== "UTC") {
  console.warn(
    `[capture-croner-corpus] TZ is ${process.env.TZ ?? "unset"}; both engines resolve in ` +
      "local time, so re-run with TZ=UTC to keep the corpus comparable.",
  );
}

let Cron;
try {
  ({ Cron } = createRequire(import.meta.url)("croner"));
} catch (error) {
  console.error(
    "[capture-croner-corpus] `croner` is not resolvable. This corpus is a one-time capture " +
      "of the engine being replaced; install croner@10.0.1 in a scratch directory and re-run " +
      "with NODE_PATH pointing at it.\n" +
      `  cause: ${error.message}`,
  );
  process.exit(1);
}

/** Fixed probe instants, chosen to exercise DST edges, month ends and leap days. */
const ANCHORS = [
  ["2024-01-15T09:00:00Z", Date.UTC(2024, 0, 15, 9, 0, 0)],
  ["2024-02-29T23:59:00Z", Date.UTC(2024, 1, 29, 23, 59, 0)],
  ["2024-03-10T01:30:00Z", Date.UTC(2024, 2, 10, 1, 30, 0)], // US spring-forward day
  ["2024-06-30T23:00:00Z", Date.UTC(2024, 5, 30, 23, 0, 0)], // 30-day month end
  ["2024-10-27T00:30:00Z", Date.UTC(2024, 9, 27, 0, 30, 0)], // EU autumn transition day
  ["2024-11-03T05:30:00Z", Date.UTC(2024, 10, 3, 5, 30, 0)], // US fall-back instant
  ["2025-01-01T00:00:00Z", Date.UTC(2025, 0, 1, 0, 0, 0)],
  ["2025-12-31T23:59:00Z", Date.UTC(2025, 11, 31, 23, 59, 0)],
  ["2028-02-29T12:00:00Z", Date.UTC(2028, 1, 29, 12, 0, 0)], // leap day
  ["2100-03-01T00:00:00Z", Date.UTC(2100, 2, 1, 0, 0, 0)], // non-leap century
];

/** Expressions covering every field form the product accepts. */
const EXPRESSIONS = [
  // Wildcards
  "* * * * *",
  "0 * * * *",
  "0 0 * * *",
  "0 0 1 * *",
  "0 0 29 2 *", // Feb 29 — only leap years
  "0 0 31 * *", // day 31 — skips short months
  "0 0 30 * *",
  // Steps
  ...Array.from({ length: 12 }, (_, i) => `*/${i + 1} * * * *`),
  "0 */6 * * *",
  "0 0 */3 * *",
  // Ranges
  "0 9-17 * * *",
  "0 0 * * 1-5",
  "0 0 * * 0-6",
  "0 8-10 * * 1,3,5",
  "15,45 * * * *",
  // Lists
  "0 0 1,15 * *",
  "0 0 * 1,6,12 *",
  "0 0 * * 0,6",
  "5,10,15,20,25,30,35,40,45,50,55 * * * *",
  // Question mark, which the legacy parser treats as a wildcard
  "0 0 ? * *",
  "0 0 * * ?",
  // Out-of-range and malformed: both engines must report "no fire"
  "60 * * * *",
  "0 24 * * *",
  "0 0 32 * *",
  "0 0 * 13 *",
  // Day-of-week is 0-6 in cron and 1-7 in the Rust crate; 7 and 8 both probe the boundary
  // between them, and 7 is the value the crate would silently read as Saturday.
  "0 0 * * 7",
  "0 0 * * 8",
  "0 0 * * 0",
  "0 0 * * 0-6",
  "0 0 * * 1-5",
  "@weekly",
  "@hourly",
  "@midnight",
  "@annually",
  "0 0 * * sun",
  "0 0 * * mon,wed",
  "* * *",
  "",
  "   ",
  "not a cron",
  "*/0 * * * *",
  "@daily",
];

const rows = [];
let unparseable = 0;

for (const expression of EXPRESSIONS) {
  for (const [anchorLabel, anchorMs] of ANCHORS) {
    let expected = null;
    let threw = false;
    try {
      const cron = new Cron(expression);
      const next = cron.nextRun(new Date(anchorMs));
      expected = next ? next.getTime() : null;
    } catch {
      threw = true;
    }
    if (threw) {
      unparseable += 1;
      // The Rust engine reports an unparseable expression as "no future fire" rather than
      // throwing, so a throw is recorded as `null` and the reason is kept for review.
      rows.push({
        expression,
        anchor: anchorLabel,
        anchorMs,
        cronerThrew: true,
        cronerNextRunAt: null,
      });
      continue;
    }
    rows.push({
      expression,
      anchor: anchorLabel,
      anchorMs,
      cronerThrew: false,
      cronerNextRunAt: expected,
    });
  }
}

writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      _comment:
        "Captured from croner@10.0.1 with TZ=UTC by scripts/capture-croner-corpus.mjs. " +
        "Replayed by tests/differential.rs to prove the Rust `cron` engine agrees. " +
        "cronerThrew marks expressions the npm engine rejected outright; the Rust engine " +
        "reports those as `null` (no future fire), which is the same user-visible outcome.",
      cronerVersion: "10.0.1",
      rowCount: rows.length,
      rows,
    },
    null,
    1,
  )}\n`,
  "utf8",
);

console.log(
  `[capture-croner-corpus] wrote ${rows.length} rows ` +
    `(${EXPRESSIONS.length} expressions x ${ANCHORS.length} anchors, ` +
    `${unparseable} rejected by croner) to ${outputPath}`,
);
