import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("provider management is installed as a first-class server module", async () => {
  const installer = await source("install.mjs");
  const providerConfigPath = path.join(root, "patches/server/paseo-provider-config.js");

  assert.ok(existsSync(providerConfigPath), "provider config module must exist");
  const providerConfig = await readFile(providerConfigPath, "utf8");
  assert.match(installer, /paseo-provider-config\.js/);
  assert.match(providerConfig, /export function mergeProviderOverride/);
});

test("provider API exposes the union of runtime snapshots and native Agent definitions", async () => {
  const management = await source("patches/server/paseo-management.js");

  assert.match(management, /listProviders\(\{\s*wait:\s*true\s*\}\)/);
  assert.match(management, /mergeProviderSnapshotEntries/);
  assert.match(management, /listRegisteredProviderIds\(\)/);
  assert.match(management, /action === "provider-save"/);
  assert.match(management, /action === "supplier-save"/);
  assert.match(management, /getAgentManagerProviderState/);
});

test("console keeps Agent selection separate from nested supplier profiles", async () => {
  const manager = await source("web/paseo-manager.js");
  const primaryTabs = manager.match(/var PRIMARY_TABS\s*=\s*([^;]+);/u)?.[1] || "";

  assert.ok(primaryTabs, "primary tab definition must exist");
  assert.match(primaryTabs, /\["agent","Agent"\]/u);
  assert.match(primaryTabs, /\["cli","CLI"\]/u);
  assert.doesNotMatch(primaryTabs, /\["switch","切换"\]/u);
  assert.doesNotMatch(primaryTabs, /\["interfaces","接口"\]/u);
  assert.doesNotMatch(primaryTabs, /\["workspace","工作区"\]/u);
  assert.match(manager, /function mergeAgentPanels/u);
  assert.match(manager, /switchPanel\.dataset\.pmPanel\s*=\s*"agent"/u);
  assert.match(manager, /interfacePanel\.remove\(\)/u);
  assert.match(manager, /nav\.replaceChildren\(\)/u);
  assert.match(manager, /data-pm-panel="cli"/u);
  assert.doesNotMatch(manager, /switchPanel\.insertBefore\(runtimePanel/u);
  assert.match(manager, /manager\("supplier-save"/);
  assert.match(manager, /manager\("supplier-switch"/);
  assert.match(manager, /id="pm-supplier"/u);
  assert.match(manager, /id="pm-supplier-name"/u);
  assert.match(manager, /item\.available/);
  assert.match(manager, /选择 Agent/u);
  assert.match(manager, /选择这个 Agent 的供应商/u);
  assert.doesNotMatch(manager, /function renameProviderLabels[\s\S]*选择供应商/u);
});

test("Agent manager selection persists independently from the new-conversation preference", async () => {
  const manager = await source("web/paseo-manager.js");
  const loadSwitch = manager.match(/async function loadSwitch[\s\S]*?\n  \}\n  async function activateProfile/u)?.[0] || "";
  const selectProvider = manager.match(/async function selectManagedProvider[\s\S]*?persistManagedProviderPreference\(id\)/u)?.[0] || "";

  assert.match(manager, /MANAGED_PROVIDER_KEY\s*=\s*"@paseo:manager-selected-agent"/u);
  assert.match(manager, /function readManagedProviderPreference\(/u);
  assert.match(manager, /function persistManagedProviderPreference\(/u);
  assert.ok(loadSwitch, "loadSwitch function must exist");
  assert.match(loadSwitch, /readManagedProviderPreference\(\)/u);
  assert.match(loadSwitch, /state\.providers\.find\(function \(item\) \{ return item\.id === managedProviderId; \}\)/u);
  assert.ok(selectProvider, "selectManagedProvider function must exist");
  assert.match(selectProvider, /persistManagedProviderPreference\(id\)/u);
});

test("console can open the bundled terminal from a first-class page and persistent shortcut", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /\["terminal","终端"\]/u);
  assert.match(manager, /panel\.dataset\.pmPanel\s*=\s*"terminal"/u);
  assert.match(manager, /id="pm-open-terminal"/u);
  assert.match(manager, /terminalShortcut\.id\s*=\s*"pm-terminal-shortcut"/u);
  assert.match(manager, /id="pm-terminal-workspace"/u);
  assert.match(manager, /manager\("workspaces"\)/u);
  assert.match(manager, /workspace-header-new-terminal/u);
  assert.match(manager, /workspace-terminal-new/u);
  assert.match(manager, /PENDING_TERMINAL_KEY/u);
  assert.match(manager, /resumePendingTerminalOpen/u);
});

test("terminal shortcut opens the workspace menu before clicking its terminal item", async () => {
  const manager = await source("web/paseo-manager.js");
  const functionSource = manager.match(/function clickOfficialTerminalButton\(\) \{[\s\S]*?\n  \}/u)?.[0] || "";
  assert.ok(functionSource, "terminal click helper must exist");

  const elements = new Map();
  const clicks = { menu: 0, terminal: 0 };
  elements.set('[data-testid="workspace-header-menu-trigger"]', {
    disabled: false,
    click() { clicks.menu += 1; },
  });
  const document = { querySelector(selector) { return elements.get(selector) || null; } };
  const clickTerminal = Function(
    "document",
    `var terminalMenuRequested = false; ${functionSource}; return clickOfficialTerminalButton;`,
  )(document);

  assert.equal(clickTerminal(), false);
  assert.equal(clicks.menu, 1);

  elements.set('[data-testid="workspace-header-new-terminal"]', {
    disabled: false,
    click() { clicks.terminal += 1; },
  });
  assert.equal(clickTerminal(), true);
  assert.equal(clicks.terminal, 1);
  assert.equal(clicks.menu, 1);
});

test("directory navigation uses the canonical parent returned by the server", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /directoryParent:\s*null/u);
  assert.match(manager, /state\.directoryParent\s*=\s*data\.parent\s*\|\|\s*null/u);
  assert.match(manager, /loadDirectories\(state\.directoryParent\)/u);
  assert.doesNotMatch(manager, /state\.directory\.replace\(/u);
});

test("standalone workspace browser opens the private directory panel without a native picker", async () => {
  const bootstrap = await source("web/paseo-standalone-bootstrap.js");
  const manager = await source("web/paseo-manager.js");

  assert.match(bootstrap, /paseo:open-workspace-browser/u);
  assert.match(manager, /addEventListener\("paseo:open-workspace-browser"/u);
  assert.match(manager, /setTab\("workspace"\)/u);
  assert.match(manager, /loadDirectories\(state\.directory\)/u);
  assert.match(manager, /pm-backdrop.*classList\.add\("open"\)/u);
});

test("collapsed floating controls leave only a real clickable ball", async () => {
  const manager = await source("web/paseo-manager.js");
  const toolbarStyle = manager.match(/var terminalStyle = document\.createElement\("style"\);[\s\S]*?document\.head\.appendChild\(terminalStyle\);/u)?.[0] || "";

  assert.match(toolbarStyle, /pm-floating-toolbar-hidden[^}]*width:36px/u);
  assert.match(toolbarStyle, /pm-floating-toolbar-hidden[^}]*height:36px/u);
  assert.match(toolbarStyle, /pm-floating-toolbar-hidden[^}]*pointer-events:auto/u);
  assert.match(toolbarStyle, /pm-floating-toolbar-hidden #pm-terminal-shortcut[^}]*display:none/u);
  assert.match(toolbarStyle, /pm-floating-toolbar-hidden #pm-squeeze[^}]*display:none/u);
  assert.match(toolbarStyle, /pm-floating-toolbar-hidden #pm-open[^}]*pointer-events:auto/u);
  assert.doesNotMatch(toolbarStyle, /pm-floating-toolbar-hidden\{opacity:\.18;transform:scaleX\(\.08\)/u);
});

test("tapping the collapsed ball expands controls without retargeting the click to squeeze", async () => {
  const manager = await source("web/paseo-manager.js");
  const dragFunction = manager.match(/function enableFloatingControlDrag\(\) \{[\s\S]*?\n  \}(?=\n  function build)/u)?.[0] || "";
  const openFunction = manager.match(/function openFloatingControl\(event\) \{[\s\S]*?\n  \}/u)?.[0] || "";

  assert.ok(dragFunction, "floating drag helper must exist");
  assert.ok(openFunction, "floating open helper must exist");
  assert.doesNotMatch(dragFunction, /\["pointerenter",\s*"pointerdown",\s*"focusin",\s*"touchstart"\]/u);
  assert.match(dragFunction, /if \(!toolbar\.classList\.contains\("pm-floating-toolbar-hidden"\)\) wakeFloatingToolbarLocal\(\)/u);
  assert.match(openFunction, /classList\.contains\("pm-floating-toolbar-hidden"\)/u);
  assert.match(openFunction, /wakeFloatingToolbar\(\);\s*return;/u);
  assert.match(manager, /openButton\.onclick\s*=\s*openFloatingControl/u);
});

test("one collapsed-ball pointer sequence only expands the toolbar", async () => {
  const manager = await source("web/paseo-manager.js");
  const dragFunction = manager.match(/function enableFloatingControlDrag\(\) \{[\s\S]*?\n  \}(?=\n  function build)/u)?.[0] || "";
  const openFunction = manager.match(/function openFloatingControl\(event\) \{[\s\S]*?\n  \}/u)?.[0] || "";
  assert.ok(dragFunction && openFunction, "floating helpers must exist");

  function classList(initial = []) {
    const values = new Set(initial);
    return {
      add(value) { values.add(value); },
      remove(value) { values.delete(value); },
      contains(value) { return values.has(value); },
      toggle(value, enabled) { if (enabled) values.add(value); else values.delete(value); },
    };
  }
  const listeners = {};
  const toolbar = {
    classList: classList(["pm-floating-toolbar-hidden"]),
    style: {},
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
  };
  const backdrop = { classList: classList() };
  const root = {
    classList: classList(), style: {}, offsetLeft: 20, offsetTop: 20,
    offsetWidth: 36, offsetHeight: 36,
  };
  const elements = { "pm-floating-toolbar": toolbar, "pm-backdrop": backdrop };
  const window = {
    innerWidth: 400, innerHeight: 800,
    addEventListener() {}, clearTimeout() {}, setTimeout() { return 1; },
  };
  const localStorage = { getItem() { return null; }, setItem() {} };
  const $ = (id) => elements[id] || null;
  let wakeFloatingToolbar = function () {};
  const enableDrag = Function("root", "window", "localStorage", "$", "wakeFloatingToolbar", `${dragFunction}; return { enableFloatingControlDrag, getWake: function () { return wakeFloatingToolbar; } };`)(root, window, localStorage, $, wakeFloatingToolbar);
  const openControl = Function("$", "setTab", "state", "wakeFloatingToolbar", `${openFunction}; return openFloatingControl;`)($, function () {}, { tab: "agent" }, function () { enableDrag.getWake()(); });
  enableDrag.enableFloatingControlDrag();
  toolbar.classList.add("pm-floating-toolbar-hidden");

  const pointer = { button: 0, pointerId: 7, clientX: 30, clientY: 30, type: "pointerup", preventDefault() {} };
  listeners.pointerdown[0](pointer);
  listeners.pointerup[0](pointer);
  openControl({ preventDefault() {}, stopPropagation() {} });

  assert.equal(toolbar.classList.contains("pm-floating-toolbar-hidden"), false);
  assert.equal(backdrop.classList.contains("open"), false);
});

test("expanded floating toolbar opens the native Termux bridge", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /function openNativeTerminal\(\)/u);
  assert.match(manager, /PaseoAndroid\.openTermuxTerminal\(\)/u);
  assert.match(manager, /terminalShortcut\.title\s*=\s*"\u6253\u5f00 Termux"/u);
  assert.match(manager, /terminalShortcut\.onclick\s*=\s*function \(event\)/u);
});

test("console exposes a native port-change action", async () => {
  const [manager, activity] = await Promise.all([
    source("web/paseo-manager.js"),
    source("ZeroTermux-main/app/src/main/java/com/termux/paseo/PaseoActivity.java"),
  ]);
  assert.match(manager, /pm-change-port/u);
  assert.match(manager, /PaseoAndroid\.changePaseoPort\(\)/u);
  assert.match(activity, /changePaseoPort/u);
});

test("console exposes independent API fields for each supplier", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /pm-provider-base-url/);
  assert.match(manager, /pm-provider-api-key/);
  assert.match(manager, /pm-provider-model/);
  assert.match(manager, /body\.baseUrl/);
  assert.match(manager, /body\.apiKey/);
  assert.match(manager, /body\.model/);
  const saveFunction = manager.match(/async function saveManagedProvider[\s\S]*?\n  \}\n  async function refreshManagedProvider/u)?.[0] || "";
  assert.ok(saveFunction, "provider save function must exist");
  assert.match(saveFunction, /supplier-save/u);
  assert.match(manager, /供应商只保存接口、密钥、模型和上下文/u);
  assert.match(manager, /OpenAI 原生/u);
  assert.match(manager, /Anthropic 原生/u);
});

