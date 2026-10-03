/** Verification section: tables-live. See docs/specs/subagent-rust-port.md. */
import { lookupReadonlyPolicy, matchesHostnameRegex } from "../../packages/rust/src/subagentProfile.ts";
import { check, readGolden } from "./harness.js";

export function run(): void {
{
  // The table is DATA, embedded from the file the capture wrote from the live tables. There is
  // no hand-transcribed copy, so there is nothing to drift — this checks that every prefix
  // resolves and that the shapes the Rust tests found (commandOnly with no safeFlags) hold at
  // the napi boundary too.
  const golden = readGolden<Record<string, Record<string, unknown>>>("apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-tables-golden.json");
  const allPrefixes = [
    ...Object.keys(golden.gitReadonlySubcommandPolicies ?? {}),
    ...Object.keys(golden.readonlyMultiwordCommandPolicies ?? {}),
    ...Object.keys(golden.readonlyCommandPolicies ?? {}),
  ];
  let missing = 0;
  for (const prefix of allPrefixes) if (lookupReadonlyPolicy(prefix) === undefined) missing += 1;
  check(`all ${allPrefixes.length} policy prefixes resolve in Rust`, missing === 0);
  check("unknown prefix stays undefined", lookupReadonlyPolicy("definitely-not-a-command") === undefined);

  const alias = lookupReadonlyPolicy("alias");
  check("commandOnly policy with no safeFlags resolves", alias !== undefined && alias.commandOnly === true);
  const gitLog = lookupReadonlyPolicy("git log");
  check("git log carries its safe flags", gitLog !== undefined && Object.keys(gitLog.safeFlags).length > 0);
  check("git tag names its callback", lookupReadonlyPolicy("git tag")?.additionalCommandIsDangerousCallback === "gitTag");
  check("git remote names its inline callback", lookupReadonlyPolicy("git remote")?.additionalCommandIsDangerousCallback === "gitRemote");

  check("hostname regex matches", matchesHostnameRegex("hostname -d --verbose"));
  check("hostname regex rejects a non-flag tail", !matchesHostnameRegex("hostname example.com"));
  check("hostname regex rejects a longer word", !matchesHostnameRegex("hostnames"));
}
}
