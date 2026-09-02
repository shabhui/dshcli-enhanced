import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const SUPPORTED_SERVER_VERSION = "0.3.1";
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function findServerRoot(explicit) {
  const globalRoot = npmGlobalRoot();
  const executablePrefix = path.resolve(path.dirname(process.execPath), "..");
  const candidates = [
    explicit,
    process.env.PASEO_SERVER_ROOT,
    process.env.PREFIX && path.join(process.env.PREFIX, "lib", "node_modules", "@getpaseo", "server"),
    path.join(executablePrefix, "lib", "node_modules", "@getpaseo", "server"),
    globalRoot && path.join(globalRoot, "@getpaseo", "server"),
    globalRoot && path.join(globalRoot, "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
    path.join(homedir(), ".npm-global", "lib", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!found) {
    throw new Error("找不到 @getpaseo/server，请使用 --server-root 指定其目录。");
  }
  return path.resolve(found);
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.paseo-enhanced-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
}

function writeCompressedVariants(filePath, source) {
  const bytes = Buffer.from(source);
  writeFileSync(`${filePath}.gz`, gzipSync(bytes, { level: 9 }));
  writeFileSync(`${filePath}.br`, brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }));
}

function patchStandaloneLoopbackTransport(webRoot) {
  const original = 'e.normalizeLoopbackToLocalhost=function(t){const{host:o,port:n,isIpv6:s}=c(t);if("127.0.0.1"===o||!s&&"0.0.0.0"===o)return`localhost:${n}`;if(s&&("::1"===o||"::"===o))return`localhost:${n}`;return t}';
  const replacement = 'e.normalizeLoopbackToLocalhost=function(t){const{host:o,port:n,isIpv6:s}=c(t);if(globalThis.__PASEO_STANDALONE_ANDROID__){if("localhost"===o||"127.0.0.1"===o||!s&&"0.0.0.0"===o)return`127.0.0.1:${n}`;if(s&&("::1"===o||"::"===o))return`127.0.0.1:${n}`;return t}if("127.0.0.1"===o||!s&&"0.0.0.0"===o)return`localhost:${n}`;if(s&&("::1"===o||"::"===o))return`localhost:${n}`;return t}';
  let patchedFiles = 0;
  const pending = [webRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const source = readFileSync(target, "utf8");
      if (source.includes(replacement)) {
        patchedFiles += 1;
        continue;
      }
      if (!source.includes(original)) continue;
      const patched = source.replace(original, replacement);
      writeFileSync(target, patched);
      writeCompressedVariants(target, patched);
      patchedFiles += 1;
    }
  }
  if (patchedFiles !== 1) {
    throw new Error(`Unable to patch the standalone loopback transport (matched ${patchedFiles} bundles)`);
  }
}

function patchAcpAgentSystemPrompt(target) {
  const originalSource = readFileSync(target, "utf8");
  let source = originalSource;
  const callMarker = "prompt: prependACPSystemPrompt(toACPContentBlocks(prompt), this.config.systemPrompt, this.config.daemonAppendSystemPrompt),";
  const helperMarker = "function toACPContentBlocks(prompt) {";
  const helper = [
    "function prependACPSystemPrompt(contentBlocks, systemPrompt, daemonAppendSystemPrompt) {",
    "  const parts = [systemPrompt, daemonAppendSystemPrompt].filter((value) => typeof value === \"string\" && value.trim()).map((value) => value.trim());",
    "  if (parts.length === 0) return contentBlocks;",
    "  return [{ type: \"text\", text: `[Paseo system prompt]\\n${parts.join(\"\\n\\n\")}\\n\\n` }, ...contentBlocks];",
    "}",
    "",
  ].join("\n");
  const helperStart = "function prependACPSystemPrompt(";
  const helperStartIndex = source.indexOf(helperStart);
  const helperMarkerIndex = helperStartIndex >= 0
    ? source.indexOf(helperMarker, helperStartIndex + helperStart.length)
    : -1;
  if (helperStartIndex >= 0 && helperMarkerIndex > helperStartIndex) {
    source = `${source.slice(0, helperStartIndex)}${helper}${source.slice(helperMarkerIndex)}`;
  }
  if (source.includes(callMarker) && source.includes(helperStart)) {
    if (source !== originalSource) writeFileSync(target, source);
    return;
  }
  if (!source.includes(helperMarker)) {
    throw new Error(`Unable to patch ACP system prompt helper: marker missing in ${target}`);
  }
  const withHelper = source.includes(helperStart)
    ? source
    : source.replace(helperMarker, `${helper}${helperMarker}`);
  const originalCall = "prompt: toACPContentBlocks(prompt),";
  const callMatches = withHelper.split(originalCall).length - 1;
  if (callMatches !== 1) {
    throw new Error(`Unable to patch ACP system prompt call: matched ${callMatches} locations in ${target}`);
  }
  const patched = withHelper.replace(originalCall, callMarker);
  writeFileSync(target, patched);
}

