import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  databaseStartupErrorCodeSchema,
  databaseMigrationFactsSchema,
  type DatabaseMigrationFacts,
  databaseStartupErrorDetailsSchema,
  zcodeStoragePreparationFrameSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { resolveDefaultZCodeAgentCommand } from "@zcode/services/storage-startup";
import { createServiceLogger } from "@zcode/services/node";

const storagePreparationLogger = createServiceLogger("desktop-host-storage-prep");

/** 保留的子进程 stderr 行数上限。够解释一次崩溃，又不会无限增长。 */
const STDERR_TAIL_LINES = 40;
/** 单行最大字符数，避免一条超长堆栈把日志撑爆。 */
const STDERR_LINE_MAX_CHARS = 2000;

/**
 * 有界 stderr tail。
 *
 * 存在的唯一理由：`child.stderr.resume()` 会把子进程崩溃的真实原因丢掉。没有它，
 * 一次存储准备失败在 Host 侧只表现为一个 `open_failed` 符号，定位不到具体原因 ——
 * 与 Rust 侧 `Stdio::null()` 是同一类缺陷。
 *
 * 仍然**不**把这些文本写进 startupState 或 IPC（可能包含本地路径），只进本地 debug 日志。
 *
 * @returns Appender that keeps only the most recent {@link STDERR_TAIL_LINES} truncated lines.
 */
