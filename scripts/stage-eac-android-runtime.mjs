import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const EAC_VERSION = "5.3.6";

const SIDECAR_FILES = ["server.js", "bridge.js", "phone-bridge.js", "rescue-integration.js"];
const DESKTOP_OVERLAYS = [
  "platform.js",
  "runtime-paths.js",
  "boot-server.js",
  "android-resolve-sync.mjs",
  // android-resolve-sync.mjs 相对导入它。漏了这个文件，node 会因 --import 的模块
  // 解析失败而直接启动不了，比不打补丁更糟。
  "resolve-sync-plan.mjs",
  // link() 在 Android 应用数据目录里被 SELinux 拒（EACCES），内核用它发布会话文件，
  // 每轮对话结束都写不下去。boot-server 以 --import 传入这个入口。
  "android-fs-patch.mjs",
  // android-fs-patch.mjs 相对导入它。漏了同样会让 node 因 --import 解析失败而起不来。
  "android-hardlink.mjs",
];
const PACKAGE_VERSIONS = new Map([
  ["@koromix/koffi-android-arm64", "3.1.5"],
  ["@img/sharp-wasm32", "0.35.3"],
  ["@emnapi/runtime", "1.11.3"],
  ["tslib", "2.8.1"],
]);
const ALLOWED_NATIVE_BINARY =
  "dsh-desktop/node_modules/node-pty/prebuilds/android-arm64/pty.node";
const FORBIDDEN_BINARY = /\.(?:exe|dll|pdb|node|bare)$|\.so(?:\.\d+)*$/i;
const RETIRED_BUILTIN_PLUGINS = [
  { id: "dsh-pet", name: "dsh-pet", directory: "dsh-pet" },
  { id: "dsh-pet-settings", name: "dsh-pet-settings", directory: "dsh-pet-settings" },
  { id: "dsh-whale-widget", name: "dsh-whale-widget", directory: "dsh-whale-widget" },
  { id: "float-window", name: "@deepseek-ai/dsh-float-window", directory: "dsh-float-window" },
  { id: "meow-smooth", name: "meow-smooth", directory: "dsh-meow-smooth" },
  { id: "skin-switch", name: "@deepseek-ai/dsh-skin-switch", directory: "dsh-skin-switch" },
  { id: "soul-md", name: "dsh-soul-md", directory: "dsh-soul-md" },
  { id: "viewport-lock", name: "dsh-viewport-lock", directory: "dsh-viewport-lock" },
  { id: "offpeak", name: "dsh-offpeak", directory: "dsh-offpeak" },
];

// Plugins injected from the desktop profile's node_modules into the Android
// payload. Each entry is copied wholesale (they are local builds not on npm)
// and registered in the COMPANION_PLUGINS array so companion-sync seeds them
// into the web-desktop profile on first launch.
// composer-dynamic-island is already in the EAC deb's assets/plugins; the
// other four come from the desktop profile.
const INJECTED_PLUGINS = [
  { id: "subagent-panel", name: "dsh-subagent-panel", directory: "dsh-subagent-panel", source: "dsh-subagent-panel" },
  { id: "dsh-custom-provider-reasoning", name: "dsh-custom-provider-reasoning", directory: "dsh-custom-provider-reasoning", source: "dsh-custom-provider-reasoning" },
  { id: "client-masquerade", name: "dsh-client-masquerade", directory: "dsh-client-masquerade", source: "dsh-client-masquerade" },
  { id: "session-id-footer", name: "dsh-session-id-footer", directory: "dsh-session-id-footer", source: "dsh-session-id-footer" },
];
// 本地插件的来源：默认取当前用户 web-desktop profile 的 node_modules，可用
// PASEO_PLUGIN_SOURCE_ROOT 覆盖。刻意不写死某台机器的绝对路径 —— 这个脚本会随
// 构建产物一起分发，写死用户名/盘符等于把本机信息带进 APK。
const INJECTED_PLUGIN_SOURCE_ROOT = process.env.PASEO_PLUGIN_SOURCE_ROOT?.trim() ||
  path.join(os.homedir(), ".dsh", "profiles", "web-desktop", "node_modules");

