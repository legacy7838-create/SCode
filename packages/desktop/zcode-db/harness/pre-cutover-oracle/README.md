# Pre-cutover parity harnesses (archived)

These `*.mts` harnesses proved each Rust DB op matched the old TypeScript
(node:sqlite) repository implementation byte-for-byte, by driving BOTH sides and
diffing `/tmp` DB dumps. They passed at commit `fe03ee7` (slice 81), before the
session-store facade was cut over onto the Rust addon (`2c094df`, which removed
`node:sqlite` from `apps/zcode-cli/packages/adapters/src`).

They are archived here — excluded from the active `harness/*.mts` run and CI —
because their TypeScript oracle modules were deliberately deleted as part of
removing `node:sqlite`; they can no longer run against a removed oracle. They are
kept as the migration's verification record (see `git log`/`git show fe03ee7` for
the runs where they were green).

The post-cutover regression net is:
- `cargo test --lib` / `cargo clippy --all-targets -- -D warnings` in the crate.
- The still-active `harness/*.mts` (task-index `*.mts`, which compare against the
  tasks-index repositories that remain).
- A `grep` gate asserting `apps/zcode-cli/packages/adapters/src` contains no
  `node:sqlite`, plus a facade-level end-to-end smoke driving the rewired
  `SqliteSessionStore` against the built addon.
