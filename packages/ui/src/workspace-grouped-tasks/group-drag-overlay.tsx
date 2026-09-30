import type { CSSProperties } from "react";
import type { ZCodeGroupedTaskViewNode } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TaskGroupColorMark } from "@/workspace-grouped-tasks/colors.js";
import { getTaskGroupDisplayTitle } from "@/workspace-grouped-tasks/group-title.js";

type GroupNode = Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;

function GroupDragOverlay({
  node,
  className,
  style,
}: {
  node: GroupNode;
  className?: string;
  style?: CSSProperties;
}) {
  const { intl } = useZCodeIntl();
  // cron uses the `cron` placeholder name in the storage layer; dragging the floating layer has bypassed the localization logic of ordinary headers.
  // Causes internal values to flash back from the "Cron Task" when dragging. The three headers use the same header formatting entry.
  const displayTitle = getTaskGroupDisplayTitle(node.group, {
    cron: intl.formatMessage({ id: "taskGroup.cronGroupName" }),
    offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" }),
  });

  return (
    <div className={className} style={style}>
      <div className="pointer-events-none flex h-8 cursor-grabbing items-center gap-1 rounded-lg border border-border bg-background pl-1.5 pr-1 text-ui-base text-foreground shadow-lg">
        <TaskGroupColorMark color={node.group.color} />
        <span className="min-w-0 flex-1 truncate px-1">{displayTitle}</span>
        <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm font-medium leading-none text-foreground-subtle">
          {node.tasks.length}
        </span>
      </div>
    </div>
  );
}

export { GroupDragOverlay };
