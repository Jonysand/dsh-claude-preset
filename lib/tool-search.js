/**
 * 延迟加载的两半：暴露层（装配时摘工具）和发现入口（`tool_search`）。
 *
 * 为什么摘装配而不是用 `deferLoading`：模型可见的 tools 由装配决定，而 `dsh-llm`
 * 在路由没有 `toolUpdate` 能力时会把 `deferLoading` 标记剥掉、把工具全发出去
 * （`dsh-llm/lib/index.js` 的 `projectToolUpdates`）。那条路在非 Anthropic 路由上
 * 静默失效，只剩"以为省了"的错觉。装配层摘掉是路由无关的：工具压根不进请求。
 *
 * 摘掉之后工具仍然可执行：执行从 registry 解析（`dsh-tools` 的 `resolveExecution`），
 * 不看这份装配结果。所以发现之后，模型按名字直接调用即可，不需要包装工具。
 *
 * 两半是同生共死的：**发现工具注册失败时整层不启用**。否则工具被摘掉、模型又没有
 * 找回入口，那是一个不可恢复的坏状态。配置为空时两半都不做，插件是空操作。
 *
 * 作用域：监听器和工具都挂在 preset 自己的插件树上，只对本 preset 代际的会话可见。
 * 同进程里别的 preset 不受影响（实测见 docs/deferred-tools-gaps.md 2.8）。
 */

/** 发现工具的名字。它自己永远不进延迟名单。 */
const TOOL_NAME = 'tool_search'

/** 关键词搜索默认返回几条。 */
const MAX_RESULTS_DEFAULT = 5

/** `max_results` 的硬上限，防止一次把整个目录拉回来。 */
const MAX_RESULTS_LIMIT = 50

/** 单次搜索结果的上限。超过就截断并说明。 */
const MAX_RESULT_BYTES = 100_000

/** 默认不延迟任何工具。真正开启靠配置里的 `defer`。 */
const DEFAULT_DEFERRED = []

/**
 * 从工具表里滤掉延迟工具。
 *
 * 纯函数，单独测：不改入参、没命中时返回原数组（保持引用，下游不必重新渲染），
 * 命中了才复制一份。
 *
 * @param tools 装配产出的工具 schema 数组；非数组原样返回。
 * @param deferred 要摘掉的名字集合。
 * @returns 过滤后的工具表。
 */
export function filterTools(tools, matcher) {
	if (!Array.isArray(tools)) return tools
	if (matcher === undefined || matcher === null || matcher.isEmpty === true) return tools
	let removed = false
	const kept = []
	for (const tool of tools) {
		const name = tool?.name
		if (typeof name === 'string' && matcher.has(name)) {
			removed = true
			continue
		}
		kept.push(tool)
	}
	return removed ? kept : tools
}

/** 只收字符串、去重、丢掉空项。配置写错不该让装配失败。 */
function toNameSet(list) {
	const names = new Set()
	if (!Array.isArray(list)) return names
	for (const item of list) {
		if (typeof item === 'string' && item.length > 0) names.add(item)
	}
	return names
}

/**
 * 通配匹配，只认一个 `*`：`mcp__*`、`mcp__rea__*`、`*_tool` 这类。
 *
 * MCP 的工具名是 `mcp__<server>__<tool>`，数量随 server 变，写不进精确名单，
 * 所以延迟配置要能表达"这一类"。多个 `*` 按字面处理（直接不匹配），避免写出
 * 一个谁也算不清的模式。
 */
export function matchesPattern(name, pattern) {
	if (typeof name !== 'string' || typeof pattern !== 'string') return false
	const star = pattern.indexOf('*')
	if (star === -1) return name === pattern
	if (pattern.indexOf('*', star + 1) !== -1) return false
	const prefix = pattern.slice(0, star)
	const suffix = pattern.slice(star + 1)
	return name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)
}

/**
 * 把"精确名单 + 通配模式"合成一个判定器。
 *
 * 发现工具自己永远不延迟——被延迟就等于关掉找回入口。这条写进 `has()` 里，
 * 装配过滤和搜索目录两处都自动遵守。
 */
export function createMatcher(exactNames, patterns) {
	const exact = exactNames instanceof Set ? exactNames : toNameSet(exactNames)
	const list = Array.isArray(patterns) ? patterns.filter((pattern) => typeof pattern === 'string' && pattern.length > 0) : []
	return {
		exact,
		patterns: list,
		isEmpty: exact.size === 0 && list.length === 0,
		has(name) {
			if (typeof name !== 'string' || name.length === 0) return false
			if (name === TOOL_NAME) return false
			if (exact.has(name)) return true
			return list.some((pattern) => matchesPattern(name, pattern))
		},
	}
}