function patchPiResumeSessionFile(target) {
  const source = readFileSync(target, "utf8");
  const helperStart = "function resolvePaseoPiResumeSessionFile(";
  const callMarker = "const sessionFile = resolvePaseoPiResumeSessionFile(handle.nativeHandle, this.runtimeSettings);";
  if (source.includes(helperStart) && source.includes(callMarker)) return;
  const helper = [
    "function resolvePaseoPiResumeSessionFile(nativeHandle, runtimeSettings) {",
    "  if (!nativeHandle) {",
    "    throw new Error(\"Pi resume requires a native session file handle\");",
    "  }",
    "  if (existsSync(nativeHandle)) return nativeHandle;",
    "  // A $HOME move leaves the recorded absolute path dangling while the session file itself was",
    "  // carried across, so look under the agent directory this launch actually uses before failing.",
    "  const rerooted = join(resolvePiAgentDir(runtimeSettings?.env), \"sessions\", nativeHandle.split(/[\\\\/]+/u).pop() ?? \"\");",
    "  if (rerooted !== nativeHandle && existsSync(rerooted)) return rerooted;",
    "  throw new Error(`Pi session file is missing: ${nativeHandle}`);",
    "}",
    "",
  ].join("\n");
  const anchor = "function resolvePiAgentDir(env) {";
  if (!source.includes(anchor)) {
    throw new Error(`Unable to patch Pi resume: agent directory resolver missing in ${target}`);
  }
  const originalCall = [
    "        const sessionFile = handle.nativeHandle;",
    "        if (!sessionFile) {",
    "            throw new Error(\"Pi resume requires a native session file handle\");",
    "        }",
  ].join("\n");
  const callMatches = source.split(originalCall).length - 1;
  if (callMatches !== 1) {
    throw new Error(`Unable to patch Pi resume: matched ${callMatches} resume guards in ${target}`);
  }
  const withHelper = source.includes(helperStart) ? source : source.replace(anchor, `${helper}${anchor}`);
  writeFileSync(target, withHelper.replace(originalCall, `        ${callMarker}`));
}

