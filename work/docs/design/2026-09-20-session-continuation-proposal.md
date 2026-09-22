# 会话续命（parked parent + wake）：设计草案

> 状态：**已实现（REV-2）** —— 冷启 spike 通过，`parkedWorker` 那一整套已落地；本文档保留为设计与取舍记录
> 目标版本：`@avantf/work-core` + `@avantf/dsh-work`，`DOMAIN_VERSION` 保持 1（新增字段带默认值）
> 关联：`docs/design/work-engine-plugin.md` §4.2 / §5.1 / §5.3.2 / §8.1 / §9.2 / §六点六
>
> **REV-1 修订摘要**（审查发现，逐条已核实并落进正文）：
> 1. **致命项**：`submit_work` 尾部同步 `await pump()`，而 `nextDispatchable` 不认 parked——
>    parked 父节点会在 owner 轮到 pre-step 之前被派成全新会话，唤醒永不发生。修正：`nextDispatchable`
>    排除 parked-ready（§3.4），engine 尾部新增 `reportParkedReady`（§五），测试 #2 方向改正、新增 #15。
> 2. 唤醒失败的 cause 从 `spawn-failed` 改为新增的 **`wake-failed`**（不进预算、不触发 30s 冷却，§4.2 / §五）。
> 3. 信号去重明确依赖既有的 `discardQueuedWakes`（§4.1.3）。
> 4. 「owner 离线也不阻塞树」的措辞**是错的**，已改写：离线期间该节点会等（§七.2）。
> 5. 新增「显式修订 §8.1 分层口径」与「先做冷启 spike 再投入」（§七.5 / §八.4）。

---

## 一、要解决的问题

一个节点被派发 → 执行者 `decompose_work` 拆出子工作 → **这次执行就结束了**。子工作全终态后，引擎会对同一个节点**再派发一次，但是一个全新会话**（设计文档 §682 明写：「每次派发都是全新会话」）。

于是当节点第二次被派发去做「汇总 / 判断是否达成 / 决定还缺什么」时，那个执行者**从未见过自己当初为什么拆**。跨这次断层的唯一通道是 `note_work` 写下的 `analysisNotes`，而 prompt 目前只要求它写「缺什么前提、子工作完成后要判断什么」——**没有要求写下"我排除过哪条路、为什么排除"**。

在「逐步逼近目标 = 排除错误」这种工作形态里，被排除掉的路径恰恰是最该延续的部分：子工作的结果如果证伪了当初的拆分前提，一个全新会话拿到的是「(上一轮)说缺 X」+「X 的结果」两段分离文本，要读者自己对齐才能发现前提被证伪；同一个会话里这件事是自然发生的。

**本方案给这条断层提供一个快路径：会话续命。** 断层不是被消除，而是变成「能续就续，续不了照旧」。

### 明确的目标 / 非目标

| | |
|---|---|
| **要** | 父节点在子工作全终态后被重新派发时，优先唤醒**它自己上一次那个 worker 会话**，把子工作结果注入进去；这一步失败则原样退回今天的全新会话 |
| **要** | 唤醒是**可失败**的，且失败**永不阻塞树**：任何一步出问题都退化成现状 |
| **不要** | 全树连续。续命只发生在**同一条父子边**上：一个 worker 只唤醒它自己上一次的那次执行 |
| **不要** | 替代 `note_work`。`analysisNotes` 仍是跨会话的正式交接（也是 fallback 路径的唯一通道） |
| **不要** | 让停手的父节点占并发槽、占 stale 判定、或影响 `heldByLiveWorkers` 的语义 |

---

## 二、设计取舍的回看与修订

设计文档 §682 的原话是「每次派发都是全新会话」。本方案**不否定它**，而是把它从「唯一路径」降为「fallback 路径」。需要同时修订的是：

1. **§682 补一句**：全新会话仍是默认与兜底；同一节点在「拆解 → 子终态 → 汇总」这条边上，若上一次执行的会话**可唤醒**且唤醒成功，则由它继续。
2. **`note_work` 的写作要求补一条**：除「缺什么前提、要判断什么」外，**写下这一轮排除了哪条路、为什么排除**。理由是本方案有 fallback——两条路径必须产出同一份可交接的记录，否则"续命成功"和"续命失败"会让同一棵树在不同轮次呈现不同质量，那就成了不可复现的随机性。