test("protocol options name one protocol each and follow the selected Agent's family", async () => {
  const manager = await source("web/paseo-manager.js");

  // A single option cannot claim two protocols: `native` means Anthropic-native for the claude
  // family and OpenAI-native for every other CLI, so the label has to be resolved per family.
  assert.doesNotMatch(manager, /OpenAI 原生 \/ Anthropic 原生/u);
  const labels = manager.match(/function\s+managedProtocolLabels[\s\S]*?\n  \}/u)?.[0] || "";
  assert.ok(labels, "protocol labels must be resolved from the provider family");
  assert.match(labels, /claude/u);
  assert.match(labels, /Anthropic 原生接口/u);
  assert.match(labels, /OpenAI 原生接口/u);

  // Rendering the editor has to apply them, and explain that for Claude the OpenAI-compatible
  // choice only moves model discovery -- the CLI itself still speaks Anthropic.
  const editor = manager.match(/function renderSupplierEditor[\s\S]*?\n  \}\n  function setSupplierEditorMode/u)?.[0] || "";
  assert.ok(editor, "supplier editor render function must exist");
  assert.match(editor, /managedProtocolLabels/u);
  assert.match(manager, /pm-provider-protocol-help/u);
});

test("Pi supplier editor persists thinking and syncs it to the composer", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /pm-provider-thinking/u);
  assert.match(manager, /thinkingOptionId/u);
  assert.match(manager, /current\.thinkingOptionId/u);
  assert.match(manager, /return\s+["']openai\/["']\s*\+\s*model/u);
});

