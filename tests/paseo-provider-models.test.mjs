import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as providerModels from "../patches/server/paseo-provider-models.js";

const { fetchProviderModels } = providerModels;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("model request credentials reuse a saved key only for the effective saved endpoint", () => {
  const saved = {
    apiProtocol: "native",
    baseUrl: "https://saved.example/v1",
    apiKey: "saved-secret",
  };

  assert.deepEqual(providerModels.resolveProviderModelRequest?.({}, saved), {
    apiProtocol: "native",
    baseUrl: "https://saved.example/v1",
    apiKey: "saved-secret",
  });
  assert.deepEqual(providerModels.resolveProviderModelRequest?.({
    baseUrl: "https://saved.example/v1/",
  }, saved), {
    apiProtocol: "native",
    baseUrl: "https://saved.example/v1/",
    apiKey: "saved-secret",
  });
  assert.deepEqual(providerModels.resolveProviderModelRequest?.({
    baseUrl: "https://other.example/v1",
  }, saved), {
    apiProtocol: "native",
    baseUrl: "https://other.example/v1",
    apiKey: "",
  });
});

test("Claude model discovery uses the Anthropic native models endpoint and headers", async () => {
  let request;
  const models = await fetchProviderModels({
    providerId: "claude",
    baseUrl: "https://api.anthropic.com",
    apiKey: "anthropic-secret",
  }, {
    async fetchImpl(url, options) {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4" }, { id: "claude-opus-4" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(request.url, "https://api.anthropic.com/v1/models?limit=100");
  assert.equal(request.options.headers["x-api-key"], "anthropic-secret");
  assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
  // An Anthropic-native request must carry the Claude CLI identity, never Codex's.
  assert.match(request.options.headers["User-Agent"], /^claude-cli\//u);
  assert.doesNotMatch(request.options.headers["User-Agent"], /codex_cli_rs/u);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.deepEqual(models, ["claude-opus-4", "claude-sonnet-4"]);
});

test("Codex model discovery uses an OpenAI-compatible bearer request", async () => {
  let request;
  const models = await fetchProviderModels({
    providerId: "codex",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "openai-secret",
  }, {
    async fetchImpl(url, options) {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6" }, { id: "gpt-5.6" }, { id: "gpt-5.5" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(request.url, "https://api.openai.com/v1/models");
  assert.equal(request.options.headers.Authorization, "Bearer openai-secret");
  assert.match(request.options.headers["User-Agent"], /^codex_cli_rs\//u);
  assert.equal(request.options.headers["x-api-key"], undefined);
  assert.deepEqual(models, ["gpt-5.5", "gpt-5.6"]);
});

test("Claude can use an OpenAI-compatible model endpoint when selected explicitly", async () => {
  let request;
  await fetchProviderModels({
    providerId: "claude",
    apiProtocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: "openai-compatible-secret",
  }, {
    async fetchImpl(url, options) {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-4" }] }), { status: 200 });
    },
  });
  assert.equal(request.url, "https://openrouter.ai/api/v1/models");
  assert.equal(request.options.headers.Authorization, "Bearer openai-compatible-secret");
  assert.equal(request.options.headers["x-api-key"], undefined);
  // Speaking the OpenAI wire protocol, so the OpenAI-side CLI identity is correct here.
  assert.match(request.options.headers["User-Agent"], /^codex_cli_rs\//u);
  assert.doesNotMatch(request.options.headers["User-Agent"], /claude-cli/u);
});

test("model discovery rejects redirects before credentials can leave the origin", async () => {
  await fetchProviderModels({
    providerId: "claude",
    baseUrl: "https://api.anthropic.com",
    apiKey: "anthropic-secret",
  }, {
    async fetchImpl(_url, options) {
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
});

test("Claude native model discovery follows every Anthropic page", async () => {
  const requests = [];
  const models = await fetchProviderModels({
    providerId: "claude",
    apiProtocol: "native",
    baseUrl: "https://api.anthropic.com",
    apiKey: "anthropic-secret",
  }, {
    async fetchImpl(url) {
      requests.push(url);
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          data: [{ id: "claude-opus-4" }, { id: "claude-sonnet-4" }],
          has_more: true,
          last_id: "claude-sonnet-4",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: [{ id: "claude-sonnet-4" }, { id: "claude-haiku-4" }],
        has_more: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(requests.length, 2);
  assert.match(requests[0], /\/v1\/models\?limit=100$/u);
  assert.match(requests[1], /[?&]after_id=claude-sonnet-4/u);
  assert.deepEqual(models, ["claude-haiku-4", "claude-opus-4", "claude-sonnet-4"]);
});

test("derived Claude providers use the Anthropic protocol and pagination", async () => {
  const requests = [];
  const models = await fetchProviderModels({
    providerId: "my-claude",
    providerFamilyId: "claude",
    baseUrl: "https://api.anthropic.com",
    apiKey: "anthropic-secret",
  }, {
    async fetchImpl(url, options) {
      requests.push({ url, options });
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          data: [{ id: "claude-sonnet-4" }],
          has_more: true,
          last_id: "claude-sonnet-4",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: [{ id: "claude-opus-4" }],
        has_more: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/v1\/models\?limit=100$/u);
  assert.match(requests[1].url, /[?&]after_id=claude-sonnet-4/u);
  assert.equal(requests[0].options.headers["x-api-key"], "anthropic-secret");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(models, ["claude-opus-4", "claude-sonnet-4"]);
});

test("provider model discovery rejects HTML and exposes an actionable endpoint error", async () => {
  await assert.rejects(
    () => fetchProviderModels({ providerId: "claude", baseUrl: "https://example.com", apiKey: "secret" }, {
      async fetchImpl() {
        return new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    }),
    /网页|API 地址|HTML/iu,
  );
});

test("management exposes generic Provider model discovery", async () => {
  const management = await readFile(path.join(root, "patches/server/paseo-management.js"), "utf8");
  const installer = await readFile(path.join(root, "install.mjs"), "utf8");

  assert.match(management, /provider-models/u);
  assert.match(management, /fetchProviderModels/u);
  assert.match(installer, /paseo-provider-models\.js/u);
});
