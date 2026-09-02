import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addAgentCli,
  listAgentCliCatalog,
  installAgentCli,
  agentCliInstallRoot,
  packageManagerEnvironment,
  rerootAgentStatePaths,
  updateAgentCli,
} from "../patches/server/paseo-agent-cli-installer.js";

async function tempHome() {
  return mkdtemp(path.join(os.tmpdir(), "paseo-agent-cli-"));
}

async function source(relativePath) {
  return readFile(path.resolve(process.cwd(), relativePath), "utf8");
}

function fakeProviderManager() {
  return {
    hasProvider(providerId) {
      return ["codex", "claude", "opencode"].includes(providerId);
    },
    async listProviders() {
      return [];
    },
  };
}

test("catalog keeps native providers and reports bundled Codex separately", async () => {
  const home = await tempHome();
  const catalog = await listAgentCliCatalog({ paseoHome: home });
  const codex = catalog.find((entry) => entry.providerId === "codex");

  assert.ok(codex);
  assert.equal(codex.installed, true);
  assert.equal(codex.installable, true);
  assert.equal(codex.status, "bundled");
  assert.match(codex.message, /随 App/);
  const paseo = catalog.find((entry) => entry.providerId === "paseo");
  assert.ok(paseo);
  assert.equal(paseo.kind, "paseo");
  assert.equal(paseo.updateable, true);
});

test("Claude, OpenCode, and Pi are protected Paseo-preconfigured installs", async () => {
  const home = await tempHome();
  const catalog = await listAgentCliCatalog({ paseoHome: home });
  const expected = {
    claude: { package: "@anthropic-ai/claude-code@latest", bin: "claude", extends: "claude" },
    opencode: { package: "opencode-ai@latest", bin: "opencode", extends: "opencode" },
    pi: { package: "@earendil-works/pi-coding-agent@latest", bin: "pi", extends: "pi" },
  };

  for (const [providerId, preset] of Object.entries(expected)) {
    const entry = catalog.find((candidate) => candidate.providerId === providerId);
    assert.ok(entry, `${providerId} preset must exist`);
    assert.equal(entry.kind, "preset");
    assert.equal(entry.installable, true);
    assert.equal(entry.updateable, true);
    assert.equal(entry.extends, preset.extends);
    assert.equal(entry.source.type, "npm");
    assert.equal(entry.source.package, preset.package);
    assert.equal(entry.source.bin, preset.bin);
    assert.match(entry.message, /Paseo 预配置版/u);
  }
});

test("Android catalog discloses the Termux Claude package while desktop keeps the official package", async () => {
  const home = await tempHome();
  const androidCatalog = await listAgentCliCatalog({ paseoHome: home, platform: "android" });
  const desktopCatalog = await listAgentCliCatalog({ paseoHome: home, platform: "linux" });
  const androidClaude = androidCatalog.find((entry) => entry.providerId === "claude");
  const desktopClaude = desktopCatalog.find((entry) => entry.providerId === "claude");

  assert.equal(androidClaude.source.package, "@bash0816/claude-code@2.1.237");
  assert.equal(androidClaude.source.updatePackage, "@bash0816/claude-code@2.1.237");
  assert.match(androidClaude.message, /Android\/Termux/u);
  assert.match(androidClaude.message, /不包含.*\.exe/u);
  assert.equal(desktopClaude.source.package, "@anthropic-ai/claude-code@latest");
  assert.match(desktopClaude.message, /官方 Claude CLI/u);
});

test("Android catalog disables OpenCode until an Android-native package is verified", async () => {
  const home = await tempHome();
  const androidCatalog = await listAgentCliCatalog({ paseoHome: home, platform: "android" });
  const desktopCatalog = await listAgentCliCatalog({ paseoHome: home, platform: "linux" });
  const androidOpenCode = androidCatalog.find((entry) => entry.providerId === "opencode");
  const desktopOpenCode = desktopCatalog.find((entry) => entry.providerId === "opencode");

  assert.equal(androidOpenCode.installable, false);
  assert.equal(androidOpenCode.updateable, false);
  assert.equal(androidOpenCode.status, "unsupported");
  assert.equal(androidOpenCode.source.type, "npm");
  assert.equal(androidOpenCode.source.package, "opencode-ai@latest");
  assert.match(androidOpenCode.message, /Android/u);
  assert.match(androidOpenCode.message, /native|Termux/u);
  assert.equal(desktopOpenCode.installable, true);
  assert.equal(desktopOpenCode.source.package, "opencode-ai@latest");
});

test("installer only exposes an App-private root", async () => {
  const home = await tempHome();
  const root = agentCliInstallRoot(home);
  assert.equal(root, path.join(home, "agents"));
  assert.match(root, /paseo-agent-cli-/);
});

test("production Paseo home resolves CLI files beside .paseo in the App-private home", async () => {
  const appHome = path.join(os.tmpdir(), "paseo-app-home");
  const root = agentCliInstallRoot(appHome);
  assert.equal(root, path.join(appHome, "agents"));
  const catalog = await listAgentCliCatalog({ paseoHome: path.join(appHome, ".paseo") });
  assert.ok(catalog.some((entry) => entry.providerId === "codex"));
});

test("preconfigured Provider installs reuse an intact existing installation", async () => {
  const home = await tempHome();
  let installs = 0;
  const runtime = {
    paseoHome: home,
    platform: "android",
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      installs += 1;
      const packageRoot = path.join(options.destination, "node_modules", "@earendil-works", "pi-coding-agent");
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.84.2",
        bin: { pi: "dist/cli.js" },
      }));
      await writeFile(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
    },
  };

  const first = await installAgentCli(runtime, "pi");
  const second = await installAgentCli(runtime, "pi");
  assert.equal(installs, 1);
  assert.deepEqual(second.command, first.command);
  assert.match(second.message, /已安装.*直接使用/u);
});

test("Android Claude reinstalls when stored state points to the desktop package", async () => {
  const home = await tempHome();
  const calls = [];
  const runAgentCliPackageInstall = async (options) => {
    calls.push(options.packageSpec);
    const termux = options.packageSpec.startsWith("@bash0816/claude-code");
    const packageName = termux ? "@bash0816/claude-code" : "@anthropic-ai/claude-code";
    const packageRoot = path.join(options.destination, "node_modules", ...packageName.split("/"));
    const entry = termux ? path.join("bin", "claude") : path.join("cli.js");
    await mkdir(path.join(packageRoot, path.dirname(entry)), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: packageName,
      version: termux ? "2.1.237" : "2.1.236",
      bin: { claude: entry },
    }));
    await writeFile(path.join(packageRoot, entry), termux
      ? "#!/system/bin/sh\nexit 0\n"
      : "#!/usr/bin/env node\n");
  };

  await installAgentCli({ paseoHome: home, platform: "linux", runAgentCliPackageInstall }, "claude");
  const installed = await installAgentCli({ paseoHome: home, platform: "android", runAgentCliPackageInstall }, "claude");

  assert.deepEqual(calls, ["@anthropic-ai/claude-code@latest", "@bash0816/claude-code@2.1.237"]);
  assert.match(installed.command[0], /packages[\\/]claude[\\/]paseo-cli$/u);
  const state = JSON.parse(await readFile(path.join(agentCliInstallRoot(home), "agent-cli-state.json"), "utf8"));
  assert.equal(state.claude.package, "@bash0816/claude-code@2.1.237");
  assert.match(state.claude.entryPath, /@bash0816[\\/]claude-code[\\/]bin[\\/]claude$/u);
});

