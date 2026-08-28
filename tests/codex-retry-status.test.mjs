import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithSqueezeRetry } from "../patches/server/codex-chat-proxy.js";
import {
  beginCodexRetryTrace,
  finishCodexRetryTrace,
  getCodexRetryStatus,
  resetCodexRetryStatusForTests,
  summarizeUpstreamText,
} from "../patches/server/codex-retry-status.js";

test("squeeze retry reports reconnect count and upstream response", async () => {
  resetCodexRetryStatusForTests();
  const trace = beginCodexRetryTrace({ profileName: "custom" });
  const responses = [
    new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
    new Response("ok", { status: 200 }),
  ];
  const profile = { busyRetryEnabled: true, baseUrl: "https://upstream.example/v1" };

  const result = await fetchWithSqueezeRetry(
    () => responses.shift(),
    profile,
    () => profile,
    { trace, stage: "Responses 主请求", endpoint: "/v1/responses" },
  );
  finishCodexRetryTrace(trace, { outcome: "success", status: result.response.status });
  const status = getCodexRetryStatus();

  assert.equal(result.response.status, 200);
  assert.equal(status.attempts, 2);
  assert.equal(status.reconnects, 1);
  assert.equal(status.lastFailure.httpStatus, 429);
  assert.equal(status.lastFailure.response, "rate limited");
  assert.equal(status.lastFailure.stage, "Responses 主请求");
  assert.equal(status.phase, "recovered");
});

test("squeeze retry reports the failing stage for network errors", async () => {
  resetCodexRetryStatusForTests();
  const trace = beginCodexRetryTrace({ profileName: "custom" });
  let calls = 0;
  const profile = { busyRetryEnabled: true, baseUrl: "https://upstream.example/v1" };

  const result = await fetchWithSqueezeRetry(
    () => {
      calls += 1;
      if (calls === 1) throw new Error("socket disconnected");
      return new Response("ok", { status: 200 });
    },
    profile,
    () => profile,
    { trace, stage: "Chat Completions 兼容请求", endpoint: "/v1/chat/completions" },
  );
  finishCodexRetryTrace(trace, { outcome: "success", status: result.response.status });
  const status = getCodexRetryStatus();

  assert.equal(status.reconnects, 1);
  assert.equal(status.lastFailure.error, "socket disconnected");
  assert.equal(status.lastFailure.stage, "Chat Completions 兼容请求");
});

test("retry diagnostics redact credentials echoed by an upstream error", () => {
  const summary = summarizeUpstreamText(JSON.stringify({
    error: { message: "authorization Bearer sk-live-secret" },
    api_key: "another-secret",
  }));

  assert.doesNotMatch(summary, /sk-live-secret|another-secret/u);
  assert.match(summary, /redacted/u);
});

test("squeeze retry does not retry authentication failures", async () => {
  resetCodexRetryStatusForTests();
  const trace = beginCodexRetryTrace({ profileName: "custom" });
  let calls = 0;
  const profile = {
    busyRetryEnabled: true,
    busyRetryAttempts: 6,
    baseUrl: "https://upstream.example/v1",
  };

  const result = await fetchWithSqueezeRetry(
    () => {
      calls += 1;
      return calls === 1
        ? new Response("invalid key", { status: 401 })
        : new Response("must not be reached", { status: 200 });
    },
    profile,
    () => profile,
    { trace, stage: "Responses 主请求", endpoint: "/v1/responses", sleep: async () => {} },
  );
  finishCodexRetryTrace(trace, { outcome: "success", status: result.response.status });
  const status = getCodexRetryStatus();

  assert.equal(calls, 1);
  assert.equal(result.response.status, 401);
  assert.equal(status.phase, "stopped");
  assert.match(status.stopReason, /401.*不(?:应|可)重试/u);
});

test("squeeze retry stops at the configured attempt limit with backoff", async () => {
  resetCodexRetryStatusForTests();
  const trace = beginCodexRetryTrace({ profileName: "custom" });
  let calls = 0;
  const delays = [];
  const profile = {
    busyRetryEnabled: true,
    busyRetryAttempts: 3,
    baseUrl: "https://upstream.example/v1",
  };

  const result = await fetchWithSqueezeRetry(
    () => {
      calls += 1;
      return calls <= 4
        ? new Response(`busy-${calls}`, { status: 503 })
        : new Response("eventual success", { status: 200 });
    },
    profile,
    () => profile,
    {
      trace,
      stage: "Responses 主请求",
      endpoint: "/v1/responses",
      sleep: async (milliseconds) => delays.push(milliseconds),
    },
  );
  finishCodexRetryTrace(trace, { outcome: "success", status: result.response.status });
  const status = getCodexRetryStatus();

  assert.equal(calls, 3);
  assert.equal(result.response.status, 503);
  assert.deepEqual(delays, [300, 600]);
  assert.equal(status.attempts, 3);
  assert.equal(status.reconnects, 2);
  assert.equal(status.maxAttempts, 3);
  assert.equal(status.phase, "stopped");
  assert.match(status.stopReason, /最多 3 次/u);
  assert.equal(status.lastFailure.response, "busy-3");
});

test("squeeze retry uses the profile's editable base interval", async () => {
  const delays = [];
  let calls = 0;
  const profile = {
    busyRetryEnabled: true,
    busyRetryAttempts: 3,
    busyRetryDelayMs: 750,
  };

  await fetchWithSqueezeRetry(
    () => {
      calls += 1;
      return calls < 3
        ? new Response("busy", { status: 503 })
        : new Response("ok", { status: 200 });
    },
    profile,
    () => profile,
    { sleep: async (milliseconds) => delays.push(milliseconds) },
  );

  assert.deepEqual(delays, [750, 1500]);
});

test("squeeze retry does not clamp a valid base interval to the old four second cap", async () => {
  const delays = [];
  let calls = 0;
  const profile = {
    busyRetryEnabled: true,
    busyRetryAttempts: 2,
    busyRetryDelayMs: 5000,
  };

  await fetchWithSqueezeRetry(
    () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 503 })
        : new Response("ok", { status: 200 });
    },
    profile,
    () => profile,
    { sleep: async (milliseconds) => delays.push(milliseconds) },
  );

  assert.deepEqual(delays, [5000]);
});

test("squeeze retry throws the last network error at the configured limit", async () => {
  resetCodexRetryStatusForTests();
  const trace = beginCodexRetryTrace({ profileName: "custom" });
  let calls = 0;
  const profile = {
    busyRetryEnabled: true,
    busyRetryAttempts: 3,
    baseUrl: "https://upstream.example/v1",
  };

  await assert.rejects(
    fetchWithSqueezeRetry(
      () => {
        calls += 1;
        if (calls <= 4) throw new Error(`network-${calls}`);
        return new Response("eventual success", { status: 200 });
      },
      profile,
      () => profile,
      { trace, stage: "Responses 主请求", endpoint: "/v1/responses", sleep: async () => {} },
    ),
    /network-3/u,
  );
  finishCodexRetryTrace(trace, { outcome: "failed", error: new Error("network-3") });
  const status = getCodexRetryStatus();

  assert.equal(calls, 3);
  assert.equal(status.phase, "stopped");
  assert.match(status.stopReason, /最多 3 次/u);
  assert.equal(status.lastFailure.error, "network-3");
});
