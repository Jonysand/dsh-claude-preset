/**
 * 工具面收敛与缓存代价观测（不做延迟加载）。
 *
 * 只做两件事：
 *
 * 1. 挡住明确不属于 Claude Code 语义的宿主工具：goal 三件套、workflow、
 *    working_directory、plugin_manager、load_workspace_dependencies，以及按前缀识别的
 *    cordis_inspect_* / schedule_*。名单短且稳定，挡掉即消失，不提供取回通道。
 *
 *    present **不在**名单里。它是本 preset 自己挂的工具，由 tool-search 延迟：稳态不占
 *    工具表，要交付文件时用 tool_search 取回。挡掉的名字既拿不回 schema（目录里也没有），
 *    按名字调用还会被判成不存在的工具，交付这条路就彻底断了。
 *
 *    free-search 的四个检索工具（advanced_search / multi_search / platform_search /
 *    free_search_test）**不在**这个名单里：它们由 tool-search 延迟，模型按需取回。
 *    挡掉等于连取回的路一起断了，而 web_search 的描述末尾又点着这几个名字，模型会去搜。
 *    实测一次这样的空搜：整段思考加一次往返，白花。
 *
 *    实际挡住多少取决于组合：Web/Desktop 里 dsh-web-app 已把 tool-goal /
 *    tool-workflow / tool-plugin-manager 设成 disabled，名单里这些名字空转，
 *    通常只剩 working_directory；base-only 组合才会真挡住 goal 三件套与 workflow。
 *    schemas() 不带 scope 是全局视图，正好是 restrict 能收窄的那一层。
 *
 * 2. 审计：request/header 一变就输出一行——工具数、工具块字节、按 4 字符/token
 *    粗估的 token、这次相比上次增删了谁。工具块在请求最前面，任何字节变化都会让
 *    缓存从该 token 起失效，这行日志就是那次失效的凭证。
 *
 * 为什么不做延迟加载：实测一次取回 = 一次全前缀重建（persona + 工具块 + 历史，
 * 按写入 1.25x 计价），而把工具块留在缓存前缀里每轮只按读取 0.1x 计价。
 * 本 preset 的工具块约 17KB（约 4.3K token），一次取回的代价约等于十余轮的
 * 缓存读，因此在当前体量下延迟加载是亏的。MCP 那种几万字符的包才可能回本，
 * 到时再按 docs/deferred-tools-gaps.md 里的路径处理。
 *
 * 收敛时机：agent loop 的顺序是「装配 prompt 与 tools → agent/pre-step →
 * 记 request/header → 冻结请求 → 发出」。装配在 pre-step 之前，所以**在 pre-step 里
 * 挡工具永远只能改变下一次请求**——那正好是一个工具表变化，从第一个变化的 token 起
 * 缓存全失效。实测一次重建 7,090 input token，而让该工具常驻只有每轮几百字节的
 * 缓存读（0.1x）；一次变化的代价约等于 7 个普通轮次，回本要十五到二十轮。
 *
 * 因此收敛只在 apply()（agent 创建时）做一次，早于第一次装配；之后不再动。
 * 代价是晚注册的工具（Desktop 的 load_workspace_dependencies）会留在表里，
 * 这是有意为之：留着比付一次重建便宜得多。
 *
 * 唯一的例外是挂载时根本拿不到工具表：那时一条都没挡住，再等也不会好，所以在
 * agent/pre-step 里补扫一次。正常路径上这次补扫什么都不做，不产生工具表变化。
 */

/** 明确不属于 Claude Code 语义的宿主工具。 */
const EXCLUDED_TOOLS = [
	'create_goal',
	'get_goal',
	'update_goal',
	'workflow',
	'working_directory',
	'plugin_manager',
	// free-search 的四个检索工具（advanced_search 1038 / multi_search 626 /
	// platform_search 663 / free_search_test 657，合计 2,984 字节）不在这里挡：
	// 它们由 tool-search 延迟，模型按需取回。挡掉会把取回的路一起断掉——模型会照
	// web_search 描述里点的名字去搜，搜不到就是一次白跑。
	// Desktop 在会话层补挂的依赖查询工具（约 640 字节），同样不属于 CC 语义。
	'load_workspace_dependencies',
]

