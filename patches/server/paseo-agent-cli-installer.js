import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const STATE_FILE = "agent-cli-state.json";
const CUSTOM_CATALOG_FILE = "agent-cli-catalog.json";
const CUSTOM_ADAPTERS = new Set(["acp", "claude", "codex", "copilot", "opencode", "pi", "omp"]);
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_MANAGER_OUTPUT_BYTES = 1024 * 1024;
const PACKAGE_MANAGER_TIMEOUT_MS = 10 * 60 * 1000;
const PACKAGE_LAUNCHER_FILE = "paseo-cli";
const ANDROID_CLAUDE_PACKAGE = "@bash0816/claude-code@2.1.237";
const NPM_PACKAGE_SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[^\s/]+)?$/iu;
const NPM_BIN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const installLocks = new Map();

// Native Provider adapters are validated by Paseo itself. This catalog tracks
// the separate CLI payload state without replacing the native Provider registry.
const AGENT_CLI_CATALOG = Object.freeze([
    {
        providerId: "paseo",
        kind: "paseo",
        label: "Paseo CLI",
        version: "0.3.1",
        command: ["paseo"],
        status: "bundled",
        installable: true,
        updateable: true,
        source: "bundled",
        message: "Paseo CLI 已随 App 内置，可在 App 私有目录重装或更新。",
    },
    {
        providerId: "codex",
        kind: "provider",
        label: "Codex",
        version: "0.147.0",
        command: ["codex"],
        status: "bundled",
        installable: true,
        updateable: true,
        source: "bundled",
        message: "Paseo Codex 适配器已校验；CLI 已随 App 内置，可重装或更新。",
    },
    {
        providerId: "claude",
        kind: "preset",
        label: "Claude",
        extends: "claude",
        args: [],
        adapterStatus: "verified",
        status: "preset",
        installable: true,
        updateable: true,
        source: { type: "npm", package: "@anthropic-ai/claude-code@latest", updatePackage: "@anthropic-ai/claude-code@latest", bin: "claude", ignoreScripts: false },
        message: "Paseo 预配置版：安装官方 Claude CLI，并自动注册 Claude Provider。",
    },
    {
        providerId: "opencode",
        kind: "preset",
        label: "OpenCode",
        extends: "opencode",
        args: ["acp"],
        adapterStatus: "verified",
        status: "preset",
        installable: true,
        updateable: true,
        source: { type: "npm", package: "opencode-ai@latest", updatePackage: "opencode-ai@latest", bin: "opencode", ignoreScripts: false },
        message: "Paseo 预配置版：安装 OpenCode，并自动使用 ACP 参数注册 Provider。",
    },
    {
        providerId: "pi",
        kind: "preset",
        label: "Pi",
        extends: "pi",
        args: [],
        adapterStatus: "verified",
        status: "preset",
        installable: true,
        updateable: true,
        source: { type: "npm", package: "@earendil-works/pi-coding-agent@latest", updatePackage: "@earendil-works/pi-coding-agent@latest", bin: "pi", ignoreScripts: true },
        message: "Paseo 预配置版：安装 Pi Coding Agent，并自动注册 Pi Provider。",
    },
    {
        providerId: "omp",
        kind: "provider",
        label: "OMP",
        version: null,
        command: ["omp"],
        adapterStatus: "verified",
        status: "unsupported",
        installable: false,
        updateable: false,
        source: "external",
        message: "Paseo OMP 适配器已校验，但当前 App 没有经过校验的 Android arm64 CLI。",
    },
    {
        providerId: "copilot",
        kind: "provider",
        label: "Copilot",
        version: null,
        command: ["copilot"],
        adapterStatus: "verified",
        status: "unsupported",
        installable: false,
        updateable: false,
        source: "external",
        message: "Paseo Copilot 适配器已校验，但当前 App 没有经过校验的 Android arm64 CLI。",
    },
]);

function catalogEntryForRuntime(runtime, entry) {
    if ((runtime.platform ?? process.platform) !== "android") return entry;
    if (entry.providerId === "claude") {
        return {
            ...entry,
            source: {
                ...entry.source,
                package: ANDROID_CLAUDE_PACKAGE,
                updatePackage: ANDROID_CLAUDE_PACKAGE,
            },
            message: "Paseo 预配置版：Android/Termux 安装第三方适配的 Claude CLI，入口为 claude，不包含 Windows .exe；桌面平台仍使用官方包。",
        };
    }
    if (entry.providerId === "opencode") {
        return {
            ...entry,
            status: "unsupported",
            installable: false,
            updateable: false,
            message: "OpenCode 官方 npm 包不支持 Android；需要经过验证的 Android native/Termux 构建后才能安装。",
        };
    }
    return entry;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertProviderId(providerId) {
    if (typeof providerId !== "string" || !PROVIDER_ID_PATTERN.test(providerId)) {
        throw new Error("Invalid provider id");
    }
    return providerId;
}

function assertText(value, label, maximum = 8192) {
    if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/u.test(value)) {
        throw new Error(`${label} is invalid`);
    }
    return value.trim();
}

function normalizeArgs(args) {
    if (args === undefined) return [];
    if (!Array.isArray(args) || args.length > 32 || args.some((value) => typeof value !== "string" || !value.trim() || value.length > 8192 || /\0/u.test(value))) {
        throw new Error("Agent CLI arguments must be a string array");
    }
    return args.map((value) => value.trim());
}

