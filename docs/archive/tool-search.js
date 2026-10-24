/**
 * ToolSearch / 延迟加载（DSH 版）。
 *
 * cc-haha 用 defer_loading + tool_reference 实现「工具不声明也能被找到」；
 * DSH 没有这两个协议字段，但两条路都验证过可行：
 *   - 未挂载的能力包：运行时把插件挂进 agent 作用域，下一次请求立刻可见、可调用；
 *   - 被 tool-surface 挡掉的全局工具：撤掉那一个工具的 restrict 遮罩即可恢复。
 *
 * 目录有两个来源，合并成一个 tool_search：
 *   1. 静态 CATALOG：本 preset 里「可选的能力包」，按包名、关键词、包含的工具名检索；
 *   2. 动态延迟池：tool-surface 把宿主层挂进来的工具逐个挡住时登记的条目，
 *      每条带名字和一句摘要。tool-surface 没挂载时这部分为空。
 *
 * 调用形式：
 *   - 不带 query，或 query 写 list：列出全部可延迟条目（名字 + 一句摘要）；
 *   - select:<名字>：精确取回一个（可逗号分隔多个）；
 *   - 其它关键词：按名字、摘要、关键词模糊匹配。
 *
 * 两个环境约束（都实测过）：
 *   1) 本文件不 import 任何 @deepseek-ai/*，工具定义手写。外部路径加载的模块
 *      解析不到应用内的包，而手写定义只依赖 ctx.tools.register 的公开契约。
 *   2) 动态 import 目标包时先试裸包名（插件位于 DSH_HOME 内时可行），失败再退回
 *      app.asar 里的实体路径（Electron 进程支持 asar 的 file: 导入）。
 *
 * 发现靠推，不靠拉：每一步的 agent/pre-step 把「还没加载的工具名」追加成一条
 * <system-reminder> 用户消息，纯名字、不带描述——和 cc-haha 的宣告粒度一致，
 * 它那边的 formatDeferredToolLine 也只返回名字。模型开局就知道有什么，不必先
 * 调用一次才看见目录；名字进消息流、工具表不动，缓存只付一次消息成本。按 agent
 * 记账只发增量，压缩结束后清空记账重发剩余条目，因为旧消息已被摘要吃掉。
 *
 * 隐藏由 tool-surface 负责，本插件管取回和宣告。单独挂本插件时全局工具不会被挡住，
 * 目录里只剩静态能力包。
 */

export const name = 'tool-search'
export const inject = ['tools']

/** tool-surface 提供的延迟池服务名；没挂载时读不到，按空目录处理。 */
const DEFERRED_SERVICE = 'claudeDeferredTools'

/**
 * 可延迟的能力包。tools 只用于展示与搜索，真正注册由被挂载的插件完成。
 */
const CATALOG = [
	{
		id: 'web',
		summary: 'Web search and page fetch: web_search for queries, web_fetch for a URL.',
		keywords: 'web search fetch url http https internet browse page 网页 搜索 抓取 联网',
		tools: ['web_search', 'web_fetch'],
		spec: '@deepseek-ai/dsh-tool-web',
		entry: 'lib/index.js',
		config: { fetch: true, searchTimeoutMs: 60000 },
	},
]

