// 遥测 egress 已下线：本模块保留调用点所需的签名，但不再产生任何 OTLP/trace span。
// runUserAction/startUserAction 变为直接执行 operation 的透传，handle 方法为 no-op。
export type UserActionTrigger =
  | "button"
  | "keyboard"
  | "shortcut"
  | "menu"
  | "switch"
  | "select"
  | "drag";

export interface UserActionResult {
  resultSource?: string;
  failureStage?: string;
  [key: string]: unknown;
}

export interface UserActionHandle {
  complete(result?: UserActionResult): void;
  fail(failure?: UserActionResult): void;
  reject(result?: UserActionResult): void;
  cancel(): void;
  noop(): void;
}

const NOOP_HANDLE: UserActionHandle = {
  complete: () => {},
  fail: () => {},
  reject: () => {},
  cancel: () => {},
  noop: () => {},
};

export function startUserAction(_input: unknown): UserActionHandle {
  return NOOP_HANDLE;
}

export function runUserAction<T>(options: {
  input: unknown;
  operation: () => T;
  completed?: unknown;
  failureStage: string;
}): T {
  return options.operation();
}

export async function runUserActionAsync<T>(options: {
  input: unknown;
  operation: () => Promise<T>;
  completed?: unknown;
  failureStage: string;
}): Promise<T> {
  return await options.operation();
}
