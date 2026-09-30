import type {
  BotConfig,
  BotProviderCallbackResult,
  BotsConfigFile,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { getWeixinUpdates } from "./providers/weixinProvider.js";
import {
  acquireWeixinPollingLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
} from "./channelRuntime.js";

interface WeixinChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined>;
  writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void>;
  processProviderCallback(
    provider: "weixin",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export function createWeixinChannelRuntime(deps: WeixinChannelRuntimeDeps) {
  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

  const runtimes = new Map<string, RuntimeEntry>();
  const refreshQueue = createLatestRuntimeRefreshQueue();

  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      bot.provider,
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  async function pollBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    const token = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: "weixin",
        status: "error",
        message: "Weixin bot token is missing.",
      });
      return;
    }

    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireWeixinPollingLock>>;
      try {
        lock = await acquireWeixinPollingLock(
          token,
          bot.id,
        );
      } catch (error) {
        if (signal.aborted) return;
        // Bugfix: Each window has an independent host. If the WeChat lock I/O fails, it must be backed off and retried, and the background Promise cannot be allowed to exit.
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "error",
          message: `Weixin polling lock failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "idle",
          message: "Weixin long polling is handled by another ZCode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "polling",
          // Fix: Running status will be displayed directly to the UI. Add messageId to let the front end render according to the current language, and the message is only used as a cover for the old version.
          message: "Weixin long polling is running.",
          messageId: "bots.runtime.weixinLongPollingRunning",
        });
        while (!signal.aborted) {
          const buf = await deps.readWeixinGetUpdatesBuf(bot.id);
          const result = await getWeixinUpdates({
            bot,
            deps: { loadCredential: (key) => deps.credentialService.load(key) },
            buf,
            signal,
          });
          if (signal.aborted) {
            return;
          }
          if ((result.rawMessageCount ?? 0) > 0 || result.messages.length > 0) {
            const attachmentCount = result.messages.reduce(
              (count, message) => count + (message.attachments?.length ?? 0),
              0,
            );
            // Bugfix debugging: WeChat attachments may have no text, record the original/parsed number to determine whether it is filtered at the provider layer.
            deps.logger.debug(
              undefined,
              `weixin polling received bot=${bot.id} raw=${result.rawMessageCount ?? 0} parsed=${result.messages.length} attachments=${attachmentCount}`,
            );
            if (result.messages.length === 0) {
              // Bugfix debugging: only record the field shape, not the text, locate why WeChat images/attachments are filtered.
              deps.logger.debug(
                undefined,
                `weixin polling diagnostics bot=${bot.id} ${(result.rawMessageDiagnostics ?? []).join(" | ")}`,
              );
            }
          }
          for (const inbound of result.messages) {
            if (signal.aborted) {
              return;
            }
            const callbackResult = await deps.processProviderCallback("weixin", {
              botId: bot.id,
              messages: [
                {
                  id: inbound.actor.providerMessageId,
                  text: inbound.text,
                  from: inbound.actor.providerUserId,
                  chatId: inbound.actor.chatId,
                  displayName: inbound.actor.displayName,
                  context_token: inbound.actor.providerContextToken,
                  // Bugfix: Attachments that have been parsed by WeChat polling cannot be lost when repackaged to the callback pipeline.
                  // Otherwise, the pure image message will be silent and unresponsive because the text is empty and the attachments are swallowed.
                  attachments: inbound.attachments,
                },
              ],
              ...(result.buf ? { buf: result.buf } : {}),
            });
            assertBotCallbackSucceeded("Weixin", callbackResult);
          }
          if (result.buf) {
            // Bugfix: WeChat get_updates_buf represents the server cursor and must wait until all messages in this batch enter business processing before persisting.
            // Previously, the cursor was written first and then the reply was processed. If the process failed midway, unfinished messages would be skipped, causing AskUserQuestion replies to be out of order or lost.
            await deps.writeWeixinGetUpdatesBuf(bot.id, result.buf);
          }
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "weixin",
            status: "polling",
            // Fix: Running status will be displayed directly to the UI. Add messageId to let the front end render according to the current language, and the message is only used as a cover for the old version.
            message: "Weixin long polling is running.",
            messageId: "bots.runtime.weixinLongPollingRunning",
          });
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "error",
          message: `Weixin polling failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
      } finally {
        // Bugfix: WeChat buf is a third-party queue confirmation point; only the lock owner can consume and write, and must be released to other hosts to take over when exiting.
        await lock.release().catch((error: unknown) => {
          deps.logger.debug(
            undefined,
            `release Weixin polling lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  async function stopPolling(botId: string): Promise<void> {
    const runtime = runtimes.get(botId);
    runtime?.controller.abort();
    if (runtime) {
      await runtime.done;
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    const previous = deps.statusSink.getRuntimeStatus(botId);
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.weixinLongPollingStopped",
        message: "Weixin long polling is stopped.",
      });
    }
  }

  function startPolling(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: "weixin",
      status: "polling",
      messageId: "bots.runtime.weixinLongPollingStarting",
      message: "Weixin long polling is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = pollBot(bot, controller.signal).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        if (previous?.status === "polling") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "weixin",
            status: "idle",
            messageId: "bots.runtime.weixinLongPollingStopped",
            message: "Weixin long polling is stopped.",
          });
        }
      }
    });
    runtimes.set(bot.id, runtime);
  }

  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    const activeWeixinIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            bot.provider === "weixin" && bot.enabled && bot.credentialRef,
        )
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeWeixinIds.has(botId)) {
        await stopPolling(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (bot.provider === "weixin" && bot.enabled && bot.credentialRef) {
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: After WeChat credentials are updated, the old getupdates loop still closes to hold the old BotConfig.
          // Wait serially for the old request to exit before taking over, to prevent the old account from continuing to consume or the new and old cursors to be advanced concurrently.
          await stopPolling(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startPolling(bot, fingerprint);
      } else if (bot.provider === "weixin" && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

  function refresh(config?: BotsConfigFile): Promise<void> {
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // Reason for repair: WeChat long polling after configuration change belongs to the local desktop host background task;
      // attached remote should only expose the remote file/agent control plane.
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Weixin polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix: WeChat buf can only be submitted by the lock owner; destruction must wait for the request to exit and finally release the lock before being completed.
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

  return {
    dispose,
    refresh,
    scheduleRefresh,
    stopPolling,
  };
}
