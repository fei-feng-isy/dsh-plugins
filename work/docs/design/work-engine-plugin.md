# `@avantf/work` 工作引擎插件：设计文档

> 2026-09-15 · 状态：待实施
> 目标：DeepSeek Harness（本机 `@deepseek-ai/dsh@0.1.5-rc.1`，profile `web`）
> 范围：**只写本插件需要实现的部分**。DSH 自带能力（子 agent 生成、提示词注册表、宿主 KV、生命周期事件、agent 投递接口）只在使用点列名，不展开。
> 关联：`docs/planned/2026-09-15-dsh-prompt-layer-port-design.md`（prompt 侧）、`docs/design/work-stack-refactor.md` v8（AvantF 原设计）

---

## 一、设计原则

工作树的执行模型是「逐步解决前置问题，不断逼近最终结果」：

1. 一个工作节点先被**尝试执行**
2. 发现缺少前提 → **由执行者自己拆解**出子节点（前提工作挂到该节点下）
3. 子节点各自被执行，全部终态后父节点重新可执行
4. 父节点这次的工作是**汇总子结论**，判断"目标已达成 → 提交结果"或"仍需拆解"
5. 直到根节点提交结果

从这里推出四条本插件必须遵守的原则：

| 原则 | 含义 | 由谁保证 |
|---|---|---|
| **引擎是程序，不是 agent** | 扫树、派活、回收全部是宿主代码，不花 LLM 调用 | 本插件 |
| **工作单元无状态、用完即弃** | 每次执行是一次新的子 agent，从不等待、从不持有 | 本插件（每次 spawn 新会话）|
| **拆解由执行者做，不在引擎里做** | "为什么需要这个前提"只有尝试过的人知道 | 本插件（工具只在工作单元上下文暴露）|
| **状态在树里，不在任何会话里** | 节点是唯一的权威状态载体 | 本插件（宿主 KV）|

由此得到的两个"不需要"：

- **不需要帧栈 / converge / 回注水位** —— 没有跨轮持有的执行帧
- **不需要 overlay 式上下文切换** —— 隔离由会话边界天然提供

---

## 二、节点数据模型

### 2.1 字段

```
tree {                              // 每棵树一条记录
  root_id          : string
  owner_session_id : string         // 建根的 agent —— 归属与销毁判据（§8.6）
  created_at       : number
  closed_at        : number | null  // finish_work 收尾时刻；归档后退出引导层
}

node {
  id            : string            // 短 id，便于工具引用
  root_id       : string            // 所属树
  parent_id     : string | null     // 创建它的父节点（见下）
  title         : string            // 一句话
  description   : string            // 工作内容
  context       : string[]          // 工作背景：拆解原因等，由拆解者写入
  corrections   : string[]          // master 的纠偏，最新在后（§6.6）
  analysis_notes: string[]          // 执行者用 note_work 写下的判断，最老在前（§5.3.2）
  analysis_attempt: number          // 写下最后一条时的 attempts；0 表示没人写过
  status        : NodeStatus
  created_at    : number            // 跨树公平排序用（最老优先）
  depth         : number            // 根为 1
  claimed_by    : string | null     // 持有者 session id —— 持久
  claimed_at    : number            // 超时兜底用
  attempts      : number            // 已执行次数
  result        : string | null     // 内联结果（超长时是摘要）
  has_result    : bool              // 必须能区分「没写」与「写了空串」
  result_read_at: number | null     // 收尾门控用
  result_ref    : string | null     // 落盘定位符
  result_hint   : string | null     // 后端给的取回指引（§5.3.1）
  children      : string[]          // 子节点 id 有序列表
  updated_at    : number
}
```

**`parent_id` 是"出生时的父节点"，不是"唯一依赖方"**：拆解去重会把已有节点复用为**另一个父节点**的前提（§9.3），此时它在两个父节点的 `children` 里，而 `parent_id` 仍是创建它的那一个（工作链沿它回溯）。因此"谁依赖我"必须由 `children` 反查，不能由 `parent_id` 推断。

`owner_session_id` 只在树记录上：**归属建根的 agent，其他 agent 不可见**（§8.1）；它也是"master 被销毁则销毁树"的判据来源（§8.6）。

`claimed_by` / `claimed_at` 也**写进 KV**（跨引擎代际的绑定记忆），但它们的用途是**被解析**：引擎每次分派前用 `claimed_by` 去查那个 agent 还在不在，活性由查询决定、不由这两个字段自己断言。见 §3.2。

### 2.2 状态机

```
                  ┌──────────────────────────────────────┐
                  │                                      │
  blocked ────────┼──► ready ──► running ──► done         │
  (有未终态子)     │     ▲         │                    │
                  │     │         ├──► failed           │
                  │     │         │                    │
                  │     └─────────┴──► interrupted ─────┘
                  │     回收/释放           (可再派活)
                  └──────────────────────────────────────┘
```

| 状态 | 可派活 | 含义 |
|---|---|---|
| `blocked` | ❌ | 有未终态子节点。**不计数、不派活**，但要下探其子树 |
| `ready` | ✅ | 无子节点，或子节点全终态（待汇总） |
| `running` | ❌ | 已派出，有绑定者 |
| `done` / `failed` | ❌ | 终态 |
| `interrupted` | ✅ | 曾派出但绑定者死亡/被中断，可重新派活 |

**可派活 = `ready` 或 `interrupted`。** 这两种节点是"空闲叶工作"的完整来源。

**不做的事**：终态节点永不被派活；`blocked` 节点不计入派活数（否则会过量扩容 —— 这是原设计里一次已修正的口径错误）。

### 2.3 释放不能回 `ready`

**会话续命的两个新结局（2026-09-20）**：`wake-failed` 是唯一不进入 `interrupted` 的 cause —— 它把
`adoptParked` 刚认领的节点退回 `ready`，不消耗任何预算、也不触发启动冷却，因为"一个停手的会话被清掉了"
既不是工作失败也不是基础设施故障，而且它的冷却只会拖慢它本该立即启用的 fallback（新起一个执行者）。
唤醒**成功但这一轮没有产出**则与普通 worker 完全同路：`subagent/end` → 扫描 → 按 `vanished` 回收，
照常消耗 `failures`。

`running` 的节点回收后进入 **`interrupted`**，不是 `ready`。原因：

- 下一个执行者要知道"**前面有人试过**"，避免重复同一段失败探索
- `attempts` 随每次派活递增，重复失败可以据此升级策略（换方法 / 标 failed / 上报）

这条替代了原设计里"释放但保留上下文交给别人接着跑"的需求 —— 在无状态工作单元的模型下，**需要交接的只有节点上的尝试记录，不是上下文**。

---

## 三、绑定与活性

### 3.1 没有"认领"这回事

**绑定发生在派活的那一刻，紧随 spawn**，不是一次独立的抢占动作：

```
引擎：scan → 取到 ready 节点 → spawn 工作单元 → 记下 claimed_by = 子 agent 的 session id
```

因为**派活方就是引擎自己**（唯一的派活者），一个节点在同一时刻只可能被派给一个工作单元 —— 不存在两个执行者争抢同一个节点的情形，也就没有"认领/抢占/重验"这套协议。

这与原设计不同，原因在两边引擎的形态：

| | AvantF | 本插件 |
|---|---|---|
| 派活者 | 多个念头（对等、各自去抢） | **引擎自己**（唯一） |
| 绑定方式 | 念头从树上**拉取**（`claim_next`）→ 必须原子抢占 | 引擎**推送**（spawn 时直接指定节点）→ 天然互斥 |
| 因此需要 | 三段式取候选 + 重验 + 锁序 | **不需要** |

> AvantF 之所以需要认领协议，是因为它的 engine 有推进模块、engine 对象可以直接持有 work 对象，多个念头会并发去摘同一个节点。
> 本插件里引擎是唯一派活者，工作单元只看到注入的 prompt，执行完凭**工作 id** 提交结果 —— 没有可争的东西。

**唯一的并发窗口**是引擎被多个触发源同时唤醒（timer 与事件同时到达），导致同一节点在一次扫描里被派两次（spawn 是异步的）。用一条最轻的规则挡住即可：

**派活前先在本次扫描的批次内标记，再 spawn；同一节点在同一批次内只派一次。** 批次标记是内存集合，不需要持久化、不需要 CAS。

### 3.2 `claimed_by`：固化存储，分派时解析活性

两项决定分开：

| 决定 | 答案 | 作用 |
|---|---|---|
| **是否固化 `claimed_by`** | **是**（写进 KV） | 让引擎在热重载（进程活、agent 活）之后仍知道节点被谁拿着 |
| **何时判断它** | **启动时 + 每次分派前** | 启动处理"上一进程/上一代引擎留下的绑定"；分派处理"这个绑定是否已失效" |

**为什么必须存 id 而不是布尔标记**：它同时承担三件事 —— 判断"还有人在做吗"、校验结果写入方身份（§3.3）、以及控制面（取消/暂停时要打断谁）。布尔化会同时丢掉后两项。

**为什么"分派时判断"是关键**：只在启动时判断不够 —— 一个长跑的引擎中途会遇到 worker 死亡，那时没有"启动"这个时刻可以依赖。判断必须落在分派决策里：

```
dispatch(node):
  if node.status == running:
      if ctx.agents.get(node.claimed_by) 存在   → 跳过（人还在做）
      else                                      → 回收为 interrupted，进入候选
  spawn(node)
```

**一条规则覆盖全部四种场景**（启动本身就是一次全量扫描，走同一条判断）：

| 场景 | `get(claimed_by)` | 结果 |
|---|---|---|
| 热重载（agent 还活着） | 命中 | 不回收，继续等它 |
| 同进程内 worker 死了 | 未命中 | 回收 → `interrupted` |
| 进程重启 | 未命中 | 回收 → `interrupted` |
| 崩溃 | 未命中 | 回收 → `interrupted` |

**不需要区分生命周期类型**：判断的是"那个 agent 还在不在"，不是"这次关闭算哪种"。

| 该持久的 | 说明 |
|---|---|
| 树的拓扑、节点状态、结果、`attempts` | 工作状态 |
| **`claimed_by` / `claimed_at`** | 跨引擎代际的绑定记忆；活性由解析决定，不靠它自己判断 |

#### 3.2.1 spawn 与 bind 之间的窗口

`claimed_by` 的值是**子 agent 的 session id**，spawn 返回后才知道，所以顺序必然是"先 spawn、后 bind"，中间存在一个窗口。窗口内崩溃/热重载 → 节点仍是 `ready`、无人记录 → 重新派 → 孪生执行者。

**不需要用原子性消除它，只需要一条不变量：**

> **引擎的「判断 + 标记 + 发起 spawn」必须在同一个事件循环轮次内完成，期间不让出。**

做法即 §3.1 的批次标记（内存集合）。只要这一整段同步，就不会有第二个扫描插进来重复派。窗口存在，但**只有崩溃能落进去** —— 而那时进程内一切已死，重新派一次是期望行为（宁可重派，也不要节点卡在无人持有的 `running`）。

> **已确认的优化**：continuable 子 agent 的 child id **可由调用方预留** —— `ContinuableStartSpec.childId` 的契约写明 "supplying one lets a durable parent **record provisioning before child materialization** without a second identity handshake"。
> 因此引擎可以先写 `claimed_by` 再物化子 agent，**窗口彻底关闭**。上面那条"同一轮次内不让出"的不变量仍应保留（防重复派活），但不再是承受窗口的唯一依靠。

### 3.3 身份即凭证

`submit_work` / `decompose_work` 只接受**调用方 session id == 节点当前 `claimed_by`** 的写入。僵死 worker 迟到写结果时，它的 session id 已不等于节点当前的绑定者，写入被拒。

这条取代了原设计的 `_result_injected` 幂等水位与"丢帧"逻辑 —— 不需要额外字段，一次身份比较就够。

### 3.4 活性优先，超时兜底

§3.2 的分派判断已经覆盖了"持有者已不存在"，本节补的是**持有者还在但卡死**这一种：

```
对每个 running 节点：
  if ctx.agents.get(node.claimed_by) === undefined
       → 持有者已不存在 → interrupted
  else if now - max(progress_at, claimed_at) > STALE_MS
       → 存活但沉默 → interrupt_agent(claimed_by) → interrupted（记一次 stall）
  else
       → 还在做，不动
```

活性是**主判据**（廉价、确定），超时只兜"活着但卡死"（需要一个阈值，是启发式）。两者都需要，但顺序不能反 —— 先看活性可以避免绝大多数无谓等待。

超时按 `progress_at` 起算：worker 每次往自己的会话里追加事件都会刷新它，所以判据是"沉默多久"而不是"跑了多久"，多步慢活不会被误判。首次停摆只有引擎自己恢复（记 `stalls`），**同一节点第二次停摆**或停摆后失败预算将用尽（`failures ≥ 4`）时才给 owner 一条消息，靠 `stalled_notified_at` 保证每节点至多一次。知会文案引用的也是失败预算而不是派发次数 —— 后者会被成功的汇总轮推高，写出来是"第 7 次派发（上限 5）"。