test("visible console copy calls runtimes Agents and API profiles suppliers", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.doesNotMatch(manager, />启用这个 Provider</u);
  assert.doesNotMatch(manager, />清除这个 Provider 的 API Key</u);
  assert.doesNotMatch(manager, /安装完成会自动注册对应 Provider/u);
  assert.doesNotMatch(manager, />启用这个 Agent</u);
  assert.doesNotMatch(manager, /id="pm-provider-enabled"/u);
  assert.match(manager, />清除这个供应商的 API Key</u);
  assert.match(manager, /安装完成会自动注册对应 Agent/u);
});

test("supplier console is list-first and opens configuration only on demand", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-agent-switcher"/u);
  assert.match(manager, /id="pm-supplier-list"/u);
  assert.match(manager, /function renderSupplierList\(/u);
  assert.match(manager, /supplierRow\.addEventListener\("click", function \(\) \{ selectManagedSupplier\(/u);
  assert.match(manager, /id="pm-add-supplier"/u);
  assert.match(manager, /id="pm-edit-supplier"/u);
  assert.match(manager, /function openManagedSupplierEditor\(/u);
  assert.match(manager, /function closeManagedSupplierEditor\(/u);
  assert.match(manager, /id="pm-provider-editor"[^>]*hidden/u);
  assert.match(manager, /form\.hidden = !state\.supplierEditorOpen/u);
  assert.match(manager, /supplierEditorOpen:\s*false/u);
});

test("saving a supplier always enables its Agent without an enable checkbox", async () => {
  const manager = await source("web/paseo-manager.js");
  const saveFunction = manager.match(/async function saveManagedProvider[\s\S]*?\n  \}\n  async function refreshManagedProvider/u)?.[0] || "";

  assert.ok(saveFunction, "managed supplier save function must exist");
  assert.match(saveFunction, /enabled:\s*true/u);
  assert.doesNotMatch(saveFunction, /pm-provider-enabled/u);
  assert.match(saveFunction, /manager\("provider-save", null, agentSettings\)/u);
});

test("a blank new-supplier editor cannot delete the previously active supplier", async () => {
  const manager = await source("web/paseo-manager.js");
  const renderFunction = manager.match(/function renderSupplierEditor[\s\S]*?\n  \}\n  function setSupplierEditorMode/u)?.[0] || "";
  const deleteFunction = manager.match(/async function deleteManagedSupplier[\s\S]*?\n  \}\n  async function selectManagedProvider/u)?.[0] || "";

  assert.ok(renderFunction, "supplier editor render function must exist");
  assert.match(renderFunction, /pm-delete-supplier/u);
  assert.match(renderFunction, /disabled\s*=\s*!profile/u);
  assert.ok(deleteFunction, "supplier delete function must exist");
  assert.match(deleteFunction, /state\.supplierEditorOpen\s*\?\s*\$\("pm-supplier-id"\)\.value\s*:\s*state\.activeSupplierId/u);
  assert.doesNotMatch(deleteFunction, /state\.activeSupplierId\s*\|\|\s*\$\("pm-supplier-id"\)/u);
});

test("activating any supplier enables its Agent and refreshes the native composer", async () => {
  const [manager, management] = await Promise.all([
    source("web/paseo-manager.js"),
    source("patches/server/paseo-management.js"),
  ]);
  const applyFunction = management.match(/async function applySupplierProfileToAgent[\s\S]*?\n\}/u)?.[0] || "";
  const switchFunction = manager.match(/async function selectManagedSupplier[\s\S]*?\n  \}\n  function newManagedSupplier/u)?.[0] || "";

  assert.ok(applyFunction, "supplier activation function must exist");
  assert.match(applyFunction, /enabled:\s*true/u);
  assert.match(manager, /providerId:\s*"codex",\s*enabled:\s*true/u);
  assert.ok(switchFunction, "supplier switch function must exist");
  assert.match(switchFunction, /syncComposerPreference/u);
  assert.match(switchFunction, /window\.location\.reload/u);
});

