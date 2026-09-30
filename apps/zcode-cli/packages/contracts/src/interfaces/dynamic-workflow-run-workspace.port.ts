// Dynamic Workflow Run Port: The reading type of workspace operation records.
// Contains manifest lines and bodies for `files.*`, `git.*` and `world.run` calls,
// It is uniformly exported by dynamic-workflow-run.port.ts and used by the caller through `@zcode/contracts`.

// The failed structuring shape remains on the main file (two fields of this group refer to it), so here we reverse import a type:
// Pure type, no runtime edge, each of the two files only describes its own set.
import type { DynamicWorkflowRunError } from "./dynamic-workflow-run.port.js";

/** The kinds of workspace node: the two world values of the journal's `dwf_node.kind`. */
export type DynamicWorkflowRunWorkspaceNodeKind = "world-read" | "world-run";

/** A node row's status, = the journal's `NodeRecordStatus` (deliberately restated here, for the same reason as lifecycle status). */
export type DynamicWorkflowRunWorkspaceNodeStatus = "running" | "completed" | "failed";

/**
 * A row's **summary** in the listing: the few numbers reportable without decoding the body.
 * The storage layer computes them inside the query with SQLite's JSON functions
 * (`resultBytes` / `resultCount` / `exitCode` / `stdoutBytes` / `stderrBytes`), and the port
 * passes them through as-is. Which fields are present depends on the op: an array body
 * (glob / grep / changedFiles) has `resultCount`, `world.run` has the exit code and the byte
 * counts of both output streams, and a string body only has `resultBytes`.
 */
export interface DynamicWorkflowRunWorkspaceNodeSummary {
  /** The body's UTF-8 byte count after serialization. */
  resultBytes: number;
  resultCount?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
}

/**
 * One row of the workspace transcript: a single `files.*` / `git.*` / `world.run` call,
 * **without the body**.
 *
 * `op` / `args` come from the `input_json` added by migration 0030 (written at admission
 * time, ≤ 4 KB); historical rows from before the upgrade have neither, and the UI falls back
 * to the step label on the static graph. `inputTruncated` means the args are a per-item string
 * preview rather than the original values.
 */
export interface DynamicWorkflowRunWorkspaceNode {
  siteId: string;
  ordinal: number;
  kind: DynamicWorkflowRunWorkspaceNodeKind;
  op?: string;
  args?: readonly unknown[];
  inputTruncated?: true;
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  /** The structured failure of a failed row (the code + message of the journal's `error_json`; no other fields cross the port). */
  error?: DynamicWorkflowRunError;
  /** Only present on rows that settled successfully. */
  summary?: DynamicWorkflowRunWorkspaceNodeSummary;
  /** The creation / most recent update time of the journal row (epoch ms); the difference is this step's duration. */
  createdAt: number;
  updatedAt: number;
}

/** The paging bag of {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.readWorkspaceNodeResult}: the byte ceiling on the body. */
export interface DynamicWorkflowRunWorkspaceNodeResultQuery {
  /** Required; the port **bounds** the body by it (truncating rather than rejecting — this is the audit surface, not the script's data-fetch surface). */
  maxBytes: number;
}

/**
 * The body of one workspace node: a `result` that has been bounded per its shape.
 *
 * Truncation is **shape-preserving**: strings are cut at the end, arrays drop their tail,
 * and `world.run`'s stdout / stderr are each cut at the end; `truncated` says whether
 * truncation happened and `totalBytes` is the byte count before truncation. A running row has
 * no body; a failed row only has `error`.
 */
export interface DynamicWorkflowRunWorkspaceNodeResult {
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  result?: unknown;
  error?: DynamicWorkflowRunError;
  truncated: boolean;
  totalBytes: number;
}
