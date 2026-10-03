/** Verification section: cancel-live. See docs/specs/subagent-rust-port.md. */
import { selectTasksToCancel, shouldSealBackgroundTaskNotifications } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
// Phase 2 live proof: the cancellation policy runs in Rust.
// 1. the teardown case: two backgrounded running bashes must be stopped
const tasks = [
  { taskId: "fg", type: "local_bash", isBackgrounded: false, status: "running" },
  { taskId: "done", type: "local_bash", isBackgrounded: true, status: "completed" },
  { taskId: "wf", type: "workflow_run", isBackgrounded: true, status: "running" },
  { taskId: "kill_1", type: "local_bash", isBackgrounded: true, status: "running" },
  { taskId: "kill_2", type: "local_bash", isBackgrounded: true, status: "running" },
];
check("selects only the strays", JSON.stringify(selectTasksToCancel(tasks)) === '["kill_1","kill_2"]');
// 2. a stringly-typed flag must NOT be cancelled (the user's own work)
check("strict on isBackgrounded",
  JSON.stringify(selectTasksToCancel([{ taskId: "x", type: "local_bash", isBackgrounded: "true", status: "running" }])) === "[]");
// 3. missing flag is kept
check("missing flag kept",
  selectTasksToCancel([{ taskId: "x", type: "local_bash", status: "running" }]).length === 0);
// 4. empty registry
check("empty registry is a no-op", selectTasksToCancel([]).length === 0);
// 5. order is preserved (the stop order is observable in the log)
check("order preserved",
  JSON.stringify(selectTasksToCancel([
    { taskId: "a", type: "local_bash", isBackgrounded: true, status: "running" },
    { taskId: "b", type: "local_bash", isBackgrounded: true, status: "running" },
  ])) === '["a","b"]');
// 6. the seal gate
check("subagent_child seals", shouldSealBackgroundTaskNotifications("subagent_child") === true);
check("main does not seal", shouldSealBackgroundTaskNotifications("main") === false);
check("workflow_child does not seal", shouldSealBackgroundTaskNotifications("workflow_child") === false);
}
}
