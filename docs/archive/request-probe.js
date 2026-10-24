/**
 * Step 0 探针（已归档）：确认 `system-prompt/assemble` 这类 waterfall 监听器会不会串到别的 preset。
 *
 * 结论见 docs/deferred-tools-gaps.md 的 2.8：不会。同一个进程里两个 preset 同时跑，
 * 挂在本 preset 里的监听器只收到了本 preset 的装配，standard 会话一行都没有。
 *
 * 再用的时候把它加回 cordis.patch.yml 的插件列表：
 *
 * ```
 * - id: request-probe
 *   name: 'dsh-claude-preset/docs/archive/request-probe.js'
 * ```
 *
 * 要回答的问题只有一个：挂在本 preset 里的监听器，是不是只收到本 preset 的 agent。
 *
 * 为什么这件事不能靠猜：`dsh-scope` 的筛选规则是「无标签监听器放行；有标签监听器
 * 仅当标签为分发键或其祖先时放行」。本 preset 的 ctx 到底有没有标签、agent 的 scope
 * 链里有没有它，取决于 preset registry 怎么挂 Loader 树。这两点都写在别的包里，
 * 而且升级会变，所以用运行时事实来定，不读源码推。
 *
 * 探针只读不写：不改装配结果、不注册工具、不改配置。它的产物是四样东西：
 *
 * 1. 挂载行：进程号、ctx 上有没有 systemPrompt / tools。
 * 2. 装配行：谁在装、装了什么、工具表指纹。第一次见到某个 agent 时打全量工具名，
 *    之后只有变化才打。工具名里出现 workflow / create_goal / schedule_* 这类本 preset
 *    明确挡掉的工具，就是串台的直接证据。
 * 3. 轮次行：每轮第一步打一行。装配行按工具表去重，静默不等于没收到，这行用来
 *    区分「没收到」和「收到但去重了」。
 * 4. 请求边界行：request/header 的 reason 与工具块字节，对应「一轮真的发出去了」。
 *
 * 输出同时走 stderr 和临时目录下的日志文件。Electron 进程的 stderr 在用户机器上通常
 * 看不到，日志文件才是能事后读的那一份。
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 日志落点。文件名带进程号后缀，多开时不会互相覆盖。 */
const LOG_PATH = join(tmpdir(), `dsh-request-probe-${process.pid}.log`)

/** 单进程最多写这么多行，防止长跑进程把临时目录写爆。 */
const LINE_LIMIT = 2000

/** 出现这些名字就说明这个 agent 不是本 preset 的——本 preset 在挂载时把它们挡掉了。 */
const FOREIGN_MARKERS = [
	'workflow',
	'create_goal',
	'get_goal',
	'update_goal',
	'present',
	'plugin_manager',
	'working_directory',
	'load_workspace_dependencies',
]
const FOREIGN_PATTERNS = [/^schedule_/, /^cordis_inspect/, /^multi_search$/, /^advanced_search$/]

let written = 0
let dropped = false

function emit(line) {
	// 每行带本地时间：事后判断「哪条先到」时，文件顺序不可靠（多个进程各写各的）。
	const stamp = new Date().toTimeString().slice(0, 8)
	const text = `[probe] ${stamp} ${line}`
	try {
		console.error(text)
	} catch {
		/* stderr 被关掉也不影响日志文件 */
	}
	if (written >= LINE_LIMIT) {
		if (!dropped && typeof text === 'string') {
			dropped = true
			try {
				appendFileSync(LOG_PATH, `[probe] log limit reached (${LINE_LIMIT} lines), further lines dropped\n`)
			} catch {
				/* 写不进去就算了，探针不能影响主流程 */
			}
		}
		return
	}
	written += 1
	try {
		appendFileSync(LOG_PATH, `${text}\n`)
	} catch {
		/* 同上 */
	}
}

function djb2(text) {
	let hash = 5381
	for (let index = 0; index < text.length; index += 1) {
		hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
	}
	return (hash >>> 0).toString(36)
}

function shortId(value) {
	if (typeof value !== 'string') return '?'
	return value.replace(/^session-/, '').slice(0, 8)
}

/** 工具名里有没有别的 preset 的痕迹。 */
function foreignHits(names) {
	const hits = names.filter((name) => FOREIGN_MARKERS.includes(name) || FOREIGN_PATTERNS.some((p) => p.test(name)))
	return hits
}

