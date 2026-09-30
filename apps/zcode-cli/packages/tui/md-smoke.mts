/**
 * THROWAWAY smoke for wave-B markdown wiring — deleted after the run.
 * Renders the real MarkdownText component headlessly via @mbears/opentui
 * test renderer over a scripted stream; counts native parses by
 * instrumenting the napi class (with injected latency to make in-flight
 * windows deterministic).
 */
import { createTestRenderer } from "@mbears/opentui-core/testing";
import type { TestRendererSetup } from "@mbears/opentui-core/testing";
import { createRoot, flushSync } from "@mbears/opentui-react";
import React from "react";
import { MarkdownText } from "./src/app-markdown.js";
import { loadMarkdown } from "@zcode/rust/markdown";
import { createMarkdownSyntaxStyle } from "./src/app-markdown-theme.js";
import { activeTuiTheme } from "./src/theme/index.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const LATENCY = Number(process.env.MD_SMOKE_LATENCY ?? 120);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// --- instrumentation: count + slow down native parses -------------------
const api = loadMarkdown();
const OrigParser = api.MarkdownParser;
let parseCalls = 0;
let instrumented = false;
try {
  class InstrumentedParser extends OrigParser {
    parse(content: string, trailingUnstable: 0 | 2): Promise<unknown> {
      parseCalls += 1;
      return (
        super.parse(content, trailingUnstable) as Promise<unknown>
      ).then(
        (delta) =>
          new Promise((resolve) => setTimeout(() => resolve(delta), LATENCY)),
      );
    }
  }
  api.MarkdownParser = InstrumentedParser;
  instrumented = api.MarkdownParser === InstrumentedParser;
} catch (cause) {
  console.log(`note: subclass instrumentation failed: ${String(cause)}`);
}
if (!instrumented) {
  try {
    const proto = OrigParser.prototype as Record<string, unknown>;
    const original = proto.parse as (
      c: string,
      t: 0 | 2,
    ) => Promise<unknown>;
    proto.parse = function (c: string, t: 0 | 2): Promise<unknown> {
      parseCalls += 1;
      return original.call(this, c, t).then(
        (delta) =>
          new Promise((resolve) => setTimeout(() => resolve(delta), LATENCY)),
      );
    };
    instrumented = true;
  } catch (cause) {
    console.log(`note: prototype instrumentation failed: ${String(cause)}`);
  }
}
console.log(
  `instrumentation=${instrumented ? `yes (latency ${LATENCY}ms)` : "NO (counts unavailable)"}`,
);

// --- capability guard: the markdown element branch must be taken ---------
const syntaxStyle = createMarkdownSyntaxStyle(activeTuiTheme());
check("syntaxStyle available (markdown branch, not text fallback)", !!syntaxStyle);

async function waitForText(
  setup: TestRendererSetup,
  text: string,
  timeoutMs = 8000,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await setup.flush();
    if (setup.captureCharFrame().includes(text)) return true;
    await sleep(25);
  }
  return false;
}

function makeEl(content: string, streaming: boolean): React.ReactElement {
  return React.createElement(MarkdownText, {
    content,
    streaming,
    key: "md",
  });
}

