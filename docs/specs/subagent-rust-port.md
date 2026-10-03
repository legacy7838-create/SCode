# Spec: Subagent runtime — TypeScript → Rust port

Status: **plan only, no code written.** Written before implementation per `AGENTS.md`.
Decision owner: user (asked for the port explicitly after the trade-offs were presented).

## 0. Goal in one line

Move the subagent (child agent) execution path out of the Node/TypeScript process and into the
Rust host, without changing observable agent behaviour.

## 1. The scope trap, stated first

The subagent *module* is small. The thing that actually runs it is not.

| Unit | Files | Lines | Measured |
|---|---|---|---|
| `core/src/subagent/` (the module you would name) | 24 | 4,212 | ✅ small |
| `core/src/runtime/` (child runtime, turn loop) | 161 | 36,662 | 🔴 |
| `core/src/tool/` (executor, permissions, hooks) | 176 | 32,500 | 🔴 |
| `adapters/src/model/` (providers, SSE streaming) | 53 | 12,752 | 🔴 |
| **Total blast radius** | **~414** | **~86,000** | |

**"Port the subagent" is therefore really "port the agent loop."** A plan that quotes 4,212 lines
is wrong. Every phase below is sized against the ~86k figure.

## 2. What is IN and OUT

**IN**

- Child runtime lifecycle: spawn, session bookkeeping, artifact/metadata writing, cancellation.
- The child turn loop: provider request → stream → tool dispatch → repeat.
- Tool execution for the child, including permission flow.
- The yield contract's collection/finalization (added in `subagent-result-contract.md`).

**OUT (stays in TypeScript, deliberately)**

- `packages/web`, `packages/ui` — renderer.
- MCP server implementations (child *consumes* them over the existing port).
- Workflow/DWF actor runtime — a different task type, not `subagent_child`.
- Prompt text itself (see §5 — the strings move only when their owner moves).

## 3. Design decisions

| Question | Decision | Why |
|---|---|---|
| Cutover strategy | **Strangler fig.** Rust takes over one seam at a time; the TS path stays as a live, selectable fallback until Phase 5. | A big-bang rewrite of an agent loop cannot be bisected when it breaks. |
| Who stays the reference? | TypeScript, for the whole port. Rust must match it, never lead it. | Makes parity a testable property instead of an opinion. |
| Drift detection | **Golden byte-parity fixtures captured from the TS path in Phase 0**, replayed against Rust in every later phase. | Prompt drift is the dominant risk and is *invisible* to functional tests — one changed word changes model behaviour. |
| Phase order | Lifecycle → artifacts → tools → **LLM loop last**. | The LLM loop is where drift is both most likely and hardest to detect; do it when the parity harness is already trusted. |
| Rollback | Per-phase flag (`subagent_host = ts \| rust`), default `ts` until Phase 5. | Any phase can be reverted without a release. |
| Streaming | Reuse the existing SSE handling contract; do **not** re-derive provider quirks in Rust. | `adapters/src/model/` encodes provider-specific workarounds (`anthropic-stream-compat`, `failure-classifier`, `empty-completion-retry`) that are battle-tested and undocumented. Re-implementing them is the single largest source of silent behaviour change. |

## 4. Owners, interfaces, event ordering

State owners (each fact has exactly one owner; no duplicates):

| Fact | Owner (today) | Owner (after port) |
|---|---|---|
| Child session identity / lifecycle | `core/src/subagent/runner.ts` | Rust `subagent` service |
| Agent profile (authoring) | `core/src/subagent/profile.ts` | Rust `profile` module (read-only projection from TS in Phase 1) |
| Tool registry for the child | `AgentRuntime.registry` (TS) | Rust tool registry |
| Yield collection + finalization | `core/src/tool/handlers/yield.ts` + `subagent/finalize-yield.ts` | Rust `subagent::yield_contract` |
| Artifacts on disk | `runner.ts:writeCompletedAgentArtifacts` | Rust `subagent::artifacts` |

Event ordering for one child turn (must not change):

