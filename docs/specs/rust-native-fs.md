# Rust native port: filesystem service (`zcode-fs`)

Status: active. Owner: PortFs. Written 2026-09-30 **before** the crate, per `AGENTS.md:3`.

Crate: `packages/rust/crates/zcode-fs` · Wrapper: `packages/rust/src/fs.ts` · Subpath: `@zcode/rust/fs`

---

## 1. Motivation

Wave 1 of `docs/specs/rust-native-program.md` §2 names two critical security findings reached
through the file service. This port takes the first one, and the host compute underneath it.

### 1.1 The security finding (unchanged from the programme spec)

`packages/services/src/file/fileService.ts:425-428` today:

```ts
async resolvePath(params: { path: string }): Promise<string> {
  // The remote workspace may be entered via a symbolic link alias (/dev vs /home/dev).
  return realpath(params.path);
},
```

`realpath` with **no containment**. `readTextFile` (`:477`) then `open`s whatever absolute path the
caller passed; `readFileRange` (`:522`), `readMediaPreview` (`:549`) and `readBinaryPreview` (`:567`)
do the same. `IFileService` is registered on `ServiceChannels.File` and reached from the renderer
(`packages/ui/src/hooks/useFileService.ts:19`, `PreviewPane.tsx:1164`, `WorkspaceShellLayout.tsx:1274`,
`assistantPreviewCardValidation.ts:57`), so the path is caller-supplied. There is no allowlist, no
`..` normalization, and no post-symlink check anywhere in the module.

`rust-native-program.md` §2 states the intent: *"Porting them places the confinement check inside the
native boundary, where it cannot be skipped by a caller that simply does not call the TS wrapper,
and where it is enforced identically for the desktop host, the server, and the CLI."* That is the
deliverable, and it is a property the TypeScript implementation structurally cannot have: any check
added in TS can be bypassed by the next call site that forgets it, and `packages/server/src/entry-http.ts:21`
and `packages/zcode-server-cli/src/server-core/core.ts:40` build the same services from the same factory.

### 1.2 The host compute

`ensureWorkspaceFileIndex` (`fileService.ts:269-368`) is a full-repository walk whose cost is paid on
a user-visible path. The code comments record the measurements: a serial DFS over a 370,000-file
Windows workspace took **21.8 s**; the current version overlaps eight traversals. For every entry it
evaluates a gitignore matcher (the `ignore` npm package, `workspaceFileIgnore.ts:253-255`) and a
name/extension filter (`workspaceFileMentionFilter.ts:126-142`). Both are pure matching over strings
and are the dominant per-entry cost. Both move to Rust unchanged, inside the walk.

Two measured bugs the same walk has to keep:
- `resolveReaddirEntryType` (`fileService.ts:176-195`) re-`stat`s symlinks because Node's `Dirent`
  reports `isSymbolicLink` without `isDirectory` for directory symlinks; a broken symlink must resolve
  to `"file"`, not throw.
- `isSkippableWorkspaceFileListError` (`:118-121`) swallows `EACCES`/`EPERM`/`ENOENT` per directory so
  one unreadable subtree cannot fail the whole scan; every other error must still propagate.

---

## 2. Scope

### 2.1 Ported

