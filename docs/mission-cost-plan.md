# mission 插件侧成本项：实施计划（2026-10-12）

来源：2026-10-12 的「任务跑起来就卡」取证（面板 / 浏览器侧）。**本计划的改动全部落在 `mission/` 树内**；
DSH 外壳侧的成本（全局投影流未合并 → 浏览器每帧 O(N 会话) 重建列表 → 侧栏不虚拟化且每次行集合变化做强制
同步布局 → durable subagent 的投影 store 不驱逐 → 整数组 `subagentCatalog`）不在本仓，另案处理。

**不重复已落地的部分**：2026-10-03 性能专项的 P2（client bundle → `--minify`）、P3（retention 三门 + 异步 fs）、
P4（行投影只带 `contextCount`、`ROW_CORRECTIONS_MAX`、`NodeRow` memo、`byId` useMemo、单一 coalescer）与
P11（`PROMPT_LIMITS` 的 `childrenBody` / `childBodyChars` / `analysisNotes` / `corrections` 上限）都已在当前
代码里，本文不再列。

**证据口径**：以下每条都来自读码（含当前工作树）。凡未跑测试的都标了「未运行验证」。

> **实施状态（2026-10-12 更新，晚于正文）**
> - **N4 已完成**：`plugin-internals.md` 与 `design/mission-engine-plugin.md` 里那处 `rows.subagent` 都改成了
>   真实投影 key `subagentCatalog`（`grep -rn "rows.subagent" mission/` 已零命中）。
> - **N1 已完成**（wire 3 → **4**）：新增轻量 `status`，标签状态那次兜底读不再拉全量快照；面板可见时的即时读
>   仍走全量。新方法要跟的四处（descriptors / wire-signature / host.spec 的发布面期望 / `index.ts` 的诊断日志）
>   都已跟改。
> - **N2 已完成**：树内窗口化单位从"棵树"改成"可见行"（阈值 120，含树头）；展开/覆写/详情/复用与排队标记语义未变。
> - **N3 只交付了第一步（仪器化）**：`snapshot` 多带一个 `bytes`（仅调试日志、不进 schema），客户端记
>   `safeParse` / 合并耗时。**第二步（增量）按判据止步**——用本机真实任务存储测得最大一帧是 **94 棵树 / 94 节点
>   / 73 KB、`safeParse` 0.148 ms/帧**（宿主投影 0.464 ms），而真实存储里 139 棵树**没有一棵超过 1 个节点**；
>   增量能省的是亚毫秒，代价是本计划唯一的"显示错行"风险 + 一套合并/回退路径。**`SNAPSHOT_WIRE_VERSION` 因此
>   保持 4，未 bump 到 5**。若将来真实树长到文档 §N3 引用的那个量级（20k 节点 / 130 ms 级），再按当时的实测重新评估。
> - **另需说明**：§0 的两条派发前置（agent-team 的 P1–P4、`review/2026-10-12-fix-workorder.md` 包 M）现在都已收口，
>   工作树已提交入库，不再占用这些文件。

---

## 0. 派发前置（必须先满足，否则会撞车）

| 占用者 | 已占文件 | 状态 |
|---|---|---|
| 另一会话正在实施 [`mission-vs-agent-team.md`](mission-vs-agent-team.md) 的 P1–P4 | `plugin/src/{tools,index,faces,host}.ts`、`core/src/{tree,dispatch,engine}.ts` | 进行中 |
| 工作树里的 [`review/2026-10-12-fix-workorder.md`](review/2026-10-12-fix-workorder.md)「包 M」 | `plugin/src/projection.ts`（新）、`host.ts`、`index.ts`、`workerSessions.ts`、`wire.ts`、`client/contract.ts`、`test/*.spec.ts` | 进行中 |

N1–N3 **都**要动 `wire.ts` 与 `host.ts`，与上面两者重叠。因此：

1. 等上述两条收口（工作树回到只有本计划改动的状态）再派发 N1–N3；
2. N4 只动文档，**任何时候都可以做**；
3. N1 → N2 → N3 串行（N1/N3 共写 `wire.ts` + `host.ts`；N2 与前两者共写 `mission/packages/plugin`）。

**包 M 的两条既有约束要延续**：`@Remote` 装饰的方法**必须留在 `AvantfMissionHost` 原型上**（`test/wire-signature.spec.ts`
用 `Function.prototype.toString()` 逐参数比对）；新增 `@Remote` **必须 bump 对应的 wire 版本常量**并同步那条比对。

---

## N1 —— 标签状态改为轻量读取（不再每 30s 拉全量快照）

