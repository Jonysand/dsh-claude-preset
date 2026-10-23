/**
 * 给 DSH 的压缩检查点结构做两处改动：
 *   - 新增 All User Messages：按顺序列出非工具结果的用户消息，指令与约束保留原文
 *   - 把上游的 Pending Jobs 改名成 Pending Tasks 并扩写：把未完成的显式请求映射到验收标准、
 *     标出缺证据的项，并带上还在跑的后台作业。名字跟 Claude Code 自己的压缩提示一致
 *     （它的第 7 项就是 Pending Tasks）。这是有意改名，不是漏抄：上游那句
 *     "explicitly requested work not yet completed" 正是这里要覆盖的内容。
 *
 * 为什么不用子类覆盖 summarize()：compaction-basic 的摘要指令是模块内常量
 * （COMPACTION_INSTRUCTION），没有导出；它导出的 BasicCompactionEngine 又只能
 * 通过 @deepseek-ai/dsh-compaction-basic 拿到，而外部插件在 profile 里解析不到
 * 这个包（它只存在于 app.asar）。所以这里换一个仍然稳定的接缝：
 *
 *   compaction-basic 的 summarizeWithLlm() 用 ctx.llm.stream({ purpose: "compaction" })
 *   发起辅助请求，并把指令作为最后一条 user 消息追加。本插件包装 ctx.llm.stream，
 *   只在 purpose === "compaction" 时把那条指令换成扩展版；其它请求原样透传，
 *   不进内容、不改 envelope、不动回放前缀，因此热前缀缓存与原文一致性都不受影响。
 *
 * 边界：
 *   - 指令文本是抄自当前版本的完整替换，不是拼接。上游改了基础指令，这里要同步，
 *     否则会丢掉新版加的规则。替换条件用开头一句做匹配，匹配不到就不动。
 *   - 文本里出现 <compacted-summary> 是检查点自身的标签，属于协议的一部分。
 *   - 包装按引用计数：同一个 llm 实例只包一次，每次 apply 记一个用户，最后一个用户卸载时才还原
 *     stream。只做幂等判断的话，新版先挂载、旧版后卸载会把补丁一起带走，且不报警。
 */

const INSTRUCTION_PREFIX = "You are now acting as a compaction engine";
const COMPACTION_PURPOSE = "compaction";
const STATE = Symbol.for("dsh.compaction-claude.instruction.state");

export const INSTRUCTION = [
	"You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
	"",
	"Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
	"",
	"## Primary Request and Intent",
	"- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
	"",
	"## Key Technical Concepts",
	"- [technologies, frameworks, patterns, and conventions in play]",
	"",
	"## Files and Code",
	"- [exact path: why it matters, key changes or snippets]",
	"",
	"## Errors and Fixes",
	"- [error: how it was resolved, plus any related user feedback]",
	"",
	"## All User Messages",
	"- [every user message that is not a tool result, in conversation order. Keep instructions, corrections, scope changes and acceptance criteria verbatim; summarize only the surrounding discussion. Preserve security-relevant constraints word for word.]",
	"",
	"## Pending Tasks",
	"- [explicitly requested work not yet completed, each mapped to the acceptance criterion it satisfies. List every unchecked item from any plan or task list in the conversation, plus any background job still running. When the evidence for an item is missing, say what is missing instead of marking it done.]",
	"",
	"## Current Work",
	"- [precisely what was in progress at this checkpoint]",
	"",
	"## Next Step",
	"- [the single next action, directly in line with the most recent request, or \"(none)\"]",
	"",
	"## Critical Context",
	"- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
	"",
	"Rules:",
	"- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
	"- Capture user feedback and explicit instructions faithfully, especially corrections.",
	"- Do NOT mention this summarization request or that the context was compacted.",
	"- Output only the checkpoint text: do not call any tool or take any other action.",
	"- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure."
].join("\n");

/**
 * 把压缩请求里最后一条 user 消息中的指令换成本扩展版。
 * 非压缩请求、结构不符、找不到基础指令时返回原对象，调用方无需区分。
 */
export function rewriteCompactionInstruction(options) {
	if (options === null || typeof options !== "object") return options;
	if (options.purpose !== COMPACTION_PURPOSE) return options;
	const { messages } = options;
	if (!Array.isArray(messages)) return options;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === null || typeof message !== "object") continue;
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const blockIndex = message.content.findIndex((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string" && block.text.startsWith(INSTRUCTION_PREFIX));
		if (blockIndex === -1) continue;
		const content = message.content.slice();
		content[blockIndex] = { ...content[blockIndex], text: INSTRUCTION };
		const nextMessages = messages.slice();
		nextMessages[index] = { ...message, content };
		return { ...options, messages: nextMessages };
	}
	return options;
}

export const name = "compaction-claude";
export const inject = ["llm"];

export function apply(ctx) {
	const { llm } = ctx;
	if (llm === void 0 || llm === null || typeof llm.stream !== "function") {
		ctx.logger?.warn?.("compaction-claude: ctx.llm.stream is unavailable; summarization instruction left unchanged");
		return;
	}

	// 引用计数：多个作用域或两次预设 revision 可能先后 apply，包装只做一次，
	// 每个 apply 记一个用户，最后一个用户卸载时才还原，避免「新版先挂、旧版后卸」把补丁带走。
	let state = llm[STATE];
	if (state === void 0) {
		const original = llm.stream;
		const stream = function patchedStream(options) {
			return original.call(this, rewriteCompactionInstruction(options));
		};
		state = { original, stream, users: 0 };
		try {
			llm.stream = stream;
			llm[STATE] = state;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.logger?.warn?.(`compaction-claude: cannot patch ctx.llm.stream (${message}); summarization instruction left unchanged`);
			return;
		}
	}

	state.users += 1;
	ctx.effect(() => () => {
		state.users -= 1;
		if (state.users > 0) return;
		// 只在 stream 仍然是我们装的那个时才还原；别人后装的流不去覆盖。
		if (llm.stream === state.stream) llm.stream = state.original;
		delete llm[STATE];
	}, "compaction-claude: summarization instruction");
}
