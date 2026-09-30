import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { takeCoverage } from "node:v8";

const COVERAGE_ENABLED_VALUE = "1";

export function buildHostE2ECoverageEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const artifactDir = env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ZCODE_E2E_COVERAGE !== COVERAGE_ENABLED_VALUE || !artifactDir) {
    return {};
  }
  const directory = resolve(artifactDir, "coverage", "raw", "host");
  mkdirSync(directory, { recursive: true });
  return { NODE_V8_COVERAGE: directory };
}

export function flushMainE2ECoverage(onError?: (error: unknown) => void): boolean {
  if (
    process.env.ZCODE_E2E_COVERAGE !== COVERAGE_ENABLED_VALUE ||
    !process.env.NODE_V8_COVERAGE?.trim()
  ) {
    return false;
  }
  try {
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });
    // The main of Desktop E2E is finally closed by external SIGKILL, and Electron will not trigger it.
    // Node's normal exit coverage writes to disk; it must be actively flushed before killing.
    takeCoverage();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
