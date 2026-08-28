import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  activateSupplierProfile,
  deleteSupplierProfile,
  getSupplierProfile,
  listSupplierProfiles,
  saveSupplierProfile,
  supplierProfileToProviderInput,
} from "../patches/server/paseo-agent-suppliers.js";

test("one Agent persists multiple supplier profiles and switches explicitly", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-suppliers-"));

  const first = await saveSupplierProfile(home, "claude", {
    id: "anthropic",
    name: "Anthropic 原生",
    apiProtocol: "native",
    baseUrl: "https://api.anthropic.com",
    apiKey: "anthropic-secret",
    model: "claude-sonnet-4",
    models: ["claude-sonnet-4", "claude-opus-4"],
  });
  await saveSupplierProfile(home, "claude", {
    id: "openrouter",
    name: "OpenRouter",
    apiProtocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "openrouter-secret",
    model: "anthropic/claude-sonnet-4",
    models: ["anthropic/claude-sonnet-4"],
  });

  assert.equal(first.activeId, "anthropic");
  assert.deepEqual(first.profiles.map((profile) => profile.id), ["anthropic"]);

  const switched = await activateSupplierProfile(home, "claude", "openrouter");
  assert.equal(switched.activeId, "openrouter");
  assert.deepEqual(switched.profiles.map((profile) => profile.id), ["anthropic", "openrouter"]);

  const listed = await listSupplierProfiles(home, "claude");
  assert.equal(listed.activeId, "openrouter");
  assert.equal(listed.profiles.find((profile) => profile.id === "openrouter").apiKeyConfigured, true);
  assert.equal(JSON.stringify(listed).includes("openrouter-secret"), false);

  const persisted = JSON.parse(await readFile(path.join(home, "agent-supplier-profiles.json"), "utf8"));
  assert.equal(persisted.agents.claude.profiles.find((profile) => profile.id === "openrouter").apiKey, "openrouter-secret");
});

test("deleting the active supplier selects the first remaining profile", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-suppliers-"));
  await saveSupplierProfile(home, "pi", { id: "one", name: "One", model: "m1" });
  await saveSupplierProfile(home, "pi", { id: "two", name: "Two", model: "m2" });
  await activateSupplierProfile(home, "pi", "two");

  const result = await deleteSupplierProfile(home, "pi", "two");
  assert.equal(result.activeId, "one");
  assert.deepEqual(result.profiles.map((profile) => profile.id), ["one"]);

  const empty = await deleteSupplierProfile(home, "pi", "one");
  assert.equal(empty.activeId, null);
  assert.deepEqual(empty.profiles, []);
});

test("supplier profile input maps to a Provider override without leaking profile metadata", () => {
  const input = supplierProfileToProviderInput({
    apiProtocol: "openai-compatible",
    baseUrl: "https://api.example/v1",
    apiKey: "secret",
    model: "custom-model",
    models: ["custom-model", "other-model"],
    contextWindowMaxTokens: 131072,
    env: { CUSTOM_FLAG: "1" },
  });

  assert.deepEqual(input, {
    apiProtocol: "openai-compatible",
    baseUrl: "https://api.example/v1",
    apiKey: "secret",
    model: "custom-model",
    additionalModelIds: ["custom-model", "other-model"],
    contextWindowMaxTokens: 131072,
    env: { CUSTOM_FLAG: "1" },
  });
  assert.equal(input.name, undefined);
  assert.equal(input.id, undefined);
});

test("supplier save reuses a key only when the normalized base URL is unchanged", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-suppliers-"));
  await saveSupplierProfile(home, "claude", {
    id: "shared",
    name: "Shared",
    baseUrl: "https://provider.example/v1",
    apiKey: "old-secret",
    model: "model-a",
  });

  await saveSupplierProfile(home, "claude", {
    id: "shared",
    name: "Shared (same endpoint)",
    baseUrl: "https://provider.example/v1/",
    model: "model-b",
  });
  let persisted = JSON.parse(await readFile(path.join(home, "agent-supplier-profiles.json"), "utf8"));
  assert.equal(persisted.agents.claude.profiles.find((profile) => profile.id === "shared").apiKey, "old-secret");

  await saveSupplierProfile(home, "claude", {
    id: "shared",
    name: "Shared (new endpoint)",
    baseUrl: "https://other-provider.example/v1",
    model: "model-c",
  });
  persisted = JSON.parse(await readFile(path.join(home, "agent-supplier-profiles.json"), "utf8"));
  assert.equal(persisted.agents.claude.profiles.find((profile) => profile.id === "shared").apiKey, "");
});

test("Pi suppliers persist thinking through max and normalize bare OpenAI model ids", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-suppliers-"));
  const saved = await saveSupplierProfile(home, "pi", {
    id: "openai",
    name: "OpenAI",
    model: "gpt-5.6",
    models: ["gpt-5.6", "openrouter/other-model"],
    thinkingOptionId: "max",
  });

  assert.equal(saved.profiles[0].thinkingOptionId, "max");
  assert.deepEqual(supplierProfileToProviderInput(
    await getSupplierProfile(home, "pi", "openai"),
    "pi",
  ), {
    apiProtocol: "native",
    baseUrl: "",
    apiKey: "",
    model: "openai/gpt-5.6",
    additionalModelIds: ["openai/gpt-5.6", "openrouter/other-model"],
    contextWindowMaxTokens: null,
    thinkingOptionId: "max",
    env: {},
  });
});

test("non-Pi supplier overrides ignore Pi-only thinking metadata", () => {
  const input = supplierProfileToProviderInput({
    model: "claude-sonnet-4",
    models: ["claude-sonnet-4"],
    thinkingOptionId: "max",
  }, "claude");

  assert.equal(input.thinkingOptionId, undefined);
});
