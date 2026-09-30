// ============================================================
// An entry for script transcript
// ============================================================
// One line of the log book: 28px category tiles on the left (red for failure, amber for run), two lines in the middle - verb + object, then
// Result line (`exit 1` red, `41 files`, time consumption, bytes, replayed chip) - time scale on the right (`+1:12`, running
// say now). The output tail (peek) is exposed under the collapsed command; the expanded panel is the complete panel. Read only summary line, file chip is on
// The code viewer looks at the file **now**. The status is based on journal, and live projection only stacks `cached`.

import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ChevronRightIcon,
  FileIcon,
  GitBranchIcon,
  SearchIcon,
  SquareTerminalIcon,
  TerminalIcon,
} from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { ReadFileChip, type ReadSummary } from "@/ToolCallBlocks/renderers/read.js";
import { WorkspaceCardBody } from "@/app-shell/WorkflowWorkspaceCardBody.js";
import { WorkspacePeek } from "@/app-shell/WorkflowWorkspacePeek.js";
import {
  formatAgo,
  formatOffset,
  rememberedOpen,
  setRememberedOpen,
} from "@/app-shell/workflowWorkspaceLogbook.js";
import {
  formatWorkspaceBytes,
  formatWorkspaceDuration,
  isTimeoutError,
  workspaceCardStatus,
  type WorkspaceCardModel,
} from "@/app-shell/workflowWorkspaceTranscript.js";

const KIND_ICON = {
  read: <FileIcon className="size-3.5" />,
  search: <SearchIcon className="size-3.5" />,
  git: <GitBranchIcon className="size-3.5" />,
  terminal: <SquareTerminalIcon className="size-3.5" />,
  step: <TerminalIcon className="size-3.5" />,
} as const;

const CODE_CLASS = "truncate font-mono text-[12.5px] text-foreground";