// EAC 把插件从 assets/plugins 拷进 profile 的 node_modules 时走的是
// lib/plugin-copy.js 里的白名单（TOP_FILES / TOP_DIRS）。本地插件带的入口和子目录
// 白名单不认识 —— dsh-client-masquerade 顶层就 require('./patches/patch-lib.js')，
// 结果桌面上跑得好好的插件到了设备上变成「Cannot find module」并拖垮整棵插件树。
// 这里按插件自己 package.json 声明的对外文件面（files / exports / main）放宽白名单，
// 再逐个校验相对 require 都落在拷贝清单里；漏文件在构建期就报错，而不是等设备起不来。
// 这份副本必须与 EAC plugin-copy.js 的 EXTRA_PACKAGE_FILES 保持一致（已含在其清单内，
// 重复添加只是无害）。
const EAC_EXTRA_PACKAGE_FILES = [
  "LICENSE", "LICENSE.md", "NOTICE", "NOTICE.md",
  "README.md", "README.zh.md", "README.zh-CN.md", "THIRD-PARTY-NOTICES.md",
];

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  if (relative === "") return true;
  // 跨盘符时 path.relative 会原样返回绝对路径（Windows: C: vs D:），
  // 它当然不以 ".." 开头，按前缀判断会把它误当成子路径。
  if (path.isAbsolute(relative)) return false;
  return !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

async function requireFile(file, label = file) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Missing ${label}: ${file}`);
    throw error;
  }
  if (!metadata.isFile()) throw new Error(`Expected a regular file for ${label}: ${file}`);
}

async function requireDirectory(directory, label = directory) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Missing ${label}: ${directory}`);
    throw error;
  }
  if (!metadata.isDirectory()) throw new Error(`Expected a directory for ${label}: ${directory}`);
}

