//! Which background tasks a subagent run must cancel on teardown.
//!
//! Spec: `docs/specs/subagent-rust-port.md` (Phase 2), ported from
//! `runtime/methods/background.ts::cancelRunningRuntimeBackgroundTasks`.
//!
//! ## Why the policy moves and the stopping does not
//!
//! The original does two different things: it *decides* which tasks to cancel (a pure
//! predicate over registry snapshots) and then *stops* them (a side effect through the
//! scheduler and the task index). Only the decision moves. Keeping the predicate in one
//! owner matters: if the rule lived in two places, a cancelled run could leave a stray
//! process behind — the exact failure this teardown exists to prevent.
//!
//! The predicate is strict on all three fields. `isBackgrounded` must be the boolean
//! `true`, not a truthy value: a task whose flag is the string `"true"` was never
//! backgrounded by this runtime and stopping it would kill the user's own work.

use serde_json::Value;

/// The task type a subagent may leave running behind it.
const CANCELLABLE_TASK_TYPE: &str = "local_bash";

/// Select the task ids to cancel, in registry order.
///
/// `tasks` is the registry's snapshots keyed by task id; the returned ids come from each
/// snapshot's own `taskId`, because that is what `stopBackgroundTask` is called with.
pub fn select_tasks_to_cancel(tasks: &[Value]) -> Vec<String> {
    tasks
        .iter()
        .filter(|task| {
            task.get("type").and_then(Value::as_str) == Some(CANCELLABLE_TASK_TYPE)
                && task.get("isBackgrounded").and_then(Value::as_bool) == Some(true)
                && task.get("status").and_then(Value::as_str) == Some("running")
        })
        .filter_map(|task| task.get("taskId").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// Whether notifications should be sealed for this runtime.
///
/// Ported from `sealBackgroundTaskNotifications`: only a subagent child seals them. A
/// main or workflow runtime keeps notifying, because its background work is the user's,
/// not a child's.
pub fn should_seal_background_task_notifications(task_type: &str) -> bool {
    task_type == "subagent_child"
}