test("missing npm package entry invalidates state and triggers reinstallation", async () => {
  const home = await tempHome();
  let installs = 0;
  const runtime = {
    paseoHome: home,
    platform: "android",
    async runAgentCliPackageInstall(options) {
      installs += 1;
      const packageRoot = path.join(options.destination, "node_modules", "@earendil-works", "pi-coding-agent");
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.84.2",
        bin: { pi: "dist/cli.js" },
      }));
      await writeFile(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
    },
  };

  await installAgentCli(runtime, "pi");
  const statePath = path.join(agentCliInstallRoot(home), "agent-cli-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await rm(state.pi.entryPath);

  const listed = (await listAgentCliCatalog(runtime)).find((entry) => entry.providerId === "pi");
  assert.equal(listed.installed, false);
  await installAgentCli(runtime, "pi");
  assert.equal(installs, 2);
});

test("Android catalog does not expose a stale desktop OpenCode install as usable", async () => {
  const home = await tempHome();
  const runtime = {
    paseoHome: home,
    platform: "linux",
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "opencode-ai");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "opencode-ai",
        version: "1.18.21",
        bin: { opencode: "bin/opencode.js" },
      }));
      await writeFile(path.join(packageRoot, "bin", "opencode.js"), "#!/usr/bin/env node\n");
    },
  };

  await installAgentCli(runtime, "opencode");
  const androidCatalog = await listAgentCliCatalog({ ...runtime, platform: "android" });
  const opencode = androidCatalog.find((entry) => entry.providerId === "opencode");

  assert.equal(opencode.status, "unsupported");
  assert.equal(opencode.installed, false);
  assert.deepEqual(opencode.command, []);
  assert.equal(opencode.state, "unsupported");
});

test("desktop npm launchers use the desktop shell shebang", async () => {
  const home = await tempHome();
  const runtime = {
    paseoHome: home,
    platform: "linux",
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "shell-agent");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "shell-agent",
        version: "1.0.0",
        bin: { agent: "bin/agent" },
      }));
      await writeFile(path.join(packageRoot, "bin", "agent"), "#!/bin/sh\nexit 0\n");
    },
  };
  await addAgentCli(runtime, {
    providerId: "shell-agent",
    label: "Shell Agent",
    extends: "acp",
    source: { type: "npm", package: "shell-agent@1.0.0", bin: "agent" },
  });

  const installed = await installAgentCli(runtime, "shell-agent");
  const launcher = await readFile(installed.command[0], "utf8");
  assert.match(launcher, /^#!\/bin\/sh\n/u);
  assert.match(launcher, /exec '\/bin\/sh'/u);
});

test("catalog self-heals lost execute permissions for Pi and Claude package entries", async () => {
  const home = await tempHome();
  const runtime = {
    paseoHome: home,
    platform: "android",
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      const claude = options.packageSpec.startsWith("@bash0816/claude-code");
      const packageRoot = claude
        ? path.join(options.destination, "node_modules", "@bash0816", "claude-code")
        : path.join(options.destination, "node_modules", "@earendil-works", "pi-coding-agent");
      const relativeEntry = claude ? path.join("bin", "claude") : path.join("dist", "cli.js");
      await mkdir(path.join(packageRoot, path.dirname(relativeEntry)), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: claude ? "@bash0816/claude-code" : "@earendil-works/pi-coding-agent",
        version: "1.0.0",
        bin: { [claude ? "claude" : "pi"]: relativeEntry },
      }));
      await writeFile(path.join(packageRoot, relativeEntry), claude
        ? "#!/system/bin/sh\nexit 0\n"
        : "#!/usr/bin/env node\n");
    },
  };

  for (const providerId of ["pi", "claude"]) {
    const installed = await installAgentCli(runtime, providerId);
    const launcher = installed.command[0];
    const entry = providerId === "claude"
      ? path.join(agentCliInstallRoot(home), "packages", "claude", "node_modules", "@bash0816", "claude-code", "bin", "claude")
      : path.join(agentCliInstallRoot(home), "packages", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    await chmod(launcher, 0o644);
    await chmod(entry, 0o644);

    await listAgentCliCatalog(runtime);

    if (process.platform !== "win32") {
      assert.notEqual((await stat(launcher)).mode & 0o111, 0, `${providerId} launcher should be executable`);
      assert.notEqual((await stat(entry)).mode & 0o111, 0, `${providerId} package entry should be executable`);
    }
  }

  assert.match(
    await source("patches/server/paseo-agent-cli-installer.js"),
    /fs\.chmod\(entryPath, 0o755\)/u,
    "catalog repair must restore the package entry mode, not only the wrapper mode",
  );
});

test("Paseo presets install through the same isolated package runner", async () => {
  const home = await tempHome();
  const runtime = {
    paseoHome: home,
    platform: "android",
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "@bash0816", "claude-code");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@bash0816/claude-code",
        version: "2.1.235",
        bin: { claude: "bin/claude" },
      }));
      await writeFile(path.join(packageRoot, "bin", "claude"), "#!/system/bin/sh\nexit 0\n");
    },
  };

  const installed = await installAgentCli(runtime, "claude");
  assert.match(installed.command[0], /agents[\\/]packages[\\/]claude[\\/]paseo-cli$/u);
  assert.notEqual(installed.command[0], process.execPath);
  assert.match(await readFile(installed.command[0], "utf8"), /bin[\\/]claude/u);
  assert.equal((await stat(path.join(
    agentCliInstallRoot(home), "packages", "claude", "node_modules", "@bash0816", "claude-code", "bin", "claude",
  ))).isFile(), true);
});