async function packageVersion(packageRoot, packageName) {
  const metadataPath = path.join(packageRoot, "package.json");
  await requireFile(metadataPath, `${packageName} package.json`);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${packageName} package.json: ${error.message}`);
  }
  return metadata.version;
}

async function requirePackageVersion(packageRoot, packageName, expectedVersion) {
  const actualVersion = await packageVersion(packageRoot, packageName);
  if (actualVersion !== expectedVersion) {
    throw new Error(`Expected ${packageName} ${expectedVersion}, found ${actualVersion ?? "unknown"}`);
  }
}

async function replaceTree(source, destination) {
  await requireDirectory(source);
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function removeMatchingDirectories(parent, predicate) {
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && predicate(entry.name)) {
      await rm(path.join(parent, entry.name), { recursive: true, force: true });
    }
  }
}

async function retireVisualPlugins(outputDesktop, pluginSourceRoot) {
  const pluginRoot = path.join(outputDesktop, "assets", "plugins");
  for (const plugin of RETIRED_BUILTIN_PLUGINS) {
    await rm(path.join(pluginRoot, plugin.directory), { recursive: true, force: true });
  }
  await rm(path.join(outputDesktop, "assets", "skins", "whale-song"), {
    recursive: true,
    force: true,
  });

  // Inject the local plugins from the desktop profile. They must be copied
  // BEFORE the registry patch below so that the freshly built payload carries
  // both the code and its registration row.
  for (const plugin of INJECTED_PLUGINS) {
    const sourceDir = path.join(pluginSourceRoot, plugin.source);
    await requireDirectory(sourceDir, `injected plugin ${plugin.name}`);
    const packageJson = JSON.parse(await readFile(path.join(sourceDir, "package.json"), "utf8"));
    if (packageJson.name !== plugin.name) {
      throw new Error(`Injected plugin directory/name mismatch: ${sourceDir} has ${packageJson.name}, expected ${plugin.name}`);
    }
    await rm(path.join(pluginRoot, plugin.directory), { recursive: true, force: true });
    await cp(sourceDir, path.join(pluginRoot, plugin.directory), { recursive: true, force: true });
  }

  const registryPath = path.join(outputDesktop, "lib", "desktop", "companion-sync.js");
  const registry = await readFile(registryPath, "utf8");
  const companionStart = registry.indexOf("exports.COMPANION_PLUGINS = [");
  const companionEnd = registry.indexOf("\n];", companionStart);
  const retiredStart = registry.indexOf("exports.RETIRED_BUILTIN_PLUGINS = [");
  const retiredEnd = registry.indexOf("\n];", retiredStart);
  if (companionStart < 0 || companionEnd < 0 || retiredStart < 0 || retiredEnd < 0) {
    throw new Error("EAC companion-sync.js has an unexpected plugin registry shape");
  }

  let updated = registry;
  const companionSection = registry.slice(companionStart, companionEnd);
  for (const plugin of RETIRED_BUILTIN_PLUGINS) {
    const escapedId = plugin.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entry = new RegExp(`^[ \\t]*\\{ id: ['\"]${escapedId}['\"][^\\n]*\\},?\\r?\\n?`, "mu");
    if (!entry.test(companionSection)) {
      throw new Error(`EAC companion registry is missing retired plugin: ${plugin.id}`);
    }
    updated = updated.replace(entry, "");
  }

  // Register the injected plugins: companion-sync copies each entry from
  // assets/plugins into the profile's node_modules on first launch and seeds
  // the bundle/patch rows. The injection point is just before the closing
  // bracket of COMPANION_PLUGINS.
  const injectRows = INJECTED_PLUGINS.map((plugin) =>
    `    { id: '${plugin.id}', name: '${plugin.name}', dir: '${plugin.directory}' },`);
  const companionCloseIndex = updated.indexOf("\n];", companionStart);
  if (companionCloseIndex < 0) {
    throw new Error("EAC companion registry lost its closing bracket while injecting plugins");
  }
  updated = updated.slice(0, companionCloseIndex) + "\n" + injectRows.join("\n") +
    updated.slice(companionCloseIndex);

  const refreshedRetiredStart = updated.indexOf("exports.RETIRED_BUILTIN_PLUGINS = [");
  const refreshedRetiredEnd = updated.indexOf("\n];", refreshedRetiredStart);
  if (refreshedRetiredStart < 0 || refreshedRetiredEnd < 0) {
    throw new Error("EAC retired plugin registry was lost while pruning");
  }
  const retiredSection = updated.slice(refreshedRetiredStart, refreshedRetiredEnd);
  const missingRetired = RETIRED_BUILTIN_PLUGINS.filter((plugin) =>
    !new RegExp(`id: ['\"]${plugin.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['\"]`).test(retiredSection));
  if (missingRetired.length) {
    const additions = missingRetired
      .map((plugin) => `    { id: '${plugin.id}', name: '${plugin.name}' },`)
      .join("\n");
    updated = updated.slice(0, refreshedRetiredEnd) + `\n${additions}` + updated.slice(refreshedRetiredEnd);
  }
  const dependencyGuard = "if (pkg.dependencies && pkg.dependencies[p.name]) {";
  const dependencyDelete = "delete pkg.dependencies[p.name];";
  if (updated.split(dependencyGuard).length !== 2 || updated.split(dependencyDelete).length !== 2) {
    throw new Error("EAC retired profile dependency cleanup has an unexpected shape");
  }
  updated = updated.replace(dependencyGuard, [
    "const bundles = pkg.dsh?.profile?.bundles;",
    "            const keptBundles = Array.isArray(bundles) ? bundles.filter(name => name !== p.name) : bundles;",
    "            const removedBundle = Array.isArray(bundles) && keptBundles.length !== bundles.length;",
    "            if (removedBundle) pkg.dsh.profile.bundles = keptBundles;",
    "            if (removedBundle || (pkg.dependencies && pkg.dependencies[p.name])) {",
  ].join("\n"));
  updated = updated.replace(dependencyDelete, "if (pkg.dependencies) delete pkg.dependencies[p.name];");
  await writeFile(registryPath, updated);
}

/** 插件对外声明的文件面：files / exports / main / dsh.bundle.patch。 */
async function pluginPublishEntries(sourceDir) {
  const manifest = JSON.parse(await readFile(path.join(sourceDir, "package.json"), "utf8"));
  const entries = new Set();
  const add = (value) => {
    if (typeof value !== "string") return;
    const cleaned = value.trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (!cleaned || cleaned.includes("*") || path.isAbsolute(cleaned)) return;
    entries.add(cleaned);
  };
  for (const value of Array.isArray(manifest.files) ? manifest.files : []) add(value);
  const collectExports = (value) => {
    if (typeof value === "string") add(value);
    else if (value && typeof value === "object") for (const nested of Object.values(value)) collectExports(nested);
  };
  collectExports(manifest.exports);
  add(manifest.main);
  if (manifest.dsh && manifest.dsh.bundle) add(manifest.dsh.bundle.patch);
  return [...entries];
}

/** 定位 EAC plugin-copy.js 里的拷贝清单数组（返回闭合括号偏移与已有成员）。 */
function pluginCopyArray(source, name) {
  const marker = `const ${name} = [`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  // 按括号配对找闭合位置，而不是找第一个 "];" —— 上游若把清单写成
  // `[...].concat(...)`，第一个 "];" 会落在下一个数组的结尾，插入点就跑偏了。
  let depth = 0;
  let quote = null;
  let index = start + marker.length - 1;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "[") depth += 1;
    else if (character === "]" && --depth === 0) break;
  }
  if (depth !== 0) return null;
  const body = source.slice(start, index);
  const members = new Set([...body.matchAll(/['"]([^'"]+)['"]/gu)].map((match) => match[1]));
  return { end: index, members };
}

