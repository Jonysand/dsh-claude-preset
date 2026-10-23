/**
 * 延迟加载的暴露层：每轮装配时把指定工具从工具表里摘掉。
 *
 * 为什么摘装配而不是用 `deferLoading`：模型可见的 tools 由装配决定，而 `dsh-llm`
 * 在路由没有 `toolUpdate` 能力时会把 `deferLoading` 标记剥掉、把工具全发出去
 * （`dsh-llm/lib/index.js` 的 `projectToolUpdates`）。那条路在非 Anthropic 路由上
 * 静默失效，只剩"以为省了"的错觉。装配层摘掉是路由无关的：工具压根不进请求。
 *
 * 摘掉之后工具仍然可执行：执行从 registry 解析（`dsh-tools` 的 `resolveExecution`），
 * 不看这份装配结果。Step 1 只做暴露，不提供发现入口——所以**默认一条也不摘**，
 * 配置为空时本插件是空操作。真正开启要等 `tool_search` 落地（Step 2），
 * 否则摘掉的工具模型没有任何办法找回来。
 *
 * 作用域：监听器挂在 preset 自己的插件树上，只收得到本 preset 代际的装配。
 * 同进程里别的 preset 的会话不受影响（实测见 docs/deferred-tools-gaps.md 2.8）。
 */

/** 可以被摘掉的工具名。留在列表外的工具一律常驻。 */
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
export function filterTools(tools, deferred) {
	if (!Array.isArray(tools)) return tools
	if (deferred === undefined || deferred.size === 0) return tools
	let removed = false
	const kept = []
	for (const tool of tools) {
		const name = tool?.name
		if (typeof name === 'string' && deferred.has(name)) {
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

export const name = 'tool-search'

export function apply(ctx, config) {
	const deferred = toNameSet(config?.defer ?? DEFAULT_DEFERRED)

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

	if (deferred.size === 0) {
		report('exposure: no deferred tools configured (filter is a no-op)')
	} else {
		report(`exposure: deferring ${[...deferred].sort().join(',')}`)
	}

	ctx.on('system-prompt/assemble', async (assembly, context, next) => {
		// 先让后面的监听器跑完，再拿最终工具表；装配结果是权威值，必须原样传下去。
		const assembled = await next()
		try {
			const before = Array.isArray(assembled?.tools) ? assembled.tools : undefined
			if (before === undefined || deferred.size === 0) return assembled
			const after = filterTools(before, deferred)
			if (after === before) {
				// 一个都没命中也要报一次：配置的名字写错了，这就是唯一的证据。
				if (announced !== 'miss') {
					announced = 'miss'
					report(`exposure: none of ${deferred.size} deferred tool(s) are in this assembly (${before.length} tools)`)
				}
				return assembled
			}
			const kept = after.map((tool) => tool?.name).filter((tool) => typeof tool === 'string')
			const removed = before
				.map((tool) => tool?.name)
				.filter((tool) => typeof tool === 'string' && deferred.has(tool))
				.sort()
			const signature = `${before.length}>${after.length}:${removed.join(',')}`
			if (announced !== signature) {
				announced = signature
				report(`exposure: ${before.length} -> ${after.length} tools, removed ${removed.join(',')} (kept ${kept.length})`)
			}
			return { ...assembled, tools: after }
		} catch (error) {
			// 过滤器自己的异常不能弄断整轮装配：退回未过滤的结果，并留下证据。
			const message = error instanceof Error ? error.message : String(error)
			report(`exposure: filter failed, assembly left untouched: ${message}`)
			return assembled
		}
	})
}
