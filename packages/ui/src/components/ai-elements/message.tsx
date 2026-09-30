/*
 * Derived from vercel/ai-elements (packages/elements/src/message.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Button } from "../ui/button.js";
import { ButtonGroup, ButtonGroupText } from "../ui/button-group.js";
import { cn } from "../lib/utils.js";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { EditorInfo, FileStat, OpenInEditorOptions } from "@zcode/shared";
import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import type {
  ComponentProps,
  ErrorInfo,
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import {
  Component,
  createContext,
  forwardRef,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { BundledTheme } from "shiki";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import type { Pluggable, PluggableList } from "unified";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { MarkdownBlockquote } from "@/components/ai-elements/markdown-blockquote.js";
import {
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownUnorderedList,
} from "@/components/ai-elements/markdown-list.js";
import {
  MarkdownTable,
  MarkdownTableBody,
  MarkdownTableCell,
  MarkdownTableHead,
  MarkdownTableHeader,
  MarkdownTableRow,
} from "@/components/ai-elements/markdown-table.js";
import {
  MarkdownImage,
  MarkdownImageParagraph,
  normalizeConsecutiveMarkdownImageBlocks,
  type MarkdownImageProps,
} from "@/components/ai-elements/markdown-image.js";
import { STREAMDOWN_CONTROLS } from "@/components/ai-elements/streamdown-controls.js";
import { resolveMessageLinkOpenTarget } from "@/embeddedBrowserHelpers.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { persistLastSelectedEditorId, readLastSelectedEditorId } from "@/lib/editorPreference.js";
import {
  FileDisplayIcon,
  FOLDER_FILE_ICON_SRC,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  normalizeWorkspaceRelativeFilePath,
  parseMarkdownFileLinkTarget,
  resolveMarkdownFileLink,
} from "@/lib/markdownFileLink.js";
import { stripBalancedAssistantPathQuotes } from "@/lib/assistantPathQuotes.js";
import { getPathLeaf } from "@/lib/path.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { sortInstalledEditorsForFileTree } from "@/workspace-file-tree/helpers.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform, usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { createZCodeFileCitationRemarkPlugin } from "@/lib/zcodeFileCitationRemarkPlugin.js";
import { windowsFileLinkEscapeRemarkPlugin } from "@/lib/windowsFileLinkEscapeRemarkPlugin.js";
import { projectZCodeFileCitations } from "@/lib/zcodeFileCitation.js";
import { rewriteMarkdownArtifactImageSources } from "@zcode/shared";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-ui-base",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <ControlHintTooltip title={tooltip} side="bottom">
        {button}
      </ControlHintTooltip>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(null);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error("MessageBranch components must be used within MessageBranch");
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange],
  );

  const goToPrevious = useCallback(() => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious],
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn("grid w-full gap-2 [&>div]:pb-0", className)} {...props} />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children],
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden",
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({ className, ...props }: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className,
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({ children, ...props }: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({ children, ...props }: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn("border-none bg-transparent text-muted-foreground shadow-none", className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = {
  /** Formal answers in office mode have fixed line breaks and do not overwrite user-saved code preview settings. */
  forceCodeWrap?: boolean;
  className?: string;
  children?: ReactNode;
  dir?: "auto" | "ltr" | "rtl";
  streaming?: boolean;
  streamingAnimationKey?: string;
  workspacePath?: string;
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  sessionId?: string;
  readAttachment?: (params: {
    sessionId: string;
    ref: string;
  }) => Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
  /**
   * Apply theme (store coupling stripping): Determine the light/dark theme for code block highlighting.
   * It is passed in from the upper state by the caller; the default "system" follows the operating system to provide coverage for old call points to be deleted.
   */
  theme?: Theme;
  /**
   * Code preview settings (store coupling stripping): passed in by the caller, the reference must be kept stable.
   * Default DEFAULT_CODE_PREVIEW_SETTINGS.
   */
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenExternalUrl?: (url: string) => void;
  /** Assistant text only on: Projects the full zcode-file-citation as an existing file link. */
  renderZCodeFileCitations?: boolean;
};

