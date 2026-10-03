/** Verification section: git-runtime-safety-live. See docs/specs/subagent-rust-port.md. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisGitPredicates, isGitRuntimeContextUnsafe } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
  // The one part of the permission path that touches the filesystem. Fixtures are real
  // directories because the checks are `lstat` on `.git`, a bounded read of `HEAD`, and an
  // executability probe on `objects/`/`refs/` — a mock would not exercise any of them.
  const root = mkdtempSync(join(tmpdir(), "gitrt-verify-"));
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const workTree = (name: string) => {
    const workspace = dir(name);
    const git = join(workspace, ".git");
    mkdirSync(join(git, "objects"), { recursive: true });
    mkdirSync(join(git, "refs"), { recursive: true });
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    return workspace;
  };

  try {
    const trusted = workTree("trusted");
    check("normal work tree is safe", isGitRuntimeContextUnsafe({ workingDirectory: trusted }) === false);
    const nested = join(trusted, "a", "b");
    mkdirSync(nested, { recursive: true });
    check("nested directory inherits trust", isGitRuntimeContextUnsafe({ workingDirectory: nested }) === false);
    check("no repository at all is safe", isGitRuntimeContextUnsafe({ workingDirectory: dir("plain") }) === false);

    const outside = dir("outside");
    const outsideGit = join(outside, ".git");
    mkdirSync(join(outsideGit, "objects"), { recursive: true });
    mkdirSync(join(outsideGit, "refs"), { recursive: true });
    writeFileSync(join(outsideGit, "HEAD"), "ref: refs/heads/main\n");

    const escaped = dir("escaped");
    writeFileSync(join(escaped, ".git"), `gitdir: ${outside}\n`);
    check("gitdir pointing outside the workspace stays unsafe", isGitRuntimeContextUnsafe({ workingDirectory: escaped }) === true);

    const symlinked = dir("symlinked");
    symlinkSync(outside, join(symlinked, ".git"));
    check("symlinked .git stays unsafe", isGitRuntimeContextUnsafe({ workingDirectory: symlinked }) === true);

    const bare = dir("bare");
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(bare, "objects"), { recursive: true });
    mkdirSync(join(bare, "refs"), { recursive: true });
    check("bare repository layout stays unsafe", isGitRuntimeContextUnsafe({ workingDirectory: bare }) === true);

    check("unresolvable path stays unsafe", isGitRuntimeContextUnsafe({ workingDirectory: join(root, "missing") }) === true);
    check("no context is safe", isGitRuntimeContextUnsafe(undefined) === false);

    check("git detected", analysisGitPredicates([{ argv: ["git", "status"] }]).hasGit === true);
    check("git behind 'command' is detected", analysisGitPredicates([{ argv: ["command", "git", "status"] }]).hasGit === true);
    check("no git", analysisGitPredicates([{ argv: ["ls"] }]).hasGit === false);
    check("git plus cd is a directory change", analysisGitPredicates([{ argv: ["git", "status"] }, { argv: ["cd", "/tmp"] }]).hasGitAndDirectoryChange === true);
    check("git alone is not", analysisGitPredicates([{ argv: ["git", "status"] }]).hasGitAndDirectoryChange === false);
    check("cd without git is not", analysisGitPredicates([{ argv: ["cd", "/tmp"] }]).hasGitAndDirectoryChange === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
