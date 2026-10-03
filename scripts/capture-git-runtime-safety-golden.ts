/**
 * PHASE 3 oracle: the git runtime-context safety check.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * `isGitRuntimeContextUnsafe` answers "is the directory we are about to run git in safe?" by
 * inspecting `.git`: a symlinked `.git`, a `gitdir:` file pointing outside the workspace, a
 * `.git` without `objects/`+`refs/`, a bare repo. Getting this wrong means git runs where the
 * policy did not expect — so it is ported with real fixture directories rather than mocks.
 *
 * Run: pnpm exec tsx scripts/capture-git-runtime-safety-golden.ts
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analysisContainsGitAndDirectoryChange,
  analysisContainsGitCommand,
  isGitRuntimeContextUnsafe,
} from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-git-runtime-safety.ts";

const root = mkdtempSync(join(tmpdir(), "git-runtime-safety-"));
const results: Record<string, unknown> = {};

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A normal work tree: `.git/` with HEAD, objects/, refs/ and no commondir. */
function workTree(name: string): string {
  const workspace = dir(name);
  const git = join(workspace, ".git");
  mkdirSync(join(git, "objects"), { recursive: true });
  mkdirSync(join(git, "refs"), { recursive: true });
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  return workspace;
}

function record(name: string, cwd: string | undefined): void {
  results[name] = {
    cwd: cwd ?? null,
    unsafe: isGitRuntimeContextUnsafe(cwd === undefined ? undefined : { workingDirectory: cwd }),
  };
}

try {
  // 1. A normal work tree is safe.
  const trusted = workTree("trusted");
  record("normal_work_tree", trusted);

  // 2. A nested directory inside it inherits trust.
  const nested = join(trusted, "src", "deep");
  mkdirSync(nested, { recursive: true });
  record("nested_in_work_tree", nested);

  // 3. No .git anywhere up the tree — not unsafe, just not a repo.
  const plain = dir("plain");
  record("no_git_at_all", plain);

  // 4. A `.git` file pointing OUTSIDE the workspace is unsafe.
  const outside = dir("outside-repo");
  const gitDir = join(outside, ".git");
  mkdirSync(join(gitDir, "objects"), { recursive: true });
  mkdirSync(join(gitDir, "refs"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  const escaped = dir("escaped");
  writeFileSync(join(escaped, ".git"), `gitdir: ${outside}\n`);
  record("gitdir_points_outside", escaped);

  // 5. A `.git` SYMLINK is unsafe.
  const symlinked = dir("symlinked");
  symlinkSync(outside, join(symlinked, ".git"));
  record("symlinked_git_dir", symlinked);

  // 6. A bare repository layout (HEAD + objects + refs, no .git) is unsafe.
  const bare = dir("bare");
  writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(bare, "objects"), { recursive: true });
  mkdirSync(join(bare, "refs"), { recursive: true });
  record("bare_repo_layout", bare);

  // 7. A `.git` dir missing objects/ and refs/ is not trusted, but not immediately unsafe.
  const incomplete = dir("incomplete");
  mkdirSync(join(incomplete, ".git"), { recursive: true });
  writeFileSync(join(incomplete, ".git", "HEAD"), "ref: refs/heads/main\n");
  record("incomplete_git_dir", incomplete);

  // 8. No context at all.
  record("no_working_directory", undefined);

  // 9. A path that does not exist is unsafe (it cannot be canonicalised).
  record("missing_directory", join(root, "does-not-exist"));

  // --- the pure predicates ---
  const part = (name: string, argv: string[]) => ({ name, argv });
  results.predicates = {
    git_present: analysisContainsGitCommand([part("git", ["git", "status"])]),
    git_wrapped: analysisContainsGitCommand([part("command", ["command", "git", "status"])]),
    no_git: analysisContainsGitCommand([part("ls", ["ls"])]),
    git_and_cd: analysisContainsGitAndDirectoryChange([
      part("git", ["git", "status"]),
      part("cd", ["cd", "/tmp"]),
    ]),
    git_and_pushd: analysisContainsGitAndDirectoryChange([
      part("git", ["git", "status"]),
      part("pushd", ["pushd", "/tmp"]),
    ]),
    git_and_popd: analysisContainsGitAndDirectoryChange([
      part("git", ["git", "status"]),
      part("popd", ["popd"]),
    ]),
    cd_without_git: analysisContainsGitAndDirectoryChange([part("cd", ["cd", "/tmp"])]),
    git_without_directory_change: analysisContainsGitAndDirectoryChange([
      part("git", ["git", "status"]),
    ]),
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}

const out = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/git-runtime-safety-golden.json`, JSON.stringify(results, null, 2) + "\n");
for (const [name, value] of Object.entries(results)) {
  console.log(`  ${name.padEnd(30)} ${JSON.stringify(value)}`);
}
