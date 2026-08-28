import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatCompatibilityAttempts,
  chatCompletionToResponse,
  createCodexChatProxyServer,
  translateResponsesRequest,
} from "../patches/server/codex-chat-proxy.js";

async function startProxy(fetchImpl) {
  const profile = {
    id: "test",
    name: "Test Provider",
    baseUrl: "https://provider.example/v1",
    apiKey: "test-secret",
    wireApi: "chat",
  };
  const server = createCodexChatProxyServer({ fetchImpl, profileLoader: () => profile });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("custom Responses tools keep custom_tool_call type and ctc id prefix after Chat fallback", () => {
  const request = {
    model: "test-model",
    input: [{
      type: "additional_tools",
      tools: [{
        type: "custom",
        name: "shell",
        description: "Run a shell command",
      }],
    }],
  };
  const translated = translateResponsesRequest(request);
  const response = chatCompletionToResponse({
    id: "chatcmpl-test",
    model: "test-model",
    choices: [{
      message: {
        tool_calls: [{
          id: "call_shell",
          type: "function",
          function: {
            name: "shell",
            arguments: JSON.stringify({ input: "pwd" }),
          },
        }],
      },
    }],
  }, request, translated.toolMapping);

  const [item] = response.output;
  assert.equal(item.type, "custom_tool_call");
  assert.match(item.id, /^ctc_/u);
  assert.equal(item.name, "shell");
  assert.equal(item.input, "pwd");
  assert.equal(item.call_id, "call_shell");
});

test("named Responses tool choice maps to the translated Chat function name", () => {
  const translated = translateResponsesRequest({
    model: "test-model",
    input: "run pwd",
    tools: [{ type: "custom", name: "shell.exec" }],
    tool_choice: { type: "custom", name: "shell.exec" },
  });

  assert.deepEqual(translated.payload.tool_choice, {
    type: "function",
    function: { name: "shell_exec" },
  });
});

test("Chat length termination becomes an incomplete Responses result", () => {
  const request = { model: "test-model", input: "test" };
  const translated = translateResponsesRequest(request);
  const response = chatCompletionToResponse({
    id: "chatcmpl-length",
    model: "test-model",
    choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
  }, request, translated.toolMapping);

  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
});

test("Chat compatibility forwards only a Codex-compatible client identity", async () => {
  let upstream;
  const proxy = await startProxy(async (url, options) => {
    upstream = { url, options };
    return new Response(JSON.stringify({
      id: "chatcmpl-test",
      model: "glm-5.3",
      choices: [{ message: { role: "assistant", content: "PASEO_TEST_OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "codex_cli_rs/test-suite",
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
      },
      body: JSON.stringify({ model: "glm-5.3", input: "test", stream: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.url, "https://provider.example/v1/chat/completions");
    assert.equal(upstream.options.headers["user-agent"], "codex_cli_rs/test-suite");
    assert.equal(upstream.options.headers["x-codex-turn-metadata"], undefined);
    assert.equal(upstream.options.headers.authorization, "Bearer test-secret");
  }
  finally {
    await proxy.close();
  }
});

test("proxied model discovery uses a Codex-compatible client identity", async () => {
  let upstream;
  const proxy = await startProxy(async (url, options) => {
    upstream = { url, options };
    return new Response(JSON.stringify({ data: [{ id: "glm-5.3" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/models`, {
      headers: { "user-agent": "codex_cli_rs/test-suite" },
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.url, "https://provider.example/v1/models");
    assert.equal(upstream.options.headers["user-agent"], "codex_cli_rs/test-suite");
    assert.equal(upstream.options.headers.authorization, "Bearer test-secret");
  }
  finally {
    await proxy.close();
  }
});

test("Chat compatibility keeps upstream streaming enabled and accepts Chat SSE", async () => {
  let upstreamBody;
  const proxy = await startProxy(async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    const chunks = [
      "data: {\"id\":\"chatcmpl-stream\",\"model\":\"glm-5.3\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"PASEO_\"}}]}\n\n",
      "data: {\"id\":\"chatcmpl-stream\",\"model\":\"glm-5.3\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"STREAM_OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
      "data: [DONE]\n\n",
    ];
    return new Response(chunks.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", input: "test", stream: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(upstreamBody.stream, true);
    assert.match(text, /PASEO_STREAM_OK/u);
    assert.match(text, /response\.completed/u);
  }
  finally {
    await proxy.close();
  }
});

test("Responses requests default to buffered JSON when stream is omitted", async () => {
  let upstreamBody;
  const proxy = await startProxy(async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: "chatcmpl-default-buffered",
      model: "glm-5.3",
      choices: [{ message: { role: "assistant", content: "PASEO_DEFAULT_BUFFERED_OK" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", input: "test" }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(upstreamBody.stream, false);
    assert.equal(body.object, "response");
    assert.match(JSON.stringify(body), /PASEO_DEFAULT_BUFFERED_OK/u);
  }
  finally {
    await proxy.close();
  }
});

test("Chat SSE tool-call fragments are reconstructed for Responses clients", async () => {
  const proxy = await startProxy(async () => new Response([
    "data: {\"id\":\"chatcmpl-tools\",\"model\":\"glm-5.3\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_shell\",\"type\":\"function\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"input\\\":\\\"pw\"}}]}}]}\n\n",
    "data: {\"id\":\"chatcmpl-tools\",\"model\":\"glm-5.3\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"d\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
    "data: [DONE]\n\n",
  ].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }));
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3",
        input: "run pwd",
        stream: false,
        tools: [{ type: "custom", name: "shell" }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.output[0].type, "custom_tool_call");
    assert.equal(body.output[0].call_id, "call_shell");
    assert.equal(body.output[0].input, "pwd");
  }
  finally {
    await proxy.close();
  }
});

test("Chat compatibility attempts progressively remove optional unsupported fields", () => {
  const attempts = buildChatCompatibilityAttempts({
    model: "glm-5.3",
    messages: [{ role: "user", content: "test" }],
    stream: true,
    reasoning_effort: "max",
    response_format: { type: "json_object" },
    parallel_tool_calls: true,
    temperature: 0.4,
    top_p: 0.9,
    max_completion_tokens: 128,
    tools: [{
      type: "function",
      function: {
        name: "shell",
        strict: true,
        parameters: { type: "object", properties: {} },
      },
    }],
  });

  assert.deepEqual(attempts[0], {
    model: "glm-5.3",
    messages: [{ role: "user", content: "test" }],
    stream: true,
    reasoning_effort: "max",
    response_format: { type: "json_object" },
    parallel_tool_calls: true,
    temperature: 0.4,
    top_p: 0.9,
    max_completion_tokens: 128,
    tools: [{
      type: "function",
      function: {
        name: "shell",
        strict: true,
        parameters: { type: "object", properties: {} },
      },
    }],
  });
  assert.deepEqual(attempts[1], { ...attempts[0], stream: false });
  assert.ok(attempts.some((attempt) => attempt.reasoning_effort === undefined));
  assert.ok(attempts.some((attempt) => attempt.response_format === undefined && attempt.parallel_tool_calls === undefined));
  assert.ok(attempts.some((attempt) => attempt.tools?.[0]?.function?.strict === undefined));
  assert.ok(attempts.some((attempt) => attempt.temperature === undefined && attempt.top_p === undefined));
  assert.ok(attempts.some((attempt) => attempt.max_tokens === 128 && attempt.max_completion_tokens === undefined));
  assert.ok(attempts.some((attempt) => attempt.max_tokens === undefined && attempt.max_completion_tokens === undefined));
  assert.equal(attempts.at(-1).stream, false);
});

test("Chat compatibility falls back to a buffered request when the provider rejects streaming", async () => {
  const seen = [];
  const proxy = await startProxy(async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.stream);
    if (body.stream === true) {
      return new Response(JSON.stringify({ error: { message: "stream is unsupported" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      id: "chatcmpl-buffered",
      model: "glm-5.3",
      choices: [{ message: { role: "assistant", content: "PASEO_BUFFERED_STREAM_OK" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", input: "test", stream: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [true, false]);
    assert.match(text, /PASEO_BUFFERED_STREAM_OK/u);
    assert.match(text, /response\.completed/u);
  }
  finally {
    await proxy.close();
  }
});

test("stream fallback preserves output constraints before degrading optional fields", async () => {
  const seen = [];
  const proxy = await startProxy(async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body);
    if (body.stream === true) {
      return new Response(JSON.stringify({ error: { message: "stream is unsupported" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      id: "chatcmpl-constrained",
      model: "glm-5.3",
      choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3",
        input: "test",
        stream: true,
        max_output_tokens: 128,
        text: { format: { type: "json_object" } },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].stream, false);
    assert.equal(seen[1].max_completion_tokens, 128);
    assert.deepEqual(seen[1].response_format, { type: "json_object" });
  }
  finally {
    await proxy.close();
  }
});

test("an SSE error event retries through the next Chat compatibility attempt", async () => {
  const seen = [];
  const proxy = await startProxy(async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.stream);
    if (body.stream === true) {
      return new Response("data: {\"error\":{\"message\":\"stream is unsupported\"}}\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({
      id: "chatcmpl-sse-retry",
      model: "glm-5.3",
      choices: [{ message: { role: "assistant", content: "PASEO_SSE_RETRY_OK" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", input: "test", stream: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [true, false]);
    assert.match(text, /PASEO_SSE_RETRY_OK/u);
  }
  finally {
    await proxy.close();
  }
});

test("Chat-only profiles compact through Chat compatibility instead of /responses/compact", async () => {
  const seen = [];
  const proxy = await startProxy(async (url) => {
    seen.push(new URL(url).pathname);
    return new Response(JSON.stringify({
      id: "chatcmpl-compact",
      model: "glm-5.3",
      choices: [{ message: { role: "assistant", content: "PASEO_COMPACT_OK" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", input: "compact this", stream: false }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ["/v1/chat/completions"]);
    assert.match(JSON.stringify(body), /PASEO_COMPACT_OK/u);
  }
  finally {
    await proxy.close();
  }
});

test("Chat SSE output reaches the Responses client before the upstream stream closes", async () => {
  const encoder = new TextEncoder();
  let release;
  let released = false;
  const proxy = await startProxy(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"id\":\"chatcmpl-live\",\"model\":\"glm-5.3\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"PASEO_INCREMENTAL_OK\"}}]}\n\n"));
      release = () => {
        if (released) return;
        released = true;
        controller.enqueue(encoder.encode("data: {\"id\":\"chatcmpl-live\",\"model\":\"glm-5.3\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"));
        controller.close();
      };
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", input: "test", stream: true }),
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    let received = "";
    while (!received.includes("PASEO_INCREMENTAL_OK")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    clearTimeout(timeout);
    assert.match(received, /PASEO_INCREMENTAL_OK/u);
    release();
    while (!(await reader.read()).done) { /* drain */ }
  }
  finally {
    release?.();
    await proxy.close();
  }
});