**"活性"必须包含"正在启动"。** 续期子会话是异步物化的：节点在子 agent 存在之前就已绑定，这段几十毫秒的窗口里 `ctx.agents.get(claim)` 还没有答案。若把这种绑定读作"worker 消失"，一次落在窗口里的扫描（每个 worker 结算都会触发扫描）就会回收它、重派一次 —— 第一个 worker 还活着，它的 `submit_work` 因为不再持有节点而全部被拒。实测代价：5 个节点的三级树跑了 **13 个 worker**（每个节点多跑一次，attempts 白烧一次）。所以 claim 从**预留起**就算 live（`startingClaims`，直到子会话接受 prompt 为止），真正的"从未出现"仍由同一条扫描在启动结束后回收。

### 3.5 跨树公平

多棵树同时活跃时，全局候选池按 `created_at` 最老优先（树内深度优先，跨树公平）。这与原设计一致。

---

## 四、引擎主循环

### 4.1 触发方式

主循环是**宿主代码**（进程级、唯一、零 LLM）。三种触发源叠加：

| 触发 | 来源 | 作用 |
|---|---|---|
| 树状态变化 | 本插件自己的写操作（拆解 / 提交 / 回收）之后立即重算 | 正常推进，实时 |
| worker 生命周期 | `subagent/end` 事件 | 补活性（worker 结束但没写结果 → 立即可回收，不必等超时）|
| 兜底扫描 | timer | 回收卡死节点、处理错过的事件 |

timer 用 `@deepseek-ai/cordis-plugin-timer`（宿主插件可用）。

### 4.2 唤醒 master：`agent/pre-step` 的过滤与放行

master 空闲时由**工作引擎**唤醒。唤醒走 master 的 pre-step，它同时承担**过滤**与**放行判断**两件事：

```
master 被唤醒（inbox 有消息）
  → pre-step:
      decision = await next()          // 默认 decision = [...inbox 认领, 运行时上下文快照]
      ⓪ 清掉仍在 inbox 里排队的、本插件 worker 的结算通知（它们本来就不该让 master 读到）
      ① 丢掉「本插件 worker 的结算通知」（subagent-settled，senderSessionId 是我们派出去的 claim）
         —— 通知只带 worker 的收尾原话，结果走树
      ② 去掉我们自己的唤醒消息后，批次里还有别的东西吗？
          ├── 有（用户消息 / 其他插件的注入 / 引导层快照） → 原样放行，丢弃唤醒消息
          │      —— 唤醒本身无内容，已有别的消息在撑起这一轮
          └── 没有 → 这是「只有本插件自己的信号」或「空批次」两种情况之一，都不拒绝：
                ├── 引擎还有需要 master 处理的状态 → 保留唤醒消息（空批次不产生模型调用，
                │      唤醒就是撑起这一轮的那条消息；内容由引导层提供）
                ├── inbox 里还排着一条非信号消息（用户消息 / 别的插件的注入）
                │      → 把它取出来放进**本步**（见下：搁置它就会一直搁置）
                └── 都没有 → 批次清空
                      → turn 以 completed 结束，零 LLM 调用；被丢掉的通知也不入库
```

**它成立的两个依据**（已核实）：

1. 空批次在 `step()` 之前就判定 turn 结束，**从不进入 `step()`**，因此不发生模型调用
2. pre-step 从 inbox 摘出的消息**只在 `enter` 分支才被写进会话**；批次清空时那些消息既离开 inbox 也从未入库 —— 净效果与"什么都没发生"一致，等价于原设计的 `WAKE_ONLY` 空唤醒

> 实测依据：结算通知的 source 是 `{ kind: "subagent-settled", form: "notice", summary, senderSessionId }`，普通用户消息是 `{ kind: "user" }` —— **两类可判别**，过滤是确定的而非启发式。

**为什么这里一次都不能 `reject`**（原先的实现用 reject，两个后果都在真实会话里发生过）：

- **pre-step waterfall 会在空批次上跑**：`step === 0 && messages.length === 0` 的判定在**钩子之后**，而第一步之后的每个步边界，loop 都会用「`next-step` 全量 + `next-turn` 第一条」发起一次 pre-step —— 模型刚调完工具时这次认领通常是空的。旧实现把它当"没有可处理的状态"reject 掉，于是 **turn 在第一次工具调用后立即结束**：模型看不到自己那次调用的结果，会话表现为"一调工具就断"。
- **reject 会搁置队列**：`agent-loop` 的 `turn()` 在 reject 分支直接 `return false`，**跳过 `if (!inbox.hasPending) return false`**，driver 就此停下；而一次认领只取 `next-turn` 的一条，所以排在后面（例如用户刚发的消息）的那条要等到**下一次无关的唤醒**才会被认领（harness 自己的文档也写明 "A rejected step leaves steering parked in the inbox until the next wake"）。这正是"用户消息石沉大海、越打字越乱"的成因：每次新消息只消耗掉队首的一条通知。

因此本步的代偿是：**把队首那条非信号消息取出来、放进本步**（`inbox.remove` + 放进 `decision.messages`，等价于 loop 自己的一次认领；不 remove 会二次投递）。空闲时还排着的那 20 条结算通知，则由 ⓪ 直接清掉，不再逐个变成一轮。

**过滤必须作用在 `decision.messages` 上，不能重建**：
loop 的默认 decision 是 `[...claimed, runtimeContext]`，其中 `runtimeContext` 是**承载全部 `systemPrompt.context()` 贡献**的那一条 user 消息（`source.form = 'snapshot'`）——
入参 `messages` 里没有它。用入参重建 `decision.messages` 会把引导层（以及其他插件的运行时上下文）整条丢掉，而快照只在"被写进会话"后才会推进水位，于是丢一次就是永久丢。

**剩下的约束**：

- **放行时不能把批次改写成空数组**（batch 里还有用户能看的内容时）：agent loop 对 `step === 0 && messages.length === 0` 的处理是「turn 以 `completed` 结束，不花模型调用」——这正是我们要的"零调用收尾"，但用在有内容的批次上就等于把用户消息吃掉
- 系统提示词在 pre-step **之前**已组装完成，此处改不了本步的 system prompt

**分层归属不变**：pre-step 钩子**只调服务、拿一个布尔**，引擎逻辑仍在宿主层（见 §8.1）。唯一例外是会话续命的唤醒投递，原因见 §8.1 的修订说明。

### 4.3 一轮循环

```
loop:
  ready = dispatchable()                   // ready + interrupted
  if ready is empty: return                // 退出，等下一次触发
  dispatched = {}                          // 本批次已派集合（内存）
  for node in ready (至多 N 个并发):
      if node.id in dispatched: continue   // 批次内去重
      dispatched.add(node.id)
      spawn_worker(node)                   // 唯一的 spawn
      bind(node, child_session_id)         // spawn 返回后记绑定（置 running）
  return                                   // 不轮询、不自旋
```

**先 spawn 再 bind**：spawn 是异步的，返回后才知道子 agent 的 session id。若 spawn 失败或返回前引擎崩溃，节点仍是 `ready`，下次扫描会重新派 —— 这是期望行为（宁可重派一次，也不要节点卡在无人持有的 `running`）。

**引擎从不等待。** 它派完一批就结束这一轮，由 worker 的结算或下一次触发把它叫回来。

### 4.4 重复触发是安全的

同一节点被重复派活只会由批次去重（§3.1）挡住；引擎可以安全地被多个触发源同时唤醒。派活没有副作用，重复一次最多是多起一个工作单元，而**结果写入有身份校验**（§3.3）保证不会写错节点。

---

## 五、工作单元的执行契约

### 5.1 节点 prompt 构造器

> **语言与精简口径（2026-09-16 起）**：模型可见文本一律中文（含 `refuse(...)` 的拒绝文案与工具返回；节点状态经 `statusLabel` 统一成"待执行/执行中/等待子工作/已完成/已失败/已中断"；日志保持英文），且**只讲"做什么 / 怎么做"**，不写"为什么" —— 不解释执行者看不到对话、不解释引擎为何重派、不解释配额与隔离的道理。工具名保持英文标识符。适用于四类文本：本节的 worker prompt、§6.0 的静态段、§6.1 的动态状态行、以及 9 个工具的 description 与参数说明。

每个工作单元是一次全新的子 agent 生成。prompt 由**一个按节点状态分叉的构造器**产出（同一段模板，尾段随状态变化）：

```
[工作链]      沿 parent 链 root → 当前节点，每层只给 **title + 少量基本信息**
[当前节点]    本节点的完整内容：id / title / description / context + attempts
              +「执行本工作时写下的分析」一节（有记录时才出现，见 §5.3.2）
[状态尾段]    按 node.status 分叉，见 §5.1.1
```

两条设计约束：

- **节点 id 必须出现在 prompt 里** —— 工作单元只看到注入的 prompt，执行完要靠这个 id 提交结果。
- **工作链只放基本信息，不放各层的 description / context** —— 完整内容属于"当前节点"那一块。这样工作链的规模是"深度 × 一行的开销"，深度上限 8 时大约是 8 行，**结构上就不会膨胀**（因此 §9.2.1 里的 token 预算不是必需的）。

**prompt 里绝对不包含**：

- 子工作进度（"你有 N 个子工作，0/N 完成"）
- 兄弟节点或树的其他部分
- 上一次执行的**对话或过程**（两个例外：执行者自己用 `note_work` 写下的分析，见 §5.3.2 —— 那是判断依据，不是过程；以及**它自己的会话**，见下）

这三条是硬约束。第一条尤其重要：一旦把子工作进度写进工作单元的 prompt，就会诱导它去等待 —— 这是整个设计要避免的核心故障。

> **"会话续命"与第三条的关系（2026-09-20）**：第三条说的是**prompt 里不塞**上一次的过程。会话续命不违反它：
> 被唤醒的执行者拿到的仍然是同一个 `buildWorkerPrompt`（子结果 + 本轮指令），只是这条消息投给它**自己**那个
> 会话，于是那段过程在它的上下文里自然存在，而不是被人为召回。区别在于"过程是否被复制到 prompt"，而不是
> "过程是否存在" —— 后者是会话自身的属性。见 §9.3。

### 5.1.1 状态尾段（对应原设计的 TempLayer）

尾段按**节点当前状态**分叉，每次派活现取现构造：

| 节点状态 | 尾段内容 |
|---|---|
| `ready`（无子工作，首次执行）| 执行职责：尝试完成工作；若缺前提则**先 `note_work` 写下这次分析，再** `decompose_work` 拆解。两种合法结局见 §5.2 |
| `ready`（**子工作全终态**，即待汇总）| 各子工作提交的结果 + 一句提示：**"所有子工作都完成，先读「执行本工作时写下的分析」，再分析工作是否已经完成；还缺则先 `note_work` 再继续拆分，否则总结工作提交给父工作"** |
**没有 `failed` 尾段**：失败节点是终态、`DISPATCHABLE` 不含 `failed`，所以它永远不会被派活 —— 失败由指导层 + 唤醒上报给 master（§7.0），而不是靠一段 prompt。

**这就是原设计里 TempLayer 的作用**（`Message(Role.SYSTEM, ...)` 那类一次性注入），但在本插件里有两点更好：

1. **它不进任何会话历史** —— 它是 prompt 构造器的输出，只存在于这一次派活的输入里
2. **它天然不会重复** —— 每个工作单元都是新 spawn 的新会话，所以不存在"上一次的临时提示还留在上下文里"的问题，**连清理动作都不需要**（原设计的 `TempLayer.consume()` 消失了）

**汇总不是独立角色**：它就是"节点处于 `ready` 且子工作全终态"时的那次派活，用的是同一个构造器、同一类执行者。所以文档里不存在"汇总者"这个实体。

### 5.2 执行者的两种合法结局

```
工作单元拿到节点
  ├── 先尝试执行
  │     ├── 做成了            → submit_work(节点, 结果)          → 结束
  │     └── 撞上前提缺失      → note_work(节点, 这次为什么拆)
  │                            → decompose_work(节点, [子工作…])  → 结束
  └── 从不等待、从不持有
```

**先尝试、撞墙才拆** 是有意的顺序：对本来就是叶子的工作，先分析一遍是纯开销；拆解只在有真实失败输入时才发生。`note_work` 与 `decompose_work` 是**同一次派活里的两步**，不是两个结局 —— 见 §5.3.2。

### 5.2.1 两个终态工具互斥（机制级，不靠提示词）

两个工具互斥的判据是**子工作是否还有未终态的**，不是"有没有子工作"。放进工具实现里就自动成立 —— 工具执行时能拿到调用方的 agent（`exec.agent`，含 session id），校验与写入都在树锁内：

```
submit_work(node, 调用方):
  持树锁:
    校验调用方 == node.claimed_by
    校验 status 非终态 且 没有未终态子节点     ← 「有待办子工作」才拒绝
    落盘超长结果（有后端则存全文 + 记住取回指引）
    置 done + result
    成功时 concludeTurn()                      ← 终止该 worker 的当前 turn

decompose_work(node, children[], 调用方):
  持树锁:
    校验调用方 == node.claimed_by
    校验 status 非终态 且 没有未终态子节点     ← 首次拆解与「汇总后仍缺前提」都合法
    校验 analysis_attempt == attempts          ← 这次派活必须自己写过分析（§5.3.2）
    建子节点（含去重）→ 按子节点终态情况置 ready / blocked
```

**为什么判据必须是"未终态"而不是"为空"**：子工作全终态的那次派活就是**汇总**（§5.1.1），它的两种合法结局正是"提交结论"与"继续拆解"。若把"有子节点"一律拒绝，任何拆解过的节点都会两条出口全封死 —— 只能靠 attempts 耗尽变成 `failed`，树永远收敛不到 `done`。