test("Android Claude installs use the audited Termux wrapper without an exe entry", async () => {
  const home = await tempHome();
  const calls = [];
  const runtime = {
    paseoHome: home,
    platform: "android",
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      calls.push(options);
      const packageRoot = path.join(options.destination, "node_modules", "@bash0816", "claude-code");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@bash0816/claude-code",
        version: "2.1.237",
        bin: { claude: "bin/claude" },
      }));
      await writeFile(path.join(packageRoot, "bin", "claude"), "#!/system/bin/sh\nexit 0\n");
    },
  };

  const installed = await installAgentCli(runtime, "claude");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].packageSpec, "@bash0816/claude-code@2.1.237");
  const launcher = await readFile(installed.command[0], "utf8");
  assert.match(launcher, /\/system\/bin\/sh/u);
  assert.match(launcher, /bin[\\/]claude/u);
  assert.doesNotMatch(launcher, /claude\.exe/u);
  await assert.rejects(() => stat(path.join(
    agentCliInstallRoot(home), "packages", "claude", "node_modules", "@bash0816", "claude-code", "bin", "claude.exe",
  )));
});

test("Android Claude launcher uses system tools and absolute Termux command shims", async () => {
  const home = await tempHome();
  const prefix = path.join(home, "usr");
  const prefixBin = path.join(prefix, "bin");
  const corepackDist = path.join(prefix, "lib", "node_modules", "corepack", "dist");
  await mkdir(prefixBin, { recursive: true });
  await mkdir(corepackDist, { recursive: true });
  for (const command of ["node", "curl", "git", "bash", "mktemp", "tar"]) {
    await writeFile(path.join(prefixBin, command), "native-placeholder\n", { mode: 0o755 });
  }
  await writeFile(path.join(corepackDist, "npm.js"), "#!/usr/bin/env node\n");
  const runtime = {
    paseoHome: home,
    platform: "android",
    cliSourceRoot: prefix,
    nodeExecutable: path.join(prefixBin, "node"),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "@bash0816", "claude-code");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@bash0816/claude-code",
        version: "2.1.237",
        bin: { claude: "bin/claude" },
      }));
      await writeFile(path.join(packageRoot, "bin", "claude"), "#!/usr/bin/env sh\nexit 0\n");
      await mkdir(path.join(packageRoot, "lib"), { recursive: true });
      await writeFile(path.join(packageRoot, "lib", "prepare-native.js"), "const tarballUrl = runCapture('npm', ['view', spec, 'dist.tarball', '--json']).replace(/^\"|\"$/g, '\\\\');\n");
      await writeFile(path.join(packageRoot, "lib", "termux-run-claude-native.sh"), "#!/system/bin/sh\nTERMUX_TMPDIR=\"${TMPDIR:-/data/data/com.termux/files/usr/tmp}\"\nSSL_CERT_DIR=\"${SSL_CERT_DIR:-/data/data/com.termux/files/usr/etc/tls}\"\nSSL_CERT_FILE=\"${SSL_CERT_FILE:-/data/data/com.termux/files/usr/etc/tls/cert.pem}\"\n");
    },
  };

  const installed = await installAgentCli(runtime, "claude");
  const agentsBin = path.join(agentCliInstallRoot(home), "bin");
  const launcher = await readFile(installed.command[0], "utf8");
  assert.equal(launcher.includes(`export TERMUX_PREFIX='${prefix}'`), true);
  assert.equal(launcher.includes(`export TERMUX_HOME='${home}'`), true);
  assert.equal(launcher.includes(`export DPKG_ADMINDIR='${path.posix.join(prefix, "var", "lib", "dpkg")}'`), true);
  assert.equal(launcher.includes(`export TERMUX_TMPDIR='${path.posix.join(prefix, "tmp")}'`), true);
  assert.match(launcher, new RegExp(`export PATH='${agentsBin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:${prefixBin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:/system/bin:/system/xbin'`, "u"));
  assert.match(launcher, new RegExp(`export MAGI_NODE='${path.join(agentsBin, "node").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}'`, "u"));
  assert.match(launcher, /export CLAUDE_TERMUX_STDIN='inherit'/u);
  for (const command of ["sh", "node", "curl", "git", "bash", "dirname", "readlink", "cat", "rm", "mkdir", "mktemp", "tar", "which"]) {
    const shim = await readFile(path.join(agentsBin, command), "utf8");
    assert.match(shim, /^#!\/system\/bin\/sh\n/u);
    if (command === "sh") {
      assert.equal(shim, "#!/system/bin/sh\nexec '/system/bin/sh' \"$@\"\n");
    } else if (["node", "curl", "git", "bash", "mktemp", "tar"].includes(command)) {
      assert.match(shim, new RegExp(path.join(prefixBin, command).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    } else {
      assert.match(shim, /\/system\/bin\/toybox/u);
      assert.match(shim, new RegExp(`['"]${command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}['"]`, "u"));
    }
  }
  const prepareNative = await readFile(path.join(
    agentCliInstallRoot(home), "packages", "claude", "node_modules", "@bash0816", "claude-code", "lib", "prepare-native.js",
  ), "utf8");
  assert.match(prepareNative, /Array\.isArray|JSON\.parse/u);
  const termuxRunner = await readFile(path.join(
    agentCliInstallRoot(home), "packages", "claude", "node_modules", "@bash0816", "claude-code", "lib", "termux-run-claude-native.sh",
  ), "utf8");
  assert.doesNotMatch(termuxRunner, /\/data\/data\/com\.termux/u);
  assert.match(termuxRunner, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

// Verbatim mode detection from @bash0816/claude-code lib/termux-run-claude-native.sh,
// plus an echo so the resolved mode is observable. The upstream script exports these two
// values as CLAUDE_TERMUX_PRINT_MODE / CLAUDE_TERMUX_TUI, and only TUI=1 skips the
// process.exit() that otherwise kills the CLI the moment its synchronous entry returns.
const CLAUDE_MODE_DETECTION_FIXTURE = `#!/usr/bin/env sh
set -eu

_pf=0
for _a in "$@"; do
  case "$_a" in
    -p|--print) _pf=1; break ;;
    --) break ;;
  esac
done

_tui=0
if [ "$_pf" = "0" ] && [ -t 0 ]; then
  _tui=1
fi

echo "PF=$_pf TUI=$_tui"
`;

async function runDetectedMode(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [scriptPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end();
  });
}

test("Android Claude wrapper stays alive for the Agent SDK's stream-json argv (no -p)", async () => {
  const home = await tempHome();
  const prefix = path.join(home, "usr");
  const prefixBin = path.join(prefix, "bin");
  await mkdir(prefixBin, { recursive: true });
  for (const command of ["node", "curl", "git", "bash", "mktemp", "tar"]) {
    await writeFile(path.join(prefixBin, command), "native-placeholder\n", { mode: 0o755 });
  }
  const runtime = {
    paseoHome: home,
    platform: "android",
    cliSourceRoot: prefix,
    nodeExecutable: path.join(prefixBin, "node"),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "@bash0816", "claude-code");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await mkdir(path.join(packageRoot, "lib"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@bash0816/claude-code",
        version: "2.1.237",
        bin: { claude: "bin/claude" },
      }));
      await writeFile(path.join(packageRoot, "bin", "claude"), "#!/usr/bin/env sh\nexit 0\n");
      await writeFile(path.join(packageRoot, "lib", "termux-run-claude-native.sh"), CLAUDE_MODE_DETECTION_FIXTURE);
    },
  };

  await installAgentCli(runtime, "claude");
  const wrapper = path.join(
    agentCliInstallRoot(home), "packages", "claude", "node_modules", "@bash0816", "claude-code",
    "lib", "termux-run-claude-native.sh",
  );

  // The SDK spawns the CLI with a piped stdin and no -p. Before the keep-alive patch this
  // resolved to PF=0 TUI=0, which made the wrapper process.exit(0) before the CLI read
  // stdin -- surfacing as "exit code 0" with no response.
  const sdkArgv = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
  assert.deepEqual(await runDetectedMode(wrapper, sdkArgv), { code: 0, out: "PF=0 TUI=1", err: "" });

  // Same flag in its = spelling.
  assert.deepEqual(
    await runDetectedMode(wrapper, ["--input-format=stream-json", "--output-format=stream-json"]),
    { code: 0, out: "PF=0 TUI=1", err: "" },
  );

  // -p keeps print mode: that path waits for the stdout flush instead, and forcing TUI
  // there would hang a single-shot invocation.
  assert.deepEqual(
    await runDetectedMode(wrapper, ["-p", "hello", "--input-format", "stream-json"]),
    { code: 0, out: "PF=1 TUI=0", err: "" },
  );

  // Piped stdin with no stream-json input is still a one-shot: no keep-alive.
  assert.deepEqual(await runDetectedMode(wrapper, ["--model", "sonnet"]), { code: 0, out: "PF=0 TUI=0", err: "" });

  // After --, tokens are prompt text rather than flags, so they must not trigger keep-alive.
  assert.deepEqual(
    await runDetectedMode(wrapper, ["--", "--input-format", "stream-json"]),
    { code: 0, out: "PF=0 TUI=0", err: "" },
  );
});

