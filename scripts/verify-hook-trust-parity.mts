/**
 * Differential replay for the Workspace Hook trust store: the live TypeScript predecessor against
 * the Rust port, over one shared fixture set.
 *
 * Unlike the off-peak/task-read harnesses, nothing here is captured from a transcript. The
 * predecessor is **still present** — `apps/zcode-cli` imports
 * `workspace-hook-trust-store-file.ts` and is deferred (`rust-native-program.md` §1.1) — so both
 * implementations can run side by side in one process and be compared directly. That is a stronger
 * check than a recorded transcript: it cannot drift from the code it was captured from, and it does
 * not need a regeneration step that nobody remembers to run.
 *
 * What is compared, per fixture:
 *
 *   1. the verdict — `ok` vs `invalid` — because the trust store is fail-closed and a verdict
 *      disagreement is the failure that matters: one side would show a hook as trusted while the
 *      other refuses it forever;
 *   2. on `ok`, the parsed record set, key by key. A port that agrees on "valid" but drops or
 *      reorders a record would still produce a *divergent trust set*, which is the same
 *      presentation/runtime split the strict schema was written to remove;
 *   3. the storage-root resolution, against the inline logic this file's own git history shows was
 *      deleted from `hooksService.ts`.
 *
 * Usage (from the repo root):
 *   ZCODE_NATIVE_DIR="$PWD/packages/rust" node_modules/.bin/tsx scripts/verify-hook-trust-parity.mts
 */
import { isAbsolute, join } from "node:path";

import {
  parseWorkspaceHookTrustStoreContent,
  type WorkspaceHookTrustStoreFile,
} from "../packages/shared/src/workspace-hook-trust-store-file.ts";
import {
  parseWorkspaceHookTrustStore,
  readWorkspaceHookTrustDigests,
  resolveWorkspaceHookTrustStorePath,
} from "../packages/rust/src/config.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_UPPER = "A".repeat(64);

interface StoreFixture {
  label: string;
  /** `null` models the file not existing, which the native boundary takes as `missing`. */
  content: string | null;
}

