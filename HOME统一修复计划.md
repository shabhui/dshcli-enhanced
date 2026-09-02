# HOME 统一后的绝对路径失效 — 修复计划

## 根因（一个原因，五处表现）

`PaseoHome` 把 Paseo 的 `$HOME` 从 `files/paseo-home` 改成 `files/home`。
`migrateLegacyHome()` **只搬文件，不改文件里存的绝对路径**。

于是 `agent-cli-state.json` 完整搬过来了、`installed: true` 也还在，
但里面的 `command` / `entryPath` / `launcher` 仍然写着 `files/paseo-home/...`。
每个消费方都拿**新** home 算出的 `packageRoot` 去校验这些旧路径 → 全部判为不存在。

只有 npm 源的条目会坏（pi、claude）。非 npm 自定义条目走 `customTargetPath()` 重算、
bundled 条目走 `agents/bin/` 重算，两者都自愈。codex 另有第 1207 行的硬编码豁免。
**这就是"除 codex 外全要重装"的原因。**

聊天记录从未丢失。搬迁是保守的（同名保留、失败原地留、不删东西），坏的只是指针。

## 上游证据（从 runtime tarball 解出的 `@getpaseo/server`）

```
pi/agent.js:1069   nativeHandle: this.state.sessionFile,     写入：存绝对路径
pi/agent.js:1937   const sessionFile = handle.nativeHandle;  恢复：读回来
pi/agent.js:1938   if (!sessionFile) throw ...              只判空，不判文件是否存在
pi/runtime.js:45   argv.push("--session", session.session);  交给 pi CLI
```

`resumeSession` 不 stat 就把死路径交给 pi，pi 静默开空会话 → "开始和 agent 对话"。

## 五项

- [x] **1. state 里的旧前缀** — `patches/server/paseo-agent-cli-installer.js`
      在 `readState()` 出口按当前 `agentCliInstallRoot` 重算陈旧绝对路径。
      锚点用无歧义的 `agents/packages/<id>` 和 `agents/bin/<id>`。
      **不放宽 `isWithinRoot`**（它是安全边界，不是便利检查）。
      纯函数 `rerootAgentStatePaths(state, installRoot)` 便于单测。
      这一处同时覆盖表现 1-5：`customCommandFromState`、`customCommandExists`、
      catalog 的 `installed`、`installAgentCli` 的 `alreadyInstalled`、
      以及 `ensureNpmPackageLauncher`（修复函数本身也被同一根因挡住，第 610 行 `return false`）。

- [x] **2. 会话元数据里的 `nativeHandle`** — 上游 `agent/providers/pi/agent.js`
      `resumeSession` 里：存的路径 stat 不到时，按当前 home 重算一次，命中就用。
      走 `install.mjs` 的外科手术式补丁（照 `patchAcpAgentSystemPrompt` 的写法：
      幂等、marker 必须唯一命中、命中不到就抛错），**不整文件 vendoring**（2082 行）。

- [x] **3. pi 静默开空会话** — 同上位置，同一个补丁
      重算后仍然找不到文件 → 抛错，而不是把死路径交给 pi。

- [x] **4. shim 删除前重算** — **不是 bug，不修**
      `ensureAndroidCommandShims` 的目标全是 `/system/bin/*`、`$PREFIX/bin/*`、
      `runtime.nodeExecutable`，没有一个是 HOME 相对的，`stat` 照样成功，不会删。
      而且路径陈旧时 `ensureNpmPackageLauncher` 早在第 610 行返回了，根本走不到 shim 代码。

- [x] **5. 纵深防御** — `PaseoHome.migrateLegacyHome`
      对还没迁移的安装，搬完文件后一并重写旧前缀。
      注意：迁移末尾 `legacy.delete()`，已迁移的机器上这是空操作，
      **所以第 1 项必须能自愈已损坏的 state，不能只在迁移时修。**

## 验证

- [x] `node --test "tests/*.test.mjs"` — **223/223**（基线 216 + 新增 7）
      追加截断修复后 **225/225**（再 +2）
