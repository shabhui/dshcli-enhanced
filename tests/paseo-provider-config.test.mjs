import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProviderOverridesToRuntime,
  modelIdsToAdditionalModels,
  mergeProviderOverrides,
  mergeProviderSnapshotEntries,
  prepareProviderOverridesForRuntime,
  providerApiValuesFromOverride,
  providerViewFromSnapshot,
} from "../patches/server/paseo-provider-config.js";

test("fetched model IDs become valid selectable Provider models", () => {
  const models = modelIdsToAdditionalModels(
    ["  custom-z  ", "custom-a", "custom-z", ""],
    {
      defaultModel: "custom-z",
      thinkingOptionIds: ["low", "high", "max"],
    },
  );

  assert.deepEqual(models, [
    {
      id: "custom-a",
      label: "custom-a",
      thinkingOptions: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
    },
    {
      id: "custom-z",
      label: "custom-z",
      isDefault: true,
      thinkingOptions: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
    },
  ]);
});

test("Pi models carry selectable thinking values and the saved default", () => {
  const models = modelIdsToAdditionalModels(["openai/gpt-5.6"], {
    defaultModel: "openai/gpt-5.6",
    thinkingOptionIds: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultThinkingOptionId: "max",
  });

  assert.equal(models[0].thinkingOptions.find((option) => option.id === "max").isDefault, true);
  assert.equal(models[0].thinkingOptions.filter((option) => option.isDefault).length, 1);
});

test("the selected custom model is retained even when discovery omits it", () => {
  assert.deepEqual(
    modelIdsToAdditionalModels(["discovered-model"], { defaultModel: "manual-model" }),
    [
      { id: "discovered-model", label: "discovered-model" },
      { id: "manual-model", label: "manual-model", isDefault: true },
    ],
  );
});

test("custom Provider models carry the configured context window at runtime", () => {
  const stored = mergeProviderOverrides({}, "claude", {
    contextWindowMaxTokens: 131072,
    additionalModels: [{ id: "claude-custom", label: "claude-custom", isDefault: true }],
  });
  const prepared = prepareProviderOverridesForRuntime(stored);

  assert.equal(stored.claude.params.paseoContextWindowMaxTokens, 131072);
  assert.equal(prepared.claude.additionalModels[0].contextWindowMaxTokens, 131072);
  assert.equal(prepared.claude.params, undefined);
  assert.equal(
    providerViewFromSnapshot(
      { provider: "claude", label: "Claude", status: "ready", enabled: true },
      stored.claude,
    ).config.contextWindowMaxTokens,
    131072,
  );
});

test("saving Claude runtime settings leaves Codex byte-for-byte unchanged", () => {
  const originalCodex = {
    enabled: true,
    command: ["/data/user/0/com.paseoe/files/usr/bin/codex"],
    env: { OPENAI_API_KEY: "codex-secret" },
  };
  const existing = {
    codex: originalCodex,
    claude: { enabled: false, env: { ANTHROPIC_API_KEY: "old-secret" } },
  };

  const updated = mergeProviderOverrides(existing, "claude", {
    enabled: true,
    command: ["/data/user/0/com.paseoe/files/usr/bin/claude"],
    env: { ANTHROPIC_API_KEY: "new-secret" },
  });

  assert.deepEqual(updated.codex, originalCodex);
  assert.notStrictEqual(updated.codex, originalCodex);
  assert.deepEqual(updated.claude, {
    enabled: true,
    command: ["/data/user/0/com.paseoe/files/usr/bin/claude"],
    env: { ANTHROPIC_API_KEY: "new-secret" },
  });
});

test("provider view exposes status and environment keys without secret values", () => {
  const view = providerViewFromSnapshot(
    {
      provider: "opencode",
      label: "OpenCode",
      description: "OpenCode agent",
      status: "unavailable",
      enabled: true,
      error: "opencode binary not found",
    },
    {
      command: ["/data/user/0/com.paseoe/files/usr/bin/opencode"],
      env: { OPENCODE_API_KEY: "do-not-return", BASE_URL: "https://example.test" },
    },
  );

  assert.equal(view.available, false);
  assert.equal(view.status, "unavailable");
  assert.deepEqual(view.config.envKeys, ["BASE_URL", "OPENCODE_API_KEY"]);
  assert.equal(JSON.stringify(view).includes("do-not-return"), false);
});