function normalizeCustomSource(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new Error("Custom Agent CLI source is required");
    }
    const type = assertText(source.type, "Custom Agent CLI source type", 20).toLowerCase();
    if (type !== "path" && type !== "url" && type !== "npm") throw new Error("Custom Agent CLI source must be path, url, or npm");
    const normalized = { type };
    if (type === "path") {
        normalized.path = assertText(source.path, "Custom Agent CLI source path", 8192);
    }
    else if (type === "url") {
        const url = assertText(source.url, "Custom Agent CLI source URL", 8192);
        if (!/^https?:\/\//iu.test(url)) throw new Error("Custom Agent CLI source URL must use http or https");
        normalized.url = url;
        if (source.updateUrl !== undefined) {
            const updateUrl = assertText(source.updateUrl, "Custom Agent CLI update URL", 8192);
            if (!/^https?:\/\//iu.test(updateUrl)) throw new Error("Custom Agent CLI update URL must use http or https");
            normalized.updateUrl = updateUrl;
        }
        if (source.sha256 !== undefined) {
            const sha256 = assertText(source.sha256, "Custom Agent CLI SHA-256", 128).toLowerCase();
            if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Custom Agent CLI SHA-256 is invalid");
            normalized.sha256 = sha256;
        }
        if (source.updateSha256 !== undefined) {
            const updateSha256 = assertText(source.updateSha256, "Custom Agent CLI update SHA-256", 128).toLowerCase();
            if (!/^[a-f0-9]{64}$/u.test(updateSha256)) throw new Error("Custom Agent CLI update SHA-256 is invalid");
            normalized.updateSha256 = updateSha256;
        }
    }
    else {
        const packageSpec = assertText(source.package, "Custom Agent CLI npm package", 500);
        if (!NPM_PACKAGE_SPEC_PATTERN.test(packageSpec) || packageSpec.startsWith("-")) {
            throw new Error("Custom Agent CLI npm package is invalid");
        }
        normalized.package = packageSpec;
        if (source.updatePackage !== undefined) {
            const updatePackage = assertText(source.updatePackage, "Custom Agent CLI npm update package", 500);
            if (!NPM_PACKAGE_SPEC_PATTERN.test(updatePackage) || updatePackage.startsWith("-")) {
                throw new Error("Custom Agent CLI npm update package is invalid");
            }
            normalized.updatePackage = updatePackage;
        }
        if (source.bin !== undefined) {
            const bin = assertText(source.bin, "Custom Agent CLI npm binary", 200);
            if (!NPM_BIN_PATTERN.test(bin)) throw new Error("Custom Agent CLI npm binary is invalid");
            normalized.bin = bin;
        }
        if (source.registry !== undefined) {
            const registry = assertText(source.registry, "Custom Agent CLI npm registry", 8192);
            if (!/^https:\/\//iu.test(registry)) throw new Error("Custom Agent CLI npm registry must use https");
            normalized.registry = registry;
        }
        if (source.ignoreScripts !== undefined && typeof source.ignoreScripts !== "boolean") {
            throw new Error("Custom Agent CLI npm ignoreScripts must be boolean");
        }
        normalized.ignoreScripts = source.ignoreScripts !== false;
    }
    if (source.version !== undefined) normalized.version = assertText(source.version, "Custom Agent CLI version", 200);
    if (source.updateVersion !== undefined) normalized.updateVersion = assertText(source.updateVersion, "Custom Agent CLI update version", 200);
    return normalized;
}

function normalizeCustomEntry(definition) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
        throw new Error("Custom Agent CLI definition is required");
    }
    const providerId = assertProviderId(definition.providerId);
    const nativeEntry = AGENT_CLI_CATALOG.find((entry) => entry.providerId === providerId);
    if (nativeEntry?.source === "bundled" || nativeEntry?.kind === "preset") throw new Error(`Paseo preset Agent CLI cannot be replaced: ${providerId}`);
    const label = assertText(definition.label ?? nativeEntry?.label ?? providerId, "Custom Agent CLI label", 200);
    const adapter = assertText(definition.extends ?? nativeEntry?.providerId ?? "acp", "Custom Agent CLI adapter", 40).toLowerCase();
    if (!CUSTOM_ADAPTERS.has(adapter)) throw new Error(`Unsupported custom Agent CLI adapter: ${adapter}`);
    return {
        providerId,
        kind: "custom",
        label,
        extends: adapter,
        args: normalizeArgs(definition.args),
        source: normalizeCustomSource(definition.source),
        adapterStatus: "user-configured",
        status: "custom",
        installable: true,
        updateable: true,
        message: "用户添加的 CLI，安装文件和 Provider 配置均保存在 App 私有目录。",
    };
}

function normalizeHome(home) {
    if (typeof home !== "string" || !home.trim()) {
        throw new Error("Paseo home is required");
    }
    return path.resolve(home);
}

function runtimeAgentHome(runtime = {}) {
    const paseoHome = runtime.paseoHome ?? runtime.home;
    if (typeof paseoHome === "string" && paseoHome.trim()) {
        const normalized = normalizeHome(paseoHome);
        const expected = path.basename(normalized) === ".paseo"
            ? path.join(path.dirname(normalized), ".paseo-app")
            : normalized;
        const explicit = runtime.agentCliHome ?? runtime.appHome;
        if (typeof explicit === "string" && explicit.trim() && normalizeHome(explicit) !== expected) {
            throw new Error("Agent CLI home must stay inside the App-private home");
        }
        return expected;
    }
    const explicit = runtime.agentCliHome ?? runtime.appHome;
    if (typeof explicit === "string" && explicit.trim()) return normalizeHome(explicit);
    throw new Error("Paseo home is required");
}

function runtimeUserHome(runtime = {}) {
    const paseoHome = runtime.paseoHome ?? runtime.home;
    if (typeof paseoHome === "string" && paseoHome.trim()) {
        const normalized = normalizeHome(paseoHome);
        return path.basename(normalized) === ".paseo"
            ? path.dirname(normalized)
            : normalized;
    }
    return runtimeAgentHome(runtime);
}

function runtimePrefix(runtime = {}) {
    const candidate = path.resolve(runtime.cliSourceRoot ?? process.env.PREFIX ?? path.dirname(path.dirname(process.execPath)));
    if (/(?:^|[\\/])com\.termux(?:[\\/]|$)/iu.test(candidate)) {
        throw new Error("Android runtime prefix cannot point to legacy com.termux");
    }
    return candidate;
}

