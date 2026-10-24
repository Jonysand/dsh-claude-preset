# Claude Code preset for DeepSeek Harness

把 Claude Code 的会话行为复刻成 DeepSeek Harness（DSH）的 agent preset，id 是 `claude-code`。

依据是 [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) 里整理的 Claude Code 会话装配代码：
`src/constants/prompts.ts` 那套按固定顺序拼装的 system prompt，以及压缩检查点的摘要结构。

## 只改两处

这个分支与官方 `standard` preset 的差别只有下面两行：

| 部分 | 做法 | 文件 |
|---|---|---|
| 系统提示词 | 照抄 Claude Code 的静态段（Intro / System / Doing tasks / Executing actions with care / Using your tools / Tone and style / Output efficiency），只把工具名换成 DSH 的，文件引用改成 DSH 渲染得出来的写法 | `cordis.patch.yml` |
| 压缩摘要 | 把 compaction 的摘要指令换成 Claude Code 的检查点结构：新增 `## All User Messages`，把 `## Pending Jobs` 改名 `## Pending Tasks` 并扩写 | `lib/compaction-claude.js` |

工具面不在这里决定：挂哪些行、每行怎么配，全部照抄 `standard`。不延迟加载、不拦截工具、
不在会话中换表——模型从头到尾看见同一张表，一次会话只有一条 `request/header`。

`persona.complete` 保持 `false`：Claude Code 自己也读 CLAUDE.md，所以 AGENTS.md 全局规则、技能目录、
运行时上下文（工作目录、时间）都保留，这比把 system prompt 裁成单独一段更接近它的真实行为。

## 与 standard 的行集合对照

`cordis.patch.yml` 里的行 id 直接对着 `dsh --profile <profile> --dump-config` 里的 `preset-standard`
逐行比过：

- **少两行**：`dsh-plugin-manager/tools`、`dsh-plugin-market/tools`。它们在 standard 里就是
  `disabled: true`，挂不挂都不产生工具，所以没有抄。
- **多一行**：压缩组里的 `compaction-claude-instruction`，就是上面那处压缩摘要改动。
- **其余完全相同**：行 id、嵌套分组（`planning` / `compaction` / `delegation`）、isolate 声明、
  每行的 `config`（`sampleOverCapGlobResults: false`、`allowParallelInProgress: true`、
  `fetch: true`、`modelSelectionSettings: true`、裁剪阈值 8192/4096/1024 等）全部一样。

## 工具对照

只作名字映射参考。同一个 Claude Code 概念在 DSH 这边叫什么：

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
| SendUserFile | `present` |
| CronCreate / CronList / ScheduleWakeup | `schedule_create` / `schedule_list` / `schedule_update`、`schedule_delete` |
| 后台任务续跑 | `create_goal` / `get_goal` / `update_goal` 加 `/goal` 命令 |
| 自动压缩 | `compaction-basic` + `/compact` |

## 系统提示词的四处改写

1. 工具名换成 DSH 的名字（`read` / `write` / `edit` / `glob` / `grep` / `todo_write` /
   `ask_user_question` / `subagent` / `skill` / `exit_plan_mode` / 平台 shell 工具）。
2. 删掉 Claude 专属内容：`/help` 与反馈渠道、模型家族与知识截止日期、`!` 前缀跑命令、
   Anthropic 内部 A/B 段、Output Style 段。
3. 文件引用改成 DSH 的写法（路径放行内代码、行号写在代码串外面），因为裸的 `file:line`
   在 DSH 的会话界面里不会变成可点链接。
4. 补两条不在 cc-haha 静态段里的行为准则，按 2026-10-20 那次会话（CLI 2.1.299）实际下发的
   文本：信息足够就行动（不复述已知事实、不重议已决事项、不给不会采纳的选项）、代码风格
   跟随周边（注释密度、命名、惯用法）。两条都放在 `# Doing tasks` 里。

