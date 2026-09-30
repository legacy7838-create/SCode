import { execFile } from "node:child_process";
import type { WindowsTaskkillRunner } from "#src/process/processTreeTypes.js";

export const defaultWindowsTaskkillRunner: WindowsTaskkillRunner = ({ force, pid, timeoutMs }) =>
  new Promise((resolve) => {
    // When multiple workspaces exit, synchronous taskkill will serially block the Host according to the number of Agents.
    // The asynchronous runner allows the process tree to be closed concurrently and passes the command completion results to the waiting state machine for observation.
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        resolve({ ...(error ? { error } : {}), ...(stderr ? { stderr } : {}) });
      },
    );
  });
