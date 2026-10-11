# mission 与 DSH「智能体团队」对照 + 实施计划

对照对象：本工作区 `mission/`（`@avantf/dsh-mission` + `@avantf/mission-core`，plugin v0.4.2）与 DSH 源码里的
Agent Teams（`packages/experimental/{agent-team,tool-agent-team,client-ui-agent-team,agent-team-profile}`，
dsh `0.2.1-alpha.2`，checkout 位于本仓之外：`/home/ffeng/sources/harness/deepseek-harness`）。

**证据口径**：本文全部结论来自读码（两侧源码 + 各自设计文档），**没有跑测试、没有开真实会话**。凡涉及行为的
断言都给了 `文件:行`；凡我推断而非读出的都标了「推断」。文末 §5 是证据索引。

本文分两半：§1–§2 是对照，§3 是实施计划（四项，按可派发的粒度写），§4 是收口。

> **实施状态（2026-10-12 更新，晚于正文）**
> - **P1 已完成**：9 个工具的 output schema 已各自声明（含成功/失败两支的 `oneOf`），由 dsh 的真实校验路径
>   （`assertSupportedJsonSchema` + `validateJsonSchemaValue`）逐分支断言；另有一条反向用例证明"漂移的值会被拒"。
> - **P2 的前置门判定为「不做 scoped 安装」**：实测 `agent.ctx.tools.register` 确实只对那个 scope 生效、子会话
>   继承不到（结论①成立），但 `verifyRegisteredFaces` 读的是**全局注册表**（单参 `tools.get(name)`），改成
>   scoped 注册后 mount 时会报 9 条假 missing；把它改对需要动 base kit + 接口世代，且每次派发的 `toolFilter`
>   都会先抛一次错。**已按替代方案 C 落地**：保持全局注册，把工具可见性收进 `system-prompt/assemble` 的按角色
>   过滤（owner 不含 executor 面、worker 不含 owner 面、其余会话一个都不含）。
> - **P3 已完成**：卸载期的中止被单独识别（沿 `cause` 链），节点回到待派发、不扣预算、日志降级为信息级。
> - **P4 已完成**：`unit` 前缀包含时给 owner 一条一次性提醒，互斥语义与调度判定未动。
>
> 因此 §3 四项**不再有待派项**；§6 的 CHANGELOG 口径已按实际落地执行（P1 不写，P2-C/P3/P4 写）。

---

## 0. 一句话结论

两者不在同一层，交集比直觉小：Agent Teams 是「让模型拥有同伴」的**协作原语**（具名 roster + 直投信箱 +
共享看板），派活与推进**完全靠模型**；mission 是「把事交出去」的**执行引擎**（任务树 + 调度 + 生命周期），
派活与推进**完全靠宿主代码**。二者共用 dsh 的 continuable 子会话缝（`ctx.subagents`），各用了它的一半。

因此 mission 值得借鉴的不是业务模型（在调度、失败预算、范围互斥、冷唤醒上它更成熟），而是 Agent Teams 在
**工程面上的四条纪律**：① 工具结果声明式 schema；② 工具面按 agent 作用域安装；③ 关闭期「取消即预期」的
分类；④ 策略只写一遍。其中 ①② 收益最实在。

---

## 1. 功能/业务对照

