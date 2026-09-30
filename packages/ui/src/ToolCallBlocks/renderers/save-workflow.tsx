import { Save } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const SAVE_WORKFLOW_TOOL_ICON = <Save className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * Styling for the overwrite badge: same family as the compiled chip on the CreateWorkflow result
 * card (an engraved chip — `rounded-xs` + an uppercase monospace micro-label), with only the
 * semantic color swapped to warning. Using warning instead of destructive is deliberate: the file
 * is being **replaced**, not deleted, so destructive would overstate it; and overwriting is a real
 * semantic state, not the “borrow a semantic color to make the block louder” move that DESIGN.md
 * forbids.
 */
const OVERWRITE_BADGE_CLASSNAME =
  "shrink-0 rounded-xs border border-warning/40 px-1.5 py-0.5 font-mono text-ui-xs uppercase tracking-wf-label leading-none text-warning";

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

/** One args declaration in SaveWorkflow's normalized input. */
export interface WorkflowArgDeclaration {
  name: string;
  type: string | undefined;
  description: string | undefined;
  required: boolean;
  /** Whether `default` is present — `default: false` and “no default” must be distinguishable. */
  hasDefault: boolean;
  defaultValue: unknown;
}

/**
 * SaveWorkflow's normalized input (the reusable-workflow spec's “SaveWorkflow normalized shape”):
 * `{name, description, whenToUse?, args?, script, path, overwrite, scope}`.
 *
 * `path` / `overwrite` / `scope` are facts computed in the resolve phase, not something the model
 * said — the confirmation window shows “what is about to happen”. This gate has no display payload,
 * so the input is the entire content.
 */
interface SaveWorkflowInput {
  name: string | undefined;
  description: string | undefined;
  whenToUse: string | undefined;
  path: string | undefined;
  scope: string | undefined;
  /**
   * The shadowing fact when another tier already uses the same name (computed in the resolve phase,
   * carried through the input channel for the same reason as path / overwrite).
   */
  shadowing: "hides_global" | "hidden_by_project" | undefined;
  overwrite: boolean;
  script: string | undefined;
  args: WorkflowArgDeclaration[];
}

function readArgDeclarations(value: unknown): WorkflowArgDeclaration[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const declarations: WorkflowArgDeclaration[] = [];
  for (const [name, declaration] of Object.entries(value)) {
    if (!isPlainRecord(declaration)) {
      continue;
    }
    declarations.push({
      name,
      type: readTrimmedString(declaration.type),
      description: readTrimmedString(declaration.description),
      required: declaration.required === true,
      hasDefault: "default" in declaration,
      defaultValue: declaration.default,
    });
  }
  return declarations;
}

export function readSaveWorkflowInput(input: unknown): SaveWorkflowInput {
  const record = isPlainRecord(input) ? input : {};

  return {
    name: readTrimmedString(record.name),
    description: readTrimmedString(record.description),
    whenToUse: readTrimmedString(record.whenToUse),
    path: readTrimmedString(record.path),
    scope: readTrimmedString(record.scope),
    shadowing:
      record.shadowing === "hides_global" || record.shadowing === "hidden_by_project"
        ? record.shadowing
        : undefined,
    // Only explicit true is an override: there is no way to say "there is already a file there" when the field is absent,
    // You can't let the confirmation window assert this for the user.
    overwrite: record.overwrite === true,
    script:
      typeof record.script === "string" && record.script.length > 0 ? record.script : undefined,
    args: readArgDeclarations(record.args),
  };
}

export function SaveWorkflowOverwriteBadge({ label }: { label: string }) {
  return (
    <span className={OVERWRITE_BADGE_CLASSNAME} data-workflow-overwrite-badge="true">
      {label}
    </span>
  );
}

/**
 * The micro-label on the collapsed global-scope row: same family as the overwrite badge (an
 * engraved chip), with the semantic color changed to foreground-subtle — it is only a scope note,
 * not an alerting state, so it does not borrow warning / destructive.
 */