```
parent Agent tool
  └─ spawn ──────────────► child session created
       └─ persist-before-spawn gate      (existing: ensureSessionPersistedForExternalActivity)
       └─ turn loop:
            provider.stream ──► tokens ──► tool_call?
                                            ├─ yes: permission gate ──► execute ──► append ──┐
                                            └─ no : append assistant turn ◄────────────────────┘
       └─ finalize yield (once, after the last turn)
       └─ write artifacts (output.txt, metadata.json, output.txt.structured.json)
       └─ mirror summary event to parent
```

## 5. Phases

Each phase ends with: parity tests green, `pnpm typecheck`/`lint`/`architecture:check` clean,
`cargo test --no-fail-fast` at baseline, and the TS fallback still selectable.

### Phase 0 — Golden parity harness *(do this first, or do not start)*

- Capture, from the **live TS path**, golden fixtures for: the assembled child system prompt,
  the tool list sent to the provider, a recorded provider request/response pair, a tool-call
  round trip, and the final artifact bytes.
- Store them as fixtures with a runner that can replay them against either implementation.
- Exit criterion: replaying a fixture through the TS path is byte-identical to itself (this is
  non-trivial: locale collation is byte-comparison by repo precedent, not `localeCompare`).

Why first: without it, every later phase is unverifiable, and drift is invisible.

### Phase 1 — Rust data model + profile projection (read-only)

**Status: complete (1a + 1b).**

- **1a (done, verified):** `packages/rust/crates/zcode-subagent-profile` implements the
  frontmatter reader and profile assembly. `scripts/capture-agent-profile-golden.ts` captures 17
  parse outcomes from the **live TypeScript parser** into
  `apps/zcode-cli/packages/core/testdata/agent-profiles/golden.json`, and
  `tests/parity.rs` replays them against Rust. `cargo test -p zcode-subagent-profile` = 4/4.
  Two real parity bugs were found and fixed this way (diagnostic ordering, and the fatal
  diagnostic losing the primary slot), plus one design change on the TS side so both sides
  share one ordering rule (`diagnostics[0]` **is** the primary `diagnostic` slot).
- **1b (done, verified):** the consumer switch.
  - `packages/rust/src/subagentProfile.ts` — wrapper over `loadNative`, exported at
    `@zcode/rust/subagent-profile`. No JS fallback: a missing binary throws.
  - `zcode-subagent-profile` registered in the payload automatically (`build-native.mjs` builds
    every cdylib crate; the packaging tool stages a crate once it has an importer).
  - `core/src/subagent/profile.ts` — `parseAgentProfileFromMarkdown` now delegates to the Rust
    reader. The eight helpers only the parser used are gone; `normalizeAgentProfiles` keeps the
    ones it still calls.
  - **`core/src/subagent/profile-frontmatter.ts` deleted.** No second reader exists.

  Two things the port had to get right, both found by tests rather than by reading:
  - **Model pinning.** `AgentProfile.modelSelection` is *derived* from the raw frontmatter
    (`model` / `thoughtLevel`) by `parseSubagentMarkdownSelection`. Deleting the reader without
    carrying the raw map forward would have silently unpinned the model of every agent that
    names one — invisible to every other assertion. Rust therefore returns `frontmatter`
    verbatim, a golden case pins it, and `modelSelection` stays derived in TypeScript.
  - **Diagnostic order.** `diagnostics[0]` is the primary slot on both sides; the TypeScript
    collection order was adjusted to match, so the two implementations cannot disagree on which
    problem is reported first.

  **1b must land as one atomic step.** `packages/rust/src/loader.ts` fails loudly when a
  native binary is missing (no JS fallback, by design), so flipping the consumer before the
  `.node` is staged turns a working CLI into a hard startup failure. The parity proof from
  1a is what makes the flip safe; the staging is what makes it not break.

- Rust structs for profile, tool policy, and the yield contract, deserialized from the same
  frontmatter TS parses (single-line JSON `outputSchema` included).
- Rust asserts it agrees with TS on a corpus of profiles. **No behaviour change.**
- Exit: Rust↔TS profile parity corpus passes; zero change to TS output.

### Phase 2 — Lifecycle + artifacts

**Status: COMPLETE.**