- [x] Android 单测 — **92 / 0 失败 / 1 跳过**（基线 90 + 新增 2），`PaseoHomeTest` 7 个全过
      Gradle 必须重定向：`./gradlew <task> > /tmp/x.log 2>&1 < /dev/null`
      否则守护进程占住 stdout 管道，后续命令全部返回空。
      构建走 ASCII 的 subst 盘（`subst X: <repo>`），中文路径会毁掉 AGP 的 native JSON。
- [x] **补丁打在真实上游文件上验过**（不是只过 fixture）
      2082 行的 `agent/providers/pi/agent.js`：marker 唯一命中、`node --check` 通过、
      跑两遍幂等（helper 1 个、调用点 1 个、旧 guard 只剩 helper 内部那一处）。
      把注入的 helper 从真实文件里切出来驱动，四种行为全对：
      旧路径重定向到迁移后的文件、活路径原样返回、真缺失抛错、空 handle 抛错。
- [x] 清理 `/tmp/pu`

---

# Claude 一直截断 — 独立根因（与 HOME 无关）

## 结论：中转在思考块之后就交不出正文，Paseo 全程不吭声

> 修订：早先写成"中转把输出压到 ~256 token"，那个说法站不住。
> 用户指出本机会话用的是**同一个供应商**、且思考几万 token 正常；
> 又查到上限不是上下文算出来的（最大一轮 29,585 + 75,471 缓存 ≈ 105k，
> 200k 窗口还剩 ~95k），所以不存在"预算被上下文挤光"。
> `max_tokens` 更像中转在思考块结束后交不出正文时贴的一个良性标签。

用户日志 `paseo-startup.log`（754 KB / 1151 行）里的事件序列：

```
content_block_start idx=0 thinking → 76×thinking_delta → content_block_stop
content_block_start idx=1 text     →  1×text_delta      → content_block_stop
message_delta  stop_reason=max_tokens  usage.output_tokens=258
message_stop
```

最终内容：`thinking` 916 字符，`text` **只有一个空格**。
`is_error: false`、`terminal_reason: "completed"`、`api_error_status: null`、`num_turns: 2`。

思考吃掉了几乎全部 258 token，正文刚开始就撞顶。
**"thinking 后没正文"和"说一半截断"是同一个故障停在不同位置。**

## 不是 Anthropic 发的响应

四条自相矛盾的证据：

| 观测 | 真 API 应为 |
|---|---|
| `msg_6bc40647e1c5479d8937e2c467f5fd68`（`msg_` + 32 位 hex） | `msg_01…` base62 |
| `output_tokens_details.thinking_tokens: 0`，却流了 916 字符思考 | 思考要计费 |
| `end_turn` 的消息报 `output_tokens: 0`（两条） | 完成一轮至少 1 |
| 258 token 撞 `max_tokens`，CLI 报模型能力 64000 | 到 64000 才停 |

