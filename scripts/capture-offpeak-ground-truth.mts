/**
 * Differential capture for the off-peak task repository.
 *
 * Drives the **JavaScript** implementation through one scripted sequence covering every state
 * transition and every guard, and writes the recorded result as JSON. The Rust port is then
 * asserted against that file, byte for byte.
 *
 * This is the same discipline as the cron differential corpus: asserting the Rust against itself
 * proves nothing, and this repo's bugs live in its guards (`mark_terminal` refusing a second
 * transition, `set_paused` requiring an unclaimed row, `update_editable_fields` rejecting a null
 * selection, `mark_settled` touching only terminal rows, `invalidate_model_selection` declining to
 * overwrite a repair another process already made). A self-consistent implementation can get all of
 * them wrong and still pass its own tests.
 *
 * Usage (from the repo root):
 *   node_modules/.bin/tsx scripts/capture-offpeak-ground-truth.mts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OffPeakTaskRepo } from "../packages/services/src/session/offPeakTaskRepo.ts";

const STALE = 10 * 60_000;

const workspace = mkdtempSync(join(tmpdir(), "zcode-offpeak-gt-"));
const dbPath = join(workspace, "tasks-index.sqlite");

/** The transcript. Every entry is one observable effect of one call. */
const transcript: unknown[] = [];
const record = (label: string, value: unknown): void => {
  transcript.push({ label, value });
};

const repo = new OffPeakTaskRepo(dbPath);
await repo.ensureReady();

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

// ---- create: three rows, deliberately different shapes ----
const created = await repo.create(
  { ...base, modelSelection: selection("p1", "m1", "high") },
  { now: 1_000, offPeakTaskId: "op-1", serverTicketId: "tk-1", queuePosition: 1, schedulable: true },
);
record("create.schedulable", created);

const queued = await repo.create(
  { ...base, title: "not schedulable", modelSelection: selection("p1", "m2") },
  { now: 2_000, offPeakTaskId: "op-2" },
);
record("create.plain", queued);

const other = await repo.create(
  { ...base, workspacePath: "/ws/b", workspaceIdentity: "ws-b", title: "other workspace", modelSelection: selection("p2", "m1") },
  { now: 3_000, offPeakTaskId: "op-3", schedulable: true },
);
record("create.otherWorkspace", other);

// A row with no valid model selection, which the claim must skip rather than block on.
const brokenSelection = await repo.create(
  { ...base, title: "broken selection", modelSelection: selection("p1", "m3") },
  { now: 4_000, offPeakTaskId: "op-broken", schedulable: true },
);
record("create.broken", brokenSelection);

// ---- reads ----
record("list.all", await repo.list());
record("list.scoped", await repo.list({ workspacePath: "/ws/a", workspaceIdentity: "ws-a" }));
record("list.scopedOther", await repo.list({ workspacePath: "/ws/b", workspaceIdentity: "ws-b" }));
record("get.op-1", await repo.get("op-1"));
record("get.missing", await repo.get("no-such-id"));
record("listNonTerminal", await repo.listNonTerminal());
record("listUnsettledTerminal", await repo.listUnsettledTerminal());
record("countNonTerminal", await repo.countNonTerminal());
record("countActive", await repo.countActive());
record("hasActiveBoundTask", await repo.hasActiveBoundTask("ws-a", "sess-1"));
record("hasActiveBoundTask.miss", await repo.hasActiveBoundTask("ws-a", "sess-nope"));

// ---- claimDue: op-1 is schedulable, op-2 is not, op-3 belongs to another workspace ----
record("claimDue.first", await repo.claimDue(5_000));
// A second claim in the same instant must find nothing: the claim is single-flight.
record("claimDue.again", await repo.claimDue(5_000));
record("get.afterClaim", await repo.get("op-1"));