function isWithinRoot(candidate, root) {
    const normalizedCandidate = path.resolve(candidate);
    const normalizedRoot = path.resolve(root);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function isExecutableFile(stat, platform = process.platform) {
    return Boolean(stat?.isFile() && (platform === "win32" || process.platform === "win32" || (stat.mode & 0o111)));
}

function hasNativeExecutableHeader(bytes) {
    if (!bytes || bytes.length < 4) return false;
    // Android npm packages shipped by Claude/OpenCode use an ELF payload with
    // a `.exe` filename. Keep PE support for desktop installs as well.
    return (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) ||
        (bytes[0] === 0x4d && bytes[1] === 0x5a);
}

function hasWindowsPortableExecutableHeader(bytes) {
    return Boolean(bytes && bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a);
}

async function isWindowsPortableExecutableFile(filePath) {
    const bytes = await fs.readFile(filePath).catch(() => null);
    return hasWindowsPortableExecutableHeader(bytes);
}

async function isNativeExecutableFile(filePath, platform = process.platform) {
    const bytes = await fs.readFile(filePath).catch(() => null);
    return (platform !== "android" && hasWindowsPortableExecutableHeader(bytes)) ||
        Boolean(bytes && bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46);
}

export function agentCliInstallRoot(paseoHome) {
    return path.join(normalizeHome(paseoHome), "agents");
}

async function readState(paseoHome) {
    try {
        const raw = await fs.readFile(path.join(agentCliInstallRoot(paseoHome), STATE_FILE), "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}

async function writeState(paseoHome, state) {
    const root = agentCliInstallRoot(paseoHome);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = path.join(root, `.${STATE_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temporary, path.join(root, STATE_FILE));
    }
    finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
}

async function readCustomCatalog(paseoHome) {
    try {
        const raw = await fs.readFile(path.join(agentCliInstallRoot(paseoHome), CUSTOM_CATALOG_FILE), "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((entry) => normalizeStoredCustomEntry(entry)).filter(Boolean);
    }
    catch {
        return [];
    }
}

function normalizeStoredCustomEntry(entry) {
    try {
        if (!entry || typeof entry !== "object") return null;
        const providerId = assertProviderId(entry.providerId);
        const label = assertText(entry.label ?? providerId, "Custom Agent CLI label", 200);
        const adapter = assertText(entry.extends ?? "acp", "Custom Agent CLI adapter", 40).toLowerCase();
        if (!CUSTOM_ADAPTERS.has(adapter)) return null;
        return {
            providerId,
            kind: "custom",
            label,
            extends: adapter,
            args: normalizeArgs(entry.args),
            source: normalizeCustomSource(entry.source),
            adapterStatus: "user-configured",
            status: "custom",
            installable: true,
            updateable: true,
            message: "用户添加的 CLI，安装文件和 Provider 配置均保存在 App 私有目录。",
        };
    }
    catch {
        return null;
    }
}

async function writeCustomCatalog(paseoHome, catalog) {
    const root = agentCliInstallRoot(paseoHome);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = path.join(root, `.${CUSTOM_CATALOG_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temporary, path.join(root, CUSTOM_CATALOG_FILE));
    }
    finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
}

function cliSourcePath(runtime, entry) {
    const explicit = runtime.cliSources?.[entry.providerId];
    const root = runtime.cliSourceRoot ?? process.env.PREFIX;
    if (typeof root !== "string" || !root.trim()) return null;
    const rootPath = path.resolve(root);
    if (typeof explicit === "string" && explicit.trim()) {
        const explicitPath = path.resolve(explicit);
        if (!isWithinRoot(explicitPath, rootPath)) throw new Error("CLI source must stay inside the App-owned runtime prefix");
        return explicitPath;
    }
    return path.join(rootPath, "bin", entry.command[0]);
}

function customTargetPath(paseoHome, entry) {
    return path.join(agentCliInstallRoot(paseoHome), "bin", entry.providerId);
}

function customPackageRoot(paseoHome, entry) {
    return path.join(agentCliInstallRoot(paseoHome), "packages", entry.providerId);
}

function shellQuote(value) {
    return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function packageLauncherContents(entryPath, nodeCommand, runner, options = {}) {
    const platform = options.platform ?? process.platform;
    const shellCommand = options.shellCommand ?? (platform === "android" ? "/system/bin/sh" : "/bin/sh");
    const shebang = platform === "android" ? "/system/bin/sh" : "/bin/sh";
    const command = runner === "native"
        ? shellQuote(entryPath)
        : runner === "shell"
            ? `${shellQuote(shellCommand)} ${shellQuote(entryPath)}`
            : `${shellQuote(nodeCommand)} ${shellQuote(entryPath)}`;
    const pathPrefix = Array.isArray(options.pathPrefix) && options.pathPrefix.length > 0
        ? `export PATH=${shellQuote(options.pathPrefix.join(":"))}:"$PATH"\n`
        : "";
    const envLines = options.environment && typeof options.environment === "object"
        ? Object.entries(options.environment)
            .filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/u.test(key) && typeof value === "string")
            .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
            .join("")
        : "";
    return `#!${shebang}\n${pathPrefix}${envLines}exec ${command} "$@"\n`;
}

async function writePackageLauncher(launcherPath, entryPath, nodeCommand, runner, options = {}) {
    const contents = packageLauncherContents(entryPath, nodeCommand, runner, options);
    const current = await fs.readFile(launcherPath, "utf8").catch(() => null);
    if (current === contents) {
        await fs.chmod(launcherPath, 0o755).catch(() => undefined);
        return false;
    }
    await fs.mkdir(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
    const temporary = `${launcherPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o755, flag: "wx" });
        await fs.chmod(temporary, 0o755);
        await fs.rename(temporary, launcherPath);
        await fs.chmod(launcherPath, 0o755);
    }
    finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
    return true;
}

async function packageEntryRunner(entryPath, platform) {
    if (await isNativeExecutableFile(entryPath, platform)) return "native";
    let prefix = "";
    const handle = await fs.open(entryPath, "r").catch(() => null);
    if (handle) {
        try {
            const buffer = Buffer.alloc(256);
            const result = await handle.read(buffer, 0, buffer.length, 0);
            prefix = buffer.subarray(0, result.bytesRead).toString("utf8");
        }
        finally {
            await handle.close().catch(() => undefined);
        }
    }
    if (/^#![^\n]*\b(?:sh|bash|zsh|dash)(?:\s|$)/mu.test(prefix) || /^#!\s*\/usr\/bin\/env\s+(?:sh|bash|zsh|dash)(?:\s|$)/mu.test(prefix)) {
        return "shell";
    }
    return "node";
}

async function ensureAndroidNpmShim(runtime, paseoHome) {
    if ((runtime.platform ?? process.platform) !== "android") return null;
    const prefix = runtimePrefix(runtime);
    const corepackPath = path.resolve(runtime.corepackPath ?? path.join(prefix, "lib", "node_modules", "corepack", "dist", "corepack.js"));
    const npmCliPath = path.resolve(runtime.npmCliPath ?? path.join(path.dirname(corepackPath), "npm.js"));
    if (!(await fs.stat(npmCliPath).catch(() => null))?.isFile()) return null;
    const nodeCommand = path.resolve(runtime.nodeExecutable ?? process.execPath);
    const shimPath = path.join(agentCliInstallRoot(paseoHome), "bin", "npm");
    const contents = `#!/system/bin/sh\nexec ${shellQuote(nodeCommand)} ${shellQuote(npmCliPath)} "$@"\n`;
    await fs.mkdir(path.dirname(shimPath), { recursive: true, mode: 0o700 });
    const current = await fs.readFile(shimPath, "utf8").catch(() => null);
    if (current !== contents) await fs.writeFile(shimPath, contents, { encoding: "utf8", mode: 0o755 });
    await fs.chmod(shimPath, 0o755).catch(() => undefined);
    return shimPath;
}

async function ensureAndroidCommandShims(runtime, paseoHome) {
    if ((runtime.platform ?? process.platform) !== "android") return {};
    const prefix = runtimePrefix(runtime);
    const binRoot = path.join(agentCliInstallRoot(paseoHome), "bin");
    const targets = {
        sh: { command: "/system/bin/sh", args: [] },
        node: { command: path.resolve(runtime.nodeExecutable ?? process.execPath), args: [] },
        curl: { command: path.join(prefix, "bin", "curl"), args: [] },
        git: { command: path.join(prefix, "bin", "git"), args: [] },
        bash: { command: path.join(prefix, "bin", "bash"), args: [] },
        dirname: { command: "/system/bin/toybox", args: ["dirname"] },
        readlink: { command: "/system/bin/toybox", args: ["readlink"] },
        cat: { command: "/system/bin/toybox", args: ["cat"] },
        rm: { command: "/system/bin/toybox", args: ["rm"] },
        mkdir: { command: "/system/bin/toybox", args: ["mkdir"] },
        mktemp: { command: path.join(prefix, "bin", "mktemp"), args: [] },
        tar: { command: path.join(prefix, "bin", "tar"), args: [] },
        which: { command: "/system/bin/toybox", args: ["which"] },
        realpath: { command: path.join(prefix, "bin", "realpath"), args: [] },
        cp: { command: path.join(prefix, "bin", "cp"), args: [] },
        mv: { command: path.join(prefix, "bin", "mv"), args: [] },
        chmod: { command: path.join(prefix, "bin", "chmod"), args: [] },
        dpkg: { command: path.join(prefix, "bin", "dpkg"), args: [] },
        "dpkg-deb": { command: path.join(prefix, "bin", "dpkg-deb"), args: [] },
        apt: { command: path.join(prefix, "bin", "apt"), args: [] },
        "apt-get": { command: path.join(prefix, "bin", "apt-get"), args: [] },
        pkg: { command: path.join(prefix, "bin", "pkg"), args: [] },
    };
    const shims = {};
    await fs.mkdir(binRoot, { recursive: true, mode: 0o700 });
    for (const [name, target] of Object.entries(targets)) {
        const shimPath = path.join(binRoot, name);
        if (!target.command.startsWith("/system/") && !(await fs.stat(target.command).catch(() => null))?.isFile()) {
            await fs.rm(shimPath, { force: true }).catch(() => undefined);
            continue;
        }
        if (path.resolve(shimPath) === path.resolve(target.command)) continue;
        const contents = `#!/system/bin/sh\nexec ${shellQuote(target.command)}${target.args.map((arg) => ` ${shellQuote(arg)}`).join("")} "$@"\n`;
        const current = await fs.readFile(shimPath, "utf8").catch(() => null);
        if (current !== contents) await fs.writeFile(shimPath, contents, { encoding: "utf8", mode: 0o755 });
        await fs.chmod(shimPath, 0o755).catch(() => undefined);
        shims[name] = shimPath;
    }
    return shims;
}

async function normalizeAndroidPackageEntryPath(entryPath, platform) {
    if (platform !== "android" || path.extname(entryPath).toLowerCase() !== ".exe") return entryPath;
    if (await isWindowsPortableExecutableFile(entryPath)) {
        throw new Error("Android cannot execute a Windows PE npm binary");
    }
    const migratedPath = path.join(path.dirname(entryPath), "paseo-entry");
    const migratedStat = await fs.lstat(migratedPath).catch(() => null);
    if (migratedStat) {
        if (!migratedStat.isFile() || migratedStat.isSymbolicLink()) {
            throw new Error("Android npm CLI migration target is invalid");
        }
        await fs.rm(entryPath, { force: true });
        return migratedPath;
    }
    try {
        await fs.rename(entryPath, migratedPath);
    }
    catch (error) {
        const concurrentTarget = await fs.lstat(migratedPath).catch(() => null);
        if (!concurrentTarget?.isFile() || concurrentTarget.isSymbolicLink()) throw error;
        await fs.rm(entryPath, { force: true });
    }
    return migratedPath;
}

async function ensureNpmPackageLauncher(runtime, paseoHome, entry, stateEntry) {
    if (entry.source.type !== "npm" || !stateEntry?.installed) return false;
    const packageRoot = customPackageRoot(paseoHome, entry);
    const storedCommand = Array.isArray(stateEntry.command) ? stateEntry.command : [];
    const platform = runtime.platform ?? process.platform;
    const prefix = runtimePrefix(runtime);
    if (platform === "android" && entry.providerId === "claude") {
        await patchAndroidClaudePackage(packageRoot, platform, "@bash0816/claude-code", prefix);
    }
    const launcherPath = path.join(packageRoot, PACKAGE_LAUNCHER_FILE);
    const candidates = [];
    for (const value of [stateEntry.entryPath, storedCommand[0], storedCommand[1]]) {
        if (typeof value !== "string" || !value.trim()) continue;
        const candidate = path.resolve(value);
        if (!isWithinRoot(candidate, packageRoot) || candidate === path.resolve(launcherPath)) continue;
        candidates.push(candidate);
        if (platform === "android" && path.extname(candidate).toLowerCase() === ".exe") {
            candidates.push(path.join(path.dirname(candidate), "paseo-entry"));
        }
    }
    let entryCandidate = null;
    for (const candidate of candidates) {
        const candidateStat = await fs.stat(candidate).catch(() => null);
        if (candidateStat?.isFile()) {
            entryCandidate = candidate;
            break;
        }
    }
    if (!entryCandidate) return false;
    let entryPath = entryCandidate;
    // Android package extraction may drop execute bits from both JS and ELF
    // npm entry points. Repair the package file before rebuilding its wrapper.
    if (platform === "android" && await isWindowsPortableExecutableFile(entryPath)) {
        throw new Error("Android cannot execute a Windows PE npm binary");
    }
    entryPath = await normalizeAndroidPackageEntryPath(entryPath, platform);
    await fs.chmod(entryPath, 0o755).catch(() => undefined);
    const runner = await packageEntryRunner(entryPath, platform);
    const native = runner === "native";
    const storedNodeCommand = runner === "node" && storedCommand[0] && !isWithinRoot(path.resolve(storedCommand[0]), packageRoot)
        ? path.resolve(storedCommand[0])
        : null;
    const nodeCommand = path.resolve(runtime.nodeExecutable ?? stateEntry.nodeCommand ?? storedNodeCommand ?? process.execPath);
    const npmShim = await ensureAndroidNpmShim(runtime, paseoHome);
    const commandShims = await ensureAndroidCommandShims(runtime, paseoHome);
    const pathPrefix = platform === "android"
        ? [path.dirname(npmShim ?? commandShims.node ?? launcherPath), path.join(prefix, "bin"), "/system/bin", "/system/xbin"]
        : [];
    const packageEnv = platform === "android"
        ? packageManagerEnvironment(runtime, paseoHome, prefix)
        : null;
    const launcherChanged = await writePackageLauncher(launcherPath, entryPath, nodeCommand, runner, {
        platform,
        pathPrefix,
        environment: platform === "android"
            ? {
                PREFIX: packageEnv.PREFIX,
                HOME: packageEnv.HOME,
                TMPDIR: packageEnv.TERMUX_TMPDIR,
                TERMUX_PREFIX: packageEnv.TERMUX_PREFIX,
                TERMUX_HOME: packageEnv.TERMUX_HOME,
                DPKG_ADMINDIR: packageEnv.DPKG_ADMINDIR,
                TERMUX_TMPDIR: packageEnv.TERMUX_TMPDIR,
                ...(entry.providerId === "claude"
                    ? {
                        CLAUDE_TERMUX_STDIN: "inherit",
                        MAGI_ENV: "1",
                        ...(commandShims.node ? { MAGI_NODE: commandShims.node } : {}),
                    }
                    : {}),
            }
            : undefined,
    });
    const command = [launcherPath, ...entry.args];
    const stateChanged = launcherChanged || JSON.stringify(stateEntry.command) !== JSON.stringify(command) ||
        stateEntry.entryPath !== entryPath || stateEntry.launcher !== launcherPath ||
        stateEntry.native !== native || stateEntry.runner !== runner || (runner === "node" && stateEntry.nodeCommand !== nodeCommand);
    stateEntry.command = command;
    stateEntry.entryPath = entryPath;
    stateEntry.launcher = launcherPath;
    stateEntry.native = native;
    stateEntry.runner = runner;
    if (runner === "native" || runner === "shell") delete stateEntry.nodeCommand;
    else stateEntry.nodeCommand = nodeCommand;
    return stateChanged;
}

function npmPackageName(packageSpec) {
    if (packageSpec.startsWith("@")) {
        const versionSeparator = packageSpec.indexOf("@", packageSpec.indexOf("/") + 1);
        return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
    }
    const versionSeparator = packageSpec.lastIndexOf("@");
    return versionSeparator > 0 ? packageSpec.slice(0, versionSeparator) : packageSpec;
}

function customCommandFromState(paseoHome, entry, stateEntry) {
    if (entry.source.type !== "npm") return [customTargetPath(paseoHome, entry), ...entry.args];
    if (!Array.isArray(stateEntry?.command) || stateEntry.command.length < 1 || stateEntry.command.some((value) => typeof value !== "string" || !value)) {
        return [];
    }
    const packageRoot = customPackageRoot(paseoHome, entry);
    const firstPath = path.resolve(stateEntry.command[0]);
    const secondPath = stateEntry.command.length > 1 ? path.resolve(stateEntry.command[1]) : null;
    if (stateEntry.native === true || isWithinRoot(firstPath, packageRoot)) {
        if (!isWithinRoot(firstPath, packageRoot)) return [];
        return [...stateEntry.command];
    }
    if (!secondPath || !isWithinRoot(secondPath, packageRoot)) return [];
    if (path.extname(secondPath).toLowerCase() === ".exe") {
        return [secondPath, ...stateEntry.command.slice(2)];
    }
    return [...stateEntry.command];
}

function isPackageEntry(entry) {
    return entry.kind === "custom" || entry.kind === "preset";
}

function npmStateMatchesEntry(entry, stateEntry) {
    if (entry.source.type !== "npm") return true;
    if (!stateEntry?.installed) return false;
    if (typeof stateEntry.package !== "string" || !stateEntry.package) {
        return entry.kind === "custom";
    }
    return [entry.source.package, entry.source.updatePackage]
        .filter((packageSpec) => typeof packageSpec === "string" && packageSpec)
        .includes(stateEntry.package);
}

async function customCommandExists(paseoHome, entry, stateEntry, platform = process.platform) {
    const command = customCommandFromState(paseoHome, entry, stateEntry);
    if (entry.source.type !== "npm") {
        const targetStat = await fs.stat(command[0]).catch(() => null);
        return isExecutableFile(targetStat, platform);
    }
    if (command.length < 1) return false;
    const packageRoot = customPackageRoot(paseoHome, entry);
    if (typeof stateEntry?.entryPath !== "string" || !stateEntry.entryPath) return false;
    const entryPath = path.resolve(stateEntry.entryPath);
    if (!isWithinRoot(entryPath, packageRoot) || entryPath === path.resolve(stateEntry.launcher ?? command[0])) return false;
    const entryStat = await fs.stat(entryPath).catch(() => null);
    if (!entryStat?.isFile()) return false;
    const launcherStat = await fs.stat(command[0]).catch(() => null);
    return isExecutableFile(launcherStat, platform);
}

function customSourcePath(runtime, entry) {
    const source = entry.source;
    if (source.type !== "path") return null;
    const candidate = path.resolve(source.path);
    const roots = [runtime.cliSourceRoot ?? process.env.PREFIX, runtimeAgentHome(runtime)].filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value));
    if (!roots.some((root) => isWithinRoot(candidate, root))) {
        throw new Error("Custom CLI source must stay inside the App-owned runtime prefix or App-private home");
    }
    return candidate;
}

async function readCustomSource(runtime, entry, updating) {
    if (entry.source.type === "npm") throw new Error("npm sources must use the package installer");
    if (entry.source.type === "path") {
        const source = customSourcePath(runtime, entry);
        const sourceStat = await fs.lstat(source).catch(() => null);
        if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`${entry.label} 的本地 CLI 文件不存在或不是普通文件`);
        return fs.readFile(source);
    }
    const url = updating ? (entry.source.updateUrl ?? entry.source.url) : entry.source.url;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${entry.label} 下载失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`${entry.label} 下载文件过大`);
    const expected = updating ? (entry.source.updateSha256 ?? entry.source.sha256) : entry.source.sha256;
    if (expected) {
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== expected) throw new Error(`${entry.label} SHA-256 校验失败`);
    }
    return bytes;
}

