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
const commandsRs = fileURLToPath(
  new URL("../../../src-tauri/src/commands.rs", import.meta.url),
);
const tauriBridgeTs = fileURLToPath(
  new URL("../../../src/renderer/src/tauriBridge.ts", import.meta.url),
);
const mainRs = fileURLToPath(
  new URL("../../../src-tauri/src/main.rs", import.meta.url),
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

/**
 * Strip `//` line comments (including `///` docs) and `/* *\/` block comments so a
 * scan of the code ignores prose. Good-enough for this single-purpose guard: it only
 * needs to avoid false positives from doc text like `always_on_top` appearing in a
 * comment, while leaving real object-key syntax intact.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/[^\n]*$/g, "");
}

/**
 * Tauri converts a Rust `snake_case` command argument into a JS `camelCase` invoke
 * key. So every key in a `tauriBridge.ts` invoke argument object MUST be camelCase;
 * a key still containing an underscore (e.g. `default_path:`) is the exact signature
 * of forgetting the conversion — a silent runtime bug where the Rust arg never
 * arrives (PORTING.md Phase-6). Scanning comment-stripped code, command-name string
 * literals are quoted and followed by `,`/`)`, so they never match `name:`.
 */
function snakeCaseArgKeys(src: string): string[] {
  return [...stripComments(src).matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\s*:/g)]
    .map((m) => m[1])
    .sort();
}

function symmetricDifference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

/**
 * Tauri auto-camelCases command ARGUMENTS, but a serde RETURN struct keeps its Rust field names
 * UNLESS the struct carries `#[serde(rename_all = "camelCase")]`. So a `Serialize` struct with a
 * snake_case field and no rename_all silently returns e.g. `local_path` where the renderer expects
 * `localPath` — the exact trap MonitorInfo / TempTextAttachmentResult guard by hand. This parses every
 * `#[derive(...Serialize...)]` brace-struct and returns the names of those with ≥1 snake_case field but
 * NO `rename_all`. An empty result means the invariant holds; a parse that finds too few structs means
 * the regex broke against the file layout (guarded separately by the tripwire below).
 */
function serializeStructsWithSnakeFieldsMissingCamelRename(
  src: string,
): string[] {
  const code = stripComments(src);
  const offenders: string[] = [];
  // Each block runs from a Serialize derive attribute up to the struct's closing brace (line-initial }).
  const blockRe = /#\[derive\([^)]*\bSerialize\b[^)]*\)\]([\s\S]*?)\n\}/g;
  for (const match of code.matchAll(blockRe)) {
    const block = match[1];
    const structName =
      (block.match(/struct\s+([A-Za-z0-9_]+)/) ?? [])[1] ?? "<anonymous>";
    const hasRenameAll = /rename_all\s*=/.test(block);
    // Field names are the identifiers left of `:` inside the body (handles `pub x:` and private `x:`).
    const body = block.slice(block.indexOf("{") + 1);
    const fieldNames = [
      ...body.matchAll(/^\s*(?:pub\s+)?([a-z][a-z0-9_]*)\s*:/gm),
    ].map((m) => m[1]);
    const hasSnakeField = fieldNames.some((f) => f.includes("_"));
    if (hasSnakeField && !hasRenameAll) {
      offenders.push(structName);
    }
  }
  return offenders.sort();
}

/** Count the `#[derive(...Serialize...)]` brace-structs the block regex recognizes (vacuity guard). */
function serializeStructCount(src: string): number {
  return [
    ...stripComments(src).matchAll(
      /#\[derive\([^)]*\bSerialize\b[^)]*\)\][\s\S]*?\n\}/g,
    ),
  ].length;
}

