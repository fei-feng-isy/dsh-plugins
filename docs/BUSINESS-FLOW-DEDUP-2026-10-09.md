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
| #4 | 未做 | 见 §4。 |
| #5 | 未做 | 见 §4。 |
| #6 | 未做 | 见 §4。 |
| #7 | 已做 | `mission/packages/plugin/src/coldResume.ts` 抽 `deliverPrompt` 骨架，两 wake 的文案/prompt 选项/`markCorrectionsDelivered` 挂点逐字保留。`pnpm -C mission/packages/plugin exec vitest run test/cold-resume.spec.ts test/session-continuation.spec.ts test/continuation-delta.spec.ts` → 25 passed；mission plugin typecheck 通过。 |
| #8 | 未做 | 见 §4。 |
| #9 | 部分做 | `stillActive` 统一注解后下沉两树共享 shim（`interface_gate.ts`），两树 `index.ts` 改导入；base `interface_consumers.spec.ts` 2 passed（含字节 pin，diff 仅余 `@module` 一行）。`present()` / 字符串版 `reasonOf` 按 §7 不做。 |
| P5 (B5) | 未做 | 见 §4。两树 `mount-smoke.mjs` 实为 786 vs 708 行、profile 旗标名都不同（`AVANTF_ENVINIT_ABSENT` vs `AVANTF_COMPAT_ABSENT`），不是规格假设的"三行 + describeError"。 |
| P6 (文档) | 已做 | v1 七处事实修正 + 顶部指针（§5）；本报告；v2 §8 已填。 |
| 收口 | 部分 | 三树快档全绿；`check:release` 见 §6。 |

## 2. Commit 清单（本轮 `refactor(dedup):`）

| commit | 内容 |
|---|---|
| `432a2f1` | P0 前置 pin（5 个测试文件，319 插入） |
| `a2bfd33` | P1 base `provision` 的 logger 契约修复 |
| `4309694` | #1 mem 兼容门禁收敛到 base（A 选项） |
| `c297c5d` | #2/#3 工具边界与信任心跳下沉到 mem 引擎（合成一个 commit，理由见 §7） |
| `cd65d55` | #7 coldResume 抽投递骨架 |
| `e27c15a` | #9 stillActive 下沉两树共享 shim |

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
mission/packages/plugin/src/interface_gate.ts      (#9)
mission/packages/plugin/src/index.ts               (#9)
mission/packages/core/test/tree.spec.ts            (P0.5)
mission/packages/plugin/test/envinit.spec.ts       (P0.4 mission)
docs/BUSINESS-FLOW-DEDUP-2026-10-09.md             (本报告, 新增)
```

（`docs/review/**` 的两个方案文件按仓库规定**不入库**。）

## 4. 未做项与原因

| 未做项 | 类别 | 具体原因 |
|---|---|---|
| #4 `asCancelled` | 负收益/被约束 | 规格同时要求"抽 `asCancelled(node, reason, now)`"与"保留既有字段顺序差异、不要顺手统一"。两处 patch 的 `result`/`hasResult` 顺序相反（`tree.ts:1785-1798` vs `:1876-1889`），单一助手必然改变其中一处的 key 顺序（持久化 JSON 的键序），而 `tree.ts` 是 mission 枢纽且本任务期间另一会话正在其上提交。抽取收益（约 10 行）低于破坏键序稳定的风险，按 AGENTS.md"base/枢纽最后动""不为变小做整体重构"不做。 |
| #5 `ownedNodeFor()` | 被约束 | 同样在 `mission/packages/plugin/src/host.ts` 枢纽；规格要求"三处 node 级合一 + 树级另用 `treeOwnedBy()`"，改动面覆盖 4 处守卫，本任务剩余预算不足以完成并做完整 mission 回归，故不做。 |
| #6 `bindRunning()` | 被约束 | 三条 patch 现已被另一会话新增的 `executorReleasedAt: null` 字段（executor handle reclaim）交织在同一批 `replace` 调用里；共享助手必须原样保留该字段与三处不同的句柄字段（`parkedWorker` vs `lastWorkerId`）与预算豁免，且要保持 key 顺序。风险与 #4 同源，不做。 |
| #8 跨树 loader 下沉 | 被约束 | 需要把 `loaded/loading` 缓存、`loadGuarded`、接口世代决策块搬进字节钉死的 `interface_gate.ts`，并给两树各自的降级文案（mem 多 `legacy provisioning`、guard 文案不同）加 words 参数，还要两树 mount smoke + base 套件回归。改动跨两个插件树的最敏感启动路径（"绝不拒载/绝不杀宿主"），剩余预算不足，宁可不做也不半拆。P0.4 的逐字 pin 已就位，将来做时即为验收器。 |
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

### 6.1 check:release 结果

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

## 8. 没能验证的

- `check:release` 已全绿（含 old-dsh / pack / 两树 mount smoke），**没有因环境失败而没跑到的门禁**。
- **真机 dsh 手工挂载**（把产物装进一个真实 profile 打开面板）不在本报告范围：mount smoke 用的是
  真 Cordis Context + 真链接，但不等同于人工验收。
- **#8 的行为等价**：未实现，无验证可言；P0.4 的逐字 pin 是现成的验收器。

---

## 补记：push

（推送结果见下节。）
