import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EAC_VERSION,
  stageEacAndroidRuntime,
} from "../scripts/stage-eac-android-runtime.mjs";

const SIDECAR_FILES = ["server.js", "bridge.js", "phone-bridge.js", "rescue-integration.js"];
const DESKTOP_OVERLAYS = [
  "platform.js",
  "runtime-paths.js",
  "boot-server.js",
  "android-resolve-sync.mjs",
  "resolve-sync-plan.mjs",
  "android-fs-patch.mjs",
  "android-hardlink.mjs",
];
const ALLOWED_NATIVE_BINARY =
  "dsh-desktop/node_modules/node-pty/prebuilds/android-arm64/pty.node";

async function put(root, relative, contents = relative) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
}

async function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

async function assertMissing(target) {
  await assert.rejects(stat(target), { code: "ENOENT" });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-eac-stage-test-"));
  const sourceRoot = path.join(root, "eac-source");
  const desktop = path.join(sourceRoot, "dsh-desktop");
  const outputRoot = path.join(root, "output");
  const overlayRoot = path.join(root, "overlay");
  const androidNodeModules = path.join(root, "android-node-modules");
  const sharpWasmRoot = path.join(root, "sharp-wasm32");
  const emnapiRuntimeRoot = path.join(root, "emnapi-runtime");
  const tslibRoot = path.join(root, "tslib");

  for (const file of SIDECAR_FILES) await put(sourceRoot, `sidecar/${file}`, file);
  await put(desktop, "package.json", JSON.stringify({ name: "dsh-desktop", version: EAC_VERSION }));
  for (const file of DESKTOP_OVERLAYS) {
    await put(desktop, `lib/desktop/${file}`, `upstream:${file}`);
    await put(overlayRoot, file, `overlay:${file}`);
  }
  await put(desktop, "lib/desktop/ignored.ts");
  await put(desktop, "vendor/kernel/kernel.tgz");
  await put(desktop, "native/desktop-host.node");
  await put(desktop, "assets/source.map");

  await put(desktop, "node_modules/node-pty/package.json", JSON.stringify({ name: "node-pty" }));
  await put(desktop, "node_modules/node-pty/prebuilds/win32-x64/conpty.node");
  await put(desktop, "node_modules/node-pty/prebuilds/linux-x64/pty.node");
  await put(desktop, "node_modules/@koromix/koffi-win32-x64/koffi.node");
  await put(desktop, "node_modules/@koromix/koffi-linux-x64/koffi.node");
  await put(desktop, "node_modules/@img/sharp-win32-x64/sharp.node");
  await put(desktop, "node_modules/@img/sharp-linux-x64/sharp.node");
  await put(desktop, "node_modules/node-addon-require-builtin-win32-x64-msvc/addon.node");
  await put(desktop, "node_modules/@vscode/ripgrep-win32-x64/rg.exe");
  await put(desktop, "node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64-gnu/addon.node");
  for (const packageName of ["bare-fs", "bare-path", "bare-url"]) {
    await put(desktop, `node_modules/${packageName}/prebuilds/win32-x64/${packageName}.bare`);
  }
  await put(desktop, "node_modules/keep/index.js");
  await put(desktop, "node_modules/keep/debug.map");
  await put(desktop, "node_modules/keep/helper.dll");
  await put(desktop, "node_modules/keep/helper.pdb");
  await put(desktop, "node_modules/keep/helper.so");

  await put(overlayRoot, "koffi-android-arm64/package.json",
    JSON.stringify({ name: "@koromix/koffi-android-arm64", version: "3.1.5", main: "index.cjs" }));
  await put(overlayRoot, "koffi-android-arm64/index.cjs",
    "module.exports={__koffiAndroidPlaceholder:true};\n");
  await put(androidNodeModules, "node-pty/prebuilds/android-arm64/pty.node", "android pty");
  await put(sharpWasmRoot, "package.json",
    JSON.stringify({ name: "@img/sharp-wasm32", version: "0.35.3" }));
  await put(sharpWasmRoot, "lib/sharp-wasm32.node.js", "export const sharp = true;\n");
  await put(sharpWasmRoot, "lib/sharp-wasm32.node.wasm", "wasm sharp");
  await put(emnapiRuntimeRoot, "package.json",
    JSON.stringify({ name: "@emnapi/runtime", version: "1.11.3" }));
  await put(emnapiRuntimeRoot, "dist/index.js", "exports.ready=true;\n");
  await put(tslibRoot, "package.json", JSON.stringify({ name: "tslib", version: "2.8.1" }));
  await put(tslibRoot, "tslib.js", "exports.__awaiter=true;\n");

  return {
    root,
    sourceRoot,
    outputRoot,
    overlayRoot,
    androidNodeModules,
    sharpWasmRoot,
    emnapiRuntimeRoot,
    tslibRoot,
  };
}

