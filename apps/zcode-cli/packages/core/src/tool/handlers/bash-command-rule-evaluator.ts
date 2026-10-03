// The bash permission rule matcher: the rule has one owner, Rust.
//
// Spec: docs/specs/subagent-rust-port.md (Phase 3). This file is only a re-export so the
// permission flow's callers stay where they are. `bash-rules-golden.json` pins the 18 rule
// cases plus the wildcard grammar; `matchesInvocationRule`'s three shapes — `:*` prefix,
// `*` wildcard, exact string — live in `zcode-subagent-profile`.
export { evaluateBashRules } from "@zcode/rust/subagent-profile";
