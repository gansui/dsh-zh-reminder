最好的强制模型中文输出dsh插件,基本可以保证默认的输出均为中文

安装方法

    下载dsh-zh-reminder-1.0.0.tgz
    执行 dsh plugin --profile web add ./dsh-zh-reminder-1.0.0.tgz

现在一般常见的现在给出三种插件的技术思路对比。

---

## 三种插件的技术思路对比

三种插件目标相同——让模型用中文思考/输出——但**干预模型的位置和粒度完全不同**。一句话概括：

| | 干预位置 | 粒度 | 关键机制 |
|---|---|---|---|
| **@max-null/dsh-chinese-thinking** | 系统提示词**开头**（order -90） | 最粗 | 只在系统提示词注入一段固定文本，一次 |
| **dsh-zh-cn** | 系统提示词**三处** + 运行时快照 | 中 | policy(开头)+final-word(结尾)+snapshot(历史末尾) |
| **dsh-cn-reminder** | **每个 step 请求前**（`agent/pre-step`） | 最细 | 每步往消息末尾追加一条 user 提醒 |

---

### 1. @max-null/dsh-chinese-thinking — 单层静态注入（最粗）

**思路**：只往系统提示词里塞一段固定中文规则（`order: -90`，紧跟 harness 身份之后，是模型最早读到的行为指令），塞完就完事。

```js
ctx.systemPrompt.section({ name: 'chinese-thinking', order: -90, text: PROMPT_TEXT })
```

**为什么失败**：它只在「系统提示词组装」时生效**一次**。系统提示词后面跟着上万 token 的英文工具文档，而模型生成时离这段规则已经很远——长流程多次 tool 调用后，注意力早被后面的英文淹没。这正印证了猜测「控制粒度粗，模型一会儿就忘」。

---

### 2. dsh-zh-cn — 三层（当前在跑，中粒度）

**思路**：三处互相补位，覆盖模型读系统提示词的「开头」和「结尾」两个注意力高峰，外加一条运行时快照贴近生成。

- **policy**（order -900）：完整立场声明，紧跟 harness 身份，开头；
- **final-word**（order 10500）：系统提示词的**最后一个字**，部署 persona 之后，结尾；
- **snapshot**（context order 130）：运行时上下文快照，作为 user 角色消息**进入历史末尾**，紧贴本次生成。

**比 @max-null/dsh-chinese-thinking 强的点**：多覆盖了「结尾」这个位置，且快照在历史末尾、离生成更近。

**为什么还是失效（我代码里的根因分析）**：
> snapshot 由 `RuntimeContextProjection` 投影，去重逻辑 `retained?.text === snapshot` 短路——**恒定文本的快照只在第一次进入历史，之后不会每步重复**。

也就是说：三层里真正「贴近生成」的那层（snapshot）只在文本变化时附一次。恒定文本下，它进入历史后就不再复现。长流程之后，模型能读到的中文规则依旧隔了很远的距离，于是又滑回英文。

---

### 3. dsh-cn-reminder — 最小粒度（`agent/pre-step` 每步注入）

**思路**：不用「写规则」，而是监听 **`agent/pre-step`** —— DSH 在**每个 step 请求模型之前**必经的 waterfall 钩子。每步把一条极短的 user 角色提醒追加到该 step 消息**末尾**，紧贴本次生成。

```js
ctx.on('agent/pre-step', async ({ signal, step }, next) => {
  const decision = await next()                       // 拿到默认要进入的消息
  if (decision.kind === 'reject' || signal.aborted) return decision
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const reminder = createUserMessage({ content: [{ type: 'text', text: reminderText }],
    source: { kind: 'zh-reminder', form: 'reminder', summary: reminderText } })
  return { ...decision, messages: [...decision.messages, reminder] }
})
```

**为什么有效**：
- `agent/pre-step` 是**每步必经**，不像 snapshot 那样只在文本变化时出现一次；
- 消息追加在**本 step 末尾**，紧贴本次生成，注意力最强；
- 官方 `dsh-plan-mode` 正是用同一模式在每步追加 narration 消息，**生产验证可用**，无副作用。

---

### 核心区别一句话

- **@max-null/dsh-chinese-thinking**：告诉模型「记住用中文」→ 只讲一次，模型转头就忘。
- **dsh-zh-cn**：讲三次（开头+结尾+快照），但快照只在第一次生效，长流程后依然失效。
- **dsh-cn-reminder**：**每步在模型面前放一张「用中文」的字条**，时刻刷新注意力——这才是真正的最小粒度。

代码在 `dsh-cn/index.js`。如果把它接入 profile（在 `cordis.patch.yml` 里注册替换掉 `dsh-zh-cn`，或两者并存对比）。

关于你问的**缓存影响**，我已在 index.js 头部注释里分析清楚（DeepSeek 前缀缓存的结论）：

> 提醒追加在消息**末尾**，不动前缀 → 连续请求的长前缀全部命中缓存，只有这条 ~20-30 token 重算，代价可忽略；反而越改系统提示词越伤缓存（这正是 DeepSeek 声明 `systemPromptUpdate: "in-history"`、在尾部追加新 system 消息而非重写 message[0] 的原因）。

