import { Library } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const LIST_SAVED_WORKFLOWS_TOOL_ICON = (
  <Library className="size-4 shrink-0 text-foreground-subtle" />
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface SavedWorkflowEntry {
  name: string;
  description: string | undefined;
  whenToUse: string | undefined;
  scope: string | undefined;
  path: string | undefined;
  argNames: string[];
}

interface InvalidSavedWorkflowEntry {
  path: string;
  reason: string | undefined;
}

interface ListSavedWorkflowsResult {
  workflows: SavedWorkflowEntry[];
  invalid: InvalidSavedWorkflowEntry[];
}

function parseJsonCandidate(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function readResultRecord(value: unknown): ListSavedWorkflowsResult | null {
  const normalized = parseJsonCandidate(value);
  if (!isPlainRecord(normalized) || !Array.isArray(normalized.workflows)) {
    return null;
  }

  const workflows: SavedWorkflowEntry[] = [];
  for (const entry of normalized.workflows) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const name = readTrimmedString(entry.name);
    if (name === undefined) {
      continue;
    }
    workflows.push({
      name,
      description: readTrimmedString(entry.description),
      whenToUse: readTrimmedString(entry.whenToUse),
      scope: readTrimmedString(entry.scope),
      path: readTrimmedString(entry.path),
      argNames: isPlainRecord(entry.args) ? Object.keys(entry.args) : [],
    });
  }

  const invalid: InvalidSavedWorkflowEntry[] = [];
  if (Array.isArray(normalized.invalid)) {
    for (const entry of normalized.invalid) {
      if (!isPlainRecord(entry)) {
        continue;
      }
      const path = readTrimmedString(entry.path);
      if (path === undefined) {
        continue;
      }
      invalid.push({ path, reason: readTrimmedString(entry.reason) });
    }
  }

  return { workflows, invalid };
}

/**
 * Result read order: **the display channel first** — on the v4 wire output.text is
 * formatModelContent's XML-style projection, so the JSON probes below never hit it (they fall
 * through to the raw fallback card); the legacy JSON probes are kept, to cover old sessions and
 * non-v4 hosts. If none of them can read anything, hand it back to fallback — an empty list and
 * "cannot read it" must stay distinguishable; a parse failure must not be drawn as "this project
 * has no workflows".
 */
function readListSavedWorkflowsResult(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ListSavedWorkflowsResult | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "saved_workflow_list") {
    return {
      workflows: display.workflows.map((entry) => ({
        name: entry.name,
        description: entry.description,
        whenToUse: entry.whenToUse,
        scope: entry.scope,
        path: entry.path,
        argNames: [...entry.argNames],
      })),
      invalid: (display.invalid ?? []).map((entry) => ({
        path: entry.path,
        reason: entry.reason,
      })),
    };
  }

  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  for (const candidate of [toolCall.output, raw?.rawOutput, raw?.output, raw?.result]) {
    const result = readResultRecord(candidate);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * The chat card for ListSavedWorkflows.
 *
 * Why it deserves a dedicated renderer: this tool name is not registered in shared's known-tools
 * table, so the generic path is `FallbackToolCallBlock`, whose default display model has no
 * inlinePreview and would therefore spread the whole `JSON.stringify(toolCall)` payload into the
 * chat area — the worst case for this particular tool, because that payload is the description /
 * whenToUse / args declaration of every single workflow.
 *
 * The card only answers "what is there and what it is for"; the scripts themselves are not in the
 * result to begin with (spec: one listing must not push 20 scripts into the context). Broken files
 * get their own row — they are **deliberately visible** and are never silently skipped.
 */
export function ListSavedWorkflowsToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const result = useMemo(() => readListSavedWorkflowsResult(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.list.listing"
      : "chat.toolCall.workflow.list.listed",
  });
  const scopeProjectLabel = intl.formatMessage({
    id: "chat.permission.workflow.saved.scope.project",
  });
  const scopeGlobalLabel = intl.formatMessage({ id: "chat.toolCall.workflow.scope.global" });
  const emptyLabel = intl.formatMessage({ id: "chat.toolCall.workflow.list.empty" });

  const workflowCount = result?.workflows.length ?? 0;
  const invalidCount = result?.invalid.length ?? 0;
  // Lightweight intl does not have ICU plural, and singular and plural numbers use separate message keys (same as the precedent of workflow.error/errors).
  const countLabel = intl.formatMessage(
    {
      id:
        workflowCount === 1
          ? "chat.toolCall.workflow.list.countOne"
          : "chat.toolCall.workflow.list.count",
    },
    { count: workflowCount },
  );
  const invalidLabel = intl.formatMessage(
    {
      id:
        invalidCount === 1
          ? "chat.toolCall.workflow.list.invalidOne"
          : "chat.toolCall.workflow.list.invalid",
    },
    { count: invalidCount },
  );

  // ToolLayout is a memo component: inline JSX props are new references every time they are rendered, which will invalidate memoization.
  const primaryText = useMemo(
    () => (
      <span className="truncate text-foreground-subtlest">
        {workflowCount === 0 ? emptyLabel : countLabel}
      </span>
    ),
    [countLabel, emptyLabel, workflowCount],
  );

  const renderContent = useCallback(() => {
    if (!result) {
      return null;
    }

    return (
      <div className="mb-2 space-y-2" data-saved-workflow-list="true">
        {result.workflows.map((workflow) => (
          <div key={workflow.path ?? workflow.name} className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className="min-w-0 truncate font-mono text-ui-base text-foreground-subtle"
                title={workflow.path ?? workflow.name}
              >
                {workflow.name}
              </span>
              {workflow.scope === "global" ? (
                <span
                  data-workflow-scope-tag="global"
                  className="shrink-0 rounded-xs border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest"
                >
                  {scopeGlobalLabel}
                </span>
              ) : (
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                  {workflow.scope === "project" ? scopeProjectLabel : workflow.scope}
                </span>
              )}
            </div>
            {workflow.description === undefined ? null : (
              <p className="min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtlest">
                {workflow.description}
              </p>
            )}
            {workflow.argNames.length === 0 ? null : (
              <div className="flex min-w-0 flex-wrap gap-1 pt-0.5">
                {workflow.argNames.map((argName) => (
                  <span
                    key={argName}
                    className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs leading-none text-foreground-subtlest"
                  >
                    {argName}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {result.workflows.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtlest">{emptyLabel}</p>
        ) : null}

        {result.invalid.length === 0 ? null : (
          <div className="space-y-0.5 rounded-lg border border-warning/40 px-2.5 py-2">
            <p className="text-ui-sm text-warning">{invalidLabel}</p>
            {result.invalid.map((entry) => (
              <p
                key={entry.path}
                className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
                title={entry.reason ?? entry.path}
              >
                {entry.path}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }, [emptyLabel, invalidLabel, result, scopeGlobalLabel, scopeProjectLabel]);

  // If you cannot read structured results (old sessions, failures, downgrade paths), return the generic card instead of drawing an empty list.
  if (!result) {
    return <FallbackToolCallBlock {...context} iconOverride={LIST_SAVED_WORKFLOWS_TOOL_ICON} />;
  }

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={LIST_SAVED_WORKFLOWS_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
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
