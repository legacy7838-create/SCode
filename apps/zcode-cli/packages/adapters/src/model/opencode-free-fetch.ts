/**
 * OpenCode Zen free-lane tool-signature cloak (9Router parity).
 *
 * The anonymous free gate fingerprints the agentic tool signature: fewer than four tools or wrong
 * names are rejected with 403 FreeTierError, while the file-search quartet {bash, glob, grep, read}
 * passes (9Router issue #4101 live bisection, Sep 2026). ZCode declares its own tools as `Bash`,
 * `Read`, `Glob`, `Grep`, so the request side canonicalises the quartet to lowercase and injects any
 * missing member as an unavailable decoy. The response side maps the canonical names back to the
 * caller's spelling, otherwise the core could not resolve its own tools.
 *
 * Both ZCode wire shapes are handled: Anthropic (`tool_use` with top-level `name`) and
 * OpenAI-compatible (`tool_call` with nested `function.name`).
 *
 * The rename map lives inside one fetch invocation (request -> response); nothing is stored on the
 * executor, so concurrent requests cannot observe each other's identity.
 */

type ProviderFetch = typeof globalThis.fetch;

/** Canonical lowercase names required by the upstream free-tier gate. */
const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const;

const UNAVAILABLE_TOOL_DESCRIPTION = "This tool is currently unavailable and must not be used.";

interface CloakedOpenCodeBody {
  readonly text: string;
  /** canonical (sent) name -> caller's original name */
  readonly renameMap: ReadonlyMap<string, string>;
}

/** The fingerprint key for a quartet member in any casing, otherwise "". */
function fingerprintKey(name: unknown): string {
  if (typeof name !== "string") return "";
  const lower = name.trim().toLowerCase();
  return (OPENCODE_FINGERPRINT_TOOLS as readonly string[]).includes(lower) ? lower : "";
}

function parseChatBody(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const body = parsed as Record<string, unknown>;
    // Only chat payloads carry a tool list; anything else (health probes, errors) passes untouched.
    return Array.isArray(body.messages) || Array.isArray(body.input) ? body : undefined;
  } catch {
    return undefined;
  }
}

function hasOpenAIShape(tool: unknown): boolean {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
  const record = tool as Record<string, unknown>;
  return record.function !== undefined;
}

function readToolName(tool: unknown): string {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const record = tool as Record<string, unknown>;
  if (typeof record.name === "string") return record.name;
  const fn = record.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return "";
}

function renameTool(tool: unknown, name: string): unknown {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
  const record = tool as Record<string, unknown>;
  if (hasOpenAIShape(tool)) {
    return { ...record, function: { ...(record.function as Record<string, unknown>), name } };
  }
  return { ...record, name };
}

function makeUnavailableTool(name: string, openAICompatible: boolean): unknown {
  return openAICompatible
    ? {
        type: "function",
        function: {
          name,
          description: UNAVAILABLE_TOOL_DESCRIPTION,
          parameters: { type: "object", properties: {} },
        },
      }
    : {
        name,
        description: UNAVAILABLE_TOOL_DESCRIPTION,
        input_schema: { type: "object", properties: {} },
      };
}

/**
 * Canonicalise the quartet to lowercase, drop duplicate casings (`Bash` + `bash` is rejected
 * upstream) and append the missing members so the signature always holds.
 */
function rewriteFingerprintTools(callerTools: readonly unknown[]): {
  readonly tools: unknown[];
  readonly renameMap: Map<string, string>;
  readonly changed: boolean;
} {
  const renameMap = new Map<string, string>();
  const seen = new Set<string>();
  const tools: unknown[] = [];

  const openAICompatibleDecoys = callerTools.some(hasOpenAIShape);
  for (const tool of callerTools) {
    const original = readToolName(tool);
    const key = fingerprintKey(original);
    if (!key) {
      tools.push(tool);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === original) {
      tools.push(tool);
      continue;
    }
    renameMap.set(key, original);
    tools.push(renameTool(tool, key));
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (!seen.has(name)) tools.push(makeUnavailableTool(name, openAICompatibleDecoys));
  }
  return {
    tools,
    renameMap,
    changed: renameMap.size > 0 || tools.length !== callerTools.length,
  };
}

