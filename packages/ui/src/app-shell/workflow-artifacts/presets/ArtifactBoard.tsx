/**
 * The `board` preset renderer: a wall of cards split into columns by `status`, with cards upserted
 * by `key`.
 *
 * Two shapes:
 * - `compact`: the **per-column counts** in the run side pane card (at a glance “3 of the 12 have
 *   not passed yet”);
 * - full size: the columns + cards inside the `workflow-artifact` tab.
 *
 * **No drag and drop**: this is a read-only projection of the journal, and a card's position is
 * decided by the status the script `report`s; letting users drag it would conjure a “who is the
 * authority” problem out of nothing (v1 explicitly does not do interactive filtering / sorting).
 */

import { memo, useMemo } from "react";
import {
  applyArtifactItems,
  type ArtifactItem,
  type BoardCardModel,
  type BoardColumnModel,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  PresetEmpty,
  PresetHeading,
  REVEAL_ANIMATION_CLASS,
  type PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { BoardSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";

function columnLabel(column: BoardColumnModel, labels: PresetLabels): string {
  return column.other ? labels.otherColumn : column.id;
}

function BoardCard({ card }: { card: BoardCardModel }) {
  return (
    // key is the card id (stable), so only new cards play the reveal animation; state changes allow cards to be swapped, but not replayed.
    <div
      className={cn(
        "rounded-lg border border-card-border bg-card px-2 py-1.5",
        REVEAL_ANIMATION_CLASS,
      )}
      data-card-id={card.id}
      data-testid="artifact-board-card"
    >
      <div className="truncate text-ui-sm font-medium text-foreground" title={card.title}>
        {card.title}
      </div>
      {card.details.length > 0 ? (
        <dl className="mt-1 space-y-0.5">
          {card.details.map((detail) => (
            <div className="flex min-w-0 items-baseline gap-1.5" key={detail.label}>
              <dt className="shrink-0 text-ui-xs text-foreground-subtlest">{detail.label}</dt>
              <dd
                className="min-w-0 flex-1 truncate text-right font-mono text-ui-xs text-foreground-subtle"
                title={detail.value}
              >
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export const ArtifactBoard = memo(function ArtifactBoard({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: BoardSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  const model = useMemo(() => applyArtifactItems("board", spec, items), [spec, items]);

  if (model.cardCount === 0) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  if (compact) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)} data-testid="artifact-board-compact">
        {model.columns.map((column) => (
          <span
            className="flex min-w-0 items-baseline gap-1 rounded-md bg-surface px-1.5 py-0.5"
            data-column-id={column.id}
            data-testid="artifact-board-column-count"
            key={column.id}
          >
            <span className="truncate text-ui-xs text-foreground-subtle">
              {columnLabel(column, labels)}
            </span>
            <span className="shrink-0 font-mono text-ui-xs text-foreground tabular-nums">
              {column.cards.length}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-board">
      <PresetHeading
        className="mb-3"
        description={spec.description}
        title={spec.title}
        trailing={
          <span className="font-mono text-ui-xs text-foreground-subtlest tabular-nums">
            {labels.itemsCount(model.cardCount)}
          </span>
        }
      />
      {/* Columns scroll horizontally inside their own container; in a narrow panel the component identity still does not change, it just takes a swipe. */}
      <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
        {model.columns.map((column) => (
          <section
            className="flex w-44 shrink-0 flex-col gap-1.5 rounded-lg bg-surface p-2"
            data-column-id={column.id}
            data-testid="artifact-board-column"
            key={column.id}
          >
            <header className="flex items-baseline justify-between gap-2">
              <h4
                className="min-w-0 truncate text-ui-sm font-medium text-foreground"
                title={columnLabel(column, labels)}
              >
                {columnLabel(column, labels)}
              </h4>
              <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest tabular-nums">
                {column.cards.length}
              </span>
            </header>
            {column.cards.map((card) => (
              <BoardCard card={card} key={card.id} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
});
