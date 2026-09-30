import { expandCustomCommandPrompt, type CustomCommandContent } from "@zcode/contracts";
import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } from "@zcode/shared";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "./app/bundled-skills.js";

/**
 * The built-in `/workflow` command.
 * The command body ships compiled with the CLI, a code-defined prompt command like `/init`, not dependent on
 * an uninstallable plugin.
 * The command name enters the reserved word table, so a user or plugin command of the same name is not expanded.
 *
 * The body reuses the contracts custom command expansion rules: replace $ARGUMENTS and prepend the `skills:`
 * intro.
 */
export const BUILTIN_WORKFLOW_COMMAND_NAME = "workflow";

const helpEntry = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find(
  (entry) => entry.name === BUILTIN_WORKFLOW_COMMAND_NAME,
);
if (!helpEntry) {
  // The shared help table is the only source of reserved words, TUI candidates, and the App directory; in the absence of entries, commands are not addressable at all.
  throw new Error(`Missing builtin slash command help entry: ${BUILTIN_WORKFLOW_COMMAND_NAME}`);
}

const USAGE_PREFIX = `/${BUILTIN_WORKFLOW_COMMAND_NAME} `;
export const BUILTIN_WORKFLOW_COMMAND_DESCRIPTION = helpEntry.summary;
export const BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT = helpEntry.usage.startsWith(USAGE_PREFIX)
  ? helpEntry.usage.slice(USAGE_PREFIX.length)
  : "";

/** `$ARGUMENTS` must be present: otherwise the expansion appends the arguments as an uncontrolled "User arguments:" tail block. */
const BUILTIN_WORKFLOW_COMMAND_BODY = [
  `Use the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill to design and launch a dynamic workflow for this request:`,
  "",
  "$ARGUMENTS",
  "",
  "Decide the subagent topology before writing any code: how many subagents, which of them",
  "share a context, what result each one returns. Then write the script and call the",
  "`CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow tool. Do not use the",
  "legacy `Workflow` tool, and do not substitute the `Agent` tool.)",
  "",
].join("\n");

export const BUILTIN_WORKFLOW_COMMAND: CustomCommandContent = {
  bytesRead: Buffer.byteLength(BUILTIN_WORKFLOW_COMMAND_BODY),
  content: BUILTIN_WORKFLOW_COMMAND_BODY,
  metadata: {
    allowedTools: [],
    argumentHint: BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT,
    description: BUILTIN_WORKFLOW_COMMAND_DESCRIPTION,
    disableNonInteractive: false,
    frontmatterKeys: ["description", "argument-hint", "skills"],
    name: BUILTIN_WORKFLOW_COMMAND_NAME,
    path: `builtin:${BUILTIN_WORKFLOW_COMMAND_NAME}`,
    rootPath: "builtin:",
    scope: "system",
    skills: [DYNAMIC_WORKFLOW_SKILL_NAME],
    source: "zcode",
  },
  sizeBytes: Buffer.byteLength(BUILTIN_WORKFLOW_COMMAND_BODY),
  truncated: false,
};

export function expandBuiltinWorkflowCommandPrompt(args: string): string {
  return expandCustomCommandPrompt({ args, command: BUILTIN_WORKFLOW_COMMAND }).prompt;
}
