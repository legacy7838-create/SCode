/**
 * PHASE 0 oracle: capture golden agent-profile parse results from the LIVE
 * TypeScript parser, so the Rust port can be proven byte-identical.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 0/1).
 *
 * Run: pnpm exec tsx scripts/capture-agent-profile-golden.ts
 *
 * This writes `apps/zcode-cli/packages/core/testdata/agent-profiles/golden.json`,
 * which `zcode-subagent-profile/tests/parity.rs` replays. It is deliberately NOT
 * regenerated automatically: if a parity test fails, the fix is a human decision
 * about which behaviour is correct, not a re-capture.
 */
import { parseAgentProfileFromMarkdown } from "../apps/zcode-cli/packages/core/src/subagent/profile.ts";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("../apps/zcode-cli/packages/core/testdata/agent-profiles", import.meta.url).pathname;

// Every frontmatter shape the parser distinguishes. Each case is authored to
// exercise one rule, so a parity failure names the rule that broke.
const CASES = [
  { name: "minimal", content: "---\nname: a\ndescription: d\n---\nbody", source: "user" },
  { name: "yield_structured", content: '---\nname: a\ndescription: d\nyield: true\noutputSchema: {"type":"object","required":["verdict"],"properties":{"verdict":{"type":"string"}}}\n---\nb', source: "user" },
  { name: "yield_no_schema", content: "---\nname: a\ndescription: d\nyield: true\n---\nb", source: "user" },
  { name: "yield_schema_string", content: '---\nname: a\ndescription: d\nyield: true\noutputSchema: "{\\"type\\":\\"object\\"}"\n---\nb', source: "user" },
  { name: "yield_schema_array", content: '---\nname: a\ndescription: d\nyield: true\noutputSchema: [1,2]\n---\nb', source: "user" },
  { name: "memory_scope", content: "---\nname: a\ndescription: d\nmemory: project\n---\nb", source: "user" },
  { name: "memory_bad_scope", content: "---\nname: a\ndescription: d\nmemory: bogus\n---\nb", source: "user" },
  { name: "memory_and_yield", content: '---\nname: a\ndescription: d\nmemory: user\nyield: true\noutputSchema: {"type":"object"}\n---\nb', source: "user" },
  { name: "memory_bad_and_yield_bad", content: "---\nname: a\ndescription: d\nmemory: bogus\nyield: true\n---\nb", source: "user" },
  { name: "no_frontmatter", content: "just body text", source: "user" },
  { name: "mcp_servers_list", content: "---\nname: a\ndescription: d\nmcpServers:\n  - one\n  - two\n---\nb", source: "user" },
  { name: "tools_list", content: "---\nname: a\ndescription: d\ntools:\n  - Read\n  - Grep\n---\nb", source: "user" },
  { name: "booleans", content: "---\nname: a\ndescription: d\nbackground: true\ninjectAgentsMd: false\n---\nb", source: "user" },
  { name: "max_turns", content: "---\nname: a\ndescription: d\nmaxTurns: 7\n---\nb", source: "user" },
  { name: "project_scope_permission_stripped", content: "---\nname: a\ndescription: d\npermissionMode: bypassPermissions\n---\nb", source: "project" },
  { name: "user_scope_permission_kept", content: "---\nname: a\ndescription: d\npermissionMode: plan\n---\nb", source: "user" },
  { name: "model_pinned", content: "---\nname: a\ndescription: d\nmodel: anthropic/claude-opus-5\nthoughtLevel: high\n---\nb", source: "user" },
  { name: "mcp_servers_bare", content: "---\nname: a\ndescription: d\nmcpServers: notalist\n---\nb", source: "user" },
];

const results = {};
for (const c of CASES) {
  const r = parseAgentProfileFromMarkdown({ content: c.content, source: c.source, path: `/golden/${c.name}.md` });
  results[c.name] = {
    source: c.source,
    content: c.content,
    // Normalise the two things that are environment, not behaviour.
    parsed: {
      diagnostic: r.diagnostic ?? null,
      diagnostics: r.diagnostics ?? null,
      profile: r.profile ?? null,
    },
  };
}
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/golden.json`, JSON.stringify(results, null, 2) + "\n");
console.log(`captured ${CASES.length} golden cases -> ${OUT}/golden.json`);
for (const [k, v] of Object.entries(results)) {
  const has = v.parsed.profile ? "profile" : "REJECTED";
  console.log(`  ${k.padEnd(34)} ${has}${v.parsed.diagnostic ? " [" + v.parsed.diagnostic.code + "]" : ""}`);
}
