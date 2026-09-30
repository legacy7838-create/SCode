import { ChevronRightIcon, Save } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { formatWorkflowArgValue } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  readSaveWorkflowInput,
  SaveWorkflowOverwriteBadge,
  type WorkflowArgDeclaration,
} from "@/ToolCallBlocks/renderers/save-workflow.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const NO_VALUE_PLACEHOLDER = "—";

function MetadataRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <span className="shrink-0 text-ui-sm text-foreground-subtlest">{label}</span>
      <span
        className={cn(
          "min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle",
          mono === true && "font-mono",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * args declaration table. Columns are Name / Type / Required / Default, with the description on its
 * own line spanning the columns — five columns at the permission dialog's width would squeeze the
 * description into a column of broken-up words, and DESIGN.md explicitly forbids layouts that "only
 * survive by way of tight truncation" and also requires the layout to hold up under i18n expansion.
 * Required is spelled out in text rather than a checkmark: the meaning is not carried by the icon
 * alone.
 */
function WorkflowArgsTable({ args }: { args: readonly WorkflowArgDeclaration[] }) {
  const { intl } = useZCodeIntl();

  const headers = [
    intl.formatMessage({ id: "chat.permission.workflow.save.args.name" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.type" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.required" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.default" }),
  ];
  const requiredLabel = intl.formatMessage({
    id: "chat.permission.workflow.save.args.requiredYes",
  });
  const optionalLabel = intl.formatMessage({
    id: "chat.permission.workflow.save.args.requiredNo",
  });

  return (
    <table className="w-full border-collapse text-left" data-workflow-save-args="true">
      <thead>
        <tr>
          {headers.map((header) => (
            <th
              key={header}
              scope="col"
              className="border-b border-border pb-1 pr-3 text-ui-xs font-medium text-foreground-subtlest"
            >
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {args.map((arg) => (
          <Fragment key={arg.name}>
            <tr data-workflow-save-arg={arg.name}>
              <td className="pr-3 pt-1.5 align-top font-mono text-ui-sm text-foreground-subtle">
                {arg.name}
              </td>
              <td className="pr-3 pt-1.5 align-top font-mono text-ui-sm text-foreground-subtlest">
                {arg.type ?? NO_VALUE_PLACEHOLDER}
              </td>
              <td className="pr-3 pt-1.5 align-top text-ui-sm text-foreground-subtlest">
                {arg.required ? requiredLabel : optionalLabel}
              </td>
              <td className="pt-1.5 align-top font-mono text-ui-sm text-foreground-subtlest">
                {arg.hasDefault ? formatWorkflowArgValue(arg.defaultValue) : NO_VALUE_PLACEHOLDER}
              </td>
            </tr>
            {arg.description === undefined ? null : (
              <tr>
                <td
                  colSpan={headers.length}
                  className="whitespace-pre-wrap break-words pb-1 pt-0.5 text-ui-sm text-foreground-subtlest"
                >
                  {arg.description}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The save confirmation block of SaveWorkflow.
 *
 * This gate has **no display payload** (the spec explicitly adds no `save_workflow` display kind in
 * v1): the input arguments are the whole content, so every item in the block is read from the
 * normalized input arguments. Script collapsing reuses the same idiom and the same set of copy as
 * the run confirmation dialog — the same script must be named the same way in both dialogs.
 *
 * Deliberately **not** wired to Refine: Refine's semantics are "reject this run and tell the model
 * how to change the workflow", whereas a save is one write to disk, the fix being the model calling
 * again with a different set of metadata, so no third option is needed.
 */
export function SaveWorkflowPermissionBlock({ request }: { request: ZCodePermissionRequest }) {
  const { intl } = useZCodeIntl();

  const input = readSaveWorkflowInput(request.raw);
  const [scriptOpen, setScriptOpen] = useState(false);

  // PermissionDialog reuses component instances across requests. It must return to the default folded state after changing requests.
  // Otherwise the last expansion will be leaked to the next save confirmation.
  useEffect(() => {
    setScriptOpen(false);
  }, [request.requestId]);

  // Overwrite and create are two **different questions**, not the same sentence with a mark: the user should know it when reading the first line
  // Will this operation replace anything that already exists?
  const title = intl.formatMessage({
    id: input.overwrite
      ? "chat.permission.workflow.save.overwriteTitle"
      : "chat.permission.workflow.save.title",
  });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const overwriteLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.overwrite" });
  const overwriteHint = intl.formatMessage({ id: "chat.permission.workflow.save.overwriteHint" });
  const scriptToggleLabel = intl.formatMessage({
    id: scriptOpen ? "chat.permission.workflow.hideScript" : "chat.permission.workflow.showScript",
  });

  return (
    <div className="space-y-3" data-save-workflow-permission-block="true">
      <p className="text-ui-base font-medium leading-5 text-foreground">{title}</p>

      <div className="flex min-w-0 items-center gap-2">
        <Save className="size-4 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 truncate font-mono text-ui-base text-foreground-subtle">
          {input.name ?? fallbackName}
        </span>
        {input.overwrite ? <SaveWorkflowOverwriteBadge label={overwriteLabel} /> : null}
      </div>

      {input.overwrite ? (
        <p
          className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-ui-sm text-foreground-subtle"
          data-workflow-overwrite-hint="true"
        >
          {overwriteHint}
        </p>
      ) : null}

      <div className="space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2">
        {input.path === undefined ? null : (
          <MetadataRow
            label={intl.formatMessage({ id: "chat.permission.workflow.save.path" })}
            value={input.path}
            mono
          />
        )}
        {input.description === undefined ? null : (
          <MetadataRow
            label={intl.formatMessage({ id: "chat.permission.workflow.save.description" })}
            value={input.description}
          />
        )}
        {input.whenToUse === undefined ? null : (
          <MetadataRow
            label={intl.formatMessage({ id: "chat.permission.workflow.save.whenToUse" })}
            value={input.whenToUse}
          />
        )}
      </div>

      {input.args.length === 0 ? null : (
        <div className="space-y-1.5">
          <p className="text-ui-sm font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.permission.workflow.save.args" })}
          </p>
          <WorkflowArgsTable args={input.args} />
        </div>
      )}

      {input.script === undefined ? null : (
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 transition-transform", scriptOpen && "rotate-90")}
            />
            <span className="min-w-0 truncate">{scriptToggleLabel}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            <CodeBlock
              code={input.script}
              language="typescript"
              renderMermaid={false}
              showLineNumbers
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