export function packageManagerEnvironment(runtime = {}, paseoHome, prefix) {
    const env = {};
    const userHome = runtime.paseoHome || runtime.home || runtime.agentCliHome || runtime.appHome
        ? runtimeUserHome(runtime)
        : paseoHome;
    for (const key of ["TMPDIR", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "LANG", "LC_ALL"]) {
        if (typeof process.env[key] === "string") env[key] = process.env[key];
    }
    env.HOME = userHome;
    env.PREFIX = prefix;
    const platform = runtime.platform ?? process.platform;
    const pathApi = platform === "android" ? path.posix : path;
    const delimiter = runtime.pathDelimiter ?? (platform === "android" ? ":" : path.delimiter);
    const inheritedPath = platform === "android"
        ? ""
        : typeof runtime.inheritedPath === "string" ? runtime.inheritedPath : (process.env.PATH ?? "");
    const systemPaths = platform === "android" ? ["/system/bin", "/system/xbin"] : [];
    env.PATH = [pathApi.join(prefix, "bin"), ...systemPaths, inheritedPath]
        .filter((entry) => typeof entry === "string" && entry.length > 0)
        .join(delimiter);
    env.COREPACK_HOME = path.join(agentCliInstallRoot(paseoHome), "cache", "corepack");
    env.npm_config_cache = path.join(agentCliInstallRoot(paseoHome), "cache", "npm");
    const custom = runtime.packageInstallEnv && typeof runtime.packageInstallEnv === "object"
        ? runtime.packageInstallEnv
        : {};
    return {
        ...env,
        ...custom,
        HOME: userHome,
        PREFIX: prefix,
        PATH: env.PATH,
        TERMUX_PREFIX: prefix,
        TERMUX_HOME: userHome,
        DPKG_ADMINDIR: pathApi.join(prefix, "var", "lib", "dpkg"),
        TERMUX_TMPDIR: pathApi.join(prefix, "tmp"),
    };
}