| 轴 | Agent Teams | dsh-mission |
|---|---|---|
| 派活者 | 模型（Lead）自己决定建谁、建什么任务 | 宿主引擎，零 LLM 调用（`mission/packages/core/src/engine.ts:2`） |
| 工作单元 | 具名、durable、可反复对话的 teammate 会话 | 一次性执行者会话，用完即弃 |
| 工作从哪来 | Lead 手写任务板（subject / description / blocked_by / write_scopes） | **执行者在执行中自己拆出**前置子任务（`note_mission` → `decompose_mission`，`mission/README.md:37`） |
| 协作通道 | 双向 `send_message`（peer↔peer、peer↔lead），运行中 steer、空闲冷唤醒 | 只沿树：向下 `context` + `corrections`，向上 `submit_mission` 结果，旁路 `note_mission` 分析；**没有消息** |
| 拓扑 | 扁平 roster（≤16，不可嵌套 / 改名 / 删除）+ 任务 DAG | 树：深度 8、单次拆解 ≤6 子、单树 ≤200 节点（`mission/packages/core/src/types.ts:29-53`） |
| 「下一步」信号 | `wait_agent`（只报是否超时，调用方自己重读） | 引擎在 `agent/pre-step` 唤醒 owner（推，不轮询；`mission/packages/plugin/src/index.ts:450`） |
| 中断 | `interrupt_agent`（Lead 专用，保 inbox，不改任务归属） | 无手动中断；引擎按活性回收；`cancel_mission` 取消整棵树 |
| 失败语义 | 有界、响亮、**不重试**：phase `failed`、名字永久占用、send 不重试、owner 不自动释放 | **有预算地自愈**：`stalled`/`hung` 判定、`failures` 5 / `spawnFailures` 5 + `30s×2^(n-1)` 退避、冷却后重派 |
| 范围冲突 | `write_scopes` 只告警，明确「不是锁」（`.agents/notes/implemented/feature/2026-08-05-agent-teams.md:71`） | `unit` 租约**引擎强制**：同一 unit 同时只有一个 `running` 节点 |
| 调度/容量 | 无。就绪不等于开跑（「Task readiness never starts an owner」） | capacity / weight / aging / maxConcurrent；容量只排队不拒绝（`mission/README.md:50-64`） |
| 隔离 | 共享同一 cwd，不做 worktree、不做 lock | 会话边界即隔离；owner 只在被唤醒时读树 |
| 跨会话恢复 | 由 dsh 的 continuable 缝提供冷恢复；Team 只恢复 roster / task | `lastWorkerId` + `parkedWorker` + `dispatchBaseline` 差量，主动冷唤醒 |
| 上限 | maxMembers 16 / maxTasks 256 / maxMessageBytes 64KiB | 深度 8 / 6 子 / 200 节点 / 并发 = 核数−1（可配）/ 结果内联 2000 字 |

一句话：**Agent Teams 把「谁做什么」交给模型，所以把「沟通」做得很足；mission 把「谁做什么」交给引擎，
所以把「沟通」压到零，换成预算、租约与唤醒。**

---

## 2. 设计/实现对照

### 2.1 状态权威在哪

Agent Teams 的状态是**从 Lead 会话日志回放出来的**：`team/member`、`team/task` 两种事件写全量快照 + flush，
投影 `stateVersion: 4` 重放（`packages/experimental/agent-team/src/projection.ts:387-394`）。mission 的状态是
**一份独立 KV 文档**（`ctx.storageDomain` 的 `avantf_mission/trees`，一树一文档），内存里的 `MissionTree`
在打开期间就是权威，每次变更在锁内 flush（`mission/packages/plugin/src/domain.ts:161-169`）。前者天然可审计、
天然容纳多写者；后者天然快、天然单写者。

### 2.2 并发控制：锁 vs 版本号

Agent Teams 面向**多个独立写者**，所以每次变更都带 `expected_revision`，过期即 `TEAM_TASK_STALE_REVISION`
（`agent-team/src/task-board.ts:105-120`）。mission 面向**单一写者**（引擎与工具都过 `MissionTree` 同一把锁），
所以用锁而不是版本号。这不是谁落后，是写者模型不同——mission 不需要 CAS。

### 2.3 幂等与重入

两边都认真做了。Agent Teams 用 `TeamJournal.transact` 按 Lead FIFO 串行化（`agent-team/src/journal.ts:42-52`）；
mission 用 `pump()` 的 `pumping` / `pumpRequested` 标志保证「一轮期间到达的触发不丢」
（`mission/packages/core/src/engine.ts:319-338`）。

### 2.4 授权

Agent Teams 把**调用者身份当凭证**：每个 service 方法都收 exact live `Agent`，Lead-only 的操作在 domain 层
拒绝（`TEAM_LEAD_REQUIRED`）。mission 是另一种形态：owner 由 `TreeRecord.ownerSessionId` 决定，只有**顶层会话**
能建树——`canCreateTree(agent) = !isSubagentSession(agent)`，判据是
`origin === 'subagent' || delegationDepth > 0`（`mission/packages/plugin/src/host.ts:78-81, 1186-1188`）。

### 2.5 恢复

