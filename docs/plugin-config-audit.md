# DSH 工具插件配置能力清单

只读审计。没有安装 bundle，没有改 profile，没有动 `~/.dsh`。

- 审计对象：18 个包，全部列在第 1 节总表。
- 版本：DSH `0.2.1-rc.2`（app.asar 内各包 package.json）。
- 目标：判断「少工具 + 短 schema」能靠 `config.plugins` 做到多少。

## 0. 方法与一个必须说明的限制

`cordis_inspect_query`（platform=host, provider=Config）在本 profile 里只对状态为 `schema` 的 entry 投影 JSON Schema。18 个候选包中，凡是被 preset 引用的工具行，`listConfigs` 返回的都是：

```json
{
  "id": "include:tool-fs",
  "name": "@deepseek-ai/dsh-tool-fs",
  "status": "inactive",
  "packageDir": "...\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-tool-fs"
}
```

没有 `schema` 字段。persona、time-context、tool-str-replace-editor、tool-pwsh-persistent、tool-bash-persistent、tool-present 这 6 个包在 live entry 目录里根本不存在，连 `packageDir` 都拿不到。

所以本清单的 schema 来源是两级：

1. `<packageDir>/README.md` 的 `Configuration` 表（README 自称 generated configuration catalog 是 exhaustive source）。
2. `<packageDir>/lib/index.js` 里插件自身的 `Config = z.object({...})` 与默认值常量。这是编译产物，比 README 更硬。

下面所有「不能改」「没有开关」的结论，都以这两级原文为准，不按包名推断。

路径简写：`<D>` = `C:\Users\liyongkun01\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai`。

---

## 1. 总表

