# Paseo 五项待办 · 调查记录

记录时间：2026-08-28。任务一~三为调查阶段成果，任务四、五为后续追加。实现进度见文末，完成一项勾一项。

## 任务一 · 彻底统一 HOME（已定方案）

现状是两个 HOME：Termux 走 `files/home`，Paseo daemon 走 `files/paseo-home`，`files/usr/bin` 共用。

- 单一改动点：`TermuxConstants.java:659` `TERMUX_HOME_DIR_PATH`
- daemon 侧对应值：`PaseoProcessEnvironment.java:10`（`PaseoProcessEnvironmentTest.java:27` 断言了这个值）
- 派生常量 6 个：`:665` CONFIG_HOME、`:676` DATA_HOME、`:682` STORAGE_HOME、`:779` CRASH_LOG、`:782` CRASH_LOG_BACKUP、`:806` SHORTCUT_SCRIPTS
- 消费点：`FileReceiverActivity:42,43`、`TermuxDocumentsProvider:175`、`PaseoDirectoryChooser:60`、`FileUtilsTests:30`、`TermuxFileUtils:58,59,91,373`、`TermuxPropertyConstants:322`
- **真正把 HOME 注入 shell 的是 `TermuxShellEnvironment.java:83`**，改完必须验这里
- 设备现状：`files/home` 只有 `.timerdir`/`ZtInfo`/`ztlink`；`files/paseo-home` 有 `.cache`/`.codex`/`.npm`/`.paseo`/`.paseo-app`/`.pi`

### 实现时改了方向（重要）

原计划是把 `TERMUX_HOME_DIR_PATH` 指到 `paseo-home`。真动手前数了一遍，发现
**硬编码 `files/home` 的地方有 65 处、跨 24 个文件**：qemu、备份/恢复、字体、SSH、
左侧菜单 XML、`bashrc.sh`、`execTermuxEnv.sh`、`termux-adb-shell.sh`、三份
`strings.xml`。改常量会让这 65 处继续指向 `files/home`，而真实 HOME 变成
`paseo-home` —— 那不是统一，是把裂缝挪了个位置，而且裂在我没法实机逐条回归的
遗留功能上。

反过来看 Paseo 侧：`start-paseo.sh` 和 `install-bundled-runtime.sh` 全是
`$HOME/.paseo-app` 这种 HOME 相对写法，硬编码 `paseo-home` 的只有 3 处 Java。

所以方向反过来：**HOME 统一到 `files/home`**（也就是 `TERMUX_HOME_DIR_PATH` 原值
不动），Paseo 侧改用它。结果是同一个 HOME、零 symlink、`TermuxShellEnvironment`
一行都不用改、那 65 处硬编码本来就是对的。

- 新增 `PaseoHome.java`：`directory()` / `appDirectory()` / `migrateLegacyHome()`
- 三处接上：`PaseoProcessEnvironment:10`、`PaseoRuntimeController:76`、`PaseoActivity:277`
  （另外把 `openTerminal` 的 `EXTRA_WORKDIR` 从 filesDir 改成 HOME）
- 迁移在 `PaseoActivity.onCreate` 里跑一次，早于任何读 `$HOME` 的代码
- 迁移策略：逐项 rename，**同名以统一 HOME 里的为准**，冲突项留在原地不覆盖、
  不删除；全部搬完才删空的 `paseo-home`
- `PaseoHome` 刻意不依赖 `android.util.Log`（JVM 单测里没打桩），问题以
  `List<String>` 返回，由 `PaseoActivity` 打日志
- 新增 `PaseoHomeTest`（5 例）；`PaseoProcessEnvironmentTest:27` 断言改为 `home`；
  `PaseoDirectoryChooserTest:66,67` 和 `PaseoPackageIdentityTest:80` 本来就断言
  `files/home`，现在自动对上了

## 任务二 · 改名残留（已定方案）

