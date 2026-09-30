/* eslint-disable max-lines */
/**
 * LexicalChatInput — Lexical-based chat composer
 *
 * A Lexical-based chat composer supporting slash commands and mention tags.
 * - Enter sends, Shift+Enter inserts a newline
 * - IME input supported
 * - Auto height (3 rows by default, scrolls once the content overflows)
 * - disabled state
 * - Trigger panels for `/` / `@` via SlashCommandPlugin / MentionPlugin
 *
 * A standalone input presentation shell that carries no conversation orchestration logic; it
 * bridges exactly three things:
 * 1. useChatViewActiveTaskProvider comes from @/v4/activeTaskProvider.js (read from the
 *    configuration surface);
 * 2. ChatComposerPasteEvent is narrowed to a structural type exported from this file;
 * 3. the mention panel is gated by enableMentionPanel; slash commands always read the CLI workspace
 *    catalog.
 */
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import { PromptClipboardPlugin } from "@/mentions/PromptClipboardPlugin.js";
import {
  resolveComposerKeyAction,
  shouldBareEnterFallThroughToNewline,
} from "@/shortcuts/composerShortcuts.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $getNodeByKey,
  $setSelection,
  $getRoot,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import { SlashCommandPlugin } from "./SlashCommandPlugin.js";
import type { AppSlashCommand } from "./slashCommandHelpers.js";
import { MentionPlugin } from "./mentions/MentionPlugin.js";
import { useChatViewActiveTaskProvider } from "@/v4/activeTaskProvider.js";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
  PromptMentionNode,
} from "./mentions/nodes/PromptMentionNode.js";
import { logger } from "./logger.js";
import { recordInputLag } from "./lib/uiPerfArmsTelemetry.js";
import { navigatePromptHistory } from "./lib/promptHistory.js";
import type { MentionItemData } from "@/mentions/mentionTypes.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

/**
 * The old useChatComposer is gone; paste events are narrowed to a minimal structural type
 * (ClipboardEvent is structurally compatible).
 */
export interface ChatComposerPasteEvent {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export interface LexicalChatInputHandle {
  clear: () => void;
  focus: () => void;
  getEditorState: () => EditorState;
  getMarkdown: () => string;
  getText: () => string;
  appendText: (text: string) => void;
  appendFileMention: (
    label: string,
    value: string,
    markdown: string,
    data?: MentionItemData,
    trailingText?: string,
  ) => void;
  prependMentionIfMissing: (mention: ComposerMentionPrefill) => boolean;
  setMention: (mention: ComposerMentionPrefill, trailingText?: string) => void;
  insertMention: (mention: ComposerMentionPrefill, selectionState?: EditorState) => void;
  setText: (text: string) => void;
  setTextWithPluginMentions: (text: string) => void;
  setEditorStateJson: (editorStateJson: string) => void;
  setSkillMention: (skillName: string, markdown?: string, trailingText?: string) => void;
  setSlashCommandMention: (commandName: string, markdown?: string, trailingText?: string) => void;
}

interface LexicalEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  enterSubmits: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  text: string;
}

interface LexicalModifiedEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  modifiedEnterSubmits: boolean;
  shiftKey?: boolean;
  text: string;
}

type LexicalSubmitResult = boolean | void;

interface LeadingChineseSlashAliasInputOptions {
  data: string | null;
  inputType: string;
  isAtEditorStart: boolean;
  isComposing?: boolean;
}

const CHINESE_SLASH_ALIAS = "、";
const STANDARD_SLASH_TRIGGER = "/";

import { HISTORY_NAVIGATION_UPDATE_TAG, PROGRAMMATIC_UPDATE_TAG } from "./lib/editorUpdateTags.js";

function shouldSubmitLexicalEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  enterSubmits,
  isComposing = false,
  metaKey = false,
  shiftKey = false,
  text,
}: LexicalEnterSubmitOptions): boolean {
  if (!enterSubmits) {
    return false;
  }
  if (shiftKey || ctrlKey || metaKey || isComposing) {
    return false;
  }
  return Boolean(text.trim() || allowSubmitWhenEmpty);
}

function shouldSubmitLexicalModifiedEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  isComposing = false,
  metaKey = false,
  modifiedEnterSubmits,
  shiftKey = false,
  text,
}: LexicalModifiedEnterSubmitOptions): boolean {
  return (
    modifiedEnterSubmits &&
    (ctrlKey || metaKey) &&
    !shiftKey &&
    !isComposing &&
    Boolean(text.trim() || allowSubmitWhenEmpty)
  );
}

function shouldResetLexicalEditorAfterSubmit(result: LexicalSubmitResult): boolean {
  return result !== false;
}

function shouldNormalizeLeadingChineseSlashAliasInput({
  data,
  inputType,
  isAtEditorStart,
  isComposing = false,
}: LeadingChineseSlashAliasInputOptions): boolean {
  return (
    data === CHINESE_SLASH_ALIAS && inputType === "insertText" && isAtEditorStart && !isComposing
  );
}

