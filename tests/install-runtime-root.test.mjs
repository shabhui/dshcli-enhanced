import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

test("installer discovers a hoisted Paseo server inside the app-owned prefix", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(
    installer,
    /process\.env\.PREFIX[\s\S]*"lib", "node_modules", "@getpaseo", "server"/,
  );
  assert.match(
    installer,
    /globalRoot && path\.join\(globalRoot, "@getpaseo", "server"\)/,
  );
});

test("Android installer trusts build-time syntax checks instead of spawning Node per patch", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(installer, /if \(process\.platform === "android"\) return;/);
  assert.match(installer, /function validateServerPatchSyntax/);
});

test("installer deploys the Agent CLI installer imported by management", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(
    installer,
    /\["paseo-agent-cli-installer\.js", "paseo-agent-cli-installer\.js"\]/u,
  );
});

test("installer deploys the separate Agent supplier profile store", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");
  const management = await readFile(new URL("../patches/server/paseo-management.js", import.meta.url), "utf8");

  assert.match(installer, /\["paseo-agent-suppliers\.js", "paseo-agent-suppliers\.js"\]/u);
  assert.match(management, /listSupplierProfiles/u);
});

test("installer deploys the Pi model configuration imported by management", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");
  const management = await readFile(new URL("../patches/server/paseo-management.js", import.meta.url), "utf8");

  assert.match(management, /paseo-pi-model-config\.js/u);
  assert.match(
    installer,
    /\["paseo-pi-model-config\.js", "paseo-pi-model-config\.js"\]/u,
  );
});

test("installer injects the global prompt into generic ACP turns", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(installer, /function patchAcpAgentSystemPrompt\(/u);
  assert.match(installer, /agent.*providers.*acp-agent\.js/u);
  assert.match(installer, /prependACPSystemPrompt/u);
  assert.match(installer, /daemonAppendSystemPrompt/u);
  assert.match(installer, /toACPContentBlocks\(prompt\)/u);
});

test("installer keeps ACP prompt patch optional for upstream builds without ACP", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(
    installer,
    /if \(existsSync\(acpAgentTarget\)\) \{[\s\S]*patchAcpAgentSystemPrompt\(acpAgentTarget\);[\s\S]*\}/u,
  );
});

