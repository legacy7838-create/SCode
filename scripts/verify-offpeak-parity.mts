/**
 * Differential check for the off-peak task repository: the captured JavaScript transcript against
 * the Rust port.
 *
 * The fixture at `packages/rust/crates/zcode-task-index/tests/fixtures/offpeak_transcript.json` was
 * produced by `scripts/capture-offpeak-ground-truth.mts` **before** the TypeScript was removed, by
 * driving the original repository through every state transition and every guard and recording each
 * return value.
 *
 * This script replays the identical sequence through `@zcode/rust/task-index` and compares entry by
 * entry. The guards are what matter — `markTerminal` refusing a second transition, `setPaused`
 * requiring an unclaimed row, `updateEditableFields` rejecting a null selection, `markSettled`
 * touching only terminal rows, `invalidateModelSelection` declining to overwrite a repair — and a
 * self-consistent implementation can get every one of them wrong.
 *
 * Usage (from the repo root):
 *   ZCODE_NATIVE_DIR="$PWD/packages/rust" node_modules/.bin/tsx scripts/verify-offpeak-parity.mts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskIndexStore } from "../packages/rust/src/taskIndex.ts";
import { OffPeakRepository } from "../packages/rust/src/offPeakRepository.ts";
import { tasksDatabaseMigrationsForNative } from "../packages/services/src/session/tasksDatabase/migrations.ts";

const STALE = 10 * 60_000;

interface Entry {
  label: string;
  value: unknown;
}
const transcript = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "packages/rust/crates/zcode-task-index/tests/fixtures/offpeak_transcript.json",
    ),
    "utf-8",
  ),
) as Entry[];

/** The recorded value for a label, so the replay can be asserted entry by entry. */
const expected = new Map(transcript.map((entry) => [entry.label, entry.value]));

const workspace = mkdtempSync(join(tmpdir(), "zcode-offpeak-parity-"));
const dbPath = join(workspace, "tasks-index.sqlite");

const store = new TaskIndexStore({ path: dbPath });
// The same migration list the JavaScript ran, with the checksum inputs already stringified.
await store.ensureReady(tasksDatabaseMigrationsForNative(), Date.now());
// One native handle, one connection, one ledger: the repository wraps the same store.
const repo = new OffPeakRepository(store);

let compared = 0;
let mismatches = 0;
const replayed = new Set<string>();
const failures: string[] = [];

/**
 * Compares one replayed value against the captured JavaScript one.
 *
 * The comparison is on the **JSON projection**, not object identity, so an omitted optional field
 * and a missing key are treated as the same thing — which is the contract: `rowToTask` maps
 * `row.x ?? undefined`, and a `null` would be a different value to any consumer testing
 * `'field' in task`.
 */
/**
 * A key-level diff of two JSON values.
 *
 * Truncating both sides to a fixed width hid the actual difference: with two 900-character task
 * objects the first 220 characters are identical, so every failure looked the same. Naming the
 * differing keys is what makes a failure actionable.
 */
const describeDifference = (want: unknown, actual: unknown): string => {
  if (Array.isArray(want) && Array.isArray(actual)) {
    if (want.length !== actual.length) {
      return `    length: rust=${actual.length} js=${want.length}`;
    }
    const lines = [`    ${want.length} item(s); per-item differences:`];
    for (let index = 0; index < want.length; index += 1) {
      const one = describeDifference(want[index], actual[index]);
      if (one.trim()) lines.push(`    [${index}] ${one.trim()}`);
    }
    return lines.filter((line) => !line.endsWith("differences:") || line.includes("length")).join("\n") || "    (identical)";
  }
  if (want && actual && typeof want === "object" && typeof actual === "object") {
    const keys = new Set([...Object.keys(want), ...Object.keys(actual)]);
    const lines: string[] = [];
    for (const key of keys) {
      const a = JSON.stringify((actual as Record<string, unknown>)[key]);
      const b = JSON.stringify((want as Record<string, unknown>)[key]);
      if (a !== b) {
        if (a === undefined) lines.push(`    - ${key} is absent in rust, js has ${b}`);
        else if (b === undefined) lines.push(`    + ${key} only in rust: ${a}`);
        else lines.push(`    ~ ${key}: rust=${a} js=${b}`);
      }
    }
    return lines.join("\n") || "    (identical)";
  }
  return `    rust=${JSON.stringify(actual)} js=${JSON.stringify(want)}`;
};

const check = (label: string, actual: unknown): void => {
  if (!expected.has(label)) {
    failures.push(`${label}: present in the Rust replay, absent from the captured transcript`);
    mismatches += 1;
    return;
  }
  const want = expected.get(label);
  compared += 1;
  replayed.add(label);
  const actualJson = JSON.stringify(actual ?? null);
  const wantJson = JSON.stringify(want ?? null);
  if (actualJson !== wantJson) {
    mismatches += 1;
    failures.push(`${label}\n${describeDifference(want, actual)}`);
  }
};

