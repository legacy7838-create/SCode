/**
 * PHASE 2 oracle: capture WHICH background tasks a subagent run must cancel on teardown.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 2).
 *
 * The selection is a policy — "a running, backgrounded local_bash task" — and stopping the
 * task is a side effect that stays in TypeScript (it goes through the scheduler and the
 * task index). Porting only the policy keeps one owner for the rule: if the predicate
 * lived in two places, a cancelled run could leave a stray process behind.
 *
 * Run: pnpm exec tsx scripts/capture-subagent-cancel-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

/** The predicate as `cancelRunningRuntimeBackgroundTasks` states it today. */
function selectTasksToCancel(tasks: Record<string, unknown>[]) {
  return Object.values(tasks)
    .filter(
      (task) =>
        (task as { type?: unknown }).type === "local_bash" &&
        (task as { isBackgrounded?: unknown }).isBackgrounded === true &&
        (task as { status?: unknown }).status === "running",
    )
    .map((task) => (task as { taskId: string }).taskId);
}

const CASES: { name: string; tasks: Record<string, unknown>[] }[] = [
  { name: "empty_registry", tasks: [] },
  {
    name: "running_backgrounded_bash_is_selected",
    tasks: [{ taskId: "t1", type: "local_bash", isBackgrounded: true, status: "running" }],
  },
  {
    name: "foreground_bash_is_kept",
    tasks: [{ taskId: "t1", type: "local_bash", isBackgrounded: false, status: "running" }],
  },
  {
    name: "finished_bash_is_kept",
    tasks: [{ taskId: "t1", type: "local_bash", isBackgrounded: true, status: "completed" }],
  },
  {
    name: "failed_bash_is_kept",
    tasks: [{ taskId: "t1", type: "local_bash", isBackgrounded: true, status: "failed" }],
  },
  {
    name: "missing_is_backgrounded_is_kept",
    tasks: [{ taskId: "t1", type: "local_bash", status: "running" }],
  },
  {
    name: "other_task_types_are_kept",
    tasks: [
      { taskId: "t1", type: "workflow_run", isBackgrounded: true, status: "running" },
      { taskId: "t2", type: "subagent", isBackgrounded: true, status: "running" },
      { taskId: "t3", type: "local_bash", isBackgrounded: true, status: "running" },
    ],
  },
  {
    name: "mixed_selects_only_the_match",
    tasks: [
      { taskId: "keep_fg", type: "local_bash", isBackgrounded: false, status: "running" },
      { taskId: "keep_done", type: "local_bash", isBackgrounded: true, status: "completed" },
      { taskId: "keep_other", type: "workflow_run", isBackgrounded: true, status: "running" },
      { taskId: "kill_1", type: "local_bash", isBackgrounded: true, status: "running" },
      { taskId: "keep_pending", type: "local_bash", isBackgrounded: true, status: "pending" },
      { taskId: "kill_2", type: "local_bash", isBackgrounded: true, status: "running" },
    ],
  },
  {
    name: "is_backgrounded_truthy_but_not_true_is_kept",
    // A string "true" is not the boolean the predicate asks for; a loose comparison
    // here would cancel tasks the child never backgrounded.
    tasks: [{ taskId: "t1", type: "local_bash", isBackgrounded: "true", status: "running" }],
  },
  {
    name: "extra_fields_do_not_matter",
    tasks: [
      {
        taskId: "t1",
        type: "local_bash",
        isBackgrounded: true,
        status: "running",
        exitCode: null,
        stopInitiator: "user",
        prompt: "sleep 100",
      },
    ],
  },
];

const results: Record<string, string[]> = {};
for (const testCase of CASES) {
  results[testCase.name] = selectTasksToCancel(testCase.tasks);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/subagent-cancel-golden.json`, JSON.stringify(results, null, 2) + "\n");
console.log(`captured ${CASES.length} cancellation policy cases`);
for (const [name, ids] of Object.entries(results)) {
  console.log(`  ${name.padEnd(42)} -> [${ids.join(", ")}]`);
}
