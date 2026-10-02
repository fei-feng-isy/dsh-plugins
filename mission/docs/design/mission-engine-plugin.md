# `@avantf/mission` 任务引擎插件：设计文档

> 2026-09-15 · 状态：待实施
> 目标：DeepSeek Harness（本机 `@deepseek-ai/dsh@0.1.5-rc.1`，profile `web`）
> 范围：**只写本插件需要实现的部分**。DSH 自带能力（子 agent 生成、提示词注册表、宿主 KV、生命周期事件、agent 投递接口）只在使用点列名，不展开。
> 关联：`docs/planned/2026-09-15-dsh-prompt-layer-port-design.md`（prompt 侧）、`docs/design/mission-stack-refactor.md` v8（AvantF 原设计）

---

## 一、设计原则

任务树的执行模型是「逐步解决前置问题，不断逼近最终结果」：

1. 一个任务节点先被**尝试执行**
2. 发现缺少前提 → **由执行者自己拆解**出子节点（前提任务挂到该节点下）
3. 子节点各自被执行，全部终态后父节点重新可执行
4. 父节点这次的任务是**汇总子结论**，判断"目标已达成 → 提交结果"或"仍需拆解"
5. 直到根节点提交结果

从这里推出四条本插件必须遵守的原则：

| 原则 | 含义 | 由谁保证 |
|---|---|---|
| **引擎是程序，不是 agent** | 扫树、派活、回收全部是宿主代码，不花 LLM 调用 | 本插件 |
| **任务单元无状态、用完即弃** | 每次执行是一次新的子 agent，从不等待、从不持有 | 本插件（每次 spawn 新会话）|
| **拆解由执行者做，不在引擎里做** | "为什么需要这个前提"只有尝试过的人知道 | 本插件（工具只在任务单元上下文暴露）|
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
  closed_at        : number | null  // finish_mission 收尾时刻；归档后退出引导层
}

