# 延迟工具的两条结构性差距

> **当前状态：做延迟加载，`defer` 13 个名字 + `deferPatterns: ['mcp__*']`。**
> 回退办法：删掉 `cordis.patch.yml` 里 `tool-search` 的 `config`，工具立刻回到全量常驻。
>
> 这个决定反复过几次，全是 2026-10-23 这一天内的事，按发生顺序：
>
> | 步 | 做了什么 | 判据 | 证据 |
> |---|---|---|---|
> | 1 | 关掉延迟，工具全部常驻 | 一次工具表变化约等于 7 个普通轮次；延迟每轮只省工具块的缓存读，回本要 15~20 轮 | 1.8 的 P2 实测 |
> | 2 | 重开。Step 0 探针确认装配监听器的作用域，Step 1 落地暴露层，Step 2 注册 `tool_search` | 回本判据只对真短会话不成立，而实际会话普遍偏长 | 2.8、2.9 |
> | 3 | Step 4：验证压缩之后还能找回 | 取回的 schema 会进历史，`/compact` 会把它压掉，那正是最容易丢的时候 | 2.10 |
> | 4 | 名单扩到 14 个，加 `deferPatterns: ['mcp__*']` | MCP 工具按 server 成批出现，没法写精确名单 | 2.11 |
> | 5 | 描述改成全列不截断；`todo_write` 挪回常驻，名单 13 个 | 系统提示点名要求使用的工具会被替代，不会被搜出来 | 2.12 |
> | 6 | 长时间多代理会话实测：2 个 turn、70 步、88 次调用 | 延迟的工具会不会永远不被用 | 2.13 |
>
> 第 6 步顺带推翻了第一节的前提：差距一假定"取回即注册、工具表会变"，而现在 schema 走工具
> 结果、不进注册表，整场 70 步只有一条 `request/header`。
>
> 下文第一节（1.x）是第 1 步当时的分析，里面「本 preset 选择了不延迟」是当时的选择；
> 第二节（2.x）是重开之后的新证据。

当时这套机制（`tool-surface` 挡工具、`tool_search` 取回、`<system-reminder>` 宣告）
在行为上已经对齐 cc-haha 的"发现"部分，剩下两条差距是结构性的：

| 差距 | cc-haha | 做延迟时的 DSH 现状 |
|---|---|---|
| 取回时工具表是否变化 | 不变：`defer_loading` 预先声明，取回只加 `tool_reference` | 变：取回即注册，数组多一个条目 |
| 延迟状态的作用域 | 会话级 | preset revision 级，跨会话共享 |

下面分别说清楚机制、证据、可选路径和验收方法。

---

## 一、取回会改工具表

### 1.1 cc-haha 的数据流

1. 延迟工具**照常声明**在请求的 `tools` 数组里，但带 `defer_loading: true`，schema 不展开。
2. 模型只看到名字（通过 `<system-reminder>` 宣告）。
3. 模型调 `ToolSearch`，结果里放 `tool_reference` 块。
4. 由 API 侧把引用展开成完整定义。

结果是：整个会话里 `tools` 数组**字节不变**。发现和激活都只往消息流尾部加东西，
所以前缀缓存只在消息增长时付正常价格，不因工具变化而整体失效。

### 1.2 DSH 其实有这三块原语

不是"DSH 没有"，而是"开关被适配器收起来了、我们的机制方向又相反"。DSH 的三块对应物：

| 原语 | 位置 | 行为 |
|---|---|---|
| `deferLoading` | `@deepseek-ai/dsh-tools` 的 `defineTool` / 注册表投影 | 工具定义上带 `deferLoading: true`；怎么表达由适配器决定：deepseek Messages 写成数组里的 `defer_loading`，pi-ai 则从数组里剔除 |
| 工具变更消息 | `@deepseek-ai/dsh-agent-loop` 的 `buildRequest()` | 头部变化时自动追加一条 `developer/message`，内容为 `tool-addition` / `tool-removal` 块，来源标记 `tool-registry` |
| 协议表达 | `@deepseek-ai/dsh-llm-deepseek` 的 `serialize()` | 把上面两种块写成 `tool_addition` / `tool_removal`，内部是 `{type:'tool_reference', name}`；此时自动加 beta 头 `mid-conversation-tool-changes-2026-07-01`；工具定义里 `deferLoading: true` 写成 `defer_loading: true` |

也就是说：**消息侧、协议侧的管道 DSH 都铺好了**，缺的是让这条管道通电的两个条件。

### 1.3 为什么本 preset 两次都通不了电

**条件一：路由不声明兼容性。**

`@deepseek-ai/dsh-llm-pi-ai` 的 `conversationUpdates(model)` 只有在模型 `compat` 里声明了
`supportsMidConvoSystemMessages`，并且（按协议不同）再声明
`supportsMidConvoToolChanges` / `supportsMidConvoToolAdditions` 时，才会把 `toolUpdate`
置为 `in-history` 或 `addition-only`。

本机 magpie 路由是 `openai-completions`，`models[]` 里四个模型都没有 `compat` 字段，
于是 `conversationUpdates()` 返回空对象，`toolUpdate` 不存在。同一函数还要求
`supportsMidConvoSystemMessages`，连系统提示词中途更新这条也一并没有。

**条件二：pi-ai 路由把 `deferLoading` 的工具从工具表里直接剔除。**

`dsh-llm-pi-ai` 的 `toolsOf()` 是：

```
options.tools?.filter((tool) => !tool.deferLoading).map(piTool)
```

带 `deferLoading` 的工具**不会进入请求的 `tools` 数组**。pi-ai 用另一条通道补偿：
工具新增写成历史里的 system 消息（带 `toolsAdded`），Anthropic 全延迟请求再补一个
占位工具（`ANTHROPIC_TOOL_UPDATE_PLACEHOLDER`），因为协议不接受空工具表。

