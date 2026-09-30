/**
 * The shared contract for whole-process CPU / memory monitoring instrumentation.
 *
 * This file only holds the constants and pure validation that "main and the unit tests must share one copy of": the process role
 * enum, the three event names, the allowlist of property keys per event, property counting and the privacy checks.
 * The actual sampling and aggregation live on the desktop main side.
 */

/** The 10 process roles of the first phase. */
export const PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
  "cli_chat",
  "cli_aux",
  "mcp",
] as const;

export type ProcessResourceRole = (typeof PROCESS_RESOURCE_ROLES)[number];

/**
 * zcode-cli's self-sampling period, the cadence contract between the CLI and the app:
 * on the CLI side it is the timer period; on the main side it is both the base for "how long counts as one CLI sample" and the base of the expiry rule (2 periods).
 * Both sides must use the same source, otherwise changing the CLI cadence makes main's `sample_count` silently drift from the agreed value.
 */
export const ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

/**
 * zcode-cli's process lanes.
 *
 * lane is not a field of the CLI protocol — a CLI process does not know which process manager launched it, so the app-side services layer
 * tags samples by the owning process manager while parsing them (`chat` is the workspace-level Agent, the other two are control-plane lanes).
 */
export const PROCESS_RESOURCE_CLI_LANES = ["chat", "plugin", "mcp-status"] as const;

export type ProcessResourceCliLane = (typeof PROCESS_RESOURCE_CLI_LANES)[number];

/**
 * lane → role: `chat` maps to `cli_chat` (one process per workspace), and the other two lanes are merged into `cli_aux`.
 *
 * The default (no lane) maps to `cli_chat`: the only possible source is a remote server that is behind on version and has not tagged its samples with a lane yet,
 * and on a remote workspace it is the chat lane that lives long and consumes resources; mapping to cli_chat is closer to the truth than dropping the whole sample.
 */
export function resolveCliProcessResourceRole(
  lane: ProcessResourceCliLane | undefined,
): Extract<ProcessResourceRole, "cli_chat" | "cli_aux"> {
  return lane === undefined || lane === "chat" ? "cli_chat" : "cli_aux";
}

/** Where the process actually runs; samples from a remote CLI / MCP carry remote themselves. */
export type ProcessResourceRuntimeSurface = "local" | "remote";

export const PROCESS_RESOURCE_EVENT_NAMES = {
  processWindow: "perf_process_window",
  systemWindow: "perf_system_window",
  toolExecResource: "perf_tool_exec_resource",
} as const;

export type ProcessResourceEventName =
  (typeof PROCESS_RESOURCE_EVENT_NAMES)[keyof typeof PROCESS_RESOURCE_EVENT_NAMES];

/** The cap on the number of properties of a single ARMS custom event (computed after merging global and event properties). */
export const ARMS_CUSTOM_EVENT_PROPERTY_LIMIT = 20;

/** The global properties shared by all resource events. */
const PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS = [
  "platform",
  "app_version",
  "arms_env",
  "device_mid",
] as const;

/**
 * All possible properties of `perf_process_window` (21 of them).
 * A single event carries at most 20: Node roles and renderer_main carry 20 (including both heap entries, without mcp_id),
 * mcp carries 19 (including mcp_id, without heap), and gpu / renderer_guest / chromium_other carry 18.
 */
export const PERF_PROCESS_WINDOW_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "process_role",
  "runtime_surface",
  "arch",
  "logical_cpu_count",
  "total_memory_gb",
  "mcp_id",
  "background_ratio",
  "uptime_minutes",
  "cpu_percent_p95",
  "cpu_percent_peak",
  "rss_kb_total_mean",
  "rss_kb_total_peak",
  "rss_kb_max_process_peak",
  "heap_used_kb_mean",
  "heap_used_kb_peak",
  "process_count_peak",
  "sample_count",
] as const;

/** All properties of `perf_system_window` (17 of them). */
export const PERF_SYSTEM_WINDOW_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "arch",
  "logical_cpu_count",
  "total_memory_gb",
  "background_ratio",
  "app_uptime_minutes",
  "system_cpu_percent_p95",
  "system_free_memory_kb_min",
  "app_cpu_percent_p95",
  "app_rss_kb_total_mean",
  "app_rss_kb_total_peak",
  "process_count_total_peak",
  "sample_count",
  "telemetry_self_ms",
] as const;

/** All properties of `perf_tool_exec_resource` (12 of them; Windows lacks the two tree_* entries, so 10). */
export const PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS = [
  ...PROCESS_RESOURCE_GLOBAL_PROPERTY_KEYS,
  "runtime_surface",
  "tool_name",
  "exit_kind",
  "tree_rss_kb_peak",
  "tree_cpu_time_ms",
  "sample_count",
  "cli_rss_kb",
  "system_free_memory_kb",
] as const;

const PROPERTY_KEY_WHITELIST: Record<ProcessResourceEventName, readonly string[]> = {
  [PROCESS_RESOURCE_EVENT_NAMES.processWindow]: PERF_PROCESS_WINDOW_PROPERTY_KEYS,
  [PROCESS_RESOURCE_EVENT_NAMES.systemWindow]: PERF_SYSTEM_WINDOW_PROPERTY_KEYS,
  [PROCESS_RESOURCE_EVENT_NAMES.toolExecResource]: PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS,
};

/**
 * Privacy red line: property keys must not contain pid / path / workspace / session / task / command semantics.
 * `device_mid` and `mcp_id` do not match that pattern (`mid` and `p_id` are not substrings of `pid`).
 */
export const PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN =
  /pid|path|workspace|session|task|command/i;

export interface ProcessResourceEventPropertyCheck {
  /** Within the allowlist, not over the count limit, and free of privacy keys. */
  ok: boolean;
  /** The number of properties actually reported (entries whose value is undefined are not counted). */
  count: number;
  overLimit: boolean;
  unknownKeys: string[];
  forbiddenKeys: string[];
}

/** Validates that the property set of one resource event matches the allowlist, the property count limit and the privacy red line. */
export function checkProcessResourceEventProperties(
  eventName: ProcessResourceEventName,
  properties: Record<string, string | number | boolean | undefined>,
): ProcessResourceEventPropertyCheck {
  const whitelist = new Set(PROPERTY_KEY_WHITELIST[eventName]);
  const presentKeys = Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  const unknownKeys = presentKeys.filter((key) => !whitelist.has(key));
  const forbiddenKeys = presentKeys.filter((key) =>
    PROCESS_RESOURCE_FORBIDDEN_PROPERTY_KEY_PATTERN.test(key),
  );
  const count = presentKeys.length;
  const overLimit = count > ARMS_CUSTOM_EVENT_PROPERTY_LIMIT;

  return {
    ok: unknownKeys.length === 0 && forbiddenKeys.length === 0 && !overLimit,
    count,
    overLimit,
    unknownKeys,
    forbiddenKeys,
  };
}
