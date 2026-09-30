import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Clock3, Trash2 } from "lucide-react";
import type {
  BotConfig,
  BotReplyGranularity,
  BotServiceStatus,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@/settings/SettingsPageParts.js";
import {
  getBotReplyGranularitiesForProvider,
  getBotReplyGranularityEntryForProvider,
} from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";
import { ProviderIcon, runtimeDot, runtimeText } from "./shared.js";

export function BotSummaryCard({
  bot,
  runtime,
  selectedBotDisplayName,
  selectedBotName,
  fallbackBotName,
  renaming,
  onStartRename,
  onCommitNameDraft,
  onNameDraftChange,
  onNameCompositionEnd,
  onNameCompositionStart,
  onNameInputKeyDown,
  onPatchBot,
}: {
  bot: BotConfig;
  runtime: BotServiceStatus["botRuntime"][number] | undefined;
  selectedBotDisplayName: string;
  selectedBotName: string;
  fallbackBotName: string;
  renaming: boolean;
  onStartRename: () => void;
  onCommitNameDraft: () => void;
  onNameDraftChange: (value: string) => void;
  onNameCompositionEnd?: () => void;
  onNameCompositionStart?: () => void;
  onNameInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const nameMeasureButtonRef = useRef<HTMLButtonElement | null>(null);
  const [nameEditorWidth, setNameEditorWidth] = useState<number | null>(null);
  const isBound = Boolean(bot.providerUserId);
  // Reason for repair: Connection failure will directly block /bind, and "unbound" can no longer be used to override the real blocking state.
  const summaryStatusText =
    runtime?.status === "error"
      ? intl.formatMessage({
          id:
            bot.provider === "feishu"
              ? "bots.runtime.feishuConnectionFailed"
              : bot.provider === "lark"
                ? "bots.runtime.larkConnectionFailed"
                : "bots.runtime.connectionFailed",
        })
      : isBound
        ? runtimeText(runtime, bot.enabled, (id) => intl.formatMessage({ id }))
        : intl.formatMessage({ id: "bots.unbound" });
  const nameEditorText = selectedBotName || fallbackBotName;

  useLayoutEffect(() => {
    if (!renaming) {
      setNameEditorWidth(null);
      return undefined;
    }
    const measureButton = nameMeasureButtonRef.current;
    if (!measureButton) {
      return undefined;
    }
    const updateWidth = () => {
      setNameEditorWidth(
        Math.ceil(measureButton.getBoundingClientRect().width),
      );
    };
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(measureButton);
    return () => resizeObserver.disconnect();
  }, [nameEditorText, renaming]);

  const botNameControl = (
    <div className="min-w-0">
      {renaming ? (
        <label
          className="relative inline-block min-w-6 max-w-md align-middle"
          style={
            nameEditorWidth ? { width: `${nameEditorWidth}px` } : undefined
          }
        >
          <span className="sr-only">
            {intl.formatMessage({ id: "bots.name" })}
          </span>
          <button
            ref={nameMeasureButtonRef}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 invisible max-w-md overflow-hidden rounded-sm px-1 text-left text-ui-lg font-medium"
            // Hidden measurement nodes will collapse the leading and trailing spaces by default, resulting in a smaller width when the input name contains spaces; only by keeping the spaces blank can the width be consistent with the actual content of the input.
            style={{ whiteSpace: "pre" }}
          >
            {nameEditorText}
          </button>
          <input
            autoFocus
            className="w-full min-w-0 truncate rounded-sm border-0 bg-transparent px-1 py-0 text-left text-ui-lg font-medium leading-normal text-foreground outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-input-border-focused"
            value={selectedBotName}
            onBlur={onCommitNameDraft}
            onChange={(event) => onNameDraftChange(event.target.value)}
            onCompositionEnd={onNameCompositionEnd}
            onCompositionStart={onNameCompositionStart}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={onNameInputKeyDown}
            placeholder={fallbackBotName}
          />
        </label>
      ) : (
        <button
          type="button"
          className="min-w-0 max-w-md truncate rounded-sm px-1 text-left text-ui-lg font-medium hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
          onClick={onStartRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onStartRename();
            }
          }}
        >
          {selectedBotDisplayName}
        </button>
      )}
    </div>
  );

  const botIdentityDescription = (
    <span className="inline-flex items-center gap-2 text-foreground-subtle">
      {isBound || runtime?.status === "error" ? (
        <span
          className={cn(
            "size-1.5 rounded-full",
            runtimeDot(runtime, bot.enabled),
          )}
        />
      ) : (
        <Clock3 className="size-3 text-foreground-subtle" />
      )}
      {summaryStatusText}
    </span>
  );

  return (
    <div className="flex items-center gap-3 pb-2 px-2">
      <ProviderIcon
        provider={bot.provider}
        className="size-12 shrink-0 text-foreground-subtle"
      />
      <div className="min-w-0 flex-1 space-y-1">
        {botNameControl}
        {botIdentityDescription}
      </div>
      <div className="shrink-0">
        <Switch
          checked={bot.enabled}
          onCheckedChange={(enabled) => onPatchBot({ enabled })}
        />
      </div>
    </div>
  );
}

export function BotReplyGranularityCard({
  bot,
  onPatchBot,
}: {
  bot: BotConfig;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const replyGranularities = getBotReplyGranularitiesForProvider(bot.provider);
  const selectedGranularity = getBotReplyGranularityEntryForProvider(
    bot.provider,
    bot.replyMode,
  );

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "bots.replyGranularity" })}
      description={intl.formatMessage({
        id: selectedGranularity.descriptionId,
      })}
      control={
        <Select
          value={selectedGranularity.id}
          onValueChange={(replyMode) =>
            onPatchBot({ replyMode: replyMode as BotReplyGranularity })
          }
        >
          <SelectTrigger size="lg" className="w-48 justify-between">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {replyGranularities.map((granularity) => (
              <SelectItem key={granularity.id} value={granularity.id}>
                {intl.formatMessage({ id: granularity.labelId })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

export function BotDangerCard({ onDelete }: { onDelete: () => void }) {
  const { intl } = useZCodeIntl();

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "bots.delete" })}
        description={intl.formatMessage({ id: "bots.delete.description" })}
        control={
          <Button
            variant="destructive"
            size="lg"
            onClick={onDelete}
            title={intl.formatMessage({ id: "bots.delete" })}
          >
            <Trash2 className="size-4" />
            {intl.formatMessage({ id: "bots.delete" })}
          </Button>
        }
      />
    </SettingsGroupCard>
  );
}
