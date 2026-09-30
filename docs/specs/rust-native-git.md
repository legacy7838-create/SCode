# Rust native port: git refresh surface (`zcode-git`)

Status: active. Owner: GitSpecAuthor (wave-1 port). Written 2026-09-28 **before**
implementation, per `docs/specs/rust-native-ports.md` and the architecture-governance
rule. The crate `packages/rust/crates/zcode-git` currently exists as a 2-line stub whose
comment references this file.

## Scope (what is ported)

The **git refresh surface**: repository resolution, status snapshot (+ untracked line
stats), identity, and branch comparison — everything `gitService.refresh` executes, plus
the shared snapshot primitives the sibling read methods reuse. Zero child-process spawns
on this path (engine rule 5).

### Legacy flow (measured, file:line)

- Entry: `gitService.refresh` (`packages/services/src/git/gitService.ts:321-336`) runs
  `Promise.all(repo.getStatus, repo.getIdentity?, repo.getBranchComparison?)` and returns
  `{ summary, identity, unstagedChanges, stagedChanges, branchComparison }`
  (`gitService.ts:348-354`) over RPC (`IGitService`, `packages/services/src/git/git.ts:52,55`).
- `resolveRepository` (`packages/services/src/git/repo/gitCliRepo.ts:712-797`): spawns
  `git rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir`
  (`:730-738`), probes `git --version` per candidate through
  `resolveGitBinary` (`packages/services/src/git/providers/gitEnvironmentProvider.ts:12-36`
  — a **spawn**, session-cached at `:41-58`), and downgrades missing-workdir /
  not-a-repository stderr into `isRepository:false` fallbacks (`:744-762`).
- `getStatus` (`gitCliRepo.ts:855-916`) runs three commands in `Promise.all` (`:871-886`):
  1. `git status --porcelain=v2 --branch --untracked-files=all -z`
     (`executeGitStatus`, `:546-553`), with the 512 KiB overflow rerun
     (`runGitStatus`, `:555-571`, per-repoRoot set `collapsedUntrackedRepoRoots` `:544`,
     `:565`; cap `DEFAULT_GIT_OUTPUT_BYTES = 512 * 1024`,
     `packages/services/src/git/config.ts:9`);
  2. `git diff --cached --numstat -z --find-renames --` (`:874-879`);
  3. `git diff --numstat -z --find-renames --` (`:880-885`);
  then parses with `parseStatusPorcelain` (`gitCliHelpers.ts:244-361`) /
  `parseNumstat` (`gitCliHelpers.ts:386-425`) and scans untracked files in TS
  (`buildUntrackedStats`, `gitCliHelpers.ts:455-485`: ≤1 MiB/file, 64 KiB chunks, NUL ⇒ 0,
  4 workers, constants `config.ts:14-16`).
- `getBranchComparison` (`gitCliRepo.ts:1371-1421`) reuses `getStatus`, then spawns
  `git diff --numstat -z --find-renames <tracking>...HEAD --` (`:1388-1400`) and maps with
  `inferKindFromNumstat` (`gitCliHelpers.ts:370-383`, used at `gitCliRepo.ts:1406`).
- `getIdentity` (`gitCliRepo.ts:1675-1728`) runs 2× `git config --show-scope
  --show-origin --get user.{name,email}` (`:1692-1704`) and parses
  `parseGitConfigValue` (`gitCliHelpers.ts:660-679`, callers `gitCliRepo.ts:1700-1701` only).
- Every command: 15 s timeout (`DEFAULT_GIT_COMMAND_TIMEOUT_MS`, `config.ts:4`) and
  `ensureGitCommandSucceeded` failure mapping (`gitCliHelpers.ts:169-205`).
- Measured on this repo (2026-09-28, `time`): `status -uall` **218 ms**, staged numstat
  **31 ms**, unstaged numstat **689 ms**, 3 091 status records — i.e. an extended refresh
  ≈ 1 s of spawn+parse per round. Umbrella records the same class of cost (757 ms numstat
  per 300 ms watcher flush, ≥1 core busy, `rust-native-ports.md` "Why").
- Triggers: workspace file-tree watcher flush debounce 300 ms
  (`packages/ui/src/workspace-file-tree/constants.ts:6`,
  `useWorkspaceFileTreeData.ts:521-554` → `gitStatus.ts:17-19` → `refresh`);
  `.git` auto-refresh throttled 60 s (`packages/ui/src/hooks/useGitAutoRefresh.ts:13-15`);
  header/Git-pane refresh (`packages/ui/src/hooks/useGitRepository.ts:466-471`);
  manual refresh (`packages/ui/src/GitActionMenu.tsx:933-936`). Promise dedup is
  in-flight only (`reuseInFlightRequest`, `gitCliRepo.ts:573-590`) — no caching, so every
  flush pays the full cost.

### Ported operations

| # | Operation | Legacy evidence | Native engine work |
|---|---|---|---|
| 1 | Repository resolution | `gitCliRepo.ts:712-797` (rev-parse + `git --version` probe) | gix discovery + canonical path math + FS-based git-binary probe (no spawn) |
| 2 | Status snapshot (porcelain-v2 equivalent: branch headers, XY records, renames, conflicts, untracked all/normal, overflow collapse) | `gitCliRepo.ts:546-571,855-916` | `gix` status platform + tree↔index diff + dirwalk |
| 3 | Staged / unstaged / branch-comparison numstat (rename-detecting, `-z`, binary ⇒ 0/0) | `gitCliRepo.ts:874-885,1388-1400` | gix diffs + `line_counts()` |
| 4 | Untracked line stats | `gitCliHelpers.ts:427-485` | native file scan, 4 threads, same budgets |
| 5 | Identity (`user.name`/`user.email` + scope + origin) | `gitCliRepo.ts:1675-1728` | gix-config snapshot (value + `Metadata{source,path}`) |
| 6 | Ahead/behind + upstream name | inside `git status` headers, parsed `gitCliHelpers.ts:264-282` | gix upstream resolution + paint-down-to-common count |

