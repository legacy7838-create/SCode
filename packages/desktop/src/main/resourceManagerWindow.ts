import { app, BrowserWindow, webContents as electronWebContents } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import os from "node:os";
import { join } from "node:path";
import {
  formatZCodeAgentProcessName,
  formatZCodeGpuProcessName,
  formatZCodeHostProcessName,
  formatZCodeMainProcessName,
  formatZCodeRendererProcessName,
  formatZCodeUtilityProcessName,
  type HostResourceUsageProcess,
  type ResourceUsageProcess,
  type ResourceUsageSnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { normalizeElectronCpuToMachinePercent } from "./electronCpuNormalization.js";
import type { ChromiumProcessRolePids } from "./processResourceRoleClassifier.js";
import { buildAuxiliaryRendererName } from "./resourceManagerProcessNames.js";
import {
  forgetHostResourceUsage,
  requestHostResourceUsage,
} from "./resourceManagerHostSampling.js";

/**
 * Resource manager.
 *
 * main only does three things: Electron's own process metrics (app.getAppMetrics), total system volume (os),
 * Merge external process rows reported by Host. External process sampling is always completed within the Host——
 * Historical bug: PS and PowerShell will freeze the entire App when starting synchronously/asynchronously in main.
 */

const preloadPath = join(import.meta.dirname, "../preload/resourceManager.cjs");
const RESOURCE_MANAGER_WINDOW_TITLE = "Resource Manager";
const BROWSER_USE_PLUGIN_NAME = "browser-use";

/** System CPU: difference in busy / total between two os.cpus() calls */
interface SystemCpuMeter {
  read(): number;
}

function createSystemCpuMeter(
  readCpus: () => Array<{ times: Record<string, number> }> = () => os.cpus(),
): SystemCpuMeter {
  let previous: { busy: number; total: number } | null = null;
  return {
    read() {
      let busy = 0;
      let total = 0;
      for (const cpu of readCpus()) {
        for (const [key, value] of Object.entries(cpu.times)) {
          total += value;
          if (key !== "idle") busy += value;
        }
      }
      const current = { busy, total };
      const baseline = previous;
      previous = current;
      if (!baseline || current.total <= baseline.total) return 0;
      const percent = ((current.busy - baseline.busy) / (current.total - baseline.total)) * 100;
      return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
    },
  };
}

// Singleton: Only one explorer window is allowed at the same time
let instance: BrowserWindow | null = null;
let samplingController: AbortController | undefined;

function stopResourceUsageSampling(): void {
  samplingController?.abort();
  samplingController = undefined;
  for (const label of hostProcesses.keys()) forgetHostResourceUsage(label);
}

/** Only the resource manager itself can start and stop observation; Main owns the single lifecycle. */
export function setResourceUsageSamplingActive(senderId: number, active: boolean): void {
  if (!instance || instance.isDestroyed() || instance.webContents.id !== senderId) return;
  if (active) samplingController ??= new AbortController();
  else stopResourceUsageSampling();
}

export async function getResourceUsageSnapshot(senderId: number): Promise<ResourceUsageSnapshot> {
  if (
    !instance ||
    instance.isDestroyed() ||
    instance.webContents.id !== senderId ||
    !samplingController
  ) {
    throw new Error("Resource sampling is inactive");
  }
  const signal = samplingController.signal;
  const result = await buildResourceUsageSnapshot({ signal });
  signal.throwIfAborted();
  return result;
}

export function getResourceManagerWindowId(): number | null {
  if (!instance || instance.isDestroyed()) {
    return null;
  }
  return instance.id;
}

/**
 * Records active host processes (utility processes).
 * Each BrowserWindow only registers one window-scoped Host; remote connections no longer generate independent Host PIDs.
 * key = window label (such as "local-2"), value = UtilityProcess
 */
const hostProcesses = new Map<string, ElectronUtilityProcess>();

interface RegisteredAgentProcess {
  pid: number;
  provider: ZCodeProvider;
  workspacePath: string;
  command: string;
  args: string[];
  startedAt: number;
}

const hostAgentProcesses = new Map<string, Map<number, RegisteredAgentProcess>>();

export function listRegisteredHostAgentProcessIds(): number[] {
  return [...hostAgentProcesses.values()].flatMap((processes) => [...processes.keys()]);
}

/**
 * The webContents id of the main application window (the window created by createWindow that hosts the workspace).
 * The only data source: resource telemetry returns the main window renderer to `renderer_main`,
 * Auxiliary windows such as Explorer / about / update-status belong to `chromium_other`.
 */
const mainApplicationWindowWebContentsIds = new Set<number>();

export function registerMainApplicationWindow(webContentsId: number): void {
  if (webContentsId > 0) {
    mainApplicationWindowWebContentsIds.add(webContentsId);
  }
}

export function unregisterMainApplicationWindow(webContentsId: number): void {
  mainApplicationWindowWebContentsIds.delete(webContentsId);
}

/** A renderer heap sample belongs to `renderer_main` when judged by the sending webContents. */
export function isMainApplicationWindowWebContents(webContentsId: number): boolean {
  return mainApplicationWindowWebContentsIds.has(webContentsId);
}

/** The utilityProcess of the cron scheduler is registered by the spawn point. */
const schedulerProcesses = new Set<ElectronUtilityProcess>();

export function registerSchedulerProcess(child: ElectronUtilityProcess): void {
  schedulerProcesses.add(child);
}

export function unregisterSchedulerProcess(child: ElectronUtilityProcess): void {
  schedulerProcesses.delete(child);
}

function collectUtilityProcessPids(children: Iterable<ElectronUtilityProcess>): Set<number> {
  const pids = new Set<number>();
  for (const child of children) {
    if (child.pid != null && child.pid > 0) {
      pids.add(child.pid);
    }
  }
  return pids;
}

/**
 * A snapshot of the pids per current process role, used by resource telemetry to split by process_role
 *
 * getAppMetrics does not hand out renderer / host / scheduler roles directly; the BrowserWindow / webContents / utilityProcess
 * registries have to be combined with it to classify them reliably.
 */
export function collectChromiumProcessRolePids(): ChromiumProcessRolePids {
  const mainWindowRendererPids = new Set<number>();
  const guestRendererPids = new Set<number>();

  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) {
      continue;
    }
    const rendererPid = contents.getOSProcessId();
    if (rendererPid <= 0) {
      continue;
    }
    if (mainApplicationWindowWebContentsIds.has(contents.id)) {
      mainWindowRendererPids.add(rendererPid);
      continue;
    }
    // The built-in browser tab is the real `<webview>` guest; secondary windows and DevTools fall to chromium_other.
    if (contents.getType() === "webview") {
      guestRendererPids.add(rendererPid);
    }
  }

  return {
    mainPid: process.pid,
    mainWindowRendererPids,
    guestRendererPids,
    hostPids: collectUtilityProcessPids(hostProcesses.values()),
    schedulerPids: collectUtilityProcessPids(schedulerProcesses),
  };
}

