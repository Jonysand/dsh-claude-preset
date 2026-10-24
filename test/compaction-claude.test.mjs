import assert from 'node:assert/strict'
import { test } from 'node:test'

import { INSTRUCTION, apply, rewriteCompactionInstruction } from '../lib/compaction-claude.js'

const PREFIX = 'You are now acting as a compaction engine'

/** 一次压缩请求的最小形状：最后一条 user 消息里带 DSH 追加的那段指令。 */
function compactionRequest(sessionId, instruction = `${PREFIX} ...upstream text...`) {
	return {
		purpose: 'compaction',
		sessionId,
		messages: [
			{ role: 'system', content: [{ type: 'text', text: 'sys' }] },
			{ role: 'user', content: [{ type: 'text', text: instruction }] },
		],
	}
}

test('指令替换只认 compression 请求与已知前缀', () => {
	// 非对象、非压缩请求、缺 messages、结构不符：一律原样返回同一个引用
	assert.equal(rewriteCompactionInstruction(undefined), undefined)
	const chat = { purpose: 'chat', messages: [] }
	assert.equal(rewriteCompactionInstruction(chat), chat)
	const broken = { purpose: 'compaction', messages: 'nope' }
	assert.equal(rewriteCompactionInstruction(broken), broken)

	const noPrefix = { purpose: 'compaction', messages: [{ role: 'user', content: [{ type: 'text', text: '别的指令' }] }] }
	assert.equal(rewriteCompactionInstruction(noPrefix), noPrefix)

	// 缺了 system 之外的结构也要能容忍
	const odd = { purpose: 'compaction', messages: [null, { role: 'assistant', content: [] }, { role: 'user', content: [] }] }
	assert.equal(rewriteCompactionInstruction(odd), odd)
})

test('替换发生在最后一条带前缀的 user 消息上，且不改入参', () => {
	const request = compactionRequest('session-1')
	const rewritten = rewriteCompactionInstruction(request)
	assert.notEqual(rewritten, request)
	assert.notEqual(rewritten.messages, request.messages)
	assert.equal(rewritten.messages[1].content[0].text, INSTRUCTION)
	// 原请求保持不动
	assert.match(request.messages[1].content[0].text, /upstream text/)
	// 其它字段照旧
	assert.equal(rewritten.purpose, 'compaction')
	assert.equal(rewritten.sessionId, 'session-1')
	assert.equal(rewritten.messages[0].content[0].text, 'sys')
})

test('替换后的指令保留 Claude Code 的检查点结构', () => {
	assert.match(INSTRUCTION, /## All User Messages/)
	assert.match(INSTRUCTION, /## Pending Tasks/)
	assert.doesNotMatch(INSTRUCTION, /## Pending Jobs/)
	assert.match(INSTRUCTION, /## Next Step/)
})

/** 假 llm：记录每次真正的分发，便于判断补丁有没有生效。 */
function fakeRuntime({ presets = { 'session-1': 'claude-code' }, withRegistry = true } = {}) {
	const calls = []
	const llm = {
		stream(options) {
			calls.push(options)
			return { kind: 'stream' }
		},
	}
	const disposers = []
	const ctx = {
		llm,
		logger: { info() {}, warn() {} },
		get(name) {
			if (!withRegistry) return undefined
			if (name === 'agents') return { list: () => [{ id: 'session-1', ctx: { id: 'session-1' }, session: { id: 'session-1' } }] }
			if (name === 'agentPresets') return { composedPreset: (agentCtx) => presets[agentCtx.id] }
			return undefined
		},
		effect(run) {
			disposers.push(run())
		},
	}
	return { llm, ctx, calls, disposers }
}

test('只改本 preset 会话的压缩请求', () => {
	const { llm, ctx, calls } = fakeRuntime()
	apply(ctx)

	const chat = { purpose: 'chat', messages: [] }
	llm.stream(chat)
	assert.equal(calls.at(-1), chat, '非压缩请求原样透传')

	const mine = compactionRequest('session-1')
	llm.stream(mine)
	assert.match(calls.at(-1).messages[1].content[0].text, /## Pending Tasks/)
	assert.match(mine.messages[1].content[0].text, /upstream text/, '入参不能被就地改写')
})

test('别的 preset 的会话保持原指令', () => {
	const { llm, ctx, calls } = fakeRuntime({ presets: { 'session-1': 'standard' } })
	apply(ctx)
	const other = compactionRequest('session-1')
	llm.stream(other)
	assert.equal(calls.at(-1).messages[1].content[0].text, `${PREFIX} ...upstream text...`)
})

test('第二个 preset 的会话同样用这套摘要结构', () => {
	const { llm, ctx, calls } = fakeRuntime({ presets: { 'session-1': 'claude-code-prompt' } })
	apply(ctx)
	llm.stream(compactionRequest('session-1'))
	assert.match(calls.at(-1).messages[1].content[0].text, /## Pending Tasks/)
})

test('判定不了归属时沿用旧行为（仍然替换）', () => {
	const { llm, ctx, calls } = fakeRuntime({ withRegistry: false })
	apply(ctx)
	llm.stream(compactionRequest('session-x'))
	assert.match(calls.at(-1).messages[1].content[0].text, /## Pending Tasks/)
})

test('引用计数：两个作用域先后挂载，最后一个卸载才还原', () => {
	const { llm, ctx, disposers } = fakeRuntime()
	const original = llm.stream

	apply(ctx)
	const patched = llm.stream
	assert.notEqual(patched, original)

	apply(ctx)
	assert.equal(llm.stream, patched, '第二个作用域不应重复包装')

	disposers[0]()
	assert.equal(llm.stream, patched, '还有一个用户时不还原')

	disposers[1]()
	assert.equal(llm.stream, original, '最后一个用户卸载后还原')
})