/** Extracts the editor content; mention nodes emit their markdown here */
function getEditorMarkdown(editorState: EditorState): string {
  let text = "";
  editorState.read(() => {
    text = $getPromptMarkdown();
  });
  return text;
}

function replaceEditorText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();

      // Lexical getTextContent() uses \n\n to separate paragraphs, and symmetrical processing prevents line breaks from doubling
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        if (line) {
          paragraph.append($createTextNode(line));
        }
        root.append(paragraph);
      }

      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

const INLINE_PLUGIN_MENTION_PATTERN =
  /\[@((?:\\.|[^\]])+)\]\(plugin:\/\/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)\)/g;

function replaceEditorTextWithPluginMentions(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        let cursor = 0;
        for (const match of line.matchAll(INLINE_PLUGIN_MENTION_PATTERN)) {
          const start = match.index ?? 0;
          if (start > cursor) paragraph.append($createTextNode(line.slice(cursor, start)));
          const markdown = match[0];
          const label = match[1]?.replaceAll("\\]", "]").replaceAll("\\[", "[") ?? "";
          const pluginId = match[2] ?? "";
          paragraph.append(
            $createPromptMentionNode({
              id: `plugin:${pluginId}`,
              category: "plugins",
              label,
              value: pluginId,
              markdown,
              data: { pluginId },
            }),
          );
          cursor = start + markdown.length;
        }
        if (cursor < line.length || paragraph.getChildrenSize() === 0) {
          paragraph.append($createTextNode(line.slice(cursor)));
        }
        root.append(paragraph);
      }
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function replaceEditorWithMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      // After pre-filling, spaces are reserved for the user to continue typing directly; the correctness of the selection is guaranteed by the TextNode text/DOM contract.
      const trailing = $createTextNode(trailingText || " ");
      paragraph.append($createPromptMentionNode(mention), trailing);
      root.append(paragraph);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

/**
 * Inserts a structured mention at the head of the draft while keeping the existing Lexical nodes
 * and paragraphs.
 *
 * Rebuilding via getMarkdown → setMention is not an option: setMention is a replace-style prefill
 * that serializes old mentions back into the editor as plain TextNodes, which degrades existing
 * Plugin / file / Skill chips.
 */
function prependEditorMentionIfMissing(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
): boolean {
  let inserted = false;
  editor.update(
    () => {
      const root = $getRoot();
      const alreadyPresent = root
        .getAllTextNodes()
        .some(
          (node) =>
            $isPromptMentionNode(node) &&
            node.getMention().category === mention.category &&
            node.getMention().value === mention.value,
        );
      if (alreadyPresent) return;

      const mentionNode = $createPromptMentionNode(mention);
      const separator = $createTextNode(" ");
      const firstBlock = root.getFirstChild();
      if ($isParagraphNode(firstBlock)) {
        const firstInline = firstBlock.getFirstChild();
        if (firstInline) {
          firstInline.insertBefore(mentionNode);
          mentionNode.insertAfter(separator);
        } else {
          firstBlock.append(mentionNode, separator);
        }
      } else {
        const paragraph = $createParagraphNode().append(mentionNode, separator);
        if (firstBlock) firstBlock.insertBefore(paragraph);
        else root.append(paragraph);
      }
      separator.selectEnd();
      inserted = true;
    },
    { discrete: true, tag: PROGRAMMATIC_UPDATE_TAG },
  );
  return inserted;
}

function replaceEditorStateJson(editor: LexicalEditor, editorStateJson: string) {
  const editorState = editor.parseEditorState(editorStateJson);
  editor.setEditorState(editorState, { tag: PROGRAMMATIC_UPDATE_TAG });
}

function resetEditor(editor: LexicalEditor) {
  replaceEditorText(editor, "");
}