- **Artifacts (done, verified):** `artifacts.rs` owns the metadata document and the writes.
  `scripts/capture-agent-metadata-golden.ts` captures 8 documents from the live TypeScript
  implementation into `metadata-golden.json`; `tests/artifacts_parity.rs` compares **exact
  strings**, because these are bytes on disk. `writeAgentMetadataFile` in `runner.ts` now calls
  the Rust builder, and the TypeScript document builder is deleted.
- **Spawn bookkeeping, part 1 (done):** `nodepath.rs` implements Node-compatible
  `path.join` / `path.dirname`, and `derive_lifecycle_paths*` owns the three artifact paths
  for both a new run and a resume. `nodepath-golden.json` is captured from **Node itself**
  (`join`/`dirname` called in `node`), 29 + 10 cases. Both `createSubagentLifecycle` and
  `createSubagentLifecycleFromTask` now take their paths from Rust.
  - Why a Node-compatible join rather than `std::path`: `Path::join("/a/b", "../c")` yields
    `/a/b/../c`, so the recorded `metadataFile` would name a different path than the file
    actually written.
  - The resume path keeps the **recorded** `outputFile` as the source of truth: a resumed run
    must keep writing into the directory its first run used.
- **Summary mirror (done):** `mirror.rs` owns `mirrorSubagentToolEvent` and
  `buildSubagentInteractionOrigin`. `subagent-mirror-golden.json` captures 13 cases from
  the live implementation, including the three that must be *dropped* (an unmirrored type, a
  missing tool call id, a non-string one). `subagent/tool-event-mirror.ts` and
  `subagent/interaction-origin.ts` are deleted.
  - The comparison covers the routing fields and the whole payload. `id`, `timestamp` and
    `sequenceNumber` are assigned by `createSessionEvent` when the event is constructed —
    a fresh UUID, the wall clock and a sequence counter — so they are not mirror-owned and
    cannot be reproduced.
  - **The tool-name cache is owned by the caller.** TypeScript threaded a mutable `Map`
    through the context; the Rust wrapper holds it in a `createSubagentEventMirror` object,
    one per child run, and passes it in and out with each call. Two runs therefore cannot
    share a cache, which is asserted.
  - The interaction origin had **two** implementations (the mirror and the interaction
    broker). Both now read from `build_interaction_origin`; the broker keeps its branded
    `SessionId`/`TurnId` types and converts at the boundary.
- **Cancellation (done):** `cancellation.rs` owns the **policy** — which registry
  snapshots a subagent teardown must stop (`type === "local_bash" && isBackgrounded === true
  && status === "running"`) and whether a runtime seals its background-task notifications.
  `subagent-cancel-golden.json` captures 10 policy cases. **Stopping** the task stays in
  TypeScript because it goes through the scheduler and the task index; only the decision
  moved.
  - The predicate is strict on all three fields on purpose. A task whose `isBackgrounded` is
    the *string* `"true"` was never backgrounded by this runtime, and a loose comparison
    would kill the user's own work — there is a golden case for exactly that.
- **Exit criterion met:** artifacts byte-identical, plus live checks that write all four files
  into a temp directory, that every derived path equals Node's own `join`, that the mirror
  routes, drops and caches exactly as before, and that teardown selects only the strays.

### Phase 2 summary — what is now Rust

| Was TypeScript | Now |
|---|---|
| `subagent/profile-frontmatter.ts` (frontmatter reader) | deleted, Rust owns it |
| `profile.ts` parser body + 8 helpers | deleted, Rust owns it |
| `buildAgentMetadataDocument` + artifact writes | deleted, Rust owns them |
| `join`/`dirname` for lifecycle paths | Rust, Node-compatible |
| `subagent/tool-event-mirror.ts` | deleted, Rust owns it |
| `subagent/interaction-origin.ts` | deleted, one Rust owner for both call sites |
| cancellation policy + seal gate | Rust; the `stopBackgroundTask` side effect stays |
| The turn loop, tool executor, provider streaming | **still TypeScript — Phase 3/4** |

### How to verify this yourself

```
pnpm exec tsx scripts/verify-subagent-rust-port.mts
```

**113 assertions across the napi boundary.** The Rust unit tests replay the golden corpora
against the crate; this script exercises the path the product actually calls, because a napi
signature typo type-checks and still fails at runtime. It exits non-zero on any failure — a
missing binary or a drifted rule stops the pipeline rather than degrading.