所以 pi-ai 的"工具表稳定"来自两件事：延迟工具从头到尾不在数组里；新增走消息。
这两件事都要求模型 `compat` 里声明会话中变更能力——正是本机 magpie 没有的。

（对照：`dsh-llm-deepseek` 的 Messages 路径是另一种实现，`defer_loading: true`
会写进数组里的工具定义，更接近 cc-haha 的形态。）

**在当前路由上，工具变更消息其实已经在生成，只是被丢掉了。**
agent loop 一旦发现头部变化就写一条 `developer/message`（`tool-addition` / `tool-removal`），
`dsh-llm-pi-ai` 把它解析成带 `toolsAdded` 的 system 消息；但 openai-completions 的
序列化器只在 `transcriptTools.anchorsAdditions` 为真时才把它写成带 `tools` 的 system
消息，否则整条丢弃。没有 `compat` 就没有 `anchorsAdditions`，于是模型能看到的唯一变化
就是工具数组本身。

还有一条容易忽略的约束：pi-ai 的 `resolveTranscriptTools()` 里，
`anchorsAdditions = supportsToolAdditions && !hasNonAdditiveToolChanges(messages)`。
**只要历史里出现过工具移除，锚定就失效**，整条回退成"每次发送当前工具表"。
所以真要保住工具表稳定，取回路径必须**只增不删**。

**结论：** 差距的真实位置不是"DSH 不支持"，而是：

1. 当前模型路由没有会话中改工具的协议能力；
2. 我们这套机制是"取回即注册"，与"延迟工具不进数组 / 只加引用"的稳定模式在数据流上相反。

### 1.4 实测：A 的可行性（2026-10-23）

拿本机 magpie 网关（`http://127.0.0.1:3425`，模型 `codemaker-chat/deepseek-flash`）直接打了
三组请求，绕过 DSH，只看传输层和上游语义。

**第一组：工具只出现在一条 system 消息的 `tools` 字段里，顶层 `tools` 为空。**

```
POST /v1/chat/completions
messages: [ {user:"Call probe_echo with text 'injected'"}, {system, tools:[probe_echo]} ]
-> 200, finish_reason=tool_calls, arguments {"text":"injected"}
```

**第二组：顶层已有工具，追加的工具只放在 system 消息里。**

```
top-level tools: [probe_echo]
messages: [ {user:"Call probe_echo2 ..."}, {system, tools:[probe_echo2]} ]
-> 200, 模型调用 probe_echo2，参数正确
```

对照组（同样的提问，但不追加那条 system 消息）：模型回复 `MISSING`，说明它确实看不见
`probe_echo2`。**追加是真的生效，不是碰巧听话。**

**第三组：把同样的配置写进 DSH profile。** 在 magpie 路由的模型上加
`compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }`，
启动直接失败：

```
INVALID_CONFIG: llm-pi-ai: provider "magpie" model "codemaker-chat/deepseek-flash" sets compat
"supportsMidConvoSystemMessages", which is not configurable here: pi-ai's installed catalog
sets it for the vendors that need it, so name that provider as the route instead
```

原因在 `dsh-llm-pi-ai` 的 `COMPLETIONS_COMPAT_GATE`：这两个开关连同 anthropic 的
`supportsMidConvoToolChanges` 都被标成 `withhold`，配置层直接拒绝，并在报错里指向
"改用自带这些标记的目录 provider"。

**第四组：抓线上请求体。** 在 DSH 与网关之间插一个记录代理（`127.0.0.1:3426`），
profile 指向代理，会话里用探针注册一个新工具（`probe_add` → `probe_added`）：

```
request 1: tools 28 -> ...probe_add,probe_ping,probe_remove...
request 3: tools 29 -> ...probe_add,probe_added,probe_ping,probe_remove...
```

（第 2 条是会话标题生成请求，没有工具，略过。）

**这一条推翻了"只要打开开关就行"的乐观判断。** `dsh-llm-pi-ai` 的 `piContext()`
每次请求都把**当前全量工具集**交给 pi-ai，而 pi-ai 的锚定取的是
`getInitialSystemMessage(messages).toolsAdded`——也就是那个刚被塞进去的全量集合。
所以即使 compat 打开，顶层 `tools` 仍然是 29 个，锚定退化成"每次发全量"。

**四条结论：**

| 层 | 结论 | 依据 |
|---|---|---|
| 网关 / 上游 | 支持"中途追加工具"的 Kimi/DeepSeek 形态 | 第一、二组请求，含对照组 |
| pi-ai 机制 | 存在：`resolveTranscriptTools(messages, supportsToolAdditions)` 为真时，顶层只发初始工具集，后续新增走 system 消息；但它依赖调用方只传初始集合 | `@earendil-works/pi-ai` 的 `transcript.js` |
| DSH 配置 | 两个开关被标 `withhold`，配置层直接拒绝 | `COMPLETIONS_COMPAT_GATE`，实测 `INVALID_CONFIG` |
| DSH 适配器 | 每次请求都发当前全量工具集，锚定前提不成立 | 第四组抓包，28 → 29 |
| 目录 provider | 本机不可用 | 只有 `moonshotai` / `fireworks` 这类目录模型带标记，magpie 网关不提供这些模型 |

还有一个容易误判的点：**锚定要求整个 transcript 没有移除或同名重声明**
（`hasNonAdditiveToolChanges`）。一旦历史里出现工具移除，`anchorsAdditions` 变假，
整条回退成"每次发送当前工具表"。所以 A 生效后，会话内不能回收工具。

### 1.5 三条可选路径