**(a) `ZeroCoreManage` 日志噪音。** `com.xinhao.zerocoremanage` 插件不存在时 `ZERO_ENGINE_CLASS` 保持 null，12 个反射方法全部在自己的 try/catch 里 NPE 并打栈。文件 `zerocore/zero/engine/ZeroCoreManage.java`，调用点 `TermuxActivity:1678`、`:2829`、`KeyBordManage:38,44-47`。修法：`ZERO_ENGINE_CLASS == null` 时提前返回。

**(b) symlink EEXIST。** `FileIOUtils.kt` 的 `createWebConfig()`（约 465-485 行）直接 `Os.symlink`，没有存在性检查，第二次运行必抛。注意是 Kotlin 文件，不是 Java。

**(c) GitHub 联网。** `HTTPIP.kt:12` 的 `GITHUB_VERSION` 每次启动都被 `TermuxActivity:1502` 和 `:2918` 拉取，删掉。

## 任务三 · 会话被大量新建（已找到根因）

### 排除项（都已验证不是原因）

- Paseo 自己的终端是 daemon 下的 node `terminal-worker-process.js`，完全不碰 `TermuxService`
- Node 侧零 termux intent 调用（grep 过 `patches/` `scripts/` `web/` `install.mjs`）
- `TermuxService.onStartCommand` 返回 `START_NOT_STICKY`，无 intent 重投递
- `messageReceiver` / `LocalReceiver` 不建会话
- `onCreateWindow` 只建 popup WebView
- `setupBootstrapIfNeeded` 收单个 Runnable，不累积
- `paseo-manager.js` 的 `PENDING_TERMINAL_KEY` 逻辑干净：三条出口都清、60 秒过期

### 根因：两个独立缺陷叠加

**缺陷 1 —— `PaseoActivity` 实例可无限叠。** `AndroidManifest.xml:216-227` 没写 `launchMode`，默认 `standard`。设备上已实测叠到 5 个实例。每个新实例都会弹一次"Paseo port"对话框。

**缺陷 2 —— 每按一次终端按钮新建一个会话。** `PaseoActivity.openTerminal():272-295` 设了 `EXTRA_SHELL_NAME = "Paseo startup log"`，但**没设 `EXTRA_SHELL_CREATE_MODE`**。`TermuxService.processShellCreateMode()` 默认落到 `ShellCreateMode.ALWAYS`，按名复用那条分支（`NO_SHELL_WITH_NAME` → `getTermuxSessionForShellName`）永远不生效。错误面板上的 "Open terminal" 按钮（`PaseoActivity.java:80`）每按一次就新建一个会话，且都存活。

**叠加路径**：daemon 启动慢或失败 → 错误面板出现 Retry + Open terminal → 用户反复按 Open terminal 看日志 → 一按一个会话，全部留存 → "大量新对话"。

### 已验证的干净基线

force-stop → monkey 启动 → 点 START 之后：1 个 daemon、1 个 terminal-worker、**0 个 bash**、栈 sz=1、1 个 WebView target。连点 3 次"新建 Agent" → 无新进程、无新会话（本机没装 CLI，Agent 起不来）。

## 本次踩到的测量假象

1. **后台 WebView 的 CDP 看起来像卡死。** Chromium 冻结不可见的 renderer，`Page.enable`/`Log.enable`/`Runtime.enable` 全部不回，而浏览器级命令照常回 —— 和 JS 线程真卡死无法区分。判据是 `/json/list` 里的 `"visible"`。
2. **`ps -A | grep node` 查不到 daemon。** 这台模拟器上 node 的进程名是 `ndk_translation_program_runner_binfmt_misc_arm64`。我一度断定 daemon 死了，实际它有 2351 秒 uptime。交叉验证：端口 6777（`/proc/net/tcp` 十六进制 `1A79`、状态 `0A`）＋ `run-as` 读 `/proc/<pid>/cmdline`。
3. **复现循环自我污染。** 循环里用 `am start -n ...PaseoActivity` 拉前台，每次都新建实例；随后的 `>_` 调用打到后台实例的 WebView，而后台 activity 无权 `startActivity`，TermuxActivity 根本没起来。那一轮数据作废。

