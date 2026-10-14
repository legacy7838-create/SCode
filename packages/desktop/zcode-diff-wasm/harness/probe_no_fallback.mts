// S4 probe: runs in a child process so a missing kernel artifact is observed from a COLD module
// registry. Prints READY when the Host facade answered, and throws when it refused — which is the
// required behavior for a missing artifact (spec/native-boundary-line-diff.md §4, scenario S4).
//
// A cold process is essential: `diffNative.ts` caches the loaded glue module, so a warm process
// would keep answering after the artifact is parked and hide the regression.
//
// The probe imports the SAME Host facade the shipped process uses, by relative path (tsx does not
// resolve the `@zcode/*` aliases without the repo's bundler), so it proves the real boundary throws
// rather than a harness-local copy of it.
//
//   node_modules/.bin/tsx packages/desktop/zcode-diff-wasm/harness/probe_no_fallback.mts
//
// Driven by `parity.mts`; run directly it is a one-line smoke check of the staged artifact.
import { computeLineChangeStatNative } from "../../../services/src/session/diffNative.js";

const stat = computeLineChangeStatNative("a\nb", "a\nc");
if (stat.added !== 1 || stat.removed !== 1) {
  throw new Error(`probe got an unexpected answer: ${JSON.stringify(stat)}`);
}
console.log("READY");
