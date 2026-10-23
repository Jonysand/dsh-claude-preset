# 依赖清单与校验

本 preset 没有 npm 运行时依赖：`lib/*.js` 不 import 任何外部模块，只用 Cordis 注入的上下文
对象（`ctx.tools`、`ctx.on`、`ctx.effect`、`ctx.logger`）。控制台里跑 `node --check` 也不会
因为缺包失败。

其余依赖全部由 DeepSeek Harness 本体提供，运行时装在
`resources/app.asar/dsh/node_modules/@deepseek-ai/` 下，profile 侧不需要安装。

## 校验结论

- 校验日期：2026-10-23
- 本机 DSH：`0.2.1-rc.2`（`DeepSeek Harness.exe` 内置）
- 校验方法：解析 `cordis.patch.yml` 里所有 `name:`，逐个读取对应包的 `package.json`，
  同时检查子路径导出（`exports` 里有没有 `./<sub>`）
- 结果：**23 处引用全部可解析，0 缺失，0 子路径错误**

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
| `@deepseek-ai/dsh-skill-filesystem` | 0.2.1-rc.2 | 技能目录（扫 SKILL.md） |
| `@deepseek-ai/dsh-tool-skill` | 0.2.1-rc.2 | skill 工具 |
| `@deepseek-ai/dsh-plan-mode` | 0.2.1-rc.2 | 计划模式 + exit_plan_mode |
| `@deepseek-ai/dsh-compaction-basic` | 0.2.1-rc.2 | 自动压缩 |
| `@deepseek-ai/dsh-command-compact` | 0.2.1-rc.2 | `/compact` 命令 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 0.2.1-rc.2 | 超大工具结果截断 |
| `@deepseek-ai/dsh-tool-subagent-control` | 0.2.1-rc.2 | interrupt_agent / send_message |
| `@deepseek-ai/dsh-tool-subagent-control/list-agents` | 0.2.1-rc.2 | list_agents（子路径导出） |
| `@deepseek-ai/dsh-tool-subagent` | 0.2.1-rc.2 | subagent（spawn）与 subagent_fork（fork）各挂一行 |
| `@deepseek-ai/dsh-tool-ask-user` | 0.2.1-rc.2 | ask_user_question |
| `@deepseek-ai/dsh-tool-todo` | 0.2.1-rc.2 | todo_write |
| `@deepseek-ai/dsh-tool-web` | 0.2.1-rc.2 | web_search / web_fetch |
| `dsh-claude-preset/lib/tool-surface.js` | 7.5 KB | 本仓库，工具面收敛与审计 |
| `dsh-claude-preset/lib/compaction-claude.js` | 6.4 KB | 本仓库，压缩摘要结构扩展 |

## 版本敏感点

升级 DSH 之后，下面三处要重新核对，其余行是稳定挂载：

1. `lib/compaction-claude.js` 整段替换了 compaction-basic 的摘要指令。上游改文案时，
   这里的 `INSTRUCTION` 要跟着改；替换条件用开头一句做匹配，匹配不到就原样放行，
   不会把请求弄坏。
2. `lib/tool-surface.js` 依赖 `ctx.tools.restrict({ deny })` 的语义：只收窄全局工具，
   对 preset 自己注册的 scoped 工具会抛 `unknown global tool`。上游若改成可收窄 scoped，
   这里的「抛错即保留」判断要改。
3. `cordis.patch.yml` 里 `delegation`、`compaction`、`planning` 三处用了 isolate realm。
   preset 里 `ctx.provide()` 的服务必须声明 isolate，否则 registry 直接拒绝整个 preset
   （报 `Preset services require isolate realms`）。
