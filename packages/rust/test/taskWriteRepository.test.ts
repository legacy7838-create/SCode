import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_STORE } from "../src/taskIndex.js";
import { TaskWriteRepository } from "../src/taskWriteRepository.js";

/**
 * Wire contract with `StateRequest` in `crates/zcode-task-index/src/napi.rs` (spec §29):
 * the native request is flat — `workspaceKey`, `taskId`, `now` plus the patch fields at the top
 * level. A nested `{ patch: {…} }` body is rejected by `deny_unknown_fields` with
 * `unknown field \`patch\``, which is what used to fail `zcode-task.archiveTask`.
 */

function captureRepo() {
  const calls: string[] = [];
  const store = {
    async updateTaskState(requestJson: string): Promise<string> {
      calls.push(requestJson);
      return JSON.stringify({ taskId: "t1" });
    },
    async applyAgentPatch(requestJson: string): Promise<string> {
      calls.push(requestJson);
      return JSON.stringify({ taskId: "t1" });
    },
  };
  const repo = new TaskWriteRepository({ [NATIVE_STORE]: store } as never);
  return { repo, calls };
}

test("updateTaskState sends a flat body — the patch fields sit at the top level", async () => {
  const { repo, calls } = captureRepo();
  await repo.updateTaskState({
    workspaceKey: "ws:home",
    taskId: "t1",
    patch: { archived: true, pinned: true, title: undefined, unreadAt: null },
    now: 1712345678901,
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]) as Record<string, unknown>;
  assert.equal(
    "patch" in body,
    false,
    "a nested patch object is rejected by StateRequest's deny_unknown_fields",
  );
  assert.equal(body.archived, true);
  assert.equal(body.pinned, true);
  assert.equal(body.workspaceKey, "ws:home");
  assert.equal(body.taskId, "t1");
  assert.equal(body.now, 1712345678901);
  // undefined means "leave alone" and must not reach the wire; null means "clear it" and must.
  assert.equal("title" in body, false);
  assert.equal(body.unreadAt, null);
});

test("updateTaskState defaults now, and applyAgentPatch stays flat", async () => {
  const { repo, calls } = captureRepo();
  const before = Date.now();
  await repo.updateTaskState({ workspaceKey: "ws", taskId: "t2", patch: { deleted: true } });
  await repo.applyAgentPatch({ workspaceKey: "ws", taskId: "t2", title: "renamed" });

  const state = JSON.parse(calls[0]) as Record<string, unknown>;
  assert.equal(state.deleted, true);
  assert.equal("patch" in state, false);
  assert.ok(
    typeof state.now === "number" && state.now >= before,
    "now defaults to Date.now() so the unread watermark stays monotone",
  );

  const agentPatch = JSON.parse(calls[1]) as Record<string, unknown>;
  assert.equal(agentPatch.title, "renamed");
  assert.equal("patch" in agentPatch, false, "applyAgentPatch is a flat body by contract");
});
