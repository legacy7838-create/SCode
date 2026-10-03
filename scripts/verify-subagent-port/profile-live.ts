/** Verification section: live-proof. See docs/specs/subagent-rust-port.md. */
import { parseAgentProfileFromMarkdown } from "../../apps/zcode-cli/packages/core/src/subagent/profile.ts";
import { check } from "./harness.js";

export function run(): void {
  // The TypeScript profile parser is gone; this entry now reaches the Rust binary. The
  // profile parser is the first thing every child run does, so its wiring is checked here
  // as well as in the crate's golden tests.
  let r = parseAgentProfileFromMarkdown({ content: "---\nname: a\ndescription: d\n---\nbody", source: "user" });
  check("legacy profile loads", r.profile?.name === "a");
  check("legacy profile has no contract", r.profile?.yield === undefined);

  r = parseAgentProfileFromMarkdown({
    content: '---\nname: rev\ndescription: d\nyield: true\noutputSchema: {"type":"object","required":["verdict"]}\n---\nb',
    source: "user",
  });
  check("yield contract carried by Rust", r.profile?.yield?.mode === "structured");
  check("schema intact through the boundary", JSON.stringify(r.profile?.yield?.schema) === '{"type":"object","required":["verdict"]}');

  r = parseAgentProfileFromMarkdown({ content: "---\nname: a\ndescription: d\nyield: true\n---\nb", source: "user" });
  check("yield without a schema rejects the profile", r.profile === undefined && r.diagnostic?.code === "agent_invalid_yield_schema");

  r = parseAgentProfileFromMarkdown({
    content: "---\nname: a\ndescription: d\nmodel: anthropic/claude-opus-5\nthoughtLevel: high\n---\nb",
    source: "user",
  });
  check("model pinning survives the port", r.profile?.modelSelection?.providerId === "anthropic");
  check("reasoning level survives", r.profile?.modelSelection?.options?.reasoningLevel === "high");

  r = parseAgentProfileFromMarkdown({ content: "---\nname: a\ndescription: d\npermissionMode: bypassPermissions\n---\nb", source: "project" });
  check("project scope strips permissionMode", r.profile?.permissionMode === undefined);

  r = parseAgentProfileFromMarkdown({ content: "---\nname: a\ndescription: d\nmcpServers:\n  - one\n  - two\n---\nb", source: "user" });
  check("mcpServers parsed", JSON.stringify(r.profile?.mcpServers) === '["one","two"]');
}
