import type { BotCommand } from "@zcode/shared";

function splitCommand(text: string): { name: string; rest: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const body = trimmed.slice(1);
  const firstSpace = body.search(/\s/u);
  if (firstSpace === -1) {
    return { name: body.toLowerCase(), rest: "" };
  }
  return {
    name: body.slice(0, firstSpace).toLowerCase(),
    rest: body.slice(firstSpace + 1).trim(),
  };
}

export function parseBotCommand(text: string): BotCommand {
  const parsed = splitCommand(text);
  if (!parsed) {
    return text.trim() === "0" ? { type: "selection.cancel" } : { type: "message", text };
  }

  const { name, rest } = parsed;
  switch (name) {
    case "bind":
      return rest ? { type: "bind", code: rest } : { type: "unknown", name, raw: text };
    case "help":
      return { type: "help" };
    case "cancel":
    case "Cancel":
      return { type: "selection.cancel" };
    case "status":
    case "Status":
      return { type: "status" };
    case "new":
    case "clear":
    case "New":
      return { type: "new" };
    case "reconnect":
    case "Reconnect":
      return { type: "reconnect" };
    case "workspace":
    case "project":
    case "Project":
      return rest ? { type: "workspace.set", value: rest } : { type: "workspace.list" };
    case "model":
      if (!rest) {
        return { type: "model.list" };
      }
      if (rest.startsWith("provider ")) {
        return { type: "model.provider.set", value: rest.slice("provider ".length).trim() };
      }
      if (rest.startsWith("model ")) {
        return { type: "model.set", value: rest.slice("model ".length).trim() };
      }
      return { type: "model.set", value: rest };
    case "mode":
      return rest ? { type: "mode.set", value: rest } : { type: "mode.list" };
    case "thoughtlevel":
    case "thought_level":
    case "thought-level":
    case "think":
      return rest ? { type: "thoughtLevel.set", value: rest } : { type: "thoughtLevel.list" };
    case "task":
      return rest ? { type: "task.set", value: rest } : { type: "task.list" };
    case "reply":
    case "Reply":
      return rest ? { type: "reply.set", value: rest } : { type: "reply.list" };
    case "stop":
      return { type: "stop" };
    case "permission":
      return rest ? { type: "permission.respond", value: rest } : { type: "unknown", name, raw: text };
    case "elicitation":
    case "answer":
      if (!rest) {
        return { type: "unknown", name, raw: text };
      }
      if (["submit", "done", "Complete", "Submit"].includes(rest.toLowerCase())) {
        return { type: "elicitation.submit" };
      }
      return { type: "elicitation.respond", value: rest };
    case "approve": {
      const [requestId, optionId] = rest.split(/\s+/u);
      return requestId && optionId
        ? { type: "approve", requestId, optionId }
        : { type: "unknown", name, raw: text };
    }
    case "deny":
      return rest ? { type: "deny", requestId: rest } : { type: "unknown", name, raw: text };
    default:
      return { type: "unknown", name, raw: text };
  }
}