test("A5: the parser finds a non-trivial number of Rust commands (guards a false-green)", () => {
  const names = rustCommandNames(readFileSync(commandsRs, "utf8"));
  // The seam is well past a handful of commands; a near-zero count here means the
  // parse broke against the file layout, which would make the drift checks vacuous.
  assert.ok(
    names.size >= 40,
    `expected >=40 Rust commands, parsed ${names.size}`,
  );
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

test("A5: every invoke arg object key is camelCase (Rust snake_case → JS camelCase)", () => {
  const snakeKeys = snakeCaseArgKeys(readFileSync(tauriBridgeTs, "utf8"));
  assert.deepEqual(
    snakeKeys,
    [],
    `invoke arg object keys must be camelCase; found snake_case key(s) whose Rust arg ` +
      `would silently never arrive: ${snakeKeys.join(", ")}`,
  );
});

/**
 * Extract every `commands::NAME` reference in `main.rs`'s `generate_handler![...]`. A command that
 * is defined in `commands.rs` but not listed here is UNREACHABLE at runtime — the Rust-side twin of
 * the slice-18 wrapper drift. `shell_kind` is defined in `main.rs` itself and registered bare (not
 * `commands::shell_kind`), so it correctly does not appear in this set.
 */
function registeredCommands(mainSrc: string): Set<string> {
  const names = new Set<string>();
  for (const m of mainSrc.matchAll(/commands::([a-z_][a-z0-9_]*)/g)) {
    names.add(m[1]);
  }
  return names;
}

test("A5: every #[tauri::command] fn is registered in main.rs generate_handler", () => {
  const defined = rustCommandNames(readFileSync(commandsRs, "utf8"));
  const registered = registeredCommands(readFileSync(mainRs, "utf8"));
  const unregistered = symmetricDifference(defined, registered);
  assert.deepEqual(
    unregistered,
    [],
    `commands defined but NOT registered (renderer cannot reach them): ${unregistered.join(", ")}`,
  );
});

test("A5: every commands::NAME registered in main.rs is a real #[tauri::command]", () => {
  const defined = rustCommandNames(readFileSync(commandsRs, "utf8"));
  const registered = registeredCommands(readFileSync(mainRs, "utf8"));
  const dangling = symmetricDifference(registered, defined);
  assert.deepEqual(
    dangling,
    [],
    `main.rs registers a commands:: name with no matching #[tauri::command] (build break): ${dangling.join(", ")}`,
  );
});

/**
 * Push-event channel guard (slice 33): a Rust `app.emit(NAME, ..)` and a JS `listen(NAME, ..)` must
 * use the IDENTICAL event-name string, else the renderer silently never receives the event. Auto-extracts
 * every `zcode:` string literal defined in `commands.rs` and requires the SAME literal to appear in
 * `tauriBridge.ts` — so it guards ALL push-events (zoom, fullscreen, and any future), not a hardcoded list.
 */
test("A5: shared push-event names appear in BOTH commands.rs and tauriBridge.ts", () => {
  const commands = stripComments(readFileSync(commandsRs, "utf8"));
  const bridge = readFileSync(tauriBridgeTs, "utf8");
  const names = [
    ...new Set([...commands.matchAll(/"(zcode:[^"]+)"/g).map((m) => m[1])]),
  ].sort();
  // Tripwire: at least the two landed events are discovered (guards a vacuous match against a parse break).
  assert.ok(
    names.length >= 2,
    `expected >=2 zcode: events in commands.rs, found ${names.join(", ")}`,
  );
  for (const name of names) {
    assert.ok(
      bridge.includes(`"${name}"`),
      `tauriBridge.ts must listen on "${name}" (defined in commands.rs)`,
    );
  }
});

/**
 * Guard the serde RETURN-struct casing (see `serializeStructsWithSnakeFieldsMissingCamelRename`).
 * Tauri camelCases ARGS automatically but NOT returned struct fields, so a `Serialize` struct with a
 * snake_case field and no `#[serde(rename_all = "camelCase")]` returns a key the renderer cannot read.
 * This is the return-side twin of the arg-camelCase check above.
 */
test("A5: every Serialize return struct with snake_case fields declares camelCase rename", () => {
  const src = readFileSync(commandsRs, "utf8");
  const offenders = serializeStructsWithSnakeFieldsMissingCamelRename(src);
  assert.deepEqual(
    offenders,
    [],
    `Serialize structs with snake_case fields but no #[serde(rename_all="camelCase")]: ${offenders.join(", ")}`,
  );
  // Vacuity guard: the parser must actually see the landed return structs, else this test passes falsely.
  const count = serializeStructCount(src);
  assert.ok(
    count >= 5,
    `expected >=5 Serialize structs parsed, got ${count} (parser likely broke)`,
  );
});