/** 按前缀识别的宿主工具；匹配到的名字同样会被挡掉。 */
const EXCLUDED_PATTERNS = [/^cordis_inspect/, /^schedule_/]

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

/** 这个名字是否属于要挡掉的宿主工具。 */
function excluded(name) {
	return EXCLUDED_TOOLS.includes(name) || EXCLUDED_PATTERNS.some((pattern) => pattern.test(name))
}

export const name = 'tool-surface'
export const inject = ['tools']

export function apply(ctx) {
	// 审计按会话存：preset revision 只有一个实例，多会话共用闭包，状态必须分开。
	const audits = new Map()
	const tried = new Set()

	const report = (message) => {
		try {
			ctx.logger?.info?.(`tool-surface: ${message}`)
		} catch {
			/* 日志失败不影响主流程 */
		}
		console.error(`[tool-surface] ${message}`)
	}

	/** 全局层可见的工具；拿不到返回 null。
	 *  schemas() 不传 scope 就是全局视图（dsh-tools 的注释原文：omitted = the global view），
	 *  正好是 restrict 能收窄的那一层；agent 作用域的 scoped 工具不会出现在这里。
	 *  挂载时拿不到就没有第二次机会（sweep 正常只调用一次），所以调用方要单独记一行日志。 */
	const visibleTools = () => {
		try {
			const schemas = ctx.tools.schemas()
			if (!Array.isArray(schemas)) return null
			const tools = schemas.filter((schema) => typeof schema?.name === 'string' && schema.name.length > 0)
			return tools.length > 0 ? tools : null
		} catch {
			return null
		}
	}

	/** 挡一个名字。返回值区分三种结果，别让日志把原因混在一起：
	 *  - denied：挡住成功；
	 *  - scoped：restrict 不认这个名字。schemas() 只列全局工具，正常走不到这条；
	 *    留着是防御「取表」和「挡」之间工具表变了；
	 *  - failed：其它错误（比如作用域不对），记原文，不假装成功。 */
	const denyOne = (name) => {
		try {
			ctx.tools.restrict({ deny: [name] })
			return 'denied'
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes('unknown global tool')) return 'scoped'
			report(`restrict failed on ${name}: ${message}`)
			return 'failed'
		}
	}

	/** 扫一遍可见工具表，挡掉名单里的名字；没有命中就不出声。
	 *  默认只在 apply()（agent 创建时）调用一次：装配发生在 agent/pre-step 之前，
	 *  所以在 pre-step 里挡工具永远只能改变"下一次"请求——那一挡就是一个工具表变化、
	 *  一次全前缀重建（实测 7,090 input token）。让它常驻每轮只是几百字节的缓存读，
	 *  一次变化的代价约等于 7 个普通轮次，回本要十五到二十轮。
	 *  唯一的例外：挂载时拿不到工具表（ready 仍为 false），pre-step 补扫一次。 */
	const sweep = (label) => {
		const tools = visibleTools()
		if (tools === null) {
			report(`restrict at ${label}: tool list unavailable`)
			return
		}
		ready = true
		const fresh = tools.filter((tool) => excluded(tool.name) && !tried.has(tool.name))
		if (fresh.length === 0) return
		const denied = []
		const kept = []
		for (const tool of fresh) {
			tried.add(tool.name)
			const outcome = denyOne(tool.name)
			if (outcome === 'denied') denied.push(tool.name)
			else if (outcome === 'scoped') kept.push(tool.name)
		}
		const parts = [`restrict at ${label}:`]
		parts.push(denied.length > 0 ? `denied ${denied.join(',')}` : 'nothing to deny')
		if (kept.length > 0) parts.push(`| scoped, kept ${kept.join(',')}`)
		report(parts.join(' '))
	}

	// 收敛点：agent 创建时执行，早于第一次装配，挡下的名字不会进第一轮请求。
	let ready = false
	sweep('mount')

	// 补扫：只在挂载时没拿到工具表的情况下生效（正常路径 ready 为 true，这里什么都不做），
	// 否则「拿不到工具表」就是一条永远不恢复的死路径。
	const rescue = ctx.on('agent/pre-step', (payload, next) => {
		if (!ready) sweep('pre-step')
		return next()
	})
	if (typeof rescue === 'function') ctx.effect(() => rescue, 'tool-surface: mount rescue')

	// 审计：按会话分开记账，工具表一变就输出一行。
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
