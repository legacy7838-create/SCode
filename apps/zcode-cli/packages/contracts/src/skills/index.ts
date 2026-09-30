// ============================================================
// Skill Contracts - reusable local instruction packs
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type SkillScope = "project" | "user" | "system" | "admin";

export type SkillSource = "agents" | "zcode" | "bundled" | "plugin" | "remote";

export type SkillDiagnosticSeverity = "warning" | "error";

export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found";

export interface SkillRoot {
  path: string;
  scope: SkillScope;
  source: SkillSource;
  priority: number;
  /** The full id of the owning plugin; available only at the plugin root. */
  pluginId?: string;
}

export interface SkillPolicy {
  allowImplicitInvocation?: boolean;
}

export interface SkillMetadata {
  name: string;
  description: string;
  whenToUse?: string;
  pluginName?: string;
  /** The full id of the owning plugin; not set for a non-plugin skill. */
  pluginId?: string;
  qualifiedName?: string;
  path: string;
  directory: string;
  rootPath: string;
  scope: SkillScope;
  source: SkillSource;
  safeToAutoLoad: boolean;
  frontmatterKeys: string[];
  policy?: SkillPolicy;
}

/** The minimal metadata allowed to cross the boundary in a Skill tool result; does not include the body or the description. */
export interface SkillTelemetryMetadata {
  qualifiedName?: string;
  pluginId?: string;
  source?: SkillSource;
}

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillLoadOutcome {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
  totalDiscovered: number;
}

export interface SkillContent {
  metadata: SkillMetadata;
  content: string;
  baseDirectory: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillDiscoverRequest {
  workingDirectory: string;
  roots?: SkillRoot[];
  trace?: TraceContext;
}

export interface SkillLoadRequest {
  name: string;
  workingDirectory: string;
  roots?: SkillRoot[];
  maxBytes?: number;
  trace?: TraceContext;
}

export interface SkillOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface SkillPort {
  discoverSkills(
    request: SkillDiscoverRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome>;
  loadSkill(request: SkillLoadRequest, options?: SkillOperationOptions): Promise<SkillContent>;
}

export interface SkillConfig {
  enabled: boolean;
  includeInstructions: boolean;
  metadataBudget: number;
  roots: string[];
}
