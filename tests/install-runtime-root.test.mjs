import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Mirrors the upstream shape of agent/providers/pi/agent.js closely enough to drive the patched
// resume path: the same imports, the same resolvePiAgentDir, and the same marker block.
const PI_AGENT_FIXTURE = [
  'import { existsSync } from "node:fs";',
  'import { homedir } from "node:os";',
  'import { join, resolve as resolvePath } from "node:path";',
  "function resolvePiAgentDir(env) {",
  "    const configured = env?.PI_CODING_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();",
  "    if (!configured) {",
  '        return join(homedir(), ".pi", "agent");',
  "    }",
  '    if (configured === "~") {',
  "        return homedir();",
  "    }",
  '    if (configured.startsWith("~/")) {',
  "        return resolvePath(homedir(), configured.slice(2));",
  "    }",
  "    return resolvePath(configured);",
  "}",
  "export class PiRpcAgentProvider {",
  "    constructor(options) {",
  "        this.runtimeSettings = options?.runtimeSettings;",
  "    }",
  "    async resumeSession(handle, overrides, launchContext) {",
  "        const sessionFile = handle.nativeHandle;",
  "        if (!sessionFile) {",
  '            throw new Error("Pi resume requires a native session file handle");',
  "        }",
  "        return sessionFile;",
  "    }",
  "}",
].join("\n");

