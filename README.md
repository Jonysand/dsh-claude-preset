# Claude Code preset for DeepSeek Harness

把 Claude Code 的会话行为复刻成 DeepSeek Harness（DSH）的 agent preset，id 是 `claude-code`。

依据是 [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) 里整理的 Claude Code 会话装配代码：
`src/constants/prompts.ts` 那套按固定顺序拼装的 system prompt、工具清单，以及压缩检查点的摘要结构。

## 它由四部分组成

| 部分 | 做法 | 文件 |
|---|---|---|
| 系统提示词 | 照抄静态段（Intro / System / Doing tasks / Executing actions with care / Using your tools / Tone and style / Output efficiency），只把工具名换成 DSH 的，文件引用改成 DSH 渲染得出来的写法 | `cordis.patch.yml` |
| 工具面 | 只挂 Claude Code 有对应物的工具；宿主层多出来的工具在 preset 挂载时逐个 `restrict` 挡掉 | `lib/tool-surface.js` |
| 工具延迟 | 装配时把点名的工具从工具表摘掉，模型看不见但按名字仍可调用；`tool_search` 负责把 schema 取回来 | `lib/tool-search.js` |
| 压缩摘要 | 把 compaction 的摘要指令换成 Claude Code 的检查点结构：新增 `## All User Messages`，把 `## Pending Jobs` 改名 `## Pending Tasks` 并扩写 | `lib/compaction-claude.js` |

`persona.complete` 保持 `false`：Claude Code 自己也读 CLAUDE.md，所以 AGENTS.md 全局规则、技能目录、
运行时上下文（工作目录、时间）都保留，这比把 system prompt 裁成单独一段更接近它的真实行为。

## 工具对照

| Claude Code | 本 preset |
|---|---|
| Bash | `pwsh`（Windows）/ `bash`（其它平台） |
| Read / Write / Edit / NotebookEdit | `read` / `write` / `edit` / `read_image`（无 NotebookEdit 对应） |
| Glob / Grep | `glob` / `grep` |
| TodoWrite | `todo_write` |
| Task / TaskOutput / TaskStop | `subagent`、`subagent_fork` / `send_message`、`list_agents` / `interrupt_agent` |
| BashOutput / KillShell | `job_list`、`job_output` / `job_kill`（后台 shell 作业） |
| WebSearch / WebFetch | `web_search` / `web_fetch` |
| Skill | `skill` |
| AskUserQuestion | `ask_user_question` |
| EnterPlanMode / ExitPlanMode | 计划模式 + `exit_plan_mode` |
| 自动压缩 | `compaction-basic` + `/compact` |

`present`、`goal` 三件套、`schedule_*`、`workflow`、`cordis_inspect_*`、`plugin_manager`
都是后补挂上的。前五个在 Claude Code 里各有对应物（SendUserFile、`/goal` + Stop hook、
CronCreate、Workflow 工具），语义一致；`plugin_manager` 与 `cordis_inspect_*` 没有对应物，
是纯 DSH 能力，按你的要求一起开了。

除 `present` 放进延迟名单外，其余都在工具表里（不在 `defer`），因此第一轮被引导相位挡住，
第一次工具调用之后直接可见。两点代价要记住：

- `goal` 一旦建起来，宿主层的 `dsh-goal-round-driver` 会自动续跑，最多 40 轮——这是行为
  变化，不是工具表变化。
- `plugin_manager` 能让模型改本 profile 的插件配置，官方 `standard` preset 里这一行是
  `disabled: true`，这里主动打开了。

`working_directory` 不在上面这一串里：它由宿主层的 `dsh-tool-working-directory` 提供，
本 preset 只负责不挡它。首轮看不见（引导相位只留两个工具），晋级之后常驻。

## 工具面怎么收敛

不再收敛。`lib/tool-surface.js` 现在只做审计：`request/header` 一变就输出一行——工具数、
工具块字节、按 4 字符/token 粗估的 token、这次相比上次增删了谁。工具块在请求最前面，任何
字节变化都会让缓存从该 token 起失效，这行就是那次失效的凭证。

```
[tool-surface] baseline #1: <工具数> tools, <字节> bytes (~<tokens> tok est) | session <id>
[tool-surface] change #2: ... | +glob | -skill | cache: reuse invalidated from the first changed tool token
```

