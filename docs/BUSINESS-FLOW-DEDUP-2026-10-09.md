# 业务流程去重 v2 实施报告（2026-10-09）

本文件是**受版本管理**的实施报告（`docs/review/` 被 `.gitignore` 整目录忽略，v1/v2 方案与 §8
只存在于工作树）。它自包含地记录：判据与硬约束、逐项状态与证据（commit / 测试名 / 命令与关键
输出）、未做项与原因、收口结果、过程中发现的新事实、v1 七处事实修正、本次改动的文件清单。

规格与口径：`docs/review/2026-10-09-business-flow-dedup-plan-v2.md`（唯一权威规格，本地上）；
v1 审查：`docs/review/2026-10-09-business-flow-dedup-plan.md`。

## 0. 判据与硬约束（复述）

- 收益 > 已验证成本，且不违反家族约束（AGENTS.md）；两个插件绝不互相 import；base 只放 required
  peer；绝不留下未处理 rejection、绝不让插件挂载失败。
- **不动** `INTERFACE_VERSION`（仍 3）、不改进版本号、不改 CHANGELOG、不动检索打分与 `eval_zh` 期望值。
- 每阶段一个 commit（前缀 `refactor(dedup):`），可独立回滚；失败即回滚该阶段写范围，不 `git reset --hard`。
- mem 的 `provision.spec.ts` / `envinit.spec.ts` 只在 `pnpm -C mem/packages/plugin test:dsh` 执行。
- shim 字节一致性 pin 在 **base 套件**（`base/plugin-base/test/interface_consumers.spec.ts`）。
- 收口：三树 `pnpm check:fast` + `pnpm check:release`；环境性失败按规格 §3.3 记录并降级到离线子集。

本轮**交付方式经用户纠偏调整**：解除"不 push"，完成后 commit 并 push（先 origin/gitee，再
github），另产出本受版本管理的报告；`docs/review/**` 一律 `git add -f` 之外一律**不入库**。

## 1. 逐项状态与证据

