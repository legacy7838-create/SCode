import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";

export function isChatTaskRunning(taskStatus: ZCodeTaskRuntimeStatus) {
  // ChatView previously used displayedStatus and the last message role to guess "whether you are thinking".
  // When the task is obviously still in creating/restoring/streaming, as long as the message list does not keep up, the shimmer will disappear early.
  // This directly aligns the task running status judgment and maintains the same set of "running" status as the top Task StatusBadge.
  return taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming";
}