Agent Teams 用**证明式对账**：`provisioning` 记录 + 子会话独立持久化的痕迹（`parentSession` 匹配 +
continuable 描述符 + 初始 user message 已记录）三者齐全才判 `active`，否则 `failed`
（`agent-team/src/roster.ts:375-417`）。mission 用**试探式自愈**：`reconcileOnOpen` 把没有物化 worker 的
`running` 节点降级为 `interrupted` 并留下 `lastWorkerId`，下次派发先试冷唤醒，投递被拒就退回全新会话且
**不扣预算**。两条路都成立。

### 2.6 工具面的装载方式（本对照最关键的一处差异）

Agent Teams **按 agent 作用域安装**：`install(agent)` 往 `agent.ctx.tools.register` 注册，并且只对
`tryMembership(agent) !== undefined` 的 agent 装（`tool-agent-team/src/index.ts:163-172, 404-421`）。
mission **全局注册 + 按面拒绝**：9 个工具在 apply 时全局 `ctx.tools.register`
（`mission/packages/plugin/src/index.ts:334-338`），owner 面只在 `canCreateTree` 为真时施加
（`index.ts:351-352`），worker 面靠派发时的 `toolFilter`（`host.ts:1818, 1878`）。

差别在于**子会话**。mission 自己写了这个机制的原理：「a child inherits its parent's **PRESET composition**,
not the parent agent's own scope」（`host.ts:1856-1859`）。于是任何子会话（Team 的 teammate、`subagent` 工具的
子代理、workflow 的子代理）都继承到 mission 全局注册的 9 个工具；而 owner 面因 `canCreateTree` 为假被跳过，
那条静态指导段又**故意**对这类会话返回空（「The provider returns '' for a session that may not root a tree」，
`index.ts:386-389`）。结果是**不对称**：指导段消失了，工具还在。

（推断，未运行时验证）后果是：在同时挂两个插件的会话里，一个 teammate 会看到全部 9 个 mission 工具（其中 3 个
worker 专用、6 个 owner 专用），其中 `create_mission` 会被 `no-authority` 拒（`host.ts:951-956`），
`note/decompose/submit` 会被 `not-owner` 类拒绝。**边界是稳的**（mission 的立场是「Hiding is usability only —
the refusals stay the boundary」，`faces.ts:1-4`），但每个子会话都在为用不上的工具描述付 token，并留了一条
注定失败的调用路径。§3 P2 就是修这个不对称。

### 2.7 关闭期

Agent Teams 有**明确的受理截止 + 在途操作集 + 有界结算**：`lifecycle.close()` 后 `spawnTeammate` /
`sendMessage` 立刻 `TEAM_DISPOSED`，在途操作共用一个 `disposalTimeoutMs` 期限 `allSettled`，然后按 root
`drainChildren`，失败聚合成 `AggregateError`；并且 `isCancellation()` 沿 `Error.cause` 链把「预期内的取消」
从「真失败」里摘出来（`agent-team/src/index.ts:262-276`、`agent-team/src/lifecycle.ts:31-43`）。

mission 的 `stop()` 是「中止在途 controller → 清表 → 立刻关域」，不 await 在途派发
（`mission/packages/plugin/src/host.ts:578-594`），也没有受理截止标志。派发失败一律走
`tree.reclaim(node.id, 'spawn-failed', claimId)`（`host.ts:1831-1838`），而 `'spawn-failed'` 会
`spawnFailures + 1`（`mission/packages/core/src/tree.ts:1305-1309`）并据此进入冷却。卸载用的 abort 原因
字符串 `'avantf-mission: plugin unloading'`（`host.ts:584`）**全仓没有任何地方读取**，也没有测试覆盖。
于是：**在派发进行中卸载插件，会给那个节点记一次「启动失败」**、让它冷却，并在日志里写成
`dispatch of X failed`；反复重载会把它推向 `spawnFailures` 上限（5）并触发一次误导性的「反复出过问题」上报。
失败后的 reclaim 已被 `.catch(() => undefined)` 兜住，所以不会变成未处理拒绝、也不会杀宿主——代价是**预算与
日志意义上的冤枉**，不是稳定性。§3 P3 就是修这个。

---

## 3. 实施计划

四项都改 `mission/`。**写范围有重叠**（P2 与 P1 都落在 `mission/packages/plugin/`；P3 与 P4 都落在
`mission/packages/plugin/src/host.ts`），因此**按 P1 → P2 → P3 → P4 串行派发**，一次只有一个任务持有
`mission/packages/plugin`。

