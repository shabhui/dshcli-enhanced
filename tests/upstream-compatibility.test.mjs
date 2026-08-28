import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeUpstream } from "../scripts/upstream-compatibility.mjs";

async function createServerFixture(version, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-upstream-"));
  const serverCodeRoot = path.join(root, "dist", "server", "server");
  await mkdir(serverCodeRoot, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@getpaseo/server", version }));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(serverCodeRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const supportedFiles = {
  "bootstrap.js": "export async function createPaseoDaemon() {}",
  "session.js": "export class Session {}",
  "agent/providers/codex-app-server-agent.js": "export class CodexAppServerAgent {}",
  "agent/provider-launch-config.js": "export const ProviderOverrideSchema = {};",
  "agent/provider-snapshot-manager.js": "listRegisteredProviderIds() {} getAgentManagerProviderState() {} refreshSettingsSnapshot() {}",
  "web-ui.js": "export function createWebUiMiddleware() {}",
};

test("upstream compatibility report accepts the pinned Paseo server shape", async () => {
  const root = await createServerFixture("0.3.1", supportedFiles);
  const report = analyzeUpstream(root);

  assert.equal(report.status, "supported");
  assert.equal(report.version, "0.3.1");
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.versionMismatch, null);
  assert.ok(report.details.some((entry) => entry.path === "agent/provider-launch-config.js" && entry.ok));
  assert.ok(report.details.some((entry) => entry.path === "agent/provider-snapshot-manager.js" && entry.ok));
  assert.ok(report.details.some((entry) => entry.path === "web-ui.js" && entry.ok));
});

test("upstream compatibility report flags version drift and missing entry points", async () => {
  const root = await createServerFixture("0.4.0", { "bootstrap.js": "export const unrelated = true;" });
  const report = analyzeUpstream(root);

  assert.equal(report.status, "review-required");
  assert.deepEqual(report.versionMismatch, { expected: "0.3.1", actual: "0.4.0" });
  assert.ok(report.missing.includes("session.js"));
  assert.ok(report.missing.includes("agent/providers/codex-app-server-agent.js"));
});
