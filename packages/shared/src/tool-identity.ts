export const ZCODE_KNOWN_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "web_search",
  "TodoRead",
  "TodoWrite",
  "GoalRead",
  "ReadSessionContext",
  "AskUserQuestion",
  "SendMessage",
  "RespondToCoordinator",
  "TaskOutput",
  "TaskStop",
  "js",
  "js_reset",
  "js_add_node_module_dir",
  "mcp__node_repl__js",
  "mcp__node_repl__js_reset",
  "mcp__node_repl__js_add_node_module_dir",
  "Agent",
  "Task",
  "Skill",
  "CreateWorkflow",
  // Revision entrance: Register into the workflow family and let the confirmation window
  // Select the run confirmation block by family; on the tool line side, divert (resolveRenderer.ts) by name first, and family will not swallow it.
  "AmendWorkflow",
  // The wire name is snake_case's submit_result (the only one in the warehouse), and the underscore must be present literally:
  // When not registered, the UI identity returns to unknown, and the submission of dynamic workflow actors will fall to the raw fallback renderer.
  "submit_result",
] as const;

export type ZCodeKnownToolName = (typeof ZCODE_KNOWN_TOOL_NAMES)[number];

export type ZCodeToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "todo"
  | "ask-user-question"
  | "agent"
  | "skill"
  | "goal"
  | "session-context"
  | "message"
  | "task-control"
  | "node-repl"
  | "workflow";

const TOOL_FAMILY_BY_NAME: Record<ZCodeKnownToolName, ZCodeToolFamily> = {
  Read: "file-read",
  Write: "file-write",
  Edit: "file-write",
  ApplyPatch: "file-write",
  Bash: "shell",
  Glob: "search",
  Grep: "search",
  WebFetch: "search",
  WebSearch: "search",
  web_search: "search",
  TodoRead: "todo",
  TodoWrite: "todo",
  GoalRead: "goal",
  ReadSessionContext: "session-context",
  AskUserQuestion: "ask-user-question",
  SendMessage: "message",
  RespondToCoordinator: "message",
  TaskOutput: "task-control",
  // When TaskStop is not registered, the UI identity will return to unknown and eventually fall to the raw fallback renderer.
  TaskStop: "task-control",
  js: "node-repl",
  js_reset: "node-repl",
  js_add_node_module_dir: "node-repl",
  // node_repl is exposed by MCP, and the tool name entering the UI is therefore prefixed with MCP.
  // If only the old built-in name is registered here, the dedicated REPL renderer will fallback to unknown fallback.
  mcp__node_repl__js: "node-repl",
  mcp__node_repl__js_reset: "node-repl",
  mcp__node_repl__js_add_node_module_dir: "node-repl",
  Agent: "agent",
  Task: "agent",
  Skill: "skill",
  CreateWorkflow: "workflow",
  AmendWorkflow: "workflow",
  submit_result: "workflow",
};

const TOOL_NAME_BY_LOWER = new Map<string, ZCodeKnownToolName>(
  ZCODE_KNOWN_TOOL_NAMES.map((toolName) => [toolName.toLowerCase(), toolName]),
);

export function normalizeZCodeToolName(
  value: string | null | undefined,
): ZCodeKnownToolName | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return TOOL_NAME_BY_LOWER.get(normalized.toLowerCase()) ?? null;
}

export function getZCodeToolFamilyForName(
  value: string | null | undefined,
): ZCodeToolFamily | null {
  const toolName = normalizeZCodeToolName(value);
  return toolName ? TOOL_FAMILY_BY_NAME[toolName] : null;
}

export function isZCodeToolFamily(
  value: string | null | undefined,
  family: ZCodeToolFamily,
): boolean {
  return getZCodeToolFamilyForName(value) === family;
}

export function isZCodeFileContentWriteToolName(value: string | null | undefined): boolean {
  return normalizeZCodeToolName(value) === "Write";
}
