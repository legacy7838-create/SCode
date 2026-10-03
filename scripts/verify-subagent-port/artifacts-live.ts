/** Verification section: artifacts-live. See docs/specs/subagent-rust-port.md. */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentMetadataDocument, writeAgentArtifacts } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
// Phase 2 live proof: metadata documents now come from the RUST binary.
const golden = JSON.parse(readFileSync("apps/zcode-cli/packages/core/testdata/agent-profiles/metadata-golden.json", "utf8")) as Record<string,string>;
// 1. every golden document, byte for byte, through the live Rust binary
for (const [name, expected] of Object.entries(golden)) {
  let actual = "";
  if (name === "running") actual = buildAgentMetadataDocument(base("running"));
  else if (name === "failed_with_error") actual = buildAgentMetadataDocument({ ...base("failed"), extra: { error: "boom" } });
  else if (name === "structured_contract") actual = buildAgentMetadataDocument({ ...base("completed"), extra: { completedAt: "2026-10-03T07:15:20.000Z", totalDurationMs: 4210, totalTokens: 1234, totalToolUseCount: 7, structured: { ok: true, data: { verdict: "ok" } } } });
  else if (name === "unicode_and_quotes") actual = buildAgentMetadataDocument({ ...base("completed"), description: 'Hindi "quoted" — dash', prompt: "line1\nline2\ttab" });
  else if (name === "control_characters") actual = buildAgentMetadataDocument({ ...base("completed"), prompt: "bell:\u0007 null-ish:\\ end" });
  else if (name === "extra_overrides_status") actual = buildAgentMetadataDocument({ ...base("completed"), extra: { status: "overridden-by-extra" } });
  else if (name === "profile_snapshot_with_schema") actual = buildAgentMetadataDocument({ ...base("completed"), profileSnapshot: { name: "reviewer", source: "user", yield: { mode: "structured", schema: { type: "object", required: ["verdict"] } }, tools: ["Read", "Grep"] } });
  else actual = buildAgentMetadataDocument(base("completed"));
  check(`golden bytes match: ${name}`, actual === expected);
}
function base(status: string) {
  const dir = "/data/agents/sess_1/agent_x";
  return {
    agentId: "agent_11111111-2222-3333-4444-555555555555",
    childSessionId: "sess_subagent_agent_11111111",
    createdAt: "2023-11-14T22:13:20.000Z",
    cwd: "/home/dev/project",
    description: "Review the diff",
    metadataFile: `${dir}/metadata.json`,
    outputFile: `${dir}/output.txt`,
    parentSessionId: "sess_parent",
    parentToolUseId: "call_abc123",
    profileId: "general-purpose",
    profileSnapshot: { name: "general-purpose", source: "built-in" },
    prompt: "Review the changes and report findings.",
    status,
    taskOutputFile: `${dir}/task.output`,
    updatedAt: "2026-10-03T07:15:13.662Z",
  };
}
// 2. real file writes through Rust, into a temp dir
const dir = mkdtempSync(join(tmpdir(), "zcode-artifacts-"));
const written = writeAgentArtifacts({
  metadataFile: join(dir, "nested", "metadata.json"),
  outputFile: join(dir, "nested", "output.txt"),
  taskOutputFile: join(dir, "nested", "task.output"),
  outputText: "the report",
  metadata: base("completed"),
  structured: { ok: true, data: { verdict: "approve", files: ["a.ts"] } },
});
check("wrote 4 artifacts", written.length === 4);
check("nested dir created", readFileSync(join(dir, "nested", "output.txt"), "utf8") === "the report");
check("task.output written", readFileSync(join(dir, "nested", "task.output"), "utf8") === "the report");
const meta = JSON.parse(readFileSync(join(dir, "nested", "metadata.json"), "utf8"));
check("metadata readable + status", meta.status === "completed");
const sidecar = JSON.parse(readFileSync(join(dir, "nested", "output.txt.structured.json"), "utf8"));
check("structured sidecar written", sidecar.data.verdict === "approve");
}
}