**目标**：给标签上的 `●` 判"有没有 running"，不再每 30s 拉一次整棵树。

**依据（已核对）**：`startPolling` 是**无条件**的（`plugin/src/client/status.ts:332`），每 tick 调
`fetchSnapshot(remote, sessionId)`（`:273`）拉**完整快照**，再用 `snapshotHasRunning` 走遍
**所有树 × 所有节点**（`:78`）。它针对当前选中的会话一直跑，与用户有没有在看面板无关。

**改动点**

1. `plugin/src/wire.ts`：新增一个**非流式** Remote 描述符 `status`（入参 `{ sessionId?: string }`），结果 schema
   只含 `{ running: boolean }`；`SNAPSHOT_WIRE_VERSION` 由 3 → 4 并写清 bump 理由（同文件 `:240` 的注释规矩）。
2. `plugin/src/host.ts`：加 `@Remote('status')` 方法，实现是短路判定——`treesForSession(sessionId)` 里任一
   `nodes` 有 `status === 'running'` 即 `true`，找到第一条就返回，不构造行投影。
3. `plugin/src/client/status.ts`：30s tick 改调轻量 `status`；`refresh()`（面板可见时的即时读）保留全量
   `fetchSnapshot`，因为那条路径要的是真数据。
4. `plugin/src/index.ts`：那条打印方法清单的日志（`:302`）加上 `status`——它是有意写成"实际发布了什么"的诊断行。

**代价与风险**：新增一个 Remote 方法 → wire 版本 +1，`wire-signature.spec.ts` 与 `client-api.spec.ts` 要跟。
风险点只有"老客户端问新方法拿到 404"这种版本错配，而 `index.ts:296-311` 那条日志已经专门为它准备。
客户端与宿主是同一个包发布的两半，不引入兼容负担。

**验收**

- `plugin/test/wire-signature.spec.ts`：`status` 出现在原型比对与方法清单里，且 `SNAPSHOT_WIRE_VERSION === 4`。
- `plugin/test/client-api.spec.ts`：`status` 的结果 schema 接受 `{running:true|false}`、拒绝其它形状；
  老 snapshot 形状（不含 `status`）仍能解析。
- 新增/扩展 `plugin/test/client-status.spec.ts`：① tick 调的是 `status` 而不是 `snapshot`（用替身记录调用名）；
  ② `running` 为真时标签带 `●`、为假时不带；③ 读失败仍然只降级"不显示标记"，不抛。
- 命令：`pnpm -C mission/packages/plugin exec vitest run test/wire-signature.spec.ts test/client-api.spec.ts test/client-status.spec.ts`

---

## N2 —— 树内按「可见行」窗口化

**目标**：一棵活跃的大树不再一次性挂上全部行。

**依据（已核对）**：窗口化只按**棵树**——`VIRTUALIZE_FROM = 25`、虚拟化器的 `count: trees.length`
（`plugin/src/client/MissionTreeView.tsx:32, 1266-1276`）；树内是递归全量渲染（`:1023-1035`），而
`expanded = override ?? !settled` → **非终态节点默认展开**（`:940`），"正在跑的树"恰好全员非终态。于是
200 节点（引擎允许的上限，`core/src/types.ts:36`）≈ 2000–2800 个 DOM 元素一次挂上；每个渲染出的行还会
`childrenOf(...)` 与 `new Set([...ancestors, node.id])`（`:928, 1031`）。

**改动点**

1. 把"树级窗口化"改成**行级窗口化**：先按现有展开规则算出**可见行数组**（`{node, depth, viaParentId, treeId}`
   的扁平列表，逻辑就是现在 `NodeRow` 的递归，只是不在渲染里做），再对数组做窗口化；渲染时每行只渲染自己，
   **不再递归渲染子行**。
2. 保留既有语义，一处不改：`expanded = override ?? !settled`、`overrides` 的 module 级持久、`openId` 详情弹窗、
   `reused` 标记、`waitingFor` 标记、`contextCount` 那一行、缩进公式 `depth * 14`。
3. 树的条数阈值逻辑（`VIRTUALIZE_FROM`）保留：树很多时窗口化的对象从"棵树"变成"行"，阈值含义随之改为
   "可见行数超过某值才窗口化"——这个新阈值要给出取值理由（建议沿用现有量级：约 25 棵树 × 每棵树可见行的典型值，
   并在注释里写明它是观测量级而不是精确边界）。