/** 把工具名切成可比的段：`mcp__github__create_issue` → mcp / github / create / issue。 */
export function tokenizeName(name) {
	if (typeof name !== 'string') return []
	return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** 描述里是否作为整词出现。`containsWord('create a repo', 'rea')` 为假，避免子串误命中。 */
export function containsWord(text, word) {
	if (typeof text !== 'string' || text.length === 0 || word.length === 0) return false
	const boundary = /[a-z0-9]/
	let index = text.indexOf(word)
	while (index !== -1) {
		const before = index === 0 ? '' : text[index - 1]
		const after = index + word.length >= text.length ? '' : text[index + word.length]
		if (!boundary.test(before) && !boundary.test(after)) return true
		index = text.indexOf(word, index + 1)
	}
	return false
}

/**
 * 在候选目录里查工具。
 *
 * 两种查询形式：
 * - `select:A,B`：按名字精确取（大小写不敏感），不认识的单独报出来；
 * - 关键词：按"名字命中 > 描述命中"打分，`+term` 表示该词必须有。
 *
 * 纯函数，单独测。
 *
 * @param query 原始查询串。
 * @param catalog 候选目录，每项至少要有 `name`，可选 `description`。
 * @param maxResults 关键词模式最多返回几条。
 * @returns 命中的名字（保持目录顺序或打分顺序）与没认出来的名字。
 */
export function searchTools(query, catalog, maxResults = MAX_RESULTS_DEFAULT) {	const list = Array.isArray(catalog) ? catalog.filter((tool) => typeof tool?.name === 'string') : []
	const text = typeof query === 'string' ? query.trim() : ''
	if (text.length === 0) return { names: [], unknown: [] }

	const select = /^select:(.*)$/i.exec(text)
	if (select !== null) {
		const byName = new Map(list.map((tool) => [tool.name.toLowerCase(), tool.name]))
		const names = []
		const unknown = []
		for (const raw of select[1].split(',')) {
			const wanted = raw.trim()
			if (wanted.length === 0) continue
			const hit = byName.get(wanted.toLowerCase())
			if (hit !== undefined) {
				if (!names.includes(hit)) names.push(hit)
				continue
			}
			// MCP 工具名是 mcp__<server>__<tool>，允许用裸工具名选取；重名就都给出来。
			const fuzzy =
				wanted.includes('__')
					? []
					: list.filter((tool) => tool.name.toLowerCase().endsWith(`__${wanted.toLowerCase()}`)).map((tool) => tool.name)
			if (fuzzy.length === 0) unknown.push(wanted)
			else for (const name of fuzzy) if (!names.includes(name)) names.push(name)
		}
		return { names, unknown }
	}

	const terms = text.toLowerCase().split(/\s+/).filter(Boolean)
	const required = terms.filter((term) => term.startsWith('+') && term.length > 1).map((term) => term.slice(1))
	const words = terms.filter((term) => !(term.startsWith('+') && term.length > 1))
	const scored = []
	for (const tool of list) {
		const name = tool.name.toLowerCase()
		const description = typeof tool.description === 'string' ? tool.description.toLowerCase() : ''
		const tokens = tokenizeName(name)
		let missing = false
		for (const term of required) {
			// 必选词按"整段"比：`mcp__github__create_issue` 的段是 mcp/github/create/issue，
			// 这样 `+rea` 不会被 `create` 里的 "rea" 误命中。
			if (!tokens.includes(term) && !containsWord(description, term)) {
				missing = true
				break
			}
		}
		if (missing) continue
		let score = 0
		for (const term of [...required, ...words]) {
			if (name === term) score += 10
			else if (tokens.includes(term)) score += 8
			else if (name.includes(term)) score += 6
			if (description.includes(term)) score += 2
		}
		if (score > 0) scored.push({ name: tool.name, score })
	}
	scored.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
	const limit = Number.isInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, MAX_RESULTS_LIMIT) : MAX_RESULTS_DEFAULT
	return { names: scored.slice(0, limit).map((entry) => entry.name), unknown: [] }
}

/** 把一条工具 schema 渲染成 Claude Code 那套 `<function>` 行。 */
function renderFunctionLine(schema) {
	return `<function>${JSON.stringify({
		description: schema.description ?? '',
		name: schema.name,
		parameters: schema.parameters ?? {},
	})}</function>`
}

