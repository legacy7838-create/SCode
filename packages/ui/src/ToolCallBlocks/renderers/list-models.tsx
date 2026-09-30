import { Cpu } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  getModelProviderFamilySpec,
  resolveModelProviderFamilyIdByProviderId,
} from "@zcode/shared";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const LIST_MODELS_TOOL_ICON = <Cpu className="size-4 shrink-0 text-foreground-subtle" />;

type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/**
 * providerId → the provider name from the session model catalog; a miss means absent (see
 * useWorkflowSubagentModelProviderName).
 */
type ProviderNameLookup = ((providerId: string) => string | undefined) | undefined;

interface ListModelsEntryView {
  id: string;
  providerId: string;
  modelId: string;
  providerLabel: string | undefined;
  reasoningLevels: string[];
  defaultReasoningLevel: string | undefined;
  contextWindow: number | undefined;
  disabledReason: string | undefined;
}

interface ListModelsResult {
  current: string | undefined;
  models: ListModelsEntryView[];
  truncated: boolean;
}

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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
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

function readResultRecord(value: unknown): ListModelsResult | null {
  const normalized = parseJsonCandidate(value);
  if (!isPlainRecord(normalized) || !Array.isArray(normalized.models)) {
    return null;
  }

  const models: ListModelsEntryView[] = [];
  for (const entry of normalized.models) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const id = readTrimmedString(entry.id);
    const providerId = readTrimmedString(entry.providerId);
    const modelId = readTrimmedString(entry.modelId);
    if (id === undefined || providerId === undefined || modelId === undefined) {
      continue;
    }
    models.push({
      id,
      providerId,
      modelId,
      providerLabel: readTrimmedString(entry.providerLabel),
      reasoningLevels: readStringArray(entry.reasoningLevels),
      defaultReasoningLevel: readTrimmedString(entry.defaultReasoningLevel),
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : undefined,
      disabledReason: readTrimmedString(entry.disabledReason),
    });
  }

  return {
    current: readTrimmedString(normalized.current),
    models,
    truncated: normalized.truncated === true,
  };
}

/**
 * The result read order is the one list-saved-workflows uses: **the display channel comes first**
 * (the `list_models` kind — on the v4 wire output.text is the `<models>` projection of
 * formatModelContent, so the JSON probe below can never hit it, which is exactly the root cause of
 * landing in the raw fallback card today); the legacy JSON probe covers old sessions and non-v4
 * hosts. If neither can read anything, return null — "this machine has no models" and "this result
 * cannot be read" must stay distinguishable.
 */
