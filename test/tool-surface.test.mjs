import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/tool-surface.js'

/** 装配之外唯一的输出通道就是日志；测试靠它判断发生了什么。 */
function captureStderr() {
	const lines = []
	const original = console.error
	console.error = (...args) => lines.push(args.join(' '))
	return { lines, restore: () => (console.error = original) }
}

/** 假 ctx：schemas 可变（模拟挂载时拿不到工具表），restrict 记下每次调用的名字。 */
function harness({ schemas = [], restrictFails = () => undefined } = {}) {
	const listeners = new Map()
	const denied = []
	const state = { schemas }
	const ctx = {
		logger: { info() {}, warn() {} },
		tools: {
			schemas() {
				return state.schemas
			},
			restrict(filter) {
				const name = filter?.deny?.[0]
				const failure = restrictFails(name)
				if (failure !== undefined) throw new Error(failure)
				denied.push(name)
				return () => {}
			},
		},
		on(name, listener) {
			const list = listeners.get(name) ?? []
			list.push(listener)
			listeners.set(name, list)
			return () => {}
		},
		effect() {
			/* 生命周期在测试里不需要 */
		},
	}
	return { ctx, state, denied, listener: (name) => listeners.get(name)?.[0] }
}

test('挂载时挡掉名单里的宿主工具', () => {
	const stderr = captureStderr()
	try {
		const { ctx, denied } = harness({
			schemas: [
				{ name: 'read' },
				{ name: 'workflow' },
				{ name: 'working_directory' },
				{ name: 'advanced_search' },
				{ name: 'present' },
				{ name: 'schedule_create' },
				{ name: 'cordis_inspect_list' },
			],
		})
		apply(ctx)
		assert.deepEqual(denied.sort(), [
			'advanced_search',
			'cordis_inspect_list',
			'present',
			'schedule_create',
			'workflow',
			'working_directory',
		])
		assert.match(stderr.lines.join('\n'), /restrict at mount:/)
	} finally {
		stderr.restore()
	}
})

test('scoped 工具抛 unknown global tool 时保留，不重试', () => {
	const stderr = captureStderr()
	try {
		const { ctx, denied } = harness({
			schemas: [{ name: 'workflow' }, { name: 'present' }],
			restrictFails: (name) => (name === 'present' ? 'unknown global tool "present"' : undefined),
		})
		apply(ctx)
		assert.deepEqual(denied, ['workflow'])
		assert.match(stderr.lines.join('\n'), /scoped, kept present/)
	} finally {
		stderr.restore()
	}
})

test('挂载时拿不到工具表，则 pre-step 补扫一次', () => {
	const stderr = captureStderr()
	try {
		const { ctx, state, denied, listener } = harness({ schemas: [] })
		apply(ctx)
		assert.deepEqual(denied, [])
		assert.match(stderr.lines.join('\n'), /tool list unavailable/)

		state.schemas = [{ name: 'workflow' }, { name: 'read' }]
		const preStep = listener('agent/pre-step')
		assert.equal(typeof preStep, 'function')
		let continued = false
		preStep({}, () => {
			continued = true
		})
		assert.equal(continued, true, 'pre-step 必须继续往下走')
		assert.deepEqual(denied, ['workflow'])
		assert.match(stderr.lines.join('\n'), /restrict at pre-step:/)
	} finally {
		stderr.restore()
	}
})

test('审计按会话记账：基线一次，变化才再打', () => {
	const stderr = captureStderr()
	try {
		const { ctx, listener } = harness({ schemas: [{ name: 'read' }] })
		apply(ctx)
		const onEvent = listener('session/event')
		assert.equal(typeof onEvent, 'function')

		const session = { id: 'session-abcdef12' }
		const header = (tools) => ({ type: 'request/header', data: { header: { tools } } })

		onEvent(session, header([{ name: 'read' }, { name: 'grep' }]))
		assert.match(stderr.lines.join('\n'), /baseline #1: 2 tools/)

		const before = stderr.lines.length
		onEvent(session, header([{ name: 'read' }, { name: 'grep' }]))
		assert.equal(stderr.lines.length, before, '工具表没变就不该再打')

		onEvent(session, header([{ name: 'read' }, { name: 'grep' }, { name: 'glob' }]))
		const text = stderr.lines.join('\n')
		assert.match(text, /change #3: 3 tools/)
		assert.match(text, /\+glob/)
		assert.match(text, /cache: reuse invalidated/)

		// 另一个会话从头记自己的基线，不共用计数
		onEvent({ id: 'session-ffffffff' }, header([{ name: 'read' }]))
		assert.match(stderr.lines.join('\n'), /baseline #1: 1 tools/)
	} finally {
		stderr.restore()
	}
})
