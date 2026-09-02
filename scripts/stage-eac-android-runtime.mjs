import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EAC_VERSION = "5.3.1";

const SIDECAR_FILES = ["server.js", "bridge.js", "phone-bridge.js", "rescue-integration.js"];
const DESKTOP_OVERLAYS = [
  "platform.js",
  "runtime-paths.js",
  "boot-server.js",
  "android-resolve-sync.mjs",
  // android-resolve-sync.mjs 相对导入它。漏了这个文件，node 会因 --import 的模块
  // 解析失败而直接启动不了，比不打补丁更糟。
  "resolve-sync-plan.mjs",
  // boot-server.js require 它。.cjs 而非 .js：本仓 package.json 是
  // "type": "module"，同名 .js 会被当成 ESM。
  "credentials-version.cjs",
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

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
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
