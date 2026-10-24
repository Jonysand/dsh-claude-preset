import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
	apply,
	containsWord,
	createMatcher,
	filterTools,
	matchesPattern,
	renderSearchResult,
	searchTools,
	tokenizeName,
} from '../lib/tool-search.js'

/** 装配监听器会往 stderr 打日志；测试期间收进数组，顺便当断言素材。 */
function captureStderr() {
	const lines = []
	const original = console.error
	console.error = (...args) => lines.push(args.join(' '))
	return { lines, restore: () => (console.error = original) }
}

/** 最小可用 ctx：记下注册的工具和监听器，schemas() 返回给定工具表。 */
function harness(schemas) {
	const listeners = new Map()
	const options = new Map()
	const registered = []
	const ctx = {
		logger: { info() {}, warn() {} },
		tools: {
			register(definition) {
				registered.push(definition)
				return () => {}
			},
			schemas() {
				return schemas
			},
		},
		on(name, listener, option) {
			const list = listeners.get(name) ?? []
			list.push(listener)
			listeners.set(name, list)
			if (option !== undefined) options.set(name, option)
			return () => {}
		},
	}
	return {
		ctx,
		registered,
		listener: (name) => listeners.get(name)?.[0],
		count: (name) => listeners.get(name)?.length ?? 0,
		options: (name) => options.get(name),
	}
}

test('matchesPattern 只认一个星号', () => {
	assert.equal(matchesPattern('read', 'read'), true)
	assert.equal(matchesPattern('read2', 'read'), false)
	assert.equal(matchesPattern('mcp__rea__ghidra', 'mcp__*'), true)
	assert.equal(matchesPattern('mcp__rea__ghidra', '*__ghidra'), true)
	assert.equal(matchesPattern('mcp__rea__ghidra', 'mcp__*__ghidra'), true)
	assert.equal(matchesPattern('mcp__gh__ghidra_x', 'mcp__*__ghidra'), false)
	assert.equal(matchesPattern('abc', '*b*'), false)
	assert.equal(matchesPattern(undefined, 'mcp__*'), false)
})

test('createMatcher 组合精确名单与通配', () => {
	const matcher = createMatcher(new Set(['web_fetch', 'tool_search']), ['mcp__*'])
	assert.equal(matcher.has('web_fetch'), true)
	assert.equal(matcher.has('mcp__rea__get_app_state'), true)
	assert.equal(matcher.has('read'), false)
	// 发现工具永不被延迟，否则找回入口会关掉自己
	assert.equal(matcher.has('tool_search'), false)
	assert.equal(createMatcher([], []).isEmpty, true)
	assert.equal(createMatcher([], ['mcp__*']).isEmpty, false)
})

test('filterTools 没命中时保持原引用', () => {
	const matcher = createMatcher(['web_fetch'], ['mcp__*'])
	const tools = [{ name: 'read' }, { name: 'web_fetch' }, { name: 'mcp__rea__x' }, { name: 'tool_search' }]
	const untouched = [{ name: 'read' }]
	assert.equal(filterTools(untouched, matcher), untouched)
	assert.deepEqual(
		filterTools(tools, matcher).map((tool) => tool.name),
		['read', 'tool_search'],
	)
	const empty = createMatcher([], [])
	assert.equal(filterTools(tools, empty), tools)
	assert.equal(filterTools(null, matcher), null)
})

test('tokenizeName 与 containsWord 按整段比对', () => {
	assert.deepEqual(tokenizeName('mcp__github__create_issue'), ['mcp', 'github', 'create', 'issue'])
	assert.equal(containsWord('create a repo', 'create'), true)
	// "create" 里含 "rea"，整词匹配必须挡住
	assert.equal(containsWord('create a repo', 'rea'), false)
	assert.equal(containsWord('fetch(url) failed', 'url'), true)
	assert.equal(containsWord('', 'x'), false)
})

