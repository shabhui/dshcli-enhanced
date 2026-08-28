import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("Android startup marks the daemon as standalone without pre-creating a workspace", async () => {
  const startup = await source("ZeroTermux-main/app/src/main/assets/paseo-runtime/start-paseo.sh");

  assert.match(startup, /PASEO_STANDALONE_ANDROID=1/);
  assert.doesNotMatch(startup, /PASEO_STANDALONE_WORKSPACE/);
  assert.doesNotMatch(startup, /workspaces\/default/);
  assert.match(startup, /ENHANCED_MARKER="\$APP_DIR\/enhanced-fingerprint"/);
  assert.match(startup, /BUNDLED_FINGERPRINT_FILE="\$RUNTIME_DIR\/asset-fingerprint"/);
  assert.doesNotMatch(startup, /enhanced-fingerprint\.mjs/);
});

test("standalone Android does not auto-download optional local speech models", async () => {
  const startup = await source("ZeroTermux-main/app/src/main/assets/paseo-runtime/start-paseo.sh");

  assert.match(startup, /PASEO_VOICE_MODE_ENABLED=false/);
  assert.match(startup, /PASEO_DICTATION_ENABLED=false/);
});

test("Android validates installed Node through its fixed RUNPATH without contaminating system tools", async () => {
  const startup = await source("ZeroTermux-main/app/src/main/assets/paseo-runtime/start-paseo.sh");
  const installer = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/install-bundled-runtime.sh",
  );

  assert.doesNotMatch(startup, /LD_LIBRARY_PATH/u);
  assert.doesNotMatch(installer, /LD_LIBRARY_PATH/u);
  const promoteIndex = installer.indexOf('"$TOYBOX" mv "$staged" "$target"');
  const validationIndex = installer.indexOf('NODE_VERSION="$("$PREFIX/bin/node" --version)"');
  assert.ok(promoteIndex >= 0);
  assert.ok(validationIndex > promoteIndex);
});

