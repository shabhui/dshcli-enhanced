'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginCapabilityDetails = pluginCapabilityDetails;
exports.nodeExecutableName = nodeExecutableName;
exports.createDesktopPlatform = createDesktopPlatform;
const fs = require("node:fs");
const path = require("node:path");
function pluginCapabilityDetails(platform = process.platform) {
    if (platform === 'win32') {
        return {
            'computer-user': { status: 'supported', reason: 'Windows PowerShell and SendInput adapter' },
            picturereader: { status: 'supported', reason: 'Windows OCR and bundled image backends' },
            'dsh-dafeiyu': { status: 'supported', reason: 'Bundled Windows helper' },
        };
    }
    if (platform === 'darwin') {
        return {
            'computer-user': { status: 'unavailable', reason: 'macOS v1.5 计划：CGEvent + TCC 授权' },
            picturereader: { status: 'external-dependency', reason: 'OCR 需 Python (paddle/rapid)，v1.5 计划 Vision 后端' },
            'dsh-dafeiyu': { status: 'unavailable', reason: '无 macOS helper 产物' },
        };
    }
    if (platform === 'android') {
        // Android 不是「另一种 Linux 桌面」：没有 Wayland/X11 会话，也没有 apt。
        // 沿用 Linux 措辞会把用户指向根本不存在的东西，所以单列。
        return {
            'computer-user': { status: 'unavailable', reason: 'Android 无 SendInput 等价通道；注入输入需 AccessibilityService，不在 sidecar 能力范围内' },
            picturereader: { status: 'external-dependency', reason: 'OCR 需在 Termux 内自行装后端（paddle/rapid），Android 上未验证' },
            'dsh-dafeiyu': { status: 'unavailable', reason: '无 Android helper 产物' },
        };
    }
    return {
        'computer-user': { status: 'unavailable', reason: 'Linux/Wayland has no transparent SendInput equivalent' },
        picturereader: { status: 'external-dependency', reason: 'OCR requires a separately installed Linux backend' },
        'dsh-dafeiyu': { status: 'unavailable', reason: 'No Linux helper payload has passed the required smoke test' },
    };
}
function nodeExecutableName(platform = process.platform) {
    return platform === 'win32' ? 'node.exe' : 'node';
}
function defaultCommandExists(file, platform, env) {
    const pathValue = env.PATH || env.Path || env.path || '';
    const delimiter = platform === 'win32' ? ';' : ':';
    const extensions = platform === 'win32'
        ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
        : [''];
    for (const dir of pathValue.split(delimiter).filter(Boolean)) {
        for (const ext of extensions) {
            const candidate = path.join(dir, platform === 'win32' ? file + ext.toLowerCase() : file);
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return true;
            }
            catch { /* continue */ }
        }
    }
    return false;
}
function createDesktopPlatform(options = {}) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? require('node:os').homedir();
    const commandExists = options.commandExists ?? ((file) => defaultCommandExists(file, platform, env));
    const userDataDir = () => {
        if (platform === 'win32') {
            const appData = env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming');
            return path.win32.join(appData, 'Deepseek Harness EAC');
        }
        if (platform === 'linux') {
            const configHome = env.XDG_CONFIG_HOME || path.posix.join(homeDir, '.config');
            return path.posix.join(configHome, 'deepseek-harness-eac');
        }
        if (platform === 'android') {
            // Termux 宿主（process.platform 实测为 'android'，不是 'linux'）。语义与
            // Linux 相同，但必须单列一条：末尾那个兜底分支用的是宿主的 path.join，
            // 在 Windows 构建机上会吐出反斜杠路径。不并进上面的 linux 条件是为了
            // 让 Linux 那行的 diff 保持为零，便于上游合并。
            const configHome = env.XDG_CONFIG_HOME || path.posix.join(homeDir, '.config');
            return path.posix.join(configHome, 'deepseek-harness-eac');
        }
        if (platform === 'darwin') {
            // macOS 惯例：~/Library/Application Support/<app>（不经 XDG fallback）。
            return path.posix.join(homeDir, 'Library', 'Application Support', 'deepseek-harness-eac');
        }
        const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
        return path.join(configHome, 'deepseek-harness-eac');
    };
    const capabilities = () => ({
        clipboard: platform === 'win32'
            ? 'supported'
            : platform === 'linux' && (commandExists('wl-copy') || commandExists('xclip') || commandExists('xsel'))
                ? 'supported'
                : platform === 'darwin'
                    ? 'supported' // pbcopy/pbpaste 为 macOS 内置
                    : platform === 'linux' ? 'external-dependency' : 'unavailable',
        clientSelfUpdate: platform === 'win32' ? 'supported' : 'external-handoff',
        computerUser: platform === 'win32' ? 'supported' : 'unavailable',
        processFence: platform === 'win32' ? 'job-object' : 'degraded',
        plugins: platform === 'win32'
            ? { computerUser: 'supported', ocr: 'supported', dafeiyu: 'supported' }
            : { computerUser: 'unavailable', ocr: 'external-dependency', dafeiyu: 'unavailable' },
    });
    return {
        userDataDir,
        runtimeExecutableName: () => nodeExecutableName(platform),
        capabilities,
    };
}
