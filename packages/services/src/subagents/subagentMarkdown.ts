import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createAgentStateId,
  parseSubagentMarkdownSelection,
  formatSubagentMarkdownModel,
  type AgentColor,
  type AgentDiagnostic,
  type AgentPermissionMode,
  type AgentScope,
  type AgentSummary,
  type SubAgentConfig,
} from "@zcode/shared";

const VALID_COLORS = new Set<AgentColor>([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);

const VALID_PERMISSION_MODES = new Set<AgentPermissionMode>(["auto", "plan"]);

interface ParseSubagentMarkdownInput {
  content: string;
  path: string;
  scope: AgentScope;
}

interface ParseSubagentMarkdownResult {
  agent?: AgentSummary;
  diagnostic?: AgentDiagnostic;
}

export function parseSubagentMarkdown(
  input: ParseSubagentMarkdownInput,
): ParseSubagentMarkdownResult {
  const parsed = splitMarkdownFrontmatter(input.content);
  if (!parsed.frontmatter) {
    return {
      diagnostic: {
        code: "agent_missing_frontmatter",
        message: `Agent Markdown must include frontmatter: ${input.path}`,
        path: input.path,
      },
    };
  }

  // The runtime uses loose frontmatter semantics; Settings is also read according to the same semantics.
  // Avoid CLI loaded profiles from disappearing in the GUI because they are not strictly YAML.
  const frontmatter = parseRuntimeCompatibleFrontmatter(parsed.frontmatter);

  const name = scalarString(frontmatter.name);
  const description = scalarString(frontmatter.description)?.replace(/\\n/gu, "\n");
  if (!name) {
    return missingRequiredDiagnostic("name", input.path);
  }
  if (!description) {
    return missingRequiredDiagnostic("description", input.path);
  }

  const source = input.scope === "built-in" ? "built-in" : "user";
  const modelSelection = parseSubagentMarkdownSelection(frontmatter);
  const color = normalizeEnum(frontmatter.color, VALID_COLORS);
  const permissionMode = normalizeEnum(frontmatter.permissionMode, VALID_PERMISSION_MODES);
  const maxTurns = normalizePositiveInteger(frontmatter.maxTurns);
  const tools = parseToolSpecList(frontmatter.tools);
  const disallowedTools = parseToolSpecList(frontmatter.disallowedTools);
  const skills = parseStringList(frontmatter.skills);
  const background = parseOptionalBoolean(frontmatter.background);
  const injectAgentsMd = parseOptionalBoolean(frontmatter.injectAgentsMd);
  const mcpServers = Array.isArray(frontmatter.mcpServers) ? frontmatter.mcpServers : undefined;

  return {
    agent: {
      id: createAgentStateId({ name, scope: input.scope, source }),
      name,
      description,
      systemPrompt: parsed.body.trim(),
      ...(color ? { color } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(skills ? { skills } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(injectAgentsMd !== undefined ? { injectAgentsMd } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      path: input.path,
      scope: input.scope,
      source,
      enabled: true,
      // The workspace scope was also marked as read-only, which caused the profile under .zcode/agents to be displayed on the settings page.
      // It cannot be edited/delete, and the hidden branch of groupAgentsByScope is displayed in the "built-in" group.
      // Only built-in agents are truly uneditable; plugin agents are explicitly overridden as read-only by discoverPluginAgents.
      readOnly: input.scope === "built-in",
    },
  };
}

export function serializeSubagentMarkdown(config: SubAgentConfig): string {
  const frontmatterLines: string[] = [
    `name: "${escapeYamlString(config.name)}"`,
    `description: "${escapeYamlString(config.description)}"`,
  ];
  appendScalar(frontmatterLines, "color", config.color);
  if (config.modelSelection) {
    appendScalar(frontmatterLines, "model", formatSubagentMarkdownModel(config.modelSelection));
    appendScalar(frontmatterLines, "thoughtLevel", config.modelSelection.options?.reasoningLevel);
  }
  appendList(frontmatterLines, "tools", config.tools);
  appendList(frontmatterLines, "disallowedTools", config.disallowedTools);
  appendList(frontmatterLines, "skills", config.skills);
  appendScalar(frontmatterLines, "permissionMode", config.permissionMode);
  if (config.maxTurns !== undefined) {
    frontmatterLines.push(`maxTurns: ${config.maxTurns}`);
  }
  if (config.background !== undefined) {
    frontmatterLines.push(`background: ${config.background ? "true" : "false"}`);
  }
  if (config.injectAgentsMd !== undefined) {
    frontmatterLines.push(`injectAgentsMd: ${config.injectAgentsMd ? "true" : "false"}`);
  }
  appendUnknownList(frontmatterLines, "mcpServers", config.mcpServers);

  return `---\n${frontmatterLines.join("\n")}\n---\n${formatBody(config.systemPrompt)}`;
}

function splitMarkdownFrontmatter(content: string): { body: string; frontmatter?: string } {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { body: normalized };
  }

  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { body: normalized };
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) {
    return { body: normalized };
  }

  return {
    frontmatter: lines.slice(1, endIndex).join("\n"),
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

function parseRuntimeCompatibleFrontmatter(frontmatter: string): Record<string, unknown> {
  const looseValues = parseLooseFrontmatter(frontmatter);
  let yamlValues: Record<string, unknown> = {};
  try {
    const rawFrontmatter = parseYaml(frontmatter) as unknown;
    yamlValues = isObjectRecord(rawFrontmatter) ? rawFrontmatter : {};
  } catch {
    yamlValues = {};
  }

  return {
    ...yamlValues,
    ...looseValues,
    ...(Array.isArray(yamlValues.mcpServers) ? { mcpServers: yamlValues.mcpServers } : {}),
  };
}

function parseLooseFrontmatter(frontmatter: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const lines = frontmatter.split(/\r?\n/u);
  let pendingListKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const listMatch = line.match(/^\s*-\s+(.*)$/u);
    if (listMatch && pendingListKey) {
      const existing = Array.isArray(values[pendingListKey])
        ? (values[pendingListKey] as unknown[])
        : [];
      values[pendingListKey] = [...existing, parseScalarValue(listMatch[1] ?? "")];
      continue;
    }

    pendingListKey = undefined;
    const keyValue = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const rawValue = keyValue[2] ?? "";
    if (rawValue.trim() === "") {
      values[key] = [];
      pendingListKey = key;
      continue;
    }
    values[key] = parseScalarValue(rawValue);
  }

  return values;
}

function parseScalarValue(rawValue: string): unknown {
  const value = stripInlineComment(rawValue.trim());
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/u.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTopLevelList(value.slice(1, -1)).map((item) =>
      unquoteScalar(stripInlineComment(item.trim())),
    );
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Runtime-compatible loose frontmatter retains the original string for illegal inline mapping;
      // A downstream strict ModelSelection schema will reject it instead of making the entire agent file disappear.
      return value;
    }
  }
  return unquoteScalar(value);
}

function stripInlineComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
    }
    if (!quote && char === "#" && /\s/u.test(value[index - 1] ?? "")) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function splitTopLevelList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  let parenDepth = 0;
  for (const char of value) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      current += char;
      continue;
    }
    if (!quote && char === "(") parenDepth += 1;
    if (!quote && char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (!quote && parenDepth === 0 && char === ",") {
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function unquoteScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function missingRequiredDiagnostic(field: string, path: string): { diagnostic: AgentDiagnostic } {
  return {
    diagnostic: {
      code: "agent_missing_required_frontmatter",
      message: `Agent frontmatter must include ${field}: ${path}`,
      path,
    },
  };
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeEnum<T extends string>(value: unknown, valid: Set<T>): T | undefined {
  const raw = scalarString(value);
  return raw && valid.has(raw as T) ? (raw as T) : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return nonEmptyList(
      value.filter((item): item is string => typeof item === "string").map((item) => item.trim()),
    );
  }
  if (typeof value !== "string") return undefined;
  return nonEmptyList(
    value
      .split(/[,\s]+/u)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseToolSpecList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return nonEmptyList(
      value.filter((item): item is string => typeof item === "string").map((item) => item.trim()),
    );
  }
  if (typeof value !== "string") return undefined;

  const result: string[] = [];
  let current = "";
  let parenDepth = 0;
  for (const char of value) {
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (parenDepth === 0 && (char === "," || /\s/u.test(char))) {
      if (current.trim()) result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return nonEmptyList(result);
}

function nonEmptyList(values: string[]): string[] | undefined {
  const filtered = values.filter((item) => item.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

function appendScalar(lines: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  lines.push(`${key}: ${formatYamlScalar(value)}`);
}

function appendList(lines: string[], key: string, values: readonly string[] | undefined): void {
  if (!values || values.length === 0) return;
  lines.push(`${key}:`);
  for (const value of values) {
    lines.push(`  - ${formatYamlScalar(value)}`);
  }
}

function appendUnknownList(
  lines: string[],
  key: string,
  values: readonly unknown[] | undefined,
): void {
  if (!values || values.length === 0) return;
  if (isStringArray(values)) {
    appendList(lines, key, values);
    return;
  }
  // The GUI does not currently have a structured form for mcpServers, but saving will rewrite the entire
  // frontmatter; the object array must be written back in a YAML structure to avoid clearing the MCP configuration when editing other fields.
  const serialized = stringifyYaml({ [key]: values }, { lineWidth: 0 }).trimEnd();
  lines.push(...serialized.split("\n"));
}

function isStringArray(values: readonly unknown[]): values is readonly string[] {
  return values.every((value) => typeof value === "string");
}

function formatYamlScalar(value: string): string {
  // `*` and utility patterns containing `: ` are treated as
  // alias/map must be quoted before writing to ensure that the saved Markdown can be re-read by the parser.
  if (isSafePlainYamlScalar(value)) {
    return value;
  }
  return `"${escapeYamlString(value)}"`;
}

function isSafePlainYamlScalar(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  if (/^(?:false|null|true|~)$/iu.test(value)) return false;
  if (/^[-+]?(?:\d+|\d*\.\d+)(?:e[-+]?\d+)?$/iu.test(value)) return false;
  if (/^[*?:,[\]{}&!|>'"%@`-]/u.test(value)) return false;
  if (value.includes("#") || /:\s/u.test(value)) return false;
  return /^[A-Za-z0-9_./@*][A-Za-z0-9_./@*\s()-]*$/u.test(value);
}

function escapeYamlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function formatBody(systemPrompt: string): string {
  const body = systemPrompt.trim();
  return body.length > 0 ? `\n${body}\n` : "\n";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
