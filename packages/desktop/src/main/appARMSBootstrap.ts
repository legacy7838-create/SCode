import { wrapStartupReporterRequest } from "./startupTelemetryDelivery.js";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import armsRum from "@arms/rum-electron";
import { ZCODE_AGENT_LIFECYCLE_LOG_MARKER } from "@zcode/shared/process-diagnostic";
import {
  ZCODE_ARMS_RUM_ENDPOINT,
  ZCODE_VERSION,
  ZCODE_TELEMETRY_ENABLED,
  mapZCodeEnvToArmsRumEnv,
} from "@zcode/shared";
import { ARMS_BROWSER_COLLECTORS, parseArmsViewName } from "../shared/armsRumShared.js";
import { redactArmsEventBatch } from "./armsEventRedaction.js";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import { ingestArmsApiEventsFromBatch } from "./desktopNetworkTelemetry.js";
import { desktopRuntimeEnv, runtimeApplicationName } from "./desktopRuntimeEnv.js";
import { summarizeLongTaskAttribution } from "./longTaskAttributionSummary.js";
import { logger } from "./logger.js";

// The snapshots of LoAF long task events (the top-5 attribution collected by the SDK) do not fall into SLS by default, and are added here.
// event.properties makes the attribution summary (top time consumption/proportion/invokerType) queryable. The original script name/URL is not reported.
function enrichLongTaskAttribution(events: Array<Record<string, unknown>>): void {
  for (const event of events) {
    if (event.event_type !== "longTask") {
      continue;
    }
    const summary = summarizeLongTaskAttribution(event.snapshots, event.duration);
    if (!summary) {
      continue;
    }
    const existingProps =
      event.properties && typeof event.properties === "object"
        ? (event.properties as Record<string, unknown>)
        : {};
    event.properties = { ...existingProps, ...summary };
  }
}

function isCrashReporterEvent(event: Record<string, unknown>): boolean {
  return (
    event.event_type === "exception" && event.type === "crash" && event.source === "crashReporter"
  );
}

function normalizeExecutableName(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/\.exe$/i, "")
    : "";
}

function hasProductExecutable(
  event: Record<string, unknown>,
  applicationName: string,
  runtimeExecutableName?: string,
): boolean {
  // Reason for repair: app name is not equal to the real binary name of all running modes; development mode uses Electron.
  // Linux Preview uses zcode-preview. Both must match exactly and cannot be relaxed to a prefix to avoid being mixed into the helper dump.
  const expectedNames = new Set(
    [applicationName, runtimeExecutableName].map(normalizeExecutableName).filter(Boolean),
  );
  if (expectedNames.size === 0 || !Array.isArray(event.binary_images)) {
    return false;
  }
  return event.binary_images.some((image) => {
    if (!image || typeof image !== "object") {
      return false;
    }
    return expectedNames.has(normalizeExecutableName((image as Record<string, unknown>).name));
  });
}

type NativeDumpProcessRole = "main" | "renderer" | "utility" | "gpu" | "host" | "agent" | "unknown";

const nativeDumpProcessRoleAliases: Record<string, NativeDumpProcessRole> = {
  main: "main",
  browser: "main",
  main_process: "main",
  renderer: "renderer",
  utility: "utility",
  utility_host: "utility",
  gpu: "gpu",
  host: "host",
  agent: "agent",
};

function readNativeDumpProcessRole(event: Record<string, unknown>): NativeDumpProcessRole {
  const metadata =
    event.meta && typeof event.meta === "object"
      ? (event.meta as Record<string, unknown>)
      : undefined;
  // Reason for fix: Generic process_role may be injected by event attributes or middleware and is not proven from Crashpad dump.
  // Only trust meta.process_type that dependency patches extract and write from structured annotation RVA, avoid helpers
  // dump promoted to app_native_process by unstructured main tag, polluting Native Crash/Crash-Free.
  const processType = metadata?.process_type;
  if (typeof processType === "string") {
    return nativeDumpProcessRoleAliases[processType.trim().toLowerCase()] ?? "unknown";
  }
  return "unknown";
}

export function filterAndEnrichNativeCrashEvents(
  events: Array<Record<string, unknown>>,
  applicationName: string,
  runtimeExecutableName?: string,
): Array<Record<string, unknown>> {
  return events.filter((event) => {
    if (!isCrashReporterEvent(event)) {
      return true;
    }
    if (!hasProductExecutable(event, applicationName, runtimeExecutableName)) {
      return false;
    }
    const existingProperties =
      event.properties && typeof event.properties === "object"
        ? (event.properties as Record<string, unknown>)
        : {};
    const nativeDumpProcessRole = readNativeDumpProcessRole(event);
    // Root cause: binary_images can only prove that the dump comes from the product binary and cannot distinguish between Linux/Windows
    // A main process, renderer, utility or host that shares the same executable. Unknown characters remain original
    // crashReporter event, but must not enter app_native_process, otherwise the helper crash loop will
    // Treat the application as native crash and lower Crash-Free. Only dumps explicitly marked as main enter product KPIs.
    event.properties = {
      ...existingProperties,
      telemetry_schema_version: "2",
      // Bugfix: SDK retries may cause the same event to pass through beforeReport again, and the incident ID must be retained for deduplication.
      crash_id:
        typeof existingProperties.crash_id === "string"
          ? existingProperties.crash_id
          : randomUUID(),
      crash_scope:
        nativeDumpProcessRole === "main" ? "app_native_process" : "native_dump_unattributed",
      crash_cause: "native_crash",
      crash_source: "crash_reporter_dump",
      native_dump_process_role: nativeDumpProcessRole,
    };
    return true;
  });
}

// Bugfix: The product backend can use production, but the Desktop started by the source code is still in the local development and running state;
// The ARMS environment must first be marked as local according to the running state to avoid development data contamination of prod.
const armsRumEnv = mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv);