Golden corpora and their capture scripts live in-repo too:
`apps/zcode-cli/packages/core/testdata/agent-profiles/` and `scripts/capture-*.ts`.

Three format details the port had to reproduce, each covered by a golden case:

1. **Key order** is the document's fixed sequence — a reader that sorts keys writes a different
   file than the one written before the port.
2. **`...extra` spread semantics**: an `extra` key that already exists keeps its **original
   position** and takes the new value. `serde_json::Map` is an `IndexMap` here (`preserve_order`),
   whose `insert` has exactly that behaviour.
3. **Absent is absent**: an unsupplied field is *omitted*, not written as `null`, which is what
   `JSON.stringify` does with `undefined`.

`createdAt`/`updatedAt` are passed in as ISO strings rather than formatted from a clock in Rust.
That keeps the output deterministic and avoids a `chrono` dependency for two calls.

**Process notes — two mistakes worth recording, because tests caught them and reading would not:**

1. The first attempt at this switch trimmed the file with a script and deleted a live function
   (`aggregateModelUsage`). `runner.ts` was restored from git and both this phase and the
   Phase 1 `structured` wiring re-applied in one scripted pass, then re-verified. The failure
   mode was "surgical edit quietly ate real code".
2. `LifecyclePaths` serialized as **snake_case** while the TypeScript side reads camelCase, so
   every derived path was `undefined` in the consumer. Caught by the live check. The
   accompanying test was also wrong (a nonsense assertion), and the shell pipeline truncated
   its output so the earlier failures were not visible — three small mistakes that a real
   assertion plus full output would have made one.

### Phase 3 — Child tool executor

**Status: slices 1–12 done. The bash permission path AND the tool-result byte budget are Rust.**

- Rust owns tool dispatch, the permission flow, and hooks for `taskType == "subagent_child"`.
- Exit: tool-call round-trip fixtures replay identically; permission decisions match, including
  the plan-mode deny path and the yield tool's `allowedInPlanMode`.

#### 3.1 Done: the git global-option safety gate (`gitflags.rs`)

`hasDangerousGitGlobalOption` is the first line of defence in the read-only git classifier and
it is a **security boundary**, not a lint: `git -c core.pager=<command>` or
`git --exec-path=...` runs an arbitrary command while every later policy check still sees only
`git <subcommand>`. If the predicate drifts, a destructive command is classified read-only and
runs **without asking**.

`git-global-flag-golden.json` captures 26 argv cases from the live implementation (13 dangerous,
13 clean). The `-c` / `-C` asymmetry is preserved deliberately and asserted separately: `-C` does
not inspect the character after the flag (`-C--x` is rejected) while `-c` requires it not to be
another `-` (`-c--x` is not). "Simplifying" that would either admit a redirect or reject a
legitimate flag.

`normalizeGitArgv` needs the **single-word** form, so both are exported from Rust rather than
reimplemented — a second copy of a security rule is how the two drift.

#### 3.2 Deliberately NOT first: the bash grammar parser

`bash-command-parser.ts` wraps the `unbash` npm package, so porting it means porting a **bash
grammar**. Two reasons it is not the first slice: it is weeks of work, and a *silent*
misclassification (a destructive command parsed as safe) is the exact failure this whole policy
exists to prevent. The grammar moves last in Phase 3, after the flag policies it feeds.

#### 3.2b Done: the read-only argv flag policy (`argvpolicy.rs`)

The second half of the safety story: after the global-option gate, this decides whether the flags
on an otherwise-known command are all safe. Wrong in the permissive direction and a write flag
rides through on a read-only command — `git log --output=/etc/x`, `sed -i`, `curl -o`.

`argv-flag-policy-golden.json` captures **42 cases** (23 allowed, 19 rejected) covering every
branch: `--`, compact counts for `head`/`tail`, attached short values, short clusters, inline `=`
values, each `SafeFlagValue` kind, and the `xargs` target check. The TS walker is deleted; the file
is now a one-line re-export, so there is no second copy of a security rule.

