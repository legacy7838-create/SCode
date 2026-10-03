import { basename } from "node:path";
import { GENERAL_PURPOSE_AGENT_TYPE, buildGeneralPurposeSystemPrompt } from "./general-purpose.js";
import { EXPLORE_AGENT_TYPE } from "./explore.js";
import { formatExploreAllowedToolsForAgentDescription } from "./explore-tools.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import type { ModelSelection } from "@zcode/shared";
import type { JsonSchema } from "@zcode/contracts";
import { resolveProfileModelSelection } from "./profile-model-selection.js";
import { parseAgentProfileFromMarkdown as parseAgentProfileFromMarkdownNative } from "@zcode/rust/subagent-profile";

export const DEFAULT_SUBAGENT_TYPE = GENERAL_PURPOSE_AGENT_TYPE;

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<typeof DEFAULT_SUBAGENT_TYPE | typeof EXPLORE_AGENT_TYPE, ModelSelection>
>;

export type AgentPermissionMode = "auto" | "plan";

export type AgentProfileSource = "built-in" | "project" | "user";
export type AgentMemoryScope = "user" | "project" | "local";

export interface AgentProfile {
  background?: boolean;
  color?: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
  description: string;
  disallowedTools?: readonly string[];
  injectAgentsMd?: boolean;
  maxTurns?: number;
  mcpServers?: readonly string[];
  memory?: AgentMemoryScope;
  modelSelection?: ModelSelection;
  /** The structured result contract: `yield: true` in frontmatter. When absent, the
   *  agent keeps the legacy free-text report and no schema is enforced. */
  yield?: { mode: "structured"; schema: JsonSchema };
  name: string;
  path?: string;
  permissionMode?: AgentPermissionMode;
  skills?: readonly string[];
  source: AgentProfileSource;
  systemPrompt: string;
  tools?: readonly string[];
}

export interface AgentProfileParseDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentProfileLoadResult {
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}




export function createBuiltInExploreAgentProfile(
  options: { modelSelection?: ModelSelection } = {},
): AgentProfile {
  return {
    name: EXPLORE_AGENT_TYPE,
    description:
      'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.',
    color: "cyan",
    injectAgentsMd: false,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    source: "built-in",
    systemPrompt: "",
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
  };
}

export function isBuiltInExploreAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  // User/project profiles can override the built-in Explore with the same name, but cannot apply built-in behaviors by name only.
  return profile.name === EXPLORE_AGENT_TYPE && profile.source === "built-in";
}

export function normalizeAgentProfiles(
  profiles: readonly AgentProfile[],
  options: {
    builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  } = {},
): AgentProfile[] {
  const overrides = options.builtInModelSelectionOverrides ?? {};
  const active = new Map<string, AgentProfile>();
  active.set(
    DEFAULT_SUBAGENT_TYPE,
    createBuiltInGeneralPurposeAgentProfile({
      modelSelection: overrides[DEFAULT_SUBAGENT_TYPE],
    }),
  );
  active.set(
    EXPLORE_AGENT_TYPE,
    createBuiltInExploreAgentProfile({
      modelSelection: overrides[EXPLORE_AGENT_TYPE],
    }),
  );
  for (const profile of profiles) {
    active.set(profile.name, profile);
  }
  return Array.from(active.values());
}

export function createBuiltInGeneralPurposeAgentProfile(
  options: { modelSelection?: ModelSelection } = {},
): AgentProfile {
  return {
    name: DEFAULT_SUBAGENT_TYPE,
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
    // The built-in sub-agent uses explicit identity color to prevent the UI from displaying the general-purpose in red after hashing by name.
    color: "blue",
    injectAgentsMd: true,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    source: "built-in",
    systemPrompt: buildGeneralPurposeSystemPrompt(),
    tools: ["*"],
  };
}

export function formatAgentProfilesForPrompt(
  profiles: readonly AgentProfile[],
  options: { embeddedSearchEnabled?: boolean } = {},
): string | null {
  const active = normalizeAgentProfiles(profiles);
  if (active.length === 0) return null;

  return [
    "Available agent types and the tools they have access to:",
    ...active.map((profile) => {
      const tools = isBuiltInExploreAgentProfile(profile)
        ? formatExploreAllowedToolsForAgentDescription(options)
        : profile.tools
          ? filterSubagentChildToolNames(profile.tools, profile.disallowedTools)
          : undefined;
      const toolText = typeof tools === "string" ? tools : tools?.join(", ");
      const suffix = toolText ? ` (Tools: ${toolText})` : "";
      return `- ${profile.name}: ${profile.description}${suffix}`;
    }),
  ].join("\n");
}

export function parseAgentProfileFromMarkdown(input: {
  content: string;
  path?: string;
  source: AgentProfileSource;
}): {
  diagnostic?: AgentProfileParseDiagnostic;
  diagnostics?: AgentProfileParseDiagnostic[];
  profile?: AgentProfile;
} {
  // The frontmatter reader is Rust (`@zcode/rust/subagent-profile`); see
  // docs/specs/subagent-rust-port.md Phase 1. The TypeScript reader is deleted, not
  // disabled: two readers drift, and a dropped `outputSchema` fails SILENTLY — the
  // agent would run with the yield contract declared in its file and nothing
  // enforcing it.
  const native = parseAgentProfileFromMarkdownNative({
    content: input.content,
    ...(input.path === undefined ? {} : { path: input.path }),
    source: input.source,
  });
  const raw = native.profile;
  // The raw frontmatter travels with the profile; model selection derives from it.
  const modelSelection = resolveProfileModelSelection(raw?.frontmatter ?? {});
  return {
    ...(native.diagnostic ? { diagnostic: native.diagnostic } : {}),
    ...(native.diagnostics ? { diagnostics: native.diagnostics } : {}),
    ...(raw
      ? {
          profile: {
            ...raw,
            source: raw.source as AgentProfileSource,
            ...(modelSelection ? { modelSelection } : {}),
          } as AgentProfile,
        }
      : {}),
  };
}

export function agentProfileDisplayName(profile: AgentProfile): string {
  return profile.path ? `${profile.name} (${basename(profile.path)})` : profile.name;
}

function normalizeToolNames(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const names = values.map(toolNameFromSpec).filter((item) => item.length > 0);
  return names.length > 0 ? names : undefined;
}

function toolNameFromSpec(value: string): string {
  const trimmed = value.trim();
  const parenIndex = trimmed.indexOf("(");
  if (parenIndex < 0) return trimmed;
  return trimmed.slice(0, parenIndex).trim();
}
