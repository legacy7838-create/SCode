import { loadNative } from "./loader.js";

export interface NativeRpcUtilsModule {
  isEventName(name: string): boolean;
  isDynamicEventName(name: string): boolean;
  transformUriIncoming(
    scheme: string,
    authority: string,
    path: string,
    remoteAuthority: string,
  ): [string, string, string];
  transformUriOutgoing(
    scheme: string,
    authority: string,
    path: string,
    remoteAuthority: string,
  ): [string, string, string];
  classifyErrorKind(message: string): string;
  extractRemoteType(authority: string): string;
  parseUri(uri: string): [string, string, string];
}

let _cached: NativeRpcUtilsModule | null = null;
export function loadRpcUtils(): NativeRpcUtilsModule {
  if (!_cached) _cached = loadNative<NativeRpcUtilsModule>("zcode-rpc-utils");
  return _cached;
}
