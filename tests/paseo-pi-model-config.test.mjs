import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPiModelsConfig,
  normalizePiOpenAIBaseUrl,
  preparePiProviderOverrides,
} from "../patches/server/paseo-pi-model-config.js";

test("Pi OpenAI-compatible base URLs consistently target the v1 API root", () => {
  assert.equal(normalizePiOpenAIBaseUrl("https://relay.example"), "https://relay.example/v1");
  assert.equal(normalizePiOpenAIBaseUrl("https://relay.example/v1/"), "https://relay.example/v1");
  assert.equal(normalizePiOpenAIBaseUrl("https://relay.example/v1/chat/completions"), "https://relay.example/v1");
});

test("Pi models config keeps provider/model selection but strips the provider from model ids", () => {
  assert.deepEqual(buildPiModelsConfig({
    baseUrl: "https://relay.example",
    models: [
      { id: "openai/glm-5.2", contextWindowMaxTokens: 131072, thinkingOptions: [{ id: "off" }, { id: "high" }] },
      { id: "openai/glm-4.7" },
    ],
  }), {
    providers: {
      openai: {
        baseUrl: "https://relay.example/v1",
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: [
          { id: "glm-4.7", name: "glm-4.7" },
          { id: "glm-5.2", name: "glm-5.2", reasoning: true, contextWindow: 131072 },
        ],
      },
    },
  });
});

test("Pi runtime override writes a secret-free provider-specific models.json", async () => {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-pi-config-"));
  const overrides = {
    pi: {
      enabled: true,
      env: {
        OPENAI_BASE_URL: "https://relay.example",
        OPENAI_API_KEY: "temporary-secret",
        PI_MODEL: "openai/glm-5.2",
      },
      additionalModels: [
        { id: "openai/glm-5.2", contextWindowMaxTokens: 131072, thinkingOptions: [{ id: "off" }, { id: "medium" }] },
      ],
    },
    claude: {
      env: { ANTHROPIC_API_KEY: "claude-secret" },
    },
  };

  const prepared = await preparePiProviderOverrides(paseoHome, overrides);
  const agentDir = prepared.pi.env.PI_CODING_AGENT_DIR;
  const raw = await readFile(path.join(agentDir, "models.json"), "utf8");

  assert.equal(agentDir, path.join(path.resolve(paseoHome), "agents", "pi", "pi"));
  assert.equal(raw.includes("temporary-secret"), false);
  assert.equal(JSON.parse(raw).providers.openai.apiKey, "$OPENAI_API_KEY");
  assert.equal(JSON.parse(raw).providers.openai.models[0].id, "glm-5.2");
  assert.deepEqual(prepared.claude, overrides.claude);
  assert.equal(overrides.pi.env.PI_CODING_AGENT_DIR, undefined);
});

test("persisted Pi context settings are expanded before models.json is written", async () => {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-pi-persisted-context-"));
  const prepared = await preparePiProviderOverrides(paseoHome, {
    pi: {
      env: {
        OPENAI_BASE_URL: "https://relay.example/v1",
        OPENAI_API_KEY: "temporary-secret",
        PI_MODEL: "openai/glm-5.2",
      },
      params: {
        paseoContextWindowMaxTokens: 1_000_000,
      },
      additionalModels: [
        { id: "openai/glm-5.2" },
      ],
    },
  });

  const config = JSON.parse(await readFile(
    path.join(prepared.pi.env.PI_CODING_AGENT_DIR, "models.json"),
    "utf8",
  ));

  assert.equal(config.providers.openai.models[0].contextWindow, 1_000_000);
  assert.equal(prepared.pi.params, undefined);
});

test("derived Pi providers get isolated config directories", async () => {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-derived-pi-config-"));
  const prepared = await preparePiProviderOverrides(paseoHome, {
    "work-pi": {
      extends: "pi",
      env: {
        OPENAI_BASE_URL: "https://relay.example/v1",
        OPENAI_API_KEY: "secret",
        PI_MODEL: "openai/glm-5.2",
      },
    },
  });

  assert.equal(
    prepared["work-pi"].env.PI_CODING_AGENT_DIR,
    path.join(path.resolve(paseoHome), "agents", "pi", "work-pi"),
  );
});