## Ownership

| Piece | Owner |
|---|---|
| `packages/rust/crates/zcode-git/**` (Cargo.toml, src/lib.rs) | GitSpecAuthor |
| `packages/rust/src/git.ts` (subpath binding: TS types + `loadGitApi()`) | GitSpecAuthor |
| `docs/specs/rust-native-git.md` (this file) | GitSpecAuthor |
| Consumer integration: `packages/services/src/git/repo/gitCliRepo.ts`, `gitCliHelpers.ts`, `packages/services/src/git/config.ts` | GitSpecAuthor |
| `packages/rust` shared scaffold (`Cargo.toml`, `package.json`, `tsconfig.json`, `src/loader.ts`, `src/index.ts`, `scripts/build-native.sh`), umbrella spec, policy, root scripts | main session (never edited by GitSpecAuthor) |

Shared-scaffold facts that already serve this port (verified, no change needed):
workspace `members = ["crates/*"]` (`packages/rust/Cargo.toml:2`); subpath export
`"./git": "./src/git.ts"` exists (`packages/rust/package.json:9`); `build-native.sh`
iterates `crates/*` (`scripts/build-native.sh:18-32`); `loadNative` is generic
(`src/loader.ts:61-79`); `@zcode/rust` is already a dependency of `packages/services`
(`packages/services/package.json`) and is esbuild-external
(`apps/zcode-cli/packages/cli/scripts/build.mjs:14`); root `typecheck` already covers
`packages/services` and `packages/rust`; `architecture-policy.yaml` grants `services`
`requires: [rust]` and forbids deep imports (consumers import the subpath export only).

## Engine decision: `gix` (gitoxide), not `git2` (libgit2)

Constraint (engine rule 5): the ported feature performs **zero child-process spawns**, so
neither engine may shell out to `git`. Both were probed offline with a scratch cargo
project in `/tmp` against a fixture repo (staged/unstaged/rename/binary/conflict/detached/
worktree states built in `/tmp/gitfx`, ground truth captured with the real `git` CLI).