每项的验收只做**针对性验证**（改动涉及的构建 / 类型检查 + 新增或改动的那几个测试文件），收口按 §4 分档跑。

### P1 —— 9 个工具各自声明结果 schema

**目标**：让编译器与运行时都能抓「工具实际返回值」与「对模型的承诺」之间的漂移。

**依据**：Agent Teams 每个工具都用 `jsonOutput()` 声明完整 `output.schema`，其决策记录写明理由——「返回无类型
JSON 会让 `execute` 与对模型的承诺悄悄漂移，编译器抓不到」
（`agent-teams.md:79`；实现见 `tool-agent-team/src/index.ts:86-153`）。而 dsh 会**强制校验**这个 schema，
且**从不把它发给模型**（`schemas()` 只白名单 name / description / parameters，
`packages/core/tools/src/index.ts:213-221, 260-267`）——所以本项**零 prompt token 变化**。

**现状**：`mission/packages/plugin/src/tools.ts` 的 `outputFor(wellFormed)` 给 9 个工具共用一个
`{ type: 'object', additionalProperties: true }`（`:50-59`），等于什么都没声明。

**改动点**

1. `outputFor(host.wellFormed, schema)`：多收一个 schema 参数，`render` 一字不改（仍先
   `wellFormed.deep(value)`、再取 `summary` 或 `JSON.stringify`）。
2. 在 `tools.ts` 顶部定义一份共享骨架与 9 份 `data` 形状。已核对的返回形状：
   - 成功：`{ ok: true, summary: string, data?: <各工具自己的> }`；
   - 失败：`fail(refusal)` / `notReady` / `NO_CALLER` 一律 `{ ok: false, summary: string, data: { code: string } }`
     （`tools.ts:84-103`）。
   - 因此每个工具的 schema 用 `oneOf` 区分成功/失败两支（`oneOf` 在本仓已被使用：
     `create_mission` 的 `analysis` 参数，`tools.ts:274-280`）。逐工具的 `data` 字段以各 `execute` 的实际返回
     为准（`create_mission` → `{root_id}`；`adjust_mission` → `{root_id, delivered, voided}`；
     `cancel_mission` → `{root_id, failed_nodes}`；`decompose_mission` → `{created, reused}`；
     `note_mission` → `{node_id, analysis_attempt}`；`submit_mission` → `{node_id, parent_ready}`；
     `mission_result` / `list_missions` / `finish_mission` → 以实现为准，逐个核对 `tools.ts:454-573`）。
3. `notReady` / `NO_CALLER` 两个降级返回也要落在 schema 内（它们走的是同一个 `data.code` 形状，天然吻合）。

**代价与风险**：只动 `tools.ts`（+ 一个新测试文件）。风险是「写完与 `execute` 不一致 → 运行期拒绝工具返回」；
这正是本项要暴露的问题，不是副作用。**不要**顺手改工具描述或参数 schema。

**验收**

- 新增 `mission/packages/plugin/test/tool_output_schema.spec.ts`：
  ① 对 9 个工具各取一次「成功」返回与一次「失败/降级」返回，断言都通过该工具自己的 `output.schema`
  （用 dsh `@deepseek-ai/dsh-tools` 的 schema 校验路径，或 `z.toJSONSchema` 反向核对 `required` 集合）；
  ② 断言 `required` 覆盖 `ok` 与 `summary`，且没有任何工具的 schema 仍是 `additionalProperties: true` 的空壳。
- 命令：`cd mission/packages/plugin && pnpm test`（`vitest run`，见 `mission/packages/plugin/package.json:34-39`）
  加 `pnpm typecheck`。

### P2 —— 工具面改为按 agent 作用域安装

**目标**：mission 的 9 个工具只出现在「用得上它们」的会话里；删掉 §2.6 那个「指导段消失、工具还在」的不对称。

**依据**：Agent Teams 的做法（`tool-agent-team/src/index.ts:163-172, 401-421`）：一份 `installed: Map<Agent,
disposer>`，`agent/created` 时按 `tryMembership` 判定是否安装，`agent/disposed` 时卸载，`ctx.effect` 兜底全清；
工具注册进 `agent.ctx.tools.register`。

**改动点**

