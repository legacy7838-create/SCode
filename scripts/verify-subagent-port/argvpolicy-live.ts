/** Verification section: argvpolicy-live. See docs/specs/subagent-rust-port.md. */
import { isArgvAllowedByPolicy } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
// Phase 3 live proof: the read-only flag policy runs in Rust.
const gitLog = { safeFlags: { "--oneline": "none", "-n": "string", "--max-count": "number" } } as const;
// 1. clean read-only invocations pass
check("git --oneline passes", isArgvAllowedByPolicy(["git", "--oneline"], gitLog, "git"));
check("git -n 5 passes", isArgvAllowedByPolicy(["git", "-n", "5"], gitLog, "git"));
check("positional is skipped", isArgvAllowedByPolicy(["git", "HEAD", "--oneline"], gitLog, "git", 2));
// 2. WRITE flags must be rejected — the permissive direction is the dangerous one
check("--output rejected", !isArgvAllowedByPolicy(["git", "--output=/etc/x"], gitLog, "git"));
check("--force rejected", !isArgvAllowedByPolicy(["git", "log", "--force"], gitLog, "git"));
check("--oneline=x rejected", !isArgvAllowedByPolicy(["git", "--oneline=x"], gitLog, "git"));
check("--max-count ten rejected", !isArgvAllowedByPolicy(["git", "--max-count", "ten"], gitLog, "git"));
check("--max-count with no value rejected", !isArgvAllowedByPolicy(["git", "--max-count"], gitLog, "git"));
// 3. xargs target checking (the policy must inspect the TARGET, not the flags)
check("xargs echo is safe", isArgvAllowedByPolicy(["xargs", "echo", "hi"], { safeFlags: {} }, "xargs"));
check("xargs rm is rejected", !isArgvAllowedByPolicy(["xargs", "rm", "-rf"], { safeFlags: {} }, "xargs"));
// 4. empty safeFlags table still walks (JS truthiness) — this is the bug the golden caught
check("empty table allows head -20", isArgvAllowedByPolicy(["head", "-20"], { safeFlags: {} }, "head"));
check("empty table still rejects unknown", !isArgvAllowedByPolicy(["head", "--danger"], { safeFlags: {} }, "head"));
// 5. absent safeFlags is rejected outright
check("absent safeFlags rejects", !isArgvAllowedByPolicy(["x", "--y"], {}, "x"));
check("allowAnyArgs permits", isArgvAllowedByPolicy(["x", "--anything"], { allowAnyArgs: true }, "x"));
check("commandOnly rejects args", !isArgvAllowedByPolicy(["x", "arg"], { commandOnly: true }, "x"));
check("empty argv rejects", !isArgvAllowedByPolicy([], { allowAnyArgs: true }, "x"));
// 6. value kinds
const kinds = { safeFlags: { "--num": "number", "--ch": "char", "--braces": "{}", "--eof": "EOF" } } as const;
check("number kind ok", isArgvAllowedByPolicy(["k", "--num", "42"], kinds, "k"));
check("char kind too long", !isArgvAllowedByPolicy(["k", "--ch", "xy"], kinds, "k"));
check("braces kind ok", isArgvAllowedByPolicy(["k", "--braces", "{}"], kinds, "k"));
check("eof kind wrong", !isArgvAllowedByPolicy(["k", "--eof", "END"], kinds, "k"));
}
}