/**
 * 把注入插件声明的文件面并进 EAC 的拷贝白名单。
 * 白名单是文本补丁：数组结尾可能是 `'styles']` 也可能是空数组，插入时补逗号。
 */
async function widenPluginCopySet(outputDesktop) {
  const copyPath = path.join(outputDesktop, "lib", "plugin-copy.js");
  let source = await readFile(copyPath, "utf8");
  const wanted = { TOP_FILES: new Set(EAC_EXTRA_PACKAGE_FILES), TOP_DIRS: new Set() };
  for (const plugin of INJECTED_PLUGINS) {
    const sourceDir = path.join(outputDesktop, "assets", "plugins", plugin.directory);
    for (const entry of await pluginPublishEntries(sourceDir)) {
      let metadata;
      try {
        metadata = await lstat(path.join(sourceDir, ...entry.split("/")));
      } catch {
        continue;
      }
      if (metadata.isDirectory()) wanted.TOP_DIRS.add(entry);
      else if (metadata.isFile()) wanted.TOP_FILES.add(entry);
    }
  }
  for (const name of ["TOP_FILES", "TOP_DIRS"]) {
    const literal = pluginCopyArray(source, name);
    if (!literal) throw new Error(`EAC plugin-copy.js has no ${name} list to widen`);
    const missing = [...wanted[name]].filter((entry) => !literal.members.has(entry)).sort();
    if (!missing.length) continue;
    const head = source.slice(0, literal.end).replace(/\s+$/u, "");
    const separator = head.endsWith(",") || head.endsWith("[") ? "" : ",";
    const insertion = `${separator} ${missing.map((entry) => `'${entry}'`).join(", ")},`;
    source = head + insertion + source.slice(literal.end);
  }
  await writeFile(copyPath, source);
}

