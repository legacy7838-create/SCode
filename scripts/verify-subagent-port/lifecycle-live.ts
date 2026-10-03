/** Verification section: lifecycle-live. See docs/specs/subagent-rust-port.md. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveLifecyclePaths } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
// Phase 2 live proof: subagent lifecycle paths come from the RUST binary.
const agentId = "agent_12345678-1234-1234-1234-123456789012";
const sessionId = "sess_74e7efda-a2a5-4c47-93b1-d864671e05cc";
const root = "/home/legacy/.zcode/cli/agents";
// 1. new run under a configured root: every path equals Node's own join
const p = deriveLifecyclePaths({ outputRootDir: root, sessionId, agentId });
const expectedDir = join(root, sessionId, agentId);
check("keys are camelCase", typeof p.agentOutputDir === "string" && typeof p.metadataFile === "string");
check("dir matches Node", p.agentOutputDir === expectedDir);
check("metadataFile matches Node", p.metadataFile === join(expectedDir, "metadata.json"));
check("outputFile matches Node", p.outputFile === join(expectedDir, "output.txt"));
check("taskOutputFile matches Node", p.taskOutputFile === join(expectedDir, "task.output"));
// 2. no configured root -> the tmpdir default
const d = deriveLifecyclePaths({ sessionId, agentId });
check("default root is tmpdir/zcode-agents", d.agentOutputDir === join(join(tmpdir(), "zcode-agents"), sessionId, agentId));
// 3. resume: the recorded output file wins over the configured root
const recorded = "/data/agents/sess_1/agent_x/output.txt";
const r = deriveLifecyclePaths({ outputRootDir: "/ignored", sessionId, agentId, recordedOutputFile: recorded });
check("resume keeps recorded dir", r.agentOutputDir === "/data/agents/sess_1/agent_x");
check("resume metadataFile", r.metadataFile === "/data/agents/sess_1/agent_x/metadata.json");
// 4. a `..` in an id is resolved, never left literal (this is why joining is Node-compatible)
const tricky = deriveLifecyclePaths({ outputRootDir: root, sessionId: "../escape", agentId });
check("no literal '..' segment survives", !tricky.agentOutputDir.split("/").includes(".."));
check("normalised result equals Node", tricky.agentOutputDir === join(root, "../escape", agentId));
// 5. empty recorded output file falls back to the derived root
const empty = deriveLifecyclePaths({ outputRootDir: root, sessionId, agentId, recordedOutputFile: "" });
check("empty recorded file falls back", empty.agentOutputDir === expectedDir);
}
}
