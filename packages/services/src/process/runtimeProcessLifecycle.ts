import type { ZCodeProcessDiagnostic } from "@zcode/shared/process-diagnostic";

export interface RuntimeProcessSpawnEvent {
  /** Process swim lane (such as mcp-status); the default is the chat main swim lane. Multi-lane processes with the same cwd and the same command rely on it to attribute. */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  command: string;
  args: string[];
  startedAt: number;
  runtimeGeneration: number;
  runtimeInstanceId: string;
}

export interface RuntimeProcessReadyEvent {
  /** Process swim lane (such as mcp-status); the default is the chat main swim lane. Multi-lane processes with the same cwd and the same command rely on it to attribute. */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  readyAt: number;
  startupDurationMs: number;
  runtimeGeneration: number;
  runtimeInstanceId: string;
}

export interface RuntimeProcessExitEvent {
  /** Process swim lane (such as mcp-status); the default is the chat main swim lane. Multi-lane processes with the same cwd and the same command rely on it to attribute. */
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  endedAt: number;
  terminationKind: "expected" | "unexpected" | "watchdog_recycle";
  terminationReason?: string;
  runtimeReady: boolean;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  uptimeMs: number;
  stderrLineCount: number;
  stderrTail?: string[];
}

export interface RuntimeProcessErrorEvent {
  /** Process swim lane (such as mcp-status); the default is the chat main swim lane. Multi-lane processes with the same cwd and the same command rely on it to attribute. */
  lane?: string;
  pid: number | null;
  provider: string;
  workspacePath: string;
  command: string;
  args: string[];
  errorName: string;
  errorCode?: string;
  errorMessage: string;
  errorStack?: string;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  occurredAt: number;
}

export interface RuntimeProcessLifecycleReporter {
  onSpawn(event: RuntimeProcessSpawnEvent): void;
  onReady?(event: RuntimeProcessReadyEvent): void;
  onExit(event: RuntimeProcessExitEvent): void;
  onError?(event: RuntimeProcessErrorEvent): void;
  onException?(event: RuntimeProcessExceptionEvent): void;
}

export interface RuntimeProcessExceptionEvent {
  lane?: string;
  pid: number;
  provider: string;
  workspacePath: string;
  runtimeGeneration: number;
  runtimeInstanceId: string;
  diagnostic: ZCodeProcessDiagnostic;
}

export interface RuntimeTaskCountChangedEvent {
  runningTaskCount: number;
}

export interface RuntimeTaskReporter {
  onRunningTaskCountChanged(event: RuntimeTaskCountChangedEvent): void;
}