> 审查提示：第 2 条是本方案里**唯一**会改变模型可见行为的地方，且它不依赖续命是否生效——即使续命一次都没成功，这条措辞改进也独立成立。

---

## 三、状态模型

### 3.1 今天的状态

```
decompose_work 时（tree.ts, decompose 的提交块）:
  node.claimedBy = null          ← 释放绑定，worker 会话从此失联
  node.status    = aggregateStatus(children)   // blocked（有未终态子）或 ready（全终态）
子全终态时（propagateAggregate）:
  node.status = ready
派发时:
  node.status = 'running'; node.claimedBy = <新 claimId>; node.attempts += 1
```

关键事实：**`claimedBy` 一置 null，那个 worker 会话就再也找不回来了**（`childId` 是唤醒的唯一地址）。

### 3.2 新增：`parkedWorker`

`NodeRecord` 增加一个字段，持久化：

```ts
/**
 * The worker session that parked this node: it decomposed the work and stopped,
 * expecting to be woken when its children reach terminal state.
 *
 * A wake-up ADDRESS, not a claim. It never authorizes anything and never makes
 * the node "held": `claimedBy` is cleared exactly as before. It survives only
 * until the next dispatch of this node — that dispatch either wakes it (and the
 * address becomes `claimedBy`) or starts a fresh session (and the address is
 * dropped). Stale values are therefore harmless, which is what lets every
 * failure path below be "just dispatch fresh".
 */
readonly parkedWorker: string | null
```

- 新增节点默认 `null`；schema 加 `z.string().nullable().default(null)`，`DOMAIN_VERSION` 不变。
- **不新增 NodeStatus**。状态词表（`ready`/`blocked`/`running`/`interrupted`/`done`/`failed`）已经出现在 prompt、面板、`work_result` 三处，多一个词要同步全改；而"这个节点有一个可唤醒的会话"是**附加事实**，不是执行状态，用字段表达不动词表。
- **停手时节点状态照旧**（`blocked` / `ready`），`claimedBy` 照旧置 null。**这正是 §4 那些豁免点能够不存在的原因。**
- **但该节点必须被 `nextDispatchable` 排除**（见 3.4）。这是本方案唯一一处**会让特性彻底失效**的地方，单独列出来。

### 3.4 必须排除 parked 节点，否则特性是惰性的（致命项）

`submit_work` 的最后一步是**同步 `await this.pump()`**（`host.ts:709`）；`pump → pass → nextDispatchable` 不认 parked，父节点一被 `recomputeAncestors` 置成 `ready`（`tree.ts:959`）就会被捞起，`pass` 随即 `dispatch(parent, 新 claimId)` + `startWorker`。**在 owner 轮到任何 pre-step 之前，parked 父节点已经被一个全新会话接管，`parkedWorker` 按 3.2 被消费，唤醒分支永远进不去。**

所以：

- `nextDispatchable` 必须**排除** `status === 'ready' && parkedWorker !== null` 的节点（不能像最初草案那样"不认识 parked"）。`dispatch()` 本身**不做**这个检查——唤醒失败后的 fallback 要能直接调它。
- parked 节点由此**只**有两条出路：被唤醒（`adoptParked`），或 `parkedWorker` 被清空后重新落回候选池。
- 这一条同时定了 §4.1 的门禁为什么必须存在：pump 不再抢派，**owner 那一轮是唯一会把该节点推进的地方**。

### 3.3 生命周期（happy path）