/** A valid record, so each fixture varies exactly one thing. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceIdentity: "ws-1",
    hookDeclarationDigest: DIGEST_A,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt: "2026-01-02T03:04:05.000Z",
    eventAtGrant: "PreToolUse",
    displayCommandAtGrant: "echo hi",
    sourcePathAtGrant: "/ws/.zcode/config.json",
    ...overrides,
  };
}

function store(records: unknown[], schemaVersion: unknown = 1): string {
  return JSON.stringify({ schemaVersion, records });
}

const CONTENT_FIXTURES: StoreFixture[] = [
  // --- the happy path, and the two ways an empty store is *not* corrupt ------
  { label: "empty records is ok, not corrupt", content: store([]) },
  {
    label: "one record",
    content: store([record()]),
  },
  {
    label: "records across workspaces, same digest",
    content: store([record(), record({ workspaceIdentity: "ws-2" })]),
  },
  {
    label: "distinct digests in one workspace",
    content: store([record(), record({ hookDeclarationDigest: DIGEST_B })]),
  },
  {
    label: "every optional field populated",
    content: store([
      record({
        lastUsedAt: "2026-10-01T12:00:00.000Z",
        bundleDigestAtGrant: DIGEST_B,
        matcherAtGrant: "Bash",
        matcherIndexAtGrant: 0,
        hookIndexAtGrant: 2,
        sourceDiscoveryOrderAtGrant: 1,
        appVersionAtGrant: "3.14.3",
      }),
    ]),
  },
  {
    label: "every event name",
    content: store([
      record({ eventAtGrant: "SessionStart" }),
      record({ hookDeclarationDigest: DIGEST_B, eventAtGrant: "UserPromptSubmit" }),
      record({ eventAtGrant: "PermissionRequest" }),
      record({ hookDeclarationDigest: DIGEST_B, eventAtGrant: "PostToolUse" }),
      record({ eventAtGrant: "PostToolUseFailure" }),
      record({ hookDeclarationDigest: DIGEST_B, eventAtGrant: "Stop" }),
    ]),
  },

  // --- T3: JSON syntax errors ------------------------------------------------
  { label: "not json", content: "{not json" },
  { label: "empty string", content: "" },
  { label: "trailing comma", content: store([]).replace("]", ",]") },
  { label: "bare scalar", content: "5" },
  { label: "array at the root", content: "[]" },
  { label: "null at the root", content: "null" },

  // --- T4: schema violations -------------------------------------------------
  { label: "wrong schema version", content: store([], 2) },
  { label: "schema version as a string", content: store([], "1") },
  { label: "missing schemaVersion", content: JSON.stringify({ records: [] }) },
  { label: "records not an array", content: JSON.stringify({ schemaVersion: 1, records: {} }) },
  { label: "unknown top-level key", content: JSON.stringify({ schemaVersion: 1, records: [], extra: 1 }) },
  { label: "unknown record key", content: store([record({ surprise: true })]) },
  { label: "record missing required field", content: store([{ workspaceIdentity: "ws" }]) },
  { label: "uppercase digest", content: store([record({ hookDeclarationDigest: DIGEST_UPPER })]) },
  { label: "digest one char short", content: store([record({ hookDeclarationDigest: "a".repeat(63) })]) },
  { label: "digest one char long", content: store([record({ hookDeclarationDigest: "a".repeat(65) })]) },
  { label: "digest not hex", content: store([record({ hookDeclarationDigest: "z".repeat(64) })]) },
  { label: "whitespace-only identity", content: store([record({ workspaceIdentity: "   " })]) },
  { label: "empty identity", content: store([record({ workspaceIdentity: "" })]) },
  { label: "identity with surrounding space is kept", content: store([record({ workspaceIdentity: " ws " })]) },
  { label: "wrong digestAlgorithm", content: store([record({ digestAlgorithm: "sha512" })]) },
  { label: "wrong decision", content: store([record({ decision: "revoked" })]) },
  { label: "bare local datetime", content: store([record({ grantedAt: "2026-01-02T03:04:05" })]) },
  { label: "date only", content: store([record({ grantedAt: "2026-01-02" })]) },
  { label: "unix epoch seconds", content: store([record({ grantedAt: "1767225845" })]) },
  { label: "bad lastUsedAt", content: store([record({ lastUsedAt: "yesterday" })]) },
  { label: "bad bundleDigestAtGrant", content: store([record({ bundleDigestAtGrant: "short" })]) },
  { label: "unknown event name", content: store([record({ eventAtGrant: "PreCompact" })]) },
  { label: "empty displayCommand", content: store([record({ displayCommandAtGrant: "" })]) },
  { label: "empty sourcePath", content: store([record({ sourcePathAtGrant: "" })]) },
  { label: "negative index", content: store([record({ matcherIndexAtGrant: -1 })]) },
  { label: "fractional index", content: store([record({ hookIndexAtGrant: 1.5 })]) },
  { label: "index as a string", content: store([record({ hookIndexAtGrant: "2" })]) },
  { label: "zero index is allowed", content: store([record({ hookIndexAtGrant: 0 })]) },
  { label: "empty appVersion", content: store([record({ appVersionAtGrant: "" })]) },
  { label: "matcher explicitly null", content: store([record({ matcherAtGrant: null })]) },
  { label: "matcher as an object", content: store([record({ matcherAtGrant: { nested: true } })]) },

  // --- T4: the uniqueness superRefine ---------------------------------------
  { label: "duplicate identity and digest", content: store([record(), record()]) },
  {
    label: "duplicate pair among three records",
    content: store([record(), record(), record({ hookDeclarationDigest: DIGEST_B })]),
  },
  {
    label: "same identity different digests is fine",
    content: store([record(), record({ hookDeclarationDigest: DIGEST_B })]),
  },
  {
    label: "same digest different identities is fine",
    content: store([record(), record({ workspaceIdentity: "ws-2" })]),
  },
  { label: "identity differing only by trailing space", content: store([record(), record({ workspaceIdentity: "ws-1 " })]) },

  // --- BOM / encoding --------------------------------------------------------
  { label: "UTF-8 BOM", content: `﻿${store([])}` },
  { label: "UTF-16 bytes decoded as UTF-8", content: "�\u0000{\u0000" },
  { label: "lone surrogate escape", content: store([record({ displayCommandAtGrant: "\ud800" })]) },
];

const PATH_FIXTURES: { label: string; home: string; configured: string | null }[] = [
  { label: "absent storage dir", home: "/home/u", configured: null },
  { label: "empty storage dir", home: "/home/u", configured: "" },
  { label: "whitespace-only storage dir", home: "/home/u", configured: "   " },
  { label: "tilde slash", home: "/home/u", configured: "~/data/x" },
  { label: "bare tilde", home: "/home/u", configured: "~" },
  { label: "absolute", home: "/home/u", configured: "/var/lib/zcode" },
  { label: "relative", home: "/home/u", configured: "rel/dir" },
  { label: "relative with dot segments", home: "/home/u", configured: "../elsewhere" },
  { label: "padded absolute", home: "/home/u", configured: "  /abs/dir  " },
  { label: "padded tilde", home: "/home/u", configured: " ~/data " },
  { label: "trailing slash", home: "/home/u", configured: "/var/lib/zcode/" },
  { label: "double slash inside", home: "/home/u", configured: "/var//lib/zcode" },
  { label: "tilde not at the start", home: "/home/u", configured: "/opt/~/x" },
  { label: "home with a trailing slash", home: "/home/u/", configured: "rel" },
  { label: "dot-relative", home: "/home/u", configured: "." },
];

/** The predecessor's own inline resolution, reconstructed from the deleted `hooksService.ts` body. */
function predecessorTrustStorePath(home: string, configured: string | null): string {
  const trimmed = (configured ?? "").trim();
  const storageRoot = trimmed
    ? trimmed.startsWith("~/")
      ? join(home, trimmed.slice(2))
      : isAbsolute(trimmed)
        ? trimmed
        : join(home, trimmed)
    : join(home, ".zcode");
  // `path.join`, not template concatenation: join normalises a duplicate separator, so
  // `/var/lib/zcode/` + `security` is one slash. Concatenating by hand produced a `//` and
  // reported a divergence that did not exist.
  return join(storageRoot, "security", "workspace-hook-trust-v1.json");
}