前两条已存入 memory `android-probes-give-false-readings.md`。

## 任务四 · 全局提示词自带默认环境说明（已定方案）

挂载点已经存在，只是没人接：`patches/server/bootstrap.js:332` 从
`process.env.PASEO_BASE_SYSTEM_PROMPT_FILE` 读 `baseSystemPrompt`，而这个环境变量
全仓库没有任何地方设置，所以它永远是空串。`combineAgentSystemPrompt(base, append)`
（`:323`）用 `\n\n` 把它和用户的 `appendSystemPrompt` 拼起来，`:1146` 还有
`onFieldChange` 做热更新。

方案：**运行时探测**，不发静态文件。理由是设备上到底装了什么会变（用户可以随时
`pkg install`，也可以装 CLI），写死的清单第一次 `pkg install git` 之后就开始骗
Agent。实现要点：

- 在 `bootstrap.js` 里生成环境前言：Android/Termux 前缀、`HOME`、前缀路径、
  实际探测到的命令清单。
- 探测方式是查 `PREFIX/bin` 真实存在的可执行文件，不是猜。
- 默认前言作为 `baseSystemPrompt`，用户自己填的 `appendSystemPrompt` 叠在后面，
  两者都要能热更新。
- UI 上要能看到这段默认前言，让用户知道自己填的是"追加"而不是"替换"。

设备实测清单（`files/usr/bin`）：
有 bash/sh/dash、node、codex、paseo、curl、apt/pkg/dpkg、awk/sed/grep/find、
nano/ed/less、tar/unzip/gzip/xz、ps/pgrep/pkill/top、logcat/am/pm/settings/getprop、
su、netstat/ifconfig/ping、diff/patch、coreutils 全套、`termux-*` 助手一整组。
没有 git、python、jq、rg、fd、proot、ssh、zsh、vim、htop、tree、wget。

## 任务五 · UI 改版（已定方案）

现状：整个控制台由 `web/paseo-manager.js`（789 行）生成，样式是**七层内联
`<style>` 层层打补丁**——`style`、`mobileOverride`、`squeezeStyle`、`compactStyle`、
`terminalStyle`、`supplierStyle`、`editorModeStyle`，后面的不停覆盖前面的。丑的根源
不是配色本身，是这七层互相打架：同一个圆角在不同层里是 `16px`/`12px`/`8px`/`7px`/
`6px`/`5px`，抽屉背景 `#1e2521` 被 `#151b18` 盖掉，`.pm-add-action` 还是一个橙色
`#f28a25` 按钮插在整套绿色里。`web/` 下没有独立 CSS 文件。

方案：**不重写那七层**（里面混着大量已验证的移动端布局规则，重写等于拿没法实机
逐条回归的东西赌），而是在最后追加一层设计令牌层：

- 用 CSS 自定义属性统一色板、圆角、间距、字号、阴影。
- 覆盖掉七层留下的不一致：统一圆角刻度、统一卡片背景、把橙色按钮收回主色。
- 提升可读性：正文对比度、次要文字层级、焦点可见性。
- 保持所有既有 id/class 选择器不变，纯视觉层，不动结构和逻辑。

### 实测中发现的三个既有 CSS 缺陷（比配色更要紧）

把真实 `paseo-manager.js` 挂在本地桩服务上、用手机视口逐个面板量过之后，发现"丑"
里有一部分根本不是审美问题，是三个一直存在、但没人量过的层叠 bug：