两个方向仍然都被堵住：

| 情况 | 结果 |
|---|---|
| 先 `submit_work` → 再 `decompose_work` | 节点已 `done` → **拒绝**（终态不可拆解）|
| 先 `decompose_work` → 再 `submit_work` | 未完成的子工作还在 → **拒绝**（有待办子工作不可提交）|
| 汇总态先 `decompose_work` → 再 `submit_work` | 新子工作未终态 → **拒绝**（同上）|
| 没 `note_work` 就 `decompose_work` | `analysis_attempt != attempts` → **拒绝**（`analysis-missing`，零副作用）|

**同一批次并行调用也安全**：两个工具的实现都持同一把树锁，谁先执行谁生效，另一个看到已变的 `node.status` 自然被拒 —— 不需要"同一批次只能调一个"的额外检查。

**提示词只作为引导**（§5.1.1 的尾段说明两种结局二选一），正确性由上面的状态机保证。

### 5.3 拆解时写入的内容

`decompose_work(node, children[])` 中每个子工作至少包含：

| 字段 | 要求 |
|---|---|
| `title` | 一句话，陈述要做的事 |
| `description` | 具体到可执行 |
| `context` | **拆解原因** —— 为什么当前工作需要它。这是子节点继承"纵向为什么"的唯一途径 |

`context` 不能省。子节点看不到兄弟、看不到整棵树，它理解自己存在意义的唯一来源就是这条链条。

**根节点的 `description` / `context` 由 `create_work` 的 `analysis` 写入**（§7.2）—— master 的初步分析就是这么传下去的。

**数量与深度校验**（§9.2）：一次至多 **6 个**子工作；树的深度上限 **8**。校验在 `decompose_work` 的入参处理处完成，超限即拒绝该次调用（不改节点状态）。

### 5.3.2 拆解分析：`note_work` 与 `decompose_work` 的门禁

**问题**：一次派活就是一个新会话，做完就消失；而"这次为什么还缺、拆出去的子工作要拿回什么"只存在于那个执行者脑子里。汇总轮是**又一次全新派活**，它读的是节点 prompt —— 如果节点上没有留话，它就只看得到子工作的结果，看不到上一轮判断这些结果的依据。

**做法**：执行者用 `note_work(node_id, analysis)` 把这次派活自己的判断写进节点：

> **要写什么（2026-09-20 补充）**：缺什么前提、**已经排除了哪条路以及为什么**、前置工作完成后要判断什么。
> 补「排除」这一条的理由是**渐进逼近靠排除**：下一次执行这个节点的会话是全新的（§5.1），它只能从这份记录
> 与子工作结果重建判断；若只写"缺什么"，被否掉的路会随会话一起消失，下一轮可能重走一遍。这句话出现在
> **三处模型可见文案**里（执行者 prompt 的拆解路径与汇总路径、`note_work` 的工具描述），必须一致 ——
> 它不依赖「会话续命」提案能否落地，独立成立。

```
note_work(node, 调用方, analysis):
  持树锁:
    校验调用方 == node.claimed_by             ← not-owner
    校验 status 非终态                        ← terminal
    按非空行切分、trim；全空则拒绝            ← no-analysis
    追加进 node.analysis_notes（精确去重，不覆盖）
    node.analysis_attempt = node.attempts     ← 归属到本次派活
```

三件事由这一个字段决定：

| 机制 | 规则 |
|---|---|
| **门禁** | `decompose_work` 校验 `analysis_attempt == attempts`，不等就 `analysis-missing` 拒绝，**且在任何副作用之前**（不建子节点、不消耗 attempt、不释放持有）。所以"先拆、后补分析"不可能发生 |
| **归属** | 检查的是**本次派活**写的分析，不是"节点上有没有分析"。汇总轮继承了上一轮的备注也不算数 —— 它必须自己说清这一轮为什么还缺 |
| **可见性** | 分析渲染成「本工作」块内单独一节，**在子工作结果之前**（§5.1）。它是读那些结果的前提，所以顺序是语义要求，不是排版偏好；没有记录时整节不出现 |

**为什么分析不写进 `context`**：`context` 是拆解者写给**子节点**的"纵向为什么"，作者是父节点；`analysis_notes` 是执行者写给**本节点后续派活**的判断，作者是本节的执行者。作者与读者都不同，混在一起会让"这个子工作为什么存在"和"上一轮判断缺什么"互相污染。

**为什么不直接放开、让模型自觉写**：`note_work` 与 `decompose_work` 是**同一次派活里要求的两步**，靠提示词纪律只能得到"大多数时候写了"。做成门禁后，"拆解必须有理由，且理由必须是这一轮的"变成机制：模型忘了写，`decompose_work` 会带着 `analysis-missing` 和下一步怎么做一起拒回来，它当场补一次 `note_work` 即可继续。

**模型面工具数 9 → 10**：`note_work` 属于 **executor 面孔**（owner 看不到，worker 看得到）—— owner 不持有任何节点，调用只会被 `not-owner` 拒。见 §5.5。

### 5.3.1 超长结果的落盘（沿用原设计的做法）

结果超过阈值（原设计是 **2000 字**）时，不把全文塞进节点：

```
submit_result(node, result):
  if len(result) > 2000:
      ref = spillStore.saveText(result, 归属)      // 完整结果落盘，取得定位信息
      摘要进 node.result
      node.result 里指明"完整结果在 <定位信息>"
  else:
      node.result = result
  node.has_result = true
```

在 DSH 上落盘走 `ctx.spillStore.saveText()`（后端 `dsh-spill-local`），取回指引随摘要一起给 —— **不需要自建目录**。
`SpillRef` 带 `locator` 与 `retrievalHint` 两项，**两项都要留在节点上**（`result_ref` / `result_hint`）：只存定位符等于给了一个读不懂的指针，而它要跨重启存活。
没有挂载 spill 后端时**不落盘**，整条结果内联进节点 —— 给一个谁都解不开的定位符，比节点大一点更糟。

**阈值与摘要是本插件自己的策略**，不接 `dsh-spill-policy` 的全局按字节策略：后者作用于所有工具结果，而"什么时候摘要、摘要怎么写"是我们对工作结果的语义判断。`spillStore` 只当作存储后端用。

### 5.4 出口与结果通道

工作单元通过停止产生工具调用来结束（DSH 的常规 agent 回合语义，无需特殊处理）。

**结果只走树，不走消息。** 派活时用工具限制摘掉 worker 不该有的能力：

```yaml
toolFilter:
  deny:
    - send_message          # 摘掉消息回传
    - subagent              # 摘掉委派 —— 工作推进只能由工作引擎进行
    - subagent_fork
    - create_goal           # 摘掉目标工具 —— goal 属于 master 的意图层
    - get_goal
    - update_goal
```

### 5.4.1 为什么每一类都要摘

| 摘掉的 | 不摘的后果 |
|---|---|
| `send_message` | 结果会同时存在于树和消息里，且 prompt 里那段"完成后把结果发给父 agent"的引导被追加，与"结果只走树"冲突 |
| `subagent` / `subagent_fork` | worker 可以自己 spawn 一个**不在树上**的执行者：引擎不知道它、结果不回填节点、失败无人回收，且递归绕过所有配额（§9.2 的节点上限按树节点计数）|
| `create_goal` / `get_goal` / `update_goal` | goal 是 master 的意图层，worker 没有业务；而且 goal 的写操作本就要求 `requireDirectHuman`，worker 调用只会浪费一个回合。**注意**：摘工具摘不掉那段指引文本，见 §5.4.2 |
| 六个 owner 工具（`create_work` / `adjust_work` / `work_result` / `list_works` / `finish_work` / `cancel_work`） | 执行者用不上它们（调用只会被 `no-authority` / `not-owner` 拒），而读到全树会让它看见兄弟节点进度 —— 与 §5.1 刻意不给 worker 兄弟进度的意图冲突（见 §5.5）|

**`note_work` 不在摘除之列**：记录本轮自己的分析正是执行者的本职，而且 `decompose_work` 会拒绝一个没写过分析的拆解（§5.3.2）。它属于 executor 面孔。

**已知缺口：`workflow` / `ralph` 没有被摘。** 上面第二行的理由（"worker 不能自己 spawn 一个不在树上的执行者"）对这两个工具同样成立 —— `workflow` 的 `agent()` 与 `ralph` 的每一轮都会起子 agent，它们不在树上、结果不回填节点、失败无人回收，递归也绕开节点配额。当前 deny 列表只有 `send_message` / `subagent` / `subagent_fork` / 三个 goal 工具，所以**隔离只覆盖了主要几条路，不是密不透风**。要不要一并摘掉是个取舍：摘了隔离严密，代价是节点内部无法再自行扇出（见下）。

> **决定（2026-09-20）：不摘，保持现状。** 口径是「worker 怎么做子任务是 worker 的事，引擎只关心工作结果」。
> 引擎对 worker 的契约只有一条 —— 最终凭 `submit_work` 把结果交回它持有的那个节点；节点内部用什么手段
> 扇出（串行、`decompose_work`、还是 `workflow` / `ralph`）属于执行者的自由。代价如实记录：worker 自发的
> 子 agent 不在树上、不占并发配额、失败不由引擎回收，所以「引擎是唯一派活者」这条不变量**只在树这一层成立**，
> 不延伸到 worker 内部的自发扇出。**补充（2026-09-20）**：这条决定的"记账入口"已经落地 —— §9.2 的单树节点
> 上限（`CAPACITY.maxNodesPerTree = 200`）现在是硬约束，`decompose` 超限即拒。它不能把 `workflow` / `ralph`
> 起的子 agent 拉回树上（引擎根本看不见它们），但保证**树这一层**的节点数有天花板，而不是只靠"深度 8"这个
> 要到第八层才生效的限制。若将来要把内部扇出也计入，先让执行者把扇出规模报给节点（改动在工具面，不在 deny）。

**它挡住的是什么（若摘掉 workflow/ralph 会失去的能力）**：

| 情形 | 现在能用 `workflow` / `ralph` 做的 | 摘掉后只能 |
|---|---|---|
| 节点内部要处理 N 个同构条目（如"审 12 个模块的导出面"） | `pipeline(items, …)` 并发跑完并汇总 | 自己在单会话里串行做完（慢、上下文膨胀），或用 `decompose_work` 拆成子节点 —— 但**每次至多 6 个**且**有未完成子工作时不能再拆**，于是要分轮：先拆 6 个、等它们终态、汇总轮再拆下一批，中间多烧一次 attempt |
| 需要结构化、被 schema 校验的中间结果 | `agent(prompt, { schema })` 拿到校验过的对象再汇总 | 树的结果通道只有 `submit_work(node_id, result: string)` 一个**字符串**，只能自己拼 JSON、无校验 |
| 需要互不影响的独立视角（"三种意见再裁决"） | `parallel([…])` 起三个彼此看不见的 agent | 自己在一个上下文里问三遍（不独立、互相污染），或拆子节点（prompt 由引擎生成，不能像 workflow 那样精确编排每条的 prompt/schema） |
| 反复迭代到判据满足、且每轮要干净上下文 | `ralph` 的新鲜 agent 轮次 | 引擎式的重派是**引擎在失败/卡死时**给的（失败预算 5，成功的汇总轮不消耗），不是 worker 能主动要的循环 |

**`send_message` 的摘除有一个额外效果**：那段"完成后用 `send_message` 把结果发给父 agent"的引导是**条件追加**的 —— 子 agent 作用域里存在该工具才附加，否则 prompt 原样。所以摘掉它，**冲突文本根本不会被生成**，比让模型在两段矛盾指令间做选择可靠得多。工具名是包内硬编码常量（非配置项），deny 列表里写字符串即可。

**工具限制的契约**（`SubagentStartRequest.toolFilter`）：in-process 后端把它作为子 agent 创建窗口内的 scoped `tools.restrict()` 应用，**被点名的工具从子 agent 的 prompt 里消失，并且拒绝执行**（一处可见性），未知名字会明确报错。

### 5.5 两张工具面孔

工具族按调用方分两半，注册是一次、可见性是两套：

| 面孔 | 判据（与 `create_work` 的授权判据同源） | 看得见 | 看不见 |
|---|---|---|---|
| **owner** | 非子代理会话 | `create_work`、`adjust_work`、`work_result`、`list_works`、`finish_work`、`cancel_work` | `note_work`、`decompose_work`、`submit_work` |
| **executor** | 子代理会话 | `note_work`、`decompose_work`、`submit_work` | 上面那六个 + `send_message`/`subagent`/`subagent_fork`/三个 goal 工具 |

**为什么要有这张表**：不做的话每个 agent 的 schema 里都带着另一半用不了的工具 —— 更糟的是"可见但必然被拒"：`create_work` 对执行者是 `no-authority`，`note_work` / `decompose_work` / `submit_work` 对 owner 是 `not-owner`。另外，worker 能读到别的节点（`list_works` / `work_result`）与 §5.1 "worker 的 prompt 不含兄弟节点进度"的意图相矛盾 —— 一个能看到兄弟进度的执行者，可能会去等它们。

**两个机制，因为两种 agent 出现在不同时刻**：