**代价与风险**：本项是纯渲染层重构，风险集中在"展开/折叠、覆写、循环保护（`ancestors` 里的 cycle 截断）、
`reused` 标记"这几处语义不能被改掉。`NodeRow` 的字段级 memo 比较器（`:1038-1044`）要跟着搬到新结构上，
它比较的是"同一个节点的行数据变了没有"，与嵌套结构无关。

**验收**

- `plugin/test/client-view.spec.tsx` 扩展：① 200 节点全展开的活跃树，**首帧挂载的行数 ≤ 窗口 + overscan**
  （断言 DOM 里 `data-node-id` 的数量）；② 折叠一个中间节点后可见行数正确减少；③ `overrides` 覆写仍然生效；
  ④ `reused` / `waitingFor` 标记仍然出现在正确的行上；⑤ 同一棵树内滚动到底部能看到最后一个节点。
- `plugin/test/client-view.spec.tsx` 原有用例全绿（展开规则、详情弹窗、点会话跳转）。
- 命令：`pnpm -C mission/packages/plugin exec vitest run test/client-view.spec.tsx`，加
  `node scripts/client-smoke.mjs`（bundle 冒烟）。

---

## N3 —— 快照增量（节点 / 树两档粒度，带全量回退）

**目标**：一次状态变化不再重发整棵树、也不再让浏览器全量 `safeParse` 一遍。

**依据（已核对）**：`snapshot` 每次返回 `{ wire, trees: TreeView[] }` 全量（`plugin/src/wire.ts:259-262`），
每次 revision 变化都重发；浏览器对每一帧做 O(节点) 的 `snapshotResultSchema.safeParse`
（`plugin/src/client/api.ts:182`）。2026-10-03 性能专项在 20k 节点下实测这一条 ≈130ms/帧主线程；当前
≤200 节点/树时是毫秒级——**所以本项排在最后，且第一步是把"真规模下的每帧代价"量出来**。

**改动点**

1. **仪器化（第一步，独立可交付）**：宿主在 `snapshot` 的返回里带一个 `bytes`（payload 的 UTF-8 字节数，仅进
   调试日志，不进 wire 的对外承诺）；客户端在调试日志里记 `safeParse` 耗时与合并耗时。用来在真实树上给出
   "每帧 X KB / Y ms" 的数，作为本项第二步是否值得继续的判据。
2. `plugin/src/host.ts`：**所有** announce 都收口到 `announceOwner(ownerSessionId)`（`:1535`），而
   `announceNode`（`:1554`）在转发时**把 node id 丢掉了**（只解析出 rootId 交给 `announceTree`）——所以今天
   在唯一的收口处**只知道 owner**。给收口加一个可选的变更描述并沿三个私有方法传下去：
   `{ rootId, nodeId? }`（知道节点）/ `{ rootId }`（只知道树）/ `{ all: true }`（整体失效）。
   环里按这些记录存，容量 512，超出丢最旧。粒度天然分两档：知道节点的回**节点级**，只知道树的回**整棵树**
   ——后者已经消掉"一个会话有多棵树时把无关树也重发"的大头。
   实测调用点（本工作树）：`announceAllTrees` `:626`；`announceOwner` `:715, 1438, 1480`；
   `announceTree` `:865, 927, 980, 1102, 1135`；`announceNode` `:1000, 1019, 1039, 1347, 1413`。
3. `plugin/src/wire.ts`：`snapshot` 入参加 `since?: number`；结果变成两支：全量（现状）或
   `{ wire, revision, delta: { trees: [{ rootId, closedAt?, nodes: NodeView[], removed: string[] }] } }`。
   `since` 缺省、`since` 不在环里、或环里出现过"整体失效" → **一律回全量**（这是唯一的正确性兜底）。
4. `plugin/src/client/api.ts` + `MissionTreeView`：客户端保存上一次合并后的树状态，按 id 合并 `nodes`、按
   `removed` 删除、按 `closedAt` 更新归档标记；任何解析失败或版本不符 → 主动请求全量并整体替换。

**代价与风险**：这是本计划里唯一有"显示错行"风险的改动，所以**回退路径必须是默认路径**（判不准就发全量），
并且必须有一条把增量与全量对照的测试。内存代价 = 每 owner 512 条变更记录（定长、有界）。

**验收**

- `plugin/test/host.spec.ts` 扩展：① `since` 命中环 → 只回变更节点；② `since` 太旧/缺失/环里有整体失效 →
  回全量；③ 环的容量边界（513 条变更后最旧的一条触发全量）。
