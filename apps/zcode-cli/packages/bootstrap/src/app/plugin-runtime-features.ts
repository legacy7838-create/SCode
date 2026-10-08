import type { AgentRuntimeConfig } from "@zcode/core";
import type { PluginLoadOutcome } from "@zcode/contracts";

type RuntimeFeaturesConfig = NonNullable<AgentRuntimeConfig["runtimeFeatures"]>;

export function resolvePluginRuntimeFeatures(
  _pluginOutcome: Pick<PluginLoadOutcome, "plugins">,
): RuntimeFeaturesConfig {
  // CUA 子系统已整体下线，官方 CUA plugin 不再存在，bootstrap 不再据此注入
  // computerUse runtime feature；保留函数以维持 create-app 的调用契约。
  return {};
}