- **executor** 由本插件创建，面孔随派活请求走（`SubagentStartRequest.toolFilter.deny`），也就是 harness 给任何被委派子会话施加的那个 scoped `tools.restrict()`；
- **owner** 在插件派活任何东西**之前**就存在，所以面孔在 agent 出现时施加（`agent/created` → `agent.ctx.tools.restrict()`），并以组装瀑布（`system-prompt/assemble` 里按 `context.agent` 过滤 `assembly.tools`）兜底 —— 这一半是无状态的，覆盖"插件挂载前就已经存在的 agent"。

注意 `tools.restrict()` **要求 scoped context**：在全局 ctx 上调用会直接抛错（harness 明确拒绝"全局限制"这种做法），这与上表里"按面孔区分"是同一件事的两种说法。disposer 按 agent id 保存、`agent/disposed` 释放、插件卸载时一并释放；名字先用 `tools.get(name, agent)` 预过滤（`restrict()` 遇到未知名字会抛，一次抛出就是 owner 的一整轮代价）。

**遮蔽不是授权。** 这两半只管"模型看不看得见"；真正的边界仍是工具体内的拒绝（`no-authority` / `not-owner`），所以即使某张面孔写错、模型幻觉出名字，调用照样被拒。`test/faces.spec.ts` 有一条不变量测试：**每个注册的工具必须恰好落在一张面孔里** —— 新增工具不归类就会失败。`note_work` 只被放进 owner 的 deny 列表，不进 worker 的：owner 拿一个必然被拒的工具是噪音，worker 缺了它则拆解根本无法通过门禁（§5.3.2）。

**owner 也看不见工作内部（2026-09-20）。** 面孔的另一半同样收紧了：`show_work`（逐个节点列出整棵树，带 `depth` / `parent_id` / `attempts` / `result_ref`）已删除；`list_works` 与每轮的进度行（`buildProgressLine`）都只报"还在跑 / 反复出过问题"，不再报逐状态计数。判据是**这条信息能不能支撑 owner 的动作**：owner 只有 `adjust_work`（只对根有效）与 `cancel_work`（只吃根 id），没有任何对节点动手的工具，所以节点级的结构、派发次数、剩余失败预算都是"看得见却动不了"的信息 —— 引擎的重试策略不属于 owner（§6.0 已按同一理由不写进静态段）。**"出过问题"是例外，也是唯一例外**：它是 owner 唯一能据此做决定的引擎事实（改方向，或者放弃），判据是引擎的 `isTroubledNode`（`core/src/prompt.ts`）—— `stalls >= maxStallsBeforeReport`、`failures >= maxAttempts - 1`、`spawnFailures >= maxAttempts - 1` 三者之一，`isTroubled` 就是它加上"还没结束"这个过滤。**这一个判据现在真的被三个渠道共用**：`list_works` 的标记、静默回收的 heads-up（`reportStall`）、以及**起不来执行者的 heads-up**（宿主在派发失败处投递，同一个门槛、同一个"只报一次"的持久标记）。三处此前并不一致：`isTroubled` 算 `spawnFailures` 而 `reportStall` 的门槛不算，于是一个连续起不来执行者的工作会在 `list_works` 里读作"反复出过问题"，却永远收不到一条消息 —— 起不来的节点从不是 `running`，而静默扫描只看 `running`。`/work` 命令与"工作"面板仍按节点渲染 —— 那是给人看的诊断面，不是模型面。

**2026-09-23 修订：一次独立核对修掉的四处。** 一件真实工作（"工具面完整性核对：参数 × 校验 × 拒绝码"，拆成 4 个前置工作、汇总交出报告）把四个读写边界上的不一致挖了出来，都改了：① `no-caller` 并入 `RefusalCode` —— 九个工具都会产生它而码表里没有，按 union 穷举的消费者会静默漏掉；② 纯空白文本不再能落库 —— `submit_work` 的结果、`adjust_work` 的纠偏、`create_work` 的标题与内容都补上 `blank-text` 拒绝，且**分层不变**：工具层只拒真正的空串，空白由引擎判（与 `note_work` 的 `no-analysis` 同源，否则这些码就没有可达的产生点）；③ 三个 owner 工具对同一个子工作 id 统一回 `not-root`，`finish_work` / `cancel_work` 原先按 ROOT 查表，把"这不是根工作"说成"工作不存在"；④ `isTroubledNode` 抽成唯一判据，并给"连续起不来执行者"补上 owner 提醒（见上）。

**2026-09-21 修订：`stuck` 曾把"历史"说成"现值"。** 首版 `isStuck` 用 `stalls > 0 || failures > 0 || spawnFailures > 0`，而 `stalls` / `failures` **只增不减**（`tree.ts` 无复位路径；只有 `spawnFailures` 会在启动成功时清零）—— 于是一个 worker 掉线被回收、重派后跑得好好的工作，此后余生每轮进度行与每次 `list_works` 都读作"卡住了"，直到整棵树终结。`list_works` 是**当下的读**，这是假陈述；而 owner 的两个动作都有破坏性（`adjust_work` 会作废未完成子工作并整体重规划，`cancel_work` 直接停掉），一个永不复位的旗标会引诱它对健康工作下手。修法两条一起上：①**判据抬到引擎自己的门槛**（见上），一次打嗝不再算数；②**措辞改成历史**（"反复出过问题"），标识符随之改名 `stuck` → `troubled`，让代码也不再声称现值。真正的"现在卡着"是另一个信号（被回收且尚未重派），本项目仍**不做**实时判读 —— 那需要时钟，而引擎的 heads-up 已经在承担这件事。

### 5.4.2 goal 的提示词段：无法从第三方插件干净遮蔽（已知限制）

`dsh-tool-goal` 除了三个工具，还注册了一个**静态**的提示词段 `tool:goal`（`text: guidance(...)`，不含作用域判断）。子 agent 会 join 父级 preset 组装，因此**这段文本会进入 worker 的 prompt** —— 即使工具已经被摘掉，worker 仍会读到"你有目标工具"的说明。

**实施时的结论：不遮蔽，如实记录这个限制。** 原因是遮蔽不是干净做法：

- 同名段落会**连 owner 一起**替换掉，而 goal 包**不导出**它的 guidance 文本，所以 owner 会失去部署的策略措辞（包括部署配置的 `blockedAfterConsecutiveRounds`）；
- 没有"只对 worker 生效"的注册点：worker 的 scope 由子 agent 组合流程创建，第三方插件没有挂载钩子。

后果有界且可恢复，因此接受而不是绕：

| 后果 | 为什么可接受 |
|---|---|
| worker 读到不适用的一段指引 | 浪费一个回合；模型可能试着调 goal 工具 |
| 调用被拒 | `tools.restrict()` 让该名字在 worker scope 内不存在，调用以 `UNKNOWN_TOOL` 失败 |
| 即使能调也无意义 | goal 的写操作要求 `requireDirectHuman`，worker 本就被拒绝 |

**正确修法在上游**：把那段 `text` 改成 `(context) =>` provider，在工具不可见的作用域返回空串 —— 这正是 `dsh-plan-mode` 的 `plan:policy` 已经在用的写法。

### 5.4.3 结果通道的两层防御

| 层次 | 手段 | 性质 |
|---|---|---|
| 第一层 | `toolFilter` 摘掉 `send_message` | **机制级**：工具不存在、也拒绝执行 |
| 第二层 | master pre-step 丢弃子代理来源的消息 | **兜底**：`subagent-settled` 结算通知由 runtime 发出，不受工具限制影响，仍需 pre-step 决定 enter / discard |

**注意**：worker 的父 agent 就是 master（见 §八），所以结算通知进入的是**用户会话** —— 正因如此，第二层的 pre-step 过滤是必需的，而不是可选的。

---

## 六、指导层

### 6.0 静态段：路由策略（何时建树）

**加这一段的原因**：§7.1 的判据此前只写在 `create_work` 的工具描述里 —— 工具描述用来讲机制，策略却要靠模型自己从工具清单里读出来。策略属于系统提示词。

| | 内容 |
|---|---|
| 注册 | `ctx.systemPrompt.section({ name: 'avantf:work-tree-guide', order: getSectionOrder('TOOL_WORKS') })` |
| 可见性 | 与 `create_work` 的授权判据**同一个函数**（`host.canCreateTree` = 非子代理会话）。worker 拿不到 `create_work`，所以 provider 对它返回空串，组装器丢弃空段 —— 不教一个调用者没有的工具 |
| 静态而非每轮 | 它讲的是"这件事该不该变成树"和"执行者看不到这段对话"，两件事在任何树存在**之前**就成立；树一旦存在，由 §6.1 起的动态层接管 |
| 位次 | 放在 `TOOL_WORKS`（工具指导区），因为它就是"一个工具族怎么用"；不占用 persona 位 |

**文本里刻意不出现**（知道也没用，或不该知道）：

| 不写 | 理由 |
|---|---|
| 节点状态词表（`ready` / `blocked` / `attempts`）、回收与扫描 | owner 从不依据节点状态行动，重试策略是引擎的事 |
| `decompose_work` 与 worker 的指令 | owner 调不了它（节点由持有它的执行者拆解），教了等于教一个不存在的工具 |
| id、存储、Remote 面、工作面板 | 模型无法据此行动 |
| 读结论 / 收尾机制（`work_result` / `finish_work`） | 动态层在唯一有意义的时刻（树存在时）才说；静态段说了就是重复占预算 |

**它会点名兄弟委派工具**（`subagent` / `subagent_fork` / `workflow`），这与上面"不写"的原则不冲突 —— 树与"起一个子 agent 去干活"在**"交出去、别人做"**这一点上重叠，而决定用哪个的差别恰好是"执行者是一次性的、跑起来就联系不上、看不到这段对话"。不写这句，owner 面对重叠只能自己猜；写了，它是一个可执行的选择。同一个边界也写在 `create_work` 的工具描述里（决策发生的地方）。

测试（`test/guidance.spec.ts`）既断言它说了什么（工作的定义与建法、谁在等、**与普通委派的边界**、工作/工作树的用语），也断言它**没说什么**（一张禁用词表），worker 视角为空串。

**正文是用户可编辑的**：正文放在**家族共享**的 `<data home>/prompts/work-tree-guide.md`（`data home` = 插件配置 `dataHome` → `$AVANTF_HOME` → `~/.avantf`；同目录下记忆插件用 `mem-*` 前缀，各插件只动自己前缀的文件）。插件在 `apply` 里**只读一次**（改完重启 `dsh` 生效）：缺失或空白会被原子写入上文的常量作为默认，有内容则**逐字注入**（去首尾空白、剥 BOM、CRLF→LF）；文件不可读写只告警并退回默认，**绝不阻断挂载**。**文件只提供正文**——段名与位次由 `index.ts`（`getSectionOrder('TOOL_WORKS')`）决定，`PROMPT_FILES` 只管"哪个文件对应哪段"，清单外的 `.md` 被忽略且不报错。因此 `guidance.spec.ts` / `wording.spec.ts` 的硬守卫（禁用词表、只说自己插件的工具、worker 视角为空串）**只守内置默认**；用户文本另由 `guidanceTextWarnings` 做一次软检查并 warn（超预算、命中「工作树/子树/节点/树」这类形状词），不截断、不拒绝。ensure/read/fallback 这套流程由底座的通用件 `PromptFiles` 提供（`base/plugin-base/src/kit/prompt_files.ts`），插件在运行时从**加载到的底座**上取（`kit?.PromptFiles`），底座缺席时退回内置正文。放在底座而非 `work-core`，因为引擎刻意不带 Node 类型。

### 6.1 目标与约束

让 master 在与用户的对话中**时刻能看到工作状态**，从而"视情况"总结。机制用提示词注册表的运行时上下文；本插件负责的是**文本怎么写**。

DSH 的运行时上下文快照是**持久**的（内容变化时追加一条，旧值留在历史里直到被压缩遮蔽）。因此文本组织不是风格问题，而是**正确性约束**：

> 每一段写进指导层的文本，都必须能经受"被当成过期信息读到"。

### 6.2 锚定分段 —— 增量/差分的写法

三类内容分开，每类自带锚点，锚点保证过期后仍然成立：

| 段 | 写法 | 为什么过期仍安全 |
|---|---|---|
| **聚合进度** | `本树：3 进行中 / 1 待汇总 / 根未收敛` | 陈述**过去某一刻**的状态，不声称是"现在"；且它语义上会被后一条取代 |
| **增量变化** | `自上次汇报，节点 a3f 已完成；节点 b71 被回收` | 显式锚在"自上次汇报"，**过期后是一句历史陈述，不是错的事实** |
| **动作指引** | `需要完整结论时读取 work_result(node_id)` | **条件式指令**，与时间无关，过期永远成立 |

反例（**不要写**）：

| 反例 | 问题 |
|---|---|
| `当前有 3 个工作进行中` | 用"当前"锚在现在，过期即假 |
| `待办从 3 变成 2` | 差分但无锚点，过期后不知何时的事 |
| `下一步应该做 X` | 用"下一步"锚在未来，过期后是错误指引 |
| `耗时 3 分钟` | 时钟量，每次组装都不同 → 去重失效 |

### 6.3 两条实施纪律

1. **状态没变就返回完全相同的字符串** —— 框架按文本去重，相同文本不产生新事件。任何会抖动的字段（时间戳、耗时、计数器按秒变化）都会让去重失效并持续追加快照。
2. **只给索引，不内联结论** —— 节点结论通过工具按需拉取，不要塞进指导层。

### 6.4 两条上下文的优先级

待办的优先级高于工作树，用两个不同的渲染位次表达（待办在前）：

