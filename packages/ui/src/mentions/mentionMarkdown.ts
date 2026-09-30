const LINK_MENTION_MARKDOWN_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)/g;
const INLINE_MENTION_TOKEN_PATTERN =
  /(^|\s)(\$[a-zA-Z0-9._-]+|\/[a-zA-Z0-9._-]+|@[a-zA-Z0-9._-]+|#sess_[a-zA-Z0-9._-]+)(?=$|\s)/g;

function escapeMarkdownLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownDestination(destination: string): string {
  return destination.replaceAll("\\", "\\\\").replaceAll(">", "\\>");
}

function unescapeMarkdownText(text: string): string {
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

function normalizeMarkdownDestination(destination: string): string {
  if (
    destination.startsWith("/") ||
    destination.startsWith("./") ||
    destination.startsWith("../") ||
    destination.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(destination)
  ) {
    return destination;
  }

  // Streamdown/rehype-harden will treat bare paths like `foo/bar.ts` as custom protocol `foo:`,
  // As a result, file references in user messages will be rendered as `[blocked]`. `./foo/bar.ts` is uniformly added here.
  // Make it a clear relative path link, which not only retains Markdown semantics, but can also be displayed normally through security verification.
  return `./${destination}`;
}

function normalizeFileMentionRelativePath(
  relativePath: string,
  kind: "file" | "directory",
): string {
  const trimmedRelativePath = relativePath.trim();
  if (kind === "directory") {
    return `${trimmedRelativePath.replace(/[\\/]+$/, "")}/`;
  }

  return trimmedRelativePath;
}

export function buildFileMentionMarkdown(
  relativePath: string,
  label: string,
  kind: "file" | "directory" = "file",
): string {
  const normalizedRelativePath = normalizeFileMentionRelativePath(relativePath, kind);
  return `[${escapeMarkdownLabel(label)}](${escapeMarkdownDestination(normalizeMarkdownDestination(normalizedRelativePath))})`;
}

export function buildSkillMentionMarkdown(label: string, skillPath?: string): string {
  if (!skillPath) {
    return `$${label}`;
  }

  return `[${escapeMarkdownLabel(`$${label}`)}](${escapeMarkdownDestination(normalizeMarkdownDestination(skillPath))})`;
}

export function buildSubagentMentionMarkdown(label: string): string {
  return `@${label}`;
}

export function buildSessionMentionMarkdown(sessionId: string, label?: string): string {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel || trimmedLabel === sessionId) {
    return `#${sessionId}`;
  }
  return `[${escapeMarkdownLabel(`#${trimmedLabel}`)}](#${escapeMarkdownDestination(sessionId)})`;
}

// Canonical persistence vector referenced by Plugin:
// `[@Label](plugin://stable-id)`. The identity is only at the destination; the label is for display only.
export function buildPluginMentionMarkdown(label: string, pluginId: string): string {
  return `[${escapeMarkdownLabel(`@${label}`)}](plugin://${escapeMarkdownDestination(pluginId)})`;
}

type MentionTextPart =
  | { type: "text"; text: string }
  | { type: "file"; label: string }
  | { type: "directory"; label: string }
  | { type: "skill"; label: string }
  | { type: "command"; label: string }
  | { type: "subagent"; label: string }
  | { type: "session"; label: string }
  | { type: "plugin"; label: string; pluginId?: string };

const PLUGIN_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parsePluginStableId(destination: string): string | undefined {
  if (!destination.startsWith("plugin://")) return undefined;
  const candidate = destination.slice("plugin://".length);
  return candidate.length <= 256 && PLUGIN_STABLE_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

/**
 * Formats a skill slug (such as code-review) into a readable title for chat bubbles (Code Review).
 * A phrase that already contains spaces is returned as-is, so user-defined display names are not
 * broken.
 */
export function formatSkillMentionDisplayLabel(label: string): string {
  const t = label.trim();
  if (!t) {
    return label;
  }
  if (t.includes(" ") && !t.includes("-") && !t.includes("_")) {
    return t;
  }
  const words = t.split(/[-_]/).filter(Boolean);
  if (words.length === 0) {
    return label;
  }
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function isDirectoryMentionDestination(destination: string): boolean {
  return /[\\/]$/.test(destination);
}

function parseInlineMentionTokens(segment: string): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of segment.matchAll(INLINE_MENTION_TOKEN_PATTERN)) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (!token) {
      continue;
    }
    const matchStart = match.index ?? 0;
    const tokenStart = matchStart + prefix.length;
    if (tokenStart > cursor) {
      parts.push({
        type: "text",
        text: segment.slice(cursor, tokenStart),
      });
    }
    if (token.startsWith("$")) {
      parts.push({ type: "skill", label: token.slice(1) });
    } else if (token.startsWith("/")) {
      parts.push({ type: "command", label: token.slice(1) });
    } else if (token.startsWith("@")) {
      parts.push({ type: "subagent", label: token.slice(1) });
    } else if (token.startsWith("#")) {
      parts.push({ type: "session", label: token.slice(1) });
    } else {
      parts.push({ type: "text", text: token });
    }
    cursor = tokenStart + token.length;
  }

  if (cursor < segment.length) {
    parts.push({ type: "text", text: segment.slice(cursor) });
  }

  return parts;
}

export function parseMentionMarkdown(content: string): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  LINK_MENTION_MARKDOWN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of content.matchAll(LINK_MENTION_MARKDOWN_PATTERN)) {
    const fullMatch = match[0] ?? "";
    const label = match[1] ? unescapeMarkdownText(match[1]) : "";
    const destination = match[2] ?? match[3] ?? "";
    const matchStart = match.index ?? 0;
    if (matchStart > cursor) {
      parts.push(...parseInlineMentionTokens(content.slice(cursor, matchStart)));
    }
    if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
      parts.push({ type: "session", label: label.startsWith("#") ? label.slice(1) : label });
    } else if (destination.startsWith("plugin://")) {
      // Plugin reference links must not fall into the file branch or be treated as external links;
      // After sending, only the label was retained, the message layer lost the stable ID, and only the bottom icon was permanently displayed.
      // Here, the legal destination identity is retained as is for the UI to associate with the Session catalog; illegal destinations remain
      // Display-only, no label guessing, percent decoding or canonical rewriting.
      const pluginId = parsePluginStableId(destination);
      parts.push({
        type: "plugin",
        label: label.startsWith("@") ? label.slice(1) : label,
        ...(pluginId ? { pluginId } : {}),
      });
    } else if (label.startsWith("$")) {
      parts.push({ type: "skill", label: label.slice(1) });
    } else if (isDirectoryMentionDestination(destination)) {
      // Before, the directory mention could only be restored as a normal file, and the message echo layer could not get the folder semantics.
      // Therefore, the folder candidates will continue to display as ordinary file icons in the bubble. Here the directory type is restored based on whether the link target ends with a slash.
      parts.push({ type: "directory", label: label.startsWith("@") ? label.slice(1) : label });
    } else {
      parts.push({ type: "file", label: label.startsWith("@") ? label.slice(1) : label });
    }
    cursor = matchStart + fullMatch.length;
  }

  if (cursor < content.length) {
    parts.push(...parseInlineMentionTokens(content.slice(cursor)));
  }

  return parts;
}
