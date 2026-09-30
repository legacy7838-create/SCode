import { readdir, readFile } from "node:fs/promises";
import { readDarwinProcessGroup, readDarwinProcessTable } from "./process-probe-darwin.js";
import {
  sampleLinuxProcessGroup,
  sampleLinuxProcessTrees,
  type LinuxProcReaders,
} from "./process-probe-linux.js";
import {
  defaultProbeExecFile,
  groupProcessTrees,
  isSamplablePid,
  toSample,
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";
import { readWindowsProcessMemory } from "./process-probe-windows.js";

export {
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
  type ProcessProbeCommandResult,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";

/** What process-tree sampling actually covers: Windows' tasklist has no ppid, so only directly attached processes can be obtained. */
export type ProcessTreeScope = "direct_process" | "process_tree";

/**
 * Generic process probe: given a batch of pids or one process group id, return the RSS and cumulative CPU time of each process.
 * MCP 5-minute sampling and Bash slow-command sampling both share this module.
 *
 * Performance red lines constrain this module:
 * - the external-process allowlist is only macOS's `ps` and Windows's `tasklist`, at most one invocation per sample;
 * - Linux always reads `/proc` and spawns no process at all;
 * - every sample has a 1-second timeout, and a timeout or failure always means "no sample this time" — no retry, no queueing;
 * - after 3 consecutive failures this instance is disabled until the caller explicitly `reset()`s it in the next reporting window.
 *
 * The failure budget belongs to the probe instance: within one CLI process each sampling scenario (MCP, Bash commands) holds its own long-lived instance,
 * scenarios do not affect each other, and the caller `reset()`s them when the window switches.
 */
export interface ProcessProbe {
  /**
   * Samples the whole process tree by root pid (including the root itself) and returns root pid → per-process samples inside the tree.
   * A root that no longer exists at sampling time will not appear in the result; returning `undefined` means no sample this time.
   */
  sampleProcessTrees(
    rootPids: readonly number[],
  ): Promise<ReadonlyMap<number, readonly ProcessProbeSample[]> | undefined>;
  /** Samples by process group id; Windows has no process group semantics, so it is always "no sample" and spawns no process. */
  sampleProcessGroup(processGroupId: number): Promise<readonly ProcessProbeSample[] | undefined>;
  /** Zeroes the consecutive-failure count when the reporting window switches, making a disabled probe usable again in the new window. */
  reset(): void;
  /** The coverage of `sampleProcessTrees` on this platform; callers label the sample scope with it instead of detecting the platform themselves. */
  readonly treeScope: ProcessTreeScope;
}

interface CreateProcessProbeOptions {
  execFile?: ProcessProbeExecFile;
  /** Lists the entries under `/proc`, Linux only */
  listProcDirectory?: () => Promise<readonly string[]>;
  /** The reason for each sampling failure (including a timeout); the caller routes it to its own debug log, the probe itself does no I/O */
  onSampleFailed?: (reason: string) => void;
  platform?: NodeJS.Platform;
  /** Reads `/proc/<pid>/stat` and `/proc/<pid>/status`, Linux only */
  readProcFile?: (path: string) => Promise<string>;
}

const PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES = 3;

const PROBE_TIMED_OUT = Symbol("process-probe-timed-out");

export function createProcessProbe(options: CreateProcessProbeOptions = {}): ProcessProbe {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? defaultProbeExecFile;
  const listProcDirectory = options.listProcDirectory ?? (() => readdir("/proc"));
  const readProcFile = options.readProcFile ?? ((path: string) => readFile(path, "utf8"));
  let consecutiveFailures = 0;

  const reportFailure = (reason: string): undefined => {
    consecutiveFailures += 1;
    try {
      options.onSampleFailed?.(reason);
    } catch {
      // Errors thrown in observation callbacks cannot in turn affect sampling and business.
    }
    return undefined;
  };

  /** The single funnel for one sample: timeouts, exceptions and command failures all surface only as "no sample", and all consume failure budget. */
  const sampleWithinBudget = async <T>(
    collect: (readers: LinuxProcReaders) => Promise<T>,
  ): Promise<T | undefined> => {
    if (consecutiveFailures >= PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES) return undefined;
    const deadline = Date.now() + PROCESS_PROBE_SAMPLE_TIMEOUT_MS;
    let outcome: T | typeof PROBE_TIMED_OUT;
    try {
      outcome = await raceProbeTimeout(
        collect({
          isExpired: () => Date.now() >= deadline,
          listProcDirectory,
          readProcFile,
        }),
      );
    } catch (error) {
      return reportFailure(error instanceof Error ? error.message : String(error));
    }
    if (outcome === PROBE_TIMED_OUT) {
      return reportFailure(`sampling exceeded ${PROCESS_PROBE_SAMPLE_TIMEOUT_MS} ms`);
    }
    consecutiveFailures = 0;
    return outcome;
  };

  return {
    treeScope: platform === "win32" ? "direct_process" : "process_tree",
    async sampleProcessTrees(rootPids) {
      const roots = [...new Set(rootPids.filter(isSamplablePid))];
      if (roots.length === 0) return new Map();
      if (platform === "win32") {
        const samples = await sampleWithinBudget(() => readWindowsProcessMemory(execFile, roots));
        if (!samples) return undefined;
        // Tasklist does not have ppid, and the "process tree" of Windows can only degenerate into the root process itself, see treeScope.
        return new Map(samples.map((sample) => [sample.pid, [sample]]));
      }
      return await sampleWithinBudget(async (readers) =>
        platform === "linux"
          ? await sampleLinuxProcessTrees(readers, roots)
          : groupProcessTrees(await readDarwinProcessTable(execFile), roots),
      );
    },
    async sampleProcessGroup(processGroupId) {
      if (!isSamplablePid(processGroupId)) return undefined;
      // Windows does not have process group semantics, nor does it have a zero-cost process tree data source, so this sampling is simply abandoned.
      if (platform === "win32") return undefined;
      return await sampleWithinBudget(async (readers) =>
        platform === "linux"
          ? await sampleLinuxProcessGroup(readers, processGroupId)
          : (await readDarwinProcessGroup(execFile, processGroupId)).map(toSample),
      );
    },
    reset() {
      consecutiveFailures = 0;
    },
  };
}

/**
 * 1-second hard timeout: `ps` / `tasklist` are really killed by execFile's timeout;
 * `/proc` reads cannot be cancelled and are aborted by readers.isExpired at the batch boundary, so this function only decides the negative return.
 */
async function raceProbeTimeout<T>(work: Promise<T>): Promise<T | typeof PROBE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof PROBE_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(PROBE_TIMED_OUT), PROCESS_PROBE_SAMPLE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