| 路径 | 做法 | 前置条件 | 工作量 | 风险 |
|---|---|---|---|---|
| A. 开一个会话中工具变更的开关 | ①`dsh-llm-pi-ai` 把两个 compat 从 `withhold` 改成 `offer`；②`dsh-agent-loop` 在适配器声明了中途变更能力时，改发**基线**工具集（增量已经由 `developer/message` 承载） | 本轮已验证网关接受该形态；剩下是 DSH 两处改动 | 中：两处上游改动 + profile 三行 | 中：开关对所有后端生效，Claude/GLM/Gemini 后端未验证 |
| A'. 换到带标记的目录 provider | 用 `moonshotai` / `fireworks` 这类目录 provider（模型自带 compat） | 网关或上游真的要提供这些模型 | 中：换模型供给 | 高：本机网关没有这些模型，等于换供应商 |
| B. 让延迟工具预先声明 | 所有延迟工具在会话开始就注册（带 `deferLoading`），`tool_search` 只负责产生 `tool-addition` 引用而不是注册 | 要能给"别人的工具"打 `deferLoading` 标记：要么上游开放按名字改标记，要么本插件用同名 shadow 注册转发调用；还要适配器真的把引用展开 | 大：需要 DSH 上游或一次影子注册改造 | 高：影子注册会影响工具来源、权限和审计 |
| C. 接受现状 | 保持"取回即注册"，用 `select:a,b` 一次取全，把失效次数压到每次会话一次 | 无 | 零 | 低：每次取回仍付一次前缀失效 |

**建议：** 本 preset 已经按"不延迟"落地（见 1.8 的实测）。A 仍然保留作为字节级
对齐的选项：它把问题从"协议不支持"降级成"两处上游改动"，而且**本 preset 的插件
一行都不用改**——取回是"新增"，正好符合 addition-only。但要先有心理预期：
只改 compat 分类不够，必须同时让适配器别再每轮发全量。

### 1.8 P2 实测：一次工具表变化的代价（2026-10-23）

把"不延迟"版本放进隔离 profile，用 `probe_add` 在会话中途注册一个工具，制造一次
真实的工具表变化。工具面 21 个、15,521 字节（约 3,880 token）。四步的用量：

| step | input | cacheRead | output | 发生了什么 |
|---|---|---|---|---|
| 1 | 5,936 | 1,920 | 164 | 冷启动，写入前缀 |
| 2 | 180 | 7,936 | 79 | 命中缓存 |
| 3 | 250 | 8,064 | 23 | 命中缓存 |
| 4 | **6,477** | **1,920** | 2 | `+probe_added` 后，前缀重建 |

按 input 单价 1、缓存读 0.1、缓存写 1.25 折算成"input 等价 token"：

- 普通一轮：约 250 + 0.1×8,064 ≈ **1,056**
- 变化那一轮：1.25×6,477 + 0.1×1,920 ≈ **8,288**
- 差额 ≈ 7,230，即**一次工具表变化 ≈ 7 个普通轮次**。

换算到回本点：延迟加载每轮省下的是被延迟工具块的缓存读。以 3.9K token 的工具块算，
每轮省 390 等价 token，回本需要 `7,230 / 390 ≈ 19` 轮。桌面 preset 的工具块约
5.6K token，比例接近（一次变化 ≈ 10~12 轮，回本 ≈ 15~20 轮）。

结论：**延迟加载是"长会话 + 少取回"才划算的买卖。** 取回一次发生在会话早期时，
后面的长尾能吃到省下的工具块，可以回本；会话短或取回两三次，就是纯亏。
本 preset 选择了不延迟：结构更简单、没有取回语义、也没有作用域串味问题，
代价是工具块一直占着缓存前缀。

如果要重新评估，判据就一条：会话是否稳定超过 20 个请求，且只取回一次。

### 1.9 后记：收敛时机本身也是成本（2026-10-23）

线上又验证了一条：**在 `agent/pre-step` 里挡工具，永远只能改变"下一次"请求**。
原因是 agent loop 的顺序是「装配 tools → agent/pre-step → 记 request/header」，
装配在 pre-step 之前。所以 pre-step 里挡掉一个已经出现在本轮请求里的工具，
必然让下一轮的工具表少一条——一次变化、一次全前缀重建。

实测（会话 90d91699，13 步）：`load_workspace_dependencies` 在挂载之后才注册，
第一步的 pre-step 补挡把它去掉，于是

```
header#1: 22 tools (含 load_workspace_dependencies)
header#2: 21 tools          ← 一次重建，step2 input 7,090
```

短会话里这一次重建直接把缓存复用率从 ~98% 压到 86%。结论：收敛只做一次——
在 `apply()` 里，早于第一次装配。晚注册的工具就留着，别再追。

### 1.6 如果走 A，需要改什么

1. `dsh-llm-pi-ai`：把 `supportsMidConvoToolAdditions`（openai-completions）与
   `supportsMidConvoToolChanges`（anthropic-messages）从 `withhold` 改成 `offer`。
2. `dsh-agent-loop` 的 `buildRequest()`：当适配器声明了会话中工具变更能力时，
   请求里发**基线**工具集（`baseline.tools`），而不是当前全量；增量已经作为
   `developer/message` 的 `tool-addition` 块写进历史，pi-ai 会把它折叠成
   `{role:'system', tools:[...]}`。
3. profile 的 magpie 模型配置加上这两个 compat；真的后端逐条验证再开，
   当前实测只覆盖 `deepseek-flash`。
4. 不需要改 preset 插件：`tool_search` 取回 = 注册 = 新增。
5. 会话内不要回收工具：任何移除都会让 `anchorsAdditions` 变假，回退成每次都发全量。
6. 验证见 1.7。

### 1.7 验收方法

- 抓包比较取回前后的请求体：A 生效时顶层 `tools` **完全一致**（都是基线集合），
  新增出现在 `{role:'system', tools:[...]}` 里。
- 注意 `request/header` 仍然会变——它记录的是 DSH 的可见工具集，不是线上请求体。
  **不能拿 header 变化判断 A 是否生效。** 本轮第四组抓包就是模板：代理记录
  `tool_count` 与 `system_tool_messages` 两个字段即可。
