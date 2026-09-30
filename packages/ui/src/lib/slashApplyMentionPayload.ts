import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import {
  buildSkillMentionMarkdown,
  buildSubagentMentionMarkdown,
} from "@/mentions/mentionMarkdown.js";
import { normalizeSlashCommandValue } from "@/slashCommandHelpers.js";
import type { PromptMentionPayload } from "@/mentions/nodes/PromptMentionNode.js";

/**
 * Turns the suggestion selected in the `/` panel into a PromptMention payload; skill/subagent still
 * reuse the existing $skill and @agent markdown semantics.
 */
export function buildSlashApplyMentionPayload(
  suggestion: PromptInputSuggestionItem,
): PromptMentionPayload {
  if (suggestion.id.startsWith("skill:")) {
    return {
      id: suggestion.id,
      category: "skills",
      label: suggestion.value,
      value: suggestion.value,
      markdown: buildSkillMentionMarkdown(suggestion.value, suggestion.data?.path),
      description: suggestion.description,
      data: suggestion.data,
    };
  }

  if (suggestion.id.startsWith("subagent:")) {
    return {
      id: suggestion.id,
      category: "subagents",
      label: suggestion.value,
      value: suggestion.value,
      markdown: buildSubagentMentionMarkdown(suggestion.value),
      description: suggestion.description,
      data: suggestion.data,
    };
  }

  const commandValue = normalizeSlashCommandValue(suggestion.value);
  return {
    id: suggestion.id,
    category: "commands",
    label: commandValue,
    value: commandValue,
    markdown: `/${commandValue}`,
    description: suggestion.description,
  };
}