| Predecessor | Location | Native export |
| --- | --- | --- |
| `readdir` | `fileService.ts:371-394` | `readdir` |
| `stat` | `fileService.ts:395-407` | `stat` |
| `checkFilesExist` | `fileService.ts:408-424` | `check_files_exist` |
| `resolvePath` | `fileService.ts:425-429` | `resolve_path` |
| `readTextFile` | `fileService.ts:477-521` | `read_text_file` |
| `readFileRange` | `fileService.ts:522-548` | `read_file_range` |
| `readMediaPreview` | `fileService.ts:549-566` | `read_media_preview` |
| `readBinaryPreview` | `fileService.ts:567-588` | `read_binary_preview` |
| `resolveReaddirEntryType` | `fileService.ts:176-195` | folded into `readdir` / `walk_workspace` |
| `isProbablyBinary` | `fileService.ts:86-103` | folded into `read_text_file` |
| `inferMediaTypeFromPath` | `fileService.ts:79-85` | folded into `read_media_preview` |
| `validateScratchWorkspaceName` | `fileService.ts:105-114` | folded into `ensure_workspace_directory` |
| workspace mkdir + is-directory check | `fileService.ts:430-476` | `ensure_workspace_directory` |
| `statWorkspaceFileSearchIgnoreFingerprint` | `fileService.ts:219-226` | folded into `load_workspace_ignore_rules` |
| `loadWorkspaceFileSearchIgnoreRules` | `workspaceFileIgnore.ts:307-384` | `load_workspace_ignore_rules` |
| `isWorkspaceFileSearchPathIgnored` | `workspaceFileIgnore.ts:391-399` | folded into `walk_workspace`; pure form kept as `match_workspace_ignore_path` |
| `readWorkspaceFileSearchIgnore` | `workspaceFileIgnore.ts:402-417` | `read_workspace_ignore` |
| `transformWorkspaceFileSearchIgnore` | `workspaceFileIgnore.ts:427-442` | `transform_workspace_ignore` |
| `writeWorkspaceFileSearchIgnore` | `workspaceFileIgnore.ts:445-451` | `write_workspace_ignore` |
| `atomicWriteIgnoreFile` | `workspaceFileIgnore.ts:277-296` | folded into `write_workspace_ignore` / `load_workspace_ignore_rules` |
| `buildWorkspaceFileSearchIgnoreTemplate` + `buildBuiltinDefaultsSection` + `splitWorkspaceFileSearchIgnoreSections` + the two section transforms | `workspaceFileIgnore.ts:106-247` | folded into the ignore exports; pure form kept as `build_workspace_ignore_template` |
| the repository walk itself | `fileService.ts:290-348` | `walk_workspace` |
| `defaultWorkspaceFileSearchFilter` | `workspaceFileMentionFilter.ts:126-142` | folded into `walk_workspace`; pure form kept as `evaluate_workspace_file_entry` |

`workspaceFileIgnore.ts` and `workspaceFileMentionFilter.ts` are **deleted**. `fileService.ts` keeps
only what §4 lists.

### 2.2 Out of scope (stated, not silently left behind)

- **`buildHostFileSearchCandidates` / `searchHostFileCandidates`** (`workspaceFileSearch.ts`).
  Not on the port list, and they are deliberately left in TypeScript for a reason that is a *parity*
  requirement, not laziness: they feed `filterWorkspaceFileSearchCandidates` from
  `@zcode/shared/workspaceFileSearch`, and they `await setImmediate()` between 2048-entry batches to
  keep the host event loop responsive. Porting them would fork the top-K merge order for no measured
  win (the 21.8 s is the walk, not the top-K).
- **The `localeCompare` sort.** The workspace index is sorted by
  `left.relativePath.localeCompare(right.relativePath)` (`fileService.ts:341-346`) and `readdir` by
  `a.name.localeCompare(b.name)` (`:390-393`). This is ICU collation, locale- and build-dependent
  (full-ICU vs small-ICU, `LANG`), and reproducing it in Rust would need an ICU collator this
  workspace does not depend on. Sorting the entries in Rust by bytes would **change the index order**,
  and that order is load-bearing: `filterWorkspaceFileSearchCandidates` merges top-K batches in index
  order, so a different order changes which entries win. Invariant 3 forbids that fork. The sort
  therefore stays in TypeScript on the entries the native walk returns. See §6 R4 for the cost.
- **`ensureWorkspaceFileIndex`'s cache** (`fileService.ts:265-368`: 60 s TTL, `.zcodeignore`
  mtime/size signature, 4-entry LRU, in-flight dedup, `refresh` bypass). This is host *policy* — how
  long a scan stays valid — not filesystem compute. It stays in `fileService.ts` and calls
  `load_workspace_ignore_rules` + `walk_workspace` instead of the TS walk. Its TTL, signature format
  and eviction order are unchanged.
