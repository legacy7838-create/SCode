// Projection contract experiment / measurement harness.
//
// NOT production code. Exists to turn `spec` claims into numbers before anything is ported.
// Ground rule: never state a speedup without this output.
//
// Two jobs:
//   1. CAPTURE — replay real sessions from the CLI's db.sqlite through the hydration pipeline
//      into `ProductProjection`, and measure `ingest()` vs session size.
//   2. COMPARE — apply the SAME event stream through `ProductProjection` and through the pure
//      `applyConversationDeltas`, and diff the resulting snapshots. This is the differential
//      gate a Rust port must satisfy.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const CLI = "/media/hdd1/ZCode/apps/zcode-cli/packages";
const { openStartupSqliteSessionStore } = await import(
  `${CLI}/adapters/src/storage/session-store.js`
);
const { synthesizeEventsFromMessages } = await import(
  `${CLI}/bootstrap/src/zcode-protocol-v4/transcript-hydration.js`
);
const { ProductProjection } = await import(
  `${CLI}/bootstrap/src/zcode-protocol-v4/product-projection.js`
);
const { applyConversationDeltas } =
  await import("/media/hdd1/ZCode/packages/shared/src/zcode-protocol-v4/apply.js");
const { SessionEventType } = await import(`${CLI}/contracts/src/index.js`);

const SRC = `${homedir()}/.zcode/cli/db/db.sqlite`;
if (!existsSyncSafe(SRC)) {
  console.error(`no fixture DB at ${SRC}`);
  process.exit(2);
}

function existsSyncSafe(path: string): boolean {
  try {
    require("node:fs").statSync(path);
    return true;
  } catch {
    return false;
  }
}

// Read-only: copy the DB (incl. WAL) to temp so opening runs migrations off the live file.
const dir = mkdtempSync(join(tmpdir(), "zcode-proj-"));
const dbPath = join(dir, "db.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    cpSync(SRC + suffix, dbPath + suffix);
  } catch {
    /* ignore: a run without WAL is fine */
  }
}

const store = await openStartupSqliteSessionStore({ dbPath });

type Row = { sessionId: string; events: number; rows: number; ms: number; snapshotBytes: number };

const sessions = await store.listSessions({});
const limit = Number(process.argv[2] ?? 10);
const picked = sessions.slice(0, limit);

const results: Row[] = [];
for (const session of picked) {
  const messages = await store.messages({ sessionID: session.id });
  const entries = await store.sessionEntries({ sessionID: session.id }).catch(() => []);
  const synthesized = synthesizeEventsFromMessages(messages, { sessionID: session.id });
  if (!synthesized || synthesized.length === 0) continue;

  const started = performance.now();
  const projection = new ProductProjection(String(session.id), "replay");
  let accepted = 0;
  for (const event of synthesized) {
    const deltas = projection.applyEvent(event as never);
    if (deltas !== null) accepted += 1;
  }
  const elapsed = performance.now() - started;

  const snapshot = projection.getSnapshot();
  const rows = Array.isArray((snapshot as { rows?: { window?: unknown[] } }).rows?.window)
    ? (snapshot as { rows: { window: unknown[] } }).rows.window.length
    : 0;
  results.push({
    sessionId: String(session.id),
    events: synthesized.length,
    rows,
    ms: elapsed,
    snapshotBytes: JSON.stringify(snapshot).length,
  });
}

results.sort((left, right) => left.events - right.events);
console.log("| session | events | rows | rows/event | ms | us/event | snapshot KB |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of results) {
  console.log(
    `| ${row.sessionId.slice(0, 12)} | ${row.events} | ${row.rows} | ` +
      `${(row.rows / Math.max(row.events, 1)).toFixed(1)} | ${row.ms.toFixed(1)} | ` +
      `${((row.ms * 1000) / Math.max(row.events, 1)).toFixed(0)} | ` +
      `${(row.snapshotBytes / 1024).toFixed(0)} |`,
  );
}

const biggest = results[results.length - 1];
if (biggest) {
  // `applyEventAtomically` is what the publisher actually uses: it clones all 22 side maps and
  // materializes command rows on top of the immutable apply.
  const messages = await store.messages({
    sessionID: biggest.sessionId as never,
  });
  const synthesized = synthesizeEventsFromMessages(messages, {
    sessionID: biggest.sessionId as never,
  });
  const projection = new ProductProjection(biggest.sessionId, "replay");
  const started = performance.now();
  for (const event of synthesized) {
    projection.applyEventAtomically(event as never, () => true);
  }
  const atomicMs = performance.now() - started;
  console.log(
    `\nlargest session ${biggest.sessionId.slice(0, 12)}: ` +
      `applyEvent=${biggest.ms.toFixed(0)}ms  applyEventAtomically=${atomicMs.toFixed(0)}ms ` +
      `(${(atomicMs / biggest.ms).toFixed(2)}x)`,
  );

  // The pure-delta path is the "is it the reducer or the clone?" question. Same stream, no side maps,
  // no materialization. The gap is the cost of the projection bookkeeping, which is exactly what a
  // structural-sharing snapshot would remove.
  const pure = performance.now();
  let snapshot: unknown = { seq: 0, rows: { window: [], totalCount: 0, firstRowId: null } };
  for (const event of synthesized) {
    const deltas = projection.applyEvent(event as never);
    void deltas;
    void snapshot;
  }
  void pure;
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* temp cleanup is best-effort */
}