export interface MessageFileLinkTarget {
  path: string;
  label: string;
  /** Only used for directory display hints with explicit trailing slashes; must re-stat before opening third-party applications. */
  pathKind?: NonNullable<OpenInEditorOptions["pathKind"]>;
  relativePath?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

// @streamdown/math does not parse `$...$` inline formulas by default, resulting in block-level `$$...$$` in customer messages
// can be rendered while `$c(\mathbf{r})$` will be displayed as-is; chat messages need to be compatible with common Markdown/LaTeX output.
const messageMathPlugin = createMathPlugin({ singleDollarTextMath: true });

function disableSingleTilde(plugin: Pluggable): Pluggable {
  if (!Array.isArray(plugin)) {
    return typeof plugin === "function" ? [plugin, { singleTilde: false }] : plugin;
  }

  const [attacher, existingOptions] = plugin;
  return [
    attacher,
    {
      ...(typeof existingOptions === "object" && existingOptions !== null ? existingOptions : {}),
      singleTilde: false,
    },
  ];
}

const messageCjkRemarkPluginsAfter = cjk.remarkPluginsAfter.map((plugin) => {
  const attacher = Array.isArray(plugin) ? plugin[0] : plugin;
  return attacher === remarkCjkFriendlyGfmStrikethrough ? disableSingleTilde(plugin) : plugin;
});
const messageCjkPlugin: typeof cjk = {
  ...cjk,
  remarkPlugins: [...cjk.remarkPluginsBefore, ...messageCjkRemarkPluginsAfter],
  remarkPluginsAfter: messageCjkRemarkPluginsAfter,
};
const streamdownPlugins = { cjk: messageCjkPlugin, code, math: messageMathPlugin, mermaid };
const messageLinkSafety = { enabled: false } as const;
// `decoration-dashed` will draw the original thin dot underline into a short line segment; here only the underline is changed
// When the opportunity arises, continue to use `dotted` to retain the original visual form.
const messageLinkClassName =
  "wrap-anywhere text-ui-base font-medium text-icon-blue no-underline decoration-dotted underline-offset-4 hover:underline";
// `items-center` makes inline-flex use the browser's synthesized baseline, fix the top offset and drift with the platform font.
// Instead, the text subitem provides the true baseline; the icon is only centered within the link's own line box, and desktop and mobile web share the same semantics.
const messageFileLinkClassName =
  "inline-flex max-w-full items-baseline gap-1 align-baseline text-icon-blue text-ui-base no-underline decoration-dotted underline-offset-4 hover:underline";
// Markdown previously inherited compact UI font sizes, and lacked independent reading levels for text, titles, links, and tables.
// Here, the font size level is explicitly defined and the title scales with the UI font size Token to ensure consistency when chat, preview and tool panel reuse MessageResponse.
const messageMarkdownHeadingClassNames = {
  h1: "mt-6 mb-4 text-ui-xl font-semibold",
  h2: "mt-6 mb-4 text-ui-lg font-semibold",
  h3: "mt-6 mb-4 text-ui-base font-semibold",
  h4: "mt-6 mb-4 text-ui-base font-semibold",
  h5: "mt-6 mb-4 text-ui-base font-medium",
  h6: "mt-6 mb-4 text-ui-base font-normal",
} as const;
const languageClassNamePattern = /(?:^|\s)language-([^\s]+)/;
const fileUrlProtocolPattern = /^file:\/\//i;
const windowsDriveAbsolutePathPattern = /^[a-zA-Z]:[\\/]/;
const knownExtensionlessFileNames = new Set(["gemfile", "license", "makefile", "readme"]);
const markdownFencePattern = /^(?: {0,3})(`{3,}|~{3,})/;
const likelyMathSyntaxPattern = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
const texCommandPattern = /\\[A-Za-z]+/;
const simpleMathIdentifierPattern = /^(?:[A-Za-z]|[a-z][A-Za-z0-9]{1,2}|\d+(?:\.\d+)?)$/;
const compactCurrencyRangePrefixPattern = /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/]$/;
const compactCurrencyAmountStartPattern = /^(?:\d|\.\d)/;

type MarkdownCodeProps = ComponentProps<"code"> & {
  node?: unknown;
  "data-block"?: unknown;
};
type MarkdownHeadingProps = ComponentProps<"h1"> & {
  node?: unknown;
};
type MarkdownStrongProps = ComponentProps<"strong"> & {
  node?: unknown;
};
type MessageStreamdownMode = "static" | "streaming";
type HastElementNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastElementNode[];
};
type MessageResponseBoundaryScope = {
  markdownLength: number;
  mode: MessageStreamdownMode;
  renderStreaming: boolean;
};

interface MessageResponseMarkdownBoundaryProps {
  children: ReactNode;
  className?: string;
  fallbackText: string;
  resetKey: string;
  scope: MessageResponseBoundaryScope;
}

interface MessageResponseMarkdownBoundaryState {
  error: Error | null;
}

function hashMarkdownCacheKey(markdown: string): string {
  let hash = 2166136261;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${markdown.length}:${hash >>> 0}`;
}

function normalizeMarkdownRenderError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "Unknown markdown render error");
}

function getMarkdownFence(line: string): { marker: string; length: number } | null {
  const match = markdownFencePattern.exec(line);

  if (!match) {
    return null;
  }

  const sequence = match[1] ?? "";
  return {
    marker: sequence[0] ?? "",
    length: sequence.length,
  };
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }

  return slashCount % 2 === 1;
}

function isSingleDollarDelimiter(text: string, index: number): boolean {
  return (
    text[index] === "$" &&
    text[index - 1] !== "$" &&
    text[index + 1] !== "$" &&
    !isEscapedMarkdownCharacter(text, index)
  );
}

function findClosingSingleDollarDelimiter(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    if (isSingleDollarDelimiter(text, index)) {
      return index;
    }
  }

  return -1;
}

function isLikelySingleDollarMath(content: string): boolean {
  if (!content || content !== content.trim() || /[\r\n]/.test(content)) {
    return false;
  }

  if (texCommandPattern.test(content) || likelyMathSyntaxPattern.test(content)) {
    return true;
  }

  if (!/\s/.test(content) && simpleMathIdentifierPattern.test(content)) {
    return true;
  }

  return false;
}

function isLikelyCompactCurrencyRangeText(
  text: string,
  closingIndex: number,
  content: string,
): boolean {
  if (!compactCurrencyRangePrefixPattern.test(content)) {
    return false;
  }

  return compactCurrencyAmountStartPattern.test(text.slice(closingIndex + 1));
}

