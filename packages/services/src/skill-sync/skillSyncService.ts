/* eslint-disable max-lines -- The skill sync service centrally maintains candidate scanning, remote deduplication and the import flow, avoiding an enlarged remote-sync regression surface when splitting it up. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  SkillSyncArchiveExportResult,
  SkillSyncCandidate,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
} from "@zcode/shared";
import type { ISkillSyncService } from "./skillSync.js";
import { createSkillSyncArchive, extractSkillSyncArchive } from "./skillSyncArchive.js";
import { normalizeSkillSyncRelativePath, resolveSkillSyncPathWithin } from "./skillSyncPath.js";
import { createSkillSyncSizeLimitError } from "./skillSyncErrors.js";
import {
  MAX_SKILL_SCAN_DEPTH,
  shouldWalkSkillDirectoryEntry,
  walkSkillMarkdownPaths,
} from "../skills/skillDiscoveryWalk.js";
import { checkRemoteSyncDirectoryWriteAccess } from "../remote-sync/remoteSyncWriteAccess.js";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

export function createSkillSyncService(options?: { maxArchiveBytes?: number }): ISkillSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  return {
    async listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult> {
      return {
        candidates: await collectUserSkillCandidates(),
        maxArchiveBytes,
      };
    },
    async listRemoteUserSkillStatuses(params): Promise<SkillSyncRemoteStatusResult> {
      const root = getUserZcodeSkillRoot();
      const existingSkillPathByName = await collectUserSkillDirectoryPathByName();
      // The skill sync service will be exposed to the renderer / remote client through RPC;
      // directoryName cannot be trusted only to UI candidates and must be restricted on the server to a safe relative path within the skills root.
      const directoryNames = params.directoryNames.map((directoryName) =>
        normalizeSkillSyncRelativePath(directoryName),
      );
      const requestedSkillNameByDirectory = new Map(
        (params.skills ?? []).map((skill) => [
          normalizeSkillSyncRelativePath(skill.directoryName),
          skill.name,
        ]),
      );
      return {
        statuses: directoryNames.map((directoryName) => {
          const path = resolveSkillSyncPathWithin(root, directoryName);
          if (existsSync(path)) {
            return { directoryName, exists: true, path };
          }
          const requestedName = requestedSkillNameByDirectory.get(directoryName);
          const existingPath = requestedName
            ? existingSkillPathByName.get(normalizeSkillNameKey(requestedName))
            : undefined;
          return existingPath
            ? { directoryName, exists: true, path: existingPath }
            : { directoryName, exists: false };
        }),
      };
    },
    async exportSkillsArchive(params): Promise<SkillSyncArchiveExportResult> {
      const candidates = await collectUserSkillCandidates();
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const selected = params.skillIds.map((id) => {
        const candidate = candidateById.get(id);
        if (!candidate) {
          throw new Error(`skill sync candidate not found: ${id}`);
        }
        return candidate;
      });
      const archiveEntries = await Promise.all(
        selected.map(async (candidate) => ({
          sourcePath: await realpath(dirname(candidate.path)),
          archivePath: candidate.directoryName,
        })),
      );
      const selectedBytes = selected.reduce((total, candidate) => total + candidate.sizeBytes, 0);
      if (selectedBytes > maxArchiveBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: selectedBytes,
          maxBytes: maxArchiveBytes,
          phase: "selected-content",
        });
      }
      const archive = await createSkillSyncArchive(archiveEntries);
      if (archive.byteLength > maxArchiveBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: archive.byteLength,
          maxBytes: maxArchiveBytes,
          phase: "archive",
        });
      }
      return {
        archive,
        archiveBytes: archive.byteLength,
        skills: selected.map(({ id, name, directoryName }) => ({
          id,
          name,
          directoryName,
        })),
      };
    },
    async checkRemoteUserSkillWriteAccess() {
      return checkRemoteSyncDirectoryWriteAccess(getUserZcodeSkillRoot());
    },
    async importSkillsArchive(params): Promise<SkillSyncImportResult> {
      if (params.overwrite) {
        throw new Error("skill sync overwrite is not supported");
      }
      if (params.archive.byteLength > maxArchiveBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: params.archive.byteLength,
          maxBytes: maxArchiveBytes,
          phase: "archive",
        });
      }
      return await importArchive(params.archive, maxArchiveBytes);
    },
  };
}

function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

async function collectUserSkillCandidates(): Promise<SkillSyncCandidate[]> {
  const seenSkillRealpaths = new Set<string>();
  const userZcodeSkillRoot = getUserZcodeSkillRoot();
  const rawZcodeCandidates = await collectUserSkillCandidatesInRoot(userZcodeSkillRoot);
  const zcodeDirectoryNames = await collectCoveredSkillDirectoryNamesInRoot(userZcodeSkillRoot);
  const zcodeSkillNameKeys = new Set(
    rawZcodeCandidates.map((candidate) => normalizeSkillNameKey(candidate.name)),
  );
  const zcodeCandidates = await dedupeCandidatesByCanonicalSkillPath(
    rawZcodeCandidates,
    seenSkillRealpaths,
  );
  const agentsCandidates = await dedupeCandidatesByCanonicalSkillPath(
    (await collectUserSkillCandidatesInRoot(getUserAgentsSkillRoot())).filter(
      (candidate) =>
        !zcodeDirectoryNames.has(candidate.directoryName) &&
        !zcodeSkillNameKeys.has(normalizeSkillNameKey(candidate.name)),
    ),
    seenSkillRealpaths,
  );

  return [...zcodeCandidates, ...agentsCandidates].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName),
  );
}

async function dedupeCandidatesByCanonicalSkillPath(
  candidates: SkillSyncCandidate[],
  seenSkillRealpaths: Set<string>,
): Promise<SkillSyncCandidate[]> {
  const result: SkillSyncCandidate[] = [];
  for (const candidate of candidates) {
    const canonicalPath = await realpath(candidate.path).catch(() => candidate.path);
    if (seenSkillRealpaths.has(canonicalPath)) {
      continue;
    }
    seenSkillRealpaths.add(canonicalPath);
    result.push(candidate);
  }
  return result;
}

async function collectUserSkillCandidatesInRoot(root: string): Promise<SkillSyncCandidate[]> {
  if (!existsSync(root)) {
    return [];
  }
  const candidates: SkillSyncCandidate[] = [];
  for await (const skillPath of walkSkillMarkdownPaths(root)) {
    const directoryPath = dirname(skillPath);
    const relativePath = normalizeSkillDirectoryRelativePath(root, directoryPath);
    if (!relativePath) {
      continue;
    }
    const content = await readSkillFileOrNull(skillPath);
    if (content !== null) {
      const metadata = parseSkillMetadata(content, basename(relativePath));
      candidates.push({
        id: createCandidateId(directoryPath),
        name: metadata.name,
        directoryName: relativePath,
        description: metadata.description,
        path: skillPath,
        sizeBytes: await computeRecursiveSize(directoryPath),
      });
    }
  }

  // Remote synchronization candidates must reuse the existing bounded scan strategy on the settings page;
  // If you maintain the recursion yourself, you will miss the MAX_SKILL_SCAN_DEPTH and soft link realpath deduplication. If you encounter a circular directory soft link, you will get stuck.
  return candidates.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

async function collectCoveredSkillDirectoryNamesInRoot(root: string): Promise<Set<string>> {
  const directoryNames = new Set<string>();
  if (!existsSync(root)) {
    return directoryNames;
  }
  const stack: Array<{ directoryPath: string; relativePath: string; depth: number }> = [
    { directoryPath: root, relativePath: "", depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const skillFilePath = join(current.directoryPath, SKILL_FILE_NAME);
    if (current.relativePath && (await readSkillFileOrNull(skillFilePath))) {
      directoryNames.add(current.relativePath);
    }
    if (current.depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.directoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(current.directoryPath, entry.name);
      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && (await stat(entryPath).catch(() => undefined))?.isDirectory());
      if (!isDirectory) {
        continue;
      }
      stack.push({
        directoryPath: entryPath,
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  return directoryNames;
}

function normalizeSkillDirectoryRelativePath(root: string, directoryPath: string): string {
  return relative(root, directoryPath).replaceAll("\\", "/");
}

function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function joinSkillRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

async function readSkillFileOrNull(skillPath: string): Promise<string | null> {
  try {
    return await readFile(skillPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseSkillMetadata(
  content: string,
  fallbackName: string,
): {
  name: string;
  description: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) {
    return { name: fallbackName, description: "" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { name: fallbackName, description: "" };
  }
  const metadata = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const name =
    typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : fallbackName;
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  return { name, description };
}

function createCandidateId(skillDirectoryPath: string): string {
  return createHash("sha256").update(skillDirectoryPath).digest("hex");
}

async function computeRecursiveSize(
  path: string,
  visitedDirectories = new Set<string>(),
): Promise<number> {
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink()) {
    const targetStat = await stat(path).catch(() => null);
    if (!targetStat) {
      return 0;
    }
    if (targetStat.isFile()) {
      return targetStat.size;
    }
    if (targetStat.isDirectory()) {
      return await computeDirectorySize(path, visitedDirectories);
    }
    return 0;
  }
  if (pathStat.isFile()) {
    return pathStat.size;
  }
  if (!pathStat.isDirectory()) {
    return 0;
  }
  return await computeDirectorySize(path, visitedDirectories);
}

async function computeDirectorySize(
  path: string,
  visitedDirectories: Set<string>,
): Promise<number> {
  const canonicalPath = await realpath(path).catch(() => path);
  if (visitedDirectories.has(canonicalPath)) {
    return 0;
  }
  visitedDirectories.add(canonicalPath);
  const children = await readdir(path, { withFileTypes: true });
  const childSizes = await Promise.all(
    children.map((child) => computeRecursiveSize(join(path, child.name), visitedDirectories)),
  );
  return childSizes.reduce((total, size) => total + size, 0);
}

async function collectSkillDirectoryPathByName(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!existsSync(root)) {
    return result;
  }
  for await (const skillPath of walkSkillMarkdownPaths(root)) {
    const content = await readSkillFileOrNull(skillPath);
    if (content === null) {
      continue;
    }
    const directoryPath = dirname(skillPath);
    const metadata = parseSkillMetadata(content, basename(directoryPath));
    const nameKey = normalizeSkillNameKey(metadata.name);
    if (!result.has(nameKey)) {
      result.set(nameKey, directoryPath);
    }
  }
  return result;
}

async function collectUserSkillDirectoryPathByName(): Promise<Map<string, string>> {
  const result = await collectSkillDirectoryPathByName(getUserZcodeSkillRoot());
  const agentsSkillPathByName = await collectSkillDirectoryPathByName(getUserAgentsSkillRoot());
  for (const [nameKey, directoryPath] of agentsSkillPathByName) {
    if (!result.has(nameKey)) {
      result.set(nameKey, directoryPath);
    }
  }
  return result;
}

async function importArchive(
  archive: Uint8Array,
  maxArchiveBytes: number,
): Promise<SkillSyncImportResult> {
  const targetRoot = getUserZcodeSkillRoot();
  await mkdir(targetRoot, { recursive: true });
  const tempRoot = join(targetRoot, `.sync-tmp-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    // The remote end synchronously receives the archive from the local machine. It must first resolve to the temporary directory and verify SKILL.md.
    // Then copy them one by one to the user-level skills root to avoid path traversal or semi-finished directory contamination of the remote configuration.
    await extractSkillSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
    const extractedSkillDirectories = await collectExtractedSkillDirectories(tempRoot);
    // The remote SkillsService reads both user-level .zcode/skills and .agents/skills.
    // Skills with the same name must also be skipped if they already exist in the compatible directory to avoid generating duplicate sources under .zcode after synchronization.
    const existingSkillPathByName = await collectUserSkillDirectoryPathByName();
    const results: SkillSyncImportResult["results"] = [];
    for (const extracted of extractedSkillDirectories) {
      const { directoryName, sourcePath } = extracted;
      const targetPath = resolveSkillSyncPathWithin(targetRoot, directoryName);
      const skillContent = await readSkillFileOrNull(join(sourcePath, SKILL_FILE_NAME));
      if (skillContent === null) {
        results.push({
          name: basename(directoryName),
          directoryName,
          status: "failed",
          error: "SKILL.md is missing",
        });
        continue;
      }

      const metadata = parseSkillMetadata(skillContent, directoryName);
      const nameKey = normalizeSkillNameKey(metadata.name);
      if (existsSync(targetPath)) {
        results.push({
          name: metadata.name,
          directoryName,
          status: "skipped",
          path: targetPath,
        });
        continue;
      }
      const existingPathForName = existingSkillPathByName.get(nameKey);
      if (existingPathForName) {
        results.push({
          name: metadata.name,
          directoryName,
          status: "skipped",
          path: existingPathForName,
        });
        continue;
      }

      try {
        await mkdir(dirname(targetPath), { recursive: true });
        await cp(sourcePath, targetPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        results.push({
          name: metadata.name,
          directoryName,
          status: "synced",
          path: targetPath,
        });
        existingSkillPathByName.set(nameKey, targetPath);
      } catch (error) {
        results.push({
          name: metadata.name,
          directoryName,
          status: "failed",
          path: targetPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function collectExtractedSkillDirectories(root: string): Promise<
  Array<{
    directoryName: string;
    sourcePath: string;
  }>
> {
  const directories: Array<{ directoryName: string; sourcePath: string }> = [];
  const stack: Array<{ directoryPath: string; relativePath: string }> = [
    { directoryPath: root, relativePath: "" },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (current.relativePath && existsSync(join(current.directoryPath, SKILL_FILE_NAME))) {
      directories.push({
        directoryName: current.relativePath,
        sourcePath: current.directoryPath,
      });
    }
    const entries = await readdir(current.directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      stack.push({
        directoryPath: join(current.directoryPath, entry.name),
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
      });
    }
  }
  return directories.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}
