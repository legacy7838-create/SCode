import type { ExecutionResult } from "@zcode/contracts";
import { analyzeBashCommand, type BashCommandAnalysis } from "./bash-command-parser.js";
import {
  evaluateBashSemantics,
  type BashAnalysis,
} from "@zcode/rust/subagent-bash-semantics";
import {
  analysisContainsGitAndDirectoryChange,
  analysisContainsGitCommand,
  isGitRuntimeContextUnsafe,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
import {
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
} from "./bash-readonly-policy.js";
import { isSedInPlaceOption } from "@zcode/rust/subagent-profile";
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(["", ":", "echo", "false", "printf", "true"]);
const BASH_SILENT_COMMANDS = new Set([
  "cd",
  "chgrp",
  "chmod",
  "chown",
  "cp",
  "export",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "touch",
  "unset",
  "wait",
]);
const SEMANTIC_NON_ERROR_MESSAGES = new Set([
  "Condition is false",
  "Files differ",
  "No matches found",
  "Some directories were inaccessible",
]);
const SEMANTIC_NO_MATCH_COMMANDS = new Set(["egrep", "fgrep", "grep", "rg"]);

export function isRuntimeReadOnlyBashCommand(
  command: string,
  context?: BashReadonlyRuntimeContext,
): boolean {
  return isRuntimeReadOnlyBashCommandForAnalysis(analyzeBashCommand(command), context);
}

/**
 * The read-only decision for an ALREADY-PARSED command line.
 *
 * Exported so the Rust owner can be golden-tested against it
 * (docs/specs/subagent-rust-port.md Phase 4): this is the whole post-parse policy, and only
 * the grammar parse itself is left in TypeScript.
 */
export function isRuntimeReadOnlyBashCommandForAnalysis(
  analysis: BashCommandAnalysis,
  context?: BashReadonlyRuntimeContext,
): boolean {
  return evaluateBashSemantics(toNativeAnalysis(analysis), context?.workingDirectory).readOnly;
}

/**
 * The grammar's `BashCommandAnalysis` in the shape the Rust boundary takes. Only the fields
 * the policy reads are carried; the grammar stays the owner of parsing.
 */
function toNativeAnalysis(analysis: BashCommandAnalysis): BashAnalysis {
  return {
    commands: analysis.commands.map((part) => ({
      name: part.name,
      argv: part.argv,
      commandText: part.commandText,
      envAssignments: part.envAssignments,
      redirects: part.redirects,
      ...(part.operatorBefore === undefined ? {} : { operatorBefore: part.operatorBefore }),
    })),
    hasParseErrors: analysis.hasParseErrors,
    hasRedirects: analysis.hasRedirects,
    hasDynamicWords: analysis.hasDynamicWords,
    hasUnsupportedSyntax: analysis.hasUnsupportedSyntax,
  };
}

export function isSedInPlaceBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors) return false;
  return analysis.commands.some(
    (commandPart) => commandPart.name === "sed" && commandPart.argv.some(isSedInPlaceOption),
  );
}

export function isSilentBashCommand(command: string): boolean {
  return evaluateBashSemantics(toNativeAnalysis(analyzeBashCommand(command))).silent;
}

export function interpretBashReturnCode(
  command: string,
  result: Pick<ExecutionResult, "error" | "exitCode" | "signal" | "status">,
): string | undefined {
  if (result.error?.type === "output_limit") {
    return "Command stopped because output exceeded the configured limit";
  }
  if (result.status === "timed_out") return "Command timed out";
  if (result.status === "cancelled") return "Command was cancelled";
  if (result.status === "spawn_error") return "Command failed to start";
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    const semantic = semanticNonErrorExit(command, result.exitCode);
    return semantic ?? `Command exited with code ${result.exitCode}`;
  }
  if (result.signal) return `Command exited due to signal ${result.signal}`;
  return undefined;
}

function isSemanticNonErrorInterpretation(message: string | undefined): boolean {
  return message !== undefined && SEMANTIC_NON_ERROR_MESSAGES.has(message);
}

export function isBashProviderErrorStatus(output: {
  exitCode?: unknown;
  returnCodeInterpretation?: unknown;
  status?: unknown;
}): boolean {
  if (output.status !== "failed") return false;
  if (typeof output.exitCode !== "number" || output.exitCode === 0) return false;
  return !isSemanticNonErrorInterpretation(
    typeof output.returnCodeInterpretation === "string"
      ? output.returnCodeInterpretation
      : undefined,
  );
}

function semanticNonErrorExit(command: string, exitCode: number): string | undefined {
  if (exitCode !== 1) return undefined;
  const commandName = statusCommandNameForExitOne(command);
  return commandName === undefined ? undefined : semanticExitOneInterpretation(commandName);
}

function statusCommandNameForExitOne(command: string): string | undefined {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax) return undefined;
  const statusCommand = analysis.commands.at(-1);
  if (statusCommand === undefined) return undefined;

  // Just because rg/grep appears before the command line, the 1 in subsequent test/exit cannot be misjudged as No matches found.
  if (statusCommand.name === "git") {
    const gitSubcommand = gitSemanticSubcommandName(statusCommand.argv);
    if (gitSubcommand === "grep") return "grep";
    if (gitSubcommand === "diff") return "diff";
  }
  return statusCommand.name;
}

function semanticExitOneInterpretation(commandName: string): string | undefined {
  if (SEMANTIC_NO_MATCH_COMMANDS.has(commandName)) return "No matches found";
  if (commandName === "find") return "Some directories were inaccessible";
  if (commandName === "diff") return "Files differ";
  if (commandName === "test" || commandName === "[") return "Condition is false";
  return undefined;
}

function gitSemanticSubcommandName(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      if (arg === "-C" || arg === "-c") index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}