const selection = (providerId: string, modelId: string, reasoningLevel?: string) => ({
  providerId,
  modelId,
  options: reasoningLevel ? { reasoningLevel } : {},
});
const base = {
  title: "nightly",
  prompt: "do the thing",
  permissionMode: "default",
  workspacePath: "/ws/a",
  workspaceIdentity: "ws-a",
};

check(
  "create.schedulable",
  await repo.offpeakCreate({
    ...base,
    offPeakTaskId: "op-1",
    modelSelection: selection("p1", "m1", "high"),
    serverTicketId: "tk-1",
    queuePosition: 1,
    schedulable: true,
    now: 1_000,
  }),
);
check(
  "create.plain",
  await repo.offpeakCreate({
    ...base,
    offPeakTaskId: "op-2",
    title: "not schedulable",
    modelSelection: selection("p1", "m2"),
    now: 2_000,
  }),
);
check(
  "create.otherWorkspace",
  await repo.offpeakCreate({
    ...base,
    offPeakTaskId: "op-3",
    workspacePath: "/ws/b",
    workspaceIdentity: "ws-b",
    title: "other workspace",
    modelSelection: selection("p2", "m1"),
    schedulable: true,
    now: 3_000,
  }),
);
check(
  "create.broken",
  await repo.offpeakCreate({
    ...base,
    offPeakTaskId: "op-broken",
    title: "broken selection",
    modelSelection: selection("p1", "m3"),
    schedulable: true,
    now: 4_000,
  }),
);

check("list.all", await repo.offpeakList());
check("list.scoped", await repo.offpeakList("ws-a"));
check("list.scopedOther", await repo.offpeakList("ws-b"));
check("get.op-1", await repo.offpeakGet("op-1"));
check("get.missing", await repo.offpeakGet("no-such-id"));
check("listNonTerminal", await repo.offpeakListNonTerminal());
check("listUnsettledTerminal", await repo.offpeakListUnsettledTerminal());
check("countNonTerminal", await repo.offpeakCountNonTerminal());
check("countActive", await repo.offpeakCountActive());
check("hasActiveBoundTask", await repo.offpeakHasActiveBoundTask("ws-a", "sess-1"));
check("hasActiveBoundTask.miss", await repo.offpeakHasActiveBoundTask("ws-a", "sess-nope"));

check("claimDue.first", await store.offpeakClaimDue(5_000));
check("claimDue.again", await store.offpeakClaimDue(5_000));
check("get.afterClaim", await repo.offpeakGet("op-1"));

check("setPaused.whileClaimed", await repo.offpeakSetPaused("op-1", true, 6_000));
check("setPaused.unclaimed", await repo.offpeakSetPaused("op-2", true, 6_100));
check("setPaused.resume", await repo.offpeakSetPaused("op-2", false, 6_200));

check("releaseClaim", await repo.offpeakReleaseClaim("op-1", { error: "boom", now: 7_000 }));
check("get.afterRelease", await repo.offpeakGet("op-1"));
check("claimDue.second", await store.offpeakClaimDue(7_100));

check(
  "markRunning",
  await repo.offpeakMarkRunning("op-1", {
    startedAt: 8_000,
    conversationId: "conv-1",
    sessionId: "sess-1",
    serverTicketId: "tk-1",
  }),
);
check("markRunning.again", await repo.offpeakMarkRunning("op-1", { startedAt: 8_500 }));
check("markRunning.missing", await repo.offpeakMarkRunning("no-such-id", { startedAt: 8_600 }));

check(
  "markTerminal",
  await repo.offpeakMarkTerminal("op-1", { status: "completed", endedAt: 9_000, filesChanged: 3 }),
);
check(
  "markTerminal.again",
  await repo.offpeakMarkTerminal("op-1", {
    status: "failed",
    endedAt: 9_500,
    failureReason: "late result",
  }),
);
check("get.afterTerminal", await repo.offpeakGet("op-1"));

check("markSettled.terminal", await repo.offpeakMarkSettled("op-1", 10_000));
check("markSettled.nonTerminal", await repo.offpeakMarkSettled("op-2", 10_100));
check("get.afterSettled", await repo.offpeakGet("op-1"));
check("listUnsettledTerminal.after", await repo.offpeakListUnsettledTerminal());

check("markHistoryDeleted.started", await repo.offpeakMarkHistoryDeleted("op-1", 11_000));
check("markHistoryDeleted.idempotent", await repo.offpeakMarkHistoryDeleted("op-1", 11_500));
check("markHistoryDeleted.notStarted", await repo.offpeakMarkHistoryDeleted("op-2", 11_600));