1. **所有主按钮其实是灰的。** `.pm-actions button` 权重 (0,1,1)，`.pm-primary` 只有
   (0,1,0)，所以第一层里 `.pm-primary{background:#38a269}` 从来没赢过，七个面板里的
   "保存/导入/安装"跟"取消"长得一模一样，完全没有主次。实测确认：关掉我这层，主按钮
   算出来是 `rgb(42,52,47)`，就是那个中性灰。已用 `.pm-actions button.pm-primary`
   复合选择器修掉，danger 同理。
2. **宽屏标签栏排不下。** `@media(min-width:700px)` 里写的是 `repeat(6,1fr)`，而
   `PRIMARY_TABS` 有 7 项，"插件"被挤到第二行单独一个。改成等分 flex 行，标签增减都
   不会再翻行。
3. **吸顶头和标签栏之间漏出 1px。** `#pm-head` 吸在 `top:-12px`、`#pm-tabs` 吸在
   `top:41px`，中间留了 1px 让滚动内容穿过去（`elementFromPoint` 打到
   `.pm-supplier-row`）。用 `box-shadow:0 2px 0 var(--pm-s1)` 盖掉，不动布局。

另外橙色 `.pm-add-action` 的白字实测只有 2.49:1（AA 要 4.5:1），已换成主色绿 + 深色
字，6.2:1。原声明里的 `#f28a25` 直接删掉，不留死值。

回归：`tests/paseo-manager-design-tokens.test.mjs` 把上面 1/2 和焦点环、橙色都钉住了。

### 实测方法（这次没有靠猜）

在 `.tmp-ui-harness/` 起了个 node 静态服务，直接喂真实的 `web/paseo-manager.js`，
再桩掉 `/api/codex-config` 和 `/api/paseo-manager` 的返回，用手机视口
(375×812) 和宽屏 (760×620) 各走了一遍七个面板，量的是 `getComputedStyle` 而不是看
截图。用完已删除。

两次踩到测量假象，记在这里：`elementFromPoint` 只做命中测试、看不见 `box-shadow`
盖没盖住；截图会把模拟视口缩到面板里（1000px 视口缩成约 28%），看着像布局崩了，实际
`getBoundingClientRect` 是对的。**结论跟之前一样：先确认量具。**

## 实现进度

- [x] 任务一 HOME 统一（反向：Paseo 改用 files/home，见 PaseoHome.java）
- [x] 任务二 (a) ZeroCoreManage 空值保护
- [x] 任务二 (b) createWebConfig 幂等（ensureSymlink）
- [x] 任务二 (c) 移除 GitHub 版本检查
- [x] 任务三 缺陷 1 `PaseoActivity` launchMode → `singleTask`
- [x] 任务三 缺陷 2 `openTerminal` 显式 `no-shell-with-name`
- [x] 任务四 默认环境提示词（运行时探测 + 注入 baseSystemPrompt）
- [x] 任务四 UI 展示默认前言（`pm-base-system-prompt`，只读折叠块）
- [x] 任务五 设计令牌层改版（第八层 `tokenStyle`，浏览器实测）

## 欠的清理

仓库：已清空（`.tmp-cdp*.mjs`、`.tmp-ws.json`、`.tmp-detect-check.sh`、
`.tmp-contrast.mjs`、`.tmp-ui-harness/`、临时的 `.claude/launch.json` 都已删除）。
设备：`/data/local/tmp/ws.json`、`/sdcard/d*.xml`（含 `d4.xml`）、我这轮的 uiautomator dump 都已删除；
`files/…/wstest` 随迁移移动后已 `rmdir`，daemon 自己把记录 `wks_37ed36bb389e8218` 归档成
`directory_missing`。授权改动已还原（`appops … SYSTEM_ALERT_WINDOW default`）。
主机：`adb forward tcp:9333` 已 remove。
设备上还留着一个没启用的 `provider_e93cf45a8e35`（"OpenAI"）配置，以及 Claude 供应商里那把测试密钥。