```
待办（优先级高）：order 较小
工作树状态      ：order 较大
```

"待办优先"是提示词里的语义约束，在文本里写明；机制上只体现为渲染先后。

### 6.5 补充：引擎向 master 的唤醒只发信号

根工作进入终态时引擎唤醒 master，**唤醒消息只带信号，不带内容** —— 内容由指导层提供（它每次组装都读当下状态）。避免同一条信息在"引擎的消息"和"指导层"两处各存一份、可能不一致。

唤醒走 §4.2 的 pre-step 通道：消息只负责让 pre-step 有机会跑起来，是否真的进入 LLM 回合由引擎的状态判断决定。

---

## 六点五、worker 会话日志的归档与清理

worker 是真实会话，所以磁盘占用随派活次数线性增长（本机实测每会话约 40 KB）。两条命令，**两种不同的接口可行性**：

| 命令 | 走什么 | 可行性 |
|---|---|---|
| `/archive` | `workspaceRegistry.archiveSession(id)` | **官方接口**：durable 写进 registry 的归档集合，可 unarchive。只改标记，**不释放磁盘** |
| `/clean all\| <id>` | 直接删会话目录 | **没有任何官方接口**：`SessionPersistence` 只有 `create`/`open`/`list`/`stat`，没有 delete；GUI 只有归档。所以只能由插件删目录 |

护栏（`src/workerSessions.ts`，见该模块注释）：

1. **只认自己的 worker**：claim id 形状 `work-<8 hex>`（`reserveClaimId`）+ 头里 `origin: subagent` / `delegationDepth: 1` / `parentSession` == 本会话。harness 自己的委派用 uuid，天然区分；
2. **绝不动在跑的会话**（`live` 为真或 `agents.get(id)` 有答案就跳）；
3. **`/clean all` 只删已归档的**：这样"丢弃"总是一个有人明确做过的决定；要跳过这道闸必须显式点名一个 id；
4. **路径只按名字找、不做编码复刻**：在 `config.sessionsRoot`（默认 `<dsh home>/sessions`）下扫 `*/<id>`，目录名必须**正好**是 session id。harness 的目录名有 slug 编码规则（`projectKey`/`encodeSegment`），复刻它就会在下一次编码变更时静默失效 —— 因此根给错或布局变了时的结果是"删不到"，而不是"删错"。

**为什么不把删除做进引擎的常规回收**：删的是**另一个子系统的持久数据**（会话存储），不是本插件的树记录。引擎的日常职责只到"节点解绑、活 Agent 由 harness 在结算时销毁"；删日志必须是一个人类明确的手势，所以它是一条 slash，而不是自动清理。

## 六点六、纠偏：把"停下再重派"换成一条消息

工作派出去之后 master 会停下来；用户再开会话讨论时才发现方向要改。没有通道时只有一条路：`cancel_work` 结束、再 `create_work` 重来 —— 已做完的部分全部作废。两条新工具把这件事变成"发一条消息"：

| 步骤 | 谁做 | 语义 |
|---|---|---|
| `adjust_work(root_id, adjustment)` | owner | **只对根工作**：纠偏写进该节点的 `corrections`（持久，之后每次派发都渲染），若此刻有执行者在跑就 `subagents.sendMessage` 直接投递给它 |
| 作废未完成的下级（含其下级） | **引擎** | 纠偏落地后自动执行：记为失败 + 锁内收集并打断在跑的执行者 + 重算所有父节点 → 该工作立刻回到汇总轮按新方向重新规划。**已完成的不受影响** |

**为什么作废不给模型一个工具**：`cancel_subworks` 作为模型工具只存在过一个提交，随后按"这不是一个决定、而是方向变了的机械后果"删掉 —— 与删掉 `reclaim_work` 的理由同源（回收/作废都是引擎的日常职责）。给 master 第二个动词只会多出一种半成品状态：纠偏差了、旧方向的活还在烧模型调用。能力本身保留为引擎原语（`WorkTree.cancelSubworks` + 宿主方法），只是模型面看不到它。

**为什么要"同时记录"**：根工作一生中大部分时间在等子工作（`blocked`、没有持有者），而**每次派发都是全新会话**。只投递消息 = 那一刻没人收就永远丢了；只记录 = 已经跑着的这次执行者看不到。两条都做：记录保持久，投递保"这一次就生效"。

**记在哪里：`NodeRecord.corrections`，不是 `context`。** `context` 是拆解者写的"为什么存在这个工作"，纠偏是 owner 对已经派出去的活的指令 —— 作者与生命周期都不同；混在一起时工作链只渲染 `context[0]`，于是纠偏永远排在 index ≥ 1、**对任何后代都不可见**（这正是实现过程中被审查抓到的一条 P1）。现在：纠偏写进独立的 `corrections`，当前节点以独立的"纠偏:"块渲染，而**工作链把每一层的纠偏一并带出**来 —— 链是唯一能到达每一次派发的通道，所以根上写的纠偏会跟着链走到任何后代。

**2026-09-23 修订：纠偏写给了执行者，却没写给查看者。** 上一段的通道只覆盖"执行"这一半：面板的行/详情与 `work_result` 只渲染 `title` / `description` / `result`，而标题是**创建时**的目标 —— 被纠偏过的工作因此读起来是"目标 X、结果 Y"，中间空无一物；纠偏在库里，却没有任何查看面读它（`/work` 的索引行同样没有）。四个面一起补上：快照的行投影（`NodeView`）带 `corrections`，行上渲染"已纠偏 N 次"标签、文本挂 tooltip；`detail`（`NodeDetail`）在"工作内容"与"本工作提交的结果"**之间**给出完整"纠偏"块；`work_result` 把纠偏列在结果之前、`data` 里再带一份；`/work` 的索引行只报次数。**目标本身不改写** —— 纠偏是叠在原始目标旁边的历史；直接改写 `title`/`description` 会把"当初要什么"抹掉，而回溯要的正是两者对照。行投影自此带上了"行只放渲染得到的东西"之外的一个字段，判据是它必须在**折叠状态**下可见、且文本短条数少。守卫：`correction.spec.ts` 的 "a correction is readable back" 三条、`client-view.spec.tsx` 的行标记与详情顺序两条。

**作废为什么不需要持有者**：状态机决定了这一点 —— 一个节点**有未完成子工作时必然是 `blocked`、且没有持有者**（`decompose` 会释放 claim），所以"持有者取消自己的子工作"落不到任何可达状态上。真正会发生作废的时刻，是 master 在后续会话里调整了方向、而根正在等子工作；此时只有 owner 能动手，所以内部原语的授权是"树的所有者，或持有该节点的执行者"（对称），后者不会有未完成子工作可作废。

**边界**（都在机制层拒绝）：只认根工作（给子工作发会被 `not-root` 拒 —— **三个 owner 工具同款**：`adjust_work` / `finish_work` / `cancel_work` 对同一个子工作 id 都给 `not-root`，后两者原先按 ROOT 查表、把"这不是根工作"说成"工作不存在"）；已结束的工作不能调整（`terminal`）；纯空白的纠偏同样被拒（`blank-text`，见 §5.x 的 2026-09-23 修订）；作废只向下走 —— 工作本身、它的父工作、兄弟工作都动不了，要结束整棵树用 `cancel_work`；作废后**重算所有被改动节点的父节点**，否则共享前提的另一个分支会永远卡在 `blocked`（这条是被测试逼出来的第一版 bug）。

**子工作执行者的改正路径**：汇总轮是全新会话，读到背景里的纠偏后**直接重新 `decompose_work`** 即可（此时没有未完成子工作，拆解本来就允许）—— 不需要先"取消"。

## 七、master 侧：建根、收尾与目标的关系

### 7.0 根工作的完成与收尾

```
根节点进入终态（done 或 failed）
  → 节点 result_read_at = null（未读状态）
  → 引擎唤醒 master（走 §4.2 的 pre-step 通道，只发信号，不发内容）
  → master 被唤醒时，指导层已带上树状态
       ├── 视情况向用户总结（对话能力，不属本插件）
       └── 读结果后调用 finish_work（收尾）

**唤醒只发生在"根进入终态"**：`failed` 与 `done` 都唤醒（否则树会在后台悄悄死掉）。
根 `ready`（待汇总）**不唤醒** —— 汇总本身就是一次派活（§5.1.1），引擎自己会派，不需要 master 参与；
唤醒它只会多花一次 LLM 回合。
```

**回调粒度是"根进入终态"，不只是"根 ready"**：根 `ready`（待汇总）需要唤醒（汇总后的判断可能要 master 参与），根 `failed`（反复拆解不收敛、子工作全失败）**也必须**唤醒 —— 否则树在后台死掉，用户永远不知道。

| 环节 | 归属 |
|---|---|
| 建根（`create_work`） | master，**且只允许顶层会话**（§10.1）|
| 拆解 / 提交（含根汇总） | 工作单元 |
| 收尾（`finish_work`，受"读后方可收尾"门控） | master |

`finish_work` 是**归档**：节点、结果、读取都不动，只是这棵树退出引导层与唤醒判断（`tree.closed_at`），
所以 `done` 与 `failed` 两种终态根都能收尾 —— 一个失败的树同样需要上报后退休。

### 7.1 master 的第一个职责：判断"是不是工作"

master 在一轮会话里，**不能假定用户发来的就是工作** —— 它有可能只是对话、一个问题、一次澄清。同时工作也可能**不由用户消息发起**：master 在对话中自己发现"下一步要执行的事"需要多轮才能完成。

所以判断有两类来源，共用一条判据：

| 来源 | 例子 |
|---|---|
| 用户消息 | "把这个模块迁移到新接口" |
| **master 自己在对话中发现的下一步** | 意识到"要改这个，得先把所有调用方找出来" |

**判据（可操作版，2026-09-21 修订）**：这是一件**可以交出去的"工作"**吗？判据是**能不能连验收标准一起交出去**，不是"这件事复不复杂"。

| | 动作 |
|---|---|
| 独立的工作、需要调研的、多步的、要跑一阵的、逐步分解的、碰多个文件/系统的 | **建工作**（`create_work`） |
| **已经想清楚、只要照单做完再交回结果的**（缺陷已定位到 文件:行，步骤与验收标准都定好了） | **同样建工作** —— 不需要拆，就是一个执行者一次做完，代价与自己做一次相当 |
| 必须看见本对话、需要追问、需要脚本化扇出的委派 | 不建工作，用 `subagent` / `subagent_fork` / `workflow` |

修订点：早先的措辞是"能不能在当前这轮对话里做完 → 能就不建根"。这条被**去掉**了 —— 一件较独立的工作即使在一轮里也能开始，交给引擎执行是正当用法；判据落在"是不是一件可交出去的工作"，而不是"一轮能不能做完"。

**2026-09-21 修订：把"已经想清楚"从排除理由里拿掉。** 此前的资格清单全是"复杂度"特征（调研 / 多步 / 逐步分解 / 碰多文件），于是"缺陷已钉到 文件:行 + 复现命令 + 验收标准、只要照单改完"这类任务被读成"不够复杂 → 不用建工作"，master 转而手起执行者。这个推理在两层上都不成立：①**判据本来就该是"可交付性"** —— 边界清晰、验收明确的任务恰恰是交出去最稳的一类；②**代价被高估** —— 不需要拆解的工作就是一次派发（一个执行者一次做完，见 §5.4 的派发路径），与 master 自己安排一次执行同量级，而它换来跨会话持久化、结果落盘、失败自动重派。同时在 `adjust_work` 一段补了一句"没有未完成的子工作时，它就是一条投递给执行者的消息" —— 不拆解的工作没有可作废的子工作，纠偏代价反而最低。守卫测试：`guidance.spec.ts` 的 "admits an independent work" / "says a correction reaches the executor"，以及 `command.spec.ts` 对 `create_work` 描述的同款断言。

**同日再修订：静态段只讲"何时用"，不碰"内容"与"参数"。** 上一版顺手写进去的两句都拿掉了：①"工作的内容是实现与验证，不可逆的对外动作（发布、推送、删除）留给你自己做" —— 这是**收窄工作内容**，而 master 自己决定一件工作为了什么，读回结果是 `work_result` 的事，静态段没有立场划这条线；②"建工作时写三样：`title` / `description` / `analysis`" —— 与 `create_work` 的参数说明重复，而模型在**同一个请求**里就读得到那份说明。去掉后静态段从 649 字降到 525 字，且它的反引号 token 集合从 `{create_work, adjust_work, title, description, analysis}` 收窄到 `{create_work, adjust_work}` —— 这本身就是"静态段不许谈机制"的量化形式。守卫：`guidance.spec.ts` 的 "leaves the mechanics to the tool"（不得出现 `title`/`description`/`analysis`）与 "does not fence off what a work may contain"（不得出现 `不可逆` / `发布、推送、删除`）。

**用语**：模型可见文本里，交出去的那件事叫**工作**；**工作树**只指它被逐步分解之后的状态。工具名同样不带 tree（`list_works`）—— 从 master 的视角看只有工作，"树"是分解之后的形态，不是它要去操作的对象。

**落地**：这张判据表现在由 §6.0 的静态提示词段直接讲给模型（此前只隐含在 `create_work` 的工具描述里）。

### 7.2 分析 ≠ 拆解

