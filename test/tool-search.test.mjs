import assert from 'node:assert/strict'
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
		on(name, listener) {
			const list = listeners.get(name) ?? []
			list.push(listener)
			listeners.set(name, list)
			return () => {}
		},
	}
	return { ctx, registered, listener: (name) => listeners.get(name)?.[0] }
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

test('描述里列全被延迟的名字，不按字母序丢掉尾部', () => {
	const stderr = captureStderr()
	try {
		// 这份名单就是 cordis.patch.yml 里在用的那一份：按字母序 todo_write / web_fetch 排最后，
		// 一旦截断，恰好是两个最常被系统提示点名的工具消失。
		const defer = [
			'web_fetch', 'read_image', 'job_list', 'job_output', 'job_kill', 'list_agents', 'interrupt_agent',
			'send_message', 'subagent_fork', 'load_workspace_dependencies', 'subagent', 'todo_write', 'glob', 'skill',
		]
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