test("Android catalog repair relocates legacy Claude Termux paths in an existing package", async () => {
  const home = await tempHome();
  const prefix = path.join(home, "usr");
  const packageRoot = path.join(
    agentCliInstallRoot(home), "packages", "claude", "node_modules", "@bash0816", "claude-code",
  );
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await mkdir(path.join(packageRoot, "lib"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@bash0816/claude-code",
    version: "2.1.237",
    bin: { claude: "bin/claude" },
  }));
  await writeFile(path.join(packageRoot, "bin", "claude"), "#!/system/bin/sh\\nexit 0\\n", { mode: 0o755 });
  await writeFile(path.join(packageRoot, "lib", "termux-run-claude-native.sh"),
    "#!/system/bin/sh\\nTERMUX_TMPDIR=\\\"${TMPDIR:-/data/data/com.termux/files/usr/tmp}\\\"\\n",
  );
  await writeFile(path.join(packageRoot, "lib", "preinstall.js"),
    "const legacyPrefix = '/data/data/com.termux/files/usr';\\n",
  );
  await writeFile(path.join(agentCliInstallRoot(home), "agent-cli-state.json"), JSON.stringify({
    claude: {
      installed: true,
      version: "2.1.237",
      package: "@bash0816/claude-code@2.1.237",
      entryPath: path.join(packageRoot, "bin", "claude"),
      launcher: path.join(agentCliInstallRoot(home), "packages", "claude", "paseo-cli"),
      command: [path.join(agentCliInstallRoot(home), "packages", "claude", "paseo-cli")],
      state: "installed",
    },
  }));

  await listAgentCliCatalog({ paseoHome: home, platform: "android", cliSourceRoot: prefix });

  const runner = await readFile(path.join(packageRoot, "lib", "termux-run-claude-native.sh"), "utf8");
  assert.equal(runner.includes("/data/data/com.termux"), false);
  assert.equal(runner.includes(prefix), true);
  const launcher = await readFile(path.join(agentCliInstallRoot(home), "packages", "claude", "paseo-cli"), "utf8");
  assert.match(launcher, /export CLAUDE_TERMUX_STDIN='inherit'/u);
  const preinstall = await readFile(path.join(packageRoot, "lib", "preinstall.js"), "utf8");
  assert.equal(preinstall.includes("/data/data/com.termux"), false);
  assert.equal(preinstall.includes(prefix), true);
});

test("Android catalog repair adds stream-json keep-alive to an already-installed Claude wrapper", async () => {
  const home = await tempHome();
  const prefix = path.join(home, "usr");
  const packageRoot = path.join(
    agentCliInstallRoot(home), "packages", "claude", "node_modules", "@bash0816", "claude-code",
  );
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await mkdir(path.join(packageRoot, "lib"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@bash0816/claude-code",
    version: "2.1.237",
    bin: { claude: "bin/claude" },
  }));
  await writeFile(path.join(packageRoot, "bin", "claude"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
  const wrapper = path.join(packageRoot, "lib", "termux-run-claude-native.sh");
  await writeFile(wrapper, CLAUDE_MODE_DETECTION_FIXTURE);
  await writeFile(path.join(agentCliInstallRoot(home), "agent-cli-state.json"), JSON.stringify({
    claude: {
      installed: true,
      version: "2.1.237",
      package: "@bash0816/claude-code@2.1.237",
      entryPath: path.join(packageRoot, "bin", "claude"),
      launcher: path.join(agentCliInstallRoot(home), "packages", "claude", "paseo-cli"),
      command: [path.join(agentCliInstallRoot(home), "packages", "claude", "paseo-cli")],
      state: "installed",
    },
  }));

  // Devices that already have the CLI installed never rerun the install path, so the repair pass
  // is the only thing that can reach their wrapper.
  await listAgentCliCatalog({ paseoHome: home, platform: "android", cliSourceRoot: prefix });
  assert.deepEqual(
    await runDetectedMode(wrapper, ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"]),
    { code: 0, out: "PF=0 TUI=1", err: "" },
  );

  // Repair runs on every catalog listing, so it has to be idempotent.
  await listAgentCliCatalog({ paseoHome: home, platform: "android", cliSourceRoot: prefix });
  const patched = await readFile(wrapper, "utf8");
  assert.equal(patched.split("# paseo: keep-alive for stream-json stdin").length - 1, 1);
  assert.deepEqual(await runDetectedMode(wrapper, ["--model", "sonnet"]), { code: 0, out: "PF=0 TUI=0", err: "" });
});

test("Android command repair removes stale shims whose private runtime tool is missing", async () => {
  const home = await tempHome();
  const prefix = path.join(home, "usr");
  const prefixBin = path.join(prefix, "bin");
  const agentsBin = path.join(agentCliInstallRoot(home), "bin");
  await mkdir(prefixBin, { recursive: true });
  await mkdir(agentsBin, { recursive: true });
  for (const command of ["node", "curl", "bash", "mktemp"]) {
    await writeFile(path.join(prefixBin, command), "native-placeholder\n", { mode: 0o755 });
  }
  await writeFile(path.join(agentsBin, "git"), "#!/system/bin/sh\nexec '/missing/git' \"$@\"\n", { mode: 0o755 });
  const runtime = {
    paseoHome: home,
    platform: "android",
    cliSourceRoot: prefix,
    nodeExecutable: path.join(prefixBin, "node"),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "@bash0816", "claude-code");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@bash0816/claude-code",
        version: "2.1.237",
        bin: { claude: "bin/claude" },
      }));
      await writeFile(path.join(packageRoot, "bin", "claude"), "#!/system/bin/sh\nexit 0\n", { mode: 0o755 });
    },
  };

  await installAgentCli(runtime, "claude");

  await assert.rejects(() => stat(path.join(agentsBin, "git")));
});