```
dispatch(node) → running, claimedBy=C1, attempts+1
worker C1: note_work(...) → decompose_work(children)
   ↓ decompose 提交时
   status=blocked, claimedBy=null, parkedWorker=C1        ← 唯一改动
   （C1 的会话回合结束，驻留结束，subagent/end 到达；引擎按今天的方式扫，什么也不会回收——
     因为节点已不是 running 且 claimedBy 已 null）
children 逐个终态 → 父 status=ready（**此时才算"所有子任务都完成"**）
引擎的 pass 看到 ready + parkedWorker=C1：
   → 按批投一条 owner 唤醒信号（复用 deliverToOwner；owner 离线则 deferred，C1 指针留着）
owner 这一轮被门禁放行（"存在 parked-ready 节点"）：
   → adoptParked: status=running, claimedBy=C1, parkedWorker=null, attempts+1   ← 认领在前
   → sendMessage(owner, C1, buildWorkerPrompt(view))
      成功: C1 继续，它这一轮的输入 = 子工作结果 + 本轮指令（叠加在它自己的历史上）
      失败: reclaim(node, 'spawn-failed') 放掉绑定
            → 用全新 claim 走今天的 dispatch + startWorker（C2）
C1/C2 这一轮结束（submit 或再 decompose）→ 回到上面任一分支
```

`claimedBy` 在唤醒时被设回 `parkedWorker`，是**出于身份一致**：worker 这一轮要能 `submit_work` / `decompose_work`（两者都校验 `claimedBy === caller`）。节点从 `ready` 到 `running` 的转换与今天完全一致，只是换了个会话 id 来源。

---

## 四、唤醒机制

### 4.1 唤醒由 owner 这一轮完成（不另起投递通道）

**决定（2026-09-20）**：唤醒不新造一条投递路径，而是挂在**引擎已有的 owner 唤醒机制**上（设计文档 §4.2）。那条机制本来就有"没有可做之事就丢弃、且零模型调用"的性质，正好承载"要不要续命"这个决策。

#### 4.1.1 前提：引擎无法自己当授权主体

`coldResume` 里 `authorizeLineage(parent, childId, child.parentSession)` 要求：

1. `parent` 是**活 Agent**（`ctx.agents.get(parent.id) === parent`）；
2. `parent.id === 该 child 会话记录的 parentSession`。

worker 起的时候 `parent` 恒为**根 owner**（`startWorker` 里 `ctx.agents.get(SessionId(owned.ownerSessionId))`）。插件的宿主 `ctx` 不是 Agent，引擎**不能以自己名义**投递。两条可走的路：

| | 做法 | 代价 |
|---|---|---|
| A | 引擎直接 `sendMessage(ownerAgent, parkedId, prompt)` | 仍要求 owner **当下物化**（`authorizeLineage` 第一条）；owner 不在线就无法续命 |
| **B（选定）** | 引擎把这条**事实**投给 owner（复用 `deliverToOwner`），owner 这一轮醒来后由运行中的引擎完成唤醒 | owner 不在线时消息 deferred，物化后再来；代价是每个"停手后又被重新派发"的节点占一次 owner 唤醒（见 4.1.4） |

选 B 的理由：不与 owner 的物化状态耦合——owner 离线时 parked 指针留在节点上，等它回来再续。

#### 4.1.2 投给 owner 的是一条**信号**，不是一条指令

沿用既有契约（`createUserMessage` + `source: { kind: 'plugin', plugin: 'avantf-work' }`），正文只陈述事实，**不要求 owner 调用任何工具**：

```
工作 <nodeId>（"<title>"）的子工作都已终态；它的执行者停在 <parkedId>，
引擎将在那个会话上继续这个工作（不可用则新起一个）。
```

**它不需要 owner 回答，也不需要新工具。** 唤醒在同一轮内由引擎完成：pre-step 门禁看到"引擎有可做之事"就放行这一步，**在同一处**（pre-step 里、`enter` 分支确定为真之后）调 `wakeWorker` 完成认领与唤醒。放行与唤醒同一个决策点，避免"放行了却没有唤醒"这种两步之间的空隙。

#### 4.1.3 pre-step 门禁新增一个准入条件

现有门禁的第三条分支（设计文档 §4.2）：

```
├── 引擎还有需要 master 处理的状态 → 保留唤醒消息（空批次不产生模型调用…）
```

"需要 master 处理的状态"现在包含：

> **存在一个节点：`status === 'ready'` 且 `parkedWorker !== null`。**

