# 依赖清单与校验

本 preset 没有 npm 运行时依赖：`lib/compaction-claude.js` 不 import 任何外部模块，只用 Cordis
注入的上下文对象（`ctx.llm`、`ctx.on`、`ctx.logger`）。控制台里跑 `node --check` 也不会因为
缺包失败。

其余依赖全部由 DeepSeek Harness 本体提供，运行时装在
`resources/app.asar/dsh/node_modules/@deepseek-ai/` 下，profile 侧不需要安装。

## 校验结论

- 校验日期：2026-10-24
- 本机 DSH：`0.2.1-rc.2`（`DeepSeek Harness.exe` 内置）
- 校验方法：解析 `cordis.patch.yml` 里所有 `name:`，逐个读取对应包的 `package.json`，
  同时检查子路径导出（`exports` 里有没有 `./<sub>`）
- 结果：**32 行 `name:` 全部可解析，0 缺失，0 子路径错误**。其中 28 行 `@deepseek-ai/*`
  （含 preset 自己那行 `dsh-agent-preset`）、3 行 `cordis:group`、1 行本仓库文件。
  `@deepseek-ai/*` 去重后是 27 个包。

## 不与第三方插件耦合

本 preset 只依赖 DSH 本体和本仓库的文件，不认识任何第三方插件：

| 检查 | 结果 |
|---|---|
| `lib/compaction-claude.js` 的 import / require | 0 条，只用注入的 `ctx` |
| `package.json` 的 dependencies / peerDependencies | 都没有 |
| `cordis.patch.yml` 的 `name:` | 27 个 `@deepseek-ai/*`（DSH 自带，版本与 DSH 相同）+ 1 个本仓库文件 |
| 按包名探测其它插件 | 没有 |

改这个仓库时的准则：新增逻辑只用 `@deepseek-ai/*` 的公开服务和 Cordis 的 `ctx`，不要为了适配
某个第三方插件写分支。profile 里另外挂的插件本就不归 preset 管——它们注册的工具照常出现在
工具表里，这不是本 preset 的耦合。

## 包清单

| 引用 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/dsh-agent-preset` | 0.2.1-rc.2 | 声明 preset 本身（registry 的一条定义） |
| `@deepseek-ai/dsh-persona` | 0.2.1-rc.2 | system prompt 的 prefix（Claude Code 静态段） |
| `@deepseek-ai/dsh-agent-instructions` | 0.2.1-rc.2 | 注入 AGENTS.md，上限 64 KB |
| `@deepseek-ai/dsh-time-context` | 0.2.1-rc.2 | 运行时时间上下文 |
| `@deepseek-ai/dsh-tool-bash` | 0.2.1-rc.2 | Bash 工具，仅非 Windows 启用 |
| `@deepseek-ai/dsh-tool-pwsh` | 0.2.1-rc.2 | PowerShell 工具，仅 Windows 启用 |
| `@deepseek-ai/dsh-tool-fs` | 0.2.1-rc.2 | read / write / edit / read_image |
| `@deepseek-ai/dsh-tool-fs-search` | 0.2.1-rc.2 | glob / grep |
| `@deepseek-ai/dsh-tool-jobs` | 0.2.1-rc.2 | job_list / job_output / job_kill |
| `@deepseek-ai/dsh-tool-schedule` | 0.2.1-rc.2 | schedule_create / list / update / delete |
| `@deepseek-ai/dsh-skill-filesystem` | 0.2.1-rc.2 | 技能目录（扫 SKILL.md） |
| `@deepseek-ai/dsh-tool-skill` | 0.2.1-rc.2 | skill 工具 |
| `@deepseek-ai/dsh-command-goal` | 0.2.1-rc.2 | `/goal` 斜杠命令 |
| `@deepseek-ai/dsh-tool-goal` | 0.2.1-rc.2 | create_goal / get_goal / update_goal |
| `@deepseek-ai/dsh-plan-mode` | 0.2.1-rc.2 | 计划模式 + exit_plan_mode |
| `@deepseek-ai/dsh-compaction-basic` | 0.2.1-rc.2 | 自动压缩 |
| `@deepseek-ai/dsh-command-compact` | 0.2.1-rc.2 | `/compact` 命令 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 0.2.1-rc.2 | 超大工具结果截断 |
| `@deepseek-ai/dsh-tool-subagent-control` | 0.2.1-rc.2 | interrupt_agent / send_message |
| `@deepseek-ai/dsh-tool-subagent-control/list-agents` | 0.2.1-rc.2 | list_agents（子路径导出） |
| `@deepseek-ai/dsh-tool-subagent` | 0.2.1-rc.2 | subagent（spawn）与 subagent_fork（fork）各挂一行；`modelSelectionSettings: true` 同时注册 list_subagent_models |
| `@deepseek-ai/dsh-workflow-ptc` | 0.2.1-rc.2 | PTC 工作流引擎（与委派同 isolate realm） |
| `@deepseek-ai/dsh-tool-workflow` | 0.2.1-rc.2 | workflow 工具 |
| `@deepseek-ai/dsh-tool-ask-user` | 0.2.1-rc.2 | ask_user_question |
| `@deepseek-ai/dsh-tool-todo` | 0.2.1-rc.2 | todo_write |
| `@deepseek-ai/dsh-tool-web` | 0.2.1-rc.2 | web_search / web_fetch |
| `@deepseek-ai/dsh-tool-present` | 0.2.1-rc.2 | present（把已有文件做成可点开的卡片） |
| `dsh-claude-preset/lib/compaction-claude.js` | 本仓库 | 压缩摘要结构扩展 |

## 版本敏感点

升级 DSH 之后，下面三处要重新核对，其余行是稳定挂载：

1. `lib/compaction-claude.js` 整段替换了 compaction-basic 的摘要指令。上游改文案时，
   这里的 `INSTRUCTION` 要跟着改；替换条件用开头一句（`You are now acting as a
   compaction engine`）做匹配，匹配不到就原样放行，不会把请求弄坏。上游的
   `## Pending Jobs` 在本仓库里有意改名成 `## Pending Tasks`（名字跟 Claude Code 的压缩
   提示一致），升级后不要当成漏抄补回去。
2. `cordis.patch.yml` 里 `planning`、`compaction`、`delegation` 三处用了 isolate realm。
   preset 里 `ctx.provide()` 的服务必须声明 isolate，否则 registry 直接拒绝整个 preset
   （报 `Preset services require isolate realms`）。
3. **工具面锚在 `standard` 上**。升级后拿 `dsh --profile <profile> --dump-config` 取
   `preset-standard` 的行列表，与本仓库的行 id 对照：应当只有两处差异——少
   `dsh-plugin-manager/tools` 与 `dsh-plugin-market/tools`（standard 里本来就是
   `disabled: true`），多 `compaction-claude-instruction`。standard 新增或删掉工具行时，
   这里要同步，否则「工具面与 standard 一致」这个前提就不成立了。
