'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.init = init;
exports.getServerProc = getServerProc;
exports.getWebUrl = getWebUrl;
exports.setIsRestarting = setIsRestarting;
exports.webServerNodeArgs = webServerNodeArgs;
exports.startAndWait = startAndWait;
exports.stopServer = stopServer;
exports.killAndWaitForRestart = killAndWaitForRestart;
exports.state = state;
// dsh web 服务进程编排（ADR 0002 L2 业务服务层；P2 自 main.js 的
// startServer / watchServerProc / waitUntilUp 提取，启动语义零变更，
// GUI 相关部分（loadURL / 「服务已停止」对话框）经 ctx 回调交给宿主）。
//
// 双轨说明：Electron main.js 在 M3 切换前保留原实现（可回退主线）；
// Tauri sidecar 挂载本模块，经 RPC 暴露：
//   boot.start   {overlays?} → {webUrl, port}
//   boot.stop    {}           → {ok}
//   boot.restart 编排由 sidecar 组合（市场排队 → 同步 → 本模块起停）
//   boot.state   {}           → {running, webUrl}
// 服务意外死亡经 ctx.onServerDied 上抛，宿主决定恢复页 / 对话框 / 静默。
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
// 兄弟 / 根模块窄签名消费（Wave 3 收编完成后改为具名类型化导入）。
const { killTree, killTreeAndWait, waitForProcExit, childEnv, childProcessSpawnOptions } = require('./proc');
const { expectedVersionScalar, planCredentialsHeal } = require('./credentials-version.cjs');
const { restrictedPortOf, chooseStableWebPort } = require('../../stable-port');
const { createStreamWriteGuard } = require('../../stream-write-guard');
let ctx;
function init(d) { ctx = d; }
let serverProc = null;
let restartingServer = false;
let webUrl = '';
function getServerProc() { return serverProc; }
function getWebUrl() { return webUrl; }
function setIsRestarting(v) { restartingServer = v; }
function logsDir() { return path.join(ctx.getUserDataDir(), 'logs'); }
function dshWebLogPath() { return path.join(logsDir(), 'dsh-web.log'); }
// 凭据版式自愈。上游这里写死成 YAML 字符串 "1"，但 5.3.1 同一个 deb 里的
// dsh-credentials-local 校验的是数字 1（lib/index.js:151
// `if (fields["version"] !== 1)`）。内核自己写出来的就是数字，被上游这段改成
// 字符串后，下一次启动 100% 死在：
//
//   credentials-local: .../.credentials.yaml declares version "1";
//   this build reads version 1
//
// 真机实测就是这个（dsh web 退出码 1，dsh-web.log 里是上面这行）。所以形态改为
// 问【实际会跑的那个校验器】要，判别不出来就不动 —— 沿用上游「看不懂则不动，
// 交由内核报错路径展示」的立场。决策是纯函数，见 credentials-version.cjs。
// 失败不阻塞启动。
function credentialsValidatorSource() {
    // 先用 node 自己的解析（本文件在 dsh-desktop/lib/desktop，node 会往上找到
    // dsh-desktop/node_modules）。该包是 ESM，require 它会失败，所以只 resolve
    // 路径再读文件。resolve 不通时退回手算路径。
    const candidates = [];
    try {
        candidates.push(require.resolve('@deepseek-ai/dsh-credentials-local/lib/index.js'));
    }
    catch { /* 退回手算 */ }
    candidates.push(path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js'));
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
        }
        catch { /* 下一个候选 */ }
    }
    return null;
}

