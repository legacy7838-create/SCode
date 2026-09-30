import type { MentionCategory } from "@/mentions/mentionTypes.js";

export const PROMPT_MENTION_BASE_CLASS_NAME =
  // Using align-middle, inline-flex token will be aligned according to the parent text baseline + x-height, not aligned with the visual center of the line box.
  // When you continue to enter the text after the token in the input box, it will be about 1px lower; align-top allows the token and the text of the same line-height to share the top reference of the line box.
  "inline-flex cursor-default items-center gap-1 align-top text-ui-base leading-5 font-medium";

export function getPromptMentionVariantClassName(category: MentionCategory): string {
  if (category === "skills") {
    return "text-skill-node-foreground";
  }
  if (category === "subagents") {
    return "text-subagent-node-foreground";
  }
  if (category === "commands") {
    return "text-command-node-foreground capitalize";
  }
  if (category === "sessions") {
    return "text-session-node-foreground";
  }
  if (category === "plugins") {
    return "text-plugin-node-foreground";
  }
  if (category === "whiteboards") {
    return "text-file-node-foreground";
  }
  return "text-file-node-foreground";
}
