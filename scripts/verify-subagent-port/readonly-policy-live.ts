/** Verification section: readonly-policy-live. See docs/specs/subagent-rust-port.md. */
import { readFileSync } from "node:fs";
import { evaluateBashReadonlyPolicy, hasKnownBashWriteOption } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
  // The read-only DECISION is Rust now; only the grammar parse (`unbash`) stays in TypeScript.
  // The verdict is three-way and `undefined` ("no opinion") must never collapse into a denial
  // or a pass, so the corpus asserts all three outcomes are present.
  const golden = JSON.parse(readFileSync("apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-policy-golden.json", "utf8")) as {
    cases: { name: string; input: any }[];
    verdicts: Record<string, boolean | null>;
  };
  let mismatches = 0;
  const counts = { t: 0, f: 0, n: 0 };
  for (const testCase of golden.cases) {
    const actual = evaluateBashReadonlyPolicy(testCase.input);
    const expected = golden.verdicts[testCase.name];
    if (actual === undefined) counts.n += 1;
    else if (actual) counts.t += 1;
    else counts.f += 1;
    const same = (actual === undefined && expected === null) || actual === expected;
    if (!same) { mismatches += 1; check(`readonly golden ${testCase.name}`, false); }
  }
  check(`all ${golden.cases.length} read-only golden cases reproduce`, mismatches === 0);
  check(`three-way corpus intact (${counts.t} read-only / ${counts.f} not / ${counts.n} no-opinion)`,
    counts.t > 0 && counts.f > 0 && counts.n > 0);

  const inv = (argv: string[]) => ({ argv, commandText: argv.join(" "), envAssignments: [], redirects: [] });
  check("git status stays read-only", evaluateBashReadonlyPolicy(inv(["git", "status"])) === true);
  check("git push stays denied", evaluateBashReadonlyPolicy(inv(["git", "push"])) === false);
  check("find -delete stays denied", evaluateBashReadonlyPolicy(inv(["find", ".", "-delete"])) === false);
  check("gh auth status stays read-only", evaluateBashReadonlyPolicy(inv(["gh", "auth", "status"])) === true);
  check("gh auth login keeps no opinion", evaluateBashReadonlyPolicy(inv(["gh", "auth", "login"])) === undefined);

  check("sed -i has a known write", hasKnownBashWriteOption(["sed", "-i", "s/a/b/", "f"]));
  check("sed without -i has none", !hasKnownBashWriteOption(["sed", "-n", "p", "f"]));
  check("tree -o has a known write", hasKnownBashWriteOption(["tree", "-o", "out.png"]));
  check("git -c has a known write", hasKnownBashWriteOption(["git", "-c", "core.pager=sh", "log"]));
  check("cat has no known write", !hasKnownBashWriteOption(["cat", "f"]));
}
}
