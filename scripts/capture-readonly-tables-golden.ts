/**
 * PHASE 3 oracle: the ENTIRE read-only policy table, as data.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * The tables are literal data — flag kinds, per-subcommand policies, multiword prefixes — with
 * the one non-literal field being `additionalCommandIsDangerousCallback`, a FUNCTION
 * reference. In the captured form that becomes a NAME, which is what lets Rust own the table
 * without a second hand-transcription of ~1,400 lines that could silently disagree.
 *
 * The merge order matters: the original spreads CORE then HISTORY (and simple, and multiword)
 * into one Map. A later entry with the same key wins, so the capture reproduces that order
 * rather than de-duplicating by hand.
 *
 * Run: pnpm exec tsx scripts/capture-readonly-tables-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import {
  GIT_READONLY_SUBCOMMAND_POLICIES,
  READONLY_MULTIWORD_COMMAND_POLICIES,
} from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-commands.ts";
import {
  READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES,
  READONLY_ALLOW_ANY_ARG_COMMANDS,
  READONLY_COMMAND_POLICIES,
} from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-simple-commands.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

/** Callback function -> the Rust dispatch name. Any callback not listed here is a capture bug. */
const CALLBACK_NAMES: Record<string, string> = {
  jqCommandIsDangerous: "jq",
  sedCommandIsDangerous: "sed",
  dateCommandIsDangerous: "date",
  psCommandIsDangerous: "ps",
  pyrightCommandIsDangerous: "pyright",
  manCommandIsDangerous: "man",
  lsofCommandIsDangerous: "lsof",
  tputCommandIsDangerous: "tput",
  ssCommandIsDangerous: "ss",
  testCommandIsDangerous: "test",
  xargsCommandIsDangerous: "xargs",
  ghCommandIsDangerous: "gh",
  gitRevisionFormatCommandIsDangerous: "gitRevisionFormat",
  gitReflogCommandIsDangerous: "gitReflog",
  gitLsRemoteCommandIsDangerous: "gitLsRemote",
  gitRemoteShowCommandIsDangerous: "gitRemoteShow",
  gitTagCommandIsDangerous: "gitTag",
  gitBranchCommandIsDangerous: "gitBranch",
};

/** Inline lambdas, keyed by the table entry they belong to. */
const INLINE_CALLBACK_NAMES: Record<string, string> = {
  "git[git remote]": "gitRemote",
};

function encodePolicy(policy: unknown, path: string): Record<string, unknown> {
  const source = policy as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof source.allowAnyArgs === "boolean") out.allowAnyArgs = source.allowAnyArgs;
  if (typeof source.commandOnly === "boolean") out.commandOnly = source.commandOnly;
  if (typeof source.allowCompactNumericCountFlag === "boolean") {
    out.allowCompactNumericCountFlag = source.allowCompactNumericCountFlag;
  }
  if (typeof source.respectsDoubleDash === "boolean") out.respectsDoubleDash = source.respectsDoubleDash;
  if (source.safeFlags && typeof source.safeFlags === "object") {
    out.safeFlags = source.safeFlags as Record<string, string>;
  }
  if (source.regex) {
    // The one field that is not data. Its source is recorded so a future port does not
    // pretend it is portable.
    out.regexSource = String(source.regex);
    out.regexIsLossless = false;
  }
  const callback = source.additionalCommandIsDangerousCallback as
    | ((commandText: string, args: readonly string[]) => boolean)
    | undefined;
  if (typeof callback === "function") {
    // `git remote`'s callback is an inline lambda with no useful `.name`, so it is keyed by
    // its table entry rather than by function name.
    const name = CALLBACK_NAMES[callback.name] ?? INLINE_CALLBACK_NAMES[path];
    if (!name) throw new Error(`unmapped callback ${callback.name} at ${path}`);
    out.additionalCommandIsDangerousCallback = name;
  }
  return out;
}

function encodeMap(table: Map<string, unknown>, name: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, policy] of table) out[key] = encodePolicy(policy, `${name}[${key}]`);
  return out;
}

const tables = {
  gitReadonlySubcommandPolicies: encodeMap(GIT_READONLY_SUBCOMMAND_POLICIES, "git"),
  readonlyMultiwordCommandPolicies: encodeMap(READONLY_MULTIWORD_COMMAND_POLICIES, "multiword"),
  readonlyCommandPolicies: encodeMap(READONLY_COMMAND_POLICIES, "simple"),
  readonlyAllowAnyArgCommands: [...READONLY_ALLOW_ANY_ARG_COMMANDS].sort(),
  readonlyAllowAnyArgCommandPrefixes: [...READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES].sort(),
};

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/readonly-tables-golden.json`, JSON.stringify(tables, null, 2) + "\n");

// Report any regex (non-portable field) so it is visible, not buried.
let regexCount = 0;
const walk = (value: unknown) => {
  if (Array.isArray(value)) return value.forEach(walk);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("regexIsLossless" in record) regexCount += 1;
    Object.values(record).forEach(walk);
  }
};
walk(tables);
console.log(`captured tables: git=${Object.keys(tables.gitReadonlySubcommandPolicies).length}, ` +
  `multiword=${Object.keys(tables.readonlyMultiwordCommandPolicies).length}, ` +
  `simple=${Object.keys(tables.readonlyCommandPolicies).length}, ` +
  `allowAny=${tables.readonlyAllowAnyArgCommands.length}`);
console.log(`policies carrying a regex (not portable as data): ${regexCount}`);
const callbacksUsed = new Set<string>();
walk(tables);
console.log(`callback kinds referenced: ${[...callbacksUsed].join(", ") || "(counted below)"}`);
