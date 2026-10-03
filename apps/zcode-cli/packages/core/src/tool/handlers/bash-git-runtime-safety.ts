// Git runtime-context safety: the Rust owner, with a thin adapter.
//
// Spec: docs/specs/subagent-rust-port.md (Phase 3). The check inspects the filesystem —
// `lstat` on `.git` (so a symlink is seen AS a symlink), a bounded read of `HEAD`, and an
// executability probe on `objects/` and `refs/`. That is filesystem work, and it is where it
// belongs. `git-runtime-safety-golden.json` pins the verdict for nine real fixture layouts
// (normal tree, nested, no repo, escaping `gitdir:`, symlinked `.git`, bare layout, incomplete
// tree, no context, missing path) plus the eight pure predicates.

export type BashReadonlyRuntimeContext = { workingDirectory?: string; workspaceRoot?: string };

import {
  analysisGitPredicates,
  isGitRuntimeContextUnsafe as isGitRuntimeContextUnsafeNative,
} from "@zcode/rust/subagent-profile";

export function analysisContainsGitCommand(
  commands: readonly { argv: readonly string[]; name: string }[],
): boolean {
  return analysisGitPredicates(commands).hasGit;
}

export function analysisContainsGitAndDirectoryChange(
  commands: readonly { argv: readonly string[]; name: string }[],
): boolean {
  return analysisGitPredicates(commands).hasGitAndDirectoryChange;
}

export function isGitRuntimeContextUnsafe(context: BashReadonlyRuntimeContext | undefined): boolean {
  return isGitRuntimeContextUnsafeNative(context);
}