这个文件早先负责挡住一批宿主工具，2026-10-24 全清：

| 原拦截项 | 当时的真实情况 |
|---|---|
| goal 三件套、`workflow`、`plugin_manager`、`schedule_*`、`cordis_inspect*`、`load_workspace_dependencies` | 宿主层把这些行设成 `disabled: true`，模型看不见它们靠的是「没人挂」，拦截从来没生效过 |
| `working_directory` | 唯一真正被挡的。现已放开，首轮被引导相位挡住，晋级之后常驻 |

要重新挡一个工具，三条约束记在 `lib/tool-surface.js` 文件头：`restrict` 只认全局层的名字、
必须在第一次装配之前调（晚一步就是一次全前缀重建）、被挡的名字拿不回 schema 所以和延迟互斥。

## 工具延迟

`lib/tool-search.js` 做两件事，两半同生共死：

1. **摘工具**：每轮装配时把 `config.defer` 点名的工具从工具表里摘掉。摘掉只影响模型看见
   什么：执行从 registry 解析（`dsh-tools` 的 `resolveExecution`），不看这份装配结果，
   所以模型按名字调用照样能跑。
2. **找回**：注册 `tool_search`，按名字或关键词查出这些工具的完整 JSON Schema，以
   `<functions>` 块放进工具结果。拿到之后模型直接按名字调用，不需要包装工具。

发现工具注册失败时整层不启用——工具被摘掉却找不回来，那是不可恢复的坏状态。

引导相位（`bootstrapTools`，本 preset 开着）：第一次请求只暴露 shell 加
`str_replace_editor`，其余全摘，`tool_search` 自己也不留——这一轮没有东西可搜，留着只会
误导。等这个会话落下第一次持久的工具调用、或者进到第 2 轮，之后才晋升成上面那套延迟表。
只看工具调用会留一个洞：第 1 轮如果只回文字、一次工具都不调，窄表会一直留着，第 2 轮要
读文件才会发现 `read`/`grep` 都不在表上。引导相位锚的是第一次请求，第 2 轮已经出了它的
范围，所以轮次一到就退场。

为什么：模型会用第一轮看见的工具目录锚定接下来怎么干活，所以要给的是**最小的那面**。方向
别接反：dsh-TUI 在 V4 Pro 上测的是「Minimal 那对 5/5 落在 Minimal 轨迹，standard 系 schema
11/11 掉回 standard 式行为」（见 [2.14](docs/deferred-tools-gaps.md)），给全表恰好是失败的
那一侧。

同一个相位还会剥掉首步的自动注入，按**路径**剥而不是按来源名字剥。两条入口：装配路径把
`assembled.contexts` 整段清空（覆盖沙箱/审批快照和任何第三方上下文提供者，不需要点名）；
步骤路径只保留本轮从 inbox 认领的消息批次加 `bootstrapAllowKinds`（默认
`skill-invocation`，用户主动点的技能不是自动注入），其余无论是谁追加的都剥。晋级之后照常
注入，第一轮没生成的 runtime-context 由循环自己的差分投影在下一个请求补上。

两条实测边界，接的时候踩到过：

- **`assembled.contexts` 会被循环重新推导。** 请求装配前 `dsh-agent-loop` 会调
  `refreshContext(assembly, …)`，它按 provider 重算，只保留 `required: true` 的那几条。
  所以清空只对非 required 生效：沙箱策略、审批策略、harness 路径这些首轮消失，工作目录
  那条（`dsh-working-directory` 标了 `required`）永远在。本机实测首轮 runtime-context
  从 662 字节降到 179 字节。
- **`prepend` 只是"注册时插到链首"。** 同层里最后注册的最外层；本插件是本地模块，比核心包
  import 慢，只注册一次就可能被别人套在外面——`dsh-time-context` 也 prepend、也在 `next()`
  之后追加消息。所以第一次真正处于引导相位的装配之后再 prepend 一次，抢回链首。

代价是首轮模型看不到沙箱与审批策略（约 480 字节，cwd 仍在）。它手上就是 shell，不接受就
把 `bootstrapSuppressRuntimeContext` 设 `false`，只保留步骤路径那条。

