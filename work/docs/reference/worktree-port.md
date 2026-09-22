# 工作树移植到 DSH：设计文档

> 命名：本插件现称「工作」(work)。本文档描述的**上游** AvantF 实现仍叫任务树 / job，
> 其中的路径、类名与 `job_output` 等一律按上游原文保留，不随本插件改名。

> 2026-09-15 · 状态：待实施（先决问题未定，见 §7）
> 源：AvantF 任务树（`src/avantf/base/harness/job/`、`docs/design/job-stack-refactor.md` v8）
> 目标：DeepSeek Harness（本机 `@deepseek-ai/dsh@0.1.5-rc.1`，profile `web`）
> 结论依据：对本机已安装包的类型契约、README 与 bundled JS 的只读核证；未能实测的项在 §6 逐条标注

## 背景与问题

任务的执行模型是「逐步解决前置问题，不断逼近最终结果」：

1. agent 取得任务，先分析是否有**前置任务**（调查工作、阻塞项），有则拆解为子任务
2. 任务引擎**不负责分派**，只根据「无主子任务」启动子 agent；子 agent 从任务引擎读取任务树，
   **摘取叶任务**执行；执行中发现前置任务则继续拆解
3. 子任务完成 → 结果提交给父节点 → 父节点成为叶任务 → 引擎通知 agent 摘取 → 直至根任务

两条上下文要求是这套设计的核心：

- **① master 执行叶任务时不能携带原会话**，只能带叶任务注入的 prompt（任务链、拆解原因、任务内容）
- **② 同一执行者在做下一个叶任务时不能带上一个叶任务的上下文**
- **③ 待办（todoist）优先级高于任务树**，两者都作为"引导程序"注入

在 AvantF 里，①②靠 `MessageRouter` 的 overlay 切换实现（`JobLayer` 换掉整个 history 层），
③靠 `DynamicLayer` 的 priority + 回退链。本设计要回答：这套东西在 DSH 上能不能落地、以什么形态落地。

## 目标

- 给出任务树在 DSH 上的**可行形态**，并把每条上下文要求落到具体机制。
- 明确**必须自建**的部分与**可直接复用**的部分，界定工作量。
- 记录已核实的 DSH 硬约束，避免照搬 AvantF 的结构。

## 非目标

- 不用 AvantF 的 Python 引擎驱动 DSH 的模型请求（那是"外挂后端"路线）。
- 不重建 `MessageLayer`/`Compactor`（见 prompt 那份设计文档的结论）。
- 不追求与 AvantF 现有 `Job`/`JobLayer` 代码级兼容。

## 关键结论（先读这段）

1. **①② 在 DSH 是白送的，但代价是 AvantF 的 overlay 机制整体作废**。
   DSH 的隔离发生在**会话边界**：`spawn` 后端的子 agent 是全新 agent、**空对话**，
   只收一条 prompt，零父级 transcript。所以「干净上下文执行叶任务」= 一次 `spawn`。
   → **`MessageRouter.cover()/uncover()` 在 DSH 没有对应物，也不可能重建**（§3.1）。

2. **②的准确形态是「每叶一个新 spawn」，不是「同一子 agent 换上下文」**。
   DSH 里"可继续 child"保留持久 Session，会带着上一个叶的历史，且**没有清空该 child 历史的 API**。
   要做②就必须每叶新建 child。代价：跨叶的**执行者连续性**消失（模型/tool 状态不延续）。

3. **③的机制现成，但"优先级"是文本级而非机制级**。
   `ctx.systemPrompt.section({order})` 决定渲染顺序，`dsh-plan-mode` 的 `plan:policy`
   （order 500）就是先例 —— 它靠文本显式声明"override any later tool description or guidance"。
   两条 `context()`（待办 order 小、树状态 order 大）+ 文本措辞即可表达"待办优先"。