| # | 包名 | 关键 config 键与默认值 | 能改 description | 能关工具 / 减工具 | 对 token 的杠杆点 |
|---|---|---|---|---|---|
| 1 | `dsh-persona` | `prefix`（必填）、`suffix=""`、`complete=false`、`includeRuntimeContext=true` | 否（无工具）；可改系统提示词 | n/a | `complete=true` 把系统提示词压成只剩 prefix；`includeRuntimeContext=false` 去掉可选运行时上下文 |
| 2 | `dsh-agent-instructions` | `maxBytes`（必填）、`maxSourceBytes=1048576`、`projectRootMarkers=[".git"]`、两组候选文件名 | 否 | n/a | `maxBytes` 直接封顶注入的 AGENTS.md 字节数；候选名单可收窄 |
| 3 | `dsh-time-context` | `timeZone`（默认进程时区）、`refreshIntervalMs=600000` | 否 | 否（只能整行卸载） | 调大 `refreshIntervalMs` 减少注入次数；`0` 反而每步都注入 |
| 4 | `dsh-tool-fs` | `read=true`、`readImage=true`、`write=true`、`edit=true`、`readLimit=2000`、`readMaxLineLength=2000`、`readMaxBytes=51200`、`readStreamMinSize=10485760` | 否（4 个 description 都硬编码） | 是（4 个布尔，逐个关） | 关工具直接删 schema；三个 read 上限压结果；`readLimit` 就是「read 最多 N 行」 |
| 5 | `dsh-tool-fs-search` | `sampleOverCapGlobResults`（必填）、`globMaxResults=100`、`grepMaxMatches=250`、`grepMaxLineBytes=2000`、`searchMetaMaxBytes=65536`、`rawOutputMaxBytes=20000000`、`graceMs=3000`、`stderrMaxBytes=65536`、`timeoutMs=30000` | 否 | 否（glob + grep 无条件同时注册） | 只能压结果条数/行宽；schema 不能删、不能改短 |
| 6 | `dsh-tool-str-replace-editor` | `maxOutputChars=16000`、`description`（长 multi-line 默认文案） | **是**（`description`） | 否（单工具；只能整行卸载） | 一个 schema 换掉 tool-fs 四个；description 可改短；`maxOutputChars` 压 view |
| 7 | `dsh-tool-pwsh` | `enableRunInBackground=true`、`promoteOnTimeout=true` | 否（固定长文案，Windows 沙箱再追加一段） | 否（单工具）；`enableRunInBackground=false` 只去掉 `run_in_background` 参数 | 几乎没有。description 是纯成本且不可缩短 |
| 8 | `dsh-tool-pwsh-persistent` | `backendType="shell"`、`timeoutMs=300000`、`maxOutputChars=16000`、`description`（默认一句） | **是**（`description`） | 否（单工具） | 可把 description 改成极短；schema 只有 `command` 一个参数；`maxOutputChars` 压输出 |
| 9 | `dsh-tool-bash-persistent` | 同 8：`backendType="shell"`、`timeoutMs=300000`、`maxOutputChars=16000`、`description` | **是**（`description`） | 否（单工具） | 同 8 |
| 10 | `dsh-tool-todo` | `allowParallelInProgress`（必填，无默认） | 否（description 由三段固定文案拼成） | 否（单工具） | 基本没有；并行/单活只切换一个短子句 |
| 11 | `dsh-tool-subagent` | `provider`（必填）、`toolName="subagent"`、`modelSelectionSettings=false`、`agentOptions`、`agentPreset`、`allowedAgentPresets`、`maxDepth`（默认 Host=1） | 否（文案由 provider/preset 选择拼接） | 半：每实例一个工具，零实例=没有；`toolName` 可改名 | `toolName` 唯一可改名点；`modelSelectionSettings=false` 省 3 个参数 + `list_subagent_models`；不开 allowlist 省 enum 与 preset 描述 |
| 12 | `dsh-tool-skill` | `catalogDescriptionMaxLength=500`（min 3） | 否 | 否（单工具） | `catalogDescriptionMaxLength` 是 skill catalog 的唯一字符杠杆；schema 本身不可减 |
| 13 | `dsh-skill-filesystem` | `providerName="filesystem"`、`includeDefaultRoots=true`、`customSkillDirs=[]`、`watch=true`、`watchUsePolling=false`、`watchStabilityThresholdMs=200`、`watchPollIntervalMs=100`、`watchMaxProjects=128`、`watchFollowSymlinks=true`、`dshHome`、`agentsHome`、`bundledSkillDir` | 否 | n/a（provider，不是工具）；可控制发现哪些 skill | 用 `includeDefaultRoots=false` + 精确 `customSkillDirs` 减少 skill 数量，间接缩 catalog |
| 14 | `dsh-tool-web` | `search=true`、`fetch=true`、`searchMaxResults=8`、`searchMaxQueries=4`、`fetchTimeoutMs=30000`、`searchTimeoutMs=30000`、`fetchMaxOutputChars=200000` | 否 | **是**（`search` / `fetch` 各自开关） | 关掉 fetch 同时删 schema 和 guidance；`searchMaxQueries` 会改 schema 文案；`fetchMaxOutputChars` 压结果 |
| 15 | `dsh-tool-jobs` | `waitTimeoutMs=30000`、`maxWaitTimeoutMs=600000`、`completionDelivery="wakeup"`、`maxConsecutiveWakes`（未设） | 否 | 否（`job_output` / `job_list` / `job_kill` 固定三件套） | 没有 schema 杠杆；`quiet` 只省唤醒轮次，不省 schema |
| 16 | `dsh-tool-present` | `maxFiles=8` | 否 | 否（单工具） | 没有；maxFiles 只限单次调用 |
| 17 | `dsh-compaction-tool-result-pruner` | `thresholdChars=8192`、`headChars=4096`、`tailChars=1024` | n/a | n/a | 在压缩触发时把超长工具结果砍成 head+marker+tail；三值越小越省 |
| 18 | `dsh-compaction-basic` | `thresholdRatio=0.8`、`headroomTokens=65536`、`retainRatio=0.16`、`retainTokens`（未设）、`summarizationProvider=""`、`summarizationModel=""`、`maxTokens=65536`、`compactionRetries=1`、`maxOverflowRetries=1`、`modelPolicies=[]`、`auto=true` | n/a | n/a | 决定何时摘要、保留多少原文；不能压 system prompt / tools / 单条不可分单元 |

---

## 2. 逐包 schema 与配置结论

### 2.1 `@deepseek-ai/dsh-persona`

