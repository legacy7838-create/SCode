/**
 * Storage classification catalog: maps relative paths under the .zcode root to categories,
 * aggregation keys and cleanability.
 * A pure function and the single source of truth.
 * Match order: root-level special cases → file rules (exact) → prefix rules (longest prefix
 * first) → anything else.
 */
import type { StorageCategoryId, StorageCleanability, StorageRootId } from "@zcode/shared";

export interface StorageCatalogContext {
  rootId: StorageRootId;
  hasCustomDataBaseDir: boolean;
}

interface StorageClassification {
  categoryId: StorageCategoryId;
  /** Aggregation key for drill-down details: the level below the path a rule matched. */
  entryKey: string;
}

/** Scope that has to be enumerated for cleanup; recursive=false means only the direct children of that directory are examined (used by file rules). */
export interface StorageCleanScope {
  prefix: string;
  recursive: boolean;
}

const CLEANABILITY: Record<StorageCategoryId, StorageCleanability> = {
  sessionStore: "none",
  // Only subagent transcript.jsonl is deletable; other tool outputs and temporary caches are not yet deletable.
  subagentTranscripts: "safe",
  toolOutputs: "none",
  modelTrajectory: "safe",
  devTraces: "safe",
  logs: "safe",
  backups: "confirm",
  exports: "safe",
  runtimes: "none",
  config: "none",
  other: "none",
};

interface FileRule {
  categoryId: StorageCategoryId;
  pattern: RegExp;
  /** The aggregation key takes the first N segments of the path (the full path by default). */
  entryKeySegments?: number;
}

