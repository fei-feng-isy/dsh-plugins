# 修复：「已完成子任务的执行者句柄、其会话已被回收」——点击不该跳进不存在的会话

> 用户实测现象（2026-10-09）：点一个**已完成任务**的节点 id，出现
> **「历史加载失败：subagent is unavailable（subagent/not-found）」** —— 一句宿主层的骨架错误，
> 出现在**会话视图**里，而不是任务面板里那句设计好的解释。

## 1. 已查实的根因（不是猜测，逐条有据）

1. **节点留着悬空句柄**：派发时节点持久化 `executorSessionId`；保留策略释放 worker 时走
   `retainWorkersFor` → `cleanWorkers(...)`，**只动会话记录 / 归档登记 / 投影缓存，不回写节点**
   （实测：被回收的 `mission-bddd4255` 在会话目录与投影缓存里都没了，而旧任务 `8d1c4d7a` 的节点
   仍指向它）。
2. **客户端把 `openSession` 当 fire-and-forget**：`workerSessionOpen` 的顺序是
   ① 有句柄直接 `open(target)`（零 I/O）② 否则 resolver；`open` 返回 void 且当刻不校验子会话存在
   ⇒ 客户端判 `opened: true`，失败被推迟到聊天视图加载历史时才抛，宿主合成
   `历史加载失败：{message}（{code}）`（模板在 `dsh-client-ui-chat/lib/client.js`，`message` 是骨架化的
   `subagent is unavailable`）。
3. **插件为此写好的分支永远走不到**：`workerFailureText('not-found')` =
   「找不到这个任务的执行者会话（…）：它可能已被清理，或日志已不在本机。」——只有**无句柄**时才会经由
   resolver 到达。

**因此这不是"设计如此"，而是缺口**：结果安全（不会开出空会话），但文案与界面层都不对。
用户已拍板采用 **A1**：**回收时标注节点，点击不再跳转，直接在面板给出那句解释**。

## 2. 要达成的行为（A1）

| 情形 | 期望行为 |
|---|---|
| 句柄**存活**（正常/在保留名额内） | **与今天逐字节相同**：零 I/O 直接打开，不查会话、不查日志 |
| 句柄对应的会话**已被回收** | **不调用 `openSession`**、不查会话日志；面板直接给 `workerFailureText('not-found')` 那句（可带 detail 说明已回收时间） |
| 节点**没有**句柄（历史记录） | 与今天相同：resolver → `not-found`/`never-dispatched` → 解释句 |
| **审计** | `executorSessionId` **保留**（它是"哪个会话执行过这个节点"的唯一记录）；新增的是"已回收"标记，不是删除 |

**要点**：标记必须表示"**这个句柄指向的会话真的被释放了**"，而不是"归档过"。
`cleanWorkers` 的返回里 `cleaned` = 真释放；`refused` / `unarchiveFailures` / `purgeFailures` **不算**
（`refused` 的会话还在，句柄仍然有效）。

## 3. 落点（按此顺序改，不要把关注点混在一起）

1. **`mission/packages/core/src/tree.ts`（域 + 持久化）**
   - `NodeRecord` 增加一个**持久**字段（建议 `executorReleasedAt: number | null`；`null` = 未回收）。
   - `normalizeLoaded` 里对旧记录读成 `null`（照 `executorSessionId` 的写法做类型检查，绝不臆造），
     并让它进 `domain_defaults_pin` 那类"两侧默认值必须同一答案"的机制。
   - **重新派发必须复位**：节点再次被派发（新句柄写入）时该标记回到 `null`——否则第二次执行的节点会被
     永久判为"已回收"。
   - 新增一个**在树锁内**的变更入口（例如 `markExecutorReleased(nodeId, at)`），并且**带守卫**：
     只有当 `node.executorSessionId` 等于被释放的那个 id 时才标记（节点可能已重新派发；旧的释放回执
     不得污染新句柄）。
2. **`mission/packages/plugin/src/index.ts`（回收侧）**
   - `retainWorkersFor` 在 `cleanWorkers(...)` 成功后，对 **`result.cleaned` 的每个 id**：找出
     `executorSessionId === id` 的节点并标记（`all.cleaned.length > 0` 那段日志旁边即可）。
   - **`/clean archive all`（手动释放）走的是同一个 `cleanWorkers`** ⇒ 抽一个共用小函数，两处都调，
     避免"手动清理不标注"的第二个洞。
   - 失败策略沿用现状：best-effort、只 `log.warn`，绝不让保留过程因标注失败而中断；标记后要让投影刷新
     （沿用既有的 announce/变更通知，别新造广播）。
3. **`mission/packages/plugin/src/client/contract.ts` + `host.ts`（视图投影）**
   - `MissionNodeView` 增加可选布尔（建议 `executorReleased?: boolean`），host 从
     `executorReleasedAt !== null` 投影；**必须可选**，老客户端拿不到就该按"未知 = 未回收"渲染
     （与今天一致）。
4. **`mission/packages/plugin/src/client/MissionTreeView.tsx`（点击分支）**
   - 在 `workerSessionOpen` 的①（句柄短路）**之前**插入：节点标为已回收 ⇒ 直接
     `fail('not-found', ...)`，**不调用** `input.open`、**不调用** resolver（零查询不变）。
   - 入口 `createWorkerSessionClick` 与行渲染把"已回收"作为独立状态传给该函数（不要用一个魔法字符串表达）。
   - 文案复用 `workerFailureText('not-found')`；detail 建议写"执行者会话已被保留策略回收"之类。

## 4. 测试（针对性：只跑你新增/改动的测试文件）

- **core**：旧记录归一为未回收；序列化往返保留标记；重新派发复位；`markExecutorReleased` 的守卫
  （句柄已被换掉时拒绝标记）。
- **plugin（host 侧）**：一次保留过程后，**被 `cleaned` 的节点**被标记、`refused` 的**没有**。
- **plugin（client 侧，`client-view.spec.tsx` 风格）**：① 已回收节点 ⇒ `open` 与 resolver **都没被调用**，
  且渲染出"可能已被清理"那句；② 存活句柄 ⇒ **仍然**只调 `open`、不调 resolver（把今天的零 I/O 行为钉死，
  防止这次改动把它退化成"每次都查"）。
- 若 mission 的 `/clean archive` 有测试，补一条"手动释放也会标注"。

## 5. 边界与验收

- **只改 `mission/packages/**`**（不动 `mem/**`、`base/**`、`scripts/bench/**`）。
- **不要发版、不要改版本号、不要改 CHANGELOG**（发版由派单方做：这是用户可观察行为变化 ⇒ mission minor）。
- 验收由派单方跑 `pnpm check:fast mission`；执行者只需：改动涉及的构建/类型检查 + **只跑新增或改动的测试文件**，
  并报告"实际跑了什么 / 每个测试证明了哪条 / 有哪些没能验证"。
- **不得**为了通过而放宽既有断言（尤其 `client-view.spec.tsx` 里我刚加的"零查询"那条与既有 L17 拒绝路径）。
- 兼容性：老记录（无标记）行为必须与今天**逐字节相同**——读成"未回收"。