// ---- setPaused while claimed must refuse: the row is in flight ----
record("setPaused.whileClaimed", await repo.setPaused("op-1", true, { now: 6_000 }));
// op-2 is unclaimed, so pausing works.
record("setPaused.unclaimed", await repo.setPaused("op-2", true, { now: 6_100 }));
record("setPaused.resume", await repo.setPaused("op-2", false, { now: 6_200 }));

// ---- releaseClaim, then re-claim ----
record("releaseClaim", await repo.releaseClaim("op-1", { error: "boom", now: 7_000 }));
record("get.afterRelease", await repo.get("op-1"));
record("claimDue.second", await repo.claimDue(7_100));

// ---- markRunning: only from queued, and it backfills ----
record("markRunning", await repo.markRunning("op-1", {
  startedAt: 8_000,
  conversationId: "conv-1",
  sessionId: "sess-1",
  serverTicketId: "tk-1",
}));
// A second transition from running must be refused.
record("markRunning.again", await repo.markRunning("op-1", { startedAt: 8_500 }));
// markRunning preserves the first started_at on a continuation segment.
record("markRunning.missing", await repo.markRunning("no-such-id", { startedAt: 8_600 }));

// ---- markTerminal: irreversible ----
record("markTerminal", await repo.markTerminal("op-1", {
  status: "completed",
  endedAt: 9_000,
  filesChanged: 3,
}));
record("markTerminal.again", await repo.markTerminal("op-1", {
  status: "failed",
  endedAt: 9_500,
  failureReason: "late result",
}));
record("get.afterTerminal", await repo.get("op-1"));

// ---- markSettled: terminal rows only ----
record("markSettled.terminal", await repo.markSettled("op-1", 10_000));
record("markSettled.nonTerminal", await repo.markSettled("op-2", 10_100));
record("get.afterSettled", await repo.get("op-1"));
record("listUnsettledTerminal.after", await repo.listUnsettledTerminal());

// ---- markHistoryDeleted: needs a task that actually started ----
record("markHistoryDeleted.started", await repo.markHistoryDeleted("op-1", { now: 11_000 }));
record("markHistoryDeleted.idempotent", await repo.markHistoryDeleted("op-1", { now: 11_500 }));
record("markHistoryDeleted.notStarted", await repo.markHistoryDeleted("op-2", { now: 11_600 }));

// ---- updateEditableFields ----
record("updateEditableFields", await repo.updateEditableFields(
  "op-2",
  { title: "renamed", modelSelection: selection("p1", "m2", "low") },
  { now: 12_000 },
));
// A null selection is rejected outright, before the status check.
record("updateEditableFields.nullSelection", await repo.updateEditableFields(
  "op-2",
  { title: "nope", modelSelection: null },
  { now: 12_100 },
));
// A terminal task is not editable.
record("updateEditableFields.terminal", await repo.updateEditableFields(
  "op-1",
  { title: "nope" },
  { now: 12_200 },
));
record("updateEditableFields.missing", await repo.updateEditableFields("no-such-id", { title: "x" }, { now: 12_300 }));

// ---- updateSchedulingSnapshot: undefined means "leave alone" ----
record("updateSchedulingSnapshot", await repo.updateSchedulingSnapshot("op-2", {
  schedulable: true,
  queuePosition: 9,
  nextPollAt: 13_000,
  now: 13_100,
}));
record("get.afterSnapshot", await repo.get("op-2"));
record("updateSchedulingSnapshot.partial", await repo.updateSchedulingSnapshot("op-2", {
  now: 13_200,
}));
record("get.afterPartialSnapshot", await repo.get("op-2"));
record("updateSchedulingSnapshot.missing", await repo.updateSchedulingSnapshot("no-such-id", { now: 13_300 }));

// ---- invalidateModelSelection ----
record("invalidateModelSelection", await repo.invalidateModelSelection(
  "op-2",
  selection("p1", "m2", "low"),
  { now: 14_000 },
));
// A repair another process already made must win over the older observation.
record("invalidateModelSelection.repaired", await repo.invalidateModelSelection(
  "op-2",
  selection("stale", "stale-model"),
  { now: 14_100 },
));
record("invalidateModelSelection.missing", await repo.invalidateModelSelection(
  "no-such-id",
  selection("p", "m"),
  { now: 14_200 },
));

