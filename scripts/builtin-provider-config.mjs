import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.ZCODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ZCODE_ENV !== undefined) value = parsed.ZCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ZCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  env = await loadEndpointEnv({ root, env });
  const environment = await resolveBuiltinProviderBuildEnvironment({
    root,
    env,
  });
  const sourcePath = resolve(
    root,
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || "config/provider/zcode-builtin.json",
  );
  try {
    const content = await readFile(sourcePath, "utf8");
    // The complete Release verification at runtime is reused during the build
    // period to avoid discovering Schema incompatibility only after successful
    // packaging — and it is the same Rust codec the runtime loads, so the
    // build-time gate cannot drift from it (docs/specs/rust-native-provider-node.md).
    // tsx is only used by the build tool to load the loader TS. It does not
    // enter the product bundle or copy the verification rules.
    // The drive letter of the Windows absolute path will be used as a protocol
    // by ESM, and after being converted into a file URL, each platform will
    // share the same loading entry.
    const { loadNative } = await tsImport(
      pathToFileURL(resolve(repositoryRoot, "packages/rust/src/loader.ts")).href,
      import.meta.url,
    );
    const { decodeZcodeBuiltinRelease } = loadNative("zcode-provider-node");
    decodeZcodeBuiltinRelease(content);
    return { environment, sourcePath, content };
  } catch (error) {
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // Bootstrap can reuse JS, but it cannot reuse the independent configuration resources of the previous environment/previous version.
  await writeFile(resolve(directory, "zcode-builtin.json"), config.content, "utf8");
  return config;
}
