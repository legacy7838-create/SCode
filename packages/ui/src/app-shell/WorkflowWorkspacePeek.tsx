// ============================================================
// The tail of the command output
// ============================================================
// The last three lines of stdout are exposed under the folded Terminal card. You can know what the command says without clicking on it. The text is stuck when scrolling into the viewport
// Just fetch (IntersectionObserver, 200 px in advance), and when fetched, it will be put into the same cache - and then expanded and no longer read. No
// The IntersectionObserver's environment (jsdom) is made immediately visible.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useWorkflowRunNodeResult } from "@/hooks/useWorkflowRunNodeResult.js";
import { peekLinesOf } from "@/app-shell/workflowWorkspaceLogbook.js";

export const WorkspacePeek = memo(function WorkspacePeek({
  node,
  runId,
  sessionId,
}: {
  node: WorkflowRunWorkspaceNode;
  runId: string;
  sessionId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || ref.current === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  const { result } = useWorkflowRunNodeResult({
    sessionId,
    runId,
    siteId: node.siteId,
    ordinal: node.ordinal,
    enabled: visible && node.status === "completed",
  });
  const lines = useMemo(
    () => (result?.result === undefined ? [] : peekLinesOf(result.result)),
    [result],
  );

  // The empty state is a zero-height sentinel: the IntersectionObserver needs something to observe.
  return (
    <div
      className={cn(
        lines.length === 0
          ? "h-0 overflow-hidden"
          : "wf-ws-peek mt-1 overflow-hidden whitespace-pre rounded-[7px] bg-panel px-2.5 py-[7px] font-mono text-ui-sm leading-[17px] text-foreground-subtle",
      )}
      data-testid="workflow-workspace-peek"
      data-ws-body
      ref={ref}
    >
      {lines.map((line, index) => (
        <span className={cn("block", line.error && "text-destructive")} key={index}>
          {line.text}
        </span>
      ))}
    </div>
  );
});