test("provider API fields are stored per provider and never leak the API key", () => {
  const existing = {
    codex: {
      enabled: true,
      params: { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
      env: { OPENAI_API_KEY: "codex-secret" },
    },
  };

  const withClaude = mergeProviderOverrides(existing, "claude", {
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-secret",
    model: "claude-sonnet-4",
  });
  const withOpenCode = mergeProviderOverrides(withClaude, "opencode", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "opencode-secret",
    model: "openai/gpt-4.1",
  });

  assert.deepEqual(withClaude.codex, existing.codex);
  assert.equal(withClaude.claude.params, undefined);
  assert.equal(withClaude.claude.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(withClaude.claude.env.ANTHROPIC_MODEL, "claude-sonnet-4");
  assert.equal(withClaude.claude.env.ANTHROPIC_API_KEY, "claude-secret");
  assert.equal(withOpenCode.opencode.params, undefined);
  assert.equal(withOpenCode.opencode.env.OPENAI_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(withOpenCode.opencode.env.OPENCODE_MODEL, "openai/gpt-4.1");
  assert.equal(withOpenCode.opencode.env.OPENAI_API_KEY, "opencode-secret");

  const view = providerViewFromSnapshot(
    { provider: "claude", label: "Claude", status: "ready", enabled: true },
    withClaude.claude,
  );
  assert.deepEqual(view.config.api, {
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4",
    apiProtocol: "native",
    protocolOptions: ["native", "openai-compatible"],
    apiKeyConfigured: true,
  });
  assert.equal(JSON.stringify(view).includes("claude-secret"), false);
});

test("server-side model discovery can reuse only the selected Provider saved API values", () => {
  const overrides = {
    codex: { env: { OPENAI_BASE_URL: "https://codex.example/v1", OPENAI_API_KEY: "codex-secret" } },
    claude: { env: { ANTHROPIC_BASE_URL: "https://claude.example", ANTHROPIC_API_KEY: "claude-secret" } },
  };

  assert.deepEqual(providerApiValuesFromOverride("claude", overrides.claude), {
    baseUrl: "https://claude.example",
    apiKey: "claude-secret",
    model: "",
    apiProtocol: "native",
  });
  assert.deepEqual(providerApiValuesFromOverride("codex", overrides.codex), {
    baseUrl: "https://codex.example/v1",
    apiKey: "codex-secret",
    model: "",
    apiProtocol: "native",
  });
});

test("each Provider persists an explicit native or OpenAI-compatible protocol", () => {
  const updated = mergeProviderOverrides({}, "claude", {
    apiProtocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "claude-via-openai",
    model: "anthropic/claude-sonnet-4",
  });
  assert.equal(updated.claude.params.paseoApiProtocol, "openai-compatible");
  assert.equal(providerApiValuesFromOverride("claude", updated.claude).apiProtocol, "openai-compatible");
  assert.equal(providerApiValuesFromOverride("codex", { env: { OPENAI_API_KEY: "key" } }).apiProtocol, "native");
});

test("the Claude CLI is always configured natively, never with an OpenAI-shaped env", () => {
  const updated = mergeProviderOverrides({}, "claude", {
    apiProtocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "claude-via-openai",
    model: "anthropic/claude-sonnet-4",
  });
  const prepared = prepareProviderOverridesForRuntime(updated);
  assert.equal(prepared.claude.params, undefined);
  // The Claude CLI only speaks the Anthropic wire protocol; OPENAI_* would be ignored,
  // leaving the CLI unauthenticated against the default endpoint.
  // Reduced to the Anthropic API root: the client appends `/v1/messages` on its own.
  assert.equal(prepared.claude.env.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(prepared.claude.env.ANTHROPIC_API_KEY, "claude-via-openai");
  assert.equal(prepared.claude.env.ANTHROPIC_MODEL, "anthropic/claude-sonnet-4");
  assert.equal(prepared.claude.env.OPENAI_BASE_URL, undefined);
  assert.equal(prepared.claude.env.OPENAI_API_KEY, undefined);
  assert.equal(prepared.claude.env.OPENAI_MODEL, undefined);
});

test("the Claude CLI receives the Anthropic API root, never a /v1-suffixed base", () => {
  // A relay that serves both protocols is usually documented with its OpenAI base (".../v1").
  // Pasting that verbatim still lists models, so the mistake only surfaces as a 404 per turn.
  for (const pasted of [
    "https://relay.example/v1",
    "https://relay.example/v1/",
    "https://relay.example/v1/messages",
    "https://relay.example/messages",
  ]) {
    const viaOpenai = prepareProviderOverridesForRuntime(
      mergeProviderOverrides({}, "claude", { apiProtocol: "openai-compatible", baseUrl: pasted, apiKey: "k" }),
    );
    assert.equal(viaOpenai.claude.env.ANTHROPIC_BASE_URL, "https://relay.example", `openai-compatible: ${pasted}`);

    const viaNative = prepareProviderOverridesForRuntime(
      mergeProviderOverrides({}, "claude", { apiProtocol: "native", baseUrl: pasted, apiKey: "k" }),
    );
    assert.equal(viaNative.claude.env.ANTHROPIC_BASE_URL, "https://relay.example", `native: ${pasted}`);
  }

  // A root that merely contains "v1" earlier in the path must survive untouched.
  const nested = prepareProviderOverridesForRuntime(
    mergeProviderOverrides({}, "claude", { apiProtocol: "native", baseUrl: "https://relay.example/v1beta/anthropic", apiKey: "k" }),
  );
  assert.equal(nested.claude.env.ANTHROPIC_BASE_URL, "https://relay.example/v1beta/anthropic");
});

test("a natively configured Claude provider keeps its Anthropic env untouched", () => {
  const updated = mergeProviderOverrides({}, "claude", {
    apiProtocol: "native",
    baseUrl: "https://api.anthropic.com",
    apiKey: "anthropic-secret",
    model: "claude-sonnet-4",
  });
  const prepared = prepareProviderOverridesForRuntime(updated);
  assert.equal(prepared.claude.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(prepared.claude.env.ANTHROPIC_API_KEY, "anthropic-secret");
  assert.equal(prepared.claude.env.ANTHROPIC_MODEL, "claude-sonnet-4");
});

test("non-Claude providers keep the OpenAI-shaped env their CLI actually reads", () => {
  const updated = mergeProviderOverrides({}, "codex", {
    apiProtocol: "native",
    baseUrl: "https://ps.example/v1",
    apiKey: "codex-secret",
    model: "glm-5.3",
  });
  const prepared = prepareProviderOverridesForRuntime(updated);
  assert.equal(prepared.codex.env.OPENAI_BASE_URL, "https://ps.example/v1");
  assert.equal(prepared.codex.env.OPENAI_API_KEY, "codex-secret");
  assert.equal(prepared.codex.env.ANTHROPIC_BASE_URL, undefined);
});

test("changing a Provider endpoint without a new key never carries the old credential", () => {
  const original = mergeProviderOverrides({}, "codex", {
    apiProtocol: "native",
    baseUrl: "https://first.example/v1/",
    apiKey: "first-secret",
    model: "gpt-first",
  });
  const sameEndpoint = mergeProviderOverrides(original, "codex", {
    baseUrl: "https://first.example/v1",
    model: "gpt-second",
  });
  assert.equal(providerApiValuesFromOverride("codex", sameEndpoint.codex).apiKey, "first-secret");

  const changedEndpoint = mergeProviderOverrides(sameEndpoint, "codex", {
    baseUrl: "https://second.example/v1",
    model: "gpt-second",
  });
  assert.equal(providerApiValuesFromOverride("codex", changedEndpoint.codex).apiKey, "");
  assert.equal(changedEndpoint.codex.env.OPENAI_BASE_URL, "https://second.example/v1");

  const changedProtocol = mergeProviderOverrides(original, "claude", {
    apiProtocol: "native",
    baseUrl: "https://api.anthropic.com",
    apiKey: "anthropic-secret",
  });
  const openAiProtocol = mergeProviderOverrides(changedProtocol, "claude", {
    apiProtocol: "openai-compatible",
    baseUrl: "https://api.anthropic.com",
  });
  assert.equal(providerApiValuesFromOverride("claude", openAiProtocol.claude).apiKey, "");
});

test("clearing a provider API key does not affect another provider", () => {
  const updated = mergeProviderOverrides(
    {
      claude: { params: { baseUrl: "https://claude.test", model: "sonnet" }, env: { ANTHROPIC_API_KEY: "secret" } },
      codex: { env: { OPENAI_API_KEY: "codex-secret" } },
    },
    "claude",
    { apiKey: null },
  );

  assert.equal(updated.claude.env?.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(updated.codex, { env: { OPENAI_API_KEY: "codex-secret" } });
  assert.equal(updated.claude.params, undefined);
  assert.equal(updated.claude.env.ANTHROPIC_BASE_URL, "https://claude.test");
  assert.equal(updated.claude.env.ANTHROPIC_MODEL, "sonnet");
});

test("provider API controls do not add unsupported params to Pi or OMP", () => {
  const pi = mergeProviderOverrides(
    { pi: { params: { sessionDir: "/tmp/pi" } } },
    "pi",
    { baseUrl: "https://pi.example/v1", apiKey: "pi-secret", model: "pi-model" },
  );
  const omp = mergeProviderOverrides(
    { omp: { params: { smolModel: "small" } } },
    "omp",
    { baseUrl: "https://omp.example/v1", apiKey: "omp-secret", model: "omp-model" },
  );

  assert.deepEqual(pi.pi.params, { sessionDir: "/tmp/pi" });
  assert.equal(pi.pi.env.OPENAI_BASE_URL, "https://pi.example/v1");
  assert.equal(pi.pi.env.OPENAI_API_KEY, "pi-secret");
  assert.equal(pi.pi.env.PI_MODEL, "pi-model");
  assert.deepEqual(omp.omp.params, { smolModel: "small" });
  assert.equal(omp.omp.env.OPENAI_BASE_URL, "https://omp.example/v1");
  assert.equal(omp.omp.env.OPENAI_API_KEY, "omp-secret");
  assert.equal(omp.omp.env.OMP_MODEL, "omp-model");
});

test("replacing custom environment values preserves the dedicated provider API settings", () => {
  const updated = mergeProviderOverrides(
    {
      claude: {
        env: {
          ANTHROPIC_BASE_URL: "https://claude.example",
          ANTHROPIC_API_KEY: "claude-secret",
          ANTHROPIC_MODEL: "sonnet",
          OLD_VALUE: "remove-me",
        },
      },
    },
    "claude",
    { env: { NEW_VALUE: "keep-me" } },
  );

  assert.deepEqual(updated.claude.env, {
    NEW_VALUE: "keep-me",
    ANTHROPIC_BASE_URL: "https://claude.example",
    ANTHROPIC_API_KEY: "claude-secret",
    ANTHROPIC_MODEL: "sonnet",
  });
});

test("clearing a provider API key also removes legacy params secrets", () => {
  const updated = mergeProviderOverrides(
    {
      claude: {
        params: { apiKey: "legacy-secret", baseUrl: "https://legacy.example", model: "legacy-model" },
        env: { ANTHROPIC_API_KEY: "current-secret" },
      },
    },
    "claude",
    { apiKey: null, baseUrl: "https://new.example", model: "new-model" },
  );

  assert.equal(updated.claude.params, undefined);
  assert.equal(updated.claude.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(updated.claude.env.ANTHROPIC_BASE_URL, "https://new.example");
  assert.equal(updated.claude.env.ANTHROPIC_MODEL, "new-model");
});

test("empty command and environment values remove only those selected-provider overrides", () => {
  const updated = mergeProviderOverrides(
    {
      codex: { enabled: true },
      pi: {
        enabled: true,
        command: ["pi"],
        env: { PI_API_KEY: "secret" },
        params: { theme: "dark" },
      },
    },
    "pi",
    { enabled: false, command: null, env: null },
  );

  assert.deepEqual(updated.codex, { enabled: true });
  assert.deepEqual(updated.pi, { enabled: false, params: { theme: "dark" } });
});

test("runtime synchronization preserves provider commands across later daemon changes", () => {
  const applied = [];
  const runtime = {
    daemonConfigStore: {
      current: {
        relay: { enabled: true },
        providers: { claude: { enabled: false } },
      },
      get() {
        return this.current;
      },
    },
    providerSnapshotManager: {
      baseProviderOverrides: {
        claude: { enabled: false, command: ["old-claude"] },
      },
      applyMutableProviderConfig(mutableProviders) {
        const merged = structuredClone(this.baseProviderOverrides ?? {});
        for (const [providerId, mutable] of Object.entries(mutableProviders ?? {})) {
          merged[providerId] = { ...merged[providerId], ...structuredClone(mutable) };
        }
        applied.push(merged);
        return { providerDefinitions: merged, clients: {} };
      },
    },
    agentManager: {
      updateProviderRegistry(state) {
        this.state = state;
      },
    },
  };
  const saved = {
    codex: { enabled: true, command: ["codex"] },
    claude: {
      enabled: true,
      command: ["/data/user/0/com.paseoe/files/usr/bin/claude"],
      env: { ANTHROPIC_API_KEY: "secret" },
    },
  };

  applyProviderOverridesToRuntime(runtime, saved);
  runtime.providerSnapshotManager.applyMutableProviderConfig(
    runtime.daemonConfigStore.get().providers,
  );

  assert.deepEqual(runtime.daemonConfigStore.get().providers, {
    codex: { enabled: true },
    claude: { enabled: true },
  });
  assert.deepEqual(applied.at(-1).claude, saved.claude);
  assert.equal(
    JSON.stringify(runtime.daemonConfigStore.get()).includes("secret"),
    false,
    "daemon mutable state must not duplicate provider secrets",
  );
});

test("mergeProviderOverrides preserves custom provider adapter metadata", () => {
  const merged = mergeProviderOverrides({}, "my-opencode", {
    extends: "opencode",
    label: "我的 OpenCode",
    description: "App-private custom CLI",
    command: ["/data/user/0/com.paseoe/files/home/.paseo-app/agents/bin/my-opencode", "acp"],
    enabled: true,
  });
  assert.equal(merged["my-opencode"].extends, "opencode");
  assert.equal(merged["my-opencode"].label, "我的 OpenCode");
  assert.equal(merged["my-opencode"].description, "App-private custom CLI");
});

test("derived Agent providers use their native base Agent API mapping", () => {
  const merged = mergeProviderOverrides({}, "my-claude", {
    apiProtocol: "native",
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-secret",
    model: "claude-sonnet-4",
  }, { providerFamily: "claude" });
  assert.equal(merged["my-claude"].env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(merged["my-claude"].env.ANTHROPIC_API_KEY, "claude-secret");
  assert.equal(merged["my-claude"].env.ANTHROPIC_MODEL, "claude-sonnet-4");
  assert.deepEqual(providerApiValuesFromOverride("my-claude", merged["my-claude"], "claude"), {
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-secret",
    model: "claude-sonnet-4",
    apiProtocol: "native",
  });
});

test("native definitions and registered IDs are unioned without relabeling Agents as suppliers", () => {
  const providers = mergeProviderSnapshotEntries(
    [{ provider: "claude", status: "ready", enabled: true, label: "Claude" }],
    ["claude", "my-claude"],
    {
      claude: { enabled: true, derivedFromProviderId: null },
      "my-claude": { enabled: true, derivedFromProviderId: "claude" },
    },
    {},
  );
  const custom = providers.find((provider) => provider.id === "my-claude");
  assert.ok(custom);
  assert.equal(custom.agentFamilyId, "claude");
  assert.equal(custom.extends, "claude");
  assert.equal(custom.supplierId, undefined);
  assert.equal(providers.length, 2);
});

test("supplier activation can replace custom environment values without carrying the previous supplier", () => {
  const merged = mergeProviderOverrides(
    {
      claude: {
        env: {
          ANTHROPIC_API_KEY: "old-secret",
          OLD_SUPPLIER_FLAG: "old",
        },
      },
    },
    "claude",
    {
      apiProtocol: "native",
      baseUrl: "https://api.anthropic.com",
      apiKey: "new-secret",
      model: "claude-sonnet-4",
      env: { NEW_SUPPLIER_FLAG: "new" },
      replaceEnv: true,
    },
  );
  assert.deepEqual(merged.claude.env, {
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_API_KEY: "new-secret",
    ANTHROPIC_MODEL: "claude-sonnet-4",
    NEW_SUPPLIER_FLAG: "new",
  });
});