test("unchanged Android runtime startup avoids launching every CLI just to validate versions", async () => {
  const installer = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/install-bundled-runtime.sh",
  );
  const fastPath = installer.match(/if \[ "\$\("\$TOYBOX" cat "\$MARKER"[\s\S]*?\nfi/)?.[0] ?? "";

  assert.match(fastPath, /-x "\$PREFIX\/bin\/node"/u);
  assert.match(fastPath, /@getpaseo\/cli\/package\.json/u);
  assert.doesNotMatch(fastPath, /--version/u);
  assert.doesNotMatch(fastPath, /node" -p/u);
});

test("bundled runtime upgrades stage and roll back only App-owned paths", async () => {
  const installer = await source("ZeroTermux-main/app/src/main/assets/paseo-runtime/install-bundled-runtime.sh");

  assert.match(installer, /STAGED_PREFIX=/u);
  assert.match(installer, /RUNTIME_OWNERSHIP=/u);
  assert.match(installer, /PROCESSED_PATHS="\$APP_DIR\/runtime-prefix\.processed"/u);
  assert.match(installer, /COMMIT_FILE="\$APP_DIR\/runtime-prefix\.commit"/u);
  assert.match(installer, /rollback_runtime_swap\(\) \(/u);
  assert.match(installer, /rollback_failed=true/u);
  assert.match(installer, /safe_target_path/u);
  assert.match(installer, /\[ -L "\$ancestor" \]/u);
  assert.match(installer, /Invalid runtime ownership path/u);
  assert.match(installer, /\.old-marker/u);
  assert.match(installer, /\.marker-was-missing/u);
  assert.match(installer, /\[ -f "\$COMMIT_FILE" \] \|\| \[ -f "\$PROCESSED_PATHS" \]/u);
  assert.match(
    installer,
    /rollback_runtime_swap \|\| \{ recovery_status=\$\?; exit "\$recovery_status"; \}/u,
  );
  assert.match(installer, /cp "\$LEGACY_PROCESSED_PATHS" "\$PROCESSED_PATHS" \|\| exit 1/u);
  assert.match(installer, /: > "\$COMMIT_FILE" \|\| exit 1/u);
  assert.match(installer, /cp "\$RUNTIME_OWNERSHIP" "\$BACKUP_PREFIX\/\.old-ownership" \|\| exit 1/u);
  assert.match(installer, /cat "\$RUNTIME_OWNERSHIP" > "\$ALL_OWNERSHIP\.input" \|\| exit 1/u);
  assert.match(installer, /cp "\$MARKER" "\$BACKUP_PREFIX\/\.old-marker" \|\| exit 1/u);
  assert.match(installer, /printf 'old %s\\n' "\$relative" >> "\$PROCESSED_PATHS" \|\| exit 1/u);
  assert.match(installer, /mv "\$target" "\$saved" \|\| exit 1/u);
  assert.match(installer, /mv "\$staged" "\$target" \|\| exit 1/u);
  assert.match(installer, /rollback_on_signal\(\) \{/u);
  assert.match(installer, /trap 'rollback_runtime_swap' EXIT/u);
  assert.match(installer, /trap 'rollback_on_signal 130' INT/u);
  assert.match(installer, /trap 'rollback_on_signal 143' TERM/u);
  assert.match(installer, /mv "\$MARKER\.tmp" "\$MARKER"/u);
  assert.match(installer, /rm -f "\$PROCESSED_PATHS"/u);
  assert.match(installer, /rm -f "\$COMMIT_FILE"/u);
  assert.match(installer, /tar -xf - -C "\$STAGED_PREFIX"/u);
  assert.match(installer, /runtime-owned-paths/u);
  assert.doesNotMatch(installer, /tar -xf - -C "\$PREFIX"/u);
  assert.doesNotMatch(installer, /rm -rf "\$PREFIX"/u);
});

test("management API returns the app-owned local host without creating a workspace", async () => {
  const management = await source("patches/server/paseo-management.js");
  const standalone = management.match(/async function standaloneBootstrap[\s\S]*?\n}\n\nfunction requireRuntime/)?.[0] ?? "";

  assert.match(management, /action === "standalone-bootstrap"/);
  assert.match(standalone, /process\.env\.PASEO_STANDALONE_ANDROID !== "1"/);
  assert.match(standalone, /const route = `\/h\/\$\{encodeURIComponent\(runtime\.serverId\)\}\/open-project`/);
  assert.doesNotMatch(standalone, /PASEO_STANDALONE_WORKSPACE/);
  assert.doesNotMatch(standalone, /findOrCreateWorkspaceForDirectory/);
  assert.doesNotMatch(standalone, /workspaceId/);
});

test("standalone browser bootstrap seeds only the local host before React starts", async () => {
  const bootstrap = await source("web/paseo-standalone-bootstrap.js");

  assert.match(bootstrap, /__PASEO_STANDALONE_ANDROID__/);
  assert.match(bootstrap, /open\("GET", "\/api\/paseo-manager\?action=standalone-bootstrap", false\)/);
  assert.match(bootstrap, /@paseo:daemon-registry/);
  assert.match(bootstrap, /var LOCAL_ENDPOINT = window\.location\.host/u);
  assert.match(bootstrap, /endpoint:\s*LOCAL_ENDPOINT/u);
  assert.match(bootstrap, /payload\.route/);
  assert.match(bootstrap, /window\.location\.pathname === "\/"/);
  assert.doesNotMatch(bootstrap, /paseo:last-workspace-route-selection/);
  assert.doesNotMatch(bootstrap, /workspaceId/);
  assert.match(bootstrap, /settings-add-host/);
  assert.match(bootstrap, /welcome-direct-connection/);
});

test("standalone Android hides the official host switcher as well as add-host flows", async () => {
  const bootstrap = await source("web/paseo-standalone-bootstrap.js");

  assert.match(bootstrap, /#sidebar-hosts-trigger/);
  assert.match(bootstrap, /settings-add-host/);
  assert.match(bootstrap, /add-project-flow-add-host/);
});

test("standalone open-project actions use compact, direct wording", async () => {
  const bootstrap = await source("web/paseo-standalone-bootstrap.js");

  assert.match(bootstrap, /function simplifyStandaloneOpenProject/u);
  assert.match(bootstrap, /open-project-submit/u);
  assert.match(bootstrap, /创建工作区/u);
  assert.match(bootstrap, /选择手机上的文件夹/u);
  assert.match(bootstrap, /导入对话/u);
  assert.match(bootstrap, /管理 Agent/u);
  assert.match(bootstrap, /MutationObserver/u);
});

test("standalone Android keeps local Paseo usable when internet access is offline", async () => {
  const bootstrap = await source("web/paseo-browser-bootstrap.js");

  assert.match(bootstrap, /function requiresInternetConnection\(\)/);
  assert.match(
    bootstrap,
    /if \(requiresInternetConnection\(\)\) show\("\u7f51\u7edc\u5df2\u65ad\u5f00/,
  );
  assert.match(
    bootstrap,
    /if \(pending \|\| \(requiresInternetConnection\(\) && navigator\.onLine === false\)\)/,
  );
});

test("standalone Android opens the in-app private workspace browser from create-workspace actions", async () => {
  const bootstrap = await source("web/paseo-standalone-bootstrap.js");

  assert.match(bootstrap, /paseo:open-workspace-browser/u);
  assert.match(bootstrap, /openWorkspaceBrowser/u);
  assert.doesNotMatch(bootstrap, /function bindAndroidWorkspaceActions\(\) \{\n    if \(!isAndroidBridgeAvailable\(\)\) return;/u);
  const binding = bootstrap.match(/function bindAndroidWorkspaceActions\(\) \{[\s\S]*?\n  \}/u)?.[0] || "";
  assert.match(binding, /openWorkspaceBrowser\(\)/u);
  assert.doesNotMatch(binding, /pickWorkspaceDirectory\(\)/u);
  assert.match(bootstrap, /add-project-flow-method-new-directory/);
  assert.match(bootstrap, /add-project-flow-method-directory-search/);
  assert.match(bootstrap, /min-height:56px/);
});

test("installer applies the Android bootstrap before the official Web UI bundle", async () => {
  const installer = await source("install.mjs");

  assert.match(installer, /patchStandaloneLoopbackTransport/);
  assert.match(installer, /paseo-standalone-bootstrap\.js/);
  assert.match(installer, /PASEO_STANDALONE_ANDROID/);
  assert.match(installer, /normalizeLoopbackToLocalhost/);
  assert.match(installer, /127\.0\.0\.1/);
  assert.match(installer, /const standaloneBootstrap = standaloneAndroid/);
  assert.match(installer, /html = html\.replace\("<head>", `<head>\\n\$\{daemonBootstrap\}/);
});

test("Android runtime generation forces existing installs to receive standalone startup fixes", async () => {
  const runtimeInstaller = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/install-bundled-runtime.sh",
  );
  const runtimeVersion = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/runtime-version",
  );

  assert.match(runtimeInstaller, /RUNTIME_VERSION="paseo-0\.3\.1-codex-0\.147\.0-arm64-v8"/);
  assert.match(runtimeVersion, /paseo-enhanced-2\.3\.6-runtime-15/);
  assert.match(runtimeInstaller, /\[ -f "\$RUNTIME_OWNERSHIP" \]/u);
});

test("Android build generates a constant-time runtime asset fingerprint", async () => {
  const build = await source("ZeroTermux-main/app/build.gradle");
  const installer = await source(
    "ZeroTermux-main/app/src/main/java/com/termux/paseo/PaseoAssetInstaller.java",
  );

  assert.match(build, /asset-fingerprint/u);
  assert.match(build, /MessageDigest\.getInstance\("SHA-256"\)/u);
  assert.match(installer, /ASSET_FINGERPRINT/u);
  assert.match(installer, /bundledFingerprint\.equals\(readText\(installedFingerprintFile\)\)/u);
});

test("non-ARM64 environments do not block the local Paseo console when Codex cannot execute", async () => {
  const runtimeInstaller = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/install-bundled-runtime.sh",
  );

  assert.match(runtimeInstaller, /uname -m/);
  assert.match(runtimeInstaller, /aarch64/);
  assert.match(runtimeInstaller, /continuing Paseo startup/);
});
