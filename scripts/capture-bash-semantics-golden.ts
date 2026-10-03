/**
 * PHASE 4 oracle: the post-parse bash permission policy.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 4).
 *
 * This is everything the read-only flow decides AFTER the grammar has split a command line:
 * whether the analysis is permission-safe, whether the whole line is read-only, whether it is
 * silent, and what an exit code of 1 means. Captured from analyses produced by the REAL
 * grammar, so the corpus includes the shapes a hand-written fixture would miss (`&&` chains,
 * redirects, subshells, dynamic words, parse errors).
 *
 * Run: pnpm exec tsx scripts/capture-bash-semantics-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import { analyzeBashCommand, isBashCommandPermissionSafe } from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.js";
import {
  isRuntimeReadOnlyBashCommandForAnalysis,
  isSilentBashCommand,
} from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.js";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

/** Real command lines: the grammar decides how each one splits. */
const COMMANDS: [string, string][] = [
  ["single_read", "ls"],
  ["git_status", "git status"],
  ["chained_and", "ls && git status"],
  ["chained_or", "ls || rm -rf /"],
  ["pipeline", "cat file | grep pattern"],
  ["git_push_denied", "git push"],
  ["redirect_output", "cat file > out.txt"],
  ["redirect_input", "cat < file"],
  ["subshell", "(cd /tmp && ls)"],
  ["command_substitution", "echo $(rm -rf /)"],
  ["dynamic_var", "ls $HOME"],
  ["glob", "ls *.ts"],
  ["env_prefix", "LANG=C ls"],
  ["empty", ""],
  ["only_whitespace", "   "],
  ["parse_error", "ls | | |"],
  ["unbalanced_quote", "echo 'unterminated"],
  ["background_and", "ls & git status"],
  ["semicolon", "ls; git status"],
  ["cd_then_git", "cd /tmp && git status"],
  ["find_delete", "find . -delete"],
  ["sed_in_place", "sed -i 's/a/b/' file"],
  ["cat_only", "cat file.txt"],
  ["true_command", "true"],
  ["false_command", "false"],
  ["echo_only", "echo hi"],
  ["colon_only", ":"],
  ["unknown_command", "zzz-not-a-command"],
  ["nested_wrappers", "command env ls"],
  ["sudo_denied", "sudo ls"],
];

const results: Record<string, unknown> = {};
for (const [name, command] of COMMANDS) {
  const analysis = analyzeBashCommand(command);
  results[name] = {
    command,
    permissionSafe: isBashCommandPermissionSafe(analysis),
    readOnly: isRuntimeReadOnlyBashCommandForAnalysis(analysis),
    silent: isSilentBashCommand(command),
    // The parsed shape, so the Rust side can be fed exactly this.
    commands: analysis.commands.map((part) => ({
      name: part.name,
      argv: part.argv,
      commandText: part.commandText,
      envAssignments: part.envAssignments,
      redirects: part.redirects,
      operatorBefore: part.operatorBefore ?? null,
    })),
    hasParseErrors: analysis.hasParseErrors,
    hasRedirects: analysis.hasRedirects,
    hasDynamicWords: analysis.hasDynamicWords,
    hasUnsupportedSyntax: analysis.hasUnsupportedSyntax,
  };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/bash-semantics-golden.json`, JSON.stringify(results, null, 2) + "\n");
let readOnly = 0;
for (const [name, value] of Object.entries(results as Record<string, any>)) {
  if (value.readOnly) readOnly += 1;
  console.log(`  ${name.padEnd(24)} safe=${String(value.permissionSafe).padEnd(5)} ro=${String(value.readOnly).padEnd(5)} silent=${value.silent}`);
}
console.log(`captured ${COMMANDS.length} command lines (${readOnly} read-only)`);
