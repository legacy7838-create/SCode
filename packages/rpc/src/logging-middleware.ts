/**
 * RPC logging interceptor middleware
 *
 * Decorates ChannelServer / ChannelClient to log all RPC calls and event subscriptions
 * in one place, without touching the core logic.
 *
 * Usage:
 *   const server = new ChannelServer(protocol, ctx);
 *   const logged = new LoggingChannelServer(server, logger.info);
 *   services.exposeOnChannelServer(logged);
 */

import type { IChannelServer, IChannelClient, IChannel, IServerChannel } from "./channels.js";
import type { CancellationToken } from "./foundation.js";
import { Event } from "./foundation.js";

// ============================================================================
// Logging function types
// ============================================================================

export type RPCLogger = (message: string, ...args: unknown[]) => void;

// ============================================================================
// LoggingServerChannel — decorates a single IServerChannel, logging call/listen
// ============================================================================

class LoggingServerChannel<TContext> implements IServerChannel<TContext> {
  constructor(
    private inner: IServerChannel<TContext>,
    private channelName: string,
    private logger: RPCLogger,
  ) {}

  async call<T>(
    ctx: TContext,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(ctx, command, arg, cancellationToken);
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} OK (${elapsed}ms)`);
      return result;
    } catch (err) {
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} FAIL (${elapsed}ms)`, err);
      throw err;
    }
  }

  listen<T>(ctx: TContext, event: string, arg?: any): Event<T> {
    try {
      const result = this.inner.listen<T>(ctx, event, arg);
      this.logger(`[rpc:listen] ${this.channelName}.${event} subscribed`);
      return result;
    } catch (err) {
      this.logger(`[rpc:listen] ${this.channelName}.${event} FAIL`, err);
      throw err;
    }
  }
}

// ============================================================================
// LoggingChannelServer — decorates IChannelServer, intercepting registerChannel
// ============================================================================

/**
 * Wraps a ChannelServer, adding logging automatically to every registered channel.
 *
 * Use it in the host process or in a server:
 * ```ts
 * const server = new ChannelServer(protocol, ctx);
 * const logged = new LoggingChannelServer(server, console.error);
 * services.exposeOnChannelServer(logged);
 * ```
 */
export class LoggingChannelServer<TContext = string> implements IChannelServer<TContext> {
  constructor(
    private inner: IChannelServer<TContext>,
    private logger: RPCLogger,
  ) {}

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.logger(`[rpc:register] channel "${channelName}"`);
    this.inner.registerChannel(
      channelName,
      new LoggingServerChannel(channel, channelName, this.logger),
    );
  }

  ready(): void {
    this.inner.ready?.();
  }
}

// ============================================================================
// LoggingChannel — decorates a single IChannel (client side), logging call/listen
// ============================================================================

class LoggingChannel implements IChannel {
  constructor(
    private inner: IChannel,
    private channelName: string,
    private logger: RPCLogger,
  ) {}

  async call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(command, arg, cancellationToken);
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} → OK (${elapsed}ms)`);
      return result;
    } catch (err) {
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} → FAIL (${elapsed}ms)`, err);
      throw err;
    }
  }

  listen<T>(event: string, arg?: any): Event<T> {
    this.logger(`[rpc:listen] ${this.channelName}.${event} → subscribed`);
    return this.inner.listen<T>(event, arg);
  }
}

// ============================================================================
// LoggingChannelClient — decorates IChannelClient, intercepting getChannel
// ============================================================================

/**
 * Wraps a ChannelClient, adding logging automatically to every channel it hands out.
 *
 * Use it in the renderer or in a client:
 * ```ts
 * const client = new ChannelClient(protocol);
 * const logged = new LoggingChannelClient(client, console.info);
 * const services = new RemoteServiceAccess(logged);
 * ```
 */
export class LoggingChannelClient implements IChannelClient {
  constructor(
    private inner: IChannelClient,
    private logger: RPCLogger,
  ) {}

  getChannel<T extends IChannel>(channelName: string): T {
    const channel = this.inner.getChannel<T>(channelName);
    return new LoggingChannel(
      channel as unknown as IChannel,
      channelName,
      this.logger,
    ) as unknown as T;
  }
}
