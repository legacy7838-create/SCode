// S5 probe: runs in a child process so a missing/bogus kernel artifact is observed from a COLD
// module registry. Prints READY when the facade answered, and throws when it refused — which is the
// required behavior for a missing artifact (spec/native-boundary-fuzzy-score.md §1.5, scenario S5).
//
//   node_modules/.bin/tsx packages/desktop/zcode-score-wasm/harness/probe_no_fallback.mts
//
// Driven by `parity.mts`; run directly it is a one-line smoke check of the staged artifact.

import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { searchWorkspaceFilesByScore } from "../../../services/src/file/workspaceScoreNative.js";

const entries: WorkspaceFileEntry[] = [
  { name: "lib.rs", path: "/w/src/lib.rs", relativePath: "src/lib.rs", type: "file" },
  { name: "main.rs", path: "/w/src/main.rs", relativePath: "src/main.rs", type: "file" },
];

const result = searchWorkspaceFilesByScore({
  packed: packWorkspaceFileEntries(entries),
  rootPath: "/w",
  query: "main",
  limit: 10,
});

if (result.length !== 1 || result[0]?.relativePath !== "src/main.rs") {
  throw new Error(`probe got an unexpected answer: ${JSON.stringify(result)}`);
}
console.log("READY");
