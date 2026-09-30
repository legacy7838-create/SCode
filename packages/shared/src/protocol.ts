import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type { ProviderFamilyConnectionSelectionSettings } from "./provider-family-connection-selection.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";
import type { EmbeddedBrowserViewportPreference } from "./browser-use/command-metadata.js";

// ── Domain types ──

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  /** Older remote server hosts may not return this; callers should treat it as false. */
  isSymbolicLink?: boolean;
}

export interface FileStat {
  path: string;
  type: "file" | "directory";
  /** File size in bytes; older remote server hosts may not return it, so callers must handle undefined. */
  size?: number;
  /** File last-modified time; shared chunked reads use it to detect concurrent rewrites while reading. */
  mtimeMs?: number;
}

/** File system change event (directory-level granularity) */
export interface FileWatchEvent {
  /** Path of the directory that changed */
  dirPath: string;
  /**
   * The full path that changed, when the underlying watcher can confirm it.
   * Omitted for older Hosts, for platforms that return no filename, or when one debounce window covers multiple paths — callers should refresh conservatively.
   */
  changedPath?: string;
}

export interface FileTextSlice {
  path: string;
  content: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
  isBinary: boolean;
}

export interface FileMediaPreview {
  path: string;
  mediaType: string;
  dataBase64: string;
  totalBytes: number;
}