Paseo 的 `ClaudeProviderOptionsSchema` **没有 maxTokens 字段**，本仓库也没有任何地方设
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`。上限不是客户端给的。

已排除（均有证据，非猜测）：`d648f97` 的 `_tui`（只管跳过尾部 `process.exit`）、
硬退出截断管道（探针两次 `lost=0`，且 Node 在 Linux/Windows 上管道 stdout 是同步的）、
`streamJsonWatcher`（无 `-p` 时根本不安装）、`extractFragments`（text/thinking 对称）、
`partial-json.js`（解析工具入参，不碰传输）。日志里 `stream ended before terminal result`、
`query_pump.exit_unexpected`、`Claude stream failed` **零命中**。

## 属于我们的缺陷：静默

- [x] **撞上限时给出可见提示** — `install.mjs` 的 `patchClaudeMaxTokensNotice`
      上游 `claude/agent.js` 4817 行里 **`stop_reason` 一次都没出现**，
      `TimelineAssembler.consumeStreamEvent` 对 `message_delta` 直接 `return []`。
      在该分支前注入：`stop_reason === "max_tokens"` 时返回一条
      `{ type: "assistant_message", text }`，形状与 `createClaudeSessionChangedNotice` 一致，
      调用方自动包成 `{ type: "timeline", item, provider: "claude" }`，不需要新通道。
      不标 `turn_failed`——那一轮确实产出了内容，标失败会丢内容。
      注意上游 1394 行另有一处 `message_delta`，在 `ClaudeContextUsageState` 里，
      只读 `output_tokens` 喂用量表、从不看 `stop_reason`，两处不冲突。

- [x] **一轮没有任何正文时也要出声** — 同一个 `patchClaudeMaxTokensNotice` 的第二处注入
      上游 `appendResultEvents` 只在 `result` **有文字**且 `output_tokens === 0` 时补救
      （那是给 `/voice`、`/usage` 这类客户端斜杠命令用的）。
      而故障轮是 `result` 为空串、`activeTurnHasAssistantText` 为 false、`subtype: "success"`，
      三个条件叠起来正好从补救里漏出去，于是静默完成。
      在 `turn_completed` 之前注入：两者都空时补一条提示，仍然照常 `turn_completed`
      （那一轮没失败，只是没产出，标 `turn_failed` 会不准）。
      复用上游已有的 `activeTurnHasAssistantText`，不新增状态。

- [x] 两处都打在**真实上游文件**上验过：各自 marker 唯一命中、`node --check` 通过、
      两遍幂等、按日志真实事件序列重放 → `max_tokens` 出提示、`end_turn` 不出；
      空轮出提示、有正文的轮不出、上游斜杠命令补救仍然优先、`subtype: "error"` 不受影响。
      两处注入各自独立判幂等，先打过一处再补另一处不会互相跳过。

- [x] **确认过两处不能合并成一处。** `SDKResultSuccess` 上有 `stop_reason` 字段，
      本来想只在 `appendResultEvents` 里读它、省掉流事件那处注入。日志实测否掉了：
      终局 result 报的是 **`stop_reason: "end_turn"`**，而 `max_tokens` 只出现在流中途的
      `message_delta` 里。终局字段跟实际发生的事不一致，所以截断必须在流里抓。
      （上游自己也从不读 result 的 `stop_reason`，全文 `message.stop_reason` 零命中。）
      空轮那处则以 `result` 为空串为主判据——实测那一轮 `result` 确实是 `''`（len=0）。
- [x] `node --test "tests/*.test.mjs"` — **226/226**

## 模拟器实测(Pixel_API_36 / SDK 36 / x86_64+arm64 翻译层)

- [x] 建包 → 装机 → 设备自己跑 `install.mjs`：指纹从 `dbd8685e…` 更新到 `4647dd18…`，
      日志出现 `Enhanced installation completed`。
- [x] 设备上的 `files/usr/lib/node_modules/@getpaseo/server/.../claude/agent.js`
      两处 marker **各命中 1 次**。
- [x] 在**设备上、对打过补丁的真实文件**重放日志里的真实形状，六项全过：

      A. max_tokens 258            → 出提示（"⚠️ 回复被截断…258 tokens…"）
      B. end_turn                  → 不出（正确）
      C. stop_reason null          → 不出（正确）
      D. 真实空轮 result='' 无正文 → 出提示（"⚠️ 本轮没有产出任何正文…"）
      E. 有正文的轮                → 不出（正确，不误报）
      F. 斜杠命令                  → 仍返回 "Unknown command: /nope"（上游补救优先）

- [x] **踩到一个静默陷阱并已记进记忆**：`subst` 必须映射**仓库根**。
      映射到 `ZeroTermux-main` 时 `stagePaseoEnhancedAssets` 报 `NO-SOURCE` 被跳过，
      **构建照样 BUILD SUCCESSFUL**，产出的 APK 里根本没有 `enhanced/`，
      设备永远不打补丁且无任何报错。带补丁 ~294 MB，漏掉的 ~262 MB。

## 客户端全链路已排除（实测，非推断）

| 层 | 查法 | 结果 |
|---|---|---|
| 官方 CLI | 本地日志代理抓原生请求 | `max_tokens=64000`（`SXS(h, vXS)`，`vXS` 是常量，非算出） |
| `@bash0816/claude-code@2.1.237` | `npm pack` 解包全文扫 | token/model/thinking **0 命中**；只做 Bun→shim 等兼容改写；下载的是官方 `@anthropic-ai/claude-code-linux-arm64` |
| 我们的 `patchAndroidClaudePackage` | 读源码 | 只改路径前缀 + stream-json 保活 |
| Paseo server 全量 dist | 解 tarball 全量 grep | `MAX_OUTPUT_TOKENS` / `MAX_CONTEXT_TOKENS` **0 命中** |
| `start-paseo.sh` | grep export | 只 `export PATH` |

**客户端没有任何一层压低 max_tokens。64000 原样上线。**

## 作废：我关于中转的两条结论都不成立

- ~~"中转按 max_tokens 预扣配额、余额不足时压低到 258"~~
  **从未观测到压低。** 只看到余额 $0.074 时它直接 403（`need quota: $0.345540`）。
  "压低到 258" 是我的推断，没有证据。用户指出：中转不可能压低。

- ~~"中转强制插思考块、剥掉内容、照扣预算"~~
  这个观测到了，但**探针没带 CLI 的 beta 头**
  （真 CLI 送 `claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,`
  `mid-conversation-system-2026-04-07,effort-2025-11-24,fallback-credit-2026-06-01`）。
  用户指出我自己就跑在同一个中转上、思考完全正常 → 带对头就没这现象。
  **所以那是我的请求形状错了，不是中转的行为。**
  违反了用户早就定下的规矩：用哪个 CLI，请求就完全照那个 CLI 的原生形状发。

## 新中转 api.zzzcoding.org：两种形状都无法复现截断

用真 CLI 经 tee 代理（请求形状零改动）在新中转上跑同一道题：

**形状一 `claude -p`：**
```
请求 max_tokens=64000  output_config={"effort":"max"}  tools=22
响应 thinking 1639 字符（真流出来）signature=PRESENT
     text 652 字符   stop=end_turn   output_tokens=1065