```ts
const Config = z.object({
  prefix: z.string().required(),                    // 必填
  suffix: z.string().default(""),                   // ""
  complete: z.boolean().default(false),             // false
  includeRuntimeContext: z.boolean().default(true)  // true
});
```

- 这不是工具包，不产生 tool schema，也不改任何工具 description。
- `complete: true` 会让 prefix 成为该 agent 唯一的 system prompt，其他 section 全部不渲染；这是整个清单里对 system prompt 最强的杠杆。
- `includeRuntimeContext: false` 只压可选运行时上下文，必需上下文（如 cwd）仍然保留。
- 只能挂在 preset 内。挂到全局会与 `dsh-system-prompt` 自己的 persona 注册冲突并直接报错（README 原文：mounting it globally collides … and fails loud）。
- 结论：想「短系统提示词」就配它；对工具面一点作用都没有。

### 2.2 `@deepseek-ai/dsh-agent-instructions`

```ts
const Config = z.object({
  projectRootMarkers: z.array(z.string()).default([".git"]),
  maxBytes: z.number().required(),                  // 必填，无默认
  maxSourceBytes: z.number().step(1).min(1).default(1048576),
  instructionFileCandidates: z.array(z.string()).default(["AGENTS.md", "CLAUDE.md"]),
  localInstructionFileCandidates: z.array(z.string()).default(["AGENTS.local.md", "CLAUDE.local.md"])
});
```

- 没有工具，也没有 description。
- `maxBytes` 是硬上限：渲染结果永不超过它；超预算时先丢较宽的整文件，最后才截断最具体的文件。
- `maxSourceBytes` 只限制单个源文件，不是注入总量。
- 结论：要省 AGENTS.md 的 token 就压 `maxBytes`；想完全不要这段上下文，直接不挂这一行。

### 2.3 `@deepseek-ai/dsh-time-context`

```ts
const Config = z.object({
  timeZone: z.string(),          // 可选；省略时用进程时区
  refreshIntervalMs: z.number()  // 可选；默认 600000
});
```

- 没有工具，也没有 description。
- 正数间隔内不会重复注入；`0` 表示每个 eligible step 都注入。
- **没有 disable 开关**。第一 eligible step 一定会注入一次；`refreshIntervalMs` 调到很大也只能减少后续注入。
- 结论：不想要时钟上下文就卸载整行；想保留但少花钱就保持 10 分钟或更大，别设 0。

### 2.4 `@deepseek-ai/dsh-tool-fs`

```ts
const Config = z.object({
  read: z.boolean().default(true),
  readImage: z.boolean().default(true),
  write: z.boolean().default(true),
  edit: z.boolean().default(true),
  readLimit: z.number().default(2000),        // 正整数；一次 read 的默认行数，也是上限
  readMaxLineLength: z.number().default(2000),// 正整数；单行截断字符数
  readMaxBytes: z.number().default(51200),    // 正整数；一次 read 选区的字节上限
  readStreamMinSize: z.number().default(10485760) // 正整数；达到此大小走流式
});
```

- 四个工具名和 description 全部硬编码：
  - `read` = `"Read a UTF-8 text file and return line-numbered content."`
  - `write` = `"Create or fully replace a UTF-8 text file."`
  - `edit` = `"Edit an existing UTF-8 text file by replacing literal text."`
  - `read_image` = `"Read a PNG/JPEG/WebP/GIF file and return the image itself. ..."`
- `readLimit` 是「默认值也是硬上限」：模型传更大的 `limit` 会直接报 `limit must be less than or equal to N`。所以「read 硬性截断到 N 行」这件事**配置就能做到**，不需要新插件；把 `readMaxBytes` 调到足够大，避免字节上限先截断即可。
- 关掉某个工具就是省它的 schema + 它的提示词段。四个布尔可以全关。
- 关 `read` 不会绕过 fs-observation-policy：已有文件的写/改仍要求先被观察过，必要时得靠另一个 reader 建立 observation。
- 结论：工具面/结果体积的主要控制点都在这个包，且都在 config 里；唯一做不到的是改 description。

