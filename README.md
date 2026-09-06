# DSHA（Paseo Enhanced）

Android 自托管 AI 工作台。`com.dshcli` 的 DSHA 应用内置 Termux 运行时、Paseo 0.3.1
增强层和 DeepSeek Harness EAC 5.3.6 桌面壳（dsh 内核），全部离线安装、本机启动。
增强层保留官方 Paseo 的运行方式，只增加本地管理界面、供应商切换和移动端可用性修复。

## 功能

- DeepSeek Harness EAC 5.3.6 桌面壳（dsh 内核 0.1.2-alpha.1）：冷启动自动引导，控制页
  提供启动/进入/重启/停止、端口与日志查看。
- EAC「添加工作区」接入 Android 系统文件管理器（SAF）：选择共享存储目录时补请求
  权限，选完自动回填真实路径完成创建。
- EAC 移动端适配 shim 家族：Locale/TimeZone/MobileCss/Touch/Dialog，console 输出转发
  logcat。
- Codex 供应商、模型、权限和 API Key 管理，密钥输入可直接粘贴。
- 对话内“挤入模式”：上游繁忙时按原请求节奏持续重试，成功或关闭开关后停止。
- 获取供应商模型列表。
- 对话一键全部导入、单个删除和后台状态同步。
- 手机目录浏览器，可直接选择工作区、Skill 或插件目录。
- Skills 按通用、Codex、Claude 和系统内置分类，支持启停、删除和从导入源更新。
- 插件导入、启停和删除。
- Android 软键盘避让，输入框不会被 IME 覆盖。
- 紧凑型侧边管理面板，避免遮挡 Paseo 原有顶栏和输入区。
- 控制台内置 Agent CLI 管理：可在 App 私有目录安装、重装和更新 Paseo CLI 与已验证的 Codex CLI，也可添加自己的 OpenCode、Pi、ACP 或其他 CLI。
- Paseo 原生 Provider 继续由 Paseo 管理；自定义 CLI 添加后会自动注册为可切换 Provider，适配器、命令、来源和版本都能在控制台指定。

## 兼容性

当前补丁严格对应 `@getpaseo/server@0.3.1`。安装器遇到其他版本会停止，
除非显式传入 `--force`。强制安装可能破坏新版 Paseo，不建议普通用户使用。

## 安装

先安装官方 Paseo CLI：

```sh
npm install -g @getpaseo/cli@0.3.1
```

然后在本项目目录执行：

```sh
node install.mjs
```

安装器会：

1. 定位全局安装的 `@getpaseo/server`。
2. 检查版本并验证补丁语法。
3. 在 `~/.paseo/paseo-enhanced-backups/` 创建逐文件备份。
4. 安装管理 API、Codex 代理和自定义 Web UI。
5. 更新 `~/.paseo/config.json` 的本地 Web UI 路径。

安装器不会停止或重启 Paseo。完成当前任务后，请按你原来的方式正常重启
Paseo Daemon；仅刷新页面不足以加载服务端补丁。

可通过参数指定非标准位置：

```sh
node install.mjs --server-root /path/to/@getpaseo/server --paseo-home /path/to/.paseo
```

## 回滚

```sh
node uninstall.mjs
```

回滚脚本恢复最近一次安装前的文件，同样不会自动重启 Paseo。也可以重新安装
官方版本进行完整恢复：

```sh
npm install -g @getpaseo/cli@0.3.1
```

## Android 客户端

独立 arm64 APK 作为 `v2.3.7` GitHub Release 附件发布；本地构建产物位于
`android/releases/DSHA-v2.3.7-arm64.apk`，不纳入 Git 跟踪。它已经内置 Termux
bootstrap、Node.js 24、Paseo CLI 0.3.1、Paseo Enhanced 2.3.7、内置 Codex CLI 0.147.0、
git 2.55.0、npm 11.16.0 / pnpm 11.7.0 和 DeepSeek Harness EAC 5.3.6 桌面壳（dsh 内核 0.1.2-alpha.1
及 Android arm64 原生模块），不需要另外安装 ZeroTermux 或 Termux。首次启动会在应用
私有目录离线安装这些运行文件，启动 Paseo Daemon，等待 `http://127.0.0.1:6767/` 就绪后
直接打开 Web UI；EAC 桌面壳由控制页一键引导，同样在应用私有目录运行。最低系统版本为
Android 7.0（API 24）。

