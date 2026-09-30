"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent } from "@/components/ui/popover.js";
import { Textarea } from "@/components/ui/textarea.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

interface PptxSelectionActionBarProps {
  children: ReactNode;
  open: boolean;
  boundary: HTMLElement | null;
  label: string;
  commentPlaceholder: string;
  cancelLabel: string;
  addToConversationLabel: string;
  editing: boolean;
  disabled: boolean;
  onAiEdit: () => void;
  onCancelAiEdit: () => void;
  onAddToConversation: (comment: string) => void;
  onExitSelection: () => void;
}

/**
 * The app-level action bar for selecting PPTX elements.
 *
 * The anchor still lives inside the slide transform container while the content renders through a
 * Popover Portal; that way it can read the real, post-scale DOMRect without letting the button
 * sizes scale with the slide or get clipped by page overflow.
 */
export function PptxSelectionActionBar({
  children,
  open,
  boundary,
  label,
  commentPlaceholder,
  cancelLabel,
  addToConversationLabel,
  editing,
  disabled,
  onAiEdit,
  onCancelAiEdit,
  onAddToConversation,
  onExitSelection,
}: PptxSelectionActionBarProps) {
  const [comment, setComment] = useState("");
  const compositionActiveRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setComment("");
      compositionActiveRef.current = false;
    }
  }, [editing]);

  return (
    <Popover open={open} modal={false}>
      {children}
      <PopoverContent
        role="toolbar"
        aria-label={label}
        side="top"
        align="center"
        sideOffset={8}
        collisionBoundary={boundary}
        collisionPadding={8}
        sticky="partial"
        hideWhenDetached
        updatePositionStrategy="always"
        className={
          editing
            ? "w-80 max-w-[calc(100vw-1rem)] gap-0 border-popover-border p-1"
            : "w-auto max-w-[calc(100vw-1rem)] gap-0 border-popover-border p-1"
        }
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (editing) {
            if (
              isImeComposingKeyEvent({
                compositionActive: compositionActiveRef.current,
                isComposing: event.isComposing,
              })
            ) {
              // Esc under the Chinese/Japanese input method cancels the candidate word, not abandons the comment.
              // At the same time, the local composition status is read to prevent the platform event timing from making isComposing false early.
              return;
            }
            // Esc is synonymous with "cancel": just discard this draft comment and return to the AI ​​editing bar, without exiting the element selection.
            onCancelAiEdit();
            return;
          }
          onExitSelection();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {editing ? (
          <div className="flex flex-col gap-2 p-1">
            <Textarea
              autoFocus
              aria-label={commentPlaceholder}
              placeholder={commentPlaceholder}
              value={comment}
              disabled={disabled}
              rows={3}
              className="min-h-16 resize-none border-input-border bg-input text-mobile-input-safe placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
              onChange={(event) => setComment(event.target.value)}
              onCompositionStart={() => {
                compositionActiveRef.current = true;
              }}
              onCompositionEnd={() => {
                compositionActiveRef.current = false;
              }}
            />
            <div className="flex items-center justify-end gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={onCancelAiEdit}
              >
                {cancelLabel}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={() => onAddToConversation(comment)}
              >
                {addToConversationLabel}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="lg"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            className="w-full justify-start rounded-lg px-2"
            onMouseDown={(event) => {
              // Reason: The browser may clear the PPTX text Selection before the button gets mouse focus; preventing the default mousedown still retains click/keyboard activation.
              event.preventDefault();
            }}
            onClick={onAiEdit}
          >
            <SparklesIcon className="size-4" />
            {label}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