`/data/local/tmp` 和 `/sdcard` 里还堆着约 615 MB 早前几轮（8/17–8/28）的测试残留：
两个 258 MB 的 codex 二进制、一个 100 MB 的 claude-code tgz，以及几十个 xml/png dump。
没有一并删，因为是跨目录批量删除，且其中一部分可能是刻意放那儿的。

## 实机验证（已完成）

三条都在模拟器 emulator-5554（Android 16 / API 36，x86_64 + `libndk_translation`，
APK `primaryCpuAbi=arm64-v8a`）上确认了。之前判断"adb 注入不到"是错的：
`TermuxService` 的 `exported="false"` 只挡住 `am startservice`，
不挡 `am start` 拉起 `PaseoActivity` + `input tap`，也不挡 `run-as` 读私有目录。

1. **任务一 迁移**：升级安装（`adb install -r`，保留数据）前 `paseo-home` 7 项、
   `home` 3 项、无同名冲突；启动后 `paseo-home` 消失，`home` 变 10 项，
   3 个原有项没被覆盖，logcat 里没有 `Home migration:` 警告。内容是真文件不是空目录
   （`.paseo/paseo-enhanced-backups/`、`web-ui-custom/` 都在）。
2. **任务三 缺陷 1**：`openTermuxTerminal()` 连调 5 次（logcat 确认 5 次都到了），
   TermuxActivity 只有 1 个实例、PaseoActivity 只有 1 个，task `sz=2`；
   再 `am start` 一次 PaseoActivity，复用同一个实例 id 并清掉上面的 TermuxActivity，
   回到 `sz=1`。logcat 直接给出 `LAUNCH_SINGLE_TASK` + `onActivityRestartAttempt wasVisible=true`。
3. **任务三 缺陷 2**：连点"OPEN TERMINAL"共约 16 次，Termux 通知一直是 **2 sessions**
   （`bash -l` + 一个 `sh -i`），没有涨到 16。三个量具互相印证：通知计数、进程表、ActivityRecord。
4. **任务四**：设备上重新生成的提示词报的是真实探测值 —— `Android 16 (API 36)`、
   `HOME=/data/user/0/com.paseoe/files/home`（顺带证明统一 HOME 真的生效了）、
   present/absent 两份命令清单。整条链路都验了：shell 探测 → 文件 →
   daemon 读入 → `GET /api/paseo-manager?action=global-settings` 返回 `baseSystemPrompt`
   → 控制台折叠块渲染 2529 字。
5. **任务五**（顺带）：412×842 实机上 7 个 tab 单行、`--pm-accent` 等令牌生效、
   主按钮 `rgb(53,167,108)`（特异度修复在设备上成立）、页面无横向溢出。

### 实机才暴露出来的两点

- **`SYSTEM_ALERT_WINDOW` 是 OPEN TERMINAL 的隐形前提。** Android 10+ 上没这个权限时，
  `TermuxService.startTermuxActivity()` 走 else 分支，只弹一个 toast，
  session 建了但不跑（`TermuxService.java:717` 的注释写明"will show in Termux
  notification but will not run until user manually clicks the notification"）。
  所以我一开始数进程恒为 0 —— 会话一直在建，只是没进程。
- **`uname -m` 和 `primaryCpuAbi` 在翻译层上不一致。** 提示词报 `x86_64`，
  而 APK 跑的是 arm64-v8a（`libndk_translation`）。真机 arm64 上没这个分裂，
  但提示词让 agent"下载原生二进制前先看这一行"，模拟器上这一行是误导的。
  同一原因让 codex app-server `SIGSEGV`（已有 non-ARM64 测试覆盖这个降级路径）。

### 又踩了三次量具错误