node {
  id            : string            // 短 id，便于工具引用
  root_id       : string            // 所属树
  parent_id     : string | null     // 创建它的父节点（见下）
  title         : string            // 一句话
  description   : string            // 任务内容
  unit          : string | null     // 改动范围（一个目录或文件）—— 引擎租约键（§2.4）
  round_ms      : number | null     // 单轮硬上限的放宽声明（只放宽、最多 24h）；null = 引擎配置值（§3.4）
  context       : string[]          // 任务背景：拆解原因等，由拆解者写入
  corrections   : string[]          // master 的纠偏，最新在后（§6.6）
  corrections_delivered_up_to : number  // 纠偏投递水位：前 N 条已确认送达持有者那个会话（§9.2.2）
  analysis_notes: string[]          // 执行者用 note_mission 写下的判断，最老在前（§5.3.2）
  analysis_attempt: number          // 写下最后一条时的 attempts；0 表示没人写过
  analysis_author: string | null    // 写下最后一条的 session id；身份比对用（§9.2.2）
  hung_count    : number            // 连续 hung 次数，有真实产出即清零；到阈值通知 owner（§3.4）
  parked_worker : string | null      // 拆解后停手的会话 id —— 等待被唤醒的地址（§3.2.2）
  last_worker_id: string | null      // 被中断的会话 id —— 冷唤醒的句柄（§3.2.2）
  dispatch_baseline: Baseline | null // 这次 prompt 给会话看过什么；冷唤醒用它算差量（§3.2.2 / §9.2.2）
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

**`parent_id` 是"出生时的父节点"，不是"唯一依赖方"**：拆解去重会把已有节点复用为**另一个父节点**的前提（§9.3），此时它在两个父节点的 `children` 里，而 `parent_id` 仍是创建它的那一个（任务链沿它回溯）。因此"谁依赖我"必须由 `children` 反查，不能由 `parent_id` 推断。

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

**可派活 = `ready` 或 `interrupted`。** 这两种节点是"空闲叶任务"的完整来源。

**不做的事**：终态节点永不被派活；`blocked` 节点不计入派活数（否则会过量扩容 —— 这是原设计里一次已修正的口径错误）。

### 2.3 释放不能回 `ready`

**会话续命的两个新结局（2026-09-20）**：`wake-failed` 是唯一不进入 `interrupted` 的 cause —— 它把
`adoptParked` 刚认领的节点退回 `ready`，不消耗任何预算、也不触发启动冷却，因为"一个停手的会话被清掉了"
既不是任务失败也不是基础设施故障，而且它的冷却只会拖慢它本该立即启用的 fallback（新起一个执行者）。
唤醒**成功但这一轮没有产出**则与普通 worker 完全同路：`subagent/end` → 扫描 → 按 `vanished` 回收，
照常消耗 `failures`。

`running` 的节点回收后进入 **`interrupted`**，不是 `ready`。原因：

- 下一个执行者要知道"**前面有人试过**"，避免重复同一段失败探索
- `attempts` 随每次派活递增，重复失败可以据此升级策略（换方法 / 标 failed / 上报）

这条替代了原设计里"释放但保留上下文交给别人接着跑"的需求 —— 在无状态任务单元的模型下，**需要交接的只有节点上的尝试记录，不是上下文**。

### 2.4 `unit` 与租约：同一范围只有一个执行者（2026-10-02）

引擎只按节点状态派发，因此两条并行线改同一个文件时会被同时派出去（实测 W7/W8 都改
`host.ts`）。修法是给节点一个**改动范围**并把它变成引擎状态：

> **一个 unit 的持有者 = 该 unit 上唯一那个 `running` 节点。**

- `unit` 是持久化字段，**缺省 `null` = 不声明范围 = 不参与租约 = 今天的行为**；
  旧记录经 `normalizeLoaded()` 读成 `null`，`DOMAIN_VERSION` 仍为 1。
- 根由 `create_mission` 声明；子任务由 `decompose_mission` 的每个 child 声明，**不写就继承父的
  unit**（安全默认：同范围的兄弟不会同时跑）。空白是显式的"不占范围"。
- 租约**跨根任务**：`heldUnits` / `unitHolder` 扫描所有树，因为撞车本来就是跨树发生的。
- 获取在**进入 `running` 的三个路径**上、在树锁内：`dispatch` / `adoptParked` /
  `adoptContinuation`；`nextDispatchable` 先跳过被持有的候选（优化，正确性在锁内那次检查）。
  被拒返回 `unit-busy`，不消耗预算。
- 释放是**状态的投影**：节点离开 `running` 即释放（submit / decompose / reclaim / cancel /
  终态 / 打开时降级 / 删树）。刻意**不做可变租约表**：那样每条释放路径都要记得清，漏一条就是
  永久卡死；投影让释放不可能被忘记。
- **无死锁**：只有 `running` 节点持租约，而 `running` 节点从不等待别的节点（要么 submit，要么
  decompose 后立刻 `blocked` 并释放），节点也至多持一个 unit，所以没有"持有并等待"的边。
- parked / 冷唤醒**不改变归属**：被唤醒的节点仍是同一 unit 的持有者，只是复用同一次租约检查。

完整设计、生命周期点与 8 条验收性质见 [`2026-10-02-unit-lease.md`](./2026-10-02-unit-lease.md)。

---

## 三、绑定与活性

### 3.1 没有"认领"这回事

**绑定发生在派活的那一刻，紧随 spawn**，不是一次独立的抢占动作：

```
引擎：scan → 取到 ready 节点 → spawn 任务单元 → 记下 claimed_by = 子 agent 的 session id
```

因为**派活方就是引擎自己**（唯一的派活者），一个节点在同一时刻只可能被派给一个任务单元 —— 不存在两个执行者争抢同一个节点的情形，也就没有"认领/抢占/重验"这套协议。

这与原设计不同，原因在两边引擎的形态：

| | AvantF | 本插件 |
|---|---|---|
| 派活者 | 多个念头（对等、各自去抢） | **引擎自己**（唯一） |
| 绑定方式 | 念头从树上**拉取**（`claim_next`）→ 必须原子抢占 | 引擎**推送**（spawn 时直接指定节点）→ 天然互斥 |
| 因此需要 | 三段式取候选 + 重验 + 锁序 | **不需要** |

> AvantF 之所以需要认领协议，是因为它的 engine 有推进模块、engine 对象可以直接持有 mission 对象，多个念头会并发去摘同一个节点。
> 本插件里引擎是唯一派活者，任务单元只看到注入的 prompt，执行完凭**任务 id** 提交结果 —— 没有可争的东西。

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
| 树的拓扑、节点状态、结果、`attempts` | 任务状态 |
| **`claimed_by` / `claimed_at`** | 跨引擎代际的绑定记忆；活性由解析决定，不靠它自己判断 |

#### 3.2.1 spawn 与 bind 之间的窗口

`claimed_by` 的值是**子 agent 的 session id**，spawn 返回后才知道，所以顺序必然是"先 spawn、后 bind"，中间存在一个窗口。窗口内崩溃/热重载 → 节点仍是 `ready`、无人记录 → 重新派 → 孪生执行者。

**不需要用原子性消除它，只需要一条不变量：**

> **引擎的「判断 + 标记 + 发起 spawn」必须在同一个事件循环轮次内完成，期间不让出。**

做法即 §3.1 的批次标记（内存集合）。只要这一整段同步，就不会有第二个扫描插进来重复派。窗口存在，但**只有崩溃能落进去** —— 而那时进程内一切已死，重新派一次是期望行为（宁可重派，也不要节点卡在无人持有的 `running`）。

> **已确认的优化**：continuable 子 agent 的 child id **可由调用方预留** —— `ContinuableStartSpec.childId` 的契约写明 "supplying one lets a durable parent **record provisioning before child materialization** without a second identity handshake"。
> 因此引擎可以先写 `claimed_by` 再物化子 agent，**窗口彻底关闭**。上面那条"同一轮次内不让出"的不变量仍应保留（防重复派活），但不再是承受窗口的唯一依靠。

#### 3.2.2 打开时的三类处置，以及"冷唤醒"句柄

`reconcileOnOpen` 对每个 `running` 节点按**本进程**的 agent 注册表判活，于是打开时恰好有三种处置：

| 情形 | 判据 | 处置 |
|---|---|---|
| **幸存者** | `isAgentLive(claimedBy)` 为真（热重载，agent 还在） | 绑定不动，只把 `progressAt`/`activityAt` 刷成当下（否则一段长跑从打开那一刻起就显得沉默） |
| **可接续** | 判活为假，但记录里有一个 `claimedBy` | **先把 `claimedBy` 存进 `lastWorkerId`**，再置 `interrupted`、清 `claimedBy` |
| **无句柄** | 本来就不是 `running`，或 `claimedBy` 就是 `null` | 不动（`lastWorkerId` 若有也早已花掉） |

第二行是新增的**持久化字段** `NodeRecord.lastWorkerId`（旧记录缺该字段时按 `null` 加载）：

```ts
/** 最近一次绑在这个节点上的执行者会话 id，在"中断"而不是"干净交接"时保留下来。
 *  与 parkedWorker 是两回事，谁也不许覆盖谁：parked 是"活着、正在等唤醒"的续命地址
 *  （它拆解完就停手，期望同一轮里被叫醒）；lastWorkerId 是"可能已经不存在"的会话句柄，
 *  冷恢复允许失败。只有 reconcileOnOpen 写它，只有 adoptContinuation 消费它 ——
 *  同进程内的回收不写，所以普通重派行为一点没变。 */
```

- **为什么非存不可**：`claimedBy` 是那个 session id 唯一的落点，一置 `null` 旧会话就再也找不回来，
  下一次派发只能起全新执行者 —— 这正是"重启后像是重新执行一遍"的成因。
- **状态词表不变**：`lastWorkerId` 是附加事实，不是执行状态；节点照样回到 `interrupted`（可派活）。
- **缺省语义取保守**：旧记录没有该字段 → `null`（没有句柄，不去唤醒任何会话）。读取时在
  `MissionTree.open()` 这个**唯一入口**把缺字段规范化成默认值，`domain.ts` 的 schema 同时给出
  `nullable().default(null)`；两处都写是因为测试可以用不经 schema 的 store，而"缺字段读成 undefined"
  会让 `!== null` 判成"有句柄"。
- **与展示句柄分开**：同一个打开动作还会顺手把 `claimedBy` 补进 `NodeRecord.executorSessionId`
  （面板用来"点节点 id 进那个 subagent 会话"的持久展示地址，见 §9 的 2026-10-02 修订之二）。两者
  名字相近但用途相反：`lastWorkerId` 是**会被消费掉**的冷唤醒地址，`executorSessionId` 只读、
  终态也留着。合并它们会让普通重派开始冷唤醒，所以刻意分成两个字段。

#### 3.2.3 变化差量基线：`dispatchBaseline`

冷唤醒要把一个会话从"它记忆里的节点"接到"节点现在的样子"，所以它不仅需要地址（`lastWorkerId`），还需要
**那个会话上一次看到的是什么**。`NodeRecord.dispatchBaseline` 就是这份快照：

```ts
interface DispatchBaseline {
  corrections: number        // 纠偏条数——与投递水位一起定义"这个会话没读过的纠偏"
  notes: number              // analysisNotes 条数——之后追加的就是差量里的"新增笔记"
  terminalChildren: number   // 当时已终态的子任务数——只用于差量措辞，不参与 material 判据
  fingerprint: string        // title + description 的指纹——任务被改写过的判据
  attempts: number           // 当时是第几次派发——身份不可比时的退路（见 holder）
  holder: string | null      // 这份 prompt 交给了哪个会话——判断"最后一条笔记是不是它自己写的"
}
```

`holder` 与节点上的 `analysisAuthor`（最后一条笔记的作者）配对使用：**按身份比对**优先，任一侧缺失（旧记录、
非本代宿主写的）时退回 `attempts` 的代数比较。为什么代数不够用，见 §9.2.2 的 material 判据表。

- **取点 = 宿主把 prompt 交给会话、投递被接受的那一刻**（`startWorker` / `wakeParkedWorker` /
  `deliverContinuation` 三处统一走 `recordBaseline`）。不放 core 的 `dispatch()`：一次 `dispatch()` 可能根本没有
  prompt（owner 不在、view 消失、启动被拒），在那种记录上盖"它看过这里"就是让下一次唤醒少报差量；而且
  "已绑定、子 agent 尚未物化"那段窗口（§3.4 的 `startingClaims`）不该再长出一笔等待中的持久写。
- **只在当前绑定者还是该会话、节点仍是 `running` 时盖戳**：与扫描回收/重派赛跑输掉的那次静默拒绝，比一个
  被相信的错误快照好。
- **缺省语义是"未知"，不是"没有变化"**：旧记录、非本代宿主构造过 prompt 的记录、以及形状残缺的 baseline 都读成
  `null`（`normalizeLoaded()` + schema 的 `nullable().default(null).catch(null)`，见 §3.2.2 的同一处口径）。
  唤醒遇到它时**照样续命**，但渲染一句诚实的说明（§5.1），不渲染任何编造的"新增 N 条"。
- **差量与阈值**（哪些变化算"大到不该续"）见 §9.2.2。

---

### 3.3 身份即凭证

`submit_mission` / `decompose_mission` 只接受**调用方 session id == 节点当前 `claimed_by`** 的写入。僵死 worker 迟到写结果时，它的 session id 已不等于节点当前的绑定者，写入被拒。

这条取代了原设计的 `_result_injected` 幂等水位与"丢帧"逻辑 —— 不需要额外字段，一次身份比较就够。

### 3.4 活性优先，超时兜底

§3.2 的分派判断已经覆盖了"持有者已不存在"，本节补的是**持有者还在但卡死**这一种：

```
对每个 running 节点：
  if ctx.agents.get(node.claimed_by) === undefined
       → 持有者已不存在 → interrupted（vanished，扣 failures）
  else if now - max(activity_at, progress_at, claimed_at) > STALE_MS
       → 存活但完全没有事件 → interrupt_agent(claimed_by) → interrupted（stalled，扣 failures、记 stalls）
  else if now - claimed_at > ROUND_MS
       → 这一轮超过硬上限 → interrupt_agent(claimed_by) → interrupted（hung，不扣预算，hungCount+1）
  else if now - produced_at > STALE_MS
       → 一直有事件但零产出 → interrupt_agent(claimed_by) → interrupted（hung，不扣预算，hungCount+1）
  else
       → 还在做，不动
```

活性是**主判据**（廉价、确定），超时只兜"活着但卡死"（需要一个阈值，是启发式）。两者都需要，但顺序不能反 —— 先看活性可以避免绝大多数无谓等待。

超时按**产出**起算而不是按事件起算：worker 追加的模型输出（`assistant/message`）、工具调用（`tool/call`）与工具结果（`tool/result`）刷新 `progress_at`，其余事件（provider 重试 `assistant/attempt`、路由快照 `request/header`/`request/context`）只刷新 `activity_at`。于是判据是"多久没产出"而不是"多久没事件"，多步慢活不会被误判，而"一直有事件但零产出"（传输层一直重试）判 `hung` —— 不扣任何预算；完全无事件仍是 `stalled`（扣 `failures`、记 `stalls`）。再加一条不看时间戳的轮级硬上限 `round_ms`（默认 1 小时）作兜底：重活可以在 `create_mission` / `decompose_mission` 上用 `round_ms` 声明放宽（**只放宽不放紧**：引擎取 `max(配置值, 声明值)`，声明值上限 24 小时，且子任务不继承）。

**"不扣预算"不等于"无上限"。** `hung` 每回收一次就 `hungCount + 1`，这是一个**连续计数**而非历史：`touchProgress` 收到任何真实产出立即清零，重新派发**不**清零（重派正是连续的一环）。累计到 `maxHungsBeforeReport`（3）时该节点命中 `isTroubledNode`，引擎走与 stalled **完全相同**的通道通知 owner —— 同一个 `notifyStalled` 回调、同一个 `isTroubledNode` 门槛、同一个 `stalledNotifiedAt` 持久标记（每节点至多一条消息，stalled / hung / 起不来三者共用）；文案说明这是连续第几次卡住、没有消耗失败预算，并指向 `adjust_mission` / `cancel_mission`。未到阈值时只打诊断日志（`notifyHung`，每次 hung 一条）。首次停摆只有引擎自己恢复（记 `stalls`），**同一节点第二次停摆**或停摆后失败预算将用尽（`failures ≥ 4`）时才给 owner 一条消息，靠 `stalled_notified_at` 保证每节点至多一次。知会文案引用的也是失败预算而不是派发次数 —— 后者会被成功的汇总轮推高，写出来是"第 7 次派发（上限 5）"。

**"活性"必须包含"正在启动"。** 续期子会话是异步物化的：节点在子 agent 存在之前就已绑定，这段几十毫秒的窗口里 `ctx.agents.get(claim)` 还没有答案。若把这种绑定读作"worker 消失"，一次落在窗口里的扫描（每个 worker 结算都会触发扫描）就会回收它、重派一次 —— 第一个 worker 还活着，它的 `submit_mission` 因为不再持有节点而全部被拒。实测代价：5 个节点的三级树跑了 **13 个 worker**（每个节点多跑一次，attempts 白烧一次）。所以 claim 从**预留起**就算 live（`startingClaims`，直到子会话接受 prompt 为止），真正的"从未出现"仍由同一条扫描在启动结束后回收。

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

master 空闲时由**任务引擎**唤醒。唤醒走 master 的 pre-step，它同时承担**过滤**与**放行判断**两件事：

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
  ready = dispatchable()                   // ready + interrupted，且其 unit 未被别的 running 节点持有（§2.4）
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

同一节点被重复派活只会由批次去重（§3.1）挡住；引擎可以安全地被多个触发源同时唤醒。派活没有副作用，重复一次最多是多起一个任务单元，而**结果写入有身份校验**（§3.3）保证不会写错节点。

---

## 五、任务单元的执行契约

### 5.1 节点 prompt 构造器

> **语言与精简口径（2026-09-16 起）**：模型可见文本一律中文（含 `refuse(...)` 的拒绝文案与工具返回；节点状态经 `statusLabel` 统一成"待执行/执行中/等待子任务/已完成/已失败/已中断"；日志保持英文），且**只讲"做什么 / 怎么做"**，不写"为什么" —— 不解释执行者看不到对话、不解释引擎为何重派、不解释配额与隔离的道理。工具名保持英文标识符。适用于四类文本：本节的 worker prompt、§6.0 的静态段、§6.1 的动态状态行、以及 9 个工具的 description 与参数说明。

每个任务单元是一次全新的子 agent 生成。prompt 由**一个按节点状态分叉的构造器**产出（同一段模板，尾段随状态变化）：

```
[续任说明]    第 N 次执行 / 上一次被中断 / 工作区可能留着改动（§9.2.2）
[变化差量]    仅冷唤醒：自你上次执行后发生了什么（无变化则整段不出现；基线未知则只有那句说明）
[任务链]      沿 parent 链 root → 当前节点，每层只给 **title + 少量基本信息**
[当前节点]    本节点的完整内容：id / title / description / context + attempts
              +「执行本任务时写下的分析」一节（有记录时才出现，见 §5.3.2）
[状态尾段]    按 node.status 分叉，见 §5.1.1
```

**「变化差量」只属于唤醒路径。** 它由 `WorkerPromptOptions.delta` 传入，只有冷唤醒（`deliverContinuation`）会传：
全新 spawn 从未执行过这个任务，"自你上次执行后"是假话，而且它本来就会读到全部纠偏、全部笔记与全部子结果 ——
两条路径在这里**刻意不合并**。差量逐分量怎么算、什么时候算"大到不该续"，见 §9.2.2。

两条设计约束：

- **节点 id 必须出现在 prompt 里** —— 任务单元只看到注入的 prompt，执行完要靠这个 id 提交结果。
- **任务链只放基本信息，不放各层的 description / context** —— 完整内容属于"当前节点"那一块。这样任务链的规模是"深度 × 一行的开销"，深度上限 8 时大约是 8 行，**结构上就不会膨胀**（因此 §9.2.2 里的 token 预算不是必需的）。

**prompt 里绝对不包含**：

- 子任务进度（"你有 N 个子任务，0/N 完成"）
- 兄弟节点或树的其他部分
- 上一次执行的**对话或过程**（两个例外：执行者自己用 `note_mission` 写下的分析，见 §5.3.2 —— 那是判断依据，不是过程；以及**它自己的会话**，见下）

这三条是硬约束。第一条尤其重要：一旦把子任务进度写进任务单元的 prompt，就会诱导它去等待 —— 这是整个设计要避免的核心故障。

> **"会话续命"与第三条的关系（2026-09-20）**：第三条说的是**prompt 里不塞**上一次的过程。会话续命不违反它：
> 被唤醒的执行者拿到的仍然是同一个 `buildWorkerPrompt`（子结果 + 本轮指令），只是这条消息投给它**自己**那个
> 会话，于是那段过程在它的上下文里自然存在，而不是被人为召回。区别在于"过程是否被复制到 prompt"，而不是
> "过程是否存在" —— 后者是会话自身的属性。见 §9.3。

### 5.1.1 状态尾段（对应原设计的 TempLayer）

尾段按**节点当前状态**分叉，每次派活现取现构造：

| 节点状态 | 尾段内容 |
|---|---|
| `ready`（无子任务，首次执行）| 执行职责：尝试完成任务；若缺前提则**先 `note_mission` 写下这次分析，再** `decompose_mission` 拆解。两种合法结局见 §5.2 |
| `ready`（**子任务全终态**，即待汇总）| 各子任务提交的结果 + 一句提示：**"所有子任务都完成，先读「执行本任务时写下的分析」，再分析任务是否已经完成；还缺则先 `note_mission` 再继续拆分，否则总结任务提交给父任务"** |
**没有 `failed` 尾段**：失败节点是终态、`DISPATCHABLE` 不含 `failed`，所以它永远不会被派活 —— 失败由指导层 + 唤醒上报给 master（§7.0），而不是靠一段 prompt。

**这就是原设计里 TempLayer 的作用**（`Message(Role.SYSTEM, ...)` 那类一次性注入），但在本插件里有两点更好：

1. **它不进任何会话历史** —— 它是 prompt 构造器的输出，只存在于这一次派活的输入里
2. **它天然不会重复** —— 每个任务单元都是新 spawn 的新会话，所以不存在"上一次的临时提示还留在上下文里"的问题，**连清理动作都不需要**（原设计的 `TempLayer.consume()` 消失了）

**汇总不是独立角色**：它就是"节点处于 `ready` 且子任务全终态"时的那次派活，用的是同一个构造器、同一类执行者。所以文档里不存在"汇总者"这个实体。

### 5.2 执行者的两种合法结局

```
任务单元拿到节点
  ├── 先尝试执行
  │     ├── 做成了            → submit_mission(节点, 结果)          → 结束
  │     └── 撞上前提缺失      → note_mission(节点, 这次为什么拆)
  │                            → decompose_mission(节点, [子任务…])  → 结束
  └── 从不等待、从不持有
```

**先尝试、撞墙才拆** 是有意的顺序：对本来就是叶子的任务，先分析一遍是纯开销；拆解只在有真实失败输入时才发生。`note_mission` 与 `decompose_mission` 是**同一次派活里的两步**，不是两个结局 —— 见 §5.3.2。

### 5.2.1 两个终态工具互斥（机制级，不靠提示词）

两个工具互斥的判据是**子任务是否还有未终态的**，不是"有没有子任务"。放进工具实现里就自动成立 —— 工具执行时能拿到调用方的 agent（`exec.agent`，含 session id），校验与写入都在树锁内：

```
submit_mission(node, 调用方):
  持树锁:
    校验调用方 == node.claimed_by
    校验 status 非终态 且 没有未终态子节点     ← 「有待办子任务」才拒绝
    落盘超长结果（有后端则存全文 + 记住取回指引）
    置 done + result
    成功时 concludeTurn()                      ← 终止该 worker 的当前 turn

decompose_mission(node, children[], 调用方):
  持树锁:
    校验调用方 == node.claimed_by
    校验 status 非终态 且 没有未终态子节点     ← 首次拆解与「汇总后仍缺前提」都合法
    校验 analysis_attempt == attempts          ← 这次派活必须自己写过分析（§5.3.2）
    建子节点（含去重）→ 按子节点终态情况置 ready / blocked
```

**为什么判据必须是"未终态"而不是"为空"**：子任务全终态的那次派活就是**汇总**（§5.1.1），它的两种合法结局正是"提交结论"与"继续拆解"。若把"有子节点"一律拒绝，任何拆解过的节点都会两条出口全封死 —— 只能靠 attempts 耗尽变成 `failed`，树永远收敛不到 `done`。

两个方向仍然都被堵住：

| 情况 | 结果 |
|---|---|
| 先 `submit_mission` → 再 `decompose_mission` | 节点已 `done` → **拒绝**（终态不可拆解）|
| 先 `decompose_mission` → 再 `submit_mission` | 未完成的子任务还在 → **拒绝**（有待办子任务不可提交）|
| 汇总态先 `decompose_mission` → 再 `submit_mission` | 新子任务未终态 → **拒绝**（同上）|
| 没 `note_mission` 就 `decompose_mission` | `analysis_attempt != attempts` → **拒绝**（`analysis-missing`，零副作用）|

**同一批次并行调用也安全**：两个工具的实现都持同一把树锁，谁先执行谁生效，另一个看到已变的 `node.status` 自然被拒 —— 不需要"同一批次只能调一个"的额外检查。

**提示词只作为引导**（§5.1.1 的尾段说明两种结局二选一），正确性由上面的状态机保证。

### 5.3 拆解时写入的内容

`decompose_mission(node, children[])` 中每个子任务至少包含：

| 字段 | 要求 |
|---|---|
| `title` | 一句话，陈述要做的事 |
| `description` | 具体到可执行 |
| `context` | **拆解原因** —— 为什么当前任务需要它。这是子节点继承"纵向为什么"的唯一途径 |

`context` 不能省。子节点看不到兄弟、看不到整棵树，它理解自己存在意义的唯一来源就是这条链条。

**根节点的 `description` / `context` 由 `create_mission` 的 `analysis` 写入**（§7.2）—— master 的初步分析就是这么传下去的。

**数量与深度校验**（§9.2）：一次至多 **6 个**子任务；树的深度上限 **8**。校验在 `decompose_mission` 的入参处理处完成，超限即拒绝该次调用（不改节点状态）。

### 5.3.2 拆解分析：`note_mission` 与 `decompose_mission` 的门禁

**问题**：一次派活就是一个新会话，做完就消失；而"这次为什么还缺、拆出去的子任务要拿回什么"只存在于那个执行者脑子里。汇总轮是**又一次全新派活**，它读的是节点 prompt —— 如果节点上没有留话，它就只看得到子任务的结果，看不到上一轮判断这些结果的依据。

**做法**：执行者用 `note_mission(node_id, analysis)` 把这次派活自己的判断写进节点：

> **要写什么（2026-09-20 补充）**：缺什么前提、**已经排除了哪条路以及为什么**、前置任务完成后要判断什么。
> 补「排除」这一条的理由是**渐进逼近靠排除**：下一次执行这个节点的会话是全新的（§5.1），它只能从这份记录
> 与子任务结果重建判断；若只写"缺什么"，被否掉的路会随会话一起消失，下一轮可能重走一遍。这句话出现在
> **三处模型可见文案**里（执行者 prompt 的拆解路径与汇总路径、`note_mission` 的工具描述），必须一致 ——
> 它不依赖「会话续命」提案能否落地，独立成立。

```
note_mission(node, 调用方, analysis):
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
| **门禁** | `decompose_mission` 校验 `analysis_attempt == attempts`，不等就 `analysis-missing` 拒绝，**且在任何副作用之前**（不建子节点、不消耗 attempt、不释放持有）。所以"先拆、后补分析"不可能发生 |
| **归属** | 检查的是**本次派活**写的分析，不是"节点上有没有分析"。汇总轮继承了上一轮的备注也不算数 —— 它必须自己说清这一轮为什么还缺 |
| **可见性** | 分析渲染成「本任务」块内单独一节，**在子任务结果之前**（§5.1）。它是读那些结果的前提，所以顺序是语义要求，不是排版偏好；没有记录时整节不出现 |

**为什么分析不写进 `context`**：`context` 是拆解者写给**子节点**的"纵向为什么"，作者是父节点；`analysis_notes` 是执行者写给**本节点后续派活**的判断，作者是本节的执行者。作者与读者都不同，混在一起会让"这个子任务为什么存在"和"上一轮判断缺什么"互相污染。

**为什么不直接放开、让模型自觉写**：`note_mission` 与 `decompose_mission` 是**同一次派活里要求的两步**，靠提示词纪律只能得到"大多数时候写了"。做成门禁后，"拆解必须有理由，且理由必须是这一轮的"变成机制：模型忘了写，`decompose_mission` 会带着 `analysis-missing` 和下一步怎么做一起拒回来，它当场补一次 `note_mission` 即可继续。

**模型面工具数 9 → 10**：`note_mission` 属于 **executor 面孔**（owner 看不到，worker 看得到）—— owner 不持有任何节点，调用只会被 `not-owner` 拒。见 §5.5。

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

**阈值与摘要是本插件自己的策略**，不接 `dsh-spill-policy` 的全局按字节策略：后者作用于所有工具结果，而"什么时候摘要、摘要怎么写"是我们对任务结果的语义判断。`spillStore` 只当作存储后端用。

### 5.4 出口与结果通道

任务单元通过停止产生工具调用来结束（DSH 的常规 agent 回合语义，无需特殊处理）。

**结果只走树，不走消息。** 派活时用工具限制摘掉 worker 不该有的能力：

```yaml
toolFilter:
  deny:
    - send_message          # 摘掉消息回传
    - subagent              # 摘掉委派 —— 任务推进只能由任务引擎进行
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
| 六个 owner 工具（`create_mission` / `adjust_mission` / `mission_result` / `list_missions` / `finish_mission` / `cancel_mission`） | 执行者用不上它们（调用只会被 `no-authority` / `not-owner` 拒），而读到全树会让它看见兄弟节点进度 —— 与 §5.1 刻意不给 worker 兄弟进度的意图冲突（见 §5.5）|

**`note_mission` 不在摘除之列**：记录本轮自己的分析正是执行者的本职，而且 `decompose_mission` 会拒绝一个没写过分析的拆解（§5.3.2）。它属于 executor 面孔。

**已知缺口：`workflow` / `ralph` 没有被摘。** 上面第二行的理由（"worker 不能自己 spawn 一个不在树上的执行者"）对这两个工具同样成立 —— `workflow` 的 `agent()` 与 `ralph` 的每一轮都会起子 agent，它们不在树上、结果不回填节点、失败无人回收，递归也绕开节点配额。当前 deny 列表只有 `send_message` / `subagent` / `subagent_fork` / 三个 goal 工具，所以**隔离只覆盖了主要几条路，不是密不透风**。要不要一并摘掉是个取舍：摘了隔离严密，代价是节点内部无法再自行扇出（见下）。

> **决定（2026-09-20）：不摘，保持现状。** 口径是「worker 怎么做子任务是 worker 的事，引擎只关心任务结果」。
> 引擎对 worker 的契约只有一条 —— 最终凭 `submit_mission` 把结果交回它持有的那个节点；节点内部用什么手段
> 扇出（串行、`decompose_mission`、还是 `workflow` / `ralph`）属于执行者的自由。代价如实记录：worker 自发的
> 子 agent 不在树上、不占并发配额、失败不由引擎回收，所以「引擎是唯一派活者」这条不变量**只在树这一层成立**，
> 不延伸到 worker 内部的自发扇出。**补充（2026-09-20）**：这条决定的"记账入口"已经落地 —— §9.2 的单树节点
> 上限（`CAPACITY.maxNodesPerTree = 200`）现在是硬约束，`decompose` 超限即拒。它不能把 `workflow` / `ralph`
> 起的子 agent 拉回树上（引擎根本看不见它们），但保证**树这一层**的节点数有天花板，而不是只靠"深度 8"这个
> 要到第八层才生效的限制。若将来要把内部扇出也计入，先让执行者把扇出规模报给节点（改动在工具面，不在 deny）。

**它挡住的是什么（若摘掉 workflow/ralph 会失去的能力）**：

| 情形 | 现在能用 `workflow` / `ralph` 做的 | 摘掉后只能 |
|---|---|---|
| 节点内部要处理 N 个同构条目（如"审 12 个模块的导出面"） | `pipeline(items, …)` 并发跑完并汇总 | 自己在单会话里串行做完（慢、上下文膨胀），或用 `decompose_mission` 拆成子节点 —— 但**每次至多 6 个**且**有未完成子任务时不能再拆**，于是要分轮：先拆 6 个、等它们终态、汇总轮再拆下一批，中间多烧一次 attempt |
| 需要结构化、被 schema 校验的中间结果 | `agent(prompt, { schema })` 拿到校验过的对象再汇总 | 树的结果通道只有 `submit_mission(node_id, result: string)` 一个**字符串**，只能自己拼 JSON、无校验 |
| 需要互不影响的独立视角（"三种意见再裁决"） | `parallel([…])` 起三个彼此看不见的 agent | 自己在一个上下文里问三遍（不独立、互相污染），或拆子节点（prompt 由引擎生成，不能像 workflow 那样精确编排每条的 prompt/schema） |
| 反复迭代到判据满足、且每轮要干净上下文 | `ralph` 的新鲜 agent 轮次 | 引擎式的重派是**引擎在失败/卡死时**给的（失败预算 5，成功的汇总轮不消耗），不是 worker 能主动要的循环 |

**`send_message` 的摘除有一个额外效果**：那段"完成后用 `send_message` 把结果发给父 agent"的引导是**条件追加**的 —— 子 agent 作用域里存在该工具才附加，否则 prompt 原样。所以摘掉它，**冲突文本根本不会被生成**，比让模型在两段矛盾指令间做选择可靠得多。工具名是包内硬编码常量（非配置项），deny 列表里写字符串即可。

**工具限制的契约**（`SubagentStartRequest.toolFilter`）：in-process 后端把它作为子 agent 创建窗口内的 scoped `tools.restrict()` 应用，**被点名的工具从子 agent 的 prompt 里消失，并且拒绝执行**（一处可见性），未知名字会明确报错。

### 5.5 两张工具面孔

工具族按调用方分两半，注册是一次、可见性是两套：

| 面孔 | 判据（与 `create_mission` 的授权判据同源） | 看得见 | 看不见 |
|---|---|---|---|
| **owner** | 非子代理会话 | `create_mission`、`adjust_mission`、`mission_result`、`list_missions`、`finish_mission`、`cancel_mission` | `note_mission`、`decompose_mission`、`submit_mission` |
| **executor** | 子代理会话 | `note_mission`、`decompose_mission`、`submit_mission` | 上面那六个 + `send_message`/`subagent`/`subagent_fork`/三个 goal 工具 |

**为什么要有这张表**：不做的话每个 agent 的 schema 里都带着另一半用不了的工具 —— 更糟的是"可见但必然被拒"：`create_mission` 对执行者是 `no-authority`，`note_mission` / `decompose_mission` / `submit_mission` 对 owner 是 `not-owner`。另外，worker 能读到别的节点（`list_missions` / `mission_result`）与 §5.1 "worker 的 prompt 不含兄弟节点进度"的意图相矛盾 —— 一个能看到兄弟进度的执行者，可能会去等它们。

**两个机制，因为两种 agent 出现在不同时刻**：

- **executor** 由本插件创建，面孔随派活请求走（`SubagentStartRequest.toolFilter.deny`），也就是 harness 给任何被委派子会话施加的那个 scoped `tools.restrict()`；
- **owner** 在插件派活任何东西**之前**就存在，所以面孔在 agent 出现时施加（`agent/created` → `agent.ctx.tools.restrict()`），并以组装瀑布（`system-prompt/assemble` 里按 `context.agent` 过滤 `assembly.tools`）兜底 —— 这一半是无状态的，覆盖"插件挂载前就已经存在的 agent"。

注意 `tools.restrict()` **要求 scoped context**：在全局 ctx 上调用会直接抛错（harness 明确拒绝"全局限制"这种做法），这与上表里"按面孔区分"是同一件事的两种说法。disposer 按 agent id 保存、`agent/disposed` 释放、插件卸载时一并释放；名字先用 `tools.get(name, agent)` 预过滤（`restrict()` 遇到未知名字会抛，一次抛出就是 owner 的一整轮代价）。

**遮蔽不是授权。** 这两半只管"模型看不看得见"；真正的边界仍是工具体内的拒绝（`no-authority` / `not-owner`），所以即使某张面孔写错、模型幻觉出名字，调用照样被拒。`test/faces.spec.ts` 有一条不变量测试：**每个注册的工具必须恰好落在一张面孔里** —— 新增工具不归类就会失败。`note_mission` 只被放进 owner 的 deny 列表，不进 worker 的：owner 拿一个必然被拒的工具是噪音，worker 缺了它则拆解根本无法通过门禁（§5.3.2）。

**owner 也看不见任务内部（2026-09-20）。** 面孔的另一半同样收紧了：`show_work`（逐个节点列出整棵树，带 `depth` / `parent_id` / `attempts` / `result_ref`）已删除；`list_missions` 与每轮的进度行（`buildProgressLine`）都只报"还在跑 / 反复出过问题"，不再报逐状态计数。判据是**这条信息能不能支撑 owner 的动作**：owner 只有 `adjust_mission`（只对根有效）与 `cancel_mission`（只吃根 id），没有任何对节点动手的工具，所以节点级的结构、派发次数、剩余失败预算都是"看得见却动不了"的信息 —— 引擎的重试策略不属于 owner（§6.0 已按同一理由不写进静态段）。**"出过问题"是例外，也是唯一例外**：它是 owner 唯一能据此做决定的引擎事实（改方向，或者放弃），判据是引擎的 `isTroubledNode`（`core/src/prompt.ts`）—— `stalls >= maxStallsBeforeReport`、`failures >= maxAttempts - 1`、`spawnFailures >= maxAttempts - 1` 三者之一，`isTroubled` 就是它加上"还没结束"这个过滤。**这一个判据现在真的被三个渠道共用**：`list_missions` 的标记、静默回收的 heads-up（`reportStall`）、以及**起不来执行者的 heads-up**（宿主在派发失败处投递，同一个门槛、同一个"只报一次"的持久标记）。三处此前并不一致：`isTroubled` 算 `spawnFailures` 而 `reportStall` 的门槛不算，于是一个连续起不来执行者的任务会在 `list_missions` 里读作"反复出过问题"，却永远收不到一条消息 —— 起不来的节点从不是 `running`，而静默扫描只看 `running`。`/mission` 命令与"任务"面板仍按节点渲染 —— 那是给人看的诊断面，不是模型面。

**2026-09-23 修订：一次独立核对修掉的四处。** 一件真实任务（"工具面完整性核对：参数 × 校验 × 拒绝码"，拆成 4 个前置任务、汇总交出报告）把四个读写边界上的不一致挖了出来，都改了：① `no-caller` 并入 `RefusalCode` —— 九个工具都会产生它而码表里没有，按 union 穷举的消费者会静默漏掉；② 纯空白文本不再能落库 —— `submit_mission` 的结果、`adjust_mission` 的纠偏、`create_mission` 的标题与内容都补上 `blank-text` 拒绝，且**分层不变**：工具层只拒真正的空串，空白由引擎判（与 `note_mission` 的 `no-analysis` 同源，否则这些码就没有可达的产生点）；③ 三个 owner 工具对同一个子任务 id 统一回 `not-root`，`finish_mission` / `cancel_mission` 原先按 ROOT 查表，把"这不是根任务"说成"任务不存在"；④ `isTroubledNode` 抽成唯一判据，并给"连续起不来执行者"补上 owner 提醒（见上）。

**2026-09-21 修订：`stuck` 曾把"历史"说成"现值"。** 首版 `isStuck` 用 `stalls > 0 || failures > 0 || spawnFailures > 0`，而 `stalls` / `failures` **只增不减**（`tree.ts` 无复位路径；只有 `spawnFailures` 会在启动成功时清零）—— 于是一个 worker 掉线被回收、重派后跑得好好的任务，此后余生每轮进度行与每次 `list_missions` 都读作"卡住了"，直到整棵树终结。`list_missions` 是**当下的读**，这是假陈述；而 owner 的两个动作都有破坏性（`adjust_mission` 会作废未完成子任务并整体重规划，`cancel_mission` 直接停掉），一个永不复位的旗标会引诱它对健康任务下手。修法两条一起上：①**判据抬到引擎自己的门槛**（见上），一次打嗝不再算数；②**措辞改成历史**（"反复出过问题"），标识符随之改名 `stuck` → `troubled`，让代码也不再声称现值。真正的"现在卡着"是另一个信号（被回收且尚未重派），本项目仍**不做**实时判读 —— 那需要时钟，而引擎的 heads-up 已经在承担这件事。

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

**加这一段的原因**：§7.1 的判据此前只写在 `create_mission` 的工具描述里 —— 工具描述用来讲机制，策略却要靠模型自己从工具清单里读出来。策略属于系统提示词。

| | 内容 |
|---|---|
| 注册 | `ctx.systemPrompt.section({ name: 'avantf:mission-tree-guide', order: getSectionOrder('TOOL_WORKS') })` |
| 可见性 | 与 `create_mission` 的授权判据**同一个函数**（`host.canCreateTree` = 非子代理会话）。worker 拿不到 `create_mission`，所以 provider 对它返回空串，组装器丢弃空段 —— 不教一个调用者没有的工具 |
| 静态而非每轮 | 它讲的是"这件事该不该变成树"和"执行者看不到这段对话"，两件事在任何树存在**之前**就成立；树一旦存在，由 §6.1 起的动态层接管 |
| 位次 | 放在 `TOOL_WORKS`（工具指导区），因为它就是"一个工具族怎么用"；不占用 persona 位 |

**文本里刻意不出现**（知道也没用，或不该知道）：

| 不写 | 理由 |
|---|---|
| 节点状态词表（`ready` / `blocked` / `attempts`）、回收与扫描 | owner 从不依据节点状态行动，重试策略是引擎的事 |
| `decompose_mission` 与 worker 的指令 | owner 调不了它（节点由持有它的执行者拆解），教了等于教一个不存在的工具 |
| id、存储、Remote 面、任务面板 | 模型无法据此行动 |
| 读结论 / 收尾机制（`mission_result` / `finish_mission`） | 动态层在唯一有意义的时刻（树存在时）才说；静态段说了就是重复占预算 |

**它会点名兄弟委派工具**（`subagent` / `subagent_fork` / `workflow`），这与上面"不写"的原则不冲突 —— 树与"起一个子 agent 去干活"在**"交出去、别人做"**这一点上重叠，而决定用哪个的差别恰好是"执行者是一次性的、跑起来就联系不上、看不到这段对话"。不写这句，owner 面对重叠只能自己猜；写了，它是一个可执行的选择。同一个边界也写在 `create_mission` 的工具描述里（决策发生的地方）。

测试（`test/guidance.spec.ts`）既断言它说了什么（任务的定义与建法、谁在等、**与普通委派的边界**、任务/任务树的用语），也断言它**没说什么**（一张禁用词表），worker 视角为空串。

**正文是用户可编辑的**：正文放在**家族共享**的 `<data home>/prompts/mission-tree-guide.md`（`data home` = ⑤ 显式实参 → ④ `$AVANTF_HOME` → ② 插件配置 `dataHome` → `~/.avantf`；同目录下记忆插件用 `mem-*` 前缀，各插件只动自己前缀的文件）。插件在 `apply` 里**只读一次**（改完重启 `dsh` 生效）：缺失或空白会被原子写入上文的常量作为默认，有内容则**逐字注入**（去首尾空白、剥 BOM、CRLF→LF）；文件不可读写只告警并退回默认，**绝不阻断挂载**。**文件只提供正文**——段名与位次由 `index.ts`（`getSectionOrder('TOOL_WORKS')`）决定，`PROMPT_FILES` 只管"哪个文件对应哪段"，清单外的 `.md` 被忽略且不报错。因此 `guidance.spec.ts` / `wording.spec.ts` 的硬守卫（禁用词表、只说自己插件的工具、worker 视角为空串）**只守内置默认**；用户文本另由 `guidanceTextWarnings` 做一次软检查并 warn（超预算、命中「任务树/子树/节点/树」这类形状词），不截断、不拒绝。ensure/read/fallback 这套流程由底座的通用件 `PromptFiles` 提供（`base/plugin-base/src/kit/prompt_files.ts`），插件在运行时从**加载到的底座**上取（`kit?.PromptFiles`），底座缺席时退回内置正文。放在底座而非 `mission-core`，因为引擎刻意不带 Node 类型。

### 6.1 目标与约束

让 master 在与用户的对话中**时刻能看到任务状态**，从而"视情况"总结。机制用提示词注册表的运行时上下文；本插件负责的是**文本怎么写**。

DSH 的运行时上下文快照是**持久**的（内容变化时追加一条，旧值留在历史里直到被压缩遮蔽）。因此文本组织不是风格问题，而是**正确性约束**：

> 每一段写进指导层的文本，都必须能经受"被当成过期信息读到"。

### 6.2 锚定分段 —— 增量/差分的写法

三类内容分开，每类自带锚点，锚点保证过期后仍然成立：

| 段 | 写法 | 为什么过期仍安全 |
|---|---|---|
| **聚合进度** | `本树：3 进行中 / 1 待汇总 / 根未收敛` | 陈述**过去某一刻**的状态，不声称是"现在"；且它语义上会被后一条取代 |
| **增量变化** | `自上次汇报，节点 a3f 已完成；节点 b71 被回收` | 显式锚在"自上次汇报"，**过期后是一句历史陈述，不是错的事实** |
| **动作指引** | `需要完整结论时读取 mission_result(node_id)` | **条件式指令**，与时间无关，过期永远成立 |

反例（**不要写**）：

| 反例 | 问题 |
|---|---|
| `当前有 3 个任务进行中` | 用"当前"锚在现在，过期即假 |
| `待办从 3 变成 2` | 差分但无锚点，过期后不知何时的事 |
| `下一步应该做 X` | 用"下一步"锚在未来，过期后是错误指引 |
| `耗时 3 分钟` | 时钟量，每次组装都不同 → 去重失效 |

### 6.3 两条实施纪律

1. **状态没变就返回完全相同的字符串** —— 框架按文本去重，相同文本不产生新事件。任何会抖动的字段（时间戳、耗时、计数器按秒变化）都会让去重失效并持续追加快照。
2. **只给索引，不内联结论** —— 节点结论通过工具按需拉取，不要塞进指导层。

### 6.4 两条上下文的优先级

待办的优先级高于任务树，用两个不同的渲染位次表达（待办在前）：

```
待办（优先级高）：order 较小
任务树状态      ：order 较大
```

"待办优先"是提示词里的语义约束，在文本里写明；机制上只体现为渲染先后。

### 6.5 补充：引擎向 master 的唤醒只发信号

根任务进入终态时引擎唤醒 master，**唤醒消息只带信号，不带内容** —— 内容由指导层提供（它每次组装都读当下状态）。避免同一条信息在"引擎的消息"和"指导层"两处各存一份、可能不一致。

唤醒走 §4.2 的 pre-step 通道：消息只负责让 pre-step 有机会跑起来，是否真的进入 LLM 回合由引擎的状态判断决定。

---

## 六点五、worker 会话日志的归档与清理

worker 是真实会话，所以磁盘占用随派活次数线性增长（本机实测每会话约 40 KB）。两条命令，**两种不同的接口可行性**：

| 命令 | 走什么 | 可行性 |
|---|---|---|
| `/archive` | `workspaceRegistry.archiveSession(id)` | **官方接口**：durable 写进 registry 的归档集合，可 unarchive。只改标记，**不释放磁盘** |
| `/clean archive all\| <mission-id>` | 直接删会话目录 | **没有任何官方接口**：`SessionPersistence` 只有 `create`/`open`/`list`/`stat`，没有 delete；GUI 只有归档。所以只能由插件删目录 |
| `/clean orphans all\| <root-id>` | `tree.destroyTree()` | 删的是插件**自己的**树记录：owner 会话已不存在或不可观测时才允许，删除前逐个重新探测 |

护栏（`src/workerSessions.ts`，见该模块注释）：

1. **只认自己的 worker**：claim id 形状 `mission-<8 hex>`（`reserveClaimId`）+ 头里 `origin: subagent` / `delegationDepth: 1` / `parentSession` == 本会话。harness 自己的委派用 uuid，天然区分；
2. **绝不动在跑的会话**（`live` 为真或 `agents.get(id)` 有答案就跳）；
3. **`/clean archive all` 只删已归档的**：这样"丢弃"总是一个有人明确做过的决定；要跳过这道闸必须显式点名一个 id；
4. **路径只按名字找、不做编码复刻**：在 `config.sessionsRoot`（默认 `<dsh home>/sessions`）下扫 `*/<id>`，目录名必须**正好**是 session id。harness 的目录名有 slug 编码规则（`projectKey`/`encodeSegment`），复刻它就会在下一次编码变更时静默失效 —— 因此根给错或布局变了时的结果是"删不到"，而不是"删错"。

**为什么不把删除做进引擎的常规回收**：删的是**另一个子系统的持久数据**（会话存储），不是本插件的树记录。引擎的日常职责只到"节点解绑、活 Agent 由 harness 在结算时销毁"；删日志必须是一个人类明确的手势，所以它是一条 slash，而不是自动清理。

## 六点六、纠偏：把"停下再重派"换成一条消息

任务派出去之后 master 会停下来；用户再开会话讨论时才发现方向要改。没有通道时只有一条路：`cancel_mission` 结束、再 `create_mission` 重来 —— 已做完的部分全部作废。两条新工具把这件事变成"发一条消息"：

| 步骤 | 谁做 | 语义 |
|---|---|---|
| `adjust_mission(root_id, adjustment)` | owner | **只对根任务**：纠偏写进该节点的 `corrections`（持久，之后每次派发都渲染），若此刻有执行者在跑就 `subagents.sendMessage` 直接投递给它 |
| 作废未完成的下级（含其下级） | **引擎** | 纠偏落地后自动执行：记为失败 + 锁内收集并打断在跑的执行者 + 重算所有父节点 → 该任务立刻回到汇总轮按新方向重新规划。**已完成的不受影响** |

**为什么作废不给模型一个工具**：`cancel_subworks` 作为模型工具只存在过一个提交，随后按"这不是一个决定、而是方向变了的机械后果"删掉 —— 与删掉 `reclaim_work` 的理由同源（回收/作废都是引擎的日常职责）。给 master 第二个动词只会多出一种半成品状态：纠偏差了、旧方向的活还在烧模型调用。能力本身保留为引擎原语（`MissionTree.cancelSubworks` + 宿主方法），只是模型面看不到它。

**为什么要"同时记录"**：根任务一生中大部分时间在等子任务（`blocked`、没有持有者），而**每次派发都是全新会话**。只投递消息 = 那一刻没人收就永远丢了；只记录 = 已经跑着的这次执行者看不到。两条都做：记录保持久，投递保"这一次就生效"。

**记在哪里：`NodeRecord.corrections`，不是 `context`。** `context` 是拆解者写的"为什么存在这个任务"，纠偏是 owner 对已经派出去的活的指令 —— 作者与生命周期都不同；混在一起时任务链只渲染 `context[0]`，于是纠偏永远排在 index ≥ 1、**对任何后代都不可见**（这正是实现过程中被审查抓到的一条 P1）。现在：纠偏写进独立的 `corrections`，当前节点以独立的"纠偏:"块渲染，而**任务链把每一层的纠偏一并带出**来 —— 链是唯一能到达每一次派发的通道，所以根上写的纠偏会跟着链走到任何后代。

**2026-09-23 修订：纠偏写给了执行者，却没写给查看者。** 上一段的通道只覆盖"执行"这一半：面板的行/详情与 `mission_result` 只渲染 `title` / `description` / `result`，而标题是**创建时**的目标 —— 被纠偏过的任务因此读起来是"目标 X、结果 Y"，中间空无一物；纠偏在库里，却没有任何查看面读它（`/mission` 的索引行同样没有）。四个面一起补上：快照的行投影（`NodeView`）带 `corrections`，行上渲染"已纠偏 N 次"标签、文本挂 tooltip；`detail`（`NodeDetail`）在"任务内容"与"本任务提交的结果"**之间**给出完整"纠偏"块；`mission_result` 把纠偏列在结果之前、`data` 里再带一份；`/mission` 的索引行只报次数。**目标本身不改写** —— 纠偏是叠在原始目标旁边的历史；直接改写 `title`/`description` 会把"当初要什么"抹掉，而回溯要的正是两者对照。行投影自此带上了"行只放渲染得到的东西"之外的一个字段，判据是它必须在**折叠状态**下可见、且文本短条数少。守卫：`correction.spec.ts` 的 "a correction is readable back" 三条、`client-view.spec.tsx` 的行标记与详情顺序两条。

**作废为什么不需要持有者**：状态机决定了这一点 —— 一个节点**有未完成子任务时必然是 `blocked`、且没有持有者**（`decompose` 会释放 claim），所以"持有者取消自己的子任务"落不到任何可达状态上。真正会发生作废的时刻，是 master 在后续会话里调整了方向、而根正在等子任务；此时只有 owner 能动手，所以内部原语的授权是"树的所有者，或持有该节点的执行者"（对称），后者不会有未完成子任务可作废。

**边界**（都在机制层拒绝）：只认根任务（给子任务发会被 `not-root` 拒 —— **三个 owner 工具同款**：`adjust_mission` / `finish_mission` / `cancel_mission` 对同一个子任务 id 都给 `not-root`，后两者原先按 ROOT 查表、把"这不是根任务"说成"任务不存在"）；已结束的任务不能调整（`terminal`）；纯空白的纠偏同样被拒（`blank-text`，见 §5.x 的 2026-09-23 修订）；作废只向下走 —— 任务本身、它的父任务、兄弟任务都动不了，要结束整棵树用 `cancel_mission`；作废后**重算所有被改动节点的父节点**，否则共享前提的另一个分支会永远卡在 `blocked`（这条是被测试逼出来的第一版 bug）。

**子任务执行者的改正路径**：汇总轮是全新会话，读到背景里的纠偏后**直接重新 `decompose_mission`** 即可（此时没有未完成子任务，拆解本来就允许）—— 不需要先"取消"。

## 七、master 侧：建根、收尾与目标的关系

### 7.0 根任务的完成与收尾

```
根节点进入终态（done 或 failed）
  → 节点 result_read_at = null（未读状态）
  → 引擎唤醒 master（走 §4.2 的 pre-step 通道，只发信号，不发内容）
  → master 被唤醒时，指导层已带上树状态
       ├── 视情况向用户总结（对话能力，不属本插件）
       └── 读结果后调用 finish_mission（收尾）

**唤醒只发生在"根进入终态"**：`failed` 与 `done` 都唤醒（否则树会在后台悄悄死掉）。
根 `ready`（待汇总）**不唤醒** —— 汇总本身就是一次派活（§5.1.1），引擎自己会派，不需要 master 参与；
唤醒它只会多花一次 LLM 回合。
```

**回调粒度是"根进入终态"，不只是"根 ready"**：根 `ready`（待汇总）需要唤醒（汇总后的判断可能要 master 参与），根 `failed`（反复拆解不收敛、子任务全失败）**也必须**唤醒 —— 否则树在后台死掉，用户永远不知道。

| 环节 | 归属 |
|---|---|
| 建根（`create_mission`） | master，**且只允许顶层会话**（§10.1）|
| 拆解 / 提交（含根汇总） | 任务单元 |
| 收尾（`finish_mission`，受"读后方可收尾"门控） | master |

`finish_mission` 是**归档**：节点、结果、读取都不动，只是这棵树退出引导层与唤醒判断（`tree.closed_at`），
所以 `done` 与 `failed` 两种终态根都能收尾 —— 一个失败的树同样需要上报后退休。

### 7.1 master 的第一个职责：判断"是不是任务"

master 在一轮会话里，**不能假定用户发来的就是任务** —— 它有可能只是对话、一个问题、一次澄清。同时任务也可能**不由用户消息发起**：master 在对话中自己发现"下一步要执行的事"需要多轮才能完成。

所以判断有两类来源，共用一条判据：

| 来源 | 例子 |
|---|---|
| 用户消息 | "把这个模块迁移到新接口" |
| **master 自己在对话中发现的下一步** | 意识到"要改这个，得先把所有调用方找出来" |

**判据（可操作版，2026-09-21 修订）**：这是一件**可以交出去的"任务"**吗？判据是**能不能连验收标准一起交出去**，不是"这件事复不复杂"。

| | 动作 |
|---|---|
| 独立的任务、需要调研的、多步的、要跑一阵的、逐步分解的、碰多个文件/系统的 | **建任务**（`create_mission`） |
| **已经想清楚、只要照单做完再交回结果的**（缺陷已定位到 文件:行，步骤与验收标准都定好了） | **同样建任务** —— 不需要拆，就是一个执行者一次做完，代价与自己做一次相当 |
| 必须看见本对话、需要追问、需要脚本化扇出的委派 | 不建任务，用 `subagent` / `subagent_fork` / `workflow` |

修订点：早先的措辞是"能不能在当前这轮对话里做完 → 能就不建根"。这条被**去掉**了 —— 一件较独立的任务即使在一轮里也能开始，交给引擎执行是正当用法；判据落在"是不是一件可交出去的任务"，而不是"一轮能不能做完"。

**2026-09-21 修订：把"已经想清楚"从排除理由里拿掉。** 此前的资格清单全是"复杂度"特征（调研 / 多步 / 逐步分解 / 碰多文件），于是"缺陷已钉到 文件:行 + 复现命令 + 验收标准、只要照单改完"这类任务被读成"不够复杂 → 不用建任务"，master 转而手起执行者。这个推理在两层上都不成立：①**判据本来就该是"可交付性"** —— 边界清晰、验收明确的任务恰恰是交出去最稳的一类；②**代价被高估** —— 不需要拆解的任务就是一次派发（一个执行者一次做完，见 §5.4 的派发路径），与 master 自己安排一次执行同量级，而它换来跨会话持久化、结果落盘、失败自动重派。同时在 `adjust_mission` 一段补了一句"没有未完成的子任务时，它就是一条投递给执行者的消息" —— 不拆解的任务没有可作废的子任务，纠偏代价反而最低。守卫测试：`guidance.spec.ts` 的 "admits an independent mission" / "says a correction reaches the executor"，以及 `command.spec.ts` 对 `create_mission` 描述的同款断言。

**同日再修订：静态段只讲"何时用"，不碰"内容"与"参数"。** 上一版顺手写进去的两句都拿掉了：①"任务的内容是实现与验证，不可逆的对外动作（发布、推送、删除）留给你自己做" —— 这是**收窄任务内容**，而 master 自己决定一件任务为了什么，读回结果是 `mission_result` 的事，静态段没有立场划这条线；②"建任务时写三样：`title` / `description` / `analysis`" —— 与 `create_mission` 的参数说明重复，而模型在**同一个请求**里就读得到那份说明。去掉后静态段从 649 字降到 525 字，且它的反引号 token 集合从 `{create_mission, adjust_mission, title, description, analysis}` 收窄到 `{create_mission, adjust_mission}` —— 这本身就是"静态段不许谈机制"的量化形式。守卫：`guidance.spec.ts` 的 "leaves the mechanics to the tool"（不得出现 `title`/`description`/`analysis`）与 "does not fence off what a mission may contain"（不得出现 `不可逆` / `发布、推送、删除`）。

**用语**：模型可见文本里，交出去的那件事叫**任务**；**任务树**只指它被逐步分解之后的状态。工具名同样不带 tree（`list_missions`）—— 从 master 的视角看只有任务，"树"是分解之后的形态，不是它要去操作的对象。

**落地**：这张判据表现在由 §6.0 的静态提示词段直接讲给模型（此前只隐含在 `create_mission` 的工具描述里）。

### 7.2 分析 ≠ 拆解

| | master | worker |
|---|---|---|
| 问题 | **这是不是任务** | **缺哪些前提** |
| 依据 | 对话上下文 + 用户意图 + 已有 goal | **实测**（尝试后撞墙）|
| 产出 | 二值：建根 / 不建根；建根时给**方向** | 带理由的子任务清单 |

master **不产出子任务结构**。它做的是"分类 + 给方向"，具体缺什么是撞出来的（§5.2）。所以 `create_mission` 的入参是：

```
create_mission(title, description, analysis)
                                  ↑ master 的初步分析（方向、约束、已确认的事实）
```

`analysis` 写进根节点的 `description` / `context`，worker 拿到根任务时**顺着已经分析过的东西继续**，而不是从零再分析一遍。这也让"根节点第一次执行时靠什么知道要不要拆"有了答案：**靠 master 已经写在节点里的分析**。

**master 的 `analysis` 与执行者的 `note_mission` 是两回事**：`create_mission.analysis` 只在建根时写一次，落进 `context`，回答"这件事为什么值得做"；`note_mission` 由每个执行者在**它那一次派活**里写，落进 `analysis_notes`，回答"这一轮为什么还缺、拆出去要拿回什么"（§5.3.2）。两者都会进节点 prompt，但只有后者受 `decompose_mission` 的门禁约束。

**推荐路径：先试做几步再建根。** 假阴性的代价是可事后纠正，而且 master 那几步产生的理解**正好成为 `create_mission` 的初步分析** —— 所以"先试试"不是浪费，它生产了根节点的输入。

### 7.3 与 `dsh-goal` 的关系

`goal` 在默认组合里是挂载的（host 服务 + `tool-goal`），因此不处理会让 master 同时看到两套"长期目标"。

**两者是两个层次，不是替代关系：**

> **goal 是"要达成什么"（意图锚点），mission 是"怎么达成"（执行结构）。**

| 维度 | goal | mission |
|---|---|---|
| 结构 | 一句 `objective` + phase | 树、依赖、结果、收敛 |
| 调度 | **不调度任务**（设计如此）| 引擎调度 |
| 写权限 | `requireDirectHuman`（人类门控）| master 建根 / worker 拆解 |
| 完成语义 | `complete`（人类决定）| 根终态 + `finish_mission`（master 门控）|

**关键约束：两者状态独立，不互相触发。** 根任务完成**不等于** goal 完成 —— 用户的验收标准可能比树更宽或更窄。goal 的完成必须由人决定。

**goal 的用处：给建根一个机械闸门。** goal 的 `create`/`edit` 要求"运行时根 agent 轮次中的直接人类消息"，这条约束正好可以当边界：

```
建根的合法来源只有两个：
  ① 本轮对话中用户直接要求的
  ② 落在某个 active goal 范围内的任务
两者都没有 → master 必须先问用户，不能自发起树
```

这把 §7.1 的判断从纯启发式变成了可核查的来源，并同时防住"发散"（树不会越界跑）和"不确定时乱建根"（不确定 → 问用户）。

**worker 侧：goal 的三件工具与提示词段都要摘掉**（§5.4）。

---

## 八、层级归属与恢复

### 8.1 两层结构

任务单元的**父 agent 就是 master** —— 只有 master 直接与用户交互，任务状态的展示、唤醒、汇报都围绕它。

```
宿主层（进程级、唯一）：
    任务树服务 + 宿主 KV 域 + 引擎（扫树 / 派活 / 回收 / 活性判断）
        ↑ 供查询
agent 层（挂在 master 的 preset 行）：
    ├── pre-step 钩子：问引擎"现在要不要放行"，并过滤子代理来源的消息
    ├── 任务树工具（create_mission / decompose_mission / submit_mission / mission_result /
    │                list_missions / finish_mission / cancel_mission）
    └── 引导层上下文（任务执行状态）
```

关键点：**pre-step 钩子不持有引擎逻辑**，只调服务、拿一个布尔 —— "引擎是纯程序"这条原则不变。引擎因此也不需要自己创建一个父 agent。

> **修订（2026-09-20，会话续命）**：pre-step 现在有**一处真实副作用** —— 在放行分支里唤醒停手的执行者
> （`host.wakeParkedWorkers()`）。这不是把引擎逻辑搬进钩子：唤醒是一次 `ctx.subagents` 投递，而它**只能**
> 在 owner 自己的轮内做，因为续期协议的 `authorizeLineage` 要求授权方是"活着的直接父会话"，而 worker 记录
> 的父会话就是 owner（见 `docs/design/2026-09-20-session-continuation-proposal.md` §4.1.1）。pre-step 在
> 此前**已经**有 inbox 副作用（`discardQueuedNotices` / `takeQueuedInput` 会 `remove` 消息），所以这不是
> 从零破例；但"在门禁里启动一个 worker"比"修剪消息"重，故在此显式记录这条权衡。

**归属与可见性**：树归**建根的那个 agent**（记在树记录的 `owner_session_id`），**其他 agent 不可见**。写入类工具（拆解 / 提交 / 收尾 / 取消 / 读结果）全部在宿主层校验归属，非 owner 一律 `not-owner`。

**命名**：注册的工具名一律带 `_work` 后缀（`create_mission` / `adjust_mission` / `decompose_mission` / `submit_mission` / `mission_result` / `list_missions` / `finish_mission` / `cancel_mission`）。本文叙述里出现的"拆解 / 提交"等简称指同一操作；**给模型的文本（工具描述、worker prompt、引导层）必须写注册名**——worker prompt 曾经写成 `decompose` / `submit_result`，两个都不存在，现在有测试盯着这一点。

**owner 工具对 worker 不可见**（§5.5 的两张面孔把它变成了机制，不再只是意图），靠的是两个机制叠加（见 §10.1 的实施口径）：
宿主平面注册一次 + **`create_mission` 拒绝非顶层会话**。后者是必须的：worker 若能建根，就等于造了一个引擎看不见的执行者
（没人给它派活、没人回收、结果不回填任何节点，还绕开配额）—— 与摘掉 `subagent` / `subagent_fork` 要防的是同一件事。

### 8.2 取消、进度展示与可见性

| 事项 | 结论 |
|---|---|
| 谁唤醒 master | 任务引擎；master 空闲时通过 pre-step 通道唤醒 |
| 展示什么 | 任务执行状态（进度、待汇总、失败），由引导层注入 prompt |
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
| 同一节点被两个触发源同时派活 | 批次内去重（§3.1）；最坏是多起一个任务单元，写入仍被身份校验挡住 |
| 拆解出实质重复的子节点 | **建节点时去重**，范围限拆解者所在子树 |
| 拆解递归过深 | 树可任意深；每次执行都是新会话，无委派深度累积问题 |
| 根节点反复拆解无法收敛 | 失败预算 `failures` 超阈值 → `failed` + 唤醒 master 上报（成功的拆解/汇总轮不消耗，见 §9.2） |
| 节点无界增长 / 无限拆解 | 配额（见 §9.2）：超限时**拒绝该次拆解** —— 一次性、零副作用，不改节点状态 |
| 用户取消 | 取消子树：把子树节点标终态，并 `interrupt_agent` 各 in-flight 持有者 |

### 9.2 配额与升级策略

| 项 | 值 | 接线入口 / 行为 |
|---|---|---|
| 树深度上限 | **8** | `decompose` 前校验，超限**拒绝该次拆解** —— 一次性、零副作用，不改节点状态；已到顶的执行者在**派发时**就会读到这条上限（prompt 的深度提示），不用靠被拒才发现 |
| 单次拆解子任务数 | **至多 6** | `decompose` 的入参校验，超出即拒绝该次调用（一次性，不改节点状态）|
| 并发任务单元上限 `maxConcurrent` | **CPU 核数 - 1**（可配）| **槽位数上限**（同时最多几个任务单元），按**已绑定的节点**计数（见下）。它是 capacity 的backstop，不是主闸门 |
| 容量 `capacity`（2026-10-02）| **派生：`availableParallelism()` → `cpus().length` → 4，减 1 核预留，夹取 1..64**（可配）| **派发主闸门**：`Σ running.weight + candidate.weight ≤ capacity`。见 §9.2.1 |
| 失败预算 `failures` | **5** | 每次 worker 被回收（消失 / 卡死）+1；达阈值 → 节点标 `failed` + 唤醒 master 上报。**成功的提交与拆解（含汇总轮）不消耗** |
| 启动失败预算 `spawnFailures` | **5** | 每次「派发即失败」（runtime 拒绝 / toolFilter 无法施加）+1，并按指数退避冷却后再派；成功启动即清零；达阈值 → `failed`。**不计入 `failures`** |
| 单树节点上限 | **200** | `decompose` 提交前校验，超限 `node-limit` 拒绝该次拆解（一次性，零副作用）。只数**本次新增**的节点：复用已有前置任务的子任务不计数 |
| 会话续命 | **同一父子边**（`parkedWorker`）+ **重启后冷唤醒**（`lastWorkerId`）| 拆解后停手的执行者被记在该节点上；子任务全终态后由 owner 那一轮唤醒它继续判断。中断留下的句柄在打开时存进 `lastWorkerId`，下次派发**先冷唤醒、失败再新起**（失败不消耗任何预算：`wake-failed`）。冷唤醒另带**变化差量**：派发时把"这个 prompt 给会话看了什么"存成 `dispatchBaseline`，唤醒时用当前值减它，差量渲染进唤醒消息；**差量大到 material 就不续命、直接新起**（不扣预算、不触发冷却）。停手期间节点不是 `running`，不占并发配额、不触发 stale 判定；认领后如常走 stale 兜底。优先级 parked > 冷唤醒 > 新起，互不覆盖。见 §3.2.2 / §3.2.3 / §5.1 / §9.2.2 与设计提案 |
| 任务链 token 预算 | **暂不需要**（见 §9.2.2）| —— |

**深度的计数口径**：根节点为第 1 层，深度 8 即允许最多 7 次连续下钻。实施时以根为准统一定义。

**"发散"与"失败"是两回事**：`failures` 只能识别反复失败，识别不了"反复成功拆解出更多节点"。深度上限（8）与单次子任务数（6）**共同给出了节点数的理论上界** —— 但那个上界是数万节点，而深度限制要到第 8 层才生效：一个每轮只拆一个子节点的递归可以在被拦住之前跑很久，每个节点在真实部署上都是一个会话。所以 200 这个上限**已经落地**（不再是"待定"），它是廉价的天花板，同时仍远高于任何人会去审的树规模（一次拆解最多加 6 个节点）。

它也是 worker 自发扇出的**唯一**可用记账点（见 §5.4.1）：引擎看不见 `workflow` / `ralph` 在节点内部起了多少子 agent，能计数的只有树自己的节点。

**`attempts` 与 `failures` 是两个计数器（2026-09-20 修订）**：

- `attempts`：**每次派活 +1**（spawn 时），是「派发代号」。它同时承担 `note_mission` 的归属门禁
  （`decompose` 校验 `analysis_attempt == attempts`，确保是本次派发自己写的分析），所以汇总轮也必须 +1。
- `failures`：**失败预算**，只在 worker 被回收（消失 / 卡死）时 +1；成功的提交与拆解一律不消耗。

修订原因：早先用 `attempts` 当失败上限，于是「拆解 → 子终态 → 汇总判断 → 还缺 → 再拆解 → 再汇总」
每一轮都吃 2 次 `attempts`，`maxAttempts=5` 实际只允许约 2 轮拆解-收敛，**合法的多轮逼近任务会被误判
`failed`**。把失败预算拆成独立的 `failures` 后，成功的收敛轮不再消耗它，只有真正反复失败的节点才逼近上限。

**派发失败要退避（2026-09-20 修订）**：`startWorker` 派发失败（`subagents` 不可用 / `toolFilter` 连重试都
失败）时，回收记为 `spawn-failed` → `spawnFailures +1`（**不进 `failures`**），并按 `30s × 2^(n-1)`（上限
10 分钟）冷却，`nextDispatchable` 在冷却期内跳过该节点。否则 pump 频繁触发会在数秒内烧光预算把节点判死。
成功启动一次即把 `spawnFailures` 清零（预算针对的是**连续**启动失败）。

**并发上限的计数口径必须是"已绑定"**：预留的 child id 在被物化之前不是 agent，
按"活 agent 数"计数会让一次扫描把 N 个 ready 节点全部派出去（上限形同虚设），
也会让上限取决于 spawn 多快注册。所以计数取 `status == running && claimed_by != null`，
本轮的派活立刻计入，同一 tick 的第二次触发也不会超发。

### 9.2.1 capacity 派发闸门与 weight（2026-10-02）

完整设计见 [`docs/design/2026-10-02-capacity.md`](./2026-10-02-capacity.md)；这里只钉住会改变行为的规则。

- **capacity 的来源**：① 显式配置（`config.capacity`，按给定值夹取）→ ② `os.availableParallelism()`
  （尊重 cgroup 配额与亲和性）→ ③ `os.cpus().length` → ④ 默认 4；派生值再减 1 核留给宿主/UI，
  夹取 `1..64`。硬件派生只在**宿主/插件边界**做（core 刻意不带 Node 类型），算完作为
  `EngineOptions.capacity` 注入，因此调度可被确定性测试。
- **`weight`（节点申报的核当量）**：`create_mission.weight` / `decompose_mission.children[].weight`，
  缺省 **1**，夹取 `1..64`，持久化在 `NodeRecord.weight`；**子任务不继承父的估值**；
  去重复用节点保留自己的 weight。`DOMAIN_VERSION` 仍为 1（可选字段 + 默认值）。
- **派发闸门 ≠ 受理闸门**：`create_mission` / `decompose_mission` **永不因容量失败** —— 树建好、节点进
  `ready` 就是排队。被闸门跳过**不是拒绝**：不扣 `attempts`/`failures`/`spawnFailures`、无冷却、不记
  `stalls`（与 unit 租约同一纪律）。每次节点完成、每次 pass/sweep 都重新评估，所以"完成后再按负载继续派发"。
- **work-conserving**：装不下的重任务被跳过、继续扫描用轻任务填满空闲容量；队列顺序是
  入队时间（FIFO）+ 老化提升，**不按 weight 排序**。
- **老化 → 预留（防饿死）**：某节点被容量跳过累计超过 `capacityWaitMs`（默认 5 分钟、下限 1 分钟）后
  进入**预留**：不再接纳新节点（已在跑的不动），等排空到它装得下再派发；多个预留按等待最久优先。
  时钟由 `EngineOptions.now` 注入，测试可确定性地推进。
- **独占例外**：`weight > capacity` 的节点（"要整机"）只在**无其它 running** 时派发，不会永远排不上。
- **`maxConcurrent` 与 capacity 的主从关系**：capacity 是**主闸门**，`maxConcurrent` 退化为**槽位数上限**
  （防止 weight=1 开太多会话），两者都满足才派发。
- **`waitingFor` 可观察**：节点投影带 `waitingFor: 'capacity' | 'unit' | 'slot' | null`（`capacity` 用
  `resource: 'cpu' | 'memory'` 区分，能给出数字时带 `needed`/`available`），接到 `mission_result` 与面板；
  推迟派发时打一条**限流**日志（`dispatch deferred: <node> needs N, capacity C, running R`，每节点每分钟一条，
  预留转变不受限流吞掉）。它**不进 `isTroubled`** —— 正常排队不是"反复出过问题"。
- **`ResourceProbe`（v1 只做接口与统一 API）**：core 定一个 Node-free 端口
  （`parallelism()` / 可选 `memoryBudget()` / `pressure()` / 可选 `workerUsage(pid)`）；宿主侧实现只用
  `os.availableParallelism()`、`os.totalmem()`、`process.constrainedMemory()`（与 totalmem 夹取，
  识别 `1.8e19` 这类"无约束"哨兵）与 `os.freemem()`（粗信号，只作下限门）。`null` 是"本平台无此信号"，
  **"无信号" ≠ "空闲"**：`null` 只能让调度更保守，绝不能放宽并发；未实现处一律 `null`
  （`pressure()` 在 v1 恒为 `null`）。平台适配器与实测校正留给 v2，接口位置与降级路径已写在该文档里。
- **空闲内存下限门**：低于配置阈值（默认 256 MiB）时**推迟派发**（闸门，不是拒绝）；探针端口没有
  `memoryBudget` 实现 = 该门不生效（v1 无平台适配器的降级路径），实现但它返回 `null` = "无法确认下限"
  → 保守推迟。

### 9.2.2 待实施项与接线入口

以下两项**当前不实施**，但预留接线位置，避免将来改造时找不到入口：

| 项 | 接线入口 | 何时需要 |
|---|---|---|
| 任务链 token 预算 | 节点 prompt 构造器（§5.1）的输出处 —— 构造完成后测长，超限则退化为"只保留根 + 最近 N 层" | 深度上限放宽，或任务链开始含描述时 |
| ~~单树节点上限~~ | 已实施：`decompose` 提交前校验（`CAPACITY.maxNodesPerTree`）| —— |

**会话续命（2026-09-20 实施）**：一次派活的执行者拆解后停手，节点会记下它的会话 id（`parkedWorker`），
子任务全终态时由 **owner 的那一轮**把它唤醒，让"判断这堆子结果够不够"这件事发生在**当初做拆解的那个会话**里，
而不是一个要从 `note_mission` 与子结果重新推导的全新会话。边界如下：

- **只沿同一条父子边**：一个 worker 只唤醒它自己上一次的执行；不跨层级。
- **必须排除出派活池**：`decompose_mission` 之后宿主会同步 `pump()`，若不把 parked 节点从 `nextDispatchable`
  排除，它会在 owner 来得及唤醒之前被派成全新会话，唤醒逻辑就成了死代码。
- **唤醒主体只能是 owner**：续期协议的 `authorizeLineage` 要求授权方是活着的直接父会话。owner 离线时
  地址**留在节点上**、不消费、不新起执行者，等它回来再续。
- **失败即降级**：会话被清理或运行时拒绝 resume → `wake-failed` 退回 `ready`，直接以新 claim 派发新执行者。
  不给重试预算 —— `note_mission` 是这条边界的正式交接，全新会话是完整正确的路径。
- **一次 park 只通知一次**：宿主按节点记录"已告知 owner"，节点离开 parked 状态即清除，避免每次 pump 都往
  owner 的 inbox 堆一条唤醒。

冷启（`sendMessage` 对非驻留子会话走 `coldResume`）已在真实协议上验证：`pnpm spike:cold-resume`。

**冷唤醒（2026-09-25 实施）：重启后不把执行者当新的**。上面的续命只在"同一进程内停手等唤醒"这条边上成立；
进程重启/worker 灭失留下的 `interrupted` 节点，过去只能起全新执行者。现在 `reconcileOnOpen` 会把旧会话 id
存成 `lastWorkerId`（§3.2.2），下一次派发**先试冷唤醒，失败再新起**：

| 项 | 约定 |
|---|---|
| **优先级** | parked 会话 > `lastWorkerId` 冷唤醒 > 全新 spawn。parked 是活着、正在等唤醒的续命；`lastWorkerId` 是可能已不存在的句柄；`nextDispatchable` 照旧排除 parked 节点 |
| **要不要续** | 认领前先算**变化差量**（`dispatchBaseline`，§3.2.3）并过 `isMaterialChange`：未读纠偏 / 笔记来自**别的会话** / 标题内容被改过 → **不续命**，消费句柄后走全新 spawn。**"子任务达到终态"被刻意排除在判据之外**：那是 parked 唤醒的触发条件本身 |
| **投递 seam** | 复用既有 `ctx.subagents.sendMessage(owner, SessionId(lastWorkerId), …)` —— dsh-subagent 的 `materialize` 就是 "Create **or resume** one child Agent"（内部 `agents.resume({ resumeSessionId })`）。不新增任何会话 API |
| **认领顺序** | 守卫 → 认领（`adoptContinuation`：`claimedBy = lastWorkerId`、`attempts+1`、**消费**句柄）→ 投递。认领必须在前，因为被唤醒的会话立刻可以 `submit_mission` / `decompose_mission`，两者都校验 `claimedBy === caller` |
| **守卫** | 复用 `wakingClaims`：冷恢复的目标同样按定义是 idle（没物化），只靠 `agents.get` 会把刚认领的绑定读成"已消失"，被扫描回收 → 冷恢复落地 + 新起执行者**双跑**。守卫在**认领之前**置位，直到 `workerLive` 真的观测到 resumed agent |
| **投递被拒** | `reclaim(..., 'wake-failed')` 退回 `ready` + 立即预留新 claim 走今天的 `dispatch`/`startWorker`。**不扣任何预算**、不触发 30s 冷却；`attempts` 不回滚（它是派发代号） |
| **不双跑的另一半** | `ResumeOutcome` 是三种答案而不是布尔：`resumed`（引擎计一次派发，**不 spawn**）/ `failed`（这次续命不会发生 —— 投递被拒时宿主已自行回收，差量 material 时宿主**根本没有认领**；两种都走普通新起）/ `skip`（另有投递在途或状态已变 —— **绝不许** spawn）。没有 `skip`，守卫窗口里就会多起一个执行者 |

**纠偏投递标记（`correctionsDeliveredUpTo`）**：`adjust_mission` 的实时投递成功后才把水位推进到
`corrections.length`；失败/无 holder 不推进。语义是"前 N 条已确认送达**那个会话**"，因此：

- **冷唤醒消息**只渲染 `corrections.slice(correctionsDeliveredUpTo)` —— 已经实时送到这个会话手里的纠偏，
  不再对它重复一遍（它已经照做或已经判过）。唤新成功后水位也随之前进，下一次再唤醒不重复。
- **全新 spawn 的消息照旧渲染全部纠偏** —— 新执行者一条都没见过，抑制任何一条都是把 owner 给的方向
  从唯一能执行它的会话眼前藏起来。两条路径在这里**刻意不合并**。
- 旧记录缺该字段按 `0` 加载（= 全部待投），保守且安全；`corrections` 仍是 append-only 的文本数组，
  标记是旁边的一个数字 —— 把数组改成对象会让历史纠偏整批读成不存在。

> **REV-4 补的那一半（2026-09-25）**：只看水位会把"全新 spawn 渲染过、但没推进水位"的纠偏永远算成未读。
> 所以"这个会话没读过的纠偏"取**两个标记的较后者**：水位（确实投递过的证据）与 `dispatchBaseline.corrections`
> （那次 prompt 里就有的证据）。未读纠偏 > 0 现在是 **material**（见下），也就是说已知基线下它**不再进入唤醒
> 消息**——它改变的是路由：改新起。上面那条"冷唤醒只渲染未送达的纠偏"因此在**未知基线**这条路径上成立
> （旧记录/夹具），渲染逻辑保留。

**变化差量与 material 判据（2026-09-25 实施）**：派发时把"这个 prompt 给会话看了什么"存成
`dispatchBaseline`（§3.2.3），冷唤醒时相减得到差量，渲染在续任说明之后、任务链之前。差量大到一定程度
（`isMaterialChange`）时**放弃续命**：

| 信号 | 为什么算 material |
|---|---|
| **未读纠偏 > 0**（水位与 baseline 取较后者） | owner 改了方向。这个会话的计划建立在旧方向上；全新执行者先读纠偏、再读别的，是这条消息更好的读者 |
| **最后一条笔记不是本会话写的**（`analysisAuthor !== baseline.holder`；任一侧缺失时退回 `analysisAttempt !== baseline.attempts`） | 节点的判断通道被**别的执行者**推进过。保守是刻意的：误报只多起一个新执行者（永远正确），漏报是在自己没写过的判断上继续推理。**按身份而不是按代数**是 2026-10-02 的修订（N3）：`analysisAttempt` 只记"哪一代派的"，而一个会话自己写的笔记会活过它的那次派发 —— 父节点拆解后再被唤醒（`attempts + 1`）正是这种情形，按代数比会把**自己**的判断读成"别人的"，于是一到汇总父节点冷唤醒就失效。`baseline.holder` 记录这份 prompt 交给了谁、`analysisAuthor` 记录最后一条笔记是谁写的；两者都在才比身份，否则退回旧的代数比较（旧记录缺字段时即上一代行为）。没有笔记时判否是必需的（`analysisAttempt` 为 `0`，与任何 `attempts` 都不等） |
| **标题或内容被改过**（指纹不同） | 会话会被唤醒到一个它从未接到过的任务上 |

**必须排除"子任务达到终态"，这是硬要求。** parked 会话被唤醒**就是因为**子任务全部终态 —— 那是引擎自己的触发条件
（`decompose_mission` 之后同步 `pump()`，父节点在子任务建出来的一刻停手）。把它算作"变了"，parked 唤醒就会永远
不续命，REV-2 那套功能当场作废。两处保证：判据里根本没有这一项，而且判据**只在冷唤醒路径**求值（`host.resumeWorker`，
parked 唤醒不看它）；回归由两侧钉住 —— core 断言"差量里 `terminalChildren === 1` 而 `isMaterialChange` 为假"，
plugin 的 `a parked wake is not drift` 在同一用例里断言这两件事**并且**真的完成一次唤醒。

**基线未知（旧记录、或本代宿主没构造过 prompt）→ 判据答"不 material"，照样续命，但附一句诚实的说明**：

```
自你上次执行后的变化无法确定（这条记录里没有当时的快照）：下面是本任务的当前视图；若与你记忆里的不一致，以当前视图为准。
```

理由：prompt 里的当前视图本身是完整的（标题/内容/背景/纠偏/全部笔记/子结果都在），差量是额外的一段而不是真相来源，
所以"无法确定变化"一句话就能诚实交代；反过来选"未知即新起"，等于在特性上线那一刻把所有在飞的任务都换成全新执行者，
是落在最该被这套功能服务的记录上的永久损失。已知基线且**没有**变化时，整段差量不出现（续任说明已经说了"你在继续"，
每次安静的唤醒都写"没有变化"只是噪声）。

**放弃续命的计数语义**：判据在**认领之前**求值（守卫 → owner 存活 → 判据 → 认领 → 投递；放在 owner 检查之后是必须的，
否则 owner 不在时返回 `failed` 会让引擎落进一次发不出去的 spawn）。判为 material 时用 `abandonContinuation` **消费句柄**并
返回 `failed`，引擎在同一次 pass 里走**既有**的新起路径；**不扣 `failures` / `spawnFailures`、不触发 30s 冷却**（与
`wake-failed` 同一条契约），`attempts` 由新的那次派发 `+1`。没有认领，所以 `wakingClaims` 与它无关；新起走既有的
`startingClaims` 路径，"不双跑"的既有三条回归未改、全部通过。

**续任说明**：两条路径都会在 prompt 顶部带一段"这是本任务第 N 次执行"：
冷唤醒说"上一次执行被中断、你接着那个会话"；全新 spawn 说"之前已经有执行者动过手"。
两者都补一句"工作区里可能留着上一次执行的改动：先核对（`git status` / 文件时间 / 测试）再决定补做还是重做"，
直接修掉"重启后像是重新执行一遍"的另一半。注意措辞用**工作区**而不是工作树：prompt 层从不向模型描述任务树的形状
（见 `prompt.spec.ts` 的 `the vocabulary the model reads`）。

**为什么任务链 token 预算暂不需要**：任务链的组装**只含各节点的 title 与少量基本信息**，不含 description / context（那些属于当前节点自己的内容）。所以任务链长度是"深度 × 一行的开销"：

| 深度 | 任务链大致规模 |
|---|---|
| 8（上限）| 8 行标题级信息 |

这个量级下 prompt 不会膨胀，加预算反而增加无谓的复杂度（YAGNI）。**§5.1 里"任务链不膨胀"这条在设计上是靠"只放基本信息"保证的，而不是靠截断策略。**

### 9.3 拆解去重的锁协议

执行者各自只看得到自己的任务链，可能独立发现同一缺口。去重由**引擎侧**完成（不是执行者的认知负担）：

```
decompose(node, children):
  持树锁:
    for child in children:
      if 等价节点已存在于「node 的兄弟子树 + node 自己的子树（含本次已建）」中:
        复用该节点 id（不新建），并把本次的 context 追加到该节点
      else:
        新建节点
```

**范围**：兄弟子树 + 自己的子树，**不做全局去重** —— 全局去重等于让执行者"看见"无关分支，破坏"执行者无需知道其他任务"这条原则。

**三类节点永不作为复用对象**：**节点自己**、**它的祖先**、以及树中的任何同 id 节点 —— 前两类会让节点变成自己的前提（依赖成环）。

**复用出的依赖是共享的**：被复用节点出现在两个父节点的 `children` 里，而 `parent_id` 仍是创建它的那一个。
于是"子任务全终态 → 父可汇总"的传播**必须从所有父节点出发**（按 `children` 反查父节点，广度优先向上），
不能沿 `parent_id` 单链上溯 —— 否则另一个分支永远等不到 `ready`。

**取消一个任务的下级时，共享前提的三种口径（2026-09-18 定：选第 2 种）**：

| 口径 | 含义 | 取舍 |
|---|---|---|
| 1 跳过共享节点 | `parentsOf(id).length > 1` 就不动它 | 保住另一条分支，但"清空重规划"不彻底 |
| **2 照取消 + 重算所有父节点**（采用） | 共享前提也被取消，**每个被改动节点的全部父节点**都重算聚合状态 | 语义与"汇总轮读子结论后重新判断"一致；代价是取消了别人没同意取消的东西 |
| 3 拒绝 | 有共享下级时返回 refusal，让 owner 改用 `cancel_mission` | 最保守，但把选择推给了人 |

第 2 种成立的前提是**汇总轮能看到真相**：取消写进去的 `result` 必须同时置 `hasResult`（否则渲染成"（未提交结果）"，理由一个字都到不了模型），且 `childrenBlock` 必须带子节点状态。两处都已实现，并有回归测试（取消一个分支后，另一个父节点必须变 `ready`）。

去重与建节点共用同一把树锁，避免"同时查、同时建"。

### 9.4 文本良构（well-formed）：入站唯一收口 + 两处出站兜底（2026-10-02）

**缺陷形状只有一个**：一个**孤立代理项**（lone surrogate）—— `D800–DFFF` 里的 UTF-16 码元，没有配对的另一半（孤立高位、孤立低位、或半个 emoji）。这样的串不是合法 Unicode 标量序列，但 `JSON.stringify` 会把它原样写成转义 `"\ud800"`；JS 自己的 `JSON.parse` **接受**它，所以本仓所有测试都是绿的，而严格解析器会拒收整份文档。实测证据：

```
printf '"\\ud800"' | jq .   →  parse error: Invalid \uXXXX\uXXXX surrogate pair escape
python3 -c 'json.loads(...); print(...)'  →  UnicodeEncodeError: surrogates not allowed
```

修复是 `String.prototype.toWellFormed()`（Node ≥20）：把每个孤立代理项换成 U+FFFD（`�`）；完整 emoji、CJK 扩展 B 区字、引号/反斜杠/换行/制表符都原样不动。**不应用 NFC**：mission 的入站文本是给人/模型读的散文，没有索引或等价类需要规范化；唯一可能想要它的拆解去重本来就是启发式（trim + 折叠空白 + 小写，且刻意不把不同 description 视为等价），NFC 只会静默改写调用方自己写下的字节。入站与出站因此用**同一个**修复函数（`wellFormedDeep`），这也让"唯一收口"与"出站兜底"可证明是同一件事。

**入站唯一收口在 `MissionTree` 的每个写路径入口**（不是每个字段各写一份；一处递归修复覆盖该路径的全部字段）：

| 写路径 | 入口（收口点） | 覆盖字段 |
|---|---|---|
| `create_mission` | `MissionTree.createRoot` 开头 `this.wellFormed.deep(input)` | title / description / analysis / unit |
| `decompose_mission` | `MissionTree.decompose` 开头 `deep(children)`（**在去重扫描之前**） | 每个 child 的 title / description / context / unit |
| `note_mission` | `MissionTree.recordAnalysis` 开头 `text(analysis)` | analysis |
| `submit_mission` | `MissionTree.submitResult` 开头 `text(result)`；落盘内联截断后再修一次 | result（含 `slice` 可能把完整字符切成半个的情况） |
| `adjust_mission` | `MissionTree.correct` 开头 `text(text)`（**在去重判断之前**） | correction |
| `/mission` 命令 | `apply` 的 handler 入口 `text(rawInput)`；标题 ellipsis 截断后再修一次 | title / description |

**两处出站边界**（都要递归先修、再成文本；也覆盖历史坏数据——旧版本写进持久化树的坏串）：

| 边界 | 位置 | 做法 |
|---|---|---|
| 工具返回值 | `plugin/src/tools.ts` 的 `outputFor(wellFormed)`（原来是 `tools.ts:32` 的 `typeof summary === 'string' ? summary : JSON.stringify(value)`） | 先 `wellFormed.deep(value)`，再走 summary / `JSON.stringify` 两个分支；`summary` 分支与 JSON 分支都不可能带出孤立代理项 |
| 执行者 prompt | `core/src/prompt.ts` 的 `buildWorkerPrompt`（以及同文件的 `buildProgressLine`） | 组装前对整个 `view`（node / chain / children）与 `options` 递归良构；数字/布尔/null 原样 |

**base 消费与回退（接口 v2）**：正本是 base kit 的 `wellFormedText` / `wellFormedDeep`。`plugin/src/wellformed.ts` 的 `resolveWellFormed(kit)` **只看"这两个函数在不在"**：在，就用加载到的 base（一次 base 发版即可修）；不在（base 缺席，或早于 v2），就用 core 的本地副本 `LOCAL_WELL_FORMED`（`core/src/wellformed.ts`，注释写明这是降级路径）。这**不是**兼容性判决，也**绝不**拒载或降级挂载：base 缺席/v1 时，同一套 9 个工具、3 条命令、prompt 段、Remote 与 UI 全部照常注册，只是修复改用本地副本。插件从不按值 import base——kit 是 bootstrap 在运行时加载、经 `apply` 传进 host 的（见 §10.2 与根 `AGENTS.md`）。

---

## 九点五、客户端半边：**任务**标签

会话视图条里的第三个标签（`conversation.view`，order 20，排在"对话"0 与"轨迹"10 之后），用树形展示本会话的任务树。

| 层 | 贡献 |
|---|---|
| 宿主 | `AvantfMissionHost` 改为 `TypertRemoteService`，加 `@Remote('snapshot')`、`@Remote('detail')`、`@Remote('result')`、`@Remote('delete')` 与 `@Remote({ mode: 'stream' }) watch` 五个方法；`wire.ts` 手写 host/client 两份 wire face，`apply` 里 `ctx.typert.register(hostContribution)` |
| 客户端 | `src/client/`：`$mount(clientContribution)` → `ctx.get('remote.avantfMission')` → 挂载时读一次，之后**跟着 `watch` 变更流刷新**（见下）；点任务标题按需调 `detail`，在**弹窗**（设置面板形制：左侧分区栏、右侧唯一滚动区）里展示该任务的标题/内容/上下文/拆解信息/纠偏/结果/子任务；**每棵树**的标题栏带"删除"按钮（二次确认，删完立即重读；树未结束时禁用并说明原因）；节点的展开默认值跟着它自己的状态：在跑/待跑/中断的默认展开（拆出来的子任务立刻可见），`done`/`failed` 的默认折叠（跑完的树收成一行，结束的分支不再压住活着的部分），点击存为覆盖值；`slots.register('conversation.view', …, order 20)` |
| 构建 | `scripts/build-client.mjs` 用 esbuild 打成 `lib/client.js`（`window.__ModuleLoader__.load` 契约；shell 提供的模块保持 external） |

**为什么手写 wire face**：DSH 包通常由 Typert 生成器产出 `typert.host.js` / `typert.remote-client.js`，而生成器只在 harness 工作区内运行。手写遵循生成器的约定（一个 `args` 对象参数、`<pkg>#<ns>/<method>` 的 invocation id、`strict` codec）。

**为什么不注入 `remote.avantfMission`**：boot 审计（`@deepseek-ai/dsh-client-web` 的 `assertEntriesActive`）对任何仍 pending 的注入项抛错，并让**整棵 web 树**起不来；而自建命名空间只有在本插件自己 `$mount` 之后才存在。所以只注入 `remote`，挂载后用 `ctx.get()` 读。

**为什么不复用 harness 的 tsdown 预设**：该预设按 `packages/*/*/package.json` 反查目标包 manifest，第三方仓用它必须往 DSH 源码树写一个 stub；本项目不改 DSH 源码，因此自建 esbuild 打包，产物契约与预设一致。

**刷新为什么由引擎推，而不是面板轮询**：只有引擎知道某棵树动了 —— 派活、回收、worker 提交、owner 收尾，其中"引擎自己在 owner 空闲时派活或回收"这一类根本不进任何会话日志，轮询频率再高也只是把延迟改小、把猜测换个周期。所以引擎在每次变更后把该 tree owner 的 revision +1，并唤醒所有挂在 `watch` 上的流；客户端对每个已挂载的面板开一条以 sessionId 为键的流，收到帧就重读快照。`watch` 声明为 `mode: 'stream'` 并带 `cancellation: { parameter: 'signal' }`（harness 自己的 `session/control` 就是这个形状），标签卸载时 `AbortController` 一 abort，宿主那边的等待就被唤醒并结束生成器，不会留下悬挂的监听。帧里只带一个 revision 号：推送只负责说"变了"，权威数据永远来自 `snapshot`/`detail`，所以丢一帧（重连、宿主重启）只值一次重读，不损正确性。

**为什么文字不用 opacity 调暗**：`opacity` 会沿子树相乘 —— 一个变淡的祖先（归档树曾整块 `.75`）乘一个变淡的子元素（meta 曾 `.55`）只剩 41%，亮色主题下约 2.7:1、暗色约 3.5:1，12px 小字实际读不了；标题本身也被那层 `.75` 拖到 5.5:1。现在所有文字颜色来自 label token：正文 `label-primary`（第 3 代条目实测 亮 18.9:1 / 暗 15.0:1）、次级文字 `label-secondary`（5.8:1 / 10.4:1），归档状态改用虚线边框而非整块变淡。状态色只用于形状与底色（`--avwf-status` 喂圆点和徽标底色），徽标文字仍是 label token —— 状态色当文字在亮色主题下只有 2.3:1。另：样式里原先的 `--dsh-color-*` 变量在设计平台里不存在，一直在走硬编码兜底，现已换成 `--dsw-alias-state-*`。

**为什么颜色也取自同一套 token**：条目的底色 `--dsw-alias-bg-layer-1`、文字色 `--dsw-alias-label-primary` 与"记忆"条目相同（shell 为明暗主题统一定义），只改颜色、不动边框圆角间距字号。相邻标签用同一套设计 token，读起来才是同一块界面；硬编码颜色会在其中一套主题里露馅。

**为什么宽度要跟"记忆"页对齐**：会话视图标签页渲染在对话正文旁边，通栏会让它看起来像个外来的浮层。根节点用与 `@avantf/mem-dsh` 相同的规则对齐共享属性 `--dsh-chat-content-width`（`ui-conversation` 的根发布它，`ui-chat` 的消息列也以它居中），两个标签因此共享同一条轴线与同一个宽度；根节点不设左右内边距，让"树框"的边界与"记忆"条目的边界重合。属性不存在时该声明在计算值阶段失效、`max-width` 退回 `none`，也就是原来的通栏行为，不需要兜底分支。

**为什么列表要窗口化、摘要要瘦身**：一个会话的任务树只增不减（删树是人的动作），所以"很多任务"迟早会发生。渲染侧按"棵树"开窗（阈值 25，`@tanstack/react-virtual`，`overscan` 5，先估后量高度）——滚动条覆盖全部历史，但 DOM 只挂视口附近的几棵，和"轨迹"表同一套机制；数据侧则让摘要只留行上要用的字段：节点的 `description` 移出摘要（行不渲染它，全文在 `detail` 里按需读），因为摘要是**每次引擎变更都重传**的，而描述是其中最大的一块。仍然随历史增长的是"每棵树的节点行"，下一步若真需要，就是把节点也改成按可见树按需读取。

**兜底为什么还需要**：`timer`（5 秒）只在宿主没有 `watch`、或流连着两次**一帧都没给**时启用（旧版本宿主、连不上的传输）—— 健康的流一定会先给一帧开场（当前 revision），所以"什么都没来"就是"这条流不能用"的判据，会话侧 revision（`useChat`/`useSession` 的便宜派生值）则始终在，用来覆盖"工具调用已经改了树、推送还在路上"的窗口。`timer` 是可选服务，本机浏览器侧没挂它，所以退到浏览器自己的 `setInterval`，两条都试过才算失败 —— 这条路径写错的表现恰好是"这个功能像是没做"。

**详情为什么按需读**：一个结果可以到 2 KB（超过就落盘，只留前 2 KB 与指针），而快照在每次变更时都要重读。通常关着的面板不该为它付钱，所以点开某一行才调 `detail({ sessionId, nodeId })`；已打开的弹窗跟着快照一起重读，所以 worker 在它开着的时候提交结果会直接出现。

**2026-09-23 修订：详情从"行内展开"改为"弹窗"。** 行内展开的详情一长就把树顶下去：读完一棵的目标/纠偏/结果再回头看另一棵，原来的滚动位置已经找不到了。现在改为居中弹窗，形制照 DSH「设置」面板 —— 全屏遮罩（`--dsw-alias-bg-mask-1` + `--dsw-mask-blur`）、layer-2 卡片（`--dsw-elevation-prominent`）、左侧分区栏、右侧**唯一**滚动区；卡片 **1040×880**（比设置的 800×800 更宽：这里读的是一列散文加长列表，176px 的分区栏一分走，800px 的内容列就局促了），正文 **15px/1.7**、标题 18px、分区标签 15px（比行文字大一档 —— 这个面就是用来读的，14px 在这个宽度上读起来像小字）。分区由内容生成且**空的分区不出现**：内容/结果恒在，上下文/拆解信息/纠偏/子任务只在有内容时成为一个标签、并在标签后带条数；**标题不是分区，而是弹窗的标题栏**（连同节点 id、状态徽标、第几次派发与深度）—— "我在看哪个任务"在任何分区被选中之前就要回答，而且读每一个分区时都得答得出来，标题曾经占着一个分区，等于让这条前设在切换标签时消失。每个分区前面有一行小字说明它装什么：`内容` 是"要达成什么（验收对象）"、`上下文` 是"为什么需要它（拆解者写的前提，不是验收标准）"—— 两个分区挨着却回答不同问题，只给名字会让人把前提当成目标；`拆解信息` 是 `note_mission` 记下的执行者分析（缺什么前提、排除了哪条路、子任务完成后要判断什么），并注明最近一条写于第几次派发 —— 这是判活的那个**全新会话**唯一能看到前任推理的地方，此前只有引擎读得到；`纠偏` 分区里写明「目标以『标题』为准」，这样"标题是创建时的目标、结果是纠偏后的方向"这两件事在同一个面板里被读成一条因果，而不是一对矛盾。关闭路径是关闭按钮、遮罩点击与 Escape，打开时焦点落在关闭按钮上。弹窗渲染在**视图根**而不是行内：行住在虚拟列表里，滚过去就会被卸载，挂在行上的弹窗会随读者的滚动消失。守卫：`client-view.spec.tsx` 的分区集合/顺序/空分区/条数/拆解信息与出处/两个分区的语义小字/溢出指针/加载与失败态，以及"弹窗尺寸、字号与画法跟设置面板同规则"的样式断言。

**为什么不走会话投影**：投影要求状态由 session log 折叠、且每次变化落一条 whole-value 事件。任务树的运行态由 service 持有，复制进日志成本更高，且"查看别的会话之外的树"语义也不对。

**破坏性操作的屏障强度不一致（记录，A4）**：面板的 `delete` 与 `/clean` 都是不可恢复的，但门禁不同 —— `/clean` 要求"是本插件的会话 + 已结算 + （`all` 时）已归档或显式点名 id"，而 `delete({ sessionId, rootId })` 只有归属一条，且 session id 由调用方提供（Remote 不带调用方身份，见下）。本地单用户宿主下可接受，但这两条值得对齐；对齐做法尚未决定（把 `delete` 也要求归档会伤 UX，因为面板的删除正是用来清掉"已完成但未归档"的任务）。

**已知限制**：Remote 调用不携带调用方身份（生成器的方法只收参数），所以 `snapshot({ sessionId })` / `detail({ sessionId, nodeId })` / `result({ sessionId, nodeId })` / `delete({ sessionId, rootId })` / `resolveExecutorSession({ sessionId, nodeId })` / `watch({ sessionId })` 的 session 由客户端给出。视图持有它正在显示的那个 id，且这运行在用户自己的宿主进程里。删除的调用形式是 `delete({ sessionId, rootId })`：**单位是整棵树**，节点 id 不是可删除的对象（传节点 id 会被当成"没有这棵树"拒掉）。未结束的树不会被删除 —— 它归引擎管，提前结束它是 `cancel_mission`；`finish_mission` 是另一种树级结束，保留记录并归档，删除则整条移出。删除不可恢复。

**2026-09-23 修订：落盘结果改成"点开就能看"。** 结果超过 2 KB 就落盘，节点只留开头与一个 locator —— 而那个 locator 是**给模型的**（`mission_result` 连同检索指引一起交给它），人在面板里点不动：浏览器不会导航到文件路径，DSH 自己那条"用桌面应用打开"的路只对有**授权路由**的 deliverable 开放，而这个 spill 不是交付物。于是加 `result({ sessionId, nodeId })`：面板上的「查看完整结果」让**宿主**（唯一能读自己 spill 产物的一方）把全文读回来，在弹窗里就地展开（展开时**替换**开头那段，不叠加 —— 开头本来就是全文的第一片）。两条降级都写死了：宿主没有这个面 → 不显示按钮（不提供一个注定失败的读）；locator 不是本机路径（`SpillStore` 的契约明确 locator 是**不透明的**，测试桩给的就是 `spill://…`）→ 回一条原因，locator 照旧留在屏幕上 —— 它本来就是"知道这个存储底座的人"要的地址。

**2026-10-02 修订：面板可以跳到执行该任务的会话。** 弹窗标题栏原本只显示**节点 id**（那是任务的身份），而真正跑它的 subagent 会话是另一个地址，读者想去看那一段执行过程时只能自己从"N 个子智能"下拉里找。现在两个投影（行的 `NodeView` 与详情的 `NodeDetail`）都多一个 `workerSessionId`，值为该节点**最近一次被派给的执行者会话**，客户端把它渲染成**节点 id 本身**的一个可点入口。

**2026-10-02 修订之二：入口是节点 id，句柄活到任务之后。** 第一版把 `workerSessionId` 定义为"当前绑定（`claimedBy`）"，且只在弹窗标题栏、和节点 id **并排**渲染成第二个链接；结果是任务一完成 `claimedBy` 被清空，链接整个消失，而用户点的其实是那一行的**节点 id**。三处一起改：

1. **持久化展示句柄 `NodeRecord.executorSessionId`**（新字段，`DOMAIN_VERSION` 仍为 1）。三个**进入 `running` 的转换**都会写它：`dispatch`（记 `claimId`）、`adoptParked`、`adoptContinuation`（记被采纳的会话 id）。**终态不清理**：`submit` / `decompose` / `reclaim` / `cancel` 之后它照旧在记录上 —— "跑完的任务是谁执行的"必须答得出来，而这正是 `claimedBy`（每次离开 `running` 都被清空）做不到的。多次尝试**只留最后一次**：投影里是一个字符串，不塞历史数组（要看历史得自己开各个会话）。打开时若记录是 `running`（老记录没有该字段），`reconcileOnOpen` 从 `claimedBy` 把它补上再降级/保留 —— 重启前跑过的会话因此仍可从面板进入。旧记录缺该字段读作 `null`（"没有可打开的执行者"），不解析失败（`domain.ts` 的 `nullable().default(null).catch(null)`）。
   - **它刻意不是 `lastWorkerId`**：后者是**一次性冷唤醒地址**（只有 `reconcileOnOpen` 写、只有 `adoptContinuation` 消费，花掉就置 `null`）。若把二者合并成一个字段，"同进程回收后重派"就会开始走冷唤醒，普通重派行为被改变。
   - 投影 `workerSessionId` 现在指这个 **最近一次** 的句柄（不再是 `claimedBy`），并新增布尔 **`workerLive`**（`status === 'running' && claimedBy === executorSessionId`）让 UI 区分"进行中 / 已结束"。两者都 `.default(null)` / `.default(false)`：老宿主缺字段 ⇒ 无句柄、不显示链接。
2. **节点 id 就是入口**：显示节点 id 的两处 —— 树头部的**根 id**（`avwf-root-id`）与弹窗标题栏的 id（`avwf-dialog-head-id`）—— 统一渲染 `NodeIdEntry`。该节点有句柄时它是有 `<button>` 的链接，文本是**节点 id**，`aria-label`/`title` 写明"打开执行这个任务的会话（进行中/已结束）"并注明**不是任务详情**；没有句柄时是纯文本。原来那个"执行者会话 id"的独立链接**已删除**：同一个东西不允许出现两个链接。
3. 点击发往宿主的 target 仍是 `{ parentSessionId: props.sessionId, childSessionId: <executorSessionId>, mode: 'continuable' }` —— 与主界面从子智能下拉进入子会话同一个形状（父会话是面板所属的 owner 会话），等价于在下拉里选中进入；面板**只做跳转**，不内嵌会话视图。

**三条降级路径**（与第一版同规矩，只是渲染对象从"执行者 id"换成"节点 id"）：① 没有句柄（从未派发，或老宿主缺字段）→ 节点 id 纯文本；**（本节 ① 与 ② 已被下面「修订之四」取代：现在无论有没有句柄、有没有 `uiWorkspace`，节点 id 都是入口，点不动的原因由点击后的提示回答。）**② 宿主可选服务 `uiWorkspace` 缺席，或本插件应用之后才挂上（所以**每次渲染重新取**，不缓存 apply 时的结果）→ 节点 id 纯文本并带一句"当前宿主没有 uiWorkspace 服务"的 tooltip；③ `openSession` 抛错或返回被拒的 Promise（会话确已被清理）→ 就地捕获成 `role="alert"` 的一行提示（树头部挂在那一棵树的状态里，弹窗挂在弹窗状态里），面板照常可用。`openWorkerSession` 是可选 prop，缺席路径与"渲染成纯文本"是同一条分支。

wire 侧同样要声明：`wire.ts` 的 `snapshotResultSchema`/`detailResultSchema` 加了 `workerSessionId`（`.nullable().default(null)`）与 `workerLive`（`.boolean().default(false)`）（**strict codec 会静默丢掉没声明的键**）。守卫：`host.spec.ts` 的"运行中 ⇒ id + live / 完成与取消后仍留 id 且 live=false / 从未派发 ⇒ null + false（不是空串、不是节点 id）"、`domain.spec.ts` 的老记录缺字段 ⇒ `null` 与真实落盘往返、`client-api.spec.ts` 的 schema 键名与解析（含老宿主缺键 ⇒ `null`/`false`）、`client-view.spec.tsx` 的"点击 target 形状 / 节点 id 本身是可点元素且区分进行中与已结束 / 树头部根 id 也是入口 / 无句柄 ⇒ 纯文本 / 服务缺席 ⇒ 纯文本 / 抛错 ⇒ 行内提示且不崩 / `apply` 每次渲染重新取服务"。

**2026-10-02 修订之四：节点 id **始终**可点，执行者会话在点击时懒查。** 「修订之二」做到了"有 `executorSessionId` 时可点"，但**历史节点**（该字段出现之前跑完的，如 `059f56ed`）字段为 `null` → 节点 id 退化成纯文本、点不动。缺的不是功能而是那批记录里没有句柄，所以这次不再以"有句柄"为条件：

1. **加载零成本是硬不变量**。挂载、开面板、渲染树与详情、`mission_result` / `list_missions` 一律**不读任何会话日志**，也不列会话语料；查找只发生在**点击**时。理由不只是性能：会话日志属于另一个存储层，面板的每一次重绘（引擎每个变化推一帧）都不该把它牵进来。
2. **解析顺序**：① 记录已有 `executorSessionId` → 直接打开，零 I/O（客户端连 Remote 都不调；宿主侧也短路，防止旧客户端把零成本点击变成一次扫描）；② 否则调**服务端**新方法 `resolveExecutorSession({ sessionId, nodeId })`；③ 打开仍走 `uiWorkspace.openSession({ parentSessionId, childSessionId, mode: 'continuable' })`。
3. **服务端解析（`src/executorSession.ts`，与 `host.ts` 分开以便单测）**：从**可选获取**的 `ctx.get('sessionQuery')`（**不进 `inject`**：headless 部署没有它，缺了只是"无法查找"，不是挂载失败）取 `listSessions()` 做**元数据过滤，三条判据都必须满足**：① `header.parentSession === 本面板的 owner 会话`（别的 owner 的子会话不可能是这个节点的执行者）；② id 形如 `mission-xxxxxxxx`（本插件自己铸的 claim 形状，同 owner 的普通 subagent 不能被读、更不该被打开）；③ `header.createdAt` 落在该节点的时间窗内（`createdAt − 2min` 到 `max(activityAt, updatedAt, createdAt) + 2min`；**终点用节点自己最后一次变动、不用 now** —— 否则 owner 之后的无关会话会被放进来，正是第③条要挡的；记录没有任何时间戳时用最宽窗口，因为"没有钟"不等于"没跑过"）。候选按 `createdAt` 倒序，只对**最多 8 个**候选读日志，在 `sessionQuery.filterEvents(sessionId, [{ kind: 'time', from, to }, { kind: 'text', text: 'id: <nodeId>' }])` 的语义文本里找首条 worker prompt 的那一行（`core/src/prompt.ts` 的 `currentNodeBlock` 固定输出 `id: ${node.id}`），再用本模块自己的正则 `(?:^|\n)id: <id>(?:\n|$)` 复核一次 —— 后端文本过滤只做近似匹配，判定必须是精确的。**过滤条件是对象联合（`{kind:'time',from,to}` / `{kind:'text',text}`），不是元组**（见「修订之六」）。命中**最新**一个即返回（与"多次尝试只留最后一次"一致）。单个候选的日志读失败不再静默吞掉：记**一条** warn（每次查找最多一条，含 sessionId 与错误摘要）后继续，一个坏文件不能毁掉整次查找。**并且答案本身要区分"没有匹配"与"一个都没读成"**（N7）：本次实际读过的候选**全部**失败时返回 `unsupported` + 首条失败原因（单行），只有"至少有一条读成功且无匹配"才是 `not-found` —— 否则一次形状错误/后端故障会伪装成"会话已被清理"。
4. **写回时机**：命中后由宿主 `MissionTree.rememberExecutor(nodeId, sessionId)` **一次写回** `executorSessionId` 并落盘，下一次点击就零 I/O。写回是**写一次**的：只在该字段仍是 `null`/空串时写 —— 查找期间已经到达的新句柄属于**更新的一次尝试**，用解析出的旧会话覆盖它会指错会话。`DOMAIN_VERSION` 仍为 1（只是多了一个可选字段的**写入**，旧记录缺它照旧读 `null`）。
5. **四类失败，四句原文**（`workerFailureText`，客户端按理由渲染，绝不让点击"没反应"）：
   - `never-dispatched`（记录 `attempts === 0`，是**事实**而非"没找到"）：`这个任务从未派发过执行者会话：没有可打开的执行者。`
   - `not-found`（派发过、会话可能已被清理）：`找不到这个任务的执行者会话：它可能已被清理，或日志已不在本机。`（带宿主原因时括号附上）
   - `unsupported`（宿主办不到：没有会话服务可查、Remote 面太旧没有这个方法、或没有 `uiWorkspace` 可跳）：`无法打开执行者会话：<原因>` —— 原因里写明是哪一种（`sessionQuery` 未挂载 / 当前宿主没有 uiWorkspace 服务 / 重启 dsh web 后再试），因为三者的补救办法不同。
   - `open`（会话已定位、`openSession` 抛错或被拒）：`找到执行者会话，但打开失败（原因）。`
   从点击到结果之间按钮进入**查找中…** 并 `disabled`（`onLookupStart` 只在**真的需要查找**时触发，有句柄的点击不会闪一个它没有的等待态）；失败后 id 旁出现 `↻` 提示可再点重试。节点 id 仍是**唯一入口**，不再出现第二个链接。
6. **wire**：新增 `resolveExecutorSession` descriptor 与结果 schema `{ sessionId?, status?, error? }`（`status` 故意是**可选**的 `enum`：老宿主没有这个方法，客户端要能把它读成"两半不同步"而不是一个猜出来的理由）。守卫：`test/executor-session.spec.ts`（三条过滤、读预算只花在最新的候选上、`never-dispatched` 不列语料、缺席服务不崩、一个坏日志不影响其它候选、正则复核挡住"只是接近"的文本）、`host.spec.ts` 的 W18 块（有句柄 ⇒ 零读 / 历史记录 ⇒ 解析并**落盘写回**且第二次零读 / 三条过滤只读命中的那个 / 找不到 vs 从未派发 / 无 `sessionQuery` ⇒ `unsupported` 且树照常渲染 / 别人的节点不读任何东西 / **挂载+snapshot+detail+`list_missions`+`mission_result` 全程 `listSessions` 与 `filterEvents` 调用数为 0**）、`client-api.spec.ts`（参数透传、四种答案作为**数据**返回、老宿主与 404 都归为"重启 dsh web"、信封错误与无法识别的负载）、`client-view.spec.tsx`（无句柄节点 ⇒ 仍是可点入口且带 `avwf-worker-lookup`、点击顺序 `busy → lookup → opened`、四类文案互不相同、无 `uiWorkspace` 时**仍是入口**且在点击里解释「宿主不支持跳转」、渲染整屏无句柄节点 **0 次查找**、节点 id 每处只有一个链接）、`core/test/tree.spec.ts`（`rememberExecutor` 落盘往返与写一次语义、未知节点不抛）。

**2026-10-02 修订之三：派发 prompt 写明容量排队等待。** 实测里一个真实排队 123 秒（`createdAt=13:28:21` vs `claimedAt=13:30:24`）的执行者向 owner 报告"我没有等待"—— 因为它拿到的 prompt 里根本没有这个事实。现在进入 `running` 的派发会把等待写进 prompt：`本任务在容量队列里等了约 N 分钟（原因：机器容量已被占用）。` 数据**不是新造的计时器**，而是引擎既有的 deferral 记账：`MissionEngine.pass()` 选中候选后、在 `capacityWaits.delete()` **之前**读同一条老化时钟（`capacityWaits`，即 `waitingFor` 与限流日志用的那一份），算出 `waitedMs`，经 `StartWorkerInput`/`ResumeWorkerInput` 交给宿主，宿主再作为 `WorkerPromptOptions.capacityWaitedMs` 交给 `buildWorkerPrompt`（冷唤醒同样带上）。措辞由 `waitedLabel` 统一：不足一分钟说"约 N 秒"（最小值 1 秒，`0`/缺省=从未排队 ⇒ **整句不出现**），超过则"约 N 分钟"。节点从未被容量推迟过时**一个字的排队说明都没有**。守卫：`core/test/capacity-gate.spec.ts`（引擎交给 start 的 `waitedMs` 等于 `now − 首次推迟时刻`，未排队者 `0`）、`core/test/prompt.spec.ts`（有等待 ⇒ 含该句且位于「本任务」之前 / 无等待 ⇒ 不含）、`plugin/test/capacity-host.spec.ts`（真挂载：被容量挡住的第二个任务派发时 prompt 含该句，先跑的没被挡的那个不含）。

**2026-10-02 修订之五：wire 1 → 2，懒查之前先看两端版本。** 「修订之四」加了 `resolveExecutorSession` 这条 Remote，却**没有**跟着 bump `SNAPSHOT_WIRE_VERSION`（仍是 1）。实测后果：点历史任务 `059f56ed`（记录无句柄 ⇒ 走懒查）时，前端 bundle 已是新的、宿主进程还是旧的，gateway 对未注册的方法回 HTTP 404，客户端把 `transport failure … HTTP 404` 原文摊在用户面前 —— 它读起来像"任务丢了"，而真正该说的是"宿主还是旧版本"。三处一起改：① `SNAPSHOT_WIRE_VERSION` 1 → 2，并在 `wire.ts` 写明**新增/删除一个 `@Remote` 方法就必须 bump**（新增可选**字段**不用：`.default(...)` 的 schema 已经跨版本吸收，marker 管的是**方法集合**）；② 新增 `EXECUTOR_LOOKUP_WIRE_VERSION = 2`，`fetchExecutorSession(…, hostWire)` 在**发调用之前**就用 `snapshot` 回报的修订号判旧 —— `hostWire < 2` 或缺失时**一次 remote 都不发**，直接回「宿主仍在运行旧版本（wire N < 2）：重启 dsh 后即可点击历史任务」；`fetchSnapshot` 把 `wire` 带到 `MissionSnapshot` 上（`client/contract.ts` 的类型同步），`client/index.ts` 记住最近一次回报的值（`noteWire` 必须是稳定引用，否则 `refresh` 的 memo 每渲染失效 ⇒ 读循环）并在点击时传下去；③ 兜底：仍然失败（404）时文案点明「宿主可能没有注册这个接口（旧版本 / 未重启）」，而不是只抛 transport 原文。**有句柄的路径完全不受影响**：不读 `wire`、不发 remote，零 I/O 直接打开。守卫：`client-api.spec.ts`（`wire` 随快照带回、`wire=1`/缺失 ⇒ **不发调用**且给出旧版本文案、`wire=2` ⇒ 照常懒查、404 兜底文案、`SNAPSHOT_WIRE_VERSION ≥ EXECUTOR_LOOKUP_WIRE_VERSION`）、`client-view.spec.tsx`（有句柄 ⇒ 直接打开且 `resolveSession` 一次都没被调用）。

**2026-10-02 修订之六：懒查的过滤器是对象联合，不是元组 —— 假实现镜像了猜测，静默 catch 藏了一轮。** 「修订之四」的懒查上线后实测：**只有带句柄的任务能跳转，所有历史任务一律不能**。真因只有一处：`executorSession.ts` 把过滤条件按**元组**发出去 —— `filterEvents(sessionId, [['time', from, to], ['text', 'id: <nodeId>']])` —— 而真实契约是**对象联合**（`@deepseek-ai/dsh-session-query` 的 `SessionEventResultFilter`：`{kind:'time'} & {from?, to?}` / `{kind:'text', text}`）。真实引擎在 `filterEvents` 里**先**跑 `materializeSessionEventResultFilters`，元组的 `kind` 是 `undefined` ⇒ 抛 `session unknown filter kind (missing)`；`sessionRanNode` 的 `catch { return false }` 把它当成"这条日志打不开"吞掉，于是**每个候选都被否**，一律 `not-found`。三处一起改：

1. **形状改对**：`SessionQueryLike.filterEvents` 的声明改成真实联合（只声明用到的 `kind:'time'` 与 `kind:'text'` 两个成员，结构必须与真实一致），实参改成 `[{ kind: 'time', from, to }, { kind: 'text', text: 'id: <nodeId>' }]`。
2. **catch 不再静默**：那次失败至少记**一条** warn（**每次查找最多一条**，含 sessionId 与错误摘要），"一条日志读失败不影响其它候选"的语义不变。没有这条 warn，形状错误与"会话确实被清理了"在外部完全同形。
3. **假实现改成校验真契约**：`test/sessionQueryContract.ts` 的 `checkEventFilters` 收到元组即记为契约违规，`executor-session.spec.ts` 的每个 fake 与 `mount.ts` 的 service stub 都过它，spec 用 `afterEach` 断言违规为空（元组会让**发出它的那个用例**失败，而不是安静地返回 `[]`）；另有一组**跨包钉死**用例直接用真实 `@deepseek-ai/dsh-session-query`（本仓是它的声明 peer）的 `materializeSessionEventResultFilters` / `filterSessionEventDocuments` 跑我们发出的 filter，形状与语义都由**拥有契约的那个包**判定。守卫：`test/executor-session.spec.ts`（发出的 filter 精确等于两个对象子句 / 契约检查本身能抓元组（非空真）/ 失败日志每次查找只 warn 一条且含 sessionId 与错误摘要 / 跨包钉死拒绝元组并选中正确事件）、`test/host.spec.ts` 的 W18 块（真挂载路径 `sessionFilterViolations` 为空）。

**教训**：**假实现必须镜像真实契约，不是镜像实现里的猜测** —— 照抄猜测的假替身会让形状/语义错误在测试里完全隐形；能跨包钉死就用真实包。**并且，别把 catch 写成静默吞掉**：一次被吞掉的形状错误，看起来和"没有结果"一模一样。

**2026-10-02 修订之七：答案也要区分"没有匹配"与"一条都没读成"（N7）。** 「修订之六」把 warn 与契约钉补上了，但**返回的答案本身**仍然把两种情况压成同一个 `not-found`：全部候选读取失败时，用户读到的是「找不到这个任务的执行者会话：它可能已被清理」—— 那正是 W20 的教训被重新穿上。改成：`sessionRanNode` 返回三态（命中 / 未命中 / 读不成+原因），`resolveExecutorSession` 统计本次**实际读过**的候选；**读过的全部失败**（`read > 0 && unreadable === read`，且至少有一条失败原因）时返回契约里既有的 `unsupported` + **首条失败原因**（单行、与其它宿主原因同样截断），客户端本来就用宿主原话渲染 `unsupported`；只要有**一条**读成功而无匹配，仍是 `not-found`。守卫：`test/executor-session.spec.ts`（全败 → `unsupported` 且文案含首条原因、单行、仍只 warn 一条；混合 → `not-found`；服务缺 `filterEvents` → `unsupported`）、`test/client-view.spec.tsx`（`unsupported` 文案把 N7 的原因读给用户，而不是"可能已被清理"）。

## 十、插件构成

### 10.1 挂载形态（实施口径）

```
@avantf/dsh-mission（单个宿主行）
  ├── 任务树服务 + 宿主 KV 域 + 引擎（扫描 / 派活 / 回收）+ timer
  ├── 9 个模型工具（owner 6 / executor 3）
  ├── 指导层上下文（order 在待办之后）
  └── agent/pre-step 钩子 + subagent/end 监听 + /mission 命令
```

**这是同一行的两半，不是两处挂载**：设计之初设想"宿主行只放服务、树工具挂 master 的 preset 行"，
落地时选择了**单宿主行**（profile 里一行即可用，不必改 preset），代价与补偿是：

| 代价 | 补偿 |
|---|---|
| 工具对**所有** agent 可见（不只 master）| 所有写入路径都在宿主层做 `owner_session_id` 归属校验；读不到别人的树 |
| worker 也能看到 `create_mission` | `create_mission` **拒绝任何 subagent 会话**（`session.header.origin === 'subagent'` 或 `delegationDepth > 0`）→ `no-authority` |

将来若要收紧可见性，把工具注册挪到 preset 行即可 —— 宿主 API 不变，`create_mission` 的守卫仍应保留（纵深防御）。

### 10.2 直接复用的既有能力

| 需要 | 用哪个 |
|---|---|
| 生成任务单元 | 既有子 agent 生成能力（`spawn` 语义：空对话、continuable） |
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
| 3 | 工具面（拆解 / 提交 / 读结果 / 收尾）+ 互斥与配额校验 + 拆解去重 + 超长结果落盘 | 三层任务跑到根完成；每个叶任务对应一个新会话；子会话看不到 master 对话；`submit_result` 与 `decompose` 互相拒绝；深度 8 / 子任务 6 / `attempts` 5 各自生效 |
| 4 | 指导层（锚定分段 + 去重）+ 根完成汇报 + pre-step 过滤与放行 + 取消子树 | 状态不变时**不产生新事件**；状态变化时恰好一条；根终态时 master 收到一次唤醒；用户消息既不丢也不被搁置（一次工具调用之后 turn 必须继续到模型自己收尾）|
| 4.5 | **纠偏下传**：根上写的纠偏必须出现在其后代 worker 的 prompt 里（任务链携带）；取消子任务后，**所有**受影响父节点仍可派发；汇总轮读到被取消的子任务时能看到状态与理由 | 单测与挂载级测试各一条（复用树上取消 → 另一父节点变 `ready`；纠偏后后代 prompt 断言；取消后汇总 prompt 断言） |
| 5 | 启动对账（`observeSession` 判 master 存亡）+ 可见性增强（可选）：树状态面板 | master 会话被删除时树被销毁；宿主重启后树保留；面板显示 ready / running / blocked 分布 |

---

## 十二、验收要点

1. **引擎零 LLM**：派活轮次不产生模型请求（对比触发前后的请求数）
2. **任务单元零等待**：worker 的 prompt 里不含子任务进度；worker 生命周期内无空转回合
3. **树是唯一权威**：杀掉引擎进程再起，树状态与 `running` 节点的回收结果一致
4. **重复拆解被抑制**：两个分支独立发现同一缺口时，树上只出现一个节点
5. **指导层不膨胀**：一个完整任务跑完，指导层快照数为个位数
6. **收尾门控生效**：未读结果时 `finish_mission` 被拒
7. **两种代际切换都正确**：热重载（agent 仍活）不重派；进程重启（agent 已死）回收后重派
8. **三层树跑到根 `done`**：拆解 → 子节点全终态 → 汇总派活提交结论 → 根收敛 → 读结果 → 收尾（这条是本设计的核心路径，必须有测试钉住）
9. **并发上限生效**：一批 N 个 ready 节点不会一次派出超过上限的任务单元
10. **容量闸门生效且只排队不拒绝**：装不下的节点留在 `ready`，`attempts`/`failures`/`spawnFailures`/`stalls` 全为 0；work-conserving 用轻任务填满空闲容量；老化超阈值后预留、排空后只派发一次；`weight > capacity` 的节点在无其它 running 时被派发；空闲内存低于下限只推迟不拒绝；`waitingFor` 在 `mission_result` 与面板可见
11. **唤醒真的唤醒**：引擎唤醒产生的 turn 至少带一条消息（否则零模型调用，等于没唤醒）