test('searchTools 支持 MCP 裸名选取', () => {
	const catalog = [
		{ name: 'read', description: 'Read a file' },
		{ name: 'mcp__github__create_issue', description: 'Create a GitHub issue' },
		{ name: 'mcp__github__list_issues', description: 'List issues in a repo' },
	]
	assert.deepEqual(searchTools('select:create_issue', catalog).names, ['mcp__github__create_issue'])
	assert.deepEqual(searchTools('select:mcp__github__list_issues', catalog).names, ['mcp__github__list_issues'])
	assert.deepEqual(searchTools('select:nope', catalog).unknown, ['nope'])
	// 带 __ 的查询不做裸名回退，否则可能一次命中一串
	assert.deepEqual(searchTools('select:mcp__nope', catalog).unknown, ['mcp__nope'])
})

test('searchTools 关键词与必选词', () => {
	const catalog = [
		{ name: 'mcp__github__create_issue', description: 'Create a GitHub issue' },
		{ name: 'mcp__rea__ghidra_decompile', description: 'Decompile a function' },
	]
	assert.deepEqual(searchTools('decompile', catalog).names, ['mcp__rea__ghidra_decompile'])
	assert.equal(searchTools('github', catalog).names.length, 1)
	// 必选词按名字段比：+rea 不能被 create 里的 "rea" 误命中
	assert.deepEqual(searchTools('+rea', catalog).names, ['mcp__rea__ghidra_decompile'])
	assert.equal(searchTools('+rea decompile', catalog).names.length, 1)
	assert.deepEqual(searchTools('zzz', catalog).names, [])
	assert.deepEqual(searchTools('   ', catalog).names, [])
})

test('renderSearchResult 生成指定格式', () => {
	const tool = { name: 'web_fetch', description: 'Fetch a URL', parameters: { type: 'object' } }
	const rendered = renderSearchResult([tool], [tool], 'select:web_fetch')
	assert.ok(rendered.text.startsWith('<functions>\n<function>{'))
	const payload = JSON.parse(rendered.text.split('\n')[1].slice('<function>'.length, -'</function>'.length))
	assert.equal(payload.name, 'web_fetch')
	assert.equal(payload.description, 'Fetch a URL')
	assert.deepEqual(payload.parameters, { type: 'object' })
	assert.deepEqual(rendered.names, ['web_fetch'])

	const empty = renderSearchResult([], [tool, tool], 'zzz')
	assert.match(empty.text, /No deferred tool matched/)
	assert.match(empty.text, /2 deferred tools/)

	const huge = { name: 'huge', description: 'x'.repeat(120000), parameters: {} }
	const capped = renderSearchResult([huge], [huge], 'huge')
	assert.deepEqual(capped.names, [])
	assert.match(capped.text, /omitted/)
})

test('apply 在配置为空时完全不动作', () => {
	const stderr = captureStderr()
	try {
		const { ctx, registered, listener } = harness([])
		apply(ctx, undefined)
		assert.equal(registered.length, 0)
		assert.equal(listener('system-prompt/assemble'), undefined)
	} finally {
		stderr.restore()
	}
})

test('apply 注册发现工具并改写装配', async () => {
	const stderr = captureStderr()
	try {
		const schemas = [
			{ name: 'read', description: 'Read a file' },
			{ name: 'web_fetch', description: 'Fetch a URL', parameters: {} },
			{ name: 'mcp__rea__ghidra', description: 'Reverse', parameters: {} },
		]
		const { ctx, registered, listener } = harness(schemas)
		apply(ctx, { defer: ['web_fetch', 'tool_search'], deferPatterns: ['mcp__*'] })

		assert.equal(registered.length, 1)
		const definition = registered[0]
		assert.equal(definition.name, 'tool_search')
		assert.match(definition.description, /web_fetch/)
		assert.match(definition.description, /mcp__\*/)
		assert.equal(definition.output.schema.type, 'string')
		assert.deepEqual(definition.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])

		// 目录只含被延迟的工具；常驻的和自己都不在里面
		const exec = { agent: { id: 'session-test' } }
		const found = await definition.execute({ query: 'select:read' }, exec)
		assert.match(found, /Not found: read/)
		const got = await definition.execute({ query: 'select:web_fetch' }, exec)
		assert.match(got, /"name":"web_fetch"/)
		await assert.rejects(() => definition.execute({ query: '  ' }, exec), /non-empty/)

		// 装配过滤：精确名单 + 通配都生效，tool_search 保留
		const assembled = await listener('system-prompt/assemble')(
			{ tools: [] },
			{ agent: { id: 'session-test' }, scope: { id: 'session-test' } },
			async () => ({ tools: schemas.concat([{ name: 'tool_search' }]), variables: { provider: 'p' } }),
		)
		assert.deepEqual(
			assembled.tools.map((tool) => tool.name),
			['read', 'tool_search'],
		)
		assert.equal(assembled.variables.provider, 'p')
	} finally {
		stderr.restore()
	}
})

