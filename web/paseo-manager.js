(function () {
  "use strict";
  if (window.__PASEO_MANAGER_LOADED__) return;
  window.__PASEO_MANAGER_LOADED__ = true;

  var state = { tab: "agent", profiles: [], activeId: null, providers: [], cliCatalog: [], managedProviderId: null, supplierProfiles: [], activeSupplierId: null, providerFetchedModels: [], supplierEditorOpen: false, conversations: [], importable: 0, importableEntries: [], workspaces: [], directory: "", directoryParent: null, directoryPurpose: null, skills: [], plugins: [], skillFilter: "all", skillTarget: "agents", squeezeEnabled: false, retryStatus: null };
  var KEY = "@paseo:create-agent-preferences";
  var MANAGED_PROVIDER_KEY = "@paseo:manager-selected-agent";
  var PENDING_TERMINAL_KEY = "@paseo:open-workspace-terminal";
  var PRIMARY_TABS = [["agent","Agent"],["cli","CLI"],["terminal","终端"],["conversations","对话"],["mcp","MCP"],["skills","Skills"],["plugins","插件"]];
  var DEFAULT_PERMISSION = /Android/iu.test(navigator.userAgent) ? "full" : "workspace";
  var root;
  var wakeFloatingToolbar = function () {};
  var retryPollTimer = null;
  var retryPollInFlight = false;
  var editorModelIds = [];
  function $(id) { return document.getElementById(id); }
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/gu, function (character) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]; }); }
  function setStatus(text, kind) { var node = $("pm-status"); if (node) { node.textContent = text || ""; node.dataset.kind = kind || ""; } }
  async function api(path, body, signal) {
    var options = { cache: "no-store", credentials: "same-origin" };
    if (signal) options.signal = signal;
    if (body) { options.method = "POST"; options.headers = { "Content-Type": "application/json" }; options.body = JSON.stringify(body); }
    var response = await fetch(path, options);
    var payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload && payload.error || ("请求失败（HTTP " + response.status + "）"));
    if (payload === null) throw new Error("服务器返回了无效响应");
    return payload;
  }
  async function codex(body) { return api("/api/codex-config", body); }
  async function manager(action, query, body, signal) {
    var queryText = query ? "?" + new URLSearchParams(Object.assign({ action: action }, query)).toString() : "?action=" + encodeURIComponent(action);
    return body ? api("/api/paseo-manager" + queryText, Object.assign({ action: action }, body), signal) : api("/api/paseo-manager" + queryText, null, signal);
  }
  function addOptions(select, items, valueKey, labelFn, allowUnavailable) {
    select.replaceChildren(); (items || []).forEach(function (item) { var option = document.createElement("option"); option.value = item[valueKey]; option.textContent = labelFn(item); option.disabled = !allowUnavailable && item.available === false; select.appendChild(option); });
  }
  function normalizeModelIds(values, selectedModel) {
    var ids = [];
    (values || []).forEach(function (value) {
      var id = typeof value === "string" ? value.trim() : value && typeof value.id === "string" ? value.id.trim() : "";
      if (id && ids.indexOf(id) < 0) ids.push(id);
    });
    var selected = typeof selectedModel === "string" ? selectedModel.trim() : "";
    if (selected && ids.indexOf(selected) < 0) ids.push(selected);
    return ids.sort();
  }
  function readComposerPreferences() { try { var value = JSON.parse(localStorage.getItem(KEY) || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch (_) { return {}; } }
  function readManagedProviderPreference() { try { return localStorage.getItem(MANAGED_PROVIDER_KEY) || ""; } catch (_) { return ""; } }
  function persistManagedProviderPreference(id) { try { if (id) localStorage.setItem(MANAGED_PROVIDER_KEY, id); else localStorage.removeItem(MANAGED_PROVIDER_KEY); } catch (_) {} }
  function managedProviderFamily(provider) {
    var providerId = typeof provider === "string" ? provider : provider && provider.id;
    var item = provider && typeof provider === "object" ? provider : state.providers.find(function (candidate) { return candidate.id === providerId; });
    return item && item.agentFamilyId || providerId || "";
  }
  // `native` is not one protocol: it means Anthropic-native for the claude family and OpenAI-native
  // for every other CLI, so one label cannot describe both. Claude also only speaks Anthropic on the
  // wire, so picking the OpenAI-compatible option there moves model discovery and nothing else.
  function managedProtocolLabels(provider) {
    if (managedProviderFamily(provider) === "claude") {
      return { native: "Anthropic 原生接口", compatible: "OpenAI 兼容接口（仅用于获取模型列表）", help: "Claude CLI 只能用 Anthropic 协议发请求。选“OpenAI 兼容接口”只是改用 /v1/models 获取模型列表，实际对话仍然是 Anthropic 协议。" };
    }
    return { native: "OpenAI 原生接口（/v1/responses）", compatible: "OpenAI 兼容接口（/v1/chat/completions）", help: "原生接口走 Responses，兼容接口走 Chat Completions。第三方中转站通常只支持兼容接口。" };
  }
  function normalizeComposerModel(provider, value) {
    var model = typeof value === "string" ? value.trim() : "";
    if (model && managedProviderFamily(provider) === "pi" && model.indexOf("/") < 0) return "openai/" + model;
    return model;
  }
  function syncComposerPreference(provider, model, activateProvider, thinkingOptionId) {
    var preferences = readComposerPreferences();
    if (activateProvider !== false) preferences.provider = provider;
    if (model !== undefined || thinkingOptionId !== undefined) {
      var allProviderPreferences = preferences.providerPreferences && typeof preferences.providerPreferences === "object" && !Array.isArray(preferences.providerPreferences) ? preferences.providerPreferences : {};
      var current = allProviderPreferences[provider] && typeof allProviderPreferences[provider] === "object" && !Array.isArray(allProviderPreferences[provider]) ? allProviderPreferences[provider] : {};
      current = Object.assign({}, current);
      if (model !== undefined) {
        var normalizedModel = normalizeComposerModel(provider, model);
        if (normalizedModel) current.model = normalizedModel; else delete current.model;
      }
      if (thinkingOptionId !== undefined) {
        if (thinkingOptionId) current.thinkingOptionId = thinkingOptionId; else delete current.thinkingOptionId;
      }
      allProviderPreferences = Object.assign({}, allProviderPreferences); allProviderPreferences[provider] = current;
      preferences.providerPreferences = allProviderPreferences;
    }
    localStorage.setItem(KEY, JSON.stringify(preferences));
    return preferences;
  }
  async function loadGlobalSettings() {
    var data = await manager("global-settings");
    var field = $("pm-global-system-prompt");
    if (field) field.value = typeof data.globalSystemPrompt === "string" ? data.globalSystemPrompt : "";
    // The built-in environment prompt is probed on the device at startup, so it is only
    // knowable at runtime. Show it verbatim: users otherwise cannot tell that their own
    // text is appended to it rather than replacing it, and write redundant instructions.
    var base = $("pm-base-system-prompt"), baseBlock = $("pm-base-system-prompt-block");
    var baseText = typeof data.baseSystemPrompt === "string" ? data.baseSystemPrompt.trim() : "";
    if (base) base.textContent = baseText || "本机未提供内置环境提示词。";
    if (baseBlock) baseBlock.hidden = false;
  }
  async function saveGlobalSettings() {
    var field = $("pm-global-system-prompt"), button = $("pm-save-global-system-prompt");
    if (!field) return;
    if (button) button.disabled = true;
    try {
      var result = await manager("global-settings-save", null, { appendSystemPrompt: field.value });
      field.value = typeof result.globalSystemPrompt === "string" ? result.globalSystemPrompt : field.value;
      setStatus("全局提示词已保存，会用于新建或恢复的 Agent 会话。", "success");
    } catch (error) { setStatus(error.message, "error"); }
    finally { if (button) button.disabled = false; }
  }
  async function loadMcpSettings() {
    var data = await manager("mcp-settings"), field = $("pm-mcp-inject"), service = $("pm-mcp-service-status");
    if (field) field.checked = data.injectIntoAgents === true;
    if (service) service.textContent = data.serviceEnabled ? "Paseo MCP 服务已启用" : "Paseo MCP 服务未启用";
  }
  async function saveMcpSettings() {
    var field = $("pm-mcp-inject"), button = $("pm-save-mcp"); if (!field) return;
    if (button) button.disabled = true;
    try {
      var result = await manager("mcp-settings-save", null, { injectIntoAgents: field.checked });
      field.checked = result.injectIntoAgents === true;
      setStatus("MCP 配置已保存，会用于新建或恢复的 Agent 会话。", "success");
    } catch (error) { setStatus(error.message, "error"); }
    finally { if (button) button.disabled = false; }
  }
  function openFloatingControl(event) {
    var toolbar = $("pm-floating-toolbar");
    if (toolbar && toolbar.classList.contains("pm-floating-toolbar-hidden")) {
      if (event) { event.preventDefault(); event.stopPropagation(); }
      wakeFloatingToolbar();
      return;
    }
    $("pm-backdrop").classList.add("open"); setTab(state.tab);
  }
  function openNativeTerminal() {
    if (window.PaseoAndroid && typeof window.PaseoAndroid.openTermuxTerminal === "function") {
      window.PaseoAndroid.openTermuxTerminal();
      return;
    }
    setStatus("当前环境无法打开 Termux。", "error");
  }
  function renderFetchedModels(values, selectedModel) {
    var select = $("pm-fetched-models"); if (!select) return;
    var ids = normalizeModelIds(values, selectedModel); select.replaceChildren();
    if (!ids.length) { var empty = document.createElement("option"); empty.value = ""; empty.textContent = "先获取模型"; select.appendChild(empty); select.disabled = true; return; }
    ids.forEach(function (id) { var option = document.createElement("option"); option.value = id; option.textContent = id; select.appendChild(option); });
    select.disabled = false; select.value = ids.indexOf(selectedModel) >= 0 ? selectedModel : ids[0];
  }
  function installPiThinkingField() {
    var contextWindow = $("pm-provider-context-window");
    var contextRow = contextWindow && contextWindow.closest("label");
    if (!contextRow || $("pm-provider-thinking-row")) return;
    var row = document.createElement("label");
    row.id = "pm-provider-thinking-row";
    row.hidden = true;
    row.innerHTML = '思考强度<select id="pm-provider-thinking" class="pm-select"><option value="off">off</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium" selected>medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select>';
    contextRow.insertAdjacentElement("afterend", row);
  }
  function installBusyRetryDelayField() {
    var attempts = $("pm-busy-attempts");
    var attemptsRow = attempts && attempts.closest("label");
    if (!attemptsRow || $("pm-busy-retry-delay")) return;
    var row = document.createElement("label");
    row.id = "pm-busy-retry-delay-row";
    row.innerHTML = '重试间隔（毫秒）<input id="pm-busy-retry-delay" class="pm-input" type="number" min="100" max="10000" step="100" inputmode="numeric" placeholder="100–10000，默认 300">';
    attemptsRow.insertAdjacentElement("afterend", row);
  }
  function profileModelIds(profile) { return normalizeModelIds(profile && profile.models, profile && profile.model); }
  function codexProfileNeedsSync(profile, provider) {
    if (!profile || !provider) return false;
    var desired = profileModelIds(profile);
    var actual = normalizeModelIds(provider.config && provider.config.additionalModels);
    var providerModel = provider.config && provider.config.api ? provider.config.api.model || "" : "";
    var providerContext = provider.config ? provider.config.contextWindowMaxTokens || null : null;
    return state.codexModelCatalogValid === false || desired.join("\n") !== actual.join("\n") || (profile.model || "") !== providerModel || (profile.contextWindowMaxTokens || null) !== providerContext;
  }
  async function syncCodexProfileToComposer(profile, reload, activateProvider) {
    if (!profile) return;
    await codex({ action: "sync-cli", id: profile.id });
    var result = await manager("provider-save", null, { providerId: "codex", enabled: true, additionalModelIds: profileModelIds(profile), model: profile.model || null, contextWindowMaxTokens: profile.contextWindowMaxTokens || null });
    state.providers = result.providers || state.providers;
    syncComposerPreference("codex", profile.model || "", activateProvider, profile.reasoningEffort || "medium");
    if (reload) window.setTimeout(function () { window.location.reload(); }, 350);
  }
  function setTab(tab) {
    state.tab = tab; root.querySelectorAll("[data-pm-tab]").forEach(function (button) { button.classList.toggle("active", button.dataset.pmTab === tab); });
    root.querySelectorAll("[data-pm-panel]").forEach(function (panel) { panel.hidden = panel.dataset.pmPanel !== tab; });
    if (tab === "agent" || tab === "cli") loadSwitch(); if (tab === "agent") loadGlobalSettings().catch(function (error) { setStatus(error.message, "error"); }); if (tab === "terminal") loadTerminalWorkspaces(); if (tab === "conversations") loadConversations(); if (tab === "mcp") loadMcpSettings().catch(function (error) { setStatus(error.message, "error"); }); if (tab === "workspace") loadDirectories(state.directory); if (tab === "skills") loadSkills(); if (tab === "plugins") loadPlugins();
  }
  function decodeRoutePart(value) { try { return decodeURIComponent(value); } catch (_) { return value; } }
  function currentWorkspaceRoute() {
    var match = window.location.pathname.match(/^\/h\/([^/]+)\/workspace\/([^/?#]+)/u);
    return match ? { serverId: decodeRoutePart(match[1]), workspaceId: decodeRoutePart(match[2]) } : null;
  }
  function currentHostId() { var match = window.location.pathname.match(/^\/h\/([^/?#]+)/u); return match ? decodeRoutePart(match[1]) : null; }
  function clickOfficialTerminalButton() {
    var selectors = ['[data-testid="workspace-header-new-terminal"]', '[data-testid="workspace-terminal-new"]'];
    for (var index = 0; index < selectors.length; index += 1) {
      var button = document.querySelector(selectors[index]);
      if (button && !button.disabled) { clickOfficialTerminalButton.menuRequested = false; button.click(); return true; }
    }
    var menuTrigger = document.querySelector('[data-testid="workspace-header-menu-trigger"]');
    if (menuTrigger && !menuTrigger.disabled && !clickOfficialTerminalButton.menuRequested) {
      clickOfficialTerminalButton.menuRequested = true;
      menuTrigger.click();
    }
    return false;
  }
  function waitForOfficialTerminalButton(remaining) {
    if (clickOfficialTerminalButton()) { localStorage.removeItem(PENDING_TERMINAL_KEY); return; }
    if (remaining <= 0) {
      clickOfficialTerminalButton.menuRequested = false;
      localStorage.removeItem(PENDING_TERMINAL_KEY);
      setStatus("工作区已打开，但原生 Terminal 按钮尚未就绪，请再点一次终端快捷按钮。", "error");
      return;
    }
    window.setTimeout(function () { waitForOfficialTerminalButton(remaining - 1); }, 100);
  }
  function resumePendingTerminalOpen() {
    var pending = null; try { pending = JSON.parse(localStorage.getItem(PENDING_TERMINAL_KEY) || "null"); } catch (_) { localStorage.removeItem(PENDING_TERMINAL_KEY); }
    if (!pending || !pending.serverId || !pending.workspaceId) return;
    if (pending.createdAt && Date.now() - pending.createdAt > 60000) { localStorage.removeItem(PENDING_TERMINAL_KEY); return; }
    var current = currentWorkspaceRoute();
    if (current && current.serverId === pending.serverId && current.workspaceId === pending.workspaceId) waitForOfficialTerminalButton(80);
  }
  function renderTerminalWorkspaces() {
    var select = $("pm-terminal-workspace"), open = $("pm-open-terminal"), status = $("pm-terminal-status"); if (!select || !open) return;
    select.replaceChildren();
    if (!state.workspaces.length) { var empty = document.createElement("option"); empty.value = ""; empty.textContent = "暂无工作区"; select.appendChild(empty); select.disabled = true; open.disabled = false; if (status) status.textContent = "请先创建工作区，然后即可从这里打开 Paseo Terminal。"; return; }
    state.workspaces.forEach(function (item) { var option = document.createElement("option"); option.value = item.id; option.textContent = item.name + " · " + item.cwd; select.appendChild(option); });
    select.disabled = false; open.disabled = false; if (status) status.textContent = "";
    var current = currentWorkspaceRoute(); if (current && state.workspaces.some(function (item) { return item.id === current.workspaceId; })) select.value = current.workspaceId;
  }
  async function loadTerminalWorkspaces() { try { state.workspaces = (await manager("workspaces")).workspaces || []; renderTerminalWorkspaces(); } catch (error) { setStatus(error.message, "error"); } }
  async function openTerminal() {
    if (!state.workspaces.length) await loadTerminalWorkspaces();
    var select = $("pm-terminal-workspace"), current = currentWorkspaceRoute();
    var selectedId = select && select.value ? select.value : current && current.workspaceId;
    var target = state.workspaces.find(function (item) { return item.id === selectedId; }) || (current && state.workspaces.find(function (item) { return item.id === current.workspaceId; })) || state.workspaces[0];
    if (!target) {
      var hostId = currentHostId(); var createRoute = window.__PASEO_STANDALONE_ROUTE__ || (hostId ? "/h/" + encodeURIComponent(hostId) + "/open-project" : null);
      if (createRoute) window.location.href = createRoute; else setStatus("暂无工作区，请先创建工作区。", "error");
      return;
    }
    $("pm-backdrop").classList.remove("open");
    localStorage.setItem(PENDING_TERMINAL_KEY, JSON.stringify({ serverId: target.serverId, workspaceId: target.id, createdAt: Date.now() }));
    if (current && current.serverId === target.serverId && current.workspaceId === target.id) { waitForOfficialTerminalButton(80); return; }
    window.location.href = "/h/" + encodeURIComponent(target.serverId) + "/workspace/" + encodeURIComponent(target.id);
  }
  function renderProfiles() {
    var list = $("pm-profiles"); if (list) { list.replaceChildren(); state.profiles.forEach(function (profile) { var button = document.createElement("button"); button.className = "pm-provider" + (profile.id === state.activeId ? " active" : ""); button.type = "button"; button.innerHTML = "<span>" + esc(profile.name) + "</span><small>" + esc(profile.model || "未选模型") + (profile.active ? " · 当前" : "") + "</small>"; button.addEventListener("click", function () { activateProfile(profile.id); }); list.appendChild(button); }); }
    var edit = $("pm-edit-profile"); if (edit) { edit.disabled = !state.profiles.length; edit.onclick = function () { openManagedSupplierEditor(state.profiles.find(function (item) { return item.id === state.activeId; }) || state.profiles[0]); }; }
  }
  function renderRetryStatus() {
    var node = $("pm-retry-status"); if (!node) return;
    var retry = state.retryStatus || {}, failure = retry.lastFailure || null, lines = [];
    if (retry.active) lines.push("正在连接：第 " + (retry.attempts || 1) + " 次请求，已重连 " + (retry.reconnects || 0) + " 次");
    else if (retry.phase === "recovered") lines.push("已恢复连接，共重连 " + (retry.reconnects || 0) + " 次");
    else if (retry.phase === "failed") lines.push("连接失败，共重连 " + (retry.reconnects || 0) + " 次");
    else if (retry.phase === "stopped") lines.push("挤入重试已停止，共重连 " + (retry.reconnects || 0) + " 次");
    if (retry.stopReason) lines.push("停止原因：" + retry.stopReason);
    if (retry.phase === "stopped" && retry.maxAttempts) lines.push("最多 " + retry.maxAttempts + " 次尝试");
    if (failure) {
      lines.push("错误阶段：" + (failure.stage || retry.stage || "未知"));
      if (failure.endpoint) lines.push("上游位置：" + failure.endpoint);
      if (failure.httpStatus) lines.push("HTTP 状态：" + failure.httpStatus);
      if (failure.response) lines.push("上游返回：" + failure.response);
      if (failure.error) lines.push("网络错误：" + failure.error);
    }
    node.textContent = lines.join("\n"); node.hidden = lines.length === 0;
  }
  function renderSqueeze() { var item = state.profiles.find(function (profile) { return profile.id === state.activeId; }); state.squeezeEnabled = Boolean(item && item.busyRetryEnabled); var retry = state.retryStatus || {}; var button = $("pm-squeeze"); if (button) { button.textContent = state.squeezeEnabled && retry.active ? "重连 " + (retry.reconnects || 0) : state.squeezeEnabled ? "挤入 开" : "挤入 关"; button.classList.toggle("on", state.squeezeEnabled); button.title = state.squeezeEnabled ? "正在持续重试，点击关闭" : "开启后持续请求直到上游连通或再次关闭"; } renderRetryStatus(); }
  function providerStatusText(item) { if (!item) return "未选择 Agent"; if (item.status === "ready" && item.enabled !== false) return "可用"; if (item.status === "loading") return "检查中"; if (item.status === "error") return "错误：" + (item.error || "无法加载"); return "不可用：" + (item.error || "缺少对应 CLI"); }
  function cliStatusText(item) {
    if (!item) return "未知";
    if (item.installed && item.updateAvailable) return "已安装 · 可更新";
    if (item.installed) return "已安装";
    if (item.kind === "preset") return "Paseo 预配置版";
    if (item.status === "bundled") return "随 App 内置";
    if (item.status === "unverified") return "未验证 Android CLI";
    if (item.status === "unsupported") return "暂无 Android CLI";
    return item.status || "未知";
  }
  function renderCliCatalog() {
    var list = $("pm-cli-list"); if (!list) return; list.replaceChildren();
    (state.cliCatalog || []).forEach(function (item) {
      var row = document.createElement("div"); row.className = "pm-row pm-cli-row";
      var detail = document.createElement("div");
      var adapter = item.adapterStatus === "verified" ? " · Paseo 适配器已校验" : "";
      detail.className = "pm-cli-detail";
      detail.title = item.message || "";
      detail.innerHTML = "<strong>" + esc(item.label) + "</strong><small>" + esc(cliStatusText(item) + adapter + (item.installedVersion ? " · " + item.installedVersion : "")) + "</small>";
      row.appendChild(detail);
      if (item.installable && !item.installed) {
        var install = document.createElement("button"); install.className = "pm-primary"; install.type = "button"; install.textContent = "安装"; install.onclick = function () { installCli(item, install); }; row.appendChild(install);
      }
      if (item.updateable && item.installed) {
        var update = document.createElement("button"); update.className = "pm-secondary"; update.type = "button"; update.textContent = item.updateAvailable ? "更新" : "重装/检查"; update.title = item.updateAvailable ? "安装已准备好的新版本" : "重新校验并安装当前 App 内置版本"; update.onclick = function () { updateCli(item, update); }; row.appendChild(update);
      }
      list.appendChild(row);
    });
  }
  function refreshProviderChoices() {
    var select = $("pm-agent"); if (!select) return;
    addOptions(select, state.providers, "id", function (item) { return item.label + "（" + item.id + "）" + (item.available ? "" : " · " + providerStatusText(item)); }, true);
    if (state.managedProviderId) select.value = state.managedProviderId;
    var switcher = $("pm-agent-switcher"); if (!switcher) return; switcher.replaceChildren();
    state.providers.forEach(function (item) {
      var button = document.createElement("button"); button.type = "button"; button.className = "pm-agent-option" + (item.id === state.managedProviderId ? " active" : ""); button.textContent = item.label || item.id; button.title = providerStatusText(item); button.setAttribute("aria-pressed", item.id === state.managedProviderId ? "true" : "false");
      button.addEventListener("click", function () { select.value = item.id; selectManagedProvider(item.id); }); switcher.appendChild(button);
    });
  }
  async function installCli(item, button) {
    button.disabled = true; setStatus("正在安装 " + item.label + " CLI…");
    try { var result = await manager("provider-cli-install", null, { providerId: item.providerId }); state.cliCatalog = result.catalog || state.cliCatalog; state.providers = result.providers || state.providers; refreshProviderChoices(); renderCliCatalog(); setStatus(result.installed.message || (item.label + " CLI 已安装。"), "success"); }
    catch (error) { setStatus(error.message, "error"); button.disabled = false; }
  }
  async function updateCli(item, button) {
    button.disabled = true; setStatus("正在更新 " + item.label + " CLI…");
    try { var result = await manager("provider-cli-update", null, { providerId: item.providerId }); state.cliCatalog = result.catalog || state.cliCatalog; state.providers = result.providers || state.providers; refreshProviderChoices(); renderCliCatalog(); setStatus(result.updated.message || (item.label + " CLI 已更新。"), "success"); }
    catch (error) { setStatus(error.message, "error"); button.disabled = false; }
  }
  function updateCustomCliSourceFields() {
    var sourceType = $("pm-custom-cli-source-type").value;
    var sourceLabel = $("pm-custom-cli-source-label");
    var sourceInput = $("pm-custom-cli-source");
    var updateLabel = $("pm-custom-cli-update-source-label");
    var updateInput = $("pm-custom-cli-update-source");
    var npmOnly = sourceType === "npm";
    var urlOnly = sourceType === "url";
    sourceLabel.textContent = npmOnly ? "npm 包" : urlOnly ? "安装 URL" : "App 运行时文件";
    sourceInput.placeholder = npmOnly ? "例如 opencode-ai@latest" : urlOnly ? "https://…" : "App 私有运行时内的绝对路径";
    updateLabel.textContent = npmOnly ? "更新 npm 包（可选）" : "更新 URL（可选）";
    updateInput.placeholder = npmOnly ? "例如 opencode-ai@latest" : "https://…";
    $("pm-custom-cli-update-source-row").hidden = sourceType === "path";
    $("pm-custom-cli-bin-row").hidden = !npmOnly;
    $("pm-custom-cli-registry-row").hidden = !npmOnly;
    $("pm-custom-cli-scripts-row").hidden = !npmOnly;
    $("pm-custom-cli-sha256-row").hidden = !urlOnly;
    $("pm-custom-cli-update-sha256-row").hidden = !urlOnly;
  }
  async function addCustomCli(event) {
    if (event) event.preventDefault();
    var argsText = $("pm-custom-cli-args").value.trim();
    var sourceType = $("pm-custom-cli-source-type").value;
    var sourceValue = $("pm-custom-cli-source").value.trim();
    var updateSourceValue = $("pm-custom-cli-update-source").value.trim();
    var source = { type: sourceType, version: $("pm-custom-cli-version").value.trim() || undefined, updateVersion: $("pm-custom-cli-update-version").value.trim() || undefined };
    if (sourceType === "npm") {
      source.package = sourceValue;
      source.updatePackage = updateSourceValue || undefined;
      source.bin = $("pm-custom-cli-bin").value.trim() || undefined;
      source.registry = $("pm-custom-cli-registry").value.trim() || undefined;
      source.ignoreScripts = !$("pm-custom-cli-allow-scripts").checked;
    } else if (sourceType === "path") {
      source.path = sourceValue;
    } else {
      source.url = sourceValue;
      source.updateUrl = updateSourceValue || undefined;
      source.sha256 = $("pm-custom-cli-sha256").value.trim() || undefined;
      source.updateSha256 = $("pm-custom-cli-update-sha256").value.trim() || undefined;
    }
    try {
      var args = argsText ? JSON.parse(argsText) : [];
      if (!Array.isArray(args)) throw new Error("启动参数必须是 JSON 字符串数组");
      var result = await manager("provider-cli-add", null, { providerId: $("pm-custom-cli-id").value.trim(), label: $("pm-custom-cli-label").value.trim(), extends: $("pm-custom-cli-adapter").value, args: args, source: source });
      state.cliCatalog = result.catalog || state.cliCatalog; state.providers = result.providers || state.providers; refreshProviderChoices(); renderCliCatalog();
      $("pm-agent").value = result.added.providerId; selectManagedProvider(result.added.providerId); syncComposerPreference(result.added.providerId); $("pm-custom-cli-form").reset(); $("pm-custom-cli-advanced").open = false; updateCustomCliSourceFields();
      setStatus(result.installed.message || (result.added.label + " CLI 已添加并安装，可在上方供应商选择器中切换。"), "success");
    } catch (error) { setStatus(error.message, "error"); }
  }
  function renderProviderConfig(item) {
    var form = $("pm-provider-editor"); if (form) { form.hidden = !state.supplierEditorOpen; if (state.managedProviderId === "codex") form.hidden = true; }
    var status = $("pm-provider-status"); if (!status) return;
    if (!item) { status.textContent = "请选择 Agent"; status.dataset.kind = ""; return; }
    var apiStatus = item.config && item.config.api && item.config.api.apiKeyConfigured ? " · API Key 已配置" : " · 等待供应商配置";
    status.textContent = item.label + " · " + providerStatusText(item) + apiStatus;
    status.dataset.kind = item.available ? "success" : "";
  }
  function renderSupplierList() {
    var list = $("pm-supplier-list"); if (!list) return;
    list.replaceChildren();
    if (!state.supplierProfiles.length) {
      list.innerHTML = '<p class="pm-muted">还没有供应商，点右上角 + 添加。</p>';
    } else {
      state.supplierProfiles.forEach(function (profile) {
        var supplierRow = document.createElement("div");
        supplierRow.className = "pm-supplier-row" + (profile.id === state.activeSupplierId ? " active" : "");
        supplierRow.tabIndex = 0;
        supplierRow.setAttribute("role", "button");
        supplierRow.innerHTML = '<span class="pm-supplier-mark">' + esc((profile.name || "?").slice(0, 1).toUpperCase()) + '</span><span class="pm-supplier-main"><strong>' + esc(profile.name || profile.id) + '</strong><small>' + esc(profile.baseUrl || "未设置接口地址") + '</small><small>' + esc(profile.model || "未选择模型") + (profile.apiKeyConfigured ? " · Key 已配置" : " · 待配置 Key") + '</small></span><span class="pm-supplier-state">' + (profile.id === state.activeSupplierId ? "当前" : "切换") + '</span>';
        supplierRow.addEventListener("click", function () { selectManagedSupplier(profile.id); });
        supplierRow.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectManagedSupplier(profile.id); } });
        list.appendChild(supplierRow);
      });
    }
    var edit = $("pm-edit-supplier"); if (edit) edit.disabled = !state.activeSupplierId;
  }
  function renderSupplierChoices() {
    var select = $("pm-supplier");
    if (select) {
      select.replaceChildren();
      state.supplierProfiles.forEach(function (profile) { var option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name + (profile.apiKeyConfigured ? "" : " · 待配置 Key"); select.appendChild(option); });
      select.hidden = true; select.disabled = !state.supplierProfiles.length; select.value = state.activeSupplierId || "";
    }
    var current = state.supplierProfiles.find(function (profile) { return profile.id === state.activeSupplierId; }) || state.supplierProfiles[0];
    state.activeSupplierId = current ? current.id : null;
    renderSupplierList();
    if (state.supplierEditorOpen && state.managedProviderId !== "codex") renderSupplierEditor(current);
  }
  function renderSupplierEditor(profile) {
    var form = $("pm-provider-editor"); if (!form) return;
    form.hidden = !state.supplierEditorOpen;
    if (state.managedProviderId === "codex") { form.hidden = true; return; }
    var agent = state.providers.find(function (item) { return item.id === state.managedProviderId; });
    var isPi = managedProviderFamily(agent || state.managedProviderId) === "pi";
    $("pm-supplier-id").value = profile ? profile.id : "";
    $("pm-supplier-name").value = profile ? profile.name : "";
    var protocolSelect = $("pm-provider-api-protocol");
    var protocolLabels = managedProtocolLabels(agent || state.managedProviderId);
    var nativeOption = protocolSelect.querySelector('option[value="native"]');
    var compatibleOption = protocolSelect.querySelector('option[value="openai-compatible"]');
    if (nativeOption) nativeOption.textContent = protocolLabels.native;
    if (compatibleOption) compatibleOption.textContent = protocolLabels.compatible;
    var protocolHelp = $("pm-provider-protocol-help"); if (protocolHelp) { protocolHelp.textContent = protocolLabels.help; protocolHelp.hidden = false; }
    protocolSelect.value = profile ? profile.apiProtocol || "native" : "native";
    $("pm-provider-base-url").value = profile ? profile.baseUrl || "" : "";
    $("pm-provider-model").value = profile ? profile.model || "" : "";
    state.providerFetchedModels = normalizeModelIds(profile && profile.models, profile && profile.model);
    renderManagedProviderModels(state.providerFetchedModels, profile && profile.model);
    $("pm-provider-models").value = state.providerFetchedModels.join("\n");
    $("pm-provider-context-window").value = profile && profile.contextWindowMaxTokens ? String(profile.contextWindowMaxTokens) : "";
    var thinkingRow = $("pm-provider-thinking-row"); if (thinkingRow) thinkingRow.hidden = !isPi;
    var thinkingSelect = $("pm-provider-thinking"); if (thinkingSelect) thinkingSelect.value = isPi && profile ? profile.thinkingOptionId || "medium" : "medium";
    $("pm-provider-api-key").value = "";
    $("pm-provider-clear-api-key").checked = false;
    $("pm-provider-env").value = "";
    $("pm-provider-clear-env").checked = false;
    $("pm-provider-command").value = agent && agent.config && agent.config.command ? JSON.stringify(agent.config.command) : "";
    $("pm-delete-supplier").disabled = !profile;
    var status = $("pm-provider-status"); if (status) status.textContent = "";
  }
  function setSupplierEditorMode(enabled) {
    var panel = root && root.querySelector('[data-pm-panel="agent"]'); if (panel) panel.classList.toggle("pm-editing", Boolean(enabled));
  }
  function openManagedSupplierEditor(profile, createNew) {
    state.supplierEditorOpen = true;
    setSupplierEditorMode(true);
    var selected = createNew ? null : profile || state.supplierProfiles.find(function (item) { return item.id === state.activeSupplierId; }) || null;
    if (selected) state.activeSupplierId = selected.id;
    if (state.managedProviderId === "codex") { openEditor(selected); renderCodexAdvancedApi(); }
    else renderSupplierEditor(selected);
    renderSupplierList();
  }
  function closeManagedSupplierEditor() {
    state.supplierEditorOpen = false;
    setSupplierEditorMode(false);
    var form = $("pm-provider-editor"); if (form) form.hidden = true;
    var editor = $("pm-editor"); if (editor) editor.hidden = true;
    renderCodexAdvancedApi(); renderSupplierList();
  }
  async function loadAgentSuppliers(id) {
    state.supplierProfiles = []; state.activeSupplierId = null;
    if (!id) { renderSupplierChoices(); return; }
    try {
      if (id === "codex") {
        state.supplierProfiles = state.profiles.map(function (profile) { return Object.assign({}, profile, { name: profile.name, apiKeyConfigured: profile.apiKeyConfigured }); });
        state.activeSupplierId = state.activeId;
      } else {
        var result = await manager("supplier-profiles", { providerId: id });
        state.supplierProfiles = result.profiles || [];
        state.activeSupplierId = result.activeId || null;
      }
      renderSupplierChoices();
    } catch (error) { setStatus(error.message, "error"); renderSupplierChoices(); }
  }
  async function selectManagedSupplier(id) {
    if (!id) return;
    var providerId = state.managedProviderId;
    try {
      closeManagedSupplierEditor();
      if (providerId === "codex") {
        await activateProfile(id);
        return;
      }
      var result = await manager("supplier-switch", null, { providerId: providerId, supplierId: id });
      state.activeSupplierId = id; state.supplierProfiles = result.suppliers?.profiles || state.supplierProfiles; state.providers = result.providers || state.providers;
      var selectedProfile = state.supplierProfiles.find(function (item) { return item.id === id; }) || {};
      refreshProviderChoices(); renderProviderConfig(state.providers.find(function (item) { return item.id === providerId; })); renderSupplierChoices(); syncComposerPreference(providerId, selectedProfile.model || "", true, selectedProfile.thinkingOptionId);
      setStatus("已切换供应商：" + id + "，正在刷新原生输入框。", "success"); window.setTimeout(function () { window.location.reload(); }, 350);
    } catch (error) { setStatus(error.message, "error"); renderSupplierChoices(); }
  }
  function newManagedSupplier() { openManagedSupplierEditor(null, true); window.setTimeout(function () { var name = state.managedProviderId === "codex" ? $("pm-name") : $("pm-supplier-name"); if (name) name.focus(); }, 0); }
  function editManagedSupplier() { var profile = state.supplierProfiles.find(function (item) { return item.id === state.activeSupplierId; }); if (profile || state.managedProviderId === "codex") openManagedSupplierEditor(profile); }
  async function deleteManagedSupplier() {
    var id = state.managedProviderId, supplierId = state.supplierEditorOpen ? $("pm-supplier-id").value : state.activeSupplierId;
    if (!id || !supplierId || !confirm("删除这个供应商档案？不会删除 Agent CLI。")) return;
    try {
      if (id === "codex") { await deleteProfile(); return; }
      var result = await manager("supplier-delete", null, { providerId: id, supplierId: supplierId }); state.supplierProfiles = result.suppliers?.profiles || []; state.activeSupplierId = result.suppliers?.activeId || null; state.providers = result.providers || state.providers; refreshProviderChoices(); renderSupplierChoices(); setStatus("供应商档案已删除。", "success");
    } catch (error) { setStatus(error.message, "error"); }
  }
  async function selectManagedProvider(id) { closeManagedSupplierEditor(); state.managedProviderId = id; persistManagedProviderPreference(id); refreshProviderChoices(); renderProviderConfig(state.providers.find(function (item) { return item.id === id; })); renderCodexAdvancedApi(); await loadAgentSuppliers(id); }
  function renderManagedProviderModels(values, selectedModel) {
    var select = $("pm-provider-fetched-models"); if (!select) return;
    var ids = normalizeModelIds(values, selectedModel); select.replaceChildren();
    if (!ids.length) { var empty = document.createElement("option"); empty.value = ""; empty.textContent = "先获取模型"; select.appendChild(empty); select.disabled = true; return; }
    ids.forEach(function (id) { var option = document.createElement("option"); option.value = id; option.textContent = id; select.appendChild(option); });
    select.disabled = false; select.value = selectedModel && ids.indexOf(selectedModel) >= 0 ? selectedModel : ids[0];
  }
  function renderCodexAdvancedApi() {
    var panel = $("pm-codex-advanced-api"); if (panel) panel.hidden = state.managedProviderId !== "codex" || !state.supplierEditorOpen;
  }
  async function fetchManagedProviderModels() {
    var button = $("pm-provider-fetch-models"); if (!button || !state.managedProviderId) return;
    button.disabled = true; button.textContent = "获取中…";
    try {
      var result = await manager("provider-models", null, { providerId: state.managedProviderId, apiProtocol: $("pm-provider-api-protocol").value, baseUrl: $("pm-provider-base-url").value.trim(), apiKey: $("pm-provider-api-key").value.trim() });
      state.providerFetchedModels = normalizeModelIds(result.models, $("pm-provider-model").value.trim());
      renderManagedProviderModels(state.providerFetchedModels, $("pm-provider-model").value.trim());
      setStatus("已获取并显示全部 " + state.providerFetchedModels.length + " 个模型，请从下拉框选择。", "success");
    } catch (error) { setStatus(error.message, "error"); }
    finally { button.disabled = false; button.textContent = "获取模型"; }
  }
  function selectManagedProviderModel(event) {
    var model = (event && event.currentTarget ? event.currentTarget.value : $("pm-provider-fetched-models").value).trim();
    if (!model) return;
    $("pm-provider-model").value = model;
    state.providerFetchedModels = normalizeModelIds(state.providerFetchedModels, model);
    setStatus("已选择 " + model + "；保存后会进入该供应商的原生模型选择器。", "success");
  }
  async function saveManagedProvider(event) {
    if (event) event.preventDefault(); var id = state.managedProviderId; if (!id) return;
    if (id !== "codex") {
      var supplier = { id: $("pm-supplier-id").value.trim() || undefined, name: $("pm-supplier-name").value.trim(), apiProtocol: $("pm-provider-api-protocol").value, baseUrl: $("pm-provider-base-url").value.trim(), model: $("pm-provider-model").value.trim(), models: normalizeModelIds(state.providerFetchedModels.concat($("pm-provider-models").value.split(/\r?\n/u)), $("pm-provider-model").value), contextWindowMaxTokens: $("pm-provider-context-window").value.trim() ? Number($("pm-provider-context-window").value) : null };
      if (managedProviderFamily(id) === "pi") supplier.thinkingOptionId = $("pm-provider-thinking").value || "medium";
      var supplierKey = $("pm-provider-api-key").value.trim();
      if ($("pm-provider-clear-api-key").checked) supplier.apiKey = null; else if (supplierKey) supplier.apiKey = supplierKey;
      var supplierEnvText = $("pm-provider-env").value.trim();
      if ($("pm-provider-clear-env").checked) supplier.env = {}; else if (supplierEnvText) { try { supplier.env = JSON.parse(supplierEnvText); } catch (_) { setStatus("环境变量必须是 JSON 对象", "error"); return; } }
      if (!supplier.name) { setStatus("供应商名称不能为空", "error"); return; }
      try {
        var agentItem = state.providers.find(function (item) { return item.id === id; });
        var agentCommandText = $("pm-provider-command").value.trim();
        var agentSettings = { providerId: id, enabled: true, providerFamily: agentItem && agentItem.agentFamilyId || undefined, command: agentCommandText ? JSON.parse(agentCommandText) : null };
        if (!Array.isArray(agentSettings.command) && agentSettings.command !== null) throw new Error("启动命令必须是 JSON 字符串数组");
        var supplierResult = await manager("supplier-save", null, { providerId: id, profile: supplier, activate: true });
        var agentResult = await manager("provider-save", null, agentSettings);
        state.supplierProfiles = supplierResult.suppliers?.profiles || state.supplierProfiles; state.activeSupplierId = supplierResult.suppliers?.activeId || supplierResult.savedSupplierId; state.providers = agentResult.providers || supplierResult.providers || state.providers; closeManagedSupplierEditor(); refreshProviderChoices(); renderProviderConfig(state.providers.find(function (item) { return item.id === id; })); renderSupplierChoices(); syncComposerPreference(id, supplier.model || "", true, supplier.thinkingOptionId); setStatus("供应商已保存并切换；Agent 已自动启用。", "success"); window.setTimeout(function () { window.location.reload(); }, 350);
      } catch (error) { setStatus(error.message, "error"); }
      return;
    }
    var body = { providerId: id, enabled: true, apiProtocol: $("pm-provider-api-protocol").value };
    var commandText = $("pm-provider-command").value.trim();
    try {
      body.baseUrl = $("pm-provider-base-url").value.trim() || null;
      body.model = $("pm-provider-model").value.trim() || null;
      body.contextWindowMaxTokens = $("pm-provider-context-window").value.trim() ? Number($("pm-provider-context-window").value) : null;
      body.additionalModelIds = normalizeModelIds(state.providerFetchedModels.concat($("pm-provider-models").value.split(/\r?\n/u)), body.model);
      var apiKeyText = $("pm-provider-api-key").value.trim();
      if ($("pm-provider-clear-api-key").checked) body.apiKey = null;
      else if (apiKeyText) body.apiKey = apiKeyText;
      body.command = commandText ? JSON.parse(commandText) : null;
      if (!Array.isArray(body.command) && body.command !== null) throw new Error("启动命令必须是 JSON 字符串数组");
      var envText = $("pm-provider-env").value.trim();
      if ($("pm-provider-clear-env").checked) body.env = null;
      else if (envText) { body.env = JSON.parse(envText); if (!body.env || Array.isArray(body.env) || typeof body.env !== "object") throw new Error("环境变量必须是 JSON 对象"); }
      var result = await manager("provider-save", null, body); state.providers = result.providers || state.providers; closeManagedSupplierEditor(); refreshProviderChoices(); $("pm-agent").value = id; renderProviderConfig(state.providers.find(function (item) { return item.id === id; })); renderCodexAdvancedApi(); syncComposerPreference(id, body.model || "", true); setStatus("已保存并切换到 " + id + "，正在刷新原生输入框和模型选择。", "success"); window.setTimeout(function () { window.location.reload(); }, 350);
    } catch (error) { setStatus(error.message, "error"); }
  }
  async function refreshManagedProvider() { var id = state.managedProviderId; if (!id) return; var button = $("pm-provider-refresh"); button.disabled = true; try { var result = await manager("provider-refresh", null, { providerId: id }); state.providers = result.providers || state.providers; refreshProviderChoices(); $("pm-agent").value = id; renderProviderConfig(state.providers.find(function (item) { return item.id === id; })); setStatus("已刷新 " + id + " 的运行状态。", "success"); } catch (error) { setStatus(error.message, "error"); } finally { button.disabled = false; } }
  async function loadSwitch() {
    try { var data = await Promise.all([codex(), manager("providers"), manager("provider-cli-catalog")]); state.profiles = data[0].profiles || []; state.activeId = data[0].activeId; state.retryStatus = data[0].retryStatus || state.retryStatus; state.codexModelCatalogValid = data[0].modelCatalogValid === true; state.providers = data[1].providers || []; state.cliCatalog = data[2].catalog || []; renderCliCatalog(); var pref = readComposerPreferences(); var managedProviderId = readManagedProviderPreference(); var preferred = state.providers.find(function (item) { return item.id === managedProviderId; }) || state.providers.find(function (item) { return item.id === pref.provider; }) || state.providers.find(function (item) { return item.available; }) || state.providers[0]; refreshProviderChoices(); if (preferred) { $("pm-agent").value = preferred.id; await selectManagedProvider(preferred.id); } else persistManagedProviderPreference(""); renderProfiles(); renderSqueeze(); var available = state.providers.filter(function (item) { return item.available; }); if (state.tab === "cli" && !available.length) setStatus("暂无可用 CLI，请在此页安装或添加。", "error"); else if (available.length) setStatus("", ""); } catch (error) { setStatus(error.message, "error"); }
    var activeProfile = state.profiles.find(function (item) { return item.id === state.activeId; });
    var codexProvider = state.providers.find(function (item) { return item.id === "codex"; });
    if (codexProfileNeedsSync(activeProfile, codexProvider)) await syncCodexProfileToComposer(activeProfile, true, false);
  }
  async function activateProfile(id) { try { state = Object.assign(state, await codex({ action: "activate", id: id })); var profile = state.profiles.find(function (item) { return item.id === id; }); state.activeSupplierId = id; state.supplierProfiles = state.profiles.slice(); closeManagedSupplierEditor(); await syncCodexProfileToComposer(profile, true); renderProfiles(); renderSupplierChoices(); renderSqueeze(); setStatus("已切换到 Agent Codex 的供应商“" + (profile || {}).name + "”，原生输入框将使用对应模型。", "success"); } catch (error) { setStatus(error.message, "error"); } }
  async function toggleSqueeze() { var item = state.profiles.find(function (profile) { return profile.id === state.activeId; }); if (!item) { await loadSwitch(); item = state.profiles.find(function (profile) { return profile.id === state.activeId; }); } if (!item) return; var button = $("pm-squeeze"); button.disabled = true; try { state = Object.assign(state, await codex({ action: "busy-retry-toggle", id: item.id, enabled: !item.busyRetryEnabled })); renderProfiles(); renderSqueeze(); setStatus(state.squeezeEnabled ? "挤入模式已开启：持续请求直到连上或再次关闭。" : "挤入模式已关闭。", "success"); } catch (error) { setStatus(error.message, "error"); } finally { button.disabled = false; } }
  function scheduleRetryStatusPoll(delay) {
    if (retryPollTimer) window.clearTimeout(retryPollTimer);
    retryPollTimer = window.setTimeout(function () {
      retryPollTimer = null;
      if (document.hidden) { scheduleRetryStatusPoll(15000); return; }
      refreshRetryStatus();
    }, delay);
  }
  async function refreshRetryStatus() {
    if (retryPollInFlight) return;
    retryPollInFlight = true;
    try {
      var result = await codex();
      state.retryStatus = result.retryStatus || null;
      renderSqueeze();
      scheduleRetryStatusPoll(state.retryStatus && state.retryStatus.active ? 1200 : 15000);
    } catch (_) {
      scheduleRetryStatusPoll(15000);
    } finally {
      retryPollInFlight = false;
    }
  }
  function openEditor(item) { state.supplierEditorOpen = true; setSupplierEditorMode(true); renderCodexAdvancedApi(); $("pm-editor").hidden = false; $("pm-name").value = item ? item.name : ""; $("pm-url").value = item ? item.baseUrl : ""; $("pm-model").value = item ? item.model || "" : ""; editorModelIds = profileModelIds(item); renderFetchedModels(editorModelIds, item && item.model); $("pm-context-window").value = item && item.contextWindowMaxTokens ? String(item.contextWindowMaxTokens) : ""; $("pm-effort").value = item ? item.reasoningEffort : "medium"; $("pm-permission").value = item ? item.permission : DEFAULT_PERMISSION; $("pm-wire").value = item ? item.wireApi || "responses" : "responses"; $("pm-busy-retry").checked = Boolean(item && item.busyRetryEnabled); $("pm-busy-attempts").value = item && item.busyRetryAttempts || 6; $("pm-busy-retry-delay").value = item && item.busyRetryDelayMs || 300; $("pm-key").value = ""; $("pm-key").classList.add("pm-secret"); $("pm-editor").dataset.id = item ? item.id : ""; $("pm-delete-profile").disabled = !item || state.profiles.length < 2; $("pm-sync-cli").disabled = !item; }
  async function fetchModels() { var button = $("pm-fetch-models"); button.disabled = true; button.textContent = "获取中…"; setStatus("正在获取模型…"); try { var contextWindowMaxTokens = $("pm-context-window").value.trim() ? Number($("pm-context-window").value) : null; var result = await codex({ action: "models", id: $("pm-editor").dataset.id || undefined, name: $("pm-name").value, baseUrl: $("pm-url").value, apiKey: $("pm-key").value, reasoningEffort: $("pm-effort").value, permission: $("pm-permission").value, wireApi: $("pm-wire").value, model: $("pm-model").value, contextWindowMaxTokens: contextWindowMaxTokens }); state = Object.assign(state, result); var ids = normalizeModelIds(result.fetchedModels, $("pm-model").value); editorModelIds = ids; renderFetchedModels(ids, $("pm-model").value); var providerResult = await manager("provider-save", null, { providerId: "codex", additionalModelIds: ids, model: $("pm-model").value.trim() || null, contextWindowMaxTokens: contextWindowMaxTokens }); state.providers = providerResult.providers || state.providers; setStatus("已获取并显示全部 " + ids.length + " 个模型；请选择后会同步到原生输入框。", "success"); } catch (error) { setStatus(error.message, "error"); } finally { button.disabled = false; button.textContent = "获取模型"; } }
  function selectFetchedModel(event) { var model = (event && event.currentTarget ? event.currentTarget.value : $("pm-fetched-models").value).trim(); if (!model) return; $("pm-model").value = model; editorModelIds = normalizeModelIds(editorModelIds, model); setStatus("已选择 " + model + "；点击“保存并启用”后同步到原生输入框。", "success"); }
  async function saveProfile(event) { event.preventDefault(); var body = { action: "save", id: $("pm-editor").dataset.id || undefined, name: $("pm-name").value, baseUrl: $("pm-url").value, apiKey: $("pm-key").value, model: $("pm-model").value, models: normalizeModelIds(editorModelIds, $("pm-model").value), contextWindowMaxTokens: $("pm-context-window").value.trim() ? Number($("pm-context-window").value) : null, reasoningEffort: $("pm-effort").value, permission: $("pm-permission").value, wireApi: $("pm-wire").value, busyRetryEnabled: $("pm-busy-retry").checked, busyRetryAttempts: Number($("pm-busy-attempts").value), busyRetryDelayMs: Number($("pm-busy-retry-delay").value) }; try { state = Object.assign(state, await codex(body)); var profile = state.profiles.find(function (item) { return item.id === state.activeId; }); state.supplierProfiles = state.profiles.slice(); state.activeSupplierId = state.activeId; closeManagedSupplierEditor(); renderProfiles(); renderSupplierChoices(); renderSqueeze(); await syncCodexProfileToComposer(profile, true); setStatus("供应商已保存并切换，模型将显示在原生输入框。", "success"); } catch (error) { setStatus(error.message, "error"); } }
  async function deleteProfile() { if (!confirm("删除这个 Paseo 供应商预设？不会删除 CLI 文件。")) return; try { state = Object.assign(state, await codex({ action: "delete", id: $("pm-editor").dataset.id })); state.supplierProfiles = state.profiles.slice(); state.activeSupplierId = state.activeId; closeManagedSupplierEditor(); renderProfiles(); renderSupplierChoices(); } catch (error) { setStatus(error.message, "error"); } }
  async function syncProfileToCli() { if (!confirm("这会写入 ~/.codex/config.toml 和 auth.json。请先关闭正在运行的 Codex CLI，确认继续？")) return; try { state = Object.assign(state, await codex({ action: "sync-cli", id: $("pm-editor").dataset.id })); setStatus("已按你的确认同步到 Codex CLI。", "success"); } catch (error) { setStatus(error.message, "error"); } }
  async function saveAgentPreference() { var provider = $("pm-agent").value, item = state.providers.find(function (entry) { return entry.id === provider; }); if (!item || !item.available) { setStatus("所选 Agent 当前不可用，请先到 CLI 页安装或检查对应 CLI。", "error"); return; } syncComposerPreference(provider); setStatus("已切换新对话默认 Agent，正在刷新界面使它立即生效。", "success"); window.setTimeout(function () { window.location.reload(); }, 450); }
  function formatTime(value) { try { return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  function conversationStatus(value) {
    var status = String(value || "").toLowerCase();
    if (/run|work|active|stream|busy|process/.test(status)) return "运行中";
    if (/complete|done|finish|success/.test(status)) return "已完成";
    if (/error|fail/.test(status)) return "出错";
    if (/close|idle|archive/.test(status)) return "已关闭";
    return value ? String(value) : "未知";
  }
  var conversationRequest = null, importableRequest = null;
  async function loadImportableCount() {
    if (importableRequest) return importableRequest;
    var button = $("pm-import-all"), controller = typeof AbortController === "function" ? new AbortController() : null;
    var timeout = controller ? window.setTimeout(function () { controller.abort(); }, 10000) : null;
    button.textContent = "正在扫描可导入对话…"; button.disabled = true;
    importableRequest = (async function () {
      try { var data = await manager("importable", null, null, controller && controller.signal); state.importableEntries = data.entries || []; state.importable = state.importableEntries.length; button.textContent = "一键导入全部（" + state.importable + "）"; renderImportableConversations(); }
      catch (error) { button.textContent = "扫描超时，点击重试"; if (error.name !== "AbortError") setStatus(error.message, "error"); }
      finally { if (timeout) window.clearTimeout(timeout); button.disabled = false; importableRequest = null; }
    })();
    return importableRequest;
  }
  async function loadConversations(scanImportable) {
    if (scanImportable !== false) loadImportableCount();
    if (conversationRequest) return conversationRequest;
    conversationRequest = (async function () {
      try { var data = await manager("conversations"); state.conversations = data.conversations || []; renderConversations(); }
      catch (error) { setStatus(error.message, "error"); }
      finally { conversationRequest = null; }
    })();
    return conversationRequest;
  }
  async function manualRefreshStatus() {
    var button = $("pm-refresh-conv"); button.disabled = true; button.textContent = "同步中…";
    try {
      var data = await manager("conversations"); state.conversations = data.conversations || []; renderConversations();
      setStatus("后台状态已同步，正在重新载入页面。", "success");
      window.setTimeout(function () { window.location.reload(); }, 250);
    }
    catch (error) { setStatus(error.message, "error"); button.disabled = false; button.textContent = "刷新状态"; }
  }
  function renderConversations() { var list = $("pm-conversations"); list.replaceChildren(); if (!state.conversations.length) { list.innerHTML = "<p class=pm-muted>暂无已导入对话。</p>"; return; } state.conversations.forEach(function (item) { var row = document.createElement("div"); row.className = "pm-row"; var status = conversationStatus(item.status); row.innerHTML = "<div><strong>" + esc(item.title) + "</strong><small>" + esc(item.provider) + " · " + esc(item.cwd) + " · " + formatTime(item.updatedAt) + "</small></div><span class=pm-conversation-status data-status=\"" + esc(String(item.status || "unknown").toLowerCase()) + "\">" + esc(status) + "</span>"; var button = document.createElement("button"); button.className = "pm-danger"; button.type = "button"; button.textContent = "删除"; button.onclick = function () { deleteConversation(item); }; row.appendChild(button); list.appendChild(row); }); }
  function renderImportableConversations() { var list = $("pm-importable"); if (!list) return; list.replaceChildren(); if (!state.importableEntries.length) { list.innerHTML = "<p class=pm-muted>暂时没有可导入对话。</p>"; return; } state.importableEntries.forEach(function (item) { var row = document.createElement("div"); row.className = "pm-row"; row.innerHTML = "<div><strong>" + esc(item.title || item.firstPromptPreview || "未命名对话") + "</strong><small>" + esc(item.providerLabel || item.providerId) + " · " + esc(item.cwd) + " · " + formatTime(item.lastActivityAt) + "</small></div>"; var button = document.createElement("button"); button.className = "pm-primary"; button.type = "button"; button.textContent = "导入"; button.onclick = function () { importConversation(item, button); }; row.appendChild(button); list.appendChild(row); }); }
  async function importConversation(item, button) { button.disabled = true; button.textContent = "导入中…"; try { await manager("conversation-import", null, { providerId: item.providerId, providerHandleId: item.providerHandleId, cwd: item.cwd }); setStatus("对话已导入。", "success"); await loadConversations(true); } catch (error) { setStatus(error.message, "error"); button.disabled = false; button.textContent = "导入"; } }
  async function deleteConversation(item) { if (!confirm("删除对话“" + item.title + "”？此操作会移除 Paseo 记录。")) return; try { await manager("conversation-delete", null, { id: item.id }); setStatus("对话已删除，正在刷新列表。", "success"); await loadConversations(); } catch (error) { setStatus(error.message, "error"); } }
  async function importAll() { if (!state.importable) { await loadImportableCount(); return; } if (!confirm("导入全部 " + state.importable + " 个可用对话？不会停止独立 CLI。")) return; var button = $("pm-import-all"); button.disabled = true; button.textContent = "正在导入…"; try { var result = await manager("conversation-import-all", null, {}); setStatus("导入完成：" + result.imported.length + " 个成功，" + result.failed.length + " 个失败。", result.failed.length ? "error" : "success"); await loadConversations(true); } catch (error) { setStatus(error.message, "error"); } finally { button.disabled = false; } }
  async function loadDirectories(dir) { try { var data = await manager("directories", dir ? { path: dir } : null); state.directory = data.path; state.directoryParent = data.parent || null; $("pm-dir-path").textContent = data.path; $("pm-dir-up").disabled = !state.directoryParent; var roots = $("pm-roots"); roots.replaceChildren(); (data.roots || []).forEach(function (item) { var b = document.createElement("button"); b.type = "button"; b.className = "pm-chip"; b.textContent = item.label; b.onclick = function () { loadDirectories(item.path); }; roots.appendChild(b); }); var list = $("pm-directories"); list.replaceChildren(); (data.directories || []).forEach(function (item) { var b = document.createElement("button"); b.type = "button"; b.className = "pm-directory"; b.innerHTML = "📁 <span>" + esc(item.name) + "</span>"; b.onclick = function () { loadDirectories(item.path); }; list.appendChild(b); }); $("pm-use-dir").textContent = state.directoryPurpose === "skill" ? "导入此目录为 Skill" : state.directoryPurpose === "plugin" ? "导入此目录为插件" : "在此目录创建工作区"; await loadWorkspaces(); } catch (error) { setStatus(error.message, "error"); } }
  async function useDirectory() { var purpose = state.directoryPurpose; if (purpose === "skill" || purpose === "plugin") { try { var importBody = { path: state.directory }; if (purpose === "skill") importBody.target = state.skillTarget; await manager(purpose + "-import", null, importBody); setStatus("已导入，请在管理列表确认。", "success"); state.directoryPurpose = null; setTab(purpose === "skill" ? "skills" : "plugins"); } catch (error) { setStatus(error.message, "error"); } return; } try { var result = await manager("workspace-add", null, { path: state.directory }); setStatus("工作区已添加：" + result.workspace.name, "success"); if (result.serverId && result.workspace.id) window.location.href = "/h/" + encodeURIComponent(result.serverId) + "/workspace/" + encodeURIComponent(result.workspace.id); } catch (error) { setStatus(error.message, "error"); } }
  async function loadWorkspaces() { try { var data = await manager("workspaces"); var list = $("pm-workspaces"); list.replaceChildren(); (data.workspaces || []).forEach(function (item) { var b = document.createElement("button"); b.type = "button"; b.className = "pm-row pm-workspace"; b.innerHTML = "<div><strong>" + esc(item.name) + "</strong><small>" + esc(item.cwd) + "</small></div><span>打开</span>"; b.onclick = function () { if (item.id) window.location.href = "/h/" + encodeURIComponent(item.serverId) + "/workspace/" + encodeURIComponent(item.id); }; list.appendChild(b); }); } catch (_) {} }
  async function loadSkills() { try { state.skills = (await manager("skills")).skills || []; renderSkills(); } catch (error) { setStatus(error.message, "error"); } }
  function renderSkills() { var list = $("pm-skills"); list.replaceChildren(); var visible = state.skills.filter(function (item) { return state.skillFilter === "all" || (state.skillFilter === "system" ? item.readOnly : item.store === state.skillFilter); }); if (!visible.length) { list.innerHTML = "<p class=pm-muted>这个分类暂无 Skill。</p>"; return; } visible.forEach(function (item) { var row = document.createElement("div"); row.className = "pm-row"; var sourceText = item.readOnly ? "系统内置" : item.sourcePath ? "可跟进上游" : "本地目录"; row.innerHTML = "<div><strong>" + esc(item.name) + "</strong><small>" + esc(item.scope) + " · " + (item.enabled ? "已启用" : "已停用") + " · " + sourceText + "<br>" + esc(item.description) + "</small></div>"; if (!item.readOnly) { var toggle = document.createElement("button"); toggle.className = "pm-secondary"; toggle.textContent = item.enabled ? "停用" : "启用"; toggle.onclick = function () { manager("skill-toggle", null, { id: item.id, enabled: !item.enabled }).then(loadSkills).catch(function (e) { setStatus(e.message, "error"); }); }; if (item.sourcePath) { var update = document.createElement("button"); update.className = "pm-secondary"; update.textContent = "更新"; update.title = item.sourcePath; update.onclick = function () { update.disabled = true; manager("skill-update", null, { id: item.id }).then(function (result) { setStatus("Skill 已从上游同步。", "success"); state.skills = result.skills || state.skills; renderSkills(); }).catch(function (e) { setStatus(e.message, "error"); update.disabled = false; }); }; row.append(toggle, update); } else row.append(toggle); var del = document.createElement("button"); del.className = "pm-danger"; del.textContent = "删除"; del.onclick = function () { if (confirm("移到 Paseo 回收站？")) manager("skill-delete", null, { id: item.id }).then(loadSkills).catch(function (e) { setStatus(e.message, "error"); }); }; row.append(del); } else row.innerHTML += "<span class=pm-badge>内置</span>"; list.appendChild(row); }); }
  async function loadPlugins() { try { state.plugins = (await manager("plugins")).plugins || []; renderPlugins(); } catch (error) { setStatus(error.message, "error"); } }
  function renderPlugins() { var list = $("pm-plugins"); list.replaceChildren(); state.plugins.forEach(function (item) { var row = document.createElement("div"); row.className = "pm-row"; row.innerHTML = "<div><strong>" + esc(item.name) + "</strong><small>" + esc(item.version || "无版本") + " · " + (item.valid ? (item.enabled ? "已启用" : "已停用") : "清单无效") + "<br>" + esc(item.description) + "</small></div>"; var toggle = document.createElement("button"); toggle.className = "pm-secondary"; toggle.textContent = item.enabled ? "停用" : "启用"; toggle.disabled = !item.valid; toggle.onclick = function () { manager("plugin-toggle", null, { id: item.id, enabled: !item.enabled }).then(loadPlugins).catch(function (e) { setStatus(e.message, "error"); }); }; var del = document.createElement("button"); del.className = "pm-danger"; del.textContent = "删除"; del.onclick = function () { if (confirm("移到 Paseo 回收站？")) manager("plugin-delete", null, { id: item.id }).then(loadPlugins).catch(function (e) { setStatus(e.message, "error"); }); }; row.append(toggle, del); list.appendChild(row); }); }
  function mergeAgentPanels() {
    var switchPanel = root.querySelector('[data-pm-panel="switch"]'), interfacePanel = root.querySelector('[data-pm-panel="interfaces"]');
    if (!switchPanel || !interfacePanel) return;
    switchPanel.dataset.pmPanel = "agent";
    var heading = switchPanel.querySelector("h3"); if (heading) heading.textContent = "Agent";
    var saveButton = $("pm-save-agent"); if (saveButton) saveButton.hidden = true;
    var agentSelect = $("pm-agent"); if (agentSelect && agentSelect.parentElement) agentSelect.parentElement.hidden = true;
    var switchHelp = switchPanel.querySelector(".pm-help"); if (switchHelp) switchHelp.textContent = "选择 Agent，然后点一个供应商即可切换。";
    var duplicateSelect = $("pm-provider-config"); if (duplicateSelect && duplicateSelect.parentElement) duplicateSelect.parentElement.remove();
    var interfaceHelp = interfacePanel.querySelector(".pm-help"); if (interfaceHelp) interfaceHelp.hidden = true;
    var supplierPanel = document.createElement("section"); supplierPanel.id = "pm-supplier-panel"; supplierPanel.setAttribute("aria-label", "选择这个 Agent 的供应商"); supplierPanel.innerHTML = '<header class="pm-supplier-head"><h3>供应商</h3><div class="pm-supplier-tools"><button id="pm-edit-supplier" class="pm-icon-action" type="button" title="编辑当前供应商" aria-label="编辑当前供应商">编辑</button><button id="pm-add-supplier" class="pm-add-action" type="button" title="添加供应商" aria-label="添加供应商">+</button></div></header><select id="pm-supplier" class="pm-select" hidden aria-hidden="true"></select><div id="pm-supplier-list" class="pm-supplier-list"></div>'; switchPanel.appendChild(supplierPanel);
    var globalSettings = document.createElement("section"); globalSettings.className = "pm-global-settings"; globalSettings.setAttribute("aria-label", "所有 Agent 的全局提示词"); globalSettings.innerHTML = '<h3>所有 Agent 的全局提示词</h3><p class="pm-help">这里的内容会作为追加提示词用于 Codex、Claude、Pi、OpenCode、ACP 及其他 Paseo Agent 的新建或恢复会话，不属于任何单独供应商。</p><details id="pm-base-system-prompt-block" class="pm-base-prompt" hidden><summary>内置环境提示词（自动生成，只读）</summary><p class="pm-help">Paseo 启动时会检测本机的 Android 版本、架构、HOME/PREFIX/PATH 和实际可用命令，把下面这段提示词自动发给每个 Agent。你在下方填写的内容会追加在它之后，不会替换它，所以不必重复说明运行环境。</p><pre id="pm-base-system-prompt" class="pm-base-prompt-text" tabindex="0"></pre></details><textarea id="pm-global-system-prompt" class="pm-input" rows="5" maxlength="65536" placeholder="在内置环境提示词之后追加你自己的要求，留空表示不追加"></textarea><div class="pm-actions"><button id="pm-save-global-system-prompt" class="pm-primary" type="button">保存全局提示词</button></div>'; switchPanel.appendChild(globalSettings);
    while (interfacePanel.firstChild) switchPanel.appendChild(interfacePanel.firstChild);
    interfacePanel.remove();
  }
  function renameProviderLabels() {
    var agentSelect = $("pm-agent");
    if (agentSelect && agentSelect.parentElement) agentSelect.parentElement.firstChild.nodeValue = "选择 Agent";
    root.querySelectorAll(".pm-help").forEach(function (help) {
      if (help.textContent.indexOf("每个 Agent") >= 0) help.textContent = "供应商只保存接口、密钥、模型和上下文；Agent 本身负责 CLI 和运行方式。";
    });
    var saveButton = $("pm-provider-editor") && $("pm-provider-editor").querySelector("button[type=submit]");
    if (saveButton) saveButton.textContent = "保存并切换供应商";
  }
  function createTerminalPanel() {
    var panel = document.createElement("div"); panel.className = "pm-panel"; panel.dataset.pmPanel = "terminal"; panel.hidden = true;
    panel.innerHTML = '<h3>工作区 Terminal</h3><label>工作区<select id="pm-terminal-workspace" class="pm-select"><option value="">正在读取工作区…</option></select></label><div class="pm-actions"><button id="pm-open-terminal" class="pm-primary" type="button">打开 Terminal</button><button id="pm-terminal-refresh" class="pm-secondary" type="button">刷新</button></div><p id="pm-terminal-status" class="pm-status"></p>';
    var conversations = root.querySelector('[data-pm-panel="conversations"]'); if (conversations) conversations.before(panel); else $("pm-drawer").appendChild(panel);
  }
  function createMcpPanel() {
    var panel = document.createElement("div"); panel.className = "pm-panel"; panel.dataset.pmPanel = "mcp"; panel.hidden = true;
    panel.innerHTML = '<h3>MCP</h3><p id="pm-mcp-service-status" class="pm-status">正在读取 Paseo MCP 状态…</p><label class="pm-toggle"><input id="pm-mcp-inject" type="checkbox"><span>将 Paseo MCP 工具注入 Agent</span></label><p class="pm-help">关闭后 Agent 不会获得 Paseo 的任务、终端和工作区控制工具。更改用于新建或恢复的 Agent 会话。</p><div class="pm-actions"><button id="pm-save-mcp" class="pm-primary" type="button">保存 MCP 配置</button></div>';
    var skills = root.querySelector('[data-pm-panel="skills"]'); if (skills) skills.before(panel); else $("pm-drawer").appendChild(panel);
  }
  function configurePrimaryNavigation() {
    var nav = $("pm-tabs"); nav.replaceChildren();
    PRIMARY_TABS.forEach(function (item) { var button = document.createElement("button"); button.type = "button"; button.dataset.pmTab = item[0]; button.textContent = item[1]; nav.appendChild(button); });
  }
  function enableFloatingControlDrag() {
    var dragTarget = $("pm-floating-toolbar") || root, storageKey = "@paseo:floating-controls";
    var toolbar = dragTarget;
    var idleTimer = null;
    function hideFloatingToolbar() {
      var backdrop = $("pm-backdrop");
      if (dragging || backdrop && backdrop.classList.contains("open")) return;
      toolbar.classList.add("pm-floating-toolbar-hidden");
    }
    function wakeFloatingToolbarLocal() {
      toolbar.classList.remove("pm-floating-toolbar-hidden");
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(function () { hideFloatingToolbar(); }, 6000);
    }
    wakeFloatingToolbar = wakeFloatingToolbarLocal;
    function clampFloatingControls() {
      var left = Math.max(0, Math.min(Math.max(0, window.innerWidth - root.offsetWidth), root.offsetLeft));
      var top = Math.max(0, Math.min(Math.max(0, window.innerHeight - root.offsetHeight), root.offsetTop));
      root.style.left = left + "px"; root.style.top = top + "px"; root.style.right = "auto"; root.style.bottom = "auto";
      localStorage.setItem(storageKey, JSON.stringify({ left: left, top: top }));
    }
    var saved = null; try { saved = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch (_) {}
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) { root.style.left = saved.left + "px"; root.style.top = saved.top + "px"; root.style.right = "auto"; root.style.bottom = "auto"; clampFloatingControls(); }
    window.addEventListener("resize", clampFloatingControls);
    window.addEventListener("orientationchange", function () { window.setTimeout(clampFloatingControls, 0); });
    var dragging = false, start = null, origin = null, pointerId = null, suppressNextClick = false, wasHiddenAtPointerDown = false;
    dragTarget.style.touchAction = "none";
    ["pointerenter", "focusin"].forEach(function (eventName) { dragTarget.addEventListener(eventName, function () { if (!toolbar.classList.contains("pm-floating-toolbar-hidden")) wakeFloatingToolbarLocal(); }, { passive: true }); });
    wakeFloatingToolbarLocal();
    dragTarget.addEventListener("click", function (event) {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    dragTarget.addEventListener("pointerdown", function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      wasHiddenAtPointerDown = toolbar.classList.contains("pm-floating-toolbar-hidden");
      if (!wasHiddenAtPointerDown) wakeFloatingToolbarLocal();
      pointerId = event.pointerId; start = { x: event.clientX, y: event.clientY }; origin = { left: root.offsetLeft, top: root.offsetTop }; dragging = false;
    });
    dragTarget.addEventListener("pointermove", function (event) {
      if (!start || event.pointerId !== pointerId) return;
      var distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (!dragging && distance >= 12) { dragging = true; suppressNextClick = true; root.classList.add("pm-dragging"); dragTarget.setPointerCapture?.(event.pointerId); }
      if (!dragging) return;
      var left = Math.max(0, Math.min(window.innerWidth - root.offsetWidth, origin.left + event.clientX - start.x));
      var top = Math.max(0, Math.min(window.innerHeight - root.offsetHeight, origin.top + event.clientY - start.y));
      root.style.left = left + "px"; root.style.top = top + "px"; root.style.right = "auto"; root.style.bottom = "auto"; event.preventDefault();
    });
    var finish = function (event) { if (event.pointerId !== pointerId) return; if (dragging) { clampFloatingControls(); root.classList.remove("pm-dragging"); suppressNextClick = event.type === "pointerup"; } else if (event.type === "pointercancel") suppressNextClick = false; start = null; origin = null; pointerId = null; dragging = false; if (!wasHiddenAtPointerDown) wakeFloatingToolbarLocal(); wasHiddenAtPointerDown = false; };
    dragTarget.addEventListener("pointerup", finish); dragTarget.addEventListener("pointercancel", finish);
  }
  function build() {
    var style = document.createElement("style"); style.textContent = "#paseo-codex-settings{display:none!important}#paseo-manager{position:fixed;left:12px;bottom:max(14px,env(safe-area-inset-bottom));z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-family:Inter,system-ui,-apple-system,'PingFang SC',sans-serif;color:#f3f5f3}#pm-open{border:1px solid #45534c;border-radius:999px;background:#1d2722;color:#f3f5f3;min-height:44px;padding:0 17px;box-shadow:0 8px 28px #0007;font-weight:700}#pm-backdrop{display:none;position:fixed;inset:0;background:#0009;align-items:flex-end;justify-content:center;padding:0}#pm-backdrop.open{display:flex}#pm-drawer{width:min(720px,100%);max-height:min(92vh,var(--paseo-viewport-height,92dvh));overflow:auto;background:#1e2521;border:1px solid #46534c;border-bottom:0;border-radius:16px 16px 0 0;padding:14px 16px max(18px,env(safe-area-inset-bottom));box-sizing:border-box}#pm-head{display:flex;align-items:center;justify-content:space-between;gap:10px;position:sticky;top:-14px;background:#1e2521;padding:4px 0 12px;z-index:1}#pm-head h2{margin:0;font-size:18px}#pm-close,.pm-icon{border:0;background:transparent;color:#c8d0cb;font-size:22px;padding:7px}#pm-tabs{display:flex;gap:6px;overflow:auto;margin-bottom:14px;position:sticky;top:42px;background:#1e2521;padding:4px 0;z-index:1}#pm-tabs button{flex:0 0 auto;border:1px solid #435048;border-radius:999px;background:#29322e;color:#d5ddd8;padding:8px 12px}#pm-tabs button.active{background:#38a269;color:#08170d;border-color:#38a269;font-weight:700}.pm-panel{display:grid;gap:12px}.pm-panel[hidden]{display:none}.pm-muted,.pm-help{color:#aab5ae;font-size:12px;line-height:18px;margin:0}.pm-status{min-height:20px;color:#aab5ae;font-size:13px}.pm-status[data-kind=success]{color:#68d39a}.pm-status[data-kind=error]{color:#ff938b}.pm-select,.pm-input{width:100%;min-height:43px;border:1px solid #45534c;border-radius:9px;background:#141a17;color:#f3f5f3;padding:0 11px;box-sizing:border-box;font:inherit}.pm-secret{-webkit-text-security:disc}.pm-actions{display:flex;gap:8px;flex-wrap:wrap}.pm-actions button,.pm-secondary,.pm-danger,.pm-primary{min-height:40px;border:1px solid #45534c;border-radius:8px;background:#2a342f;color:#f3f5f3;padding:0 12px}.pm-primary{background:#38a269;color:#08170d;border-color:#38a269;font-weight:700}.pm-danger{color:#ff938b;border-color:#754540;background:transparent}.pm-provider{display:grid;text-align:left;gap:3px;border:1px solid #45534c;border-radius:10px;background:#29322e;color:#f3f5f3;padding:11px}.pm-provider.active{border-color:#54d18f;background:#203d2d}.pm-provider small,.pm-row small{display:block;color:#aab5ae;font-size:11px;line-height:16px}.pm-list{display:grid;gap:8px}.pm-row{display:flex;align-items:center;gap:8px;justify-content:space-between;border:1px solid #3c4841;border-radius:10px;background:#252e29;padding:10px}.pm-row>div{min-width:0;flex:1}.pm-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pm-profiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.pm-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.pm-grid>label{display:grid;gap:5px;font-size:12px;color:#c6d0c9}.pm-chip{border:1px solid #45534c;border-radius:999px;background:#29322e;color:#dce4df;padding:8px 11px}.pm-roots{display:flex;gap:6px;flex-wrap:wrap}.pm-dirpath{font-size:12px;word-break:break-all;color:#aab5ae}.pm-directories{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:7px}.pm-directory{display:flex;align-items:center;gap:7px;border:1px solid #3c4841;border-radius:8px;background:#252e29;color:#f3f5f3;text-align:left;padding:11px;min-height:43px}.pm-directory span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pm-workspace{width:100%;text-align:left}.pm-badge{font-size:11px;color:#68d39a}@media(max-width:520px){#pm-drawer{padding-left:12px;padding-right:12px}.pm-grid{grid-template-columns:1fr}.pm-row{align-items:flex-start;flex-wrap:wrap}.pm-row>button{flex:1}.pm-profiles{grid-template-columns:1fr 1fr}}"; document.head.appendChild(style);
    var mobileOverride = document.createElement("style"); mobileOverride.textContent = "#paseo-manager{left:auto;right:0;top:calc(50% - 23px);bottom:auto;pointer-events:none}#pm-open{pointer-events:auto;min-height:46px;height:46px;padding:0;font-size:15px;opacity:.68}#pm-open:active{opacity:1}html.paseo-keyboard-open #pm-open{display:none}#pm-backdrop{z-index:2147483001}#pm-drawer{max-height:min(88vh,var(--paseo-viewport-height,88dvh));padding-bottom:max(18px,env(safe-area-inset-bottom),var(--paseo-keyboard-inset,0px))}.pm-model-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px}.pm-model-row .pm-secondary{min-height:43px;white-space:nowrap}.pm-toggle{display:flex!important;align-items:center;grid-template-columns:none!important;gap:9px!important;min-height:43px}.pm-toggle input{width:19px;height:19px;accent-color:#38a269;flex:none}.pm-toggle span{line-height:18px}"; document.head.appendChild(mobileOverride);
    var squeezeStyle = document.createElement("style"); squeezeStyle.textContent = "#pm-squeeze{order:-1;pointer-events:auto;min-width:56px;max-width:96px;min-height:32px;height:32px;margin:0 2px;padding:0 6px;border:1px solid #45534c;border-radius:6px;background:#29322e;color:#d5ddd8;font-size:11px;box-shadow:0 6px 18px #0006;opacity:.92;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#pm-squeeze.on{background:#38a269;border-color:#54d18f;color:#08170d;font-weight:700}#pm-squeeze:disabled{opacity:.5}.pm-retry-status{margin:0;padding:8px 9px;border:1px solid #4c5d52;border-radius:7px;background:#101612;color:#cbd5ce;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.pm-retry-status[hidden]{display:none}#pm-custom-cli-form{display:grid;gap:10px}#pm-custom-cli-form>h4{margin:4px 0 0;font-size:14px}#pm-custom-cli-form>label,.pm-advanced-fields>label{display:grid;gap:5px;font-size:12px;color:#c6d0c9}#pm-custom-cli-advanced{border:0;border-top:1px solid #2b3930;padding-top:8px}#pm-custom-cli-advanced>summary{cursor:pointer;color:#aab5ae;font-size:12px;padding:6px 0}#pm-custom-cli-advanced[open]>summary{color:#d5ddd8}.pm-advanced-fields{display:grid;gap:9px;padding-top:8px}#pm-custom-cli-scripts-row[hidden]{display:none!important}#pm-backdrop,#pm-drawer,#pm-backdrop button,#pm-backdrop input,#pm-backdrop textarea,#pm-backdrop select{pointer-events:auto}.pm-global-settings{display:grid;gap:8px;margin-top:8px;padding-top:10px;border-top:1px solid #2b3930}.pm-global-settings textarea{min-height:112px;resize:vertical}.pm-global-settings .pm-status{min-height:0}.pm-base-prompt[hidden]{display:none}.pm-base-prompt>summary{cursor:pointer;color:#aab5ae;font-size:12px;padding:6px 0}.pm-base-prompt[open]>summary{color:#d5ddd8}.pm-base-prompt-text{margin:6px 0 0;padding:9px 10px;max-height:240px;overflow:auto;border:1px solid #2b3930;border-radius:7px;background:#101612;color:#cbd5ce;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}"; document.head.appendChild(squeezeStyle);
    var compactStyle = document.createElement("style"); compactStyle.textContent = "#pm-open{width:26px;min-width:26px;height:46px;min-height:46px;padding:0;border-radius:7px 0 0 7px;font-size:15px;line-height:1;background:#17211c;border-color:#52675a;border-right:0;opacity:.68}#pm-open:hover,#pm-open:focus-visible{opacity:1}#pm-squeeze{margin:0 4px 0 auto;box-shadow:none;border-radius:7px;min-height:32px;height:32px}#pm-backdrop{background:rgba(7,10,8,.72)}#pm-drawer{background:#151b18;border-color:#3a4a40;border-radius:12px 12px 0 0;padding:12px 14px max(16px,env(safe-area-inset-bottom));box-shadow:0 -12px 40px rgba(0,0,0,.35)}#pm-head{top:-12px;background:#151b18;border-bottom:1px solid #2c3931;padding:2px 0 10px}#pm-head h2{font-size:16px;letter-spacing:.01em}#pm-close{order:3}#pm-tabs{top:41px;gap:4px;margin:0 0 12px;padding:4px;background:#101512;border:1px solid #27352d;border-radius:8px}#pm-tabs button{border:0;border-radius:6px;background:transparent;padding:8px 7px;color:#9eaca2;font-size:12px}#pm-tabs button.active{background:#2f9b63;color:#07140b}#pm-status{min-height:18px;padding:0 2px;font-size:12px}.pm-panel{gap:10px}.pm-help{padding:7px 9px;border-left:2px solid #3d9e69;background:#1c2620;border-radius:5px}.pm-actions{gap:6px}.pm-control{display:grid;flex:1 1 140px;gap:5px;min-width:0;color:#aab5ae;font-size:11px}.pm-control .pm-select{min-height:38px}.pm-actions button,.pm-secondary,.pm-danger,.pm-primary{min-height:38px;border-radius:7px;font-size:12px}.pm-provider{min-height:56px;border-radius:8px;background:#1c2620;border-color:#2f4035;padding:9px 10px}.pm-provider.active{background:#203f2c;border-color:#4bc783;box-shadow:inset 3px 0 #4bc783}.pm-provider small,.pm-row small{font-size:10px;color:#8f9f94}.pm-row{border-radius:7px;background:#1a231e;border-color:#2b3930;padding:9px}.pm-row .pm-conversation-status{flex:none;padding:3px 6px;border-radius:5px;background:#25372b;color:#aab5ae;font-size:11px;white-space:nowrap}.pm-row .pm-conversation-status[data-status*=run],.pm-row .pm-conversation-status[data-status*=active],.pm-row .pm-conversation-status[data-status*=work]{color:#77dda1;background:#1e402d}.pm-row .pm-conversation-status[data-status*=complete],.pm-row .pm-conversation-status[data-status*=done],.pm-row .pm-conversation-status[data-status*=success]{color:#77dda1}.pm-row .pm-conversation-status[data-status*=error],.pm-row .pm-conversation-status[data-status*=fail]{color:#ff9c94;background:#452b29}.pm-select,.pm-input{min-height:40px;border-radius:7px;background:#101612;border-color:#34463a;font-size:13px}.pm-grid{gap:8px}.pm-directories{gap:6px}.pm-directory{border-radius:7px;background:#1a231e;border-color:#2b3930;padding:9px}.pm-chip{border-radius:6px;padding:7px 9px;background:#1c2921}.pm-badge{font-size:10px}@media(min-width:700px){#pm-backdrop{align-items:stretch;justify-content:flex-end;padding:0}#pm-drawer{width:430px;height:100%;max-height:none;border-radius:0;border-width:0 0 0 1px;padding-top:16px}#pm-tabs{display:grid;grid-template-columns:repeat(7,1fr)}#pm-head{top:-16px}}@media(max-width:520px){#pm-drawer{max-height:min(84dvh,var(--paseo-viewport-height,84dvh));padding-left:11px;padding-right:11px}.pm-profiles{grid-template-columns:1fr 1fr}.pm-row>button{flex:0 0 auto}}"; document.head.appendChild(compactStyle);
    var terminalStyle = document.createElement("style"); terminalStyle.textContent = "#pm-floating-toolbar{pointer-events:auto;display:flex;align-items:center;gap:2px;padding:2px;border:1px solid #52675a;border-radius:7px 0 0 7px;background:#17211c;box-shadow:0 6px 18px #0006;transform-origin:right center;transition:opacity .2s ease,transform .2s ease}#pm-floating-toolbar.pm-floating-toolbar-hidden{width:36px;height:36px;min-width:36px;min-height:36px;padding:0;box-sizing:border-box;justify-content:center;gap:0;border-radius:50%;opacity:.92;transform:none;pointer-events:auto;overflow:hidden}#pm-floating-toolbar.pm-floating-toolbar-hidden #pm-terminal-shortcut,#pm-floating-toolbar.pm-floating-toolbar-hidden #pm-squeeze{display:none!important;pointer-events:none!important}#pm-floating-toolbar.pm-floating-toolbar-hidden #pm-open{display:block!important;width:36px!important;min-width:36px!important;height:36px!important;min-height:36px!important;padding:0!important;border:0!important;border-radius:50%!important;pointer-events:auto!important;opacity:1!important}#pm-floating-toolbar button{margin:0!important;box-shadow:none!important}#pm-terminal-shortcut{pointer-events:auto;width:32px;min-width:32px;height:32px;min-height:32px;border:0;border-radius:5px;background:transparent;color:#d5ddd8;font:700 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace}#pm-terminal-shortcut:hover,#pm-terminal-shortcut:focus-visible{background:#243129;color:#fff}#pm-floating-toolbar #pm-open{width:32px;min-width:32px;height:32px;min-height:32px;border:0;border-radius:5px}#pm-floating-toolbar #pm-squeeze{height:32px;min-height:32px}.pm-dragging #pm-floating-toolbar{outline:2px solid #54d18f;opacity:.92;transform:none}.pm-dragging #pm-floating-toolbar.pm-floating-toolbar-hidden{width:36px;height:36px;transform:none}html.paseo-keyboard-open #pm-floating-toolbar{display:none}.pm-cli-row{min-height:44px;padding:6px 8px;flex-wrap:nowrap}.pm-cli-row .pm-cli-detail{display:flex;align-items:center;gap:8px;min-width:0}.pm-cli-row .pm-cli-detail strong{flex:0 1 auto}.pm-cli-row .pm-cli-detail small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pm-cli-row>button{flex:0 0 auto;min-height:32px!important;height:32px;padding:0 9px}@media(min-width:700px){#pm-tabs{grid-template-columns:repeat(6,1fr)}}@media(max-width:520px){.pm-cli-row{align-items:center!important;flex-wrap:nowrap!important}.pm-cli-row .pm-cli-detail{display:block}.pm-cli-row .pm-cli-detail small{display:block}}"; document.head.appendChild(terminalStyle);
    var supplierStyle = document.createElement("style"); supplierStyle.textContent = "#pm-status:empty,#pm-provider-status:empty{display:none}.pm-agent-switcher{display:flex;gap:7px;overflow-x:auto;padding:2px 1px 5px;scrollbar-width:thin}.pm-agent-option{flex:0 0 auto;min-height:42px;border:1px solid #34463a;border-radius:8px;background:#101612;color:#aebbb2;padding:0 15px;font:600 13px/1 inherit;cursor:pointer}.pm-agent-option.active{background:#2f9b63;border-color:#54d18f;color:#07140b}.pm-agent-option:disabled{opacity:.5}.pm-supplier-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:3px}.pm-supplier-head h3{margin:0;font-size:15px}.pm-supplier-head small{display:block;margin-top:3px;color:#8f9f94;font-size:11px}.pm-supplier-tools{display:flex;align-items:center;gap:6px}.pm-icon-action{min-height:34px;border:1px solid #34463a;border-radius:7px;background:#1a231e;color:#cbd5ce;padding:0 10px;font-size:12px}.pm-icon-action:disabled{opacity:.45}.pm-add-action{width:38px;height:38px;min-width:38px;border:0;border-radius:8px;font:400 27px/1 Arial,sans-serif}.pm-add-action:active{transform:scale(.96)}.pm-supplier-list{display:grid;gap:8px}.pm-supplier-row{display:grid;grid-template-columns:36px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:70px;border:1px solid #2b3930;border-radius:8px;background:#1a231e;color:#f3f5f3;padding:10px;cursor:pointer;outline:none}.pm-supplier-row:hover,.pm-supplier-row:focus-visible{border-color:#4baf78;background:#1e2d23}.pm-supplier-row.active{border-color:#54d18f;background:#203f2c;box-shadow:inset 3px 0 #54d18f}.pm-supplier-mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid #44604d;border-radius:8px;background:#25372b;color:#9de0b7;font-weight:700}.pm-supplier-main{min-width:0}.pm-supplier-main strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.pm-supplier-main small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8f9f94;font-size:10px;line-height:16px}.pm-supplier-state{color:#77dda1;font-size:11px;white-space:nowrap}.pm-editor-head{display:flex;align-items:center;gap:8px;border-bottom:1px solid #2b3930;padding-bottom:8px}.pm-editor-head h3{margin:0;font-size:15px}.pm-editor-head .pm-icon-action{margin-right:auto}@media(max-width:520px){.pm-agent-option{padding:0 12px}.pm-supplier-row{grid-template-columns:32px minmax(0,1fr) auto;gap:8px;min-height:64px}.pm-supplier-mark{width:30px;height:30px}.pm-supplier-state{font-size:10px}}"; document.head.appendChild(supplierStyle);
    var editorModeStyle = document.createElement("style"); editorModeStyle.textContent = '[data-pm-panel="agent"].pm-editing>h3,[data-pm-panel="agent"].pm-editing>#pm-agent-switcher,[data-pm-panel="agent"].pm-editing>.pm-help,[data-pm-panel="agent"].pm-editing>#pm-supplier-panel{display:none}'; document.head.appendChild(editorModeStyle);
    // Design tokens. The seven layers above were each added for one feature and each
    // restyled what the previous one had already styled, so a single element could end up
    // with radii of 16/12/10/9/8/7/6/5px, three different "card" greys, two different
    // greens for the same "active" state, and an orange add button in an otherwise green
    // palette (white on #f28a25 is 2.49:1, under the 4.5:1 AA floor). That drift is what
    // reads as unfinished. This layer adds no element and invents no selector: it maps the
    // surviving values onto one scale and fixes contrast, focus rings, and tap targets.
    var tokenStyle = document.createElement("style");
    tokenStyle.textContent = ":root{" +
      // Surfaces, recessed to raised. --pm-s1 is the drawer, and the sticky #pm-head and
      // the >=700px side panel must stay on it or a seam shows through while scrolling.
      "--pm-s0:#0f1411;--pm-s1:#151b18;--pm-s2:#1a211d;--pm-s3:#202a24;--pm-s4:#26312a;" +
      "--pm-line:#2a352e;--pm-line-strong:#3a4a40;" +
      // Text: 15.6:1, 8.1:1 and 6.5:1 on --pm-s1, so all three clear AA for body copy.
      "--pm-text:#eef2ef;--pm-dim:#a7b3ab;--pm-faint:#93a099;" +
      "--pm-accent:#35a76c;--pm-accent-hi:#5fd898;--pm-accent-soft:#17301f;--pm-accent-ink:#04140a;" +
      "--pm-ok:#6fd79c;--pm-danger:#ff9a92;--pm-danger-soft:#2c1a19;--pm-danger-line:#6d4340;" +
      // One radius scale. Container > card > control, each step visually distinct.
      "--pm-r-xs:6px;--pm-r-sm:8px;--pm-r-md:10px;--pm-r-lg:14px;--pm-r-pill:999px;" +
      "--pm-gap:10px;--pm-gap-sm:7px;--pm-pad:12px;" +
      // 40px keeps controls comfortably tappable; the compact layer had drifted to 32-38px.
      "--pm-tap:40px;--pm-tap-sm:36px;" +
      "--pm-shadow:0 -14px 44px rgba(0,0,0,.42);--pm-shadow-pop:0 6px 20px rgba(0,0,0,.38);" +
      "--pm-ring:0 0 0 2px var(--pm-accent-hi);--pm-ease:.16s ease" +
      "}" +
      // Shell.
      "#paseo-manager{color:var(--pm-text)}" +
      "#pm-backdrop{background:rgba(6,10,8,.68);backdrop-filter:blur(2px)}" +
      "#pm-drawer{background:var(--pm-s1);border-color:var(--pm-line-strong);border-radius:var(--pm-r-lg) var(--pm-r-lg) 0 0;box-shadow:var(--pm-shadow)}" +
      // #pm-head sticks at top:-12px and #pm-tabs at top:41px, which leaves a 1px band
      // between them where the scrolling list shows through as a twitching hairline
      // (elementFromPoint lands on .pm-supplier-row there). The shadow paints 2px of
      // drawer colour under the header to cover it, without shifting any layout.
      "#pm-head{background:var(--pm-s1);border-bottom:1px solid var(--pm-line);box-shadow:0 2px 0 var(--pm-s1)}" +
      "#pm-head h2{font-size:17px;font-weight:650;letter-spacing:.01em;color:var(--pm-text)}" +
      "#pm-close,.pm-icon{color:var(--pm-dim);border-radius:var(--pm-r-sm)}" +
      "#pm-close:hover,.pm-icon:hover{color:var(--pm-text);background:var(--pm-s3)}" +
      // Tab strip: a recessed trough with pill tabs, so the active tab reads as selected
      // rather than as a stray coloured block.
      "#pm-tabs{background:var(--pm-s0);border:1px solid var(--pm-line);border-radius:var(--pm-r-md);padding:4px;gap:3px}" +
      "#pm-tabs button{border-radius:var(--pm-r-xs);color:var(--pm-dim);font-size:12px;font-weight:550;transition:background var(--pm-ease),color var(--pm-ease)}" +
      "#pm-tabs button:hover{background:var(--pm-s3);color:var(--pm-text)}" +
      "#pm-tabs button.active{background:var(--pm-accent);border-color:var(--pm-accent);color:var(--pm-accent-ink);font-weight:700}" +
      // Type and helper text.
      "#pm-status{color:var(--pm-dim)}" +
      ".pm-status[data-kind=success]{color:var(--pm-ok)}" +
      ".pm-status[data-kind=error]{color:var(--pm-danger)}" +
      ".pm-muted,.pm-help{color:var(--pm-dim)}" +
      ".pm-help{border-left:2px solid var(--pm-accent);background:var(--pm-accent-soft);border-radius:0 var(--pm-r-xs) var(--pm-r-xs) 0;padding:8px 10px}" +
      ".pm-panel>h3,.pm-supplier-head h3,.pm-editor-head h3,#pm-custom-cli-form>h4{color:var(--pm-text);font-weight:600}" +
      // 10px small print was the least legible thing in the UI; 11px costs no layout.
      ".pm-provider small,.pm-row small,.pm-supplier-head small,.pm-supplier-main small{color:var(--pm-faint);font-size:11px;line-height:16px}" +
      ".pm-dirpath{color:var(--pm-faint)}" +
      ".pm-badge{color:var(--pm-ok);font-size:11px}" +
      ".pm-grid>label,#pm-custom-cli-form>label,.pm-advanced-fields>label,.pm-control{color:var(--pm-dim)}" +
      // Inputs.
      ".pm-select,.pm-input{min-height:var(--pm-tap);border-radius:var(--pm-r-sm);background:var(--pm-s0);border-color:var(--pm-line-strong);color:var(--pm-text);font-size:13px;transition:border-color var(--pm-ease),box-shadow var(--pm-ease)}" +
      ".pm-select:hover,.pm-input:hover{border-color:var(--pm-accent)}" +
      ".pm-input::placeholder{color:var(--pm-faint)}" +
      ".pm-control .pm-select{min-height:var(--pm-tap-sm)}" +
      // Buttons. One radius, one height, and a real hover state on the neutral variant.
      ".pm-actions button,.pm-secondary,.pm-danger,.pm-primary{min-height:var(--pm-tap);border-radius:var(--pm-r-sm);border-color:var(--pm-line-strong);background:var(--pm-s3);color:var(--pm-text);font-size:13px;font-weight:550;transition:background var(--pm-ease),border-color var(--pm-ease),opacity var(--pm-ease)}" +
      ".pm-actions button:hover,.pm-secondary:hover{background:var(--pm-s4);border-color:var(--pm-accent)}" +
      // `.pm-actions button` is (0,1,1) and `.pm-primary` is (0,1,0), so since the first
      // stylesheet every primary button in the console has silently lost to the neutral
      // rule and rendered grey -- the confirm action looked identical to cancel in all
      // seven panels. The compound selector outranks it; verified in the browser.
      ".pm-primary,.pm-actions button.pm-primary{background:var(--pm-accent);border-color:var(--pm-accent);color:var(--pm-accent-ink);font-weight:700}" +
      ".pm-primary:hover,.pm-actions button.pm-primary:hover{background:var(--pm-accent-hi);border-color:var(--pm-accent-hi)}" +
      ".pm-danger,.pm-actions button.pm-danger{color:var(--pm-danger);border-color:var(--pm-danger-line);background:transparent}" +
      ".pm-danger:hover,.pm-actions button.pm-danger:hover{background:var(--pm-danger-soft);border-color:var(--pm-danger)}" +
      ".pm-actions button:disabled,.pm-secondary:disabled,.pm-danger:disabled,.pm-primary:disabled{opacity:.45}" +
      ".pm-icon-action{min-height:var(--pm-tap-sm);border-radius:var(--pm-r-sm);border-color:var(--pm-line-strong);background:var(--pm-s3);color:var(--pm-dim)}" +
      ".pm-icon-action:hover{background:var(--pm-s4);color:var(--pm-text)}" +
      // The orange add button was the one AA failure and the only non-green accent in the
      // whole console. Same shape, palette accent, dark ink: 6.2:1.
      ".pm-add-action{border-radius:var(--pm-r-sm);background:var(--pm-accent);color:var(--pm-accent-ink);box-shadow:var(--pm-shadow-pop);font:400 26px/1 system-ui,Arial,sans-serif}" +
      ".pm-add-action:hover{background:var(--pm-accent-hi)}" +
      ".pm-chip{border-radius:var(--pm-r-pill);background:var(--pm-s3);border-color:var(--pm-line-strong);color:var(--pm-text)}" +
      ".pm-chip:hover{background:var(--pm-s4);border-color:var(--pm-accent)}" +
      // Cards. Rows, providers, suppliers and directories were four surfaces and four radii
      // for what is visually one component; they become one card with one selected state.
      ".pm-row,.pm-directory,.pm-provider,.pm-supplier-row{border-radius:var(--pm-r-md);background:var(--pm-s2);border-color:var(--pm-line);color:var(--pm-text);transition:background var(--pm-ease),border-color var(--pm-ease)}" +
      ".pm-row:hover,.pm-directory:hover,.pm-provider:hover,.pm-supplier-row:hover{background:var(--pm-s3);border-color:var(--pm-line-strong)}" +
      // Selected state: accent border plus an inset accent bar, applied identically to
      // every card kind. Previously .pm-provider.active and .pm-supplier-row.active used
      // two different greens with two different bar widths.
      ".pm-provider.active,.pm-supplier-row.active{background:var(--pm-accent-soft);border-color:var(--pm-accent);box-shadow:inset 3px 0 var(--pm-accent-hi)}" +
      ".pm-supplier-mark{border-radius:var(--pm-r-sm);border-color:var(--pm-accent);background:var(--pm-accent-soft);color:var(--pm-accent-hi)}" +
      ".pm-supplier-state{color:var(--pm-ok)}" +
      ".pm-supplier-row.active .pm-supplier-mark{background:var(--pm-accent);color:var(--pm-accent-ink);border-color:var(--pm-accent)}" +
      ".pm-agent-option{border-radius:var(--pm-r-pill);background:var(--pm-s2);border-color:var(--pm-line-strong);color:var(--pm-dim);min-height:var(--pm-tap);transition:background var(--pm-ease),color var(--pm-ease),border-color var(--pm-ease)}" +
      ".pm-agent-option:hover{background:var(--pm-s3);color:var(--pm-text)}" +
      ".pm-agent-option.active{background:var(--pm-accent);border-color:var(--pm-accent);color:var(--pm-accent-ink)}" +
      ".pm-row .pm-conversation-status{border-radius:var(--pm-r-xs);background:var(--pm-s4);color:var(--pm-dim)}" +
      ".pm-row .pm-conversation-status[data-status*=run],.pm-row .pm-conversation-status[data-status*=active],.pm-row .pm-conversation-status[data-status*=work]{background:var(--pm-accent-soft);color:var(--pm-accent-hi)}" +
      ".pm-row .pm-conversation-status[data-status*=complete],.pm-row .pm-conversation-status[data-status*=done],.pm-row .pm-conversation-status[data-status*=success]{color:var(--pm-ok)}" +
      ".pm-row .pm-conversation-status[data-status*=error],.pm-row .pm-conversation-status[data-status*=fail]{background:var(--pm-danger-soft);color:var(--pm-danger)}" +
      // Monospace blocks.
      ".pm-retry-status,.pm-base-prompt-text{border-radius:var(--pm-r-sm);border-color:var(--pm-line);background:var(--pm-s0);color:var(--pm-dim)}" +
      "#pm-custom-cli-advanced,.pm-editor-head{border-color:var(--pm-line)}" +
      "#pm-custom-cli-advanced>summary,.pm-base-prompt>summary{color:var(--pm-dim);border-radius:var(--pm-r-xs)}" +
      "#pm-custom-cli-advanced[open]>summary,.pm-base-prompt[open]>summary{color:var(--pm-text)}" +
      ".pm-global-settings{border-top-color:var(--pm-line)}" +
      // Focus. .pm-supplier-row shipped `outline:none` with only a border-colour change to
      // replace it, and most buttons had no focus style at all, so keyboard users on the
      // drawer had nothing to follow. One ring for everything focusable.
      "#pm-drawer :focus-visible,#pm-floating-toolbar :focus-visible{outline:2px solid var(--pm-accent-hi);outline-offset:2px}" +
      ".pm-supplier-row:focus-visible{outline:2px solid var(--pm-accent-hi);outline-offset:-2px;border-color:var(--pm-accent)}" +
      // Fields take the ring as an inset glow rather than an outline, so it hugs the
      // rounded border. Needs the #pm-drawer prefix to outrank the generic rule above,
      // otherwise the field draws an outline and a glow at once.
      "#pm-drawer .pm-select:focus-visible,#pm-drawer .pm-input:focus-visible{outline:none;border-color:var(--pm-accent-hi);box-shadow:var(--pm-ring)}" +
      // Tap targets the compact layer had shrunk below comfortable touch size. The dense
      // CLI row's !important is matched deliberately; 36px still fits its 44px row.
      ".pm-cli-row>button{min-height:var(--pm-tap-sm)!important;height:var(--pm-tap-sm)}" +
      // The floating toolbar stays deliberately small: it sits over the terminal, and
      // enlarging it would cover content. Only its palette is normalised.
      "#pm-floating-toolbar{border-color:var(--pm-line-strong);background:var(--pm-s2);border-radius:var(--pm-r-sm) 0 0 var(--pm-r-sm);box-shadow:var(--pm-shadow-pop)}" +
      "#pm-open{border-color:var(--pm-line-strong);background:var(--pm-s2);color:var(--pm-text)}" +
      // Two-ID selector, to match the earlier layer that gives this button 5px while its
      // neighbours get 6px -- adjacent buttons with different corners look accidental.
      "#pm-floating-toolbar #pm-open{border-radius:var(--pm-r-xs)}" +
      "#pm-terminal-shortcut{color:var(--pm-dim);border-radius:var(--pm-r-xs)}" +
      "#pm-terminal-shortcut:hover,#pm-terminal-shortcut:focus-visible{background:var(--pm-s4);color:var(--pm-text)}" +
      "#pm-squeeze{border-radius:var(--pm-r-xs);border-color:var(--pm-line-strong);background:var(--pm-s3);color:var(--pm-dim)}" +
      "#pm-squeeze.on{background:var(--pm-accent);border-color:var(--pm-accent);color:var(--pm-accent-ink)}" +
      ".pm-dragging #pm-floating-toolbar{outline-color:var(--pm-accent-hi)}" +
      ".pm-toggle input{accent-color:var(--pm-accent)}" +
      // Scrollbars, so the drawer and the prompt block do not show a default light bar.
      "#pm-drawer,.pm-base-prompt-text,.pm-retry-status,.pm-agent-switcher{scrollbar-width:thin;scrollbar-color:var(--pm-line-strong) transparent}" +
      "#pm-drawer::-webkit-scrollbar,.pm-base-prompt-text::-webkit-scrollbar,.pm-agent-switcher::-webkit-scrollbar{width:8px;height:8px}" +
      "#pm-drawer::-webkit-scrollbar-thumb,.pm-base-prompt-text::-webkit-scrollbar-thumb,.pm-agent-switcher::-webkit-scrollbar-thumb{background:var(--pm-line-strong);border-radius:var(--pm-r-pill)}" +
      "#pm-drawer::-webkit-scrollbar-track,.pm-base-prompt-text::-webkit-scrollbar-track,.pm-agent-switcher::-webkit-scrollbar-track{background:transparent}" +
      // The wide layout docks the drawer to the right edge, so it needs a side border and
      // a matching shadow direction rather than the bottom-sheet's upward one.
      // The wide layout docks the drawer to the right edge, so it needs a side border and
      // a shadow cast leftwards rather than the bottom-sheet's upward one. The tab strip
      // was `repeat(6,1fr)` against seven PRIMARY_TABS entries, which wrapped 插件 onto a
      // row of its own; an even flex row fits any tab count on one line instead.
      "@media(min-width:700px){#pm-drawer{border-radius:0;border-color:var(--pm-line-strong);box-shadow:-14px 0 44px rgba(0,0,0,.42)}" +
      "#pm-tabs{display:flex}#pm-tabs button{flex:1 1 0;min-width:0;padding:8px 4px}}" +
      "@media(prefers-reduced-motion:reduce){#paseo-manager *,#pm-backdrop *{transition:none!important}}";
    document.head.appendChild(tokenStyle);
    var legacySettings = document.getElementById("paseo-codex-settings"); if (legacySettings) legacySettings.remove();
    root = document.createElement("div"); root.id = "paseo-manager"; root.innerHTML = '<button id="pm-open" type="button" title="Paseo 控制台" aria-label="Paseo 控制台">☰</button><div id="pm-backdrop"><section id="pm-drawer" role="dialog" aria-modal="true"><header id="pm-head"><h2>Paseo 控制台</h2><button id="pm-close" type="button">×</button></header><nav id="pm-tabs">' + [["switch","切换"],["interfaces","接口"],["cli","CLI"],["conversations","对话"],["workspace","工作区"],["skills","Skills"],["plugins","插件"]].map(function (item) { return '<button type="button" data-pm-tab="' + item[0] + '">' + item[1] + '</button>'; }).join("") + '</nav><p id="pm-status" class="pm-status" role="status"></p>' +
      '<div class="pm-panel" data-pm-panel="switch"><h3>Agent</h3><div id="pm-agent-switcher" class="pm-agent-switcher" role="group" aria-label="切换 Agent"></div><label hidden>选择 Agent<select id="pm-agent" class="pm-select"></select></label><button id="pm-save-agent" type="button" hidden>保存</button></div>' +
      '<div class="pm-panel" data-pm-panel="interfaces" hidden><p class="pm-help">供应商只保存接口、密钥、模型和上下文；Agent 本身负责 CLI 和运行方式。</p><p id="pm-provider-status" class="pm-status"></p><form id="pm-provider-editor" hidden><header class="pm-editor-head"><button id="pm-cancel-provider-editor" class="pm-icon-action" type="button">返回</button><h3>供应商设置</h3></header><input id="pm-supplier-id" type="hidden"><label>供应商名称<input id="pm-supplier-name" class="pm-input" required placeholder="例如 Anthropic 原生、OpenRouter"></label><label>接口协议<select id="pm-provider-api-protocol" class="pm-select"><option value="native">原生接口</option><option value="openai-compatible">OpenAI 兼容接口</option></select></label><p id="pm-provider-protocol-help" class="pm-help" hidden></p><label>接口地址<input id="pm-provider-base-url" class="pm-input" inputmode="url" placeholder="例如 https://api.anthropic.com"></label><label>当前模型<div class="pm-model-row"><input id="pm-provider-model" class="pm-input" placeholder="先获取模型，再从下拉框选择"><button id="pm-provider-fetch-models" class="pm-secondary" type="button">获取模型</button></div></label><label>获取到的全部模型<select id="pm-provider-fetched-models" class="pm-select" disabled><option value="">先获取模型</option></select></label><label>上下文长度（tokens）<input id="pm-provider-context-window" class="pm-input" type="number" min="1024" max="4000000" step="1" placeholder="留空使用模型默认"></label><label>API Key<input id="pm-provider-api-key" class="pm-input pm-secret" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="留空保留已保存密钥"></label><details id="pm-provider-advanced"><summary>高级设置</summary><div class="pm-advanced-fields"><label>可选择的自定义模型<textarea id="pm-provider-models" class="pm-input" rows="3" placeholder="通常不需要手填；获取模型后直接选择"></textarea></label><label class="pm-toggle"><input id="pm-provider-clear-api-key" type="checkbox"><span>清除这个供应商的 API Key</span></label><label>启动命令 JSON<input id="pm-provider-command" class="pm-input" inputmode="text" placeholder="留空使用已安装 CLI 的默认命令"></label><label class="pm-toggle"><input id="pm-provider-clear-env" type="checkbox"><span>清除自定义环境变量</span></label><label>环境变量 JSON<textarea id="pm-provider-env" class="pm-input" rows="3" placeholder="留空保留已保存环境变量"></textarea></label></div></details><div class="pm-actions"><button class="pm-primary" type="submit">保存并切换</button><button id="pm-provider-refresh" class="pm-secondary" type="button">刷新状态</button><button id="pm-delete-supplier" class="pm-danger" type="button">删除供应商</button></div></form><div id="pm-codex-advanced-api" hidden><div id="pm-profiles" class="pm-profiles" hidden></div><button id="pm-new-profile" type="button" hidden>新增</button><button id="pm-edit-profile" type="button" hidden>编辑</button><form id="pm-editor" hidden><header class="pm-editor-head"><button id="pm-cancel-editor" class="pm-icon-action" type="button">返回</button><h3>Codex 供应商设置</h3></header><div class="pm-grid"><label>名称<input id="pm-name" class="pm-input" required></label><label>Base URL<input id="pm-url" class="pm-input" required inputmode="url"></label><label>当前模型<div class="pm-model-row"><input id="pm-model" class="pm-input" placeholder="可手动输入自定义模型"><button id="pm-fetch-models" class="pm-secondary" type="button">获取模型</button></div></label><label>获取到的全部模型<select id="pm-fetched-models" class="pm-select" disabled><option value="">先获取模型</option></select></label><label>上下文长度（tokens）<input id="pm-context-window" class="pm-input" type="number" min="1024" max="4000000" step="1" placeholder="留空使用模型默认"></label><label>思考强度<select id="pm-effort" class="pm-select"><option>minimal</option><option>low</option><option selected>medium</option><option>high</option><option>xhigh</option><option>max</option></select></label><label>权限<select id="pm-permission" class="pm-select"><option value="readonly">只读</option><option value="workspace" selected>工作区</option><option value="autonomous">自动执行</option><option value="full">完全访问</option></select></label><label>协议<select id="pm-wire" class="pm-select"><option value="responses">Responses</option><option value="chat">Chat Completions</option></select></label><label class="pm-toggle"><input id="pm-busy-retry" type="checkbox"><span>挤入模式（繁忙时自动重试）</span></label><label>最多尝试<select id="pm-busy-attempts" class="pm-select"><option value="3">3 次</option><option value="6" selected>6 次</option><option value="10">10 次</option><option value="20">20 次</option></select></label></div><pre id="pm-retry-status" class="pm-retry-status" hidden></pre><label>API Key<input id="pm-key" class="pm-input pm-secret" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="留空保留已保存密钥"></label><div class="pm-actions"><button class="pm-primary" type="submit">保存并切换</button><button id="pm-sync-cli" class="pm-secondary" type="button">同步到 CLI</button><button id="pm-delete-profile" class="pm-danger" type="button">删除供应商</button></div></form></div></div>' +
      '<div class="pm-panel" data-pm-panel="cli" hidden><h3 title="Paseo CLI 预配置版安装完成会自动注册对应 Agent；已有完整安装会直接复用">Agent CLI</h3><div id="pm-cli-list" class="pm-list"><p class="pm-muted">正在检查 CLI…</p></div><details id="pm-cli-custom-panel"><summary>添加其他 CLI</summary><div id="pm-cli-custom-slot"></div></details></div>' +
      '<div class="pm-panel" data-pm-panel="conversations" hidden><div class="pm-actions"><button id="pm-import-all" class="pm-primary" type="button">一键导入全部</button><button id="pm-refresh-conv" class="pm-secondary" type="button">刷新状态</button></div><p class="pm-help">导入会读取各 Agent 的历史会话；“刷新状态”只重载界面，不会停止后台 Agent 或独立 CLI。</p><h3>可导入对话</h3><div id="pm-importable" class="pm-list"><p class="pm-muted">正在扫描…</p></div><h3>已导入对话</h3><div id="pm-conversations" class="pm-list"></div></div>' +
      '<div class="pm-panel" data-pm-panel="workspace" hidden><div id="pm-roots" class="pm-roots"></div><div class="pm-actions"><button id="pm-dir-up" class="pm-secondary" type="button">上一级</button><button id="pm-use-dir" class="pm-primary" type="button">在此目录创建工作区</button></div><div id="pm-dir-path" class="pm-dirpath"></div><div id="pm-directories" class="pm-directories"></div><h3>已有工作区</h3><div id="pm-workspaces" class="pm-list"></div></div>' +
      '<div class="pm-panel" data-pm-panel="skills" hidden><p class="pm-help">按官方 SKILL.md 目录管理。系统内置只读；启用/停用会在之后的 Codex 扫描中生效。</p><div id="pm-skill-controls" class="pm-actions"></div><div class="pm-actions"><input id="pm-skill-path" class="pm-input" placeholder="Skill 文件夹路径"><button id="pm-skill-browse" class="pm-secondary" type="button">浏览</button><button id="pm-skill-import" class="pm-primary" type="button">导入</button></div><div id="pm-skills" class="pm-list"></div></div>' +
      '<div class="pm-panel" data-pm-panel="plugins" hidden><p class="pm-help">插件按 .codex-plugin/plugin.json 管理，并同步个人 marketplace；删除会移入 Paseo 回收站。</p><div class="pm-actions"><input id="pm-plugin-path" class="pm-input" placeholder="插件文件夹路径"><button id="pm-plugin-browse" class="pm-secondary" type="button">浏览</button><button id="pm-plugin-import" class="pm-primary" type="button">导入</button></div><div id="pm-plugins" class="pm-list"></div></div></section></div>';
    document.body.appendChild(root);
    var portButton = document.createElement("button"); portButton.id = "pm-change-port"; portButton.className = "pm-icon-action"; portButton.type = "button"; portButton.title = "更改 Paseo 端口"; portButton.setAttribute("aria-label", "更改 Paseo 端口"); portButton.textContent = "端口"; $("pm-head").insertBefore(portButton, $("pm-close"));
    installPiThinkingField();
    installBusyRetryDelayField();
    mergeAgentPanels();
    renameProviderLabels();
    createTerminalPanel();
    createMcpPanel();
    configurePrimaryNavigation();
     var customCliForm = document.createElement("form");
     customCliForm.id = "pm-custom-cli-form";
     customCliForm.innerHTML = [
        '<h4>添加其他 CLI</h4>',
        '<p class="pm-help">这里用于添加未列在 Paseo 预配置版中的 CLI。OpenCode、Pi、Claude 等内置项请直接在上方安装。</p>',
       '<label>CLI ID<input id="pm-custom-cli-id" class="pm-input" required placeholder="例如 my-agent"></label>',
       '<label>显示名称<input id="pm-custom-cli-label" class="pm-input" required placeholder="例如 我的 Agent"></label>',
       '<label>适配器<select id="pm-custom-cli-adapter" class="pm-select"><option value="acp">通用 ACP</option><option value="opencode">OpenCode</option><option value="pi">Pi</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="copilot">Copilot</option><option value="omp">OMP</option></select></label>',
       '<label>启动参数 JSON<input id="pm-custom-cli-args" class="pm-input" placeholder="不需要参数可留空，例如 [\"acp\"]"></label>',
       '<label>安装来源<select id="pm-custom-cli-source-type" class="pm-select"><option value="npm">npm 包</option><option value="url">URL 下载</option><option value="path">App 运行时内文件</option></select></label>',
       '<label><span id="pm-custom-cli-source-label">npm 包</span><input id="pm-custom-cli-source" class="pm-input" required placeholder="例如 opencode-ai@latest"></label>',
       '<details id="pm-custom-cli-advanced"><summary>高级设置</summary><div class="pm-advanced-fields">',
       '<label id="pm-custom-cli-update-source-row"><span id="pm-custom-cli-update-source-label">更新 npm 包（可选）</span><input id="pm-custom-cli-update-source" class="pm-input" placeholder="例如 opencode-ai@latest"></label>',
       '<label id="pm-custom-cli-bin-row">npm 包内命令名<input id="pm-custom-cli-bin" class="pm-input" placeholder="留空使用 package.json 的第一个 bin"></label>',
       '<label id="pm-custom-cli-registry-row">npm Registry（可选）<input id="pm-custom-cli-registry" class="pm-input" inputmode="url" placeholder="必须使用 https://"></label>',
       '<label id="pm-custom-cli-scripts-row" class="pm-toggle"><input id="pm-custom-cli-allow-scripts" type="checkbox"><span>允许 npm 安装脚本（仅对可信包开启）</span></label>',
       '<label>当前版本（可选）<input id="pm-custom-cli-version" class="pm-input" placeholder="npm 包会自动读取版本"></label>',
       '<label>更新版本（可选）<input id="pm-custom-cli-update-version" class="pm-input" placeholder="更新后版本，可留空"></label>',
       '<label id="pm-custom-cli-sha256-row" hidden>安装 SHA-256（URL 可选）<input id="pm-custom-cli-sha256" class="pm-input" inputmode="text" placeholder="64 位十六进制校验值"></label>',
       '<label id="pm-custom-cli-update-sha256-row" hidden>更新 SHA-256（URL 可选）<input id="pm-custom-cli-update-sha256" class="pm-input" inputmode="text" placeholder="64 位十六进制校验值"></label>',
       '</div></details>',
       '<div class="pm-actions"><button class="pm-primary" type="submit">安装并启用</button></div>',
     ].join("");
      var customSlot = $("pm-cli-custom-slot");
      if (customSlot) customSlot.appendChild(customCliForm);
    var skillControls = $("pm-skill-controls");
    function addSkillSelect(labelText, id, options, value, onChange) {
      var label = document.createElement("label"); label.className = "pm-control"; label.textContent = labelText;
      var select = document.createElement("select"); select.id = id; select.className = "pm-select";
      options.forEach(function (optionData) { var option = document.createElement("option"); option.value = optionData[0]; option.textContent = optionData[1]; select.appendChild(option); });
      select.value = value; select.addEventListener("change", onChange); label.appendChild(select); skillControls.appendChild(label); return select;
    }
    addSkillSelect("显示来源", "pm-skill-filter", [["all", "全部"], ["agents", "通用"], ["codex", "Codex"], ["claude", "Claude"], ["system", "系统内置"]], state.skillFilter, function () { state.skillFilter = this.value; renderSkills(); });
    addSkillSelect("导入到", "pm-skill-target", [["agents", "通用目录"], ["codex", "Codex 目录"], ["claude", "Claude 目录"]], state.skillTarget, function () { state.skillTarget = this.value; });
    var openButton = $("pm-open");
    var toolbar = document.createElement("div"); toolbar.id = "pm-floating-toolbar"; toolbar.title = "按住拖动工具条"; root.insertBefore(toolbar, openButton);
    var terminalShortcut = document.createElement("button"); terminalShortcut.id = "pm-terminal-shortcut"; terminalShortcut.type = "button"; terminalShortcut.title = "打开 Termux"; terminalShortcut.setAttribute("aria-label", "打开 Termux"); terminalShortcut.textContent = ">_"; toolbar.appendChild(terminalShortcut);
    var squeezeButton = document.createElement("button"); squeezeButton.id = "pm-squeeze"; squeezeButton.type = "button"; squeezeButton.setAttribute("aria-label", "切换挤入模式"); squeezeButton.textContent = "挤入 关"; toolbar.appendChild(squeezeButton);
    toolbar.appendChild(openButton);
    enableFloatingControlDrag();
    var busyLabel = $("pm-busy-retry"); if (busyLabel && busyLabel.parentElement) { var busyText = busyLabel.parentElement.querySelector("span"); if (busyText) busyText.textContent = "挤入模式（持续请求直到连上或关闭）"; }
    terminalShortcut.onclick = function (event) { event.preventDefault(); event.stopPropagation(); openNativeTerminal(); };
    squeezeButton.onclick = toggleSqueeze;
    openButton.onclick = openFloatingControl;
    $("pm-close").onclick = function () { $("pm-backdrop").classList.remove("open"); wakeFloatingToolbar(); };
    root.querySelectorAll("[data-pm-tab]").forEach(function (button) { button.onclick = function () { setTab(button.dataset.pmTab); }; });
    $("pm-save-agent").onclick = saveAgentPreference; $("pm-agent").addEventListener("change", function () { selectManagedProvider(this.value); }); $("pm-supplier").addEventListener("change", function () { selectManagedSupplier(this.value); }); $("pm-add-supplier").onclick = newManagedSupplier; $("pm-edit-supplier").onclick = editManagedSupplier; $("pm-delete-supplier").onclick = deleteManagedSupplier; $("pm-cancel-provider-editor").onclick = closeManagedSupplierEditor; $("pm-new-profile").onclick = function () { newManagedSupplier(); }; $("pm-edit-profile").onclick = function () { editManagedSupplier(); }; $("pm-editor").onsubmit = saveProfile; $("pm-cancel-editor").onclick = closeManagedSupplierEditor; $("pm-delete-profile").onclick = deleteProfile; $("pm-sync-cli").onclick = syncProfileToCli; $("pm-fetch-models").onclick = fetchModels; $("pm-fetched-models").addEventListener("change", selectFetchedModel); $("pm-provider-fetch-models").onclick = fetchManagedProviderModels; $("pm-provider-fetched-models").addEventListener("change", selectManagedProviderModel); $("pm-provider-editor").onsubmit = saveManagedProvider; $("pm-provider-refresh").onclick = refreshManagedProvider; $("pm-new-profile").textContent = "新增供应商"; $("pm-edit-profile").textContent = "编辑供应商";
    $("pm-open-terminal").onclick = openTerminal; $("pm-terminal-refresh").onclick = loadTerminalWorkspaces; $("pm-save-global-system-prompt").onclick = saveGlobalSettings; $("pm-save-mcp").onclick = saveMcpSettings; $("pm-change-port").onclick = function () { if (window.PaseoAndroid && typeof window.PaseoAndroid.changePaseoPort === "function") window.PaseoAndroid.changePaseoPort(); else setStatus("当前环境无法更改 Paseo 端口。", "error"); };
    window.addEventListener("paseo:open-workspace-browser", function () { $("pm-backdrop").classList.add("open"); state.directoryPurpose = null; setTab("workspace"); loadDirectories(state.directory || undefined); });
    $("pm-key").addEventListener("focus", function () { this.classList.add("pm-secret"); }); $("pm-key").addEventListener("dblclick", function () { this.classList.toggle("pm-secret"); });
    $("pm-import-all").onclick = importAll; $("pm-refresh-conv").onclick = manualRefreshStatus; $("pm-dir-up").onclick = function () { if (state.directoryParent) loadDirectories(state.directoryParent); }; $("pm-use-dir").onclick = useDirectory;
    $("pm-skill-browse").onclick = function () { state.directoryPurpose = "skill"; setTab("workspace"); }; $("pm-plugin-browse").onclick = function () { state.directoryPurpose = "plugin"; setTab("workspace"); }; $("pm-skill-import").onclick = function () { state.directoryPurpose = null; manager("skill-import", null, { path: $("pm-skill-path").value, target: state.skillTarget }).then(function (result) { state.skills = result.skills || state.skills; renderSkills(); setStatus("Skill 已导入到" + (state.skillTarget === "codex" ? " Codex" : state.skillTarget === "claude" ? " Claude" : "通用") + "目录。", "success"); }).catch(function (e) { setStatus(e.message, "error"); }); }; $("pm-plugin-import").onclick = function () { state.directoryPurpose = null; manager("plugin-import", null, { path: $("pm-plugin-path").value }).then(loadPlugins).catch(function (e) { setStatus(e.message, "error"); }); };
    $("pm-custom-cli-source-type").addEventListener("change", updateCustomCliSourceFields);
    $("pm-custom-cli-form").addEventListener("submit", addCustomCli);
    updateCustomCliSourceFields();
    setTab("agent");
    resumePendingTerminalOpen();
    scheduleRetryStatusPoll(15000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) scheduleRetryStatusPoll(0); });
    window.setInterval(function () { if (state.tab === "conversations" && !document.hidden) loadConversations(false); }, 10000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build, { once: true }); else build();
})();