```

**形状二（Paseo 实际走的）`--input-format stream-json --output-format stream-json`：**
```
thinking 1186 字符 → text 665 字符 → stop_reason=end_turn
result len=665（非空）  output_tokens=1465  thinking_tokens=0
```

两种形状、500 字长文、~27k 输入，**全部完整交付，没有任何截断**。

### 我那四条"响应不是 Anthropic 发的"证据，三条已塌

| 当初的"证据" | 实测真相 |
|---|---|
| `message_start` 与 `message_delta` 的 input_tokens 对不上 | **正常**。前者预估、后者最终带缓存核算。健康回合里原样出现（24354/0 → 4614/26033） |
| 有思考内容却 `thinking_tokens: 0` | **正常**。健康回合里 1186 字符思考 + `thinking_tokens: 0` |
| `msg_` + 32 位 hex 不像 Anthropic 格式 | 常见写法（`randomUUID().replace(/-/g,'')`），证明不了任何事 |
| 终局 result 报 `end_turn`、流里却是 `max_tokens` | **仍未解释**，但无原始日志无法复核 |

### 客户端参数也已排除干净

Agent SDK 支持 `--max-budget-usd` 与 `--max-thinking-tokens`（这两个能反推出小 max_tokens），
但 Paseo **两个都不传**。`maxThinkingTokens` 在 `agent.js:281` 仅用于日志汇总，从不赋值。
（web-ui 里出现 `--max-budget-usd` 只是终端 profile 的参数白名单，与 agent 调用无关。）

## 当前诚实状态：258 的来源仍未定位

已知：客户端送 64000，响应报 `stop_reason=max_tokens` / `output_tokens=258`。
两者对不上，而客户端各层都已排除。

**本会话拿不到原始日志**（`paseo-startup.log` 不在仓库里），
所有关于 258 的推理都建立在上一轮会话的摘要上，无法复核。这是最大的短板。

### 又一条印证：`effort` 的位置我一直是错的

抓包代理在本机跑通后，抓到真 CLI 的完整请求形状：

```
>>> max_tokens = 64000
model    = claude-opus-5
thinking = {"type":"adaptive"}   effort=(none)
extra    = output_config: {"effort":"max"}
system   = 9611 chars   tools=22   stream=true
ua       = claude-cli/2.1.239 (external, claude-desktop-3p, agent-sdk/0.3.246)
betas    = claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,
           mid-conversation-system-2026-04-07,effort-2025-11-24,fallback-credit-2026-06-01