这个判断必须**同步、廉价、只读内存**（与 `nextDispatchable` 同级），并且**按批处理**——一条唤醒消息覆盖所有这种节点。owner 离线一段时间后可能同时出现多个，一个节点一条唤醒会形成唤醒风暴。

同一个放行条件也顺带覆盖了"终态树要上报"等其他引擎状态：owner 这一轮里该处理的事一起处理，唤醒不会被浪费在单一事项上。

**信号的重复投递靠既有机制收敛**：`reportParkedReady` 每次 pump 只要条件成立就会发，但 owner 侧 `discardQueuedWakes`（`index.ts:188`，`keepOne` 参数）本来就把多条本插件的唤醒收敛成一条 —— 所以不会形成风暴，也不新增持久标记。这是本方案**依赖的既有行为**；实现时若发现该收敛覆盖不到这种形态，则改为 host 侧只投一次（记录已投过的 nodeId 集合，节点被唤醒即清）。

#### 4.1.4 成本边界（如实记录）

- **每个"停手 → 子全终态 → 重新派发"的边沿占一次 owner 唤醒。** 这是固定成本，与树的大小、子工作数量无关；对多轮逼近的工作就是每轮一次。
- 它比看上去便宜：唤醒消息无内容，门禁在"没有 parked-ready 节点"时丢弃它，**零模型调用**（空批次不进 `step()`，且被摘下的消息不入库）；只有真有事可做才撑起一轮。
- 与 owner 已有的"有终态树要上报"唤醒**共用同一个通道**，不新增通道。

### 4.2 唤醒与降级

```ts
// host.ts：由引擎在 owner 这一轮内调用（pre-step 放行之后）。
// 节点此刻已被 adoptParked 认领（claimedBy = parkedId, parkedWorker = null）。
private async wakeParkedWorker(node: NodeRecord, parkedId: string): Promise<boolean> {
  const owned = this.requireTree().treeOf(node.rootId)
  if (owned === undefined) return false
  // 授权主体 = 该 worker 的直接父会话 = owner（startWorker 起 worker 时 parent 传的就是它）。
  const parent = this.ctx.agents.get(SessionId(owned.ownerSessionId))
  if (parent === undefined) return false
  try {
    // 与 startWorker 同源：view 现取（期间可能有兄弟结果落地），prompt 用同一个构造器。
    const view = this.requireTree().view(node.id)
    if (view === undefined) return false
    await this.ctx.subagents.sendMessage(
      parent,
      SessionId(parkedId),
      [{ type: 'text', text: buildWorkerPrompt(view) }],
      { signal: new AbortController().signal },
    )
    return true
  } catch (error) {
    this.log.warn(`wake of ${parkedId} failed (${String(error)}); dispatching a fresh executor`)
    return false
  }
}
```

`sendMessage` 对**不在驻留中的**子会话会走 `coldResume`（`dsh-subagent` 契约：*"A missing direct child cold-resumes through the ordinary continuation lifecycle"*），所以"驻留已释放""进程重启后从盘上重建"是**同一条路**，不需要两套代码。

降级表：

| 情形 | 处理 |
|---|---|
| parked 会话仍可投递（驻留中 / 可冷启） | 唤醒成功：`claimedBy = parkedId`，注入 `buildWorkerPrompt(view)` |
| parked 会话已被清理（clean）/ `NOT_RESUMABLE` / `UNAUTHORIZED` / `ACTIVATION_CLOSING` | WARN → `reclaim(node, 'wake-failed')` 把刚认领的绑定退回 `ready` → **直接调 `dispatch(node, 新 claimId)`** 走今天的 `startContinuable`。**不走 `spawn-failed`**：那个 cause 会累加 `spawnFailures` 并触发 `nextDispatchable` 的 30s 指数冷却（`spawnBackoffMs`），而"一个停手的会话被清掉了"既不是基础设施故障，也不该让节点等冷却 |
| owner 未物化 | 唤醒消息 deferred，**`parkedWorker` 保留在节点上**；owner 物化后的下一次门禁再处理。不设超时、不设计数——状态本身在节点上 |
| 唤醒被接受但这一轮**没有产出** | 由**现有**回收路径处理：`claimedBy` 在唤醒时已置回，`subagent/end` → sweep → liveness 判定 → `reclaim('vanished')`（`failures+1`）。不新建判死逻辑 |
| 唤醒后被 `cancel_work` / `adjust_work` 打断 | 与今天在跑的 worker 完全同路（`claimedBy` 在，`interruptWorker` 拿得到会话） |

