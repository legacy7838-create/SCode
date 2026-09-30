import type { CustomCommandRoot } from "../commands/index.js";
import type { HookEventName, HookMatcherConfig } from "../hooks/index.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { SkillRoot } from "../skills/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
export const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
export const ZCODE_PLUGIN_HOST_COMMAND = "__zcode-plugin-host";
/**
 * Hidden subcommand: the sandboxed child process entry point for dynamic workflows (`__zcode-dwf-child <entry path>`; the last argv element is
 * the entry file path the harness has written, and the payload does not travel over the command line).
 *
 * Of the same family and mechanism as {@link ZCODE_PLUGIN_HOST_COMMAND}: a SEA single-file binary does not interpret Node CLI flags, so
 * the harness's default `node --max-old-space-size=… <entry>` spawn necessarily fails under SEA by handing those flags to a strict
 * parseArgs. Under SEA it instead re-execs this binary, and `run.ts` dispatches **before** parseArgs.
 * The constant lives in contracts rather than in dynamic-workflow-runtime: the latter deliberately does not depend on contracts (the app-free proof),
 * and bootstrap hands it to the harness as the argsPrefix after the SEA check.
 */
export const ZCODE_DWF_CHILD_COMMAND = "__zcode-dwf-child";

export function isOfficialMarketplaceId(id: string): boolean {
  return id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE;
}

export type PluginSource = "official" | "inline" | "cache";
export type PluginDiagnosticSeverity = "warning" | "error";

export type PluginDiagnosticCode =
  | "plugin_root_not_found"
  | "plugin_manifest_not_found"
  | "plugin_manifest_invalid"
  | "plugin_component_path_invalid"
  | "plugin_unsupported_component"
  | "plugin_skill_root_empty"
  | "plugin_mcp_read_failed"
  | "plugin_mcp_invalid"
  | "plugin_mcp_server_disabled"
  | "plugin_hook_read_failed"
  | "plugin_hook_invalid"
  | "plugin_hook_unsupported_event"
  | "plugin_dependency_invalid"
  | "plugin_dependency_missing"
  | "plugin_dependency_cycle"
  | "plugin_dependency_cross_marketplace"
  | "plugin_marketplace_invalid"
  | "plugin_marketplace_declaration_reserved"
  | "plugin_git_unavailable"
  | "plugin_archive_fetch_failed"
  | "plugin_marketplace_source_unsupported"
  | "plugin_validation_deferred"
  | "plugin_variable_missing"
  | "plugin_duplicate_id"
  | "plugin_not_found"
  | "plugin_ambiguous_name";

export interface PluginUserConfigOption {
  default?: string | number | boolean;
  description?: string;
  title?: string;
  required?: boolean;
  sensitive?: boolean;
  type?: "string" | "number" | "boolean" | "directory" | "file";
}

export type PluginOptionValue = string | number | boolean;
export type PluginOptionValues = Record<string, PluginOptionValue>;

export type PluginMarketplaceSourceConfig =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string };

export interface PluginMarketplaceConfig {
  source: PluginMarketplaceSourceConfig;
}

export interface PluginHookDetail {
  args?: string[];
  async?: boolean;
  command: string;
  event: HookEventName;
  matcher?: string;
  runnable: boolean;
  shell?: true | string;
  sourcePath: string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command" | "process";
}

/** The component grouping type of the detail UI, in the same order as displayed: agent / command / skill / hook / mcp. */
export type PluginComponentKind = "agent" | "command" | "skill" | "hook" | "mcp";

export interface PluginComponentItem {
  name: string;
  /** A description from the component's frontmatter / manifest; omitted when missing, never fabricated. */
  description?: string;
}

export interface PluginComponentGroup {
  kind: PluginComponentKind;
  items: PluginComponentItem[];
}

/**
 * Store information (Store Listing): the presentational metadata a marketplace catalog entry carries, describing "how it is presented in the store",
 * without affecting plugin functionality. All fields are optional; when missing, the UI follows the degradation matrix (letter avatar / hidden section / omitted info row).
 */
export interface PluginStoreListing {
  /** The display name on the card/detail, falling back to the plugin's name slug when missing. */
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  /** The localized versions of the catalog entry's description (the description itself already has its own field). */
  descriptionI18n?: Record<string, string>;
  /** The icon image: an https URL or a local asset path for a built-in plugin. */
  icon?: string;
  category?: string;
  author?: string;
  authorUrl?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  /** The hero banner image on the details page. */
  heroImage?: string;
  /** The example prompt pills on the details page; clicking one creates a new session prefilled with it. */
  examplePrompts?: string[];
  examplePromptsI18n?: Record<string, string[]>;
  /**
   * A paid plan is needed to make good use of it: the catalog entry declares `requiresPaidPlan: true`, and the store card and the details page
   * show a hint icon to the right of the title. It expresses a "condition of use" and does not mean the plugin itself is a paid product,
   * so it takes no part in the install gate or in billing; the naming is not bound to a concrete plan product name, so renaming a plan will not make the field stale.
   */
  requiresPaidPlan?: boolean;
}