function runProcess(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, shell: false, windowsHide: true });
        let stdout = "";
        let stderr = "";
        let outputBytes = 0;
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const append = (kind, chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_PACKAGE_MANAGER_OUTPUT_BYTES) {
                child.kill();
                finish(new Error("Agent CLI package manager output is too large"));
                return;
            }
            if (kind === "stdout") stdout += chunk.toString("utf8");
            else stderr += chunk.toString("utf8");
        };
        child.stdout?.on("data", (chunk) => append("stdout", chunk));
        child.stderr?.on("data", (chunk) => append("stderr", chunk));
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
            if (code === 0) finish(null, { stdout, stderr });
            else finish(new Error(`Agent CLI package install failed (${code}): ${(stderr || stdout).trim().slice(-2000)}`));
        });
        const timer = setTimeout(() => {
            child.kill();
            finish(new Error("Agent CLI package install timed out"));
        }, PACKAGE_MANAGER_TIMEOUT_MS);
        timer.unref?.();
    });
}

async function runNpmInstall(runtime, options) {
    if (typeof runtime.runAgentCliPackageInstall === "function") {
        return runtime.runAgentCliPackageInstall(options);
    }
    const paseoHome = runtimeAgentHome(runtime);
    const prefix = runtimePrefix(runtime);
    const nodeCommand = path.resolve(runtime.nodeExecutable ?? process.execPath);
    const corepackPath = path.resolve(runtime.corepackPath ?? path.join(prefix, "lib", "node_modules", "corepack", "dist", "corepack.js"));
    const corepackStat = await fs.stat(corepackPath).catch(() => null);
    if (!corepackStat?.isFile()) throw new Error("App 内置 Corepack 尚未准备好，无法安装 npm CLI");
    const env = packageManagerEnvironment(runtime, paseoHome, prefix);
    await Promise.all([
        fs.mkdir(env.COREPACK_HOME, { recursive: true, mode: 0o700 }),
        fs.mkdir(env.npm_config_cache, { recursive: true, mode: 0o700 }),
    ]);
    const args = [
        corepackPath,
        "npm",
        "install",
        "--prefix", options.destination,
        "--no-save",
        "--package-lock=false",
        "--omit=dev",
        "--fund=false",
        "--audit=false",
    ];
    if (options.ignoreScripts) args.push("--ignore-scripts");
    if (options.registry) args.push("--registry", options.registry);
    args.push(options.packageSpec);
    return runProcess(nodeCommand, args, { cwd: paseoHome, env });
}

