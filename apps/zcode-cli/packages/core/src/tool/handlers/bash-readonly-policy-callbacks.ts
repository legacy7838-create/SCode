// Read-only danger callbacks: the Rust owner, with a thin adapter.
//
// Spec: docs/specs/subagent-rust-port.md (Phase 3). The RULE lives in Rust so there is one
// implementation; this file only keeps the policy tables' function references working, so no
// table had to be edited. The golden corpora pin all 80 cases across these callbacks.
//
// Every danger callback is Rust now; this file is delegation only.

import {
  readonlyCallbackIsDangerous,
  isSedInPlaceOption as isSedInPlaceOptionNative,
} from "@zcode/rust/subagent-profile";

export const isSedInPlaceOption = isSedInPlaceOptionNative;

export function jqCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("jq", args);
}

export function sedCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("sed", args);
}

export function dateCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("date", args);
}

export function psCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("ps", args);
}

export function pyrightCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("pyright", args);
}

export function manCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("man", args);
}

export function lsofCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("lsof", args);
}

export function tputCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("tput", args);
}

export function ssCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("ss", args);
}

export function testCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("test", args);
}

export function xargsCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("xargs", args);
}

export function ghCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return readonlyCallbackIsDangerous("gh", args);
}

export * from "./bash-readonly-policy-git-callbacks.js";