| | master | worker |
|---|---|---|
| 问题 | **这是不是工作** | **缺哪些前提** |
| 依据 | 对话上下文 + 用户意图 + 已有 goal | **实测**（尝试后撞墙）|
| 产出 | 二值：建根 / 不建根；建根时给**方向** | 带理由的子工作清单 |

master **不产出子工作结构**。它做的是"分类 + 给方向"，具体缺什么是撞出来的（§5.2）。所以 `create_work` 的入参是：

```
create_work(title, description, analysis)
                                  ↑ master 的初步分析（方向、约束、已确认的事实）
```

`analysis` 写进根节点的 `description` / `context`，worker 拿到根工作时**顺着已经分析过的东西继续**，而不是从零再分析一遍。这也让"根节点第一次执行时靠什么知道要不要拆"有了答案：**靠 master 已经写在节点里的分析**。

**master 的 `analysis` 与执行者的 `note_work` 是两回事**：`create_work.analysis` 只在建根时写一次，落进 `context`，回答"这件事为什么值得做"；`note_work` 由每个执行者在**它那一次派活**里写，落进 `analysis_notes`，回答"这一轮为什么还缺、拆出去要拿回什么"（§5.3.2）。两者都会进节点 prompt，但只有后者受 `decompose_work` 的门禁约束。

**推荐路径：先试做几步再建根。** 假阴性的代价是可事后纠正，而且 master 那几步产生的理解**正好成为 `create_work` 的初步分析** —— 所以"先试试"不是浪费，它生产了根节点的输入。

### 7.3 与 `dsh-goal` 的关系

`goal` 在默认组合里是挂载的（host 服务 + `tool-goal`），因此不处理会让 master 同时看到两套"长期目标"。

**两者是两个层次，不是替代关系：**

> **goal 是"要达成什么"（意图锚点），work 是"怎么达成"（执行结构）。**

| 维度 | goal | work |
|---|---|---|
| 结构 | 一句 `objective` + phase | 树、依赖、结果、收敛 |
| 调度 | **不调度工作**（设计如此）| 引擎调度 |
| 写权限 | `requireDirectHuman`（人类门控）| master 建根 / worker 拆解 |
| 完成语义 | `complete`（人类决定）| 根终态 + `finish_work`（master 门控）|

**关键约束：两者状态独立，不互相触发。** 根工作完成**不等于** goal 完成 —— 用户的验收标准可能比树更宽或更窄。goal 的完成必须由人决定。

**goal 的用处：给建根一个机械闸门。** goal 的 `create`/`edit` 要求"运行时根 agent 轮次中的直接人类消息"，这条约束正好可以当边界：

```
建根的合法来源只有两个：
  ① 本轮对话中用户直接要求的
  ② 落在某个 active goal 范围内的工作
两者都没有 → master 必须先问用户，不能自发起树
```

这把 §7.1 的判断从纯启发式变成了可核查的来源，并同时防住"发散"（树不会越界跑）和"不确定时乱建根"（不确定 → 问用户）。

**worker 侧：goal 的三件工具与提示词段都要摘掉**（§5.4）。

---

## 八、层级归属与恢复

### 8.1 两层结构

工作单元的**父 agent 就是 master** —— 只有 master 直接与用户交互，工作状态的展示、唤醒、汇报都围绕它。

```
宿主层（进程级、唯一）：
    工作树服务 + 宿主 KV 域 + 引擎（扫树 / 派活 / 回收 / 活性判断）
        ↑ 供查询
agent 层（挂在 master 的 preset 行）：
    ├── pre-step 钩子：问引擎"现在要不要放行"，并过滤子代理来源的消息
    ├── 工作树工具（create_work / decompose_work / submit_work / work_result /
    │                list_works / finish_work / cancel_work）
    └── 引导层上下文（工作执行状态）
```

关键点：**pre-step 钩子不持有引擎逻辑**，只调服务、拿一个布尔 —— "引擎是纯程序"这条原则不变。引擎因此也不需要自己创建一个父 agent。

> **修订（2026-09-20，会话续命）**：pre-step 现在有**一处真实副作用** —— 在放行分支里唤醒停手的执行者
> （`host.wakeParkedWorkers()`）。这不是把引擎逻辑搬进钩子：唤醒是一次 `ctx.subagents` 投递，而它**只能**
> 在 owner 自己的轮内做，因为续期协议的 `authorizeLineage` 要求授权方是"活着的直接父会话"，而 worker 记录
> 的父会话就是 owner（见 `docs/design/2026-09-20-session-continuation-proposal.md` §4.1.1）。pre-step 在
> 此前**已经**有 inbox 副作用（`discardQueuedNotices` / `takeQueuedInput` 会 `remove` 消息），所以这不是
> 从零破例；但"在门禁里启动一个 worker"比"修剪消息"重，故在此显式记录这条权衡。

**归属与可见性**：树归**建根的那个 agent**（记在树记录的 `owner_session_id`），**其他 agent 不可见**。写入类工具（拆解 / 提交 / 收尾 / 取消 / 读结果）全部在宿主层校验归属，非 owner 一律 `not-owner`。

**命名**：注册的工具名一律带 `_work` 后缀（`create_work` / `adjust_work` / `decompose_work` / `submit_work` / `work_result` / `list_works` / `finish_work` / `cancel_work`）。本文叙述里出现的"拆解 / 提交"等简称指同一操作；**给模型的文本（工具描述、worker prompt、引导层）必须写注册名**——worker prompt 曾经写成 `decompose` / `submit_result`，两个都不存在，现在有测试盯着这一点。

**owner 工具对 worker 不可见**（§5.5 的两张面孔把它变成了机制，不再只是意图），靠的是两个机制叠加（见 §10.1 的实施口径）：
宿主平面注册一次 + **`create_work` 拒绝非顶层会话**。后者是必须的：worker 若能建根，就等于造了一个引擎看不见的执行者
（没人给它派活、没人回收、结果不回填任何节点，还绕开配额）—— 与摘掉 `subagent` / `subagent_fork` 要防的是同一件事。

### 8.2 取消、进度展示与可见性

| 事项 | 结论 |
|---|---|
| 谁唤醒 master | 工作引擎；master 空闲时通过 pre-step 通道唤醒 |
| 展示什么 | 工作执行状态（进度、待汇总、失败），由引导层注入 prompt |
| worker 出现在 `/` 子代理面板 | **可以接受** —— 用户需要时可去查看执行情况 |
| 执行过程的默认可见性 | 不在主对话里，但 master 的 prompt 里有状态；需要细节时切视图或读树 |

### 8.3 上下文增长

master 的历史只从两个来源增长：

| 来源 | 频率 |
|---|---|
| pre-step **放行**时的那批消息 | 每次"有状态值得 master 处理"一次 |
| master 自己 toolcall 读来的结果 | 按需 |

而非终态的叶子结算通知**一条都不会进历史** —— pre-step 从 inbox 摘出的消息只在 enter 分支才被 append；批次被清空时那些消息既离开 inbox 也从未入库，排队中的通知也由 ⓪ 直接清掉。所以"不会上下文爆炸"不是靠"消息发得少"，而是**结构性保证**。

### 8.4 master 的存活形态

**关闭会话 ≠ 销毁 master。** 宿主侧的事实（源码核实）：

- session-controller 的 `ensureSession` 返回**裸 `Agent`，`AgentHandle` 的 disposer 没有被任何地方保存**，而 agent-loop 的 `dispose()` 只由 owner fiber 卸载 / caller 中止 / factory teardown 触发
- 没有任何 idle 淘汰机制（`session-controller/src` 与 `core/agent/src` 均无）
- GUI 对会话只有 **archive**，不是删除；客户端 `manager.dispose()` 拆的是**客户端会话视图**

> **用户"关闭会话"只是客户端不再看它 —— 宿主里的 master agent 仍在，`ctx.agents.get(masterId)` 仍然命中。**

因此**不需要任何"汇报落 KV / 内存保持"的补偿机制**：树的状态本来就在宿主 KV，master 重新进入时 `ensureSession` 拿到的是同一个活 agent，pre-step 正常放行、正常投递。

### 8.5 master 是否存在的判据

| 步骤 | API | 含义 |
|---|---|---|
| 1 | `ctx.agents.get(id) !== undefined` | 活 agent 在注册表里 |
| 2 | `ctx.sessionQuery.observeSession(id)` 成功 | 会话数据在持久层（`source: 'live' \| 'prepared'` 可区分活的与冷读）|
| 3 | 命中 `SESSION_QUERY_SESSION_NOT_FOUND` | **会话确实不存在 → 按规则销毁树** |

第 2 步的契约是 live-preferred（先查 `ctx.sessions.get`，未命中再冷读持久层），活/冷两种都能观察；第 3 步的错误码是确定的。这就是"master 被销毁"的可靠判据。

**为什么第 1 步单独不够（实现上踩过的坑）**：agent 是**按需物化**的 —— 宿主启动那一刻，所有会话都不在注册表里，
而它们的数据完好无损。若用「注册表里没有」当"master 已销毁"，**每次宿主重启都会销毁全部树**。
所以归属判据只认第 2/3 步（`observeSession`），注册表只用于 worker 活性（§3.2 的场景表不变）。
`ctx.sessionQuery` 未挂载或探测失败时，一律按"存在"处理：多留一棵树的代价可逆，销毁不可逆。

**派活也认这件事**：树的 owner 不是活 agent 时，引擎**不派活**（`nextDispatchable` 跳过该树）。
否则重启后（owner 尚未物化）每次派活都会走到"没有父 agent 可用"，把节点的 `attempts` 白白烧光。
owner 回来后树自然继续。

### 8.6 插件生命周期 vs 数据生命周期

Cordis 的 `ctx.effect()` 就是 install/uninstall 接线：**disposer 在 fiber 卸载时运行（同一 fiber 内反序，父 fiber 卸载级联到子 fiber）**。所以"我们自己的清理一定会跑"。

但**兄弟 fiber 之间的相对拆卸顺序没有保证** —— `agent/disposed` 由 agent-loop 的 `dispose()` 发出，其 owner 是 session-controller 的 lifespan；宿主关闭时两个 fiber 是兄弟，我们可能先被拆完而错过该事件。**跨服务顺序不可依赖。**

由此确定分工：

| 时机 | 该做什么 |
|---|---|
| **插件拆卸**（HMR / 宿主关闭） | 只做**进程内清理**：停 timer、丢弃内存派活集合、注销服务。**树、节点、结果一律不动** |
| **引擎启动** | **对账**：对每棵树查 `observeSession(root.owner_session_id)` —— 成功 → 树保留；`NOT_FOUND` → master 已销毁 → 销毁整棵树 |
| **运行中** | `subagent/end` 立即回收结束的 worker（§4.1）；孤儿树由兜底扫描按 §8.5 判据清理 |

三种情形因此自动正确：

| 情形 | 结果 |
|---|---|
| 宿主关闭再重启 | master 会话数据仍在 → **树保留**（符合"关掉不影响执行"）|
| master 被真正销毁 | 启动对账 `NOT_FOUND` → **树销毁** |
| 热重载 | 新实例从 KV 接回同一棵树，master 是活的 → 什么都不用做 |
| 重启后某节点 `running` | 按 §3.2/§3.4 判据回收为 `interrupted`；若 agent 仍在（热重载）则不回收 |
| 其他 agent | 看不见这棵树（§8.1）；worker 拿不到读全树的工具 |

**核心分界**：数据生命周期由**事实**（master 会话是否存在）决定，不由**我们自己的装卸**决定。

---

## 九、异常与边界

| 场景 | 处理 |
|---|---|
| worker 崩溃 / 被中断，没写结果 | 活性判据 + `subagent/end` → `interrupted`，`attempts` 已递增 |
| worker 迟到写结果（节点已被重新派给别的 worker） | 身份校验拒绝（§3.3）|
| 同一节点被两个触发源同时派活 | 批次内去重（§3.1）；最坏是多起一个工作单元，写入仍被身份校验挡住 |
| 拆解出实质重复的子节点 | **建节点时去重**，范围限拆解者所在子树 |
| 拆解递归过深 | 树可任意深；每次执行都是新会话，无委派深度累积问题 |
| 根节点反复拆解无法收敛 | 失败预算 `failures` 超阈值 → `failed` + 唤醒 master 上报（成功的拆解/汇总轮不消耗，见 §9.2） |
| 节点无界增长 / 无限拆解 | 配额（见 §9.2）：超限时**拒绝该次拆解** —— 一次性、零副作用，不改节点状态 |
| 用户取消 | 取消子树：把子树节点标终态，并 `interrupt_agent` 各 in-flight 持有者 |

### 9.2 配额与升级策略

| 项 | 值 | 接线入口 / 行为 |
|---|---|---|
| 树深度上限 | **8** | `decompose` 前校验，超限**拒绝该次拆解** —— 一次性、零副作用，不改节点状态；已到顶的执行者在**派发时**就会读到这条上限（prompt 的深度提示），不用靠被拒才发现 |
| 单次拆解子工作数 | **至多 6** | `decompose` 的入参校验，超出即拒绝该次调用（一次性，不改节点状态）|
| 并发工作单元上限 | **CPU 核数 - 1**（可配）| 引擎每次派活 pass 的上限，按**已绑定的节点**计数（见下）|
| 失败预算 `failures` | **5** | 每次 worker 被回收（消失 / 卡死）+1；达阈值 → 节点标 `failed` + 唤醒 master 上报。**成功的提交与拆解（含汇总轮）不消耗** |
| 启动失败预算 `spawnFailures` | **5** | 每次「派发即失败」（runtime 拒绝 / toolFilter 无法施加）+1，并按指数退避冷却后再派；成功启动即清零；达阈值 → `failed`。**不计入 `failures`** |
| 单树节点上限 | **200** | `decompose` 提交前校验，超限 `node-limit` 拒绝该次拆解（一次性，零副作用）。只数**本次新增**的节点：复用已有前置工作的子工作不计数 |
| 会话续命 | **同一父子边**（`parkedWorker`）| 拆解后停手的执行者被记在该节点上；子工作全终态后由 owner 那一轮唤醒它继续判断。不占并发配额（停手时 `claimedBy=null`）、不触发 stale 判定、失败不消耗任何预算（`wake-failed`）。见 §9.3 与设计提案 |
| 工作链 token 预算 | **暂不需要**（见 §9.2.1）| —— |