/**
 * 用打过补丁的 EAC 拷贝清单核对：注入插件里每个相对 require/import 的目标
 * 都必须真的会被拷进 profile。这条校验就是本次「设备上 Cannot find module
 * './patches/patch-lib.js'、整棵插件树加载失败」的回归闸门。
 */
async function validateInjectedPluginCopySet(outputDesktop) {
  const copyLib = createRequire(import.meta.url)(path.join(outputDesktop, "lib", "plugin-copy.js"));
  if (typeof copyLib.pluginCopyEntries !== "function") {
    throw new Error("EAC plugin-copy.js no longer exports pluginCopyEntries");
  }
  const problems = [];
  for (const plugin of INJECTED_PLUGINS) {
    const sourceDir = path.join(outputDesktop, "assets", "plugins", plugin.directory);
    const copied = new Set(copyLib.pluginCopyEntries(sourceDir));
    const resolveCopied = (specifier, from) => {
      const base = path.posix.join(path.posix.dirname(from), specifier);
      return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
        `${base}/index.js`, `${base}/index.mjs`, `${base}/index.cjs`]
        .find((candidate) => copied.has(candidate));
    };
    for (const relative of [...copied].sort()) {
      if (!/\.(?:js|mjs|cjs)$/u.test(relative)) continue;
      const text = await readFile(path.join(sourceDir, ...relative.split("/")), "utf8");
      const specifiers = [
        ...text.matchAll(/\brequire\(\s*['"](\.[^'"]*)['"]\s*\)/gu),
        ...text.matchAll(/\bimport\(\s*['"](\.[^'"]*)['"]\s*\)/gu),
        ...text.matchAll(/\bfrom\s+['"](\.[^'"]*)['"]/gu),
      ];
      for (const match of specifiers) {
        if (resolveCopied(match[1], relative)) continue;
        problems.push(`${plugin.name}: ${relative} loads ${match[1]} that the EAC plugin copy list drops`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`Injected plugins would lose files they load at runtime:\n  ${problems.join("\n  ")}`);
  }
}

async function pruneFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const normalized = childRelative.split(path.sep).join("/");
    const child = path.join(root, childRelative);
    if (entry.isDirectory()) {
      await pruneFiles(root, childRelative);
      continue;
    }
    if (entry.name.toLowerCase().endsWith(".map") ||
        (FORBIDDEN_BINARY.test(entry.name) && normalized !== ALLOWED_NATIVE_BINARY)) {
      await rm(child, { force: true });
    }
  }
}

async function listNativeBinaries(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listNativeBinaries(root, childRelative));
    else if (FORBIDDEN_BINARY.test(entry.name)) files.push(childRelative.split(path.sep).join("/"));
  }
  return files.sort();
}

function packageTarget(nodeModules, packageName) {
  return path.join(nodeModules, ...packageName.split("/"));
}