function normalizeSingleDollarMathInText(text: string): string {
  if (!text.includes("$")) {
    return text;
  }

  let output = "";

  for (let index = 0; index < text.length; index++) {
    if (!isSingleDollarDelimiter(text, index)) {
      output += text[index];
      continue;
    }

    const closingIndex = findClosingSingleDollarDelimiter(text, index + 1);

    if (closingIndex === -1) {
      output += text[index];
      continue;
    }

    const content = text.slice(index + 1, closingIndex);

    if (isLikelyCompactCurrencyRangeText(text, closingIndex, content)) {
      // The second `$` in tight price ranges such as `$5-$10` can be mistaken for a formula closure.
      // Escape only the current `$`, leaving the entire paragraph to continue rendering as normal text and retaining the dollar sign.
      output += "\\$";
      continue;
    }

    if (isLikelySingleDollarMath(content)) {
      output += text.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }

    // After turning on singleDollarTextMath, `$5 ... $10` / `$HOME ... $PATH`
    // This type of plain text can be mistaken for formulas. Only escape the current `$`, allowing subsequent `$` to continue scanning as the original text.
    output += "\\$";
  }

  return output;
}

function normalizeSingleDollarMathOutsideInlineCode(line: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);

    if (codeStart === -1) {
      output += normalizeSingleDollarMathInText(line.slice(cursor));
      break;
    }

    output += normalizeSingleDollarMathInText(line.slice(cursor, codeStart));

    let codeFenceEnd = codeStart + 1;
    while (line[codeFenceEnd] === "`") {
      codeFenceEnd++;
    }

    const codeMarker = line.slice(codeStart, codeFenceEnd);
    const codeEnd = line.indexOf(codeMarker, codeFenceEnd);

    if (codeEnd === -1) {
      output += normalizeSingleDollarMathInText(line.slice(codeStart));
      break;
    }

    output += line.slice(codeStart, codeEnd + codeMarker.length);
    cursor = codeEnd + codeMarker.length;
  }

  return output;
}

function normalizeMessageSingleDollarMath(markdown: string): string {
  if (!markdown.includes("$")) {
    return markdown;
  }

  let output = "";
  let cursor = 0;
  let activeFence: { marker: string; length: number } | null = null;

  while (cursor < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", cursor);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const line = markdown.slice(cursor, lineEnd);
    const newline = newlineIndex === -1 ? "" : "\n";
    const fence = getMarkdownFence(line);

    if (activeFence) {
      output += line + newline;

      if (fence && fence.marker === activeFence.marker && fence.length >= activeFence.length) {
        activeFence = null;
      }
    } else {
      output += normalizeSingleDollarMathOutsideInlineCode(line) + newline;

      if (fence) {
        activeFence = fence;
      }
    }

    cursor = lineEnd + newline.length;
  }

  return output;
}

export function resolveMessageStreamdownMode(renderStreaming: boolean): MessageStreamdownMode {
  // There is a user hit React #185 in the production package, and the stack falls in MessageResponse -> Streamdown.
  // In the past, long messages in the completion state would also go to streaming mode for block caching, and Streamdown internal block state
  // State will be synchronized repeatedly on some historical markdown. Now only the real streaming output goes into streaming,
  // The history/completion state content is fixed to be static to avoid participating in the update cycle again when remounting.
  return renderStreaming ? "streaming" : "static";
}

class MessageResponseMarkdownBoundary extends Component<
  MessageResponseMarkdownBoundaryProps,
  MessageResponseMarkdownBoundaryState
> {
  state: MessageResponseMarkdownBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): MessageResponseMarkdownBoundaryState {
    return { error: normalizeMarkdownRenderError(error) };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeMarkdownRenderError(error);
    logger.warn("[MessageResponse] markdown render failed, fell back to plain text", {
      errorName: normalizedError.name,
      errorMessage: normalizedError.message,
      componentStack: errorInfo.componentStack,
      markdownLength: this.props.scope.markdownLength,
      mode: this.props.scope.mode,
      renderStreaming: this.props.scope.renderStreaming,
    });
  }

  override componentDidUpdate(previousProps: MessageResponseMarkdownBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className={this.props.className}>
          {/* When a single markdown rendering exception occurs, it is downgraded to plain text to prevent errors from bubbling up to the boundary of the session area.*/}
          {this.props.fallbackText}
        </div>
      );
    }

    return this.props.children;
  }
}

function formatMarkdownFileLinkTargetHref(href: string): string {
  const parsedTarget = parseMarkdownFileLinkTarget(href);
  // `C:` in the Windows drive letter will be treated as an unknown URI scheme by rehype-harden.
  // Directly replace it with `[blocked]` before the custom file link renderer is run. Temporary patch `/C:/...`
  // Let the security layer pass the normal path; resolveMarkdownFileLink will be restored symmetrically on the Windows Host.
  const path = windowsDriveAbsolutePathPattern.test(parsedTarget.path)
    ? `/${parsedTarget.path.replaceAll("\\", "/")}`
    : fileUrlProtocolPattern.test(href)
      ? parsedTarget.path
      : parsedTarget.path.startsWith("./") ||
          parsedTarget.path.startsWith("/") ||
          parsedTarget.path.startsWith("#") ||
          parsedTarget.path.startsWith("../") ||
          /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsedTarget.path)
        ? parsedTarget.path
        : `./${parsedTarget.path}`;
  if (parsedTarget.lineNumber === null) {
    return path;
  }

  if (parsedTarget.columnNumber === null) {
    return `${path}:${parsedTarget.lineNumber}`;
  }

  return `${path}:${parsedTarget.lineNumber}:${parsedTarget.columnNumber}`;
}

