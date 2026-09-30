/**
 * slashCommandHelpers — pure-function helpers for SlashCommandPlugin.tsx
 */
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { AgentSummary, Locale, SkillSummary, ZCodeSlashCommand } from "@zcode/shared";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "@/mentions/providers/skillsMentionProvider.js";
import type { PromptInputSuggestionItem } from "./lib/promptInputTriggers.js";

export interface SlashCommandPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * The id of an existing Session; null/undefined means a new draft, which decides the Skill
   * catalog authority.
   */
  sessionId?: string | null;
  disabled?: boolean;
  excludedCommandNames?: readonly string[];
  /**
   * App-layer local command (e.g. `/side`). The command catalog still treats the CLI catalog as
   * authoritative; only commands that "run a UI behavior on selection" may be appended by the
   * render layer — they do not take part in sending and are not written back to the CLI command
   * list.
   */
  appCommands?: readonly AppSlashCommand[];
}

/** App-layer slash command: runs a UI behavior on selection (no mention inserted, nothing sent). */
export interface AppSlashCommand {
  /** Command value (without the leading `/`), e.g. "side". */
  value: string;
  /** Localized description, shown directly in the `/` panel. */
  description: string;
  /**
   * Extra search keywords; should include both Chinese and English aliases so that either typing
   * habit can find it.
   */
  keywords?: readonly string[];
  /** The UI behavior executed immediately after the command is selected. */
  run: () => void;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = "app-slash:";

export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [
      {
        id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
        trigger: "/",
        value,
        label: `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.description, ...(command.keywords ?? [])])],
      },
    ];
  });
}

export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * `/side` gating: in draft state there is no parent session for a child to hang off, an assistant
 * conversation is not allowed to open another assistant conversation, and the read-only and phone
 * viewports hide it consistently with the pinned entry point.
 */
export function shouldOfferSideSlashCommand(options: {
  isDraft: boolean;
  selectionSideChat: boolean;
  readOnly: boolean;
  isMobileViewport: boolean;
}): boolean {
  return (
    !options.isDraft && !options.selectionSideChat && !options.readOnly && !options.isMobileViewport
  );
}

export function normalizeSlashCommandValue(name: string): string {
  // ZCode Agent may return "/init" directly as the command name on the remote side.
  // The UI value needs to strip the leading slash, otherwise inserting markdown would produce "//init" and affect / panel matching.
  return name.trim().replace(/^\/+/, "");
}

export function buildSlashSuggestions(commands: ZCodeSlashCommand[]): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.name);
    // The UI previously maintained a built-in whitelist, GLM `/goal` fallback, and v4 appended directory simultaneously.
    // When the CLI catalog was lost, some commands would still display, masking the absence of `/init` and custom commands.
    // Command discovery is now unified with the CLI protocol catalog as the authority; the UI no longer appends commands or maintains a built-in whitelist.
    if (!value) {
      return [];
    }
    return [
      {
        id: `slash:${value}`,
        trigger: "/",
        value,
        label: command.inputHint?.trim() || `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.name, command.description, command.inputHint ?? ""])],
      },
    ];
  });
}

export function buildSubagentSuggestions(
  agents: Array<
    Pick<
      AgentSummary,
      "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
    >
  >,
): PromptInputSuggestionItem[] {
  return mapSubagentsToMentionItemsForTest(agents).map((item) =>
    mapSubagentMentionItemToSuggestion(item),
  );
}

export function buildSkillSuggestions(
  skills: Array<
    Pick<SkillSummary, "id" | "name" | "description" | "path" | "scope" | "pluginName">
  >,
  locale?: Locale,
): PromptInputSuggestionItem[] {
  return mapSkillsToMentionItemsForTest(skills, locale).map((item) => ({
    id: item.id,
    trigger: "/",
    value: item.value,
    label: `$${item.value}`,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "skill", "skills", item.value])],
    data: item.data,
  }));
}

function mapSubagentMentionItemToSuggestion(item: MentionItem): PromptInputSuggestionItem {
  return {
    id: item.id,
    trigger: "/",
    value: item.value,
    label: item.label,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "subagent", "agent"])],
    data: item.data,
  };
}

export function getTextAroundCursor() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return {
      textAfterCursor: "",
      textBeforeCursor: $getRoot().getTextContent(),
    };
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const textContent = node.getTextContent();
  return {
    textAfterCursor: textContent.slice(anchor.offset),
    textBeforeCursor: textContent.slice(0, anchor.offset),
  };
}