async function validateInputs(options) {
  const resolved = {};
  for (const name of [
    "sourceRoot",
    "outputRoot",
    "overlayRoot",
    "androidNodeModules",
    "sharpWasmRoot",
    "emnapiRuntimeRoot",
    "tslibRoot",
  ]) {
    if (typeof options?.[name] !== "string" || options[name].trim() === "") {
      throw new Error(`stageEacAndroidRuntime requires ${name}`);
    }
    resolved[name] = path.resolve(options[name]);
  }
  if (resolved.outputRoot === path.parse(resolved.outputRoot).root) {
    throw new Error(`Refusing to stage EAC at a filesystem root: ${resolved.outputRoot}`);
  }
  // 默认取本机 web-desktop profile 的 node_modules（用户装的插件就是这个版本）；
  // 测试用 fixture 覆盖它，避免依赖某台机器的桌面环境。
  resolved.pluginSourceRoot = typeof options?.pluginSourceRoot === "string" && options.pluginSourceRoot.trim() !== ""
    ? path.resolve(options.pluginSourceRoot)
    : INJECTED_PLUGIN_SOURCE_ROOT;
  if (inside(resolved.outputRoot, resolved.pluginSourceRoot)) {
    throw new Error(`Injected plugin source must not live inside the EAC output: ${resolved.pluginSourceRoot}`);
  }
  for (const name of [
    "sourceRoot",
    "overlayRoot",
    "androidNodeModules",
    "sharpWasmRoot",
    "emnapiRuntimeRoot",
    "tslibRoot",
  ]) {
    if (inside(resolved[name], resolved.outputRoot)) {
      throw new Error(`EAC output must not be inside ${name}: ${resolved.outputRoot}`);
    }
  }

  const sourceDesktop = path.join(resolved.sourceRoot, "dsh-desktop");
  await requireDirectory(sourceDesktop, "EAC dsh-desktop");
  await requirePackageVersion(sourceDesktop, "EAC", EAC_VERSION);
  for (const file of SIDECAR_FILES) {
    await requireFile(path.join(resolved.sourceRoot, "sidecar", file), `EAC sidecar ${file}`);
  }
  for (const file of DESKTOP_OVERLAYS) {
    await requireFile(path.join(resolved.overlayRoot, file), `Android overlay ${file}`);
  }
  await requirePackageVersion(
    path.join(resolved.overlayRoot, "koffi-android-arm64"),
    "@koromix/koffi-android-arm64",
    PACKAGE_VERSIONS.get("@koromix/koffi-android-arm64"),
  );
  await requireFile(path.join(
    resolved.androidNodeModules, "node-pty", "prebuilds", "android-arm64", "pty.node"),
  "Android node-pty binary");
  await requirePackageVersion(resolved.sharpWasmRoot, "@img/sharp-wasm32",
    PACKAGE_VERSIONS.get("@img/sharp-wasm32"));
  await requirePackageVersion(resolved.emnapiRuntimeRoot, "@emnapi/runtime",
    PACKAGE_VERSIONS.get("@emnapi/runtime"));
  await requirePackageVersion(resolved.tslibRoot, "tslib", PACKAGE_VERSIONS.get("tslib"));
  await requireDirectory(resolved.pluginSourceRoot, "injected plugin source root");
  return resolved;
}

async function validateOutput(outputRoot) {
  for (const file of SIDECAR_FILES) {
    await requireFile(path.join(outputRoot, "sidecar", file), `staged sidecar ${file}`);
  }
  const desktop = path.join(outputRoot, "dsh-desktop");
  await requirePackageVersion(desktop, "EAC", EAC_VERSION);
  for (const file of DESKTOP_OVERLAYS) {
    await requireFile(path.join(desktop, "lib", "desktop", file), `staged overlay ${file}`);
  }
  // Every injected plugin must survive staging with its package.json intact.
  for (const plugin of INJECTED_PLUGINS) {
    const packageRoot = path.join(desktop, "assets", "plugins", plugin.directory);
    const version = await packageVersion(packageRoot, plugin.name);
    if (!version) throw new Error(`${plugin.name} has no version in its package.json`);
  }
  // composer-dynamic-island stays from the deb payload (it was un-retired).
  await requireFile(
    path.join(desktop, "assets", "plugins", "dsh-composer-dynamic-island", "package.json"),
    "composer-dynamic-island package.json");
  const nodeModules = path.join(desktop, "node_modules");
  for (const [packageName, version] of PACKAGE_VERSIONS) {
    await requirePackageVersion(packageTarget(nodeModules, packageName), packageName, version);
  }
  await requireFile(path.join(outputRoot, ...ALLOWED_NATIVE_BINARY.split("/")),
    "staged Android node-pty binary");
  const nativeBinaries = await listNativeBinaries(outputRoot);
  if (nativeBinaries.length !== 1 || nativeBinaries[0] !== ALLOWED_NATIVE_BINARY) {
    throw new Error(`Unexpected native binary in staged EAC payload: ${nativeBinaries.join(", ")}`);
  }
}

