import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultPermissionForPlatform,
  handleCodexConfigAction,
  normalizeContextWindowTokens,
  normalizeProfileModelIds,
  profileView,
  repairActiveCodexFilesIfNeeded,
  buildCustomModelCatalog,
  customModelCatalogMatches,
  updateModelCatalogPath,
  updateModelContextWindow,
} from "../patches/server/codex-config.js";

function inMemoryActionDependencies(state) {
  const syncCalls = [];
  let saves = 0;
  return {
    dependencies: {
      loadState: () => state,
      saveProfiles: () => { saves += 1; },
      syncProfileToCodexFiles: (_state, profile) => { syncCalls.push({ ...profile }); },
    },
    syncCalls,
    savedCount: () => saves,
  };
}

test("new Codex profiles retain every fetched model and the selected custom model", () => {
  assert.deepEqual(
    normalizeProfileModelIds([" model-z ", "model-a", "model-z", ""], "manual-model"),
    ["manual-model", "model-a", "model-z"],
  );
});

test("existing Codex profile models are preserved when save omits the model list", () => {
  assert.deepEqual(
    normalizeProfileModelIds(undefined, "model-b", ["model-a", "model-b"]),
    ["model-a", "model-b"],
  );
});

test("invalid custom model IDs are rejected before persistence", () => {
  assert.throws(
    () => normalizeProfileModelIds(["valid", "invalid\nmodel"], ""),
    /model id is invalid/i,
  );
});

test("legacy Codex profiles expose their selected custom model in the model catalog", () => {
  const view = profileView({
    id: "legacy-profile",
    name: "Legacy",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    reasoningEffort: "max",
    permission: "workspace",
    wireApi: "responses",
    model: "custom-codex-model",
    models: [],
  }, "legacy-profile");

  assert.deepEqual(view.models, ["custom-codex-model"]);
});

test("Codex profile view exposes a bounded editable squeeze interval", () => {
  const base = {
    id: "retry-profile",
    name: "Retry",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    reasoningEffort: "medium",
    permission: "workspace",
  };

  assert.equal(profileView({ ...base, busyRetryDelayMs: 750 }, base.id).busyRetryDelayMs, 750);
  assert.equal(profileView({ ...base, busyRetryDelayMs: 50 }, base.id).busyRetryDelayMs, 300);
  assert.equal(profileView({ ...base, busyRetryDelayMs: 10001 }, base.id).busyRetryDelayMs, 300);
});

test("Codex context window accepts a bounded token count or model default", () => {
  assert.equal(normalizeContextWindowTokens(131072), 131072);
  assert.equal(normalizeContextWindowTokens("262144"), 262144);
  assert.equal(normalizeContextWindowTokens("", 131072), null);
  assert.equal(normalizeContextWindowTokens(undefined, 131072), 131072);
  assert.throws(() => normalizeContextWindowTokens(1000), /context window/i);
  assert.throws(() => normalizeContextWindowTokens(4_000_001), /context window/i);
  assert.throws(() => normalizeContextWindowTokens(65536.5), /context window/i);
});