function replaceEditorWithSkillMention(
  editor: LexicalEditor,
  skillName: string,
  markdown = `$${skillName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-skill:${skillName}`,
          category: "skills",
          // Although the skill node will be inserted before pre-filling the entry, the markdown saved in the node is still fixed to `$slug`.
          // As a result, even if an entry like New Skill theoretically has complete translation content, it will be quietly downgraded after entering the input box.
          // Here, the original markdown is explicitly transmitted and the frontmatter name is displayed directly to avoid reprocessing the skill title in the UI.
          label: skillName,
          value: skillName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function replaceEditorWithSlashCommandMention(
  editor: LexicalEditor,
  commandName: string,
  markdown = `/${commandName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-slash:${commandName}`,
          category: "commands",
          label: commandName,
          value: commandName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function appendEditorFileMention(
  editor: LexicalEditor,
  label: string,
  value: string,
  markdown: string,
  data?: MentionItemData,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append(
        $createPromptMentionNode({
          id: `dropped-file:${value}`,
          category: "files",
          label,
          value,
          markdown,
          data,
        }),
        $createTextNode(trailingText),
      );
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function appendEditorPlainText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append($createTextNode(text));
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function getPromptMentionIdAfterDomSelection(rootElement: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  if (!rootElement.contains(anchorNode)) {
    return null;
  }

  if (anchorNode.nodeType === Node.ELEMENT_NODE) {
    const child = anchorNode.childNodes.item(selection.anchorOffset);
    return getPromptMentionIdFromBoundaryNode(child);
  }

  if (anchorNode.nodeType !== Node.TEXT_NODE) {
    return null;
  }

  if (selection.anchorOffset !== (anchorNode.textContent ?? "").length) {
    return null;
  }

  return getPromptMentionIdFromBoundaryNode(anchorNode.nextSibling);
}

function getPromptMentionIdFromBoundaryNode(node: Node | null): string | null {
  if (!(node instanceof HTMLElement) || !node.matches("[data-mention-id]")) {
    return null;
  }
  return node.dataset.mentionId ?? null;
}

function selectAfterPromptMentionById(mentionId: string): boolean {
  const mentionNode = $getRoot()
    .getAllTextNodes()
    .find(
      (node): node is PromptMentionNode =>
        $isPromptMentionNode(node) && node.getMention().id === mentionId,
    );
  if (!mentionNode) {
    return false;
  }

  const nextSibling = mentionNode.getNextSibling();
  if ($isTextNode(nextSibling)) {
    const text = nextSibling.getTextContent();
    const offset = /^\s/.test(text) ? Math.min(1, text.length) : 0;
    nextSibling.select(offset, offset);
    return true;
  }

  mentionNode.selectNext(0, 0);
  return true;
}

/**
 * Keyboard behavior plugin: Enter sends, Shift+Enter inserts a newline
 *
 * Intercepts the Enter key at COMMAND_PRIORITY_HIGH so that Lexical's default paragraph-insertion
 * behavior is prevented.
 */
function KeyboardPlugin({
  onSubmit,
  onModifiedSubmit,
  disabled,
  submitDisabled,
  allowSubmitWhenEmpty,
  enterSubmits,
}: {
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  // Scope change binding layer: read the composer command slice of the effective table; ref transparent transmission to avoid key monitoring rehang.
  const effectiveShortcutBindings = useEffectiveShortcutBindings();
  const composerEffectiveRef = useRef({
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  });
  composerEffectiveRef.current = {
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  };

  useEffect(() => {
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;

        if (disabled) {
          event.preventDefault();
          return true;
        }

        // IME is being combined (such as Chinese input method), not intercepted
        if (event.isComposing) {
          return false;
        }

        const text = getEditorMarkdown(editor.getEditorState());

        // Scope change layer: user key table takes precedence over built-in defaults.
        // Hit line break → release Lexical insertion paragraph; hit send → take the access control branch equivalent to the main chain;
        // Missed → fell to the main chain below (including reverse delivery/modified combination wrap/viewport access control).
        const composerEffective = composerEffectiveRef.current;
        const scopedAction = resolveComposerKeyAction(event, composerEffective);
        if (scopedAction === "newline") {
          return false;
        }
        if (scopedAction === "send") {
          const modifiedScopedEnter = event.shiftKey || event.ctrlKey || event.metaKey;
          // When reverse delivery is enabled, the modified combination gives way to the main chain (Ctrl+Enter = reverse delivery, delivery semantics are more specific than key positions)
          if (!(modifiedScopedEnter && onModifiedSubmit)) {
            // Access control equivalent to main chain bare Enter: unmodified combination is subject to submitDisabled / mobile viewport enterSubmits;
            // Modified combinations are not subject to viewport access control (consistent with the onModifiedSubmit path of the main chain).
            if (submitDisabled || (!modifiedScopedEnter && !enterSubmits)) {
              return false;
            }
            event.preventDefault();
            if (
              shouldSubmitLexicalEnter({
                allowSubmitWhenEmpty,
                enterSubmits: modifiedScopedEnter ? true : enterSubmits,
                text,
              })
            ) {
              const submitResult = onSubmit(text);
              if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
                resetEditor(editor);
              }
            }
            return true;
          }
        }

        // Main chain pre-check: When composerSend has been changed and bound (the effective binding does not contain naked Enter),
        // Naked Enter no longer means send, allowing Lexical to wrap (the expected behavior after the "Ctrl+Enter party" binding was changed).
        if (
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          shouldBareEnterFallThroughToNewline(composerEffective)
        ) {
          return false;
        }

        if (
          !submitDisabled &&
          onModifiedSubmit &&
          shouldSubmitLexicalModifiedEnter({
            allowSubmitWhenEmpty,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            modifiedEnterSubmits: true,
            shiftKey: event.shiftKey,
            text,
          })
        ) {
          event.preventDefault();
          const submitResult = onModifiedSubmit(text);
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
          return true;
        }

        // Shift+Enter, and Ctrl/Meta+Enter when reverse posting is not enabled continue wrapping.
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          return false;
        }

        // While the current request is in progress, the input box still allows you to continue editing the draft, but it cannot be submitted again at this time.
        // Previously, the status was directly mapped to disabled, which caused the input and the Lenovo panel to be invalid; if only disabled was removed,
        // Enter will trigger submit by mistake and clear the draft. Here, when submitDisabled, Enter is returned to Lexical to handle line breaks.
        if (submitDisabled || !enterSubmits) {
          return false;
        }

        event.preventDefault();

        if (
          shouldSubmitLexicalEnter({
            allowSubmitWhenEmpty,
            enterSubmits,
            text,
          })
        ) {
          const submitResult = onSubmit(text);
          // The business layer may reject this submission and require the draft to remain in the input box.
          // The Enter keyboard layer cannot be reset unconditionally, otherwise the user input will be eaten even if the business layer does not send it.
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchor = selection.anchor;
        if (anchor.type !== "text") {
          return false;
        }

        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          return false;
        }

        const text = node.getTextContent();
        if (anchor.offset !== 1 || text !== " ") {
          return false;
        }

        const previousSibling = node.getPreviousSibling();
        if (!$isPromptMentionNode(previousSibling)) {
          return false;
        }

        // When mention is inserted, a space will be automatically added for continued input.
        // Previously, Backspace would first delete the space and then delete the token. The user's experience was that "it takes two clicks to delete the label."
        // Here, when "the cursor is just after the filled space", the space + mention token are directly deleted at once.
        event?.preventDefault();
        previousSibling.remove();
        node.remove();
        node.getParent()?.selectEnd();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const handleRootKeyDownCapture = (event: KeyboardEvent) => {
      if (
        disabled ||
        event.key !== "ArrowRight" ||
        !event.altKey ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing
      ) {
        return;
      }

      const rootElement = editor.getRootElement();
      if (!rootElement) {
        return;
      }

      const mentionId = getPromptMentionIdAfterDomSelection(rootElement);
      if (!mentionId) {
        return;
      }

      // macOS Option+ArrowRight will perform word-level jump according to DOM text. Previously, the cursor would be dropped into
      // The file name text inside the mention token; Lexical will delete the token as the replaced content the next time it is entered.
      // Explicitly move the selection to the back of the token at the left edge of the token, maintaining the atomic editing semantics of mention.
      event.preventDefault();
      event.stopImmediatePropagation();
      editor.update(
        () => {
          selectAfterPromptMentionById(mentionId);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    // Scope rebinding layer·Non-Enter distribution (unified open policy): KEY_ENTER_COMMAND only for Enter
    // Distributed by root keydown capture when the user binds send/line feed to a non-Enter key (such as F9).
    // Otherwise, changing the binding will be a dead binding, and the naked Enter to fallback to a newline will cause the entire keyboard sending ability to be lost.
    // Non-Enter physical keys do not have the problem of mis-sending the mobile phone's soft keyboard, and send is not subject to enterSubmits viewport access control;
    // No overlap with reverse delivery (only responds to Ctrl/Meta+Enter), no need to give way.
    const handleNonEnterScopedKeydown = (event: KeyboardEvent) => {
      if (disabled || event.repeat || event.isComposing || event.key === "Enter") {
        return;
      }
      const scopedAction = resolveComposerKeyAction(event, composerEffectiveRef.current);
      if (!scopedAction) {
        return;
      }
      if (scopedAction === "newline") {
        event.preventDefault();
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertLineBreak();
          }
        });
        return;
      }
      if (submitDisabled) {
        return;
      }
      event.preventDefault();
      const text = getEditorMarkdown(editor.getEditorState());
      if (shouldSubmitLexicalEnter({ allowSubmitWhenEmpty, enterSubmits: true, text })) {
        const submitResult = onSubmit(text);
        if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
          resetEditor(editor);
        }
      }
    };

    const unregisterRootListener = editor.registerRootListener(
      (rootElement, previousRootElement) => {
        previousRootElement?.removeEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        previousRootElement?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
      },
    );

    return () => {
      unregisterEnter();
      unregisterBackspace();
      unregisterRootListener();
      editor.getRootElement()?.removeEventListener("keydown", handleRootKeyDownCapture, {
        capture: true,
      });
      editor.getRootElement()?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
        capture: true,
      });
    };
  }, [
    allowSubmitWhenEmpty,
    disabled,
    editor,
    enterSubmits,
    onModifiedSubmit,
    onSubmit,
    submitDisabled,
  ]);

  return null;
}