- 对照 C（现状）：顶层 `tools` 会多一个条目，且从该 token 起前缀失效。

---

## 二、延迟状态是 revision 级，不是会话级

### 2.1 事实

`tool-surface` 调 `ctx.tools.restrict({deny:[name]})` 得到的遮罩，挂在**调用它的那个
作用域**上。preset 的插件树按 **revision** 挂载一次、所有会话共用，于是：

- 任意会话取回一个工具，遮罩被撤掉，其它会话立刻也看得见；
- 之后新建的会话一上来就能看到它，直到进程重启或预设重载；
- 进程重启后全部复位。

证据有三条：

1. 启动 web profile 时**没有任何会话**，`tool-surface` 的 apply 已经执行过，说明挂载早于且独立于会话。
2. 在真实桌面会话里取回 `web_fetch` 后，新建会话的工具表里它已经可见。
3. 重启进程复位，需要重新取回。

### 2.2 机制

`restrict()` 的实现是往当前作用域的层里追加一条限制记录，并返回撤销函数
（`@deepseek-ai/dsh-tools` 的 `restrict()`，内部 `scopeOf(this.ctx)`）。
作用域决定可见范围，也决定何时回收：作用域销毁，限制随之消失。

preset 作用域是"一次 revision 一份"，不是"一个会话一份"。所以遮罩天然是共享的。

### 2.3 后果

| 场景 | 现在的行为 | 期望（cc-haha） |
|---|---|---|
| A 会话取回 web_fetch，B 会话继续 | B 也能直接看到 web_fetch，没取回过 | B 仍然看不到 |
| 取回后新建会话 | 新会话开局就有它 | 新会话从干净状态开始 |
| 进程重启 | 全部复位 | 会话恢复时按该会话自己的状态 |
| 恢复会话（resume） | 工具表比中断时少（遮罩重新加回） | 工具表与中断时一致 |

### 2.4 方案 A：把两个插件下沉到 agent 作用域（推荐）

做法：preset 里只留一个很薄的"装配器"，它在 `agent/created` 时把真正干活的插件挂进
`agent.ctx`：

```
ctx.on('agent/created', ({ agent }) => {
  agent.ctx.plugin(deferredToolsWorker)   // 一个插件，同时负责收敛、池子、tool_search、宣告
})
```

要点：

1. **合并成一个插件**。现在 `tool-surface` 与 `tool_search` 通过 `ctx.provide('claudeDeferredTools')`
   通信；按 agent 各挂一份时，服务也要按 agent 提供，还要处理 preset registry 的
   isolate realm 审计。合并成一个插件后这条跨插件通道直接消失，最省事。
2. **遮罩随 agent 回收**：限制挂在 agent 作用域上，agent 销毁时自动撤销，不需要额外清理。
3. **晚注册工具仍要扫**：`load_workspace_dependencies`、后连上的 MCP 工具照旧由
   `agent/pre-step` 补扫，逻辑不变。
4. **宣告记账跟着 agent 走**：现在是 WeakMap 按 agent 记账，迁移后天然就是会话级。

工作量估计：合并两个插件约 250 行，加一个装配器约 30 行；需要重跑三类验证
（收敛、取回、宣告）。

风险：

- `agent/created` 的时序：必须在第一次装配之前完成挂载，否则第一轮请求会带上宿主工具。
  探针已验证这个时序可行（挂载后首次请求即为干净工具表）。
- 服务提供方式变化：合并后不再有 `provide`，如果将来还想让别的插件读池子，要重新设计。

### 2.5 方案 B：共享挂载 + 按 agent 施加限制

保留 preset 里的共享插件，只把 `restrict` 的调用点挪进 `agent/created`，对每个 agent
分别调用 `agent.ctx.tools.restrict(...)`。

优点：改动小，池子和 tool_search 都不用动。
风险：**未验证**。`restrict()` 取的是调用处的作用域，从共享监听器里通过 `agent.ctx`
拿到的服务是否按 agent 作用域绑定，需要一次探针确认。如果成立，这是成本最低的路径。

### 2.6 方案 C：保持共享，写清楚

不改代码，只把"取回是 revision 级"作为已知边界写进 preset 注释和文档。
适用于"会话数量少、能接受取回泄漏"的使用方式。

### 2.7 和 resume 的相互作用

即使做了方案 A，**恢复会话仍会有一次工具表重建**：新 agent 起来时所有宿主工具重新被
挡住，而会话历史里是"取回过"的工具表，两者不一致，前缀从工具块起失效一次。

cc-haha 没有这个问题，因为它的工具数组从头到尾不变（`defer_loading` 声明在前）。
换句话说：**差距二修好之后，差距一仍然会在 resume 时收一次费**。要彻底消掉，只能走
第一部分的路 A/B。

### 2.8 Step 0 实测：装配监听器只看得到本 preset（2026-10-23）

重开延迟加载要先回答一个问题：**挂在 preset 里的 `system-prompt/assemble` 监听器，
会不会也收到别的 preset 的 agent 的装配？** 如果会，任何按需裁剪工具表的实现都会
误伤其它 preset，方案等于作废。

做法是把一个只读探针（`docs/archive/request-probe.js`）挂在本 preset 的插件列表末尾，
它记录每次装配的 agent id、工具数、工具名，以及工具表里是否出现本 preset 明确挡掉的
宿主工具（`workflow` / `create_goal` / `schedule_*` / `present` 等）。日志落
`%TEMP%\dsh-request-probe-<pid>.log`。

同一个进程（pid 65528）里同时跑两个 preset，一轮一个会话：

| 会话 | 实际 preset | 工具数 | 工具块字节 | 探针记录 |
|---|---|---|---|---|
| `2ef4d717` | claude-code | 22 | 17,222 | `created` + `assemble` + `header` |
| `5fd7cb86` | standard | 37 | 约 34 KB | 只有 `created` |
| `121974cd`（对照） | claude-code | 22 | 17,222 | `created` + `assemble` + `header` |

