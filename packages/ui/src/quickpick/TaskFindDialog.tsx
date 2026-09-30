import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileDiffIcon,
  MessageCircleIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  getConversationFindState,
  resolveConversationFindNavigationSelection,
  resolveConversationFindNavigationDirection,
} from "@/quickpick/conversationFindSearch.js";

type TaskFindScope = "conversation" | "changes";

export type TaskFindDialogProps = {
  open: boolean;
  focusRequestId: number;
  placement?: "window" | "chat";
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  conversationMatchCount: number;
  conversationMatchIndex: number;
  fileChangeMatchCount: number;
  fileChangeMatchIndex: number;
  onOpenChange: (open: boolean) => void;
  onConversationFindChange: (query: string, activeIndex: number) => void;
  onConversationFindNavigate: (query: string, activeIndex: number) => void;
  onFileChangeFindChange: (query: string, activeIndex: number) => void;
  onFileChangeFindNavigate: (query: string, activeIndex: number) => void;
  onOpenFileChanges: () => void;
};

export function TaskFindDialog({
  open,
  focusRequestId,
  placement = "window",
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  conversationMatchCount,
  conversationMatchIndex,
  fileChangeMatchCount,
  fileChangeMatchIndex,
  onOpenChange,
  onConversationFindChange,
  onConversationFindNavigate,
  onFileChangeFindChange,
  onFileChangeFindNavigate,
  onOpenFileChanges,
}: TaskFindDialogProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const titleId = useId();
  const descriptionId = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TaskFindScope>("conversation");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const conversationState = useMemo(
    () =>
      getConversationFindState(query.trim() ? conversationMatchCount : 0, conversationMatchIndex),
    [conversationMatchCount, conversationMatchIndex, query],
  );
  const fileChangeState = useMemo(
    () => getConversationFindState(query.trim() ? fileChangeMatchCount : 0, fileChangeMatchIndex),
    [fileChangeMatchCount, fileChangeMatchIndex, query],
  );
  const activeFindState = scope === "conversation" ? conversationState : fileChangeState;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setScope("conversation");
      onConversationFindChange("", -1);
      onFileChangeFindChange("", -1);
      return;
    }

    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [onConversationFindChange, onFileChangeFindChange, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Cmd/Ctrl+F will not change the open state when the search box is open, and the regular focus effect will not rerun.
    // Listen for explicit focus requests here so that the focus can always be brought back to the search input box when the shortcut key is triggered repeatedly.
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [focusRequestId, open]);

  useEffect(() => {
    if (!open || scope !== "changes") {
      return;
    }

    onOpenFileChanges();
  }, [onOpenFileChanges, open, scope]);

  useEffect(() => {
    if (!open || placement !== "chat") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      // After the search box is sunk into the chat area, Radix Dialog is no longer responsible for Esc.
      // The window bubbling listener only handles Esc that has not been consumed by the active floating layer to avoid preempting the closing semantics of the nested menu/pop-up layer.
      event.preventDefault();
      onOpenChange(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open, placement]);

  useEffect(() => {
    if (!open || scope !== "conversation") {
      return;
    }

    onFileChangeFindChange("", -1);
    onConversationFindChange(query, conversationState.currentIndex);
  }, [
    conversationState.currentIndex,
    onConversationFindChange,
    onFileChangeFindChange,
    open,
    query,
    scope,
  ]);

  useEffect(() => {
    if (!open || scope !== "changes") {
      return;
    }

    // Old conversation search highlights should no longer remain in the chat area after switching to the "File Changes" scope.
    // The two ranges use independent highlighting root, and the other side is explicitly cleared here to prevent users from mistakenly thinking that the two ranges are effective at the same time.
    onConversationFindChange("", -1);
    onFileChangeFindChange(query, fileChangeState.currentIndex);
  }, [
    fileChangeState.currentIndex,
    onConversationFindChange,
    onFileChangeFindChange,
    open,
    query,
    scope,
  ]);

  const moveSelection = useCallback(
    (direction: "previous" | "next") => {
      if (activeFindState.total === 0) {
        // The button is disabled on zero hit, but the keyboard still enters the same handler function.
        // Empty navigation is uniformly rejected here to avoid invalid request id increments and button/keyboard semantic bifurcation.
        return;
      }

      const selection = resolveConversationFindNavigationSelection(
        query,
        activeFindState,
        direction,
      );
      if (scope === "conversation") {
        onConversationFindNavigate(selection.query, selection.activeIndex);
        return;
      }

      onFileChangeFindNavigate(selection.query, selection.activeIndex);
    },
    [activeFindState, onConversationFindNavigate, onFileChangeFindNavigate, query, scope],
  );

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      const nextIndex = nextQuery.trim() ? 0 : -1;
      if (scope === "conversation") {
        // When entering a new search term you should start scrolling from the first hit.
        // If the old activeIndex is used, the new keyword may jump directly to the Nth result, which is inconsistent with the system search behavior.
        onConversationFindChange(nextQuery, nextIndex);
        return;
      }

      onFileChangeFindChange(nextQuery, nextIndex);
    },
    [onConversationFindChange, onFileChangeFindChange, scope],
  );

  const handleScopeChange = useCallback(
    (nextScope: TaskFindScope) => {
      setScope(nextScope);
      if (nextScope === "changes") {
        onOpenFileChanges();
        onConversationFindChange("", -1);
        onFileChangeFindChange(query, query.trim() ? 0 : -1);
        return;
      }

      onFileChangeFindChange("", -1);
      onConversationFindChange(query, query.trim() ? 0 : -1);
    },
    [onConversationFindChange, onFileChangeFindChange, onOpenFileChanges, query],
  );

  const handleToggleScope = useCallback(() => {
    handleScopeChange(scope === "conversation" ? "changes" : "conversation");
  }, [handleScopeChange, scope]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const direction = resolveConversationFindNavigationDirection(event.key, event.shiftKey);
      if (direction) {
        event.preventDefault();
        moveSelection(direction);
      }
    },
    [moveSelection],
  );

  const placeholderId = `quickPick.find.placeholder.${scope}`;
  const ScopeIcon = scope === "conversation" ? MessageCircleIcon : FileDiffIcon;
  const nextScopeLabelId =
    scope === "conversation" ? "quickPick.find.scope.changes" : "quickPick.find.scope.conversation";
  const previousLabel = intl.formatMessage({ id: "quickPick.find.previous" });
  const nextLabel = intl.formatMessage({ id: "quickPick.find.next" });
  const nextScopeLabel = intl.formatMessage({ id: nextScopeLabelId });
  const scopeTooltipLabel = intl.formatMessage({
    id: "quickPick.find.scope.tooltip",
  });
  const closeLabel = intl.formatMessage({ id: "common.close" });
  const renderFindIconButton = ({
    label,
    tooltipLabel = label,
    disabled,
    onClick,
    children,
  }: {
    label: string;
    tooltipLabel?: string;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <ControlHintTooltip title={tooltipLabel} side="bottom">
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </span>
    </ControlHintTooltip>
  );
  const findContent = (
    <div className="flex h-9 items-center gap-1.5 py-0 pr-2 pl-2">
      <SearchIcon className="size-3.5 shrink-0 text-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={intl.formatMessage({ id: placeholderId })}
        className="min-w-0 flex-1 bg-transparent text-ui-base font-medium text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      <div className="w-8 shrink-0 text-center text-ui-xs font-medium text-foreground-subtle tabular-nums">
        {activeFindState.total > 0
          ? `${activeFindState.currentIndex + 1}/${activeFindState.total}`
          : "0/0"}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5">
        {renderFindIconButton({
          label: previousLabel,
          disabled: activeFindState.total === 0,
          onClick: () => moveSelection("previous"),
          children: <ArrowUpIcon className="size-3.5" />,
        })}
        {renderFindIconButton({
          label: nextLabel,
          disabled: activeFindState.total === 0,
          onClick: () => moveSelection("next"),
          children: <ArrowDownIcon className="size-3.5" />,
        })}
        {(!isOfficeMode || scope === "changes") &&
          renderFindIconButton({
            label: nextScopeLabel,
            tooltipLabel: scopeTooltipLabel,
            onClick: handleToggleScope,
            children: <ScopeIcon className="size-3.5" />,
          })}
      </div>
      <div className="ml-0.5 flex shrink-0 border-l border-border pl-1.5">
        {renderFindIconButton({
          label: closeLabel,
          onClick: () => onOpenChange(false),
          children: <XIcon className="size-3.5" />,
        })}
      </div>
    </div>
  );
  const contentPositionClassName = cn(
    // The width and height of the original search box are too large, which will block more text area in small windows and intensive operations.
    // This is tightened up to a smaller width and padding, making it less intrusive and keeping the operation readable.
    "left-auto !w-[min(360px,calc(100vw-0.75rem))] !max-w-[calc(100vw-0.75rem)] translate-x-0 translate-y-0",
    // The window control and title bar of Linux are both self-drawn by the renderer; if you continue to paste the floating layer on top-3,
    // The click area of the title bar will be covered, resulting in the inability to switch/drag windows through the title bar after opening the floating layer. Linux desktop
    // Reserve 48px for the title bar and 120px for the right window button safe area, and use the offsets of their respective branches for the remaining platforms.
    isWindowsDesktop
      ? "top-12 right-36"
      : isMacDesktop
        ? "top-14 right-3"
        : isLinuxDesktop
          ? "top-12 right-[120px]"
          : "top-3 right-3",
  );

  if (placement === "chat") {
    if (!open) {
      return null;
    }

    return (
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="absolute top-3 left-1/2 z-30 w-[min(360px,calc(100%-1rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-popover-border bg-popover p-0 text-ui-base/relaxed text-foreground shadow-md outline-none [app-region:no-drag] max-md:top-2"
      >
        <div className="sr-only">
          <h2 id={titleId}>{intl.formatMessage({ id: "quickPick.find.title" })}</h2>
          <p id={descriptionId}>{intl.formatMessage({ id: "quickPick.find.description" })}</p>
        </div>
        {findContent}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogHeader className="sr-only">
        <DialogTitle id={titleId}>{intl.formatMessage({ id: "quickPick.find.title" })}</DialogTitle>
        <DialogDescription id={descriptionId}>
          {intl.formatMessage({ id: "quickPick.find.description" })}
        </DialogDescription>
      </DialogHeader>
      <DialogContent
        showCloseButton={false}
        showOverlay={false}
        onInteractOutside={(event) => {
          // After the search box is changed to unmasked, the user will click on the chat area to view the context of the hit.
          // Radix Dialog treats external clicks as close signals by default, which will cause the search state to be lost; the floating layer is retained here, and you can still exit with the Esc or close button.
          event.preventDefault();
        }}
        className={cn(
          // Cmd/Ctrl+F The floating layer cannot be fixed in the upper right corner: the Desktop side will overlap with the title area control.
          // Here, a safe area is reserved according to the platform: move it down to the bottom of the title area, and move it to the right in Windows to avoid the native window button in the upper right corner.
          contentPositionClassName,
          "overflow-hidden border-popover-border bg-popover p-0 shadow-md",
        )}
      >
        {findContent}
      </DialogContent>
    </Dialog>
  );
}