/**
 * Text change plugin
 *
 * With Lexical's own OnChangePlugin, the first character typed into an empty editor is skipped
 * outright by the internal `prevEditorState.isEmpty()`, so the parent component's input state never
 * receives that first character and the send button drifts out of sync with the content. Here we
 * listen to update ourselves and only sync when the serialized markdown actually changes, so the
 * first keystroke is reported back reliably too.
 */
function TextContentPlugin({
  onChange,
  taskId,
}: {
  onChange?: (text: string) => void;
  taskId?: string | null;
}) {
  const [editor] = useLexicalComposerContext();
  // IME composition markup: does not directly rely on editor.isComposing(), because it is executed synchronously in the update listener
  // Whether it has been reflected that there is timing uncertainty in the combined state. Failure to read true will misreport the high time consumption of Chinese/Japanese long text combinations as typing lag.
  // Instead, the compositionstart/compositionend events are maintained by themselves, which is stable and controllable.
  const composingRef = useRef(false);

  useEffect(() => {
    const handleCompositionStart = () => {
      composingRef.current = true;
    };
    const handleCompositionEnd = () => {
      // The composition has just ended when compositionend is triggered, but the update listener of the "composition submission" beat is usually in the same round.
      // The task is executed synchronously. If it is set to false immediately, the high time consumption will be misjudged as typing lag. Use queueMicrotask to set it to false
      // After delaying the current synchronization task, ensure that the beat submitted by the combination is still short-circuited in the combination state, and then resume normal counting.
      queueMicrotask(() => {
        composingRef.current = false;
      });
    };

    // The root will rehang, use registerRootListener to correctly unbind/bind on the old and new root.
    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("compositionstart", handleCompositionStart);
      previousRootElement?.removeEventListener("compositionend", handleCompositionEnd);
      rootElement?.addEventListener("compositionstart", handleCompositionStart);
      rootElement?.addEventListener("compositionend", handleCompositionEnd);
    });
  }, [editor]);

  useEffect(() => {
    if (!onChange) {
      return;
    }

    return editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, editorState, prevEditorState, tags }) => {
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
          return;
        }

        // Input lag timing: cover the processing hotspot of "full serialization + onChange synchronous re-rendering".
        const startedAt = performance.now();

        const nextText = getEditorMarkdown(editorState);
        const previousText = getEditorMarkdown(prevEditorState);
        if (nextText === previousText) {
          return;
        }

        onChange(nextText);

        const lagMs = performance.now() - startedAt;
        // The combined state of programmatic rewriting and IME does not count as typing lag (it is determined that there is a unified short circuit in recordInputLag).
        recordInputLag({
          lagMs,
          textLength: nextText.length,
          isProgrammatic: tags.has(PROGRAMMATIC_UPDATE_TAG),
          isComposing: composingRef.current,
          taskId: taskId ?? undefined,
        });
      },
    );
  }, [editor, onChange, taskId]);

  return null;
}