test("generic Provider API fetches every model and requires an explicit selection", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-provider-fetch-models"/u);
  assert.match(manager, /id="pm-provider-fetched-models"/u);
  assert.match(manager, /manager\("provider-models"/u);
  assert.match(manager, /providerId:\s*state\.managedProviderId/u);
  assert.match(manager, /pm-provider-fetched-models[\s\S]*addEventListener\("change"/u);
  assert.match(manager, /\$\("pm-provider-model"\)\.value\s*=\s*model/u);
});

test("Codex profile controls only appear while configuring Codex", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-codex-advanced-api"/u);
  assert.match(manager, /managedProviderId\s*===\s*"codex"/u);
  assert.match(manager, /pm-codex-advanced-api[\s\S]*hidden/u);
});

test("console exposes every fetched model as a real selection and syncs the native composer", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-fetched-models"/);
  assert.match(manager, /syncComposerPreference/);
  assert.match(manager, /providerPreferences/);
  assert.match(manager, /additionalModelIds/);
  assert.match(manager, /pm-fetched-models[\s\S]*addEventListener\("change"/);
  assert.doesNotMatch(manager, /<datalist id="pm-models"/);
});

test("saving a new Codex profile includes the models fetched before it had an id", async () => {
  const manager = await source("web/paseo-manager.js");
  const saveFunction = manager.match(/async function saveProfile[^\n]+/u)?.[0] || "";

  assert.ok(saveFunction, "profile save function must exist");
  assert.match(saveFunction, /models:\s*normalizeModelIds\(editorModelIds,/u);
  assert.match(manager, /editorModelIds\s*=\s*ids/u);
});

test("selecting a fetched model only updates the editor until save", async () => {
  const manager = await source("web/paseo-manager.js");
  const selectStart = manager.indexOf("function selectFetchedModel");
  const saveStart = manager.indexOf("async function saveProfile", selectStart);
  const selectFunction = selectStart >= 0 && saveStart > selectStart
    ? manager.slice(selectStart, saveStart)
    : "";

  assert.ok(selectFunction, "fetched model selection function must exist");
  assert.match(selectFunction, /\$\("pm-model"\)\.value\s*=\s*model/u);
  assert.match(selectFunction, /editorModelIds\s*=\s*normalizeModelIds\(editorModelIds,\s*model\)/u);
  assert.doesNotMatch(selectFunction, /codex\(|manager\(|syncComposerPreference|window\.location\.reload/u);
});

test("console supports max reasoning and custom models for every Provider", async () => {
  const [manager, codexConfig] = await Promise.all([
    source("web/paseo-manager.js"),
    source("patches/server/codex-config.js"),
  ]);

  assert.match(manager, /<option>max<\/option>/);
  assert.match(codexConfig, /"max"/);
  assert.match(manager, /id="pm-provider-models"/);
  assert.match(manager, /additionalModelIds/);
});

test("console exposes a bounded context window for Codex and generic Providers", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-context-window"/u);
  assert.match(manager, /id="pm-provider-context-window"/u);
  assert.match(manager, /id="pm-context-window"[^>]*step="1"/u);
  assert.match(manager, /id="pm-provider-context-window"[^>]*step="1"/u);
  assert.match(manager, /contextWindowMaxTokens/u);
  assert.match(manager, /留空使用模型默认/u);
});

test("console displays live squeeze retry diagnostics", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-retry-status"/u);
  assert.match(manager, /retryStatus/u);
  assert.match(manager, /重连/u);
  assert.match(manager, /上游返回/u);
  assert.match(manager, /错误阶段/u);
  assert.match(manager, /stopReason/u);
  assert.match(manager, /最多 .* 次尝试/u);
});

test("saving a generic supplier refreshes the native composer preference cache", async () => {
  const manager = await source("web/paseo-manager.js");
  const saveFunction = manager.match(/async function saveManagedProvider[\s\S]*?\n  \}\n  async function refreshManagedProvider/u)?.[0] || "";

  assert.ok(saveFunction, "managed Provider save function must exist");
  assert.match(saveFunction, /syncComposerPreference\(id, supplier\.model \|\| "", true, supplier\.thinkingOptionId\)/u);
  assert.match(manager, /供应商已保存并切换/u);
});