function healCredentialsVersion() {
    try {
        const home = childEnv().DSH_HOME || path.join(os.homedir(), '.dsh');
        const file = path.join(home, '.credentials.yaml');
        if (!fs.existsSync(file))
            return;
        const expected = expectedVersionScalar(credentialsValidatorSource());
        if (expected === null) {
            ctx.log('dsh', '跳过 .credentials.yaml 自愈：读不出 credentials-local 要求的 version 形态');
            return;
        }
        const text = fs.readFileSync(file, 'utf8');
        const plan = planCredentialsHeal(text, expected);
        if (plan.changed) {
            fs.writeFileSync(file, plan.text);
            ctx.log('dsh', `已自愈 .credentials.yaml 版式（credentials-local 要求 version: ${expected}）`);
        }
    }
    catch { /* 自愈失败交由内核报错路径展示 */ }
}
/**
 * dsh web 子进程的 node 命令行。抽成纯函数是为了可测：startServer 会真的 spawn
 * 进程并等端口，而这行的顺序有硬约束（node 标志必须在脚本路径之前）。
 *
 * Android 必须补 --expose-internals。cordis-plugin-loader 取 Node 内部 ESM
 * loader 有两条路（loader/lib/index.js:11-16）：先看 process.execArgv 里有没有
 * 这个标志，否则要 node-addon-require-builtin 的原生绑定 —— 而后者 0.1.5 的
 * 可选依赖只覆盖 darwin / linux-*-gnu / win32-*-msvc，没有 android（Termux 是
 * bionic，且 process.platform 实测为 'android'，连 linux-arm64-gnu 都不会命中）。
 * 两条都断则 ctx.loader.internal 为 undefined，引出两个看似无关的故障：装在
 * profile 里的插件一律解析不到，以及 cordis-plugin-hmr:107 在 web 服务器**已经
 * 监听之后**才抛 "--expose-internals is required for HMR service"。
 * 该标志无法经 NODE_OPTIONS 传入（node 明确拒绝），只能写在命令行上。
 *
 * androidShim 是 android-resolve-sync.mjs 的绝对路径，同样只在 android 分支生效：
 * Android 运行时是 Node 24.18，内部 loader 的 resolveSync 已是 v2 形状，而
 * dsh-client-modules 无条件按 v1 形状调用，不补则客户端插件表恒为空。由调用方
 * 传入而非在此拼装，是为了让「文件不存在就不要传」的判断留在有 fs 的那一侧 ——
 * --import 指向不存在的文件会让 node 直接启动失败。
 */