- 唤醒失败后是**直接 `dispatch()`**，不是等 pump 重新捞：`nextDispatchable` 只影响 pump 的选择，`dispatch()` 自己是权威入口；`parkedWorker` 已在 `adoptParked` 时置空，该节点此刻已是普通候选。

> **为什么唤醒失败不重试**：`note_work` + 全新会话是等价正确的兜底。把续命做成"必须成功"，收益没变、风险变成"树依赖一个可能不存在的会话"。"这条边不值得续"就退化成全新会话，不给重试预算——这条边界必须写进代码注释，否则下一个人很容易改成"失败重试三次"。

### 4.3 与 `subagent/end` 的关系（实现时必须小心）

`subagent/end` 是**按驻留 epoch** 发的（`dsh-subagent/lib/index.js:351` 的 `createActivationObserver.settle`），也就是**每一轮跑完都发**。所以：

- worker `C1` 拆完停手 → 它的回合 settle → `onSubagentEnd(C1)` → `sweep()`。此时节点已是 `blocked/ready + claimedBy=null`，扫描什么都不会回收（这正是 3.2 把停手做成"释放绑定"而不是"保留绑定"的好处：**不需要让 sweep 认识 parked 概念**）。
- 唤醒后 `C1` 再跑一轮 → settle → 再次 `onSubagentEnd(C1)` → 同样按 `claimedBy` 与 liveness 判定，与今天的 worker 没有区别。

**结论：`heldByLiveWorkers` / `reclaimStale` / `inFlightCount` 三处都不需要为 parked 开特例**，因为 parked 期间节点不是 `running`、也没有 `claimedBy`。

**一个真实竞态**：`settle` 与下一次投递可能相邻（投递会走 `activation.inbox.closing` 分支重试，见 `deliverFollowup` 的 `while` 循环）。这不影响正确性（协议自己重试），但意味着**唤醒必须走 `sendMessage` 这条正规投递**，不能自己往 inbox 里塞东西。


## 五、改动清单

### core（`@avantf/work-core`）

| 位置 | 改动 |
|---|---|
| `types.ts` | `NodeRecord.parkedWorker: string \| null`（含上面那段注释）；`makeNode` 初始化 `null` |
| `tree.ts` `decompose` | 提交块里 `claimedBy = null` 的同时 `parkedWorker = node.claimedBy`（即本次调用者） |
| `tree.ts` `dispatch` | 保持纯粹：**不认识 parked**。唤醒决策在 host（因为只有 host 能碰 `subagents`） |
| `tree.ts` 新增 | `adoptParked(nodeId, workerId): MutationResult<DispatchView>` —— 与 `dispatch` 同一把锁、同样的"失败即拒绝"语义，但 `claimedBy` 用传入的 `parkedWorker` 而不是新 claimId；若 `parkedWorker` 已被清空则拒绝（调用方退回 `dispatch`） |
| `prompt.ts` | 不需要分叉；唤醒与派发共用 `buildWorkerPrompt` |
| `engine.ts` | 新增 `reportParkedReady()`，挂在 `pump()` 尾部（与 `reportTerminalRoots` 同一位置、同一形态）：`parkedReadyNodes().length > 0` 时调一次新 hook `notifyParkedReady(nodes)`。**这是 `pass` 侧唯一的改动**——派发决策仍由 `nextDispatchable` 的排除规则负责 |
| `engine.ts` | `wakeWorker` 的触发点：owner 这一轮被放行后，在 pre-step 的 `enter` 分支里由 host 调 `wakeWorker({ node, workerId })` |
| `tree.ts` 新增 | `parkedReadyNodes(): readonly NodeRecord[]` —— `status === 'ready' && parkedWorker !== null`，供 pre-step 门禁与 `reportParkedReady` 做**同步、只读内存**的批量判断（§4.1.3） |
| `tree.ts` `nextDispatchable` | **排除 parked-ready 节点**（§3.4）。这是致命项的唯一落点 |
| `tree.ts` `reclaim` | 新增 cause `'wake-failed'`：把刚 `adoptParked` 的 `running` 退回 `ready`、`claimedBy=null`，**不动 `failures` 也不动 `spawnFailures`**（它不是基础设施失败，见 §4.2） |

