// ============================================================
// Two fields of the "Configuration" elastic layer
// ============================================================
// Take it out from WorkflowRunSettingsPopover.tsx: it manages the form status, commands and consequence sentences. Here we only draw two controlled fields——
// Subagent model (composer's model menu + think file) and "simultaneous running limit" stepper. props are all cooked values.

import { useMemo, useRef, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { ZCODE_AGENT_PROVIDER, type ZCodeConfigOption } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { cn } from "@/components/lib/utils.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
  ModelConfigSelect,
  type ModelSelectGroup,
  type ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import { clampWorkflowRunSettingsBound } from "./workflowRunSettings.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

/** Field label: 12px, secondary color, 4px above the control. */
function FieldLabel({ children }: { children: string }) {
  return <div className="text-ui-sm text-foreground-subtle">{children}</div>;
}

/**
 * Sub-agent model: the same model menu as in the composer, with the “session model” first; when the
 * selected model has thought levels, the trigger is followed by the same thought-level control used
 * in the sub-agent cell of the settings page. When the list is empty the whole cell is replaced by
 * a single sentence (the limit is still adjustable).
 */
export function WorkflowRunSettingsModelField({
  badge,
  disabled,
  groups,
  leadingItem,
  noCatalog,
  onLevelChange,
  onValueChange,
  thoughtOption,
  triggerLabel,
  value,
}: {
  /**
   * The badge inside the trigger: “session model” or “unavailable”; when absent, nothing is shown.
   */
  badge?: { text: string; tone: "subtle" | "warning" };
  disabled: boolean;
  groups: readonly ModelSelectGroup[];
  leadingItem: ModelSelectGroupItem;
  /** The current agent has no selectable model: the whole cell degrades to a single sentence. */
  noCatalog: boolean;
  onLevelChange: (level: string) => void;
  onValueChange: (value: string) => void;
  /** Thought levels of the selected model; when absent, no thought-level control is drawn. */
  thoughtOption: ZCodeConfigOption | null;
  triggerLabel: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [levelOpen, setLevelOpen] = useState(false);
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model" });
  // ModelConfigSelect is a memo component: the inline array is a new reference every time it is rendered, which will make its memo useless.
  const leadingItems = useMemo(() => [leadingItem], [leadingItem]);
  if (noCatalog) {
    return (
      <div className="flex flex-col gap-1" data-testid="workflow-run-settings-model">
        <FieldLabel>{label}</FieldLabel>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.model.noCatalog" })}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-run-settings-model">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="inline-flex min-w-0 flex-1" data-model-current-value={value}>
          <ModelConfigSelect
            modelGroups={groups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={onValueChange}
            leadingItems={leadingItems}
            contentSide="bottom"
            contentAlign="start"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-7 w-full min-w-0 justify-between rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
            triggerTestId="workflow-run-settings-model-trigger"
            {...(badge === undefined
              ? {}
              : {
                  triggerBadge: (
                    <span
                      className={cn(
                        MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
                        badge.tone === "warning" && "text-warning",
                      )}
                      data-testid="workflow-run-settings-model-badge"
                    >
                      {badge.text}
                    </span>
                  ),
                })}
            disabled={disabled}
          />
        </span>
        {thoughtOption === null ? null : (
          <ThoughtLevelCycleControl
            intl={intl}
            option={thoughtOption}
            provider={ZCODE_AGENT_PROVIDER}
            onCurrentValueCommit={onLevelChange}
            showInvalidCurrentValue
            disabled={disabled}
            open={disabled ? false : levelOpen}
            onOpenChange={setLevelOpen}
            triggerRef={levelTriggerRef}
            restoreFocusSelector={null}
            labelVisibilityClassName="inline-flex"
            triggerClassName="h-7 shrink-0 rounded-md border border-input-border bg-input px-2 text-foreground hover:border-input-border-hover hover:bg-input"
            onValueChange={onLevelChange}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The “max concurrent runs” stepper: minus, a tabular number, plus, from 1 up to the local ceiling.
 * The ceiling itself means “this run has no limit of its own”, so the hint is reworded to “= local
 * limit”. When the ceiling is unknown (older CLI) there is no limit and no hint, and the number can
 * be typed directly.
 */
export function WorkflowRunSettingsBoundField({
  bound,
  ceiling,
  disabled,
  onChange,
}: {
  bound: number | null;
  ceiling: number | undefined;
  disabled: boolean;
  onChange: (bound: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const hint =
    ceiling === undefined
      ? undefined
      : bound !== null && bound >= ceiling
        ? intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit.atCeiling" })
        : intl.formatMessage(
            { id: "chat.toolCall.workflow.run.settings.limit.ceiling" },
            { n: ceiling },
          );
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-run-settings-bound">
      <FieldLabel>
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit" })}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <InputGroup className="w-auto shrink-0">
          <InputGroupAddon align="inline-start">
            <InputGroupButton
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.settings.limit.decrease",
              })}
              data-testid="workflow-run-settings-bound-decrease"
              disabled={disabled || bound === null || bound <= 1}
              onClick={() =>
                bound !== null && onChange(clampWorkflowRunSettingsBound(bound - 1, ceiling))
              }
              size="icon-xs"
            >
              <MinusIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
          <InputGroupInput
            aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.limit" })}
            className="h-7 w-9 px-0 text-center font-mono tabular-nums"
            data-testid="workflow-run-settings-bound-value"
            disabled={disabled}
            inputMode="numeric"
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(parsed)) onChange(clampWorkflowRunSettingsBound(parsed, ceiling));
            }}
            placeholder="—"
            value={bound === null ? "" : String(bound)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.settings.limit.increase",
              })}
              data-testid="workflow-run-settings-bound-increase"
              disabled={disabled || bound === null || (ceiling !== undefined && bound >= ceiling)}
              onClick={() =>
                bound !== null && onChange(clampWorkflowRunSettingsBound(bound + 1, ceiling))
              }
              size="icon-xs"
            >
              <PlusIcon className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {hint === undefined ? null : (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{hint}</span>
        )}
      </div>
    </div>
  );
}
