// Projection scaling probe: does `ProductProjection.applyEvent` degrade super-linearly with event
// count?
//
// The repo has real sessions, but the largest ones locally are ~26 events, which is far too small to
// show a curve. Scaling is driven by event count, not by where the events come from, so this builds
// synthetic streams with the same event *mix* a real turn produces and measures wall-clock per
// event.
//
// If the per-event cost grows with N, the `[...snapshot.rows.window]` copies in
// `applyConversationDelta` are O(N) each and the total is O(N^2).
import { createRequire } from "node:module";

const CLI = "/media/hdd1/ZCode/apps/zcode-cli/packages";
const { ProductProjection } = await import(
  `${CLI}/bootstrap/src/zcode-protocol-v4/product-projection.js`
);
const { SessionEventType } = await import(`${CLI}/contracts/src/index.js`);

const CLOCK = new Date("2024-01-01T00:00:00.000Z");
let sequenceNumber = 0;
let turnIndex = 0;

/** Build one well-formed event. `ProductProjection` reads `event.timestamp.getTime()`, so a real Date is required. */
function event(type: string, payload: Record<string, unknown>) {
  const current = sequenceNumber;
  sequenceNumber += 1;
  return {
    type,
    sessionId: "bench",
    turnId: `turn-${turnIndex}`,
    sequenceNumber: current,
    timestamp: new Date(CLOCK.getTime() + current),
    payload,
  };
}

/** Long assistant replies dominate a real turn's event volume. */
const PER_TURN = 40;

function buildStream(eventCount: number) {
  sequenceNumber = 0;
  turnIndex = 0;
  const events = [event(SessionEventType.SessionCreated, { title: "bench" })];
  while (events.length < eventCount) {
    events.push(event(SessionEventType.TurnStarted, {}));
    events.push(event(SessionEventType.UserMessage, { content: "hello" }));
    for (let index = 0; index < PER_TURN && events.length < eventCount; index += 1) {
      events.push(
        event(SessionEventType.ModelStreaming, { kind: "text_delta", delta: "chunk of output " }),
      );
    }
    events.push(event(SessionEventType.TurnComplete, {}));
    turnIndex += 1;
  }
  return events.slice(0, eventCount);
}

const sizes = [250, 500, 1000, 2000, 4000];
console.log("| events | ms | us/event | rows |");
console.log("| ---: | ---: | ---: | ---: |");
const measurements: Array<{ n: number; ms: number }> = [];
for (const n of sizes) {
  const stream = buildStream(n);
  const projection = new ProductProjection("bench", "scaling");
  const started = performance.now();
  for (const synthetic of stream) {
    projection.applyEvent(synthetic as never);
  }
  const elapsed = performance.now() - started;
  const rows = (projection.getSnapshot() as { rows: { window: unknown[] } }).rows.window.length;
  measurements.push({ n, ms: elapsed });
  console.log(`| ${n} | ${elapsed.toFixed(1)} | ${((elapsed * 1000) / n).toFixed(0)} | ${rows} |`);
}

const first = measurements[0]!;
const last = measurements[measurements.length - 1]!;
const ratio = last.n / first.n;
const exponent = Math.log(last.ms / first.ms) / Math.log(ratio);
console.log(
  `\nN grew ${ratio.toFixed(0)}x, time grew ${(last.ms / first.ms).toFixed(1)}x -> exponent ${exponent.toFixed(2)} ` +
    `${exponent < 1.3 ? "(LINEAR — no quadratic blowup)" : exponent < 1.7 ? "(SUPER-LINEAR)" : "(QUADRATIC)"}`,
);