function webServerNodeArgs(o) {
    const platform = o.platform ?? process.platform;
    const android = platform === 'android';
    return [
        // --use-system-ca：让 dsh web 进程信任系统证书库（代理/MITM 场景下内置
        // node 的默认 CA 无法验证，导致插件市场等对外 fetch 失败）。
        '--use-system-ca',
        ...(android ? ['--expose-internals'] : []),
        // fs 补丁必须排在 resolve-sync 之前：它只能用 createRequire 取 fs/promises,
        // 一旦别的模块先建好 ESM facade,内核的具名 import { link } 就快照到原版,
        // 补丁静默失效（android-fs-patch.mjs 里有实测数据与原因）。
        ...(android && o.androidFsPatch ? ['--import', o.androidFsPatch] : []),
        // 必须在 --expose-internals 之后：shim 里 require('internal/...') 依赖它。
        ...(android && o.androidShim ? ['--import', o.androidShim] : []),
        o.bin,
        // `--profile <name>` 直接在根命令上（本版本的 `web` 是 --profile web 的
        // 硬编码别名，不接受父级 --profile）；--host/--port 透传给该 app。
        '--profile', o.profile,
        '--host', '127.0.0.1',
        '--port', String(o.port),
        // --no-open：内核 openBrowser 默认 true 会每轮启动弹一个系统浏览器标签
        //（5.1.0 批次修过，5.3.0 重写 boot-server 时丢失回归）。
        '--no-open',
        ...(o.patchArgs ?? []),
    ];
}
async function startServer(unsafePortRetries = 4, overlays = []) {
    // M1 修复：重入前先终结旧进程，避免孤儿 harness 同时写同一 DSH_HOME。
    if (serverProc && !serverProc.killed && !ctx.isQuitting()) {
        ctx.log('dsh', 'startServer 重入：先终结旧进程再启动');
        killTree(serverProc);
        serverProc = null;
    }
    healCredentialsVersion();
    // 稳定端口（stable-port）：复用 settings.webPort，避免每次 --port 0 换
    // origin 导致 localStorage 偏好丢失；同时避开 Chromium 受限端口。
    const webPort = await chooseStableWebPort({
        loadSettings: () => ctx.loadSettings(),
        saveSettings: (_c, s) => ctx.saveSettings(s),
    });
    return new Promise((resolve, reject) => {
        const nodeBin = ctx.nodeExe();
        const bin = ctx.dshBin();
        if (!fs.existsSync(nodeBin)) {
            return reject(new Error('找不到内置 Node 运行时: ' + nodeBin));
        }
        fs.mkdirSync(logsDir(), { recursive: true });
        const out = fs.createWriteStream(dshWebLogPath(), { flags: 'a' });
        const patchArgs = overlays
            .filter((p) => typeof p === 'string' && p && fs.existsSync(p))
            .flatMap((p) => ['--patch', p]);
        // Android 的 resolveSync 归一化补丁随本模块发布（同目录）。缺失时不传，
        // 让服务照常起来——插件表会空，但页面能打开、日志能看到，比 node 直接
        // 因 --import 找不到文件而启动失败更好排查。
        const shimPath = path.join(__dirname, 'android-resolve-sync.mjs');
        // link() 在 Android 应用数据目录里被 SELinux 拒（EACCES），而内核用它发布
        // 会话文件，于是每轮对话结束都写不下去。同样缺失时不传。
        const fsPatchPath = path.join(__dirname, 'android-fs-patch.mjs');
        const args = webServerNodeArgs({
            bin,
            profile: ctx.getDesktopProfile(),
            port: webPort,
            patchArgs,
            // 条件展开而非显式 undefined：tsconfig 开了 exactOptionalPropertyTypes。
            ...(fs.existsSync(shimPath) ? { androidShim: shimPath } : {}),
            ...(fs.existsSync(fsPatchPath) ? { androidFsPatch: fsPatchPath } : {}),
        });
        // 日志里落完整 argv：Android 上「插件解析不到」这类故障的第一现场就是
        // --expose-internals 有没有真的传下去。
        ctx.log('dsh', `启动: "${nodeBin}" ${args.map((a) => `"${a}"`).join(' ')}`);
        const proc = cp.spawn(nodeBin, args, {
            ...childProcessSpawnOptions(),
            cwd: ctx.getUserDataDir(),
            env: childEnv(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverProc = proc;
        // profile 首次引导（node_modules 缺失）时 dsh 要先跑 pnpm 装齐依赖，
        // 就绪等待放宽（下方 bootTimeoutMs）。
        const firstBoot = !fs.existsSync(path.join(ctx.desktopProfileDir(), 'node_modules'));
        watchServerProc(proc, out, { expectedPort: webPort, unsafePortRetries, overlays, firstBoot }).then(resolve, reject);
    });
}
function watchServerProc(proc, out, opts) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let handedOff = false; // 受限端口重启：本实例的退出不再影响外层 Promise
        let bootTimer = null;
        // 0.1.2：stdout 就绪行携带的一次性 token URL（HTTP 探测胜出时的兜底值）。
        let probeFallbackUrl = '';
        const output = createStreamWriteGuard(out, {
            onError: (err) => ctx.log('warn', 'dsh web 日志流异常: ' + String((err && err.message) || err)),
        });
        let onSettled = (err, url) => {
            if (err)
                reject(err);
            else
                resolve(url);
        };
        const finish = (err, url) => {
            if (!settled) {
                settled = true;
                onSettled?.(err, url);
                onSettled = null;
            }
            if (bootTimer) {
                clearTimeout(bootTimer);
                bootTimer = null;
            }
        };
        // 跨 chunk 行缓冲：就绪行（含一次性 token URL）若被管道分块截断，按块
        // split 会两半都匹配失败 → token 永久丢失（HTTP 探测超时后 401 白屏）。
        // 只处理完整行，尾段不完整行滚入下一块。
        let lineBuf = '';
        const onData = (chunk) => {
            output.write(chunk);
            lineBuf += chunk.toString();
            const lines = lineBuf.split(/\r?\n/);
            lineBuf = lines.pop();
            for (const line of lines) {
                const m = line.match(/dsh web:\s+(https?:\/\/\S+)/);
                if (!m)
                    continue;
                const blocked = restrictedPortOf(m[1]);
                if (blocked && opts.unsafePortRetries > 0) {
                    // 端口命中 Chromium 受限列表：结束该实例重启换端口（有上限）。
                    handedOff = true;
                    ctx.log('dsh', `端口 ${blocked} 属于 Chromium 受限端口（ERR_UNSAFE_PORT），重启服务换端口（剩余重试 ${opts.unsafePortRetries} 次）`);
                    killTree(proc);
                    setTimeout(() => {
                        if (ctx.isQuitting())
                            return finish(new Error('应用正在退出'), '');
                        startServer(opts.unsafePortRetries - 1, opts.overlays).then((url) => finish(null, url), (err) => finish(err, ''));
                    }, 600);
                    return;
                }
                // 稳定端口：若 dsh 最终监听端口与请求的不同（极端兜底），以实际为准并保存。
                try {
                    const actual = Number(new URL(m[1]).port) || 0;
                    if (actual > 0 && actual !== opts.expectedPort) {
                        const settings = ctx.loadSettings();
                        settings.webPort = actual;
                        ctx.saveSettings(settings);
                    }
                }
                catch { /* URL 解析失败时忽略 */ }
                // 0.1.2：就绪行带一次性 token。记录给 HTTP 探测胜出路径兜底用
                //（finish 与探测是竞争关系，谁先到都会带上有 token 的 URL）。
                probeFallbackUrl = m[1];
                finish(null, m[1]);
            }
        };
        const onStderrData = (chunk) => output.write(chunk);
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onStderrData);
        proc.once('error', (err) => finish(err, ''));
        // close 在 exit 之后、stdio 全部关闭后触发：此时再结束文件流，既保留尾部
        // 输出，也不会让迟到的 data 写入已 end 的 Writable。
        proc.once('close', () => {
            proc.stdout.removeListener('data', onData);
            proc.stderr.removeListener('data', onStderrData);
            output.end();
        });
        // HTTP 就绪探测与 stdout 就绪行并行竞争 —— 就绪行被管道缓冲吞掉或格式
        // 变化时不再白白等满 bootTimer（「启动 60 秒超时」的主要假阳性来源）。
        // 内核 0.1.2 起 Web UI 首屏带一次性 token 鉴权：裸 `/` 在服务就绪后返回
        // 401，只证明端口活着、不证明可用。探测改打免鉴权的静态资源
        // favicon.svg。探测胜出时【不再立即返回】：token 只存在于 stdout 就绪行
        //（探测时行通常还没打印），再等一小窗口拿带 token 的 URL；窗口内没等到
        // 就绪行才回退裸 origin（rc.2 语义，兼容无鉴权老内核）。
        if (restrictedPortOf(`http://127.0.0.1:${opts.expectedPort}`) === 0) {
            const probeUrl = `http://127.0.0.1:${opts.expectedPort}`;
            void (async () => {
                while (!settled) {
                    const ok = await new Promise((res) => {
                        const req = http.get(probeUrl + '/favicon.svg', { timeout: 2500 }, (r) => {
                            r.resume();
                            res(!!r.statusCode && r.statusCode < 500);
                        });
                        req.on('error', () => res(false));
                        req.on('timeout', () => { req.destroy(); res(false); });
                    }).catch(() => false);
                    if (!ok) {
                        await new Promise((r) => setTimeout(r, 350));
                        continue;
                    }
                    // 探测就绪：给 stdout 就绪行（带 token）最多 30 秒补到窗口。就绪行
                    // 通常随端口就绪毫秒级到达；曾只等 5 秒，慢盘/杀毒软件拖慢 stdout
                    // 管道时窗口内拿不到 token，回退裸 origin 就是 401 白屏且无从诊断。
                    for (let i = 0; i < 300 && !settled && !probeFallbackUrl; i += 1) {
                        await new Promise((r) => setTimeout(r, 100));
                    }
                    if (!settled) {
                        if (!probeFallbackUrl) {
                            ctx.log('dsh', 'HTTP 探测就绪但 30 秒内未收到带 token 的就绪行，回退裸 origin（0.1.2 内核下将 401，需查 dsh-web.log 的就绪行）');
                        }
                        finish(null, probeFallbackUrl || probeUrl);
                    }
                    return;
                }
            })();
        }
        proc.once('exit', (code, signal) => {
            ctx.log('dsh', `进程退出 code=${code} signal=${signal}`);
            // 原地重启（插件市场）或已替换为新进程时，不打扰用户、也不清新句柄。
            const intentional = restartingServer || serverProc !== proc;
            if (serverProc === proc)
                serverProc = null;
            if (!handedOff) {
                finish(new Error(`dsh web 启动失败（退出码 ${code}）。日志: ${dshWebLogPath()}`), '');
            }
            if (!ctx.isQuitting() && !intentional && !handedOff && webUrl) {
                ctx.onServerDied?.({ code, signal, logPath: dshWebLogPath() });
            }
        });
        // 兜底：就绪行与 HTTP 探测都未按时落地时超时。首次引导（pnpm 装依赖）
        // 放宽到 180 秒，稳态 60 秒。
        const bootTimeoutMs = opts.firstBoot ? 180000 : 60000;
        bootTimer = setTimeout(() => finish(new Error(`等待 dsh web 启动超时（${Math.round(bootTimeoutMs / 1000)} 秒）`), ''), bootTimeoutMs);
        bootTimer.unref();
    });
}
function waitUntilUp(url, timeoutMs = 120000) {
    const started = Date.now();
    // 0.1.2 起 URL 可能带 ?token= 查询串：探测路径必须走 URL 拼接而非字符串
    // 追加（`url + '/'` 会把路径插到 query 前）。探测用免鉴权静态资源。
    const probeTarget = new URL('favicon.svg', url).href;
    return new Promise((resolve, reject) => {
        const tick = () => {
            const req = http.get(probeTarget, { timeout: 3000 }, (res) => {
                res.resume();
                if (res.statusCode && res.statusCode < 500)
                    resolve(url);
                else
                    retry();
            });
            req.on('error', retry);
            req.on('timeout', () => { req.destroy(); retry(); });
        };
        const retry = () => {
            if (Date.now() - started > timeoutMs)
                reject(new Error('Web UI 未在预期时间内就绪'));
            else
                setTimeout(tick, 300);
        };
        tick();
    });
}
/** 拉起服务并等待 Web UI 就绪（= main.js startAndShow 的非 GUI 部分）。 */
async function startAndWait(overlays = []) {
    const url = await startServer(4, overlays).then((u) => waitUntilUp(u));
    webUrl = url;
    let port = 0;
    try {
        port = Number(new URL(url).port) || 0;
    }
    catch { /* 保持 0 */ }
    return { webUrl: url, port };
}
/** 退出路径专用：有界同步回收服务进程树（grace → 强杀 → 再等）。 */
async function stopServer() {
    const proc = serverProc;
    serverProc = null;
    await killTreeAndWait(proc);
}
/** 原地重启前置：终结旧进程并等待真正退出（DLL 文件锁释放），供 sidecar
 *  在“无锁窗口”里执行市场排队任务 / 同步配套插件后再拉起新服务。 */
async function killAndWaitForRestart() {
    const old = serverProc;
    serverProc = null;
    killTree(old);
    await waitForProcExit(old, 20000);
}
function state() {
    return { running: !!(serverProc && serverProc.exitCode === null), webUrl };
}