test('装配过滤器带 prepend，后注册的监听器加塞的工具也会被摘掉', () => {
	const stderr = captureStderr()
	try {
		const { ctx, options } = harness([])
		apply(ctx, { defer: ['read'] })
		// 环绕式 waterfall：不带 prepend 就注册在链尾，后处理最先跑，
		// 之后别的监听器再往 tools 里加东西，这一段就看不见了。
		assert.deepEqual(options('system-prompt/assemble'), { prepend: true })
	} finally {
		stderr.restore()
	}
})

test('引导相位：首轮只留引导集合，落下工具调用之后晋升成延迟表', async () => {
	const stderr = captureStderr()
	try {
		const session = { id: 'session-anchor', events: [{ type: 'session' }] }
		const { ctx, listener } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['pwsh', 'str_replace_editor'] })
		const assemble = listener('system-prompt/assemble')
		const context = { agent: { session } }
		const next = async () => ({
			tools: [{ name: 'pwsh' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'glob' }, { name: 'tool_search' }],
		})

		// 首轮连 tool_search 都不留：这一轮没有东西可搜
		const first = await assemble({ tools: [] }, context, next)
		assert.deepEqual(first.tools.map((tool) => tool.name), ['pwsh', 'str_replace_editor'])

		// 落下第一次持久的工具调用之后，同一个会话转成延迟表
		listener('session/event')(session, { type: 'tool/call', seq: 3 })
		const later = await assemble({ tools: [] }, context, next)
		assert.deepEqual(later.tools.map((tool) => tool.name), ['pwsh', 'str_replace_editor', 'glob', 'tool_search'])
	} finally {
		stderr.restore()
	}
})

test('首轮只回文字也算晋级：进到第 2 轮就换成延迟表', async () => {
	const stderr = captureStderr()
	try {
		const { ctx, listener } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['pwsh'] })
		const assemble = listener('system-prompt/assemble')
		const next = async () => ({ tools: [{ name: 'pwsh' }, { name: 'read' }, { name: 'tool_search' }] })

		// 第 1 轮只回文字、一次工具都不调，窄表不能被一直留着
		const session = { id: 'session-text-only', events: [{ type: 'session' }] }
		const context = { agent: { session } }
		listener('session/event')(session, { type: 'turn/start', data: { turn: 1 } })
		const first = await assemble({ tools: [] }, context, next)
		assert.deepEqual(first.tools.map((tool) => tool.name), ['pwsh'])

		// 第 2 轮一开始就退场，不必等工具调用
		listener('session/event')(session, { type: 'turn/start', data: { turn: 2 } })
		const second = await assemble({ tools: [] }, context, next)
		assert.deepEqual(second.tools.map((tool) => tool.name), ['pwsh', 'tool_search'])

		// 恢复会话同理：历史里没有工具调用，但已经过了第 1 轮
		const resumed = {
			id: 'session-resumed-text',
			snapshotEvents: () => [{ type: 'session' }, { type: 'turn/start', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } }],
		}
		const restored = await assemble({ tools: [] }, { agent: { session: resumed } }, next)
		assert.deepEqual(restored.tools.map((tool) => tool.name), ['pwsh', 'tool_search'])
	} finally {
		stderr.restore()
	}
})

test('恢复会话不重放引导相位：历史里已有工具调用就直接用延迟表', async () => {
	const stderr = captureStderr()
	try {
		const session = {
			id: 'session-resumed',
			snapshotEvents: () => [{ type: 'session' }, { type: 'tool/call', seq: 9 }],
		}
		const { ctx, listener } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['pwsh'] })
		const assembled = await listener('system-prompt/assemble')(
			{ tools: [] },
			{ agent: { session } },
			async () => ({ tools: [{ name: 'read' }, { name: 'pwsh' }, { name: 'tool_search' }] }),
		)
		assert.deepEqual(assembled.tools.map((tool) => tool.name), ['pwsh', 'tool_search'])
	} finally {
		stderr.restore()
	}
})