> **为什么认领必须在前**：被唤醒消息接受的会话**立刻**可以调 `submit_work` / `decompose_work`，而两者都校验 `claimedBy === caller`。若先投递再认领，先到的写入会被 `not-owner` 拒掉——这正是 §六点六 那条"绑定与子 agent 注册之间的窗口"的同一个坑。所以顺序固定为：**认领（`claimedBy = parkedWorker`）→ 投递 → 投递失败则回收并改用全新会话**。投递失败时 `parkedWorker` 已被消费（置空），后续轮次会走全新会话；这一点是可接受的，因为 `note_work` 就是这条边界的交接，全新会话是完整正确的路径，不为"保住一个也许还能唤醒的会话"设计重试。

### plugin（`@avantf/dsh-work`）

| 位置 | 改动 |
|---|---|
| `host.ts` | 新增 `wakeParkedWorker()`（§4.2）；`prestep` 的"引擎还有需要 master 处理的状态"增补 `parkedReadyNodes().length > 0`，并把唤醒信号按批投给 owner（复用 `deliverToOwner`，owner 不在线即 deferred）；`EngineHooks` 增加 `wakeWorker` |
| `host.ts` `compose` 后的注入 | 无（沿用 `buildWorkerPrompt`） |
| `domain.ts` | `nodeSchema` 加 `parkedWorker: z.string().nullable().default(null)` |
| `prompt.ts`（core）| `EXECUTE_TAIL` / `AGGREGATE_TAIL_PREFIX` 里 `note_work` 的措辞补「排除过哪条路、为什么排除」 |

### 文档

| 位置 | 改动 |
|---|---|
| `docs/design/work-engine-plugin.md` | §682 补 fallback 语义；§9.2 配额表加一行"会话续命：同一父子边、可失败、不占配额"；§六点六（回收）加一句"唤醒后无产出按 vanished 回收"；§5.3.2 补 `note_work` 的排除要求 |
| 本文档 | 定稿后并入设计文档或保留为独立提案（待你定） |

---

## 六、测试计划

**core（纯树语义，无 harness）**

1. `decompose` 后 `parkedWorker === 调用者`、`claimedBy === null`、状态与今天一致；
2. **子全终态后 `nextDispatchable` 跳过该节点**（否则 pump 抢派，唤醒永不发生——§3.4）；`parkedWorker` 被清空或经 `wake-failed` 之后**重新返回它**；
3. `adoptParked` 成功：`claimedBy` 变成 parked 会话、`parkedWorker` 清空、`attempts+1`；
4. `adoptParked` 在 `parkedWorker` 已空 / 节点非 `ready` / 已被别人持有 时拒绝，且**零副作用**；
5. 旧文档（无 `parkedWorker`）load 后字段为 `null`（`domain.spec.ts` 的"旧文档"用例扩展）。

**plugin（真实 Cordis + stub 服务）**