function packageBinPath(packageRoot, metadata, requestedBin) {
    const bin = metadata?.bin;
    let relative = null;
    if (typeof bin === "string") relative = bin;
    else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
        if (requestedBin) relative = bin[requestedBin];
        else relative = bin[Object.keys(bin)[0]];
    }
    if (typeof relative !== "string" || !relative.trim()) {
        throw new Error(`npm package does not expose the requested CLI binary: ${requestedBin ?? "default"}`);
    }
    const resolved = path.resolve(packageRoot, relative);
    if (!isWithinRoot(resolved, packageRoot)) throw new Error("npm package CLI binary escapes its package directory");
    return resolved;
}

const CLAUDE_KEEP_ALIVE_MARKER = "# paseo: keep-alive for stream-json stdin";

// The Termux wrapper only keeps the CLI alive on two paths: an interactive TTY (_tui=1, which
// skips the trailing process.exit()) and -p print mode (which waits for the stdout flush).
// @anthropic-ai/claude-agent-sdk uses a third shape -- piped stdin with
// --input-format stream-json and no -p -- so both checks fail and the wrapper exits 0 before
// the CLI ever reads stdin. Treat stream-json stdin as a session like a TTY. Not print mode:
// that watcher stops at the first result line and would end multi-turn sessions after one turn.
async function patchClaudeStreamJsonKeepAlive(packageDir) {
    const wrapperPath = path.join(packageDir, "lib", "termux-run-claude-native.sh");
    const current = await fs.readFile(wrapperPath, "utf8").catch(() => null);
    if (typeof current !== "string" || current.includes(CLAUDE_KEEP_ALIVE_MARKER)) return;
    const ttyPattern = /_tui=0\nif \[ "\$_pf" = "0" \] && \[ -t 0 \]; then\n  _tui=1\nfi\n/u;
    if (!ttyPattern.test(current)) return;
    const replacement = [
        CLAUDE_KEEP_ALIVE_MARKER,
        '_sj=0',
        '_prev=""',
        'for _a in "$@"; do',
        '  if [ "$_a" = "--" ]; then break; fi',
        '  if [ "$_a" = "--input-format=stream-json" ]; then _sj=1; break; fi',
        '  if [ "$_prev" = "--input-format" ] && [ "$_a" = "stream-json" ]; then _sj=1; break; fi',
        '  _prev="$_a"',
        'done',
        '',
        '_tui=0',
        'if [ "$_pf" = "0" ] && { [ -t 0 ] || [ "$_sj" = "1" ]; }; then',
        '  _tui=1',
        'fi',
        '',
    ].join("\n");
    await fs.writeFile(wrapperPath, current.replace(ttyPattern, replacement), "utf8");
}

async function patchAndroidClaudePackage(packageRoot, platform, packageName, prefix) {
    if (platform !== "android" || packageName !== "@bash0816/claude-code") return;
    const packageDir = path.basename(packageRoot) === "claude-code"
        ? packageRoot
        : path.join(packageRoot, "node_modules", "@bash0816", "claude-code");
    const preparePath = path.join(packageDir, "lib", "prepare-native.js");
    const current = await fs.readFile(preparePath, "utf8").catch(() => null);
    if (typeof current === "string") {
        const legacyPattern = /const\s+(?:tarballUrl|url)\s*=\s*runCapture\('npm',\s*\['view',\s*spec,\s*'dist\.tarball',\s*'--json'\]\)(?:\.replace\([^;\n]+\))?;/u;
        if (legacyPattern.test(current)) {
            const replacement = "const rawTarball = runCapture('npm', ['view', spec, 'dist.tarball', '--json']);\n    let tarballUrl = rawTarball;\n    try {\n      const parsedTarball = JSON.parse(rawTarball);\n      tarballUrl = Array.isArray(parsedTarball) ? parsedTarball[0] : parsedTarball;\n    } catch {}\n    tarballUrl = String(tarballUrl || '').replace(/^\\\"|\\\"$/g, '');";
            await fs.writeFile(preparePath, current.replace(legacyPattern, replacement), "utf8");
        }
    }
    await patchClaudeStreamJsonKeepAlive(packageDir);
    const patchTextFiles = async (directory) => {
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await patchTextFiles(filePath);
                continue;
            }
            if (!entry.isFile()) continue;
            const bytes = await fs.readFile(filePath).catch(() => null);
            if (!bytes || bytes.includes(0)) continue;
            const text = bytes.toString("utf8");
            const patched = text
                .replaceAll("/data/data/com.termux/files/usr", prefix)
                .replaceAll("/data/data/com.termux", path.dirname(prefix));
            if (patched !== text) await fs.writeFile(filePath, patched, "utf8");
        }
    };
    await patchTextFiles(packageDir);
}

