// ============================================================
// Dynamic Workflow Snippet Port - Synchronous compilation execution boundary of snippet
// ============================================================
// Parallel rather than merge with {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort}:
// The construction premise of the run port is durable journal (without persistence, there is no run), while snippet is completely transient and
// Relying on only two execution ports - hanging it on the run port is equivalent to allowing the experimental channel to be linked to durability conditions.

import type { TraceContext } from "../tracing/tracer.js";

/** The JSON shape of one compile diagnostic (the same shape as CreateWorkflow's diagnostics; the port does not import zod schemas). */
export interface DynamicWorkflowSnippetDiagnostic {
  code: number;
  column: number;
  line: number;
  message: string;
}

export interface DynamicWorkflowSnippetEvalRequest {
  /** The snippet source (scratch facade vocabulary: files.*, git.*, log, plain TS). */
  code: string;
  /** The execution working directory (the sandbox subprocess cwd, the root of world-read). */
  cwd: string;
  /** The wall clock for the whole snippet (ms). Clamping belongs to the tool layer; the port only executes by the value given. */
  timeoutMs: number;
  trace: TraceContext;
}

export interface DynamicWorkflowSnippetEvalOptions {
  signal?: AbortSignal;
}

/**
 * The structured result of an eval. The three shapes are mutually exclusive:
 *   - it did not compile: `diagnostics` is non-empty and nothing was executed;
 *   - execution completed: `artifact` is the script's top-level return value (an `undefined` artifact means the field is absent);
 *   - execution failed: `error` carries a stable error code (timeout / the script threw / a cap rejection all take this shape).
 * `logs` is present in the latter two shapes (the narrative before a failure is equally valuable).
 */
export type DynamicWorkflowSnippetEvalResult =
  | { kind: "diagnostics"; diagnostics: DynamicWorkflowSnippetDiagnostic[] }
  | { kind: "completed"; artifact?: unknown; logs: string[]; logsTruncated: boolean }
  | {
      kind: "failed";
      error: { code: string; message: string };
      logs: string[];
      logsTruncated: boolean;
    };

export interface DynamicWorkflowSnippetPort {
  /** Compile once and execute synchronously through settlement (fully transient: no dwf_* rows, no background tasks). */
  evalSnippet(
    request: DynamicWorkflowSnippetEvalRequest,
    options?: DynamicWorkflowSnippetEvalOptions,
  ): Promise<DynamicWorkflowSnippetEvalResult>;
}