6. **owner 信号**：父拆解 → 子全终态 → 断言 `owner.followup` 收到一条本插件的唤醒消息，正文含 nodeId 与 parkedId，且**没有**要求 owner 调工具的措辞；
7. **门禁准入**：同一状态下 pre-step 的"引擎有可做之事"为真；把子工作改成未终态后为假（唤醒消息被丢弃，零模型调用）；
8. **happy path**：放行后断言 `subagents.sendMessage` 的 sender 是 **owner Agent**、目标是被唤醒的 childId、正文 = `buildWorkerPrompt(view)`；且**没有**新的 `startContinuable` 调用；
9. **降级 a（被 clean）**：`sendMessage` 抛 `NOT_RESUMABLE`/`UNAUTHORIZED` → 记 WARN + 走 `startContinuable` 新起 worker，节点不被判失败，`failures` 不变；
10. **降级 b（owner 离线）**：owner 不在 `agents` 里 → 唤醒**不投递**、`parkedWorker` 保留、不新起 worker；owner 物化并再走一次门禁后完成唤醒；
11. **唤醒后无产出**：唤醒成功后该会话 settle 且不再是活体 → 按 `vanished` 回收（`failures+1`）并重新派发，而不是死等；
12. **配额不变**：被唤醒的那一轮 `attempts+1`、`failures` 不变（唤醒不是失败）；
13. **`cancel_work` 能打断被唤醒的会话**：断言 `interrupts` 含该 childId（与 P1 那条回归同源）；
14. **批量**：同一 owner 下两个 parked-ready 节点 → **一条**唤醒消息，而不是两条（依赖 `discardQueuedWakes`，若实现改为 host 侧只投一次则断言投递次数 == 1）；
15. **pump 不抢派**（致命项的回归）：`submit_work` 触发的那次 `pump` 返回后，断言**没有**新的 `startContinuable`，且节点仍 `parkedWorker !== null`；
16. **`wake-failed` 不消耗预算**：唤醒失败后断言 `failures` 与 `spawnFailures` 都不变，且节点立刻被全新会话接走（不被 30s 冷却挡住）。

**变异验证（必须做，否则测试可能空绿）**

- 删掉 host 里的"优先唤醒"分支 → 用例 8 必须红（退化成全新会话）；
- 删掉 `decompose` 里 `parkedWorker = node.claimedBy` → 用例 6/8 必须红；
- 删掉"唤醒失败即降级"（改成抛错）→ 用例 9 必须红；
- 把门禁的 parked-ready 条件删掉 → 用例 7 必须红（唤醒消息永不放行）；
- 把 `nextDispatchable` 的排除删掉 → 用例 15 必须红（pump 抢派，唤醒永不发生）；
- 把 `wake-failed` 换成 `spawn-failed` → 用例 16 必须红（预算被消耗 + 冷却挡住重派）；
- 把批量改成逐节点投递 → 用例 14 必须红。

---

## 七、这个方案**不**解决的问题

1. **不解决层级隔离**：续命只发生在同一条父子边。一个 worker 内部用 `workflow`/`ralph` 起的子 agent 仍然不在树上、不被记账（§5.4.1 的既有取舍不变）。
2. **owner 离线时该节点会等**：`nextDispatchable` 排除 parked 节点（§3.4），而唤醒又必须由 owner 那一轮完成，所以离线期间 parked 节点**既不新鲜派发、也无人唤醒**，一直停到 owner 回来。这**不是新退化**——`nextDispatchable` 本来就在 `!isAgentLive(ownerSessionId)` 时跳过整棵树（`tree.ts:376`），该节点的子工作本来也派不出去。措辞要准确：离线时**不存在**"退回全新会话"这条路，那只在 owner 在线、唤醒失败时才发生。
3. **不替代 `note_work`**：两条路径并存，所以 `analysisNotes` 的质量仍然决定 fallback 路径的质量；本方案只是让快路径有机会利用更多的过程信息。
4. **不改变回收语义**：唤醒后无产出按今天的 `vanished` / `stalled` 处理；唤醒**失败**是第三种 cause（`wake-failed`），不消耗任何预算。
5. **要显式修订 §8.1 的分层口径**：设计文档 §8.1 写"pre-step 钩子不持有引擎逻辑，只调服务、拿一个布尔"，而本方案要在 pre-step 的 `enter` 分支里真正启动一个 worker。pre-step **今天已有** inbox 副作用（`discardQueuedNotices` / `takeQueuedInput` 会 `remove` 消息），不是从零破例；但"在门禁里唤醒一个 worker"比"修剪消息"重。之所以没有更干净的注入点：**owner 唯一保证物化的时刻就是它自己的轮内**，而唤醒需要活着的授权主体（§4.1.1）。这条权衡要写进 §8.1，而不是只留在提案里。

---