shell 按平台二选一，照官方 minimal preset 的写法：POSIX 是 `bash`，Windows 是 `pwsh`。

子代理不走这个相位。判定按 `delegationDepth > 0`（会话头与运行时 `options.subagentDepth`
取较大者），子代理开局直接就是延迟表，也不剥上下文——它们被派出去时通常马上要
`read`/`grep`/`web_search`。参考实现的 `includeSubagents` 也默认 false（他们自己那个 preset
开成 true）。

相位从会话事件重建，不是进程内状态：恢复会话时扫一次历史，压缩不重置。所以一个会话只会
多这一条 `request/header`。

名单分两类：

- `defer`（精确名字）：`web_fetch`、`read_image`、`job_list`、`job_output`、`job_kill`、
  `list_agents`、`interrupt_agent`、`send_message`、`subagent_fork`、`subagent`、`glob`、
  `skill`、`advanced_search`、`multi_search`、`platform_search`、`free_search_test`、
  `str_replace_editor`、`present`
- `deferPatterns`（按类）：`mcp__*`。只认一个 `*`。MCP 工具名是 `mcp__<server>__<tool>`，
  数量随 server 变，只能按模式表达；本 preset 目前没有 MCP server，这条是给将来留的。

`str_replace_editor` 是引导相位的第二个工具：只在这一轮出现，晋级后收起来，真要用时由
`tool_search` 取回。dsh-TUI 那条实测的首轮工具对就是 shell 加它；官方 0.2.1 的 minimal 已经
不含编辑器（自 0.1.3-alpha.2 起 opt-in），所以这里自己挂了一行。

`present` 交付文件用：把已有文件做成用户可点开的卡片。Claude Code 里对应 SendUserFile，
语义一致，所以挂上了；因为低频，放进延迟名单——模型要交付时先
`tool_search select:present` 拿 schema，再按名字调用。

`advanced_search`、`multi_search`、`platform_search`、`free_search_test` 这四个是 free-search
的检索工具，合计 2,984 字节。它们原来在 `tool-surface` 的拦截名单里，结果是模型照 `web_search`
描述末尾点的名字去搜，搜不到，白花一次往返（实测见 2.14）。现在改成延迟：平时不出现在表里，
模型想换引擎时 `tool_search` 能搜到、拿到 schema 再调用。

挑的原则：一旦被延迟，首次使用要多花一次 `tool_search` 往返，所以高频的 `read`、`edit`、
`pwsh`、`grep`、`web_search` 一律常驻。系统提示点名要求使用的工具（`todo_write`）同样常驻：
实测模型手边有替代品时，宁可拿 `pwsh` 凑合，也不会为它多花一次往返。`tool_search` 的描述
里会把名单全列出来，模型才知道有什么可查。要关掉就删掉 `config`。

实测（真实会话）：

- 名单 5 个：工具表 22 → 18，工具块 17,222 → 16,310 字节。模型 `select:web_fetch` 拿到
  schema 后，下一轮直接调用 `web_fetch`——一个不在请求 `tools[]` 里的工具——执行成功。
- 名单 9 个：工具表 22 → 14，工具块 13,391 字节。`/compact` 把 schema 压掉后，模型自己
  重搜一次，拿到同一份 schema 再调用，照样成功。
- 名单 14 个：工具表 22 → 9，工具块 9,925 字节。同一场里 `todo_write` 和 `glob` 没被搜出，
  被 `pwsh` 替代了，所以 `todo_write` 已挪回常驻。
- 名单 13 个：工具表 22 → 10，工具块 10,925 字节。一场 70 步、88 次调用的会话里工具表
  一次没变（全场只有一条 `request/header`），延迟的 `subagent` 用了 4 次、`send_message`
  用了 1 次，都是拿到 schema 之后按名字直接调用。
- 相位打开后（2026-10-24）：一场 20 步、37 次调用的会话是两条 `request/header`——首轮
  22 个工具、17,222 字节，之后 10 个、10,925 字节。这一场跑的是**接反**的那一版（首轮给
  全表），现已翻成首轮最窄。可用的观察是：晋级那一刻整张表换掉，模型照样把被延迟的
  `web_fetch` 搜出来用了 23 次，没有一次失败——切换本身不打断工作。