### 2.5 `@deepseek-ai/dsh-tool-fs-search`

```ts
const Config = z.object({
  sampleOverCapGlobResults: z.boolean().required(), // 必填，无 fallback
  globMaxResults: z.number().default(100),
  grepMaxMatches: z.number().default(250),
  grepMaxLineBytes: z.number().default(2000),
  searchMetaMaxBytes: z.number().default(65536),
  rawOutputMaxBytes: z.number().default(20000000),
  graceMs: z.number().default(3000),
  stderrMaxBytes: z.number().default(65536),
  timeoutMs: z.number().default(30000)
});
```

- `glob` 和 `grep` 无条件同时注册，没有单独开关。要只留一个，只能不挂这个包，或用另一层 scoped tool restriction 按 Agent 隐藏（那不属于本包 Config）。
- description 固定，不能改短。
- `sampleOverCapGlobResults` 影响的是超限 glob 的排序策略和 glob description 的一句话，不是 token 大小的主要开关。
- 结果侧可压：`globMaxResults`、`grepMaxMatches`、`grepMaxLineBytes`。
- 结论：schema 侧没有可操作空间；只能压结果。

### 2.6 `@deepseek-ai/dsh-tool-str-replace-editor`

```ts
const Config = z.object({
  maxOutputChars: z.number().default(16000),  // 正整数
  description: z.string().default(DEFAULT_DESCRIPTION) // 非空，multi-line 默认文案
});
```

- 单工具 `str_replace_editor`，命令为 `view` / `create` / `str_replace` / `insert`。
- description 是全清单里少数真正可覆盖的之一；想让 schema 变短，直接把默认多行文案换成一句。
- `maxOutputChars` 只保留 view 的前缀，超出追加 clipping 提示。
- 没有工具开关；不想要就卸载整行。它没有 `replace_all`，也没有 `read_image`。
- 结论：如果目标是「一个编辑器工具 + 短 schema」，这是现成的最优解；但它替代不了 tool-fs 的图片读取和 replace_all。

### 2.7 `@deepseek-ai/dsh-tool-pwsh`

```ts
const Config = z.object({
  enableRunInBackground: z.boolean().default(true),
  promoteOnTimeout: z.boolean().default(true)
});
```

- 单工具 `pwsh`，名字和 description 都硬编码。description 很长：base 已包含「删/移前校验绝对路径」「不要给 `$HOME` 等自动变量赋值」「沙箱拒绝标记」等约定；当 Windows 沙箱 executor 挂载时还会再追加 ConstrainedLanguage 与命名管道 EPERM 一长段。
- **没有 description 配置键，无法缩短**。这是本清单里「description 是 token 大头且不可配」最典型的包。
- `enableRunInBackground=false` 会从 schema 去掉 `run_in_background` 参数，并拒绝强制后台调用；`promoteOnTimeout=false` 只改超时语义与 `timeoutMs` 的参数描述。
- 单个工具不能通过 config 关掉；只能整行卸载。
- 结论：如果目标是短 schema，优先考虑 persistent 版（description 可覆盖、schema 只有一个参数），或者不用 pwsh 工具。

### 2.8 `@deepseek-ai/dsh-tool-pwsh-persistent`

```ts
const Config = z.object({
  backendType: z.string().default("shell"),
  timeoutMs: z.number().default(300000),
  maxOutputChars: z.number().default(16000),
  description: z.string().default(
    "Run commands in a persistent PowerShell shell. State, including the current directory and exported environment variables, persists across calls for this agent."
  )
});
```

- 单工具 `pwsh`；description 可覆盖（非空校验）。
- schema 只有 `command` 一个字符串参数，是清单里最小的 shell 工具面。
- `timeoutMs` 到点会关闭 shell；`maxOutputChars` 保留输出前缀，固定诊断另加。
- 没有工具开关；不挂就没有。
- 结论：能满足「一个 shell 工具 + 短 schema + 可改描述」，但要求有 pwsh-dialect PTY backend。

### 2.9 `@deepseek-ai/dsh-tool-bash-persistent`

