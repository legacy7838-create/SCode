import assert from "node:assert/strict";
import test from "node:test";
import {
  isOpencodeFreeProvider,
  isOpenCodeGoBaseUrl,
  isOpenCodeZenBaseUrl,
  toOpenCodeRequestId,
  toOpenCodeSessionId,
} from "../src/model/opencode-session.js";
import { createModelRequestAttributionHeaders } from "../src/model/runner-attribution.js";

/**
 * The Zen free-lane gate only accepts canonical `ses_`/`msg_` identifiers, and the free quota is
 * accounted per session: a fresh id per request would burn it, while a translated id keeps one
 * stable upstream identity per conversation.
 */

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function makeStatusContext(overrides: Record<string, unknown> = {}) {
  // Only the identity fields (baseURL/sessionId/requestId) participate in the OpenCode decision.
  return {
    traceId: "trace_1",
    requestId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    providerId: "opencode-free",
    modelId: "space-bunny-free",
    modelRequestSessionType: "main",
    transport: "sdk",
    maxAttempts: 1,
    ...overrides,
  } as Parameters<typeof createModelRequestAttributionHeaders>[0];
}

test("session ids are canonical, deterministic and conversation-stable", () => {
  const first = toOpenCodeSessionId("sess_conversation_a");
  const second = toOpenCodeSessionId("sess_conversation_a");
  assert.match(first, SESSION_RE);
  assert.equal(first.length, 30);
  assert.equal(first, second, "the same conversation must reuse one upstream session");
  assert.notEqual(first, toOpenCodeSessionId("sess_conversation_b"));
  assert.notEqual(first, toOpenCodeSessionId(undefined));
});

test("a canonical session id passes through unchanged", () => {
  const canonical = "ses_5f3a9c1b2d4eAbCdEfGhIjKlMn";
  assert.match(canonical, SESSION_RE);
  assert.equal(toOpenCodeSessionId(canonical), canonical);
});

test("a session-less request stays process-stable instead of minting a new session", () => {
  assert.equal(toOpenCodeSessionId(undefined), toOpenCodeSessionId(undefined));
  assert.equal(toOpenCodeSessionId("   "), toOpenCodeSessionId(undefined));
});

test("request ids are canonical and stable for the same round", () => {
  const id = toOpenCodeRequestId("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  assert.match(id, REQUEST_RE);
  assert.equal(id.length, 30);
  assert.equal(id, toOpenCodeRequestId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"));
  assert.notEqual(id, toOpenCodeRequestId("7c9e6679-7425-40de-944b-e07fc1f90ae7"));
});

test("the free lane is recognized by the Zen root plus the anonymous credential", () => {
  assert.equal(
    isOpencodeFreeProvider({ baseURL: "https://opencode.ai/zen/v1", apiKey: "public" }),
    true,
  );
  assert.equal(
    isOpencodeFreeProvider({ baseURL: "https://opencode.ai/zen/v1", apiKey: "sk-real" }),
    false,
    "the keyed zen providers must keep their untouched request path",
  );
  assert.equal(
    isOpencodeFreeProvider({ baseURL: "https://opencode.ai/zen/go/v1", apiKey: "public" }),
    false,
  );
  assert.equal(
    isOpencodeFreeProvider({ baseURL: "https://api.anthropic.com/v1", apiKey: "public" }),
    false,
  );
  assert.equal(isOpenCodeZenBaseUrl("https://opencode.ai/zen/v1"), true);
  assert.equal(isOpenCodeZenBaseUrl("https://opencode.ai/zen/v1/"), true);
  assert.equal(isOpenCodeZenBaseUrl("https://opencode.ai/zen/go/v1"), false);
  assert.equal(isOpenCodeGoBaseUrl("https://opencode.ai/zen/go/v1"), true);
});

test("attribution sends canonical identity headers to the Zen free lane", () => {
  const headers = createModelRequestAttributionHeaders(
    makeStatusContext({
      baseURL: "https://opencode.ai/zen/v1",
      sessionId: "sess_conversation_a",
    }),
  );
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  assert.match(headers["x-opencode-request"] ?? "", REQUEST_RE);
  assert.equal(
    headers["x-opencode-session"],
    createModelRequestAttributionHeaders(
      makeStatusContext({
        baseURL: "https://opencode.ai/zen/v1",
        sessionId: "sess_conversation_a",
      }),
    )["x-opencode-session"],
    "a retry of the same conversation must keep the same upstream session",
  );
});

test("attribution keeps the conversation id for the keyed Go lane", () => {
  const headers = createModelRequestAttributionHeaders(
    makeStatusContext({
      baseURL: "https://opencode.ai/zen/go/v1",
      sessionId: "sess_conversation_a",
    }),
  );
  // The internal `sess_` prefix is stripped at the header boundary, and the Go lane keeps receiving
  // that value unchanged (no canonical translation, no request id).
  assert.equal(headers["x-opencode-session"], "conversation_a");
  assert.equal(headers["x-opencode-request"], undefined, "the Go lane sends no request id");
});

test("attribution sends no OpenCode headers to unrelated providers", () => {
  const headers = createModelRequestAttributionHeaders(
    makeStatusContext({
      baseURL: "https://api.anthropic.com/v1",
      sessionId: "sess_conversation_a",
    }),
  );
  assert.equal(headers["x-opencode-session"], undefined);
  assert.equal(headers["x-opencode-request"], undefined);
});
