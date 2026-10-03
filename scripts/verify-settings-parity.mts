/**
 * §5 differential: the LIVE TypeScript `appSettingsSchema` / `appSettingsPatchSchema`
 * against the native crate, over one corpus (spec docs/specs/rust-native-config.md).
 *
 *   npx tsx scripts/verify-settings-parity.mts
 *
 * The corpus is committed (`crates/zcode-config/tests/fixtures/settings-parity-cases.json`)
 * so the run is reproducible; expected behaviour comes from the live zod schema on
 * every run, so a zod-side change is caught as a divergence rather than frozen
 * into a stale snapshot.
 *
 * Compared per case, in order:
 *  1. verdict — ok / invalid-json / schema-invalid,
 *  2. issues  — the full `{path, message}` sequence, byte-for-byte (shape order
 *               is part of the contract; see the module docs of settings.rs),
 *  3. output  — the parsed settings with JSON round-trip applied to the TS side
 *               (so `undefined`-valued keys, zod's spelling of "cleared", drop
 *               out identically), AND the key sequence itself, because that
 *               order is what `JSON.stringify(persisted, null, 2)` writes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
} from "../packages/shared/src/validationAppSettings.ts";
import { parseSettingsContent, parseSettingsPatch } from "../packages/rust/src/config.ts";

interface Issue {
  path: string;
  message: string;
}

const corpusPath = fileURLToPath(
  new URL(
    "../packages/rust/crates/zcode-config/tests/fixtures/settings-parity-cases.json",
    import.meta.url,
  ),
);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  settings: Record<string, unknown>;
  patch: Record<string, unknown>;
};

let checks = 0;
const failures: string[] = [];

function fail(name: string, detail: string): void {
  failures.push(`${name}: ${detail}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- settings cases ------------------------------------------------------

for (const [name, input] of Object.entries(corpus.settings)) {
  checks += 1;
  const ts = appSettingsSchema.safeParse(input);
  const native = parseSettingsContent(JSON.stringify(input));

  const expectedStatus = ts.success ? "ok" : "schema-invalid";
  if (native.status !== expectedStatus) {
    fail(
      name,
      `status: ts=${expectedStatus} native=${native.status} issues=${JSON.stringify(native.issues)}`,
    );
    continue;
  }
  if (!ts.success) {
    const tsIssues: Issue[] = ts.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    if (!deepEqual(tsIssues, native.issues)) {
      fail(
        name,
        `issues:\n    ts:     ${JSON.stringify(tsIssues)}\n    native: ${JSON.stringify(native.issues)}`,
      );
    }
    continue;
  }
  // Success: compare the parsed output and its key sequence.
  const tsData = JSON.parse(JSON.stringify(ts.data)) as Record<string, unknown>;
  if (native.settings === null) {
    fail(name, "native returned null settings on ok");
    continue;
  }
  if (!deepEqual(tsData, native.settings)) {
    fail(
      name,
      `settings diverge:\n    ts:     ${JSON.stringify(tsData)}\n    native: ${JSON.stringify(native.settings)}`,
    );
    continue;
  }
  const tsKeys = Object.keys(tsData);
  const nativeKeys = Object.keys(native.settings);
  if (!deepEqual(tsKeys, nativeKeys)) {
    fail(name, `key order:\n    ts:     ${tsKeys.join(",")}\n    native: ${nativeKeys.join(",")}`);
  }
}

// --- patch cases ---------------------------------------------------------

for (const [name, input] of Object.entries(corpus.patch)) {
  checks += 1;
  const ts = appSettingsPatchSchema.safeParse(input);
  const native = parseSettingsPatch(input);

  if (ts.success !== native.ok) {
    fail(
      name,
      `verdict: ts.success=${ts.success} native.ok=${native.ok} native=${JSON.stringify(native)}`,
    );
    continue;
  }
  if (!ts.success) {
    const tsIssues: Issue[] = ts.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    if (native.ok) {
      fail(name, "native returned ok where ts failed");
      continue;
    }
    if (!deepEqual(tsIssues, native.issues)) {
      fail(
        name,
        `issues:\n    ts:     ${JSON.stringify(tsIssues)}\n    native: ${JSON.stringify(native.issues)}`,
      );
    }
    continue;
  }
  if (!native.ok) {
    fail(name, `native failed where ts succeeded: ${JSON.stringify(native.issues)}`);
    continue;
  }
  const tsData = JSON.parse(JSON.stringify(ts.data)) as Record<string, unknown>;
  const nativePatch = native.patch;
  if (!deepEqual(tsData, nativePatch)) {
    fail(
      name,
      `patch diverge:\n    ts:     ${JSON.stringify(tsData)}\n    native: ${JSON.stringify(nativePatch)}`,
    );
    continue;
  }
  const tsKeys = Object.keys(tsData);
  const nativeKeys = Object.keys(nativePatch);
  if (!deepEqual(tsKeys, nativeKeys)) {
    fail(
      name,
      `patch key order:\n    ts:     ${tsKeys.join(",")}\n    native: ${nativeKeys.join(",")}`,
    );
  }
}

// --- raw-text entries (the file boundary itself) --------------------------

for (const [name, text] of [
  ["text-invalid-json", "{ not json"],
  ["text-scalar", "5"],
  ["text-array", "[1,2]"],
] as const) {
  checks += 1;
  const native = parseSettingsContent(text);
  let expectedStatus: string;
  try {
    const parsed: unknown = JSON.parse(text);
    const ts = appSettingsSchema.safeParse(parsed);
    expectedStatus = ts.success ? "ok" : "schema-invalid";
  } catch {
    expectedStatus = "invalid-json";
  }
  if (native.status !== expectedStatus) {
    fail(name, `status: expected=${expectedStatus} native=${native.status}`);
  }
}

if (failures.length > 0) {
  console.error(`settings parity: ${failures.length}/${checks} DIVERGED`);
  for (const failure of failures.slice(0, 20)) console.error("  ✗ " + failure);
  process.exit(1);
}
console.log(`settings parity OK: ${checks} checks, zero divergence`);
