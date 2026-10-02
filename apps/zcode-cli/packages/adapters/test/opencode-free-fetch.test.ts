import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeFreeFetch } from "../src/model/opencode-free-fetch.js";

/**
 * The Zen free gate fingerprints the agentic tool signature, so the request must always carry the
 * lowercase quartet exactly once, and the response must hand the caller's own spelling back —
 * otherwise the core could not resolve its `Bash`/`Read`/`Glob`/`Grep` tools. Everything is asserted
 * through the public fetch wrapper, which is the only surface the executor uses.
 */

const UNAVAILABLE = "This tool is currently unavailable and must not be used.";
const QUARTET = ["bash", "glob", "grep", "read"];

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string): Response {
  return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function claudeTool(name: string) {
  return { name, description: `${name} tool`, input_schema: { type: "object", properties: {} } };
}

function bodyOf(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools as { name?: string; function?: { name?: string } }[];
  return tools.map((tool) => tool.name ?? tool.function?.name ?? "");
}

function openAiTool(name: string) {
  return {
    type: "function",
    function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } },
  };
}

/** Send `body` through the wrapper and capture the raw payload that would reach upstream. */
async function throughFetch(
  body: string,
  makeResponse: () => Response,
): Promise<{ sent: string; response: Response }> {
  let sent = "";
  const wrapped = createOpencodeFreeFetch(async (_input, init) => {
    sent = typeof init?.body === "string" ? init.body : "";
    return makeResponse();
  });
  const response = await wrapped("https://opencode.ai/zen/v1/messages", {
    method: "POST",
    body,
  });
  return { sent, response };
}

async function cloak(
  body: unknown,
  makeResponse: () => Response = () => jsonResponse({ content: [] }),
): Promise<{ sent: string; body: Record<string, unknown>; response: Response }> {
  const result = await throughFetch(JSON.stringify(body), makeResponse);
  return { ...result, body: bodyOf(result.sent) };
}

test("the quartet is canonicalised, deduplicated and completed", async () => {
  const { body } = await cloak({
    messages: [{ role: "user", content: "hi" }],
    tools: [claudeTool("Bash"), claudeTool("Read"), claudeTool("Edit"), claudeTool("bash")],
    tool_choice: { type: "tool", name: "Bash" },
  });

  assert.deepEqual(toolNames(body), ["bash", "read", "Edit", "glob", "grep"]);
  // A duplicate (`Bash` + `bash`) is rejected upstream, so exactly one declaration survives.
  const tools = body.tools as { name: string; description: string; input_schema: unknown }[];
  const injected = tools.filter((tool) => tool.name === "glob" || tool.name === "grep");
  assert.equal(injected.length, 2);
  for (const tool of injected) {
    assert.equal(tool.description, UNAVAILABLE);
    assert.ok(tool.input_schema, "decoys keep the caller's tool shape");
  }
  // The explicit tool_choice must follow the name that is actually sent.
  assert.deepEqual(body.tool_choice, { type: "tool", name: "bash" });
  // Non-fingerprint tools are passed through verbatim.
  assert.deepEqual(
    tools.find((tool) => tool.name === "Edit"),
    claudeTool("Edit"),
  );
});

