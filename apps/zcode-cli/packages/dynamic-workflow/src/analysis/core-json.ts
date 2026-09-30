import type { OrderTrace } from "./causality-order.js";
import type { AnalysisCore, CoreSites } from "./core.js";
import type { TaintOcc } from "./domain.js";

/**
 * The JSON encoding/decoding of `AnalysisCore`.
 *
 * The core is already position-independent pure data, and the only thing standing in the way of
 * `JSON.stringify` are the `Map`s inside `facts.*` and `types.*` — they would be serialized as `{}`.
 * Here every Map is replaced with an **ordered** `[key, value][]`:
 * the array preserves the insertion order and decoding restores it verbatim with `new Map(entries)`, so
 * `serializeCore(decode(encode(c)))` is byte-identical to `serializeCore(c)`, and the graph the
 * projection computes over a frozen artifact matches the moment of export.
 *
 * `sites` and `trace` contain only plain objects, arrays and optional fields, and pass through
 * unchanged: `JSON.stringify` drops the properties whose value is `undefined` and the decoder does
 * **not** add them back — the projection decides purely on "the field is absent" rather than on "the
 * field is undefined", so the two shapes are equivalent. The only exception is the value of
 * `joinPortTypes`: an `undefined` landing inside a `(string | undefined)[]` is written as `null` by
 * JSON, so the encoder writes `null` explicitly and the decoder converts it back to `undefined`, so
 * that the hole of "this port's type is unknowable" is still `undefined` after a round trip rather
 * than `null`.
 */

/** An ordered Map entry: the array order is the Map's insertion order. */
export type MapEntries<V> = [string, V][];

export interface AnalysisCoreJson {
  /** The format version; the decoder only accepts the versions it knows and throws for the rest instead of guessing. */
  version: 1;
  sites: CoreSites;
  facts: {
    askData: MapEntries<TaintOcc[]>;
    askActor: MapEntries<TaintOcc[]>;
    worldReadData: MapEntries<TaintOcc[]>;
    joinIn: MapEntries<TaintOcc[]>;
    fanoutIn: MapEntries<TaintOcc[]>;
    returnData: TaintOcc[];
  };
  trace: OrderTrace;
  types: {
    siteType: MapEntries<string>;
    /** A hole in a port type (`undefined`) is `null` here — a JSON array has no `undefined`. */
    joinPortTypes: MapEntries<(string | null)[]>;
  };
}

const VERSION = 1;

/** Turns the core into a plain object that `JSON.stringify` can handle directly; `sites` and `trace` keep their original references. */
export function encodeAnalysisCore(core: AnalysisCore): AnalysisCoreJson {
  return {
    facts: {
      askActor: [...core.facts.askActor],
      askData: [...core.facts.askData],
      fanoutIn: [...core.facts.fanoutIn],
      joinIn: [...core.facts.joinIn],
      returnData: core.facts.returnData,
      worldReadData: [...core.facts.worldReadData],
    },
    sites: core.sites,
    trace: core.trace,
    types: {
      joinPortTypes: [...core.types.joinPortTypes].map(([id, ports]) => [
        id,
        ports.map((port) => (port === undefined ? null : port)),
      ]),
      siteType: [...core.types.siteType],
    },
    version: VERSION,
  };
}

/** Rebuilds the core from its JSON form (Maps keep their original insertion order). An unknown version throws a plain `Error`. */
export function decodeAnalysisCore(json: AnalysisCoreJson): AnalysisCore {
  if (json.version !== VERSION) {
    throw new Error(`unsupported AnalysisCoreJson version ${String(json.version)} (expected ${VERSION})`);
  }
  return {
    facts: {
      askActor: new Map(json.facts.askActor),
      askData: new Map(json.facts.askData),
      fanoutIn: new Map(json.facts.fanoutIn),
      joinIn: new Map(json.facts.joinIn),
      returnData: json.facts.returnData,
      worldReadData: new Map(json.facts.worldReadData),
    },
    sites: json.sites,
    trace: json.trace,
    types: {
      joinPortTypes: new Map(
        json.types.joinPortTypes.map(([id, ports]) => [id, ports.map((port) => (port === null ? undefined : port))]),
      ),
      siteType: new Map(json.types.siteType),
    },
  };
}
