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
- 结果：**25 处引用全部可解析，0 缺失，0 子路径错误**。计数不含 3 行 `cordis:group` 和
  preset 自己的展示名。本轮新增的 1 行是 `lib/tool-search.js`（已确认文件存在），其余 24 行
  沿用上一轮逐包核对的结果；此前的「23 处」少算了一行重复的 `dsh-tool-subagent`。

## 不与第三方插件耦合

本 preset 只依赖 DSH 本体和本仓库的文件，不认识任何第三方插件：

| 检查 | 结果 |
|---|---|
| `lib/*.js` 的 import / require | 0 条，三个文件只用注入的 `ctx` |
| `package.json` 的 dependencies / peerDependencies | 都没有 |
| `cordis.patch.yml` 的 `name:` | 22 行 `@deepseek-ai/*`（DSH 自带，版本与 DSH 相同）+ 3 行本仓库文件 |
| 按包名探测其它插件 | 没有 |

`tool-surface` 的名单里出现 `advanced_search`、`load_workspace_dependencies` 这类名字，但那是**工具名**，
不是包引用：它只处理当前可见工具表里真实存在的名字，名字对应的插件没装就什么都不发生。名单是
「挡掉什么」的声明，不是「必须装什么」的依赖。

实测办法：只挂 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + 本 preset 的隔离 profile，
没有任何第三方 bundle，能正常挂载：

```
[tool-surface] restrict at mount: denied get_goal,create_goal,update_goal,working_directory,workflow
OK
```

这五个来自 base；名单里其余名字全部缺席，不报错、不影响挂载。

改这个仓库时的准则：新增逻辑只用 `@deepseek-ai/*` 的公开服务和 Cordis 的 `ctx`，不要为了适配
某个第三方插件写分支。profile 里另外挂的插件本就不归 preset 管。

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
| `dsh-claude-preset/lib/tool-surface.js` | 10.2 KB | 本仓库，工具面收敛与审计 |
| `dsh-claude-preset/lib/tool-search.js` | 16.8 KB | 本仓库，工具延迟：摘工具 + tool_search |
| `dsh-claude-preset/lib/compaction-claude.js` | 9.7 KB | 本仓库，压缩摘要结构扩展 |

## 版本敏感点

升级 DSH 之后，下面四处要重新核对，其余行是稳定挂载：

1. `lib/compaction-claude.js` 整段替换了 compaction-basic 的摘要指令。上游改文案时，
   这里的 `INSTRUCTION` 要跟着改；替换条件用开头一句做匹配，匹配不到就原样放行，
   不会把请求弄坏。上游的 `## Pending Jobs` 在本仓库里有意改名成 `## Pending Tasks`
   （名字跟 Claude Code 的压缩提示一致），升级后不要当成漏抄补回去。
2. `lib/tool-surface.js` 依赖 `ctx.tools.restrict({ deny })` 的语义：只收窄全局工具，
   对 preset 自己注册的 scoped 工具会抛 `unknown global tool`。上游若改成可收窄 scoped，
   这里的「抛错即保留」判断要改。
3. `lib/tool-search.js` 依赖三处 DSH 内部契约：
   - `system-prompt/assemble` 这个 waterfall 的形状：监听器拿 `(assembly, context, next)`，
     `await next()` 之后的返回值是权威值，`tools` 是可以整体替换的数组；
   - `ctx.tools.register(definition)` 接受手工构造的 `{ name, description, parameters,
     output: { schema, render }, execute }`，只校验 `output`，`parameters` 只要求是可无损
     序列化的 JSON Schema（支持的关键字仅 type / oneOf / properties / required /
     additionalProperties / items / enum / const 加四个注释字段）；
   - `ctx.tools.schemas(agent)` 返回该 agent 作用域下的可见 schema。
   任何一条变了，这里都要跟着改。它同时依赖「监听器按作用域分发」与「工具注册落在
   preset 作用域」两条语义。
4. `cordis.patch.yml` 里 `delegation`、`compaction`、`planning` 三处用了 isolate realm。
   preset 里 `ctx.provide()` 的服务必须声明 isolate，否则 registry 直接拒绝整个 preset
   （报 `Preset services require isolate realms`）。
