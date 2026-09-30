import {
  isFeishuBotProvider,
  type BotConfig,
  type BotProvider,
  type BotProviderCallbackResult,
  type BotsConfigFile,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import {
  startFeishuBotWebSocket,
  type FeishuWebSocketClient,
} from "./providers/feishuProvider.js";
import {
  acquireFeishuWebSocketLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
  waitForAbort,
} from "./channelRuntime.js";

interface FeishuChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  summarizeCallbackPayload(payload: unknown): string;
  processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export function createFeishuChannelRuntime(deps: FeishuChannelRuntimeDeps) {
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
      bot.feishuAppId ?? "",
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  async function runBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    let client: FeishuWebSocketClient | null = null;
    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireFeishuWebSocketLock>>;
      try {
        lock = await acquireFeishuWebSocketLock(bot);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        // Bugfix: When the runtime is stopped or the lock directory is abnormal, the lock file creation may fail before entering the connection try block.
        // Acquire must be included in a resumable loop, otherwise multi-window closing will leave an unhandled rejection.
        deps.logger.warn(
          undefined,
          `acquire Feishu WebSocket lock failed bot=${bot.id}: ${error instanceof Error ? `${error.message}${"code" in error && typeof error.code === "string" ? ` code=${error.code}` : ""}` : String(error)}`,
        );
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          message: `Feishu WebSocket lock failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "idle",
          message: "Feishu WebSocket is handled by another ZCode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      let retryAfterError = false;
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          messageId: "bots.runtime.feishuWebSocketConnecting",
          message: "Feishu WebSocket is connecting.",
        });
        client = await startFeishuBotWebSocket({
          bot,
          signal,
          onConnectionStateChange: (state) => {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: bot.provider,
              status: "connected",
              message:
                state === "reconnecting"
                  ? "Feishu WebSocket is reconnecting."
                  : "Feishu WebSocket is running.",
              messageId:
                state === "reconnecting"
                  ? "bots.runtime.feishuWebSocketConnecting"
                  : "bots.runtime.feishuWebSocketRunning",
            });
          },
          deps: {
            loadCredential: (key) => deps.credentialService.load(key),
          },
          onPayload: async (payload) => {
            if (signal.aborted) {
              return;
            }
            deps.logger.debug(
              undefined,
              `feishu websocket payload bot=${bot.id} ${deps.summarizeCallbackPayload(payload)}`,
            );
            const callbackResult = await deps.processProviderCallback(
              bot.provider,
              payload,
            );
            assertBotCallbackSucceeded(
              bot.provider === "lark" ? "Lark" : "Feishu",
              callbackResult,
            );
            return callbackResult.replies[0];
          },
        });
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          // Fix: Running status will be displayed directly to the UI. Add messageId to let the front end render according to the current language, and the message is only used as a cover for the old version.
          message: "Feishu WebSocket is running.",
          messageId: "bots.runtime.feishuWebSocketRunning",
        });
        // Bugfix: ready for the first time is not the end of the long connection life cycle. If the SDK reconnection is exhausted, you must enter the catch.
        // Only then can the error status be updated, the client closed, the cross-window lock released, and the outer recovery loop entered.
        await Promise.race([
          waitForAbort(signal),
          client.terminated,
        ]);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          message: `Feishu WebSocket failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        retryAfterError = true;
      } finally {
        if (client) {
          try {
            client.close();
          } catch (error) {
            deps.logger.debug(
              undefined,
              `close Feishu WebSocket failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          client = null;
        }
        await lock.release().catch((error: unknown) => {
          deps.logger.warn(
            undefined,
            `release Feishu WebSocket lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      // Reason for repair: Retry backoff cannot occupy the old client and cross-window lock waiting, and the resources must be completely cleared first.
      if (retryAfterError) {
        await waitFor(5_000, signal);
      }
    }
  }

  async function stopWebSocket(botId: string): Promise<void> {
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
        messageId: "bots.runtime.feishuWebSocketStopped",
        message: "Feishu WebSocket is stopped.",
      });
    }
  }

  function startWebSocket(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: "connected",
      messageId: "bots.runtime.feishuWebSocketStarting",
      message: "Feishu WebSocket is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = runBot(bot, controller.signal).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        if (previous?.status === "connected") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: bot.provider,
            status: "idle",
            messageId: "bots.runtime.feishuWebSocketStopped",
            message: "Feishu WebSocket is stopped.",
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
    const activeFeishuIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            isFeishuBotProvider(bot.provider) &&
            bot.enabled &&
            bot.credentialRef &&
            bot.feishuAppId,
        )
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeFeishuIds.has(botId)) {
        await stopWebSocket(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (
        isFeishuBotProvider(bot.provider) &&
        bot.enabled &&
        bot.credentialRef &&
        bot.feishuAppId
      ) {
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: After the provider, App ID or credentials of Feishu/Lark are changed, the old WebSocket still retains the old configuration.
          // You must wait for the old client and cross-window lock to be released before starting a new connection to ensure that only one configuration version of the same Bot is online.
          await stopWebSocket(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startWebSocket(bot, fingerprint);
      } else if (isFeishuBotProvider(bot.provider) && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
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
      // Reason for repair: remote workspace host / desktop-attached remote only exposes control plane services;
      // The bot runtime background connection must remain on the local desktop host to avoid re-running after configuration changes.
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Feishu WebSocket failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix: abort only sends a cancellation signal; the destruction of the final state must wait for the WebSocket to close and finally release the cross-process lock.
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
    stopWebSocket,
  };
}