跟之前那条记录同一个教训：先确认量具。
`grep -c ActivityRecord` 数的是 dumpsys 里的**提法**不是实例（读出 8，实际 1，
要按对象 id 去重）；`ps -o PID,ARGS` 之后还去 `grep u0_a223` —— USER 列已经不输出了，
恒为空；把滚动容器（`.pm-agent-switcher` 是 `overflow-x:auto`）的子元素当成溢出
（真正的判据是 `documentElement.scrollWidth > innerWidth`，实测 412 = 412，没有溢出）。
另外 Git Bash 会把 `/data/...` 改写成 `C:/Program Files/Git/data/...`，要 `MSYS_NO_PATHCONV=1`。

## 8/28 这轮：exit code 0 和协议选项

### √ 问题一：`exit code 0` 用不了 Claude Code（根因已定位并修好）

两条报错是**同一个故障的两个报告者**：
`Query closed before response received` 是 SDK 那侧看到的，
`Claude stopped unexpectedly (exit code 0)` 是 Paseo `handleRuntimeExit` 看到的。

`@anthropic-ai/claude-agent-sdk` 拉起 CLI 的参数是
`--output-format stream-json --verbose --input-format stream-json`，**没有 `-p`**，
stdin 是管道。而 Termux wrapper（`lib/termux-run-claude-native.sh`）只认两种形态：

| 形态 | `_pf` | `_tui` | 保活方式 |
|---|---|---|---|
| 交互式 TTY | 0 | 1 | 跳过结尾的 `process.exit()` |
| `-p` 打印模式 | 1 | 0 | 等 stdout flush |
| **SDK 的 stream-json** | **0** | **0** | **没有 → 立刻 exit 0** |

第三种两个条件都不满足：不装 stdout watcher，`waitForPrintFlushIfNeeded` 直接返回，
`main().then()` 落到 `process.exit(process.exitCode ?? 0)` —— CLI 还没读 stdin 就被杀了，
所以退出码是 0（不是崩溃，是"正常"退出）。

修复：`patchClaudeStreamJsonKeepAlive`（`patches/server/paseo-agent-cli-installer.js`）
扫 argv 里的 `--input-format stream-json`（两种写法都认，遇到 `--` 停），
或进 `_tui` 条件。**故意用 `_tui=1` 不用 `_pf=1`** —— stream-json watcher 在第一条
`type:"result"` 就退出，多轮会话会被砍在第一轮。wrapper 第 2 行是 `set -eu`，
所以补丁里所有条件写成 `if ... fi`（`case` 里裸 `&&` 判假会让退出码非 0 触发 `set -e`），
`_prev` 也必须先初始化。

真机口径的验证（真 installer + 真的 1989 行 wrapper，1989 → 1999 行）：

| 调用方式 | 打补丁前 | 打补丁后 |
|---|---|---|
| SDK 真实参数（无 `-p`） | exit 0，stdout 空，无 result | exit 0，三行 JSON，274 ms |
| 带 `-p`（原有测试覆盖的） | 正常 | 正常，264 ms |

**为什么之前没被测出来**：这个包自带的存活测试**每一条都传了 `-p`**，
没有一条覆盖"stream-json 且没有 `-p`"。已补两条回归测试。

补丁挂在 `patchAndroidClaudePackage` 里面，所以**全新安装和修复路径都会走到**
（修复路径经 `listAgentCliCatalog`）。这一点单独测了：已装好的设备下次列 catalog
就会被就地修好，不用重装；重复列也只打一次补丁（幂等）。

### √ 问题二：一个选项写了两种协议

用户说得对，这个标签本身就是错的：

```html
<option value="native">原生接口（OpenAI 原生 / Anthropic 原生）</option>
```

`native` 不是一种协议 —— 对 `claude` 家族是 Anthropic 原生，对其他 CLI 是 OpenAI 原生，
一个标签描述不了两种。更绕的是 `NATIVE_ONLY_CLI_FAMILIES = new Set(["claude"])`：
Claude 的进程环境永远被强制成 `ANTHROPIC_*`，所以给 Claude 选"OpenAI 兼容"
**只换获取模型列表的接口，实际对话协议一点没变**，而旧 UI 完全没说这件事。