/** Plugin that controls the editor's editable state */
function EditablePlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  return null;
}

function E2ELexicalInputBridgePlugin({ inputTestId }: { inputTestId?: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!inputTestId || typeof document === "undefined") {
      return;
    }

    const bridge = {
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) =>
        replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
    };

    let attachedInput: HTMLElement | null = null;
    const detachBridge = (input: HTMLElement | null) => {
      if (
        input &&
        (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E === bridge
      ) {
        delete (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E;
      }
      input?.removeAttribute("data-e2e-lexical-bridge");
    };
    const attachBridge = (input: HTMLElement | null) => {
      if (attachedInput && attachedInput !== input) {
        detachBridge(attachedInput);
      }
      attachedInput = input;
      if (!input) {
        return;
      }

      // E2E needs to drive the real Lexical state; only changing the DOM contenteditable will bypass editor update.
      // It is easy to mistakenly type text into the main input box, resulting in a disconnect between test conclusions and product behavior.
      Object.defineProperty(input, "__zcodeLexicalInputE2E", {
        configurable: true,
        value: bridge,
      });
      input.setAttribute("data-e2e-lexical-bridge", "ready");
    };

    const resolveInput = (rootElement: HTMLElement | null) => {
      if (rootElement?.getAttribute("data-testid") === inputTestId) {
        return rootElement;
      }
      return document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    };

    let retryTimer: number | null = null;
    const tryAttachBridge = () => {
      const nextInput = resolveInput(editor.getRootElement());
      attachBridge(nextInput);
      if (nextInput && retryTimer !== null) {
        window.clearInterval(retryTimer);
        retryTimer = null;
      }
    };
    const unregisterRoot = editor.registerRootListener((rootElement, previousRootElement) => {
      if (previousRootElement !== rootElement) {
        detachBridge(previousRootElement);
      }
      // The E2E bridge previously only queried the DOM once in the effect.
      // If the editor root is mounted later than the plugin or is remounted by Lexical, the bridge will be permanently missing.
      attachBridge(resolveInput(rootElement));
    });

    tryAttachBridge();
    // ChatPromptEditor's initialValue backfill, Lexical root registration,
    // React DOM commit order may span multiple frames. Short polling is only responsible for patching and testing the bridge and does not participate in product behavior.
    retryTimer = window.setInterval(tryAttachBridge, 100);

    return () => {
      unregisterRoot();
      if (retryTimer !== null) {
        window.clearInterval(retryTimer);
      }
      detachBridge(attachedInput);
    };
  }, [editor, inputTestId]);

  return null;
}