## 八、已定（2026-09-20）

| # | 决定 | 落点 |
|---|---|---|
| 1 | **由引擎生成 owner 消息来授权**；等所有子任务都完成后再唤醒，原 worker 被 clean 则新起一个 | §4.1 / §4.2 / §五 |
| 2 | **保留 `note_work`**，并补上"排除过哪条路、为什么排除"的写作要求（两条路径共存，措辞保证两者质量一致） | §二.2 / §五 |
| 3 | **`parkedWorker` 只留最近一次** | §3.2 |

| 4 | **先做冷启 spike 再投入实现** —— **spike 已通过** | §八.1 |

#### 冷启 spike 的结论（2026-09-20，已跑通）

`scripts/spike-cold-resume.mjs`（`pnpm spike:cold-resume`）挂载**真实** `@deepseek-ai/dsh-subagent`
运行时与 continuation manager，只 stub 三个缝隙：`agents`（记录 create/resume）、`sessionPersistence`、
`sessionQuery`。它跑**两个独立 bootstrap**（= 进程重启的忠实模型），10 条断言全绿：

| 断言 | 结果 |
|---|---|
| A1–A4 `startContinuable` 落盘 continuable 描述符；描述符可 `foldSubagentDescriptor` 还原；父会话日志记下该子会话 | ok |
| **B1–B4** 非驻留子会话上 `sendMessage(owner, childId, …)` → 走 `coldResume` → `agents.resume({ resumeSessionId: childId, parentAgent: owner })`，即**同一个会话被重建**、授权主体是 owner、且它读的是**已存在的**会话而非新建 | **ok** |
| C 非父会话作为发送方被拒 `UNAUTHORIZED` | ok |
| D `one-shot` 子会话被拒 `NOT_RESUMABLE` | ok |

**反向验证**（防它空绿）：把子会话日志里的 `subagent/descriptor` 事件去掉再跑，精确失败 6 条
（A2/A3/B1–B4），且 B1 捕获到的正是 `NOT_RESUMABLE: … has no supported continuation state`。

**因此 §4.2 降级表里"parked 会话仍可投递"这一行是有实验依据的**，不再是契约假设。C 这条同时确认了
§4.1.1 的授权边界确实由协议强制（换一个发送方就拒），所以"唤醒主体只能是 owner"不是我们的选择，是约束。

顺序（§八.4 原意）：
1. ✅ `note_work` 措辞（已落地，`32896b5`）
2. ✅ 冷启 spike（本节）
3. ✅ 实现 `parkedWorker` 那一整套（含 §3.4 的排除规则）—— 已落地：

   | 落点 | 实现 |
   |---|---|
   | `NodeRecord.parkedWorker` | `types.ts`（含 rationale）；`domain.ts` 加 `nullable().default(null)`，`DOMAIN_VERSION` 仍为 1 |
   | 记录 | `tree.decompose` 提交时 `parkedWorker = callerSessionId`，`claimedBy` 照旧置 null |
   | 排除 | `nextDispatchable` 跳过 parked（§3.4 的致命项）；`cancelTree`/终态路径清地址 |
   | 认领 | `tree.adoptParked(nodeId, workerId)`：地址必须匹配、同锁、`attempts+1`、消费地址 |
   | 退回 | `reclaim(node, 'wake-failed')`：退回 `ready`，**不消耗任何预算**、不触发冷却 |
   | 报告 | `engine.pump()` 尾部 `reportParkedReady()` → host `notifyParkedReady()`，**每个 park 只投一次** |
   | 唤醒 | host `wakeParkedWorkers()`，只在 owner 的 pre-step 放行分支里调用；先查 owner 存活，再认领，再 `sendMessage` |
   | 降级 | 投递失败 → `wake-failed` + 立即以新 claim `dispatch`（不等下一次 pump） |
   | 用例 | core `the parked-session address` 5 条 + plugin `session-continuation.spec.ts` 6 条；**7 条变异验证全部变红** |

正文（含 `note_work` 措辞、`pre-step` 门禁准入条件、批量投递、`wake-failed`）待实现时按 §五 / §六 执行。