function stageOptions(f) {
  return {
    sourceRoot: f.sourceRoot,
    outputRoot: f.outputRoot,
    overlayRoot: f.overlayRoot,
    androidNodeModules: f.androidNodeModules,
    sharpWasmRoot: f.sharpWasmRoot,
    emnapiRuntimeRoot: f.emnapiRuntimeRoot,
    tslibRoot: f.tslibRoot,
  };
}

test("stages the official EAC sibling layout with audited Android overlays", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  await stageEacAndroidRuntime(stageOptions(f));

  for (const file of SIDECAR_FILES) {
    assert.equal(await readFile(path.join(f.outputRoot, "sidecar", file), "utf8"), file);
  }
  for (const file of DESKTOP_OVERLAYS) {
    assert.equal(
      await readFile(path.join(f.outputRoot, "dsh-desktop", "lib", "desktop", file), "utf8"),
      `overlay:${file}`,
    );
  }
  assert.equal(await readFile(path.join(f.outputRoot, ALLOWED_NATIVE_BINARY), "utf8"), "android pty");
  assert.match(await readFile(path.join(
    f.outputRoot, "dsh-desktop", "node_modules", "@koromix", "koffi-android-arm64", "index.cjs"), "utf8"),
  /koffiAndroidPlaceholder/);
  assert.equal(await readFile(path.join(
    f.outputRoot, "dsh-desktop", "node_modules", "@img", "sharp-wasm32", "lib",
    "sharp-wasm32.node.wasm"), "utf8"), "wasm sharp");
  assert.equal(await readFile(path.join(
    f.outputRoot, "dsh-desktop", "node_modules", "@emnapi", "runtime", "dist", "index.js"), "utf8"),
  "exports.ready=true;\n");
  assert.equal(await readFile(path.join(
    f.outputRoot, "dsh-desktop", "node_modules", "tslib", "tslib.js"), "utf8"),
  "exports.__awaiter=true;\n");

  const packageVersions = [
    ["@koromix/koffi-android-arm64", "3.1.5"],
    ["@img/sharp-wasm32", "0.35.3"],
    ["@emnapi/runtime", "1.11.3"],
    ["tslib", "2.8.1"],
  ];
  for (const [packageName, version] of packageVersions) {
    const packagePath = packageName.startsWith("@") ? packageName.split("/") : [packageName];
    const metadata = JSON.parse(await readFile(path.join(
      f.outputRoot, "dsh-desktop", "node_modules", ...packagePath, "package.json"), "utf8"));
    assert.equal(metadata.version, version);
  }
});

test("removes desktop payloads and leaves only the Android node-pty native binary", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  await stageEacAndroidRuntime(stageOptions(f));

  const desktop = path.join(f.outputRoot, "dsh-desktop");
  await assertMissing(path.join(desktop, "vendor"));
  await assertMissing(path.join(desktop, "native"));
  for (const relative of [
    "node_modules/@koromix/koffi-win32-x64",
    "node_modules/@koromix/koffi-linux-x64",
    "node_modules/@img/sharp-win32-x64",
    "node_modules/@img/sharp-linux-x64",
    "node_modules/node-addon-require-builtin-win32-x64-msvc",
    "node_modules/@vscode/ripgrep-win32-x64",
    "node_modules/@deepseek-ai/node-addon-landlock-run-linux-x64-gnu",
    "node_modules/node-pty/prebuilds/win32-x64",
    "node_modules/node-pty/prebuilds/linux-x64",
    "node_modules/bare-fs/prebuilds",
    "node_modules/bare-path/prebuilds",
    "node_modules/bare-url/prebuilds",
  ]) await assertMissing(path.join(desktop, ...relative.split("/")));

  const files = await listFiles(f.outputRoot);
  assert.deepEqual(files.filter((file) => file.endsWith(".map")), []);
  assert.deepEqual(
    files.filter((file) => /\.(?:exe|dll|pdb|so|node|bare)$/i.test(file)),
    [ALLOWED_NATIVE_BINARY],
  );
});

test("rejects an EAC source from a different release", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await put(f.sourceRoot, "dsh-desktop/package.json",
    JSON.stringify({ name: "dsh-desktop", version: "5.3.0" }));

  await assert.rejects(stageEacAndroidRuntime(stageOptions(f)), /EAC 5\.3\.6/);
});

test("rejects an incomplete official sidecar payload", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(path.join(f.sourceRoot, "sidecar", "phone-bridge.js"));

  await assert.rejects(stageEacAndroidRuntime(stageOptions(f)), /phone-bridge\.js/);
});