```

- **`effort` 不在 `thinking` 里，是顶层 `output_config: {effort: "max"}`。**
  我的探针把它写成根级 `effort: "high"` —— 中转不认的形状。
  探针里"思考回来 0 字符"很可能就是这个造成的，进一步坐实那批数据不可用。
- beta 头含 **`fallback-credit-2026-06-01`**；CLI 二进制里有对应处理
  `if (k && "fallback_credit_token" in k) delete k.fallback_credit_token`。
  官方对"额度回退"有专门机制。与额度直接相关，但**不等于**"压低 max_tokens"，
  暂列线索，不下结论。

**工具已就绪**：`D:/cache/capture-only.mjs`（只记录不转发，请求侧零成本）。
本机已用真 CLI 验证可用：`ANTHROPIC_BASE_URL=http://127.0.0.1:8788` +
任意假 key → 日志正确抄下 `max_tokens=64000`，CLI 收到 400，中转从未收到请求。

**零成本的决定性下一步**：只记录不转发的抓包代理。
记下请求体里的 `max_tokens`、`thinking`、beta 头之后直接返回错误、不发给中转
→ **不消耗任何额度**，但能确定安卓那条路真实送出的 max_tokens 是多少。
手机侧只需把 Paseo 的 Claude agent 指向 `http://127.0.0.1:8788`（配合 `adb reverse`）。

## 历史记录：探针数据（形状不对，仅存档）

用本机真 CLI + 本地日志代理抓到的原生请求（一个字节没改）：

```
POST /v1/messages?beta=true
model=claude-opus-5  max_tokens=64000  stream=true
thinking={"type":"adaptive"}  effort=(none)  tools=22
```

`max_tokens` 是 **64000**（CLI 内部 `SXS(h, vXS)`，`vXS` 是常量 64000，
不由上下文算出）。所以 258 绝不是客户端给的。

中转的响应把机制说穿了：

```
403 token quota is not enough,
    token remain quota: $0.074792
    need quota:         $0.345540
```

**中转在请求执行前就按 `max_tokens` 全额预扣配额。** `$0.3455` 与用户失败那轮的
`total_cost_usd = 0.354` 基本重合 —— 那轮"花掉"的钱不是实际生成量，是预扣额度。
余额充裕时（本机会话）毫无感觉；余额见底时预算被压到买得起的数，就是 258。

叠加第二个因素（已实测）：**中转强制插入思考块，客户端关不掉。**

| 请求 | thinking 到达 | 正文 | stop_reason | output_tokens |
|---|---|---|---|---|
| max_tokens=1200, 送 adaptive+effort | 0 字符（signature 在） | 75 字 | max_tokens | 1200 |
| max_tokens=1200, **完全不送 thinking** | 0 字符（块照样出现） | 130 字 | max_tokens | 1200 |
| max_tokens=1200, 非流式 | 0 字符 | **26 字** | max_tokens | 1200 |
| max_tokens=3000, 不送 thinking | 0 字符 | **723 字** | **end_turn** | 2080 |

思考稳定吃掉 ~1150–1350 token，内容被剥掉只留空信封，预算照扣。
预算 1200 → 正文分不到；预算 3000 → 正文拿到剩下的 ~730，整篇写完。
用户那轮预算 258、思考 916 字符、正文一个空格 —— 同一个故障停在更早的位置。

