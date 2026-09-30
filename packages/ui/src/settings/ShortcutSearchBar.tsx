import type { ReactNode } from "react";
import { Keyboard, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import type { ShortcutKeySearch } from "./useShortcutKeySearch.js";

interface ShortcutSearchBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  keySearch: ShortcutKeySearch;
  /**
   * The armed state and inline recording are mutually exclusive: cancel any in-progress inline
   * recording before activating key search.
   */
  onArmKeySearch: () => void;
  /** The action area on the right side of the search bar (the "Restore all defaults" button). */
  actions?: ReactNode;
}

/**
 * The search bar of the shortcut settings page: a text search box + a VSCode-style "search by key
 * combination" button.
 */
export function ShortcutSearchBar({
  query,
  onQueryChange,
  keySearch,
  onArmKeySearch,
  actions,
}: ShortcutSearchBarProps) {
  const { intl } = useZCodeIntl();
  // Same display as VSCode: The captured key combination is displayed from the left as the input box text (replacement text search term,
  // Text filters are still in effect internally, × returns to plain text search after clearing).
  const keyLabel =
    keySearch.binding !== null ? formatShortcutBindingLabel(keySearch.binding) : null;

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
        <Input
          className={`pl-9 font-mono ${keyLabel !== null ? "pr-16 text-brand" : "pr-9"}`}
          placeholder={
            keySearch.armed
              ? intl.formatMessage({ id: "settings.shortcuts.keySearchPlaceholder" })
              : intl.formatMessage({ id: "settings.shortcuts.searchPlaceholder" })
          }
          value={keyLabel ?? query}
          onChange={(e) => onQueryChange(e.target.value)}
          // Armed keyboard events are exclusive to window capture; after capture, the combined label is displayed instead of editable text.
          // Both are readOnly to prevent visual ambiguity caused by IME/focus residue
          readOnly={keySearch.armed || keyLabel !== null}
          data-testid="settings-shortcut-search-input"
        />
        {keyLabel !== null ? (
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "settings.shortcuts.keySearchClearAria" })}
            data-testid="settings-shortcut-key-search-clear"
            className="absolute right-9 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-foreground-subtle hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={keySearch.clear}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "settings.shortcuts.keySearchAria" })}
          aria-pressed={keySearch.armed}
          data-testid="settings-shortcut-key-search"
          className={`absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-offset-2 ${
            keySearch.armed ? "text-brand" : "text-foreground-subtle hover:text-foreground"
          }`}
          onClick={() => {
            if (!keySearch.armed) {
              onArmKeySearch();
            }
            keySearch.toggle();
          }}
        >
          <Keyboard className="size-4" />
        </button>
      </div>
      {actions}
    </div>
  );
}
