import type { MentionCategory } from "@/mentions/mentionTypes.js";

function unescapePromptMentionMarkdownText(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }
    result += text[index];
  }
  return result;
}

function extractPromptMentionMarkdownLabel(text: string): string | null {
  const matched = /^\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)$/.exec(
    text.trim(),
  );
  const label = matched?.[1];
  return label ? unescapePromptMentionMarkdownText(label) : null;
}

export function normalizePromptMentionDisplayLabel(
  category: MentionCategory,
  label: string,
  value: string,
): string {
  const markdownLabel = extractPromptMentionMarkdownLabel(label);
  let displayLabel = markdownLabel ?? label;

  if (category === "skills" && displayLabel.startsWith("$")) {
    displayLabel = displayLabel.slice(1);
  } else if (category === "sessions" && displayLabel.startsWith("#")) {
    displayLabel = displayLabel.slice(1);
  } else if (
    (category === "files" ||
      category === "subagents" ||
      category === "whiteboards" ||
      category === "plugins") &&
    displayLabel.startsWith("@")
  ) {
    displayLabel = displayLabel.slice(1);
  }

  // In the old draft snapshot, the complete markdown link may be written into the text field of the mention node.
  // This will leave the restored tag icon still there, but the text displayed as `[$skill](path)`. The display layer only takes human-readable labels,
  // The markdown field continues to retain the complete original text for sending.
  return displayLabel.trim() || value;
}