改成按家族解析（`managedProtocolLabels`，家族在 `renderSupplierEditor` 里本来就拿得到，
跟已有的 `isPi` 分支同一个来源，不用加新管道）：

| 家族 | native | openai-compatible |
|---|---|---|
| claude | Anthropic 原生接口 | OpenAI 兼容接口（仅用于获取模型列表） |
| 其他 | OpenAI 原生接口（/v1/responses） | OpenAI 兼容接口（/v1/chat/completions） |

底下加一行 `pm-provider-protocol-help` 说明差别。保存的**值**没动
（`API_PROTOCOLS` 仍是 `["native","openai-compatible"]`），所以不影响已存配置。

全量测试 216/216 过。

### √ 启动界面中文化

`values-zh-rCN` 里那 6 个 `paseo_port_*` 之前那轮已经加了，这轮补上剩下的硬编码英文：

| 位置 | 原来 | 现在 |
|---|---|---|
| `activity_paseo.xml` 48/64/71 | `"Preparing the embedded terminal"` / `"Retry"` / `"Open terminal"` | 抽成 `@string/paseo_*`，zh-rCN 给中文 |
| `PaseoRuntimeController.java` 6 处 | 硬编码英文状态文案 | `text(R.string.…, 英文兜底)` |
| `start-paseo.sh` 4 处 `write_status` + 10 处 `fail` | 英文 | 中文 |

`values/` 和 `values-zh-rCN/` 现在都是 14 个 `paseo_*`，一一对应。

**controller 里为什么要兜底**：`stop()` 在第 103 行把 `activity` 置空，但排队中的
status poll 还会调 `readState()`。`text()` 拿不到 Activity 就返回英文原文 ——
一句状态文案不值得让启动界面崩掉。

**改了三条测试断言**，都是原来钉住英文原文的：
`PaseoStartupScriptTest` 两条 + `PaseoRuntimeControllerTest` 一条。
钉的意图是"这个边界有诊断"（90 秒）和"这条路径是失败而不是复用"（`$PORT` 出现在文案里），
不是英文散文本身，所以换成钉中文文案 + 保留 `$PORT`/`90` 这些真正承重的 token，
断言强度没降。**一开始我为了不动测试，把文案写成
`"Paseo port $PORT is already in use（端口已被占用）"` 这种中英夹杂 —— 那是本末倒置，
已经改回正常中文。**

**顺带解决了上一轮欠的那个问题：`runtime-version` 不用手动 bump。**
`start-paseo.sh` 本来就是 `asset-fingerprint` 的输入之一（`build.gradle:306`），
构建时指纹自动变；`PaseoAssetInstaller` 看到指纹不一致就刷新
（`PaseoAssetInstallerTest.sameRuntimeVersionRefreshesChangedEnhancedSources` 正是这个场景）。
所以已装机的设备升级后会拿到新脚本。

注意 `start-paseo.sh` 里的中文是**写死的**，不跟系统语言走 —— shell 脚本没有资源系统，
没为这个单独搭一套。

Android 单测 90 项过（1 skipped），Node 216 项过。

## 8/28 实机验证（模拟器 emulator-5554，Android 16 / API 36）

装了新构建的 APK 后逐项确认，两个问题都在设备上验完了。

**前提：先把 locale 切成 zh-CN。** 模拟器默认 `en-US`，`values-zh-rCN/` 根本不会生效，
不切的话验的是英文资源。`setprop persist.sys.locale zh-CN` + 重启。

**中文化。** 端口对话框、7 个 tab、控制台、供应商编辑器全中文。脚本那条链路单独验了：
设备上的 `start-paseo.sh` 四条 `write_status` 都是中文，状态文件里读出 `Paseo 已就绪`,
经 Java `InputStreamReader` 到 TextView 没有乱码 —— UTF-8 整条通了。
指纹机制按预期工作，不用手动 bump `runtime-version`。