**The bug the golden caught.** `safeFlags: {}` (present but empty) and `safeFlags` absent are
**different states**: `if (policy.safeFlags)` is truthy for `{}`, so an empty table still goes to
the walker, and `head -20` is allowed. Collapsing the two into "empty" rejected it. `CommandPolicy`
therefore stores `Option<Vec<…>>`, and the distinction is documented at the field.

#### 3.2c Done: the danger callbacks (`callbacks.rs`)

`callbacks.ts` decides whether a known "read-only" command actually writes. Each closes a real
vector: `sed -i` rewrites the file, `sed 'w out'` writes it, `date FILE` writes it, `jq --rawfile`
reads an arbitrary path, `lsof -i @host` reaches a remote host, `ps e` executes, a numeric
`test` operand runs a command substitution.

`readonly-callbacks-golden.json` captures **53 cases** (27 dangerous, 26 clean). The Rust side
writes every matcher by hand — the workspace has no `regex` dependency and takes a deliberate
minimal-dependency position, and these patterns are anchored literal sets rather than general
regexes.

`callbacks.ts` is now a **thin adapter**: it keeps the policy tables' function references
working, so no table had to be edited, and the rule itself has one owner. **316 lines became
78**, all of it delegation.

A second corpus (`readonly-callbacks2-golden.json`, 27 cases) covers `man`, `tput`, `ss` and
`xargs`, completing eleven callbacks. A live check then cross-checks **all eleven against the
TypeScript adapter across 363 probe argument lists**, which is what makes the adapter trustworthy
rather than merely type-correct.

`ss -t tcp` is rejected by the original — `c` is in `[a-f]` and there is no colon, so the blunt
mask rule fires. That false positive is reproduced and asserted; "improving" it would be a
decision this port does not own.

`isSedInPlaceOption` moved too, so the `sed` callback and `hasKnownBashWriteOption` cannot
disagree about what counts as in-place.

**Not ported:** `ghCommandIsDangerous` and the git callbacks in
`bash-readonly-policy-git-callbacks.ts` — they stay in TypeScript and the file says so.

**A mistake worth recording.** The adapter was first built with a regex-based trim that deleted
more than intended and broke four other exports; `git checkout` restored the file and the
adapter was rebuilt from **explicit line ranges** instead of pattern matching. The compiler caught
it immediately, which is the only reason it was cheap.

#### 3.2d Done: the permission rule matcher (`rulematcher.rs`)

`evaluateBashRules` is the permission decision itself: it decides whether a saved rule
(allow / deny / ask) covers the command about to run. Too eager and an `allow` rule covers a
destructive command; too loose and a saved `deny` stops firing.

`bash-rules-golden.json` holds **18 cases, balanced 10 true / 8 false** — an all-false corpus
proved nothing until the fixtures were corrected, because the real subjects are argv-joined
invocations (`git status`), not `bash git status`, and prefix rules end in `:*` not `:`.

Three shapes are asserted directly rather than only through fixtures: `:*` prefix (stopping at a
word boundary, so `git` does not match `gitx`), `*` wildcard, and exact string. Wildcard matching
is written as a **standard greedy glob with backtracking** instead of a `^…$` RegExp — the
workspace has no `regex` dependency, and re-expressing the original's escape step without an
engine is exactly where the two would diverge.

**Four cases were verified against the ORIGINAL TypeScript** (`git show HEAD:…rule-evaluator.ts`,
run as its own module), not inferred from it, because the branches they reach are not in the
corpus: an empty `exactCommands` never short-circuits, a non-intersecting one never does, an
intersecting one always does, and an empty rule is a catch-all.

#### 3.2e Done: the git subcommand callbacks (`gitcallbacks.rs`)

These are the `additionalCommandIsDangerousCallback` values the read-only git policy table points
at, so the table cannot be ported without them. They close the gap between "this subcommand is on
the read-only list" and "these particular arguments still do something":

| Command | What it does that is not read-only |
|---|---|
| `git tag v1.0` (no `--list`) | **moves or deletes a tag** |
| `git branch main` (no `--list`) | moves a branch |
| `git reflog expire` | destroys history |
| `git log --format=%G` | runs a signature verification (executes repo config) |
| `git ls-remote origin` | reaches the network |
| `git remote show origin` (no `-n`) | can shell out through the pager |