export interface PluginManifest {
  agents?: unknown;
  author?: unknown;
  channels?: unknown;
  commands?: unknown;
  dependencies?: unknown;
  description?: string;
  homepage?: string;
  hooks?: unknown;
  keywords?: unknown;
  license?: string;
  lspServers?: unknown;
  mcpServers?: unknown;
  name: string;
  outputStyles?: unknown;
  repository?: string;
  settings?: unknown;
  skills?: unknown;
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

export interface PluginConfig {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces: Record<string, PluginMarketplaceConfig>;
  options: Record<string, PluginOptionValues>;
  suppressedBuiltins: string[];
}

export interface PluginMetadata {
  /** The author name in the manifest (plugin.json), normalized to a string; used as the details-page fallback when store information is missing. */
  author?: string;
  authorUrl?: string;
  commandRootCount: number;
  /**
   * The authoritative component inventory (name + optional description), produced by the loader enumerating the plugin root directory at
   * the resolution stage, independent of the enabled state. The detail UI displays it directly, with no need to join Skills/Commands/Agents on the UI side.
   */
  components: PluginComponentGroup[];
  configuredOptions?: PluginOptionValues;
  dataPath: string;
  declaredMcpServerNames: string[];
  description?: string;
  enabled: boolean;
  /** The homepage in the manifest (plugin.json); used as the details-page fallback when store information is missing. */
  homepage?: string;
  id: string;
  manifestPath: string;
  marketplace: string;
  mcpServerNames: string[];
  name: string;
  hookDetails: PluginHookDetail[];
  rootPath: string;
  skillCount: number;
  skillRootCount: number;
  source: PluginSource;
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnosticSeverity;
}

// ============================================================
// The identity catalog contract referenced by the Plugin conversation (@Plugin capability hint).
// Semantics: catalog is frozen when Session (App) is created,
// It only carries the "declaration" of identity and capabilities; the actual injected capabilities intersect with the live inventory in each round.
// ============================================================

export interface PluginReferenceCatalogEntry {
  /** Stable Plugin ID: `${manifest.name}@${marketplace}`, the sole identity of a canonical plugin:// link. */
  pluginId: string;
  /** The manifest name (the base of the Skill/MCP/Subagent runtime namespace), used only for display and provenance matching; it carries no authority. */
  name: string;
  marketplace: string;
  /** The enabled state at the moment the catalog was frozen; disabled entries are kept for `disabled_in_session` diagnostics and must not be referenced. */
  enabled: boolean;
  /**
   * Other enabled Plugin stable IDs that share this entry's manifest.name.
   * Non-empty means a V1 fail-closed conflict: the Picker disallows selection, the runtime skips it as ambiguous,
   * and last-write-wins or display-name guessing are forbidden.
   */
  conflictingPluginIds: string[];
  /** The Skill qualified names declared by this identity (`${name}:${skill}`); they come from the component enumeration and are decoupled from live discovery. */
  skillQualifiedNames: string[];
  /** The namespaced MCP server names declared by this identity (`plugin:${name}:${server}`). */
  mcpServerNames: string[];
  /** The canonical Subagent names declared by this identity (`${name}:${agent}`); they come from the component enumeration. */
  subagentNames: string[];
  /**
   * The plugin root directory, used only by the runtime to trace provenance for live Skill/Subagent lookups (a rootPath prefix check).
   * It must never enter the provider reminder or the protocol projection -- a path does not belong to the identifiers-only contract.
   */
  rootPath: string;
}

export interface PluginReferenceCatalog {
  plugins: PluginReferenceCatalogEntry[];
}

export interface PluginLoadOutcome {
  commandRoots: CustomCommandRoot[];
  diagnostics: PluginDiagnostic[];
  hooks: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  mcpServers: Record<string, McpServerConfig>;
  /** The store listing is keyed by the full Plugin ID for CLI/TUI display; it takes no part in runtime identity decisions. */
  pluginListingsById?: Record<string, PluginStoreListing>;
  plugins: PluginMetadata[];
  skillRoots: SkillRoot[];
}

export interface PluginDiscoverRequest {
  config: PluginConfig;
  env?: Record<string, string | undefined>;
  // Bootstrap can pass in the official plugin id list that is "safe enough to be enabled by default".
  // Allow users to use it without `zcode plugins enable` first (such as content-only skill-creator).
  // The default collection is empty, and the behavior of existing plugins (including heavy loads such as ios-simulator/android-emulator) remains unchanged.
  officialPluginsEnabledByDefault?: ReadonlySet<string>;
  officialPluginRoots?: string[];
  storageRoot: string;
  trace?: TraceContext;
  workingDirectory: string;
}

export interface PluginOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface PluginPort {
  discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome>;
}