const OUT = {
	schema: { type: 'string' },
	render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** 推导 app.asar 内的 node_modules 根目录；失败返回 undefined。 */
function appNodeModulesRoot() {
	try {
		const { dirname, join } = process.getBuiltinModule('node:path')
		const resources =
			typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
				? process.resourcesPath
				: join(dirname(process.execPath), 'resources')
		return join(resources, 'app.asar', 'dsh', 'node_modules')
	} catch {
		return undefined
	}
}

async function importCapability(entry) {
	try {
		return await import(entry.spec)
	} catch (bareError) {
		const root = appNodeModulesRoot()
		if (root === undefined) throw bareError
		const { pathToFileURL } = process.getBuiltinModule('node:url')
		const { join } = process.getBuiltinModule('node:path')
		const file = join(root, entry.spec, entry.entry)
		try {
			return await import(pathToFileURL(file).href)
		} catch (asarError) {
			throw new Error(
				`${entry.spec}: bare import failed (${bareError.message}); asar import failed (${asarError.message})`,
			)
		}
	}
}

/** 读取延迟池；tool-surface 没挂载时返回 null。 */
function deferredPool(ctx) {
	try {
		const pool = ctx.get(DEFERRED_SERVICE)
		if (pool === undefined || pool === null || typeof pool.list !== 'function') return null
		return pool
	} catch {
		return null
	}
}

/** 把静态能力包和动态延迟池拍平成同一种条目。 */
function entries(ctx) {
	const list = CATALOG.map((entry) => ({
		kind: 'package',
		name: entry.id,
		tools: entry.tools,
		summary: entry.summary,
		keywords: entry.keywords,
		entry,
	}))
	const pool = deferredPool(ctx)
	if (pool !== null) {
		for (const item of pool.list()) {
			list.push({ kind: 'tool', name: item.name, tools: [item.name], summary: item.summary, keywords: '' })
		}
	}
	return list
}

function matches(item, query) {
	const needle = query.toLowerCase()
	return (
		item.name.toLowerCase() === needle ||
		item.tools.some((tool) => tool.toLowerCase() === needle) ||
		item.name.toLowerCase().includes(needle) ||
		item.summary.toLowerCase().includes(needle) ||
		item.keywords.toLowerCase().includes(needle)
	)
}

/**
 * 精确优先：先找同名的延迟工具，再找同名的能力包，最后才允许「包里有这个工具」
 * 或模糊匹配。否则 select:web_fetch 会先命中 web 包，把整包 web_search + web_fetch
 * 一起挂上，和调用方点名要的那一个不是一回事。
 */
function pick(all, query) {
	const needle = query.toLowerCase()
	const exactTool = all.find((item) => item.kind === 'tool' && item.name.toLowerCase() === needle)
	if (exactTool !== undefined) return exactTool
	const exactPackage = all.find((item) => item.kind === 'package' && item.name.toLowerCase() === needle)
	if (exactPackage !== undefined) return exactPackage
	return all.find((item) => matches(item, query))
}

function describe(item) {
	return item.kind === 'package' ? `${item.name} (${item.tools.join(', ')}) — ${item.summary}` : `${item.name} — ${item.summary}`
}

/** 宣告消息的来源标签，用于在会话里识别自己写的那条。 */
const ANNOUNCE_SOURCE = 'deferred-tools'

function newId() {
	try {
		return process.getBuiltinModule('node:crypto').randomUUID()
	} catch {
		return `${Date.now()}-${Math.random().toString(16).slice(2)}`
	}
}

/** 会话层把消息当不可变值保存，这里先深冻结。 */
function deepFreeze(value) {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
	for (const key of Object.keys(value)) deepFreeze(value[key])
	return Object.freeze(value)
}

/** 一条宣告消息：纯名字列表，与 cc-haha 的宣告粒度一致（描述留给 tool_search）。 */
function announcementMessage(names) {
	const text = [
		'<system-reminder>',
		'The following deferred tools are available via tool_search:',
		...names,
		'</system-reminder>',
	].join('\n')
	return deepFreeze({
		id: newId(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: { kind: ANNOUNCE_SOURCE, form: 'notice', summary: `${names.length} deferred tool(s)` },
	})
}

/** 当前还没加载的工具名：未挂载能力包里的工具 + 延迟池里的工具。 */
function pendingNames(ctx, mounted) {
	const names = []
	for (const entry of CATALOG) {
		if (mounted.has(entry.id)) continue
		for (const tool of entry.tools) names.push(tool)
	}
	const pool = deferredPool(ctx)
	if (pool !== null) for (const item of pool.list()) names.push(item.name)
	return [...new Set(names)].sort()
}

/**
 * 发现靠推：每一步把还没宣告过的延迟工具名追加成一条 <system-reminder> 消息。
 * 名字进消息流、工具表不动，所以只付一次消息成本；按 agent 记账只发增量；
 * 压缩结束后清空记账，下一步重发剩余条目（旧消息已被摘要吃掉）。
 */
function attachAnnouncement(ctx, mounted) {
	const announcedByAgent = new WeakMap()
	const agentBySession = new Map()

	const announce = (agent, decision) => {
		if (agent === null || agent === undefined) return decision
		let announced = announcedByAgent.get(agent)
		if (announced === undefined) {
			announced = new Set()
			announcedByAgent.set(agent, announced)
		}
		try {
			const sessionId = agent.session?.id
			if (typeof sessionId === 'string') agentBySession.set(sessionId, agent)
		} catch {
			/* 拿不到会话 id 只影响压缩后的重发，不影响本次宣告 */
		}
		const fresh = pendingNames(ctx, mounted).filter((name) => !announced.has(name))
		if (fresh.length === 0) return decision
		for (const name of fresh) announced.add(name)
		console.error(`[tool-search] announced ${fresh.length} deferred tool(s): ${fresh.join(',')}`)
		return { ...decision, messages: [...decision.messages, announcementMessage(fresh)] }
	}

	const disposeStep = ctx.on('agent/pre-step', async (payload, next) => {
		const decision = await next()
		if (decision === null || decision === undefined || decision.kind !== 'enter') return decision
		if (payload?.signal?.aborted === true) return decision
		if (!Array.isArray(decision.messages)) return decision
		try {
			return announce(payload?.agent, decision)
		} catch (error) {
			console.error(`[tool-search] announce failed: ${error?.message ?? error}`)
			return decision
		}
	})
	if (typeof disposeStep === 'function') ctx.effect(() => disposeStep, 'tool-search: deferred announcements')

	const disposeEvents = ctx.on('session/event', (session, event) => {
		if (event === null || typeof event !== 'object' || event.type !== 'compaction/end') return
		const agent = agentBySession.get(session?.id)
		if (agent === undefined) return
		announcedByAgent.delete(agent)
		console.error('[tool-search] compaction ended: deferred announcements will be re-sent')
	})
	if (typeof disposeEvents === 'function') ctx.effect(() => disposeEvents, 'tool-search: compaction reset')
}

function createDefinition(ctx, mounted) {
	return {
		name: 'tool_search',
		description:
			'Load a capability that is not in the current tool list. Tools from outside this preset and optional packages are deferred to keep requests small. ' +
			'Query forms: "list" (or an empty query) for every deferred name with a one-line description; "select:<name>" for exact names, comma-separated to load several at once; or keywords such as "web search". ' +
			'Every load rewrites the tool table and invalidates prompt-cache reuse, so load everything you need in one call instead of one at a time. ' +
			'Loaded tools become callable from the next step of this same turn.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'list, select:<name>[,<name>...] to load several in one call, or keywords' },
			},
			required: ['query'],
			additionalProperties: false,
		},
		output: OUT,
		async execute(args) {
			const raw = typeof args?.query === 'string' ? args.query.trim() : ''
			const all = entries(ctx)
			const listing = all.length > 0 ? all.map(describe).join('\n- ') : '(none)'
			if (raw === '' || /^list$/i.test(raw)) {
				return `Deferred capabilities (load any subset in one call: select:<name>[,<name>...]):\n- ${listing}`
			}
			const selectMatch = raw.match(/^select:(.+)$/i)
			const queries = selectMatch ? selectMatch[1].split(',').map((part) => part.trim()).filter(Boolean) : [raw]
			const hits = []
			for (const query of queries) {
				const item = pick(all, query)
				if (item !== undefined && !hits.includes(item)) hits.push(item)
			}
			if (hits.length === 0) return `No deferred capability matched "${raw}". Deferred:\n- ${listing}`
			const lines = []
			for (const item of hits) {
				if (mounted.has(item.name)) {
					lines.push(`${item.name}: already loaded (${item.tools.join(', ')})`)
					continue
				}
				if (item.kind === 'tool') {
					const pool = deferredPool(ctx)
					const released = pool === null ? null : pool.take(item.name)
					if (released === null) {
						lines.push(`${item.name}: could not be released (no longer available)`)
						continue
					}
					mounted.add(item.name)
					lines.push(`${item.name}: released (${item.tools.join(', ')})`)
					continue
				}
				try {
					const module = await importCapability(item.entry)
					const plugin =
						typeof module.apply === 'function'
							? { name: `deferred:${item.name}`, apply: module.apply, inject: module.inject, Config: module.Config }
							: module.default
					if (plugin === undefined) throw new Error('module exports neither apply nor default')
					ctx.plugin(plugin, item.entry.config ?? {})
					mounted.add(item.name)
					lines.push(`${item.name}: loaded (${item.tools.join(', ')})`)
				} catch (error) {
					lines.push(`${item.name}: failed to load — ${error?.message ?? error}`)
				}
			}
			return `${lines.join('\n')}\nLoaded tools are callable from the next step; call them directly instead of calling tool_search again for the same names.`
		},
	}
}

export function apply(ctx) {
	const mounted = new Set()
	ctx.tools.register(createDefinition(ctx, mounted))
	attachAnnouncement(ctx, mounted)
}
