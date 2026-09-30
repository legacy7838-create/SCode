// ============================================================
// Context Builder Types
// ============================================================

import type {
  EnvInfo,
  Model,
  ModelInputMessage,
  ProjectContext,
  ResolvedUserInstructions,
  SkillLoadOutcome,
  UserInstructionsOptions,
} from "@zcode/contracts";
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";

export type {
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@zcode/contracts";

// -----------------------------------------------
// Context Source
// -----------------------------------------------

export type ContextSource =
  | "cli_prefix" // CLI/Product Identity Prefix
  | "identity" // Agent basic description
  | "env_info" // Environment information (cwd, platform, git repo boolean)
  | "system_context" // git snapshot context
  | "skills" // Available skills
  | "tools" // Tool definition
  | "request_user_context" // request-level user context provider-visible combination block
  | "memory" // long term memory read path
  | "current_date" // current date
  | "custom_system_prompt" // Custom stable system body
  | "workflow_actor_identity" // Dynamic workflow subagent identity: contract + persona overlay
  | "subagent_agent_prompt" // Sub-agent exclusive identity/task prompt
  | "subagent_notes" // Sub-agent general operation reminder
  | "subagent_environment" // Child agent environment and model context
  | "dynamic_behavior" // dynamic behavioral boundaries
  | "session_guidance" // Currently available built-in capability guidance
  | "output_style" // Output style
  | "context_management" // Long context management tips
  | "desktop_context"; // ZCode Desktop rendering and interaction protocol

export type ContextInjectionTarget = "system" | "meta_user";

export type ContextCacheHint = "stable" | "dynamic";

export type PresentationSurface = "terminal" | "zcode_desktop";

// -----------------------------------------------
// Context Section
// -----------------------------------------------

export interface ContextSection {
  name: string; // Human-readable section name
  source: ContextSource; // Source identification
  injectionTarget: ContextInjectionTarget; // Injection location
  cacheHint: ContextCacheHint; // Cache stability tips
  chars: number; // Number of characters
  tokens: number; // Estimate the number of tokens
  content: string; // full content
  preview: string; // First 100 characters preview
}

export type ContextMetaUserAttachmentSource = "skills_listing" | "context_prefix";

export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
}

// -----------------------------------------------
// Context Build Result
// -----------------------------------------------

export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: ModelInputMessage[]; // ContextBuilder only assembles system messages
  metaUserAttachments: ContextMetaUserAttachment[]; // Meta user body not wrapped in <system-reminder>
}

export interface OutputStylePromptConfig {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

// -----------------------------------------------
// Context Builder Config
// -----------------------------------------------

export interface ContextBuilderConfig {
  workingDirectory: string;
  envInfo: EnvInfo;
  /** The execution object of the current step; does not enter the Context Source or the persisted environment snapshot. */
  model?: Model;
  presentationSurface?: PresentationSurface;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
  skills?: SkillLoadOutcome;
  agentProfiles?: readonly AgentProfile[];
  embeddedSearchEnabled?: boolean;
  skillMetadataBudget?: number;
  customSystemPrompt?: string;
  /**
   * Identity input for a dynamic workflow subagent (workflow child). Present means the builder's third path is taken: the base
   * segments (CLI prefix, safety lines, Harness, memory) + the workflow subagent contract + a persona overlay, rather than replacing
   * the whole thing as `customSystemPrompt` does. Mutually exclusive with `customSystemPrompt`.
   */
  workflowActor?: WorkflowActorContext;
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
}

/**
 * Identity input for a workflow subagent: the effective name (absent when anonymous) and the author-written persona system prompt (may be absent). No tool tier: every subagent has the full work
 * toolset, and the contract is a single piece of text.
 */
export interface WorkflowActorContext {
  name?: string;
  persona?: string;
}

export type ContextUserInstructionsRequest = UserInstructionsOptions;