/**
 * 拼搜索结果。
 *
 * 返回 `{ text, names }`：`text` 是进历史的正文，`names` 供日志用。
 * 超过字节上限时按整条丢弃并补一行说明——宁可少给一个，也不要给半段 schema。
 */
export function renderSearchResult(found, catalog, query) {
	if (found.length === 0) {
		const total = catalog.length
		return {
			names: [],
			text:
				`No deferred tool matched ${JSON.stringify(query)}. ` +
				`${total} deferred tool${total === 1 ? ' is' : 's are'} searchable but their names are not all listed here. ` +
				'Use "select:<exact-name>" when you know the name.',
		}
	}
	const lines = []
	const kept = []
	let bytes = 0
	let dropped = 0
	for (const schema of found) {
		const line = renderFunctionLine(schema)
		const size = Buffer.byteLength(line, 'utf8')
		if (bytes + size > MAX_RESULT_BYTES) {
			dropped += 1
			continue
		}
		bytes += size
		lines.push(line)
		kept.push(schema.name)
	}
	const parts = [`<functions>\n${lines.join('\n')}\n</functions>`]
	if (dropped > 0) {
		parts.push(`(${dropped} more match${dropped === 1 ? '' : 'es'} omitted: result too large. Narrow the query.)`)
	}
	return { names: kept, text: parts.join('\n\n') }
}

/**
 * 发现工具的描述。把这一层延迟了哪些名字直接写进去，模型才有线索可查。
 *
 * 名字全列、不截断：截断会让排在后头的名字彻底消失（按字母序，`todo_write`、
 * `web_fetch` 总是在末尾），而系统提示里又在要求模型用 `todo_write`——看得见
 * 的指令、看不见的工具，模型只会绕过。显式名单由配置作者控制，十几个名字几
 * 百字节，比它们各自的 schema 便宜两个数量级；数量大的工具族用 deferPatterns。
 */
function buildDescription(names, patterns) {
	const lines = ['Searches tools that are installed but not currently listed in your tool list, and returns their complete JSON Schema.']
	if (names.length > 0) {
		lines.push(`Deferred tools (schema not loaded): ${names.join(', ')}.`)
	}
	if (patterns.length > 0) {
		lines.push(
			`Also deferred: every tool matching ${patterns.join(', ')} — for example MCP tools named mcp__<server>__<tool>. Search them by keyword, or select the full name.`,
		)
	}
	lines.push(
		'',
		'If a tool your instructions name is missing from your tool list, it is probably deferred here: search for it instead of working around it.',
		'',
		'Query forms:',
		'- "select:web_fetch,read_image" — fetch these exact names',
		'- "select:create_issue" — an MCP tool may be selected by its bare name',
		'- "web fetch" — keyword search over names and descriptions',
		'- "+web fetch" — require "web" in the name, rank by the other terms',
		'',
		'Once a schema comes back, call that tool directly with its normal arguments. The schema stays valid for the rest of the conversation.',
	)
	return lines.join('\n')
}

/**
 * 手工构造 ToolDefinition。
 *
 * 不用 `defineTool` 是因为 preset 侧解析不到 `@deepseek-ai/dsh-tools`（profile 的
 * node_modules 里没有 @deepseek-ai/*）。这里按 `defineTool` 产物的形状写：
 * `dsh-tools` 的 `register()` 只要 `output: { schema, render }`，装配那边只读
 * `name`/`description`/`parameters`/`deferLoading`，执行那边调 `execute(args, exec)`
 * 再拿 `output.render(args, value)` 渲染内容。
 */
function createDefinition(getCatalog, deferredNames, patterns) {
	return {
		name: TOOL_NAME,
		description: buildDescription(deferredNames, patterns),
		parameters: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'select:A,B for exact names, or keywords. Prefix a term with + to require it.',
				},
				max_results: {
					type: 'integer',
					description: `Keyword mode result count, default ${MAX_RESULTS_DEFAULT}.`,
				},
			},
			required: ['query'],
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const query = typeof args?.query === 'string' ? args.query : ''
			if (query.trim().length === 0) throw new Error('tool_search: query must be a non-empty string')
			const catalog = getCatalog(exec).filter((tool) => tool.name !== TOOL_NAME)
			const { names, unknown } = searchTools(query, catalog, args?.max_results)
			const found = names
				.map((name) => catalog.find((tool) => tool.name === name))
				.filter((tool) => tool !== undefined)
			const rendered = renderSearchResult(found, catalog, query)
			const notes = []
			if (unknown.length > 0) notes.push(`Not found: ${unknown.join(', ')}.`)
			if (names.length > 0 && found.length === 0) notes.push('All matches disappeared between lookup and rendering.')
			return notes.length === 0 ? rendered.text : `${rendered.text}\n\n${notes.join(' ')}`
		},
	}
}

