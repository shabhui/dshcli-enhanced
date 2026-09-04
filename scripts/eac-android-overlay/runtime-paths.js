'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_ROOT = void 0;
exports.init = init;
exports.nodeExe = nodeExe;
exports.npmCli = npmCli;
exports.updCtx = updCtx;
exports.dshBin = dshBin;
exports.dshVersion = dshVersion;
exports.dshVersionSource = dshVersionSource;
// 运行时定位：内置 Node / npm CLI / dsh CLI 二进制（ADR 0002 L2 业务服务层；
// Wave 1 自 runtime-paths.js 类型化迁出，行为零变更）。
// 优先级：用户已批准的官方更新 overlay > 随包内置副本。
const path = require("node:path");
const fs = require("node:fs");
const platform_1 = require("./platform");
// 应用根目录（本模块位于 <root>/lib/desktop/ 下）。
exports.APP_ROOT = path.resolve(__dirname, '..', '..');
// updater.js 尚未类型化（Wave 3 收编），先以窄签名消费。
const updater = require('../../updater');
let ctx;
function init(d) { ctx = d; }
// 壳环境注入缺省时按开发态处理（保持原防御语义）。
function isPackaged() {
    return typeof ctx.isPackaged === 'function' ? !!ctx.isPackaged() : false;
}
function resourcesDir() {
    return typeof ctx.resourcesPath === 'function' ? ctx.resourcesPath() : '';
}
function runtimePlatform() {
    return ctx.platform ?? process.platform;
}
function runtimeExecPath() {
    return typeof ctx.execPath === 'function' ? ctx.execPath() : process.execPath;
}
// Termux 前缀：$PREFIX/bin/node → $PREFIX。全程 path.posix —— 在 Windows 构建机
// 上用宿主的 path.join 会吐出 \data\data\... 这种在设备上不存在的路径。
function termuxPrefix() {
    return path.posix.dirname(path.posix.dirname(runtimeExecPath().split(path.win32.sep).join('/')));
}
function appRoot() {
    return typeof ctx.appRoot === 'function' ? ctx.appRoot() : exports.APP_ROOT;
}
function nodeExe() {
    // Android（Termux）既没有 vendor/ 也没有 Electron 的 resourcesPath，node 由宿主
    // 提供。桌面版那两条路径在设备上都不存在，而 boot-server 对 nodeExe() 做
    // existsSync 硬失败（「找不到内置 Node 运行时」）。这里直接复用正在运行的解释器：
    // 桌面层本身就跑在 Termux node 上，自洽且不依赖环境变量。
    // 必须先于 isPackaged 判断 —— 标记为已打包而 resourcesPath 为空时，
    // path.join('', 'node', 'node') 会得到相对路径 'node/node'（按 cwd 解析）。
    if (runtimePlatform() === 'android')
        return runtimeExecPath();
    const executable = (0, platform_1.nodeExecutableName)(runtimePlatform());
    // Tauri 布局：应用树 = <DSH_RESOURCE_ROOT>/dsh-desktop（= APP_ROOT），内置
    // Node 在 vendor/node/ 下；isPackaged 真实判定（5.3.3 批次 D）后打包分支
    // 必须优先走这里 —— 5.3.2 恒 false 掩盖了该差异（打包态其实一直在用
    // 开发分支的路径）。旧 Electron 布局 resources/node/ 保留为兼容候选。
    const tauriBundled = path.resolve(appRoot(), 'vendor', 'node', executable);
    if (isPackaged()) {
        if (fs.existsSync(tauriBundled))
            return tauriBundled;
        return path.join(resourcesDir(), 'node', executable);
    }
    return tauriBundled;
}
function npmCli() {
    // B0 把 npm 装到 $PREFIX/lib/node_modules/npm（Termux 的标准布局），
    // 从解释器位置推导，运行时整体搬家也能跟着走。
    if (runtimePlatform() === 'android') {
        return path.posix.join(termuxPrefix(), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    }
    const tauriBundled = path.resolve(appRoot(), 'vendor', 'npm', 'bin', 'npm-cli.js');
    if (isPackaged()) {
        if (fs.existsSync(tauriBundled))
            return tauriBundled;
        return path.join(resourcesDir(), 'npm', 'bin', 'npm-cli.js');
    }
    return tauriBundled;
}
// Context shared with the updater module.
function updCtx() {
    return {
        userDataDir: ctx.getUserDataDir(),
        nodeExe,
        npmCli,
        log: ctx.log,
    };
}
// Updated overlay takes precedence over the bundled copy — 除非 overlay 比
// 随包内置内核旧（应用升级后，过时的官方更新 overlay 不得遮蔽更新的内置内核；
// 平局仍取 overlay，保持既有语义）。
function effectiveOverlay() {
    const c = updCtx();
    const ov = updater.overlayBinPath(c);
    if (!ov || !fs.existsSync(ov))
        return null;
    const ovVer = updater.overlayVersion(c);
    const bundled = updater.bundledVersion();
    if (ovVer && bundled && updater.compareVersions(ovVer, bundled) < 0)
        return null;
    return ov;
}
function dshBin() {
    const ov = effectiveOverlay();
    if (ov)
        return ov;
    return require.resolve('@deepseek-ai/dsh/lib/bin.js');
}
function dshVersion() {
    const c = updCtx();
    if (effectiveOverlay())
        return updater.overlayVersion(c) || updater.activeVersion(c) || '未知';
    return updater.bundledVersion() || '未知';
}
function dshVersionSource() {
    return effectiveOverlay() ? '用户目录（已更新）' : '内置';
}