test("ACP prompt injection is installed once and preserves structured prompt blocks", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "paseo-install-acp-prompt-"));
  const serverRoot = path.join(fixture, "server");
  const paseoHome = path.join(fixture, "home");
  const webUi = path.join(serverRoot, "dist", "server", "web-ui");
  const acpAgent = path.join(serverRoot, "dist", "server", "server", "agent", "providers", "acp-agent.js");
  await mkdir(webUi, { recursive: true });
  await mkdir(path.dirname(acpAgent), { recursive: true });
  await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: "0.3.1" }));
  await writeFile(path.join(webUi, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  await writeFile(acpAgent, [
    "function send(prompt) {",
    "  return { prompt: toACPContentBlocks(prompt), };",
    "}",
    "function toACPContentBlocks(prompt) {",
    "  return typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;",
    "}",
  ].join("\n"));
  const installArgs = [
    fileURLToPath(new URL("../install.mjs", import.meta.url)),
    "--server-root", serverRoot,
    "--paseo-home", paseoHome,
  ];
  const env = { ...process.env };
  delete env.PASEO_STANDALONE_ANDROID;

  await execFileAsync(process.execPath, installArgs, { env });
  await execFileAsync(process.execPath, installArgs, { env });

  const installed = await readFile(acpAgent, "utf8");
  await execFileAsync(process.execPath, ["--check", acpAgent]);
  assert.match(installed, /prependACPSystemPrompt\(toACPContentBlocks\(prompt\), this\.config\.systemPrompt, this\.config\.daemonAppendSystemPrompt\)/u);
  assert.equal(installed.match(/function prependACPSystemPrompt\(/gu)?.length, 1);
  assert.match(installed, /return \[\{ type: "text", text: `\[Paseo system prompt\]/u);
  assert.match(installed, /\.\.\.contentBlocks/u);
});

test("installer repairs the malformed ACP helper emitted by the previous installer", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "paseo-install-acp-repair-"));
  const serverRoot = path.join(fixture, "server");
  const paseoHome = path.join(fixture, "home");
  const webUi = path.join(serverRoot, "dist", "server", "web-ui");
  const acpAgent = path.join(serverRoot, "dist", "server", "server", "agent", "providers", "acp-agent.js");
  await mkdir(webUi, { recursive: true });
  await mkdir(path.dirname(acpAgent), { recursive: true });
  await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: "0.3.1" }));
  await writeFile(path.join(webUi, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  await writeFile(acpAgent, [
    "function send(prompt) {",
    "  return { prompt: prependACPSystemPrompt(toACPContentBlocks(prompt), this.config.systemPrompt, this.config.daemonAppendSystemPrompt), };",
    "}",
    'function prependACPSystemPrompt(contentBlocks, systemPrompt, daemonAppendSystemPrompt) {\\n  const parts = [systemPrompt, daemonAppendSystemPrompt].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());\\n  if (parts.length === 0) return contentBlocks;\\n  return [{ type: "text", text: `[Paseo system prompt]\\n${parts.join("\\n\\n")}\\n\\n` }, ...contentBlocks];\\n}\\nfunction toACPContentBlocks(prompt) {',
    "  return typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;",
    "}",
  ].join("\n"));
  const env = { ...process.env };
  delete env.PASEO_STANDALONE_ANDROID;

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../install.mjs", import.meta.url)),
    "--server-root", serverRoot,
    "--paseo-home", paseoHome,
  ], { env });

  await execFileAsync(process.execPath, ["--check", acpAgent]);
  const installed = await readFile(acpAgent, "utf8");
  assert.equal(installed.match(/function prependACPSystemPrompt\(/gu)?.length, 1);
});

test("installer scopes the bundled loopback daemon to standalone Android", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(installer, /__PASEO_INITIAL_DAEMON_CONNECTION__/);
  assert.match(installer, /listen:\s*window\.location\.host/u);
  assert.match(installer, /useTls:\s*false/);
  assert.match(installer, /const daemonBootstrap = standaloneAndroid\s*\?/u);
  assert.match(installer, /replace\("<head>",/);
});

test("non-standalone install preserves the upstream daemon bootstrap", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "paseo-install-desktop-"));
  const serverRoot = path.join(fixture, "server");
  const paseoHome = path.join(fixture, "home");
  const webUi = path.join(serverRoot, "dist", "server", "web-ui");
  await mkdir(webUi, { recursive: true });
  await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: "0.3.1" }));
  await writeFile(path.join(webUi, "index.html"), [
    "<!doctype html>",
    "<html lang=\"en\"><head>",
    "<script id=\"paseo-daemon-bootstrap\">window.__PASEO_INITIAL_DAEMON_CONNECTION__ = { listen: \"10.0.0.5:7777\", useTls: true };</script>",
    "</head><body><div id=\"root\"></div></body></html>",
  ].join("\n"));
  const env = { ...process.env };
  delete env.PASEO_STANDALONE_ANDROID;

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../install.mjs", import.meta.url)),
    "--server-root", serverRoot,
    "--paseo-home", paseoHome,
  ], { env });

  const installed = await readFile(path.join(paseoHome, "web-ui-custom", "index.html"), "utf8");
  assert.match(installed, /10\.0\.0\.5:7777/u);
  assert.match(installed, /useTls:\s*true/u);
  assert.doesNotMatch(installed, /listen:\s*"127\.0\.0\.1:6767"/u);
  assert.match(installed, /paseo-manager\.js/u);
});

test("installer leaves no fixed localhost fallback after the Android port becomes selectable", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(installer, /patchStandaloneLocalhostFallback/u);
  assert.doesNotMatch(installer, /localhost:6767/u);
  assert.doesNotMatch(installer, /127\.0\.0\.1:6767/u);
  assert.match(installer, /window\.location\.host/u);
});

test("Android launcher refreshes enhanced assets by bundled source fingerprint", async () => {
  const launcher = await readFile(
    new URL("../ZeroTermux-main/app/src/main/assets/paseo-runtime/start-paseo.sh", import.meta.url),
    "utf8",
  );

  assert.match(launcher, /BUNDLED_FINGERPRINT_FILE="\$RUNTIME_DIR\/asset-fingerprint"/);
  assert.match(launcher, /asset-fingerprint/);
  assert.match(launcher, /ENHANCED_FINGERPRINT=/);
  assert.doesNotMatch(launcher, /ENHANCED_VERSION=/);
});