async function installPiAgentFixture(prefix) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), prefix));
  const serverRoot = path.join(fixture, "server");
  const paseoHome = path.join(fixture, "home");
  const webUi = path.join(serverRoot, "dist", "server", "web-ui");
  const piAgent = path.join(serverRoot, "dist", "server", "server", "agent", "providers", "pi", "agent.js");
  await mkdir(webUi, { recursive: true });
  await mkdir(path.dirname(piAgent), { recursive: true });
  await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: "0.3.1" }));
  await writeFile(path.join(webUi, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  await writeFile(piAgent, PI_AGENT_FIXTURE);
  const installArgs = [
    fileURLToPath(new URL("../install.mjs", import.meta.url)),
    "--server-root", serverRoot,
    "--paseo-home", paseoHome,
  ];
  const env = { ...process.env };
  delete env.PASEO_STANDALONE_ANDROID;
  return { fixture, piAgent, run: () => execFileAsync(process.execPath, installArgs, { env }) };
}

test("installer makes Pi resume survive a home move instead of silently opening an empty session", async () => {
  const { fixture, piAgent, run } = await installPiAgentFixture("paseo-install-pi-resume-");
  await run();
  // Repair has to be idempotent: the installer reruns on every launch.
  await run();
  await execFileAsync(process.execPath, ["--check", piAgent]);

  const agentDir = path.join(fixture, "home", ".paseo-app", "agents", "pi", "pi");
  const sessions = path.join(agentDir, "sessions");
  await mkdir(sessions, { recursive: true });
  const live = path.join(sessions, "01JBS.jsonl");
  await writeFile(live, "{}\n");
  const stale = path.join(fixture, "paseo-home", ".paseo-app", "agents", "pi", "pi", "sessions", "01JBS.jsonl");
  const { PiRpcAgentProvider } = await import(`${pathToFileURL(piAgent).href}?v=${Date.now()}`);
  const provider = new PiRpcAgentProvider({ runtimeSettings: { env: { PI_CODING_AGENT_DIR: agentDir } } });

  // A path recorded under the previous home resolves to the migrated file rather than a dead path.
  assert.equal(await provider.resumeSession({ nativeHandle: stale }), live);
  // A path that still exists is used verbatim.
  assert.equal(await provider.resumeSession({ nativeHandle: live }), live);
  // Genuinely missing history fails loudly instead of starting a blank conversation.
  await assert.rejects(
    () => provider.resumeSession({ nativeHandle: path.join(sessions, "absent.jsonl") }),
    /missing/iu,
  );
  await assert.rejects(
    () => provider.resumeSession({ nativeHandle: "" }),
    /native session file handle/u,
  );
});

test("installer keeps the Pi resume patch optional for upstream builds without Pi", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(installer, /function patchPiResumeSessionFile\(/u);
  assert.match(
    installer,
    /if \(existsSync\(piAgentTarget\)\) \{[\s\S]*patchPiResumeSessionFile\(piAgentTarget\);[\s\S]*\}/u,
  );
});

// Mirrors upstream's TimelineAssembler: message_delta carries stop_reason, and the branch order
// upstream relies on means the assistant message lands before the delta that ends it.
const CLAUDE_AGENT_FIXTURE = [
  "function isObjectRecord(value) {",
  "    return typeof value === \"object\" && value !== null && !Array.isArray(value);",
  "}",
  "function toObjectRecord(value) {",
  "    return isObjectRecord(value) ? value : undefined;",
  "}",
  "function readTrimmedString(value) {",
  "    if (typeof value !== \"string\") {",
  "        return undefined;",
  "    }",
  "    const trimmed = value.trim();",
  "    return trimmed.length > 0 ? trimmed : undefined;",
  "}",
  "export class TimelineAssembler {",
  "    constructor() {",
  "        this.emitted = [];",
  "    }",
  "    resolveMessageId(input) {",
  "        return input.messageId ?? null;",
  "    }",
  "    consumeStreamEvent(message, runId, messageIdHint) {",
  "        const event = toObjectRecord(message.event) ?? {};",
  "        const eventType = readTrimmedString(event.type);",
  "        const streamEventMessageId = messageIdHint;",
  "        if (eventType === \"content_block_start\") {",
  "            return [];",
  "        }",
  "        return [];",
  "    }",
  "}",
  "export class ResultAssembler {",
  "    constructor(hasText) {",
  "        this.activeTurnHasAssistantText = hasText;",
  "        this.sidechainTracker = { finishAll: () => [] };",
  "    }",
  "    convertUsage() {",
  "        return { output_tokens: 0 };",
  "    }",
  "    appendResultEvents(message, events) {",
  "        const usage = this.convertUsage(message, message.modelUsage);",
  "        if (message.subtype === \"success\") {",
  "            events.push(...this.sidechainTracker.finishAll(\"completed\"));",
  "            const resultText = typeof message.result === \"string\" ? message.result.trim() : \"\";",
  "            const outputTokens = message.usage?.output_tokens;",
  "            if (resultText.length > 0 && outputTokens === 0 && !this.activeTurnHasAssistantText) {",
  "                events.push({",
  "                    type: \"timeline\",",
  "                    provider: \"claude\",",
  "                    item: {",
  "                        type: \"assistant_message\",",
  "                        text: resultText,",
  "                        messageId: message.uuid,",
  "                    },",
  "                });",
  "            }",
  "            events.push({ type: \"turn_completed\", provider: \"claude\", usage });",
  "            return;",
  "        }",
  "        events.push({ type: \"turn_failed\", provider: \"claude\" });",
  "    }",
  "}",
  "function isSyntheticUserEntry(entry) {",
  "    return false;",
  "}",
].join("\n");

async function installClaudeAgentFixture(prefix) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), prefix));
  const serverRoot = path.join(fixture, "server");
  const paseoHome = path.join(fixture, "home");
  const webUi = path.join(serverRoot, "dist", "server", "web-ui");
  const claudeAgent = path.join(serverRoot, "dist", "server", "server", "agent", "providers", "claude", "agent.js");
  await mkdir(webUi, { recursive: true });
  await mkdir(path.dirname(claudeAgent), { recursive: true });
  await writeFile(path.join(serverRoot, "package.json"), JSON.stringify({ version: "0.3.1" }));
  await writeFile(path.join(webUi, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  await writeFile(claudeAgent, CLAUDE_AGENT_FIXTURE);
  const installArgs = [
    fileURLToPath(new URL("../install.mjs", import.meta.url)),
    "--server-root", serverRoot,
    "--paseo-home", paseoHome,
  ];
  const env = { ...process.env };
  delete env.PASEO_STANDALONE_ANDROID;
  return { claudeAgent, run: () => execFileAsync(process.execPath, installArgs, { env }) };
}

test("installer surfaces Claude max_tokens truncation instead of completing a half-written turn", async () => {
  const { claudeAgent, run } = await installClaudeAgentFixture("paseo-install-claude-trunc-");
  await run();
  // Repair has to be idempotent: the installer reruns on every launch.
  await run();
  await execFileAsync(process.execPath, ["--check", claudeAgent]);

  const patched = await readFile(claudeAgent, "utf8");
  assert.equal(patched.match(/function describePaseoClaudeTruncation\(/gu)?.length, 1);
  const { TimelineAssembler } = await import(`${pathToFileURL(claudeAgent).href}?v=${Date.now()}`);
  const assembler = new TimelineAssembler();
  const consume = (event) => assembler.consumeStreamEvent({ event }, "turn-1", "msg_abc");
  const delta = (stopReason, outputTokens) => ({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: 2485, output_tokens: outputTokens },
  });

  // Hitting the output ceiling is reported, and names the budget so the cause is diagnosable.
  const truncated = consume(delta("max_tokens", 258));
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0].type, "assistant_message");
  assert.equal(truncated[0].messageId, "msg_abc");
  assert.match(truncated[0].text, /max_tokens/u);
  assert.match(truncated[0].text, /258/u);

  // Every other terminal reason stays silent, so normal turns gain no extra chatter.
  assert.deepEqual(consume(delta("end_turn", 1200)), []);
  assert.deepEqual(consume(delta("tool_use", 900)), []);
  assert.deepEqual(consume(delta(null, 900)), []);
  // A ceiling hit without usage still reports rather than throwing on the missing count.
  const noUsage = assembler.consumeStreamEvent(
    { event: { type: "message_delta", delta: { stop_reason: "max_tokens" } } },
    "turn-1",
    "msg_abc",
  );
  assert.equal(noUsage.length, 1);
  assert.match(noUsage[0].text, /max_tokens/u);
  // Untouched branches keep working.
  assert.deepEqual(consume({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), []);
});

