/**
 * PHASE 3 oracle: capture the read-only command danger callbacks.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * These decide whether a known "read-only" command actually writes. Each one closes a real
 * vector: `sed -i` rewrites the file, `sed 'w out'` writes it, `date -f` writes it, `jq
 * --rawfile` reads an arbitrary path, `lsof -i @host` talks to a remote host. Wrong in the
 * permissive direction and a write runs with no permission prompt.
 *
 * Run: pnpm exec tsx scripts/capture-readonly-callbacks-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import * as callbacks from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-callbacks.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

const CASES: { name: string; call: (args: string[]) => boolean }[] = [
  // --- sed: in-place and the `w` command both write. ---
  { name: "sed_clean", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_in_place_short", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_in_place_long", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_in_place_suffix", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_expression_inline", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_expression_write", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_expression_inline_write", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_expression_clean", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_write_command", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_write_after_semicolon", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_write_in_double_quotes_only", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_line_length_skips", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_after_double_dash", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },
  { name: "sed_multiple_scripts", call: (a) => callbacks.sedCommandIsDangerous("sed", a) },

  // --- jq: --rawfile/--slurpfile/--argfile read paths; env/include execute. ---
  { name: "jq_clean", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_rawfile", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_rawfile_inline", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_slurpfile", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_argfile", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_from_file", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_library_path", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_run_tests", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_f_flag", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_env_in_filter", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_env_object_in_filter", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_include_in_filter", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_import_in_filter", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_environment_word_is_not_env", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_indent_skips_value", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },
  { name: "jq_double_dash_filter", call: (a) => callbacks.jqCommandIsDangerous("jq", a) },

  // --- date: `-f FILE` writes the file. ---
  { name: "date_clean", call: (a) => callbacks.dateCommandIsDangerous("date", a) },
  { name: "date_writes_file", call: (a) => callbacks.dateCommandIsDangerous("date", a) },
  { name: "date_output_operand", call: (a) => callbacks.dateCommandIsDangerous("date", a) },
  { name: "date_format_is_allowed", call: (a) => callbacks.dateCommandIsDangerous("date", a) },
  { name: "date_value_flag_consumes", call: (a) => callbacks.dateCommandIsDangerous("date", a) },
  { name: "date_inline_value_flag", call: (a) => callbacks.dateCommandIsDangerous("date", a) },

  // --- lsof: `-i @host` reaches a remote host. ---
  { name: "lsof_clean", call: (a) => callbacks.lsofCommandIsDangerous("lsof", a) },
  { name: "lsof_remote_host", call: (a) => callbacks.lsofCommandIsDangerous("lsof", a) },
  { name: "lsof_remote_host_value_next", call: (a) => callbacks.lsofCommandIsDangerous("lsof", a) },
  { name: "lsof_port_no_host", call: (a) => callbacks.lsofCommandIsDangerous("lsof", a) },
  { name: "lsof_plus_m", call: (a) => callbacks.lsofCommandIsDangerous("lsof", a) },

  // --- the single-argument predicates ---
  { name: "ps_everything", call: (a) => callbacks.psCommandIsDangerous("ps", a) },
  { name: "ps_clean", call: (a) => callbacks.psCommandIsDangerous("ps", a) },
  { name: "ps_flag_e", call: (a) => callbacks.psCommandIsDangerous("ps", a) },
  { name: "pyright_watch_long", call: (a) => callbacks.pyrightCommandIsDangerous("pyright", a) },
  { name: "pyright_watch_short", call: (a) => callbacks.pyrightCommandIsDangerous("pyright", a) },
  { name: "pyright_clean", call: (a) => callbacks.pyrightCommandIsDangerous("pyright", a) },

  // --- test: a non-numeric argument to a numeric operator is a command. ---
  { name: "test_clean", call: (a) => callbacks.testCommandIsDangerous("test", a) },
  { name: "test_bracket", call: (a) => callbacks.testCommandIsDangerous("test", a) },
  { name: "test_and_or", call: (a) => callbacks.testCommandIsDangerous("test", a) },
  { name: "test_numeric_ok", call: (a) => callbacks.testCommandIsDangerous("test", a) },
  { name: "test_numeric_with_command", call: (a) => callbacks.testCommandIsDangerous("test", a) },
  { name: "test_tty_flag", call: (a) => callbacks.testCommandIsDangerous("test", a) },
];

const ARGV: Record<string, string[]> = {
  sed_clean: ["-n", "s/a/b/p", "file.txt"],
  sed_in_place_short: ["-i", "s/a/b/", "file.txt"],
  sed_in_place_long: ["--in-place", "s/a/b/", "file.txt"],
  sed_in_place_suffix: ["-i.bak", "s/a/b/", "file.txt"],
  sed_expression_inline: ["-e", "s/a/b/", "file.txt"],
  sed_expression_write: ["-e", "s/a/b/ w out.txt", "file.txt"],
  sed_expression_inline_write: ["--expression=s/a/b/ w out.txt", "file.txt"],
  sed_expression_clean: ["--expression=s/a/b/", "file.txt"],
  sed_write_command: ["s/a/b/w out.txt", "file.txt"],
  sed_write_after_semicolon: ["s/a/b/; w out.txt", "file.txt"],
  sed_write_in_double_quotes_only: ['s/w/word/', "file.txt"],
  sed_line_length_skips: ["-l", "80", "s/a/b/", "file.txt"],
  sed_after_double_dash: ["--", "s/a/b/w out.txt"],
  sed_multiple_scripts: ["-n", "p", "-e", "s/a/b/ w out.txt", "file.txt"],

  jq_clean: [".name", "file.json"],
  jq_rawfile: ["--rawfile", "x", "/etc/shadow"],
  jq_rawfile_inline: ["--rawfile=x:/etc/shadow", ".name"],
  jq_slurpfile: ["--slurpfile", "x", "/etc/shadow"],
  jq_argfile: ["--argfile", "x", "/etc/shadow"],
  jq_from_file: ["--from-file", "/tmp/f.jq"],
  jq_library_path: ["--library-path", "/tmp/libs"],
  jq_run_tests: ["--run-tests"],
  jq_f_flag: ["-f", "/tmp/f.jq"],
  jq_env_in_filter: ["$ENV.PATH"],
  jq_env_object_in_filter: [".a | env.PATH"],
  jq_include_in_filter: ["include \"x\""],
  jq_import_in_filter: ["import \"x\" as y"],
  jq_environment_word_is_not_env: [".environment"],
  jq_indent_skips_value: ["--indent", "4", ".name"],
  jq_double_dash_filter: ["--", "$ENV.HOME"],

  date_clean: ["-u"],
  date_writes_file: ["/tmp/out.txt"],
  date_output_operand: ["+%Y"],
  date_format_is_allowed: ["+%Y-%m-%d"],
  date_value_flag_consumes: ["-d", "yesterday", "+%s"],
  date_inline_value_flag: ["--date=yesterday", "+%s"],

  lsof_clean: ["-i", "TCP:80"],
  lsof_remote_host: ["-i@evil.example.com:22"],
  lsof_remote_host_value_next: ["-i", "@evil.example.com:22"],
  lsof_port_no_host: ["-i", ":80"],
  lsof_plus_m: ["+m"],

  ps_everything: ["e", "-"],
  ps_clean: ["aux"],
  ps_flag_e: ["-e"],
  pyright_watch_long: ["--watch", "src"],
  pyright_watch_short: ["-w", "src"],
  pyright_clean: ["--outputjson", "src"],

  test_clean: ["1", "-eq", "1"],
  test_bracket: ["[", "1", "=", "1", "]"],
  test_and_or: ["1", "-a", "2"],
  test_numeric_ok: ["5", "-gt", "3"],
  test_numeric_with_command: ["5", "-gt", "$(rm -rf /)"],
  test_tty_flag: ["-t", "0"],
};

const results: Record<string, { dangerous: boolean; args: string[] }> = {};
for (const testCase of CASES) {
  results[testCase.name] = {
    dangerous: testCase.call(ARGV[testCase.name] ?? []),
    args: ARGV[testCase.name] ?? [],
  };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/readonly-callbacks-golden.json`, JSON.stringify(results, null, 2) + "\n");
const dangerous = Object.values(results).filter((entry) => entry.dangerous).length;
console.log(`captured ${CASES.length} callback cases (${dangerous} dangerous, ${CASES.length - dangerous} clean)`);
for (const [name, entry] of Object.entries(results)) {
  if (entry.dangerous) console.log(`  DANGEROUS  ${name.padEnd(34)} ${JSON.stringify(entry.args).slice(0, 62)}`);
}