| 项 | 状态 | 证据 |
|---|---|---|
| P0.1 | 已做（先红） | `base/plugin-base/test/compat_gate.spec.ts` 新增「never throws when the LOGGER itself explodes」。P1 前实测红（`Error: logger exploded` @ compat_gate.spec.ts:133），P1 后 `12 passed`。 |
| P0.2 | 已做（先红） | `mem/packages/plugin/test/provision.spec.ts` 新增「delegates to the shared gate…」。`#1` 前 status 为 `ok`（断言 `probe-skipped` 失败），`#1` 后 `16 passed`（`pnpm -C mem/packages/plugin exec vitest run --config vitest.dsh.config.ts test/provision.spec.ts`）。 |
| P0.3 | 已做（随 #2 一起诞生） | sink oracle 在 `mem/packages/core/test/dispatch.spec.ts`（6 passed），跨面一致矩阵在 `mem/packages/mcp/test/mcp.spec.ts`（11 passed）：成功 / 校验失败 / `mem_admin` list / `kb_list` 参数错 / 未知 key 下 MCP 信封与 `runToolSpec` 信封逐字段一致。 |
| P0.4 | 已做 | 两树 `test/envinit.spec.ts` 各补 absent / incompatible / cannot-tell 三态与 guard 兜底行的**逐字**文案：mem `14 passed`（test:dsh）、mission `13 passed`。 |
| P0.5 | 已做 | `mission/packages/core/test/tree.spec.ts` 三路进 running 的终态字段矩阵（含 adoptParked 预算豁免）：`102 passed`。 |
| P0.6 | 已做（随 #3 一起诞生） | `mem/packages/core/test/trustHeartbeat.spec.ts` fake-timer oracle（每拍一次 tick + 一次 onBeat、stop 后不再触发、失败文案按调用方、失败不吞 onBeat）：3 passed（与 dispatch 合计 9 passed）。 |
| P1 (S0) | 已做 | `base/plugin-base/src/compat.ts`：新增本地 `emit(log, line)`，catch 分支与 verdict 循环两处改经它。`pnpm -C base/plugin-base exec vitest run test/compat_gate.spec.ts` → 12 passed。 |
| #1 | 已做（A 选项） | `mem/packages/plugin/src/provision.ts` 委托 `compat.module.provision(ctx, log, spec ?? compat.spec)`，**保留** `cannotDetermine` 兜底。`provision.spec.ts` 16 passed。 |
| #2 | 已做 | `mem/packages/core/src/dispatch.ts` 增 `runToolSpec`；plugin `index.ts` 变薄委托，MCP CallTool 经它。`dispatch.spec.ts` 6 passed、`mcp.spec.ts` 11 passed、`pnpm -C mem typecheck:dsh`、`pnpm -C mem/packages/mcp typecheck` 均通过。 |
| #3 | 已做 | `mem/packages/core/src/trustHeartbeat.ts` 增 `installTrustHeartbeat`，plugin/MCP 各按自己的文案与 per-beat 工作接入。`trustHeartbeat.spec.ts` 3 passed；typecheck 通过。 |
| #4 | 已做（续做） | `33bace7`：`asCancelled(node, now, ended)` 覆盖两处取消；`tree.spec.ts` 新增终端记录 pin。mission core `tree.spec` 103 passed、全套 269 passed。见 §9.1。 |
| #5 | 已做（续做） | `3a65f18`：`ownedNodeFor(node, sessionId)` 覆盖三处 node 级守卫、`treeOwnedBy(record, sessionId)` 覆盖树级 `delete`；`1181` 异形不动。`host.spec` + `executor-session.spec` + `client-api.spec` 128 passed。见 §9.2。 |
| #6 | 已做（续做） | `ce5f1c0`：`bindRunning` + `budgetRefusal`；P0.5 终态矩阵 103 passed（含 adoptParked 预算豁免）。见 §9.3。 |
| #7 | 已做 | `mission/packages/plugin/src/coldResume.ts` 抽 `deliverPrompt` 骨架，两 wake 的文案/prompt 选项/`markCorrectionsDelivered` 挂点逐字保留。`pnpm -C mission/packages/plugin exec vitest run test/cold-resume.spec.ts test/session-continuation.spec.ts test/continuation-delta.spec.ts` → 25 passed；mission plugin typecheck 通过。 |
| #8 | 已做（续做） | `db98ef1`：两树 loader 的缓存/守卫/决策块下沉 `interface_gate.ts`（两 shim 仍只差 `@module` 一行），措辞走 `DEGRADE_WORDS`。base 全套 475 passed（含字节 pin 2 passed）、mem `envinit` 14 + `provision` 16（test:dsh）、mission `envinit` 13、两树 `check:fast`、两树 `build:dsh`（mount smoke）全过。见 §9.4。 |
| #9 | 部分做 | `stillActive` 统一注解后下沉两树共享 shim（`interface_gate.ts`），两树 `index.ts` 改导入；base `interface_consumers.spec.ts` 2 passed（含字节 pin，diff 仅余 `@module` 一行）。`present()` / 字符串版 `reasonOf` 按 §7 不做。 |
| P5 (B5) | 未做 | 见 §4。两树 `mount-smoke.mjs` 实为 786 vs 708 行、profile 旗标名都不同（`AVANTF_ENVINIT_ABSENT` vs `AVANTF_COMPAT_ABSENT`），不是规格假设的"三行 + describeError"。 |
| P6 (文档) | 已做 | v1 七处事实修正 + 顶部指针（§5）；本报告；v2 §8 已填。 |
| 收口 | 已做 | 三树快档全绿；`check:release` 见 §6。 |