test("installer surfaces a Claude turn that completed without producing any body text", async () => {
  const { claudeAgent, run } = await installClaudeAgentFixture("paseo-install-claude-empty-");
  await run();
  await run(); // idempotent
  const patched = await readFile(claudeAgent, "utf8");
  assert.equal(patched.split("const paseoEmptyTurnNotice =").length - 1, 1);
  await execFileAsync(process.execPath, ["--check", claudeAgent]);

  const { ResultAssembler } = await import(`${pathToFileURL(claudeAgent).href}?empty=${Date.now()}`);

  // The failing shape, copied from the real paseo-startup.log terminal result:
  // subtype success, is_error false, stop_reason "end_turn" (the max_tokens cut is only
  // visible mid-stream), empty `result`, and no assistant text ever streamed.
  const silent = [];
  new ResultAssembler(false).appendResultEvents(
    {
      subtype: "success",
      is_error: false,
      num_turns: 2,
      stop_reason: "end_turn",
      api_error_status: null,
      result: "",
      usage: { output_tokens: 0 },
      uuid: "u1",
    },
    silent,
  );
  const notices = silent.filter((event) => event.item?.type === "assistant_message");
  assert.equal(notices.length, 1);
  assert.match(notices[0].item.text, /没有产出任何正文/u);
  assert.equal(notices[0].item.messageId, "u1");
  // The turn still completes; the notice is additive, not a failure.
  assert.equal(silent.at(-1).type, "turn_completed");

  // A turn that did stream text stays untouched.
  const spoke = [];
  new ResultAssembler(true).appendResultEvents(
    { subtype: "success", result: "", usage: { output_tokens: 0 }, uuid: "u2" },
    spoke,
  );
  assert.deepEqual(spoke.filter((event) => event.item?.type === "assistant_message"), []);
  assert.equal(spoke.at(-1).type, "turn_completed");

  // Upstream's slash-command rescue still wins when `result` carries text.
  const slash = [];
  new ResultAssembler(false).appendResultEvents(
    { subtype: "success", result: "Unknown command: /nope", usage: { output_tokens: 0 }, uuid: "u3" },
    slash,
  );
  const slashNotices = slash.filter((event) => event.item?.type === "assistant_message");
  assert.equal(slashNotices.length, 1);
  assert.equal(slashNotices[0].item.text, "Unknown command: /nope");

  // Failures are untouched.
  const failed = [];
  new ResultAssembler(false).appendResultEvents({ subtype: "error", result: "" }, failed);
  assert.equal(failed.at(-1).type, "turn_failed");
});

test("installer keeps the Claude truncation notice optional for upstream builds without Claude", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(installer, /function patchClaudeMaxTokensNotice\(/u);
  assert.match(
    installer,
    /if \(existsSync\(claudeAgentTarget\)\) \{[\s\S]*patchClaudeMaxTokensNotice\(claudeAgentTarget\);[\s\S]*\}/u,
  );
});
