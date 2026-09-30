import { runServerCore } from "./core.js";

const generation = Number(process.argv[2] ?? 0);
void runServerCore(generation).catch((error: unknown) => {
  // Same as the shutdown path of core.ts - startup failure often occurs when the service has been partially initialized.
  // After that (SQLite, interval, etc. still hold the event loop handle), just setting exitCode will make the process
  // Hanging will not exit; Supervisor will not crash and retreat if it does not receive the exit event, and the status will be permanently stuck at starting.
  // Must exit explicitly after fatal message is sent (or no IPC channel).
  const exit = (): void => process.exit(1);
  if (typeof process.send !== "function" || process.connected === false) {
    exit();
    return;
  }
  try {
    process.send(
      { type: "fatal", message: error instanceof Error ? error.message : String(error) },
      exit,
    );
  } catch {
    // The parent process may disconnect from IPC while failing to start, unable to wait for a fatal callback that never arrives.
    exit();
  }
});