`5fd7cb86` 的工具表里带着 `workflow`、`create_goal`、`present`、`schedule_*`、
`advanced_search`（后来挪进 defer，见 2.14）、`working_directory`——这些名字要么在本 preset
的拦截名单里，要么由 tool-search 延迟。探针看得到它就会直接打 `FOREIGN=`。实际一行都没有，
而它那一轮有完整的 7 步和一条 `request/header`（seq 15）。

对照会话 `121974cd` 是 8 分钟后新建的 claude-code 会话：同一个探针实例、没有第二次
`mount`，照样打出了装配行。所以"没记录"不是探针死了，是它收不到。

机制写在事件契约里（`cordis_inspect` 的 Event provider，`system-prompt/assemble` 原文）：

> Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): **scoped listeners receive only that
> scope's assemblies.**

一个细节值得记下来：`5fd7cb86` 的 `session` 首行写的是 `agentPreset: "claude-code"`，
第 4 个事件 `agent-preset/selected` 才写 `standard`。探针收到它的 `created`（建会话时
还在本代际），4 秒后它切到 standard，之后的装配就与本代际无关了。所以监听器绑定的是
**preset 代际**，不是进程。

这条结论只覆盖**监听器分发**，不覆盖 `restrict()` 的作用域——方案 B 里"从共享监听器
调用 `agent.ctx.tools.restrict()` 是否按 agent 生效"仍然未验证，要另跑一次探针。

### 2.9 Step 2/3 实测：摘掉、搜到、直接调用（2026-10-23）

会话 `f9a8eaf9`，claude-code preset，一轮 7 步、11 次工具调用。当时配的延迟名单是
`web_fetch`、`read_image`、`job_list`、`job_output`、`job_kill`。

| 观测点 | 结果 |
|---|---|
| 工具表 | 22 → 18；少的正好是配置那 5 个，多的正好是 `tool_search` |
| 工具块字节 | 17,222 → 16,310（同一口径：`JSON.stringify(tools)` 的 UTF-8 字节） |
| `request/header` | 整场只有一条，`reason: initial`——工具表没再动过 |
| 发现 | 第 2 步 `tool_search {"query":"select:web_fetch"}`，结果 288 字节，正文是一段 `<functions>` 加完整 schema |
| 直接调用 | 第 3 步调用 `web_fetch`——它不在请求的 `tools[]` 里——返回 `Fetched … (HTTP 200)` 与正文 |
| 后续 | 同一会话又调了 4 次 `web_fetch`，全部成功；另有一次 `TypeError: fetch failed`，是网络错误，不是准入拒绝 |

这条实测把方案的赌注验完了：**暴露与执行确实是两层**。工具从装配里消失，注册表里还在，
模型按名字调用照样跑通，不需要包装工具、不需要 `DeferredToolCall`。

成本要按同一口径算：

- 摘掉的 5 个 schema 合计 1,788 字节；
- `tool_search` 自己 876 字节（含描述里那串名字）；
- 净省 912 字节，约 228 token，而且只在缓存的 0.1x 档位上省。

也就是说 **净收益 ≈ 被延迟 schema 之和 − 876 字节**。延迟 5 个小工具基本是白忙；
真正的回本点在 MCP 那种几千字节起步的工具包。名单随后扩到 9 个（加了
`list_agents`、`interrupt_agent`、`send_message`、`subagent_fork`），因为这几个在真实
会话里几乎不用。

### 2.10 Step 4 实测：压缩后会重搜（2026-10-23）

会话 `a1acd0ea`：两轮，第一轮抓 `example.com` 的标题，然后 `/compact`，第二轮抓
`example.org`。这一场跑的是 9 个工具的名单。

工具表按预期缩到 14 个（22 − 9 + `tool_search`），工具块 13,391 字节：摘掉 4,766 字节，
`tool_search` 自己占 935，净省 3,831 字节。

压缩本身记在 `compaction/summary`：

- `shadowedRange` 是 8–25，`shadowedTokenCount` 3,408——第一轮整段（含 `tool_search`
  的调用与结果）全部出上下文；
- 摘要是一段普通 Markdown，里面没有 `<functions>`、没有参数 schema。它提到过
  “`web_fetch` was not in the initially loaded tool list; retrieved with query
  `select:web_fetch`”，但那是叙述，不是定义。

压缩之后：

| seq | 事件 |
|---|---|
| 45 | `request/header` `reason=series`，14 个工具，与压缩前完全一致 |
| 47 | `tool_search {"query":"select:web_fetch"}` —— **模型自己又搜了一次** |
| 48 | 结果与压缩前逐字相同的那段 `<functions>` |
| 52 | `web_fetch https://example.org` |
| 53 | `result: Fetched … (HTTP 200)` |

也就是说，在第 1 种分支上收尾：**压缩丢掉 schema，模型自己重搜，重搜拿回同一份定义，
调用成功**。不需要改压缩指令。

两条附带结论：

- 压缩不会动工具表。第二条 `request/header` 的 reason 是 `series` 而不是 `change`，
  说明头部（含工具数组）逐字相同，只是请求序列重开了一次。
- 名单写进 `tool_search` 的描述而不是发一条公告，这个选择在压缩场景里是决定性的：
  公告是历史消息会被压掉，描述是工具 schema 压不掉。

### 2.11 按类延迟：MCP 与通配（2026-10-23）

MCP 工具没法写精确名单：名字是 `mcp__<server>__<tool>`，随 server 增减，一个 server 就是
几十上百个。所以配置加了第二层 `deferPatterns`，只认一个 `*`：

```yaml
defer: ['web_fetch', 'glob', ...]
deferPatterns: ['mcp__*']
```