```ts
const Config = z.object({
  backendType: z.string().default("shell"),
  timeoutMs: z.number().default(300000),
  maxOutputChars: z.number().default(16000),
  description: z.string().default(
    "Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent."
  )
});
```

- 与 2.8 完全同构，只是方言和默认 description 不同。
- description 可覆盖；`maxOutputChars` 是唯一结果体积上限；单工具无开关。
- 结论：同 2.8。若目标工具名叫 `Bash`，config 改不了名字，见第 3 节。

### 2.10 `@deepseek-ai/dsh-tool-todo`

```ts
const Config = z.object({
  allowParallelInProgress: z.boolean().required() // 必填，无默认
});
```

- 单工具 `todo_write`，description 由固定三段拼接：
  - 固定头
  - `allowParallelInProgress ? 并行子句 : 单活子句`
  - 固定尾
- 没有 description 覆盖，也没有开关。并行/单活只改变中间一个短子句，token 差异很小。
- 省略 `allowParallelInProgress` 会在加载时直接失败，不能留空。
- 结论：工具面没有可裁剪空间；要么整行保留，要么整行去掉。

### 2.11 `@deepseek-ai/dsh-tool-subagent`

```ts
const Config = z.object({
  provider: z.string().required(),
  toolName: z.string().default("subagent"),
  modelSelectionSettings: z.boolean().default(false),
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
  }).default(void 0),
  agentPreset: z.string().min(1),
  allowedAgentPresets: z.array(z.string().min(1)).min(1).default(void 0),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")])
});
```

- **清单里唯一能改工具名的包**：`toolName`。想叫 `Agent` 或 `Task` 可以，想叫 `Read` 也只能做到名字，parameters 还是 subagent 的。
- description 不可配：由 provider 的 `inheritsParentContext` 决定两套文案，再由 model/preset 选择追加句子。想改文案只能改 provider 或写新插件。
- 每个实例注册一个工具，多实例就是多个 schema；不挂实例就没有。
- 省 schema 的配法：`modelSelectionSettings` 保持 false（省 3 个参数和 `list_subagent_models`），不配 `allowedAgentPresets`（省 enum 和 preset 描述）。
- `maxDepth` 为数值时，达到上限会多一条 runtime context；`"provider-managed"` 不发 cap，也不产生深度提示。
- 结论：能改名、能减实例；不能短 description。

### 2.12 `@deepseek-ai/dsh-tool-skill`

```ts
const Config = z.object({
  catalogDescriptionMaxLength: z.number().default(500) // min 3
});
```

- 单工具 `skill`；description 固定，无开关。
- 真正花钱的是 durable catalog：每个 skill 的名字 + 截断后的 description。`catalogDescriptionMaxLength` 是唯一直接杠杆。
- 注意：这个值只截 catalog 里的描述，**不截加载后的 skill 正文**；正文仍然可能很大。
- 结论：把 `catalogDescriptionMaxLength` 压到 60–120 能明显缩 catalog；schema 侧没办法。

### 2.13 `@deepseek-ai/dsh-skill-filesystem`

```ts
const Config = z.object({
  providerName: z.string().min(1).default("filesystem"),
  includeDefaultRoots: z.boolean().default(true),
  dshHome: z.string(),                    // 默认 $DSH_HOME 或 ~/.dsh
  agentsHome: z.string(),                 // 默认 $DSH_AGENTS_HOME 或 ~/.agents
  customSkillDirs: z.array(z.string()).default([]),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(200),
  watchPollIntervalMs: z.number().default(100),
  watchMaxProjects: z.number().default(128),
  watchFollowSymlinks: z.boolean().default(true),
  bundledSkillDir: z.string()
});
```

- 这是 provider，不是工具，没有 description 问题。
- 默认会扫 project `<root>/.dsh/skills`、`<root>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`，再加上 `customSkillDirs`。
- 想减少 skill 数量：`includeDefaultRoots: false` 后只留自己的 `customSkillDirs`（或反过来只留默认根）。数量直接决定 catalog 大小。
- `watch: false` 只停目录监听，不改变 catalog 大小。
- 结论：是「间接控制 catalog token」的包，单独配它不能缩 schema。

