/* eslint-disable max-lines */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME,
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodeProvider,
} from "@zcode/shared";
import { MAX_PERMISSION_FEEDBACK_CHARS } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import {
  getPermissionOptionDisplayKind,
  getPermissionRequestPreview,
  shouldPreferPermissionOptionName,
  sortPermissionOptions,
  type PermissionRequestScope,
} from "@/lib/permissionRequest.js";
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import { isPlainRecord, readRawToolCallInput } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { SearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import { SkillToolCallBlock } from "@/ToolCallBlocks/renderers/skill.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import { WorkflowPermissionBlock } from "@/WorkflowPermissionBlock.js";
import { SaveWorkflowPermissionBlock } from "@/SaveWorkflowPermissionBlock.js";
import { isSaveWorkflowToolCall } from "@/lib/workflowToolNames.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { Info, LoaderIcon, WrenchIcon } from "lucide-react";

const MCP_PERMISSION_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type PermissionBlockKind =
  | "edit"
  | "execute"
  | "mcp"
  | "search"
  | "skill"
  | "workflow"
  | "saveWorkflow"
  | "fallback";

interface PermissionBlockInteraction {
  canToggle: boolean;
  forceOpen: boolean;
}

interface PermissionRuleScope {
  display: string;
  truncated: boolean;
}

const PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS = 160;
const NON_USER_FACING_PERMISSION_REASONS = new Set([
  "High risk tools require explicit approval",
  "Tool has side effects and requires approval",
]);

function formatPermissionRuleScope(content: string): PermissionRuleScope {
  const lineBreakIndex = content.search(/\r?\n/);
  const firstLine = lineBreakIndex === -1 ? content : content.slice(0, lineBreakIndex);
  const truncated =
    lineBreakIndex !== -1 || firstLine.length > PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS;

  const suffix = " …";
  const visible = firstLine
    .slice(0, PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS - suffix.length)
    .trimEnd();
  return { display: `${visible}${suffix}`, truncated };
}

function readPermissionRuleScopes(option: ZCodePermissionOption): PermissionRuleScope[] {
  const scopes: PermissionRuleScope[] = [];
  for (const update of option.response?.permissionUpdates ?? []) {
    if (update.type !== "addRules" || update.behavior !== "allow") continue;
    for (const rule of update.rules) {
      if (rule.toolName.toLowerCase() !== "bash") continue;
      const content = rule.ruleContent?.trim();
      if (!content?.endsWith(":*")) continue;
      scopes.push(formatPermissionRuleScope(content.slice(0, -2)));
    }
  }
  return scopes.slice(0, 5);
}

function isOfficialCuaProjectPermission(option: ZCodePermissionOption): boolean {
  return (option.response?.permissionUpdates ?? []).some(
    (update) =>
      update.type === "addRules" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
}

/**
 * workflow Refine (reject with modification comments).
 * This option is not rendered as a button, but serves as the response target of the feedback line: the user writes modification comments in the same numbered input line of other confirmation windows.
 * When submitting, the response carries freeText, and the CLI broker upgrades deny to user feedback with workflow_refine_feedback accordingly.
 */
function isWorkflowRefineOption(option: ZCodePermissionOption): boolean {
  return option.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID;
}

function InlinePermissionPrefixScopes({ scopes }: { scopes: readonly PermissionRuleScope[] }) {
  if (scopes.length === 0) return null;
  return (
    <span
      className="flex min-w-0 flex-1 basis-48 flex-col gap-1"
      data-permission-rule-scopes="true"
      data-permission-rule-prefixes="true"
    >
      {scopes.map((scope, index) => (
        <code
          key={`${scope.display}:${index}`}
          className="min-w-0 whitespace-pre-wrap break-all font-mono text-ui-base leading-5 text-foreground-subtle"
          data-permission-rule-scope="prefix"
          data-permission-rule-scope-truncated={scope.truncated ? "true" : undefined}
        >
          {scope.display}
        </code>
      ))}
    </span>
  );
}

function getOptionLabelMessageId(kind: string): string | null {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return "chat.permission.approve";
    case "allowAlways":
      return "chat.permission.approveAlways";
    case "rejectOnce":
      return "chat.permission.deny";
    case "rejectAlways":
      return "chat.permission.denyAlways";
    default:
      return null;
  }
}

const PROVIDER_PERMISSION_OPTION_NAME_LABELS: Partial<
  Record<ZCodeProvider, Record<string, string>>
> = {
  glm: {
    // The project-level memory authorization copy sent by GLM/ZCode Agent through ZCode Agent is the original English text.
    // Here, the known provider-native permission text is unified to i18n to avoid being regarded as a custom option in English.
    "always allow in this project": "chat.permission.allowForProject",
  },
};

interface PermissionOptionNameMessageIds {
  label: string;
  /** The description derived by kind can be overridden when hit by name: session-level options cannot inherit the project-level copy of "Don't ask again for the same request". */
  description?: string;
}

const GLOBAL_PERMISSION_OPTION_NAME_LABELS: Record<string, PermissionOptionNameMessageIds> = {
  "full access": {
    label: "chat.permission.fullAccess",
    description: "chat.permission.fullAccess.description",
  },
  "always allow in this project": { label: "chat.permission.allowForProject" },
  "always allow computer use in this project": { label: "chat.permission.cua.allowForProject" },
  // The workflow runs the confirmation window session without confirmation:
  // On the CLI side, name is the matching key, and wire kind is allowAlways (the sorting/style is the same as always allow).
  "always allow in this session": {
    label: "chat.permission.workflow.allowForSession",
    description: "chat.permission.workflow.allowForSession.description",
  },
};

function getProviderOptionNameMessageIds(
  provider: ZCodeProvider | undefined,
  name: string,
): PermissionOptionNameMessageIds | null {
  const normalizedName = name.trim().replace(/\s+/g, " ").toLowerCase();
  const global = GLOBAL_PERMISSION_OPTION_NAME_LABELS[normalizedName];
  if (global) {
    return global;
  }
  const providerLabel = provider
    ? PROVIDER_PERMISSION_OPTION_NAME_LABELS[provider]?.[normalizedName]
    : undefined;
  return providerLabel ? { label: providerLabel } : null;
}

function getOptionDescriptionMessageId(kind: string, scope: PermissionRequestScope): string | null {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return "chat.permission.allowOnce.description";
    case "allowAlways":
      return `chat.permission.allowAlways.description.${scope}`;
    case "rejectOnce":
      return "chat.permission.denyOnce.description";
    case "rejectAlways":
      return `chat.permission.denyAlways.description.${scope}`;
    default:
      return null;
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readUserFacingPermissionReason(value: unknown): string | null {
  const reason = readNonEmptyString(value);
  // The general permission policy reason is used for protocol diagnosis and is not a specific description that can help users judge this operation.
  // Previously, the UI displayed reason indiscriminately, causing the permission pop-up window to repeatedly appear with the same English text as "waiting for confirmation".
  return reason && !NON_USER_FACING_PERMISSION_REASONS.has(reason) ? reason : null;
}

function getPermissionDisplayReason(request: ZCodePermissionRequest): string | null {
  const rawInput = readRawToolCallInput(request.raw);
  const inputReason = isPlainRecord(rawInput)
    ? (readUserFacingPermissionReason(rawInput.description) ??
      readUserFacingPermissionReason(rawInput.reason) ??
      readUserFacingPermissionReason(rawInput.summary))
    : null;
  const rawReason = isPlainRecord(request.raw)
    ? readUserFacingPermissionReason(request.raw.reason)
    : null;

  return inputReason ?? readUserFacingPermissionReason(request.description) ?? rawReason;
}

function getMcpPermissionToolName(toolCall: TaskChatToolCall): string | null {
  const rawToolName = isPlainRecord(toolCall.raw)
    ? (readNonEmptyString(toolCall.raw.toolName) ?? readNonEmptyString(toolCall.raw.tool_name))
    : null;
  const toolName =
    readNonEmptyString(toolCall.toolName) ??
    rawToolName ??
    readNonEmptyString(toolCall.kind) ??
    readNonEmptyString(toolCall.title);

  return toolName?.startsWith("mcp__") ? toolName : null;
}

function getMcpPermissionReason(toolCall: TaskChatToolCall): string | null {
  return isPlainRecord(toolCall.raw) ? readNonEmptyString(toolCall.raw.reason) : null;
}

function resolvePermissionBlockKind(
  preview: ReturnType<typeof getPermissionRequestPreview>,
  toolCall: TaskChatToolCall,
  rawFileSummaries: ToolCallBlockRenderContext["rawFileSummaries"],
): PermissionBlockKind {
  // SaveWorkflow is determined first by **tool name**, earlier than file summary and family distribution. It normalizes into parameters with `path`
  // With the complete `script`, any heuristic that "looks like writing a file" may suck it into the edit block; while workflow
  // Once the family name is registered, it will fall into the run confirmation block (Figure + Refine, which is completely the wrong language for writing a disk at once).
  if (isSaveWorkflowToolCall(toolCall)) {
    return "saveWorkflow";
  }

  if (rawFileSummaries.length > 0 || preview.fileChanges.length > 0) {
    return "edit";
  }

  const identity = resolveToolCallIdentity(toolCall);

  if (getMcpPermissionToolName(toolCall)) {
    // MCP permission requests are not ordinary unknown tools; in the past, fallback would spread out the raw JSON and display the tool name twice.
    // The MCP name and reason in the protocol are displayed separately here to prevent users from reading the debugging payload during approval.
    return "mcp";
  }

  // Guess kind/title/rawInput.skill separately before the permission pop-up window, and the chat area shunt rules will drift.
  // The fixed tool identity is reused here, so that Skill permission requests follow the same set of semantics before and after confirmation.
  if (identity.family === "skill") {
    return "skill";
  }

  if (identity.family === "workflow") {
    // The main body of the workflow confirmation window is a cause-and-effect diagram + folding script, which is the same tool identity as the chat area;
    // It must be determined earlier than search/execute, otherwise the command fragment in the script will misjudge it as a normal command confirmation.
    return "workflow";
  }

  if (identity.family === "search") {
    // WebFetch/WebSearch permission requests previously fell into fallback, and the entire toolCall JSON package would be typed out.
    // The same search renderer is used here as in the chat area, and only the URL/query summary that the user cares about is displayed.
    return "search";
  }

  if (preview.command) {
    return "execute";
  }

  return "fallback";
}

function getPermissionBlockInteraction(blockKind: PermissionBlockKind): PermissionBlockInteraction {
  switch (blockKind) {
    case "edit":
      return {
        canToggle: false,
        forceOpen: false,
      };
    case "mcp":
    case "skill":
    case "search":
    case "execute":
    case "workflow":
    case "saveWorkflow":
    case "fallback":
      // This is an intermediate display of the permission pop-up window, which does not provide collapse/expand interaction to prevent users from hiding key content.
      // workflow / saveWorkflow are listed here just for exhaustiveness: they are rendered directly by their respective dedicated blocks, without going through the common block,
      // Intra-block script folding is a deliberate exception to spec documentation (pictures, names, and drop points are still not foldable).
      return {
        canToggle: false,
        forceOpen: true,
      };
  }
}

function buildPermissionToolCall(
  request: ZCodePermissionRequest,
  preview: ReturnType<typeof getPermissionRequestPreview>,
): TaskChatToolCall {
  const rawInput = readRawToolCallInput(request.raw);

  return {
    toolId: `permission:${request.requestId}`,
    kind: request.kind,
    title: request.title ?? request.description ?? preview.title,
    input: rawInput ?? preview.command ?? request.raw,
    status: "completed",
    raw: request.raw,
  };
}

function buildPermissionBlockContext(
  toolCall: TaskChatToolCall,
  rawFileSummaries: ToolCallBlockRenderContext["rawFileSummaries"],
  workspacePath: string,
  blockKind: PermissionBlockKind,
  kindLabelOverride: ReactNode,
  theme: ToolCallBlockRenderContext["theme"],
  codePreviewSettings: ToolCallBlockRenderContext["codePreviewSettings"],
): ToolCallBlockRenderContext {
  const { canToggle, forceOpen } = getPermissionBlockInteraction(blockKind);

  return {
    toolCallNode: {
      toolCall,
      childToolCalls: [],
    } as ToolCallBlockRenderContext["toolCallNode"],
    workspacePath,
    // Store coupling stripping: the display component no longer takes its own store, and the theme/code preview settings are injected by the dialog host.
    theme,
    codePreviewSettings,
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries,
    // When the permission pop-up window is waiting for user confirmation, the tool has not been executed and the running state cannot be reused.
    // Previously, Bash permissions would display "Executing" with loading, obscuring the real reason for requesting.
    isRunning: false,
    statusLabel: "",
    childToolList: null,
    showIcon: true,
    kindLabelOverride,
    canToggle,
    forceOpen,
    onOpenCodeViewer: undefined,
    onOpenBrowserUrl: undefined,
  };
}

function McpPermissionBlock(context: ToolCallBlockRenderContext) {
  const { toolCall } = context.toolCallNode;
  const toolName = getMcpPermissionToolName(toolCall) ?? toolCall.title ?? toolCall.kind;
  const reason = getMcpPermissionReason(toolCall);
  const hasKindLabelOverride = context.kindLabelOverride != null;
  const primaryText = useMemo(
    () =>
      hasKindLabelOverride ? (
        <span className="min-w-0 truncate text-foreground-subtle">{toolName}</span>
      ) : reason ? (
        <span className="min-w-0 truncate text-foreground-subtle">{reason}</span>
      ) : null,
    [hasKindLabelOverride, reason, toolName],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={MCP_PERMISSION_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={false}
      kindLabel={context.kindLabelOverride ?? toolName}
      primaryText={primaryText}
      isRunning={context.isRunning}
      content={null}
    />
  );
}

export function PermissionDialog({
  request,
  onRespond,
  workspacePath,
  provider,
  responding = false,
  responseError,
}: {
  request: ZCodePermissionRequest;
  responding?: boolean;
  responseError?: string;
  onRespond: (requestId: string, option: ZCodePermissionOption, feedback?: string) => void;
  workspacePath: string;
  provider?: ZCodeProvider;
}) {
  const { intl } = useZCodeIntl();
  // Store coupling stripping: theme/code preview settings take the store at the host and go down to props/render context.
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // The Refine option of the workflow confirmation window is not included in the button list: it is the feedback line for this window (see feedbackOption).
  const refineOption = useMemo(
    () => request.options.find(isWorkflowRefineOption),
    [request.options],
  );
  const orderedOptions = useMemo(
    () =>
      sortPermissionOptions(request.options).filter((option) => !isWorkflowRefineOption(option)),
    [request.options],
  );
  const preview = useMemo(() => getPermissionRequestPreview(request), [request]);
  const toolCall = useMemo(() => buildPermissionToolCall(request, preview), [preview, request]);
  const rawFileSummaries = useMemo(
    () =>
      // Before the permission pop-up window only recognizes preview.fileChanges, if the Write request only contains file_path/content,
      // The file summary will be lost here; instead, the same set of edit parsing in the chat area is reused to avoid inconsistent display results between the two entrances.
      readRawToolCallFileSummaries(toolCall.raw, {
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [toolCall],
  );
  const blockKind = useMemo(
    () => resolvePermissionBlockKind(preview, toolCall, rawFileSummaries),
    [preview, rawFileSummaries, toolCall],
  );
  const blockContext = useMemo(
    () =>
      buildPermissionBlockContext(
        toolCall,
        rawFileSummaries,
        workspacePath,
        blockKind,
        intl.formatMessage({ id: "chat.permission.awaitingApproval" }),
        theme,
        codePreviewSettings,
      ),
    [blockKind, codePreviewSettings, intl, rawFileSummaries, theme, toolCall, workspacePath],
  );
  const displayReason = useMemo(() => getPermissionDisplayReason(request), [request]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const feedbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const feedbackCompositionActiveRef = useRef(false);
  const feedbackInputFocusedRef = useRef(false);
  const denyOption = useMemo(
    () =>
      orderedOptions.find((option) =>
        getPermissionOptionDisplayKind(option.kind).startsWith("reject"),
      ),
    [orderedOptions],
  );
  // The response target of the feedback line: the workflow confirmation window is Refine (reject + modify the opinion to upgrade to a real user message),
  // Other confirmation windows are Deny (Rejection + Feedback). The two confirmation windows share the same line of input, only the response target and copy text are changed.
  // No more drawing separate sets of input boxes - having two different feedback inputs in the same dock area is a design debt.
  // Reason: Reusing the Deny index will highlight the reject button and the input box at the same time; the input rows are navigated independently, and the target option is used for submission.
  const feedbackOption = refineOption ?? (request.freeText === true ? denyOption : undefined);
  const hasFeedbackInput = Boolean(feedbackOption);
  const feedbackIndex = orderedOptions.length;
  const selectableCount = orderedOptions.length + (hasFeedbackInput ? 1 : 0);
  const isFeedbackSelected = hasFeedbackInput && selectedIndex === feedbackIndex;

  useEffect(() => {
    setSelectedIndex(0);
    // The draft is reset to zero by requestId to prevent feedback (or workflow modification opinions) from one request from leaking into the next confirmation window.
    setFeedback("");
  }, [request.requestId]);

  useEffect(() => {
    if (orderedOptions.length === 0) {
      return;
    }
    if (feedbackInputFocusedRef.current) {
      return;
    }

    // After the feedback input box is added, the old RAF may call back after the user obtains the input focus and regain the option focus.
    // Confirm the focus state again when the callback is executed to avoid interrupting user input.
    const frameId = requestAnimationFrame(() => {
      if (!feedbackInputFocusedRef.current) {
        if (isFeedbackSelected) feedbackInputRef.current?.focus();
        else optionRefs.current[selectedIndex]?.focus();
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [isFeedbackSelected, orderedOptions.length, request.requestId, selectedIndex]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (selectableCount === 0) {
        return;
      }

      feedbackInputFocusedRef.current = false;
      setSelectedIndex(
        (currentIndex) => (currentIndex + direction + selectableCount) % selectableCount,
      );
    },
    [selectableCount],
  );

  const respondWithOption = useCallback(
    (option: ZCodePermissionOption) => {
      if (responding) return;
      const selectedKind = getPermissionOptionDisplayKind(option.kind);
      // Deny in the general confirmation window sends the draft of the feedback line as the reason for rejection; the draft in the workflow confirmation window belongs to Refine.
      // Clicking Deny means an ordinary rejection - otherwise a modification opinion will be issued as an ordinary rejection reason.
      // Model does not receive upgrade delivery for workflow_refine_feedback.
      const trimmedFeedback =
        !refineOption && selectedKind.startsWith("reject") ? feedback.trim() : "";
      onRespond(request.requestId, option, trimmedFeedback || undefined);
    },
    [feedback, onRespond, refineOption, request.requestId, responding],
  );

  const submitFeedback = useCallback(() => {
    // Trim before submission: CLI broker will deny the blank freeText and cannot treat pure blank as feedback.
    const trimmedFeedback = feedback.trim();
    if (responding || !feedbackOption || !trimmedFeedback) {
      return;
    }
    onRespond(request.requestId, feedbackOption, trimmedFeedback);
  }, [feedback, feedbackOption, onRespond, request.requestId, responding]);

  const confirmSelection = useCallback(() => {
    if (isFeedbackSelected) {
      submitFeedback();
      return;
    }
    const selectedOption = orderedOptions[selectedIndex];
    if (selectedOption) respondWithOption(selectedOption);
  }, [isFeedbackSelected, orderedOptions, respondWithOption, selectedIndex, submitFeedback]);

  const handleFeedbackKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (
        isImeComposingKeyEvent({
          compositionActive: feedbackCompositionActiveRef.current,
          nativeEvent: event.nativeEvent,
        })
      ) {
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Tab") {
        event.preventDefault();
        moveSelection(event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        submitFeedback();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        feedbackInputRef.current?.blur();
      }
    },
    [moveSelection, submitFeedback],
  );

  const handleOptionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (hasFeedbackInput && event.key === String(feedbackIndex + 1)) {
        event.preventDefault();
        setSelectedIndex(feedbackIndex);
        return;
      }
      if (event.key === "1" || event.key === "2" || event.key === "3") {
        const shortcutIndex = Number(event.key) - 1;
        const shortcutOption = orderedOptions[shortcutIndex];
        if (!shortcutOption) {
          return;
        }

        event.preventDefault();
        setSelectedIndex(shortcutIndex);
        respondWithOption(shortcutOption);
        return;
      }

      switch (event.key) {
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          moveSelection(1);
          return;
        case "Tab":
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          confirmSelection();
          return;
        default:
          return;
      }
    },
    [
      confirmSelection,
      feedbackIndex,
      hasFeedbackInput,
      moveSelection,
      orderedOptions,
      respondWithOption,
    ],
  );

  const PermissionBlock =
    blockKind === "edit"
      ? EditToolCallBlock
      : blockKind === "mcp"
        ? McpPermissionBlock
        : blockKind === "skill"
          ? SkillToolCallBlock
          : blockKind === "search"
            ? SearchToolCallBlock
            : blockKind === "execute"
              ? ExecuteToolCallBlock
              : FallbackToolCallBlock;
  // The current ZCode Agent's ExitPlanMode permission request no longer passes legacy switch_mode.
  // The tool identity is reused here to avoid the planning mode tool diversion of the approval pop-up window and chat area from drifting again.
  const shouldUseSwitchModePlaceholder = resolveToolCallIdentity(toolCall).family === "switch-mode";
  // The workflow confirmation window comes with a localized title ("Run this workflow?") and figure body, and is an independent block instead of a universal preview block.
  const shouldUseWorkflowBlock = blockKind === "workflow";
  // The save confirmation window is the same, but the question, content, and options are different: there is no picture, no Refine, and the main body is drop point + metadata + script.
  const shouldUseSaveWorkflowBlock = blockKind === "saveWorkflow";
  return (
    <div className="w-full shrink-0 relative z-1">
      <div className="w-full overflow-hidden rounded-2xl border border-border bg-popover shadow-xs">
        <div className="flex flex-col gap-3 p-3">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-ui-base font-medium leading-tight text-foreground-subtle">
                {intl.formatMessage({ id: "chat.permission.title" })}
              </p>
              <InteractionRequestOriginBadge origin={request.origin} />
            </div>
            {!shouldUseSwitchModePlaceholder &&
            !shouldUseWorkflowBlock &&
            !shouldUseSaveWorkflowBlock &&
            displayReason ? (
              <p className="text-ui-base leading-5 text-foreground">{displayReason}</p>
            ) : null}
            {shouldUseSwitchModePlaceholder ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground">
                <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
                <span className="animated-gradient-text font-medium">
                  {intl.formatMessage({
                    id: "chat.permission.switchMode.placeholder",
                  })}
                </span>
              </div>
            ) : shouldUseWorkflowBlock ? (
              // The reason on the CLI side is for protocol diagnosis ("createWorkflow.runConfirmation: ..."),
              // This is deliberately not rendered here: the localized title within the displayReason: block is the question for the user.
              <WorkflowPermissionBlock request={request} workspacePath={workspacePath} />
            ) : shouldUseSaveWorkflowBlock ? (
              // Same as above: The question to save the gate (save/overwrite two sentences) is given by the block itself, and the protocol reason is not reused.
              <SaveWorkflowPermissionBlock request={request} />
            ) : (
              <PermissionBlock {...blockContext} />
            )}
          </div>

          {/* The feedback rows were separated by an outer gap-3; visually grouped by the same 4px, preserving the listbox's permission option borders. */}
          <div className="space-y-1">
            <div
              role="listbox"
              aria-label={intl.formatMessage({ id: "chat.permission.title" })}
              className="space-y-1"
            >
              {orderedOptions.map((option, index) => {
                const isSelected = index === selectedIndex;
                const officialCuaProjectPermission = isOfficialCuaProjectPermission(option);
                const labelMessageId = officialCuaProjectPermission
                  ? "chat.permission.cua.allowForProject"
                  : option.name.trim().toLowerCase() === "always allow in this project" &&
                      preview.scope === "command"
                    ? "chat.permission.allowCommand"
                    : getOptionLabelMessageId(option.kind);
                const nameMessageIds = getProviderOptionNameMessageIds(provider, option.name);
                const descriptionMessageId = officialCuaProjectPermission
                  ? "chat.permission.cua.allowForProject.description"
                  : labelMessageId === "chat.permission.allowCommand"
                    ? "chat.permission.allowCommand.description"
                    : (nameMessageIds?.description ??
                      getOptionDescriptionMessageId(option.kind, preview.scope));
                const fallbackLabel = labelMessageId
                  ? intl.formatMessage({ id: labelMessageId })
                  : null;
                const knownNameLabel = nameMessageIds
                  ? intl.formatMessage({ id: nameMessageIds.label })
                  : null;
                // In the ZCode Agent protocol, option.name is the actual option text shown to the user, and kind only represents button semantics.
                // Previously, all localizations here were based on kind. Options like switch_mode with different semantics but the same allow_always,
                // will be mistakenly pressed into two identical "always allowed".
                const preferOptionName = shouldPreferPermissionOptionName(option);
                const label =
                  (labelMessageId === "chat.permission.allowCommand"
                    ? fallbackLabel
                    : knownNameLabel) ??
                  (preferOptionName ? option.name : (fallbackLabel ?? option.name));
                const description =
                  (preferOptionName && !knownNameLabel) || !descriptionMessageId
                    ? null
                    : intl.formatMessage({ id: descriptionMessageId });
                const ruleScopes =
                  getPermissionOptionDisplayKind(option.kind) === "allowAlways"
                    ? readPermissionRuleScopes(option)
                    : [];

                return (
                  <button
                    key={option.optionId}
                    // After the exact rule is not displayed according to product semantics, E2E can no longer guess the option based on the visible rule text;
                    // Expose standardized semantics for barrier-free automation and stable selection without leaking the original command content.
                    data-permission-option-kind={getPermissionOptionDisplayKind(option.kind)}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    type="button"
                    role="option"
                    aria-label={label}
                    aria-selected={isSelected}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => {
                      if (isSelected) {
                        respondWithOption(option);
                      } else {
                        setSelectedIndex(index);
                      }
                    }}
                    onFocus={() => setSelectedIndex(index)}
                    onKeyDown={handleOptionKeyDown}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-selected",
                      isSelected ? "bg-selected" : "hover:bg-hover",
                    )}
                  >
                    <span
                      className={cn(
                        "w-5 shrink-0 text-ui-base font-medium self-center",
                        isSelected ? "text-foreground" : "text-foreground-subtlest",
                      )}
                    >
                      {index + 1}.
                    </span>
                    <span className="min-w-0 flex flex-1 flex-col">
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-ui-base font-medium text-foreground">{label}</span>
                        {ruleScopes.length > 0 ? (
                          <InlinePermissionPrefixScopes scopes={ruleScopes} />
                        ) : description ? (
                          <span className="text-ui-base leading-4 text-foreground-subtle">
                            {description}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {feedbackOption ? (
              <div
                onClick={(event) => {
                  if (event.target !== feedbackInputRef.current) {
                    feedbackInputRef.current?.focus();
                  }
                }}
                className={cn(
                  "flex w-full cursor-text items-center gap-3 rounded-xl px-3 py-2 transition-colors",
                  isFeedbackSelected ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <span
                  className={cn(
                    // Match the first row height and 1px border of the textarea; the mobile phone input row height is different, but the serial number font size remains unchanged.
                    "mt-px w-5 shrink-0 self-start text-ui-base font-medium leading-5 md:leading-relaxed",
                    isFeedbackSelected ? "text-foreground" : "text-foreground-subtlest",
                  )}
                >
                  {feedbackIndex + 1}.
                </span>
                <Textarea
                  ref={feedbackInputRef}
                  rows={1}
                  wrap="soft"
                  value={feedback}
                  maxLength={MAX_PERMISSION_FEEDBACK_CHARS}
                  // The copywriting of the Refine line is localized according to the stable optionId: the name in the protocol is the English version of the server.
                  aria-label={intl.formatMessage({
                    id: refineOption
                      ? "chat.permission.workflow.refine"
                      : "chat.permission.feedback.ariaLabel",
                  })}
                  placeholder={intl.formatMessage({
                    id: refineOption
                      ? "chat.permission.workflow.refine.placeholder"
                      : "chat.permission.feedback.placeholder",
                  })}
                  data-permission-feedback-option={feedbackOption.optionId}
                  onFocus={() => {
                    feedbackInputFocusedRef.current = true;
                    setSelectedIndex(feedbackIndex);
                  }}
                  onBlur={() => {
                    feedbackInputFocusedRef.current = false;
                  }}
                  onChange={(event) => {
                    setFeedback(event.target.value);
                  }}
                  onCompositionStart={() => {
                    feedbackCompositionActiveRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    feedbackCompositionActiveRef.current = false;
                  }}
                  onKeyDown={handleFeedbackKeyDown}
                  className={cn(
                    // Reject feedback to wrap automatically, but limit it to 5 lines and scroll within the input box to avoid narrow screens blocking permission options and confirmation buttons.
                    "h-auto !min-h-5 max-h-[5lh] min-w-0 max-w-full overflow-y-auto rounded-none border-transparent bg-transparent !px-0 !py-0 font-medium text-ui-base leading-5 shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0",
                  )}
                />
              </div>
            ) : null}
          </div>

          {responseError ? (
            <p role="alert" className="text-ui-base text-destructive">
              {responseError}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="flex gap-2 text-ui-base items-center text-foreground-subtle">
              <Info className="text-foreground size-4 shrink-0" />
              {intl.formatMessage({ id: "chat.permission.keyboardHint" })}
            </p>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "common.confirm" })}
              size="lg"
              onClick={confirmSelection}
              disabled={
                responding ||
                (isFeedbackSelected
                  ? !feedback.trim()
                  : orderedOptions[selectedIndex] === undefined)
              }
              className="bg-brand text-foreground-inverse hover:bg-brand/80"
            >
              {intl.formatMessage({ id: "common.confirm" })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
