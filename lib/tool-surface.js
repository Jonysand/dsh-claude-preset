/**
 * 工具表审计：`request/header` 一变就输出一行——工具数、工具块字节、按 4 字符/token
 * 粗估的 token、这次相比上次增删了谁。工具块在请求最前面，任何字节变化都会让缓存从
 * 该 token 起失效，这行日志就是那次失效的凭证。
 *
 * 这个文件早先还负责挡住一批宿主工具（`ctx.tools.restrict({ deny })`）。2026-10-24
 * 名单清空：web/desktop 里宿主层本来就把那些工具行设成 disabled，模型看不见它们靠的
 * 是「没人挂」，不是「被挡住」；需要的能力一律改成本 preset 自己挂（见 cordis.patch.yml）。
 * 最后一条 `working_directory` 也放开了——它提供切换会话工作目录，首轮看不见（引导相位
 * 只留两个工具），晋级之后作为宿主的全局工具出现在表里。
 *
 * 要重新挡一个工具，记住三条：
 *
 *   - 用 `ctx.tools.restrict({ deny: [name] })`，只能挡全局层的名字。`ctx.tools.schemas()`
 *     不带 scope 就是那一层；preset 自己注册的 scoped 工具不在里面，写进来也不会命中。
 *   - 在第一次装配之前调。agent loop 的顺序是「装配 prompt 与 tools → `agent/pre-step` →
 *     记 `request/header` → 冻结请求 → 发出」，晚一步就只能改变下一次请求，而那是一次
 *     工具表变化加一次全前缀重建（本机实测 7,090 input token，约等于 7 个普通轮次）。
 *   - 被挡的名字既拿不回 schema（`tool_search` 的目录也来自 `schemas()`），按名字调用还会
 *     被判成不存在的工具。所以延迟（`tool-search` 的 defer）和拦截互斥：要能取回，就绝不
 *     能挡。
 */

/** 粗估常数，与 cc-haha 的字符/token 常数同值；只用于量级判断。 */
const CHARS_PER_TOKEN = 4

/** 审计状态按会话保留的上限；超了就淘汰最早的那个。 */
const AUDIT_LIMIT = 128

function djb2(text) {
	let hash = 5381
	for (let index = 0; index < text.length; index += 1) {
		hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
	}
	return hash >>> 0
}

function fingerprint(tool) {
	return djb2(JSON.stringify([tool.name, tool.description ?? '', tool.parameters ?? tool.input_schema ?? null]))
}

function snapshot(tools) {
	const map = new Map()
	for (const tool of tools) map.set(tool.name, fingerprint(tool))
	return map
}

function diff(previous, current) {
	const added = []
	const removed = []
	const changed = []
	for (const [name, hash] of current) {
		const before = previous.get(name)
		if (before === undefined) added.push(name)
		else if (before !== hash) changed.push(name)
	}
	for (const name of previous.keys()) if (!current.has(name)) removed.push(name)
	return { added, removed, changed }
}

export const name = 'tool-surface'

export function apply(ctx) {
	// 审计按会话存：preset revision 只有一个实例，多会话共用闭包，状态必须分开。
	const audits = new Map()

	const report = (message) => {
		try {
			ctx.logger?.info?.(`tool-surface: ${message}`)
		} catch {
			/* 日志失败不影响主流程 */
		}
		console.error(`[tool-surface] ${message}`)
	}

	const dispose = ctx.on('session/event', (session, event) => {
		if (event === null || typeof event !== 'object' || event.type !== 'request/header') return
		const tools = event.data?.header?.tools
		if (!Array.isArray(tools) || tools.length === 0) return
		const id = typeof session?.id === 'string' ? session.id : 'unknown'
		let audit = audits.get(id)
		if (audit === undefined) {
			// 只给审计用，别让长跑进程攒上几百个会话：超过上限淘汰最早的那个。
			if (audits.size >= AUDIT_LIMIT) audits.delete(audits.keys().next().value)
			audit = { previous: null, index: 0 }
			audits.set(id, audit)
		}
		audit.index += 1
		const count = audit.index
		const tag = id === 'unknown' ? '' : ` | session ${id.replace(/^session-/, '').slice(0, 8)}`
		const current = snapshot(tools)
		const names = [...current.keys()]
		const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
		const tokens = Math.round(bytes / CHARS_PER_TOKEN)

		if (audit.previous === null) {
			report(`baseline #${count}: ${names.length} tools, ${bytes} bytes (~${tokens} tok est)${tag}`)
			audit.previous = current
			return
		}

		const delta = diff(audit.previous, current)
		if (delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0) return

		const parts = [`change #${count}: ${names.length} tools, ${bytes} bytes (~${tokens} tok est)`]
		if (delta.added.length > 0) parts.push(`+${delta.added.sort().join(',')}`)
		if (delta.removed.length > 0) parts.push(`-${delta.removed.sort().join(',')}`)
		if (delta.changed.length > 0) parts.push(`~${delta.changed.sort().join(',')}`)
		parts.push('cache: reuse invalidated from the first changed tool token')
		report(parts.join(' | ') + tag)
		audit.previous = current
	})

	if (typeof dispose === 'function') ctx.effect(() => dispose, 'tool-surface: request header listener')
}
