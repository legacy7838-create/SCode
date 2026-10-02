# OpenCode Free provider

## Goal

Add "OpenCode Free" Model Providers to ZCode that call the OpenCode Zen anonymous free lane
(`https://opencode.ai/zen/v1`) with the same client identity 9Router uses, with the API key
hardcoded to `public` and no API-key input offered to the user.

This spec is the behavior contract. It records the upstream gates as observed facts, names the owner
of every new piece of state, and lists the deliberate deviations from 9Router.

## Upstream facts (live probes, 2026-10-01 and 2026-10-02)

Endpoint base: `https://opencode.ai/zen/v1`. Auth: `Authorization: Bearer public` (the official
OpenCode client itself falls back to `apiKey = "public"` when no account/key is configured —
`anomalyco/opencode` `packages/core/src/plugin/provider/opencode.ts`).

The anonymous free lane is **per-model and per-wire-shape**: the fingerprint quartet must be sent in
the shape of the lane (Claude `{name,...}` vs OpenAI `{type:"function", function:{name,...}}`).

Chat lane (`POST /chat/completions`, OpenAI function quartet, `stream:true`) — 2026-10-02:

| Model                                 | Result                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `big-pickle`                          | **200**                                                                              |
| `space-bunny-free`                    | **200**                                                                              |
| `fledge-alpha-free`                   | **200**                                                                              |
| `mimo-v2.5-free`                      | **200**                                                                              |
| `mimo-v2.6-flash-free`                | **200**                                                                              |
| `nemotron-3-ultra-free`               | **200**                                                                              |
| `nemotron-3.5-lightning-free`         | **200**                                                                              |
| `longcat-2.5-preview-free`            | **200**                                                                              |
| `ling-3.0-flash-fin-free`             | **400** "Endpoint is unavailable" (dead upstream)                                    |
| `deepseek-v4-flash-free`              | **400** "Model is unavailable" (dead upstream)                                       |
| `muse-spark-1.2/1.3-contributor-free` | **500** (Responses-lane only)                                                        |
| `jev-1.13-free`                       | **500** (SystemOne lane, unsupported by ZCode)                                       |
| same ids **without** the quartet      | **403** `FreeTierError` "OpenCode's free tier can only be used from within OpenCode" |

Anthropic lane (`POST /messages`, Claude quartet, `stream:true`) — 2026-10-01/02:

| Model                               | Result                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `space-bunny-free`                  | **200** (stream, non-stream, with `thinking`, `cache_control`, `x-api-key: public`) |
| `fledge-alpha-free`                 | **500** (Chat/OpenAI-lane model)                                                    |
| `muse-spark-*-free` on `/responses` | **403** Console gate                                                                |
| `union-alpha`                       | **401** "Model union-alpha is not supported"                                        |
| `deepseek-v4-flash-free`            | **400** upstream                                                                    |
| `/zen/go/v1/*`                      | **401** "Missing API key" (paid subscription lane)                                  |

The gate messages match 9Router's open issues (`decolua/9router` #4101, #4124, #4127, #4183).
Therefore each shipped template lists only ids that verified 200 anonymously **on that template's
lane**.

### Client identity gates (9Router's live bisection, Sep 17-18 2026, re-confirmed on our probes)

1. `User-Agent` must parse as `opencode/<version>` with version >= 1.17 (`426` below, `403` for a
   bare or third-party UA). Gate-compatible value:
   `opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`.
2. `x-opencode-session` must match `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` (30 chars). Missing or
   non-canonical values are rejected.
3. Tool-signature gate: fewer than four tools or wrong names are rejected with 403; the fingerprint
   quartet `{bash, glob, grep, read}` passes. Extra tools are allowed, duplicates
   (`Bash` + `bash`) are rejected. The quartet must be in the lane's tool shape.
4. Streaming gate: `stream: false` was rejected for Console models in the September bisection.

Gates 1-2 are cheap to satisfy unconditionally, so they are always sent. Gate 3 is implemented as a
request/response tool-name cloak (see below). Gate 4 is **not** implemented — see Deviations.

## Deviations from 9Router

