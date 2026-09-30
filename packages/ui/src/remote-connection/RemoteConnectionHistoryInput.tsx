import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/components/ui/command.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside } from "@/remote-connection/remoteConnectionHistoryPopover.js";

function matchesSuggestion(value: string, query: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return normalizedValue.includes(normalizedQuery);
}

export function RemoteConnectionHistoryInput({
  containerClassName,
  suggestionWidth,
  label,
  placeholder,
  value,
  suggestions,
  emptyText,
  onChange,
  ...inputProps
}: {
  containerClassName?: string;
  suggestionWidth?: string;
  label?: string;
  placeholder: string;
  value: string;
  suggestions: string[];
  emptyText: string;
  onChange: (value: string) => void;
} & Omit<
  ComponentProps<typeof Input>,
  "children" | "onChange" | "placeholder" | "size" | "value"
>) {
  const [open, setOpen] = useState(false);
  const [filterWithCurrentValue, setFilterWithCurrentValue] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keepInputFocusOnOpenRef = useRef(false);
  const suppressOpenUntilRef = useRef(0);
  const skipNextBlurRef = useRef(false);

  const filteredSuggestions = useMemo(() => {
    if (!filterWithCurrentValue) {
      return suggestions;
    }

    return suggestions.filter((item) => matchesSuggestion(item, value));
  }, [filterWithCurrentValue, suggestions, value]);

  const requestOpenFromInput = useCallback(
    (options?: { resetFilter?: boolean }) => {
      if (Date.now() < suppressOpenUntilRef.current || suggestions.length === 0) {
        return;
      }

      if (options?.resetFilter !== false) {
        setFilterWithCurrentValue(false);
      }

      keepInputFocusOnOpenRef.current = true;
      setOpen(true);
    },
    [suggestions.length],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      return;
    }

    keepInputFocusOnOpenRef.current = false;
    setFilterWithCurrentValue(false);
    if (skipNextBlurRef.current) {
      skipNextBlurRef.current = false;
    }
  }, []);

  return (
    <div ref={containerRef} className={cn("w-full", containerClassName)}>
      {label ? (
        <label className="mb-1 block text-ui-base text-foreground-subtle">{label}</label>
      ) : null}
      <Popover open={open && suggestions.length > 0} onOpenChange={handleOpenChange}>
        <PopoverAnchor asChild>
          <Input
            ref={inputRef}
            size="lg"
            placeholder={placeholder}
            value={value}
            onFocus={() => requestOpenFromInput()}
            onClick={() => requestOpenFromInput()}
            onChange={(event) => {
              onChange(event.target.value);
              setFilterWithCurrentValue(true);
              requestOpenFromInput({ resetFilter: false });
            }}
            autoComplete="off"
            {...inputProps}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-menu p-1 shadow-lg"
          style={{
            width: suggestionWidth ?? "var(--radix-popover-trigger-width)",
          }}
          onInteractOutside={(event) => {
            const targetNode = event.target;
            if (
              shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside({
                isTargetInsideContainer:
                  targetNode instanceof Node && containerRef.current?.contains(targetNode) === true,
              })
            ) {
              // The first time the mouse clicks on the input box, focus will be triggered to open the suggestion list.
              // The same subsequent click will be regarded as an "out-of-content click" by Popover and will be closed immediately.
              // Here, interactions from the current input box container are excluded to avoid the first focus flashing twice in a row.
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => {
            // Popover will grab the focus within the pop-up layer by default. Once the input box is out of focus, the user will not be able to continue input filtering while viewing the history.
            // Here, the automatic focus is intercepted when "opened by the input box" and the focus is left in the input box, ensuring that both focus display and continuous input are established.
            if (!keepInputFocusOnOpenRef.current) {
              return;
            }

            event.preventDefault();
            inputRef.current?.focus();
            keepInputFocusOnOpenRef.current = false;
          }}
        >
          <Command className="rounded-lg bg-transparent p-0 text-foreground">
            <CommandList className="max-h-56 scroll-py-1">
              {filteredSuggestions.length === 0 ? (
                <CommandEmpty className="px-3 py-5 text-ui-base text-foreground-subtle">
                  {emptyText}
                </CommandEmpty>
              ) : (
                filteredSuggestions.map((item) => (
                  <CommandItem
                    key={item}
                    value={item}
                    className="min-h-8 rounded-lg px-3 py-1.5 text-ui-base text-foreground data-selected:bg-menu-hover data-selected:text-foreground"
                    onPointerDown={() => {
                      skipNextBlurRef.current = true;
                    }}
                    onSelect={(selected) => {
                      onChange(selected);
                      setFilterWithCurrentValue(false);
                      // After selecting the historical item, the click/focus of the input will be replayed immediately, and the pop-up layer will appear "Just close and then reopen".
                      // Here, a short suppression window is used to shield this incident to avoid interaction jitter.
                      suppressOpenUntilRef.current = Date.now() + 120;
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{item}</span>
                  </CommandItem>
                ))
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