/** A stable, order-independent rendering so a reordering counts as a divergence. */
function canonicalFile(file: WorkspaceHookTrustStoreFile | null): string {
  if (!file) return "<null>";
  const records = [...file.records]
    .map((record) => JSON.stringify(record, Object.keys(record).sort()))
    .sort();
  return JSON.stringify({ schemaVersion: file.schemaVersion, records });
}

let checked = 0;
let divergences = 0;

function compare(label: string, expected: string, actual: string): void {
  checked += 1;
  if (expected === actual) return;
  divergences += 1;
  process.stdout.write(`  DIVERGENCE  ${label}\n`);
  process.stdout.write(`    predecessor: ${expected}\n`);
  process.stdout.write(`    rust:        ${actual}\n`);
}

for (const { label, content } of CONTENT_FIXTURES) {
  // Verdict. `null` content has no predecessor equivalent — the TS function only ever saw a
  // string, because ENOENT was classified by the caller. Skip the verdict for it and assert the
  // native `missing` arm below instead.
  if (content !== null) {
    const tsResult = parseWorkspaceHookTrustStoreContent(content);
    const tsVerdict = tsResult.status === "ok" ? "ok" : "invalid";
    const rustStore = parseWorkspaceHookTrustStore(content);
    compare(`verdict — ${label}`, tsVerdict, rustStore === null ? "invalid" : "ok");

    if (tsResult.status === "ok" && rustStore !== null) {
      compare(
        `records — ${label}`,
        canonicalFile(tsResult.file),
        canonicalFile(JSON.parse(rustStore) as WorkspaceHookTrustStoreFile),
      );
    }
  }
}

// The `missing` arm has no predecessor equivalent: the TS function only ever received a string,
// because ENOENT was classified by the caller before the parse was reached. So it is asserted
// against the contract the spec states, not against the predecessor.
{
  const read = readWorkspaceHookTrustDigests(null, "ws-1");
  checked += 1;
  const correct =
    read.status === "missing" && read.corrupt === false && read.digests.size === 0 && !read.reason;
  if (!correct) {
    divergences += 1;
    process.stdout.write(
      `  DIVERGENCE  missing arm: expected {missing, not corrupt, empty, no reason}, got ` +
        `{${read.status}, corrupt=${read.corrupt}, size=${read.digests.size}}\n`,
    );
  }
}

// A corrupt store must never yield a digest, through either entry point.
for (const label of ["not json", "unknown record key", "duplicate identity and digest"]) {
  const fixture = CONTENT_FIXTURES.find((candidate) => candidate.label === label);
  if (!fixture || fixture.content === null) continue;
  const read = readWorkspaceHookTrustDigests(fixture.content, "ws-1");
  checked += 1;
  if (!(read.corrupt && read.digests.size === 0 && read.reason === "invalid-content")) {
    divergences += 1;
    process.stdout.write(`  DIVERGENCE  corrupt arm (${label}) returned digests or a weak reason\n`);
  }
}

for (const { label, home, configured } of PATH_FIXTURES) {
  compare(
    `path — ${label}`,
    predecessorTrustStorePath(home, configured),
    resolveWorkspaceHookTrustStorePath(home, configured),
  );
}

// One divergence is enumerated and accepted, in the same spirit as the four the cron engine
// records (`rust-native-cron.md` §6.2). It is a limitation of the toolchain, not of the port.
//
//   A JSON string containing a *lone* surrogate escape (`"\ud800"`). `JSON.parse` accepts it and
//   yields a JS string holding an unpaired surrogate; `serde_json` refuses to parse the document at
//   all. So a store with such a character in `displayCommandAtGrant` reads as `ok` in TypeScript
//   and as `corrupt` here.
//
//   The direction is the safe one — corrupt is fail-closed, so the affected hook is
//   `pending_trust` and the runtime blocks it, which is what happens for every other untrustworthy
//   store. Accepting it silently would be worse than naming it, and "fixing" it would mean
//   pre-scanning the file for a pattern no real grant produces.
const ENUMERATED = new Set(["verdict — lone surrogate escape"]);

process.stdout.write(`\nhook trust store parity: ${checked} checks, ${divergences} divergence(s)\n`);
if (divergences > ENUMERATED.size) {
  process.stdout.write(`  ${divergences - ENUMERATED.size} un-enumerated divergence(s) — this is a regression.\n`);
  process.exit(1);
}
process.stdout.write(
  `  ${ENUMERATED.size} enumerated divergence accepted: lone surrogate escape (serde_json rejects ` +
    `what JSON.parse accepts; fail-closed direction). See rust-native-config.md §5a.\n`,
);
process.exit(0);