`git-callbacks-golden.json` captures **36 cases (17 dangerous, 19 clean)**. The live check
replays the corpus through the napi boundary and then cross-checks all six callbacks against the
TypeScript adapter across **96 probes**.

`bash-readonly-policy-git-callbacks.ts` went from 121 lines to a 40-line adapter. It matched on
the first run — worth noting because the previous five slices each found real bugs, and the reason
this one did not is that the golden corpus was built from **carefully chosen branch-covering
probes** rather than happy paths.

#### 3.2f Done: the policy table itself (`tables.rs`)

The table is **data**, and the data has one owner: `readonly-tables-golden.json` is captured from
the live tables (24 git + 22 multiword + 60 simple policies, 46 allow-any commands) and
**embedded verbatim** with `include_str!`. Nothing is transcribed by hand — 106 policies hand-copied
would be a second source that silently disagrees, which is precisely what the harness exists to
prevent.

`additionalCommandIsDangerousCallback` is a function reference in TypeScript; in the captured data
it is a **name**, dispatched through the same callback module. One entry, `git remote`, is an inline
lambda, so it is keyed by its table entry rather than by `Function.name` — and it got its own Rust
function.

**The one `RegExp`** is `hostname` (`^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$`). The
workspace has no `regex` dependency, so it is written out directly; its behaviour is pinned by its
own test rather than assumed.

**Two bugs the tests caught:**
1. `CommandPolicy::from_json` required `safeFlags` to be present, so a `commandOnly` policy like
   `alias` — which legitimately has none — was invisible to the lookup. Absence means "no flag
   branch", not "not a policy".
2. The hand-written `hostname` matcher trimmed leading whitespace *before* checking for the space
   that separates a flag group, so `hostname -d` never matched.

#### 3.2h Done: the evaluator itself (`readonlypolicy.rs`)

`evaluateBashReadonlyPolicy` and `hasKnownBashWriteOption` — the functions that decide "does
this one command count as read-only" — are Rust. That moves the whole decision above the
grammar; the only TypeScript left in this path is `analyzeBashCommand` (the `unbash` parse).

**The verdict is three-way**, and the golden corpus asserts all three outcomes are present:
`Some(true)` read-only, `Some(false)` definitely not, `None` no opinion. Collapsing `None` into
either side is a real behavioural change — `None` is how a command says "I have no opinion" while
the caller keeps evaluating the rest of the line.

`readonly-policy-golden.json` holds 31 cases (16 / 10 / 5 across the three outcomes). It also
caught **two data bugs** an eye would miss:

1. `SAFE_ENV_ASSIGNMENTS` was first written from a guess with prefix rules (`ZCODE_*`, `PATH`,
   …). The original is a **fixed 39-entry set with no prefix logic** — and `PATH`, which my guess
   accepted, is *not* in it. Assignment safety now comes from the original's exact set.
2. `env` was treated as a safe command wrapper. It is not: the wrappers are `command`, `builtin`
   and `noglob`, so `env ls` has no opinion rather than being read-only.

Consolidating the two `CommandPolicy` structs into `tables::CommandPolicy` also surfaced a third:
`respectsDoubleDash` must distinguish **absent** from `false` (absent stops the scan, `false`
skips a word), so it is an `Option<bool>` for the same reason `safe_flags` is.

#### 3.2i Done: git runtime-context safety (`gitruntimesafety.rs`)

The last part of the permission path that touches the filesystem. `isGitRuntimeContextUnsafe`
answers "is this directory safe to run a read-only git in?" by inspecting `.git`: a symlinked one, a
`gitdir:` file pointing outside the workspace, a bare layout, or a path that cannot be resolved.
Git loads hooks and config from the directory it runs in, so a wrong answer here means git
executes somewhere the policy did not expect — and that is exactly the class of bug that does not
show up in a unit test.

This is the first slice with real filesystem I/O, so the golden is built from **nine real fixture
trees** rather than mocks: normal work tree, nested directory, no repository, escaping `gitdir:`,
symlinked `.git`, bare layout, incomplete tree, no context, and a missing path — plus the eight
pure predicates. The checks are `lstat` (not `stat`, so a symlink is seen *as* a symlink), a
bounded read of `HEAD`, and an executability probe on `objects/`/`refs/`; a mock would not have
exercised any of those.

