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

/** 假 ctx：记下 restrict 调用与监听器；schemas 只为证明没人去摸工具表。 */
function harness() {
	const listeners = new Map()
	const restricted = []
	const ctx = {
		logger: { info() {}, warn() {} },
		tools: {
			schemas() {
				return [{ name: 'working_directory' }, { name: 'read' }]
			},
			restrict(filter) {
				restricted.push(filter)
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
	return { ctx, restricted, listener: (name) => listeners.get(name)?.[0] }
}

test('不再拦截任何工具，也不装 pre-step 监听器', () => {
	const stderr = captureStderr()
	try {
		const { ctx, restricted, listener } = harness()
		apply(ctx)
		// working_directory 已放开：它要作为宿主的全局工具出现在晋级之后的工具表里
		assert.deepEqual(restricted, [])
		assert.equal(listener('agent/pre-step'), undefined)
	} finally {
		stderr.restore()
	}
})

test('审计按会话记账：基线一次，变化才再打', () => {
	const stderr = captureStderr()
	try {
		const { ctx, listener } = harness()
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