function readListModelsResult(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ListModelsResult | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "list_models") {
    return {
      current: display.current,
      models: display.models.map((model) => ({
        id: model.id,
        providerId: model.providerId,
        modelId: model.modelId,
        providerLabel: model.providerLabel,
        reasoningLevels: [...model.reasoningLevels],
        defaultReasoningLevel: model.defaultReasoningLevel,
        contextWindow: model.contextWindow,
        disabledReason: model.disabledReason,
      })),
      truncated: display.truncated === true,
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
 * Group name = the provider's **name**, by the same rule as the model menu (the same discipline as
 * subagent-model-label.ts): a built-in family uses the family name; otherwise the providerLabel
 * from the payload; otherwise the name from the session model catalog; with none of those, the word
 * "Model provider" itself. **Never fall back to providerId** — on a team plan it is a UUID, and
 * putting that on screen means making the user skip 36 characters before they see a model name.
 */
function listModelsGroupName(
  providerId: string,
  providerLabel: string | undefined,
  providerName: ProviderNameLookup,
  formatMessage: FormatMessage,
): string {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  if (familyId !== null) {
    return getModelProviderFamilySpec(familyId).label;
  }
  const label = providerLabel?.trim();
  if (label !== undefined && label.length > 0 && label !== providerId) {
    return label;
  }
  // When the session list cannot be found, the providerId itself (zcodeSessionSettingsToConfigOptions) will be returned and treated as not found.
  const resolved = providerName?.(providerId)?.trim();
  if (resolved !== undefined && resolved.length > 0 && resolved !== providerId) {
    return resolved;
  }
  return formatMessage({ id: "chat.toolCall.workflow.models.provider" });
}

/**
 * How the context window is read: below a thousand, verbatim; below a million, rounded to K; above
 * that, to M and keeping one decimal only when there is one (`1M` / `1.5M`). This column is for
 * glancing at relative sizes, not for checking an exact token count.
 */
function formatContextWindow(contextWindow: number): string {
  if (contextWindow < 1_000) {
    return String(contextWindow);
  }
  if (contextWindow < 1_000_000) {
    return `${Math.round(contextWindow / 1_000)}K`;
  }
  const millions = contextWindow / 1_000_000;
  return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
}

function levelWord(level: string, formatMessage: FormatMessage): string {
  // The gear words are in the same table as the thinking control; values ​​not in the table are displayed as they are (provider's customized gear name).
  const labelId = thoughtLevelLabelId(level);
  return labelId === undefined ? level : formatMessage({ id: labelId });
}

/**
 * The row tooltip: the first line is the reasoning-effort level (say so when there is none), and
 * after the line break the canonical id. The canonical id exists so a machine can back-fill
 * `subagent_model`, and it belongs only here (the same division of labour as
 * subagent-model-label.ts).
 */
function listModelsRowTooltip(model: ListModelsEntryView, formatMessage: FormatMessage): string {
  let levelsLine: string;
  if (model.reasoningLevels.length === 0) {
    levelsLine = formatMessage({ id: "chat.toolCall.workflow.models.noLevels" });
  } else {
    const levels = model.reasoningLevels
      .map((level) => levelWord(level, formatMessage))
      .join(" · ");
    levelsLine =
      model.defaultReasoningLevel === undefined
        ? formatMessage({ id: "chat.toolCall.workflow.models.levelsNoDefault" }, { levels })
        : formatMessage(
            { id: "chat.toolCall.workflow.models.levels" },
            { default: levelWord(model.defaultReasoningLevel, formatMessage), levels },
          );
  }
  return `${levelsLine}\n${model.id}`;
}

interface ListModelsGroup {
  providerId: string;
  models: ListModelsEntryView[];
}

/**
 * Group by providerId, keeping first-appearance order — the catalog's order is the host registry's
 * order, and the card does not re-sort.
 */
function groupModelsByProvider(models: ListModelsEntryView[]): ListModelsGroup[] {
  const groups: ListModelsGroup[] = [];
  const byProviderId = new Map<string, ListModelsGroup>();
  for (const model of models) {
    let group = byProviderId.get(model.providerId);
    if (group === undefined) {
      group = { providerId: model.providerId, models: [] };
      byProviderId.set(model.providerId, group);
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/**
 * The chat card for ListModels.
 *
 * Why it deserves a dedicated renderer: this tool name is not in shared's known-tool table, so the
 * generic path is `FallbackToolCallBlock`, which lays the model-facing `<models>` text out verbatim
 * — every line of that text starts with a providerId (possibly a UUID or an equally opaque id), and
 * "current" is hidden in brackets at the end of the line.
 *
 * The card answers only three things: what is there, where it comes from, which one is current. The
 * level list and the canonical id of each row belong to the tooltip; not a single character of
 * providerId reaches the screen.
 */
export function ListModelsToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const providerName = useWorkflowSubagentModelProviderName(context.workspacePath);

  const result = useMemo(() => readListModelsResult(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.models.listing"
      : "chat.toolCall.workflow.models.listed",
  });
  const emptyLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.empty" });
  const currentLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.current" });
  const truncatedLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.truncated" });

  const modelCount = result?.models.length ?? 0;
  // Lightweight intl does not have ICU plural, and singular and plural numbers use separate message keys (same as the precedent of workflow.list.count).
  const countLabel = intl.formatMessage(
    {
      id:
        modelCount === 1
          ? "chat.toolCall.workflow.models.countOne"
          : "chat.toolCall.workflow.models.count",
    },
    { count: modelCount },
  );

  const groups = useMemo(
    () => (result === null ? [] : groupModelsByProvider(result.models)),
    [result],
  );

  // ToolLayout is a memo component: inline JSX props are new references every time they are rendered, which will invalidate memoization.
  const primaryText = useMemo(
    () => (
      <span className="truncate text-foreground-subtlest">
        {modelCount === 0 ? emptyLabel : countLabel}
      </span>
    ),
    [countLabel, emptyLabel, modelCount],
  );

  const renderContent = useCallback(() => {
    if (result === null) {
      return null;
    }

    return (
      <div className="mb-2 space-y-2" data-model-list="true">
        {groups.map((group) => (
          <div key={group.providerId} className="min-w-0 space-y-0.5">
            <div className="text-ui-xs text-foreground-subtlest">
              {listModelsGroupName(
                group.providerId,
                group.models.find((model) => model.providerLabel !== undefined)?.providerLabel,
                providerName,
                intl.formatMessage,
              )}
            </div>
            {group.models.map((model) => (
              <div
                key={model.id}
                className="flex min-w-0 items-baseline gap-x-2"
                title={listModelsRowTooltip(model, intl.formatMessage)}
                data-model-id={model.id}
              >
                <span
                  className={
                    model.disabledReason === undefined
                      ? "min-w-0 truncate font-mono text-ui-base text-foreground-subtle"
                      : "min-w-0 truncate font-mono text-ui-base text-foreground-subtlest"
                  }
                >
                  {model.modelId}
                </span>
                {model.id === result.current ? (
                  <span
                    className="shrink-0 text-ui-xs text-foreground-subtlest"
                    data-model-current="true"
                  >
                    {currentLabel}
                  </span>
                ) : null}
                {model.disabledReason === undefined ? null : (
                  <span className="min-w-0 truncate text-ui-xs text-warning">
                    {model.disabledReason}
                  </span>
                )}
                {model.contextWindow === undefined ? null : (
                  <span className="ml-auto shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                    {formatContextWindow(model.contextWindow)}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}

        {result.truncated ? (
          <p className="text-ui-sm text-foreground-subtlest">{truncatedLabel}</p>
        ) : null}
      </div>
    );
  }, [currentLabel, groups, intl.formatMessage, providerName, result, truncatedLabel]);

  // Failure does not return the card: that card will spread out the error JSON, and what is really being said here is "This session cannot read the model."
  // Directory". It is different from "not a single model". The card neither draws a list nor says that empty phrase (same as
  // model_catalog_unavailable resolution on the model channel).
  if (result === null && toolCall.status === "failed") {
    return (
      <>
        <ToolLayout
          toolId={toolCall.toolId}
          icon={LIST_MODELS_TOOL_ICON}
          showIcon={context.showIcon !== false}
          canToggle={false}
          forceOpen={false}
          kindLabel={context.kindLabelOverride ?? kindLabel}
          sourceLabel={context.sourceLabel}
          // When failed, the summary line only has category words and status words: the count and the sentence "no configuration model" are both lies here.
          primaryText={null}
          statusLabel={context.statusLabel}
          statusTooltip={context.errorText}
          showFailureStatus
          isRunning={context.isRunning}
          title={toolCall.title}
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

  // If you cannot read the structured results (old sessions, downgrade paths), return the general card instead of drawing an empty directory.
  if (result === null) {
    return <FallbackToolCallBlock {...context} iconOverride={LIST_MODELS_TOOL_ICON} />;
  }

  // When there is no model, the summary line is just that sentence, with no expandable content - an empty card body is harder to read than no card body.
  const hasDetails = modelCount > 0;

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={LIST_MODELS_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
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