实现上把"精确名单 + 模式"合成一个 matcher，装配过滤和搜索目录共用它，`tool_search`
自己在 `has()` 里硬编码为永不匹配——否则一个 `tool_*` 模式就能把找回入口关掉。

配套改了两处搜索逻辑，都是为 MCP 服务的：

1. **裸名选取**：`select:create_issue` 能选中 `mcp__github__create_issue`。重名（两个 server
   都有 `create_issue`）时全部返回，让模型自己看描述选。
2. **必选词按段比**：名字先切成段（`mcp/github/create/issue`），`+rea` 只匹配段等于 `rea`
   的工具。改之前是子串匹配，`+rea` 会命中 `create_issue`——`create` 里就藏着 "rea"。
   描述里的匹配也改成整词边界，同一个理由。

描述的名单**原样全列，不截断**。一开始按 12 个截断，理由是"别让描述随名单膨胀"，
但 2.12 的实测证明这个理由站不住：名单是配置作者写的、十几条几百字节，
比它们各自的 schema 便宜两个数量级；而截断按字母序砍尾，`todo_write`、`web_fetch`
这类最常被系统提示点名的工具恰好排在最后。MCP 走通配、不进名单，所以描述不会随 server 膨胀。

顺带记一个没做的机会：本机 `reverse` preset 里挂着 REA MCP——170 个逆向工具、约 43 万字符
schema（作者自己在注释里写的）。那是这套东西真正的目标场景：按 4 字符/token 折算，光工具块
就十万 token 量级。但 `tool-search` 是 preset 作用域的，`claude-code` 这边的实例根本看不到
那边的工具；要让收益落到那里，得在 `reverse` preset 的插件列表里也挂一行同样的 `tool-search`。
那一行在用户 profile 的 patch 里，不在本仓库。

### 2.12 名单 14 个的实测：体积达标，但点名的工具会被替代（2026-10-23）

会话 `b2dab545`，claude-code preset，一轮 13 步、21 次工具调用（任务是逆向一个游戏客户端的指令通道）。

**体积达标。** 第一条 `request/header` 是 9 个工具、9,925 字节，预测 9,930（预测时把通配
MCP 的工具也算进去了，实际上这个 preset 一个 MCP server 都没挂）。基线 22 个 / 17,222
字节，每次请求省 7,297 字节，约 1,824 token。`tool_search` 自己占 1,221 字节。

**找回通路能用。** 模型调了两次 `tool_search`：`+rea +binary +analysis open_binary`、
`select:open_binary,inspect_managed_artifact,analyze_javascript_application`。语法都对，
都没命中——REA 那批工具挂在 `reverse` preset 上，这边看不到。返回是 "No deferred tool
matched … 14 deferred tools are searchable"。没崩、没编造，模型直接改用手写 PE 解析。

**没达成的部分：`todo_write` 和 `glob` 一次没调、一次没搜。**

- `todo_write`：系统提示第 9,907 字符写着 "Break down and manage your work with the
  todo_write tool"。但描述当时只列前 12 个名字、按字母序，`todo_write` 和 `web_fetch`
  正好被压成 "and 2 more"——这个名字从头到尾没出现过。模型把计划全写在正文里
  （"Plan: 1. PE import table…"）。
- `glob`：系统提示第 9,488 字符写着 "To search for files use glob instead of find or ls"，
  而且 `glob` **在**描述列出的 12 个名字里（字母序第一个）。模型照样用
  `Get-ChildItem -Recurse` 扫了三次目录。

所以问题不是名字看不看得见。手边有能干活的替代品时，模型不会为一个"更好用的工具"多花
一次往返；把名字全列出来是必要条件，不是充分条件。

各工具的实际字节数（22 工具基线，会话 `f2e0656d`）：

| 工具 | 字节 | 系统提示提到 | `b2dab545` 是否用 |
|---|---|---|---|
| subagent_fork | 1,272 | 1 | 否 |
| subagent | 1,165 | 5 | 否 |
| todo_write | 858 | 1 | **否，也没搜** |
| glob | 750 | 2 | **否，也没搜** |
| list_agents | 661 | 0 | 否 |
| load_workspace_dependencies | 632 | 0 | 否 |
| job_output | 615 | 1 | 否 |
| send_message | 527 | 0 | 否 |
| interrupt_agent | 514 | 0 | 否 |
| read_image | 389 | 0 | 否 |
| job_kill | 370 | 1 | 否 |
| skill | 332 | 4 | 否（用 `/reverse-engineer-anything` 直接注入） |
| web_fetch | 242 | 2 | 否（任务不联网） |
| job_list | 168 | 0 | 否 |

**处置：**

1. 描述改成全列，并补一句"指令里点了名、工具表里又没有的，多半在这里，先搜再绕过"。
2. `todo_write` 挪回常驻，+858 字节。它被系统提示点名，缺了是静默的（用户看不到进度），
   实测 0 次调用 0 次搜索。净省从 7,297 降到 6,439 字节。下一场它就被用了 2 次，见 2.13。
3. `glob` 继续延迟：替代品 `pwsh` 干活够用，代价只是绕开了提示词的偏好。

### 2.13 长会话实测：工具表全程没变，延迟的工具确实被用了（2026-10-23）

会话 `dfa69eef`，claude-code preset。用户要求"分析当前目录下的游戏如何注入指令，尽可能利用
子代理"。2 个 turn、70 步、88 次工具调用、50 分钟（UTC 12:19:47 → 13:09:58，即本地 20:19 → 21:09）。

**工具表全程恒定。** 整场只有一条 `request/header`，reason 是 `initial`：10 个工具、10,925
字节。88 次调用、6 次取回、4 个子代理，工具数组一个字节都没动——取回的 schema 进的是工具
结果消息，不是注册表。第一节里"取回即注册、数组多一个条目"的差距一，在这个实现里不成立。