- **`FileExistenceCache`** (`fileService.ts:128-174`, TTL 60 s, 100 entries). Same reason: a
  memoization policy, not compute. The *cap* and the *result* come from the native call.
- **`WorkspaceFileSearchFilter` injection** (`fileService.ts:197-199`, `node.ts:1315`,
  `node.ts:36-40`). Grep proof: **no caller anywhere in the repo passes
  `workspaceFileSearchFilter`** — `node.ts:2416` is the only read, and it is `options?.…`. With the
  default filter ported, the injection point has no implementation to inject, so the interface, the
  option and the four re-exports are deleted rather than left as a second, unported code path.
- **`os.homedir()`.** Stays in TypeScript and is passed *into* the native call as the base
  directory. `os.homedir()` has per-platform resolution semantics (Windows `USERPROFILE`, macOS
  `dscl`, libuv fallback chain) that `std::env::var("HOME")` does not reproduce. Every filesystem
  *operation* and every name/path *rule* still runs in Rust; only the platform's home lookup stays
  on the host, which is the same split `getConversationWorkspaceDir()` (`packages/services/src/paths.ts:48`)
  already makes for the app-data directory.
- **`getConversationWorkspaceDir()` / `getZCodeDataRootDir()`** (`paths.ts:43-50`). Configuration
  reads owned by the app-data module; the resulting path is passed as a root.

### 2.3 Why the workspace-creation methods are in scope

The brief asked for an explicit decision on `ensureConversationWorkspace`, `createDefaultWorkspace`
and `createScratchWorkspace`. Decision: **they are ported**, because after `os.homedir()` supplies
the base directory what remains is name validation, `mkdir -p`, an `isDirectory` verification, and a
`created` flag — all pure host compute and all filesystem effects, with no configuration read left
once the base is supplied. Keeping them in TypeScript would have left `node:fs/promises` imported by
`fileService.ts` and three more `mkdir` sites outside the native boundary. See §6 R6 for the
`created`-flag subtlety.

---

## 3. Design

### 3.1 The native boundary: required root allowlist

**Every native export that touches a path takes a required `roots: string[]` parameter.** There is no
default, no optional form, and no flag to skip the check. Omitting `roots` is a napi binding error
(`roots` is a required field of a `#[napi(object)]` request); passing `[]` rejects everything.

The resolution is:

```
canonicalize_each_root(root)                    // std::fs::canonicalize == realpath
canonical = canonicalize(requested_path)        // symlinks resolved
accept  ⟺  ∃ root : canonical == root
        ∨  canonical.starts_with(root + separator)
```

`canonicalize` is the whole check. Because it resolves every symlink component (including the final
one) before the prefix comparison, a symlink inside a root that points outside it fails the
comparison, and a `..` segment is folded away by the kernel before the comparison. The comparison is
`==` or `starts_with(root + sep)` — never a bare `starts_with(root)`, so `/ws-evil` is not accepted
for root `/ws`.

Ordering: roots are canonicalized first, then the requested path. A root that cannot be
canonicalized is **skipped** (it can contain nothing), not an error — see §4.

### 3.2 Why the TS side cannot bypass it

Three structural properties, in order of strength:

1. **There is no native path-taking export without `roots`.** A future call site cannot call the
   crate "the simple way": the signature does not exist. This is the property the TS implementation
   could not have and is the point of the port.
2. **Every TypeScript call site passes `scope.roots()`.** There is no branch, no `options.`
   feature-detection, no `catch` → legacy path. The `@zcode/rust/fs` subpath is the only
   implementation of the filesystem surface; `fileService.ts` contains no `node:fs` import.
3. **The allowlist is append-only.** `FileServiceScope` (`fileService.ts`) exposes only `allow()` and
   `roots()`; there is no `remove`, no `clear`, no `replace`, and no `bypass`. A root that has been
   admitted cannot be un-admitted for the lifetime of the service, so a cached verdict derived from a
   contained check (§5, `checkFilesExist`) stays valid.

### 3.3 The allowlist policy (who may open what) is the host's