test("Codex context window is written as a TOML integer and can be cleared", () => {
  const original = 'model = "custom-model"\n[features]\ngoals = true\n';
  const updated = updateModelContextWindow(original, 131072);

  assert.match(updated, /^model_context_window = 131072$/mu);
  assert.doesNotMatch(updated, /model_context_window\s*=\s*"/u);
  assert.doesNotMatch(updateModelContextWindow(updated, null), /model_context_window/u);
});

test("Codex custom model catalog keeps the complete GLM-compatible model schema and exact slugs", () => {
  assert.deepEqual(buildCustomModelCatalog(["glm-5.2", "deepseek-ai/DeepSeek-V4-Pro-0813"]), {
    models: [
      {
        slug: "deepseek-ai/DeepSeek-V4-Pro-0813",
        display_name: "deepseek-ai/DeepSeek-V4-Pro-0813",
        description: "deepseek-ai/DeepSeek-V4-Pro-0813 via the configured provider.",
        default_reasoning_level: "max",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balances speed and reasoning depth" },
          { effort: "high", description: "Greater reasoning depth" },
          { effort: "xhigh", description: "Extra high reasoning depth" },
          { effort: "max", description: "Maximum reasoning depth" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        availability_nux: null,
        upgrade: null,
        support_verbosity: true,
        default_verbosity: "low",
        supports_reasoning_summaries: true,
        supports_parallel_tool_calls: true,
        supports_search_tool: true,
        supports_image_detail_original: true,
        input_modalities: ["text", "image"],
        web_search_tool_type: "text_and_image",
        experimental_supported_tools: [],
        apply_patch_tool_type: "freeform",
        base_instructions: "",
        context_window: 1_000_000,
        max_context_window: 1_000_000,
        effective_context_window_percent: 100,
        truncation_policy: { mode: "tokens", limit: 1_000_000 },
      },
      {
        slug: "glm-5.2",
        display_name: "GLM-5.2",
        description: "GLM-5.2 via the configured provider.",
        default_reasoning_level: "max",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balances speed and reasoning depth" },
          { effort: "high", description: "Greater reasoning depth" },
          { effort: "xhigh", description: "Extra high reasoning depth" },
          { effort: "max", description: "Maximum reasoning depth" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        availability_nux: null,
        upgrade: null,
        support_verbosity: true,
        default_verbosity: "low",
        supports_reasoning_summaries: true,
        supports_parallel_tool_calls: true,
        supports_search_tool: true,
        supports_image_detail_original: true,
        input_modalities: ["text", "image"],
        web_search_tool_type: "text_and_image",
        experimental_supported_tools: [],
        apply_patch_tool_type: "freeform",
        base_instructions: "",
        context_window: 1_000_000,
        max_context_window: 1_000_000,
        effective_context_window_percent: 100,
        truncation_policy: { mode: "tokens", limit: 1_000_000 },
      },
    ],
  });
});

test("Codex GLM-5.2 entry preserves every source-template value", () => {
  assert.deepEqual(buildCustomModelCatalog(["glm-5.2"]).models[0], {
    slug: "glm-5.2",
    display_name: "GLM-5.2",
    description: "GLM-5.2 via the configured provider.",
    default_reasoning_level: "max",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth" },
      { effort: "high", description: "Greater reasoning depth" },
      { effort: "xhigh", description: "Extra high reasoning depth" },
      { effort: "max", description: "Maximum reasoning depth" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    support_verbosity: true,
    default_verbosity: "low",
    supports_reasoning_summaries: true,
    supports_parallel_tool_calls: true,
    supports_search_tool: true,
    supports_image_detail_original: true,
    input_modalities: ["text", "image"],
    truncation_policy: { mode: "tokens", limit: 1_000_000 },
    web_search_tool_type: "text_and_image",
    experimental_supported_tools: [],
    apply_patch_tool_type: "freeform",
    base_instructions: "",
    context_window: 1_000_000,
    effective_context_window_percent: 100,
    max_context_window: 1_000_000,
  });
});

test("Codex catalog validation detects the old reduced entry and accepts the complete generated entry", () => {
  const expected = buildCustomModelCatalog(["glm-5.2"]);
  const reduced = {
    models: [{
      slug: "glm-5.2",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 100,
      truncation_policy: { mode: "tokens", limit: 1_000_000 },
    }],
  };

  assert.equal(customModelCatalogMatches(reduced, ["glm-5.2"]), false);
  assert.equal(customModelCatalogMatches(expected, ["glm-5.2"]), true);
});

test("reading Codex settings repairs a stale model catalog before returning state", () => {
  const state = {
    activeId: "glm",
    profiles: [{ id: "glm", models: ["glm-5.2"] }],
    paths: { customModelsPath: "/tmp/custom-models.json" },
  };
  const synced = [];
  const repaired = repairActiveCodexFilesIfNeeded(state, {
    readCatalog: () => ({ models: [{ slug: "glm-5.2", truncation_policy: { mode: "tokens", limit: 10000 } }] }),
    syncProfileToCodexFiles: (_state, profile) => synced.push(profile.id),
  });

  assert.equal(repaired, true);
  assert.deepEqual(synced, ["glm"]);
});

test("reading Codex settings leaves a complete model catalog untouched", () => {
  const state = {
    activeId: "glm",
    profiles: [{ id: "glm", models: ["glm-5.2"] }],
    paths: { customModelsPath: "/tmp/custom-models.json" },
  };
  let syncCalls = 0;
  const repaired = repairActiveCodexFilesIfNeeded(state, {
    readCatalog: () => buildCustomModelCatalog(["glm-5.2"]),
    syncProfileToCodexFiles: () => { syncCalls += 1; },
  });

  assert.equal(repaired, false);
  assert.equal(syncCalls, 0);
});

test("Codex config points at the generated custom model catalog", () => {
  const updated = updateModelCatalogPath("model = \"glm-5.2\"\n", "C:/Users/test/.codex/custom-models.json");
  assert.match(updated, /^model_catalog_json = "C:\/Users\/test\/.codex\/custom-models\.json"$/mu);
});

test("new Android Codex profiles default to the app sandbox compatible permission", () => {
  assert.equal(defaultPermissionForPlatform("android"), "full");
  assert.equal(defaultPermissionForPlatform("linux"), "workspace");
  assert.equal(defaultPermissionForPlatform("win32"), "workspace");
});

test("saving and enabling a Codex profile immediately synchronizes the CLI", async () => {
  const state = {
    profiles: [{
      id: "provider_test",
      name: "custom",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      reasoningEffort: "xhigh",
      permission: "workspace",
      wireApi: "responses",
      model: "old-model",
      models: ["old-model"],
      contextWindowMaxTokens: null,
    }],
    activeId: "provider_test",
  };
  const harness = inMemoryActionDependencies(state);

  await handleCodexConfigAction({
    action: "save",
    id: "provider_test",
    name: "custom",
    baseUrl: "https://example.test/v1",
    reasoningEffort: "max",
    permission: "full",
    wireApi: "responses",
    model: "custom-model",
    models: ["custom-model", "other-model"],
    contextWindowMaxTokens: 131072,
    busyRetryDelayMs: 750,
  }, harness.dependencies);

  assert.equal(harness.savedCount(), 1);
  assert.equal(harness.syncCalls.length, 1);
  assert.equal(harness.syncCalls[0].model, "custom-model");
  assert.equal(harness.syncCalls[0].reasoningEffort, "max");
  assert.equal(harness.syncCalls[0].contextWindowMaxTokens, 131072);
  assert.equal(harness.syncCalls[0].busyRetryDelayMs, 750);
});

test("saving a Codex profile on a new endpoint does not reuse an omitted API key", async () => {
  const state = {
    profiles: [{
      id: "provider_test",
      name: "custom",
      baseUrl: "https://old.example/v1",
      apiKey: "old-secret",
      reasoningEffort: "medium",
      permission: "workspace",
      wireApi: "responses",
      model: "old-model",
      models: ["old-model"],
      contextWindowMaxTokens: null,
    }],
    activeId: "provider_test",
  };
  const harness = inMemoryActionDependencies(state);

  await handleCodexConfigAction({
    action: "save",
    id: "provider_test",
    name: "custom",
    baseUrl: "https://new.example/v1",
    reasoningEffort: "medium",
    permission: "workspace",
    wireApi: "responses",
    model: "new-model",
  }, harness.dependencies);

  assert.equal(harness.syncCalls[0].apiKey, "");
});

test("activating an existing Codex profile synchronizes its CLI endpoint", async () => {
  const state = {
    profiles: [
      { id: "provider_a", name: "A", model: "model-a" },
      { id: "provider_b", name: "B", model: "model-b" },
    ],
    activeId: "provider_a",
  };
  const harness = inMemoryActionDependencies(state);

  await handleCodexConfigAction({ action: "activate", id: "provider_b" }, harness.dependencies);

  assert.equal(state.activeId, "provider_b");
  assert.equal(harness.savedCount(), 1);
  assert.equal(harness.syncCalls.length, 1);
  assert.equal(harness.syncCalls[0].id, "provider_b");
});
