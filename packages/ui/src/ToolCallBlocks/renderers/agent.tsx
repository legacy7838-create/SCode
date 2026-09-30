import { BotIcon } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";
import type { AgentColor } from "@zcode/shared";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSubagentColorFromName, SUBAGENT_TEXT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { getLatestExploreChildSummaryFromChildren } from "./explore.js";
import { AgentPromptSection } from "./agentPromptSection.js";
import {
  formatAgentMessage,
  getAgentColor,
  getAgentKindLabel,
  getAgentActivityContent,
  getAgentPrimaryText,
  getAgentPrompt,
  readBackgroundAgentInfo,
} from "./agentHelpers.js";

const AGENT_TOOL_ICON = <BotIcon className="size-4 shrink-0 text-foreground-subtle" />;

function AgentChildToolList({
  childToolCalls,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onLoadFullToolCallFields,
}: {
  childToolCalls: ToolCallBlockRenderContext["toolCallNode"]["childToolCalls"];
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
  onOpenAutomationsMain?: ToolCallBlockRenderContext["onOpenAutomationsMain"];
  onLoadFullToolCallFields?: ToolCallBlockRenderContext["onLoadFullToolCallFields"];
}) {
  if (childToolCalls.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {childToolCalls.map((childToolCallNode) => (
        <ToolCallBlock
          key={childToolCallNode.toolCall.toolId}
          toolCallNode={childToolCallNode}
          depth={1}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          showIcon={false}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenAutomationsMain={onOpenAutomationsMain}
          onLoadFullToolCallFields={onLoadFullToolCallFields}
          suppressSourceLabel
        />
      ))}
    </div>
  );
}

function AgentActivitySection({
  label,
  content,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  label: string;
  content: string;
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
}) {
  return (
    <section className="space-y-2">
      <div className="rounded-lg border border-border bg-background-alt/40 flex flex-col">
        <h4 className="p-3 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
          {label}
        </h4>
        <div className="overflow-auto max-h-64" data-markdown-table-sticky-scrollbar="disabled">
          {/* Agent activity content may also contain long code/paths, allowing horizontal scrolling to avoid truncation on narrow screens.*/}
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={workspacePath}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenExternalUrl={onOpenBrowserUrl}
          >
            {content}
          </MessageResponse>
        </div>
      </div>
    </section>
  );
}

function BackgroundAgentProcessRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2">
      <div className="text-foreground-subtlest">{label}</div>
      <div className="min-w-0 text-foreground-subtle">{children}</div>
    </div>
  );
}

function AgentNameText({ color, name }: { color: AgentColor; name: string }) {
  return (
    <span
      className={cn(
        // Subagent names cannot rely on font baseline alignment within tool summary lines.
        // inline-flex is responsible for vertical centering, and the 1.5x line height maintains a consistent reading rhythm with the surrounding summary text.
        "inline-flex max-w-36 items-center truncate font-mono text-ui-base font-medium leading-[1.5]",
        SUBAGENT_TEXT_COLOR_CLASS[color],
      )}
      title={name}
    >
      {name}
    </span>
  );
}

function normalizeAgentLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

function BackgroundAgentProcessSection({
  outputFile,
  hasActivity,
  isRunning,
  status,
}: {
  outputFile?: string;
  hasActivity: boolean;
  isRunning: boolean;
  status: string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, fallback: string) => formatAgentMessage(intl, id, fallback);
  const launchStatus =
    status === "failed"
      ? msg("chat.toolCall.agent.backgroundLaunchFailed", "Launch failed")
      : status === "pending"
        ? msg("chat.toolCall.agent.backgroundLaunching", "Launching")
        : msg("chat.toolCall.agent.backgroundLaunched", "Launched");
  const launchStatusKind =
    status === "failed" ? "failed" : status === "pending" ? "pending" : "launched";
  const activityStatus = isRunning
    ? hasActivity
      ? msg(
          "chat.toolCall.agent.backgroundActivityStreaming",
          "Running in background, syncing output",
        )
      : msg(
          "chat.toolCall.agent.backgroundActivityRunningWaiting",
          "Running in background, waiting for output",
        )
    : hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityReceived", "SubAgent output received")
      : msg("chat.toolCall.agent.backgroundActivityWaiting", "Waiting for SubAgent output");
  const activityStatusKind = isRunning
    ? hasActivity
      ? "streaming"
      : "running_waiting"
    : hasActivity
      ? "received"
      : "waiting";

  return (
    <section
      data-background-agent-activity-status={activityStatusKind}
      data-background-agent-launch-status={launchStatusKind}
      className="rounded-lg border border-border bg-background-alt/40 p-3 text-ui-base"
    >
      <div className="font-medium text-foreground-subtle">
        {msg("chat.toolCall.agent.backgroundProcess", "Background Agent process")}
      </div>
      <div className="mt-2 space-y-2">
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundLaunch", "Launch")}>
          {launchStatus}
        </BackgroundAgentProcessRow>
        <BackgroundAgentProcessRow
          label={msg("chat.toolCall.agent.backgroundActivity", "Activity")}
        >
          {activityStatus}
        </BackgroundAgentProcessRow>
        {outputFile ? (
          <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.outputFile", "Output file")}>
            <span className="block break-all rounded-md bg-background px-2 py-1 font-mono text-foreground-subtle">
              {outputFile}
            </span>
          </BackgroundAgentProcessRow>
        ) : null}
      </div>
    </section>
  );
}