- 掉头之后（2026-10-24，会话 `3d7c5f13`）：首轮 2 个工具、6,609 字节，晋级后 10 个、
  11,000 字节，之后 34 次请求没再变。第 1 步只带 `user`/`runtime-context`/`time-context`
  三条消息，技能目录和工作区指令都等到第 2 步才注入。首轮一句话就直接 `pwsh` 抓日志，
  没有去找当轮不存在的 `read`/`edit`/`todo_write`。

数据见 [docs/deferred-tools-gaps.md](docs/deferred-tools-gaps.md) 2.9、2.10、2.13、2.14。
前四条是打开相位之前跑的，那时全场只有一条 `request/header`；第五、六条是打开之后跑的，
第五条方向接反，第六条是掉头之后。

注意这只在缓存的 0.1x 档位上省，**净收益 = 被延迟 schema 之和 − `tool_search` 的开销**，
所以这套东西真正的回本点是 MCP 那种几万字符起步的工具包。

搜索对 MCP 有两条专门处理：`select:<裸工具名>` 能选中 `mcp__<server>__<tool>`
（重名就都给出来）；关键词按 `mcp__server__tool` 切段，`+rea` 这类必选词按整段比，
不会被 `create` 里的 "rea" 误命中。

为什么在装配处摘、而不是用 `deferLoading`：模型可见的 tools 由装配决定，而 `dsh-llm` 在
路由没有 `toolUpdate` 能力时会把 `deferLoading` 剥掉、把工具全发出去。那条路在非 Anthropic
路由上静默失效。装配层摘掉是路由无关的。

作用域不用担心：监听器和工具都挂在 preset 自己的插件树上，只对本 preset 代际的会话生效，
同进程里别的 preset 不受影响（实测见 [docs/deferred-tools-gaps.md](docs/deferred-tools-gaps.md) 2.8）。

## 技能目录

`dsh-tool-skill` 会把每个 skill 的名字和截断后的描述拼成一段 `<system-reminder>` 塞进历史，
从第一轮起就跟着每次请求走。本工作区 28 个 skill 合计 8,966 字节，描述占 7,543（85%），
名字只有 419。

配置里把 `catalogDescriptionMaxLength` 从默认 500 压到 120，目录降到约 6.1 KB。描述第一句的
长度中位数 63 字、p90 138 字，120 保得住绝大多数条目的第一句——超过 120 的通常是末尾那串
触发条件，而名字本身已经把话说清（`jenkins-auth`、`tracy-analysis`、`crash-fix`）。

不加按需搜索的理由：技能用得很少，但用上的时候是一步到位。80 场会话、约 9,500 次工具调用里
`skill` 只出现 11 次（0.12%），全部落在 seq 18–30，直接按目录点名，没有一次弯路。换成
「先搜再取」会让这 11 次各多一步，而目录本身一行配置就能砍掉三成。评估过程见
[docs/deferred-tools-gaps.md](docs/deferred-tools-gaps.md) 2.15。

## 安装

前提：DSH 与这些包同版本，当前为 `0.2.1-rc.2`。依赖清单见 [docs/dependencies.md](docs/dependencies.md)。

1. 把本仓库放到任意目录，例如 `F:\OH-WorkSpace\DeepSeek\dsh-claude-preset`。
2. 在 profile 的 `package.json` 里加一条 link 依赖，并把包名加进 `dsh.profile.bundles`：

   ```json
   {
     "dependencies": {
       "dsh-claude-preset": "link:F:/OH-WorkSpace/DeepSeek/dsh-claude-preset"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-claude-preset"]
       }
     }
   }
   ```

3. 装进 profile：

   ```powershell
   dsh plugin --profile <profile> install
   ```

4. 重启 DSH。新建会话时在 preset 列表里选 **Claude Code**；想设成默认，在 profile 的
   `cordis.patch.yml` 里改 registry：

   ```yaml
   - id: agent-preset-registry
     config:
       default: standard
       selectedDefault: claude-code
   ```

`selectedDefault` 是易变配置，进程重启后可能回到 `default`；要长期生效就改 `default`。

## 验证

