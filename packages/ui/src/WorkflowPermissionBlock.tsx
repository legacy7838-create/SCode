import { ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowPhasesDetail } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowCardHeader } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  formatWorkflowArgValue,
  isWorkflowAmendPredecessorLive,
  readWorkflowAmendPredecessor,
  readWorkflowAmendScriptInherited,
  readWorkflowAmendTarget,
  readWorkflowMaxConcurrency,
  readWorkflowName,
  readWorkflowSaved,
  readWorkflowScript,
  readWorkflowSubagentModel,
  type WorkflowSavedSource,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "@/components/workflow-timeline/subagent-model-label.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isAmendWorkflowToolCall } from "@/lib/workflowToolNames.js";

/**
 * saved source badge: the script for this run comes from a file in the project, not from a passage
 * the model just wrote.
 *
 * Deliberately only one line plus a table of actual arguments, and placed **above** the timeline:
 * the graph is still the subject of the decision, while the source and the arguments are the prior
 * fact of "which copy is running, with what parameters" — once that is read, only then does the
 * graph come. The badge expresses no trust at all — invariant 1: saving confers no trust.
 */
function WorkflowSavedSourceBadge({ saved }: { saved: WorkflowSavedSource }) {
  const { intl } = useZCodeIntl();

  const savedLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.badge" });
  const scopeLabel =
    saved.scope === "project"
      ? intl.formatMessage({ id: "chat.permission.workflow.saved.scope.project" })
      : saved.scope;
  const argsLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.args" });
  const argEntries = Object.entries(saved.args);

  return (
    <div
      className="space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2"
      data-workflow-saved-source="true"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 text-ui-sm font-medium text-foreground-subtle">
          {scopeLabel === undefined ? savedLabel : `${savedLabel} · ${scopeLabel}`}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtlest"
          data-workflow-saved-name="true"
          title={saved.path ?? saved.name}
        >
          {saved.name}
        </span>
      </div>

      {saved.path === undefined ? null : (
        <p
          className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
          data-workflow-saved-path="true"
          title={saved.path}
        >
          {saved.path}
        </p>
      )}

      {argEntries.length === 0 ? null : (
        <dl
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 pt-0.5"
          data-workflow-saved-args="true"
          aria-label={argsLabel}
        >
          {argEntries.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-mono text-ui-sm text-foreground-subtlest">{key}</dt>
              <dd className="min-w-0 break-words font-mono text-ui-sm text-foreground-subtle">
                {formatWorkflowArgValue(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Run confirmation block for CreateWorkflow / AmendWorkflow: header (question + name, with only `N
 * phases` on the right — no "compiled" lamp, and no more counting of subagents and steps) + lineage
 * (only for amendments) + concurrency cap (only when the user mentioned it) + saved badge +
 * **timeline** + collapsible script. Deny / Refine / Run are still supplied by PermissionDialog.
 *
 * The amendment confirmation window appears only when the predecessor is a run from **another
 * session** (or a run the user stopped by hand): the question becomes "Adjust this workflow?", and
 * the lineage line says which run is being changed and whether it is still running.
 *
 * Permission blocks are normally non-collapsible (see the comment on PermissionDialog
 * getPermissionBlockInteraction); the timeline and the name are decision-critical content and stay
 * non-collapsible, while the script is the audit-detail layer.
 */
export function WorkflowPermissionBlock({
  request,
  workspacePath,
}: {
  request: ZCodePermissionRequest;
  /**
   * Scope of the session model list (supplied by PermissionDialog): used only to turn a provider id
   * into a provider name.
   */
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();

  // The raw of v4 ask is the tool input parameter (detail: payload.input of product-projection).
  // Share the read rules of create-workflow.tsx with the chat card to prevent the two places from parsing the same input parameters separately.
  const scriptText = readWorkflowScript(request.raw);
  const workflowName = readWorkflowName(request.raw);
  const saved = readWorkflowSaved(request.raw);
  // Revisions are judged by tool name (kind/title is the tool name attached to v4 ask); lineage is only true for revisions.
  const amend = isAmendWorkflowToolCall(request);
  const amendTarget = amend ? readWorkflowAmendTarget(request.raw) : undefined;
  const predecessor = amend ? readWorkflowAmendPredecessor(request.raw) : undefined;
  // This revision follows the predecessor’s script:
  // The script entered in the parameter is the one backfilled by the CLI - the graph and folding draw the script to be run as usual, and the lineage line says "the script remains unchanged".
  const scriptInherited = amend && readWorkflowAmendScriptInherited(request.raw);
  // Concurrency upper limit: Create and Amend are the same
  // Enter the parameter field, so it is not forked by the tool name - what is approved is "run with this upper limit", and it must be stated in both windows. Enter here
  // The clamp of resolveInput has been passed, so the number on the window is the boundary that will take effect.
  const maxConcurrency = readWorkflowMaxConcurrency(request.raw);
  // Sub-agent model: a "condition proposed by the user" in the same family as the concurrency upper limit,
  // And it should be said more clearly than it should be - the approval is "let these subagents run on another model". The input parameters here have been resolvedInput
  // It is parsed into a canonical string, so the id on the window is the one that will actually be used. The main agent is not affected, so the copywriting only talks about the sub-agents.
  const subagentModel = readWorkflowSubagentModel(request.raw);
  // The specification string is only entered into the tooltip: the model name is stated on the screen (add thinking intensity if necessary), and the naming rules are the same as those in the model menu.
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(workspacePath);
  const describedSubagentModel = useMemo(
    () =>
      subagentModel === undefined
        ? undefined
        : describeWorkflowSubagentModel(subagentModel, {
            formatMessage: intl.formatMessage.bind(intl),
            ...(subagentModelProviderName === undefined
              ? {}
              : { providerName: subagentModelProviderName }),
          }),
    [intl, subagentModel, subagentModelProviderName],
  );

  // Empty images (not even a single ask / files.* call in the script) are not worth an empty track; the same rule as chat cards.
  const display = request.display?.kind === "create_workflow" ? request.display : null;
  const causalityGraph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const hasGraph = causalityGraph !== undefined;
  const model = useMemo(
    () =>
      causalityGraph === undefined ? undefined : buildWorkflowTimeline(causalityGraph, undefined),
    [causalityGraph],
  );

  // The script is collapsed by default when there is a picture; there is no picture to see in the zero-step script, and the code is the only content, which is expanded by default.
  const [scriptOpen, setScriptOpen] = useState(!hasGraph);

  // PermissionDialog will reuse the same component instance across requests (resetting internal state only by requestId),
  // After changing the request, you must return to the default collapsed state, otherwise the last expansion will leak to the next workflow.
  useEffect(() => {
    setScriptOpen(!hasGraph);
  }, [hasGraph, request.requestId]);

  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const title = intl.formatMessage({
    id: amend ? "chat.permission.workflow.amend.title" : "chat.permission.workflow.title",
  });
  const amendsLabel = intl.formatMessage({ id: "chat.permission.workflow.amends" });
  const stillRunningLabel = intl.formatMessage({ id: "chat.permission.workflow.amends.running" });
  const scriptUnchangedLabel = intl.formatMessage({
    id: "chat.permission.workflow.amends.scriptUnchanged",
  });
  const scriptToggleLabel = intl.formatMessage({
    id: scriptOpen ? "chat.permission.workflow.hideScript" : "chat.permission.workflow.showScript",
  });
  const detail =
    model === undefined
      ? undefined
      : workflowPhasesDetail(intl.formatMessage.bind(intl), model, causalityGraph);

  return (
    <div className="space-y-3" data-workflow-permission-block="true">
      {/* The question goes on top: the dialog's generic title "Permission required" sits right
          above it, and reading the two together forms the complete decision question; the name
          follows, serving as the title of the timeline below it.
          */}
      <WorkflowCardHeader
        detail={detail}
        expanded
        kind={title}
        name={workflowName ?? fallbackName}
      />

      {/* The lineage line (amendments only): sits right against the name line and, together with it,
          forms the heading for "what is being changed this time"; when the predecessor is still
          running it adds "will be stopped" — what the user approves is not just a new script but
          also stopping a run that is in flight.
          */}
      {amendTarget === undefined ? null : (
        <div
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
          data-workflow-amends="true"
          {...(isWorkflowAmendPredecessorLive(predecessor)
            ? { "data-workflow-amends-live": "true" }
            : {})}
          {...(scriptInherited ? { "data-workflow-amends-script-inherited": "true" } : {})}
        >
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">{amendsLabel}</span>
          <span
            className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
            title={amendTarget}
          >
            {amendTarget}
          </span>
          {scriptInherited ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
              · {scriptUnchangedLabel}
            </span>
          ) : null}
          {isWorkflowAmendPredecessorLive(predecessor) ? (
            <span className="shrink-0 text-ui-xs text-warning">· {stillRunningLabel}</span>
          ) : null}
        </div>
      )}

      {/* Concurrency cap: the model only writes this field when the user explicitly asks for it, so its
          presence is itself **a condition the user stated themselves** — a secondary fact of the
          same family as the lineage line, following right after it and placed before the source
          badge. When absent, no space is left for it.
          */}
      {maxConcurrency === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-max-concurrency"
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.maxConcurrency" },
            { count: String(maxConcurrency) },
          )}
        </p>
      )}

      {/* Subagent model: same family as the concurrency cap, right behind it — both lines are
          "conditions the user set for this run", and this one deserves to be said out loud: what is
          being approved is letting those subagents run on another model. The main agent is
          unaffected.
          */}
      {describedSubagentModel === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-subagent-model"
          title={workflowSubagentModelTooltip(
            intl.formatMessage.bind(intl),
            describedSubagentModel,
          )}
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.subagentModel" },
            {
              model: workflowSubagentModelText(
                intl.formatMessage.bind(intl),
                describedSubagentModel,
              ),
            },
          )}
        </p>
      )}

      {saved ? <WorkflowSavedSourceBadge saved={saved} /> : null}

      {model === undefined ? null : <WorkflowTimeline className="py-1" model={model} />}

      {scriptText ? (
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 transition-transform", scriptOpen && "rotate-90")}
            />
            <span className="min-w-0 truncate">{scriptToggleLabel}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            {/* Height-capped and scrollable: a long script no longer stretches the confirmation window taller. */}
            <div className="max-h-72 overflow-auto" data-testid="workflow-script-scroll">
              <CodeBlock
                code={scriptText}
                language="typescript"
                renderMermaid={false}
                showLineNumbers
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