- `plugin/test/client-api.spec.ts` 扩展：**增量与全量等价性**——对同一棵树依次施加一串增量，每步之后把
  合并结果与"同 revision 的全量快照"深比较，必须逐字段相等（这条是本项的 correctness 门槛）。
- `plugin/test/wire-signature.spec.ts`：`snapshot` 的新形状与版本号（3 → 4，或与 N1 合并为同一个版本号——
  两个改动都动 wire，按实际派发顺序决定：**若 N1 已落地，本项 bump 到 5**）。
- 命令：`pnpm -C mission/packages/plugin exec vitest run test/host.spec.ts test/client-api.spec.ts test/wire-signature.spec.ts`

---

## N4 —— 修正文档里的投影 key（随手项，随时可做）

**依据**：`mission/docs/plugin-internals.md:126` 说缓存里的行是 `rows.subagent`，代码里的投影 key 是
`subagentCatalog`（`packages/subagent/subagent/src/catalog.ts:121-131`）。

**改动点**：把该处（以及同段其它提到 `rows.subagent` 的地方）改成 `subagentCatalog`，并保留"这条缓存没有
驱逐 API"的原意。

**验收**：`grep -rn "rows.subagent" mission/` 无命中（或命中处均已说明是历史形态）。

---

## 5. 写范围与排序（一张表）

| 序 | 项 | 允许写 | 依赖 |
|---|---|---|---|
| 1 | N4 | `mission/docs/plugin-internals.md` | 无（随时） |
| 2 | N1 | `plugin/src/{wire,host,index}.ts`、`plugin/src/client/status.ts`、`plugin/test/{wire-signature,client-api,client-status}.spec.ts` | §0 的两个占用者收口 |
| 3 | N2 | `plugin/src/client/MissionTreeView.tsx`、`plugin/test/client-view.spec.tsx` | N1 之后（同包串行） |
| 4 | N3 | `plugin/src/{wire,host}.ts`、`plugin/src/client/{api.ts,MissionTreeView.tsx}`、`plugin/test/{host,client-api,wire-signature}.spec.ts` | N2 之后（共写 `wire.ts`/`host.ts`，且要在 N1 的版本号基础上再 bump） |

`mission/packages/core/**` **本计划不动**（引擎语义、调度、租约、预算与这几条成本路径不相交）。

## 6. 收口

- 每项结束：执行者只跑本文列出的测试文件，如实报告"跑了什么 / 每条测试证明了哪条要求 / 哪些没验证"。
- 每项交给派单方后：`pnpm check:fast mission`（build + typecheck + 该树一次全套测试 + `guard` + 四个自测 +
  `prepublish:assert`）。
- N1/N3 改了 wire 版本与响应形状 → 属**用户可观察**（面板与宿主的版本错配诊断、面板行为），
  `mission/CHANGELOG.md` 与 `mission/packages/plugin/README.md` 要跟；N2 只改渲染策略，若面板行为对用户
  可见（大树的展开/滚动表现）同样写进 CHANGELOG；N4 只改仓库内部文档，不写。
- 全部落完、发版前：`pnpm check:release`。

## 7. 证据索引

- `mission/packages/plugin/src/client/status.ts:78, 262-288, 320-333` —— 标签状态的 30s 全量读。
- `mission/packages/plugin/src/client/MissionTreeView.tsx:30-36, 925-945, 1018-1036, 1266-1287` —— 树级窗口化、
  默认展开规则、树内递归渲染、`byId` 与 memo。
- `mission/packages/plugin/src/wire.ts:200-208, 240, 259-262` —— 描述符清单、wire 版本规矩、快照形状。
- `mission/packages/plugin/src/host.ts:1235, 1250, 1273, 1311, 1419, 1453, 1517` —— 七个 `@Remote` 方法
  （新增 `status` 的位置就在这一段）；`:1509-1562` revision、唤醒、四个 announce 私有方法；`:1745-1784`
  `treesForSession`。
- `mission/packages/plugin/src/client/api.ts:15, 89-113, 182` —— 轮询/合并常量与每帧 `safeParse`。
- `mission/packages/core/src/types.ts:29-53` —— 引擎上限（深度 8 / 6 子 / 200 节点）。
- `mission/docs/plugin-internals.md:126, 256, 282` —— 幽灵缓存、刷新由引擎推、树级窗口化的现状描述。
- `docs/review/2026-10-03-performance-review.md` —— 20k 节点 130ms+/帧、bundle 6.2×、retention 同步 IO 的实测。
- `docs/review/2026-10-12-fix-workorder.md`「包 M」 —— 本轮占用的文件与两条既有约束。