function PromptHistoryPlugin({
  entries,
  disabled,
}: {
  entries: readonly string[];
  disabled?: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const historyIndexRef = useRef<number | null>(null);
  const applyingHistoryRef = useRef(false);

  useEffect(() => {
    if (historyIndexRef.current !== null && entries[historyIndexRef.current] === undefined) {
      historyIndexRef.current = null;
    }
  }, [entries]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        return;
      }

      if (applyingHistoryRef.current) {
        applyingHistoryRef.current = false;
        return;
      }

      const currentIndex = historyIndexRef.current;
      if (currentIndex === null) {
        return;
      }

      if (entries[currentIndex] === undefined) {
        historyIndexRef.current = null;
        return;
      }

      if (getEditorMarkdown(editorState) !== entries[currentIndex]) {
        historyIndexRef.current = null;
      }
    });
  }, [editor, entries]);

  const applyHistoryEntry = useCallback(
    (nextIndex: number | null, nextValue: string) => {
      historyIndexRef.current = nextIndex;
      applyingHistoryRef.current = true;
      // Use the specific HISTORY_NAVIGATION_UPDATE_TAG instead of the generic PROGRAMMATIC_UPDATE_TAG,
      // Enable SlashCommandPlugin to differentiate between "history backfill" and "user is entering a slash query",
      // Prevent panel reopening and swallowing subsequent arrow keys with COMMAND_PRIORITY_CRITICAL when backfilling history entries containing /.
      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          for (const line of nextValue.split("\n\n")) {
            const paragraph = $createParagraphNode();
            if (line) {
              paragraph.append($createTextNode(line));
            }
            root.append(paragraph);
          }
          root.getLastChild()?.selectEnd();
        },
        { tag: HISTORY_NAVIGATION_UPDATE_TAG },
      );
    },
    [editor],
  );

  const handleHistoryNavigation = useCallback(
    (direction: "up" | "down") => (event: KeyboardEvent | null) => {
      if (!event) return false;

      if (
        disabled ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      ) {
        return false;
      }

      const text = getEditorMarkdown(editor.getEditorState());
      const currentIndex = historyIndexRef.current;

      // Historical navigation only takes over the up and down keys when "empty input" or "has entered the history browsing state".
      // Avoid taking away the original cursor movement behavior of multi-line input.
      if (currentIndex === null && text.length > 0) {
        return false;
      }

      const result = navigatePromptHistory(entries, currentIndex, direction);
      if (!result.shouldHandle) {
        return false;
      }

      event.preventDefault();
      applyHistoryEntry(result.nextIndex, result.nextValue);
      return true;
    },
    [applyHistoryEntry, disabled, editor, entries],
  );

  useEffect(() => {
    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      handleHistoryNavigation("up"),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      handleHistoryNavigation("down"),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterUp();
      unregisterDown();
    };
  }, [editor, handleHistoryNavigation]);

  return null;
}

function isCollapsedSelectionAtEditorStart(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }

  const [startPoint] = selection.getStartEndPoints() ?? [];
  if (!startPoint || startPoint.offset !== 0) {
    return false;
  }

  const root = $getRoot();
  const startNode = startPoint.getNode();
  if (startPoint.type === "text") {
    const firstTextNode = root.getAllTextNodes()[0] ?? null;
    return firstTextNode?.is(startNode) ?? root.getTextContentSize() === 0;
  }

  if (startNode.is(root)) {
    return true;
  }

  const firstDescendant = root.getFirstDescendant();
  return firstDescendant?.is(startNode) ?? root.getTextContentSize() === 0;
}

function LeadingChineseSlashAliasPlugin({ disabled }: { disabled?: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (disabled) {
      return;
    }

    const handleBeforeInput = (event: InputEvent) => {
      let shouldNormalize = false;
      editor.getEditorState().read(() => {
        shouldNormalize = shouldNormalizeLeadingChineseSlashAliasInput({
          data: event.data,
          inputType: event.inputType,
          isAtEditorStart: isCollapsedSelectionAtEditorStart(),
          isComposing: event.isComposing,
        });
      });

      if (!shouldNormalize) {
        return;
      }

      // Under the Chinese input method, when the user wants to type `/` in the first position of the input box to invoke the command,
      // The comma `,` may actually be entered. Here we only intercept the pauses that are actually entered manually and are located at the beginning of the full text.
      // Immediately normalize to standard `/` to avoid spreading the comma into another set of matching syntax for slash command.
      event.preventDefault();
      editor.update(
        () => {
          if (!isCollapsedSelectionAtEditorStart()) {
            return;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertText(STANDARD_SLASH_TRIGGER);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("beforeinput", handleBeforeInput as EventListener);
      rootElement?.addEventListener("beforeinput", handleBeforeInput as EventListener);
    });
  }, [disabled, editor]);

  return null;
}

function PasteCapturePlugin({
  disabled,
  onPaste,
}: {
  disabled?: boolean;
  onPaste?: (event: ChatComposerPasteEvent) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPaste) {
      return;
    }

    const handlePaste = (event: ClipboardEvent) => {
      if (disabled) {
        return;
      }

      const wasDefaultPrevented = event.defaultPrevented;
      onPaste(event);
      if (event.defaultPrevented && !wasDefaultPrevented) {
        // After the long text has been converted into an attachment, subsequent Lexical paste commands must be blocked.
        // Otherwise, there will be double content like "The attachment is available and the text is also inserted."
        event.stopImmediatePropagation();
      }
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("paste", handlePaste, {
        capture: true,
      });
      rootElement?.addEventListener("paste", handlePaste, { capture: true });
    });
  }, [disabled, editor, onPaste]);

  return null;
}