**Platform rule: the executability probe on Windows.** `is_searchable` is cfg-split. An
unguarded `use std::os::unix::fs::PermissionsExt` does not compile on Windows (`E0433`), and a
single uncompilable crate fails the whole workspace `cargo build --release` — which fails
`build:native`, and with zero JS fallback (umbrella invariant 1) that is a total outage, not a
degradation: no `.node`, no `@zcode/server`. The split mirrors exactly what the legacy did: the
TS original called `accessSync(childPath, X_OK)` **without** a `platform !== "win32"` guard
(unlike `apps/zcode-cli/packages/adapters/src/browser/executable.ts`, which has one), and Node on
Windows accepts `X_OK` for any existing directory (verified empirically: `accessSync(dir, X_OK)`
→ PASS on win32). So the rule is: on unix, *some* execute bit must be set
(`Permissions::mode() & 0o111`); on Windows, a readable `metadata` is the same verdict the
legacy produced. The shape is the one `zcode-git::is_executable_file` already uses
(`#[cfg(unix)]` / `#[cfg(not(unix))]`), and the golden fixtures are plain `create_dir_all` trees
with default modes, so the pinned verdict is identical on both platforms.

**Fixture rule: the symlinked `.git` case on Windows.** The nine-fixture golden includes a
directory symlink (`symlinked_git_dir`). Creating one on Windows requires Administrator or
Developer Mode (`symlink_dir` → `EPERM` otherwise), so the test fixture creates it with the
platform's native API and, when the host refuses, **skips exactly that one golden case** with an
explicit message instead of failing the suite or silently dropping the fixture. This is a
capability of the test environment, not a product code path: `classify_dot_git_directory` still
takes the symlink branch unconditionally at runtime, and privileged Windows / unix hosts run all
nine cases.

The two predicates take each command's **argv**, not the name the grammar reported, because the
grammar reports `command`/`builtin`/`noglob` as the name — the unwrapping has to happen exactly
once, and it happens in Rust.

#### 3.3b Done: the post-parse bash policy (Phase 4, first slice)

`isBashCommandPermissionSafe`, `isRuntimeReadOnlyBashCommand`, `isSilentBashCommand` — everything
the bash permission flow decides AFTER the grammar has split a command line — is Rust. The seam is
explicit: TypeScript parses, Rust decides.

`bash-semantics-golden.json` holds **30 command lines parsed by the real grammar**, so the corpus
includes shapes a hand-written fixture would miss: `&&` and `||` chains, pipelines, output and
input redirects, subshells, command substitution, unbalanced quotes, `LANG=C` prefixes, and
`command env` wrapper nesting. The live check then replays those same lines **end to end** — real
string → real grammar → Rust — because that is the only check that exercises the seam between the
two halves.

One data bug the corpus caught: `BASH_SILENT_COMMANDS` was first written from a guess
(`true`/`sleep`/`wait`), which is wrong in both directions — it is `cd`, `chmod`, `cp`, `rm`, `rmdir`,
`touch`, `wait`, … . A silent-command list guessed from memory is a list that classifies
destructively-invisible commands as noisy and vice versa.

`packages/rust/src/subagentProfile.ts` reached the repository's maximum file length during this
work, so the bash-semantics surface moved to `subagentBashSemantics.ts` behind
`@zcode/rust/subagent-bash-semantics` rather than being allowed to grow past the rule.

#### 3.3c Done: the tool-result byte budget (`resultbudget.rs`)

`fitStringToBytes` and `fitContentWithSuffix` decide how much of a tool result reaches the model.
They are the context-budget primitive, and they had a trap that a reading would not catch: the
JavaScript original clips at **code-point** boundaries (`Array.from`, while a JS string is UTF-16),
so the natural Rust translation — `&value[..n]` — either panics on a boundary or silently splits
a code point. A split code point is invalid UTF-8 that reaches the model.

`result-budget-golden.json` pins **307 cases, most of them Unicode**: emoji (surrogate pairs in
JS), CJK (3 bytes per code point), combining marks, ZWJ sequences, and byte budgets chosen to land
mid-sequence. 208 of the cases actually truncate, so the corpus is not a corpus of no-ops.