## 压缩摘要的两处改写

上游 `compaction-basic` 的摘要指令是模块内常量、没有导出，插件解析不到那个包，所以接在
`ctx.llm.stream` 上：只在 `purpose === 'compaction'` 时把最后那条指令换成扩展版，其它请求
原样透传——不进内容、不改 envelope、不动回放前缀。

1. 新增 `## All User Messages`：按顺序列出非工具结果的用户消息，指令、纠正、范围调整和
   验收标准保留原文。
2. `## Pending Jobs` 改名 `## Pending Tasks` 并扩写：未完成的显式请求映射到它满足的验收
   标准、标出缺证据的项、带上还在跑的后台作业。名字跟 Claude Code 自己的压缩提示一致
   （它的第 7 项就是 Pending Tasks）；这是有意改名，不是漏抄。

自动压缩、`/compact`、溢出恢复三条入口都走这里。补丁是进程级的，但每次压缩请求都按发起
它的 agent 绑的 preset 判定一次，只改 `claude-code` 会话。

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

# 2. 隔离 profile 冒烟：应正常起会话、不报 agent-preset/invalid
$env:DSH_HOME = "$env:TEMP\dsh-smoke"
dsh --profile <临时 profile> "reply ok"
```

真实会话的核对点在会话日志的 `request/header` 事件：`data.header.tools` 就是模型当轮看到的
工具表。工具面与 standard 一致意味着两件事：整个会话只有一条 `request/header`（`initial`），
工具数与同版本 standard 会话相同。

## 测试

`lib/compaction-claude.js` 有单测：指令替换、匹配失败时放行、按会话判定、引用计数。零依赖，
用的是 Node 自带的 test runner：

```powershell
node --test        # 或 pnpm test
```

测试拿假 `ctx` 直接调用插件的 `apply()`，不启动 DSH；插件打到 stderr 的日志被收进断言里，
所以跑起来是安静的。当前 7 项。

## 已知差异与限制

- **preset 是 revision 级，不是会话级**。插件树按 preset 定义挂一次、所有会话共用。
- **压缩摘要指令是整段替换**，不是拼接。上游改文案时这里要同步，否则会丢新版规则；
  匹配不到基础指令时原样放行，不会弄坏请求。上游的 `## Pending Jobs` 是被**有意改名**成
  `## Pending Tasks` 的，升级后不要当成漏抄补回去。
- 包装 `ctx.llm.stream` 用引用计数：多个作用域或前后两版预设先后挂载时只包一次，
  最后一个卸载才还原，避免「新版先挂、旧版后卸」把补丁带走。
- **压缩补丁是进程级的，但按会话判定**。`ctx.llm` 是宿主单例，补丁在 preset 挂载时（进程启动）
  就装上；每次压缩请求都会按发起它的 agent 绑的 preset 判定一次，只改 `claude-code` 会话，
  其它 preset 原样透传。判定不了时按旧行为处理并打一行 warn。
- 没有 NotebookEdit 对应工具；`Read` 对 PDF 的支持 DSH 没有。
- 权限提示不在 preset 里做，用 DSH 的 permission preset（`danger-full-access` 等）。
- **只依赖 DSH 本体，不依赖任何第三方插件**。profile 里另外挂的插件不归 preset 管：它们的
  工具照常出现在工具表里，自己往 system prompt 里加的说明也照常进提示词。核对方法见
  [docs/dependencies.md](docs/dependencies.md)。

## 目录

```
cordis.patch.yml               preset 定义：提示词 + 插件行（照抄 standard）+ 压缩扩展行
package.json                   bundle 清单（dsh.bundle.patch 指向 cordis.patch.yml）
lib/compaction-claude.js       压缩摘要结构扩展
test/compaction-claude.test.mjs
docs/dependencies.md           依赖清单与校验结论
docs/plugin-config-audit.md    DSH 各工具包的可配置项审计（19 个包）
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