function patchClaudeMaxTokensNotice(target) {
  let source = readFileSync(target, "utf8");
  const helperStart = "function describePaseoClaudeTruncation(";
  const callMarker = "const truncationNotice = describePaseoClaudeTruncation(event);";
  const emptyMarker = "const paseoEmptyTurnNotice =";
  const alreadyTruncation = source.includes(helperStart) && source.includes(callMarker);
  const alreadyEmpty = source.includes(emptyMarker);
  if (alreadyTruncation && alreadyEmpty) return;
  const helper = [
    "function describePaseoClaudeTruncation(event) {",
    "  const delta = toObjectRecord(event.delta);",
    "  if (readTrimmedString(delta?.stop_reason) !== \"max_tokens\") return null;",
    "  // max_tokens is a non-error terminal reason, so nothing downstream reports it and the turn",
    "  // lands as `completed` with a half-written body. Surface it or the truncation stays invisible.",
    "  const outputTokens = toObjectRecord(event.usage)?.output_tokens;",
    "  const budget = typeof outputTokens === \"number\" ? `${outputTokens} tokens` : \"the output limit\";",
    "  return `⚠️ 回复被截断：模型在 ${budget} 处撞到 max_tokens 上限。若思考占满了预算，正文就会缺失或半截。`;",
    "}",
    "",
  ].join("\n");
  const anchor = "function isSyntheticUserEntry(entry) {";
  if (!source.includes(anchor)) {
    throw new Error(`Unable to patch Claude truncation notice: transcript helper missing in ${target}`);
  }
  const originalCall = [
    "        if (eventType === \"content_block_start\") {",
  ].join("\n");
  const callMatches = source.split(originalCall).length - 1;
  if (callMatches !== 1 && !alreadyTruncation) {
    throw new Error(`Unable to patch Claude truncation notice: matched ${callMatches} stream branches in ${target}`);
  }
  const branch = [
    "        if (eventType === \"message_delta\") {",
    "            const truncationNotice = describePaseoClaudeTruncation(event);",
    "            if (!truncationNotice) {",
    "                return [];",
    "            }",
    "            const messageId = this.resolveMessageId({",
    "                runId,",
    "                createIfMissing: false,",
    "                messageId: streamEventMessageId,",
    "            });",
    "            return [{ type: \"assistant_message\", text: truncationNotice, messageId: messageId ?? undefined }];",
    "        }",
  ].join("\n");
  if (!alreadyTruncation) {
    source = source.includes(helperStart) ? source : source.replace(anchor, `${helper}${anchor}`);
    source = source.replace(originalCall, `${branch}\n${originalCall}`);
  }

  // Second blind spot: a turn can end `end_turn` having produced no assistant text at all
  // (thinking streamed, body never arrived, `result` empty). Upstream only rescues the
  // zero-token case when `result` carries text, so an empty body completes silently.
  if (!alreadyEmpty) {
    const emptyAnchor = 'events.push({ type: "turn_completed", provider: "claude", usage });';
    const emptyMatches = source.split(emptyAnchor).length - 1;
    if (emptyMatches !== 1) {
      throw new Error(`Unable to patch Claude empty-turn notice: matched ${emptyMatches} completion sites in ${target}`);
    }
    const emptyBranch = [
      "            const paseoEmptyTurnNotice = resultText.length === 0 && !this.activeTurnHasAssistantText",
      "                ? \"⚠️ 本轮没有产出任何正文：模型只回了思考（或什么都没回）就结束了。上游把这轮标成成功，所以默认不会有任何提示。\"",
      "                : null;",
      "            if (paseoEmptyTurnNotice) {",
      "                events.push({",
      "                    type: \"timeline\",",
      "                    provider: \"claude\",",
      "                    item: {",
      "                        type: \"assistant_message\",",
      "                        text: paseoEmptyTurnNotice,",
      "                        messageId: message.uuid,",
      "                    },",
      "                });",
      "            }",
    ].join("\n");
    source = source.replace(emptyAnchor, `${emptyBranch.trimStart()}\n            ${emptyAnchor}`);
  }

  writeFileSync(target, source);
}

const serverRoot = findServerRoot(option("--server-root"));
const paseoHome = path.resolve(option("--paseo-home") || process.env.PASEO_HOME || path.join(homedir(), ".paseo"));
const standaloneAndroid = process.env.PASEO_STANDALONE_ANDROID === "1";
const serverVersion = readJson(path.join(serverRoot, "package.json")).version;
if (serverVersion !== SUPPORTED_SERVER_VERSION && !args.includes("--force")) {
  throw new Error(`仅支持 @getpaseo/server@${SUPPORTED_SERVER_VERSION}，当前为 ${serverVersion || "未知"}。`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(paseoHome, "paseo-enhanced-backups", stamp);
const backupEntries = [];
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });

function backup(target, key) {
  const existed = existsSync(target);
  const backupPath = path.join(backupRoot, key);
  if (existed) {
    mkdirSync(path.dirname(backupPath), { recursive: true });
    copyFileSync(target, backupPath);
  }
  backupEntries.push({ target, backupPath, existed });
}

const serverFiles = [
  ["bootstrap.js", "bootstrap.js"],
  ["session.js", "session.js"],
  ["codex-config.js", "codex-config.js"],
  ["codex-retry-status.js", "codex-retry-status.js"],
  ["codex-chat-proxy.js", "codex-chat-proxy.js"],
  ["paseo-provider-config.js", "paseo-provider-config.js"],
  ["paseo-provider-models.js", "paseo-provider-models.js"],
  ["paseo-agent-cli-installer.js", "paseo-agent-cli-installer.js"],
  ["paseo-agent-suppliers.js", "paseo-agent-suppliers.js"],
  ["paseo-pi-model-config.js", "paseo-pi-model-config.js"],
  ["paseo-management.js", "paseo-management.js"],
  ["agent-providers-codex-app-server-agent.js", path.join("agent", "providers", "codex-app-server-agent.js")],
];

function validateServerPatchSyntax(files) {
  if (process.platform === "android") return;
  for (const [sourceName] of files) {
    execFileSync(process.execPath, ["--check", path.join(projectRoot, "patches", "server", sourceName)], { stdio: "inherit" });
  }
}
validateServerPatchSyntax(serverFiles);

const serverCodeRoot = path.join(serverRoot, "dist", "server", "server");
for (const [sourceName, relativeTarget] of serverFiles) {
  const source = path.join(projectRoot, "patches", "server", sourceName);
  const target = path.join(serverCodeRoot, relativeTarget);
  backup(target, path.join("server", relativeTarget));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}
const acpAgentTarget = path.join(serverCodeRoot, "agent", "providers", "acp-agent.js");
if (existsSync(acpAgentTarget)) {
  backup(acpAgentTarget, path.join("server", "agent", "providers", "acp-agent.js"));
  patchAcpAgentSystemPrompt(acpAgentTarget);
}
const piAgentTarget = path.join(serverCodeRoot, "agent", "providers", "pi", "agent.js");
if (existsSync(piAgentTarget)) {
  backup(piAgentTarget, path.join("server", "agent", "providers", "pi", "agent.js"));
  patchPiResumeSessionFile(piAgentTarget);
}
const claudeAgentTarget = path.join(serverCodeRoot, "agent", "providers", "claude", "agent.js");
if (existsSync(claudeAgentTarget)) {
  backup(claudeAgentTarget, path.join("server", "agent", "providers", "claude", "agent.js"));
  patchClaudeMaxTokensNotice(claudeAgentTarget);
}

const configPath = path.join(paseoHome, "config.json");
backup(configPath, path.join("paseo-home", "config.json"));
const config = readJson(configPath);
config.version = config.version || 1;
config.features = config.features && typeof config.features === "object" ? config.features : {};
config.features.webUi = config.features.webUi && typeof config.features.webUi === "object" ? config.features.webUi : {};
config.features.webUi.enabled = true;
config.features.webUi.distDir = "web-ui-custom";
writeJsonAtomic(configPath, config);

const webDir = path.join(paseoHome, "web-ui-custom");
const createdWebDir = !existsSync(webDir);
if (createdWebDir) {
  const bundledWeb = path.join(serverRoot, "dist", "server", "web-ui");
  if (!existsSync(path.join(bundledWeb, "index.html"))) {
    throw new Error(`找不到 Paseo 内置 Web UI：${bundledWeb}`);
  }
  cpSync(bundledWeb, webDir, { recursive: true });
}

for (const fileName of ["index.html", "index.html.gz", "index.html.br", "paseo-standalone-bootstrap.js", "paseo-browser-bootstrap.js", "paseo-manager.js"]) {
  const target = path.join(webDir, fileName);
  if (!createdWebDir) backup(target, path.join("web", fileName));
}