**延迟的工具真的被用了，而且是长距离调用：**

| 工具 | 状态 | 用于 |
|---|---|---|
| `subagent` | 延迟 | 4 次（seq 185–188），并行派出 A/B/C/D 四个子代理，全部交付报告 |
| `send_message` | 延迟 | 1 次（seq 494），催一个还没交付的子代理，消息投递成功 |
| `todo_write` | 常驻 | 2 次（seq 179、521），范围确认后建表、收尾全部标完成 |

第一次取回 `subagent` 的 schema 是 UTC 12:20:03，真正调用是 12:23:17——中间隔了 160 个事件、
3 分 14 秒、18 个步。schema 留在历史里，隔这么久照样能用。

**代价是重复取回。** 全场 6 次 `tool_search`：2 次首次取回（seq 24 取 `subagent`+`list_agents`，
seq 308 一次取 4 个）、1 次空命中（找 REA 工具，那批工具不在本 preset）、3 次重搜
（`list_agents` 前后取回 3 次，`send_message` 取回 2 次）。模型不记得自己取过什么，深在历史
里的 schema 会被稀释。每次重搜两三百字节，摊到 70 步里约 4% 的轮次——不值得为此改代码：
唯一的替代方案是把工具重新注册回去，那正好破坏恒定工具表。

**这一场修正了 2.12 的结论。** 2.12 里 `subagent` 一次没调，是因为当时还在侦察阶段，模型
自己写着"先侦察再派"。等 `ask_user_question` 确认范围（seq 174）、`todo_write` 建表（179）
之后，它一次派了 4 个。所以延迟的上限不是"模型不用工具"，而是"在用户或任务给出必须用的
信号之前，想不起来用它"。`glob` 被 `pwsh` 替代也是同一回事：`pwsh` 够用，信号不够强。

### 2.14 首轮给全表：让第一次请求留在 Claude Code 的目录上（2026-10-23）

起因是看 dsh-TUI 那个项目（`ccch1mneyyy/dsh-TUI`）里的 liangshen preset。他们做的是反方向的
同类事，但顺手记了一条实测：**第一次请求的工具目录会锚定整场的行为**。V4 Pro 上，Minimal 那对
`bash` + `str_replace_editor` 首轮 5/5 落在 Minimal 轨迹；所有 standard 系 schema（pwsh/read、
只有 pwsh、沙箱 bash/read）11/11 掉回 standard 式行为。同一份记录里还有一条：首轮 `max_tokens`
1024 时 26/32 出现 `We need` 式开头，256000 时 0/5。

这对本 preset 是个反向风险。我们的目的是复刻 Claude Code 行为，而延迟把首轮工具表从 22 个砍到
10 个——首轮目录已经不是 Claude Code 的了。他们换的是壳工具身份（persistent bash 对 pwsh），
我们只是减外围工具（`glob`/`skill`/`subagent`/`web_fetch`/`read_image`/`job_*`），风险比他们那个
弱，但不是零。

**接法。** 加一个相位，配置键 `firstRequestFullCatalog`：

| 相位 | 触发条件 | 工具表 |
|---|---|---|
| 首轮 | 会话还没有持久的 `tool/call` | 原样给出装配结果，只摘掉 `tool_search` 自己。这一轮没有东西可搜，留着只会误导。22 个工具、17,222 字节 |
| 稳态 | 落下第一次 `tool/call` 之后 | 照旧摘掉 13 个 + 加回 `tool_search`。10 个工具、10,925 字节 |

首轮摘掉 `tool_search` 而不是留着，是因为它的描述写着「Deferred tools (schema not loaded)」——
首轮一个都没延迟，这句就是假的。

**相位从会话事件重建，不是进程内状态。** 用 `session.snapshotEvents()`（没有就用 `session.events`）
扫一次历史找 `tool/call`，之后靠 `session/event` 增量维护。这样恢复会话不会把首轮重放一遍——重放
会多一条 `request/header`，还让工具表白变一次。压缩不重置：压缩之后会话的风格已经定了，再放一次
全表只是多付一次钱。

读不出历史时按"已过首轮"处理。稳态是延迟，宁可少放一次全表，也不要因为一次读取失败把整张表长期
放出去。

**代价。** 每个会话多一条 `request/header`，首轮付全价 17,222 字节。2.13 那场 70 步的会话按 69 步
结账，仍是 69 × 6,297 ≈ 424 KB 的净省。真正变贵的是短会话：一次问答只有两次请求时，首轮全表 +
次轮延迟，比一直延迟多 6,297 字节。

**首次实测（2026-10-24 07:48）。** 会话 `23ee8da0`，任务「详细收集 kimi k3.1 pro 的消息并
报告」，路由 `magpie / codemaker-chat/deepseek-flash`。1 个 turn、20 步、37 次工具调用、103 秒。

| 序 | 事件 | reason | 工具数 | 字节 |
|---|---|---|---|---|
| seq 13 | `request/header` | `initial` | 22 | 17,222 |
| seq 25 | `request/header` | `change` | 10 | 10,925 |

全场两条，没有第三条。首轮那张表里没有 `tool_search`，22 个名字与 2.13 的基线逐字一致。

切换发生在第一次 `tool/call`（seq 19、20 的两次 `web_search`）之后的下一轮。seq 26 是 harness
自己发的 `developer/message`（`source.kind: tool-registry`）：一条 `tool-addition: tool_search`
加 13 条 `tool-removal`。模型被明确告知表变了，不用自己猜。

这条会话正好要 `web_fetch`——被延迟的 13 个之一。模型在表变化后的同一步里 `select:web_fetch`
（seq 28）拿到 schema，紧接的三次调用并发抓页面（seq 36–38），全场用了 23 次。`read_image`
同样先搜一次再用。37 次调用没有一次失败。