/** An explicit `tool_choice` naming a canonicalised member must follow the name actually sent. */
function retargetToolChoice(body: Record<string, unknown>): boolean {
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false;

  let changed = false;
  const record = choice as Record<string, unknown>;
  const direct = record.name;
  if (typeof direct === "string") {
    const key = fingerprintKey(direct);
    if (key && key !== direct) {
      record.name = key;
      changed = true;
    }
  }
  const fn = record.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const fnRecord = fn as Record<string, unknown>;
    const name = fnRecord.name;
    if (typeof name === "string") {
      const key = fingerprintKey(name);
      if (key && key !== name) {
        fnRecord.name = key;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Rewrite one request body so it always carries the fingerprint quartet exactly once.
 * Returns the input text untouched when nothing had to change.
 */
function cloakOpenCodeRequestBody(text: string): CloakedOpenCodeBody {
  const body = parseChatBody(text);
  if (!body) return { text, renameMap: new Map<string, string>() };

  const callerTools = Array.isArray(body.tools) ? body.tools : [];
  const rewritten = rewriteFingerprintTools(callerTools);
  body.tools = rewritten.tools;
  const choiceChanged = retargetToolChoice(body);

  // A caller that offered no tools must not be able to select an injected decoy.
  if (callerTools.length === 0 && body.tool_choice === undefined) {
    body.tool_choice = { type: "none" };
  }
  if (!rewritten.changed && !choiceChanged && callerTools.length > 0) {
    return { text, renameMap: rewritten.renameMap };
  }
  return { text: JSON.stringify(body), renameMap: rewritten.renameMap };
}

/**
 * Restore the caller's tool spelling in tool-bearing response payloads. Only the `tool_use`
 * declaration is touched, so a tool *input* containing a `name` field is never rewritten.
 */
function restoreOpenCodeToolNames(value: unknown, renameMap: ReadonlyMap<string, string>): unknown {
  if (renameMap.size === 0) return value;
  if (Array.isArray(value)) return value.map((item) => restoreOpenCodeToolNames(item, renameMap));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const name = record.name;
  if (record.type === "tool_use" && typeof name === "string" && renameMap.has(name)) {
    return { ...record, name: renameMap.get(name) };
  }
  const fn = record.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const fnRecord = fn as Record<string, unknown>;
    const fnName = fnRecord.name;
    if (typeof fnName === "string" && renameMap.has(fnName)) {
      return { ...record, function: { ...fnRecord, name: renameMap.get(fnName) } };
    }
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    next[key] = restoreOpenCodeToolNames(entry, renameMap);
  }
  return next;
}

function restoreSseText(text: string, renameMap: ReadonlyMap<string, string>): string {
  if (renameMap.size === 0 || !text.includes("data:")) return text;
  return text.replace(/(^|\n)data:([^\n]*)/g, (match, lineStart: string, payload: string) => {
    const trimmed = payload.startsWith(" ") ? payload.slice(1) : payload;
    if (!trimmed.trim().startsWith("{")) return match;
    try {
      return `${lineStart}data: ${JSON.stringify(restoreOpenCodeToolNames(JSON.parse(trimmed), renameMap))}`;
    } catch {
      return match;
    }
  });
}

function createRestoreTransform(
  renameMap: ReadonlyMap<string, string>,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const boundary = pending.lastIndexOf("\n");
      if (boundary === -1) return;
      controller.enqueue(encoder.encode(restoreSseText(pending.slice(0, boundary + 1), renameMap)));
      pending = pending.slice(boundary + 1);
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.length > 0) {
        controller.enqueue(encoder.encode(restoreSseText(pending, renameMap)));
      }
    },
  });
}

async function restoreOpenCodeResponse(
  response: Response,
  renameMap: ReadonlyMap<string, string>,
): Promise<Response> {
  if (renameMap.size === 0 || !response.ok || !response.body) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("event-stream")) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(response.body.pipeThrough(createRestoreTransform(renameMap)), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  if (!contentType.includes("json")) return response;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  const restored = restoreOpenCodeToolNames(parsed, renameMap);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(restored), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function readRequestBodyText(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  // Only a text body can be cloaked; a non-text body keeps the caller's payload untouched.
  if (init?.body !== undefined && init.body !== null) return undefined;
  if (request instanceof Request) return request.clone().text();
  return undefined;
}

/** Fetch wrapper applied to the OpenCode Free provider only; keyed Zen providers keep their path. */
export function createOpencodeFreeFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (request, init) => {
    const bodyText = await readRequestBodyText(request, init);
    const cloaked = bodyText === undefined ? undefined : cloakOpenCodeRequestBody(bodyText);
    if (!cloaked || cloaked.text === bodyText) {
      return baseFetch(request, init);
    }
    // Replace the body in place: a Request must be rebuilt, a plain init just gets the new string.
    const response =
      request instanceof Request
        ? await baseFetch(new Request(request, { ...init, body: cloaked.text }), undefined)
        : await baseFetch(request, { ...init, body: cloaked.text });
    return restoreOpenCodeResponse(response, cloaked.renameMap);
  };
}
