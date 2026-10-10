// WRITE-parity for the local-settings cluster: the REAL TS `saveProjectPermission` +
// `saveProjectPermissionMode` (from local-settings.ts) run against copy A, the Rust addon run against
// copy B, on TWO independent throwaway session-store DBs with the SAME inputs. Both copies'
// `local_setting` dumps AND each op's returned value are deep-compared. Never touches ~/.zcode.
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/session_write_local_settings_parity.mts
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  saveProjectPermission,
  saveProjectPermissionMode,
} from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/local-settings.ts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const addon = require(join(here, "..", "zcode_db.node"));

const dir = mkdtempSync(join(tmpdir(), "zcode-lswrite-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const short = (v: unknown) => JSON.stringify(v)?.slice(0, 200);
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
    if (a.length !== b.length) out.push(`${path}: len ts=${a.length} rust=${b.length}`);
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

let diffs = 0;
function cmp(name: string, tsRaw: unknown, rustRaw: unknown): void {
  const ts = JSON.parse(JSON.stringify(tsRaw ?? null));
  const rust =
    typeof rustRaw === "string" ? JSON.parse(rustRaw) : JSON.parse(JSON.stringify(rustRaw ?? null));
  const out: string[] = [];
  diff(ts, rust, name, out);
  if (out.length === 0) console.log(`  ${name}: OK`);
  else {
    diffs++;
    console.log(`  ${name}: ${out.length} DIFF(s)`);
    console.log(out.slice(0, 8).join("\n"));
  }
}

// Full-PK ORDER BY keeps the two independently-built DBs' row order deterministic; `key` leads the
// ordering exactly as specified (the extra columns only break ties, never reorder distinct-key rows).
function dump(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db
    .prepare(
      "select scope, scope_id, namespace, key, value, schema_version from local_setting \
       order by key, scope, scope_id, namespace",
    )
    .all();
  db.close();
  return rows;
}

try {
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // A `now` for the addon (TS reads its own Date.now() internally; the time columns are not dumped,
  // so the two clocks do not affect the comparison).
  const now = Date.now();

  // A non-trivial ruleset (nested array + quote + unicode) that must round-trip through
  // getProjectPermission identically on both sides.
  const ruleset1 = {
    rules: [{ tool: "bash", action: "allow" }],
    note: 'quote " and \' chars — unicode ✓',
  };
  // A second ruleset for the SAME (scope,scope_id,namespace,key) → exercises the upsert UPDATE branch.
  const ruleset2 = { rules: [], version: 2 };

  // ---- copy A: real TS ----
  const dbA = new DatabaseSync(A);
  // insert branch (p1), then UPDATE branch (same key p1), plus a round-trip ruleset (p3).
  const tsRet1 = await saveProjectPermission(dbA, { projectID: "p1", permission: ruleset1 } as never);
  const tsRet2 = await saveProjectPermission(dbA, { projectID: "p1", permission: ruleset2 } as never);
  const tsRet3 = await saveProjectPermission(dbA, { projectID: "p3", permission: ruleset1 } as never);
  const tsModeRet = saveProjectPermissionMode(dbA, { mode: "yolo", projectID: "p2" } as never);
  dbA.close();

  // ---- copy B: Rust addon (identical inputs) ----
  const rsRet1 = addon.saveProjectPermissionJson(B, "p1", JSON.stringify(ruleset1), now);
  const rsRet2 = addon.saveProjectPermissionJson(B, "p1", JSON.stringify(ruleset2), now);
  const rsRet3 = addon.saveProjectPermissionJson(B, "p3", JSON.stringify(ruleset1), now);
  const rsModeRet = addon.saveProjectPermissionModeJson(B, "p2", "yolo", now);

  // ---- returned values ----
  cmp("ret.ruleset.insert(p1.first)", tsRet1, rsRet1);
  cmp("ret.ruleset.update(p1.second)", tsRet2, rsRet2);
  cmp("ret.ruleset.roundtrip(p3)", tsRet3, rsRet3);
  cmp("ret.mode(p2)", tsModeRet, rsModeRet);

  // ---- persisted local_setting dump (value + schema_version, no time columns) ----
  cmp("dump.local_setting", dump(A), dump(B));
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (diffs === 0) {
  console.log("LOCAL-SETTINGS WRITE PARITY: OK");
  process.exit(0);
} else {
  console.log(`LOCAL-SETTINGS WRITE PARITY: ${diffs} DIFF(S)`);
  process.exit(1);
}
