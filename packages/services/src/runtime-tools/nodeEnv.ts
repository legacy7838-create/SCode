import { resolveZCodeRuntimeEnv } from "@zcode/shared";

type EffectiveNodeEnv = "development" | "production";

function resolveEffectiveNodeEnv(
  env: Record<string, string | undefined> = process.env,
): EffectiveNodeEnv {
  const runtimeEnv = resolveZCodeRuntimeEnv(env);
  // NODE_ENV is a common variable used by both the user shell and the Node ecosystem, and cannot be used as a ZCode runtime criterion.
  // Only ZCODE_RUNTIME_ENV explicitly injected by app/CLI is recognized here to prevent NODE_ENV in Bash or login shell from leaking into
  // When host/agent is running; when test is running, it is processed in normal mode and the development debugging log is not opened.
  return runtimeEnv === "development" ? "development" : "production";
}

export function isEffectiveDevelopmentNodeEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveEffectiveNodeEnv(env) === "development";
}