| 9Router behavior                                                                      | ZCode                                                                             | Reason                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always forces `stream: true` upstream and converts SSE to JSON for non-stream callers | Not implemented                                                                   | Non-stream is accepted today: `stream:false` returned 200 on both lanes (verified twice). ZCode's `generateText` flows (title generation, memory, verification, webfetch) require plain JSON, and an SSE aggregator would be a second response pipeline to keep correct. Re-evaluate when gate 4 is observable again. |
| Session identity kept in a per-identity in-memory map with TTL                        | Deterministic translation of the ZCode session id, with a process-stable fallback | Same externally visible contract (one stable canonical session per conversation, never a new session per request) without owning a second session store.                                                                                                                                                              |

## Provider config (data)

Owner: `config/provider/zcode-builtin.json` (revision bumped on every content change — binaries and
config must ship together, see "Release invariant").

Two templates, both pinning `{ "type": "api-key", "apiKey": "public", "apiKeyEditable": false }`:

| Template                                              | `api.type`                | Models                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode-free` (display "OpenCode Free (Anthropic)") | `anthropic-messages`      | `space-bunny-free`                                                                                                                                                                  |
| `opencode-free-chat` (display "OpenCode Free (Chat)") | `openai-chat-completions` | `big-pickle`, `space-bunny-free`, `fledge-alpha-free`, `mimo-v2.5-free`, `mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `longcat-2.5-preview-free` |

- `api.baseUrl`: `https://opencode.ai/zen/v1` for both.
- `api.headers`: gate 1 (`User-Agent`), `x-opencode-client: desktop`, `x-opencode-project: global`.
  Static values belong to config; per-request values belong to the attribution layer below.
- `apiKeyEditable: false` removes the API-key field from the settings UI (no input offered).

Each lane only lists ids verified 200 **on that lane**. Excluded on purpose: `jev-1.13-free`
(SystemOne lane, no ZCode transport), `muse-spark-*-contributor-free` (Responses lane + Console gate),
`deepseek-v4-flash-free` and `ling-3.0-flash-fin-free` (dead upstream, 400).

### Release invariant

The builtin config carries schema-backed fields (`apiKeyEditable`, literal `apiKey: "public"`).
A binary built from an older schema rejects the newer config outright
(`AggregateError: Both the Bundled and Active ZCode Built-in Release are unavailable` — observed
when a Sep-29 CLI build met revision 31 in the shared data dir). Config and binaries must always be
rebuilt together.

### Reasoning override (Anthropic lane only)

`modelApiRules` gains a trailing rule for `space-bunny-free` + `anthropic-messages` that overrides
`optionSpecs.reasoningLevel.map`:

- `reasoningLevel == "disabled"` -> `{ "thinking": null }` (merge-patch deletes the key)
- otherwise -> `{ "thinking": { "type": "adaptive" }, "output_config": { "effort": ... } }`

Reason: the generic Anthropic rule sends `{"thinking": {"type":"disabled"}}` when the level is
`disabled`, and the OpenCode gateway rejects that body with `400 invalid_request_error` (verified).
Rules overlay in array order, so this rule must stay **after** the generic `.*` rule; the test
asserts the ordering.

The chat lane needs no override: the generic `openai-chat-completions` rule's body
(`thinking`/`enable_thinking`/`reasoning_effort`/`reasoning`, both disabled and enabled values) was
verified 200 against the lane (2026-10-02).

## Request identity (code)

Owner: `apps/zcode-cli/packages/adapters/src/model/runner-attribution.ts`, helper module
`opencode-session.ts`.

`createModelRequestAttributionHeaders(statusContext)` already decides per-request headers and is
merged after the Provider's static headers for both `generateText` and `streamText`. For a base URL
of the OpenCode Zen root (`/zen/v1`) it now adds:

- `x-opencode-session`: the ZCode conversation session id translated to the canonical `ses_` shape.
  Same input conversation -> same value (deterministic SHA-256 based translation), so upstream quota
  and prompt cache stay attached to the conversation instead of being burned per request. Already
  canonical values pass through unchanged.
