import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeZCodeBuiltinRelease,
  serializeZCodeBuiltinRelease,
} from "./zcode-builtin-release.js";

export interface MaterializeZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/**
 * Releases the single bundled baseline into the environment directory; upgrading assumes the old
 * process has exited, so no historical hash copies are kept.
 * Kept separate from the downloaded config, and reusing the shared lock plus atomic write so that
 * concurrent startups never read a half-written JSON.
 */
export async function materializeZCodeBuiltinProviderConfig(
  options: MaterializeZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  const content = `${serializeZCodeBuiltinRelease(
    decodeZCodeBuiltinRelease(JSON.parse(options.content)),
  )}\n`;
  const filePath = join(
    options.environmentConfigRoot,
    "runtime",
    "provider",
    "bundled",
    "zcode-builtin.json",
  );
  await withFileLock(filePath, async () => {
    if ((await readOptionalFile(filePath)) !== content) {
      await atomicWritePrivateTextFile(filePath, content);
    }
  });
  return filePath;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