### 2.14 `@deepseek-ai/dsh-tool-web`

```ts
const Config = z.object({
  search: z.boolean().default(true),
  fetch: z.boolean().default(true),
  searchMaxResults: z.number().default(8),
  searchMaxQueries: z.number().default(4),
  fetchTimeoutMs: z.number().default(30000),
  searchTimeoutMs: z.number().default(30000),
  fetchMaxOutputChars: z.number().default(200000)
});
```

- description 固定，不能改。
- `search` / `fetch` 是真正的工具开关：关哪个就删哪个的 schema + 对应 guidance，`search` 还会自动切到 search-only 的提示文案。
- `searchMaxQueries` 会写进 schema 描述和 prompt guidance，改了会改 schema 文本；但太小会限制模型一次多查。
- `fetchMaxOutputChars` 只管结果，不缩 schema。
- 结论：能减一个工具（如果只要搜索）；不能短 description。

### 2.15 `@deepseek-ai/dsh-tool-jobs`

```ts
const Config = z.object({
  waitTimeoutMs: z.number().min(1).default(30000),
  maxWaitTimeoutMs: z.number().min(1).default(600000),
  completionDelivery: z.union(["quiet", "wakeup"]).default("wakeup"),
  maxConsecutiveWakes: z.number().min(1) // 未设
});
```

- 三件套 `job_output` / `job_list` / `job_kill` 一起注册，没有单独开关；description 固定。
- `completionDelivery: "quiet"` 只是不主动唤醒 idle agent，不省 schema。
- `waitTimeoutMs` 必须 ≤ `maxWaitTimeoutMs`，否则加载失败。
- 结论：schema 侧没有可裁剪空间。省 token 只能不挂这行，但那样 shell 的后台任务也失去控制工具。

### 2.16 `@deepseek-ai/dsh-tool-present`

```ts
const Config = z.object({
  maxFiles: z.number().default(8) // 必须是正安全整数
});
```

- 单工具 `present`，description 固定，无开关。
- `maxFiles` 只限制一次调用能声明的文件数，且 README 明确 schema 里建议「1-2 个、最多 4 个」——配置值和 schema 文案并不完全一致。
- 结论：没有 schema 杠杆；不需要这个交付能力就整行去掉。

### 2.17 `@deepseek-ai/dsh-compaction-tool-result-pruner`

```ts
z.object({
  thresholdChars: z.number().step(1).min(1).default(8192), // 正整数
  headChars: z.number().step(1).min(0).default(4096),      // 非负整数
  tailChars: z.number().step(1).min(0).default(1024)       // 非负整数
})
// 约束：headChars + marker + tailChars <= thresholdChars
```

- 不是工具，不产生 schema；只在 compaction 触发时重写超长工具结果。
- 默认就是把 >8192 字符的结果变成「前 4096 + `[... tool result middle pruned ...]` + 后 1024」。
- 想更省：同时降 `thresholdChars` 和 `headChars`/`tailChars`；三个数必须满足上面的不等式，否则加载报错。
- 它不改变「低于压力时不裁剪」这一事实，所以不能当成实时的输出上限。
- 结论：想压历史里的工具结果，这是最直接的包；它管不到 schema 和 description。

### 2.18 `@deepseek-ai/dsh-compaction-basic`

```ts
// 运行时校验（非 schemastery），键集与默认值：
thresholdRatio: number            // 0.8；(0,1]
headroomTokens: number            // 65536；非负整数
retainRatio: number               // 0.16；(0,1]；与 retainTokens 互斥
retainTokens?: number             // 未设；非负整数；与 retainRatio 互斥，且 < resolved threshold
summarizationProvider: string     // ""
summarizationModel: string        // ""
maxTokens: number                 // 默认取 headroomTokens（65536）；正整数
compactionRetries: number         // 1；非负整数
maxOverflowRetries: number        // 1；非负整数
modelPolicies: Array<{            // []
  provider: string;
  model: string;
  thresholdRatio?: number;
  headroomTokens?: number;
  retainRatio?: number;
  retainTokens?: number;
  summarizationProvider?: string;
  summarizationModel?: string;
  maxTokens?: number;
  compactionRetries?: number;
  maxOverflowRetries?: number;
}>
auto: boolean                     // true
```