test("saving a generic supplier also persists Agent enabled state and command", async () => {
  const manager = await source("web/paseo-manager.js");
  const saveFunction = manager.match(/async function saveManagedProvider[\s\S]*?\n  \}\n  async function refreshManagedProvider/u)?.[0] || "";

  assert.match(saveFunction, /agentSettings/u);
  assert.match(saveFunction, /enabled:\s*true/u);
  assert.doesNotMatch(saveFunction, /pm-provider-enabled/u);
  assert.match(saveFunction, /manager\("provider-save", null, agentSettings\)/u);
  assert.match(saveFunction, /pm-provider-command/u);
});

test("squeeze mode is a persistent directly draggable control outside the manager drawer", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /toolbar\.appendChild\(squeezeButton\)/);
  assert.doesNotMatch(manager, /\$\("pm-head"\)\.insertBefore\(squeezeButton/);
  assert.match(manager, /if \(!item\) \{ await loadSwitch\(\)/);
  assert.match(manager, /enableFloatingControlDrag/u);
  assert.match(manager, /@paseo:floating-controls/u);
  assert.match(manager, /if \(!dragging && distance >= 12\)/u);
  assert.doesNotMatch(manager, /setTimeout\(function \(\) \{ dragging = true/u);
  assert.match(manager, /suppressNextClick/u);
  assert.match(manager, /stopImmediatePropagation/u);
  assert.match(manager, /clampFloatingControls/u);
  assert.match(manager, /addEventListener\("resize", clampFloatingControls/u);
});

test("console repairs the active Codex model catalog on initial load without changing the preferred Agent", async () => {
  const manager = await source("web/paseo-manager.js");
  const loadSwitch = manager.match(/async function loadSwitch[\s\S]*?\n  \}\n  async function activateProfile/u)?.[0] || "";

  assert.ok(loadSwitch, "loadSwitch function must exist");
  assert.match(manager, /function codexProfileNeedsSync/u);
  assert.match(loadSwitch, /codexProfileNeedsSync\(activeProfile, codexProvider\)/u);
  assert.match(loadSwitch, /syncCodexProfileToComposer\(activeProfile, true, false\)/u);
});

test("CLI page presents Paseo-preconfigured installs and supports install/update", async () => {
  const manager = await source("web/paseo-manager.js");
  assert.match(manager, /Paseo 预配置版/u);
  assert.match(manager, /provider-cli-catalog/);
  assert.match(manager, /provider-cli-install/);
  assert.match(manager, /provider-cli-update/);
  assert.match(manager, /adapterStatus/);
  assert.match(manager, /updateAvailable/);
  assert.match(manager, /Paseo CLI/);
});

test("CLI manager exposes custom registration fields and add action", async () => {
  const manager = await source("web/paseo-manager.js");
  assert.match(manager, /pm-custom-cli-id/);
  assert.match(manager, /pm-custom-cli-label/);
  assert.match(manager, /pm-custom-cli-adapter/);
  assert.match(manager, /pm-custom-cli-source/);
  assert.match(manager, /provider-cli-add/);
});

test("custom CLI form supports npm packages and updates without duplicating built-in presets", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /value="npm"/);
  assert.match(manager, /pm-custom-cli-update-source/);
  assert.match(manager, /pm-custom-cli-bin/);
  assert.match(manager, /pm-custom-cli-allow-scripts/);
  assert.match(manager, /pm-custom-cli-update-sha256/);
  assert.doesNotMatch(manager, /pm-custom-cli-preset/u);
  assert.match(manager, /source\.package\s*=\s*sourceValue/);
  assert.match(manager, /source\.updatePackage/);
  assert.match(manager, /source\.bin/);
  assert.match(manager, /source\.ignoreScripts/);
  assert.match(manager, /#pm-custom-cli-scripts-row\[hidden\]\{display:none!important\}/);
});

test("CLI manager keeps the common install flow short and folds advanced settings", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-custom-cli-advanced"/);
  assert.match(manager, /<summary>添加其他 CLI<\/summary>/u);
  assert.match(manager, /<summary>高级设置<\/summary>/);
  assert.match(manager, /pm-custom-cli-advanced[\s\S]*pm-custom-cli-update-source-row/);
  assert.match(manager, /pm-custom-cli-advanced[\s\S]*pm-custom-cli-registry-row/);
  assert.match(manager, /pm-custom-cli-advanced[\s\S]*pm-custom-cli-update-sha256-row/);
});