/** File-level rules: evaluated in order, first match wins (backups/caches must be listed before the generic config rule). */
const FILE_RULES: FileRule[] = [
  // Subagent run records (single files can reach tens of MB), aggregated by session directory
  {
    categoryId: "subagentTranscripts",
    pattern: /^cli\/agents\/[^/]+\/[^/]+\/transcript\.jsonl$/,
    entryKeySegments: 3,
  },
  { categoryId: "sessionStore", pattern: /^v2\/[^/]+\.sqlite(?:-wal|-shm)?$/ },
  { categoryId: "sessionStore", pattern: /^cli\/db\/db\.sqlite(?:-wal|-shm)?$/ },
  { categoryId: "toolOutputs", pattern: /^v2\/checkpoints\/(?:.+\/)?(?:pending|tmp)\// },
  { categoryId: "backups", pattern: /^cli\/db\/db\.sqlite\.[^/]+$/ },
  { categoryId: "backups", pattern: /^cli\/config\.json\.bak[^/]*$/ },
  { categoryId: "backups", pattern: /^v2\/[^/]+\.bak$/ },
  { categoryId: "backups", pattern: /^v2\/[^/]+\.backup\.json$/ },
  { categoryId: "backups", pattern: /^v2\/setting\.json\.(?:corrupt-|[^/]*backup)[^/]*$/ },
  { categoryId: "backups", pattern: /^v2\/config\.json\.pre-[^/]+$/ },
  { categoryId: "toolOutputs", pattern: /^v2\/coding-plan-cache\.json$/ },
  // Bot history cache is only for resource explorer identification and display; it does not load config or start channels.
  { categoryId: "toolOutputs", pattern: /^v2\/bots-model-cache[^/]*\.json$/ },
  { categoryId: "logs", pattern: /^computer-use\/run\/[^/]+\.log$/ },
  { categoryId: "config", pattern: /^v2\/[^/]+\.json$/ },
  { categoryId: "config", pattern: /^cli\/config\.json$/ },
  { categoryId: "config", pattern: /^agents\/[^/]+\.md$/ },
  { categoryId: "config", pattern: /^AGENTS\.md$/ },
];

/** Prefix rules: the value is a directory prefix relative to the root, and the longest match wins. */
const PREFIX_RULES: Record<Exclude<StorageCategoryId, "other">, string[]> = {
  sessionStore: ["v2/sessions", "v2/session-bindings", "v2/checkpoints"],
  // transcript.jsonl is matched by the file rules above; the remaining cli/agents content stays here
  subagentTranscripts: [],
  toolOutputs: [
    "cli/artifacts",
    "cli/agents",
    "cli/sessions",
    "cli/exec",
    "cli/image-cache",
    "cli/pdf-cache",
    "clipboard",
    "git-checkpoint-index",
    "editor-icon",
    "tmp",
    "cache",
  ],
  modelTrajectory: ["cli/debug", "cli/rollout"],
  devTraces: ["v2/dev", "v2/acp-traffic-proxy", "v2/acp-stream-diagnostics"],
  logs: ["v2/logs", "cli/log", "logs", "v2/crash", "v2/perf", "feedback/logs"],
  backups: ["backup", "v2/backup", "v2/migrations", "cli/db/backup", "cli/db/backups"],
  exports: ["export-log", "export-log-stage", "feedback"],
  runtimes: ["agents", "bundled-agents", "lite", "computer-use", "cli/plugins"],
  // cli/plugins as a whole (including cache) cannot be cleaned; plugin cache belongs to the runtime.
  config: [
    "v2/agent-config",
    "v2/bots-runtime-locks",
    "v2/bot-attachments",
    "v2/certs",
    "v2/acp-auth",
    "v2/acp-config",
    "v2/provider",
    "cli/models",
    "cli/memories",
    "cli/workflows",
    "security",
    "commands",
    "skills",
    "workflows",
    "workspace",
    "mailbox",
    "server",
    "controller",
    "launcher",
    "dev-signing",
    "cua-helper-dev-identity",
    "perf-task-manifests",
    "plugin-workspace",
    "projects",
  ],
};

const PREFIX_INDEX: Array<{ prefix: string; categoryId: StorageCategoryId }> = Object.entries(
  PREFIX_RULES,
)
  .flatMap(([categoryId, prefixes]) =>
    prefixes.map((prefix) => ({ prefix, categoryId: categoryId as StorageCategoryId })),
  )
  .sort((a, b) => b.prefix.length - a.prefix.length);

/** Files that can never be deleted under any category: startup bootstrap files, credentials, Helper broker credentials, diagnostic switches, active crash dumps. */
const PROTECTED_BASENAMES = new Set([
  "setting.json",
  "setting.json.lock",
  "credentials.json",
  ".credentials.json",
  ".tokens",
  "zcode-stdio-tap.json",
]);
const PROTECTED_PREFIXES = ["v2/crash/live"];

export function normalizeStorageRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function entryKeyBelow(path: string, prefix: string): string {
  const rest = path.slice(prefix.length + 1);
  const next = rest.split("/")[0];
  return next ? `${prefix}/${next}` : prefix;
}

export function classifyStoragePath(
  rawPath: string,
  context: StorageCatalogContext,
): StorageClassification {
  const path = normalizeStorageRelativePath(rawPath);
  // After enabling custom data paths, the v2 under the home root is a legacy copy from migration, classified as "Other" as a whole, with no cleanup provided.
  if (context.rootId === "home" && context.hasCustomDataBaseDir && isUnderPrefix(path, "v2")) {
    return { categoryId: "other", entryKey: "v2" };
  }
  // agent/ is a remnant from the ACP era with no writers in the current code, also classified as "Other".
  if (isUnderPrefix(path, "agent")) {
    return { categoryId: "other", entryKey: "agent" };
  }
  for (const rule of FILE_RULES) {
    if (rule.pattern.test(path)) {
      const entryKey = rule.entryKeySegments
        ? path.split("/").slice(0, rule.entryKeySegments).join("/")
        : path;
      return { categoryId: rule.categoryId, entryKey };
    }
  }
  for (const { prefix, categoryId } of PREFIX_INDEX) {
    if (isUnderPrefix(path, prefix)) {
      return { categoryId, entryKey: entryKeyBelow(path, prefix) };
    }
  }
  return { categoryId: "other", entryKey: path.split("/")[0] ?? path };
}

export function getStorageCategoryCleanability(categoryId: StorageCategoryId): StorageCleanability {
  return CLEANABILITY[categoryId];
}

export function isProtectedStoragePath(rawPath: string): boolean {
  const path = normalizeStorageRelativePath(rawPath);
  const basename = path.split("/").at(-1) ?? path;
  if (PROTECTED_BASENAMES.has(basename)) return true;
  return PROTECTED_PREFIXES.some((prefix) => isUnderPrefix(path, prefix));
}

/** Directories that contain file rules: cleanup only needs to enumerate them non-recursively. */
const FILE_RULE_SCOPES: Partial<Record<StorageCategoryId, string[]>> = {
  backups: ["cli/db", "cli", "v2"],
  logs: ["computer-use/run"],
};
/** Categories covered only by file rules that need recursive enumeration: after filtering candidates by classification, only the paths matching a file rule remain. */
const RECURSIVE_FILE_RULE_SCOPES: Partial<Record<StorageCategoryId, string[]>> = {
  subagentTranscripts: ["cli/agents"],
};

export function getStorageCleanScopes(categoryId: StorageCategoryId): StorageCleanScope[] {
  if (categoryId === "other" || CLEANABILITY[categoryId] === "none") return [];
  const recursive = [
    ...PREFIX_RULES[categoryId],
    ...(RECURSIVE_FILE_RULE_SCOPES[categoryId] ?? []),
  ].map((prefix) => ({ prefix, recursive: true }));
  const shallow = (FILE_RULE_SCOPES[categoryId] ?? []).map((prefix) => ({
    prefix,
    recursive: false,
  }));
  return [...recursive, ...shallow];
}
