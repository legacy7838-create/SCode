import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
const readyMarkerNames = {
  main: ".main-build-ready",
  host: ".host-build-ready",
  preload: ".preload-build-ready",
  // The scheduler has become an independent tsup target, and onSuccess will call the same marker script.
  // The target is missing from the old whitelist, causing the production build to fail with unknown target even after the bundle succeeds.
  scheduler: ".scheduler-build-ready",
};

if (!Object.hasOwn(readyMarkerNames, target)) {
  throw new Error(`unknown ready marker target: ${target ?? "<empty>"}`);
}

const readyMarkerPath = resolve(root, "out", readyMarkerNames[target]);

mkdirSync(dirname(readyMarkerPath), { recursive: true });

// The CLI-level onSuccess of tsup will be triggered individually by each sub-build and cannot represent the completion of the overall desktop build.
// Here it is changed to main/host/preload to write independent markers for each. dev.mjs will start Electron only after all three are ready.
writeFileSync(readyMarkerPath, `${new Date().toISOString()}\n`, "utf8");