test('读不出会话历史时按已晋级处理，不放窄表', async () => {
	const stderr = captureStderr()
	try {
		const session = { id: 'session-broken', snapshotEvents() { throw new Error('boom') } }
		const { ctx, listener } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['pwsh'] })
		const assembled = await listener('system-prompt/assemble')(
			{ tools: [] },
			{ agent: { session } },
			async () => ({ tools: [{ name: 'read' }, { name: 'pwsh' }, { name: 'tool_search' }] }),
		)
		assert.deepEqual(assembled.tools.map((tool) => tool.name), ['pwsh', 'tool_search'])
		assert.match(stderr.lines.join('\n'), /phase: session history unreadable/)
	} finally {
		stderr.restore()
	}
})

test('引导集合里的名字没装配出来时退回延迟表，不放全表', async () => {
	const stderr = captureStderr()
	try {
		const session = { id: 'session-absent', events: [] }
		const { ctx, listener } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['bash', 'str_replace_editor'] })
		const assembled = await listener('system-prompt/assemble')(
			{ tools: [] },
			{ agent: { session } },
			async () => ({ tools: [{ name: 'pwsh' }, { name: 'read' }, { name: 'glob' }, { name: 'tool_search' }] }),
		)
		assert.deepEqual(assembled.tools.map((tool) => tool.name), ['pwsh', 'glob', 'tool_search'])
		assert.match(stderr.lines.join('\n'), /bootstrap tool\(s\) absent: bash,str_replace_editor/)
	} finally {
		stderr.restore()
	}
})

test('首步按路径剥注入：只留本轮认领的批次加技能手势', async () => {
	const stderr = captureStderr()
	try {
		const session = { id: 'session-context', events: [] }
		const { ctx, listener, options } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['pwsh'] })
		const preStep = listener('agent/pre-step')
		assert.deepEqual(options('agent/pre-step'), { prepend: true })
		const anonymous = { source: { kind: 'user' } }
		const claimed = [{ id: 1, source: { kind: 'user' } }, anonymous]
		const messages = [
			{ id: 1, source: { kind: 'user' } },
			{ id: 2, source: { kind: 'skill-catalog' } },
			{ id: 3, source: { kind: 'agent-instructions' } },
			{ id: 4, source: { kind: 'time-context' } },
			{ id: 5, source: { kind: 'skill-invocation', name: 'office' } },
			{ id: 6 },
			{ id: 7, source: { kind: 'brand-new-injector' } },
			{ id: 8, source: { kind: 'user' } },
			anonymous,
		]
		const decision = await preStep({ agent: { session }, messages: claimed }, async () => ({ kind: 'enter', messages }))
		// 认领的批次原样留下（含没有 id、只靠身份对上的那条）；
		// 白名单里的技能手势留下；其余一律剥——包括没见过的注入源和没被认领的 user 消息。
		assert.deepEqual(decision.messages.map((message) => message.id), [1, 5, undefined])

		// 上游拒绝就原样返回，不碰
		const rejected = await preStep({ agent: { session }, messages: claimed }, async () => ({ kind: 'reject' }))
		assert.equal(rejected.kind, 'reject')

		// 晋级之后全部放行
		listener('session/event')(session, { type: 'tool/call' })
		const after = await preStep({ agent: { session }, messages: claimed }, async () => ({ kind: 'enter', messages }))
		assert.equal(after.messages.length, messages.length)
	} finally {
		stderr.restore()
	}
})