/** 读 ctx 上的服务类型时不能让它抛：Cordis 里拿不到的服务属性可能直接抛错，
 *  apply 抛错会让整个 preset 挂载失败，探针不能有这种破坏力。 */
function describeService(ctx, key) {
	try {
		const value = ctx?.[key]
		return typeof value
	} catch {
		return 'unavailable'
	}
}

/** 注册一个监听器；失败只记一行，不影响其余监听器和 preset 挂载。 */
function listen(ctx, event, listener) {
	try {
		ctx.on(event, listener)
		return true
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		emit(`listen failed event=${event} error=${message}`)
		return false
	}
}

export const name = 'request-probe'

export function apply(ctx) {
	// 每个 agent 上一次看到的工具指纹；只有变化才重新打全量名字。
	const signatures = new Map()

	emit(
		`mount pid=${process.pid} systemPrompt=${describeService(ctx, 'systemPrompt')} tools=${describeService(ctx, 'tools')} log=${LOG_PATH}`,
	)

	const describe = (agent, tools, label) => {
		const id = shortId(agent?.id)
		const names = tools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
		const signature = `${names.length}:${djb2([...names].sort().join(','))}`
		const previous = signatures.get(id)
		if (previous === signature) return
		signatures.set(id, signature)
		const sorted = [...names].sort()
		const foreign = foreignHits(sorted)
		const parts = [
			label,
			`agent=${id}`,
			`tools=${names.length}`,
			`sig=${signature.slice(0, 12)}`,
			foreign.length > 0 ? `FOREIGN=${foreign.join(',')}` : 'foreign=none',
		]
		if (previous === undefined) parts.push(`names=${sorted.join(',')}`)
		emit(parts.join(' '))
	}

	// 1) 装配：每轮一次，是判断「监听器属于谁」的主证据。
	listen(ctx, 'system-prompt/assemble', async (assembly, context, next) => {
		const assembled = await next()
		try {
			const target = assembled ?? assembly
			const agent = context?.agent
			const tools = Array.isArray(target?.tools) ? target.tools : []
			describe(agent, tools, `assemble scope=${context?.scope === agent ? 'agent' : 'other'}`)
			// 变量表能看出这套装配是不是本 realm 拼的：别的 preset 不一定有同一批变量。
			const variables = target?.variables
			if (variables !== null && typeof variables === 'object') {
				const keys = Object.keys(variables).sort().join(',')
				const marker = `vars:${djb2(keys)}`
				const previous = signatures.get(`${shortId(agent?.id)}:vars`)
				if (previous !== marker) {
					signatures.set(`${shortId(agent?.id)}:vars`, marker)
					emit(`vars agent=${shortId(agent?.id)} keys=${keys || '(none)'}`)
				}
			}
		} catch {
			/* 探针自己的异常不能影响装配 */
		}
		return assembled
	})

	// 2) 每轮第一步：证明探针还活着。装配行按工具表去重，静默不等于没收到；
	//    这一行每轮必写一次，用来区分「没收到」和「收到但去重了」。
	listen(ctx, 'agent/pre-step', (payload, next) => {
		try {
			if (payload?.step === 1) emit(`turn agent=${shortId(payload?.agent?.id)} turn=${payload?.turn ?? '?'}`)
		} catch {
			/* 探针不能影响 pre-step */
		}
		return next()
	})

	// 3) agent 创建：理论上一轮装配之前就该有一次，用来对时间线。
	listen(ctx, 'agent/created', (payload) => {
		try {
			emit(`created agent=${shortId(payload?.agent?.id)} source=${payload?.source ?? '?'}`)
		} catch {
			/* 忽略 */
		}
	})

	// 4) 请求边界：request/header 真的落了，说明这一轮发出去了。
	listen(ctx, 'session/event', (session, event) => {
		try {
			if (event === null || typeof event !== 'object' || event.type !== 'request/header') return
			const tools = event.data?.header?.tools
			if (!Array.isArray(tools)) return
			const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
			emit(
				`header agent=${shortId(session?.id)} seq=${event.seq ?? '?'} reason=${event.data?.reason ?? '?'} tools=${tools.length} bytes=${bytes}`,
			)
		} catch {
			/* 忽略 */
		}
	})
}