async function main(): Promise<void> {
  const setup = await createTestRenderer({ width: 100, height: 40 });
  const root = createRoot(setup.renderer);

  const render = (content: string, streaming: boolean): void => {
    flushSync(() => root.render(makeEl(content, streaming)));
  };

  const steps: [string, string][] = [
    ["# Streaming Title\n\nHello ", "Streaming Title"],
    ["with **bold** and `inline` words.\n", "inline words"],
    ["\n- item one\n- item two\n", "item two"],
    ["\n> quoted line for blockquote\n", "quoted line"],
    ["\n| col A | col B |\n| --- | --- |\n| 1 | 2 |\n", "col A"],
    [
      "\n```ts\nconst x: number = 42;\nconsole.log(x);\n```\n",
      "const x: number = 42;",
    ],
  ];

  // P1: mount rule — markdown element mounts content-empty.
  render("", true);
  await sleep(50);
  await setup.flush();
  const frame0 = setup.captureCharFrame();
  check(
    "mount rule: initial frame empty (no constructor parse of content)",
    !frame0.includes("Streaming Title"),
  );

  // P2: progressive streaming — each step paints while streaming=true.
  let content = "";
  for (let i = 0; i < steps.length; i += 1) {
    content += steps[i][0];
    const n0 = parseCalls;
    render(content, true);
    const painted = await waitForText(setup, steps[i][1]);
    check(
      `progressive step ${i + 1} paints ("${steps[i][1]}") while streaming`,
      painted,
    );
    const delta = parseCalls - n0;
    check(
      `step ${i + 1} made at least one native parse`,
      !instrumented || delta >= 1,
      `parseCalls Δ=${delta}`,
    );
  }

  // P3: fenced code visible during streaming (top risk).
  await setup.flush();
  const frameStreaming = setup.captureCharFrame();
  check(
    "fenced code visible DURING streaming",
    frameStreaming.includes("console.log(x);"),
  );
  const concealOk = !frameStreaming.includes("**bold**");
  console.log(
    `note: conceal behavior during stream: markers ${concealOk ? "hidden" : "visible (raw ** present)"}`,
  );

  // P4: in-flight finalize race + cheap finalize.
  content += "\nFinal tail line.\n";
  const nBeforeTail = parseCalls;
  render(content, true);
  await sleep(15); // effects fire; 105ms of injected latency still in flight
  render(content, false); // finalize flip while the tail parse is in flight
  const tailPainted = await waitForText(setup, "Final tail line.");
  check(
    "in-flight result survives finalize flip (drop-guard race fix)",
    tailPainted,
  );
  const tailDelta = parseCalls - nBeforeTail;
  check(
    "finalize flip caused no extra native parse (cheap finalize)",
    !instrumented || tailDelta === 1,
    `parseCalls Δ=${tailDelta} (expected 1: tail growth only)`,
  );
  await sleep(LATENCY + 100);
  await setup.flush();
  const frameSettled = setup.captureCharFrame();
  check(
    "settled frame still contains tail after latency window",
    frameSettled.includes("Final tail line."),
  );
  const callsSettled = parseCalls;

  // P5: input coalescing — rapid deltas during in-flight parses.
  root.unmount();
  const root2 = createRoot(setup.renderer);
  const rapid = [
    "# Coalesce head\n",
    "alpha beta gamma delta\n",
    "- one\n- two\n",
    "tail of coalesce stream\n",
    "FINAL coalesce marker\n",
  ];
  let rapidContent = "";
  const nRapid0 = parseCalls;
  for (const chunk of rapid) {
    rapidContent += chunk;
    flushSync(() => root2.render(makeEl(rapidContent, true)));
    await sleep(5);
  }
  const rapidPainted = await waitForText(setup, "FINAL coalesce marker");
  check("rapid coalesced stream paints final content", rapidPainted);
  const rapidDelta = parseCalls - nRapid0;
  check(
    "rapid deltas coalesced at input (fewer parses than deltas)",
    !instrumented || (rapidDelta < rapid.length && rapidDelta >= 1),
    `parseCalls Δ=${rapidDelta} for ${rapid.length} deltas`,
  );

  // P6: scrollback/mount path — fresh instance over finished content.
  root2.unmount();
  const root3 = createRoot(setup.renderer);
  flushSync(() => root3.render(makeEl(content, false)));
  const remountPainted = await waitForText(setup, "Final tail line.");
  check("fresh mount of finished content paints (scrollback path)", remountPainted);
  await setup.flush();
  const frameRemount = setup.captureCharFrame();
  check(
    "scrollback frame matches settled stream frame (text)",
    frameRemount === frameSettled,
    frameRemount === frameSettled
      ? `${frameSettled.length} chars equal`
      : `settled=${frameSettled.length} chars, remount=${frameRemount.length} chars`,
  );
  check(
    "finished message caused zero re-parse on remount settle",
    !instrumented || parseCalls === callsSettled + 1,
    `parseCalls after remount Δ=${parseCalls - callsSettled} (expected 1: the fresh mount parse)`,
  );

  console.log("--- frames (first 12 non-empty lines) ---");
  console.log(
    frameSettled
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, 12)
      .join("\n"),
  );
  console.log(`parseCalls total=${parseCalls}`);
  console.log(failures === 0 ? "SMOKE_RESULT=PASS" : `SMOKE_RESULT=FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((cause) => {
  console.error("SMOKE_CRASH", cause);
  process.exit(2);
});