export async function stageEacAndroidRuntime(options) {
  const input = await validateInputs(options);
  const outputDesktop = path.join(input.outputRoot, "dsh-desktop");
  const outputNodeModules = path.join(outputDesktop, "node_modules");

  await rm(input.outputRoot, { recursive: true, force: true });
  await mkdir(path.join(input.outputRoot, "sidecar"), { recursive: true });
  for (const file of SIDECAR_FILES) {
    await cp(path.join(input.sourceRoot, "sidecar", file), path.join(input.outputRoot, "sidecar", file));
  }
  await cp(path.join(input.sourceRoot, "dsh-desktop"), outputDesktop, { recursive: true, force: true });

  for (const file of DESKTOP_OVERLAYS) {
    await cp(path.join(input.overlayRoot, file), path.join(outputDesktop, "lib", "desktop", file),
      { force: true });
  }
  await replaceTree(
    path.join(input.androidNodeModules, "node-pty", "prebuilds", "android-arm64"),
    path.join(outputNodeModules, "node-pty", "prebuilds", "android-arm64"),
  );
  for (const directory of await readdir(path.join(outputNodeModules, "node-pty", "prebuilds"),
    { withFileTypes: true })) {
    if (directory.isDirectory() && directory.name !== "android-arm64") {
      await rm(path.join(outputNodeModules, "node-pty", "prebuilds", directory.name),
        { recursive: true, force: true });
    }
  }
  await replaceTree(path.join(input.overlayRoot, "koffi-android-arm64"),
    packageTarget(outputNodeModules, "@koromix/koffi-android-arm64"));
  await replaceTree(input.sharpWasmRoot, packageTarget(outputNodeModules, "@img/sharp-wasm32"));
  await replaceTree(input.emnapiRuntimeRoot, packageTarget(outputNodeModules, "@emnapi/runtime"));
  await replaceTree(input.tslibRoot, packageTarget(outputNodeModules, "tslib"));

  await rm(path.join(outputDesktop, "vendor"), { recursive: true, force: true });
  await rm(path.join(outputDesktop, "native"), { recursive: true, force: true });
  await removeMatchingDirectories(path.join(outputNodeModules, "@koromix"),
    (name) => name.startsWith("koffi-") && name !== "koffi-android-arm64");
  await removeMatchingDirectories(path.join(outputNodeModules, "@img"),
    (name) => name.startsWith("sharp-") && name !== "sharp-wasm32");
  await removeMatchingDirectories(outputNodeModules,
    (name) => name.startsWith("node-addon-require-builtin-"));
  await removeMatchingDirectories(path.join(outputNodeModules, "@vscode"),
    (name) => name.startsWith("ripgrep-"));
  await removeMatchingDirectories(path.join(outputNodeModules, "@deepseek-ai"),
    (name) => name.startsWith("node-addon-landlock-run-"));
  for (const packageName of ["bare-fs", "bare-path", "bare-url"]) {
    await rm(path.join(outputNodeModules, packageName, "prebuilds"), { recursive: true, force: true });
  }
  await retireVisualPlugins(outputDesktop, input.pluginSourceRoot);
  await widenPluginCopySet(outputDesktop);
  await validateInjectedPluginCopySet(outputDesktop);
  await pruneFiles(input.outputRoot);
  await validateOutput(input.outputRoot);
}

function parseCli(argv) {
  const names = new Map([
    ["--source", "sourceRoot"],
    ["--output", "outputRoot"],
    ["--overlay", "overlayRoot"],
    ["--android-node-modules", "androidNodeModules"],
    ["--sharp-wasm", "sharpWasmRoot"],
    ["--emnapi-runtime", "emnapiRuntimeRoot"],
    ["--tslib", "tslibRoot"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || typeof value !== "string") throw new Error(`Invalid EAC staging argument: ${argv[index]}`);
    options[name] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  stageEacAndroidRuntime(parseCli(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
