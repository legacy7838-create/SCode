// ============================================================
// Automation Port - scheduled task management boundary
// ============================================================

import type {
  CronAutomation,
  CronCreateInput,
  CronDeleteInput,
  CronUpdateInput,
} from "../tools/automation.js";

export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AutomationCreateLimitError";
    this.cause = cause;
  }
}

export function isAutomationCreateLimitError(error: unknown): error is AutomationCreateLimitError {
  if (error instanceof AutomationCreateLimitError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === AUTOMATION_CREATE_LIMIT_ERROR_CODE ||
    (typeof candidate.message === "string" &&
      candidate.message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE))
  );
}

export interface AutomationCreateContext {
  /** The model of the runtime where the current tool is called is injected by the executor and does not come from model input. */
  model?: string;
  /** The session in which the current tool is called; subsequent cron triggers within the session will reuse the session. */
  sessionId?: string;
}

export interface AutomationPort {
  create(input: CronCreateInput, context?: AutomationCreateContext): Promise<CronAutomation>;
  update(input: CronUpdateInput): Promise<CronAutomation>;
  list(): Promise<CronAutomation[]>;
  delete(input: CronDeleteInput): Promise<boolean>;
}
