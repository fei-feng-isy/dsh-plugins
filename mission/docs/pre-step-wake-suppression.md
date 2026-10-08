# 空跑拦截：不让"执行者结算通知 + 宿主时间注记"白烧一次模型调用

> 本文件是**实施规格**（派单方写给执行者）。范围只在 mission 树；宿主 `dsh-time-context` 的缺口只报告、不修。

## 1. 现象（有日志证据）

任务树跑起来后，owner 会话会周期性出现**空轮**：只带一条 `Time sampled while preparing turn N, step 1: …`
注记、没有用户输入，模型仍被调用一次、产出"无事可做"的回答。实测两轮对比（会话日志 seq）：

| 轮 | 时间 | 发生了什么 | 是否烧 token |
| --- | --- | --- | --- |
| 63 | 12:25:59 | `agent/inbox/spliced {removedCount:1}` 结算通知被丢 → **无 `step/start`** → `turn/end(completed)` | **否** |
| 64 | 12:36:53 | 通知被丢 → `step/start` → `user/message`(kind=`time-context`) → 模型跑一步 | **是** |

差别来自宿主的**时间注记节流**（`dsh-time-context` 默认 `refreshIntervalMs = 600000`，10 分钟）：
turn 63 距上次注入 5m47s → 被节流、没有 step；turn 64 距上次 16m41s → 注记被追加 → 白跑一步。

## 2. 诊断：mission 的拦截**已经生效**，漏点在宿主

- mission 的 `agent/pre-step`（`packages/plugin/src/index.ts:455`）本来就有拦截：
  `discardQueuedNotices` 移除自家 worker 结算通知、① 从 `decision.messages` 里过滤它们、
  ③ 批次空了就交回**空数组**（注释自称"the step closes without a model call"）。
  第 64 轮日志证明它确实丢掉了通知（`removedCount:1`）。
- 但宿主的 `dsh-time-context` 是**前置（prepend）**的 pre-step 监听器：它在 mission 的决策**之后**执行，
  把注记 `[...decision.messages, createUserMessage({…})]` **无条件**追加（只受 10 分钟节流约束）。
  宿主自己的 model-switch 监听器有空批次守卫（`if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision;`），
  **time-context 没有** → 空批次被它填成"有内容" → 跑一步。
- 结论：**上游缺口，我们不改宿主**（只在本文件与收尾报告里记录，必要时由派单方提 issue）。
  我们侧能做的是：让"批次除了自家通知/唤醒之外什么都没有"这一步**根本不进入 admit**。

## 3. 我们侧的修法

### 3.1 pre-step ③ 分支：`reject` 取代"空批次 admit"

现在（`index.ts` 步骤 ③）：

```ts
const admitted = actionable ? kept : []
const queued = takeQueuedInput(agent, host)
return queued === undefined ? { ...decision, messages: admitted } : { ...decision, messages: [...admitted, queued] }
```

改成：**当且仅当**下面三条同时成立时返回 `{ kind: 'reject', … }`（宿主语义：pre-step 拒绝会丢弃已认领的
消息、不跑 step，见 `dsh-agent` 的 `accountsForClaim` 注释）：

1. `content.length === 0`（② 的早返回已经保证：批里没有非自家消息）；
2. `kept` 为空且 `takeQueuedInput(agent, host)` 返回 `undefined`（**没有**排队输入可服务）；
3. `admitStep(agent).admit === false`（见 3.2 收紧后的判据）。

任一条不成立就维持现状（交回 `admitted`/`queued`）。
**必须保留 ② 的早返回与 `takeQueuedInput`**：`reject` 会结束整轮，注释里写的两条事故
（工具调用步读不到自己的结果、排在信号后面的排队输入被搁置）都靠这两处兜住。

### 3.2 收紧 `admitStep` 的"owner 可动作"判据

现状（`host.ts:1256` `admitStep`）把任意 `ready` / `interrupted` / `done` / `failed` **节点**都算"可动作"，
于是执行者一结算（子节点变 `done`/`failed`）就被判"有事可做"。

**owner 真正需要动手的只有两类**：

- **根**进入终态（`done`/`failed`）——这时 owner 要读 `mission_result` 并 `finish_mission`；
- **trouble**（`isTroubled(nodes)` 已有的判据：反复卡住/失败到需要人决定）。

