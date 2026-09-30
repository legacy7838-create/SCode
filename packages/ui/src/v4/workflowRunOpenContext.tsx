// The entrance to the sidebar run line "Click → Select Session + Open Run Pane". The same jump as the composer logo, determined by WorkspaceShellLayout;
// Use context instead of layer-by-layer props: Run lines are in five types of task lines (default/timeline/top/archive/group).
// When there is no provider (mobile phone remote control home page, single test), the running line is just text, not a button.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { SessionWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";

export interface WorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  run: SessionWorkflowRunSummary;
}

type WorkflowRunOpenHandler = (target: WorkflowRunOpenTarget) => void;

const WorkflowRunOpenContext = createContext<WorkflowRunOpenHandler | null>(null);

export function WorkflowRunOpenProvider({
  onOpenRun,
  children,
}: {
  onOpenRun: WorkflowRunOpenHandler;
  children: ReactNode;
}) {
  const handlerRef = useRef(onOpenRun);
  handlerRef.current = onOpenRun;
  const stable = useMemo<WorkflowRunOpenHandler>(() => (target) => handlerRef.current(target), []);
  return (
    <WorkflowRunOpenContext.Provider value={stable}>{children}</WorkflowRunOpenContext.Provider>
  );
}

export function useWorkflowRunOpen(): WorkflowRunOpenHandler | null {
  return useContext(WorkflowRunOpenContext);
}