/** Exposes focus / clear / getText to callers */
function insertEditorMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  selectionState?: EditorState,
) {
  const selection = selectionState?.read(() => $getSelection()?.clone() ?? null);
  editor.update(
    () => {
      // After the floating layer gains focus, the Lexical selection will be lost and the cursor before opening the menu will be restored to avoid covering the entire draft.
      // Drafts may be replaced while the menu is open; the selection cannot be restored when the old node does not exist, otherwise Lexical will throw an error.
      if ($isRangeSelection(selection)) {
        if ($getNodeByKey(selection.anchor.key) && $getNodeByKey(selection.focus.key)) {
          $setSelection(selection);
        } else {
          $getRoot().selectEnd();
        }
      }
      let target = $getSelection();
      if (!$isRangeSelection(target)) target = $getRoot().selectEnd();
      const trailing = $createTextNode(" ");
      target.insertNodes([$createPromptMentionNode(mention), trailing]);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function EditorApiPlugin({
  editorApiRef,
}: {
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editorApiRef) {
      return;
    }

    editorApiRef.current = {
      clear: () => resetEditor(editor),
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getMarkdown: () => getEditorMarkdown(editor.getEditorState()),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      appendText: (text: string) => appendEditorPlainText(editor, text),
      appendFileMention: (
        label: string,
        value: string,
        markdown: string,
        data?: MentionItemData,
        trailingText = " ",
      ) => appendEditorFileMention(editor, label, value, markdown, data, trailingText),
      insertMention: (mention, selectionState) =>
        insertEditorMention(editor, mention, selectionState),
      prependMentionIfMissing: (mention) => prependEditorMentionIfMissing(editor, mention),
      setMention: (mention, trailingText) =>
        replaceEditorWithMention(editor, mention, trailingText),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) =>
        replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
      setSkillMention: (skillName: string, markdown = `$${skillName}`, trailingText = " ") =>
        replaceEditorWithSkillMention(editor, skillName, markdown, trailingText),
      setSlashCommandMention: (
        commandName: string,
        markdown = `/${commandName}`,
        trailingText = " ",
      ) => replaceEditorWithSlashCommandMention(editor, commandName, markdown, trailingText),
    };

    return () => {
      editorApiRef.current = null;
    };
  }, [editor, editorApiRef]);

  return null;
}

interface LexicalChatInputProps {
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  onChange?: (text: string) => void;
  onFocus?: () => void;
  triggerPanelContainer?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** Affects only the Skill reference directories; a draft may use a prewarmed Session runtime. */
  skillCatalogSessionId?: string | null;
  inputTestId?: string;
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
  promptHistory?: readonly string[];
  compactPlaceholder?: boolean;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  excludedSlashCommandNames?: readonly string[];
  /** App-local slash commands (such as `/side`): picking one runs a UI behavior, it is not sent. */
  appSlashCommands?: readonly AppSlashCommand[];
  /**
   * Toggle for the mention (@/#) panel. Explicitly off while the v4 data plane is not ready; the
   * entry point is kept.
   */
  enableMentionPanel?: boolean;
}

const EDITOR_THEME = {
  paragraph: "m-0",
};