**keep-alive 补丁走真实 daemon 的修复路径。** 这台模拟器只装过 `pi`，没有 Claude wrapper 可查，
所以造了个最小的"已安装"包（用真实的 mode-detection 块，17 行未打补丁），
然后 `GET /api/paseo-manager?action=provider-cli-catalog` 触发真实 daemon 列表：

- 17 行 → 27 行，marker 出现 1 次
- 再列两次，marker 仍然是 1 次，27 行不变（幂等）
- 五种参数形态在真机 + 真管道 stdin（`adb shell -T` 关掉 PTY）下全对：
  SDK 真实参数 `PF=0 TUI=1`、`=` 写法 `PF=0 TUI=1`、带 `-p` `PF=1 TUI=0`、
  纯管道无 stream-json `PF=0 TUI=0`、`--` 之后 `PF=0 TUI=0`

验完把假包和 `agent-cli-state.json` 都还原了。

**协议选项。** 四个家族在设备上逐个确认：claude 显示"Anthropic 原生接口"+
"OpenAI 兼容接口（仅用于获取模型列表）"，pi/codex/opencode 显示
"OpenAI 原生接口（/v1/responses）"+"OpenAI 兼容接口（/v1/chat/completions）"，
下面的说明框文案正确。顺带修了我自己写的一个标点问题（半角逗号配全角句号）。

### 这轮的量具错误（又是四个）

- **`adb shell run-as com.paseoe sh -c '...'` 的引号会被吞。** `sh -c 'echo MARKER-OK'`
  输出为空，`ls` 收不到路径参数，于是列出 cwd 并且看起来"路径对但内容不对"。
  改成 `run-as com.paseoe <cmd> <args>` 直接传，不要套 `sh -c`。
- **读了 10 小时前的旧 status 文件**，据此判断"新脚本没到设备"。判据应该是文件 mtime
  跟设备当前时间对比，不是 `ls -t` 的第一个。差点得出完全相反的结论。
- **靠截图估控件坐标点不中。** 估的 (701,1110) 实际应该是 (894,1417)。
  用 `uiautomator dump` 读真实 bounds。
- **CSS 坐标换设备像素两轴比例不一致。** `1080/412=2.62` 但 `2400/842=2.85`,
  WebView 有偏移，按 dpr 算出来的位置点不到。正确做法是绕开换算：
  用 CDP `Input.dispatchTouchEvent`，它直接吃 CSS 坐标。
  另外 `pm-open` 走 pointer 事件序列，合成 `.click()` 驱动不了它。
- WebView 的 CDP socket 是 `webview_devtools_remote_<pid>`，不是 `chrome_devtools_remote`。
  从 `/proc/net/unix` 里取，pid 每次重启都变。

### 清理

主机临时文件已删。设备上我这轮的改动全部还原：假 claude 包、`agent-cli-state.json`、
`/data/local/tmp` 权限（755 → 771）、`SYSTEM_ALERT_WINDOW`（allow → default）、
`adb forward tcp:9333`。locale 留在 zh-CN，因为这个 App 本来就是中文优先，
下次验证还要用；要回 en-US 就 `setprop persist.sys.locale en-US` 再重启。

早前几轮的 615 MB 残留也清了（用户授权"你看着办"）：
`/data/local/tmp` 588 M → 56 K（两个 258 M codex 二进制、99 M claude-code tgz、
`paseo-nav-verify.jar`、`paseo-signal-test.sh`、空的 `.strace`、
`codex-home/`（里面的 `config.toml` 可能含测试密钥，没看内容直接删）），
`/sdcard` 97 个 xml/png dump 共 8.3 M。删前确认过 app 配置不引用
`/data/local/tmp` 任何路径；保留了 `dalvik-cache`。
删完复查：daemon 仍在 6777 监听，catalog 返回 200，`pi` 包完好，app 进程存活。