Two properties are asserted directly so a regression names itself: the budget is never exceeded,
and a budget landing mid-sequence keeps the whole leading code points or none of them.

`packages/rust/src/subagentProfile.ts` hit the repository's maximum file length a second time
while adding this, so the budget surface moved to `subagentResultBudget.ts` behind
`@zcode/rust/subagent-result-budget`. Both times the rule caught it rather than a reviewer.

#### Known duplication, deliberately left

`permission/service.ts:309` (`matchesRuleContent`) implements the **same three shapes** with
`wildcardToRegExp`, for the non-Bash tools. That duplication existed before this port — two
TypeScript copies — and it now spans one TS copy and one Rust copy. It is flagged here rather
than cleaned up: folding it in means porting `PermissionService`, which is a much larger change
than this phase. See §8.

**Three real bugs, all caught by the golden corpus:**
1. **An infinite loop.** The `--expression=` branch did `continue` without advancing the index,
   so `sed --expression=…` hung. It read as a slow test rather than a hang, which is the worst
   way for a bug to present.
2. **`\S*@` misread.** `lsof -i@host` was the *whole* point of that check, and requiring the `@`
   immediately after the flag let it through. `\S*` is greedy and backtracks, so the `@` may sit
   anywhere after the `i` in the same word.
3. **The spaced form of a jq option.** `--rawfile=/path` was rejected but plain `--rawfile` was
   allowed — i.e. the flag a person actually types.

#### 3.3 Still open in Phase 3

- `man`, `tput`, `ss` and the `xargs` target check (still TypeScript)
- The policy tables (`git` subcommands, simple commands, `gh`, multiword) and the callbacks.
- `hasKnownBashWriteOption`'s `sed`/`find`/`tree` write detection.
- The tool-call round trip itself (dispatch, permission flow, hooks) and the bash grammar.

### Phase 4 — Turn loop + streaming *(largest)*

- Rust owns provider request assembly, SSE consumption, tool-call parsing, and retry/failure
  classification, porting `adapters/src/model/` behaviour with its golden fixtures.
- Exit: recorded provider streams replay identically, including `anthropic-stream-compat` and
  `empty-completion-retry` cases.

### Phase 5 — Cutover

- Default `subagent_host = rust`; keep `ts` selectable for one release.
- Remove the TS child path only after a release with no rollbacks.

## 6. Risks, with the mitigation that is actually in the plan

| Risk | Mitigation in this plan |
|---|---|
| Prompt/stream drift silently degrades quality | Phase 0 golden fixtures gate every phase |
| Provider quirk regressions | Phase 4 ports fixtures, not guesses; `anthropic-stream-compat` and friends have recorded cases |
| No measurable speedup (agent loop is LLM-wait-bound) | §7 stop criteria — kill the port on evidence, not on opinion |
| Rollback impossible mid-way | Per-phase flag, TS retained through Phase 5 |
| Rust suite already has failures | Baseline recorded (263/12 in `--lib`, all integration binaries green) and must not regress |

## 7. Stop criteria (decide with evidence, before Phase 4)

The port is justified by a benefit. Measure it at the end of Phase 2 on a real workload:

- If child wall-clock improves **< 10%** and RSS improves **< 25%**, stop after Phase 2 and keep
  TS for the turn loop. Phases 3–4 are the expensive ones and buy the least.
- Report the numbers either way in `docs/specs/rust-native-server.md`.

## 8. Honest effort estimate

Wide ranges, because Phase 4's size depends on provider-fixture coverage that is not yet
measured: Phase 0 **3–5 d**, Phase 1 **1–2 wk**, Phase 2 **2–3 wk**, Phase 3 **4–8 wk**,
Phase 4 **6–12 wk**, Phase 5 **2–3 wk** → **roughly 4–7 months** of focused work, with Phase 0
being the cheapest and highest-leverage part of the whole plan.

## 9. Not decided here

- Whether Phase 4 should reuse an existing Rust SSE crate or hand-roll; decide when the fixture
  corpus size is known.
- Whether the TS fallback is deleted at Phase 5 or one release later.