- 不是工具，不产生 schema。
- `auto: false` 只关自动压缩/溢出恢复，`/compact` 这类手动入口仍可用（需 command-compact）。
- `thresholdRatio` 越低越早压缩；`retainRatio`/`retainTokens` 决定保留多少最近原文。
- 它明确压不了 system prompt、tools、session prefix，也拆不开单个不可分单元。
- 结论：这是「历史压缩」的旋钮，不是「工具面变短」的旋钮。

---

## 3. 必须写新插件才能做到的事

共 5 项。下面每一条都核对过 Config 键集与 `lib/index.js`，不是按包名猜的。

### 3.1 改绝大多数工具的 description / 参数说明

只有 3 个工具包有 `description` 键：

- `dsh-tool-str-replace-editor`
- `dsh-tool-pwsh-persistent`
- `dsh-tool-bash-persistent`

其余包都没有：

| 包 | Config 里没有 `description` 的证据 |
|---|---|
| `dsh-tool-fs` | `<D>/dsh-tool-fs/lib/index.js` 的 `Config` 只有 8 个键（read/readImage/write/edit/readLimit/readMaxLineLength/readMaxBytes/readStreamMinSize）；4 个工具 description 是 `defineTool` 里的字面量 |
| `dsh-tool-pwsh` | `Config` 只有 `enableRunInBackground` / `promoteOnTimeout`；`pwshDescription()` 是函数内硬编码，Windows 沙箱再拼一段 |
| `dsh-tool-fs-search` | `Config` 9 个键，无 description；glob/grep schema 里的文案固定 |
| `dsh-tool-todo` | `Config` 只有 `allowParallelInProgress`；description 由 `DESCRIPTION_HEAD/PARALLEL/SINGLE/TAIL` 拼接 |
| `dsh-tool-subagent` | `Config` 无 description；文案来自 `providerWording()` + 动态追加 |
| `dsh-tool-skill` | `Config` 只有 `catalogDescriptionMaxLength` |
| `dsh-tool-web` | `Config` 7 个键，无 description |
| `dsh-tool-jobs` | `Config` 4 个键，无 description |
| `dsh-tool-present` | `Config` 只有 `maxFiles` |

参数级 description（比如 `file_path`、`old_string`、`timeoutMs` 的说明）也全部写在 `defineTool.parameters` 里，没有 config 能改。

**判断依据**：逐包的 `Config = z.object({...})` 键集；以及 `defineTool({ description: "...", parameters: {...} })` 的字面量位置。只要 Config 没有对应键，Loader 就会把多出来的键判为未知配置或直接忽略，无法触达这些文案。

### 3.2 把工具名改成 Claude Code 风格（Read / Edit / Bash / Glob / Grep）

唯一有 `toolName` 的是 `dsh-tool-subagent`。其余包的工具名都写死在 `defineTool({ name: ... })`：

- tool-fs：`read` / `read_image` / `write` / `edit`
- fs-search：`glob` / `grep`
- pwsh：`pwsh`
- pwsh-persistent：`pwsh`
- bash-persistent：`bash`
- str-replace-editor：`str_replace_editor`
- todo：`todo_write`
- skill：`skill`
- web：`web_search` / `web_fetch`
- jobs：`job_output` / `job_list` / `job_kill`
- present：`present`

agent-preset 的 `config` 只有 `id` / `plugins` / `name` / `description` / `order`，没有 rename 或 alias；plugin row 的 `config` 也没有统一的名字覆盖层。

**判断依据**：各包 `Config` 键集 + `defineTool.name` 字面量；`dsh-agent-preset` 的 README 配置表。想保留原实现只换名字，只能写一个同名注册/代理插件。

### 3.3 让 `edit` 输出 unified diff，而不是成功提示

`dsh-tool-fs` 的 `edit` 成功结果固定为：

```ts
`The file ${displayPath} has been updated successfully.`
// replace_all 时：
`The file ${displayPath} has been updated. All occurrences were successfully replaced.`
```

