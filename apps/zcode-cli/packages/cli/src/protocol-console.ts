import { Console } from "node:console";

/**
 * Installs the console output boundary for a CLI that owns stdout exclusively (stdio protocol / TUI).
 *
 * The stdout of app-server/agent-server may only carry ZCode Protocol NDJSON frames, but third-party
 * SDKs may write plain text through console.*. If the streams are not separated before those dependencies load,
 * any log line will be parsed as JSON by the Host, or will overwrite the TUI's picture right at the cursor.
 */
export function installStderrConsoleBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalConsole = globalThis.console;
  globalThis.console = new Console({ stdout: stderr, stderr });

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    globalThis.console = originalConsole;
  };
}