test('首步清空装配出来的 runtime-context，晋级之后恢复', async () => {
	const stderr = captureStderr()
	try {
		const session = { id: 'session-runtime', events: [] }
		const { ctx, listener } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['pwsh'] })
		const assemble = listener('system-prompt/assemble')
		// 沙箱/审批快照和任何第三方上下文提供者都走这一处，不需要点名。
		const assembly = () => ({
			sections: [],
			contexts: [{ name: 'sandbox', text: 'policy' }],
			tools: [{ name: 'pwsh' }, { name: 'read' }],
			variables: {},
		})
		const first = await assemble({ tools: [] }, { agent: { session } }, async () => assembly())
		assert.deepEqual(first.contexts, [])
		assert.deepEqual(first.tools.map((tool) => tool.name), ['pwsh'])

		// 不是 agent 的装配（会话标题等）不动它：拿不到相位就放行
		const untargeted = await assemble({ tools: [] }, {}, async () => assembly())
		assert.equal(untargeted.contexts.length, 1)

		listener('session/event')(session, { type: 'tool/call' })
		const later = await assemble({ tools: [] }, { agent: { session } }, async () => assembly())
		assert.deepEqual(later.contexts, [{ name: 'sandbox', text: 'policy' }])
	} finally {
		stderr.restore()
	}
})

test('第一次引导相位的装配之后，pre-step 闸门重新 prepend 抢到链首', async () => {
	const stderr = captureStderr()
	try {
		const session = { id: 'session-chain-head', events: [] }
		const { ctx, listener, count, options } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['pwsh'] })
		assert.equal(count('agent/pre-step'), 1)

		const assembly = async () => ({ tools: [{ name: 'pwsh' }] })
		await listener('system-prompt/assemble')({ tools: [] }, { agent: { session } }, assembly)
		assert.equal(count('agent/pre-step'), 2)
		// 只抢一次，不会每次装配都叠一层
		await listener('system-prompt/assemble')({ tools: [] }, { agent: { session } }, assembly)
		assert.equal(count('agent/pre-step'), 2)
		assert.deepEqual(options('agent/pre-step'), { prepend: true })
		assert.match(stderr.lines.join('\n'), /re-prepended after assembly/)

		// 已经晋级的会话不抢：那条链上不该再挂层
		const promoted = harness([])
		apply(promoted.ctx, { defer: ['read'], bootstrapTools: ['pwsh'] })
		const promotedSession = { id: 'session-promoted', events: [{ type: 'tool/call', seq: 1 }] }
		await promoted.listener('system-prompt/assemble')({ tools: [] }, { agent: { session: promotedSession } }, assembly)
		assert.equal(promoted.count('agent/pre-step'), 1)
	} finally {
		stderr.restore()
	}
})

test('bootstrapSuppressRuntimeContext: false 时首步保留 runtime-context', async () => {
	const stderr = captureStderr()
	try {
		const session = { id: 'session-runtime-off', events: [] }
		const { ctx, listener } = harness([])
		apply(ctx, { defer: ['read'], bootstrapTools: ['pwsh'], bootstrapSuppressRuntimeContext: false })
		const assembled = await listener('system-prompt/assemble')(
			{ tools: [] },
			{ agent: { session } },
			async () => ({ tools: [{ name: 'pwsh' }], contexts: [{ name: 'sandbox', text: 'policy' }] }),
		)
		assert.equal(assembled.contexts.length, 1)
		// 工具面照旧收窄：开关只影响上下文那一条
		assert.deepEqual(assembled.tools.map((tool) => tool.name), ['pwsh'])
	} finally {
		stderr.restore()
	}
})

test('不配引导集合时，有会话也照样立刻延迟', async () => {
	const stderr = captureStderr()
	try {
		const session = { id: 'session-off', events: [] }
		const { ctx, listener } = harness([])
		apply(ctx, { defer: ['read'] })
		const assembled = await listener('system-prompt/assemble')(
			{ tools: [] },
			{ agent: { session } },
			async () => ({ tools: [{ name: 'read' }, { name: 'glob' }, { name: 'tool_search' }] }),
		)
		assert.deepEqual(assembled.tools.map((tool) => tool.name), ['glob', 'tool_search'])
		assert.equal(listener('session/event'), undefined)
		assert.equal(listener('agent/pre-step'), undefined)
	} finally {
		stderr.restore()
	}
})