`createFileService` takes a **required** `scope: FileServiceScope`. `node.ts` builds one from
`createFileServiceScope()`; the seeds are the two roots the service itself owns:
`join(homedir(), "ZCodeProject")` (the scratch/default workspace area) and
`getConversationWorkspaceDir()`. Roots are added by:

- the workspace-creation methods, for the directories they create or verify;
- every `rootPath`-carrying method (`searchWorkspaceFiles`, `listWorkspaceFilesLength`,
  `listWorkspaceFilesRange`, `readWorkspaceFileSearchIgnore`,
  `applyWorkspaceFileSearchIgnoreTransform`, `writeWorkspaceFileSearchIgnore`), for the `rootPath`
  the caller passed.

`FileServiceScope` is exported from `@zcode/services/node` so a host assembly can admit a workspace
root at workspace-open time. **No host does this today** — the four `createLocalServices` call sites
(`packages/desktop/src/host/index.ts:2843`, `packages/desktop/src/main/index.ts:1718`,
`packages/server/src/entry-http.ts:21`, `packages/zcode-server-cli/src/server-core/core.ts:40`) have
no workspace-path input, and `IFileService` is a frozen IPC contract that this port does not change.
That wiring is named in §6 R1 with the exact call site. It is the difference between *containment*
(symlink/`..`/traversal escape from a declared root is impossible) and *authorization* (only
declaring a root admits it), and this port delivers containment.

### 3.4 Why `isPathInWorkspaceScope` is not reused

`packages/services/src/git/config.ts:97-110` is a **string** predicate over a git repo-relative path
and a workspace-in-repo path. It does no I/O, resolves no symlink, and its result is used to filter a
returned file *list*. It is the wrong tool for a filesystem confinement decision: it would answer
"is `src/a.ts` inside the workspace" without ever asking the kernel what `src/a.ts` actually is. It
is also git-specific, so the file service would gain a git dependency. `zcode-fs` implements its own
`is_contained_in` over canonicalized paths; the two have no shared code and no shared contract.

### 3.5 Event-loop and process rules

All fourteen filesystem exports are `AsyncTask` (invariant 4): a 25 MB preview read, a 370,000-entry
walk and a 15-path existence batch all exceed 1 ms, so none of them may run on the host's event loop.
The three pure exports (`match_workspace_ignore_path`, `evaluate_workspace_file_entry`,
`build_workspace_ignore_template`) are synchronous string work below 1 ms and are the only synchronous
exports. **Zero child processes** (invariant 5): no `Command`, no `git`, no `sh`; the crate links
only `std`, `napi`, `base64` and `ignore`.

### 3.6 Byte boundary

`read_file_range` returns `napi::bindgen_prelude::Buffer` (invariant 8), not `Vec<u8>`, so a
`Uint8Array`/`Buffer` in produces a `Uint8Array` out and RPC keeps its raw byte channel. It is the
only byte-moving export. `read_binary_preview` and `read_media_preview` do **not** move bytes: their
wire contract is `dataBase64: string` (`packages/shared/src/protocol.ts:49-60`), so they encode
base64 in Rust with `base64::engine::general_purpose::STANDARD` and return a string, byte-identical
to `Buffer.toString("base64")`.

### 3.7 The gitignore matcher is not hand-written

`workspaceFileIgnore.ts:16-20` states the rule: *"Rule parsing is delegated to the `ignore` npm
package (the gitignore spec 2.22 reference implementation, the same one ESLint uses) … Hand-writing
gitignore parsing in this repo is forbidden."* The port keeps that rule and moves it to the Rust
crate of the same spec and the same author: `ignore = "0.4"` (`ignore::gitignore::Gitignore`), whose
`matched_path_or_any_parents` / `matched` cover later-declaration override, `!` negation with git's
parent-exclusion constraint, anchoring, `**`, the `/` directory suffix, character classes and
escapes. The `mime_guess` workspace dependency added for this port is **deliberately unused**:
`inferMediaTypeFromPath` (`:79-85`) is a closed three-step table (image table → `getMediaPreviewFormat`
audio/video table → `application/octet-stream`) and `mime_guess` is a strict superset that would
return e.g. `audio/ogg` for `.opus` and `text/plain` for `.ts`. Using it would be a silent behavior
fork under invariant 3.