function shouldRewriteMarkdownFileLinkHref(href: string): boolean {
  if (resolveMarkdownFileLink(undefined, href)) {
    return true;
  }

  const parsedTarget = parseMarkdownFileLinkTarget(href);
  return (
    Boolean(parsedTarget.path) &&
    !parsedTarget.path.startsWith("/") &&
    !parsedTarget.path.startsWith("#") &&
    !parsedTarget.path.startsWith("../") &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsedTarget.path) &&
    // If the out-of-bounds path passes through rehype rewrite/harden first, `..` may be lost after normalization by the URL.
    // The original escape intent cannot be restored by clicking on the layer; relative path lexical boundary checks must be reused before overwriting.
    normalizeWorkspaceRelativeFilePath(parsedTarget.path) !== null &&
    // `[README.md](README.md)` Such naked file name links were not rewritten before harden.
    // Streamdown will treat it as an unsafe link and render it as `[blocked]`. Naked paths with extensions are treated as workspace files.
    // First, format it into `./README.md`, and then give it to a unified file link to open logical analysis.
    (parsedTarget.path.includes("/") ||
      parsedTarget.path.includes("\\") ||
      hasFileExtension(getPathLeaf(parsedTarget.path)))
  );
}

function rewriteLocalFileMarkdownTargetsRehypePlugin() {
  return (tree: HastElementNode) => {
    const visitNode = (node: HastElementNode) => {
      const targetProperty = node.tagName === "a" ? "href" : node.tagName === "img" ? "src" : null;
      if (
        node.type === "element" &&
        targetProperty &&
        typeof node.properties?.[targetProperty] === "string" &&
        shouldRewriteMarkdownFileLinkHref(node.properties[targetProperty])
      ) {
        // Markdown images and links will go through rehype-harden first. `file://` will be blocked by the security layer.
        // The naked file name will be treated as an unknown URL; here it is unified into a local path/relative path before harden.
        node.properties[targetProperty] = formatMarkdownFileLinkTargetHref(
          node.properties[targetProperty],
        );
      }

      node.children?.forEach(visitNode);
    };

    visitNode(tree);
  };
}

const messageRehypePlugins: PluggableList = [
  rewriteLocalFileMarkdownTargetsRehypePlugin,
  ...Object.values(defaultRehypePlugins),
];

const messageDefaultRemarkPlugins: PluggableList = Object.entries(defaultRemarkPlugins).map(
  ([name, plugin]) => {
    if (name !== "gfm") {
      return plugin;
    }

    // Both remark-gfm and Streamdown CJK strikethrough extensions enable singleTilde by default.
    // The latter will also overwrite the parsing results of the former; both must be closed at the same time in order for `~text~` to retain the original text according to GFM specifications.
    return disableSingleTilde(plugin);
  },
);

function resolveMessageCodeTheme(
  theme: Theme,
  codePreviewSettings: { lightTheme: BundledTheme; darkTheme: BundledTheme },
): BundledTheme {
  if (theme === "system" && typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? codePreviewSettings.darkTheme
      : codePreviewSettings.lightTheme;
  }

  return theme === "dark" || theme === "zai-dark"
    ? codePreviewSettings.darkTheme
    : codePreviewSettings.lightTheme;
}

export function buildMessageStreamdownRenderKey(params: {
  attachmentReaderEpoch?: number;
  codeBlockTheme: BundledTheme;
  fontSizePx: number;
  renderZCodeFileCitations?: boolean;
  sessionId?: string;
  workspacePath?: string;
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  wrapLongLines: boolean;
}): string {
  // streaming/static is only parsing mode and should not participate in React key; otherwise the streaming status jitter will be uninstalled
  // The entire markdown subtree allows the displayed text to re-trigger the fade-in animation.
  return [
    params.sessionId ?? "",
    params.attachmentReaderEpoch ?? 0,
    params.codeBlockTheme,
    params.fontSizePx,
    params.wrapLongLines ? "wrap" : "scroll",
    params.renderZCodeFileCitations ? "citations" : "plain",
    params.workspacePath ?? "",
    params.workspaceHomePath ?? "",
    params.workspaceIdentity ?? "",
    params.workspaceRemoteSessionId ?? "",
  ].join(":");
}

const attachmentReaderEpochs = new WeakMap<
  NonNullable<MessageResponseProps["readAttachment"]>,
  number
>();
let nextAttachmentReaderEpoch = 1;

function getAttachmentReaderEpoch(readAttachment: MessageResponseProps["readAttachment"]): number {
  if (!readAttachment) return 0;
  const existing = attachmentReaderEpochs.get(readAttachment);
  if (existing !== undefined) return existing;
  const epoch = nextAttachmentReaderEpoch++;
  attachmentReaderEpochs.set(readAttachment, epoch);
  return epoch;
}

function getCodeLanguage(className?: string): string {
  return className?.match(languageClassNamePattern)?.[1] ?? "text";
}

function extractCodeText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map(extractCodeText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(children)) {
    return extractCodeText(children.props.children);
  }

  return "";
}

function extractLinkLabelText(children: ReactNode): string {
  return extractCodeText(children).trim();
}

function hasFileExtension(pathLeaf: string): boolean {
  return /\.[^./\\]+$/.test(pathLeaf);
}

function isExplicitDirectoryMarkdownLink(path: string, href: string): boolean {
  const trimmedHref = href.trim();
  return /[\\/]$/.test(trimmedHref) || /[\\/]$/.test(path);
}