export interface FileBinaryPreview {
  path: string;
  dataBase64: string;
  totalBytes: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

export interface SystemInfo {
  homedir: string;
  platform: string;
}

/** Supported locales */
export type Locale = "en-US";

/** Interaction behavior when the user keeps typing while ZCode is running */
export type ZCodeInteractionBehavior = "queue" | "guide";

/** Electron auto-update release channel on desktop. */
export type ElectronReleaseChannel = "stable" | "preview";

/** Integrated-terminal shell dialects the Windows Bash tool can use. */
export type IntegratedTerminalShellDialect = "cmd" | "git-bash";

/** The user's Windows Bash shell choice in settings. */
export type IntegratedTerminalShellSelection =
  | { mode: "auto" }
  | {
      mode: "shell";
      dialect: IntegratedTerminalShellDialect;
      id: string;
      label: string;
      path: string;
    };

/** Windows shell options the current host recognizes. */
export interface IntegratedTerminalShellOption {
  dialect: IntegratedTerminalShellDialect;
  id: string;
  label: string;
  path: string;
  source: "system" | "path";
}

/** Default locale */
export const DEFAULT_LOCALE: Locale = "en-US";

// ── Workspace / Tab ──

/** Unique tab identifier */
export type TabId = string;

/** State of a single tab */
export interface TabState {
  id: TabId;
  /** Absolute workspace path */
  workspacePath: string;
  /** Display name, usually the last path segment */
  label: string;
}

export interface SSHRemoteTargetSnapshot {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  /** The SSH config Host alias the user picked when connecting, used for UI display only. */
  sshConfigAlias?: string;
  privateKeyPath?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
  /**
   * The SSH password is never written into setting.json.
   * Only the credentialService key name is stored here; the real password is read from secure storage at restore time.
   */
  passwordCredentialKey?: string;
  /**
   * The private key passphrase is never written into setting.json.
   * Only the credentialService key name is stored here; the real passphrase is read from secure storage at restore time.
   */
  privateKeyPassphraseCredentialKey?: string;
}

export interface WSLRemoteTargetSnapshot {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export type RemoteTargetSnapshot = SSHRemoteTargetSnapshot | WSLRemoteTargetSnapshot;
export interface RemoteWorkspaceSessionSnapshot {
  /** The real absolute path of the remote workspace */
  workspacePath: string;
  /** The local workspace path at the moment the remote connection was opened, used only to rewrite MCP filesystem paths. */
  localWorkspacePath?: string;
  /** Stable identity key of the remote workspace (authority + canonicalPath). */
  workspaceIdentity?: string;
  /** Restorable snapshot of the remote connection target */
  target: RemoteTargetSnapshot;
  /** Timestamp of the last successful open of this workspace */
  lastOpenedAt: number;
  /** Result of the most recent restore/reconnect */
  lastConnectionStatus: "connected" | "failed";
  /** Reason for the most recent failure; cleared on success */
  lastConnectionError?: string;
}

export interface LocalWorkspaceSessionEntry {
  kind: "local";
  workspacePath: string;
  /** Project display category; legacy data defaults to project, while conversation still uses the real workspacePath as its cwd/key. */
  workspacePurpose?: WorkspacePurpose;
}

export interface RemoteWorkspaceSessionEntry extends RemoteWorkspaceSessionSnapshot {
  kind: "remote";
}

export type PersistedWorkspaceSessionEntry =
  | LocalWorkspaceSessionEntry
  | RemoteWorkspaceSessionEntry;

// ── Process Monitor ──

/** Resource explorer category: base service / builtin plugin / community plugin */
export type ResourceUsageCategory = "base" | "builtin-plugin" | "community-plugin";

/** Base-service group key; plugin group keys are the plugin name or the MCP server name */
export type ResourceUsageBaseGroupKey = "main" | "gpu" | "renderer" | "host" | "cli" | "utility";

/** One process row in the resource explorer (CPU is a whole-machine normalized percentage, memory is in bytes) */
export interface ResourceUsageProcess {
  pid: number;
  /** Process display name, e.g. zcode-main / zcode-agent-zcode-demo / node_repl */
  name: string;
  category: ResourceUsageCategory;
  groupKey: string;
  groupLabel: string;
  cpuPercent: number;
  memoryBytes: number;
  /** false means only the topology is known and metrics have not been sampled yet (rendered as —) */
  sampled: boolean;
}

/** External process rows sampled on the Host side (Agent / MCP / terminal, etc.), merged into the snapshot by main */
export type HostResourceUsageProcess = Omit<ResourceUsageProcess, "sampled">;

/** One complete resource explorer snapshot, returned by the main process after merging Electron metrics, system totals, and Host samples */
export interface ResourceUsageSnapshot {
  sampledAt: number;
  logicalCpuCount: number;
  system: {
    cpuPercent: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
  };
  app: {
    cpuPercent: number;
    memoryBytes: number;
  };
  processes: ResourceUsageProcess[];
}

export interface AppSettings {
  /** The current App/Host no longer shows the pre-commit experience plan recommendation; it does not change model selection in any entry point. */
  startPlanRecommendationDismissed?: boolean;
  recentProjects: string[]; // List of recent projects, up to 10 kept
  /**
   * User-overridden keyboard shortcut bindings (command ID → array of binding strings, see shortcutCommands.ts for the format).
   * Only overrides are stored: commands without an override are never persisted and are merged with the SHORTCUT_COMMANDS defaults on read;
   * an override replaces the whole group (e.g. overriding openCommandCenter's two default bindings disables both at once).
   */
  shortcutBindings?: Record<string, string[]>;
  /** Whether to inherit the system terminal profile, shell environment, and font as far as possible */
  terminalInheritSystemProfile?: boolean;
  /** Terminal font explicitly overridden by the user; when empty it is auto-detected from the system terminal config */
  terminalFontFamily?: string;
  /** Native shell used by the Bash tool on Windows; auto-selected when unset. */
  integratedTerminalShell?: IntegratedTerminalShellSelection;
  /** HTTP/HTTPS egress proxy, e.g. http://127.0.0.1:7890; a direct connection is used when empty. Takes effect on the next app/agent start. */
  httpProxy?: string;
  /** Proxy bypass rules, e.g. localhost,127.0.0.1,.example.com; only affect the renderer when httpProxy is set, while agent/tool still honor the explicit environment. */
  httpProxyNoProxy?: string;
  /** Custom PEM root certificate path; on the next app/agent start it is used for renderer verification and for the agent's NODE_EXTRA_CA_CERTS. */
  httpProxyCaCertPath?: string;
  /**
   * The built-in browser ignores HTTPS certificate validation errors (self-signed, expired, hostname mismatch, etc.) to reach internal test sites.
   * This only affects the built-in browser's egress, not ZCode's own requests to the backend and model APIs. Off by default; takes effect after restart.
   */
  embeddedBrowserAllowInsecureCertificates?: boolean;
  /** One-time display preference applied when a human user opens the Browser tab; Agent Browser Use neither reads nor writes it. */
  embeddedBrowserViewportPreference?: EmbeddedBrowserViewportPreference;
  /**
   * The user has turned off the composer's "computer use" button in settings (an internal hidden state).
   * It uses hidden rather than visible semantics: undefined means shown by default, so existing users need no data migration.
   * Once turned off the button is no longer rendered and never self-heals through a restart or version update; it can only be turned back on in settings.
   */
  computerUseComposerEntryHidden?: boolean;
  /** Master switch for auto-archiving finished legacy tasks */
  taskAutoArchiveEnabled?: boolean;
  /** Auto-archive threshold; a task may be archived once its last update time is older than this many days */
  taskAutoArchiveOlderThanDays?: number;
  /** Hide to the tray when the window is closed on Windows desktop; ignored on other platforms */
  closeToTrayOnWindows?: boolean;
  /** Block system idle sleep while an off-peak task is running (a manual switch; it cannot prevent lid-close sleep). */
  keepAwakeWhileRunning?: boolean;
  /** Whether the one-time migration of the Windows close-to-tray default has already run; used only for settings migration, never in business logic. */
  closeToTrayOnWindowsMigrationInitialized?: boolean;
  /** Global page zoom level on desktop; restores the UI scale after restart, ignored on Web/mobile. */
  desktopZoomLevel?: number;
  /** Most recent non-maximized width/height and maximized state of the desktop main window; ignored on Web/mobile. */
  desktopWindowSize?: {
    width: number;
    height: number;
    maximized: boolean;
  };
  /** Chromium hardware acceleration switch on desktop; only takes effect early in the next main-process start, ignored on Web/mobile. */
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  /** Whether to show the model's reasoning process in the message stream */
  messageStreamShowReasoning?: boolean;
  // TODO (settings-schema-version): After this migration can be proven that all supported upgrade paths have been performed, use the unified settings schema version and delete this marker, migration function and persistence judgment together.
  /** Whether the one-time migration of the "show model reasoning" default has already run; used only for settings migration, never for message rendering decisions. */
  messageStreamShowReasoningMigrationInitialized?: boolean;
  /** Whether to show todo tool rendering in the message stream; does not affect todos in the summary panel */
  messageStreamShowTodos?: boolean;
  /** Whether to group consecutive read-only tool calls into Explore. */
  toolGroupingExploreEnabled?: boolean;
  /** Whether to group consecutive non-read-only Shell tool calls into Terminal. */
  toolGroupingTerminalEnabled?: boolean;
  /** Whether to group consecutive Write/Edit/ApplyPatch tool calls into Changes. */
  toolGroupingChangesEnabled?: boolean;
  /** When the user keeps typing while ZCode is running, whether the input is queued for the next turn or guided to run after the next tool call */
  zcodeInteractionBehavior?: ZCodeInteractionBehavior;
  /** Whether an Agent question may auto-continue after five minutes with no answer; a missing value means enabled, for compatibility with old configs. */
  askUserQuestionAutoResolutionEnabled?: boolean;
  /** Whether to retain Model I/O in full; when enabled it is never rotated, quota-reset, compressed, or trimmed, though auth information is still redacted. */
  modelIoFullRetentionEnabled?: boolean;
  /** The one structured connection selection currently active for each Provider Family in settings. */
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  /** The ZAI / BigModel provider family runtime domain confirmed by the user after connecting successfully through the WelcomeScreen. */
  providerFamilyDomain?: ProviderFamilyDomain;
  /** Time of the last time providerFamilyDomain was set or cleared. */
  providerFamilyDomainUpdatedAt?: number;
  /** Whether legacy oauth/provider state has already been migrated to providerFamilyDomain. */
  providerFamilyDomainMigrated?: boolean;
  /** Whether newly created or cold-restored Sessions get the bfs/ugrep enhancements injected into Bash; enabled by default. */
  nativeSearchEnhancementsEnabled?: boolean;
  /** Whether newly created or cold-restored Sessions enable Memory; disabled by default. */
  memoryEnabled?: boolean;
  onboardingOccupation?:
    | "office"
    | "developer"
    | "independent"
    | "infrastructure"
    | "product"
    | "design"
    | "student"
    | "creator"
    | "operations"
    | "marketing"
    | "finance"
    | "accounting"
    | "legal"
    | "other"
    | null;
  proactiveSuggestionsEnabled?: boolean;
  /** The full set of workspace sessions at last shutdown (local and remote workspaces) */
  lastWorkspaceSession?: PersistedWorkspaceSessionEntry[];
  /** Index of the tab that was active at last shutdown */
  lastActiveTabIndex?: number;
  /** Last active taskId per workspace, auto-restored on next open */
  lastActiveTaskByWorkspace?: Record<string, string>;
  /** Root path of the data directory (replaces homedir), defaults to os.homedir(); the .zcode/v2 suffix is unchanged */
  dataBaseDir?: string;
  /** Release notes to show on the first start after an auto-update install completes */
  pendingPostUpdateReleaseNotes?: {
    version: string;
    title: string;
    markdown: string;
    releaseDate?: string;
    releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
  };
  /** The "receive preview auto-updates" preference in settings; only read by desktop auto-update. */
  receivePreviewUpdates?: boolean;
  /** The "automatically download and install updates from now on" preference in settings / the update dialog; only read by desktop auto-update. */
  autoDownloadAndInstallUpdates?: boolean;
  /** Electron auto-update versions the user skipped; isolated per channel so stable / preview never shadow each other. */
  skippedElectronUpdateVersions?: Partial<Record<ElectronReleaseChannel, string>>;
  /** Whether the first-run settings sync prompt has been consumed; it only means the dialog no longer appears, not that the import succeeded. */
  settingsSyncFirstRunPromptHandled?: boolean;
  /** Temporary endpoint override in settings; the production/test default base url is managed by the ZCODE_BASE_URL env var. */
  zcodeEndpointOrigin?: string;
}