### 3.8 Native API

All path-taking requests carry `roots`. `roots` is validated at the top of every `compute()`.

| Export | Async | Request | Result |
| --- | --- | --- | --- |
| `readdir` | yes | `{ path, roots, includeHidden? }` | `FileEntry[]` |
| `stat` | yes | `{ path, roots }` | `FileStat` |
| `check_files_exist` | yes | `{ paths, roots }` | `PathExistence[]` |
| `resolve_path` | yes | `{ path, roots }` | `string` |
| `read_text_file` | yes | `{ path, roots, offset?, length? }` | `TextSlice` |
| `read_file_range` | yes | `{ path, roots, offset, length }` | `Buffer` |
| `read_media_preview` | yes | `{ path, roots, maxBytes? }` | `MediaPreview` |
| `read_binary_preview` | yes | `{ path, roots, maxBytes? }` | `BinaryPreview` |
| `ensure_workspace_directory` | yes | `{ baseDir, roots, name? }` | `{ path, created }` |
| `load_workspace_ignore_rules` | yes | `{ rootPath, roots }` | `{ content, source, created, fingerprint, degradedReason? }` |
| `walk_workspace` | yes | `{ rootPath, roots, ignoreRules }` | `WorkspaceEntry[]` |
| `read_workspace_ignore` | yes | `{ rootPath, roots }` | `{ content, source }` |
| `transform_workspace_ignore` | yes | `{ rootPath, roots, transform }` | `{ content }` |
| `write_workspace_ignore` | yes | `{ rootPath, roots, content }` | `void` |
| `match_workspace_ignore_path` | no | `{ rules, relativePath, isDirectory }` | `bool` |
| `evaluate_workspace_file_entry` | no | `{ name, relativePath, type, ignoreRulesActive }` | `{ include, traverse }` |
| `build_workspace_ignore_template` | no | `{ gitignore }` | `string` |

`load_workspace_ignore_rules` returns the rules **content** rather than a matcher handle: the
matching happens inside `walk_workspace`, so there is no per-entry FFI call. The `source` tag
(`file` | `created-from-gitignore` | `created-from-template` | `fallback-gitignore` |
`fallback-builtin`) and the one-shot `degradedReason` string are returned so `fileService.ts` can
keep the existing `createServiceLogger("workspace-file-ignore")` warn/info lines verbatim. The
`.zcodeignore` `mtimeMs:size` fingerprint rides along in the same response, which removes the second
`stat` the TS cache signature needed.

---

## 4. Failure semantics

Every row is covered by a `cargo test -p zcode-fs` case.