| Criterion | `gix = "0.88"` (0.88.0, released 2026-09-25) | `git2 = "0.21"` (0.21.0) | Winner |
|---|---|---|---|
| Conflict XY codes (`u AA`/`UU`/…) | `gix_status::index_as_worktree::Conflict` enum maps 1:1 (`BothAdded`, `BothModified`, `BothDeleted`, `AddedByUs/Them`, `DeletedByUs/Them` ⇒ `AA/UU/DD/AU/UA/DU/UD`) — verified in `gix-status-0.35.0/src/index_as_worktree/types.rs:205-231` | `Status::CONFLICTED` flag only; exact XY lost, must be re-derived from index stages | **gix** |
| Identity `--show-origin` (file path) + `--show-scope` | `gix_config::file::Metadata { path, source, level, trust }` per section (`gix-config-0.61.0/src/file/mod.rs:35-43`); `Source` enum covers system/global/local/worktree/env/cli (`types.rs:17-42`); probe printed `value=Tester source=Local path=/tmp/gitfx/work/.git/config` | `git2::ConfigEntry` has `level()`/`include_depth()` but **no origin/path accessor** (`git2-0.21.0/src/config.rs:525-565`) → hard parity gap on `nameSource`/`emailSource` | **gix** |
| `include` / `includeIf` conditional config | implemented (`gix-config …/file/includes/mod.rs:77-257`, gitdir conditions with context) | not verified; libgit2 historically incomplete here — irrelevant now | **gix** |
| Status untracked modes `-uall` / `-unormal` | `UntrackedFiles::Files` vs `Collapsed` (`gix-0.88.0/src/status/mod.rs:47-60`), probe reproduced `dir/` collapse | `recurse_untracked_dirs(bool)` (coarser: no `dir/` collapse mode exposed) | **gix** |
| Worktree rename suppression in status | index→worktree rewrites `None` by default (`status/platform.rs:104-118`) = matches CLI ground truth (`mv` shows `1 .D` + `?`) | needs explicit `renames_index_to_workdir(false)` discipline | tie |
| Rename original path | `gix_diff::index::Change::Rewrite { source_location, location }` and `status::index_worktree::Rewrite.source` | `StatusEntry::head_to_index()` delta old path — works | tie |
| Ahead/behind | no built-in; custom paint-down-to-common (validated vs `git rev-list --left-right --count` in harness) | `graph_ahead_behind()` built-in | git2 |
| Line counts (numstat) | `blob::diff::Platform::line_counts() → DiffLineStats { removals, insertions }`, binary ⇒ `None` (`gix-0.88.0/src/object/blob.rs:116-137`), honours `diff.algorithm` | `Patch::line_stats()` over vendored xdiff (closer lineage to git's diff core) | git2 (slightly) |
| Process purity / packaging | pure Rust; no C toolchain; spawn surface = `gix-path`'s git-invocation helpers, neutralised by default permissions (below) | `libgit2-sys` C build (cc/link variance per platform, larger `.node`) | **gix** |
| Cancellation | `Platform::should_interrupt_owned(Arc<AtomicBool>)` polled during status/dirwalk (`status/platform.rs:54-67`) | no per-operation interrupt | **gix** |

**Decision: `gix` 0.88** with `default-features = false, features = ["status", "parallel",
"revision", "index", "dirwalk", "attributes", "excludes", "blob-diff", "interrupt",
"sha1"]` (this exact set compiled and ran the probe) plus direct `gix-status = "0.35"`,
`gix-diff = "0.68"`, `gix-object = "0.65"` where re-exports are insufficient. The stub's
provisional `git2 = "0.20"` + `rayon` dependencies are removed (crate file, owned by this
port). Line-count and ordering divergences of imara-diff vs git's xdiff are bounded by the
parity harness below and enumerated under "Divergences".

### Zero-spawn guarantee for gix (engine rule 5) — verified

`gix-path` *can* invoke `git` (config-path discovery, `gix-path-0.13.0/src/env/git/mod.rs:141-198`),
but:

- `open::permissions::Config::all()` ships `git_binary: false` precisely because that
  source "may involve executing the git binary" (`gix-0.88.0/src/open/permissions.rs:10-24,38-56`),
  so `Source::GitInstallation` short-circuits before any invocation; on unix
  `Source::System` resolves to the constant `/etc/gitconfig` without spawning
  (`gix-path-0.13.0/src/env/mod.rs:48-54`).
- **Empirically verified**: a `git` shim first on `PATH` that appends to a log ran the full
  probe (discover, status ×2, upstream, config snapshot, tree diff) — log stayed empty.
- Windows caveat: `system_config()` there consults `GIT_CONFIG_PATHS` which invokes `git`
  once per process. Mitigation: always pass `open::Options::system_config_path(...)`
  (and `git_installation_config_path(...)` if `permissions.config.git_binary` is ever
  enabled) resolved by filesystem probing of the same candidate prefixes the TS code uses
  (`config.ts:18-33, 58-66`); `source_path` then short-circuits before `storage_location`
  (`gix-0.88.0/src/config/cache/init.rs:218-249`). Acceptance requires the shim test on
  Windows/macOS targets too.
- No gix feature that shells out (`command`, `credentials`, network transports) is enabled.
- The crate never sets `GIT_*` env overrides for its engine; discovery is path-based, which
  matches legacy semantics because `getGitCommandEnv()` strips `GIT_DIR`/`GIT_WORK_TREE`/
  `GIT_COMMON_DIR`/`GIT_CONFIG*` from child environments anyway
  (`config.ts:34-87`).

## Crate API design (exact `#[napi]` surface)

All four exports are **`AsyncTask`** (engine rule 4 — every unit can exceed 1 ms; legacy
status/numstat/rev-parse all ran as child processes, i.e. never on the event loop). No
synchronous exports. No `AbortSignal` equivalent is exposed (see Abort semantics).

Naming follows `zcode-image` precedent: `#[napi(object)]` structs with camelCase TS
fields, `Task` impl per operation, `Result<AsyncTask<T>>` returns.

```rust
// crates/zcode-git/src/lib.rs (signatures; implementation = wave 2)

#[napi(object)]
pub struct NativeResolveRequest { pub workspace_path: String }

#[napi(object)]
pub struct NativeResolveResult {
  pub git_available: bool,                 // legacy isGitAvailable (FS probe, no spawn)
  pub discovery: String,                   // "ok" | "not-repository" | "missing-workdir"
  pub repo_root: String,                   // absolute; "" unless discovery == "ok"
  pub workspace_prefix: String,            // rev-parse --show-prefix equivalent: "" | "sub/" (trailing slash)
  pub git_dir: String,                     // absolute (--absolute-git-dir equivalent)
  pub git_common_dir: String,              // ABSOLUTE (--git-common-dir equivalent)
}
#[napi]
pub fn resolve_repository(req: NativeResolveRequest)
  -> Result<AsyncTask<ResolveTask>>;       // Task Output = NativeResolveResult

#[napi(object)]
pub struct NativeStatusRequest { pub repo_root: String }

#[napi(object)]
pub struct NativeStatusEntry {
  pub path: String,                        // repo-root-relative, "/"-normalized (normalizeGitPath)
  pub original_path: Option<String>,       // type-2 source path
  pub x: Option<String>,                   // porcelain X char (".", "M", "A", "D", "R", "T", …)
  pub y: Option<String>,                   // porcelain Y char
  pub is_untracked: bool,
  pub is_conflicted: bool,
}
#[napi(object)]
pub struct NativeStatRecord { pub path: String, pub added: i64, pub removed: i64 }

#[napi(object)]
pub struct NativeStatusSnapshot {
  pub branch_name: Option<String>,         // null ⇔ head detached (header "(detached)")
  pub tracking_branch_name: Option<String>,// e.g. "origin/master"
  pub head_ref_type: String,               // "branch" | "detached"
  pub ahead: i64, pub behind: i64,
  pub entries: Vec<NativeStatusEntry>,     // EXACT legacy record order (see Ordering)
  pub staged_stats: Vec<NativeStatRecord>,
  pub unstaged_stats: Vec<NativeStatRecord>,
  pub untracked_stats: Vec<NativeStatRecord>,
  pub collapsed_now: bool,                 // first overflow-collapse for this repoRoot (drives legacy log.warn)
}
#[napi]
pub fn status_snapshot(req: NativeStatusRequest)
  -> Result<AsyncTask<StatusTask>>;        // Task Output = NativeStatusSnapshot

#[napi(object)]
pub struct NativeIdentityRequest { pub repo_root: String }

#[napi(object)]
pub struct NativeIdentity {
  pub user_name: Option<String>, pub user_email: Option<String>,
  pub name_source: Option<String>,         // --show-origin equivalent, e.g. "file:.git/config"
  pub email_source: Option<String>,
  pub name_scope: Option<String>,          // --show-scope equivalent, e.g. "local"
  pub email_scope: Option<String>,
}
#[napi]
pub fn identity(req: NativeIdentityRequest) -> Result<AsyncTask<IdentityTask>>;

#[napi(object)]
pub struct NativeBranchComparisonRequest {
  pub repo_root: String,
  pub tracking_branch_name: String,        // legacy always diffs "<tracking>...HEAD"
}
#[napi(object)]
pub struct NativeBranchChange {
  pub path: String, pub original_path: Option<String>,
  pub added: i64, pub removed: i64,
  pub kind: String,                        // "added" | "deleted" | "modified" | "renamed"
}
#[napi]
pub fn branch_comparison(req: NativeBranchComparisonRequest)
  -> Result<AsyncTask<BranchComparisonTask>>;
```

TS binding (`packages/rust/src/git.ts`, mirrors `src/diff.ts`/`src/image.ts`):
`NativeGitApi` interface + `loadGitApi(): NativeGitApi` → `loadNative("zcode-git")`.
Loud failure, no fallback (invariant 1).

### Design justifications

- **Granularity, not one mega-call**: the four exports mirror the four legacy repo
  methods so `reuseInFlightRequest` dedup maps (`gitCliRepo.ts:573-590`) and the
  `invalidate()` lifecycle (`:594-599`) stay untouched, and non-refresh readers
  (`getRepositorySummary` `gitService.ts:177`, `getChanges` `:214`, commit preview `:260`,
  `listLocalBranches` `:978`, push `:1639`, switch `:1075/1170/1242`, branch-diff
  `:1270`) keep calling `repo.getStatus(...)` exactly as today — only the body beneath
  the interface changes. No caller of `GitCliRepo` needs edits.
- **`resolveRepository` moves native too** (decision 6): it is a spawn today
  (`:730-738` + the `git --version` probe), and `refresh` cannot satisfy zero-spawn
  otherwise. Native returns the four rev-parse values plus the discovery enum; TS keeps
  building the fallback literals (`:717-726`, `:744-762`) and `GitResolvedRepository`
  with the existing pure helpers `normalizeWorkspaceInRepoPath`
  (`config.ts:93-99`) and `buildAutoRefreshWatchPaths` (`gitCliRepo.ts:142-164`) —
  absolute `git_common_dir` flows through `isAbsolute` branch unchanged (`:156-161`).
- **Kind derivation stays split with legacy**: status-entry `kind` keeps using the existing
  `inferKindFromStatusCode` (in `gitCliHelpers.ts`, still required by the commit path's
  `parseStatusPorcelain` call); branch-change `kind` replicates the 5-line
  `inferKindFromNumstat` rule natively (same arithmetic ⇒ identical strings) because that
  helper dies with its last caller.
- **Stats cross the boundary as arrays**: napi objects become plain JS objects, not `Map`s;
  TS builds the three `Map<string, GitLineStat>` exactly where it does today
  (`gitCliRepo.ts:911-914`), preserving `GitStatusSnapshot` byte-for-byte. Map insertion
  order is never observable (lookup-only consumers, `gitService.ts:80-113`).

## Data-shape parity table (engine rule 3 — byte-identical payloads)

| Output (contract) | Legacy producer | Native representation → TS assembly | Claim |
|---|---|---|---|
| `GitResolvedRepository` | `gitCliRepo.ts:774-788` (+fallbacks `:717-726`, `:744-762`) | `NativeResolveResult` + existing TS literals/helpers | identical fields/values; `git_common_dir` absolute vs legacy relative → same resolved `autoRefreshWatchPaths` (both go through `:156-161`) |
| `GitRepositorySummary` | built at `gitCliRepo.ts:896-910` / `createEmptySummary` (`gitCliTypes.ts:104-119`) | unchanged TS code over native snapshot | byte-identical by construction |
| `GitStatusEntry[]` (order matters) | `parseStatusPorcelain` record order | native emits the same record order (4-group rule below); TS `inferKindFromStatusCode` unchanged | byte-identical incl. order, verified by harness |
| `stagedStats`/`unstagedStats`/`untrackedStats` | `parseNumstat` + `buildUntrackedStats` maps | arrays → same TS map-building site | identical key sets and `{added,removed}` values (see Divergence D7 for unmerged paths) |
| branch headers | `gitCliHelpers.ts:264-282` | gix head/upstream + custom ahead/behind | `branchName`, `trackingBranchName`, `headRefType`, `ahead`, `behind` identical (`(detached)` ⇒ `null` + `"detached"`; unborn ⇒ `oid`-free fields as legacy ignores oid) |
| `GitIdentity` | `gitCliRepo.ts:1706-1727` | `NativeIdentity` → TS `scopeLabel = name_scope ?? email_scope ?? null` | identical values incl. `file:`-origin and scope strings (mapping + harness below) |
| `GitBranchComparisonSnapshot.changes[]` | `gitCliRepo.ts:1402-1411` | `NativeBranchChange[]` in git's record order | identical array incl. order |
| `GitRefreshResult` (RPC payload) | `gitService.ts:348-354` | **unchanged file** — composes the same snapshots | byte-identical payload by construction |
| UTF-8 / non-UTF8 paths | legacy stdout decoded via `chunk.toString("utf-8")` (`gitCommandProvider.ts:209`) | native converts bytes → JS string with WHATWG-equivalent lossy UTF-8 (U+FFFD) | identical strings (fixture with invalid-UTF8 filename in harness) |

Ordering rule for `entries` (empirically pinned against the CLI, 2026-09-28):
1. (headers, not entries) `# branch.oid`, `# branch.head`, `# branch.upstream`, `# branch.ab`;
2. tracked `1`/`2` records, **byte-sorted by record path (rename destination)**, staged and
   unstaged interleaved by path (verified: staged-only `zzz` sorts after unstaged-only
   `aaa`);
3. conflicted `u` records, path-sorted, **after** all tracked records (verified: `u 0conf`
   after `1 zzz_tracked`);
4. untracked `?` records, path-sorted, **last** (verified: `? aaa_untracked` after `1`s).
The gix parallel iterator yields undefined order (`gix-0.88.0/src/status/iter/mod.rs:26-54`),
so the crate must merge TreeIndex (staged X) + IndexWorktree (Y/untracked/conflict) by path
and apply exactly this grouping; nested-path byte-sort equivalence is a pinned harness
fixture (mismatch = bug, not a divergence).

## State / owner design sketch

- TS keeps owning: the three in-flight maps + `invalidate()` (`gitCliRepo.ts:532-544,
  573-590`, `:594-599`), fallback literal construction, summary/snapshot assembly, `Map` building,
  `getChangesForSource`/`toChangeForSource`/`toBranchComparisonChange`
  (`gitService.ts:70-137`), `buildAutoRefreshWatchPaths`, and the legacy `log.warn` line
  — emitted when native returns `collapsed_now: true` (replicates `gitCliRepo.ts:563-569`).
- The crate owns two process-lifetime statics inside the `.node`:
  - `collapsed_untracked_roots: Mutex<HashSet<PathBuf>>` — mirrors
    `collapsedUntrackedRepoRoots` (`:544`, set at `:565`, never cleared by `invalidate`,
    exactly like legacy);
  - git-binary probe cache — mirrors the session cache in
    `gitEnvironmentProvider.ts:41-58`, but filesystem-only: candidate list
    `ZCODE_GIT_BINARY` → `PATH` scan → Windows Program Files candidates
    (`config.ts:18-33, 58-66`), existence + executable-bit check, cached forever.
- No cross-call repo cache: parity with legacy's in-flight-only dedup (no caching).

## Overflow rule (512 KiB) re-derived — output shape unchanged

Legacy semantics (verified in `gitCommandProvider.ts:199-215`): `outputTruncated` ⇔ the
full stdout byte length **>** `maxOutputBytes` (512 KiB). For status, `runGitStatus`
(`gitCliRepo.ts:555-571`) then re-runs with `--untracked-files=normal` and remembers the
repoRoot forever; if the collapsed run *still* exceeds the cap, `ensureGitCommandSucceeded`
throws `git status output exceeded limit` (`gitCliHelpers.ts:194-196`) — parity keeps that.

Native has no stdout, so it re-derives the decision exactly:

1. Build all status records and accumulate their **exact legacy byte length** (record
   templates incl. the two oids of `1`/`2` records — available from index/tree entries —
   plus NUL separators and header lines).
2. `> 512 * 1024` ⇒ discard the untracked-all group, re-walk with
   `UntrackedFiles::Collapsed`, set `collapsed_now` (only when this repoRoot first
   crosses), remember the root; recompute size; still `>` ⇒ throw
   `git status output exceeded limit`.
3. Otherwise emit entries as-is. Records beyond the untracked group are byte-accounted the
   same way, so a huge *tracked* churn still fails exactly like legacy.

Identical byte-gates (throwing the same `"<label> output exceeded limit"` strings) are
implemented for staged numstat (`git diff --cached --numstat`), unstaged numstat
(`git diff --numstat`), branch comparison (`git diff --numstat upstream...HEAD`), identity
(`git config`) and resolution (`git rev-parse`) — legacy applies the default cap to all of
them (`gitCommandProvider.ts:93-94`).

The `GitStatusSnapshot`/`GitRefreshResult` **shapes are identical in every branch**
(collapsed entries are `path`-with-trailing-`/` untracked records either way — legacy's
`shouldIncludeUntrackedChange` already special-cases them, `gitService.ts:64-69`).

## Untracked stats move into the crate (decision 3, event-loop rule 4)

Ported 1:1 from `gitCliHelpers.ts:427-485` inside the `status_snapshot` async task:
`stat` must be a regular file and `size ≤ 1 MiB` (`GIT_UNTRACKED_STAT_MAX_BYTES`), read in
64 KiB chunks up to `size + 1` bytes, `totalBytes > 1 MiB` after growth ⇒ `0`, NUL byte ⇒
`0`, EOF ⇒ `newlines + (lastByte == '\n' ? 0 : 1)` with `lastByte` initialised to `'\n'`,
any error ⇒ `{added: 0, removed: 0}`, collapsed `dir/` keys included (stat of a directory
⇒ `{0,0}`). Concurrency: 4 fixed threads with one 64 KiB buffer each (mirrors
`GIT_UNTRACKED_STAT_CONCURRENCY = 4`, `config.ts:16`, and the comment about bounded memory
at `gitCliHelpers.ts:461-463`); thread scheduling cannot change the result (per-key
independent). Chunk size does not affect semantics (every byte is scanned once) but is kept
at 64 KiB for memory parity. No timeout here — legacy had none on file scans.

## Async, ordering, abort (engine rules 4 + 6)

- All four exports are `AsyncTask`; `compute()` runs on napi's async worker; gix uses its
  own `parallel` threads internally. The event loop never runs status/numstat/config work.
- `gitService.refresh` (`gitService.ts:321-336`) keeps its `Promise.all` — native tasks
  run concurrently exactly like the legacy parallel spawns did; `getBranchComparison` still
  `await`s `getStatus` first (`gitCliRepo.ts:1372`), so the same dedup collapses them.
  Result field order and array order are fixed by the unchanged TS literals.
- **Timeout parity**: legacy = 15 s per spawned command (`config.ts:4`). Native = a 15 s
  deadline per unit (resolve, status, staged numstat, unstaged numstat, identity,
  branch comparison), enforced with gix `should_interrupt_owned` during walks plus
  explicit checks between work units and every N commits in ahead/behind counting.
  Expiry throws `<label> timed out after 15000ms` with native timing detail (legacy's
  kill/cleanup stats are process artifacts — enumerated divergence D1).
- **AbortSignal**: the legacy refresh API accepted **none** — `GitRefreshRequest` is only
  `{ workspacePath, includeIdentity?, includeBranchComparison? }`
  (`packages/shared/src/git.ts:126-129`, `git.ts:52`) and `GitCommandExecutionOptions`
  has no signal field (`gitCommandProvider.ts:8-16`). Parity therefore requires no signal;
  no cancel handle is invented (the UI's 8 s file-tree race
  (`useWorkspaceFileTreeData` timeout constant `constants.ts:10`) never reached the
  service either). Engine rule 6 is satisfied by the documented timeout semantics above.

## Failure semantics

| Condition | Legacy behavior (file:line) | Native behavior |
|---|---|---|
| git binary missing | `isGitAvailable:false` fallback, no throw (`gitCliRepo.ts:717-726`) | identical: FS probe finds no candidate ⇒ same literal |
| missing workdir / not a repo | fallback literals (`:744-762`) | `discovery` enum ⇒ identical literals in TS |
| binary missing mid-path | `run()` throws "Git binary is not available" (`gitCommandProvider.ts:88-90`) — unreachable for refresh after resolve | same guard before native units |
| command timeout | throw `"<label> timed out after 15000ms (elapsed=…, killAt=…)"` (`gitCliHelpers.ts:174-191`) | throw `"<label> timed out after 15000ms (native detail)"` — **enumerated D1** |
| output > 512 KiB | `"<label> output exceeded limit"` (`:194-196`) | same strings via byte-gates (status incl. collapse) |
| non-zero exit / engine error | `"<label> failed: <stderr…>"` (`:198-204`) | `"<label> failed: <engine message>"` — prefix identical, detail text differs (**D2**) |
| identity key unset | `exit 1` ⇒ nulls (`:665-667`) | no value ⇒ nulls |
| binary load failure | `loadNative` throws actionable error (`src/loader.ts:61-79`), never falls back | same — the only failure mode of the wrapper |
| config unreadable (permissions) | `git config failed: …` | same label, native detail (**D2**) |

## Non-goals / unported sibling features (NOT fallbacks)

These keep spawning via `commandProvider` — they are separate features, never invoked as
alternatives to the native refresh path (engine rule 5):

- Mutations & operations: `stage`/`unstage`/`discard` (`git add/rm/checkout`, `gitCliRepo.ts:1423-1478`),
  `commit` incl. its scoped `git status --porcelain=v2 -z -- pathspec` + `ls-files`
  (`:1488-1560`), `push` (`:1638-1673`), `switchBranch`/`createBranchAndSwitch`
  (`:1069-1260`), `listLocalBranches` `for-each-ref` (`:977-1000`), `validateBranchName`
  (`:600-612`), operation markers (`:615-630`), push-remote config reads (`:636-671`),
  `getIgnoredPaths` `check-ignore` (`:919-960`), `getCommitGraph` log (`:1009+`),
  `getDiff` (`:1252-1368`, 20 s timeout — separate feature), blob previews
  (`:80-98`, `:166-215`), `git check-ref-format`/`ls-files` helpers.
- Providers stay: `gitCommandProvider.ts`, `gitEnvironmentProvider.ts` (still used by
  every sibling above; its `resolveGitBinary` spawn remains for them).
- Session env snapshot: `apps/zcode-cli/packages/adapters/src/context/git-snapshot.ts`
  (own `execFile` git usage — independent feature).
- Bootstrap workflow world-read with its own porcelain parser:
  `apps/zcode-cli/packages/bootstrap/src/app/workflow-git-world-read.ts:297+`.
- Checkpoint system: `gitCheckpointRepo.ts` / `gitCheckpointHelpers.ts` (own
  `parseNumstat` at `gitCheckpointHelpers.ts:84` — untouched, not a fallback).
- `getWorkspaceRepositoryInfo` (pure `stat`/`readFile`, `gitCliRepo.ts:789-853`) — no
  spawn, stays TS; its `resolveRepository` dependency becomes native automatically.
- UI trigger logic (300 ms / 60 s debounces), `GitStatusSnapshot` contract types, RPC
  layer — unchanged.

## Migration boundary (exact file list)

Files **edited by this port** (all owned by this agent / consumer integration):

1. `packages/rust/crates/zcode-git/Cargo.toml` — drop stub `git2 = "0.20"` + `rayon`;
   add the `gix` feature set above (+ direct `gix-status`/`gix-diff`/`gix-object` as
   needed); keep `napi`/`napi-derive` workspace deps; `serde`/`serde_json` only if used.
2. `packages/rust/crates/zcode-git/src/lib.rs` — replace the comment stub with the four
   `AsyncTask` exports (implementation wave).
3. `packages/rust/src/git.ts` — create (fills the existing dangling `./git` export).
4. `packages/services/src/git/repo/gitCliRepo.ts` —
   - `resolveRepository` (`:712`), `getStatus` (`:855`), `getBranchComparison` (`:1371`),
     `getIdentity` (`:1675`) bodies → native calls + unchanged assembly/dedup;
   - **DELETE** `executeGitStatus` (`:546-553`), `runGitStatus` (`:555-571`),
     `collapsedUntrackedRepoRoots` (`:544`, `:565`) — collapse state moves into the crate;
   - **DELETE** imports `inferKindFromNumstat`, `parseGitConfigValue`, `parseNumstat`
     (`:41,46,47`) once their last callers (`:912-913`, `:1402-1406`, `:1700-1701`) are
     gone; **KEEP** `parseStatusPorcelain` (still called by `commit` at `:1521`) and
     `ensureGitCommandSucceeded` (sibling callers throughout).
5. `packages/services/src/git/repo/gitCliHelpers.ts` — **DELETE** `parseNumstat`
   (`:386-425`), `parseNumstatValue` (`:361-368`), `inferKindFromNumstat` (`:370-383`),
   `countUntrackedFileLines` (`:427-453`), `buildUntrackedStats` (`:455-485`),
   `parseGitConfigValue` (`:660-681`) — caller graph verified 2026-09-28: after the four
   body swaps, no references remain anywhere in the repo (checkpoint has its own copy).
   **DELETE** `isNotRepositoryResult` (`:205-208`) and
   `isMissingWorkingDirectoryResult` (`:210-217`) — their only callers are
   `resolveRepository`'s swapped stderr handling (`gitCliRepo.ts:743`, `:754`).
   **KEEP** `parseStatusPorcelain` + `inferKindFromStatusCode` (commit path `:1521`) and
   `ensureGitCommandSucceeded` (callers throughout siblings and checkpoint,
   e.g. `gitCliRepo.ts:610,888,961,997,1400` and `gitCheckpointRepo.ts:118-488`).
6. `packages/services/src/git/config.ts` — **DELETE** `GIT_UNTRACKED_STAT_MAX_BYTES`,
   `GIT_UNTRACKED_STAT_CHUNK_BYTES`, `GIT_UNTRACKED_STAT_CONCURRENCY` (`:14-16`; only
   importer today is `gitCliHelpers.ts:11-13`).

Files explicitly **unchanged**: `gitService.ts` (composition and
`getChangesForSource` machinery untouched), `gitCliTypes.ts` (contracts), all of
`packages/shared`, all UI, providers, checkpoint, adapters, bootstrap,
`packages/rust` shared scaffold, umbrella spec, policy, lockfile-managed workspace deps
(no new shared workspace dependency: `gix` lives in the crate manifest, like `image`/
`mozjpeg` in `zcode-image`).

`packages/services/package.json` needs **no change** — `@zcode/rust: workspace:*` is
already present.

## Divergences enumerated (explicit, fixture-backed like `rust-native-diff.md`)

- **D1 — timeout message detail.** Legacy appends kill/cleanup telemetry
  (`elapsed/killAt/cleanup/forceKill/orphaned`, `gitCliHelpers.ts:174-191`); native has no
  process to kill. Prefix `<label> timed out after 15000ms` preserved; error strings are
  not wire payloads (surfaced as UI text only).
- **D2 — failure detail text.** `"<label> failed: …"` detail comes from the engine instead
  of git's stderr; label and shape preserved.
- **D3 — git availability probe.** Legacy executes `git --version` per candidate
  (`gitEnvironmentProvider.ts:12-36`); native checks exists+executable (zero-spawn
  mandate). A broken-but-present `git` reads as available natively; consequence is
  confined to sibling CLI features failing loudly on their own.
- **D4 — install-scoped config not loaded.** gix's default `permissions.config.git_binary
  = false` skips the git-binary installation config (the file `git config --show-origin`
  reports on exotic installs, e.g. Apple's `unknown` scope). On standard Linux/Windows/
  Homebrew layouts system config resolves without it (Windows via explicit
  `system_config_path`, Linux `/etc/gitconfig`, global/XDG from env). Impact: identity
  `scopeLabel`/`nameSource` differ only if the value exists *only* in such a file —
  harness covers local/global/XDG/system/include fixtures and flags any miss.
- **D5 — no external filters/processes.** Legacy `git status` itself could spawn
  `filter.lfs.process` etc. Zero-spawn forbids this: with `clean/smudge` pipelines
  (LFS), tracked-but-filtered files may report as worktree-modified when the checkout is
  actually clean. Enumerated per engine rule 5; builtin filters (CRLF/ident) are applied
  by gix in-process.
- **D6 — host env config vars.** Legacy strips `GIT_CONFIG`/`GIT_CONFIG_COUNT`/
  `GIT_CONFIG_PARAMETERS` from child env (`config.ts:34-56`); gix reads process env with
  `permissions.config.env = true`. Divergence only if the host process itself carries
  those variables (the CLI/Desktop hosts do not); documented, not guarded.
- **D7 — unmerged-path `unstagedStats` value.** Legacy `git diff --numstat` emits *two*
  records for a conflicted path and `parseNumstat`'s Map keeps the last
  (observed `0 0 path` + `4 0 path` ⇒ `{4,0}`). Native computes its own value for that
  key. **Provably payload-irrelevant**: conflicted entries never read the map —
  `toChangeForSource` hardcodes `0/0` for conflicts (`gitService.ts:94-97`) and staged
  skips them (`:84-87`); `GitRefreshResult`/`getChanges` therefore cannot differ. Enumerated
  because `GitStatusSnapshot` itself is internal-only there.
- **D8 — diff line-count lineage.** Counts come from imara-diff (via gix) rather than
  git's xdiff. Identical on all fixtures/fuzz pairs in the harness by requirement; any
  pathological ambiguity case that diverges must be added to this list with evidence
  (same policy as the jsdiff-timeout divergence in `rust-native-diff.md`).
  - *Amended case (2026-09-28, GitPortImpl, Main-authorized):* ambiguous hunks where
    multiple minimal alignments exist — fixture 18 (live ZCode repo, tree-stable
    sandwich window) diverges on 2 files: native `unstagedStats` `{15,15}` /
    `{50,46}` vs `git diff --numstat` default `{16,16}` / `{52,48}`
    (`turn-output-token-continuation.ts`, `offPeakMockGateway.ts`). Root cause:
    imara-diff-with-slider-heuristics (`gix_diff::blob::diff_with_slider_heuristics`)
    vs git's xdiff myers lineage. Verified on the frozen index/worktree pair:
    `git diff --diff-algorithm=myers` = 16/16 (git default, no config), `histogram` =
    15/15 (native's effective alignment). Impact: Git-pane `added`/`removed` counts
    only on ambiguous hunks — status entries, ordering, and all payload shapes
    unaffected. Harness: 51/52 with the entire required acceptance fixture list
    passing; accepted as cosmetic per Main ruling.

Not divergences (equivalences to prove): overflow gate (exact byte ⇔ provider truncation),
collapse rule, record order, UTF-8 lossy decoding, rename threshold (explicit 50% =
`--find-renames` default for numstat; config-honoring `AsConfigured` for status = `git
status` default), `status.showUntrackedFiles` (legacy always passes the flag; native
always overrides explicitly).

## Acceptance checklist

Feasibility evidence already gathered (this wave, read-only/`/tmp`):

- gix 0.88 probe compiled with the exact feature set and ran against `/tmp/gitfx` fixtures:
  discovery (`workdir/git_dir/common_dir`), status items (modification + conflict +
  untracked collapse), upstream short name `origin/master`, `merge_base`, config identity
  (`value=Tester source=Local path=…/.git/config`), tree-change events with rewrites —
  all printed; spawn-shim log empty.
- git2 0.21 probed and rejected (config origin gap, conflict XY loss) — table above.
- Live legacy timings on this repo: status 218 ms / staged 31 ms / unstaged 689 ms
  (3 091 records); CLI ground-truth captures for ordering, collapse, rename, conflict
  (`u AA`), detached, unborn, worktree origin strings (`file:.git/config` relative from
  main tree, absolute from linked worktree).

Implementation phase (wave 2) gates, per umbrella + assignment:

1. `cargo build --release` (workspace) with `zcode-git` in the dep graph; no `command`/
   network/credentials gix features present (`cargo tree` grep).
2. `pnpm --filter @zcode/rust build:native` emits `zcode-git.<platform>.node`.
3. Direct-load smoke:
   `node -e "const m=require('./packages/rust/zcode-git.<platform>.node'); console.log(Object.keys(m))"`
   → the four exports (+ class for tasks).
4. **Parity harness** (throwaway in `/tmp`, results quoted in the delivery report):
   legacy service output vs native output, deep-equal on `GitRefreshResult` and
   `GitStatusSnapshot` for fixtures: clean repo; staged/unstaged/MM/`A.`/`D.`; staged
   rename (committed source) incl. `2 R.` original path; binary numstat (`-` ⇒ 0/0);
   untracked file + untracked dir (`-uall` and collapse); >512 KiB overflow → collapse →
   persistent behavior + exact error when still over; conflicts (`AA`, `UU`, …) incl.
   `u` grouping; detached HEAD; unborn repo; nested-path ordering (`a.txt` vs `a/b.txt`);
   subdir workspace; linked worktree; identity: local/global/XDG/missing/include; upstream
   ahead/behind vs `git rev-list --left-right --count`; no-upstream; intent-to-add;
   invalid-UTF-8 filename (linux); symlinked workspace (unix); large-file untracked stats
   (1 MiB boundary, NUL byte, partial last line, growing file, unreadable file, directory
   key).
5. **Zero-spawn proof**: PATH-shim `git` that logs invocations; run the full native
   refresh path (resolve+status+identity+comparison, first call of the process); assert
   empty log — required on linux AND windows/macos targets.
6. Grep proofs: `executeGitStatus|runGitStatus|collapsedUntrackedRepoRoots|parseNumstat\b|
   inferKindFromNumstat|buildUntrackedStats|countUntrackedFileLines|parseGitConfigValue|
   GIT_UNTRACKED_STAT_` absent from `packages/services`; `git status`/`diff --numstat`/
   `rev-parse`/`config --get` argv absent from the refresh methods in `gitCliRepo.ts`;
   no `try { native } catch { legacy }` shape anywhere in the touched files;
   `parseStatusPorcelain` still present exactly once with its `commit` caller.
7. `pnpm typecheck` (root `tsc -b` list includes `packages/services` + `packages/rust`),
   `pnpm lint`, `pnpm architecture:check --changed` — no new violations; services imports
   only `@zcode/rust/git` (subpath export, no deep paths).
8. Perf evidence in report: extended refresh wall time before (≈ 938 ms + identity +
   branch diff measured today) vs after, on this repo.
