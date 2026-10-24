# 依赖清单与校验

本 preset 没有 npm 运行时依赖：`lib/*.js` 不 import 任何外部模块，只用 Cordis 注入的上下文
对象（`ctx.tools`、`ctx.on`、`ctx.effect`、`ctx.logger`）。控制台里跑 `node --check` 也不会
因为缺包失败。

其余依赖全部由 DeepSeek Harness 本体提供，运行时装在
`resources/app.asar/dsh/node_modules/@deepseek-ai/` 下，profile 侧不需要安装。

## 校验结论

- 校验日期：2026-10-24
- 本机 DSH：`0.2.1-rc.2`（`DeepSeek Harness.exe` 内置）
- 校验方法：解析 `cordis.patch.yml` 里所有 `name:`，逐个读取对应包的 `package.json`，
  同时检查子路径导出（`exports` 里有没有 `./<sub>`）
- 结果：**69 行 `name:` 全部可解析，0 缺失，0 子路径错误**。两个 preset 合计 58 行
  `@deepseek-ai/*`（去重 29 个包、30 个导出说明符）、7 行 `cordis:group`、4 行本仓库文件。
  本仓库文件里 `tool-search` 与 `tool-surface` 只挂 `claude-code`，`compaction-claude`
  两个 preset 各挂一次。

## 不与第三方插件耦合

本仓库只依赖 DSH 本体和它自己的文件，不认识任何第三方插件：

| 检查 | 结果 |
|---|---|
| `lib/*.js` 的 import / require | 0 条，三个文件只用注入的 `ctx` |
| `package.json` 的 dependencies / peerDependencies | 都没有 |
| `cordis.patch.yml` 的 `name:` | 58 行 `@deepseek-ai/*`（去重 29 个包，DSH 自带）+ 7 行 `cordis:group` + 4 行本仓库文件 |
| 按包名探测其它插件 | 没有 |

模型看不见某个工具只可能来自两处：preset 没挂那一行，或者名字进了 `tool-search` 的延迟名单
（`claude-code` 的 18 个名字加 `mcp__*` 模式）。两者写的都是**工具名**，不是包引用——名单里写了
一个没装插件的名字，什么都不会发生。`tool-surface` 只做审计、不拦截任何工具，
`claude-code-prompt` 连它都不挂。

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
| `@deepseek-ai/dsh-tool-present` | 0.2.1-rc.2 | present（把已有文件做成可点开的卡片） |
| `@deepseek-ai/dsh-tool-str-replace-editor` | 0.2.1-rc.2 | str_replace_editor，引导相位那一对里的编辑器 |
| `@deepseek-ai/dsh-tool-schedule` | 0.2.1-rc.2 | schedule_create / list / update / delete |
| `@deepseek-ai/dsh-tool-goal` | 0.2.1-rc.2 | create_goal / get_goal / update_goal |
| `@deepseek-ai/dsh-tool-cordis` | 0.2.1-rc.2 | cordis_inspect_list / query |
| `@deepseek-ai/dsh-plugin-manager/tools` | 0.2.1-rc.2 | plugin_manager（只挂 `claude-code`） |
| `@deepseek-ai/dsh-workflow-ptc` | 0.2.1-rc.2 | PTC 工作流引擎（与委派同 isolate realm） |
| `@deepseek-ai/dsh-tool-workflow` | 0.2.1-rc.2 | workflow |
| `@deepseek-ai/dsh-command-goal` | 0.2.1-rc.2 | `/goal` 命令（只挂 `claude-code-prompt`，与 standard 对齐） |
| `dsh-claude-preset/lib/tool-surface.js` | 4.9 KB | 本仓库，工具表审计（只挂 `claude-code`） |
| `dsh-claude-preset/lib/tool-search.js` | 25.8 KB | 本仓库，工具延迟：摘工具 + tool_search 找回（只挂 `claude-code`） |
| `dsh-claude-preset/lib/compaction-claude.js` | 9.9 KB | 本仓库，压缩摘要结构扩展（两个 preset 各挂一次，插件按 preset id 判定归属） |

## 版本敏感点

升级 DSH 之后，下面六处要重新核对，其余行是稳定挂载：

1. `lib/compaction-claude.js` 整段替换了 compaction-basic 的摘要指令。上游改文案时，
   这里的 `INSTRUCTION` 要跟着改；替换条件用开头一句做匹配，匹配不到就原样放行，
   不会把请求弄坏。上游的 `## Pending Jobs` 在本仓库里有意改名成 `## Pending Tasks`
   （名字跟 Claude Code 的压缩提示一致），升级后不要当成漏抄补回去。
2. `lib/tool-surface.js` 只做审计，不拦截任何工具：它监听 `session/event` 里的 `request/header`，
   输出工具数、工具块字节和这次增删了谁。要重新引入拦截得回到 `ctx.tools.restrict({ deny })`，
   那是注册表级的收窄——只认全局层的名字，对 preset 自己注册的 scoped 工具会抛
   `unknown global tool`，被挡的名字也拿不回 schema（所以和延迟互斥）。
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
5. `lib/tool-search.js` 的 `deferPatterns` 默认写的是 `mcp__*`，它建立在一个不归本仓库
   管的约定上：`@deepseek-ai/dsh-mcp-client` 把远端工具发布成 `mcp__<serverName>__<rawName>`
   （`serverName` 限 `[A-Za-z0-9_-]{1,32}`，rawName 归一化有损时追加 12 位 hash）。
   命名规则一变，`mcp__*` 就匹配不到任何东西，延迟静默失效；`tool_search` 的
   `select:<裸工具名>` 也依赖 `__` 这段分隔符。升级后拿一个 MCP 会话跑
   `request/header` 看一眼工具名即可确认。
6. **`claude-code-prompt` 的行列表锚在 `standard` 上**。升级后拿
   `dsh --profile <profile> --dump-config` 取 `preset-standard` 的行列表，与本仓库的第二个
   preset 对照：应当只有两处差异——少 `dsh-plugin-manager/tools` 与 `dsh-plugin-market/tools`
   （standard 里本来就是 `disabled: true`），多 `compaction-claude-instruction`。standard
   增删工具行时要同步，否则「工具面与 standard 一致」这个前提就不成立了。
