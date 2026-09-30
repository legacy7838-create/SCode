/**
 * `@zcode/rust/protocol` — loader + typed wrappers for the zcode-protocol native binary.
 *
 * INVARIANT: there is NO JavaScript fallback. Hard-throw when binary missing.
 */
import { loadNative } from "./loader.js";

export interface NativeProtocolModule {
  writeProtocolMessage(
    msgType: number,
    id: number,
    ack: number,
    data: Uint8Array,
  ): Uint8Array;
  parseProtocolHeader(
    data: Uint8Array,
    offset: number,
  ): {
    msgType: number;
    id: number;
    ack: number;
    bodyLength: number;
  } | null;
  processAck(
    unackIds: number[],
    unackDataLengths: number[],
    ack: number,
  ): {
    remainingIds: number[];
    remainingLengths: number[];
    dropped: number;
    unackBytesDelta: number;
  };
  checkCongestion(
    unackBytes: number,
    saturated: boolean,
    highWatermark: number,
    lowWatermark: number,
  ): {
    saturated: boolean;
    fireSaturated: boolean;
    fireDrained: boolean;
  };
  checkReplayOverflow(unackBytes: number, maxBytes: number): boolean;
  checkGraceWindow(
    oldestQueuedAt: number,
    now: number,
    graceMs: number,
  ): boolean;
}

let _cached: NativeProtocolModule | null = null;

export function loadProtocol(): NativeProtocolModule {
  if (!_cached) {
    _cached = loadNative<NativeProtocolModule>("zcode-protocol");
  }
  return _cached;
}