APK 的 SHA-256 随 GitHub Release 提供。此版本沿用 v2.3.6 的 debug 签名。

v2.3.7 在设备端为 apt/dpkg 下载的官方 Termux deb 重定位路径，修复 `pkg install`
写入 `com.termux` 目录失败；内置 git 可离线使用，后续由包管理器安装时登记完整文件清单。
Android EAC 包移除选定的 9 个桌宠及外观插件，保留输入灵动岛，并新增五个本地插件：
子智能体注入面板（dsh-subagent-panel）、第三方模型思考强度调节
（dsh-custom-provider-reasoning）、客户端伪装（dsh-client-masquerade）、会话 ID 页脚
（dsh-session-id-footer）与输入灵动岛（dsh-composer-dynamic-island），全部默认可用。
旧版终端的文件管理和下载库按需初始化，状态文件轮询移到后台，共享存储权限只在选择目录时请求。

Android 工程位于 `ZeroTermux-main/`，离线运行时准备脚本位于
`scripts/prepare-android-runtime.ps1`。应用使用独立包名 `com.dshcli`，可以与原来的
ZeroTermux (`com.termux`) 共存；Termux Java namespace 仍保留为 `com.termux`，
bootstrap 和运行时前缀已迁移到 `/data/data/com.dshcli/files/usr`。

### Agent CLI 安装与更新

打开 Paseo 控制台的“安装 Agent CLI（含 Paseo CLI）”折叠区即可操作。安装内容只会写入
`$HOME/.paseo-app/agents`，不会读取或复用另一个 Termux/ZeroTermux 的前缀。Paseo 和
Codex 的内置安装项受保护；Paseo 原生的 OpenCode、Pi、Claude、Copilot、OMP 等 Provider
仍然保留，可使用同名 CLI ID 安装自己选择的实现来补齐命令，而不是删除原生适配器。

控制台提供可编辑的 OpenCode/Pi 模板，也允许自行填写 CLI ID、显示名称、适配器、启动参数，
并从 npm 包、HTTPS URL 或 App 运行时文件安装。npm 来源可以分别指定首次安装包、更新包、
`package.json` 中的 `bin` 名称和 HTTPS Registry；安装后会读取真实包版本与入口，立即注册到
上方 Agent 选择器供直接切换。再次提交同一个自定义 ID 会更新定义，列表中的“更新”会按新来源
原子替换旧版本。npm lifecycle scripts 默认关闭，只有勾选“允许 npm 安装脚本”才会执行；
URL 来源支持为安装和更新分别填写 SHA-256。任意第三方 CLI 仍需自身兼容 Android arm64，
控制台不会把普通桌面包伪装成已验证的 Android 包。

## 安全说明

- 管理 API 只接受回环地址请求。
- Android WebView 对本机只允许 `127.0.0.1` 上当前配置的 Paseo 端口；远程连接仅允许用户明确连接的完整 origin，其他导航和明文 HTTP 地址会被阻止。本机 Android 桥接与移动端 shim 也只注入本机页面。
- Android 应用备份已关闭，release 签名信息只从构建进程的环境变量读取。
- API Key 保存在用户本机的 `~/.paseo/codex-provider-profiles.json`，不会由
  管理接口返回明文。
- 请勿公开 `.paseo` 目录、Daemon 密钥、会话记录或 Android 签名文件。
- “挤入模式”会持续请求繁忙的上游服务；使用前应确认供应商条款和额度限制。

## 上游更新

本项目采用版本锁定补丁，不能假设未来 Paseo 文件结构不变。升级官方 Paseo 前，
先运行兼容性检查：

```sh
npm run check:upstream -- --server-root /path/to/@getpaseo/server
```

检查器是只读的，会同时检查版本和补丁依赖的入口点。只有输出 `supported` 时才建议
运行 `node install.mjs`；如果输出 `review-required`，它会列出版本漂移或缺失的文件，
便于把上游更新逐项对照后再调整补丁，不需要盲目使用 `--force`。完成调整后再运行
`npm run check` 和 `node --test tests/*.test.mjs`。

## 第三方声明与 License

本项目基于 Paseo 修改并按 GNU AGPL v3 发布。使用、修改或再分发时，请保留
[LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 和
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，并提供对应源代码。

这里的“增强版”是非官方发行版，不代表 Paseo 官方背书。上游 Paseo 以及本仓库
使用的其他组件、SDK 和 npm 依赖，仍受各自原始许可证约束；不要删除其版权和
许可声明。