4. **任务树本体与待领队列必须自建 host 插件**。
   DSH **没有**共享待领队列、没有"无主 leaf"检测、没有"新工作可用"广播。
   `dsh-jobs` 是 per-owner 且纯内存、不排队不抢占；`dsh-goal` 每会话单目标且写操作要求
   **直接人类消息**（`requireDirectHuman`），不能由引擎自动创建子任务；
   `todo_write` 明确**不支持跨 agent 共享**。
   唯一可用的共享持久状态是 host-plane 的 `ctx.storageDomain`。

5. **「引擎扫描任务树并起 agent」这个形态在 DSH 不存在**，且宿主插件**无法充当唤醒者**。
   `sendMessage` 要求 `sender` 是**确切的在线 Agent**；仅有符号键的 host-protocol 通道
   也需要"确切的直接父亲"授权。→ 调度循环只能跑在**协调者 agent 的回合里**，
   宿主插件负责状态与门控，不负责唤醒。

6. **递归深度可配，且本机 profile 实际不设限**：`maxDepth` 默认 **3**，但 shipped preset
   （`standard`/`ptc`/`cordis`）**全部**把它设为 **`'provider-managed'`**，即不向进程内
   provider 发送上限 —— `spawn` provider 声明具备 `depthLimit` 能力，收到
   `provider-managed` 后不加钳制。→ 本机 Web profile 下子 agent **可以继续递归拆解**；
   但深树会让"每层各持一段上下文"的链变长，仍需按 §7 的先决问题权衡。

## 现状

### AvantF 侧（已核实）

`src/avantf/base/harness/job/__init__.py` 明确标注「**未接线，保留作重建基础**」——
原 `job1` 调度体系已拆除，消费链（`session.job_tree`、TUI job 面板、job 工具）已清理。
保留的是完整数据模型：

| 件 | 位置 | 职责 |
|---|---|---|
| `Job` | `job/job.py:46` | 节点：`JobStatus`（PENDING/DISPATCHED/SUCCESS/FAILED/CANCELLED）、`submit()` → 父 `report()`、`job_infos()` 任务链序列化、`is_leaf`/`leafs()`/`is_terminal` |
| `JobLayer` | `job/job.py:191` | **overlay**：`AbsLayerOverlay(MessageLayer)`，自有 `messages.jsonl`/`context.jsonl`（`save_dir = 父目录/自身 id`），`build()` = `_head()`（任务链）+ 自身历史 + `_tail()`（进度 + 三工具指引） |
| `build_context_path()` | `job/job.py:215` | 沿 parent 链收集、`root→leaf` 顺序 —— 即"任务链、拆解原因、任务内容" |
| `JobTree` / `Root` | `job/tree.py:12,18` | 树容器与状态（`RESUME`/`PAUSE`）—— 极简，待重建 |
| `EngineManager` | `manager/manager.py:66` | `require_engines(n)`：复用空闲念头、不足则 `_spawn_thought_locked`，`_wake` 发 `WAKE_ONLY` 空系统消息 |
| `harness/advance/` | `advance/*.py` | 推进器框架壳（`AbsAdvancer`/`Advances`/`models`）在，**`JobAdvancer` 不在** |

规格侧：`docs/design/job-stack-refactor.md` v8 的 §2.1 明确 **"master 只对话，念头只执行"**
（master 永不认领任何 job 帧，`job_stack` 恒空），§6 给出可认领判定
（非终态叶子 + 子任务全终态的待汇总 node）、跨树按 `created_at` 最老优先、
三段式 + 重验的跨树认领协议、`require_engines(n)` 的口径。

**已知缺陷**：`MessageRouter.cover()`（`prompt/router.py:33`）在 `_overlay` 为 `None` 时
`return False`，**从不替换、永不 `on_attach()`**。重建时会先炸。

### 映射总表