// The ARMS user.id field is forced to be rewritten to an internal random value by the SDK (config.user.id is explicitly skipped during event merging.
// cannot be injected), while user.name is not masked. Here, write device_mid to user.name so that the RUM log can be
// Device dimension association. device_mid reuses the same persistent UUID of telemetry-state.json (same origin as data warehouse/preload injection,
// ensureDesktopDeviceMidSync is idempotent and does not write disk repeatedly).
// Note: After the rendering process events are forwarded to the main process via ArmsEventBridge, the main process client uses "main process config"
// Repackage and report, so you only need to set it once in the main process init to cover all reports of the main process + rendering process.
const armsDeviceMid = ensureDesktopDeviceMidSync();

// Reason: armsRum.init() returns Promise; without await, web-contents-created/rendering process injection may be later than the first window dom-ready, resulting in zero reporting.
// You must await armsInitPromise (see index.ts) before creating the BrowserWindow in app.whenReady().
// The SDK's sendCustom only indicates joining the queue, and the original request does not check HTTP status.
// Wrap the transport during init installation by exposing useReporter, retaining the original SDK's filtering and serialization links.
const useReporter = armsRum.client.useReporter.bind(armsRum.client);
armsRum.client.useReporter = (reporter) => {
  const request = reporter.request.bind(reporter);
  reporter.request = wrapStartupReporterRequest(request, {
    acknowledged: (eventIds, delivery) =>
      logger.info("[database-startup] telemetry delivery", { eventIds, delivery }),
  });
  useReporter(reporter);
};
function startArmsRum(): Promise<void> {
  return armsRum
    .init({
      enable: true,
      version: ZCODE_VERSION,
      endpoint: ZCODE_ARMS_RUM_ENDPOINT,
      env: armsRumEnv,
      // Browser SDK is injected by SDK through executeJavaScript in dom-ready; do not manually init in preload/renderer to avoid repeated collection.
      autoInject: true,
      browserCollectors: { ...ARMS_BROWSER_COLLECTORS },
      app: {
        name: runtimeApplicationName,
        version: ZCODE_VERSION,
        env: armsRumEnv,
        type: "electron",
        framework: "react",
      },
      user: {
        name: armsDeviceMid,
      },
      // Session sampling: must be 1, otherwise ARMS default PV/perf/webvitals and other whole session events will be discarded (about 90% cannot see page performance when developing 0.1)
      sessionConfig: {
        sampleRate: 1,
      },
      // The Electron desktop is a single page file:// / dev-server. The whole page is loaded, without History routing; only false can be used. The SDK defaults to "full page loading" perf collection.
      spaMode: false,
      parseViewName: parseArmsViewName,
      collectors: {
        jsError: true,
        consoleError: true,
        crash: true,
        application: true,
        api: true,
        rpc: true,
      },
      // Main process collectors: Electron side; renderer side see browserCollectors + autoInject
      // SDK tracing.sample takes a value of 0–100 (percentage); 0.1 means 0.1% sampling, almost no hits
      tracing: {
        enable: true,
        sample: armsRumEnv === "prod" ? 0.1 : 1,
      },
      // HTTP full link time consumption comes from ARMS api batch; production/local running both ingest, local running additionally prints batch summary
      beforeReport: (payload: { events?: Array<Record<string, unknown>> }) => {
        // Bugfix: The crash collector will scan the shared dump directory, and dumps from external descendant processes may also be mixed in.
        // Only retain native crashes containing the current product executable file; filtering only traverses existing batch metadata and does not add new IO.
        const events = filterAndEnrichNativeCrashEvents(
          // Local error logs reported by the structured life cycle are no longer collected repeatedly as console JS exceptions.
          // Filters wrapped events only by explicit tags, retaining real uncaughtException and other console.errors.
          (payload?.events ?? []).filter(
            (event) =>
              !(
                event.event_type === "exception" &&
                event.type === "error" &&
                event.source === "console.error" &&
                typeof event.message === "string" &&
                event.message.includes(ZCODE_AGENT_LIFECYCLE_LOG_MARKER)
              ),
          ),
          runtimeApplicationName,
          basename(process.execPath),
        );
        payload.events = events;
        ingestArmsApiEventsFromBatch(events);
        enrichLongTaskAttribution(events);
        // Privacy closures must be ranked after ingest and attribution digests: network aggregation follows its own interface normalization rules,
        // LongTask digests require the original snapshots; only the copies that eventually leave the local machine are desensitized.
        redactArmsEventBatch(events);
        if (desktopRuntimeEnv === "development") {
          const perfEvents = events.filter(
            (event) => String(event.type ?? "").toLowerCase() === "perf",
          );
          const summary = events
            .map((event) => {
              const eventType = String(event.event_type ?? "?");
              const subType = String(event.type ?? "");
              const name = String(event.name ?? "");
              if (subType === "perf") {
                return `${eventType}:perf`;
              }
              return `${eventType}:${name || subType || "?"}`;
            })
            .join(", ");
          logger.info(
            `[arms] beforeReport batch=${events.length} perf=${perfEvents.length}${summary ? ` [${summary}]` : ""}`,
          );
        }
        return payload;
      },
    })
    .then(() => {
      logger.info(`[arms] electron initialized env=${armsRumEnv} version=${ZCODE_VERSION}`);
    })
    .catch((error) => {
      logger.error("[arms] electron init failed:", error);
      throw error;
    });
}

// The SDK is not initialized when the master switch is off or the endpoint is not configured.
export const armsInitPromise: Promise<void> =
  ZCODE_TELEMETRY_ENABLED && ZCODE_ARMS_RUM_ENDPOINT ? startArmsRum() : Promise.resolve();
