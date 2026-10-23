# Claude Code preset for DeepSeek Harness

把 Claude Code 的会话行为复刻成 DeepSeek Harness（DSH）的 agent preset，id 是 `claude-code`。

依据是 [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) 里整理的 Claude Code 会话装配代码：
`src/constants/prompts.ts` 那套按固定顺序拼装的 system prompt、工具清单，以及压缩检查点的摘要结构。

## 它由三部分组成

| 部分 | 做法 | 文件 |
|---|---|---|
| 系统提示词 | 照抄静态段（Intro / System / Doing tasks / Executing actions with care / Using your tools / Tone and style / Output efficiency），只把工具名换成 DSH 的，文件引用改成 DSH 渲染得出来的写法 | `cordis.patch.yml` |
| 工具面 | 只挂 Claude Code 有对应物的工具；宿主层多出来的工具在 preset 挂载时逐个 `restrict` 挡掉 | `lib/tool-surface.js` |
| 工具延迟（暴露层） | 装配时把配置点名的工具从工具表摘掉，模型看不见但按名字仍可执行；默认一条不摘 | `lib/tool-search.js` |
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

刻意不挂 `workflow`、`goal`、`schedule`、`present`。它们在 Claude Code 里有对应物
（Workflow 工具、`/goal` 加 Stop hook、CronCreate、SendUserFile），但在 DSH 里语义不同：
goal 会自动续跑最多 40 轮，workflow 走 PTC 编排，挂上会改变行为而不是复刻行为。

## 工具面怎么收敛

`lib/tool-surface.js` 的名单在文件顶部：`EXCLUDED_TOOLS` 是名字，`EXCLUDED_PATTERNS` 是前缀。
挡的是这些：`create_goal` / `get_goal` / `update_goal`、`workflow`、`working_directory`、
`plugin_manager`、free-search 的四个检索工具、`load_workspace_dependencies`，以及
`cordis_inspect*`、`present`、`schedule_*`。

两件事值得说明：

1. **不用维护完整名单**。`schemas()` 不带 scope 就是全局视图，列出的都是 `restrict` 能收窄的
   全局工具；preset 自己注册的 scoped 工具根本不在这个列表里，不会被误挡。名单只写要挡的
   宿主工具即可。
2. **只在挂载时扫一次**。agent loop 的顺序是「装配工具 → `agent/pre-step` → 记 `request/header`」，
   在 pre-step 里挡工具只能改变下一轮——那正好制造一次工具表变化、一次全前缀重建
   （本机实测 7,090 input token，等于 7 个普通轮次）。晚注册的工具（桌面端的
   `load_workspace_dependencies`）就留在表里，比付一次重建便宜。唯一的例外是挂载时压根没拿到
   工具表：那时什么都没挡住，`agent/pre-step` 会补扫一次。

**挡掉多少取决于组合**，这点容易被名单误导：

| 组合 | 实际被挡的 |
|---|---|
| `base` only（例如 headless） | goal 三件套、`workflow`、`working_directory` 等，合计约 3.7KB，占 22 个工具、17.3KB 工具块的 21% |
| `base` + `dsh-web-app`（桌面） | 通常只有 `working_directory`；`tool-goal`、`tool-workflow`、`tool-plugin-manager` 已被 web-app bundle 关掉，名单里这些名字空转 |

装了 free-search 时另外还会有它的四个检索工具。日志里 `denied` 后面列的是这次真的挡掉的名字。

日志里能看到实际效果：

```
[tool-surface] restrict at mount: denied working_directory
[tool-surface] baseline #1: <工具数> tools, <字节> bytes (~<tokens> tok est) | session <id>
```

第二条只在工具表真的变化时才打印（工具数、字节、粗估 token、增删了谁）。

## 工具延迟的暴露层

`lib/tool-search.js` 在每轮装配时把 `config.defer` 点名的工具从工具表里摘掉。摘掉只影响
模型看见什么：执行从 registry 解析（`dsh-tools` 的 `resolveExecution`），不看这份装配结果，
所以模型按名字调用照样能跑。

**默认一条也不摘**，配置为空时插件是空操作。缺的不是过滤器，是发现入口——`tool_search`
要到 Step 2 才有；没有它，摘掉的工具模型没有任何办法找回来。所以现在这层只占位。

为什么在装配处摘、而不是用 `deferLoading`：模型可见的 tools 由装配决定，而 `dsh-llm` 在
路由没有 `toolUpdate` 能力时会把 `deferLoading` 剥掉、把工具全发出去。那条路在非 Anthropic
路由上静默失效。装配层摘掉是路由无关的。

作用域不用担心：监听器挂在 preset 自己的插件树上，只收得到本 preset 代际的装配，同进程
里别的 preset 不受影响（实测见 [docs/deferred-tools-gaps.md](docs/deferred-tools-gaps.md) 2.8）。

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
lib/tool-search.js             延迟工具的暴露层（默认不生效）
lib/compaction-claude.js       压缩摘要结构扩展
docs/dependencies.md           依赖清单与校验结论
docs/deferred-tools-gaps.md    延迟加载为什么放弃（含实测数据）
docs/plugin-config-audit.md    DSH 各工具包的可配置项审计（18 个包）
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