test("Android package launchers keep HOME at the Paseo user home beside .paseo", async () => {
  const userHome = await tempHome();
  const paseoHome = path.join(userHome, ".paseo");
  const prefix = path.join(userHome, "usr");
  const prefixBin = path.join(prefix, "bin");
  await mkdir(prefixBin, { recursive: true });
  for (const command of ["node", "curl", "bash", "mktemp"]) {
    await writeFile(path.join(prefixBin, command), "native-placeholder\n", { mode: 0o755 });
  }
  const runtime = {
    paseoHome,
    platform: "android",
    cliSourceRoot: prefix,
    nodeExecutable: path.join(prefixBin, "node"),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "@bash0816", "claude-code");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@bash0816/claude-code",
        version: "2.1.237",
        bin: { claude: "bin/claude" },
      }));
      await writeFile(path.join(packageRoot, "bin", "claude"), "#!/system/bin/sh\nexit 0\n", { mode: 0o755 });
    },
  };

  const installed = await installAgentCli(runtime, "claude");
  const launcher = await readFile(installed.command[0], "utf8");

  assert.match(launcher, new RegExp(`export HOME='${userHome.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}'`, "u"));
  assert.doesNotMatch(launcher, /export HOME='[^']*\.paseo-app'/u);
  assert.match(launcher, new RegExp(`export PREFIX='${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}'`, "u"));
});

test("native OpenCode ELF bins execute directly while JavaScript npm bins use Node", async () => {
  const home = await tempHome();
  const runtime = {
    paseoHome: home,
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", options.packageSpec.startsWith("opencode") ? "opencode-ai" : "javascript-agent");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      const native = packageRoot.endsWith("opencode-ai");
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: native ? "opencode-ai" : "javascript-agent",
        version: "1.0.0",
        bin: { agent: native ? "bin/agent.exe" : "bin/agent.js" },
      }));
      await writeFile(path.join(packageRoot, "bin", native ? "agent.exe" : "agent.js"), native
        ? Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])
        : "#!/usr/bin/env node\n");
    },
  };
  await addAgentCli(runtime, {
    providerId: "native-opencode",
    label: "Native OpenCode",
    extends: "opencode",
    source: { type: "npm", package: "opencode-ai@1.0.0", bin: "agent" },
  });
  await addAgentCli(runtime, {
    providerId: "javascript-agent",
    label: "JavaScript Agent",
    extends: "acp",
    source: { type: "npm", package: "javascript-agent@1.0.0", bin: "agent" },
  });
  const native = await installAgentCli(runtime, "native-opencode");
  const javascript = await installAgentCli(runtime, "javascript-agent");
  assert.match(native.command[0], /native-opencode[\\/]paseo-cli$/u);
  assert.notEqual(native.command[0], process.execPath);
  assert.match(await readFile(native.command[0], "utf8"), /agent\.exe/u);
  assert.match(javascript.command[0], /javascript-agent[\\/]paseo-cli$/u);
  assert.match(await readFile(javascript.command[0], "utf8"), /agent\.js/u);
  assert.match(await readFile(javascript.command[0], "utf8"), new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("shell npm bins execute through sh instead of Node", async () => {
  const home = await tempHome();
  const runtime = {
    paseoHome: home,
    platform: "android",
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "shell-agent");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "shell-agent",
        version: "1.0.0",
        bin: { agent: "bin/agent" },
      }));
      await writeFile(path.join(packageRoot, "bin", "agent"), "#!/system/bin/sh\nexec echo shell-ok\n");
    },
  };

  await addAgentCli(runtime, {
    providerId: "shell-agent",
    label: "Shell Agent",
    extends: "acp",
    source: { type: "npm", package: "shell-agent@1.0.0", bin: "agent" },
  });

  const installed = await installAgentCli(runtime, "shell-agent");
  const launcher = await readFile(installed.command[0], "utf8");
  assert.match(launcher, /\/system\/bin\/sh/u);
  assert.match(launcher, /exec ['"](?:\/system\/bin\/sh|\/bin\/sh)['"]/u);
  assert.doesNotMatch(launcher, /exec ['"][^'"]*node(?:\.exe)?['"]/iu);
  assert.match(launcher, /bin[\\/]agent/u);
});

test("Android npm shim invokes Corepack's npm entry instead of the Corepack CLI", async () => {
  const home = await tempHome();
  const prefix = path.join(home, "usr");
  const corepackDist = path.join(prefix, "lib", "node_modules", "corepack", "dist");
  await mkdir(corepackDist, { recursive: true });
  await writeFile(path.join(corepackDist, "corepack.js"), "#!/usr/bin/env node\n");
  await writeFile(path.join(corepackDist, "npm.js"), "#!/usr/bin/env node\n");
  const runtime = {
    paseoHome: home,
    platform: "android",
    cliSourceRoot: prefix,
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "shell-agent");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "shell-agent",
        version: "1.0.0",
        bin: { agent: "bin/agent" },
      }));
      await writeFile(path.join(packageRoot, "bin", "agent"), "#!/system/bin/sh\nexit 0\n");
    },
  };
  await addAgentCli(runtime, {
    providerId: "shell-agent",
    label: "Shell Agent",
    extends: "acp",
    source: { type: "npm", package: "shell-agent@1.0.0", bin: "agent" },
  });

  await installAgentCli(runtime, "shell-agent");

  const npmShim = await readFile(path.join(agentCliInstallRoot(home), "bin", "npm"), "utf8");
  assert.match(npmShim, /corepack[\\/]dist[\\/]npm\.js/u);
  assert.doesNotMatch(npmShim, /corepack[\\/]dist[\\/]corepack\.js/u);
});

