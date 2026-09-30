import { FlaskConical } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ToolCallEvalWorkflowSnippetDisplay } from "@zcode/shared/zcode-protocol-v4";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { WorkflowDiagnosticsSection } from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";
import {
  snippetResponse,
  snippetValue,
} from "@/ToolCallBlocks/renderers/workflow-snippet-presentation.js";

const ICON = <FlaskConical className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * The three-state summary carries no result preview; the expanded content is sorted by execution
 * status.
 */
export function EvalWorkflowSnippetToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const snippet = display?.kind === "eval_workflow_snippet" ? display : undefined;
  const running = context.isRunning;
  const failed = !running && (toolCall.status === "failed" || snippet?.ok === false);
  const startedAt = toolCall.startedAt;
  // During the process, it moves in whole seconds, one frame per second (the same granularity as other timings in the panel); the final state is fixed at the precise millisecond of the tool result.
  // Milliseconds cannot be displayed every 100ms - the mantissa cannot be read with the naked eye, but it is the most frequent pending update in the chat area
  // (React nested update count is seeded when projected frames are backlogged).
  const now = useNowTicker(running && typeof startedAt === "number");
  const durationText = running
    ? typeof startedAt === "number"
      ? `${Math.max(0, Math.floor((now - startedAt) / 1000))}s`
      : undefined
    : snippet?.durationMs === undefined
      ? undefined
      : `${snippet.durationMs}ms`;
  const durationNode = useMemo(
    () =>
      !failed && durationText !== undefined ? (
        <span className="font-mono tabular-nums">{durationText}</span>
      ) : undefined,
    [durationText, failed],
  );
  const input = toolCall.input as { code?: unknown } | undefined;
  const code = typeof input?.code === "string" && input.code.trim() ? input.code : undefined;
  const response = useMemo(
    () =>
      snippet
        ? snippetResponse(snippet)
        : typeof toolCall.output === "string" && toolCall.output.trim()
          ? toolCall.output
          : undefined,
    [snippet, toolCall.output],
  );
  const error =
    context.errorText ||
    (failed ? response || snippet?.diagnostics.map((d) => d.message).join("\n") : undefined);
  // The expanded entrance is consistent with the currently displayed content, and no empty panels can be left due to hidden code/logs.
  const hasDetails = running
    ? code !== undefined
    : failed
      ? code !== undefined ||
        !!snippet?.logs.length ||
        !!snippet?.diagnostics.length ||
        !!(response || error)
      : response !== undefined;
  const renderContent = useCallback(
    () => (
      <SnippetBody
        key={running ? "running" : "terminal"}
        code={code}
        display={snippet}
        running={running}
        failed={failed}
        response={
          failed ? response || (!snippet?.diagnostics.length ? error : undefined) : response
        }
        theme={context.theme}
      />
    ),
    [code, snippet, running, failed, response, error, context.theme],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: running
              ? "chat.toolCall.workflow.snippet.validating"
              : "chat.toolCall.workflow.snippet.ran",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={durationNode}
        summaryContentSeparator="·"
        statusLabel={failed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined}
        statusTooltip={failed ? error : undefined}
        showFailureStatus={failed}
        isRunning={running}
        renderContent={hasDetails ? renderContent : undefined}
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

function SnippetBody({
  code,
  display,
  running,
  failed,
  response,
  theme,
}: {
  code?: string;
  display?: ToolCallEvalWorkflowSnippetDisplay;
  running: boolean;
  failed: boolean;
  response?: string;
  theme: ToolCallBlockRenderContext["theme"];
}) {
  const { intl } = useZCodeIntl();
  if (!failed) {
    const content = running
      ? code === undefined
        ? undefined
        : { code, language: "typescript" }
      : response === undefined
        ? undefined
        : snippetValue(response);
    if (!content) return null;
    return (
      <SnippetTextPanel
        key={content.code}
        text={content.code}
        language={content.language}
        running={running}
        truncated={!running && display?.truncated === true}
      />
    );
  }

  const codeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.snippet.section.code" });
  const codeBlock =
    code === undefined ? null : (
      <CodeBlock
        code={code}
        language="typescript"
        appTheme={theme}
        showLineNumbers
        renderMermaid={false}
      />
    );
  const value = response === undefined ? undefined : snippetValue(response);
  return (
    <div className="mb-2 space-y-3" data-testid="workflow-snippet-body">
      {display?.diagnostics.length ? (
        <WorkflowDiagnosticsSection diagnostics={display.diagnostics} />
      ) : null}
      {value ? (
        <section className="space-y-1.5" data-testid="snippet-result">
          <div className="max-h-72 overflow-auto">
            <CodeBlock
              code={value.code}
              language={value.language}
              appTheme={theme}
              renderMermaid={false}
            >
              <CodeBlockHeader>
                <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                  {intl.formatMessage({
                    id: failed
                      ? "chat.toolCall.status.failed"
                      : "chat.toolCall.workflow.snippet.section.response",
                  })}
                </h4>
                <CodeBlockCopyButton />
              </CodeBlockHeader>
            </CodeBlock>
          </div>
        </section>
      ) : null}
      {display?.logs.some((line) => line.trim()) ? (
        <section className="space-y-1.5" data-testid="snippet-logs">
          <h4 className="text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.toolCall.workflow.snippet.section.logs" })}
          </h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
            {display.logs.join("\n")}
          </pre>
        </section>
      ) : null}
      {codeBlock ? (
        <details className="space-y-2" data-testid="snippet-code">
          <summary className="cursor-pointer text-ui-sm text-foreground-subtlest">
            {codeLabel}
          </summary>
          <div className="max-h-64 overflow-auto">{codeBlock}</div>
        </details>
      ) : null}
      {display?.truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A shared Markdown toolbar, with the body scrolling on its own so the copy button does not scroll
 * away with long content.
 */
function SnippetTextPanel({
  text,
  language,
  running,
  truncated,
}: {
  text: string;
  language: string;
  running: boolean;
  truncated: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="mb-2 min-w-0" data-testid="workflow-snippet-body">
      <div data-testid={running ? "snippet-running-code" : "snippet-result"}>
        <CodeBlock
          code={text}
          language={language}
          className="border border-border bg-card"
          contentClassName="max-h-80 overflow-auto"
          wrapLongLines
          renderMermaid={false}
        >
          <CodeBlockHeader className="pl-3 pr-2 pt-2" language={language} />
        </CodeBlock>
      </div>
      {truncated ? (
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