export function AgentToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const prompt = getAgentPrompt(toolCall);
  const fallbackLabel = formatAgentMessage(intl, "chat.toolCall.agent.fallback", "SubAgent");
  const primaryText = getAgentPrimaryText(toolCall, fallbackLabel);
  const agentName = getAgentKindLabel(toolCall, "", context.authoritativeAgentType);
  const configuredAgentsFromContext = useSubagentsContextStore((state) => {
    const candidates = Object.values(state.contexts).filter(
      (candidate) => candidate.workspacePath === context.workspacePath && candidate.loaded,
    );
    // The same remote path may correspond to multiple workspaceIdentities; when identity is missing, it is better to fall back to the default color.
    // Nor can you guess a bucket and string in the Agent configuration of another remote workspace.
    return candidates.length === 1 ? candidates[0]?.agents : undefined;
  });
  const configuredAgentsFromHook = useSubagentsStore((state) => state.agents);
  const configuredAgents =
    configuredAgentsFromContext && configuredAgentsFromContext.length > 0
      ? configuredAgentsFromContext
      : configuredAgentsFromHook.length > 0
        ? configuredAgentsFromHook
        : useSubagentsStore.getState().agents;
  const configuredAgentColor = useMemo(() => {
    const lookupName = normalizeAgentLookupValue(agentName);
    if (!lookupName) {
      return undefined;
    }
    return configuredAgents.find((agent) => {
      const name = normalizeAgentLookupValue(agent.name);
      const id = normalizeAgentLookupValue(agent.id);
      return name === lookupName || id === lookupName;
    })?.color;
  }, [agentName, configuredAgents]);
  const agentColor = agentName
    ? (configuredAgentColor ?? getAgentColor(toolCall) ?? resolveSubagentColorFromName(agentName))
    : null;
  const agentNameDetail =
    agentName && agentColor ? <AgentNameText color={agentColor} name={agentName} /> : null;
  // The done/in-progress boundary of an Agent parent block is determined solely by the parent Agent tool.
  // The child tool is an expanded area detail and cannot be continued in the running state of the parent block, otherwise after the parent Agent completed
  // Gradient and child tool summaries are still displayed, which is inconsistent with the parent tool life cycle in the protocol.
  const isAgentVisuallyRunning = context.isRunning;
  const collapsedChildSummary = isAgentVisuallyRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  const backgroundAgentInfo = readBackgroundAgentInfo(toolCall);
  const activityContent = getAgentActivityContent(toolCall);
  const activityThought = toolCall.thought?.trim();
  // The Agent block and the sub-tools within it have expressed sources through hierarchies,
  // Continuing to display the subagent source badge creates repetitive noise.
  const sourceLabel = undefined;
  const collapsedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const expandedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const summaryAction = useMemo(
    () =>
      context.agentSummaryAction
        ? {
            ...context.agentSummaryAction,
            ariaLabel: formatAgentMessage(
              intl,
              "chat.toolCall.agent.openInSidePane",
              "Open on the right",
            ),
          }
        : undefined,
    [context.agentSummaryAction, intl],
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-3 border-border border-l pl-3.5">
        {backgroundAgentInfo ? (
          <BackgroundAgentProcessSection
            outputFile={backgroundAgentInfo.outputFile}
            hasActivity={Boolean(activityContent || activityThought)}
            isRunning={isAgentVisuallyRunning}
            status={toolCall.status}
          />
        ) : null}
        {prompt ? (
          <AgentPromptSection
            prompt={prompt}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityThought ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.thought", "Agent thought")}
            content={activityThought}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityContent ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.output", "Agent output")}
            content={activityContent}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        <AgentChildToolList
          childToolCalls={childToolCalls}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onLoadFullToolCallFields={context.onLoadFullToolCallFields}
        />
      </div>
    ),
    [
      activityContent,
      activityThought,
      backgroundAgentInfo,
      childToolCalls,
      context.codePreviewSettings,
      context.onLoadFullToolCallFields,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      intl,
      isAgentVisuallyRunning,
      prompt,
      toolCall.status,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={AGENT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        forceOpen={false}
        summaryAction={summaryAction}
        // Product boundaries: Agent/Task only retains a single-line summary in the parent conversation; the complete child timeline is unified from
        // The right tab / mobile phone drawer is viewed, so there is neither automatic expansion nor manual expansion entry.
        kindLabel={fallbackLabel}
        expandedKindLabel={fallbackLabel}
        kindDetail={agentNameDetail}
        expandedKindDetail={agentNameDetail}
        sourceLabel={sourceLabel}
        autoCollapseOnComplete
        primaryText={
          collapsedChildSummary ? collapsedChildSummary.primaryText : collapsedPrimaryText
        }
        expandedPrimaryText={expandedPrimaryText}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        summaryContentSeparator="·"
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ?? `agent:${toolCall.toolId}:${primaryText}`
        }
        statusLabel={context.statusLabel}
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isAgentVisuallyRunning}
        title={collapsedChildSummary?.title ?? primaryText}
        expandedTitle={primaryText}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