export const name = 'tool-search'
export const inject = ['tools']

export function apply(ctx, config) {
	const exact = toNameSet(config?.defer ?? DEFAULT_DEFERRED)
	// 控制工具永不被摘：摘掉它等于关掉找回入口。配置写错了就纠正并说一声。
	const listedControlTool = exact.delete(TOOL_NAME)
	const patterns = Array.isArray(config?.deferPatterns)
		? config.deferPatterns.filter((pattern) => typeof pattern === 'string' && pattern.length > 0)
		: []
	const matcher = createMatcher(exact, patterns)

	/** 上次报过的状态，只在变化时出声，避免每轮刷一行。 */
	let announced

	const report = (message) => {
		try {
			ctx.logger?.info?.(`tool-search: ${message}`)
		} catch {
			/* 日志失败不影响主流程 */
		}
		console.error(`[tool-search] ${message}`)
	}

	if (matcher.isEmpty) {
		report('exposure: no deferred tools configured (filter and tool_search are both off)')
		return
	}

	const names = [...exact].sort()
	if (listedControlTool) report(`${TOOL_NAME} was listed in defer and was removed from the list: it is never deferred`)

	/** 取当前 agent 作用域下可见的工具表，只留匹配延迟规则的那些。 */
	const getCatalog = (exec) => {
		let schemas
		try {
			schemas = exec?.agent === undefined ? ctx.tools.schemas() : ctx.tools.schemas(exec.agent)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			report(`catalog: schemas() failed: ${message}`)
			return []
		}
		if (!Array.isArray(schemas)) return []
		return schemas
			.filter((schema) => typeof schema?.name === 'string' && matcher.has(schema.name))
			.map(({ name: toolName, description, parameters }) => ({ name: toolName, description, parameters }))
	}

	// 先注册发现入口。注册失败就整层不启用——否则工具被摘掉却没有找回的路。
	try {
		ctx.tools.register(createDefinition(getCatalog, names, patterns))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		report(`discovery tool failed to register, deferral NOT enabled: ${message}`)
		return
	}

	const deferredSummary = [names.length > 0 ? names.join(',') : undefined, patterns.length > 0 ? `patterns ${patterns.join(',')}` : undefined]
		.filter((part) => part !== undefined)
		.join(' + ')
	report(`exposure: deferring ${deferredSummary}; ${TOOL_NAME} registered`)

	ctx.on('system-prompt/assemble', async (assembly, context, next) => {
		// 先让后面的监听器跑完，再拿最终工具表；装配结果是权威值，必须原样传下去。
		const assembled = await next()
		try {
			const before = Array.isArray(assembled?.tools) ? assembled.tools : undefined
			if (before === undefined) return assembled
			const present = before.map((tool) => tool?.name).filter((toolName) => typeof toolName === 'string')
			// 精确名单里写了、这次装配却没有的名字：多半是拼错了，或者那个插件根本没挂。
			// 通配模式不参与这项检查——匹配不到是正常的。
			const missing = names.filter((toolName) => !present.includes(toolName))
			const after = filterTools(before, matcher)
			const removed = present.filter((toolName) => matcher.has(toolName)).sort()
			const signature = `${before.length}>${after.length}:${missing.join(',')}`
			if (announced !== signature) {
				announced = signature
				const parts = [`exposure: ${before.length} -> ${after.length} tools`]
				if (removed.length > 0) parts.push(`removed ${removed.slice(0, 12).join(',')}${removed.length > 12 ? `, +${removed.length - 12}` : ''}`)
				else parts.push('nothing matched')
				if (missing.length > 0) parts.push(`| configured but absent: ${missing.join(',')}`)
				report(parts.join(' '))
			}
			return after === before ? assembled : { ...assembled, tools: after }
		} catch (error) {
			// 过滤器自己的异常不能弄断整轮装配：退回未过滤的结果，并留下证据。
			const message = error instanceof Error ? error.message : String(error)
			report(`exposure: filter failed, assembly left untouched: ${message}`)
			return assembled
		}
	})
}