const SCOPE_BADGE_CLASSNAME =
  "shrink-0 rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs uppercase tracking-wf-label leading-none text-foreground-subtle";

function SaveWorkflowScopeBadge({ label }: { label: string }) {
  return (
    <span className={SCOPE_BADGE_CLASSNAME} data-workflow-scope-badge="global">
      {label}
    </span>
  );
}

/**
 * SaveWorkflow's chat card: deliberately compact — name, overwrite marker, description.
 *
 * The full content (target location, args declaration table, script) belongs to the confirmation
 * window: that is where the user makes the decision, whereas this card is the one-line record left
 * after the decision.
 */
export function SaveWorkflowToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const saved = useMemo(() => readSaveWorkflowInput(toolCall.input), [toolCall.input]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.save.saving"
      : "chat.toolCall.workflow.save.saved",
  });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const overwriteLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.overwrite" });
  const pathLabel = intl.formatMessage({ id: "chat.permission.workflow.save.path" });
  const whenToUseLabel = intl.formatMessage({ id: "chat.permission.workflow.save.whenToUse" });
  const isGlobalScope = saved.scope === "global";
  const isProjectScope = saved.scope === "project";
  const scopeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.label" });
  const globalBadgeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.scope.global" });
  const scopeValue = isGlobalScope
    ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.global" })
    : isProjectScope
      ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.project" })
      : null;
  const shadowingLabel =
    saved.shadowing === "hides_global"
      ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.hidesGlobal" })
      : saved.shadowing === "hidden_by_project"
        ? intl.formatMessage({ id: "chat.toolCall.workflow.save.scope.hiddenByProject" })
        : null;

  const primaryText = useMemo(
    () => (
      <span className="truncate font-mono text-foreground-subtlest">
        {saved.name ?? fallbackName}
      </span>
    ),
    [fallbackName, saved.name],
  );

  const kindDetail = useMemo(
    () =>
      // Folding row: Add a "global" submark to the global file, in the same row as the overwrite logo (unknown/project files do not add it).
      saved.overwrite || isGlobalScope ? (
        <span className="flex items-center gap-1">
          {saved.overwrite ? <SaveWorkflowOverwriteBadge label={overwriteLabel} /> : null}
          {isGlobalScope ? <SaveWorkflowScopeBadge label={globalBadgeLabel} /> : null}
        </span>
      ) : null,
    [globalBadgeLabel, isGlobalScope, overwriteLabel, saved.overwrite],
  );

  const renderContent = useMemo(
    () => () => (
      <div className="mb-2 space-y-1.5">
        {saved.description === undefined ? null : (
          // Collapse row leaving only name + overwrite logo.
          <p className="min-w-0 whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground-subtle">
            {saved.description}
          </p>
        )}
        {scopeValue === null ? null : (
          // The scope line is above the drop point.
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{scopeLabel}</span>
            <span className="min-w-0 text-foreground-subtle">{scopeValue}</span>
          </p>
        )}
        {shadowingLabel === null ? null : (
          <p className="min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">
            {shadowingLabel}
          </p>
        )}
        {saved.path === undefined ? null : (
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{pathLabel}</span>
            <span className="min-w-0 truncate font-mono text-foreground-subtle" title={saved.path}>
              {saved.path}
            </span>
          </p>
        )}
        {saved.whenToUse === undefined ? null : (
          <p className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span className="shrink-0 text-foreground-subtlest">{whenToUseLabel}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words text-foreground-subtle">
              {saved.whenToUse}
            </span>
          </p>
        )}
      </div>
    ),
    [
      pathLabel,
      saved.description,
      saved.path,
      saved.whenToUse,
      scopeLabel,
      scopeValue,
      shadowingLabel,
      whenToUseLabel,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SAVE_WORKFLOW_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        kindDetail={kindDetail}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        // Deliberately do not pass secondaryText: the folded line only has the name (+ overwrite logo), description/drop point/whenToUse
        // Move everything into the expanded card body - the shorter the "line of record after the decision" is, the easier it is to read.
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={saved.description ?? toolCall.title}
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