本轮（续做 v2 剩余项）另加 4 个 commit：`33bace7`(#4) → `3a65f18`(#5) → `ce5f1c0`(#6) → `db98ef1`(#8)，
详细证据见 §9。

## 2. Commit 清单（本轮 `refactor(dedup):`）

| commit | 内容 |
|---|---|
| `432a2f1` | P0 前置 pin（5 个测试文件，319 插入） |
| `a2bfd33` | P1 base `provision` 的 logger 契约修复 |
| `4309694` | #1 mem 兼容门禁收敛到 base（A 选项） |
| `c297c5d` | #2/#3 工具边界与信任心跳下沉到 mem 引擎（合成一个 commit，理由见 §7） |
| `cd65d55` | #7 coldResume 抽投递骨架 |
| `e27c15a` | #9 stillActive 下沉两树共享 shim |

续做（v2 剩余项，同一 `refactor(dedup):` 前缀，每项一个 commit）：

| commit | 内容 |
|---|---|
| `33bace7` | #4 两处取消共享 `asCancelled` 节点构造（+ 终端记录 pin） |
| `3a65f18` | #5 host 所有权守卫抽 `ownedNodeFor` / `treeOwnedBy` |
| `ce5f1c0` | #6 三条进 running 共享 `bindRunning` + `budgetRefusal` |
| `db98ef1` | #8 两树 loader 可共享部分下沉 `interface_gate` shim |
| 本报告更新 | §1/§2/§3/§4/§6/§7/§9（受版本管理） |

## 3. 本次改动的文件清单

```
base/plugin-base/src/compat.ts                     (P1)
base/plugin-base/test/compat_gate.spec.ts          (P0.1)
base/plugin-base/test/interface_consumers.spec.ts  (#9)
mem/packages/plugin/src/provision.ts               (#1)
mem/packages/plugin/src/index.ts                   (#2/#3/#9)
mem/packages/plugin/src/interface_gate.ts          (#9)
mem/packages/plugin/test/provision.spec.ts         (P0.2)
mem/packages/plugin/test/envinit.spec.ts           (P0.4 mem)
mem/packages/core/src/dispatch.ts                  (#2)
mem/packages/core/src/trustHeartbeat.ts            (#3, 新增)
mem/packages/core/src/index.ts                     (#3)
mem/packages/core/test/dispatch.spec.ts            (#2/P0.3)
mem/packages/core/test/trustHeartbeat.spec.ts      (#3/P0.6, 新增)
mem/packages/mcp/src/index.ts                      (#2/#3)
mem/packages/mcp/test/mcp.spec.ts                  (P0.3)
mission/packages/plugin/src/coldResume.ts          (#7)
mission/packages/plugin/src/interface_gate.ts      (#9, #8)
mission/packages/plugin/src/index.ts               (#9)
mission/packages/core/test/tree.spec.ts            (P0.5, #4 pin)
mission/packages/plugin/test/envinit.spec.ts       (P0.4 mission)
docs/BUSINESS-FLOW-DEDUP-2026-10-09.md             (本报告, 新增)

续做（v2 剩余项）追加：

```
mission/packages/core/src/tree.ts                  (#4, #6)
mission/packages/core/test/tree.spec.ts            (#4 pin, +1 test)
mission/packages/plugin/src/host.ts                (#5)
mem/packages/plugin/src/interface_gate.ts          (#8)
mission/packages/plugin/src/interface_gate.ts      (#8)
mem/packages/plugin/src/envinit.ts                 (#8)
mission/packages/plugin/src/envinit.ts             (#8)
```

（`docs/review/**` 的两个方案文件按仓库规定**不入库**。）

## 4. 未做项与原因

| 未做项 | 类别 | 具体原因 |
|---|---|---|
| （#4 / #5 / #6 / #8 已不在本表） | — | 续做轮已完成，逐项证据见 §9；上一轮列出的"枢纽并发/剩余预算不足"障碍随另一会话的提交入库而消失，且 #4 的关键理由被实测推翻（见 §7.1 第 7 条）。 |
| P5 `scripts/lib/mount-target.mjs` | 负收益 | 规格假设两树 mount-smoke 只有"NORMAL/ABSENT profile、packed 三行、本地 `describeError`"可共享；实测两份文件 786 vs 708 行、profile 旗标名不同（`AVANTF_ENVINIT_ABSENT` vs `AVANTF_COMPAT_ABSENT`）、链接逻辑与断言体差异大，抽取面远超"三行"，收益低于改动风险。非发布面，排最后。 |
| B 选项（删两树兜底 + 抬 base peer 下限） | 被约束 | 规格明确排除：需先发布修复后的 base，且会让老 base 宿主降级。 |
| base 修复的发版 | 环境/权限 | 本轮不 publish、不切版本号（用户纠偏只放开 push）。`base/plugin-base/src/compat.ts` 的修复**已入库、未发布**；消费它的 mem `#1` 因此必须保留本地 `cannotDetermine` 兜底。 |

## 5. v1 七处事实修正清单

已就地修正 `docs/review/2026-10-09-business-flow-dedup-plan.md`（只改事实、结论不变），顶部已加
指向 v2 的指针：

1. §一 #1「改后两树 `cannotDetermine` 删除，verdict 字面量回归 base 一处」→ 不成立：修复后的 base 未发布，A 选项下两树兜底保留。
2. §一 #1「`probe-skipped` 字面量因此存在三份（base `compat.ts:752` + 两树）」→ base 自身两处（`:727`/`:755`），共 **4 处**。
3. §一 #5「三重守卫三份」→ 实为 **4 处**（多 `host.ts:1524-1530` 的树级变体）。
4. §二 #7 路径 `core/src/coldResume.ts` → 应为 `plugin/src/coldResume.ts`。
5. §二 #8「接口降级 WARNING 文案一字不差 / 近乎逐字节」→ 文案**不同**（mem 多 `legacy provisioning`；`loadGuarded` 文案 mem `the framework is SKIPPED` vs mission `the compatibility gate is SKIPPED`），只有 `cannot-tell` 那条一字不差。
6. §二 #9「`stillActive`（逐字节）」→ 注解不同；`present()` 两树签名不同；字符串版 `reasonOf` 与 base 同名不同义（下沉 = 接口换代）。
7. §一 #2 的 `DESIGN.md:574` → 该处讲的是 Remote **请求**类型；retention 诊断的刻意差异在 `mem/DESIGN.md:239`。

## 6. 收口结果

- 三树快档（本轮恢复跑并留日志）：
  - `pnpm check:fast base` → `BASE_EXIT=0`，tail `check:fast ok (base)`（`/tmp/fast-base.log`）
  - `pnpm check:fast mem` → `MEM_EXIT=0`，tail `check:fast ok (mem)`（`/tmp/fast-mem.log`；含 `test:dsh`）
  - `pnpm check:fast mission` → `MISSION_EXIT=0`，tail `check:fast ok (mission)`
- `pnpm check:release`：见 §6.1。
- 针对性验证（本任务内已跑并留证据）：base `compat_gate`（12）、base `interface_consumers`（2）、
  mem `provision`（16, test:dsh）、mem `envinit`（14, test:dsh）、mem core `dispatch`（6）、mem core
  `trustHeartbeat`（3）、mem `mcp`（11）、mission core `tree`（102）、mission `envinit`（13）、
  mission `cold-resume`/`session-continuation`/`continuation-delta`（25）；`pnpm -C mem typecheck:dsh`、
  `pnpm -C mem/packages/mcp typecheck`、`pnpm -C mission/packages/plugin typecheck` 均通过。
- **续做轮（#4/#5/#6/#8）**：mission 快档 ×3（#4/#5/#6）+ mem/mission 快档各一次（#8）全绿；两树
  `build:dsh`（mount smoke）OK；base 全套 475 passed。逐项证据见 §9。

### 6.1 check:release 结果（第一轮）

**全绿，exit 0**（`pnpm check:release`，完整日志 `/tmp/check-release.log`；各步日志在
`logs/check-release-*.log`）。摘要：

```
PASS  strict gate: base (@avantf/dsh-plugin-base) (exit 0)
PASS  strict gate: mem (@avantf/dsh-mem, incl. mount smoke) (exit 0)
PASS  strict gate: mission (@avantf/dsh-mission, incl. mount smoke) (exit 0)
PASS  release surface (publishable set, peers, one zod, published base) (exit 0)
PASS  prepublish assertions (publish surface) (exit 0)
check:release ok
```

即 **old-dsh 下限门、pack、两树 mount smoke、根 `release-check`、prepublish 断言都跑到了并通过**，
无需降级到离线子集。`release-check` 同时确认：三包可发布集合、required peer 区间、单份 zod、
无 `link:`/`file:`、registry 上 `@avantf/dsh-plugin-base@0.4.0` 的接口世代（3）不低于两棵插件 bake
的世代（3）。

### 6.2 续做轮 check:release 结果

**全绿，exit 0**（`pnpm check:release`，完整日志 `/tmp/check-release-v2.log`；各步日志在
`logs/check-release-*.log`）：

```
PASS  strict gate: base (@avantf/dsh-plugin-base) (exit 0)
PASS  strict gate: mem (@avantf/dsh-mem, incl. mount smoke) (exit 0)
PASS  strict gate: mission (@avantf/dsh-mission, incl. mount smoke) (exit 0)
PASS  release surface (publishable set, peers, one zod, published base) (exit 0)
PASS  prepublish assertions (publish surface) (exit 0)
check:release ok
```

同样**没有环境性失败**，未降级到离线子集；`release-check` 的世代备注与第一轮一致（已发布 base
0.4.0 世代 3 不低于两树 bake 的世代 3）。

## 7. 过程中发现的新事实

1. **另一会话并发提交**：本任务执行期间，工作树里既有的"executor handle reclaim / 任务标签状态点"
   在途改动被**另一会话**提交为 `67331b0`、`dae71c7`、`8c4c9a4`（并改了 `mission/packages/plugin/
   README.md`、`package.json`）。本轮所有 `refactor(dedup):` commit 都只 `git add` 本任务路径，未混入
   这些文件；`git log` 呈线性：`432a2f1 → a2bfd33 → 4309694 → {67331b0 → dae71c7 → 8c4c9a4} → c297c5d → cd65d55 → e27c15a`。
   这也是 #4/#5/#6 未做的直接环境因素（同一批 `tree.ts`/`host.ts` 热点同时被两边改动）。
2. **`#2`/`#3` 必须合成一个 commit**：二者都修改 `plugin/src/index.ts` 与 `mcp/src/index.ts` 且 import
   区相邻；若按规格拆两个 commit，先提交的那个会引用尚未提交的 core 成员（`runToolSpec` /
   `installTrustHeartbeat`）而**编译不过**，违反"每阶段可独立回滚"。故合成 `c297c5d`（同属 P2）。
3. **`stillActive` 可下沉且已下沉**：两树唯一差异是 `fiber.uid` 的类型注解；统一为 `ctx: unknown`
   后放进 shim 不违反"shim 无插件专属逻辑"（它是通用 Cordis liveness）。`present()`/`reasonOf`
   确认不可下沉，与规格 §1.8 一致。
4. **P5 的规模被低估**：两树 `mount-smoke.mjs` 不是"三行 + describeError"，而是 786/708 行、不同
   profile 旗标名、不同链接与断言结构。
5. **base 修复确为真实缺陷**：P0.1 在 P1 前实测抛 `Error: logger exploded`（`verdictOf` 在 load=true
   时必推 info 行），与规格 §1.1 一致。
6. `link-dsh` 持续报告 vendored client preset 与 harness checkout 漂移（3/8 文件），**与本任务无关**，
   属既有状态。

### 7.1 续做轮新增事实

7. **上一轮 #4 的关键理由（"单一助手必然改变持久化键序"）实测不成立**：`result` / `hasResult` 在
   `createNode`（`tree.ts`）里就已是 `NodeRecord` 的键；JS 覆盖已有键**不改变插入顺序**，所以两处
   `{...node, status, result/hasResult, …}` 无论按哪种字面量顺序写，落地键序都相同。续做仍按任务
   要求把这对字段作为调用方片段传入，让两处各自的写法保留在源码里（可读的差异），但这不再是承重
   约束。新增 `tree.spec` pin 断言两条路径的终端记录键序/字段/各自 reason 一致。
8. **#5 的守卫确实是 4 处 + 1 个异形**：三处 node 级（`result` / `detailOf` /
   `resolveExecutorSession`，同一条件 `sessionId === undefined || owner === undefined ||
   owner.ownerSessionId !== sessionId`）合并为 `ownedNodeFor(node, sessionId)`；树级 `delete`
   （按 rootId 寻址、且"缺树"与"不是你的"是两种答）用第二个助手 `treeOwnedBy(record, sessionId)`，
   存在性检查留在调用方；`readResult` 的"容忍 owner 缺失"形态按规格不动。
9. **#6 的三条绑定补丁字段完全同形**，唯一差异是消费的句柄键（`parkedWorker` / `lastWorkerId`）与
   是否有预算块；`bindRunning` 用单键片段接收句柄，`budgetRefusal` 只被 `dispatch` 与
   `adoptContinuation` 调用（`adoptParked` 刻意豁免，注释与行为原样保留），资源门先于预算的顺序
   不变。
10. **#8 的共享面正好是"机制/措辞"两条轴**：`loaded/loading` 缓存、`loadGuarded`、接口决策块
    （`interfaceVerdict` + `baseIsUsable` + `cannot-tell` 告警）都可下沉；两树差异全部落在措辞上
    （mem `the framework is SKIPPED` / 含 `legacy provisioning`；mission `the compatibility gate is
    SKIPPED` / 不含），因此 shim 新增 `DegradeWords` 参数，`envinit.ts` 只留 `DEGRADE_WORDS` 常量与
    一行 `gateOrDegrade(...)`。shim 内部不含任何插件专属逻辑。
11. **`createLoadCache` 把"失败不缓存"变成了共享不变量**：两树的重试用例（mem 的 bootstrap 抛错后
    重试、mission 的 `readDeclaredVersions` 首次抛错后重试）在共享实现下都保持绿；mission 原先在
    `loadCompatOnce` 内部写 `loaded = runtime`，下沉后由缓存统一写，语义等价（`loading` 在同一个
    microtask 里仍挡并发）。

## 8. 没能验证的

- `check:release` 已全绿（含 old-dsh / pack / 两树 mount smoke），**没有因环境失败而没跑到的门禁**。
- **真机 dsh 手工挂载**（把产物装进一个真实 profile 打开面板）不在本报告范围：mount smoke 用的是
  真 Cordis Context + 真链接，但不等同于人工验收。
- **#8 的行为等价**：续做轮已实现；验收靠 P0.4 的两树 `envinit.spec.ts` 逐字文案 + base 的
  `interface_consumers.spec.ts` 字节 pin + 两树 mount smoke（见 §9.4）。仍未做的是把两个 `interface_gate.ts`
  合并成一个物理文件（跨树相对引用被边界守卫禁止），因此"两份逐字节副本"依旧是设计而非疏漏。
- **#6 的调度时序**：只验证了终态字段矩阵与预算/资源门的先后（单测断言），没有做真机并发压力测试。

---

## 9. 续做记录（2026-10-09，v2 剩余项 #4 / #5 / #6 / #8）

用户口径：续做上一轮判定未做的 #4/#5/#6/#8；每项一个 commit（前缀 `refactor(dedup):`）、失败即回滚
该写范围并继续；逐项跑针对性测试 + 该树 `pnpm check:fast`；#8 另跑 base 套件与两树 mount smoke；
全案最后跑 `pnpm check:release`。全程**未动** `INTERFACE_VERSION`（仍 3）、版本号、CHANGELOG、
检索打分与 `eval_zh` 期望值；每个 commit 只 `git add` 本任务路径，未碰既有的未跟踪文件
`mission/docs/EXECUTOR_HANDLE_RECLAIM.md`。

### 9.1 #4 两处取消共享 `asCancelled`（`33bace7`）

- 改动：`mission/packages/core/src/tree.ts` 新增私有 `asCancelled(node, now, ended)`。
  `cancelSubworks` 与 `cancelTree` 各自把 `result`/`hasResult` 作为**单片段**传入（前者 `result`
  在前、后者 `hasResult` 在前），reason 各自给（`被父任务取消` / `已取消`）；`flush` 位置各自保留
  （一个在 `propagateFrom` 之后、一个紧跟循环，均在各自 `withLock` 内）；共享的只有记录形状
  （`status: 'failed'`、`claimedBy: null`、`parkedWorker: null`、`endedAt`/`updatedAt`）。
- pin：`mission/packages/core/test/tree.spec.ts` 新增「gives both cancellation paths the SAME terminal
  record shape」——两条路径的终端记录键序一致、`status=failed` / `claimedBy=null` /
  `parkedWorker=null` / `hasResult=true` / `updatedAt === endedAt`，reason 各按路径。
- 证据：`pnpm -C mission/packages/core exec vitest run test/tree.spec.ts` → **103 passed**；
  `pnpm -C mission/packages/core test` → 12 files / **269 passed**；`pnpm -C mission/packages/core
  typecheck` 通过；`pnpm check:fast mission` → `check:fast ok (mission)`。
- 事实修正：上一轮"单一助手必然改变持久化键序"的判断**不成立**，见 §7.1 第 7 条。

### 9.2 #5 host 所有权守卫（`3a65f18`）

- 改动：`mission/packages/plugin/src/host.ts` 新增私有 `ownedNodeFor(node, sessionId)`（返回所属
  `TreeRecord`，`resolveExecutorSession` 需要 owner id）与 `treeOwnedBy(record, sessionId)`。
  三处 node 级守卫（`result` / `detailOf` / `resolveExecutorSession`）改走前者；树级 `delete`
  （按 `rootId` 寻址）改走后者，**存在性检查留在调用方**——"缺树 → 任务 X 不存在"与"不是你的 →
  这个任务属于别的会话"是两种答。`readResult` 的异形守卫（容忍 owner 缺失，不等 sessionId）按规格
  不动。
- 文案：四处 `'这个任务属于别的会话'`、两处 `任务 X 不存在` 逐字不变（helper 只做判定，payload 与
  句子归调用方）。
- 证据：`pnpm -C mission/packages/plugin typecheck` 通过；
  `pnpm -C mission/packages/plugin exec vitest run test/host.spec.ts test/executor-session.spec.ts
  test/client-api.spec.ts` → **128 passed**（含 `result` 的 "elsewhere"、`detail` 的 "someone-else"、
  `delete` 的 "someone-else" 三条守卫用例）；`pnpm check:fast mission` → `check:fast ok (mission)`。

### 9.3 #6 三条进 running 共享 `bindRunning` + `budgetRefusal`（`ce5f1c0`）

- 改动：`mission/packages/core/src/tree.ts` 新增私有 `bindRunning(node, claimId, at, consumed)`（`consumed`
  是调用方的单键片段：`dispatch`/`adoptParked` 传 `{ parkedWorker: null }`、`adoptContinuation` 传
  `{ lastWorkerId: null }`），以及私有 `budgetRefusal(state, node)`（两条 `failExhausted` 预算）。
  每个调用点仍依次 `admissionRefusal → budgetRefusal`，**资源门先于预算**不变；
  `adoptParked` **继续不查预算**（原注释保留在调用点，`budgetRefusal` 的文档也写明这是刻意豁免）；
  `attempts`/`progressAt`/`activityAt`/`executorSessionId`/`executorReleasedAt`/`dispatchedAt` 的
  语义与注释合并进 helper 文档。
- pin：P0.5 的 `mission/packages/core/test/tree.spec.ts` 三路终态字段矩阵（含 adoptParked 预算豁免）
  **保持绿**。
- 证据：`pnpm -C mission/packages/core exec vitest run test/tree.spec.ts` → **103 passed**；
  `pnpm -C mission/packages/core test` → **269 passed**；`pnpm check:fast mission` → `check:fast ok
  (mission)`。

### 9.4 #8 两树 loader 可共享部分下沉 shim（`db98ef1`）

- 改动：两树 `src/interface_gate.ts` 新增 `GateLogger`、`DegradeWords`、本地 guarded `warn` 与
  `reasonOf`、`gateOrDegrade(module, log, words)`（= `interfaceVerdict` + `baseIsUsable` 决策 + `cannot-tell`
  告警）、`loadGuarded(options, loadOnce, log, words)`、`createLoadCache(guarded)`（进程内一次、
  **失败不缓存**）。两树 `src/envinit.ts` 删除各自的 `loaded`/`loading`、`loadGuarded` /
  `loadCompatGuarded` 与接口决策块，改为一个 `DEGRADE_WORDS` 常量 + `cache` + 一行
  `gateOrDegrade(...)`；mem 的 `dispose()` 由 `cache.clear()` 承担。
- 措辞（必须逐字不变，全部作为数据传入）：mem `prefix='envinit:'`、
  `loadFailure='the framework is SKIPPED and the plugin will mount anyway'`、
  `withheld='own prompt defaults, gate skipped, legacy provisioning'`；mission `prefix='compat:'`、
  `loadFailure='the compatibility gate is SKIPPED and the plugin will mount anyway'`、
  `withheld='own prompt defaults, gate skipped'`。
- 硬约束核对：`diff` 两 shim → **只有 `@module` 一行不同**；shim 内无插件专属逻辑（决策、缓存、
  守卫、措辞参数都是通用的）。
- 证据：
  - base 全套 `pnpm -C base/plugin-base test` → 36 files / **475 passed**，其中
    `test/interface_consumers.spec.ts` **2 passed**（字节 pin + 三个导出仍在）。
  - mem：`pnpm -C mem/packages/plugin exec vitest run --config vitest.dsh.config.ts test/envinit.spec.ts
    test/provision.spec.ts` → **14 + 16 passed**；`pnpm -C mem/packages/plugin exec vitest run
    test/interface.spec.ts` → **16 passed**。
  - mission：`pnpm -C mission/packages/plugin exec vitest run test/envinit.spec.ts test/interface.spec.ts`
    → **13 + 14 passed**。
  - 两树 `pnpm check:fast` → `check:fast ok (mem)` / `check:fast ok (mission)`。
  - 两树 mount smoke：`pnpm build:dsh mem` → `MOUNT SMOKE OK`（`framework: OK`、
    `compat: OK`、`compat (neg): OK`、degraded mount 8 tools）；`pnpm build:dsh mission` →
    `MOUNT SMOKE OK`。
  - P0.4 的两树逐字文案 pin 是这次的验收器，全绿。

### 9.5 续做轮收口

- 逐项快档（见上）：mission ×3 项 + mem/mission 各一次（#8）。
- 全案 `pnpm check:release`：见 §9.6。
- 未做项：本轮无（#4/#5/#6/#8 全部完成，无回滚）。§4 中仍排除的 P5 / B 选项 / base 发版不在本轮范围。

### 9.6 续做轮 `check:release`

**全绿，exit 0**（`pnpm check:release`，完整日志 `/tmp/check-release-v2.log`）：

```
PASS  strict gate: base (@avantf/dsh-plugin-base) (exit 0)
PASS  strict gate: mem (@avantf/dsh-mem, incl. mount smoke) (exit 0)
PASS  strict gate: mission (@avantf/dsh-mission, incl. mount smoke) (exit 0)
PASS  release surface (publishable set, peers, one zod, published base) (exit 0)
PASS  prepublish assertions (publish surface) (exit 0)
check:release ok
```

old-dsh 下限门、pack、两树 mount smoke、根 `release-check`、prepublish 断言都跑到了并通过；无环境性
失败，未使用离线子集。

---

## 补记：第一轮 push

**两个远端都推送成功**（先 origin/gitee、再 github；均非 force、无 tag、无 publish）：

- `git push origin master`（`git@gitee.com:ffeng86/dsh-plugins.git`）→
  `8eb5e16..36e6873  master -> master`，exit 0
- `git push github master`（`git@github.com:fei-feng-isy/dsh-plugins.git`）→
  `8eb5e16..36e6873  master -> master`，exit 0
- `git status -sb` → `## master...origin/master`（工作树与远端一致）

推送范围 `8eb5e16..36e6873` 覆盖本轮全部 `refactor(dedup):` commit 与本报告；**不含**
`docs/review/**`（被 `.gitignore` 排除）。本补记是其后一个小 commit，按同一顺序再次推送（先
origin、后 github）。