| # | Condition | Behavior |
| --- | --- | --- |
| F1 | `roots` omitted at the binding | napi argument error. The request type has no optional form for it. |
| F2 | `roots: []` | Every path rejected: `Path is not inside an allowed root: <path>` (`Status::GenericFailure`). |
| F3 | Requested path escapes a root via a **symlink** (`<root>/link` → `/etc`) | Rejected. The symlink is resolved *before* the prefix test, so `/etc` is compared against the roots and misses. |
| F4 | Requested path escapes a root via **`..`** (`<root>/../etc/passwd`) | Rejected. `canonicalize` folds `..` before the prefix test. |
| F5 | Sibling-prefix confusion (`root=/ws`, path=`/ws-evil/x`) | Rejected. The test is `==` or `starts_with(root + sep)`, never a bare `starts_with(root)`. |
| F6 | Requested path does not exist | `ENOENT: no such file or directory, <syscall> '<path>'` — Node's `Error` message shape, so renderer error text is unchanged. `syscall` is the real predecessor syscall name (`realpath`, `stat`, `open`, `readdir`, `access`, `mkdir`). |
| F7 | Requested path is not readable (EACCES/EPERM/ENOTDIR/EISDIR where a file is required) | The OS error, same shape as F6. |
| F8 | A root cannot be canonicalized (deleted, or permission-denied) | That root is **skipped**, not an error. It cannot contain anything, so skipping is fail-closed. If every root is skipped, F2 applies. |
| F9 | `check_files_exist` with more than 15 paths | `File existence check supports at most 15 paths.` The cap moves into the native call so it cannot be bypassed by a caller that batches differently. |
| F10 | `check_files_exist`, path inside the roots but the stat fails | `{ path, exists: false }`. Any stat failure is `exists: false`, exactly as the predecessor's `.catch(() => false)`. |
| F11 | `check_files_exist`, path **outside** the roots | The whole call fails with the F2 message. An out-of-root probe is not silently reported as "does not exist" — that would hide the attempt. |
| F12 | `read_text_file` / `read_file_range` / `read_media_preview` / `read_binary_preview` on a non-file | `Path is not a file: <path>`. |
| F13 | `read_media_preview` / `read_binary_preview` with `size > maxBytes` | `File is too large to preview: <path>`. `size == maxBytes` succeeds. |
| F14 | `read_binary_preview` `maxBytes` absent | 25 MB — both the default and the ceiling. The 25 MB cap is a DoS control and is preserved exactly. |
| F15 | `read_media_preview` `maxBytes` absent | 4 MB default, 8 MB ceiling. |
| F16 | `read_text_file` `offset >= size` | Empty slice: `content: ""`, `bytesRead: 0`, `truncated: false`, `isBinary: false` — including `isBinary: false` on a binary file, which is what the predecessor's early return does. |
| F17 | `read_text_file` / `read_file_range` `offset` negative or non-finite | `max(0, trunc(offset))`; non-finite is the default (0 / the clamp default). |
| F18 | `read_text_file` `length` below 1, above 256 KB, non-finite, absent | Clamped to `[1, 256 KB]`; non-finite and absent are the 128 KB default. `read_file_range` clamps to `[1, 1 MB]`, default 256 KB. |
| F19 | `walk_workspace` hits an unreadable directory (`EACCES`/`EPERM`/`ENOENT`) | Skipped, scan continues. Any other error propagates. |
| F20 | `walk_workspace` hits a symlink | Classified by `stat`-ing the target (directory → `"directory"`); never traversed (`fileService.ts:332`); a broken symlink is `"file"`. |
| F21 | `.zcodeignore` missing | Created atomically from `.gitignore` (or the default template); `created: true`, `source: created-from-gitignore` / `created-from-template`. |
| F22 | `.zcodeignore` unreadable, or the atomic create fails | Fail open: fall back to the `.gitignore` content in memory (`fallback-gitignore`), else the built-in template (`fallback-builtin`), and return `degradedReason` so the host logs the same warn line. |
| F23 | `ensure_workspace_directory` with an empty, `/`-containing, or `\`-containing `name` | `Workspace name is required.` / `Workspace name cannot contain path separators.` |
| F24 | `ensure_workspace_directory` where the target exists but is not a directory | `Workspace path is not a directory: <path>` |
| F25 | `ensure_workspace_directory` where `mkdir` fails but the path is an existing directory | Succeeds, `created: false` (the predecessor's EEXIST-tolerant branch, `fileService.ts:443-454`). |
| F26 | `transform_workspace_ignore` with an unknown `transform` | `Unknown workspace ignore transform: <value>` |

Containment is checked **before** any `open`/`stat` of the requested path, and the check uses the
canonical form, so F3/F4/F5 hold regardless of what the filesystem would have done.

---

## 5. Differential plan

`tmp/zcode-fs-differential.mts` (throwaway; deleted after the run) built one deterministic fixture
tree — text/empty/binary/invalid-UTF-8 files, ten media extensions, `.env*`, `node_modules/`, `.git/`,
`cmake-build-*`, `bazel-*`, `*.egg-info/`, `*.dist-info/`, `coverage.out`, `lcov.info`, a `.so`, a
`.tsbuildinfo`, a `.war`, a `build/` tree, `.github/workflows/`, a three-level `sub/deep/leaf.txt`, a
`.gitignore` with `build/`, `*.log`, `!keep.log`, a directory symlink, a dangling symlink, an
out-of-tree symlink, a sibling `ws-evil/` prefix, and size fixtures at 4 MB, 8 MB, 8 MB+1, 25 MB and
25 MB+1 — and drove the **predecessor** `createFileService` and the **ported** one over it.

### Recorded result (2026-10-01)

| Metric | Count |
| --- | --- |
| Named input cases | **93** |
| Byte-identical outputs (predecessor vs port) | **82** |
| Containment rejections proved (predecessor served them; port refuses) | **11** |
| Divergences | **0** |

The 82 byte-identical cases cover `stat` (5), `readdir` (6), `checkFilesExist` (3), `resolvePath` (4),
`readTextFile` (21), `readFileRange` (9), `readMediaPreview` (16), `readBinaryPreview` (6), and the
workspace index (11: packed length, two packed ranges, four `searchWorkspaceFiles` queries, and the
three settings-page read/transform/write round trips). Errors are compared by **message**, which is
byte-identical; the `code` label is compared only where the predecessor carried one.

The 11 containment cases are `symlink-escape`, `dotdot-escape`, `sibling-prefix`,
`absolute-outside`, `resolvePath-outside`, `readdir-outside`, `stat-outside`,
`binaryPreview-outside`, `mediaPreview-outside`, `fileRange-outside` and `exists-outside`. Every one
of them returned real content under the predecessor (captured before the TypeScript was deleted —
e.g. `dotdot-escape` returned `TOP SECRET` from `<fixture>/outside/secret.txt`); every one now fails
with `Path is not inside an allowed root: <path>`.

### Comparison rules

- **Containment rows are asserted, not compared.** The predecessor has no containment, so there is
  nothing byte-comparable; the assertion is the security property itself.
- `mtimeMs` is normalized out: the fixture is rebuilt between the two captures, so the two runs
  legitimately hold different mtimes. Everything else about the `stat` payload must match exactly.
- The workspace index is compared as the **sorted packed string** plus the candidate list from
  `searchWorkspaceFiles`, i.e. the product-visible output of the scan, not an internal shape.

### Defects the differential caught (all fixed before merge)

1. `checkFileExists` kept the predecessor's `.catch(() => false)`, which turned a containment
   rejection into `exists: false` — "you may not look there" silently became "it is not there".
   The native call now answers absence with `exists: false` and throws only for a rejection, so the
   catch is gone.
2. `checkFilesExist` used `canonicalize`, so an in-root but *absent* path failed the whole batch with
   `ENOENT` instead of answering `false`. Fixed by `Roots::admit`, which confines a non-existent path
   against its deepest existing ancestor.
3. `ensureWorkspaceDirectory` reported `created: true` on every successful call. The predecessor's
   `(await mkdir(recursive)) !== undefined` is true only when this call created the directory; fixed.
4. A blank workspace name fell through to "the base directory" instead of raising
   `Workspace name is required.`

---

## 6. Risks

- **R1 — the allowlist is containment, not authorization.** Until a host assembly calls
  `FileServiceScope.allow(workspacePath)` at workspace-open time, a caller can admit a root by
  calling a `rootPath`-carrying method with it. That is *not* a regression (the predecessor allowed
  any path outright) and the escape classes F3/F4/F5 are closed either way, but the port does not by
  itself decide which roots a session may open. Exact follow-up: in
  `packages/desktop/src/host/index.ts` (and `main/index.ts` / `entry-http.ts` / `core.ts` for the
  other three hosts), call `allow(workspacePath)` from the same place the host already receives
  `msg.workspacePath`. Out of this port's ownership boundary; reported as REQUIRED-CHANGE.
- **R2 — a behavior change is intended and visible.** `DirectoryBrowser`
  (`packages/ui/src/DirectoryBrowser.tsx:95`) browses arbitrary directories through `readdir`. With
  no host hook, navigating above the admitted root now fails. This is the containment working; R1 is
  the fix.
- **R3 — `checkFilesExist`'s TTL cache is consulted before the native call**, so a cached verdict
  skips the native check for up to 60 s. Sound because the root set is append-only (§3.2.3) and a
  verdict is only ever produced by a contained call. Documented so a future change to the cache does
  not silently reintroduce the hole.
- **R4 — the `localeCompare` sort stays in TS** (§2.2). The walk moves to Rust but the sort of
  370,000 entries does not, so the port's win is the traversal + matching, not the sort. Accepted for
  invariant 3.
- **R5 — differential cases must cover the caps, not just the happy path.** The 8 MB / 25 MB /
  256 KB / 1 MB clamps and the `offset >= size` early return are the boundaries where a port
  silently drifts. They are in the corpus (§5) *and* in `cargo test`; the corpus is what caught
  defects 1-4 in §5's defect list, none of which a unit test would have found.
- **R6 — `created` on `ensureConversationWorkspace`** is `(await mkdir(path, {recursive:true})) !== undefined`,
  i.e. `true` for both a fresh create and an already-existing directory, because libuv's recursive
  mkdir returns `undefined` on success. The ported `created` preserves that (true whenever `mkdir`
  succeeded without throwing); the catch branch that sets `created = false` is the real signal. Changing
  it would be a fork.
- **R7 — UTF-8 decoding.** `chunk.toString("utf-8")` and `String::from_utf8_lossy` both emit U+FFFD
  for malformed sequences using the Unicode *maximal subpart* rule, so a binary chunk classified as
  text decodes identically. Recorded in the differential with a deliberately invalid-UTF-8 fixture.
- **R8 — `ignore` crate version.** `ignore = "0.4.33"` is declared inline in the crate manifest
  because it is not yet in `[workspace.dependencies]`. See REQUIRED-CHANGE.
- **R9 — `mime_guess` is deliberately unused.** The workspace declares it for this port and this
  crate does not take it: §3.7 explains why the closed table must be reproduced instead. It is
  listed in `[workspace.dependencies]` with no consumer, which `cargo` accepts but `native:inventory`
  will not, so it should be removed from the root manifest in the same REQUIRED-CHANGE.
- **R10 — `Error.code` for service-level rejections.** napi always attaches a `code` to a thrown
  `Error`; a plain `new Error()` in the predecessor attached none, so a size-cap or not-a-file
  rejection surfaces as `code: "GenericFailure"` here and `code: undefined` there. The **message**
  is byte-identical and that is what every caller renders. Errno rows (`ENOENT`, `EACCES`, …) *do*
  carry the original code, via the retained-error hand-off in `lib.rs`'s `js_error`.

---

## 7. Acceptance checklist

- [x] Spec exists and precedes the crate.
- [x] `CARGO_TARGET_DIR=/tmp/zcode-fs-target cargo build --release -p zcode-fs` succeeds and emits
      `zcode-fs.linux-x64-gnu.node`.
- [x] `cargo test -p zcode-fs` passes, one test per row of §4.
- [x] Direct-load smoke: `node -e` loads the `.node` and exercises `read_text_file`,
      `read_file_range` and the F3/F4 rejections.
- [x] Differential of **93 named inputs**, 82 byte-identical + 11 containment rejections, zero
      divergences (§5).
- [x] `fileService.ts` contains no ported implementation and no `node:fs` import.
- [x] `workspaceFileIgnore.ts` and `workspaceFileMentionFilter.ts` deleted; the now-dead
      `workspaceFileSearchFilter` injection point and its four `node.ts` re-exports deleted with them.
- [x] `packages/rust/src/fs.ts` contains the literal `loadNative("zcode-fs")` and
      `packages/services/src/file/fileService.ts` imports `@zcode/rust/fs`, so
      `pnpm --filter @zcode/rust native:inventory` sees a live consumer.
- [x] Zero `catch` → legacy shape, zero env flag, zero `node:child_process`.
