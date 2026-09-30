import { mkdirSync } from "node:fs";
import { takeCoverage } from "node:v8";

export function flushHostE2ECoverage(onError?: (error: unknown) => void): boolean {
  if (process.env.ZCODE_E2E_COVERAGE !== "1" || !process.env.NODE_V8_COVERAGE?.trim()) {
    return false;
  }
  try {
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });
    // The exit of the host is scheduled by main. Node is not guaranteed to automatically write to the disk in the event of an exception or forced recycling;
    // Actively flush after the resource release is completed to ensure that the V8 counter of the process isolate is placed on the disk.
    takeCoverage();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