export function registerHostProcess(label: string, child: ElectronUtilityProcess): void {
  hostProcesses.set(label, child);
}

export function unregisterHostProcess(label: string): void {
  hostProcesses.delete(label);
  hostAgentProcesses.delete(label);
  forgetHostResourceUsage(label);
}

export function registerHostAgentProcess(label: string, process: RegisteredAgentProcess): void {
  let processes = hostAgentProcesses.get(label);
  if (!processes) {
    processes = new Map();
    hostAgentProcesses.set(label, processes);
  }

  processes.set(process.pid, process);
}

export function unregisterHostAgentProcess(label: string, pid: number): void {
  const processes = hostAgentProcesses.get(label);
  if (!processes) {
    return;
  }

  processes.delete(pid);
  if (processes.size === 0) {
    hostAgentProcesses.delete(label);
  }
}

/** The browser guest of browser-use is WebContentsView in main, and its renderer belongs to the built-in plug-in browser-use */
let browserUseGuestWebContentsIdsProvider: () => Iterable<number> = () => [];

export function setBrowserUseGuestWebContentsIdsProvider(provider: () => Iterable<number>): void {
  browserUseGuestWebContentsIdsProvider = provider;
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

/**
 * Opens the resource manager window (a singleton).
 * An existing instance is focused instead of being created a second time.
 */
export function openResourceManager(): void {
  if (instance && !instance.isDestroyed()) {
    instance.focus();
    return;
  }

  instance = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    title: RESOURCE_MANAGER_WINDOW_TITLE,
    // Do not inherit the custom title bar of the main window and use the system default title bar.
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Consistent with the main window: Production packages always load rendering resources from signed packages.
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    instance.loadURL(`${base}/resource-manager.html`);
  } else {
    instance.loadFile(join(import.meta.dirname, "../renderer/resource-manager.html"));
  }

  instance.on("closed", () => {
    stopResourceUsageSampling();
    instance = null;
  });
  instance.webContents.on("render-process-gone", stopResourceUsageSampling);
  instance.webContents.on("destroyed", stopResourceUsageSampling);

  logger.info("[resource-manager] window opened");
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function baseProcess(
  pid: number,
  name: string,
  groupKey: string,
  cpuPercent: number,
  memoryBytes: number,
): ResourceUsageProcess {
  return {
    pid,
    name,
    category: "base",
    groupKey,
    groupLabel: groupKey,
    cpuPercent,
    memoryBytes,
    sampled: true,
  };
}

/** Electron itself process (main/gpu/renderer/host/utility) → process line */
function collectElectronProcesses(): ResourceUsageProcess[] {
  const metrics = app.getAppMetrics();
  const metricsByPid = new Map(metrics.map((m) => [m.pid, m]));
  const assigned = new Set<number>();
  const rows: ResourceUsageProcess[] = [];
  const logicalCpuCount = os.cpus().length;

  const metricsOf = (pid: number): { cpuPercent: number; memoryBytes: number } => {
    const metric = metricsByPid.get(pid);
    return {
      cpuPercent: normalizeElectronCpuToMachinePercent(metric?.cpu.percentCPUUsage, {
        logicalCpuCount,
      }),
      // The workingSetSize unit of getAppMetrics is KB
      memoryBytes: (metric?.memory.workingSetSize ?? 0) * 1024,
    };
  };
  const push = (row: ResourceUsageProcess): void => {
    if (assigned.has(row.pid)) return;
    assigned.add(row.pid);
    rows.push(row);
  };

  const mainMetrics = metricsOf(process.pid);
  push(
    baseProcess(
      process.pid,
      formatZCodeMainProcessName(),
      "main",
      mainMetrics.cpuPercent,
      mainMetrics.memoryBytes,
    ),
  );

  for (const m of metrics) {
    if (m.type === "GPU") {
      const { cpuPercent, memoryBytes } = metricsOf(m.pid);
      push(baseProcess(m.pid, formatZCodeGpuProcessName(), "gpu", cpuPercent, memoryBytes));
    }
  }

  // The same OS process may host multiple BrowserWindow, and deduplication is performed by PID.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const rendererPid = win.webContents.getOSProcessId();
    if (rendererPid <= 0) continue;
    const { cpuPercent, memoryBytes } = metricsOf(rendererPid);
    push(
      baseProcess(
        rendererPid,
        formatZCodeRendererProcessName(win.getTitle() || `Window ${win.id}`),
        "renderer",
        cpuPercent,
        memoryBytes,
      ),
    );
  }

  // The browser guest:renderer process of browser-use is a built-in plug-in.
  const browserUseGuestIds = new Set(browserUseGuestWebContentsIdsProvider());
  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const rendererPid = contents.getOSProcessId();
    if (rendererPid <= 0 || assigned.has(rendererPid)) continue;
    const { cpuPercent, memoryBytes } = metricsOf(rendererPid);
    const name = buildAuxiliaryRendererName(contents);
    if (browserUseGuestIds.has(contents.id)) {
      push({
        pid: rendererPid,
        name,
        category: "builtin-plugin",
        groupKey: `builtin:${BROWSER_USE_PLUGIN_NAME}`,
        groupLabel: BROWSER_USE_PLUGIN_NAME,
        cpuPercent,
        memoryBytes,
        sampled: true,
      });
      continue;
    }
    push(baseProcess(rendererPid, name, "renderer", cpuPercent, memoryBytes));
  }

  // host is a direct child process of main created via utilityProcess.fork().
  for (const [label, child] of hostProcesses) {
    if (child.pid == null) continue;
    const { cpuPercent, memoryBytes } = metricsOf(child.pid);
    push(
      baseProcess(child.pid, formatZCodeHostProcessName(label), "host", cpuPercent, memoryBytes),
    );
  }

  for (const m of metrics) {
    if (assigned.has(m.pid)) continue;
    const { cpuPercent, memoryBytes } = metricsOf(m.pid);
    push(
      baseProcess(
        m.pid,
        m.type === "Utility"
          ? formatZCodeUtilityProcessName(m.name || String(m.pid))
          : formatZCodeUtilityProcessName(m.type, "process"),
        "utility",
        cpuPercent,
        memoryBytes,
      ),
    );
  }

  return rows;
}