已推翻的自己的两个说法：
- ~~"中转交不出正文"~~ —— 太重了。用户指出我自己就跑在同一个中转上，
  思考几万 token、长回复全正常。中转没坏，是**预算小的时候**才要命。
- ~~"output_tokens 精确等于 max_tokens 说明数字是编的"~~ —— 撞顶时二者相等是定义使然，
  不是异常。这一步我读错了。

仍属推断、未直接观测：**中转把 max_tokens 压到余额买得起的数**这一步。
我只看到余额 $0.074 时它直接 403，没亲眼看到它静默压低。258 与"被饿死的预算"吻合，
但没有直接证据。

## 客户端可做的硬化（有取舍，待定）

`CLAUDE_CODE_MAX_OUTPUT_TOKENS` 是 CLI 认的开关（二进制里 `yQt` 读它，
撞顶时的报错自己也点名它）。设成 8000：预扣从 $0.345 降到 ~$0.043（8 倍），
小余额不再崩；强制思考吃掉 ~1350 后还剩 ~6600 给正文，足够。
代价：直连官方 API 的用户单轮输出上限也从 64000 降到 8000。
**这个取舍要用户定，没有替他决定。**

## 仍待用户侧确认

确切来源在中转服务端，日志只记 SDK 事件、抓不到 HTTP 请求体（`"max_tokens":` 零命中），
客户端无法自证。已确认的事实：

- 撞顶那轮之后**连着两轮什么都没产出**：一条 `end_turn` / `output_tokens: 0`，
  再一条连 content block 都没开；最终 `is_error=false num_turns=2`、
  `stop_reason="end_turn"`、`api_error_status=null`，
  给用户看到的正文是 `''`（len=0）。真的预算封顶不会让后面两轮也空掉。
- 那一轮 `duration_ms=27212`、`total_cost_usd=0.354`。
  **花了 27 秒、计了 0.354 美元，交付给用户的是空字符串。**
- 同一轮内 `message_start` 报 29,585 input / 0 缓存，`message_delta` 报 2,485 input /
  36,823 缓存创建——中转自己的用量账本前后不一致。
- 日志里只有 `claude-opus-5` 一个模型，没有第二个模型混入。

**下一步（用户侧）**：先确认手机上那个 key 的余额。测试 key 实测只剩 $0.074，
按 $0.345/轮 预扣，连一轮都开不起。若手机用的是同一个 key 或同样接近见底的额度，
充值即可恢复，不需要改代码、不需要重新编译。

关 thinking 这条路已实测无效：**不送 thinking 参数，中转照样插思考块并照样扣预算。**
Paseo 的 Thinking mode 选择器（`setThinking` RPC / `update_agent` → `setAgentThinkingOption`）
改不动中转的行为，不用白试。

---

## 模拟器端到端实测（新中转 api.zzzcoding.org）

**结论：整条链路在模拟器上跑通，两种 CLI 形态都不截断。** 截断复现不出来。

| 形态 | thinking | 正文 | result | 结尾 |
| --- | --- | --- | --- | --- |
| `claude -p` | 872 字 | 579 字 | `success` / `is_error=false` | 完整句，三段齐 |
| Paseo 实际形态<br>`--input-format stream-json --output-format stream-json --verbose` | 1064 字 | 793 字 | `success` / `is_error=false` | 完整句，四段齐 |

stream 形态 usage：`input 2356 / cache_creation 29622 / output 1116`。
两轮都要求"不少于 500 字"，都超额交付，没有半句而止。

配置实测值（`/api/paseo-manager?action=providers`）：
`apiProtocol=native`、`baseUrl=https://api.zzzcoding.org`、`model=claude-opus-5`、
`apiKeyConfigured=true`、`envKeys=[ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL]`、
`status=ready`。`contextWindowMaxTokens=null`（没有任何客户端上限）。