export function LexicalChatInput({
  placeholder,
  disabled = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  onSubmit,
  onModifiedSubmit,
  onChange,
  onFocus,
  triggerPanelContainer,
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  inputTestId,
  editorApiRef,
  promptHistory = [],
  compactPlaceholder = false,
  onWhiteboardMentionSelected,
  onPaste,
  excludedSlashCommandNames,
  appSlashCommands,
  enableMentionPanel = true,
}: LexicalChatInputProps) {
  const inputMountedAtRef = useRef(Date.now());
  const lastReadyLogKeyRef = useRef<string | null>(null);
  const activeTaskProvider = useChatViewActiveTaskProvider(
    taskId,
    workspacePath,
    workspaceIdentity,
  );
  useEffect(() => {
    const readyLogKey = [
      workspaceIdentity ?? workspacePath,
      taskId ?? "draft",
      activeTaskProvider,
      triggerPanelContainer ? "trigger-ready" : "trigger-missing",
    ].join("|");
    if (lastReadyLogKeyRef.current === readyLogKey) {
      return;
    }
    lastReadyLogKeyRef.current = readyLogKey;

    let frameId: number | null = null;
    const logReady = () => {
      logger.info("[LexicalChatInput] chat input editor first frame ready", {
        durationMs: Date.now() - inputMountedAtRef.current,
        activeTaskProvider,
        disabled,
        hasPromptHistory: promptHistory.length > 0,
        submitDisabled,
        taskId,
        triggerPanelReady: Boolean(triggerPanelContainer),
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });
    };

    // Lexical editor initialization, slash/mention plugin and external portal are separate components.
    // Wait for the next frame of the browser to be clicked here, so that it can be aligned with the first frame of composer shell and toolbar portal ready.
    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(logReady);
    } else {
      logReady();
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    activeTaskProvider,
    disabled,
    promptHistory.length,
    submitDisabled,
    taskId,
    triggerPanelContainer,
    workspaceIdentity,
    workspacePath,
  ]);
  const handleSubmit = useCallback(
    (text: string) => {
      const submitResult = onSubmit(text);
      requestAnimationFrame(() => {
        editorApiRef?.current?.focus();
      });
      return submitResult;
    },
    [editorApiRef, onSubmit],
  );
  // Lexical's ContentEditable props is a mutually exclusive union type,
  // Once aria-placeholder appears, it requires placeholder to exist at the same time.
  // Previously, when writing ternary JSX directly, TypeScript did not correctly retain this set of linkage constraints when merging the two branches, resulting in a false positive that the placeholder was missing.
  const contentEditableProps: React.ComponentProps<typeof ContentEditable> = placeholder
    ? {
        "aria-placeholder": placeholder,
        placeholder: (
          <div
            className={`pointer-events-none absolute left-0 top-0 ${compactPlaceholder ? "line-clamp-2" : ""} text-ui-base leading-5 text-foreground-subtlest`}
          >
            {placeholder}
          </div>
        ),
      }
    : {
        placeholder: null,
      };

  const contentEditable = (
    <ContentEditable
      // mention node uses the inline-flex chip with fixed line height. If the normal text inherits the browser normal line-height,
      // When you continue to enter text after the token, the baseline will be calculated based on different line boxes; the line height of the text is explicitly closed here.
      className="min-h-10 max-h-40 overflow-y-auto text-ui-base leading-5 text-foreground outline-none"
      data-testid={inputTestId}
      onFocus={onFocus}
      {...contentEditableProps}
    />
  );

  const initialConfig = useMemo(
    () => ({
      namespace: "ChatInput",
      theme: EDITOR_THEME,
      nodes: [PromptMentionNode],
      // LexicalComposer initialConfig Each time render is created, the input area subtree will be recorded as props changes;
      // The configuration content itself is static, and fixed references can prevent irrelevant state updates from triggering composer subtree bubbling.
      onError: (error: Error) => {
        logger.error("[LexicalChatInput] editor error:", error);
      },
    }),
    [],
  );

  return (
    <div className="relative flex-1">
      <LexicalComposer initialConfig={initialConfig}>
        <div className="relative">
          <PlainTextPlugin contentEditable={contentEditable} ErrorBoundary={LexicalErrorBoundary} />
          <HistoryPlugin />
          <PromptClipboardPlugin />
          <TextContentPlugin onChange={onChange} taskId={taskId} />
          <KeyboardPlugin
            onSubmit={handleSubmit}
            onModifiedSubmit={onModifiedSubmit}
            disabled={disabled}
            submitDisabled={submitDisabled}
            allowSubmitWhenEmpty={allowSubmitWhenEmpty}
            enterSubmits={enterSubmits}
          />
          <PromptHistoryPlugin entries={promptHistory} disabled={disabled} />
          <EditablePlugin editable={!disabled} />
          <E2ELexicalInputBridgePlugin inputTestId={inputTestId} />
          <EditorApiPlugin editorApiRef={editorApiRef} />
          <LeadingChineseSlashAliasPlugin disabled={disabled} />
          <PasteCapturePlugin disabled={disabled} onPaste={onPaste} />
        </div>
        <SlashCommandPlugin
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={skillCatalogSessionId ?? taskId}
          provider={activeTaskProvider}
          container={triggerPanelContainer}
          disabled={disabled}
          excludedCommandNames={excludedSlashCommandNames}
          appCommands={appSlashCommands}
        />
        {enableMentionPanel ? (
          <MentionPlugin
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            sessionId={skillCatalogSessionId ?? taskId}
            provider={activeTaskProvider}
            container={triggerPanelContainer}
            disabled={disabled}
            onWhiteboardMentionSelected={onWhiteboardMentionSelected}
          />
        ) : null}
      </LexicalComposer>
    </div>
  );
}

/** A simple error boundary */
function LexicalErrorBoundary({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
