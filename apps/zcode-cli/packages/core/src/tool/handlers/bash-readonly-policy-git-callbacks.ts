// Git subcommand danger callbacks: the Rust owner, with a thin adapter.
//
// Spec: docs/specs/subagent-rust-port.md (Phase 3). The RULE lives in Rust; this file keeps the
// policy table's `additionalCommandIsDangerousCallback` references working without editing the
// table. `git-callbacks-golden.json` pins all 36 cases across the six callbacks.
//
// These close the gap between "the subcommand is on the read-only list" and "these particular
// arguments still do something": `git tag v1.0` moves a tag, `git reflog expire` destroys
// history, `git log --format=%G` runs a signature check, `git ls-remote origin` reaches the
// network.

import { readonlyCallbackIsDangerous } from "@zcode/rust/subagent-profile";

export function gitRevisionFormatCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  return readonlyCallbackIsDangerous("gitRevisionFormat", args);
}

export function gitReflogCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  return readonlyCallbackIsDangerous("gitReflog", args);
}

export function gitLsRemoteCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  return readonlyCallbackIsDangerous("gitLsRemote", args);
}

export function gitRemoteShowCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  return readonlyCallbackIsDangerous("gitRemoteShow", args);
}

export function gitTagCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("gitTag", args);
}

export function gitBranchCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  return readonlyCallbackIsDangerous("gitBranch", args);
}