// ---- claimDue skips a row whose selection is broken, and keeps going ----
record("claimDue.skipsBroken", await repo.claimDue(15_000));

// ---- requeueForContinuation ----
record("requeueForContinuation.notRunning", await repo.requeueForContinuation("op-2", { now: 16_000 }));
record("markRunning.op2", await repo.markRunning("op-2", { startedAt: 16_100, sessionId: "sess-1" }));
record("requeueForContinuation.running", await repo.requeueForContinuation("op-2", { now: 16_200 }));
record("get.afterRequeue", await repo.get("op-2"));
record("requeueForContinuation.terminal", await repo.requeueForContinuation("op-1", { now: 16_300 }));

// ---- releaseClaim, then recoverInterrupted ----
record("releaseClaim.noError", await repo.releaseClaim("op-2", { now: 17_000 }));
// Put a row into `running` first, otherwise `recoverInterrupted` has nothing to reclaim and the
// fixture would pin a zero that proves nothing about the transition.
record("markRunning.op3", await repo.markRunning("op-3", { startedAt: 17_100, sessionId: "sess-b" }));
record("countActive.beforeRecover", await repo.countActive());
record("get.beforeRecover", await repo.list({ workspacePath: "/ws/a", workspaceIdentity: "ws-a" }));
record("recoverInterrupted", await repo.recoverInterrupted(18_000));
record("get.afterRecover", await repo.list({ workspacePath: "/ws/a", workspaceIdentity: "ws-a" }));

// ---- a stale claim is reclaimed, and a fresh one is not ----
record("claimDue.forStale", await repo.claimDue(19_000));
record("claimDue.pastStale", await repo.claimDue(19_000 + STALE + 1));
record("claimDue.fresh", await repo.claimDue(19_000 + STALE + 2));

// ---- delete ----
record("delete", await repo.delete("op-3"));
record("get.afterDelete", await repo.get("op-3"));
record("delete.missing", await repo.delete("no-such-id"));

// ---- the conflict detector, which callers use to tell a duplicate create apart ----
try {
  await repo.create(
    { ...base, modelSelection: selection("p", "m") },
    { now: 20_000, offPeakTaskId: "op-conflict" },
  );
  // A second create with the same (workspace_key, session_id) hits the unique index only when a
  // session is bound, so bind one first.
  await repo.create(
    { ...base, boundSessionId: "sess-dup", modelSelection: selection("p", "m") },
    { now: 20_100, offPeakTaskId: "op-dup" },
  );
  const { isOffPeakBoundSessionConflict } = await import(
    "../packages/services/src/session/offPeakTaskRepo.ts"
  );
  let conflict = false;
  try {
    await repo.create(
      { ...base, boundSessionId: "sess-dup", modelSelection: selection("p", "m") },
      { now: 20_200, offPeakTaskId: "op-dup2" },
    );
  } catch (error) {
    conflict = isOffPeakBoundSessionConflict(error);
  }
  record("boundSessionConflict", conflict);
} catch (error) {
  record("boundSessionConflict.setupFailed", String(error));
}

// ---- final state ----
record("final.list", await repo.list());
record("final.countNonTerminal", await repo.countNonTerminal());
record("final.countActive", await repo.countActive());
record("final.hasActiveBoundTask", await repo.hasActiveBoundTask("ws-a", "sess-1"));

repo.close();

const { writeFileSync } = await import("node:fs");
const out = join(process.cwd(), "packages/rust/crates/zcode-task-index/tests/fixtures/offpeak_transcript.json");
writeFileSync(out, `${JSON.stringify(transcript, null, 2)}\n`, "utf-8");
rmSync(workspace, { recursive: true, force: true });

console.log(`captured ${transcript.length} entries -> ${out}`);
