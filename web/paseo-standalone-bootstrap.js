(function () {
  "use strict";

  if (window.__PASEO_STANDALONE_BOOTSTRAP_LOADED__) return;
  window.__PASEO_STANDALONE_BOOTSTRAP_LOADED__ = true;
  window.__PASEO_STANDALONE_ANDROID__ = true;
  var LOCAL_ENDPOINT = window.location.host;
  window.__PASEO_INITIAL_DAEMON_CONNECTION__ = {
    listen: LOCAL_ENDPOINT,
    useTls: false
  };

  var DAEMON_REGISTRY_KEY = "@paseo:daemon-registry";
  var directoryBusy = false;

  function installStandaloneStyles() {
    var style = document.createElement("style");
    style.id = "paseo-standalone-visibility";
    style.textContent = [
      '#sidebar-hosts-trigger',
      '[data-testid="settings-add-host"]',
      '[data-testid="settings-host-picker"]',
      '[data-testid="add-project-flow-add-host"]',
      '[data-testid="welcome-direct-connection"]',
      '[data-testid="welcome-paste-pairing-link"]',
      '[data-testid="welcome-scan-qr"]',
      '[data-testid="host-page-connections-card"]',
      '[data-testid="host-page-pair-device-card"]',
      '[data-testid="host-page-remove-host-card"]'
    ].join(",") + "{display:none!important}" +
      '[data-testid="open-project-submit"],[data-testid="open-project-import-session"],[data-testid="open-project-setup-providers"],[data-testid="sidebar-global-new-workspace"],[data-testid="sidebar-add-project"],[data-testid="add-project-flow-method-new-directory"],[data-testid="add-project-flow-method-directory-search"]{min-height:56px!important;padding:12px!important;width:100%!important;box-sizing:border-box!important;touch-action:manipulation!important;pointer-events:auto!important}' +
      '[data-testid="open-project-submit"]>div,[data-testid="open-project-import-session"]>div,[data-testid="open-project-setup-providers"]>div{gap:2px!important}';
    document.head.appendChild(style);
  }

  function replaceActionCopy(element, title, description) {
    if (!element) return;
    var textNodes = [];
    var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.trim()) textNodes.push(node);
    }
    if (textNodes[0] && textNodes[0].nodeValue.trim() !== title) textNodes[0].nodeValue = title;
    if (textNodes[1] && textNodes[1].nodeValue.trim() !== description) textNodes[1].nodeValue = description;
    element.setAttribute("aria-label", title + "：" + description);
  }

  function simplifyStandaloneOpenProject() {
    replaceActionCopy(document.querySelector('[data-testid="open-project-submit"]'), "创建工作区", "选择手机上的文件夹");
    replaceActionCopy(document.querySelector('[data-testid="open-project-import-session"]'), "导入对话", "导入外部 Agent 对话");
    replaceActionCopy(document.querySelector('[data-testid="open-project-setup-providers"]'), "管理 Agent", "安装 CLI，添加和切换供应商");
  }

  function observeStandaloneOpenProject() {
    simplifyStandaloneOpenProject();
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () { scheduled = false; simplifyStandaloneOpenProject(); });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function isAndroidBridgeAvailable() {
    return !!(window.PaseoAndroid && typeof window.PaseoAndroid.pickWorkspaceDirectory === "function");
  }

  function workspaceAdd(path) {
    if (!path) return;
    directoryBusy = true;
    var targets = [
      '[data-testid="open-project-submit"]',
      '[data-testid="sidebar-global-new-workspace"]',
      '[data-testid="sidebar-add-project"]',
      '[data-testid="add-project-flow-method-new-directory"]',
      '[data-testid="add-project-flow-method-directory-search"]'
    ];
    targets.forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (element) {
        element.dataset.paseoDirectoryBusy = "1";
        element.style.opacity = "0.65";
        element.style.pointerEvents = "none";
      });
    });
    fetch("/api/paseo-manager?action=workspace-add", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "workspace-add", path: path })
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error(payload.error || "工作区创建失败");
        return payload;
      });
    }).then(function (payload) {
      if (!payload.serverId || !payload.workspace || !payload.workspace.id) {
        throw new Error("工作区创建响应不完整");
      }
      window.location.href = "/h/" + encodeURIComponent(payload.serverId) + "/workspace/" + encodeURIComponent(payload.workspace.id);
    }).catch(function (error) {
      directoryBusy = false;
      window.__PASEO_DIRECTORY_ERROR__ = String(error && error.message || error);
      console.error("[Paseo] Workspace directory failed", error);
      showDirectoryStatus(window.__PASEO_DIRECTORY_ERROR__, true);
      targets.forEach(function (selector) {
        document.querySelectorAll(selector).forEach(function (element) {
          delete element.dataset.paseoDirectoryBusy;
          element.style.opacity = "";
          element.style.pointerEvents = "";
        });
      });
    });
  }

  function pickWorkspaceDirectory() {
    if (!isAndroidBridgeAvailable() || directoryBusy) return false;
    directoryBusy = true;
    window.PaseoAndroid.pickWorkspaceDirectory();
    return true;
  }

  function showDirectoryStatus(message, isError) {
    var node = document.getElementById("paseo-directory-status");
    if (!node) {
      node = document.createElement("div");
      node.id = "paseo-directory-status";
      node.style.cssText = "position:fixed;left:16px;right:16px;bottom:88px;z-index:2147483646;padding:12px 14px;border-radius:6px;background:#202624;color:#f4f7f6;font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28)";
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.style.border = isError ? "1px solid #d56565" : "1px solid #4b8f72";
    node.hidden = false;
    window.clearTimeout(showDirectoryStatus.timer);
    showDirectoryStatus.timer = window.setTimeout(function () { node.hidden = true; }, 5000);
  }

  function openWorkspaceBrowser() {
    window.dispatchEvent(new CustomEvent("paseo:open-workspace-browser"));
  }

  function bindAndroidWorkspaceActions() {
    document.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target.closest(
        '[data-testid="open-project-submit"],[data-testid="sidebar-global-new-workspace"],[data-testid="sidebar-add-project"],[data-testid="add-project-flow-method-new-directory"],[data-testid="add-project-flow-method-directory-search"]'
      ) : null;
      if (!target || target.dataset.paseoDirectoryBusy === "1") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openWorkspaceBrowser();
    }, true);
    window.addEventListener("paseo:directory-picked", function (event) {
      var detail = event && event.detail || {};
      if (detail.error) {
        directoryBusy = false;
        window.__PASEO_DIRECTORY_ERROR__ = detail.error;
        console.error("[Paseo] Directory picker failed", detail.error);
        showDirectoryStatus(detail.error, true);
        return;
      }
      if (detail.cancelled) {
        directoryBusy = false;
        return;
      }
      directoryBusy = false;
      showDirectoryStatus("正在创建工作区…", false);
      workspaceAdd(detail.path);
    });
  }

  function readStandaloneBootstrap() {
    var request = new XMLHttpRequest();
    request.open("GET", "/api/paseo-manager?action=standalone-bootstrap", false);
    request.setRequestHeader("Accept", "application/json");
    request.send(null);
    if (request.status < 200 || request.status >= 300) {
      throw new Error("Standalone bootstrap returned HTTP " + request.status);
    }
    return JSON.parse(request.responseText || "{}");
  }

  function seedOfficialStores(payload) {
    if (!payload || !payload.serverId || !payload.route) {
      throw new Error("Standalone bootstrap response is incomplete");
    }
    var now = new Date().toISOString();
    var connectionId = "direct:" + LOCAL_ENDPOINT;
    var host = {
      serverId: payload.serverId,
      label: payload.label || "Paseo 本机",
      appearance: { color: "none", badgeDisplay: null },
      lifecycle: {},
      connections: [{
        id: connectionId,
        type: "directTcp",
        endpoint: LOCAL_ENDPOINT,
        useTls: false
      }],
      preferredConnectionId: connectionId,
      createdAt: now,
      updatedAt: now
    };
    window.localStorage.setItem(DAEMON_REGISTRY_KEY, JSON.stringify([host]));
    window.__PASEO_STANDALONE_ROUTE__ = payload.route;
  }

  function redirectHostOnboarding(route) {
    if (!route) return;
    if (window.location.pathname === "/" ||
        /^\/(?:welcome|pair-scan|open-project)(?:\/|$)/.test(window.location.pathname)) {
      window.location.replace(route);
    }
  }

  installStandaloneStyles();
  observeStandaloneOpenProject();
  bindAndroidWorkspaceActions();
  try {
    var payload = readStandaloneBootstrap();
    seedOfficialStores(payload);
    redirectHostOnboarding(payload.route);
  } catch (error) {
    window.__PASEO_STANDALONE_BOOTSTRAP_ERROR__ = String(error && error.message || error);
    console.error("[Paseo] Standalone bootstrap failed", error);
  }
})();