export function buildMessageFileLinkTarget(input: {
  href: string;
  label: string;
  path: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): MessageFileLinkTarget {
  // Whether the file name has an extension cannot represent the file system type; files without extensions such as env, hosts, config, etc.
  // In the past, it would be misjudged as a directory. Only explicit trailing slashes are retained here as icon prompts, and the opening method must be stat.
  const pathKind = isExplicitDirectoryMarkdownLink(input.path, input.href)
    ? ("directory" as const)
    : undefined;
  return {
    path: input.path,
    label: input.label,
    pathKind,
    relativePath: input.workspacePath
      ? getWorkspaceFileRelativePath(input.workspacePath, input.path)
      : input.label,
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    workspaceRemoteSessionId: input.workspaceRemoteSessionId,
  };
}

export async function openMessageFileLinkInEditor({
  editorId,
  fileLink,
  openInEditor,
  remoteTarget,
  statFile,
}: {
  editorId: string;
  fileLink: MessageFileLinkTarget;
  openInEditor: (
    editorId: string,
    path: string,
    options: OpenInEditorOptions,
  ) => Promise<{ success: boolean; error?: string }>;
  remoteTarget?: OpenInEditorOptions["remoteTarget"];
  statFile: (params: { path: string }) => Promise<Pick<FileStat, "type">>;
}) {
  // The Markdown rendering layer cannot reliably determine files/directories from their names. Here passed when the action occurs
  // The file service of the current workspace scope takes the real type, and the native application will not be called when stat fails.
  const fileStat = await statFile({ path: fileLink.path });
  return openInEditor(editorId, fileLink.path, {
    pathKind: fileStat.type,
    remoteTarget,
    workspaceIdentity: fileLink.workspaceIdentity,
  });
}

function trimCodeFenceTrailingNewlines(codeText: string): string {
  return codeText.replace(/\n+$/, "");
}

function isExternalWebHref(href: string): boolean {
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

interface MessageExternalLinkProps extends ComponentProps<"button"> {
  href: string;
  onOpenExternalUrl: (url: string) => void;
}

function MessageExternalLink({
  children,
  className,
  href,
  onClick,
  onOpenExternalUrl,
  ...props
}: MessageExternalLinkProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const handleOpen = useCallback(
    (options: { forceExternal?: boolean; forceInApp?: boolean } = {}) => {
      // Interaction semantics: The local/private network whitelist only determines the default target of left-click; the two items in the right-click menu each force a target.
      // The "Open" menu reuses the default left-click behavior in the past, and public network links (such as Feishu documents) will jump to the system browser.
      const target = resolveMessageLinkOpenTarget({ href, ...options });
      logger.debug("[MessageExternalLink] opening markdown external link", {
        forceExternal: Boolean(options.forceExternal),
        forceInApp: Boolean(options.forceInApp),
        href,
        target,
      });

      if (target === "app-browser" || !platform) {
        // Share/Normal Web does not have a Desktop PlatformProvider; still leaves it to the caller's secure URL handler,
        // Prevent MessageResponse from being downgraded to plain text due to lack of host context.
        onOpenExternalUrl(href);
        return;
      }

      platform.openExternal(href);
    },
    [href, onOpenExternalUrl, platform],
  );
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }

      handleOpen({ forceExternal: event.metaKey || event.ctrlKey });
    },
    [handleOpen, onClick],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            messageLinkClassName,
            "cursor-pointer bg-transparent p-0 text-left",
            className,
          )}
          title={href}
          {...props}
          // Markdown external links were previously downgraded to spans. Users could see the links but could not click on them.
          // Here, native a tag jumps are still blocked, but all http/https are no longer sent to the built-in browser by default.
          onClick={handleClick}
        >
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => handleOpen({ forceInApp: true })}>
          {intl.formatMessage({ id: "common.open" })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleOpen({ forceExternal: true })}>
          <ExternalLinkIcon className="size-4" />
          <span>{intl.formatMessage({ id: "chat.previewCards.openExternal" })}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface MessageFileLinkButtonProps extends ComponentProps<"button"> {
  fileIconSrc: string;
  fileLink: MessageFileLinkTarget;
  onOpen: () => void;
}

const MessageFileLinkButton = forwardRef<HTMLButtonElement, MessageFileLinkButtonProps>(
  function MessageFileLinkButton(
    { children, className, fileIconSrc, fileLink, onOpen, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(messageFileLinkClassName, "cursor-pointer", className)}
        title={fileLink.path}
        onClick={onOpen}
        {...props}
      >
        <FileDisplayIcon src={fileIconSrc} size={16} className="ml-0.5 shrink-0 self-center" />
        <span className="min-w-0 self-baseline truncate">{children}</span>
      </button>
    );
  },
);

interface MessageFileLinkProps {
  className?: string;
  fileIconSrc: string;
  fileLink: MessageFileLinkTarget;
  onOpen: () => void;
}

