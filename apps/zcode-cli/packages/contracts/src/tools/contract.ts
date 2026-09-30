// ============================================================
// Tool Contract - shared tool declaration surface
// ============================================================

import type { RiskLevel } from "../interfaces/session.port.js";

export type ToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

/**
 * The side-effect scopes that rewrite the workspace: the filesystem, git,
 * and shell / host execution that cannot be proven read-only. `network`, `session`, `userInteraction` and
 * `none` do not touch the workspace.
 * dynamic-workflow's import cache decides "the first write" from this: a tool call whose resolved capability
 * has `readOnly !== true` and whose scope falls in this set is a write. The predicate lives in contracts because
 * both the executor that produces the mark (core) and the driver that consumes it (bootstrap) need the same
 * rule.
 */
export const WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES: ReadonlySet<ToolSideEffectScope> = new Set<ToolSideEffectScope>([
  "workspace",
  "git",
  "system",
]);

/** Whether a tool call (by its resolved capability) rewrites the workspace. An absent scope is treated as rewriting (conservative: undeclared is untrusted). */
export function isWorkspaceMutatingToolCall(capability: {
  readOnly?: boolean | undefined;
  sideEffectScope?: ToolSideEffectScope | undefined;
}): boolean {
  if (capability.readOnly === true) return false;
  return capability.sideEffectScope === undefined
    ? true
    : WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES.has(capability.sideEffectScope);
}

/**
 * The side-effect scopes that serve the protocol alone, neither reading nor changing the outside world:
 * `session` hands results / questions back to the caller (dynamic-workflow's `submit_result` and `escalate`
 * sit in this tier), and `userInteraction` asks the user.
 */
const PROTOCOL_ONLY_SIDE_EFFECT_SCOPES: ReadonlySet<ToolSideEffectScope> = new Set<ToolSideEffectScope>([
  "session",
  "userInteraction",
]);

/**
 * Whether a tool call **read or changed the outside world** (reading a file, running a command, reaching the
 * network...).
 *
 * How it divides the work with `isWorkspaceMutatingToolCall`: that one decides "write", used to decide when to
 * close the amend-resume import cache; this one decides "touched", used to decide whether a cache entry is
 * **pure** (pure = answers only from the instructions and the transcript prefix, so it can still hit after the
 * cache closes). Reading counts as touching: `Read` declares the scope `none` (it produces no side effects), yet
 * its answer depends on the workspace. So the predicate works by exclusion: only the protocol tier
 * (`session` / `userInteraction`) is excluded, everything else counts as touching; an absent scope counts as
 * touching too.
 */
export function isWorldTouchingToolCall(capability: {
  sideEffectScope?: ToolSideEffectScope | undefined;
}): boolean {
  return capability.sideEffectScope === undefined
    ? true
    : !PROTOCOL_ONLY_SIDE_EFFECT_SCOPES.has(capability.sideEffectScope);
}

export type ToolPermissionPatternSource =
  | "none"
  | "toolName"
  | "input"
  | "path"
  | "command"
  | "network"
  | "custom";

export type ToolResultBudgetStrategy = "inline" | "truncate" | "artifact";

export type ToolExecutionMode = "client" | "providerNative";

export interface ProviderNativeToolSpec {
  kind: "provider_native";
  logicalName: string;
  providerToolName: string;
  providerIds?: string[];
  args?: Record<string, unknown>;
  fallback: "disabled";
}

export interface ToolPermissionSpec {
  permission: string;
  reason: string;
  riskLevel: RiskLevel;
  sideEffectScope: ToolSideEffectScope;
  needsApproval: boolean;
  patternSources: ToolPermissionPatternSource[];
  alwaysAllowPatternSources?: ToolPermissionPatternSource[];
  denyPriority: "beforeAsk" | "afterStaticAllow";
  /**
   * Requires explicit user approval in every permission mode. Unlike `needsApproval`, which
   * the permissive modes are allowed to short-circuit, this survives yolo's pass-through and
   * plan mode's read-only pass-through: the tool's unit of work is large enough that no
   * permissiveness setting should be able to run it unattended.
   *
   * It overrides allow-granting branches only, never deny-granting ones — an explicitly
   * disallowed tool stays denied.
   */
  alwaysAsk?: true;
  /**
   * Narrows the options offered when this tool asks. `allowAlways: false` suppresses the
   * persistent project rule: a tool whose input is different code on every call cannot
   * have a decision remembered without permanently disabling its gate. `"session"` swaps
   * the persistent rule for an in-memory, session-scoped one ("Always allow in this
   * session"): the gate stays closed for the rest of this runtime only, and every new
   * session (restart, cold resume, `/new`) asks again first.
   */
  askOptions?: { allowAlways: false | "session" };
}

export interface ToolResultBudget {
  /** Inline UI/event threshold before a result should be summarized, truncated, or redirected. */
  maxInlineBytes: number;
  /**
   * Provider-visible inline threshold. For artifact strategy this is the threshold that triggers
   * artifact persistence; the successful <persisted-output> preview uses its own preview budget.
   */
  maxModelBytes: number;
  strategy: ToolResultBudgetStrategy;
  preview?: {
    maxBytes?: number;
    maxLines?: number;
    direction?: "head" | "tail";
  };
  artifact?: {
    enabled: boolean;
    retention?: "session" | "project" | "temporary";
  };
}

export interface NoToolTimeoutPolicy {
  kind: "none";
}

export interface TimedToolTimeoutPolicy {
  kind?: "timed";
  defaultMs: number;
  maxMs?: number;
  allowCallOverride: boolean;
  /**
   * Extra wall-clock budget reserved for cancellation and adapter cleanup after the
   * tool's own timeout. The user-facing timeout still comes from defaultMs/input.
   */
  cleanupGraceMs?: number;
}

export type ToolTimeoutPolicy = NoToolTimeoutPolicy | TimedToolTimeoutPolicy;

export interface ToolCancellationPolicy {
  supported: boolean;
  cleanup: "none" | "bestEffort" | "required";
  userVisibleMessage: string;
}

export interface ToolTracePolicy {
  required: true;
  propagateToAdapters: boolean;
  recordInput: "summary" | "full" | "none";
  recordOutput: "summary" | "full" | "none";
}

export interface ToolContractDeclaration {
  capability: string;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /**
   * Declaring `inputSchema` **qualifies** for the provider's strict mode (Anthropic `strict: true`: constrained
   * decoding guarantees that tool_use.input satisfies the schema exactly). It is only a qualification, not a
   * command: the adapter decides per provider / model whether to actually send it, and is responsible for
   * folding keywords that the strict subset cannot express into the description. Absent means not strict.
   * The first user is the typed `submit_result` of a dwf mono subagent.
   */
  strict?: boolean;
  requiresUserInteraction?: boolean;
  permission: ToolPermissionSpec;
  resultBudget: ToolResultBudget;
  timeout: ToolTimeoutPolicy;
  cancellation: ToolCancellationPolicy;
  trace: ToolTracePolicy;
}