**深度的计数口径**：根节点为第 1 层，深度 8 即允许最多 7 次连续下钻。实施时以根为准统一定义。

**"发散"与"失败"是两回事**：`failures` 只能识别反复失败，识别不了"反复成功拆解出更多节点"。深度上限（8）与单次子工作数（6）**共同给出了节点数的理论上界** —— 但那个上界是数万节点，而深度限制要到第 8 层才生效：一个每轮只拆一个子节点的递归可以在被拦住之前跑很久，每个节点在真实部署上都是一个会话。所以 200 这个上限**已经落地**（不再是"待定"），它是廉价的天花板，同时仍远高于任何人会去审的树规模（一次拆解最多加 6 个节点）。

它也是 worker 自发扇出的**唯一**可用记账点（见 §5.4.1）：引擎看不见 `workflow` / `ralph` 在节点内部起了多少子 agent，能计数的只有树自己的节点。

**`attempts` 与 `failures` 是两个计数器（2026-09-20 修订）**：

- `attempts`：**每次派活 +1**（spawn 时），是「派发代号」。它同时承担 `note_work` 的归属门禁
  （`decompose` 校验 `analysis_attempt == attempts`，确保是本次派发自己写的分析），所以汇总轮也必须 +1。
- `failures`：**失败预算**，只在 worker 被回收（消失 / 卡死）时 +1；成功的提交与拆解一律不消耗。

修订原因：早先用 `attempts` 当失败上限，于是「拆解 → 子终态 → 汇总判断 → 还缺 → 再拆解 → 再汇总」
每一轮都吃 2 次 `attempts`，`maxAttempts=5` 实际只允许约 2 轮拆解-收敛，**合法的多轮逼近工作会被误判
`failed`**。把失败预算拆成独立的 `failures` 后，成功的收敛轮不再消耗它，只有真正反复失败的节点才逼近上限。

**派发失败要退避（2026-09-20 修订）**：`startWorker` 派发失败（`subagents` 不可用 / `toolFilter` 连重试都
失败）时，回收记为 `spawn-failed` → `spawnFailures +1`（**不进 `failures`**），并按 `30s × 2^(n-1)`（上限
10 分钟）冷却，`nextDispatchable` 在冷却期内跳过该节点。否则 pump 频繁触发会在数秒内烧光预算把节点判死。
成功启动一次即把 `spawnFailures` 清零（预算针对的是**连续**启动失败）。

**并发上限的计数口径必须是"已绑定"**：预留的 child id 在被物化之前不是 agent，
按"活 agent 数"计数会让一次扫描把 N 个 ready 节点全部派出去（上限形同虚设），
也会让上限取决于 spawn 多快注册。所以计数取 `status == running && claimed_by != null`，
本轮的派活立刻计入，同一 tick 的第二次触发也不会超发。

### 9.2.1 待实施项与接线入口

以下两项**当前不实施**，但预留接线位置，避免将来改造时找不到入口：

| 项 | 接线入口 | 何时需要 |
|---|---|---|
| 工作链 token 预算 | 节点 prompt 构造器（§5.1）的输出处 —— 构造完成后测长，超限则退化为"只保留根 + 最近 N 层" | 深度上限放宽，或工作链开始含描述时 |
| ~~单树节点上限~~ | 已实施：`decompose` 提交前校验（`CAPACITY.maxNodesPerTree`）| —— |

**会话续命（2026-09-20 实施）**：一次派活的执行者拆解后停手，节点会记下它的会话 id（`parkedWorker`），
子工作全终态时由 **owner 的那一轮**把它唤醒，让"判断这堆子结果够不够"这件事发生在**当初做拆解的那个会话**里，
而不是一个要从 `note_work` 与子结果重新推导的全新会话。边界如下：

- **只沿同一条父子边**：一个 worker 只唤醒它自己上一次的执行；不跨层级。
- **必须排除出派活池**：`decompose_work` 之后宿主会同步 `pump()`，若不把 parked 节点从 `nextDispatchable`
  排除，它会在 owner 来得及唤醒之前被派成全新会话，唤醒逻辑就成了死代码。
- **唤醒主体只能是 owner**：续期协议的 `authorizeLineage` 要求授权方是活着的直接父会话。owner 离线时
  地址**留在节点上**、不消费、不新起执行者，等它回来再续。
- **失败即降级**：会话被清理或运行时拒绝 resume → `wake-failed` 退回 `ready`，直接以新 claim 派发新执行者。
  不给重试预算 —— `note_work` 是这条边界的正式交接，全新会话是完整正确的路径。
- **一次 park 只通知一次**：宿主按节点记录"已告知 owner"，节点离开 parked 状态即清除，避免每次 pump 都往
  owner 的 inbox 堆一条唤醒。

冷启（`sendMessage` 对非驻留子会话走 `coldResume`）已在真实协议上验证：`pnpm spike:cold-resume`。

**为什么工作链 token 预算暂不需要**：工作链的组装**只含各节点的 title 与少量基本信息**，不含 description / context（那些属于当前节点自己的内容）。所以工作链长度是"深度 × 一行的开销"：

| 深度 | 工作链大致规模 |
|---|---|
| 8（上限）| 8 行标题级信息 |

这个量级下 prompt 不会膨胀，加预算反而增加无谓的复杂度（YAGNI）。**§5.1 里"工作链不膨胀"这条在设计上是靠"只放基本信息"保证的，而不是靠截断策略。**

### 9.3 拆解去重的锁协议

执行者各自只看得到自己的工作链，可能独立发现同一缺口。去重由**引擎侧**完成（不是执行者的认知负担）：

```
decompose(node, children):
  持树锁:
    for child in children:
      if 等价节点已存在于「node 的兄弟子树 + node 自己的子树（含本次已建）」中:
        复用该节点 id（不新建），并把本次的 context 追加到该节点
      else:
        新建节点
```

**范围**：兄弟子树 + 自己的子树，**不做全局去重** —— 全局去重等于让执行者"看见"无关分支，破坏"执行者无需知道其他工作"这条原则。

**三类节点永不作为复用对象**：**节点自己**、**它的祖先**、以及树中的任何同 id 节点 —— 前两类会让节点变成自己的前提（依赖成环）。

**复用出的依赖是共享的**：被复用节点出现在两个父节点的 `children` 里，而 `parent_id` 仍是创建它的那一个。
于是"子工作全终态 → 父可汇总"的传播**必须从所有父节点出发**（按 `children` 反查父节点，广度优先向上），
不能沿 `parent_id` 单链上溯 —— 否则另一个分支永远等不到 `ready`。

**取消一个工作的下级时，共享前提的三种口径（2026-09-18 定：选第 2 种）**：

| 口径 | 含义 | 取舍 |
|---|---|---|
| 1 跳过共享节点 | `parentsOf(id).length > 1` 就不动它 | 保住另一条分支，但"清空重规划"不彻底 |
| **2 照取消 + 重算所有父节点**（采用） | 共享前提也被取消，**每个被改动节点的全部父节点**都重算聚合状态 | 语义与"汇总轮读子结论后重新判断"一致；代价是取消了别人没同意取消的东西 |
| 3 拒绝 | 有共享下级时返回 refusal，让 owner 改用 `cancel_work` | 最保守，但把选择推给了人 |

第 2 种成立的前提是**汇总轮能看到真相**：取消写进去的 `result` 必须同时置 `hasResult`（否则渲染成"（未提交结果）"，理由一个字都到不了模型），且 `childrenBlock` 必须带子节点状态。两处都已实现，并有回归测试（取消一个分支后，另一个父节点必须变 `ready`）。

去重与建节点共用同一把树锁，避免"同时查、同时建"。

---

## 九点五、客户端半边：**工作**标签

会话视图条里的第三个标签（`conversation.view`，order 20，排在"对话"0 与"轨迹"10 之后），用树形展示本会话的工作树。

| 层 | 贡献 |
|---|---|
| 宿主 | `AvantfWorkHost` 改为 `TypertRemoteService`，加 `@Remote('snapshot')`、`@Remote('detail')`、`@Remote('result')`、`@Remote('delete')` 与 `@Remote({ mode: 'stream' }) watch` 五个方法；`wire.ts` 手写 host/client 两份 wire face，`apply` 里 `ctx.typert.register(hostContribution)` |
| 客户端 | `src/client/`：`$mount(clientContribution)` → `ctx.get('remote.avantfWork')` → 挂载时读一次，之后**跟着 `watch` 变更流刷新**（见下）；点工作标题按需调 `detail`，在**弹窗**（设置面板形制：左侧分区栏、右侧唯一滚动区）里展示该工作的标题/内容/上下文/拆解信息/纠偏/结果/子工作；**每棵树**的标题栏带"删除"按钮（二次确认，删完立即重读；树未结束时禁用并说明原因）；节点的展开默认值跟着它自己的状态：在跑/待跑/中断的默认展开（拆出来的子工作立刻可见），`done`/`failed` 的默认折叠（跑完的树收成一行，结束的分支不再压住活着的部分），点击存为覆盖值；`slots.register('conversation.view', …, order 20)` |
| 构建 | `scripts/build-client.mjs` 用 esbuild 打成 `lib/client.js`（`window.__ModuleLoader__.load` 契约；shell 提供的模块保持 external） |

**为什么手写 wire face**：DSH 包通常由 Typert 生成器产出 `typert.host.js` / `typert.remote-client.js`，而生成器只在 harness 工作区内运行。手写遵循生成器的约定（一个 `args` 对象参数、`<pkg>#<ns>/<method>` 的 invocation id、`strict` codec）。

**为什么不注入 `remote.avantfWork`**：boot 审计（`@deepseek-ai/dsh-client-web` 的 `assertEntriesActive`）对任何仍 pending 的注入项抛错，并让**整棵 web 树**起不来；而自建命名空间只有在本插件自己 `$mount` 之后才存在。所以只注入 `remote`，挂载后用 `ctx.get()` 读。

**为什么不复用 harness 的 tsdown 预设**：该预设按 `packages/*/*/package.json` 反查目标包 manifest，第三方仓用它必须往 DSH 源码树写一个 stub；本项目不改 DSH 源码，因此自建 esbuild 打包，产物契约与预设一致。

**刷新为什么由引擎推，而不是面板轮询**：只有引擎知道某棵树动了 —— 派活、回收、worker 提交、owner 收尾，其中"引擎自己在 owner 空闲时派活或回收"这一类根本不进任何会话日志，轮询频率再高也只是把延迟改小、把猜测换个周期。所以引擎在每次变更后把该 tree owner 的 revision +1，并唤醒所有挂在 `watch` 上的流；客户端对每个已挂载的面板开一条以 sessionId 为键的流，收到帧就重读快照。`watch` 声明为 `mode: 'stream'` 并带 `cancellation: { parameter: 'signal' }`（harness 自己的 `session/control` 就是这个形状），标签卸载时 `AbortController` 一 abort，宿主那边的等待就被唤醒并结束生成器，不会留下悬挂的监听。帧里只带一个 revision 号：推送只负责说"变了"，权威数据永远来自 `snapshot`/`detail`，所以丢一帧（重连、宿主重启）只值一次重读，不损正确性。

**为什么文字不用 opacity 调暗**：`opacity` 会沿子树相乘 —— 一个变淡的祖先（归档树曾整块 `.75`）乘一个变淡的子元素（meta 曾 `.55`）只剩 41%，亮色主题下约 2.7:1、暗色约 3.5:1，12px 小字实际读不了；标题本身也被那层 `.75` 拖到 5.5:1。现在所有文字颜色来自 label token：正文 `label-primary`（第 3 代条目实测 亮 18.9:1 / 暗 15.0:1）、次级文字 `label-secondary`（5.8:1 / 10.4:1），归档状态改用虚线边框而非整块变淡。状态色只用于形状与底色（`--avwf-status` 喂圆点和徽标底色），徽标文字仍是 label token —— 状态色当文字在亮色主题下只有 2.3:1。另：样式里原先的 `--dsh-color-*` 变量在设计平台里不存在，一直在走硬编码兜底，现已换成 `--dsw-alias-state-*`。

**为什么颜色也取自同一套 token**：条目的底色 `--dsw-alias-bg-layer-1`、文字色 `--dsw-alias-label-primary` 与"记忆"条目相同（shell 为明暗主题统一定义），只改颜色、不动边框圆角间距字号。相邻标签用同一套设计 token，读起来才是同一块界面；硬编码颜色会在其中一套主题里露馅。