test("Android rejects a Windows PE npm binary even when its filename ends in .exe", async () => {
  const home = await tempHome();
  const runtime = {
    paseoHome: home,
    platform: "android",
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "windows-agent");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "windows-agent",
        version: "1.0.0",
        bin: { agent: "bin/agent.exe" },
      }));
      await writeFile(path.join(packageRoot, "bin", "agent.exe"), Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
    },
  };

  await addAgentCli(runtime, {
    providerId: "windows-agent",
    label: "Windows Agent",
    extends: "acp",
    source: { type: "npm", package: "windows-agent@1.0.0", bin: "agent" },
  });

  await assert.rejects(
    () => installAgentCli(runtime, "windows-agent"),
    /Windows PE|Android.*native|unsupported.*binary/u,
  );
});

test("Android keeps non-entry package artifacts while installing the real JavaScript CLI", async () => {
  const home = await tempHome();
  const runtime = {
    paseoHome: home,
    platform: "android",
    async runAgentCliPackageInstall(options) {
      const packageRoot = path.join(options.destination, "node_modules", "tree-agent");
      await mkdir(path.join(packageRoot, "bin", "vendor"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "tree-agent",
        version: "1.0.0",
        bin: { agent: "bin/agent.js" },
      }));
      await writeFile(path.join(packageRoot, "bin", "agent.js"), "#!/usr/bin/env node\n");
      await writeFile(path.join(packageRoot, "bin", "vendor", "helper.exe"), Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
    },
  };
  await addAgentCli(runtime, {
    providerId: "tree-agent",
    label: "Tree Agent",
    extends: "acp",
    source: { type: "npm", package: "tree-agent@1.0.0", bin: "agent" },
  });
  const installed = await installAgentCli(runtime, "tree-agent");
  assert.equal(installed.installed, true);
  assert.equal((await stat(path.join(agentCliInstallRoot(home), "packages", "tree-agent", "node_modules", "tree-agent", "bin", "vendor", "helper.exe"))).isFile(), true);
});

test("Android rejects a legacy com.termux runtime prefix before installing", async () => {
  const home = await tempHome();
  await assert.rejects(
    () => installAgentCli({ paseoHome: home, platform: "android", cliSourceRoot: "/data/data/com.termux/files/usr" }, "pi"),
    /legacy com\.termux|runtime prefix/u,
  );
});

test("legacy native npm command stored as node plus exe is migrated when listed", async () => {
  const home = await tempHome();
  const packageRoot = path.join(agentCliInstallRoot(home), "packages", "legacy-native", "node_modules", "legacy-native", "bin");
  await mkdir(packageRoot, { recursive: true });
  const entryPath = path.join(packageRoot, "legacy.exe");
  await writeFile(entryPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), { mode: 0o755 });
  await writeFile(path.join(agentCliInstallRoot(home), "agent-cli-state.json"), JSON.stringify({
    "legacy-native": {
      installed: true,
      command: [process.execPath, entryPath],
      state: "installed",
    },
  }));
  await addAgentCli({ paseoHome: home }, {
    providerId: "legacy-native",
    label: "Legacy Native",
    extends: "acp",
    source: { type: "npm", package: "legacy-native@1.0.0", bin: "legacy" },
  });
  const catalog = await listAgentCliCatalog({ paseoHome: home, platform: "android" });
  const entry = catalog.find((candidate) => candidate.providerId === "legacy-native");
  assert.ok(entry.installed);
  assert.match(entry.command[0], /legacy-native[\\/]paseo-cli$/u);
  assert.notEqual(entry.command[0], process.execPath);
  assert.match(await readFile(entry.command[0], "utf8"), /paseo-entry/u);
  await assert.rejects(() => stat(entryPath));
});

test("installer rejects an explicit CLI home outside the App-private home", async () => {
  const home = await tempHome();
  await assert.rejects(
    () => listAgentCliCatalog({ paseoHome: path.join(home, ".paseo"), agentCliHome: path.join(home, "other-app") }),
    /App-private|private|一致/iu,
  );
});

test("installed state is not trusted after its wrapper is deleted", async () => {
  const home = await tempHome();
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-source-"));
  const source = path.join(sourceRoot, "bin", "paseo");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "#!/system/bin/sh\nexit 0\n", { mode: 0o755 });
  const runtime = { paseoHome: home, cliSourceRoot: sourceRoot, providerSnapshotManager: fakeProviderManager() };
  await installAgentCli(runtime, "paseo");
  await rm(path.join(agentCliInstallRoot(home), "bin", "paseo"));
  const paseo = (await listAgentCliCatalog(runtime)).find((entry) => entry.providerId === "paseo");
  assert.equal(paseo.installed, false);
});

test("management exposes Agent CLI catalog and install actions", async () => {
  const management = await source("patches/server/paseo-management.js");
  assert.match(management, /provider-cli-catalog/);
  assert.match(management, /provider-cli-install/);
});

test("daemon PATH includes only the App-private Agent CLI directory", async () => {
  const startup = await source("ZeroTermux-main/app/src/main/assets/paseo-runtime/start-paseo.sh");
  assert.match(startup, /AGENTS_BIN=.*agents\/bin/);
  assert.match(startup, /export PATH/);
  assert.match(startup, /PATH="\$AGENTS_BIN:\$PREFIX\/bin:\/system\/bin:\/system\/xbin"/);
  assert.doesNotMatch(startup, /PATH=.*\$\{PATH/);
});

test("package installs build PATH with the host delimiter and platform directories", () => {
  const prefix = path.resolve(os.tmpdir(), "paseo-prefix");
  const home = path.resolve(os.tmpdir(), "paseo-home");
  const desktop = packageManagerEnvironment({
    platform: process.platform,
    inheritedPath: path.join(prefix, "host-bin"),
  }, home, prefix);

  assert.equal(
    desktop.PATH,
    [path.join(prefix, "bin"), path.join(prefix, "host-bin")].join(path.delimiter),
  );
  assert.doesNotMatch(desktop.PATH, /\/system\/bin/u);

  const android = packageManagerEnvironment({
    platform: "android",
    pathDelimiter: ":",
    inheritedPath: "/ignored/untrusted/path",
    paseoHome: path.join(home, ".paseo"),
  }, path.join(home, ".paseo"), "/data/data/com.dshcli/files/usr");
  assert.equal(android.PATH, "/data/data/com.dshcli/files/usr/bin:/system/bin:/system/xbin");
  assert.equal(android.HOME, home);
  assert.equal(android.PREFIX, "/data/data/com.dshcli/files/usr");
  assert.equal(android.TERMUX_PREFIX, "/data/data/com.dshcli/files/usr");
  assert.equal(android.TERMUX_HOME, home);
  assert.equal(android.DPKG_ADMINDIR, "/data/data/com.dshcli/files/usr/var/lib/dpkg");
});

test("bundled Paseo CLI can be installed into the App-private directory", async () => {
  const home = await tempHome();
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-source-"));
  const source = path.join(sourceRoot, "bin", "paseo");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "#!/system/bin/sh\nexit 0\n", { mode: 0o755 });
  const runtime = {
    paseoHome: home,
    cliSourceRoot: sourceRoot,
    cliVersions: { paseo: "0.3.1" },
    providerSnapshotManager: fakeProviderManager(),
  };

  const installed = await installAgentCli(runtime, "paseo");
  const target = path.join(agentCliInstallRoot(home), "bin", "paseo");
  assert.equal(installed.version, "0.3.1");
  assert.equal((await stat(target)).isFile(), true);
  assert.equal((await readFile(target, "utf8")).includes("exit 0"), true);
});