```powershell
# 1. 组合能否解析：输出里应出现 preset-claude-code 行
dsh --profile <profile> --dump-config | Select-String 'preset-claude-code'

# 2. 隔离 profile 冒烟：应打印 restrict 行、不报 agent-preset/invalid
$env:DSH_HOME = "$env:TEMP\dsh-smoke"
dsh --profile <临时 profile> "reply ok"
```

真实会话的核对点是会话日志里的 `request/header` 事件：`data.header.tools` 就是模型当轮看到的工具表。

## 测试

`lib/` 下三个插件的逻辑都有单测：装配改写、通配与裸名选取、工具面拒绝名单与补扫、
压缩指令替换与引用计数。零依赖，用的是 Node 自带的 test runner：

```powershell
node --test        # 或 pnpm test
```

测试拿假 `ctx` 直接调用插件的 `apply()`，不启动 DSH；插件打到 stderr 的日志被收进断言里，
所以跑起来是安静的。当前 22 项。

## 已知差异与限制

- **preset 是 revision 级，不是会话级**。插件树按 preset 定义挂一次、所有会话共用；挡住或放开
  都作用于整个进程，直到重启或预设重载。
- **不做延迟加载**。DSH 当前路由（pi-ai + openai-completions）没有会话中改工具的协议能力，
  取回工具必然改工具表、必然整体失效前缀缓存。实测一次变化约等于 7 个普通轮次，回本要 15~20 轮。
  设计与实测数据在 [docs/deferred-tools-gaps.md](docs/deferred-tools-gaps.md)。
- **压缩摘要指令是整段替换**，不是拼接。上游改文案时这里要同步，否则会丢新版规则；
  匹配不到基础指令时原样放行，不会弄坏请求。上游的 `## Pending Jobs` 是被**有意改名**成
  `## Pending Tasks` 的（名字跟 Claude Code 的压缩提示一致），不是漏抄。
- 包装 `ctx.llm.stream` 用引用计数：多个作用域或前后两版预设先后挂载时只包一次，
  最后一个卸载才还原，避免「新版先挂、旧版后卸」把补丁带走。
- 没有 NotebookEdit 对应工具；`Read` 对 PDF 的支持 DSH 没有。
- 权限提示不在 preset 里做，用 DSH 的 permission preset（`danger-full-access` 等）。
- **压缩补丁是进程级的，但按会话判定**。`ctx.llm` 是宿主单例，补丁在 preset 挂载时（进程启动）
  就装上；每次压缩请求都会按发起它的 agent 绑的 preset 判定一次，只改 `claude-code` 会话，
  其它 preset 原样透传。判定不了时按旧行为处理并打一行 warn。
- **只依赖 DSH 本体，不依赖任何第三方插件**。profile 里另外挂的插件不归 preset 管：它们的工具会被
  挡掉，但它们自己往 system prompt 里加的说明照常进提示词。核对方法见
  [docs/dependencies.md](docs/dependencies.md)。

## 目录

```
cordis.patch.yml               preset 定义：prompt + 插件行 + isolate 分组
package.json                   bundle 清单（dsh.bundle.patch 指向 cordis.patch.yml）
lib/tool-surface.js            工具面收敛 + 工具表审计
lib/tool-search.js             工具延迟：装配时摘工具 + tool_search 找回
lib/compaction-claude.js       压缩摘要结构扩展
test/                          三个插件的单测（node --test，零依赖）
docs/dependencies.md           依赖清单与校验结论
docs/deferred-tools-gaps.md    延迟加载为什么放弃（含实测数据）
docs/plugin-config-audit.md    DSH 各工具包的可配置项审计（19 个包）
docs/archive/tool-search.js    废弃的 tool_search 实现，仅作设计留档
docs/archive/request-probe.js  作用域探针（Step 0 用毕归档，可重新挂载）
```

## 来源

- 会话装配与工具清单：[NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha)
- 工具命名与运行时：DeepSeek Harness `0.2.1-rc.2`

## 许可证

本仓库的代码与文档用 MIT，见 [LICENSE](LICENSE)。

`cordis.patch.yml` 里的 persona 文本是 Anthropic Claude Code 的 system prompt 副本
（经 cc-haha 转写，只改了工具名和文件引用写法）。MIT 只覆盖本仓库原创的部分，
这段文本的再分发条件以 Anthropic 的条款为准。
