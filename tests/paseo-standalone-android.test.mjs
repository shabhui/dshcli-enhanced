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

test("create-workspace actions prefer the SAF picker and fall back to the in-app browser", async () => {
  const bootstrap = await source("web/paseo-standalone-bootstrap.js");

  assert.match(bootstrap, /paseo:open-workspace-browser/u);
  assert.match(bootstrap, /openWorkspaceBrowser/u);
  assert.doesNotMatch(bootstrap, /function bindAndroidWorkspaceActions\(\) \{\n    if \(!isAndroidBridgeAvailable\(\)\) return;/u);
  const binding = bootstrap.match(/function bindAndroidWorkspaceActions\(\) \{[\s\S]*?\n  \}/u)?.[0] || "";
  // SAF 优先：bridge 在（真机 WebView）走系统文件管理器选目录；
  // bridge 不在（电脑端浏览器打开）退回自制目录浏览器。
  assert.match(binding, /isAndroidBridgeAvailable\(\)/u);
  assert.match(binding, /pickWorkspaceDirectory\(\)/u);
  assert.match(binding, /openWorkspaceBrowser\(\)/u);
  assert.match(binding, /paseo:directory-picked/u);
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

  assert.match(
    runtimeInstaller,
    /RUNTIME_VERSION="paseo-0\.3\.1-codex-0\.147\.0-npm-11\.16\.0-pnpm-11\.7\.0-eac-5\.3\.6-git-2\.55\.0-arm64-v12"/,
  );
  assert.match(runtimeVersion, /paseo-enhanced-2\.3\.7-runtime-16/);
  assert.match(runtimeInstaller, /\[ -f "\$RUNTIME_OWNERSHIP" \]/u);
});

test("Android runtime bundles and atomically installs the EAC payload", async () => {
  const installer = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/install-bundled-runtime.sh",
  );
  const assembler = await source("scripts/prepare-android-runtime.ps1");

  assert.match(assembler, /eac-runtime-arm64\.tgz/u);
  assert.match(assembler, /stage-eac-android-runtime\.mjs/u);
  assert.match(assembler, /node_modules\/@img\/sharp-wasm32/u);
  assert.match(assembler, /node_modules\/@emnapi\/runtime/u);
  assert.match(assembler, /node_modules\/tslib/u);
  assert.match(assembler, /koffi-android-arm64/u);
  assert.match(assembler, /Deepseek\.Harness\.EAC_5\.3\.6_amd64\.deb/u);
  assert.match(assembler, /05acc5e789d1a3919d56bfc21f1b7f97b764f9be48d5fd39a76108606605a2fc/u);
  assert.match(assembler, /\$manifestLines[\s\S]*\$eacArchiveName/u);

  assert.match(installer, /EAC_ARCHIVE="\$PACKAGES_DIR\/eac-runtime-arm64\.tgz"/u);
  assert.match(installer, /EAC_ROOT="\$RUNTIME_DIR\/eac"/u);
  assert.match(installer, /EAC_STAGING_ROOT="\$RUNTIME_DIR\/eac-payload\.staging"/u);
  assert.match(installer, /EAC_STAGED_ROOT="\$EAC_STAGING_ROOT\/eac"/u);
  assert.match(installer, /EAC_BACKUP="\$RUNTIME_DIR\/eac\.backup"/u);
  assert.match(installer, /EAC_SHA_FILE="\$EAC_ROOT\/\.payload-sha256"/u);
  assert.match(installer, /gzip -dc "\$EAC_ARCHIVE"[\s\S]*tar -xf - -C "\$EAC_STAGING_ROOT"/u);
  for (const file of ["server.js", "bridge.js", "phone-bridge.js", "rescue-integration.js"]) {
    const escaped = file.replace(".", "\\.");
    assert.match(installer, new RegExp(`\\[ -f "\\$root/sidecar/${escaped}" \\]`, "u"));
  }
  assert.match(installer, /\[ -f "\$root\/dsh-desktop\/package\.json" \]/u);
  assert.match(installer, /\[ -f "\$root\/dsh-desktop\/lib\/desktop\/boot-server\.js" \]/u);
  assert.match(installer, /printf '%s\\n' "\$expected_sha" > "\$EAC_STAGED_ROOT\/\.payload-sha256\.tmp"/u);
  assert.match(installer, /mv "\$EAC_STAGED_ROOT\/\.payload-sha256\.tmp" "\$EAC_STAGED_ROOT\/\.payload-sha256"/u);
  assert.match(installer, /mv "\$EAC_ROOT" "\$EAC_BACKUP"/u);
  assert.match(installer, /mv "\$EAC_STAGED_ROOT" "\$EAC_ROOT"/u);
  assert.match(installer, /mv "\$EAC_BACKUP" "\$EAC_ROOT"/u);

  const eacInstallIndex = installer.indexOf('install_eac_payload "$EAC_EXPECTED_SHA"');
  const prefixFastPathIndex = installer.indexOf('cat "$MARKER"');
  assert.ok(eacInstallIndex >= 0, "EAC install call must be present");
  assert.ok(prefixFastPathIndex > eacInstallIndex,
    "EAC freshness installation must run before the prefix fast-path can exit");
});

