/** Verification section: callbacks-all-live. See docs/specs/subagent-rust-port.md. */
import { readFileSync } from "node:fs";
import { isSedInPlaceOption, readonlyCallbackIsDangerous } from "../../packages/rust/src/subagentProfile.ts";
import type { ReadonlyDangerCallbackName } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

/** Golden corpus path -> the Rust dispatch name each case-name prefix maps to. */
const CORPORA = [
  ["apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-callbacks-golden.json", {
    jq_: "jq", sed_: "sed", date_: "date", lsof_: "lsof", ps_: "ps",
    pyright_: "pyright", test_: "test",
  }],
  ["apps/zcode-cli/packages/core/testdata/agent-profiles/readonly-callbacks2-golden.json", {
    man_: "man", tput_: "tput", ss_: "ss", xargs_: "xargs",
  }],
  ["apps/zcode-cli/packages/core/testdata/agent-profiles/gh-callback-golden.json", {
    gh_: "gh",
  }],
] as const;

export function run(): void {
  // The TypeScript adapters this section used to cross-check are gone — that is the point
  // of the port. The oracle is the RECORDED golden corpus, which is stronger than a live
  // re-implementation: it is the exact output the Rust code was proved against.
  let total = 0;
  let mismatches = 0;
  for (const [goldenPath, nameFor] of CORPORA) {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<
      string,
      { dangerous: boolean; args: string[] }
    >;
    for (const [name, entry] of Object.entries(golden)) {
      const prefix = Object.keys(nameFor).find((candidate) => name.startsWith(candidate)) as
        | keyof typeof nameFor
        | undefined;
      if (prefix === undefined) continue;
      total += 1;
      const key = nameFor[prefix] as ReadonlyDangerCallbackName;
      if (readonlyCallbackIsDangerous(key, entry.args) !== entry.dangerous) {
        mismatches += 1;
        check(`callback golden ${name}`, false);
      }
    }
  }
  check(`all ${total} danger-callback golden cases reproduce`, mismatches === 0);

  // The write vectors, asserted by intent rather than by fixture name, because a
  // regression should say which command opened.
  check("sed -i closed", readonlyCallbackIsDangerous("sed", ["-i", "s/a/b/", "f.txt"]));
  check("sed w-after-semicolon closed", readonlyCallbackIsDangerous("sed", ["s/a/b/; w out.txt", "f.txt"]));
  check("sed w-mid-substitution stays clean", !readonlyCallbackIsDangerous("sed", ["s/a/b/ w out.txt", "f.txt"]));
  check("jq rawfile closed", readonlyCallbackIsDangerous("jq", ["--rawfile", "x", "/etc/shadow"]));
  check("jq env closed", readonlyCallbackIsDangerous("jq", ["include \"x\""]));
  check("date write closed", readonlyCallbackIsDangerous("date", ["/etc/passwd"]));
  check("lsof remote closed", readonlyCallbackIsDangerous("lsof", ["-i@h:1"]));
  check("tput store closed", readonlyCallbackIsDangerous("tput", ["-S"]));
  check("xargs rm closed", readonlyCallbackIsDangerous("xargs", ["rm"]));
  check("gh host target closed", readonlyCallbackIsDangerous("gh", ["user@evil"]));

  // ...and the clean cases must STAY clean: a policy that rejects everything is not a policy.
  check("jq clean stays clean", !readonlyCallbackIsDangerous("jq", [".name"]));
  check("date format stays clean", !readonlyCallbackIsDangerous("date", ["+%Y"]));
  check("xargs echo stays clean", !readonlyCallbackIsDangerous("xargs", ["echo"]));
  check("gh auth status stays clean", !readonlyCallbackIsDangerous("gh", ["auth", "status"]));

  // `isSedInPlaceOption` has one owner too.
  check("isSedInPlaceOption agrees", isSedInPlaceOption("-i") && isSedInPlaceOption("--in-place") && !isSedInPlaceOption("-p"));
  check("isSedInPlaceOption takes a suffix", isSedInPlaceOption("-i.bak"));

  // An unknown name is a LOUD failure, never a silent "safe".
  let threw = false;
  try {
    readonlyCallbackIsDangerous("nope" as ReadonlyDangerCallbackName, []);
  } catch {
    threw = true;
  }
  check("unknown callback throws loudly", threw);
}