`write` 固定为：

```text
<path>...</path>
<type>file</type>
<content>
Created file | Updated file
</content>
```

diff 只进 presentation meta（`computeHunkDiffs` → UI 卡片），不进模型可见结果。`str_replace_editor` 同样只回确认文本，`maxOutputChars` 和 `description` 都不改变输出格式。

**判断依据**：`formatEditOutput()` / `formatWriteOutput()` 是模块内固定函数；`Config` 没有任何输出格式键。要实现「Edit 回 unified diff」必须替换 renderer → 新插件。

### 3.4 拆开一个包里的工具（只留一部分）

- `dsh-tool-fs-search`：`glob` 和 `grep` 在 `apply()` 里无条件双双注册，Config 没有 `glob` / `grep` 布尔。想只留 `glob` 必须写插件（或用另一层 scoped tool restriction）。
- `dsh-tool-jobs`：三个工具一起注册，Config 没有单工具开关。
- 单工具包（pwsh、todo、present、skill、editor、persistent 两个）可以靠「不挂这一行」达到 0 个工具，但无法「保留包、去掉唯一工具」——这没有意义，所以不算缺口。

**判断依据**：`apply()` 中 `applyGlobTool(...)`、`applyGrepTool(...)`、`ctx.tools.register(job_output/job_list/job_kill)` 的调用没有 config 条件；`Config` 也没有对应键。

### 3.5 自定义 schema 文本（参数名、参数描述、enum 文案）

想把 `file_path` 改成 `path`、把 `old_string` 改成 `old_str`、把 `replace_all` 去掉、或把 `timeoutMs` 的参数说明压成一句，都没有 config 入口。schema 在 `defineTool.parameters` 里逐字写死。

**判断依据**：`parameters` 对象是编译期字面量，Config 不参与其构造（唯一例外是 `readLimit` 会插进 read 的 `limit` 描述模板，`searchMaxQueries` 会插进 web 的 schema 文案；但这是数字插值，不是文案替换）。

### 3.6 反过来：以下目标**不需要**新插件，config 就能做到

| 目标 | 做法 | 依据 |
|---|---|---|
| read 硬性最多 N 行 | `tool-fs` 配 `readLimit: N`；模型传更大值会报错 | `parseReadArgs` 用 `caps.limit` 做上限 |
| read 单行/单次输出更短 | `readMaxLineLength`、`readMaxBytes` | Config 键与 README 表 |
| 关掉 read_image / write / edit | 对应布尔设 false | Config 四个布尔 |
| 只保留 web_search | `tool-web` 配 `fetch: false` | Config 的 `search` / `fetch` |
| skill catalog 描述更短 | `tool-skill` 配 `catalogDescriptionMaxLength` | Config 唯一键 |
| 减少发现的 skill 数量 | `skill-filesystem` 的 `includeDefaultRoots` / `customSkillDirs` | README Roots 表 |
| 系统提示词只剩 persona | `persona` 配 `complete: true` | Config 键与 README |
| 去掉可选运行时上下文 | `persona` 配 `includeRuntimeContext: false` | Config 键 |
| 缩短 bash/pwsh persistent 描述 | 配 `description` | Config 键 |
| 工具结果在压缩时变短 | `tool-result-pruner` 配小 `thresholdChars/headChars/tailChars` | Config 键 + 不等式校验 |

---

## 4. 一句话结论

- 18 个包里，只有 3 个能直接改工具 description：`str-replace-editor`、`pwsh-persistent`、`bash-persistent`；`persona` 另可改系统提示词，但不碰工具 schema。
- 能靠 config 真正「减工具」的只有 `tool-fs`（4 个开关）和 `tool-web`（2 个开关）；`tool-subagent` 靠实例数/改名间接控制。
- 必须写新插件的目标共 5 项：① 改其余包的 description；② 改参数名/参数说明/enum 文案；③ 工具改名成 Read/Edit/Bash；④ `edit` 输出 unified diff；⑤ 拆 fs-search/jobs 的内部工具。
- `readLimit` 是例外：它已经能实现「read 硬截断到 N 行」，不要再为这个写插件。
