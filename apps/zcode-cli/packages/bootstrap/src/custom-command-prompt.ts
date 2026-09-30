import {
  expandCustomCommandPrompt,
  expandCustomCommandTemplate,
  formatCustomCommandPrompt,
  type ExecutionPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { loadZCodeCustomCommand, type ListZCodeCustomCommandsOptions } from "./custom-commands.js";
import { expandCustomCommandShellSyntax } from "./custom-command-shell-expansion.js";
import { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";

const CUSTOM_COMMAND_NOT_FOUND_PATTERN = /not found/i;
const PROMPT_CUSTOM_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

interface ResolveZCodeCustomCommandPromptOptions extends ListZCodeCustomCommandsOptions {
  executionPort?: ExecutionPort;
  sessionId?: SessionId;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}

export async function resolveZCodeCustomCommandPrompt(
  input: string,
  options: ResolveZCodeCustomCommandPromptOptions = {},
): Promise<string | undefined> {
  const invocation = parsePromptCustomCommandInvocation(input);
  // Reserved names (including built-in `workflow`) directly return undefined here, which is the same as "command does not exist": the built-in command is
  // Builtin-prompt-command.ts is expanded first. What is rejected here is the path to bypass built-in semantics (or function switches) by using custom commands with the same name.
  if (!invocation || isReservedZCodeSlashCommandName(invocation.name)) {
    return undefined;
  }

  try {
    const command = await loadZCodeCustomCommand({
      ...options,
      name: invocation.name,
    });
    if (options.executionPort) {
      // When calling slash command, execute it first and replace the output to avoid unsupported errors.
      // Make the UI stuck in "thinking" for a long time after throwing before turn is created.
      //
      // Reuse contracts' underlying template/format functions instead of expandCustomCommandPrompt:
      // In the latter, detectUnsupportedDynamicSyntax will directly throw an error for the `!` syntax, and this path
      // Exactly to support shell expansion, it can only be used between expandCustomCommandTemplate and
      // Insert expandCustomCommandShellSyntax between formatCustomCommandPrompt.
      const expanded = expandCustomCommandTemplate({
        args: invocation.args,
        command,
      });
      const body = await expandCustomCommandShellSyntax({
        command,
        content: expanded.body,
        executionPort: options.executionPort,
        sessionId: options.sessionId,
        signal: options.signal,
        traceContext: options.traceContext,
        workingDirectory: options.workingDirectory ?? process.cwd(),
      });
      return formatCustomCommandPrompt({
        argumentCount: expanded.argumentCount,
        body,
        command,
        usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
      }).prompt;
    }
    return expandCustomCommandPrompt({
      args: invocation.args,
      command,
    }).prompt;
  } catch (error) {
    if (error instanceof Error && CUSTOM_COMMAND_NOT_FOUND_PATTERN.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function parsePromptCustomCommandInvocation(input: string): { args: string; name: string } | null {
  const match = PROMPT_CUSTOM_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}
