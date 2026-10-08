import type { ZCodeUsage } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";

function toUsage(fact: Extract<ConversationTelemetryFact, { kind: "usage.delta" }>): ZCodeUsage {
  return {
    inputTokens: fact.inputTokens,
    outputTokens: fact.outputTokens,
    totalTokens: fact.totalTokens,
    reasoningTokens: fact.reasoningTokens,
    cachedInputTokens: fact.cacheReadTokens,
    cachedWriteInputTokens: fact.cacheWriteTokens,
  };
}

function mergeUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  if (!left) return { ...right };
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

/**
 * renderer workspace 级 usage 归因器。
 *
 * 修复依据：原先这里同时承载 appTelemetry / ARMS / messageTelemetry / localTtft 等出口上报。
 * 遥测出口整体移除后，只保留订阅 `ConversationTelemetryFact` 并按 session 聚合 `usage.delta`
 * → `ZCodeUsage` 的 fact→usage 归因链，作为运行中会话 token/usage 展示的旁路聚合，
 * 不再向设备外发送任何诊断数据。
 *
 * 它不读取 rows/snapshot，也不跟随 pane lease 销毁；React 只负责 attachment 生命周期，
 * 所有高频 fact 都进入这个命令式对象，避免 streaming 触发渲染。
 */
export class ConversationTelemetrySupervisor {
  private readonly workspaceScopeKey: string;
  private readonly usageBySessionId = new Map<string, ZCodeUsage>();
  private disposed = false;

  constructor(options: { workspaceScopeKey: string }) {
    this.workspaceScopeKey = options.workspaceScopeKey;
  }

  handleFact(fact: ConversationTelemetryFact): void {
    if (this.disposed) return;
    // 只消费 usage.delta：turn.terminal 等其余事实仅服务于已移除的遥测上报，
    // 运行中 usage 展示由 session store 直接驱动，这里保留纯归因聚合。
    if (fact.kind !== "usage.delta") return;
    const previous = this.usageBySessionId.get(fact.sessionId) ?? null;
    this.usageBySessionId.set(fact.sessionId, mergeUsage(previous, toUsage(fact)));
  }

  /** 当前 workspace 下按 session 聚合的 usage；workspaceScopeKey 用于跨窗口隔离标识。 */
  getAggregatedUsage(sessionId: string): ZCodeUsage | undefined {
    return this.usageBySessionId.get(sessionId);
  }

  getWorkspaceScopeKey(): string {
    return this.workspaceScopeKey;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.usageBySessionId.clear();
  }
}
