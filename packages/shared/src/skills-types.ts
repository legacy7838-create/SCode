export type SkillScope = "workspace" | "user" | "plugin";

export interface SkillMetadata {
  slug?: string;
  version?: string;
  ownerId?: string;
  publishedAt?: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  /**
   * Original SKILL.md path hit during the discovery phase (not resolved through realpath).
   * For skills imported through a symlink, `path` is the realpath-resolved target file, while `sourcePath` points
   * at the link itself under `~/.zcode/skills/<name>`; deletion must use it so that only the link is removed and
   * the target is left alone. For a normal skill it equals `path`.
   */
  sourcePath?: string;
  scope: SkillScope;
  enabled: boolean;
  /** Name of the source plugin for the plugin scope; empty for other scopes. */
  pluginName?: string;
  /** Full ID of the source plugin (name@marketplace) for the plugin scope; may be absent in legacy payloads. */
  pluginId?: string;
  metadata?: SkillMetadata;
}

export interface SkillsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export type SkillDiagnosticSeverity = "warning" | "error";

/** Kept in sync with zcode-cli `SkillDiagnosticCode`. Change apps/zcode-cli/packages/contracts/src/skills/index.ts together with this. */
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

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillsListResult {
  skills: SkillSummary[];
  capability: SkillsCapability;
  diagnostics: SkillDiagnostic[];
}

export interface SkillsPromptContext {
  prompt: string;
  activatedSkillNames: string[];
}