| AvantF 概念 | AvantF 机制 | DSH 落点 | 判定 |
|---|---|---|---|
| 节点执行隔离 | `JobLayer` overlay 换 history | `spawn` 新子会话 | **机制不同，语义等价** |
| 跨叶隔离 | `uncover()` 再 `cover()` 新的 | 每叶新 spawn | **白送**（代价：无延续） |
| 任务引擎 | Python 常驻进程 + `EngineManager` | 宿主 Cordis 插件 | **需自建**（DSH 无现成件） |
| 摘取叶任务 | `claim_next` + 三段式重验 | 协调者的一个工具调用（宿主插件做门控） | **需自建** |
| 树状态持久化 | `job.json` 逐节点落盘 | `ctx.storageDomain`（host-plane KV） | **需自建 schema** |
| "有新叶子"通知 | `on_work_available` → `require_engines` | child 结算通知注入父级 + 协调者回合 | **相邻，需重组** |
| 任务链注入 | `JobLayer._head()` | spawn 的 prompt（首条 user message） | **直接映射** |
| 进度引导 | `DynamicLayer` + priority | `systemPrompt.context()` + order | **直接映射** |
| 待办优先于树 | priority 80 > 树 | 两条 context 的 order + 文本声明 | **需靠文本，非机制** |

## 设计

### 3.1 节点执行：会话边界取代 overlay（要求 ①②）

DSH 里"干净上下文"只存在于**新会话**。子 agent 由 `spawn` 后端建立时：

- 全新 `Agent`、**空对话**，任务 prompt 是唯一 user message
- 继承 cwd / 谱系 / provider / model / reasoningEffort / maxTokens
- **零父级 transcript**；工具作用域与权限**全新扁平**，不继承父级限制
- 子会话 header 记 `parentSession` + `origin: 'subagent'` + `delegationDepth`

比 `fork` 后端（把父级**已完成的轮次前缀**作为 seed）正是本设计**不要**的。

**"每叶一个新 spawn"与 one-shot/continuable 的取舍**（这是选型，不是实现）：

| 模式 | 行为 | 对①② | 代价 |
|---|---|---|---|
| one-shot 前台 | 调用阻塞，返回子 agent 最终文本 | ✅ 每叶天然干净 | 协调者无法同时挂多个叶 |
| one-shot 后台 | 返回 `job_output`，父级收完成通知 | ✅ | 受 `maxConcurrentJobsPerOwner`（默认 10）；job 随进程消失 |
| continuable | 返回持久 child id，`send_message` 续派 | ⚠️ 复用即带旧历史 | 无清空 API → 不能复用 |

本机 standard preset 把 `subagent` 配成 `provider: spawn` + `backgroundMode: continuable`。
→ 若走 continuable，执行者复用会违反②；除非**每叶新建 child**，此时 continuable 只是
"后台 + 可寻址"的载体，不是上下文载体。

**结论**：叶任务与执行者应当**一一对应**，用完即弃；任务树是任务树的持久结构，
执行者是执行者的临时身份。两者不要在同一个对象上纠缠 —— 这正是 AvantF 里
`Job`（持久）与 `JobLayer`（每次 cover 重建）分开的原因，DSH 上这个分离要更彻底。

### 3.2 协调者：唯一驱动者（要求 ①②③的共同前提）

因为宿主插件不能唤醒 agent（结论 5），调度循环必须在 agent 回合里。形态：

```
用户 ──► 协调者（root agent，普通会话）
            │  1. 建根节点（任务树工具）
            │  2. 取可认领叶/待汇总节点
            │  3. spawn 一个子 agent，prompt = 任务链 + 该节点
            │      ├─ 子 agent 回报：完成 + 结果
            │      └─ 子 agent 回报：需要前置任务（拆解请求）
            │  4. 写回父节点 → 新的可认领节点出现 → 回到 2
            └─ 根节点完成 ──► 汇报用户
```

要点：

- **任务链是 spawn prompt 的全部上下文**，与 `JobLayer._head()` 等价（`root→leaf` + 当前任务）
- 子 agent 的产物有**两种**：完成结果，或**拆解请求**（"我还需要先做 X/Y"）。
  后者是"拆解"的落点：节点由协调者写进树，不由子 agent 自己建
- `subagent/end` 是 **observe-only**，不能作为决策接口；但 child 结算时 runtime
  **自动**向父级注入一条 user 角色通知（含子级最后一条 assistant 内容），
  这天然触发协调者的下一回合（就是"通知 agent 去摘叶任务"）