1. **前置调研（本项第一步，必须先做）**：确认两个语义，任何一条不成立就要换方案并回报：
   ① `agent.ctx.tools.register` 是否只对那个 agent 的 scope 生效、**不会**被子会话继承
   （读 dsh `packages/core/tools` 的 scope 语义与 `agent.ctx` 的派生规则）；
   ② base kit 的 `verifyRegisteredFaces`（apply 时调用，`mission/packages/plugin/src/index.ts:342-344`）判定的是
   **全局注册表**还是某个 scope——若它读全局注册表，改成 scoped 注册后这条复查会失败，需要在同一改动里把复查
   的调用点/判据一并调整（它属于 base kit，改法要遵守根 `AGENTS.md` 的「抽到 base 的次序」）。
2. `mission/packages/plugin/src/index.ts`：
   - 删除 `for (const tool of tools) ctx.tools.register(tool)`（`:334-338`）；
   - 删除 `ownerFaces` Map 与 `applyOwnerFace`（`:350-364`）、以及
     `system-prompt/assemble` 里 `visibleTo(assembled.tools, OWNER_TOOL_DENY)` 那一半（`:378-384`）；
   - 新增 `installFace(agent)`：`canCreateTree(agent)` → 注册 owner 面 6 个工具
     （`create/adjust/mission_result/list/finish/cancel`）；`host.isWorkerClaim(agent.id)` → 注册 worker 面 3 个
     （`note/decompose/submit`）；其余会话不注册任何 mission 工具；
   - 挂 `agent/created` / `agent/disposed` / `ctx.effect` 三个口，形状照 `tool-agent-team` 的 `installed` Map；
     冷恢复（重启后 agent 已存在）要覆盖：apply 时先扫一遍 `ctx.agents.list()`（同 agent-team 在
     `:412` 做的）。
3. `mission/packages/plugin/src/faces.ts`：`OWNER_TOOL_DENY` 的语义由「拒绝清单」变成「owner 面不该有的名单」，
   用它从 `tools` 数组里**挑出**owner 面（`visibleTo` 保留，改用正向挑选），`WORKER_TOOL_DENY` 保持原义。
4. **保留**派发时的 `toolFilter: { deny: WORKER_TOOL_DENY }`（`host.ts:1818, 1878`）不动——它是第二道，
   覆盖「子会话意外继承」这种异常。

**代价与风险**：本项是本计划里唯一动挂载结构的改动，必须整树回归。风险点集中在第 1 步的两个语义；`restrict()`
抛错的既有容错（`host.ts:1883-1893`）不在本项范围内，不动。

**验收**

- 扩展 `mission/packages/plugin/test/faces.spec.ts`：断言 ① 顶层会话的 tool schema 集合含 owner 面 6 个、
  不含 worker 面 3 个；② 一个 `origin: 'subagent'` 的会话（用现有 fixture 造）**不含任何** mission 工具；
  ③ worker 会话仍含 `note/decompose/submit`。
- 补一条挂载级用例（`mission/packages/plugin/test/mount.ts` 的挂载夹具）：`agent/created` 后安装、`agent/disposed`
  后卸载、插件卸载后 `installed` 全清。
- 命令：`cd mission/packages/plugin && pnpm test && pnpm typecheck`，再加 `pnpm build:dsh mission`
  （含挂载冒烟，`mission/README.md:160`）。

### P3 —— 关闭期的「取消即预期」分类

**目标**：卸载插件不再给在途派发的节点记一次「启动失败」、不再让它冷却、不再打误导的 WARN。

**依据**：Agent Teams 的 `isCancellation()` 沿 `Error.cause` 链判定并放行预期内的取消
（`agent-team/src/lifecycle.ts:31-43`）；mission 的对应能力只落在「域关闭后的 start-up 失败」两处
（`host.ts:447, 542`），派发路径没有。

**改动点**

1. `mission/packages/plugin/src/host.ts`：把 `new Error('avantf-mission: plugin unloading')`（`:584`）提成
   模块级常量并保留引用，新增私有谓词 `isUnloadAbort(error)`（沿 `cause` 链比对那个常量；`cause` 链的遍历
   形状照 agent-team 的 `isCancellation`）。
2. 派发 catch（`:1831-1852`）：
   - `isUnloadAbort(error)` 为真 → 回收原因改用新的 `'unloading'`，日志降为 `info` 并写明是卸载；
   - 否则维持 `'spawn-failed'` 与现有的 `notifySpawnTrouble` 分支不变。
