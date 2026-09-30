import {
  normalizeBotReplyGranularity,
  type BotActor,
  type BotCommandPolicy,
  type BotConfig,
  type BotProvider,
  type BotsConfigFile,
} from "@zcode/shared";
import {
  normalizeBotCommandPolicy,
  normalizeBotCurrentOptions,
} from "./config.js";
import { normalizeAllowedWorkspaces } from "./workspaceHelpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getContextKey(bot: Pick<BotConfig, "id">): string {
  return bot.id;
}

export function findBot(config: BotsConfigFile, botId: string): BotConfig | null {
  return config.bots.find((bot) => bot.id === botId) ?? null;
}

export function findCallbackBot(
  config: BotsConfigFile,
  provider: BotProvider,
  payload: unknown,
): BotConfig | null {
  if (!isRecord(payload)) {
    return null;
  }
  const botId = typeof payload.botId === "string" ? payload.botId : "";
  if (botId) {
    return findBot(config, botId);
  }
  return config.bots.filter((bot) => bot.provider === provider && bot.enabled).at(0) ?? null;
}

export function findAuthorizedBot(
  config: BotsConfigFile,
  actor: BotActor,
): BotConfig | null {
  if (actor.provider === "weixin") {
    return config.bots.find((bot) => bot.enabled && bot.provider === "weixin" && bot.id === actor.botId) ?? null;
  }
  return (
    config.bots.find(
      (bot) =>
        bot.enabled &&
        bot.provider === actor.provider &&
        bot.providerUserId === actor.providerUserId,
    ) ?? null
  );
}

export function findBoundUser(bot: BotConfig, actor: BotActor): BotConfig | null {
  return actor.provider === "weixin" || bot.providerUserId === actor.providerUserId ? bot : null;
}

export function normalizeBotConfig(bot: BotConfig): BotConfig {
  const normalized = {
    ...bot,
    // After Bot configuration, allowedWorkspaces is the sole workspace permission boundary; empty arrays are uniformly converted to "*".
    allowedWorkspaces: normalizeAllowedWorkspaces(bot.allowedWorkspaces),
    allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
    currentOptions: normalizeBotCurrentOptions(bot.currentOptions),
    // Bugfix: Feishu/Lark reply granularity depends on Card JSON 2.0 single-card updates; old configs cannot keep the plain message mode.
    replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
  };
  if (normalized.provider !== "weixin") {
    return normalized;
  }
  // WeChat uses a built-in iLink address; clean webhookUrl when saving to avoid leaving other providers' outbound fields in the WeChat config.
  delete normalized.webhookUrl;
  return normalized;
}

function getUserCommandPolicy(bot: BotConfig): BotCommandPolicy {
  return normalizeBotCommandPolicy(bot.allowedCommands);
}

export function isUserCommandAllowed(
  bot: BotConfig,
  requestedCommand:
    | "help"
    | "status"
    | "new"
    | "reconnect"
    | "workspace"
    | "model"
    | "mode"
    | "thoughtLevel"
    | "task"
    | "reply"
    | "stop"
    | "message"
    | "approve",
): boolean {
  if (
    requestedCommand === "help" ||
    requestedCommand === "message" ||
    requestedCommand === "approve" ||
    requestedCommand === "task" ||
    requestedCommand === "stop"
  ) {
    return true;
  }
  if (requestedCommand === "reconnect") {
    return getUserCommandPolicy(bot).workspace !== false;
  }
  return getUserCommandPolicy(bot)[requestedCommand] !== false;
}

export function normalizeConfigBots(config: BotsConfigFile): BotsConfigFile {
  return {
    ...config,
    bots: config.bots.map(normalizeBotConfig),
  };
}