- 协调者用任务树工具读状态、取可认领节点 —— **门控在宿主插件里**，
  即"引擎不派活，只告诉谁能干活"的 DSH 版本

### 3.3 存储：host-plane 自建（要求 ②③的共同前提）

选 `ctx.storageDomain`（host-plane，schema 校验 KV，跨重启持久，发 `domain/changed`，
**模型与 agent loop 看不到**）。已核实的三条硬约束：

1. **同一 domain 名一进程只能 open 一次**，第二次抛 `already-open`
   → 任务树引擎必须是该 domain 的**唯一 open 者**，再把句柄/事件分发给消费者；
   绝不能让每个 preset/agent 各自 open。
2. `domain/changed` 是**无 scope 过滤**的普通 cordis 事件（不像 `goal/changed` 是
   `Scoped<Agent>` 过滤的）→ 要按 agent 通知得自己过滤。
3. 变更**只在单进程内可见**（`domain/changed` 是进程内事件），跨进程/GUI 要另想办法。

**节点 schema 草案**（对应 `Job.to_dict()`，但补上调度需要的字段）：

```
node: {
  id, root_id, parent_id, title, description, context[],
  status: pending | dispatched | success | failed | cancelled,
  created_at, owner_session?, result?, result_injected_at?
}
── 可认领判定沿用 v8 §6.1：非终态叶子 + 子任务全终态的待汇总 node
── 跨树公平沿用 v8 §6.2：created_at 最老优先
── 认领必须「取候选 → 重验 → 提交」三段式（v8 §6.3），否则并发双摘
```

### 3.4 引导层：待办与树的优先级（要求 ③）

分两层，**待办的 order 更小**（先渲染）：

```js
// 待办（priority 更高）
ctx.systemPrompt.context({
  name: 'avantf:todoist', order: 10,
  text: (c) => todoistText(c.agent) ?? '',          // '' 即不贡献
})
// 任务树状态（priority 更低）
ctx.systemPrompt.context({
  name: 'avantf:jobtree', order: 20,
  text: (c) => treeText(c.agent) ?? '',
})
```

注意三点：

1. **优先级是文本级，不是机制级**。DSH 里 order 只决定渲染先后；要"待办优先"必须
   像 `dsh-plan-mode` 那样在文本里写明（"以下待办优先于任务树规划"）。
   v8 §8.1 的"回退链、不累加"是机制级抢占，DSH 的 `context()` 是**累加 + 取代**语义。
2. **快照是 user 角色**（AvantF 的 DynamicLayer 注入的是 system 消息），且
   **内容不变时不产生新事件**（框架按 `retained.text` 去重）→ 树状态文本必须
   "低频、离散、状态迁移才变"，不能塞计数器。
3. **进度不要用 `todo_write`**：它明确不支持跨 agent 共享，且 projection 在
   `turn/start` 清空；它只是工具 + UI 投影，**不注入模型**。

### 3.5 深度约束与树的形态（结论 6）

- `maxDepth` 包默认 **3**，是**绝对委派深度上限**（`0` 禁止委派）；数字上限要求提供方
  具备 `depthLimit` 能力，否则 mount 直接失败
- 达到上限时**工具仍可见**，只是启动被拒（返回出错的工具结果）
- 深度持久化在 session header，跨 resume 存活

**但本机实际不设限**：shipped preset（`standard`/`ptc`/`cordis`）的两条委派行
**全部**写 `maxDepth: provider-managed`，即不向 provider 发送上限；`spawn` provider
声明具备 `depthLimit` 能力，收到 `provider-managed` 后不加钳制。
（`dsh-agent-presets/presets/standard/agent.cordis.yml:211,220`）

→ 递归拆解**在技术上可用**，但代价是：每层子 agent 各持一段任务链上下文，
树的深度 = 委派链的长度，而叶子结果要逐层回填。**"任务树任意深"与"agent 调用链任意深"
是两件事**：前者是数据结构，后者是执行成本。§7 的先决问题因此是**成本与贴合度的权衡**，
不是可行性问题。

## 实施计划

分四步，每步可独立验收。**注意：§7 的先决问题未定前不要开 step 2。**

