/**
 * The request seam of the option-map pipeline. The engine lives in the
 * `zcode-model-option-map` binary and is loaded directly by `model-execution.ts`
 * (no wrapper package — spec docs/specs/rust-native-model-option-map.md §4);
 * this file owns only the structural shapes and the `fetch` glue, which is
 * JavaScript by nature (`Request`/`fetch` objects cannot cross the FFI).
 */

type ProviderFetch = typeof globalThis.fetch;

export type JsonObject = { readonly [key: string]: unknown };

export interface ModelOptionValues {
  readonly reasoningLevel: string;
  readonly maxOutputTokens: number;
}

/** The compiled pair as the binary hands it over: JSON text in, patched text out. */
export interface CompiledModelOptionMaps {
  apply(bodyJson: string, valuesJson: string): string;
}

export interface RawRequestBodyCapture {
  body?: JsonObject;
}

export function createModelOptionMapFetch(input: {
  readonly capture?: RawRequestBodyCapture;
  readonly fetch: ProviderFetch;
  readonly maps: CompiledModelOptionMaps;
  readonly values: ModelOptionValues;
}): ProviderFetch {
  return async (request, init) => {
    const bodyText = await readRequestBody(request, init);
    if (bodyText === undefined) return input.fetch(request, init);
    // The native apply takes and returns the body as JSON text, so the normal
    // path pays neither a JS `JSON.parse` nor a re-stringify; only a capture
    // needs the object form back.
    const patchedBody = input.maps.apply(bodyText, JSON.stringify(input.values));
    if (input.capture) input.capture.body = parseJsonObject(patchedBody);
    if (request instanceof Request) {
      return input.fetch(new Request(request, { ...init, body: patchedBody }));
    }
    return input.fetch(request, { ...init, body: patchedBody });
  };
}

async function readRequestBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  // Option Map is the only request field authority for reasoning/max-output. If the SDK is changed to non-text Body, it will be silent.
  // Skipping the Patch, the request will still be issued but two Option will be lost; therefore, it must fail-closed when there is a Body.
  if (init?.body !== undefined && init.body !== null) {
    throw new Error("Model option maps require a JSON text request body.");
  }
  if (request instanceof Request) return request.clone().text();
  return undefined;
}

function parseJsonObject(body: string): JsonObject {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model option maps require a JSON object request body.");
  }
  return parsed as JsonObject;
}
