import { ProxyChannel, type IChannelServer } from "@zcode/rpc";
import type { ServiceDescriptor } from "./descriptors.js";

/**
 * ServiceCollection — the service registry
 *
 * Used on the server side to register service instances and automatically expose them on the ChannelServer.
 */
export class ServiceCollection {
  private readonly _services = new Map<string, unknown>();

  register<T>(descriptor: ServiceDescriptor<T>, instance: T): this {
    this._services.set(descriptor.channelName, instance);
    return this;
  }

  get<T>(descriptor: ServiceDescriptor<T>): T {
    const instance = this._services.get(descriptor.channelName);
    if (!instance) {
      throw new Error(`Service not registered: ${descriptor.channelName}`);
    }
    return instance as T;
  }

  getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined {
    return this._services.get(descriptor.channelName) as T | undefined;
  }

  /** Automatically exposes every registered service as a channel */
  exposeOnChannelServer(
    server: IChannelServer,
    overrides: ReadonlyMap<string, unknown> = new Map(),
  ): void {
    for (const [channelName, instance] of this._services) {
      const exposed = overrides.get(channelName) ?? instance;
      server.registerChannel(
        channelName,
        ProxyChannel.fromService(exposed as Record<string, unknown>),
      );
    }
  }
}