Paseo 生成的 `paseo-cli` 包装脚本只导出路径类变量
（`PATH/PREFIX/HOME/TMPDIR/TERMUX_*/DPKG_ADMINDIR/CLAUDE_TERMUX_STDIN=inherit/MAGI_*`），
**零个 token / model / thinking 变量**——包装层已彻底排除。

### 顺带修掉的两个真问题

1. **`provider-cli-install` 可以直接打**：`POST /api/paseo-manager`
   `{"action":"provider-cli-install","providerId":"claude"}`，经
   `adb forward tcp:16777 tcp:6777` 从宿主机就能调，不用手搓 runtime 对象。
   装好返回 `installed=true / version=2.1.237 / status=installed`。
2. **模拟器上 `prepare-native.js` 必然失败**：它跑裸 `tar -xzf`，而 AVD 的
   arm64 转译层要 `realpath(argv[0])`，basename 解析不了，报
   `Unable to get realpath of tar`。Termux 自己的 bootstrap 脚本记录了同一条错误，
   并注明这是"arm64 rootfs 跑在 x86_64 AVD"的产物——**模拟器专属，不是真机 bug，
   不要为它改真机代码路径**。绕过办法：预放官方二进制到
   `$HOME/.claude-termux-native-package/versions/2.1.237/app/node_modules/@anthropic-ai/claude-code-linux-arm64/claude`，
   `prepare-native.js` 见到该文件就提前 `exit(0)`。
   已用官方 tarball 落地，sha256 `6d4e8bad…a2c0` 与审计清单
   `claude-native-audited-versions.json` 完全一致，`--version` 返回 `2.1.237 (Claude Code)`。

### 仍然待办

- ~~`openai-compatible` 给 Claude 用是静默坏配置~~ —— **作废，我读错了。**
  `paseo-provider-config.js:354` 有 `NATIVE_ONLY_CLI_FAMILIES = new Set(["claude"])`，
  `forceNativeCliEnvironment`（:381）在 `prepareProviderOverridesForRuntime` 里
  先把所有协议的环境变量删掉，再把值按 **native 名字**（`ANTHROPIC_*`）写回去，
  base URL 还过一遍 `anthropicRootBaseUrl` 剥掉 `/v1`。
  `tests/paseo-provider-config.test.mjs` 有两条用例锁死这个行为（"the Claude CLI is
  always configured natively" 和 "receives the Anthropic API root"），24/24 通过。
  **这里没有 bug，不用改。**

### 但由此得到一个可检验的截断假设

那份 `openai-compatible + OPENAI_BASE_URL=https://ps.air-outer.com/v1 +
OPENAI_MODEL=glm-5.3` 的配置，经上面的翻译，实际交给 CLI 的是：

```
ANTHROPIC_BASE_URL = https://ps.air-outer.com     ← /v1 被剥掉
ANTHROPIC_MODEL    = glm-5.3
ANTHROPIC_API_KEY  = <key>
```

也就是说：**Claude CLI 用 Anthropic 的 `/v1/messages` 线协议，去要一个 `glm-5.3` 模型。**
中间必然有一层把 Anthropic 协议翻成 GLM 的转换 shim。一个没把长 SSE 流、
`thinking` 块、`content_block_delta` 边界处理干净的 shim，产出的正是
"thinking 之后没正文"和"说一半截断"——和用户描述的两种症状完全对上。

这与已确认的事实一致：客户端整条链干净（官方 CLI 恒发 64000）、
换成真 Anthropic 上游（api.zzzcoding.org）之后两种形态都不截断。

**注意**：模拟器上那份 glm-5.3 配置是我自己上一轮测试留下的，**不是**用户手机的证据。
所以这只是假设，需要用户确认手机上 Claude 那一栏的 base URL 和 model 到底填的是什么。
若手机也是"Claude CLI + 非 Anthropic 模型"的组合，换回真 Anthropic 上游即可，不用改代码。
- 截断仍未复现。剩下唯一可查的方向是把手机上的日志级别从 `info` 调到能记请求体，
  否则"258"只能停留在上一轮会话的摘要里，无法复检。