3. `mission/packages/core/src/tree.ts` 的 `reclaim` 增加 cause `'unloading'`（`:1261-1313`）：行为与既有
   `'wake-failed'` 同一支——`status: 'ready'`、`claimedBy: null`、**不扣任何预算、不记 stalls**（理由同
   `:1294-1304` 的注释：启动从未发生，这不是任务的失败）。既有 `cause` 的联合类型要一并扩。
4. **先固化现状**：在动手前先加一条断言「当前行为是 `spawnFailures` 会 +1」的测试（做法见下），让改动前后的差异
   是被测出来的、不是被声称的。

**代价与风险**：动 `host.ts` 的派发 catch 与 `tree.ts` 的 `reclaim`，两者都有既有测试覆盖
（`plugin/test/host.spec.ts`、`core/test/tree.spec.ts`、`plugin/test/lifecycle-open.spec.ts`）；新增 cause 是
纯增量，不改既有 cause 的语义。

**验收**

- 新增 `mission/packages/plugin/test/unload-mid-dispatch.spec.ts`：用现有 subagent 替身（`test/fixtures.ts`）
  让 `startContinuable` 挂住不 resolve → 调 `host.stop()` → 断言 ① 节点的 `spawnFailures` **没有**增加；
  ② 节点回到 `ready` 且可再次派发；③ 日志里没有 `dispatch of … failed` 的 WARN；④ 没有任何未处理拒绝
  （测试里挂 `unhandledRejection` 钩子）。同文件保留一条**改动前行为**的说明性断言（例如直接对
  `reclaim(id, 'spawn-failed')` 断言 +1），让「分类」这件事在测试里看得见。
- 命令：`cd mission && pnpm --filter @avantf/mission-core test && pnpm --filter @avantf/dsh-mission test`
  加 `pnpm typecheck`。

### P4 —— unit 前缀重叠的告警

**目标**：`unit` 的**互斥语义不变**（仍是精确匹配的引擎强制租约），但两个同时 `running` 的节点声明了互相包含
的范围时，owner 得到一条可行动的告警。

**依据**：Agent Teams 的重叠判定是「相等 **或** 前缀包含」（`l === r || l.startsWith(r + '/') ||
r.startsWith(l + '/')`），只对 `in_progress` 的任务产生告警、绝不阻塞
（`agent-team/src/task-view.ts`，判定与归一化在 `agent-team/src/validation.ts:26-33`）。mission 的
`create_mission` 工具描述明说「父目录与它下面的文件算两个范围，不会互相排斥」（`tools.ts:256-258`），
而「两个执行者同时改同一片地方」正是当初加租约要防的事故（`mission/README.md:47` 的 unit 说明、
`docs/design/2026-10-02-unit-lease.md`）——包含关系是同一事故的另一个形状。

**改动点**

1. `mission/packages/core/src/dispatch.ts` 新增纯函数 `unitsOverlap(a, b)`（相等或前缀包含，入参是
   `normalizeUnit` 之后的键），与既有 `normalizeUnit` / `unitHolder` 同住一个模块。
2. `mission/packages/core/src/engine.ts` 在每轮 `pass()` 末尾（`publishWaiting` 附近，`:634-649`）扫描同一次
   快照里**同时 `running`** 的节点两两比较 `unit`；命中则通过 hooks 上报一条
   `notifyUnitOverlap?({ rootId, nodeIds, unit, other })`。上报**一次**：用引擎内存里的 Set 记住已告警的
   `rootId+pair`（重启后可能重复一次——这是 advisory 信息，值得用零 schema 改动换）。
3. `mission/packages/plugin/src/host.ts` 实现 `notifyUnitOverlap`：日志一条 WARN +
   `deliverToOwner` 一条中文一句话（形状照 `notifySpawnTrouble`（`host.ts:1986`）与 `notifyStalled`
   （`host.ts:1999`）），
   文案要点：哪两个节点、各自的 unit、建议把其中一个的 `unit` 写成另一个或改窄。

**代价与风险**：核心是 O(running²) 的字符串比较，running 数量以容量为界（默认核数−1，上限 64），代价可忽略。
不改 `WaitingFor`、不改调度判定、不改 domain schema。

**验收**

