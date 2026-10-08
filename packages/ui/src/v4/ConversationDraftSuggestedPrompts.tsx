import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog.js";
import type { CSSProperties } from "react";
import { X, SquareCode } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveDraftSuggestedPromptText,
  type DraftSuggestedPromptItem,
} from "@/v4/draftSuggestedPromptItems.js";

export type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

function DraftSuggestedPromptIcon({ name }: { name?: string }) {
  return (
    <ClientSceneLucideIcon
      name={name}
      aria-hidden="true"
      className="size-4"
      strokeWidth={2}
      fallback={<SquareCode aria-hidden="true" className="size-4" strokeWidth={2} />}
    />
  );
}

export interface ConversationDraftSuggestedPromptsProps {
  className?: string;
  layout?: "chips" | "list";
  items?: DraftSuggestedPromptItem[];
  onSelect?: (item: DraftSuggestedPromptItem) => void;
  disabled?: boolean;
  onRefresh?: () => void;
  onClose?: () => void;
  refreshDisabled?: boolean;
}

export function ConversationDraftSuggestedPrompts({
  className,
  layout = "chips",
  items = [],
  onSelect,
  disabled = false,
  onRefresh,
  onClose,
  refreshDisabled = false,
}: ConversationDraftSuggestedPromptsProps) {
  const { locale, intl } = useZCodeIntl();
  const [confirmClose, setConfirmClose] = useState(false);

  if (items.length === 0) return null;

  if (layout === "list") {
    return (
      <div
        data-v4-draft-suggested-prompts="true"
        className={cn("w-full min-w-0 px-2 py-4", className)}
      >
        <div className="flex items-center justify-between gap-2 px-3 pb-2 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "occupationOnboarding.suggestionsHeading" })}</span>
          <div className="flex shrink-0 items-center gap-2">
            {onRefresh ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0 text-ui-sm text-foreground-subtle"
                disabled={disabled || refreshDisabled}
                onClick={onRefresh}
              >
                {intl.formatMessage({ id: "chat.officeSuggestions.refresh" })}
              </Button>
            ) : null}
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled || refreshDisabled}
                aria-label={intl.formatMessage({ id: "chat.officeSuggestions.closeTitle" })}
                onClick={() => setConfirmClose(true)}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {intl.formatMessage({ id: "chat.officeSuggestions.closeTitle" })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {intl.formatMessage({ id: "chat.officeSuggestions.closeDescription" })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
              <AlertDialogAction onClick={onClose}>
                {intl.formatMessage({ id: "common.confirm" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                data-draft-suggested-prompt={item.id}
                disabled={!onSelect || disabled}
                onClick={() => onSelect?.(item)}
                className="flex w-full items-center gap-3 rounded-xl p-3 text-left text-ui-base text-foreground hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:opacity-50"
              >
                <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface p-px">
                  <img
                    src={item.iconUrl}
                    alt=""
                    draggable={false}
                    className={cn(
                      "shrink-0 rounded-sm object-contain",
                      item.iconUrl?.includes("/github/icon.png") ? "size-4.5" : "size-full",
                    )}
                  />
                </span>
                <span className="min-w-0 flex-1 break-words">
                  {resolveDraftSuggestedPromptText(item.label, locale)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      data-v4-draft-suggested-prompts="true"
      className={cn(
        "w-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <div
        data-v4-draft-suggested-prompts-group="true"
        className="mx-auto flex w-max items-center gap-4"
      >
        {items.map((item, index) => {
          const label = resolveDraftSuggestedPromptText(item.label, locale);
          return (
            <Button
              key={item.id}
              type="button"
              variant="outline"
              size="lg"
              data-draft-suggested-prompt={item.id}
              aria-label={label}
              title={label}
              disabled={!onSelect || disabled}
              onClick={onSelect ? () => onSelect(item) : undefined}
              className="zcode-draft-prompt-waterfall h-8 min-w-0 justify-start gap-1.5 overflow-hidden rounded-lg px-3 text-left text-ui-caption font-normal leading-4.5 text-foreground"
              style={
                {
                  "--zcode-draft-prompt-waterfall-delay": `${index * 65}ms`,
                } as CSSProperties
              }
            >
              <span
                data-draft-suggested-prompt-icon="true"
                className="flex size-4 shrink-0 items-center justify-center text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
              >
                <DraftSuggestedPromptIcon name={item.iconName} />
              </span>
              <span
                data-draft-suggested-prompt-text="true"
                className="min-w-0 max-w-64 truncate text-ui-base text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
              >
                {label}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
