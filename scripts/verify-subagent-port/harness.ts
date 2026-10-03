import { readFileSync } from "node:fs";

/**
 * Shared harness for the subagent Rust port verification.
 *
 * Spec: docs/specs/subagent-rust-port.md. Run it through `scripts/verify-subagent-rust-port.mts`,
 * which loads every section; this file only owns the counters and the pass/fail contract.
 */

let failed = 0;
let passed = 0;

/** Every check goes through here, both directions: an unnoticed pass hides a broken wiring. */
export function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`FAIL  ${name}`);
  }
}

export function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

export function tally(): { failed: number; passed: number } {
  return { failed, passed };
}

export function readGolden<T>(relativePath: string): T {
  // Repo-relative on purpose: the script runs from the repository root, and an absolute
  // path would make this script machine-specific.
  return JSON.parse(readFileSync(relativePath, "utf8")) as T;
}