test("Android runtime bundles npm and pnpm with device wrappers", async () => {
  const runtimeInstaller = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/install-bundled-runtime.sh",
  );
  const assembler = await source("scripts/prepare-android-runtime.ps1");
  const runtimeProject = JSON.parse(await source("scripts/android-runtime/package.json"));

  // Pinned through the lockfile, not copied from whatever Node the build host
  // happens to have. npm 11.16.0 is the version Node 24.18.0 itself ships.
  assert.equal(runtimeProject.dependencies.npm, "11.16.0");
  assert.equal(runtimeProject.dependencies.pnpm, "11.7.0");

  // Assembly must fail loudly if either entry point is absent from the payload.
  assert.match(assembler, /node_modules\/npm\/bin\/npm-cli\.js/u);
  assert.match(assembler, /node_modules\/pnpm\/bin\/pnpm\.cjs/u);
  // pnpm vendors Windows-only fastlist helpers that the .exe/.dll guard rejects.
  assert.match(assembler, /pnpm\\dist\\vendor/u);

  // The wrappers cannot rely on a shebang lookup: Termux has no /usr/bin/env,
  // so both exec the bundled node against an absolute entry-point path.
  assert.match(
    runtimeInstaller,
    /exec "\$PREFIX\/bin\/node" "\$PREFIX\/lib\/node_modules\/npm\/bin\/npm-cli\.js" "\$@"/u,
  );
  assert.match(
    runtimeInstaller,
    /exec "\$PREFIX\/bin\/node" "\$PREFIX\/lib\/node_modules\/pnpm\/bin\/pnpm\.cjs" "\$@"/u,
  );
  // Owned paths, so a later install removes them instead of orphaning them.
  assert.match(runtimeInstaller, /'bin\/paseo' 'bin\/codex' 'bin\/npm' 'bin\/pnpm'/u);
  // The freshness gate must notice a runtime that is missing either tool.
  assert.match(runtimeInstaller, /\[ -x "\$PREFIX\/bin\/npm" \]/u);
  assert.match(runtimeInstaller, /\[ -x "\$PREFIX\/bin\/pnpm" \]/u);
});