test('子代理不走引导相位：首轮直接拿延迟表，也不剥上下文', async () => {
	const stderr = captureStderr()
	try {
		const tools = [{ name: 'pwsh' }, { name: 'str_replace_editor' }, { name: 'read' }, { name: 'tool_search' }]
		const userMessage = { id: 2, source: { kind: 'user' } }
		const messages = [{ id: 1, source: { kind: 'skill-catalog' } }, userMessage]
		const claimed = [userMessage]
		const contexts = [{ name: 'sandbox', text: 'policy' }]
		const config = { defer: ['read'], bootstrapTools: ['pwsh'] }

		// 会话头里的深度与运行时 options 都算数，取两者较大的那个
		const subagents = [
			{ session: { id: 'session-child-header', header: { delegationDepth: 1 }, events: [] } },
			{ session: { id: 'session-child-options', events: [] }, options: { subagentDepth: 2 } },
		]
		for (const agent of subagents) {
			const { ctx, listener } = harness([])
			apply(ctx, config)
			const assembled = await listener('system-prompt/assemble')(
				{ tools: [] },
				{ agent },
				async () => ({ tools, contexts }),
			)
			assert.deepEqual(
				assembled.tools.map((tool) => tool.name),
				['pwsh', 'str_replace_editor', 'tool_search'],
				`${agent.session.id} 应拿到延迟表`,
			)
			assert.equal(assembled.contexts.length, 1, `${agent.session.id} 不该清空 runtime-context`)
			const decision = await listener('agent/pre-step')({ agent, messages: claimed }, async () => ({ kind: 'enter', messages }))
			assert.equal(decision.messages.length, 2, `${agent.session.id} 不该剥上下文`)
		}

		// 同一份配置下，顶层会话照旧收窄并剥掉注入
		const top = harness([])
		apply(top.ctx, config)
		const topAgent = { session: { id: 'session-top', header: {}, events: [] } }
		const narrowed = await top.listener('system-prompt/assemble')(
			{ tools: [] },
			{ agent: topAgent },
			async () => ({ tools, contexts }),
		)
		assert.deepEqual(narrowed.tools.map((tool) => tool.name), ['pwsh'])
		assert.deepEqual(narrowed.contexts, [])
		const topDecision = await top.listener('agent/pre-step')({ agent: topAgent, messages: claimed }, async () => ({ kind: 'enter', messages }))
		assert.deepEqual(topDecision.messages.map((message) => message.id), [2])
	} finally {
		stderr.restore()
	}
})

test('描述里列全被延迟的名字，不按字母序丢掉尾部', () => {
	const stderr = captureStderr()
	try {
		// 直接读 cordis.patch.yml 里在用的那一份，别抄一份：抄的那份已经漂过一次。
		// 按字母序 web_fetch 排最后，一旦截断，恰好是最常被系统提示点名的工具消失。
		const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
		const row = patch.split('\n').find((line) => line.trim().startsWith('defer: ['))
		assert.ok(row !== undefined, 'cordis.patch.yml 里找不到 defer 名单')
		const defer = [...row.matchAll(/'([^']+)'/g)].map((match) => match[1])
		assert.ok(defer.length > 10, `defer 名单只解析出 ${defer.length} 个名字`)

		const { ctx, registered } = harness([])
		apply(ctx, { defer, deferPatterns: ['mcp__*'] })
		const { description } = registered[0]
		for (const name of defer) assert.match(description, new RegExp(`\\b${name}\\b`), `缺少 ${name}`)
		assert.doesNotMatch(description, /and \d+ more/)
		assert.match(description, /search for it instead of working around it/)
	} finally {
		stderr.restore()
	}
})

test('apply 在配置里点了 tool_search 时把它剔除', () => {
	const stderr = captureStderr()
	try {
		const { ctx } = harness([])
		apply(ctx, { defer: ['tool_search', 'web_fetch'] })
		assert.match(stderr.lines.join('\n'), /tool_search was listed in defer/)
	} finally {
		stderr.restore()
	}
})

test('注册失败时整层不启用（不装过滤器）', () => {
	const stderr = captureStderr()
	try {
		const { ctx, registered, listener } = harness([])
		const original = ctx.tools.register
		ctx.tools.register = () => {
			throw new Error('boom')
		}
		apply(ctx, { defer: ['web_fetch'] })
		assert.equal(registered.length, 0)
		assert.equal(listener('system-prompt/assemble'), undefined)
		assert.match(stderr.lines.join('\n'), /deferral NOT enabled/)
		ctx.tools.register = original
	} finally {
		stderr.restore()
	}
})