copyFileSync(path.join(projectRoot, "web", "paseo-browser-bootstrap.js"), path.join(webDir, "paseo-browser-bootstrap.js"));
copyFileSync(path.join(projectRoot, "web", "paseo-manager.js"), path.join(webDir, "paseo-manager.js"));
if (standaloneAndroid) {
  copyFileSync(path.join(projectRoot, "web", "paseo-standalone-bootstrap.js"), path.join(webDir, "paseo-standalone-bootstrap.js"));
}

const indexPath = path.join(webDir, "index.html");
if (standaloneAndroid) {
  patchStandaloneLoopbackTransport(webDir);
}
let html = readFileSync(indexPath, "utf8");
const upstreamDaemonBootstrap = html.match(/\s*<script id=["']paseo-daemon-bootstrap["'][\s\S]*?<\/script>/u)?.[0]?.trim() || "";
html = html
  .replace(/^\s*<script[^>]+src=["']\/paseo-standalone-bootstrap\.js[^>]*><\/script>\s*$/gmu, "")
  .replace(/^\s*<script[^>]+src=["']\/paseo-browser-bootstrap\.js[^>]*><\/script>\s*$/gmu, "")
  .replace(/^\s*<script[^>]+src=["']\/paseo-codex-settings\.js[^>]*><\/script>\s*$/gmu, "")
  .replace(/^\s*<script[^>]+src=["']\/paseo-manager\.js[^>]*><\/script>\s*$/gmu, "")
  .replace(/\s*<script id=["']paseo-daemon-bootstrap["'][\s\S]*?<\/script>/gmu, "");
const daemonBootstrap = standaloneAndroid
  ? '  <script id="paseo-daemon-bootstrap">window.__PASEO_INITIAL_DAEMON_CONNECTION__ = { listen: window.location.host, useTls: false };</script>'
  : upstreamDaemonBootstrap;
const standaloneBootstrap = standaloneAndroid
  ? '  <script src="/paseo-standalone-bootstrap.js?v=standalone-v1"></script>'
  : "";
const injection = [
  '  <script src="/paseo-browser-bootstrap.js?v=enhanced-1" defer></script>',
  '  <script src="/paseo-manager.js?v=enhanced-1" defer></script>',
].join("\n");
if (!html.includes("</body>")) throw new Error("Web UI index.html 缺少 </body>。");
if (!html.includes("<head>")) throw new Error("Web UI index.html 缺少 <head>。");
html = html.replace(/<html\s+lang=["'][^"']+["']/i, '<html lang="zh-CN"');
if (!html.includes('id="paseo-viewport-fix"')) {
  const viewportStyle = '<style id="paseo-viewport-fix">html,body,#root{height:var(--paseo-viewport-height,100dvh)!important;min-height:0!important}#root{max-height:var(--paseo-viewport-height,100dvh)}</style>';
  html = html.replace("</head>", `${viewportStyle}\n</head>`);
}
html = html.replace("<head>", `<head>\n${daemonBootstrap}${standaloneBootstrap ? `\n${standaloneBootstrap}` : ""}`);
html = html.replace("</body>", `${injection}\n</body>`);
writeFileSync(indexPath, html);
writeFileSync(`${indexPath}.gz`, gzipSync(Buffer.from(html), { level: 9 }));
writeFileSync(`${indexPath}.br`, brotliCompressSync(Buffer.from(html), {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
}));

const installManifest = {
  installedAt: new Date().toISOString(),
  serverRoot,
  serverVersion,
  paseoHome,
  backupRoot,
  createdWebDir,
  backupEntries,
};
writeJsonAtomic(path.join(backupRoot, "manifest.json"), installManifest);
writeJsonAtomic(path.join(paseoHome, "paseo-enhanced-backups", "latest.json"), installManifest);

console.log(`Paseo Enhanced 已安装，备份位于：${backupRoot}`);
console.log("安装器没有重启 Paseo。请结束当前任务后按原方式正常重启 Daemon。");