1. **宿主插件骨架 + 存储**
   - host 插件行挂进 profile 的 `cordis.patch.yml`；`inject: ['storageDomain']`
   - 定义 `defineDomain` schema；提供 `create_root` / `decompose` / `claimable` /
     `claim` / `submit` 的内部 API
   - 验收：建树 → 拆解 → 可认领计算正确；重开 DSH 后树仍在（跨重启持久）
2. **协调者工具 + 执行者 spawn**
   - 在某个 agent preset 里注册任务树工具（写操作）+ 一条任务树 state 的 context
   - 协调者：取可认领 → `subagent` spawn（prompt = 任务链）→ 收结果 → 写回 → 再取
   - 验收：一个三层任务能跑到根完成；**每个叶任务对应一个新 child**
     （对比 `list_agents` 的子会话数）；子会话里**看不到**协调者的对话
3. **引导层 + 待办优先**
   - 两条 `context()`（待办 order 10 / 树 order 20）+ 文本里的优先级声明
   - 验收：状态不变时**不产生新事件**；树状态迁移时恰好一次；
     待办文本排在树文本之前
4. **并发与回收**
   - 多叶并行（one-shot 后台 + `job_output`，或 continuable 多 child）
   - 卡死节点回收（v8 §10.1 的 `scan_stale_jobs`）、取消子树、树终态通知
   - 验收：两棵树并行；超时节点被回收；树完成后协调者收到通知并汇报

## 风险与验证

| 风险 | 说明 | 验证方式 |
|---|---|---|
| 宿主插件无法唤醒 agent | `sendMessage` 要求确切在线 Agent sender；host-protocol 通道也要求"确切的直接父亲" | step 2 用协调者驱动；**不要**设计"插件主动唤醒"的路径 |
| 协调者会话被任务链撑爆 | 每个叶的 spawn + 结果通知都进协调者历史 | 协调者只保留索引不内联结论（v8 §8.2）；超阈值靠 DSH compaction |
| 递归深度 | 本机 preset 设 `'provider-managed'`（不设限），默认 3 不生效；但深树每层都要携带任务链，上下文线性增长 | step 2 先做 1 层委派；递归拆解作为 step 5 单独评估 |
| domain 双 open | 第二次 `open` 同 domain 抛 `already-open` | 引擎独占 open，其他消费者拿句柄；预先用测试锁住 |
| `subagent/end` 被当成决策接口 | 官方定位是 **observe-only** | 只用于观测/日志；驱动靠 child 结算通知 + 协调者回合 |
| 后台并发上限 | `maxConcurrentJobsPerOwner` 默认 10；job 随进程消失 | step 4 压测；必要时改用 continuable 多 child |
| 未实测项 | 上述 API 组合"能否端到端跑通"**只做了只读核证** | step 1/2 就是端到端验证 |

## 待决问题

1. **中间层拆解：收归协调者，还是子 agent 递归拆解？**
   前者树任意深、agent 调用树恒 2 层，但协调者回合数 = 拆解层数；
   后者更贴合"子 agent 自己继续拆解"的描述，且本机 `maxDepth` 不设限、技术上可行，
   但每层各持一段任务链、结果逐层回填，深树的执行成本与失败面都会放大。
   （**阻塞 step 2**）
2. **master 是否亲自执行叶任务？**
   v8 §2.1 说"master 永不认领任何 job 帧"，你这次说"如果 master 参与子任务执行，
   `MessageRouter` 就是必须的"。若确实要 master 本体执行，DSH **不可表达**
   （§3.1：无法给活着的会话换干净上下文）——只能改为"master 再 spawn 一个执行者"。
3. **执行者连续性是否要保留？**
   ②要求跨叶不带上下文，但 AvantF 的 `JobLayer` 保留了引擎身份（模型/tool 状态延续）。
   DSH 上"每叶新 child"会把这份延续一起丢掉。若需要，只能显式放进任务链 prompt。
4. **任务链的 token 预算**：深树的 `_head()` 会线性增长，是否需要在任务链上做摘要压缩？
