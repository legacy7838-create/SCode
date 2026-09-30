import type { Locale } from "@zcode/shared";

export type BotMessageLocale = Extract<Locale, "en-US">;

type MessageValues = Record<string, string | number | undefined>;

const messages = {
  "en-US": {
    botDisabled: "This bot is not enabled.",
    privateChatOnly: "Bots do not support group chats yet. Please use a private chat.",
    bindPrivateOnly: "Bots can only bind in a private chat.",
    userNotBound:
      "This bot is not bound. Generate a bind code in the zcode UI, then send **/bind <code>**.",
    commandNotAllowed: "This command is disabled for the current bot.",
    noWorkspaceAllowed: "No workspace is available. Allow a workspace in Bots settings first.",
    workspaceOutOfScope:
      "The workspace in this chat is no longer authorized. Please select **/workspace** again.",
    bindCodeInvalid: "The bind code is invalid or expired. Generate a new one in the zcode UI.",
    bindBotMissing: "Bind failed: bot does not exist.",
    bindSuccess: "Bound successfully. Send **/help** to see available commands.",
    weixinActivatedWelcome:
      "Weixin bot is active. Send **/help** to see commands, or describe what you want to do.",
    helpTitle: "ZCode bot commands:",
    helpHelp: "**/help** — Show this guide",
    helpBind: "**/bind <code>** — Bind this chat",
    helpStatus: "**/status** — Show workspace, model, and task status",
    helpNew: "/new or /clear — Start a new task draft",
    helpWorkspace: "**/project** — Switch workspace",
    helpModel: "**/model** — Switch model",
    helpMode: "**/mode** — Switch run mode",
    helpThoughtLevel: "**/think** — Switch thought level",
    helpReply: "**/reply** — Switch reply detail",
    webhookSecretInvalid: "Webhook secret verification failed.",
    callbackFailed: "Failed to process bot callback: {message}",
    sessionExpiredNewTaskHint:
      "The current task session has expired. It may have been cleaned up, or this bot message is stale. Send **/new task** to create a new task and continue.",
    deletedTaskReplaced:
      "The previous task was deleted, so I created a new task for you. This message will be processed in the new task without the previous conversation history.",
    received: "Received.",
    attachmentOnlyPrompt: "Please review the attachment and help based on its content.",
    attachmentRejected: "Failed to process attachment: {message}",
    attachmentDownloadUnavailable:
      "Could not download the attachment. The file may have expired, been removed, or the bot may not have permission to read it. Please send the attachment again and try once more.",
    attachmentTooLarge: "The attachment exceeds 5MB. Compress it and send it again.",
    selectionCancelled: "Cancelled.",
    selectionCancelOption: "Cancel",
    selectionTextHint: "Reply with a number to choose, or 0 to cancel.",
    selectionTextHintNoCancel: "Reply with a number to choose.",
    newTaskDraft: "Entered a new task draft in {workspacePath}.",
    workspaceSelectTitle: "Current workspace {workspace}\nSelect workspace",
    workspaceMissing: "No available workspace found.",
    modelSelectTitle: "Select model",
    modelProviderSelectTitle: "Current model {model}\nSelect model provider",
    modelModelSelectTitle: "Current model {model}\nSelect model",
    modelMissing: "Model not found.",
    sessionModelUnavailable:
      "The session's model selection is unavailable. Use /model to choose again. Your saved selection has been preserved.",
    modeSelectTitle: "Current mode {mode}\nSelect mode",
    modeMissing: "Mode option not found.",
    modeChanged: "Current task mode changed to {mode}.",
    modeLocked: "This bot is locked to **yolo** run mode and cannot be switched.",
    thoughtLevelSelectTitle: "Current thought level {level}\nSelect thought level",
    thoughtLevelMissing: "The current model does not support thought level.",
    thoughtLevelChanged: "Current task thought level changed to {level}.",
    modelProviderMissing: "Model provider not found.",
    modelChanged: "Current task model changed to {model}.",
    taskMissing: "Task not found.",
    taskChanged: "Switched to task: {title}",
    noActiveTask: "There is no active task.",
    permissionExpired: "This permission request has expired. Please handle it in the zcode UI.",
    permissionHandled: "Permission request has already been handled.",
    permissionDenied: "Permission request denied.",
    permissionSubmitted: "Permission response submitted.",
    elicitationExpired: "This question request has expired. Please handle it in the zcode UI.",
    elicitationHandled: "Question request has already been handled.",
    elicitationSubmitted: "Question response submitted.",
    elicitationCancelled: "Question request cancelled.",
    elicitationCustomOption: "Custom answer",
    elicitationCustomPlaceholder: "Enter a custom answer",
    elicitationQuestionTitle: "Question",
    planApprovalTitle: "Review this implementation plan.",
    planApprovalHeader: "Implementation plan",
    planApprovalApprove: "Approve",
    planApprovalApproveDescription: "Exit plan mode and start implementation.",
    elicitationCancelledCard: "✅ Questions cancelled",
    elicitationSubmitOption: "Done",
    elicitationSkipOption: "Skip",
    elicitationMultiSelectHint:
      "You can select multiple options; select again to remove, then choose Done.",
    elicitationTextHint: "You can also reply with text as a custom answer.",
    statusWorkspace: "Workspace",
    statusModel: "Model",
    statusTask: "Task",
    statusState: "State",
    statusWorked: "Worked",
    statusProgress: "Progress",
    statusDraft: "draft",
    statusRemoteDisconnected: "remote disconnected",
    statusCancelled: "cancelled",
    statusStopped: "stopped",
    streamingStatusRunning: "Running",
    streamingStatusCompleted: "Completed",
    streamingStatusFailed: "Failed",
    streamingWorking: "Working...",
    streamingToolSummaries: "Tool summaries",
    stopSubmitted: "Current task generation stopped.",
    unknownCommand: "Unknown command: **/{command}**",
    taskFailed: "Task failed: {message}",
    taskRunning:
      "The current task is still running. Try again later, or use **/stop** to stop the current task.",
    taskSelectTitle: "Current task {task}\nSelect task",
    noHistoryTasks: "There are no history tasks in the current workspace.",
    remoteDisconnected:
      "The remote workspace {workspacePath} is not connected. Send **/reconnect** first, then try again. The previous request was not executed.",
    remoteDisconnectedStatus:
      "The remote workspace {workspacePath} is not connected. Send **/reconnect** to restore the connection.",
    remoteWorkspaceSelectedDisconnected:
      "Switched to {workspacePath}, but the remote workspace is not connected. Send **/reconnect** before running tasks.",
    remoteReconnectStarting:
      "The remote workspace {workspacePath} is not connected. Reconnecting now...",
    remoteReconnectFailed:
      "Remote workspace {workspacePath} reconnect failed: {message}\nThe previous request was not executed.",
    remoteReconnectUnavailable:
      "The remote workspace {workspacePath} is not connected, but the bot cannot access the remote reconnect service. Open this remote project in ZCode and try again.",
    remoteReconnectLocal:
      "The current workspace is local and does not need reconnecting. Send **/workspace** to switch to a remote project.",
    remoteReconnectAlreadyConnected: "The remote workspace {workspacePath} is connected.",
    replySelectTitle: "Current third-party reply detail {mode}\nSelect third-party reply detail",
    replyMissing: "Reply detail option not found.",
    replyChanged: "Third-party reply detail changed to {mode}.",
  },
} as const;

export type BotMessageId = keyof (typeof messages)[BotMessageLocale];

export function formatBotMessage(
  locale: Locale | undefined,
  id: BotMessageId,
  values: MessageValues = {},
): string {
  let message: string = messages["en-US"][id];
  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return message;
}
