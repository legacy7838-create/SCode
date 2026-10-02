/**
 * IPC Framework — unified exports
 *
 * Architecture overview (bottom to top):
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  Layer 6: Remote connections                                   │
 * │  RemoteAuthorityResolver → SocketFactory → PersistentProtocol  │
 * │  → IPCClient → channel.call()                                  │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 5: ProxyChannel automatic service proxying              │
 * │  fromService(service) ↔ toService(channel)                     │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 4: IPCServer(1:N) / IPCClient(1:1 bidirectional)        │
 * │  connection management, routing, multicast                     │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 3: ChannelServer / ChannelClient                        │
 * │  Channel-based RPC (call/listen)                               │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 2: IMessagePassingProtocol                              │
 * │  send(buffer) / onMessage: Event<buffer>                       │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 1: serialization (VQL + type tags)                      │
 * │  serialize() / deserialize()                                   │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 0: infrastructure                                       │
 * │  Event / Emitter / Disposable / VSBuffer / CancellationToken   │
 * └──────────────────────────────────────────────────────────────┘
 */

// Layer 0: Infrastructure
export {
  type IDisposable,
  toDisposable,
  DisposableStore,
  Event,
  Emitter,
  Relay,
  EventMultiplexer,
  type CancellationToken,
  CancellationTokenSource,
} from "./foundation.js";

export { VSBuffer } from "./buffer.js";

// Layer 1: Serialization
export {
  type IReader,
  type IWriter,
  BufferReader,
  BufferWriter,
  serialize,
  deserialize,
} from "./serialization.js";

// Layer 2: Transport protocol
export {
  type IMessagePassingProtocol,
  type ConnectionFlowControl,
  type MessagePortFlowControl,
  type MessagePortFlowState,
  type MessagePortPayload,
  type ISocket,
  ChunkStream,
  SocketProtocol,
  ProtocolMessageType,
  ProtocolMessage,
  MessagePortProtocol,
  type MessagePortLike,
  createQueuePair,
} from "./protocol.js";
export { PersistentProtocol, type PersistentProtocolOptions } from "./persistent-protocol.js";

// Layer 3: Channel RPC
export {
  type IChannel,
  type IServerChannel,
  type IChannelServer,
  type IChannelClient,
  ChannelServer,
  ChannelClient,
  getDelayedChannel,
} from "./channels.js";

// Layer 4: Connection management
export {
  type ClientConnectionEvent,
  type Client,
  type IConnectionHub,
  type IClientRouter,
  IPCServer,
  IPCClient,
  StaticRouter,
} from "./ipc.js";

// Layer 5: Service proxy
export { ProxyChannel } from "./proxy-channel.js";

// Logging middleware — decorates ChannelServer/ChannelClient, uniformly logging RPC calls
export {
  type RPCLogger,
  type RpcLoggingOptions,
  LoggingChannelServer,
  LoggingChannelClient,
} from "./logging-middleware.js";

export {
  type NetworkTransportKind,
  type NetworkObservation,
  type NetworkTelemetrySink,
  setNetworkTelemetrySink,
  emitNetworkTelemetryObservation,
  NetworkTelemetryChannelServer,
  NetworkTelemetryChannelClient,
} from "./network-telemetry-middleware.js";

// Layer 6: Remote
export {
  RemoteConnectionType,
  WebSocketRemoteConnection,
  ManagedRemoteConnection,
  type RemoteConnection,
  type ResolvedAuthority,
  type IRemoteAuthorityResolver,
  RemoteAuthorityResolverService,
  type ISocketFactory,
  RemoteSocketFactoryService,
  type IURITransformer,
  type SimpleURI,
  createURITransformer,
  RemoteAgentConnection,
  type RemoteConnectionState,
} from "./remote.js";

// Byte port: the single seam for the byte primitives. `crc32Hex` is hardware-accelerated on Node
// (bound via `@zcode/rpc/native`) and table-driven in the renderer; the rest stay on the platform.
// Exported so other renderer-reachable packages (e.g. @zcode/shared wire codec) reuse the one
// shared binding instead of importing @zcode/rust directly (spec invariant 9).
export {
  type IRpcBytesPort,
  rpcBytesPort,
  bindRpcBytesPort,
  isNativeRpcBytesPort,
  TS_BYTES_PORT,
} from "./bytes-port.js";