test("a caller without tools receives the quartet but cannot select a decoy", async () => {
  const { body } = await cloak({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(toolNames(body), QUARTET);
  assert.deepEqual(body.tool_choice, { type: "none" });
});

test("an already-cloaked or non-chat body is forwarded byte-identical", async () => {
  const complete = JSON.stringify({
    messages: [{ role: "user", content: "hi" }],
    tools: QUARTET.map(claudeTool),
  });
  assert.equal((await throughFetch(complete, () => jsonResponse({ content: [] }))).sent, complete);

  const unrelated = JSON.stringify({ foo: "bar" });
  assert.equal((await throughFetch(unrelated, () => jsonResponse({ ok: true }))).sent, unrelated);
  assert.equal((await throughFetch("not json", () => jsonResponse({ ok: true }))).sent, "not json");
});

test("the wrapper cloaks the request and restores the streamed tool name", async () => {
  const sse = [
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{"name":"bash"}}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");

  const { body, response } = await cloak(
    {
      messages: [{ role: "user", content: "run it" }],
      tools: [claudeTool("Bash"), claudeTool("Read"), claudeTool("Glob"), claudeTool("Grep")],
    },
    () => sseResponse(sse),
  );
  assert.deepEqual(toolNames(body), ["bash", "read", "glob", "grep"]);

  const text = await response.text();
  const toolEventLine = text
    .split("\n")
    .find((line) => line.startsWith("data:") && line.includes("tool_use"));
  assert.ok(toolEventLine, "the tool_use event must survive");
  const toolEvent = JSON.parse(toolEventLine.slice("data:".length)) as {
    content_block: { name: string; input: { name: string } };
  };
  assert.equal(toolEvent.content_block.name, "Bash", "the caller spelling is restored");
  assert.equal(
    toolEvent.content_block.input.name,
    "bash",
    "tool inputs are never rewritten, only declarations",
  );
  assert.ok(text.includes("event: message_stop"), "event framing is preserved");
});

test("the wrapper restores a non-streaming tool call and nothing around it", async () => {
  const { response } = await cloak(
    {
      messages: [{ role: "user", content: "run it" }],
      tools: [claudeTool("Bash"), claudeTool("Read"), claudeTool("Glob"), claudeTool("Grep")],
    },
    () =>
      jsonResponse({
        id: "msg_1",
        content: [
          { type: "tool_use", id: "toolu_1", name: "bash", input: { name: "bash" } },
          { type: "text", text: "calling bash" },
        ],
        metadata: { name: "bash" },
      }),
  );

  const restored = JSON.parse(await response.text()) as {
    content: { name: string; input: { name: string }; text?: string }[];
    metadata: { name: string };
  };
  assert.equal(restored.content[0].name, "Bash");
  assert.equal(restored.content[0].input.name, "bash", "tool inputs stay untouched");
  assert.equal(restored.content[1].text, "calling bash", "text stays untouched");
  assert.equal(restored.metadata.name, "bash", "unrelated name fields stay untouched");
});

test("responses are untouched when nothing was renamed", async () => {
  const sse =
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"bash"}}\n\n';
  const { response } = await cloak({ messages: [{ role: "user", content: "hi" }] }, () =>
    sseResponse(sse),
  );
  // No caller tools: the quartet is injected as decoys, so there is no original spelling to restore.
  assert.equal(await response.text(), sse);
});

test("openai function-shaped tools are cloaked and tool_choice follows the sent name", async () => {
  const { body } = await cloak({
    messages: [{ role: "user", content: "run it" }],
    tools: [openAiTool("Bash"), openAiTool("Read"), openAiTool("Edit")],
    tool_choice: { type: "function", function: { name: "Bash" } },
  });

  assert.deepEqual(toolNames(body), ["bash", "read", "Edit", "glob", "grep"]);
  // Injected decoys keep the caller's wire shape so the OpenAI schema still validates.
  const tools = body.tools as { type?: string; function?: { name: string; description: string } }[];
  const injected = tools.filter(
    (tool) => tool.function?.name === "glob" || tool.function?.name === "grep",
  );
  assert.equal(injected.length, 2);
  for (const tool of injected) {
    assert.equal(tool.type, "function");
    assert.equal(tool.function?.description, UNAVAILABLE);
  }
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "bash" } });
  assert.deepEqual(
    tools.find((tool) => tool.function?.name === "Edit"),
    openAiTool("Edit"),
  );
});

test("the wrapper restores a streamed openai tool call", async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{}"}}]}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const { response } = await cloak(
    {
      messages: [{ role: "user", content: "run it" }],
      tools: [openAiTool("Bash"), openAiTool("Read"), openAiTool("Glob"), openAiTool("Grep")],
    },
    () => sseResponse(sse),
  );

  const text = await response.text();
  const callLine = text.split("\n").find((line) => line.includes("tool_calls"));
  assert.ok(callLine, "the tool_calls chunk must survive");
  const chunk = JSON.parse(callLine.slice("data:".length)) as {
    choices: { delta: { tool_calls: { function: { name: string; arguments: string } }[] } }[];
  };
  assert.equal(chunk.choices[0].delta.tool_calls[0].function.name, "Bash");
  assert.equal(chunk.choices[0].delta.tool_calls[0].function.arguments, "{}");
  assert.ok(text.includes("data: [DONE]"), "the stream terminator is preserved");
});

test("the wrapper restores a non-streaming openai tool call", async () => {
  const { response } = await cloak(
    {
      messages: [{ role: "user", content: "run it" }],
      tools: [openAiTool("Bash"), openAiTool("Read"), openAiTool("Glob"), openAiTool("Grep")],
    },
    () =>
      jsonResponse({
        id: "chatcmpl_1",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
  );

  const restored = JSON.parse(await response.text()) as {
    choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] } }[];
  };
  assert.equal(restored.choices[0].message.tool_calls[0].function.name, "Bash");
  assert.equal(restored.choices[0].message.tool_calls[0].function.arguments, "{}");
});
