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
 * @param {{
 *   text?: string,            // 提醒文案
 *   repeatEvery?: number,     // 每 N 个 step 提醒一次；1 = 每个 step 都提醒
 *   sourceKind?: string,      // 提醒消息的去重标识；改它可与其它提醒插件共存
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const reminderText = config.text ?? '请用简体中文思考和回复；代码、命令、路径、报错原文按原样保留，仅用中文解释。'
  const repeatEvery = Math.max(1, Math.trunc(config.repeatEvery ?? 1))
  const sourceKind = config.sourceKind ?? 'zh-reminder'

  /**
   * 【Bug C 修复】判断一批消息里是否已带本插件的同款提醒。
   *
   * 必须同时命中两点才算「重复」：
   * 1. source.kind === sourceKind —— 精确锁定是本插件注入的提醒，不误伤其它插件消息；
   * 2. content 里有一段 text 与 reminderText 完全一致 —— 避免「同 kind 但不同文本」
   *    的提醒被误判为已存在而被吞掉。
   */
  const hasReminder = (messages) => {
    if (!Array.isArray(messages)) return false
    return messages.some((m) => (
      m?.source?.kind === sourceKind
      && Array.isArray(m.content)
      && m.content.some((b) => b?.type === 'text' && b.text === reminderText)
    ))
  }

  // 本地计数：DSH 的 payload.step 不是稳定的「第几步」全局计数器（跨工具循环、
  // 重放等场景不可控），改用本插件自己维护的调用序号，避免「奇偶」语义不可预测。
  let calls = 0

  ctx.on('agent/pre-step', async ({ signal }, next) => {
    // 【Bug A 语义】`agent/pre-step` 是「返回合并」型瀑布：每个 handler 用
    // `await next()` 拿到**后续所有 handler 处理完**的 decision（同一对象透传），
    // 在其基础上修改后 `return` 出去成为最终结果。这里**只调用一次 next()**——
    // 多次调用会触发 cordis `waterfall` 抛 `Error("next() called multiple times")`。
    // 本 handler 以 prepend（ctx.on 第三参 true）注册，位于瀑布最外层：下游所有
    // 注入者（dsh-agent-instructions、runtime-context、time-context 等）都在
    // next() 里先追加完毕，reminder 最后追加 ⇒ 恒定排在消息最末尾，紧贴本次生成。
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    // 【Bug B 修复】频次控制：用自维护计数器 calls 代替 payload.step。
    // calls 从 1 开始；每调用一次 +1。只在 calls % repeatEvery === 0 时追加。
    // repeatEvery=1（默认）⇒ 每个 step 都提醒，紧贴生成；repeatEvery=N ⇒ 每 N 步一次。
    // 注意：真正的「稀释」来源是历史里**堆积多条同款提醒**——已由下方 hasReminder
    // 去重根治：任何时刻上下文里至多一条本插件提醒，故重复提醒不会互相稀释。
    calls += 1
    if (calls % repeatEvery !== 0) return decision

    // 【Bug C 修复】本 step 即将发送的消息里若已带同款提醒，直接返回，不再追加。
    // 这保证即使 reminder 残留进了上一步的历史，这一步也不会再复制出一条。
    if (hasReminder(decision.messages)) return decision

    const { createUserMessage, boundContextSummary } = await import('@deepseek-ai/dsh-llm')
    // createUserMessage 不校验 source.summary 长度（官方 notice 约定 120 字符上限，
    // 见 dsh-llm 的 CONTEXT_SUMMARY_MAX_CHARS）。config.text 自定义超长文案时，
    // 用 dsh-llm 导出的 boundContextSummary 截到 120 字符（119 + "…"）保持合规。
    const reminder = createUserMessage({
      content: [{ type: 'text', text: reminderText }],
      source: { kind: sourceKind, form: 'reminder', summary: boundContextSummary(reminderText) },
    })

    return { ...decision, messages: [...decision.messages, reminder] }
  }, true) // true = prepend shorthand：本 handler 成为瀑布最外层，提醒恒定排在消息最末尾（否则 dsh-time-context 的英文时间戳可能垫后）
}