test("Android package-manager hooks relocate official Termux debs at install time", async () => {
  const installer = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/install-bundled-runtime.sh",
  );
  const relocator = await source("scripts/android-dpkg-relocate.cjs");

  assert.match(installer, /dsha-dpkg-relocate\.js/u);
  assert.match(installer, /libexec\/dsha-runtime/u);
  assert.match(installer, /com\.termux/u);
  assert.match(installer, /com\.dshcli/u);
  assert.match(installer, /bin\/apt/u);
  assert.match(installer, /bin\/apt-get/u);
  assert.match(installer, /bin\/dpkg/u);
  assert.match(installer, /bin\/dpkg-deb/u);
  assert.match(relocator, /spawnSync/u);
  assert.match(relocator, /--raw-extract/u);
  assert.match(relocator, /--build/u);
  assert.match(relocator, /Buffer\.from\(['"]com\.termux['"]\)/u);
  assert.match(installer, /append_directory_units "\$STAGED_PREFIX\/libexec"/u);
  assert.doesNotMatch(installer, /Package: git/u);
});

test("runtime assembly pins tar and stays runnable without symlink privilege", async () => {
  const assembler = await source("scripts/prepare-android-runtime.ps1");

  // A bare `tar.exe` resolves through PATH. Launched from git-bash that finds GNU
  // tar, which reads the `D:` of an absolute archive path as a remote host and
  // aborts, so the tool is pinned to Windows' own bsdtar instead.
  assert.match(assembler, /\$tar = Join-Path \$env:SystemRoot 'System32\\tar\.exe'/u);
  assert.doesNotMatch(assembler, /& tar\.exe/u);

  // Only the Node headers are wanted here. Unpacking the whole deb also unpacks
  // bin/corepack, the payload's one symlink, which fails without
  // SeCreateSymbolicLinkPrivilege and would take the entire run down with it.
  assert.match(assembler, /include\/node"\r?\n/u);

  // Staging the Termux archive needs those privileges, so an operator who lacks
  // them can reuse the committed one, but only if it is actually there.
  assert.match(assembler, /\[switch\]\$SkipTermuxRuntime/u);
  assert.match(assembler, /-SkipTermuxRuntime needs the existing \$termuxArchiveName/u);

  // Validation re-extracts that archive purely to scan file contents, and it skips
  // reparse points, so symlinks it could not create cost it no coverage. Capturing
  // native stderr needs the script-wide 'Stop' preference relaxed first, otherwise
  // the first warning terminates the run before the exit code is read.
  assert.match(assembler, /\$ErrorActionPreference = 'Continue'/u);
  assert.match(assembler, /\$ErrorActionPreference = \$previousErrorAction/u);
  assert.match(assembler, /Can't create '\.\+': Invalid argument/u);
});

test("runtime assembly replaces the manifest instead of truncating a file held by readers", async () => {
  const assembler = await source("scripts/prepare-android-runtime.ps1");

  assert.match(assembler, /\$manifestTemporary = "\$manifest\.tmp"/u);
  assert.match(assembler, /WriteAllText\(\s*\$manifestTemporary,/u);
  assert.match(assembler, /Move-Item -LiteralPath \$manifestTemporary -Destination \$manifest -Force/u);
});

test("runtime symlink replay omits all pruned paths and uses LF", async () => {
  const assembler = await source("scripts/prepare-android-runtime.ps1");
  assert.match(assembler, /@\(\$runtimeDirectoriesToPrune\).*@\(\$runtimeFilesToPrune\)/u);
  assert.match(assembler, /WriteAllText\(\$linkList,.*-join "`n"/u);
});

test("cold start defers the legacy UI stack and storage permission", async () => {
  const application = await source("ZeroTermux-main/app/src/main/java/com/termux/app/TermuxApplication.java");
  const activity = await source("ZeroTermux-main/app/src/main/java/com/termux/paseo/PaseoActivity.java");
  const onCreate = activity.slice(activity.indexOf("protected void onCreate"), activity.indexOf("private boolean hasStoragePermission"));
  assert.doesNotMatch(onCreate, /requestStoragePermissionIfNeeded/u);
  assert.match(application, /onActivityPreCreated/u);
  assert.match(application, /ensureLegacyUiInitialized/u);
  const appCreate = application.slice(application.indexOf("public void onCreate()"), application.indexOf("public static void setLogConfig"));
  assert.doesNotMatch(appCreate, /onCreateInit\(\)/u);
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