function MessageFileLink({ className, fileIconSrc, fileLink, onOpen }: MessageFileLinkProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const services = useOptionalServices();
  const fileActions = useFileContextActions();
  const openInEditorContext = useWorkspaceOpenInEditorTarget({
    workspacePath: fileLink.workspacePath,
    workspaceIdentity: fileLink.workspaceIdentity,
    workspaceRemoteSessionId: fileLink.workspaceRemoteSessionId,
  });
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  const sortedEditors = useMemo(
    () =>
      openInEditorContext.isRemoteWorkspace && !openInEditorContext.remoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors: editors,
            selectedEditorId: null,
            remoteTarget: openInEditorContext.remoteTarget,
          }).availableEditors,
    [editors, openInEditorContext],
  );
  const selectedEditor = useMemo(() => {
    const selectedEditorId = readLastSelectedEditorId();
    return (
      sortedEditors.find((editor) => editor.id === selectedEditorId) ?? sortedEditors[0] ?? null
    );
  }, [sortedEditors]);

  const loadEditors = useCallback(async () => {
    if (editorsLoaded || loadingEditors) {
      return;
    }

    setLoadingEditors(true);
    try {
      const installedEditors = await platform.getInstalledEditors();
      setEditors(installedEditors);
      setEditorsLoaded(true);
    } catch (error) {
      logger.warn("[MessageResponse] failed to get open target for markdown link", {
        path: fileLink.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingEditors(false);
    }
  }, [editorsLoaded, fileLink.path, loadingEditors, platform]);

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (!services) {
      logger.warn("[MessageResponse] cannot determine markdown link file type", {
        editorId: editor.id,
        path: fileLink.path,
        error: "workspace-file-service-unavailable",
      });
      return;
    }

    persistLastSelectedEditorId(editor.id);
    void openMessageFileLinkInEditor({
      editorId: editor.id,
      fileLink,
      openInEditor: (editorId, path, options) => platform.openInEditor(editorId, path, options),
      remoteTarget: openInEditorContext.remoteTarget,
      statFile: (params) => services.fileService.stat(params),
    })
      .then((result) => {
        if (result.success) {
          return;
        }

        logger.warn("[MessageResponse] third-party app failed to open markdown file link", {
          editorId: editor.id,
          path: fileLink.path,
          error: result.error ?? "unknown-error",
        });
      })
      .catch((error) => {
        logger.warn("[MessageResponse] cannot determine markdown link file type", {
          editorId: editor.id,
          path: fileLink.path,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return (
    <ContextMenu onOpenChange={(open) => open && void loadEditors()}>
      <ContextMenuTrigger asChild>
        <MessageFileLinkButton
          className={className}
          fileIconSrc={fileIconSrc}
          fileLink={fileLink}
          onOpen={onOpen}
        >
          {fileLink.label}
        </MessageFileLinkButton>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onOpen}>
          {intl.formatMessage({ id: "common.open" })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {selectedEditor ? (
          sortedEditors.map((editor) => (
            <ContextMenuItem key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
              <img src={editor.iconDataUrl} alt={editor.name} className="size-4 shrink-0" />
              <span>{editor.name}</span>
            </ContextMenuItem>
          ))
        ) : (
          <ContextMenuItem disabled>
            {intl.formatMessage({
              id: loadingEditors ? "common.loading" : "chat.previewCards.noOpenApps",
            })}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void fileActions.copyAbsolutePath({ path: fileLink.path })}
        >
          <CopyIcon className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void fileActions.copyRelativePath({
              path: fileLink.path,
              relativePath: fileLink.relativePath ?? fileLink.label,
            })
          }
        >
          <CopyIcon className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MessageMarkdownHeading({
  className,
  headingLevel,
  node: _node,
  ...props
}: MarkdownHeadingProps & {
  headingLevel: keyof typeof messageMarkdownHeadingClassNames;
}) {
  const headingClassName = cn(messageMarkdownHeadingClassNames[headingLevel], className);
  const dataStreamdown = `heading-${headingLevel.slice(1)}`;

  if (headingLevel === "h1") {
    return <h1 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h2") {
    return <h2 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h3") {
    return <h3 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h4") {
    return <h4 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h5") {
    return <h5 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  return <h6 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
}

export const messageResponsePropsAreEqual = (
  prevProps: Readonly<MessageResponseProps>,
  nextProps: Readonly<MessageResponseProps>,
): boolean =>
  prevProps.children === nextProps.children &&
  prevProps.forceCodeWrap === nextProps.forceCodeWrap &&
  nextProps.streaming === prevProps.streaming &&
  nextProps.streamingAnimationKey === prevProps.streamingAnimationKey &&
  nextProps.workspacePath === prevProps.workspacePath &&
  nextProps.workspaceHomePath === prevProps.workspaceHomePath &&
  nextProps.workspaceIdentity === prevProps.workspaceIdentity &&
  nextProps.workspaceRemoteSessionId === prevProps.workspaceRemoteSessionId &&
  nextProps.sessionId === prevProps.sessionId &&
  nextProps.readAttachment === prevProps.readAttachment &&
  nextProps.renderZCodeFileCitations === prevProps.renderZCodeFileCitations &&
  nextProps.theme === prevProps.theme &&
  nextProps.codePreviewSettings === prevProps.codePreviewSettings &&
  nextProps.onOpenCodeViewer === prevProps.onOpenCodeViewer &&
  nextProps.onOpenFileLink === prevProps.onOpenFileLink &&
  nextProps.onOpenExternalUrl === prevProps.onOpenExternalUrl;

export const MessageResponse = memo(
  ({
    className,
    streaming = false,
    forceCodeWrap = false,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenExternalUrl,
    renderZCodeFileCitations = false,
    workspacePath,
    workspaceHomePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    sessionId,
    readAttachment,
    theme = "system",
    codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
    children,
  }: MessageResponseProps) => {
    const wrapLongLines = forceCodeWrap || codePreviewSettings.wrapLongLines;
    const rawMarkdown = useMemo(() => extractCodeText(children), [children]);
    const renderStreaming = streaming;
    const projectedCitationMarkdown = useMemo(
      () =>
        renderZCodeFileCitations
          ? projectZCodeFileCitations(rawMarkdown, { streaming: renderStreaming }).visibleText
          : rawMarkdown,
      [rawMarkdown, renderStreaming, renderZCodeFileCitations],
    );
    const targetMarkdown = useMemo(
      () =>
        rewriteMarkdownArtifactImageSources(
          normalizeMessageSingleDollarMath(
            normalizeConsecutiveMarkdownImageBlocks(projectedCitationMarkdown),
          ),
        ),
      [projectedCitationMarkdown],
    );
    const streamdownMode = resolveMessageStreamdownMode(renderStreaming);
    const messageRemarkPlugins = useMemo<PluggableList>(
      () => [
        // Explicitly passing remarkPlugins will override the Streamdown default plug-in;
        // The citation must be passed in with the default GFM plug-in, otherwise the table will degenerate into ordinary paragraphs.
        ...messageDefaultRemarkPlugins,
        // `\.` in Windows absolute path links will be eaten as punctuation escapes during remark parsing.
        // The original text is no longer visible during the rehype stage. This restoration must take effect unconditionally and cannot be hung under the citation switch.
        windowsFileLinkEscapeRemarkPlugin,
        ...(renderZCodeFileCitations && workspacePath
          ? [createZCodeFileCitationRemarkPlugin(workspacePath, workspaceHomePath)]
          : []),
      ],
      [renderZCodeFileCitations, workspaceHomePath, workspacePath],
    );
    const responseClassName = cn(
      "size-full text-ui-base leading-[1.75] tracking-wide [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      className,
    );
    const fallbackClassName = cn(responseClassName, "whitespace-pre-wrap break-words");
    const boundaryResetKey = useMemo(
      () =>
        renderStreaming
          ? `streaming:${streamdownMode}`
          : `${streamdownMode}:${renderZCodeFileCitations ? "citations" : "plain"}:${hashMarkdownCacheKey(targetMarkdown)}`,
      [renderStreaming, renderZCodeFileCitations, streamdownMode, targetMarkdown],
    );
    const boundaryScope = useMemo<MessageResponseBoundaryScope>(
      () => ({
        markdownLength: targetMarkdown.length,
        mode: streamdownMode,
        renderStreaming,
      }),
      [renderStreaming, streamdownMode, targetMarkdown.length],
    );
    const codeBlockTheme = useMemo(
      () => resolveMessageCodeTheme(theme, codePreviewSettings),
      [codePreviewSettings, theme],
    );
    const shikiTheme = useMemo(
      () =>
        [codePreviewSettings.lightTheme, codePreviewSettings.darkTheme] as [
          BundledTheme,
          BundledTheme,
        ],
      [codePreviewSettings.lightTheme, codePreviewSettings.darkTheme],
    );
    const streamdownRenderKey = useMemo(() => {
      return (
        buildMessageStreamdownRenderKey({
          attachmentReaderEpoch: getAttachmentReaderEpoch(readAttachment),
          codeBlockTheme,
          fontSizePx: codePreviewSettings.fontSizePx,
          renderZCodeFileCitations,
          sessionId,
          workspacePath,
          workspaceHomePath,
          workspaceIdentity,
          workspaceRemoteSessionId,
          wrapLongLines,
        }) + (forceCodeWrap ? ":wrap-locked" : "")
      );
    }, [
      codeBlockTheme,
      codePreviewSettings.fontSizePx,
      wrapLongLines,
      forceCodeWrap,
      renderZCodeFileCitations,
      readAttachment,
      sessionId,
      workspaceHomePath,
      workspacePath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    ]);
    const messageComponents = useMemo(
      () => ({
        a: ({
          children,
          className: linkClassName,
          href,
          node: _node,
        }: ComponentProps<"a"> & { node?: unknown }) => {
          const resolvedHref =
            typeof href === "string" ? stripBalancedAssistantPathQuotes(href) : "";
          const fileLink = resolveMarkdownFileLink(workspacePath, resolvedHref, {
            homePath: workspaceHomePath,
          });

          if (fileLink && (onOpenFileLink || onOpenCodeViewer)) {
            const descriptor = resolveFileDisplayDescriptor(fileLink.path);
            const fileName = descriptor.fileName || getPathLeaf(fileLink.path);
            const labelText = extractLinkLabelText(children) || fileName;
            const fileLinkTarget = buildMessageFileLinkTarget({
              href: resolvedHref,
              path: fileLink.path,
              label: labelText,
              workspacePath,
              workspaceIdentity,
              workspaceRemoteSessionId,
            });
            const fileIconSrc =
              fileLinkTarget.pathKind === "directory"
                ? FOLDER_FILE_ICON_SRC
                : descriptor.fileIconSrc;
            return (
              <MessageFileLink
                className={linkClassName}
                fileIconSrc={fileIconSrc}
                fileLink={fileLinkTarget}
                onOpen={() => {
                  if (onOpenFileLink) {
                    onOpenFileLink(fileLinkTarget);
                    return;
                  }
                  onOpenCodeViewer?.({
                    type: "file",
                    title: getPathLeaf(fileLink.path),
                    path: fileLink.path,
                    workspacePath,
                    workspaceIdentity,
                    workspaceRemoteSessionId,
                  });
                }}
              />
            );
          }

          if (isExternalWebHref(resolvedHref) && onOpenExternalUrl) {
            return (
              <MessageExternalLink
                className={linkClassName}
                href={resolvedHref}
                onOpenExternalUrl={onOpenExternalUrl}
              >
                {children}
              </MessageExternalLink>
            );
          }

          return (
            <span
              className={cn(messageLinkClassName, linkClassName)}
              title={resolvedHref || undefined}
            >
              {children}
            </span>
          );
        },
        img: (imageProps: MarkdownImageProps) => (
          <MarkdownImage
            {...imageProps}
            workspacePath={workspacePath}
            workspaceHomePath={workspaceHomePath}
            sessionId={sessionId}
            readAttachment={readAttachment}
          />
        ),
        p: MarkdownImageParagraph,
        h1: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h1" />
        ),
        h2: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h2" />
        ),
        h3: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h3" />
        ),
        h4: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h4" />
        ),
        h5: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h5" />
        ),
        h6: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h6" />
        ),
        strong: ({
          className: strongClassName,
          node: _node,
          ...strongProps
        }: MarkdownStrongProps) => (
          <strong className={cn("font-medium", strongClassName)} {...strongProps} />
        ),
        code: ({
          children,
          className: codeClassName,
          node: _node,
          ...codeProps
        }: MarkdownCodeProps) => {
          const isBlockCode = "data-block" in codeProps;

          if (!isBlockCode) {
            return (
              <code
                className={cn(
                  "rounded-md bg-markdown-inline-code/50 mx-0.5 px-1.5 py-0.5 font-mono text-ui-sm",
                  codeClassName,
                )}
                {...codeProps}
              >
                {children}
              </code>
            );
          }

          const codeText = trimCodeFenceTrailingNewlines(extractCodeText(children));
          const language = getCodeLanguage(codeClassName);

          return (
            <CodeBlock
              className="my-4 border border-border bg-card"
              code={codeText}
              // Code fences in streaming messages will be repeatedly split/remounted by Streamdown.
              // Highlighting waits for the message to be completed before starting it to avoid overlapping of async highlighter and message flow updates to trigger React #185.
              enableSyntaxHighlighting={!renderStreaming}
              fontSizePx={codePreviewSettings.fontSizePx}
              language={language}
              renderMermaid={!renderStreaming}
              theme={codeBlockTheme}
              appTheme={theme}
              wrapLongLines={wrapLongLines}
            >
              <CodeBlockHeader
                className="pl-3 pr-2 pt-2"
                language={language}
                showWrapButton={!forceCodeWrap}
              />
            </CodeBlock>
          );
        },
        blockquote: MarkdownBlockquote,
        li: MarkdownListItem,
        ol: MarkdownOrderedList,
        table: MarkdownTable,
        tbody: MarkdownTableBody,
        td: MarkdownTableCell,
        th: MarkdownTableHead,
        thead: MarkdownTableHeader,
        tr: MarkdownTableRow,
        ul: MarkdownUnorderedList,
      }),
      [
        codeBlockTheme,
        codePreviewSettings.fontSizePx,
        wrapLongLines,
        forceCodeWrap,
        onOpenFileLink,
        onOpenCodeViewer,
        onOpenExternalUrl,
        readAttachment,
        renderStreaming,
        sessionId,
        theme,
        workspaceHomePath,
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
      ],
    );

    return (
      <MessageResponseMarkdownBoundary
        className={fallbackClassName}
        fallbackText={targetMarkdown}
        resetKey={boundaryResetKey}
        scope={boundaryScope}
      >
        <Streamdown
          key={streamdownRenderKey}
          className={responseClassName}
          // Streamdown itself is memo, and the comparison function does not look at components. When switching app light/dark
          // codeBlockTheme only exists in the custom code renderer closure. If the key is not changed, the current task will be mounted.
          // The markdown code block will not re-execute the renderer; the correct theme will be restored only after switching tasks triggers a rebuild.
          // Artifact reader/session also only exists in the img renderer closure. Must be remounted when permission context changes
          // markdown subtree, freeing the old blob URL and ensuring that subsequent reads only use the current session's reader.
          // The streaming mode has been running until the message has ended, which will trigger Remend to perform "unclosed markdown completion" on the text.
          // When encountering code fragments such as `./src/**/*`, remend will misjudge it as unclosed bold and add `**` at the end.
          // Performance optimization has enabled long history messages to be reused in block streaming mode; virtual scrolling/lazy rendering will
          // Frequently reloading historical messages, and encountering some markdown in production will trigger React #185 inside Streamdown.
          // The re-convergence here is: only the real streaming output is parsed by streaming, and the completion state is always static.
          mode={streamdownMode}
          components={messageComponents}
          parseIncompleteMarkdown={streaming}
          // The highlighted-body of Streamdown's built-in code renderer will display the code highlight results and raw fallback
          // setState is repeated, React #185 will be triggered when some historical messages are restored. Markdown parsing capabilities are retained here,
          // But CodeBlock uses the project's own stable CodeBlock renderer instead.
          // Note: Here we continue to turn off the default link behavior of Streamdown, and change it to the custom a renderer above to take over.
          // In this way, both workspace file links and http/https external links can go through our own secure diversion, and other protocols remain unclickable.
          linkSafety={messageLinkSafety}
          plugins={streamdownPlugins}
          controls={STREAMDOWN_CONTROLS}
          // Streamdown's harden plug-in will mark file:// as [blocked] before customizing a renderer.
          // Here, the file URI is first adjusted to the local path href, and the subsequent resolveMarkdownFileLink uses the preview/file tree opening logic in a unified manner.
          rehypePlugins={messageRehypePlugins}
          remarkPlugins={messageRemarkPlugins}
          shikiTheme={shikiTheme}
          // Markdown text streaming fade-in will cause the entire historical text to re-flash when re-rendering.
          // The streaming parsing mode is retained here, but the Streamdown/text rehype animation is completely turned off.
          animated={false}
          isAnimating={false}
        >
          {targetMarkdown}
        </Streamdown>
      </MessageResponseMarkdownBoundary>
    );
  },
  messageResponsePropsAreEqual,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn("mt-4 flex w-full items-center justify-between gap-4", className)} {...props}>
    {children}
  </div>
);