function createBoundedStderrTail(): { push: (chunk: string) => void; snapshot: () => string[] } {
  const lines: string[] = [];
  return {
    push(chunk) {
      for (const raw of chunk.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const bounded =
          line.length > STDERR_LINE_MAX_CHARS
            ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}…[truncated]`
            : line;
        lines.push(bounded);
        if (lines.length > STDERR_TAIL_LINES) lines.shift();
      }
    },
    snapshot: () => [...lines],
  };
}

type Phase = NonNullable<DatabaseStartupState["databasePhase"]>;
const workerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      migration: databaseMigrationFactsSchema.optional(),
      phase: z.enum([
        "checking",
        "waiting_for_lock",
        "migrating",
        "committing",
        "maintaining",
        "ready",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
  z
    .object({
      type: z.literal("failed"),
      errorCode: databaseStartupErrorCodeSchema,
      migration: databaseMigrationFactsSchema.optional(),
      ...databaseStartupErrorDetailsSchema.shape,
    })
    .strict(),
]);
const statusError = (
  kind: string,
  details?: {
    sqliteCode?: number;
    systemCode?: string;
    migrationId?: string;
    migration?: DatabaseMigrationFacts;
  },
  databaseId?: string,
) =>
  Object.assign(new Error(`Storage preparation failed: ${kind}`), {
    kind,
    errcode: details?.sqliteCode,
    code: details?.systemCode,
    migrationId: details?.migrationId,
    migrationUpdate:
      databaseId && details?.migration ? { databaseId, migration: details.migration } : undefined,
  });

export function prepareHostStorage(
  path: string,
  report: (phase: Phase, migration?: DatabaseMigrationFacts) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tasksStorageWorker.js", import.meta.url), {
      workerData: { path },
    });
    let done = false;
    let failure: unknown;
    let firstState = false;
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      void worker.terminate();
    }, 30_000);
    const abort = () => {
      failure = statusError("transport_closed");
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (raw: unknown) => {
      const result = workerMessageSchema.safeParse(raw);
      if (!result.success) {
        failure = statusError("transport_closed");
        void worker.terminate();
        return;
      }
      firstState = true;
      clearTimeout(firstStateTimer);
      const message = result.data;
      if (message.type === "progress") report(message.phase, message.migration);
      else if (message.type === "done") done = true;
      else failure = statusError(message.errorCode, message, "tasks-index");
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      clearTimeout(firstStateTimer);
      signal.removeEventListener("abort", abort);
      if (done && code === 0 && !failure && firstState) resolve();
      else reject(failure ?? statusError("transport_closed"));
    });
    if (signal.aborted) abort();
  });
}

/** 在 Host 所属 Worker 运行同一 CLI bundle 的存储入口；Host 退出不会留下持锁孤儿进程。 */
export async function prepareSessionStorage(options: {
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  report: (
    phase: Phase,
    details?: { databaseId: string; migration?: DatabaseMigrationFacts },
  ) => void;
  preparedPaths?: Set<string>;
  observePath: (path: string) => Promise<void>;
}): Promise<void> {
  const command = resolveDefaultZCodeAgentCommand({
    workspacePath: options.cwd,
    workspaceKey: options.cwd,
    presentationSurface: "desktop",
  });
  if (!command?.supportsStorageStartup || !command.storagePreparationEntry)
    throw statusError("unsupported_runtime");
  const entry = command.storagePreparationEntry;
  await new Promise<void>((resolve, reject) => {
    const child = new Worker(entry, {
      argv: ["app-server", "--stdio", "--prepare-storage", "--cwd", command.cwd ?? options.cwd],
      env: { ...process.env, ...options.env, ...command.env },
      stdin: true,
      stdout: true,
      stderr: true,
    });
    const input = child.stdin!;
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let prepared = false;
    let pathReceived = false;
    let preparedPath: string | undefined;
    let failure: unknown;
    const terminate = () => {
      void child.terminate();
    };
    const abort = () => {
      failure ??= statusError("transport_closed");
      terminate();
    };
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      terminate();
    }, 30_000);
    options.signal.addEventListener("abort", abort, { once: true });
    // stdout 只有有界控制帧。stderr 仍然不把可能含本地路径的原始文本**上报**（不进入
    // startupState / IPC），但必须留在本地：之前这里是 `child.stderr.resume()`，把子进程
    // 崩溃时的真实原因直接扔掉了，于是所有存储准备失败都只表现为一个 `open_failed` /
    // `transport_closed` 符号，与 Rust 侧 `Stdio::null()` 是同一类问题。
    // 现在保留一个有界 tail 并在失败时打进本地日志，路径仍不上报。
    const stderrTail = createBoundedStderrTail();
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail.push(chunk.toString());
    });
    input.on("error", (error) => {
      failure ??= error;
      terminate();
    });
    lines.on("line", (line) => {
      try {
        if (line.length > 65536) throw statusError("transport_closed");
        const frame = zcodeStoragePreparationFrameSchema.parse(JSON.parse(line));
        clearTimeout(firstStateTimer);
        if (frame.method === "startup/storagePath") {
          if (pathReceived) throw statusError("transport_closed");
          pathReceived = true;
          void (async () => {
            // 仅复用同一次准备中已成功关闭的真实库，不能按不同 cwd 误判为不同数据库。
            preparedPath = await realpath(frame.params.path).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return resolvePath(frame.params.path);
                throw error;
              },
            );
            if (settled || failure || options.signal.aborted) return;
            const reuse = options.preparedPaths?.has(preparedPath) ?? false;
            if (!reuse) await options.observePath(frame.params.path);
            if (!settled && !failure && !options.signal.aborted)
              input.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse })}\n`);
          })().catch((error) => {
            failure ??= error;
            terminate();
          });
        } else if (frame.method === "startup/storagePrepared") {
          prepared = pathReceived;
          input.end();
        } else if (frame.params.phase === "failed")
          failure ??= statusError(
            frame.params.errorCode ?? "sql_failed",
            frame.params,
            frame.params.databaseId,
          );
        else
          options.report(frame.params.phase, {
            databaseId: frame.params.databaseId,
            migration: frame.params.migration,
          });
      } catch (error) {
        failure ??= error;
        terminate();
      }
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("exit", (code) => {
      settled = true;
      clearTimeout(firstStateTimer);
      options.signal.removeEventListener("abort", abort);
      lines.close();
      if (code === 0 && prepared && !failure) {
        if (preparedPath) options.preparedPaths?.add(preparedPath);
        resolve();
      } else {
        // 失败时把子进程 stderr tail 打进本地 debug 日志。这是定位存储准备失败原因的唯一
        // 途径：IPC 帧只携带枚举化的 errorCode，不携带原始文本（可能含本地路径）。
        const tail = stderrTail.snapshot();
        if (tail.length > 0) {
          storagePreparationLogger.debug(
            `storage preparation child failed (code=${code}); stderr tail:\n${tail.join("\n")}`,
          );
        }
        reject(failure ?? statusError("transport_closed"));
      }
    });
    if (options.signal.aborted) abort();
  });
}