- `x-opencode-request`: the stable per-request `statusContext.requestId` translated to the canonical
  `msg_` shape. The ZCode request id is reused across retries of the same round, which matches
  9Router's "same id on retry" rule.
- When no session id exists (sidecar flows), a process-stable canonical session is used; a request
  must never mint a fresh session.

The OpenCode **Go** behavior (`/zen/go/v1`, raw session value) is unchanged; only `/zen/v1` is
treated as the free lane.

## Tool fingerprint cloak (code)

Owner: `apps/zcode-cli/packages/adapters/src/model/opencode-free-fetch.ts`, a fetch wrapper applied
in `model-execution.ts` to both the `anthropic` and `openai-compatible` factories **only** when
`isOpencodeFreeProvider` (Zen base URL + `apiKey === "public"`); the keyed `opencode-zen-*`
providers keep their untouched request path.

Both wire shapes are handled — Anthropic (`{name, description, input_schema}` and
`content_block_start`/`content[].tool_use`) and OpenAI (`{type:"function", function:{name,...}}` and
`choices[].delta|message.tool_calls[].function.name`).

Request side, invariants:

1. Case variants of the quartet (`Bash`/`bash`, ...) are renamed to the canonical lowercase name and
   duplicates are removed — upstream rejects a duplicate pair.
2. Missing quartet members are injected with an "unavailable" description in the caller's wire shape
   so the tool signature always holds; injected members are never presented as callable originals.
3. An explicit `tool_choice` naming a renamed member (top-level `name` or nested `function.name`) is
   retargeted to the canonical name.
4. Tools outside the quartet are passed through verbatim.
5. The request-local rename map (sent name -> caller name) is carried to the response transform;
   no state lives on the executor.

Response side, invariants:

1. Renamed tool names are restored to the caller's spelling for both shapes, so ZCode keeps
   resolving its own `Bash`/`Read`/`Glob`/`Grep` tools.
2. Names that were only injected have no original and are left as-is (the caller never offered them).
3. Non-tool payloads keep their meaning: only tool _declarations_ are touched, tool _inputs_ and
   text are never rewritten (SSE frames are re-serialized without semantic change).

## UI contract

Owner: `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx` plus the
access schema in `packages/provider`.

`apiKeyEditable: false` (optional, default absent = editable) hides the API-key section. Everything
else about the provider card (name, endpoint, models, enable/disable) stays as for other API-key
providers. The field is part of the strict access schema, so it survives template resolution,
overlay, serialization and settings sync without a parallel code path.

## Acceptance scenarios

1. Settings -> Add provider -> either OpenCode Free template creates a ready-to-use provider with no
   API key prompt; the card shows no API-key field; `apiKey` resolves to `public`.
2. A chat turn sends `Authorization: Bearer public`, the gate-compatible `User-Agent`,
   `x-opencode-client`, `x-opencode-project`, a canonical `x-opencode-session` stable for the
   conversation, and a canonical `x-opencode-request` stable across retries.
3. The request body carries `tools` containing the lowercase quartet once, in the lane's shape, and
   (Anthropic lane) never carries `thinking: {"type":"disabled"}`.
4. A streamed tool call named `bash` on the wire reaches the core as `Bash` on **both** lanes
   (Anthropic `tool_use` and OpenAI `tool_calls`).
5. A non-stream (`generateText`) call succeeds and is not rewritten.
6. `fledge-alpha-free` (chat lane) works end to end — live proof: cloak sent
   `bash,read,glob,grep` + retargeted `tool_choice`, upstream returned `200` with `[DONE]`.
7. `opencode-zen-*` (keyed) and `opencode-go-*` providers keep byte-identical request behavior.

## Out of scope / retrigger conditions

- The Responses lane (`muse-spark-*-contributor-free`) and the SystemOne lane (`jev-1.13-free`) have
  no transport in ZCode.
- Console/login-walled models are re-verified before being added; the dead ids
  (`deepseek-v4-flash-free`, `ling-3.0-flash-fin-free`) stay out.
- Non-stream -> stream forcing is deliberately absent (see Deviations).
