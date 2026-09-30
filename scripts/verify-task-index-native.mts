/**
 * End-to-end check that TypeScript reaches the Rust task-index engine.
 *
 * Runs the real compiled `.node` against a **copy** of the real
 * `~/.zcode/v2/tasks-index.sqlite`, so the checks cover the schema, the migration ledger and
 * the stored key formats rather than a hand-written fixture.
 *
 * Usage (from the repo root):
 *   ZCODE_NATIVE_DIR=packages/rust node_modules/.bin/tsx scripts/verify-task-index-native.mts
 */
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

import { TaskIndexStore } from "../packages/rust/src/taskIndex.ts";

const realDatabase = join(homedir(), ".zcode/v2/tasks-index.sqlite");
if (!existsSync(realDatabase)) {
  console.log("[skipped] no real ~/.zcode/v2/tasks-index.sqlite on this machine.");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "zcode-task-index-e2e-"));
const copy = join(workspace, "tasks-index.sqlite");
copyFileSync(realDatabase, copy);

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const store = new TaskIndexStore({ path: copy });

// The declared migrations, with the checksum input already stringified. If the checksum rule
// were wrong, every one of these would mismatch against the real ledger.
await store.ensureReady(
  [
    {
      id: "0002_provider_selection",
      sql: "",
      checksumInputJson: '["legacy-automation-selection-v1","no-provider-for-legacy-off-peak-v1"]',
    },
  ],
  Date.now(),
);
check("ensureReady accepts the real ledger without a checksum mismatch", true);

// Read path.
const rows = await store.listTasks({ includeArchived: true, limit: 50 });
check("listTasks returns rows from the real schema", rows.length > 0, `${rows.length} rows`);
check(
  "a row carries the columns the renderer needs",
  typeof rows[0]?.taskId === "string" && typeof rows[0]?.searchableText === "string",
);
check("no search means no snippets", (rows[0]?.snippets ?? []).length === 0);

// The search path, including the paragraph fallback.
const searched = await store.listTasks({ includeArchived: true, search: "the" });
check(
  "a search returns rows with snippets attached",
  searched.length > 0 && searched.every((row) => row.snippets.length > 0),
  `${searched.length} rows`,
);

// The two sibling facades over the same connection.
const active = await store.offpeakCountActive();
const nonTerminal = await store.offpeakCountNonTerminal();
check(
  "the off-peak counters read the same file",
  nonTerminal >= active,
  `active=${active} nonTerminal=${nonTerminal}`,
);

const missing = await store.automationHasTaskBinding("definitely-not-a-row");
check("a missing automation reads as false, not an error", missing === false);

const count = await store.automationScheduledRunCount("definitely-not-a-row");
check("a missing run count reads as null, not an error", count === null);

// The claim: a compare-and-swap, and this copy has no due rows to claim.
const claimed = await store.automationClaimDue(Date.now());
check("automationClaimDue runs against the real schema", Array.isArray(claimed), `${claimed.length} claimed`);

// Closing, then a call must be refused rather than silently reopening.
store.close();
let refused = false;
try {
  await store.listTasks({});
} catch {
  refused = true;
}
check("a call after close is refused, not silently served", refused);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