test("bundled CLI update replaces the App-private wrapper and records the new version", async () => {
  const home = await tempHome();
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-source-"));
  const source = path.join(sourceRoot, "bin", "codex");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "#!/system/bin/sh\n# updated\nexit 0\n", { mode: 0o755 });
  const runtime = {
    paseoHome: home,
    cliSourceRoot: sourceRoot,
    cliVersions: { codex: "0.148.0" },
    providerSnapshotManager: fakeProviderManager(),
  };

  await installAgentCli(runtime, "codex");
  const updated = await updateAgentCli(runtime, "codex");
  const target = path.join(agentCliInstallRoot(home), "bin", "codex");
  assert.equal(updated.version, "0.148.0");
  assert.equal((await readFile(target, "utf8")).includes("updated"), true);
});

test("management exposes Agent CLI update action", async () => {
  const management = await source("patches/server/paseo-management.js");
  assert.match(management, /provider-cli-update/);
});

test("custom Agent CLI definitions persist, install, and become selectable providers", async () => {
  const home = await tempHome();
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-custom-cli-source-"));
  const source = path.join(sourceRoot, "opencode-custom");
  await writeFile(source, "#!/system/bin/sh\n# v1\nexit 0\n", { mode: 0o755 });
  const runtime = {
    paseoHome: home,
    cliSourceRoot: sourceRoot,
    providerSnapshotManager: fakeProviderManager(),
  };

  const added = await addAgentCli(runtime, {
    providerId: "my-opencode",
    label: "我的 OpenCode",
    extends: "opencode",
    args: ["acp"],
    source: { type: "path", path: source, version: "1.0.0" },
  });
  assert.equal(added.providerId, "my-opencode");
  assert.equal(added.installable, true);
  assert.equal(added.extends, "opencode");

  const installed = await installAgentCli(runtime, "my-opencode");
  assert.equal(installed.version, "1.0.0");
  assert.deepEqual(installed.command.slice(1), ["acp"]);
  const catalog = await listAgentCliCatalog(runtime);
  const custom = catalog.find((entry) => entry.providerId === "my-opencode");
  assert.ok(custom);
  assert.equal(custom.installed, true);
  assert.equal(custom.status, "custom");
});

