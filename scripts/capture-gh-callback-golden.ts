/**
 * PHASE 3 oracle: the `gh` danger callback (the last TypeScript danger callback).
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * `gh` is on the read-only multiword list (`gh auth status`), but a `gh` argument naming a
 * different `owner/repo`, a URL, or `user@host` can point the CLI at another host. This
 * callback rejects those so the read-only entry cannot be used to reach out.
 *
 * Run: pnpm exec tsx scripts/capture-gh-callback-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import { ghCommandIsDangerous } from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-callbacks.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

const ARGV: Record<string, string[]> = {
  gh_empty: [],
  gh_bare: ["status"],
  gh_auth_status: ["auth", "status"],
  gh_owner_repo: ["cli/cli"],
  gh_owner_repo_two_slashes: ["a/b/c"],
  gh_single_slash: ["cli/"],
  gh_url: ["https://evil.example.com"],
  gh_at_host: ["user@evil.example.com"],
  gh_eq_repo: ["--repo=other/other"],
  gh_eq_url: ["--repo=https://evil"],
  gh_eq_empty: ["--repo="],
  gh_flag_no_eq: ["--json"],
  gh_dash_prefix_ignored: ["-R", "owner/repo"],
};

const results: Record<string, { dangerous: boolean; args: string[] }> = {};
for (const [name, args] of Object.entries(ARGV)) {
  results[name] = { dangerous: ghCommandIsDangerous("gh", args), args };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/gh-callback-golden.json`, JSON.stringify(results, null, 2) + "\n");
const dangerous = Object.values(results).filter((entry) => entry.dangerous).length;
console.log(`captured ${Object.keys(ARGV).length} gh cases (${dangerous} dangerous, ${Object.keys(ARGV).length - dangerous} clean)`);
for (const [name, entry] of Object.entries(results)) {
  if (entry.dangerous) console.log(`  DANGEROUS  ${name}  ${JSON.stringify(entry.args)}`);
}
