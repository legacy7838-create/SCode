/**
 * Typed wrapper over the zcode-git napi binary (spec: docs/specs/rust-native-git.md).
 *
 * The four exports mirror the legacy repo methods (`resolveRepository`,
 * `getStatus`, `getIdentity`, `getBranchComparison`) so the in-flight dedup and
 * `invalidate()` lifecycle in the consumer stay untouched.
 *
 * Load errors are thrown loudly by loadNative — there is no JS fallback here.
 */
import { loadNative } from "./loader.js";

export interface NativeGitResolveRequest {
  workspacePath: string;
}

export interface NativeGitResolveResult {
  /** Legacy `isGitAvailable` (filesystem probe, no spawn). */
  gitAvailable: boolean;
  discovery: "ok" | "not-repository" | "missing-workdir";
  /** Absolute; "" unless discovery === "ok". */
  repoRoot: string;
  /** `git rev-parse --show-prefix` equivalent: "" | "sub/". */
  workspacePrefix: string;
  /** Absolute. */
  gitDir: string;
  /** Absolute. */
  gitCommonDir: string;
}

export interface NativeGitStatusRequest {
  repoRoot: string;
}

export interface NativeGitStatusEntry {
  path: string;
  /** napi `Option` — `undefined` when absent; coerce with `?? null` for legacy parity. */
  originalPath: string | undefined;
  x: string | undefined;
  y: string | undefined;
  isUntracked: boolean;
  isConflicted: boolean;
}

export interface NativeGitStatRecord {
  path: string;
  added: number;
  removed: number;
}

export interface NativeGitStatusSnapshot {
  /** HEAD's branch, `undefined` ⇔ detached; coerce with `?? null`. */
  branchName: string | undefined;
  /** e.g. "origin/master". */
  trackingBranchName: string | undefined;
  headRefType: "branch" | "detached";
  ahead: number;
  behind: number;
  /** Exact legacy record order: tracked (byte-sorted) → conflicted → untracked. */
  entries: NativeGitStatusEntry[];
  stagedStats: NativeGitStatRecord[];
  unstagedStats: NativeGitStatRecord[];
  untrackedStats: NativeGitStatRecord[];
  /** True only on the first overflow-collapse of this repoRoot. */
  collapsedNow: boolean;
}

export interface NativeGitIdentityRequest {
  repoRoot: string;
}

export interface NativeGitIdentity {
  userName: string | undefined;
  userEmail: string | undefined;
  /** `--show-origin` equivalent, e.g. "file:.git/config". */
  nameSource: string | undefined;
  emailSource: string | undefined;
  /** `--show-scope` equivalent, e.g. "local". */
  nameScope: string | undefined;
  emailScope: string | undefined;
}

export interface NativeGitBranchComparisonRequest {
  repoRoot: string;
  /** Legacy always diffs "<tracking>...HEAD". */
  trackingBranchName: string;
}

export interface NativeGitBranchChange {
  path: string;
  originalPath: string | undefined;
  added: number;
  removed: number;
  kind: "added" | "deleted" | "modified" | "renamed";
}

export interface NativeGitApi {
  resolveRepository(request: NativeGitResolveRequest): Promise<NativeGitResolveResult>;
  statusSnapshot(request: NativeGitStatusRequest): Promise<NativeGitStatusSnapshot>;
  identity(request: NativeGitIdentityRequest): Promise<NativeGitIdentity>;
  branchComparison(request: NativeGitBranchComparisonRequest): Promise<NativeGitBranchChange[]>;
}

export function loadGitApi(): NativeGitApi {
  return loadNative<NativeGitApi>("zcode-git");
}