test("CLI rows stay compact and do not repeat the unavailable warning on the Agent page", async () => {
  const manager = await source("web/paseo-manager.js");
  const renderStart = manager.indexOf("function renderCliCatalog");
  const renderEnd = manager.indexOf("async function installCli", renderStart);
  const renderFunction = renderStart >= 0 && renderEnd > renderStart
    ? manager.slice(renderStart, renderEnd)
    : "";

  assert.ok(renderFunction, "CLI catalog renderer must exist");
  assert.match(renderFunction, /pm-cli-row/u);
  assert.match(renderFunction, /detail\.title\s*=/u);
  assert.doesNotMatch(renderFunction, /<br>/u);
  assert.doesNotMatch(manager, /当前没有可运行的 Agent CLI/u);
  assert.doesNotMatch(manager, /<p class="pm-help">优先使用 Paseo CLI/u);
  assert.doesNotMatch(manager, /<p class="pm-help">选择 Agent，然后点一个供应商/u);
  assert.doesNotMatch(manager, /<small>选择这个 Agent 的供应商<\/small>/u);
  assert.match(manager, /\.pm-cli-row/u);
});

test("floating actions share one compact directly draggable toolbar", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /pm-floating-toolbar/u);
  assert.match(manager, /toolbar\.appendChild\(terminalShortcut\)/u);
  assert.match(manager, /toolbar\.appendChild\(squeezeButton\)/u);
  assert.match(manager, /toolbar\.appendChild\(openButton\)/u);
  assert.doesNotMatch(manager, /longPressTarget/u);
  assert.doesNotMatch(manager, /setTimeout\(function \(\) \{ dragging = true/u);
  assert.match(manager, /distance >= 12/u);
  assert.match(manager, /min-width:56px;max-width:96px/u);
  assert.match(manager, /toolbar\.title = "按住拖动工具条"/u);
  assert.match(manager, /@paseo:floating-controls/u);
});