test("custom Agent CLI update replaces the installed executable from its source", async () => {
  const home = await tempHome();
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-custom-cli-update-"));
  const source = path.join(sourceRoot, "pi-custom");
  await writeFile(source, "#!/system/bin/sh\n# v1\nexit 0\n", { mode: 0o755 });
  const runtime = {
    paseoHome: home,
    cliSourceRoot: sourceRoot,
    providerSnapshotManager: fakeProviderManager(),
  };
  await addAgentCli(runtime, {
    providerId: "my-pi",
    label: "我的 Pi",
    extends: "pi",
    source: { type: "path", path: source, version: "1.0.0", updateVersion: "2.0.0" },
  });
  await installAgentCli(runtime, "my-pi");
  await writeFile(source, "#!/system/bin/sh\n# v2\nexit 0\n", { mode: 0o755 });
  const updated = await updateAgentCli(runtime, "my-pi");
  const target = path.join(agentCliInstallRoot(home), "bin", "my-pi");
  assert.equal(updated.version, "2.0.0");
  assert.match(await readFile(target, "utf8"), /# v2/);
});

test("management exposes custom Agent CLI registration action", async () => {
  const management = await source("patches/server/paseo-management.js");
  assert.match(management, /provider-cli-add/);
  assert.match(management, /addAgentCli/);
  assert.match(management, /installAgentCli\(activeRuntime, added\.providerId, \{ force: true \}\)/u);
});

test("protected Paseo presets cannot be replaced by custom definitions", async () => {
  const home = await tempHome();
  for (const providerId of ["claude", "opencode", "pi"]) {
    await assert.rejects(
      () => addAgentCli({ paseoHome: home }, {
        providerId,
        label: providerId,
        extends: providerId,
        source: { type: "npm", package: `${providerId}-replacement@latest`, bin: providerId },
      }),
      /预配置|preset|内置|already exists/iu,
    );
  }
});

test("bundled Paseo and Codex Provider IDs cannot be replaced", async () => {
  const home = await tempHome();
  for (const providerId of ["paseo", "codex"]) {
    await assert.rejects(
      () => addAgentCli({ paseoHome: home }, {
        providerId,
        label: providerId,
        extends: providerId === "paseo" ? "acp" : "codex",
        source: { type: "npm", package: `${providerId}-replacement@latest`, bin: providerId },
      }),
      /bundled|内置|preset|预配置|already exists/i,
    );
  }
});

test("npm Agent CLIs install and update atomically with a resolved package bin", async () => {
  const home = await tempHome();
  const calls = [];
  const runtime = {
    paseoHome: home,
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      calls.push(options);
      const version = options.packageSpec.endsWith("@2.0.0") ? "2.0.0" : "1.0.0";
      const packageRoot = path.join(options.destination, "node_modules", "opencode-ai");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "opencode-ai",
        version,
        bin: { opencode: "bin/opencode.js" },
      }));
      await writeFile(
        path.join(packageRoot, "bin", "opencode.js"),
        `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
      );
    },
  };

  await addAgentCli(runtime, {
    providerId: "my-opencode-npm",
    label: "OpenCode",
    extends: "opencode",
    args: ["acp"],
    source: {
      type: "npm",
      package: "opencode-ai@1.0.0",
      updatePackage: "opencode-ai@2.0.0",
      bin: "opencode",
    },
  });

  const installed = await installAgentCli(runtime, "my-opencode-npm");
  assert.equal(installed.version, "1.0.0");
  assert.match(installed.command[0], /agents[\\/]packages[\\/]my-opencode-npm[\\/]paseo-cli$/u);
  assert.deepEqual(installed.command.slice(1), ["acp"]);
  assert.match(await readFile(installed.command[0], "utf8"), /opencode\.js/u);
  assert.equal(calls[0].packageSpec, "opencode-ai@1.0.0");
  assert.equal(calls[0].ignoreScripts, true);

  const updated = await updateAgentCli(runtime, "my-opencode-npm");
  assert.equal(updated.version, "2.0.0");
  assert.equal(calls[1].packageSpec, "opencode-ai@2.0.0");
  assert.match(await readFile(path.join(agentCliInstallRoot(home), "packages", "my-opencode-npm", "node_modules", "opencode-ai", "bin", "opencode.js"), "utf8"), /2\.0\.0/u);

  const catalog = await listAgentCliCatalog(runtime);
  const opencode = catalog.find((entry) => entry.providerId === "my-opencode-npm");
  assert.equal(opencode.installed, true);
  assert.deepEqual(opencode.command, updated.command);
});

test("forcing a custom npm install applies a replacement definition with the same id", async () => {
  const home = await tempHome();
  const calls = [];
  const runtime = {
    paseoHome: home,
    providerSnapshotManager: fakeProviderManager(),
    async runAgentCliPackageInstall(options) {
      calls.push(options.packageSpec);
      const version = options.packageSpec.endsWith("@2.0.0") ? "2.0.0" : "1.0.0";
      const packageRoot = path.join(options.destination, "node_modules", "replaceable-agent");
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "replaceable-agent",
        version,
        bin: { agent: "bin/agent.js" },
      }));
      await writeFile(path.join(packageRoot, "bin", "agent.js"), `console.log(${JSON.stringify(version)});\n`);
    },
  };

  await addAgentCli(runtime, {
    providerId: "replaceable-agent",
    label: "Replaceable Agent",
    extends: "acp",
    source: { type: "npm", package: "replaceable-agent@1.0.0", bin: "agent" },
  });
  await installAgentCli(runtime, "replaceable-agent");

  await addAgentCli(runtime, {
    providerId: "replaceable-agent",
    label: "Replaceable Agent",
    extends: "acp",
    source: { type: "npm", package: "replaceable-agent@2.0.0", bin: "agent" },
  });
  const reinstalled = await installAgentCli(runtime, "replaceable-agent", { force: true });

  assert.deepEqual(calls, ["replaceable-agent@1.0.0", "replaceable-agent@2.0.0"]);
  assert.equal(reinstalled.version, "2.0.0");
  assert.match(await readFile(path.join(agentCliInstallRoot(home), "packages", "replaceable-agent", "node_modules", "replaceable-agent", "bin", "agent.js"), "utf8"), /2\.0\.0/u);
});

test("state paths recorded under a previous home are re-rooted onto the current install root", () => {
  const deviceFiles = path.resolve(path.sep, "data", "data", "com.termux", "files");
  const oldRoot = path.join(deviceFiles, "paseo-home", ".paseo-app", "agents");
  const newRoot = path.join(deviceFiles, "home", ".paseo-app", "agents");
  const nodeCommand = path.join(deviceFiles, "usr", "bin", "node");
  const state = {
    pi: {
      installed: true,
      command: [path.join(oldRoot, "packages", "pi", "paseo-cli")],
      entryPath: path.join(oldRoot, "packages", "pi", "node_modules", ".bin", "pi"),
      launcher: path.join(oldRoot, "packages", "pi", "paseo-cli"),
      nodeCommand,
    },
  };

  const changed = rerootAgentStatePaths(state, newRoot);

  assert.equal(changed, true);
  assert.deepEqual(state.pi.command, [path.join(newRoot, "packages", "pi", "paseo-cli")]);
  assert.equal(state.pi.entryPath, path.join(newRoot, "packages", "pi", "node_modules", ".bin", "pi"));
  assert.equal(state.pi.launcher, path.join(newRoot, "packages", "pi", "paseo-cli"));
  // nodeCommand lives under $PREFIX, not $HOME, so the move never invalidated it.
  assert.equal(state.pi.nodeCommand, nodeCommand);
});

test("re-rooting leaves healthy state untouched and reports no change", () => {
  const root = path.resolve(path.sep, "srv", "home", ".paseo-app", "agents");
  const state = {
    pi: {
      installed: true,
      command: [path.join(root, "bin", "pi")],
      entryPath: path.join(root, "packages", "pi", "node_modules", ".bin", "pi"),
    },
  };
  const snapshot = structuredClone(state);

  assert.equal(rerootAgentStatePaths(state, root), false);
  assert.deepEqual(state, snapshot);
});

test("re-rooting only rewrites paths that carry an agents anchor", () => {
  const root = path.resolve(path.sep, "new", "agents");
  const state = {
    pi: {
      command: [path.join(path.sep, "usr", "local", "bin", "pi"), "--flag"],
      entryPath: 42,
    },
  };

  assert.equal(rerootAgentStatePaths(state, root), false);
  assert.deepEqual(state.pi.command, [path.join(path.sep, "usr", "local", "bin", "pi"), "--flag"]);
  assert.equal(state.pi.entryPath, 42);
});

test("an npm CLI installed under the previous home still reports installed after the home moved", async () => {
  const oldHome = await tempHome();
  const newHome = await tempHome();
  const oldRoot = agentCliInstallRoot(oldHome);
  const newRoot = agentCliInstallRoot(newHome);
  // The home migration moved the files but left the absolute paths inside the state file behind.
  const packageRoot = path.join(newRoot, "packages", "claude", "node_modules", "@bash0816", "claude-code");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@bash0816/claude-code",
    version: "2.1.237",
    bin: { claude: "bin/claude" },
  }));
  await writeFile(path.join(packageRoot, "bin", "claude"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
  const stalePackageRoot = path.join(oldRoot, "packages", "claude", "node_modules", "@bash0816", "claude-code");
  await writeFile(path.join(newRoot, "agent-cli-state.json"), JSON.stringify({
    claude: {
      installed: true,
      version: "2.1.237",
      package: "@bash0816/claude-code@2.1.237",
      entryPath: path.join(stalePackageRoot, "bin", "claude"),
      launcher: path.join(oldRoot, "packages", "claude", "paseo-cli"),
      command: [path.join(oldRoot, "packages", "claude", "paseo-cli")],
      state: "installed",
    },
  }));

  const catalog = await listAgentCliCatalog({ paseoHome: newHome, platform: "android", cliSourceRoot: path.join(newHome, "usr") });
  const claude = catalog.find((entry) => entry.providerId === "claude");

  assert.ok(claude);
  assert.equal(claude.installed, true, "a moved home must not present an installed CLI as missing");
  const persisted = JSON.parse(await readFile(path.join(newRoot, "agent-cli-state.json"), "utf8"));
  assert.equal(persisted.claude.entryPath.startsWith(newRoot), true);
  assert.equal(persisted.claude.launcher.startsWith(newRoot), true);
});
