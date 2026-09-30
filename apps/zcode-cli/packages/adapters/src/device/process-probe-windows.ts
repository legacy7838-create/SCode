import {
  runProbeCommand,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";

/**
 * On Windows: the only permitted external process is `tasklist`, which returns all process memory in a single call.
 * Never switch to a Windows management-interface script host style of implementation (see the forbidden-keyword list in the spec's
 * performance red lines): a past incident was exactly that — a heavyweight process spawned every few seconds, measurably slowing down
 * the user's machine. `tasklist` reports neither ppid nor cumulative CPU time, so this only returns the RSS of directly connected processes.
 */
export async function readWindowsProcessMemory(
  execFile: ProcessProbeExecFile,
  pids: readonly number[],
): Promise<readonly ProcessProbeSample[]> {
  const stdout = await runProbeCommand(execFile, "tasklist", ["/FO", "CSV", "/NH"], {
    windowsHide: true,
  });
  const wanted = new Set(pids);
  const samples: ProcessProbeSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = parseCsvFields(line);
    const pid = Number(fields[1]);
    if (!wanted.has(pid)) continue;
    const memoryDigits = (fields[4] ?? "").replace(/\D/g, "");
    if (!memoryDigits) continue;
    const rssKb = Number(memoryDigits);
    if (!Number.isFinite(rssKb) || rssKb < 0) continue;
    samples.push({ pid, rssKb });
  }
  return samples;
}

function parseCsvFields(line: string): string[] {
  const fields: string[] = [];
  for (const match of line.matchAll(/"((?:[^"]|"")*)"/g)) {
    fields.push((match[1] ?? "").replace(/""/g, '"'));
  }
  return fields;
}
