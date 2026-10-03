// The read-only policy evaluator: the Rust owner, with a thin adapter.
//
// Spec: docs/specs/subagent-rust-port.md (Phase 3). The whole decision — the gates, the direct
// argv shortcuts, the multiword table, the per-command policies and every danger callback — is
// Rust. `readonly-policy-golden.json` pins all 31 cases with their three-way verdict.
//
// What stays in TypeScript is the GRAMMAR (`analyzeBashCommand`, the `unbash` package): it
// splits a command line into invocations, and this file only receives the result.
export { evaluateBashReadonlyPolicy, hasKnownBashWriteOption } from "@zcode/rust/subagent-profile";
