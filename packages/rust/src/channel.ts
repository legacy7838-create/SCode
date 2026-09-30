/**
 * `@zcode/rust/channel` — loader + typed wrappers for the zcode-channel native binary.
 *
 * INVARIANT: there is NO JavaScript fallback. Hard-throw when binary missing.
 */
import { loadNative } from "./loader.js";

export interface NativeChannelModule {
  parseClientResponse(data: Uint8Array): {
    responseType: number;
    id: number;
    dataJson: string | null;
  } | null;
  parseServerRequest(data: Uint8Array): {
    requestType: number;
    id: number;
    channelName: string;
    methodName: string;
    argJson: string | null;
  } | null;
  buildResponse(
    responseType: number,
    id: number,
    dataJson: string | null,
  ): Uint8Array;
  buildRequest(
    requestType: number,
    id: number,
    channelName: string,
    methodName: string,
    argJson: string | null,
  ): Uint8Array;
}

let _cached: NativeChannelModule | null = null;

export function loadChannel(): NativeChannelModule {
  if (!_cached) {
    _cached = loadNative<NativeChannelModule>("zcode-channel");
  }
  return _cached;
}
