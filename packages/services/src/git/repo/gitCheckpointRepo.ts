import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  GitCheckpointConflict,
  GitCheckpointDiff,
  GitCheckpointMeta,
  GitCheckpointRestoreResult,
} from "@zcode/shared";
import { getGitCheckpointIndexRootDir } from "../../paths.js";
import { toWorkspaceRelativeGitPath } from "../config.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import { createGitCliRepo, type GitCliRepo } from "./gitCliRepo.js";
import {
  buildAffectedRepoPaths,
  buildCheckpointEnv,
  getCheckpointRefName,
  getWorkspacePathspec,
  mergeCheckpointDiff,
  normalizeAffectedRepoPath,
  parseLsTree,
  parseNameStatus,
  parseNumstat,
  removeFileIfExists,
  toAbsolutePath,
} from "./gitCheckpointHelpers.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";

interface GitCheckpointRepo {
  createCheckpoint(params: {
    workspacePath: string;
    checkpointId: string;
  }): Promise<GitCheckpointMeta>;
  diffCheckpoints(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
  }): Promise<GitCheckpointDiff>;
  restoreBetweenCheckpoints(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
    force?: boolean;
  }): Promise<GitCheckpointRestoreResult>;
  deleteCheckpoint(params: { workspacePath: string; checkpoint: GitCheckpointMeta }): Promise<void>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function createGitCheckpointRepo(options?: {
  commandProvider?: GitCommandProvider;
  gitRepo?: Pick<GitCliRepo, "resolveRepository">;
}): GitCheckpointRepo {
  const commandProvider = options?.commandProvider ?? createGitCommandProvider();
  const gitRepo = options?.gitRepo ?? createGitCliRepo({ commandProvider });

  async function ensureRepository(
    workspacePath: string,
  ): Promise<Awaited<ReturnType<typeof gitRepo.resolveRepository>>> {
    // All checkpoint operations must be based on the premise that "the current workspace corresponds to a real Git repository".
    // Warehouse parsing and capability pre-verification are unified here to avoid errors and semantic inconsistencies after each method makes its own judgment.
    const resolution = await gitRepo.resolveRepository(workspacePath);
    if (!resolution.isGitAvailable) {
      throw new Error("Git binary is not available in the current environment.");
    }
    if (!resolution.isRepository) {
      throw new Error("Workspace is not inside a Git repository.");
    }
    return resolution;
  }

  async function computeCheckpointDiff(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
  }): Promise<GitCheckpointDiff> {
    // The diff between checkpoints is only calculated for the current workspace scope, not the entire warehouse.
    // In this way, when the monorepo subdirectory is opened, subsequent restore/summary/conflict detection will naturally converge within the boundaries of the current workspace.
    const resolution = await ensureRepository(params.workspacePath);
    const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);
    const [nameStatusResult, numstatResult] = await Promise.all([
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--name-status",
          "--find-renames",
          "-z",
          params.from.commitOid,
          params.to.commitOid,
          "--",
          pathspec,
        ],
      }),
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--numstat",
          "--find-renames",
          "-z",
          params.from.commitOid,
          params.to.commitOid,
          "--",
          pathspec,
        ],
      }),
    ]);
    ensureGitCommandSucceeded("git diff --name-status checkpoint", nameStatusResult);
    ensureGitCommandSucceeded("git diff --numstat checkpoint", numstatResult);

    // name-status determines "which files have been changed and what type of changes", and numstat provides added/removed statistics.
    // Putting the two together, what you get is a structured checkpoint diff for the upper layer, rather than the original Git text output.
    return mergeCheckpointDiff({
      repoRoot: resolution.repoRoot,
      workspaceInRepoPath: resolution.workspaceInRepoPath,
      fromCheckpointId: params.from.checkpointId,
      toCheckpointId: params.to.checkpointId,
      nameStatusEntries: parseNameStatus(nameStatusResult.stdout),
      numstat: parseNumstat(numstatResult.stdout),
    });
  }

  async function collectWorkspaceConflicts(params: {
    repoRoot: string;
    workspaceInRepoPath: string;
    from: GitCheckpointMeta;
    affectedRepoPaths: string[];
  }): Promise<GitCheckpointConflict[]> {
    if (params.affectedRepoPaths.length === 0) {
      return [];
    }

    // Conflict detection does not determine "whether the entire workspace is dirty", but determines the paths that restore will reach.
    // Whether the current disk state is still equal to the fromCheckpoint declared by the caller.
    // Only in this way can the underlying capabilities still work safely when there are irrelevant changes, and the entire warehouse will not be judged as unrecoverable across the board.
    const treeResult = await commandProvider.run({
      cwd: params.repoRoot,
      args: ["ls-tree", "-r", "-z", params.from.commitOid, "--", ...params.affectedRepoPaths],
    });
    ensureGitCommandSucceeded("git ls-tree checkpoint paths", treeResult);
    const treeEntries = parseLsTree(treeResult.stdout);

    const conflicts: GitCheckpointConflict[] = [];
    for (const repoRelativePath of params.affectedRepoPaths) {
      const absolutePath = toAbsolutePath(params.repoRoot, repoRelativePath);
      const expectedEntry = treeEntries.get(repoRelativePath);

      if (!expectedEntry) {
        // The path does not exist in fromCheckpoint, which means that according to baseline semantics it should not appear on the disk.
        // If it exists now, it means that the user or other processes added the file after checkpoint, which is an overwriting risk.
        if (!(await pathExists(absolutePath))) {
          continue;
        }
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "unexpected-file-in-worktree",
        });
        continue;
      }

      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(absolutePath);
      } catch {
        // fromCheckpoint requires that the file exists, but it is no longer on the disk. If you write it back directly during recovery,
        // It will overwrite the real user operation of "why the file disappeared", so the conflict must be reported explicitly first.
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "missing-in-worktree",
        });
        continue;
      }

      const expectsSymlink = expectedEntry.mode === "120000";
      if (stats.isDirectory() || (expectsSymlink && !stats.isSymbolicLink())) {
        // The current implementation only handles file status that Git can stably express; if checkpoint expects a file/symbolic link,
        // Now that the disk has become a directory or other type, direct restore is prone to semantic misalignment, so it is handled according to type conflicts.
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "type-mismatch",
        });
        continue;
      }

      const hashResult = await commandProvider.run({
        cwd: params.repoRoot,
        args: ["hash-object", "--no-filters", absolutePath],
      });
      ensureGitCommandSucceeded("git hash-object checkpoint verify", hashResult);
      if (hashResult.stdout.trim() === expectedEntry.objectId) {
        continue;
      }

      // We do not compare weak signals such as timestamps and sizes here, but directly compare blob hashes.
      // Only if the contents are completely consistent will it be considered that "the current disk still stays at the fromCheckpoint baseline".
      conflicts.push({
        path: absolutePath,
        repoRelativePath,
        workspaceRelativePath: toWorkspaceRelativeGitPath(
          repoRelativePath,
          params.workspaceInRepoPath,
        ),
        reason: "content-mismatch",
      });
    }

    const deduped = new Map<string, GitCheckpointConflict>();
    for (const conflict of conflicts) {
      deduped.set(conflict.repoRelativePath, conflict);
    }
    return [...deduped.values()];
  }

  return {
    /**
     * Create an immutable snapshot of the workspace file.
     *
     * Overall process:
     * 1. Parse the Git warehouse and scope corresponding to the workspace
     * 2. Use temporary GIT_INDEX_FILE to collect the current live worktree status
     * 3. Generate internal hidden commits through write-tree/commit-tree
     * 4. Use hidden ref to hang this commit to prevent it from being cleared early by Git GC.
     * 5. Return the meta information required by the manifest
     *
     * Key constraints:
     * - Does not pollute the user’s real index
     * - No user-visible branches or normal commits are generated
     * - scope always follows the current workspace, rather than an indistinguishable snapshot of the entire repo
     */
    async createCheckpoint(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const refName = getCheckpointRefName(params.workspacePath, params.checkpointId);
      const tempIndexRootDir = getGitCheckpointIndexRootDir();
      await mkdir(tempIndexRootDir, { recursive: true });
      const tempIndexDir = await mkdtemp(resolve(tempIndexRootDir, "index-"));
      const tempIndexPath = resolve(tempIndexDir, "index");
      const env = buildCheckpointEnv(tempIndexPath);
      const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);

      try {
        // Warm up the temporary index: copy the user's real index first, downgrade to read-tree HEAD, or return to an empty index at worst.
        // Background: git add -A under an empty index will open/read/hash all files in the workspace and write them to the object store.
        // In a Windows + Defender environment, the overhead of a single file is magnified to 5-15ms, and large warehouses can easily exceed the 15s timeout.
        // After reusing the stat cache of the user index, unmodified files take the stat-match fast path and directly skip reading and writing objects.
        // Mac/Linux also benefits (large warehouse add is reduced from seconds to sub-seconds), and the final tree is determined by the worktree, and the semantics are completely equivalent.
        // Use rev-parse --git-path index to parse the real index path, compatible with worktree / submodule scenarios.
        const indexPathResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["rev-parse", "--git-path", "index"],
        });
        let primed = false;
        if (indexPathResult.exitCode === 0) {
          const indexRelPath = indexPathResult.stdout.trim();
          if (indexRelPath.length > 0) {
            const userIndexPath = resolve(resolution.repoRoot, indexRelPath);
            try {
              await copyFile(userIndexPath, tempIndexPath);
              primed = true;
            } catch {
              // The user index does not exist (the short position just inited) or does not have permission, so it will be downgraded.
            }
          }
        }
        if (!primed) {
          // When there is no copyable index, use the HEAD tree to fill the temporary index, at least let the tracked files follow the hash-match path.
          // read-tree will fail when HEAD does not exist (new warehouse), allowing silent fallback to an empty index.
          const readTreeResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["read-tree", "HEAD"],
            env,
          });
          if (readTreeResult.exitCode === 0) {
            primed = true;
          }
        }

        // Core implementation: Use temporary GIT_INDEX_FILE to solidify the live state of the current workspace into a hidden commit.
        // In this way, Git's object storage capabilities can be reused without polluting the user's real index / staged state.
        const addResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["add", "-A", "--", pathspec],
          env,
        });
        ensureGitCommandSucceeded("git add checkpoint", addResult);

        // The temporary index has collected the complete status of the current workspace scope, and the next step is to freeze it into a tree object.
        const treeResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["write-tree"],
          env,
        });
        ensureGitCommandSucceeded("git write-tree checkpoint", treeResult);

        // The checkpoint does not need to go into the user's branch history, but the Git object must have a stable anchor.
        // Therefore, an internal commit is created here, and subsequent hidden refs point to it.
        const commitResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "commit-tree",
            treeResult.stdout.trim(),
            "-m",
            `zcode checkpoint ${params.checkpointId}`,
          ],
          env,
        });
        ensureGitCommandSucceeded("git commit-tree checkpoint", commitResult);
        const commitOid = commitResult.stdout.trim();

        // The hidden ref is the checkpoint's "long-term reference", which guarantees:
        // 1. Git will not directly recycle this object as garbage.
        // 2. In subsequent diff/restore/delete operations, you can stably retrieve the corresponding commit by pressing refName.
        const updateRefResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["update-ref", refName, commitOid],
        });
        ensureGitCommandSucceeded("git update-ref checkpoint", updateRefResult);

        return {
          checkpointId: params.checkpointId,
          workspacePath: params.workspacePath,
          repoRoot: resolution.repoRoot,
          workspaceInRepoPath: resolution.workspaceInRepoPath,
          createdAt: Date.now(),
          refName,
          commitOid,
          scope: "workspace",
        };
      } finally {
        // The temporary index only serves this checkpoint build and must be cleared after completion to avoid leakage to the host environment.
        await rm(tempIndexDir, { recursive: true, force: true });
      }
    },

    /**
     * Compare the file differences between two checkpoints under the current workspace scope.
     *
     * This method itself is not aware of ZCode Agent/task/turn and only answers a pure file question:
     * "What files in this workspace have changed from fromCheckpoint to toCheckpoint?"
     *
     * The return value will be reused by restore, subsequent summary capabilities, and even potential debugging tools, so it remains purely read and has no side effects.
     */
    async diffCheckpoints(params) {
      return await computeCheckpointDiff(params);
    },

    /**
     * Safely restore the current live workspace from fromCheckpoint to toCheckpoint.
     *
     * This is the core method of the entire base. Its semantics is not "directly restore to a certain checkpoint".
     * But a "three-way comparison":
     * - Caller statement: The current disk should still stay at fromCheckpoint
     * - Actual goal: I hope to restore the file status to toCheckpoint
     * - Current reality: The disk may have been modified by the user or other processes
     *
     * So the order of execution is:
     * 1. First calculate the affected path from -> to
     * 2. Check again whether these paths are still equal to fromCheckpoint
     * 3. If there is a conflict, it will be returned without overwriting it directly.
     * 4. When there is no conflict or force=true, write the content of toCheckpoint back to the worktree
     * 5. Finally, verify again to ensure that the real disk after recovery is equal to toCheckpoint
     */
    async restoreBetweenCheckpoints(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const diff = await computeCheckpointDiff({
        workspacePath: params.workspacePath,
        from: params.from,
        to: params.to,
      });
      // The diff may contain both the current path and the old path before rename.
      // This is uniformly collapsed into the final affected path set, and subsequent conflict detection and deletion logic all work according to this set.
      const affectedRepoPaths = buildAffectedRepoPaths(diff.files).map((path) =>
        normalizeAffectedRepoPath(resolution.repoRoot, path),
      );

      if (affectedRepoPaths.length === 0) {
        return {
          success: true,
          restoredPaths: [],
        };
      }

      const conflicts = await collectWorkspaceConflicts({
        repoRoot: resolution.repoRoot,
        workspaceInRepoPath: resolution.workspaceInRepoPath,
        from: params.from,
        affectedRepoPaths,
      });
      if (conflicts.length > 0 && params.force !== true) {
        // In default mode, writes are rejected once the relevant path is found to have deviated from fromCheckpoint.
        // In this way, the upper layer can throw conflict information to users instead of the lower layer secretly overwriting their new modifications.
        return {
          success: false,
          conflicts,
        };
      }

      const restoreRepoPaths = diff.files
        .filter((file) => file.kind !== "deleted")
        .map((file) => file.repoRelativePath);
      if (restoreRepoPaths.length > 0) {
        // In the restore phase, only the worktree is changed, and the real index is not changed. In this way, the rollback capability is "file status recovery".
        // Rather than the destructive operation of secretly changing the user's temporary storage area.
        const restoreResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "restore",
            `--source=${params.to.commitOid}`,
            "--worktree",
            "--",
            ...restoreRepoPaths,
          ],
        });
        ensureGitCommandSucceeded("git restore checkpoint", restoreResult);
      }

      const deleteAbsolutePaths = new Set<string>();
      for (const file of diff.files) {
        if (file.kind === "deleted") {
          // toCheckpoint no longer contains these paths. After the restore, the remaining entities in the live worktree need to be deleted.
          deleteAbsolutePaths.add(file.path);
          continue;
        }
        if (file.kind === "renamed" && file.originalPath) {
          // In the rename scenario, git restore will only restore the contents of the new path;
          // The old path must be deleted explicitly by us to avoid "coexistence of old and new files".
          deleteAbsolutePaths.add(file.originalPath);
        }
      }
      for (const path of deleteAbsolutePaths) {
        await removeFileIfExists(path);
      }

      const verifyConflicts = await collectWorkspaceConflicts({
        repoRoot: resolution.repoRoot,
        workspaceInRepoPath: resolution.workspaceInRepoPath,
        from: params.to,
        affectedRepoPaths,
      });
      if (verifyConflicts.length > 0) {
        // In theory, there should be no deviation here; if there is, it means that the restore process did not really bring the disk to the target state.
        // Continuing to return success will only solidify the error status, so throwing an error directly allows the caller to perceive the exception.
        throw new Error("Checkpoint restore verification failed.");
      }

      return {
        success: true,
        restoredPaths: diff.files.map((file) => file.path),
      };
    },

    /**
     * Delete a checkpoint's Git reference.
     *
     * This is only responsible for deleting hidden ref; the deletion of manifest is completed by the upper store/service.
     * In this way, the repo layer focuses on Git object reference management, and the store layer focuses on local metadata file management, making the responsibilities clearer.
     */
    async deleteCheckpoint(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const deleteRefResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["update-ref", "-d", params.checkpoint.refName],
      });
      ensureGitCommandSucceeded("git update-ref -d checkpoint", deleteRefResult, [0, 1]);
    },
  };
}

export type { GitCheckpointRepo };
