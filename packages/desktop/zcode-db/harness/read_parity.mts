// TS-vs-Rust golden read-parity harness (task-index `listTaskMetas`).
// Runs the REAL TypeScript repo and the Rust N-API addon against the SAME copy of a live
// tasks-index.sqlite and deep-diffs the projected metas. This is the differential gate that
// validates the rowToMeta / listTaskMetas port against the authoritative TS implementation, not
// just hand-written unit tests. Read-only on the real file (works on a throwaway copy).
//
// Run from the repo root:  node_modules/.bin/tsx packages/desktop/zcode-db/harness/read_parity.mts
// Optional env: ZCODE_DB_SRC=/abs/path/to/tasks-index.sqlite
import { createRequire } from "node:module";
import { cpSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const addon = require(join(here, "..", "zcode_db.node"));
const { TaskIndexRepo } = await import("../../../services/src/session/taskIndexRepo.js");

const src = process.env.ZCODE_DB_SRC ?? join(process.env.HOME ?? "", ".zcode/v2/tasks-index.sqlite");
const dir = mkdtempSync(join(tmpdir(), "zcode-golden-"));
const copy = join(dir, "tasks-index.sqlite");
cpSync(src, copy);

const short = (v: unknown) => JSON.stringify(v)?.slice(0, 120);

function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (a === b) return;
  if (a === null || b === null || a === undefined || b === undefined) {
    if (a !== b) out.push(`${path}: ts=${short(a)} rust=${short(b)}`);
    return;
  }
  if (typeof a !== typeof b) {
    out.push(`${path}: type ts=${typeof a} rust=${typeof b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ts=${a.length} rust=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!(k in ao)) out.push(`${path}.${k}: MISSING-IN-TS rust=${short(bo[k])}`);
      else if (!(k in bo)) out.push(`${path}.${k}: MISSING-IN-RUST ts=${short(ao[k])}`);
      else diff(ao[k], bo[k], `${path}.${k}`, out);
    }
  }
}

try {
  const repo = new TaskIndexRepo(copy);
  await repo.ensureReady();
  const tsMetas = await repo.listTaskMetas({ includeDeleted: true });
  repo.close();

  const rustMetas = JSON.parse(addon.listTaskMetasFilteredJson(copy, JSON.stringify({ includeDeleted: true })));

  // Round-trip both through JSON so `undefined`-vs-absent matches the wire representation.
  const ts = JSON.parse(JSON.stringify(tsMetas)).sort((x: any, y: any) => String(x.taskId).localeCompare(String(y.taskId)));
  const rust = JSON.parse(JSON.stringify(rustMetas)).sort((x: any, y: any) => String(x.taskId).localeCompare(String(y.taskId)));

  const out: string[] = [];
  diff(ts, rust, "metas", out);

  console.log(`ts metas=${ts.length}  rust metas=${rust.length}`);
  console.log(`modes: ${JSON.stringify([...new Set(ts.map((m: any) => m.mode))])}`);
  if (out.length === 0) {
    console.log("READ PARITY: OK — 0 diffs across all task metas");
    process.exit(0);
  }
  console.log(`READ PARITY: ${out.length} diff(s). First 20:`);
  console.log(out.slice(0, 20).join("\n"));
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
