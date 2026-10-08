/*
 * Layer A5 — invoke()⇄#[tauri::command] contract guard.
 *
 * The Tauri bridge's core invariant is a 1:1 correspondence between every real
 * `#[tauri::command]` in `src-tauri/src/commands.rs` and a typed `invoke("...")`
 * wrapper in `src/renderer/src/tauriBridge.ts`. Earlier slices drifted (the slice-12
 * theme commands and the `spawn_sidecar_echo` PoC shipped on the Rust side with no
 * TS wrapper, leaving them unreachable from the renderer). This test parses BOTH
 * languages and fails on either direction of drift, so the seam cannot silently
 * diverge again. It is fully static (no live window, no sidecar) and therefore
 * safe to run headless on CI.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Paths resolved relative to this file: .../tauri-port/test/layer-a/ -> .../desktop/
const commandsRs = fileURLToPath(new URL("../../../src-tauri/src/commands.rs", import.meta.url));
const tauriBridgeTs = fileURLToPath(
  new URL("../../../src/renderer/src/tauriBridge.ts", import.meta.url),
);

/**
 * Extract the declared command function name that follows each `#[tauri::command]`
 * attribute. We split on the attribute so the intervening `///` doc-comment lines
 * are skipped, then take the first `pub [async] fn NAME` in each segment.
 */
function rustCommandNames(src: string): Set<string> {
  const parts = src.split("#[tauri::command]");
  const names = new Set<string>();
  for (const segment of parts.slice(1)) {
    const m = segment.match(/\bpub\s+(?:async\s+)?fn\s+([a-z0-9_]+)/);
    if (m) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * Extract every command name invoked through the bridge, matching both
 * `invoke("name", ...)` and `invoke<T>("name", ...)` call forms.
 */
function bridgeInvokedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

function symmetricDifference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

test("A5: the parser finds a non-trivial number of Rust commands (guards a false-green)", () => {
  const names = rustCommandNames(readFileSync(commandsRs, "utf8"));
  // The seam is well past a handful of commands; a near-zero count here means the
  // parse broke against the file layout, which would make the drift checks vacuous.
  assert.ok(names.size >= 40, `expected >=40 Rust commands, parsed ${names.size}`);
});

test("A5: every #[tauri::command] has a tauriBridge invoke wrapper", () => {
  const rust = rustCommandNames(readFileSync(commandsRs, "utf8"));
  const ts = bridgeInvokedNames(readFileSync(tauriBridgeTs, "utf8"));
  const missingWrappers = symmetricDifference(rust, ts);
  assert.deepEqual(
    missingWrappers,
    [],
    `commands with no TS wrapper (renderer cannot call them): ${missingWrappers.join(", ")}`,
  );
});

test("A5: every tauriBridge invoke targets a real #[tauri::command]", () => {
  const rust = rustCommandNames(readFileSync(commandsRs, "utf8"));
  const ts = bridgeInvokedNames(readFileSync(tauriBridgeTs, "utf8"));
  const brokenCalls = symmetricDifference(ts, rust);
  assert.deepEqual(
    brokenCalls,
    [],
    `wrappers invoking an unknown command (would reject at runtime): ${brokenCalls.join(", ")}`,
  );
});
