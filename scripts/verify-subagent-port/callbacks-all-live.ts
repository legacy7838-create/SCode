/** Verification section: callbacks-all-live. See docs/specs/subagent-rust-port.md. */
import { isSedInPlaceOption, readonlyCallbackIsDangerous } from "../../packages/rust/src/subagentProfile.ts";
import * as ts from "../../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-callbacks.ts";
import { check } from "./harness.js";

export function run(): void {
{
// Phase 3 live proof: all 11 Rust-owned danger callbacks, verified against TS.
const pairs: [string, (a: string[]) => boolean][] = [
  ["sed", ts.sedCommandIsDangerous], ["jq", ts.jqCommandIsDangerous],
  ["date", ts.dateCommandIsDangerous], ["ps", ts.psCommandIsDangerous],
  ["pyright", ts.pyrightCommandIsDangerous], ["man", ts.manCommandIsDangerous],
  ["lsof", ts.lsofCommandIsDangerous], ["tput", ts.tputCommandIsDangerous],
  ["ss", ts.ssCommandIsDangerous], ["test", ts.testCommandIsDangerous],
  ["xargs", ts.xargsCommandIsDangerous],
];
const probes: string[][] = [
  [], ["-i", "s/a/b/", "f"], ["--in-place=x", "f"], ["s/a/b/; w out", "f"],
  ["--rawfile", "v", "/etc/shadow"], ["$ENV.X"], ["include \"m\""], [".env"],
  ["/etc/passwd"], ["+%Y"], ["-Scaps"], ["clear"], ["bel"], ["-t", "tcp"],
  ["state", "listening"], ["dst", "0100"], ["-i@h:1"], ["-i", ":80"], ["+m"],
  ["e"], ["-e"], ["--watch"], ["5", "-gt", "$(id)"], ["5", "-gt", "3"],
  ["1", "-a", "2"], ["rm"], ["echo"], ["-n", "1", "echo"], ["/x/y.1"], ["-k", "/x/y"],
  ["-T", "xterm", "clear"], ["--", "clear"], ["-n", "1"],
];
let mismatches = 0;
for (const [name, tsFn] of pairs) {
  for (const args of probes) {
    const rust = readonlyCallbackIsDangerous(name as any, args);
    const reference = tsFn("", args);
    if (rust !== reference) { mismatches++; check(`${name} ${JSON.stringify(args)}`, false); }
  }
}
check(`all 11 callbacks agree with TS across ${pairs.length * probes.length} probes`, mismatches === 0);
// the write vectors stay closed
check("sed -i closed", readonlyCallbackIsDangerous("sed", ["-i", "s/a/b/", "f"]));
check("sed w closed", readonlyCallbackIsDangerous("sed", ["s/a/b/; w out", "f"]));
check("jq rawfile closed", readonlyCallbackIsDangerous("jq", ["--rawfile", "v", "/etc/shadow"]));
check("date write closed", readonlyCallbackIsDangerous("date", ["/etc/passwd"]));
check("lsof remote closed", readonlyCallbackIsDangerous("lsof", ["-i@h:1"]));
check("tput store closed", readonlyCallbackIsDangerous("tput", ["-S"]));
check("xargs rm closed", readonlyCallbackIsDangerous("xargs", ["rm"]));
// and the clean cases stay clean
check("jq clean stays clean", !readonlyCallbackIsDangerous("jq", [".name"]));
check("date format stays clean", !readonlyCallbackIsDangerous("date", ["+%Y"]));
check("xargs echo stays clean", !readonlyCallbackIsDangerous("xargs", ["echo"]));
// isSedInPlaceOption has one owner too
check("isSedInPlaceOption agrees", isSedInPlaceOption("-i") && isSedInPlaceOption("--in-place") && !isSedInPlaceOption("-p"));
check("isSedInPlaceOption matches TS", isSedInPlaceOption("-i.bak") === ts.isSedInPlaceOption("-i.bak"));
let threw = false;
try { readonlyCallbackIsDangerous("nope" as any, []); } catch { threw = true; }
check("unknown callback throws loudly", threw);
}
}
