import { materializeZCodeBuiltinProviderConfig } from "@zcode/services/node";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

interface MaterializeBundledZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** Returns the ZCode Built-in Provider Config embedded into the remote Server at build time. */
export function readBundledZCodeBuiltinProviderConfig(): string {
  if (typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("this build does not embed a ZCode Built-in Provider Config");
  }
  return __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * Atomically materialises the ZCode Built-in Config into a fixed resource copy owned by its
 * environment. Old processes exit before the upgrade; no historical files keyed by content hash are
 * kept around.
 */
export async function materializeBundledZCodeBuiltinProviderConfig(
  options: MaterializeBundledZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeZCodeBuiltinProviderConfig(options);
}