- `mission/packages/core/test/unit-lease.spec.ts` 增补：① `unitsOverlap('a', 'a/b')` 为真、`('a','ab')` 为假、
  `('a','a')` 为真；② 两个 `running` 节点 unit 为 `a` 与 `a/b` 时 `notifyUnitOverlap` 恰被调用一次；
  ③ 第二次 `pass()` 不重复调用；④ 只有精确相等时（既有情形）不触发本告警。
- `mission/packages/plugin/test/unit-lease.spec.ts` 增补：owner 收到一条消息、日志一行、且**没有任何**节点状态
  或 `waitingFor` 因此改变。
- 命令：`cd mission && pnpm --filter @avantf/mission-core test && pnpm --filter @avantf/dsh-mission test`
  加 `pnpm typecheck`。

---

## 4. 收口

四项都是 `mission/` 树内的改动、**不碰 `base/**`**，因此按根 `AGENTS.md` 的**快档**收口即可：

- 每个 P 项结束后：`pnpm check:fast mission`（build + typecheck + 该树一次全套测试 + `guard` + 四个自测 +
  `prepublish:assert`）。
- 四项全部落完、准备发版时：`pnpm check:release`（含 pack、`old-dsh` 下限门、mount smoke、根 `release:check`）。
- 改完后发布面要跟的两处（`mission/CHANGELOG.md` 与 `mission/packages/plugin/README.md`）：
  - P1 是纯内部（schema 不发模型）→ **CHANGELOG 不写**；
  - P2 会改变「子会话里能看到什么工具」→ 属用户可观察，CHANGELOG 写；
  - P3 改变卸载期行为与日志 → 属用户可观察（升级/重载行为），CHANGELOG 写；
  - P4 新增一条 owner 能收到的告警 → 属用户可观察，CHANGELOG 写。
- 每项的「没能验证的东西」必须写在任务结果里（例如 P2 的前置两条语义、P3 是否真有未处理拒绝）。

---

## 5. 证据索引

**Agent Teams（路径相对 `/home/ffeng/sources/harness/deepseek-harness`）**

- `docs/subsystems/agent-team.md` —— 子系统类型与 `ctx.agentTeams` 服务面。
- `packages/experimental/agent-team/README.md` —— 配置默认值、限制、已知限制清单。
- `packages/experimental/agent-team/src/{index,roster,task-board,task-graph,task-view,projection,journal,lifecycle,activity,validation,error}.ts`
- `packages/experimental/tool-agent-team/src/index.ts` —— 9 个工具、`team:policy`、按 agent 安装、声明式 output。
- `packages/experimental/client-ui-agent-team/src/**` —— Web 面板（slot、投影读取、只读）。
- `packages/experimental/agent-team-profile/{src/index.ts,cordis.patch.yml}` —— 组合包如何挂载它。
- `.agents/notes/implemented/feature/2026-08-05-agent-teams.md` —— 身份/信箱/任务/共享目录的决策记录（含被否决
  的备选方案）。
- `snapshots/session/team-targets/{system-prompt.expected.md,tool-schemas.expected.json}` —— prompt 与工具 schema
  的钉死快照。
- `packages/core/tools/src/index.ts:213-221, 260-267` —— 输出 schema「强制校验、永不发模型」。
- `packages/subagent/subagent/src/child-agent.ts:120-152` —— 子会话的 `origin` / `delegationDepth`。

**mission（路径相对本仓根）**

- `mission/README.md` —— 设计原则、关键参数、调度语义 v1、worker 保留与清理四步。
- `mission/docs/design/mission-engine-plugin.md` —— 主设计文档（状态机、绑定与活性、主循环、执行契约、指导层、
  异常与边界、验收要点）。
- `mission/docs/design/2026-10-02-capacity.md`、`2026-10-02-unit-lease.md`、`2026-09-20-session-continuation-proposal.md`
- `mission/docs/plugin-internals.md`、`mission/docs/references/*`
- `mission/packages/core/src/{types,engine,prompt,tree,dispatch,capacity,resources,liveness,continuation,timing}.ts`
- `mission/packages/plugin/src/{index,tools,faces,host,prompt,domain,wire,projection,workerSessions,coldResume}.ts`
- `mission/packages/plugin/test/**`、`mission/packages/core/test/**` —— 现有测试面（P1–P4 的落点）。