check(
  "updateEditableFields",
  await repo.offpeakUpdateEditableFields("op-2", { title: "renamed", modelSelection: selection("p1", "m2", "low") }, 12_000),
);
check(
  "updateEditableFields.nullSelection",
  await repo.offpeakUpdateEditableFields("op-2", { title: "nope", modelSelection: null }, 12_100),
);
check("updateEditableFields.terminal", await repo.offpeakUpdateEditableFields("op-1", { title: "nope" }, 12_200));
check("updateEditableFields.missing", await repo.offpeakUpdateEditableFields("no-such-id", { title: "x" }, 12_300));

check("updateSchedulingSnapshot", await repo.offpeakUpdateSchedulingSnapshot("op-2", {
  schedulable: true,
  queuePosition: 9,
  nextPollAt: 13_000,
  now: 13_100,
}));
check("get.afterSnapshot", await repo.offpeakGet("op-2"));
check("updateSchedulingSnapshot.partial", await repo.offpeakUpdateSchedulingSnapshot("op-2", { now: 13_200 }));
check("get.afterPartialSnapshot", await repo.offpeakGet("op-2"));
check("updateSchedulingSnapshot.missing", await repo.offpeakUpdateSchedulingSnapshot("no-such-id", { now: 13_300 }));

check("invalidateModelSelection", await repo.offpeakInvalidateModelSelection("op-2", selection("p1", "m2", "low"), 14_000));
check("invalidateModelSelection.repaired", await repo.offpeakInvalidateModelSelection("op-2", selection("stale", "stale-model"), 14_100));
check("invalidateModelSelection.missing", await repo.offpeakInvalidateModelSelection("no-such-id", selection("p", "m"), 14_200));

check("claimDue.skipsBroken", await store.offpeakClaimDue(15_000));

check("requeueForContinuation.notRunning", await repo.offpeakRequeueForContinuation("op-2", 16_000));
check("markRunning.op2", await repo.offpeakMarkRunning("op-2", { startedAt: 16_100, sessionId: "sess-1" }));
check("requeueForContinuation.running", await repo.offpeakRequeueForContinuation("op-2", 16_200));
check("get.afterRequeue", await repo.offpeakGet("op-2"));
check("requeueForContinuation.terminal", await repo.offpeakRequeueForContinuation("op-1", 16_300));

check("releaseClaim.noError", await repo.offpeakReleaseClaim("op-2", { now: 17_000 }));
check("markRunning.op3", await repo.offpeakMarkRunning("op-3", { startedAt: 17_100, sessionId: "sess-b" }));
check("countActive.beforeRecover", await repo.offpeakCountActive());
check("get.beforeRecover", await repo.offpeakList("ws-a"));
check("recoverInterrupted", await repo.offpeakRecoverInterrupted(18_000));
check("get.afterRecover", await repo.offpeakList("ws-a"));

check("claimDue.forStale", await store.offpeakClaimDue(19_000));
check("claimDue.pastStale", await store.offpeakClaimDue(19_000 + STALE + 1));
check("claimDue.fresh", await store.offpeakClaimDue(19_000 + STALE + 2));

check("delete", await repo.offpeakDelete("op-3"));
check("get.afterDelete", await repo.offpeakGet("op-3"));
check("delete.missing", await repo.offpeakDelete("no-such-id"));

// The bound-session unique index: the loser of a concurrent double create must be identifiable.
await repo.offpeakCreate({ ...base, offPeakTaskId: "op-conflict", modelSelection: selection("p", "m"), now: 20_000 });
await repo.offpeakCreate({
  ...base,
  offPeakTaskId: "op-dup",
  sessionId: "sess-dup",
  modelSelection: selection("p", "m"),
  now: 20_100,
});
let conflict = false;
try {
  await repo.offpeakCreate({
    ...base,
    offPeakTaskId: "op-dup2",
    sessionId: "sess-dup",
    modelSelection: selection("p", "m"),
    now: 20_200,
  });
} catch (error) {
  conflict = /UNIQUE constraint failed: off_peak_tasks\.workspace_key, off_peak_tasks\.session_id/.test(
    (error as Error).message,
  );
}
check("boundSessionConflict", conflict);

check("final.list", await repo.offpeakList());
check("final.countNonTerminal", await repo.offpeakCountNonTerminal());
check("final.countActive", await repo.offpeakCountActive());
check("final.hasActiveBoundTask", await repo.offpeakHasActiveBoundTask("ws-a", "sess-1"));

store.close();

for (const failure of failures) console.log(`FAIL  ${failure}`);
const unreplayedLabels = transcript
  .map((entry) => entry.label)
  .filter((label) => !replayed.has(label));
for (const label of unreplayedLabels) {
  console.log(`SKIP  ${label} — present in the transcript, not asserted here`);
}
console.log(
  `\n${compared - mismatches}/${compared} replayed entries match the captured JavaScript transcript` +
    ` (${mismatches} mismatched, ${unreplayedLabels.length} of ${transcript.length} labels not replayed)`,
);
process.exit(mismatches ? 1 : 0);