**为什么宽度要跟"记忆"页对齐**：会话视图标签页渲染在对话正文旁边，通栏会让它看起来像个外来的浮层。根节点用与 `@avantf/mem-dsh` 相同的规则对齐共享属性 `--dsh-chat-content-width`（`ui-conversation` 的根发布它，`ui-chat` 的消息列也以它居中），两个标签因此共享同一条轴线与同一个宽度；根节点不设左右内边距，让"树框"的边界与"记忆"条目的边界重合。属性不存在时该声明在计算值阶段失效、`max-width` 退回 `none`，也就是原来的通栏行为，不需要兜底分支。

**为什么列表要窗口化、摘要要瘦身**：一个会话的工作树只增不减（删树是人的动作），所以"很多工作"迟早会发生。渲染侧按"棵树"开窗（阈值 25，`@tanstack/react-virtual`，`overscan` 5，先估后量高度）——滚动条覆盖全部历史，但 DOM 只挂视口附近的几棵，和"轨迹"表同一套机制；数据侧则让摘要只留行上要用的字段：节点的 `description` 移出摘要（行不渲染它，全文在 `detail` 里按需读），因为摘要是**每次引擎变更都重传**的，而描述是其中最大的一块。仍然随历史增长的是"每棵树的节点行"，下一步若真需要，就是把节点也改成按可见树按需读取。

**兜底为什么还需要**：`timer`（5 秒）只在宿主没有 `watch`、或流连着两次**一帧都没给**时启用（旧版本宿主、连不上的传输）—— 健康的流一定会先给一帧开场（当前 revision），所以"什么都没来"就是"这条流不能用"的判据，会话侧 revision（`useChat`/`useSession` 的便宜派生值）则始终在，用来覆盖"工具调用已经改了树、推送还在路上"的窗口。`timer` 是可选服务，本机浏览器侧没挂它，所以退到浏览器自己的 `setInterval`，两条都试过才算失败 —— 这条路径写错的表现恰好是"这个功能像是没做"。

**详情为什么按需读**：一个结果可以到 2 KB（超过就落盘，只留前 2 KB 与指针），而快照在每次变更时都要重读。通常关着的面板不该为它付钱，所以点开某一行才调 `detail({ sessionId, nodeId })`；已打开的弹窗跟着快照一起重读，所以 worker 在它开着的时候提交结果会直接出现。

**2026-09-23 修订：详情从"行内展开"改为"弹窗"。** 行内展开的详情一长就把树顶下去：读完一棵的目标/纠偏/结果再回头看另一棵，原来的滚动位置已经找不到了。现在改为居中弹窗，形制照 DSH「设置」面板 —— 全屏遮罩（`--dsw-alias-bg-mask-1` + `--dsw-mask-blur`）、layer-2 卡片（`--dsw-elevation-prominent`）、左侧分区栏、右侧**唯一**滚动区；卡片 **1040×880**（比设置的 800×800 更宽：这里读的是一列散文加长列表，176px 的分区栏一分走，800px 的内容列就局促了），正文 **15px/1.7**、标题 18px、分区标签 15px（比行文字大一档 —— 这个面就是用来读的，14px 在这个宽度上读起来像小字）。分区由内容生成且**空的分区不出现**：内容/结果恒在，上下文/拆解信息/纠偏/子工作只在有内容时成为一个标签、并在标签后带条数；**标题不是分区，而是弹窗的标题栏**（连同节点 id、状态徽标、第几次派发与深度）—— "我在看哪个工作"在任何分区被选中之前就要回答，而且读每一个分区时都得答得出来，标题曾经占着一个分区，等于让这条前设在切换标签时消失。每个分区前面有一行小字说明它装什么：`内容` 是"要达成什么（验收对象）"、`上下文` 是"为什么需要它（拆解者写的前提，不是验收标准）"—— 两个分区挨着却回答不同问题，只给名字会让人把前提当成目标；`拆解信息` 是 `note_work` 记下的执行者分析（缺什么前提、排除了哪条路、子工作完成后要判断什么），并注明最近一条写于第几次派发 —— 这是判活的那个**全新会话**唯一能看到前任推理的地方，此前只有引擎读得到；`纠偏` 分区里写明「目标以『标题』为准」，这样"标题是创建时的目标、结果是纠偏后的方向"这两件事在同一个面板里被读成一条因果，而不是一对矛盾。关闭路径是关闭按钮、遮罩点击与 Escape，打开时焦点落在关闭按钮上。弹窗渲染在**视图根**而不是行内：行住在虚拟列表里，滚过去就会被卸载，挂在行上的弹窗会随读者的滚动消失。守卫：`client-view.spec.tsx` 的分区集合/顺序/空分区/条数/拆解信息与出处/两个分区的语义小字/溢出指针/加载与失败态，以及"弹窗尺寸、字号与画法跟设置面板同规则"的样式断言。

**为什么不走会话投影**：投影要求状态由 session log 折叠、且每次变化落一条 whole-value 事件。工作树的运行态由 service 持有，复制进日志成本更高，且"查看别的会话之外的树"语义也不对。

**破坏性操作的屏障强度不一致（记录，A4）**：面板的 `delete` 与 `/clean` 都是不可恢复的，但门禁不同 —— `/clean` 要求"是本插件的会话 + 已结算 + （`all` 时）已归档或显式点名 id"，而 `delete({ sessionId, rootId })` 只有归属一条，且 session id 由调用方提供（Remote 不带调用方身份，见下）。本地单用户宿主下可接受，但这两条值得对齐；对齐做法尚未决定（把 `delete` 也要求归档会伤 UX，因为面板的删除正是用来清掉"已完成但未归档"的工作）。

**已知限制**：Remote 调用不携带调用方身份（生成器的方法只收参数），所以 `snapshot({ sessionId })` / `detail({ sessionId, nodeId })` / `result({ sessionId, nodeId })` / `delete({ sessionId, rootId })` / `watch({ sessionId })` 的 session 由客户端给出。视图持有它正在显示的那个 id，且这运行在用户自己的宿主进程里。删除的调用形式是 `delete({ sessionId, rootId })`：**单位是整棵树**，节点 id 不是可删除的对象（传节点 id 会被当成"没有这棵树"拒掉）。未结束的树不会被删除 —— 它归引擎管，提前结束它是 `cancel_work`；`finish_work` 是另一种树级结束，保留记录并归档，删除则整条移出。删除不可恢复。

**2026-09-23 修订：落盘结果改成"点开就能看"。** 结果超过 2 KB 就落盘，节点只留开头与一个 locator —— 而那个 locator 是**给模型的**（`work_result` 连同检索指引一起交给它），人在面板里点不动：浏览器不会导航到文件路径，DSH 自己那条"用桌面应用打开"的路只对有**授权路由**的 deliverable 开放，而这个 spill 不是交付物。于是加 `result({ sessionId, nodeId })`：面板上的「查看完整结果」让**宿主**（唯一能读自己 spill 产物的一方）把全文读回来，在弹窗里就地展开（展开时**替换**开头那段，不叠加 —— 开头本来就是全文的第一片）。两条降级都写死了：宿主没有这个面 → 不显示按钮（不提供一个注定失败的读）；locator 不是本机路径（`SpillStore` 的契约明确 locator 是**不透明的**，测试桩给的就是 `spill://…`）→ 回一条原因，locator 照旧留在屏幕上 —— 它本来就是"知道这个存储底座的人"要的地址。

## 十、插件构成

### 10.1 挂载形态（实施口径）

```
@avantf/dsh-work（单个宿主行）
  ├── 工作树服务 + 宿主 KV 域 + 引擎（扫描 / 派活 / 回收）+ timer
  ├── 9 个模型工具（owner 6 / executor 3）
  ├── 指导层上下文（order 在待办之后）
  └── agent/pre-step 钩子 + subagent/end 监听 + /work 命令
```

**这是同一行的两半，不是两处挂载**：设计之初设想"宿主行只放服务、树工具挂 master 的 preset 行"，
落地时选择了**单宿主行**（profile 里一行即可用，不必改 preset），代价与补偿是：

| 代价 | 补偿 |
|---|---|
| 工具对**所有** agent 可见（不只 master）| 所有写入路径都在宿主层做 `owner_session_id` 归属校验；读不到别人的树 |
| worker 也能看到 `create_work` | `create_work` **拒绝任何 subagent 会话**（`session.header.origin === 'subagent'` 或 `delegationDepth > 0`）→ `no-authority` |

将来若要收紧可见性，把工具注册挪到 preset 行即可 —— 宿主 API 不变，`create_work` 的守卫仍应保留（纵深防御）。

### 10.2 直接复用的既有能力

| 需要 | 用哪个 |
|---|---|
| 生成工作单元 | 既有子 agent 生成能力（`spawn` 语义：空对话、continuable） |
| 限制 worker 工具面 | 子 agent 请求的 `toolFilter`（`deny`：`send_message` / `subagent` / `subagent_fork` / 三个 goal 工具）—— 同时使 `send_message` 那段回传引导**不被追加** |
| 限制 worker 的工具面（含 goal） | 子 agent 请求的 `toolFilter`（见 §5.4）；goal 的**指引文本**无法干净移除，作为已知限制记录在 §5.4.2 |
| 预留 child id（关闭 spawn/bind 窗口） | `ContinuableStartSpec.childId`（调用方预留，物化前即可记录 provisioning） |
| 树的持久化 | 宿主 KV（引擎独占打开该域） |
| 指导层注入 | 提示词注册表的运行时上下文 |
| 唤醒 master | agent 投递接口；过滤与放行判断走 master 的 `agent/pre-step`（只清空/替换批次，从不 reject） |
| master 侧消息过滤 | pre-step 读 `message.source.kind`（`subagent-settled` 等子代理来源与用户消息可判别） |
| master 存在性判据（启动对账） | `ctx.sessionQuery.observeSession`（`dsh-session-query-sqlite`；base 组合已挂载并发布 `ctx.sessionQuery`）|
| worker 活性 | agent 注册表查询（`ctx.agents.get`）+ 生命周期事件 |
| 结果超长时的落盘与取回 | `ctx.spillStore.saveText()`（后端 `dsh-spill-local`）；阈值策略由本插件在 `submit_result` 里判断 |
| 定时兜底 | timer 插件 |

**不自己实现**：子 agent 的生成后端、会话持久化、压缩。

---

## 十一、实施步骤

| Step | 内容 | 验收 |
|---|---|---|
| 1 | 宿主插件骨架 + KV 域 + 节点模型（状态机、可派活计算、树记录的 `owner_session_id`）| 建树 / 拆解 / 可派活计算正确；重启后树仍在 |
| 2 | 派活与绑定（KV 固化 `claimed_by`、批次去重、分派时解析活性）+ 节点 prompt 构造器（含状态尾段）+ `toolFilter` 工具面 | 同一节点不会同时有两个在跑；杀掉绑定者后节点在下次分派时被回收为 `interrupted`；迟到写入被拒；**热重载后不重派**（agent 仍在）；worker 的 prompt 里没有 `send_message` / 委派 / goal 工具 |
| 3 | 工具面（拆解 / 提交 / 读结果 / 收尾）+ 互斥与配额校验 + 拆解去重 + 超长结果落盘 | 三层工作跑到根完成；每个叶工作对应一个新会话；子会话看不到 master 对话；`submit_result` 与 `decompose` 互相拒绝；深度 8 / 子工作 6 / `attempts` 5 各自生效 |
| 4 | 指导层（锚定分段 + 去重）+ 根完成汇报 + pre-step 过滤与放行 + 取消子树 | 状态不变时**不产生新事件**；状态变化时恰好一条；根终态时 master 收到一次唤醒；用户消息既不丢也不被搁置（一次工具调用之后 turn 必须继续到模型自己收尾）|
| 4.5 | **纠偏下传**：根上写的纠偏必须出现在其后代 worker 的 prompt 里（工作链携带）；取消子工作后，**所有**受影响父节点仍可派发；汇总轮读到被取消的子工作时能看到状态与理由 | 单测与挂载级测试各一条（复用树上取消 → 另一父节点变 `ready`；纠偏后后代 prompt 断言；取消后汇总 prompt 断言） |
| 5 | 启动对账（`observeSession` 判 master 存亡）+ 可见性增强（可选）：树状态面板 | master 会话被删除时树被销毁；宿主重启后树保留；面板显示 ready / running / blocked 分布 |

---

## 十二、验收要点

1. **引擎零 LLM**：派活轮次不产生模型请求（对比触发前后的请求数）
2. **工作单元零等待**：worker 的 prompt 里不含子工作进度；worker 生命周期内无空转回合
3. **树是唯一权威**：杀掉引擎进程再起，树状态与 `running` 节点的回收结果一致
4. **重复拆解被抑制**：两个分支独立发现同一缺口时，树上只出现一个节点
5. **指导层不膨胀**：一个完整工作跑完，指导层快照数为个位数
6. **收尾门控生效**：未读结果时 `finish_work` 被拒
7. **两种代际切换都正确**：热重载（agent 仍活）不重派；进程重启（agent 已死）回收后重派
8. **三层树跑到根 `done`**：拆解 → 子节点全终态 → 汇总派活提交结论 → 根收敛 → 读结果 → 收尾（这条是本设计的核心路径，必须有测试钉住）
9. **并发上限生效**：一批 N 个 ready 节点不会一次派出超过上限的工作单元
10. **唤醒真的唤醒**：引擎唤醒产生的 turn 至少带一条消息（否则零模型调用，等于没唤醒）
