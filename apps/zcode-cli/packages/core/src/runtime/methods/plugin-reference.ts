// turn-start injection of plugin_reference reminder.
// Contract: Parse canonical text → Freeze catalog →
// Intersect with live Skill/MCP/Subagent inventory → generate model-only reminder for this round.
// Failure semantics: dialogue fail open (any exception will not block this round), capability injection fail closed (no exception will be injected).
import { toMcpToolName } from "../../mcp/index.js";
import {
  buildPluginReferenceReminderBody,
  extractPluginReferences,
  type LivePluginMcpServer,
  type LivePluginSkill,
  type LivePluginSubagent,
} from "../../plugin-reference/index.js";
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

async function collectLiveMcpServers(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  toolDisallowlist: readonly string[] | undefined,
): Promise<LivePluginMcpServer[]> {
  if (!runtime.mcpPort) return [];
  // initializeMcp is idempotent; the first provider of the turn loop will wait for it before requesting it.
  // Here await does not add extra waiting. References never trigger connect/reconnect/OAuth - only the status quo is read.
  await runtime.initializeMcp(traceContext);
  const statuses = await runtime.mcpPort.status();
  const snapshot = runtime.mcpStartupPromise ? await runtime.mcpStartupPromise : undefined;
  const registeredToolNames = new Set(runtime.getTools().map((tool) => tool.name));
  // Maintains exactly the same "full tool name" semantics as turn-loop's provider tool filtering;
  // Execution rules with parameters do not remove the entire tool from the provider tool list and cannot be expanded on the reminder side.
  const turnDisallowedToolNames = new Set(toolDisallowlist ?? []);
  const providerVisibleToolCounts = new Map<string, number>();
  for (const descriptor of snapshot?.tools ?? []) {
    // provider-visible = Start the tool in the snapshot first through the Session global allow/disallow registration filter,
    // Then pass this round of toolDisallowlist. Root cause: Just looking at the registry will result in "this cycle is hidden, but the global is still registered"
    // The MCP tool miscalculates visible capabilities, and the reminder will claim a server that the provider cannot actually reach.
    const toolName = toMcpToolName(descriptor);
    if (!registeredToolNames.has(toolName)) continue;
    if (turnDisallowedToolNames.has(toolName)) continue;
    providerVisibleToolCounts.set(
      descriptor.serverName,
      (providerVisibleToolCounts.get(descriptor.serverName) ?? 0) + 1,
    );
  }
  return Object.entries(statuses).map(([serverName, status]) => ({
    serverName,
    connected: status.status === "connected",
    providerVisibleToolCount: providerVisibleToolCounts.get(serverName) ?? 0,
  }));
}

function collectLivePluginSkills(runtime: AgentRuntimeInternal): LivePluginSkill[] {
  const skills: LivePluginSkill[] = [];
  for (const skill of runtime.skillLoadOutcome?.skills ?? []) {
    if (skill.source !== "plugin") continue;
    if (!skill.pluginName || !skill.qualifiedName) continue;
    skills.push({
      qualifiedName: skill.qualifiedName,
      pluginName: skill.pluginName,
      rootPath: skill.rootPath,
      source: skill.source,
    });
  }
  return skills;
}

function collectLivePluginSubagents(runtime: AgentRuntimeInternal): LivePluginSubagent[] {
  const subagents: LivePluginSubagent[] = [];
  for (const profile of runtime.config.subagents?.profiles ?? []) {
    const name = profile.name.trim();
    const path = profile.path?.trim();
    // Plugin profile is successfully parsed from Markdown by bootstrap before entering config, and must carry path.
    // The built-in/inline profile without path cannot perform provenance traceback, so press fail closed to skip.
    if (!name || !path) continue;
    subagents.push({ name, path });
  }
  return subagents;
}

export async function injectPluginReferenceReminderFromTurn(
  this: AgentRuntimeInternal,
  userInput: string,
  traceContext: TraceContext,
  toolDisallowlist?: readonly string[],
): Promise<void> {
  // No reference is the absolute home path: no touching MCP/skills, zero overhead returned.
  const extraction = extractPluginReferences(userInput);
  if (extraction.references.length === 0) {
    if (extraction.invalidCount > 0) {
      this.logger?.debug("Plugin reference parse rejected invalid destinations", {
        ...traceContextToLogContext(traceContext),
        event: "plugin_reference.parse.invalid",
        invalidCount: extraction.invalidCount,
        module: "core.runtime",
      });
    }
    return;
  }

  const startedAt = Date.now();
  try {
    const liveMcpServers = await collectLiveMcpServers(this, traceContext, toolDisallowlist);
    const liveSkills = collectLivePluginSkills(this);
    const liveSubagents = collectLivePluginSubagents(this);
    const result = buildPluginReferenceReminderBody({
      references: extraction.references,
      catalog: this.config.pluginReferenceCatalog,
      liveSkills,
      liveMcpServers,
      liveSubagents,
    });
    // Each round is of the same order of magnitude as the message flow → must be debugged (production no-op), only controlled identification and count are output.
    this.logger?.debug("Plugin reference reminder resolved", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "plugin_reference.reminder.resolved",
      invalidCount: extraction.invalidCount,
      mcpServerCount: result.diagnostics.mcpServerCount,
      module: "core.runtime",
      referenceCount: extraction.references.length,
      resolvedPluginIds: result.diagnostics.resolvedPluginIds,
      skillCount: result.diagnostics.skillCount,
      subagentCount: result.diagnostics.subagentCount,
      skipped: result.diagnostics.skipped,
      truncated: result.diagnostics.truncated || extraction.truncatedCount > 0,
    });
    if (!result.body) return;
    this.messageHistory.addAttachment("plugin_reference", result.body);
    // Root cause: Only writing runtime attachment will cause the hot session to retain reminder and cold resume but lose them.
    // The historical message sequence is thus misaligned and corrupts the provider prefix cache. Inject first and then use model-only notice
    // The original text is dropped into the library, and the universal hydration will rebuild the attachment according to the same source, and the UI will not generate user bubbles.
    await this.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      sessionId: this.sessionId,
      source: "plugin_reference",
      text: result.body,
      traceContext,
    });
  } catch (error) {
    // Dialog fail open: Reminder generation failure does not affect the current round of sending; capability injection fail closed: No cryptic content is written.
    this.logger?.debug("Plugin reference reminder generation failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      event: "plugin_reference.reminder.failed",
      module: "core.runtime",
      referenceCount: extraction.references.length,
    });
  }
}
