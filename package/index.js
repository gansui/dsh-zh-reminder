/**
 * dsh-zh-reminder — 最小粒度的中文语言提醒（针对 DeepSeek 前缀缓存优化）。
 *
 * 核心思路：
 * 不依赖「系统提示词里写规则」，而是监听 `agent/pre-step` —— DSH 在**每个 step
 * 请求模型之前**必经的 waterfall 钩子（官方 `dsh-plan-mode` 用它在每步追加
 * narration 消息，模式已验证生产可用）。每步把一条极短的 user 角色提醒追加到
 * 该 step 的消息末尾，紧贴本次生成，让「中文」时刻悬在模型眼前。
 *
 * 为什么它能解决「模型输出英文」：
 * 现在 profile 里跑的 `dsh-zh-cn`（即 zh.js 的三层实现）第三层 snapshot 由
 * `RuntimeContextProjection` 投影，其去重逻辑 `retained?.text === snapshot` 短路：
 * 恒定文本的快照只在**第一次**进入历史，之后不会每步重复。长流程（多次 tool
 * 调用）之后，模型在系统提示词里读到的中文规则已经隔了上万 token 的英文工具
 * 文档，自然「忘」了。agent/pre-step 每步注入则每步都强制刷新注意力。
 *
 * ── 对 DeepSeek 前缀缓存的影响（关键）──
 * DeepSeek 用自动**前缀缓存**：相邻两次请求从 messages[0] 逐条精确比对，
 * 命中的前缀不重算（cache_read_input_tokens），只有分歧点之后的尾部重算。
 *
 * 1. 本插件的提醒**追加在消息最末尾**（tail 位置），不动前缀。连续请求之间，
 *    系统提示词 + 此前所有历史完全一致 ⇒ 长前缀全部命中缓存，只有这条 ~20
 *    token 的提醒被重算，代价可忽略。这跟 zh.js 把 snapshot 放在 order 130
 *    尾部的道理一样：tail 位置天然不伤前缀缓存。
 *
 * 2. 反而**越改系统提示词越伤缓存**：DeepSeek 适配器声明 `systemPromptUpdate:
 *    "in-history"`，就是当系统提示词变化时在历史**尾部追加**一条新 system 消息
 *    而不是重写 message[0]——目的正是保住前面那个可复用的长前缀。所以「把中文
 *    规则写进系统提示词、然后每次改动系统提示词文本」这条路，比「尾部追加
 *    提醒」更伤缓存。
 *
 * 3. 成本权衡：每步追加 = 每步多 ~20-30 token 的输出计费（cacheWrite）＋
 *    下一次请求里这一条的小段重算。相对动辄几千 token 的上下文，微不足道。
 *    可用 config.repeatEvery 调低频次；但要明白——低频次会让提醒离生成变远，
 *    正是「模型忘了」的复发点。
 */
export const name = 'zh-reminder'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ text?: string, repeatEvery?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const reminderText = config.text ?? '请用简体中文思考和回复；代码、命令、路径、报错原文按原样保留，仅用中文解释。'
  const repeatEvery = config.repeatEvery ?? 1 // 每 N 步提醒一次；1 = 每步都提醒

  ctx.on('agent/pre-step', async ({ signal, step }, next) => {
    // next() 得到本轮该 step 默认要进入的消息（已含 runtime-context 快照）
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    // 频次控制：只在 step % repeatEvery === 0 时追加（payload 的 step 序号）
    if (repeatEvery > 1 && step % repeatEvery !== 0) return decision

    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const reminder = createUserMessage({
      content: [{ type: 'text', text: reminderText }],
      source: { kind: 'zh-reminder', form: 'reminder', summary: reminderText },
    })

    return { ...decision, messages: [...decision.messages, reminder] }
  })
}