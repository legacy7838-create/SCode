import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { runCommand } from "./spawn-command.mjs";

// Bugfix: Windows GNU tar (Git Bash) will treat the drive letter colon (C:) in the absolute path as the remote host name.
// Backslash paths are also corrupted by MSYS parameter conversion. The tar parameters are uniformly converted to forward slashes, and the archive path is used first.
// The format relative to cwd avoids the drive letter colon; it has no impact on bsdtar and Linux/macOS CI.
function toTarPosixPath(pathValue) {
  return pathValue.replaceAll("\\", "/");
}

function resolveTarArchiveArg(archivePath, cwd) {
  if (process.platform === "win32") {
    try {
      const relativeArchivePath = relative(cwd, archivePath);
      if (relativeArchivePath && !relativeArchivePath.startsWith("..")) {
        return toTarPosixPath(relativeArchivePath);
      }
    } catch {
      // When crossing drive letters, relative will throw an error and return a forward slash absolute path (available for bsdtar).
    }
  }

  return toTarPosixPath(archivePath);
}

export function extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd }) {
  mkdirSync(extractDir, { recursive: true });
  if (archiveExt === "zip") {
    if (process.platform === "win32") {
      runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
      ]);
      return;
    }

    runCommand("unzip", ["-q", archivePath, "-d", extractDir], { cwd });
    return;
  }

  const tarCwd = cwd ?? process.cwd();
  runCommand(
    "tar",
    ["-xzf", resolveTarArchiveArg(archivePath, tarCwd), "-C", toTarPosixPath(extractDir)],
    { cwd: tarCwd },
  );
}

export function findPrebuiltBinary(rootDir, binaryName) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findPrebuiltBinary(fullPath, binaryName);
      if (nested) return nested;
      continue;
    }

    if (entry.isFile() && entry.name === binaryName) return fullPath;
  }

  return undefined;
}

function assertPrebuiltArchiveSha256(expectedSha256) {
  const normalizedExpectedSha256 = String(expectedSha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedExpectedSha256)) {
    throw new Error("missing prebuilt archive SHA-256");
  }
  return normalizedExpectedSha256;
}

export function verifyPrebuiltArchiveSha256(archivePath, expectedSha256) {
  const normalizedExpectedSha256 = assertPrebuiltArchiveSha256(expectedSha256);
  const actualSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actualSha256 !== normalizedExpectedSha256) {
    throw new Error(
      `Archive SHA-256 mismatch: expected ${normalizedExpectedSha256}, received ${actualSha256}`,
    );
  }
}

export async function extractPrebuiltBinary({
  archiveExt,
  archivePath,
  archiveSha256,
  binaryName,
  binaryPath,
  cwd,
  targetPlatform,
  validateBinary,
}) {
  verifyPrebuiltArchiveSha256(archivePath, archiveSha256);
  mkdirSync(dirname(binaryPath), { recursive: true });
  mkdirSync(tmpdir(), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-prebuilt-binary-"));
  const extractDir = join(tempDir, "extract");

  try {
    extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd });
    const extractedBinaryPath = findPrebuiltBinary(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error(`Failed to locate ${binaryName} in extracted archive`);
    }

    // The foreign target cannot be verified by executing the target file, and the temporary product must be verified before overwriting the official path.
    await validateBinary?.(extractedBinaryPath);
    copyFileSync(extractedBinaryPath, binaryPath);
    if (targetPlatform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    // Bugfix: The decompression product under Windows may temporarily hold the handle to the antivirus/indexer or the decompression subprocess that has not yet exited.
    // Immediate deletion of rmSync will cause EPERM, and the exception thrown in finally will cover up the real decompression error.
    // Delete with retry, only alert when failure occurs, and let the original error be thrown normally.
    try {
      rmSync(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`[warn] Failed to clean up temporary directory (ignorable): ${tempDir}`);
      console.warn(`[warn] ${String(error)}`);
    }
  }
}
