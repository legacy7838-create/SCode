/**
 * ServiceDescriptor — identifies a service by channel name and ties types together generically.
 *
 * It relies on TypeScript allowing an interface and a const with the same name (types and values
 * live in different namespaces), so callers use one name for both the service type and the runtime
 * descriptor.
 */

export interface ServiceDescriptor<T> {
  readonly channelName: string;
  /** Phantom type — used only for type inference, absent at runtime */
  readonly _brand?: T;
}

export function createServiceDescriptor<T>(channelName: string): ServiceDescriptor<T> {
  return { channelName };
}
