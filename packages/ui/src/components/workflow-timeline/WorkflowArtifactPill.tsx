import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import type { WorkflowRunArtifactKind } from "@zcode/shared/zcode-protocol-v4";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
  truncateArtifactChipTitle,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Artifact pill: the same grammar as the sub-agent pill — the same height, corner radius,
 * background color, hover lift, and ↗ in the tail slot taking the place of the existing content —
 * with only two things swapped: a **square** ink-gray tile instead of the **round** colored avatar
 * (color says “who”, shape says “what”), and a version number in the tail slot instead of a status
 * marker.
 *
 * ⚠ Terminology: the artifact here is an output that a script publishes for the user to see via
 * `artifact.*`, not the same-named engine-internal term for a “script top-level return value”.
 *
 * Two sizes: `md` (32px) is used where the pill already lived — the artifact bar under the
 * timeline, the hub's “recent artifacts”; `sm` (24px) is used inside a single row — the collapsed
 * header of a completion notification, the hub's run history rows. When an artifact has
 * **somewhere** to live (the completion card, the gallery in the run side panel) a tile is used
 * (`WorkflowArtifactTile`), and its caption line speaks this pill's grammar.
 *
 * Always a `<button>`: an artifact is a “thing that can be opened”, and when the host gives no
 * callback it is a **disabled** button, looking as quiet as a sub-agent pill with no session —
 * “what was delivered” is a fact, “whether it can be opened” is a capability. The version number
 * only appears from v2 onward (in v1 it is the norm, and writing it out is noise); when the same id
 * is republished, the tail slot is remounted per version and plays the marked pop-in animation.
 */
export interface ArtifactPillData {
  id: string;
  kind: WorkflowRunArtifactKind;
  title?: string;
  version?: number;
}

export type ArtifactPillSize = "md" | "sm";

export function WorkflowArtifactPill({
  artifact,
  className,
  detail,
  enterDelayMs,
  fill = false,
  onOpen,
  size = "md",
  testId = "workflow-artifact-pill",
  title,
  truncateTitle = false,
  variant = "pill",
}: {
  variant?: "pill" | "link";
  artifact: ArtifactPillData;
  size?: ArtifactPillSize;
  /**
   * Monospace secondary information after the name and before the tail slot (the sidebar row's `PDF
   * · 1.2 MB` / `12 items`).
   */
  detail?: ReactNode;
  /** Present means openable; absent means disabled (the presence of the callback is the gate). */
  onOpen?: (artifactId: string) => void;
  /**
   * The name fills the remaining width (sidebar rows); when absent, the pill shrinks to its content
   * (the artifact bar under the timeline).
   */
  fill?: boolean;
  /**
   * The title in the bar is truncated to 24 characters (the full title lives in the tooltip);
   * sidebar rows rely on CSS truncate and are not character-truncated.
   */
  truncateTitle?: boolean;
  /** Overrides the tooltip; when absent it is “kind word · title”. */
  title?: string;
  /** Entry delay (in the artifact bar they land one after another, each offset by 30 ms). */
  enterDelayMs?: number;
  testId?: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const fullTitle = artifactDisplayTitle(artifact);
  const label = truncateTitle ? truncateArtifactChipTitle(fullTitle) : fullTitle;
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
  const openable = onOpen !== undefined;
  const version = artifact.version ?? 1;
  const showVersion = version >= 2;
  const versionLabel = intl.formatMessage(
    { id: "chat.toolCall.workflow.run.artifacts.version" },
    { version: String(version) },
  );
  const md = size === "md";
  // Delayed entries have to be filled backwards: the starting frame is kept during the wait (same reason as for subagent pills).
  const style: CSSProperties | undefined =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  // Notification summaries reuse Read link syntax to avoid thick product pills in the toolbar.
  if (variant === "link")
    return (
      <button
        type="button"
        disabled={!openable}
        onClick={openable ? () => onOpen(artifact.id) : undefined}
        data-testid={testId}
        data-artifact-id={artifact.id}
        data-artifact-kind={artifact.kind}
        data-artifact-version={String(version)}
        title={title ?? `${kindLabel} · ${fullTitle}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-ui-base font-normal text-foreground-subtle enabled:cursor-pointer enabled:hover:underline"
      >
        <ArtifactKindIcon className="size-4 shrink-0" kind={artifact.kind} />
        <span className="min-w-0 truncate">{label}</span>
        {showVersion ? (
          <span data-testid="workflow-run-artifact-version">{versionLabel}</span>
        ) : null}
      </button>
    );
  return (
    <button
      aria-label={
        openable
          ? `${intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.open" })}: ${fullTitle}`
          : undefined
      }
      className={cn(
        "wf-pill wf-arrive flex min-w-0 max-w-full items-center bg-surface text-left",
        md
          ? "h-8 gap-2 rounded-[9px] pl-2 pr-2.5 text-ui-sm"
          : "h-6 gap-1.5 rounded-md pl-1.5 pr-2 text-ui-xs",
        openable
          ? "wf-pill-open cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          : "cursor-default",
        fill && "w-full",
        className,
      )}
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
      data-artifact-open={openable ? "true" : undefined}
      data-artifact-version={String(version)}
      data-pill-size={size}
      data-testid={testId}
      disabled={!openable}
      onClick={openable ? () => onOpen(artifact.id) : undefined}
      style={style}
      title={title ?? `${kindLabel} · ${fullTitle}`}
      type="button"
    >
      <ArtifactKindIcon className="size-4 shrink-0 text-foreground-subtle" kind={artifact.kind} />
      <span className={cn("wf-pill-name min-w-0 truncate text-foreground", fill && "flex-1")}>
        {label}
      </span>
      {detail === undefined || detail === null ? null : (
        <span className="flex shrink-0 items-center gap-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {detail}
        </span>
      )}
      {showVersion || openable ? (
        <span
          className={cn(
            "wf-pill-tail grid shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1",
            md ? "size-3.5" : "size-3",
          )}
          data-testid="workflow-pill-tail"
        >
          {showVersion ? (
            // Rehang by version: When re-releasing with the same id, the tail slot will pop in once (the entry of wf-mark), and give way to ↗ when hovering.
            <span
              className="wf-mark font-mono text-ui-xs leading-none tabular-nums text-foreground-subtlest"
              data-testid="workflow-run-artifact-version"
              key={version}
              title={versionLabel}
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.artifacts.versionTail" },
                { version: String(version) },
              )}
            </span>
          ) : null}
          {openable ? (
            <span
              aria-hidden
              className="wf-pill-go flex items-center justify-center text-foreground-subtlest"
              data-testid="workflow-artifact-pill-open"
            >
              <ArrowUpRightIcon className={md ? "size-3.5" : "size-3"} />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