有一次空命中：seq 80 找 `multi_search`、`platform_search`、`advanced_search`、`free_search_test`，
0 结果。这四个名字来自 `web_search` 自己的描述末尾，而那四个工具被 `tool-surface` 挡掉了——
挡的是注册表，`tool_search` 的取回通道跟着一起断。

**已改（2026-10-24）。** 这四个从拦截名单挪到 `defer`，合计 2,984 字节（1,038 / 626 / 663 /
657）。稳态仍是 10 个工具，首轮从 22 变 26。和 2.12 的 `todo_write` 同一类问题：指令或描述
点名了工具，模型就真的会去找，挡掉它只换来一次空搜。

**还没验的事。** 这条锚定效应对 Claude Code 复刻成不成立，我们没有自己的数据。他们的数据是
Minimal 与 Standard 两个家族之间的分野，不是"像不像 Claude Code"。要验就同一道题跑若干次，
看开头风格和首个工具选择。在那之前，这只是把已知风险降一档，不是消除。

### 2.15 评估：要不要接 dsh-TUI 的 skill-search（2026-10-24）

看的是 `presets/liangshen/skill-search.mjs`。它做的事：把 `dsh-tool-skill` 整行换掉，不再注入
技能目录，改成两个工具——`skill_search`（按关键词查名字和描述，最多 20 条）、`skill_load`
（按名字取正文，`agent.inject` 进下一轮）。

**它盯的成本是真的。** 本工作区 28 个 skill 的目录 8,966 字节，从第一轮起就在历史里，每次请求
都跟着走。拆开：描述 7,543（85%）、名字 419、包装 879。比我们延迟 13 个工具省下的 6,297 字节
还大。

**但这笔钱有一行配置的杠杆。** `dsh-tool-skill` 自带 `catalogDescriptionMaxLength`（默认 500，
min 3），`docs/plugin-config-audit.md` 2.12 早就记过这条，preset 里却一直没设。描述第一句长度
中位数 63 字、p90 138 字、最长 498 字（`j-space`）。压到 120 之后目录约 6.1 KB，每次请求省
2.8 KB。

**技能用得少，但用的时候一步命中。** 扫了 80 场会话、约 9,500 次工具调用，`skill` 一共 11 次
（0.12%）。全部落在 seq 18–30，直接按目录点名：`jenkins-auth` 三场、`redmine`、
`h42-patch-reference`、`cordis` 两个（dev 与 standard 各一场）。没有一次走弯路。

**所以不接。** 三条：

1. 换成 `skill_search` 之后，那 11 次会从"看一眼目录直接调"变成"先搜再调"，而 `skill_load`
   把正文 inject 进下一轮，比现有 `skill` 工具还多一步。
2. 我们的提示词是从 Claude Code 原样搬的，第 105 行写着 "…matches a skill in the available
   skills list"。删掉目录这句话就悬空了——和 2.14 那四个检索工具同一类问题，只是方向相反。
3. 一行配置拿走 2.8 KB，没必要为剩下的 2.8 KB 加两个工具、改提示词、再背一套技能发现逻辑。

**留着备选。** 想再省不必换实现：把 `catalogDescriptionMaxLength` 压到 3，目录只剩名字
（约 1.3 KB，省 7.6 KB）；再不够才轮到按需搜索。

---

## 三、两者的关系

- 差距一决定"取回要不要付费"：现状是每次取回付一次，一次取全可以压到一次。
- 差距二决定"谁付、付几次"：现状是全预设共用一个状态，取回效果会泄漏到别的会话。
- 只修差距二：每个会话的取回各自计费，语义正确，但 resume 仍有一次重建。
- 只修差距一：工具表恒定，取回免费，但状态仍然是共享的，泄漏依旧。
- 两个都修：才等价于 cc-haha 的模型——工具表恒定 + 状态按会话。

---

## 四、附录

### 4.1 代码索引

| 关注点 | 包 | 符号 |
|---|---|---|
| 工具定义上的延迟标记 | `@deepseek-ai/dsh-tools` | `defineTool({ deferLoading })`、注册表投影 |
| 工具变更消息的生成 | `@deepseek-ai/dsh-agent-loop` | `buildRequest()` 里 `tool-addition` / `tool-removal` |
| DeepSeek 协议的表达 | `@deepseek-ai/dsh-llm-deepseek` | `serialize()`、beta 常量 `mid-conversation-tool-changes-2026-07-01` |
| pi-ai 路由的兼容性判定 | `@deepseek-ai/dsh-llm-pi-ai` | `conversationUpdates(model)` |
| pi-ai 丢弃 deferred 工具 | `@deepseek-ai/dsh-llm-pi-ai` | `toolsOf(options)` |
| pi-ai 的工具锚定判定 | `@deepseek-ai/dsh-llm-pi-ai`（依赖 `@earendil-works/pi-ai`） | `appendDeveloper()`、`resolveTranscriptTools()` 的 `anchorsAdditions` |
| Anthropic 全延迟占位工具 | `@deepseek-ai/dsh-llm-pi-ai` | `ANTHROPIC_TOOL_UPDATE_PLACEHOLDER` |
| 遮罩的作用域语义 | `@deepseek-ai/dsh-tools` | `restrict()`、`scopeOf()` |

### 4.2 本 preset 的实测数据

- 隔离 profile、25 个宿主工具：`restrict at mount` 一次挡掉 25 个；请求里只剩 `tool_search`（808 字节）。
- 宣告：25 个名字一条消息，344 字符，出现在第一次请求的上下文里；两步会话只发一次。
- 取回：`select:web_fetch` 后下一次请求多一个工具（1 → 2），缓存从该 token 起失效；没有重复宣告。
- 静态能力包（web）在 magpie 环境下与延迟池重叠：`web_search` / `web_fetch` 本来就由宿主层挂载，
  因此走的是"挡住再取回"的路径，而不是"动态挂包"的路径。
