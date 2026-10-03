/**
 * PHASE 2 oracle: capture the agent-metadata artifact bytes produced by the live
 * TypeScript implementation, so the Rust port can be proven byte-identical.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 2).
 *
 * Run: pnpm exec tsx scripts/capture-agent-metadata-golden.ts
 *
 * Written to `apps/zcode-cli/packages/core/testdata/agent-profiles/metadata-golden.json`,
 * which `zcode-subagent-profile/tests/artifacts_parity.rs` replays. Not auto-regenerated:
 * a diff is a decision about which bytes are correct, not something to paper over.
 */
import { writeFileSync, mkdirSync } from "node:fs";

import { buildAgentMetadataDocument } from "../apps/zcode-cli/packages/core/src/subagent/runner.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

/** The lifecycle/request fields the document reads. Everything else is unused. */
function fixture(overrides: {
  profile?: Record<string, unknown>;
  request?: Record<string, unknown>;
  status?: "running" | "completed" | "failed" | "stopped";
  extra?: Record<string, unknown>;
}) {
  return {
    lifecycle: {
      agentId: "agent_11111111-2222-3333-4444-555555555555",
      childSessionId: "sess_subagent_agent_11111111",
      metadataFile: "/data/agents/sess_1/agent_x/metadata.json",
      outputFile: "/data/agents/sess_1/agent_x/output.txt",
      taskOutputFile: "/data/agents/sess_1/agent_x/task.output",
      profile: overrides.profile ?? { name: "general-purpose", source: "built-in" },
      startedAt: 1_700_000_000_000,
      runTraceContext: {},
      childTraceContext: {},
    },
    request: {
      workingDirectory: "/home/dev/project",
      description: "Review the diff",
      parentSessionId: "sess_parent",
      parentToolCallId: "call_abc123",
      agentType: "general-purpose",
      prompt: "Review the changes and report findings.",
      sessionId: "sess_parent",
      trace: {},
      ...overrides.request,
    },
    status: overrides.status ?? "completed",
    createdAt: "2023-11-14T22:13:20.000Z",
    updatedAt: "2026-10-03T07:15:13.662Z",
    ...(overrides.extra ? { extra: overrides.extra } : {}),
  };
}

const CASES = [
  { name: "completed", input: fixture({}) },
  { name: "running", input: fixture({ status: "running" }) },
  {
    name: "failed_with_error",
    input: fixture({ status: "failed", extra: { error: "boom" } }),
  },
  {
    name: "structured_contract",
    input: fixture({
      extra: {
        completedAt: "2026-10-03T07:15:20.000Z",
        totalDurationMs: 4210,
        totalTokens: 1234,
        totalToolUseCount: 7,
        structured: { ok: true, data: { verdict: "ok" } },
      },
    }),
  },
  {
    name: "unicode_and_quotes",
    input: fixture({
      request: { description: 'Hindi "quoted" — dash', prompt: "line1\nline2\ttab" },
    }),
  },
  {
    name: "control_characters",
    input: fixture({ request: { prompt: "bell:\u0007 null-ish:\\ end" } }),
  },
  {
    name: "extra_overrides_status",
    input: fixture({ extra: { status: "overridden-by-extra" } }),
  },
  {
    name: "profile_snapshot_with_schema",
    input: fixture({
      profile: {
        name: "reviewer",
        source: "user",
        yield: { mode: "structured", schema: { type: "object", required: ["verdict"] } },
        tools: ["Read", "Grep"],
      },
    }),
  },
];

const results: Record<string, string> = {};
for (const testCase of CASES) {
  results[testCase.name] = buildAgentMetadataDocument(
    testCase.input as unknown as Parameters<typeof buildAgentMetadataDocument>[0],
  );
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/metadata-golden.json`, JSON.stringify(results, null, 2) + "\n");
console.log(`captured ${CASES.length} metadata documents`);
for (const [name, doc] of Object.entries(results)) {
  console.log(`  ${name.padEnd(28)} ${doc.length} bytes`);
}