async function collectHostProcesses(signal?: AbortSignal): Promise<HostResourceUsageProcess[]> {
  const results = await Promise.all(
    [...hostProcesses].map(([label, child]) =>
      child.pid != null ? requestHostResourceUsage(label, child, undefined, signal) : [],
    ),
  );
  return results.flat();
}

/** Agent registry cover: Agents that have not been reported by the Host must also appear in the list (indicators are not collected) */
function collectUnsampledAgentProcesses(sampledPids: Set<number>): ResourceUsageProcess[] {
  const rows: ResourceUsageProcess[] = [];
  for (const processes of hostAgentProcesses.values()) {
    for (const agent of [...processes.values()].sort(
      (left, right) => left.startedAt - right.startedAt,
    )) {
      if (sampledPids.has(agent.pid)) continue;
      rows.push({
        pid: agent.pid,
        name: formatZCodeAgentProcessName(agent.provider, agent.workspacePath),
        category: "base",
        groupKey: "cli",
        groupLabel: "cli",
        cpuPercent: 0,
        memoryBytes: 0,
        sampled: false,
      });
    }
  }
  return rows;
}

const systemCpuMeter = createSystemCpuMeter();

/** A complete snapshot: Electron process + Host sampled external process + total system volume */
async function buildResourceUsageSnapshot(
  options: { includeHosts?: boolean; signal?: AbortSignal } = {},
): Promise<ResourceUsageSnapshot> {
  const electronProcesses = collectElectronProcesses();
  const hostRows = options.includeHosts === false ? [] : await collectHostProcesses(options.signal);

  const electronPids = new Set(electronProcesses.map((row) => row.pid));
  const processes: ResourceUsageProcess[] = [...electronProcesses];
  for (const row of hostRows) {
    // Will Electron processes other than Host itself be seen in the Host subtree again? No (they are all subprocesses of main),
    // However, in extreme cases such as pid reuse, the Electron indicator still takes precedence.
    if (electronPids.has(row.pid)) continue;
    processes.push({ ...row, sampled: true });
  }
  processes.push(...collectUnsampledAgentProcesses(new Set(processes.map((row) => row.pid))));

  const appTotals = processes.reduce(
    (total, row) => ({
      cpuPercent: total.cpuPercent + row.cpuPercent,
      memoryBytes: total.memoryBytes + row.memoryBytes,
    }),
    { cpuPercent: 0, memoryBytes: 0 },
  );
  const memoryTotalBytes = os.totalmem();

  return {
    sampledAt: Date.now(),
    logicalCpuCount: os.cpus().length,
    system: {
      cpuPercent: systemCpuMeter.read(),
      memoryTotalBytes,
      memoryUsedBytes: Math.max(0, memoryTotalBytes - os.freemem()),
    },
    app: {
      cpuPercent: Math.round(appTotals.cpuPercent * 10) / 10,
      memoryBytes: appTotals.memoryBytes,
    },
    processes,
  };
}
