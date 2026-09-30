type ChatPlaceholderMessageKey =
  | "chat.placeholder.newTask"
  | "chat.placeholder.newTaskMobile"
  | "chat.placeholder.followUpAsk"
  | "chat.placeholder.followUpQueue";

export function resolveChatPlaceholderKey(options: {
  hasHistoryMessages: boolean;
  isTaskProcessing: boolean;
  compactNewTask?: boolean;
}): ChatPlaceholderMessageKey {
  const { compactNewTask = false, hasHistoryMessages, isTaskProcessing } = options;

  // Divided by semantics:
  // 1) No history -> newTask
  // 2) History and free -> followUpAsk
  // 3) There is history and is being processed -> followUpQueue
  if (!hasHistoryMessages) {
    return compactNewTask ? "chat.placeholder.newTaskMobile" : "chat.placeholder.newTask";
  }

  return isTaskProcessing ? "chat.placeholder.followUpQueue" : "chat.placeholder.followUpAsk";
}
