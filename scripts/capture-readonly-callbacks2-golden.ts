/**
 * PHASE 3 oracle (part 2): the remaining read-only danger callbacks.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * `man` reaches a man page path and can be made to render; `tput` can write terminal
 * capabilities; `ss` filters can contain a hex mask that makes it read any socket; and
 * `xargs` runs whatever command it is handed. Same rule as part 1: the permissive direction
 * is the dangerous one.
 *
 * Run: pnpm exec tsx scripts/capture-readonly-callbacks2-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import * as callbacks from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-callbacks.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

const CASES: { name: string; call: (args: string[]) => boolean }[] = [
  { name: "man_clean", call: (a) => callbacks.manCommandIsDangerous("man", a) },
  { name: "man_page_name", call: (a) => callbacks.manCommandIsDangerous("man", a) },
  { name: "man_path_operand", call: (a) => callbacks.manCommandIsDangerous("man", a) },
  { name: "man_apropos_allows_path", call: (a) => callbacks.manCommandIsDangerous("man", a) },
  { name: "man_after_double_dash", call: (a) => callbacks.manCommandIsDangerous("man", a) },
  { name: "man_value_flag_consumes", call: (a) => callbacks.manCommandIsDangerous("man", a) },
  { name: "man_single_dash", call: (a) => callbacks.manCommandIsDangerous("man", a) },

  { name: "tput_clean", call: (a) => callbacks.tputCommandIsDangerous("tput", a) },
  { name: "tput_set_store", call: (a) => callbacks.tputCommandIsDangerous("tput", a) },
  { name: "tput_attached_s", call: (a) => callbacks.tputCommandIsDangerous("tput", a) },
  { name: "tput_dangerous_capability", call: (a) => callbacks.tputCommandIsDangerous("tput", a) },
  { name: "tput_safe_capability", call: (a) => callbacks.tputCommandIsDangerous("tput", a) },
  { name: "tput_termtype_consumes", call: (a) => callbacks.tputCommandIsDangerous("tput", a) },
  { name: "tput_after_double_dash", call: (a) => callbacks.tputCommandIsDangerous("tput", a) },

  { name: "ss_clean", call: (a) => callbacks.ssCommandIsDangerous("ss", a) },
  { name: "ss_listening", call: (a) => callbacks.ssCommandIsDangerous("ss", a) },
  { name: "ss_state_keyword", call: (a) => callbacks.ssCommandIsDangerous("ss", a) },
  { name: "ss_hex_mask", call: (a) => callbacks.ssCommandIsDangerous("ss", a) },
  { name: "ss_port_keyword", call: (a) => callbacks.ssCommandIsDangerous("ss", a) },
  { name: "ss_value_flag_consumes", call: (a) => callbacks.ssCommandIsDangerous("ss", a) },
  { name: "ss_after_double_dash", call: (a) => callbacks.ssCommandIsDangerous("ss", a) },

  { name: "xargs_clean", call: (a) => callbacks.xargsCommandIsDangerous("xargs", a) },
  { name: "xargs_safe_target", call: (a) => callbacks.xargsCommandIsDangerous("xargs", a) },
  { name: "xargs_dangerous_target", call: (a) => callbacks.xargsCommandIsDangerous("xargs", a) },
  { name: "xargs_value_flag_consumes", call: (a) => callbacks.xargsCommandIsDangerous("xargs", a) },
  { name: "xargs_double_dash_target", call: (a) => callbacks.xargsCommandIsDangerous("xargs", a) },
  { name: "xargs_only_flags", call: (a) => callbacks.xargsCommandIsDangerous("xargs", a) },
];

const ARGV: Record<string, string[]> = {
  man_clean: ["bash"],
  man_page_name: ["1", "bash"],
  man_path_operand: ["/etc/man/bash.1"],
  man_apropos_allows_path: ["-k", "/usr/share/man/bash"],
  man_after_double_dash: ["--", "/etc/man/bash.1"],
  man_value_flag_consumes: ["-S", "1", "/etc/man/bash.1"],
  man_single_dash: ["-", "bash"],

  tput_clean: ["cols", "lines"],
  tput_set_store: ["-S"],
  tput_attached_s: ["-Scaps"],
  tput_dangerous_capability: ["clear"],
  tput_safe_capability: ["bel"],
  tput_termtype_consumes: ["-T", "xterm", "clear"],
  tput_after_double_dash: ["--", "clear"],

  ss_clean: ["-t", "tcp"],
  ss_listening: ["-ltn"],
  ss_state_keyword: ["state", "listening"],
  ss_hex_mask: ["dst", "0100007F"],
  ss_port_keyword: ["dport", ":22"],
  ss_value_flag_consumes: ["-f", "inet", "state", "established"],
  ss_after_double_dash: ["--", "state", "listening"],

  xargs_clean: ["-n", "1", "echo"],
  xargs_safe_target: ["echo"],
  xargs_dangerous_target: ["rm"],
  xargs_value_flag_consumes: ["-I", "{}", "wc"],
  xargs_double_dash_target: ["--", "grep"],
  xargs_only_flags: ["-0"],
};

const results: Record<string, { dangerous: boolean; args: string[] }> = {};
for (const testCase of CASES) {
  results[testCase.name] = {
    dangerous: testCase.call(ARGV[testCase.name] ?? []),
    args: ARGV[testCase.name] ?? [],
  };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/readonly-callbacks2-golden.json`, JSON.stringify(results, null, 2) + "\n");
const dangerous = Object.values(results).filter((entry) => entry.dangerous).length;
console.log(`captured ${CASES.length} cases (${dangerous} dangerous, ${CASES.length - dangerous} clean)`);
for (const [name, entry] of Object.entries(results)) {
  if (entry.dangerous) console.log(`  DANGEROUS  ${name.padEnd(30)} ${JSON.stringify(entry.args)}`);
}
