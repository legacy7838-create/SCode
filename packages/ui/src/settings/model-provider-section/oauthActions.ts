import type { BuiltinModelProviderId, IPlatformService } from "@zcode/shared";

// 修复原因：数仓埋点链路（appTelemetry）已整体下线，不再有任何诊断数据出设备。
// 保留导出与签名以维持既有调用点，函数体不再上报，仅作为 no-op 透传。
export async function reportPresetSubscriptionSuccess(_params: {
  platform: IPlatformService;
  presetId: BuiltinModelProviderId;
}) {}