子节点的 `done`/`failed` 由引擎聚合、`ready` 由引擎派发，都不需要 owner 一步。
把判据收紧到这两类，并**在注释里写明理由**（"中间节点的结算由引擎聚合，叫醒 owner 只会让他读一遍指南"）。
**不要**改 `notifyOwner` / `notifyStalled` / `notifyParkedReady` 的触发条件——那三条是刻意的 owner 通知，
本任务只影响"**除此之外的批次该不该进模型**"。

## 4. 安全边界（必须写进测试）

**普通 subagent 的结算通知绝不能受影响**，证据是两层的：

- mission 的 worker 身份由**自铸的窄形状 id** 判定：`claims.ts` 的 `newClaimId()` = `mission-` + 8 位 hex，
  `isWorkerClaimId` = `/^mission-[0-9a-f]{8}$/`；mission 把它作为 `childId` 传给宿主（`host.ts:2000`）。
- 宿主对**其它** spawn 用 `spec.childId ?? brandString(randomUUID())`
  （`dsh-subagent/lib/index.js` 的 `startContinuable`）→ 普通子会话 id 是 UUID，**不可能**匹配该形状；
  且 mission 只在 `ownsTrees(agent)` 的会话上设门，逐条消息判定。

因此 `isWorkerNotice` 只可能对 mission 自己的执行者为真；批里一旦有**任何**别的消息（用户输入、
别的插件的通知、普通 subagent 的结算通知），② 早返回就会把它照常送到模型。

## 5. 验收标准

1. **结算通知独占一批 → 拒绝**：注入一条 `source.kind='subagent-settled'`、`senderSessionId` 为
   `/^mission-[0-9a-f]{8}$/` 的通知，且树里**只有中间节点**结算 → pre-step 决策为 `reject`，
   该轮**不产生模型调用**（mount 级测试断言决策形状即可，不必真跑模型）。
2. **根终态 → 不拒绝**：同一批 + 根 `done`/`failed` → 照常 admit。
3. **混入用户消息 → 不拒绝**：批里有任意用户消息 → admit，且用户消息原样送达。
4. **混入非 mission 的 subagent 通知 → 不拒绝**（`senderSessionId` 是 UUID）→ admit，通知原样送达。
5. **有排队输入 → 不拒绝**：`takeQueuedInput` 能取到消息时仍走现有分支，且该消息被服务。
6. **trouble 场景不回归**：`isTroubled` 为真时仍 admit（现有用例保持绿）。
7. `pnpm -C mission build` → `pnpm -C mission typecheck` → `pnpm -C mission test`（**只跑新增/改动的
   测试文件**）全绿；收口由派单方跑 `check:fast mission`。
8. 文档：`mission/DESIGN.md`（或等价的实现笔记）记一段"为什么 owner 只被叫醒两次：根终态与 trouble"，
   并把上游 `dsh-time-context` 的空批次缺口写进"已知上游问题"（不改宿主）。

## 6. 边界

- 不动版本号 / CHANGELOG；不碰根 `AGENTS.md`（派单方收口时改）。
- **不要**去 patch 宿主的 `dsh-time-context`（那是宿主包，任何本地改动都不随我们发布）。
- 不要扩大范围去动 `notifyOwner` / `notifyStalled` / `notifyParkedReady` 的触发条件。

## 7. 参考坐标

- `mission/packages/plugin/src/index.ts:455`（pre-step 钩子全文）、`:186`（`isWorkerNotice`）、
  `:207`（`discardQueuedNotices`）、`:195`（`PendingInbox` / `takeQueuedInput` 的 inbox 面）
- `mission/packages/plugin/src/host.ts:1256`（`admitStep`）、`:1276`（`ownsTrees`）、`:1043`（`isWorkerClaim`）、
  `:2000`（`childId: SessionId(claimId)`）、`:160`（`workerSessionIdOf`）
- `mission/packages/plugin/src/claims.ts`（claim id 的形状）
- 宿主侧（只读参考，不改）：`dsh-subagent/lib/index.js`（`startContinuable` 的 `childId` 生成、
  `notifySettlement`）、`dsh-time-context/lib/index.js`（前置 pre-step 监听器）、
  `dsh-agent/lib/index.js`（pre-step 拒绝的语义注释）