async function installNpmSource(runtime, entry, updating = false) {
    const paseoHome = runtimeAgentHome(runtime);
    const platform = runtime.platform ?? process.platform;
    const prefix = runtimePrefix(runtime);
    const packagesRoot = path.join(agentCliInstallRoot(paseoHome), "packages");
    const target = customPackageRoot(paseoHome, entry);
    const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const staging = path.join(packagesRoot, `.${entry.providerId}.${suffix}.tmp`);
    const backup = path.join(packagesRoot, `.${entry.providerId}.${suffix}.bak`);
    const requestedPackageSpec = updating ? (entry.source.updatePackage ?? entry.source.package) : entry.source.package;
    const packageSpec = (runtime.platform ?? process.platform) === "android" && entry.providerId === "claude"
        ? ANDROID_CLAUDE_PACKAGE
        : requestedPackageSpec;
    const packageName = npmPackageName(packageSpec);
    let movedPrevious = false;
    let installedTarget = false;
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
        await runNpmInstall(runtime, {
            destination: staging,
            packageSpec,
            ignoreScripts: entry.source.ignoreScripts !== false,
            registry: entry.source.registry,
        });
        const stagedPackageRoot = path.join(staging, "node_modules", ...packageName.split("/"));
        const metadataPath = path.join(stagedPackageRoot, "package.json");
        const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
        if (metadata.name !== packageName) throw new Error(`npm package name mismatch: expected ${packageName}`);
        await patchAndroidClaudePackage(stagedPackageRoot, platform, packageName, prefix);
        let stagedEntryPath = packageBinPath(stagedPackageRoot, metadata, entry.source.bin);
        const entryStat = await fs.lstat(stagedEntryPath).catch(() => null);
        if (!entryStat?.isFile() || entryStat.isSymbolicLink()) throw new Error("npm package CLI binary is missing or invalid");
        const nodeCommand = path.resolve(runtime.nodeExecutable ?? process.execPath);
        if (platform === "android" && await isWindowsPortableExecutableFile(stagedEntryPath)) {
            throw new Error("Android cannot execute a Windows PE npm binary");
        }
        stagedEntryPath = await normalizeAndroidPackageEntryPath(stagedEntryPath, platform);
        await fs.chmod(stagedEntryPath, 0o755);
        const relativeEntryPath = path.relative(staging, stagedEntryPath);
        const finalEntryPath = path.join(target, relativeEntryPath);
        const runner = await packageEntryRunner(stagedEntryPath, platform);
        const native = runner === "native";
        const stagedLauncherPath = path.join(staging, PACKAGE_LAUNCHER_FILE);
        const npmShim = await ensureAndroidNpmShim(runtime, paseoHome);
        const commandShims = await ensureAndroidCommandShims(runtime, paseoHome);
        const pathPrefix = platform === "android"
            ? [path.dirname(npmShim ?? commandShims.node ?? stagedLauncherPath), path.join(prefix, "bin"), "/system/bin", "/system/xbin"]
            : [];
        const packageEnv = platform === "android"
            ? packageManagerEnvironment(runtime, paseoHome, prefix)
            : null;
        await writePackageLauncher(stagedLauncherPath, finalEntryPath, nodeCommand, runner, {
            platform,
            pathPrefix,
            environment: platform === "android"
                ? {
                    PREFIX: packageEnv.PREFIX,
                    HOME: packageEnv.HOME,
                    TMPDIR: packageEnv.TERMUX_TMPDIR,
                    TERMUX_PREFIX: packageEnv.TERMUX_PREFIX,
                    TERMUX_HOME: packageEnv.TERMUX_HOME,
                    DPKG_ADMINDIR: packageEnv.DPKG_ADMINDIR,
                    TERMUX_TMPDIR: packageEnv.TERMUX_TMPDIR,
                    ...(entry.providerId === "claude"
                        ? {
                            CLAUDE_TERMUX_STDIN: "inherit",
                            MAGI_ENV: "1",
                            ...(commandShims.node ? { MAGI_NODE: commandShims.node } : {}),
                        }
                        : {}),
                }
                : undefined,
        });
        const currentStat = await fs.lstat(target).catch(() => null);
        if (currentStat) {
            await fs.rename(target, backup);
            movedPrevious = true;
        }
        await fs.rename(staging, target);
        installedTarget = true;
        const launcherPath = path.join(target, PACKAGE_LAUNCHER_FILE);
        const command = [launcherPath, ...entry.args];
        const version = typeof metadata.version === "string" && metadata.version.trim()
            ? metadata.version.trim()
            : (updating ? entry.source.updateVersion : entry.source.version) ?? null;
        const state = await readState(paseoHome);
        state[entry.providerId] = {
            installed: true,
            version,
            command,
            native,
            runner,
            entryPath: finalEntryPath,
            launcher: launcherPath,
            ...(!native ? { nodeCommand } : {}),
            package: packageSpec,
            state: "installed",
            updatedAt: new Date().toISOString(),
        };
        await writeState(paseoHome, state);
        if (movedPrevious) await fs.rm(backup, { recursive: true, force: true });
        return {
            providerId: entry.providerId,
            installed: true,
            command,
            version,
            status: "installed",
            configureProvider: true,
            providerExtends: entry.extends,
            label: entry.label,
            message: `${entry.label} npm CLI 已安装到 App 私有目录。`,
        };
    }
    catch (error) {
        if (installedTarget) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        if (movedPrevious) await fs.rename(backup, target).catch(() => undefined);
        throw error;
    }
    finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function installBundledSource(runtime, entry) {
    const paseoHome = runtimeAgentHome(runtime);
    const source = cliSourcePath(runtime, entry);
    const sourceStat = source ? await fs.lstat(source).catch(() => null) : null;
    if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`${entry.label} 的 App 内置 CLI 尚未准备好`);
    }
    const binRoot = path.join(agentCliInstallRoot(paseoHome), "bin");
    await fs.mkdir(binRoot, { recursive: true, mode: 0o700 });
    const target = path.join(binRoot, entry.command[0]);
    const temporary = path.join(binRoot, `.${entry.command[0]}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.copyFile(source, temporary);
        await fs.chmod(temporary, 0o755);
        await fs.rename(temporary, target);
        await fs.chmod(target, 0o755);
    }
    finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
    const state = await readState(paseoHome);
    const version = runtime.cliVersions?.[entry.providerId] ?? entry.version;
    state[entry.providerId] = {
        installed: true,
        version,
        state: "installed",
        updatedAt: new Date().toISOString(),
    };
    await writeState(paseoHome, state);
    return {
        providerId: entry.providerId,
        installed: true,
        command: [...entry.command],
        version,
        status: "installed",
        configureProvider: entry.kind === "provider",
        message: `${entry.label} CLI 已安装到 App 私有目录。`,
    };
}

async function installCustomSource(runtime, entry, updating = false) {
    if (entry.source.type === "npm") return installNpmSource(runtime, entry, updating);
    const paseoHome = runtimeAgentHome(runtime);
    const target = customTargetPath(paseoHome, entry);
    const binRoot = path.dirname(target);
    await fs.mkdir(binRoot, { recursive: true, mode: 0o700 });
    const temporary = path.join(binRoot, `.${entry.providerId}.${process.pid}.${Date.now()}.tmp`);
    const bytes = await readCustomSource(runtime, entry, updating);
    try {
        await fs.writeFile(temporary, bytes, { mode: 0o700, flag: "wx" });
        await fs.chmod(temporary, 0o755);
        await fs.rename(temporary, target);
        await fs.chmod(target, 0o755);
    }
    finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
    const state = await readState(paseoHome);
    const version = updating
        ? (entry.source.updateVersion ?? entry.source.version ?? null)
        : (entry.source.version ?? null);
    const command = [target, ...entry.args];
    state[entry.providerId] = { installed: true, version, command, state: "installed", updatedAt: new Date().toISOString() };
    await writeState(paseoHome, state);
    return {
        providerId: entry.providerId,
        installed: true,
        command,
        version,
        status: "installed",
        configureProvider: true,
        providerExtends: entry.extends,
        label: entry.label,
        message: `${entry.label} CLI 已安装到 App 私有目录。`,
    };
}

export async function addAgentCli(runtime, definition) {
    const paseoHome = runtimeAgentHome(runtime);
    const entry = normalizeCustomEntry(definition);
    const current = await readCustomCatalog(paseoHome);
    await writeCustomCatalog(paseoHome, [...current.filter((candidate) => candidate.providerId !== entry.providerId), entry]);
    return clone(entry);
}

async function allCatalogEntries(runtime, paseoHome) {
    const custom = paseoHome ? await readCustomCatalog(paseoHome) : [];
    const customById = new Map(custom.map((entry) => [entry.providerId, entry]));
    const nativeIds = new Set(AGENT_CLI_CATALOG.map((entry) => entry.providerId));
    return [
        ...AGENT_CLI_CATALOG.map((entry) => catalogEntryForRuntime(
            runtime,
            entry.kind === "preset" ? entry : (customById.get(entry.providerId) ?? entry),
        )),
        ...custom.filter((entry) => !nativeIds.has(entry.providerId)),
    ];
}

export async function listAgentCliCatalog(runtime = {}) {
    const paseoHome = runtime.paseoHome || runtime.home || runtime.agentCliHome || runtime.appHome
        ? runtimeAgentHome(runtime)
        : null;
    const state = paseoHome ? await readState(paseoHome) : {};
    const appHome = paseoHome ? runtimeAgentHome(runtime) : null;
    const entries = await allCatalogEntries(runtime, paseoHome);
    let stateChanged = false;
    if (appHome) {
        for (const entry of entries) {
            if (entry.installable && isPackageEntry(entry) && entry.source.type === "npm" &&
                npmStateMatchesEntry(entry, state[entry.providerId])) {
                stateChanged = await ensureNpmPackageLauncher(runtime, appHome, entry, state[entry.providerId]) || stateChanged;
            }
        }
        if (stateChanged) await writeState(appHome, state);
    }
    const targetExists = async (entry) => {
        if (!appHome || !state[entry.providerId]?.installed) return false;
        if (!entry.installable) return false;
        if (isPackageEntry(entry)) {
            if (!npmStateMatchesEntry(entry, state[entry.providerId])) return false;
            return customCommandExists(appHome, entry, state[entry.providerId], runtime.platform ?? process.platform);
        }
        const targetStat = await fs.stat(path.join(agentCliInstallRoot(appHome), "bin", entry.command[0])).catch(() => null);
        return isExecutableFile(targetStat, runtime.platform ?? process.platform);
    };
    const installedFlags = await Promise.all(entries.map((entry) => targetExists(entry)));
    return entries.map((entry, index) => {
        const installed = entry.source === "bundled"
            ? (entry.providerId === "paseo" || entry.providerId === "codex") && (!state[entry.providerId]?.installed || installedFlags[index])
            : installedFlags[index];
        const installedVersion = state[entry.providerId]?.version ?? entry.version ?? entry.source?.version ?? null;
        const latestVersion = isPackageEntry(entry)
            ? (entry.source.updateVersion ?? entry.source.version ?? null)
            : (runtime.cliVersions?.[entry.providerId] ?? entry.version);
        return {
            ...clone(entry),
            installed,
            installedVersion: entry.installable ? installedVersion : null,
            latestVersion,
            updateAvailable: Boolean(entry.updateable && installed && latestVersion && installedVersion && latestVersion !== installedVersion),
            command: !entry.installable
                ? []
                : isPackageEntry(entry)
                ? customCommandFromState(appHome ?? runtimeAgentHome(runtime), entry, state[entry.providerId])
                : [...entry.command],
            state: entry.installable ? (state[entry.providerId]?.state ?? null) : entry.status,
        };
    });
}

export async function installAgentCli(runtime, providerId, options = {}) {
    assertProviderId(providerId);
    const paseoHome = runtimeAgentHome(runtime);
    const entry = (await allCatalogEntries(runtime, paseoHome)).find((candidate) => candidate.providerId === providerId);
    if (!entry) throw new Error(`Unknown Agent CLI: ${providerId}`);
    if (!entry.installable || (entry.source !== "bundled" && !isPackageEntry(entry))) {
        throw new Error(entry.message);
    }
    const lockKey = `${paseoHome}\0${providerId}`;
    const previous = installLocks.get(lockKey);
    if (previous) return previous;
    const operation = (async () => {
      if (!options.update && !options.force) {
        const appHome = paseoHome;
        const state = await readState(appHome);
        const reusablePackageState = !isPackageEntry(entry) || entry.source.type !== "npm" ||
            npmStateMatchesEntry(entry, state[providerId]);
        if (reusablePackageState && isPackageEntry(entry) && entry.source.type === "npm" && state[providerId]?.installed &&
            await ensureNpmPackageLauncher(runtime, appHome, entry, state[providerId])) {
            await writeState(appHome, state);
        }
        const customCommand = isPackageEntry(entry)
            ? customCommandFromState(appHome, entry, state[providerId])
            : null;
        const alreadyInstalled = isPackageEntry(entry)
            ? reusablePackageState && await customCommandExists(appHome, entry, state[providerId], runtime.platform ?? process.platform)
            : isExecutableFile(await fs.stat(path.join(agentCliInstallRoot(appHome), "bin", entry.command[0])).catch(() => null), runtime.platform ?? process.platform);
        if (state[providerId]?.installed && !state[providerId]?.error && alreadyInstalled) {
            return {
                providerId,
                installed: true,
                command: isPackageEntry(entry)
                    ? customCommand
                    : [...entry.command],
                version: state[providerId].version ?? entry.version ?? entry.source?.version ?? null,
                status: "installed",
                configureProvider: entry.kind === "provider" || isPackageEntry(entry),
                providerExtends: entry.extends,
                label: entry.label,
                message: `${entry.label} CLI 已安装，可直接使用。`,
            };
        }
      }
      return isPackageEntry(entry)
          ? installCustomSource(runtime, entry, Boolean(options.update))
          : installBundledSource(runtime, entry);
    })();
    installLocks.set(lockKey, operation);
    try {
        return await operation;
    }
    finally {
        if (installLocks.get(lockKey) === operation) installLocks.delete(lockKey);
    }
}

export async function updateAgentCli(runtime, providerId) {
    const paseoHome = runtimeAgentHome(runtime);
    const entry = (await allCatalogEntries(runtime, paseoHome)).find((candidate) => candidate.providerId === providerId);
    if (!entry?.updateable) throw new Error(entry?.message ?? `Agent CLI cannot be updated: ${providerId}`);
    return installAgentCli(runtime, providerId, { update: true });
}

export const agentCliCatalog = AGENT_CLI_CATALOG;