interface WorkflowWorkspaceCardProps {
  card: WorkspaceCardModel;
  sessionId: string;
  runId: string;
  run: WorkflowRunState | undefined;
  /** The zero point of the time scale (the admission time of the first card); absent means no time is drawn. */
  origin: number | undefined;
  /** Current moment (running card advances per second). */
  now: number;
  /** Arrival is offset (24 ms per frame, capped on panel side); absence is immediate. */
  enterDelayMs?: number;
  /** Place the card on it: once it is in place, the background color will light up. */
  landed?: boolean;
  /** Workspace root: The relative path of the Read card is filled in with the absolute path and then handed over to the code viewer. */
  workspacePath: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

function readSummaryOf(path: string, workspacePath: string): ReadSummary {
  const absolute =
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${workspacePath}/${path}`;
  const descriptor = resolveFileDisplayDescriptor(absolute);
  return {
    path: absolute,
    fileName: descriptor.fileName,
    filePath: descriptor.filePath,
    fileIconSrc: descriptor.fileIconSrc,
    entryType: "file",
  };
}

/** Place a small dot between the parts of the resulting row. */
function joined(parts: readonly ReactNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (part === null || part === undefined) return;
    if (out.length > 0) {
      out.push(
        <span
          aria-hidden
          className="size-[3px] shrink-0 rounded-full bg-foreground-subtlest opacity-70"
          key={`sep-${index}`}
        />,
      );
    }
    out.push(<span key={index}>{part}</span>);
  });
  return out;
}

export const WorkflowWorkspaceCard = memo(function WorkflowWorkspaceCard({
  card,
  enterDelayMs,
  landed = false,
  now,
  onOpenCodeViewer,
  origin,
  run,
  runId,
  sessionId,
  workspacePath,
}: WorkflowWorkspaceCardProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const { node, kind } = card;
  const { status, replayed } = workspaceCardStatus(node, run);
  const isRunning = status === "running";
  const exitCode = node.summary?.exitCode;
  const failed = status === "failed" || (exitCode !== undefined && exitCode !== 0);
  const durationMs = Math.max(0, node.updatedAt - node.createdAt);

  // Read only has the summary line; the rest can be expanded (the running command can also be expanded to see the command line). Press the card to remember in the expanded state.
  const expandable = kind !== "read";
  const persistKey = `${sessionId}:${runId}:${card.key}`;
  const [open, setOpen] = useState(() => rememberedOpen(persistKey));
  const toggle = useCallback(() => {
    setOpen((previous) => {
      setRememberedOpen(persistKey, !previous);
      return !previous;
    });
  }, [persistKey]);
  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // The text and clicks in peek (text selection, copy, file chip) are not collapsed.
      if ((event.target as HTMLElement).closest("[data-ws-body],button,a") !== null) return;
      toggle();
    },
    [toggle],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  const readSummary = useMemo(
    () => (kind === "read" ? readSummaryOf(card.primary, workspacePath) : null),
    [card.primary, kind, workspacePath],
  );
  const openRead = useCallback(() => {
    if (readSummary === null || onOpenCodeViewer === undefined) return;
    onOpenCodeViewer({ type: "file", title: readSummary.fileName, path: readSummary.path });
  }, [onOpenCodeViewer, readSummary]);

  // First line: verb + object.
  const verb =
    kind === "read"
      ? format({ id: "chat.toolCall.workflow.script.verb.read" })
      : kind === "search"
        ? format({ id: "chat.toolCall.workflow.script.verb.searched" })
        : kind === "git"
          ? "git"
          : kind === "terminal"
            ? format({
                id: isRunning ? "chat.toolCall.execute.running" : "chat.toolCall.execute.ran",
              })
            : format({ id: "chat.toolCall.workflow.script.kind.step" });
  const object: ReactNode =
    kind === "read" && readSummary !== null ? (
      <span className="inline-flex h-5 min-w-0 max-w-full items-center rounded-[5px] border border-border bg-card px-1.5 text-ui-sm [&_button]:text-foreground [&_span]:text-foreground">
        <ReadFileChip
          summary={readSummary}
          clickable={onOpenCodeViewer !== undefined}
          onClick={openRead}
        />
      </span>
    ) : kind === "search" ? (
      <span className="flex min-w-0 items-baseline gap-1.5 truncate">
        <code className={CODE_CLASS}>{card.primary}</code>
        {card.secondary === undefined ? null : (
          <>
            <span className="text-foreground-subtlest">
              {format({ id: "chat.toolCall.workflow.script.search.in" })}
            </span>
            <code className={CODE_CLASS}>{card.secondary}</code>
          </>
        )}
      </span>
    ) : kind === "git" ? (
      <code className={CODE_CLASS}>{card.primary.replace(/^git /, "")}</code>
    ) : kind === "terminal" ? (
      <code className={CODE_CLASS}>{card.command ?? card.primary}</code>
    ) : (
      <span className="truncate text-foreground">{card.primary}</span>
    );

  // Second row: results. When the status word changes value, a new word comes into play.
  const statusWord =
    status === "failed"
      ? isTimeoutError(node.error)
        ? format({ id: "chat.toolCall.workflow.script.status.timedOut" })
        : (node.error?.code ?? format({ id: "chat.toolCall.workflow.graph.status.failed" }))
      : exitCode !== undefined
        ? format({ id: "chat.toolCall.workflow.script.status.exit" }, { code: String(exitCode) })
        : undefined;
  const statusNode =
    statusWord === undefined ? null : (
      <span
        className={cn("wf-swap font-semibold", failed ? "text-destructive" : "text-success")}
        data-failed={failed ? "true" : undefined}
        data-testid="workflow-workspace-status"
        key={statusWord}
        title={
          status === "failed"
            ? (node.error?.message ?? node.error?.code)
            : failed
              ? card.command
              : undefined
        }
      >
        {statusWord}
      </span>
    );
  const replayedNode = replayed ? (
    <span
      className="inline-flex h-4 items-center rounded-[4px] border border-dashed border-border px-1 text-[10.5px] leading-none text-foreground-subtlest"
      data-testid="workflow-workspace-replayed"
      title={format({ id: "chat.toolCall.workflow.script.status.replayedHint" })}
    >
      {format({ id: "chat.toolCall.workflow.script.status.replayed" })}
    </span>
  ) : null;
  const bytes = node.summary?.resultBytes;
  const count = node.summary?.resultCount;
  const countNode =
    count === undefined ? null : (
      <b className="font-medium text-foreground-subtle">
        {format(
          {
            id:
              card.op === "grep"
                ? "chat.toolCall.workflow.script.result.matches"
                : "chat.toolCall.workflow.script.result.files",
          },
          { count: String(count) },
        )}
      </b>
    );
  const resultParts: ReactNode[] = isRunning
    ? [
        format(
          { id: "chat.toolCall.workflow.script.startedAgo" },
          { ago: formatAgo(now - node.createdAt) },
        ),
      ]
    : status === "failed"
      ? [statusNode, formatWorkspaceDuration(durationMs)]
      : kind === "read"
        ? [
            <span className="truncate font-mono" key="path">
              {card.primary}
            </span>,
            bytes === undefined ? null : formatWorkspaceBytes(bytes),
            replayedNode,
          ]
        : kind === "search"
          ? [countNode, formatWorkspaceDuration(durationMs), replayedNode]
          : kind === "terminal"
            ? [
                statusNode,
                formatWorkspaceDuration(durationMs),
                formatWorkspaceBytes(node.summary?.stdoutBytes ?? bytes ?? 0),
                replayedNode,
              ]
            : [
                countNode,
                bytes === undefined ? null : formatWorkspaceBytes(bytes),
                formatWorkspaceDuration(durationMs),
                replayedNode,
              ];
  if (node.inputTruncated) {
    resultParts.push(
      <span title={format({ id: "chat.toolCall.workflow.script.args.truncated" })}>…</span>,
    );
  }

  const style: CSSProperties =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? {}
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div
      aria-expanded={expandable ? open : undefined}
      className={cn(
        "wf-ws-entry wf-arrive group/ws grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-[9px] px-2 pb-2.5 pt-[9px] outline-none",
        expandable &&
          "cursor-pointer hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40",
        landed && "wf-ws-landed",
      )}
      data-card-key={card.key}
      data-open={open ? "true" : undefined}
      data-ordinal={node.ordinal}
      data-phase-id={card.phase?.id}
      data-site-id={node.siteId}
      data-status={status}
      data-testid="workflow-workspace-card"
      onClick={expandable ? onClick : undefined}
      onKeyDown={expandable ? onKeyDown : undefined}
      role={expandable ? "button" : undefined}
      style={style}
      tabIndex={expandable ? 0 : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "mt-px flex size-7 items-center justify-center rounded-[7px] bg-surface text-foreground-subtle transition-colors",
          failed &&
            "bg-[color-mix(in_oklab,var(--color-destructive)_10%,transparent)] text-destructive",
          isRunning && "bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] text-warning",
        )}
      >
        {KIND_ICON[kind]}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-1.5 text-ui-base leading-[18px]">
          <span
            className={cn(
              "shrink-0 font-medium text-foreground-subtle",
              isRunning && "wf-ws-shine",
            )}
          >
            {verb}
          </span>
          {object}
          {expandable ? (
            <ChevronRightIcon
              className={cn(
                "ml-0.5 size-3.5 shrink-0 self-center text-foreground-subtlest opacity-0 transition-[opacity,transform] duration-[160ms] group-hover/ws:opacity-100 group-focus-visible/ws:opacity-100",
                open && "rotate-90 opacity-100",
              )}
            />
          ) : null}
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5 text-ui-sm leading-4 text-foreground-subtlest"
          data-testid="workflow-workspace-result"
        >
          {joined(resultParts)}
        </div>
        {kind === "terminal" && !open && status === "completed" ? (
          <WorkspacePeek node={node} runId={runId} sessionId={sessionId} />
        ) : null}
        {expandable && open ? (
          <WorkspaceCardBody card={card} runId={runId} sessionId={sessionId} />
        ) : null}
      </div>
      <span
        className="flex items-center gap-1.5 whitespace-nowrap font-mono text-ui-xs leading-[18px] tabular-nums text-foreground-subtlest"
        data-testid="workflow-workspace-when"
      >
        {isRunning ? (
          <>
            <span aria-hidden className="wf-lamp-running size-1.5 rounded-full bg-warning" />
            {format({ id: "chat.toolCall.workflow.script.now" })}
          </>
        ) : origin === undefined ? null : (
          formatOffset(node.createdAt - origin)
        )}
      </span>
    </div>
  );
});
