import assert from "node:assert/strict";
import test from "node:test";
import { mergeGlobalTaskListResults } from "../src/lib/globalTaskListMerge.js";
import type { GlobalTaskListShardResult } from "../src/lib/globalTaskListMerge.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

/**
 * useGlobalTaskList aggregates per-workspace shards (docs/specs/window-controller-availability.md
 * §3): each shard answers from its own endpoint's tasks-index top-N, so the merge must keep global
 * ordering, keep the true total for the "show more" gate, and surface any shard's hasMore.
 */

function meta(overrides: Partial<ZCodeTaskMeta>): ZCodeTaskMeta {
  return {
    taskId: "task",
    workspacePath: "/ws",
    title: "t",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    provider: "glm",
    ...overrides,
  } as ZCodeTaskMeta;
}

function shard(items: ZCodeTaskMeta[], total: number, hasMore = false): GlobalTaskListShardResult {
  return { items, total, hasMore };
}

test("merges shards in descending updatedAt order across workspaces", () => {
  const result = mergeGlobalTaskListResults({
    shards: [
      shard([meta({ taskId: "a", updatedAt: 100 })], 1),
      shard([meta({ taskId: "b", updatedAt: 300 }), meta({ taskId: "c", updatedAt: 200 })], 2),
    ],
    sortBy: "updated",
  });
  assert.deepEqual(
    result.items.map((item) => item.taskId),
    ["b", "c", "a"],
  );
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, false);
});

test("total is the sum of shard totals even when the limit trims items", () => {
  const items = [
    meta({ taskId: "a", updatedAt: 500 }),
    meta({ taskId: "b", updatedAt: 400 }),
    meta({ taskId: "c", updatedAt: 300 }),
  ];
  const result = mergeGlobalTaskListResults({
    shards: [shard(items, 30, true), shard([meta({ taskId: "d", updatedAt: 200 })], 10, true)],
    sortBy: "updated",
    limit: 20,
  });
  assert.equal(result.items.length, 4);
  assert.equal(result.total, 40);
  assert.equal(result.hasMore, true);
});

test("hasMore is true when a shard reports more even if totals equal visible rows", () => {
  const result = mergeGlobalTaskListResults({
    shards: [shard([meta({ taskId: "a" })], 1, true), shard([], 0)],
    sortBy: "updated",
  });
  assert.equal(result.hasMore, true);
});

test("without a limit every shard row is returned", () => {
  const result = mergeGlobalTaskListResults({
    shards: [shard([meta({ taskId: "a" })], 1), shard([meta({ taskId: "b" })], 1)],
    sortBy: "created",
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.hasMore, false);
});

test("empty shard set merges to an empty list with zero total", () => {
  const result = mergeGlobalTaskListResults({ shards: [], sortBy: "updated" });
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
  assert.equal(result.hasMore, false);
});