test("management validates only runtime-safe Provider overrides", async () => {
  const management = await source("patches/server/paseo-management.js");

  assert.match(management, /prepareProviderOverridesForRuntime/u);
  assert.match(management, /ProviderOverrideSchema\.parse\(prepareProviderOverridesForRuntime\(\{ \[providerId\]: providers\[providerId\] \}\)\[providerId\]\)/u);
  assert.doesNotMatch(management, /providers\[providerId\] = ProviderOverrideSchema\.parse/u);
});

test("global system prompt is read and written through the daemon config for every Agent", async () => {
  const management = await source("patches/server/paseo-management.js");

  assert.match(management, /action === "global-settings"/u);
  assert.match(management, /appendSystemPrompt/u);
  assert.match(management, /daemonConfigStore\.get\(\)/u);
  assert.match(management, /daemonConfigStore\.patch\(\{\s*appendSystemPrompt/u);
});

test("console exposes one global system prompt editor for all Agents", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-global-system-prompt"/u);
  assert.match(manager, /global-settings/u);
  assert.match(manager, /所有 Agent/u);
  assert.match(manager, /appendSystemPrompt/u);
  assert.match(manager, /新建或恢复的 Agent 会话/u);
  assert.doesNotMatch(manager, /所有 Agent 的新请求/u);
});

test("console exposes Paseo MCP injection settings", async () => {
  const management = await source("patches/server/paseo-management.js");
  const manager = await source("web/paseo-manager.js");

  assert.match(management, /action === "mcp-settings"/u);
  assert.match(management, /action === "mcp-settings-save"/u);
  assert.match(management, /injectIntoAgents/u);
  assert.match(manager, /id="pm-mcp-inject"/u);
  assert.match(manager, /mcp-settings/u);
  assert.match(manager, /新建或恢复的 Agent 会话/u);
});

test("squeeze retry attempts remain visible and manually editable", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-busy-attempts"/u);
  assert.doesNotMatch(manager, /attemptsField[\s\S]*style\.display\s*=\s*"none"/u);
  assert.match(manager, /busyRetryAttempts:\s*Number\(\$\("pm-busy-attempts"\)\.value\)/u);
});

