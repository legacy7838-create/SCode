import type { KeyboardEvent, MouseEvent } from "react";
import { ARTIFACT_CHIP_MAX_VISIBLE } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PILL_STAGGER_MS } from "./WorkflowTimeline.js";
import {
  WorkflowArtifactPill,
  type ArtifactPillData,
  type ArtifactPillSize,
} from "./WorkflowArtifactPill.js";

/**
 * Product strip: one row of product pills, at most three.
 * Fold the rest into `+N` of equal width. Under the timeline (tool card, wheel summary), the folded header of the completion notification, the running history line of the hub and
 * The "Recent Products" bar is all about it - the same product must look the same everywhere. Full inventory is on the run side panel.
 *
 * ⚠ Terminology: artifact = the output of a script published to users via `artifact.*`.
 *
 * The event only stops for **Pill**: the bar often sits in other clickable areas (the folding switch of the notification line, the tail of the wheel
 * summary of the entire switch, the hub's history row), the pill is a button and not part of that area - **Including disabled ones**: Disabled
 * Just make opening a no-op, and you should not click on the outside part by the way (the browser does not send clicks to disabled controls, jsdom will send them to ancestors;
 * Both sides are consistent here). Bars with white space and `+N` are part of that area: clicking on them bubbles up to the host, and the tail summary is switched accordingly.
 */
function hitsPill(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

export function WorkflowArtifactStrip({
  artifacts,
  className,
  moreTestId,
  onOpenArtifact,
  pillTestId,
  size = "md",
  testId,
  truncated = false,
  variant = "pill",
}: {
  variant?: "pill" | "link";
  artifacts: readonly ArtifactPillData[];
  size?: ArtifactPillSize;
  /** Absence means the pill is all disabled (presence of the callback means gating). */
  onOpenArtifact?: (artifactId: string) => void;
  /** Emitting side chopped (over the upper bound or filtered) - `+N` so may be underreported, use `…` instead of a number. */
  truncated?: boolean;
  testId?: string;
  pillTestId?: string;
  moreTestId?: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  if (artifacts.length === 0) return null;
  const visible = artifacts.slice(0, ARTIFACT_CHIP_MAX_VISIBLE);
  const overflow = artifacts.length - visible.length;
  return (
    <span
      className={cn(
        "wf-motion flex min-w-0 shrink flex-wrap items-center",
        size === "md" ? "gap-1.5" : "gap-1",
        className,
      )}
      data-testid={testId}
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        if (hitsPill(event.target)) event.stopPropagation();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (hitsPill(event.target)) event.stopPropagation();
      }}
    >
      {visible.map((artifact, i) => (
        <WorkflowArtifactPill
          artifact={artifact}
          variant={variant}
          enterDelayMs={PILL_STAGGER_MS * i}
          key={artifact.id}
          size={size}
          truncateTitle
          {...(pillTestId === undefined ? {} : { testId: pillTestId })}
          {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
        />
      ))}
      {overflow > 0 || truncated ? (
        <span
          className="shrink-0 px-0.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid={moreTestId}
        >
          {intl.formatMessage(
            { id: "chat.backgroundResult.workflow.artifacts.more" },
            { count: truncated && overflow === 0 ? "…" : String(overflow) },
          )}
        </span>
      ) : null}
    </span>
  );
}