test("squeeze retry base interval remains visible and manually editable", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /id="pm-busy-retry-delay"/u);
  assert.match(manager, /\$\("pm-busy-retry-delay"\)\.value\s*=\s*item\s*&&\s*item\.busyRetryDelayMs/u);
  assert.match(manager, /busyRetryDelayMs:\s*Number\(\$\("pm-busy-retry-delay"\)\.value\)/u);
});

test("floating toolbar auto-hides while idle and wakes on pointer or focus", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /pm-floating-toolbar[\s\S]*opacity/u);
  assert.match(manager, /pm-floating-toolbar-hidden[^}]*width:36px/u);
  assert.match(manager, /pm-floating-toolbar-hidden[^}]*height:36px/u);
  assert.match(manager, /pm-floating-toolbar-hidden[^}]*pointer-events:auto/u);
  assert.match(manager, /pm-floating-toolbar-hidden #pm-open[^}]*pointer-events:auto/u);
  assert.match(manager, /setTimeout\(function \(\) \{[\s\S]*pm-floating-toolbar/u);
  assert.match(manager, /pointerenter/u);
  assert.match(manager, /focusin/u);
  assert.match(manager, /toolbar\.classList\.(add|remove)\("pm-floating-toolbar-hidden"\)/u);
});

test("closing the console drawer restarts the floating toolbar idle timer", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /\$\("pm-close"\)\.onclick\s*=\s*function\s*\(\)\s*\{\s*\$\("pm-backdrop"\)\.classList\.remove\("open"\);\s*wakeFloatingToolbar\(\);\s*\}/u);
});
