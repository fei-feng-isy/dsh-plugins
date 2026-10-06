# 改进项先测后改：离线 A/B 测量战役结果

> **本报告只测量、不实现。** 未改 `mem/packages/**`、未改默认配置 / CHANGELOG / 版本号；
> 机制原型全部活在 `mem/scripts/spikes/bench-*.mjs` 里。真实库全程只读（`VACUUM INTO` 快照 +
> 临时 `dataHome`），**报告与 raw JSON 不含任何真实正文**（只有 id / 长度 / 日期 / 分数）。
> 派单规格见 [IMPROVEMENT_SPIKE_BRIEF.md](IMPROVEMENT_SPIKE_BRIEF.md)。

## 0. 总表

| 项 | 裁决 | 关键数字（全部可指回 raw JSON） | 脚本 | 原始 JSON |
|---|---|---|---|---|
| **P0-1 F4** FTS 分数函数 | **不采纳** | 三臂在冻结 41 与真实 20 上**逐条同分同序**：`must_include 40/41`、`must_exclude 27/41`、`top3 1.0244`；真实 `top1 10/11`、`top3 1.8182`。20/20 同候选集；FTS 腿自身分数仅 2/20 变化，**融合分 0/20 变化、返回 id 0/20 变化**。 | [bench-f4-fts-score.mjs](../scripts/spikes/bench-f4-fts-score.mjs) | [raw/f4-fts-score.json](raw/f4-fts-score.json) |
| **P0-2 L2** ≥2 腿准入 | **不采纳** | 真实 11 条 gold 查询 **删掉 gold 0 条**、`top3` 与基线同（1.8182）；δ=0.2 删掉 18 条返回命中（全是单腿），δ=0.4 删 11 条；**收益 0**。返回命中里 **49/86 是单腿**。冻结 `must_include` 40/41 不变。 | [bench-l2-two-leg-admission.mjs](../scripts/spikes/bench-l2-two-leg-admission.mjs) | [raw/l2-two-leg-admission.json](raw/l2-two-leg-admission.json) |
| **P0-3 A5** 乘性 boost | **不采纳** | 4 臂（recency/trust × α=0.1/0.2）动了尾部次序（13–16/20 条顺序变了），但 `top1 10/11`、`top3 1.8182`、冻结 `must_include 40/41`、`must_exclude 27/41` **全部零位移**。 | [bench-a5-multiplicative-boost.mjs](../scripts/spikes/bench-a5-multiplicative-boost.mjs) | [raw/a5-multiplicative-boost.json](raw/a5-multiplicative-boost.json) |
| **P0-4 A8** 预算装箱 | **不采纳** | 整条装箱把半截文本清零（`truncated 80→0` 等），代价是 gold：真实集 30 → **10/10/14/21**（budget 80/150/300/600，净 **−20/−20/−16/−9**）；冻结@10 `must_include −4`。 | [bench-a8-budget-boxing.mjs](../scripts/spikes/bench-a8-budget-boxing.mjs) | [raw/a8-budget-boxing.json](raw/a8-budget-boxing.json) |
| **P1-1 A3** 实体规范化 | **不采纳** | 三档阈值（0.5/0.7/0.9）的实体型查询读数与基线**完全相同**（`top1 15/15`、`top3 3.0`、扇出中位 7、实体袋中位 7）；阈值 0.5 的 20 对抽样**过度合并率 30%**（npm~pnpm、base~base64…），0.7/0.9 为 0%。 | [bench-a3-entity-merge.mjs](../scripts/spikes/bench-a3-entity-merge.mjs) | [raw/a3-entity-merge.json](raw/a3-entity-merge.json) |
| **P1-2 A2** 中文时间窗 | **采纳（带条件）** | 15 条时间查询：基线 gold 基本召不回（`missing 14/15`、`in_top3 1/15`）；boost 腿（w=1.0）`in_top3 14/15`、`missing 0`；**无时间守卫 5/5 逐字节不变（误伤 0）**、解析 **15/15** 正确；碰撞干扰项被移除后 gold 名次各升 1。**条件**：真实库**没有**任何带时间语义的查询（扫描 61 条 = 0），本卡测在脚本构造的真实形状 fixture 上。 | [bench-a2-time-window.mjs](../scripts/spikes/bench-a2-time-window.mjs) | [raw/a2-time-window.json](raw/a2-time-window.json) |
| **P1-3 A7/F2** 融合后门槛可行性 | **不适用** | 融合 top-1 分位数 `min 0.15 / p50 1.0 / max 1.0`（天花板 = 权重和 1.0）；有 gold 查询的 top-1 最低 **0.3** ≤ 无 gold 查询的 top-1 最高 **0.7**；阈值扫描 **0 个**能分开"有答案/无答案"。原因是 `fuse` 按每腿最大值归一。 | [bench-a7-fused-score-scale.mjs](../scripts/spikes/bench-a7-fused-score-scale.mjs) | [raw/a7-fused-score-scale.json](raw/a7-fused-score-scale.json) |
| **P2-4 A6** 信封逐臂分（只量成本） | **仅成本数字** | 每 hit 平均 **+108.76 B**（+10.68% 载荷）；`JSON.stringify` **+0.001 ms/hit**；`admin.stats` 现载荷 **481 B**（对照）。无质量 A/B（它对质量无影响）。 | [bench-a6-envelope-cost.mjs](../scripts/spikes/bench-a6-envelope-cost.mjs) | [raw/a6-envelope-cost.json](raw/a6-envelope-cost.json) |
| P2-1 L1/B1 主体·属性 spike | **未测** | 原因见 §10。 | — | — |
| P2-2 L3 pilot 长事实分块 | **未测** | 原因见 §10。 | — | — |
| P2-3 A4 索引文本并入实体名/日期 | **未测** | 原因见 §10。 | — | — |

**统计**：8 项有裁决（6 不采纳 / 1 采纳（带条件）/ 1 不适用），3 项未测且写明原因。
共享脚手架 [bench-spike-lib.mjs](../scripts/spikes/bench-spike-lib.mjs) 提供快照、腿复现与 identity 断言。

---

## 1. 测量网与共同纪律（先说清"这些数字凭什么可信"）

**三个口径**

1. **冻结集**：`mem/packages/core/test/fixtures/eval_zh_relations.jsonl`（41 条查询 / 16 个 case），
   驱动方式同 `bench-floors.mjs`：每个 case 一个临时 runtime、真 `remember` + 真 `recall`、真
   `bge-base-zh-v1.5`（768 维），`floors: 'strict'`。
2. **真实库快照（主网）**：`~/.avantf/memory/memory.db` 以只读连接 `VACUUM INTO` 到临时目录；
   每个 runtime 的 `dataHome` 指向另一个临时目录，`configs/common.yaml` 由脚本现写；
   **全程一个字节都没碰 `~/.avantf/`**。查询集 = `RERANK_AB_REAL.md` §1 的 20 条（6 自指 + 3 非自指
   + 5 条 2 字实体型 + 6 条常见问法），gold 定义沿用该文（自指指 pinned `user_profile`；2 字查询指实体集）。
   本次快照 **85 条 active**、正文长度 **min 9 / 中位 313 / max 2672**（派单时的 84 条已增长 1 条），
   85 条全部是 `local_bge/Xenova/bge-base-zh-v1.5/768` 的向量。
3. **脚本构造的真实形状 fixture**（仅 A2 需要）：长度分布复刻真实（中位 ~300、含 9 字符短事实与
   800+ 字符长笔记）、含"正文恰好含查询字面碎片"的干扰项与一条反事实断言。

**共同纪律——生产臂 identity 断言（每条臂都跑）**

脚本自己驱动一遍完整 pass（腿 → 逐腿门槛 → 方案 A 增广并集 → `fuse` → live 过滤 → 切片 → 预算），
其中**腿是通过 runtime 实例上的生产方法取回的**（`MemoryStore.ftsPath` / `semanticPath` /
`jaccardPath`；`fuse` / `applyScoreFloor` / `applyTermFloor` / `resolveFloors` / `gradedTerms`
是从构建产物 import 的生产定义），然后断言该 pass 的返回 **id 顺序逐条等于 `rt.recall` 的返回顺序**。
每张卡的 JSON 都记录了 `identity.{checked,passed,failures}`：

| 卡 | 真实库 identity | 冻结集 identity |
|---|---|---|
| F4 | 20/20 | 三臂各 0 failures / 41 |
| L2 | 20/20 | 两臂各 0 failures / 41 |
| A5 | 20/20 | 五臂各 0 failures / 41 |
| A8 | 100/100（20 查询 × 预算 0/80/150/300/600） | 两档各 0 failures / 41 |
| A3 | 15/15 | — |
| A2 | 20/20（15 时间 + 5 守卫） | — |
| A7/F2 | 20/20 | 0 failures / 41 |
| A6 | 20/20 | — |

**脚手架自校验（三口径交叉证据）**：本脚本的冻结集**基线臂**复现出的七项汇总
`P@k 0.6423 / R@k 0.9878 / MRR 1 / must_include 0.9756（40/41）/ must_exclude 0.6585（27/41）/
empty 0`、唯一未满足 `must_include` 的查询 = `张伟管理的人负责什么`
与 `RERANK_AB_REAL.md` §3.3 记录的数字**逐位相同**（见 `raw/f4-fts-score.json` 的 `frozen.bm25`，
以及 `raw/l2-two-leg-admission.json` 的 `frozen_base`）。这把"脚本驱动的 pass == 产品"从断言变成了
可对照的既有记录。

**一条限制（写明而不是藏着）**：identity 断言钉的是返回 `ref_id` 的**顺序**与融合分；它**不重算**
`dropped_by_floor` / `weights` / 预算后的文本。改这些层的臂不在断言的覆盖范围内。

---

## 2. P0-1 · F4：FTS 腿分数函数（bm25 → 覆盖率 / 混合）

- **假设**：`bm25()` 对 OR 起来的三元组求和，会奖励"偶然含多个查询碎片的长笔记"（2026-10-04 形态）。
- **臂**（只换 FTS 腿的 raw 分数，候选集与其余层逐字不变）：
  `bm25` = 生产 `-bm25`；`coverage` = `countMatchedTerms/(terms.length)`；
  `hybrid` = `(bm25/max) × coverage`。
- **口径**：冻结 41（strict）+ 真实 20（strict，limit 5）。
- **数字**：

  | 臂 | 冻结 must_inc | 冻结 must_exc | 冻结 top3 | 真实 top1 | 真实 top3 |
  |---|---|---|---|---|---|
  | bm25 | 40/41 | 27/41 | 1.0244 | 10/11 | 1.8182 |
  | coverage | 40/41 | 27/41 | 1.0244 | 10/11 | 1.8182 |
  | hybrid | 40/41 | 27/41 | 1.0244 | 10/11 | 1.8182 |

  `我是谁？` 族：#103 名次 3、#117 名次 2、#125 未入 top-5，**三臂完全相同**。
  诊断：`queries_with_same_candidate_set 20/20`、`queries_where_fts_leg_head_differs 2/20`、
  **`queries_where_fused_scores_differ 0/20`、`queries_where_returned_ids_differ 0/20`**。
- **裁决**：**不采纳**。判据要求"`must_include` 不降 且（`must_exclude` 或 top-3 严格上升）且并集不收窄"——
  前两条同时成立但不满足"严格上升"，且三臂在**两条网络上零位移**。候选并集确实没被收窄（20/20 同集合）；
  这也是本快照上 `legCap=200 > 85`，FTS 的 `ORDER BY bm25 LIMIT cap` **根本没有截断**的结果。
- **附带观察（为什么不再继续调它）**：本快照上 `我是谁？` 的 #117/#103 是**语义腿**（cos 0.5173/0.5157）
  送进来的，不是 FTS 腿；2026-10-04 的 FTS 路径已被 0.4.2 的"逐 variant 可达性 clamp"关闭。
  也就是说 ScoreFunction 这一层不是今天这条病根的载体，重打分救不了它。
- **复现**：`node mem/scripts/spikes/bench-f4-fts-score.mjs`
- **原始 JSON**：[raw/f4-fts-score.json](raw/f4-fts-score.json)

## 3. P0-2 · L2：≥2 条腿准入（负假设）

- **规则**：在生产融合池上 `keep = (证据腿数 ≥ 2) or (score ≥ top1 × (1 − δ))`，δ ∈ {0.2, 0.4}。
- **数字**（真实 11 条有 gold 查询 / 冻结 41）：

  | δ | 删掉 gold | 真实 top3 | 被删返回命中 | 其中单腿 | 冻结 must_inc |
  |---|---|---|---|---|---|
  | 0.20 | **0** | 1.8182（基线同） | 18 | 18 | 40/41 |
  | 0.40 | **0** | 1.8182（基线同） | 11 | 11 | 40/41 |

  返回命中的证据分布：**单腿 49 条 / 两腿 34 条 / 三腿 3 条**（共 86 条）——规则瞄准的形状很常见，
  但删掉它们**换不到任何收益**。
- **裁决**：**不采纳**。判据是"任一 gold 被删 **或** top3 不升 ⇒ 不采纳"；这里是**没有 gold 被删、
  top3 一点没升**，即该规则只删不增。这份数字就是"交集式准入在本库是纯损失/零收益"的反证存档。
  注意与派单预期的差异：**没有被删的 gold**——因为 gold 要么是多腿命中、要么本就贴近 top-1；
  真正被删的是 49/86 条单腿返回命中（非 gold 尾部）。
- **复现**：`node mem/scripts/spikes/bench-l2-two-leg-admission.mjs`
- **原始 JSON**：[raw/l2-two-leg-admission.json](raw/l2-two-leg-admission.json)

## 4. P0-3 · A5：乘性 boost（recency / trust）

- **臂**：`final' = final × (1 + α(signal − 0.5))`，α ∈ {0.1, 0.2}；signal = recency（`updated_at ?? created_at`
  在活跃语料上 min-max 归一）或 trust（`trust_score`）。`proof` **跳过**：本库事实没有 proof 字段
  （schema 核对），按派单要求不造占位。
- **数字**：

  | 臂 | 真实 top1 | 真实 top3 | 顺序变化查询 | 冻结 must_inc | 冻结 must_exc | 冻结 top3 |
  |---|---|---|---|---|---|---|
  | base | 10/11 | 1.8182 | — | 40/41 | 27/41 | 1.0244 |
  | recency α=0.1 | 10/11 | 1.8182 | 15/20 | 40/41 | 27/41 | 1.0244 |
  | recency α=0.2 | 10/11 | 1.8182 | 16/20 | 40/41 | 27/41 | 1.0244 |
  | trust α=0.1 | 10/11 | 1.8182 | 13/20 | 40/41 | 27/41 | 1.0244 |
  | trust α=0.2 | 10/11 | 1.8182 | 13/20 | 40/41 | 27/41 | 1.0244 |

- **裁决**：**不采纳**。四臂都"动了次序、没动任何被测量的质量"（真实 13–16/20 条顺序变化，top1/top3
  与冻结四项全零位移）。这与派单先验一致（乘性、α 封顶 ⇒ 只动尾部），**没有为它调参到能动数字为止**。
- **复现**：`node mem/scripts/spikes/bench-a5-multiplicative-boost.mjs`
- **原始 JSON**：[raw/a5-multiplicative-boost.json](raw/a5-multiplicative-boost.json)

## 5. P0-4 · A8：预算装箱（截断 vs 整条跳过）

- **臂**：A = 生产 `fitToTokenBudget`（降级文本、保留条目）；B = 整条装箱（放不下就跳过，全放不下回退 top-1）。
- **数字**（真实 20 条 × 预算；gold = 11 条有 gold 查询的累计保留）：

  | 预算 | A 返回/其中半截/空文本/gold | B 返回/半截/空文本/gold | gold 差 |
  |---|---|---|---|
  | 80 | 86 / 80 / 21 / **30** | 24 / 0 / 0 / **10** | **−20** |
  | 150 | 86 / 73 / 10 / **30** | 30 / 0 / 0 / **10** | **−20** |
  | 300 | 86 / 62 / 10 / **30** | 39 / 0 / 0 / **14** | **−16** |
  | 600 | 86 / 26 / 2 / **30** | 62 / 0 / 0 / **21** | **−9** |

  冻结@10：`must_include` A 40/41 → B 36/41（**−4**）；冻结@30 无位移（事实太短，预算不咬）。
- **裁决**：**不采纳**。判据"`must_include` 不降 且半截文本归零"——半截文本确实归零（`truncated` 全 0），
  但 `must_include` 在**每一档预算上都下降**（真实 −9…−20；冻结@10 −4）。
  "知晓条目存在但拿到半截文本"比"整条消失"更有价值，本库的 gold 分布支持保留生产的截断语义。
- **复现**：`node mem/scripts/spikes/bench-a8-budget-boxing.mjs`
- **原始 JSON**：[raw/a8-budget-boxing.json](raw/a8-budget-boxing.json)

## 6. P1-1 · A3：实体规范化（trigram 合并 + 共现）

- **合并规则**：实体名小写 3-gram Jaccard，union-find，簇代表 = 活跃 df 最高的名字；**两侧一致**——
  查询侧 `extractEntities` 的名字与事实侧实体袋都映射到代表名，再套**生产**指标
  （`selectAnchors` → 共享锚点候选 → `anchoredOverlap`）。阈值 0.5 / 0.7 / 0.9。
- **数字**（5 条 2 字 + 10 条高 df 实体名 = 15 条实体型查询）：

  | 臂 | top1 | top3 相关均值 | 扇出中位 | 实体腿大小中位 | 合并对 / 非单例簇 | 20 对抽样过度合并率 |
  |---|---|---|---|---|---|---|
  | 基线 | 15/15 | 3.0 | 7 | 7 | — | — |
  | t0.5 | 15/15 | 3.0 | 7 | 7 | 465 / 217 | **30%**（6/20） |
  | t0.7 | 15/15 | 3.0 | 7 | 7 | 198 / 155 | 0% |
  | t0.9 | 15/15 | 3.0 | 7 | 7 | 112 / 104 | 0% |

  语料侧：`entities` 表 2232 个名字，其中 **1442 个**挂在活跃事实上。实体袋原始宽度：min 3 / **中位 32** / max 66。
  抽样审计：t0.7、t0.9 的合并对几乎全是大小写变体（`DSH~dsh`）与单复数（`plugin~plugins`）；
  t0.5 出现**真过度合并**：`npm~pnpm`、`base~base64`、`avantf~avantfWork`、`listPackages~packages`、
  `packageId~packages`、`PNPM~npm`。
- **裁决**：**不采纳**。两条判据都不成立方向互补：0.5 有 30% 过度合并（≥5% 即拒），0.7/0.9 干净但
  **零收益**（实体型查询 top1/top3/扇出/袋宽全部不变）。原因之一是 2 字 CJK 名没有 3-gram，
  本卡的合并触及不到那 5 条主要查询。
- **复现**：`node mem/scripts/spikes/bench-a3-entity-merge.mjs`
- **原始 JSON**：[raw/a3-entity-merge.json](raw/a3-entity-merge.json)（含 20 对抽样的名字与判定）

## 7. P1-2 · A2：中文时间窗（查询类能力）

- **先做诚实性检查**：用脚本解析器扫过**全部 61 条真实/冻结查询**，带时间表达的 = **0 条**。
  所以真实库**没有**带时间窗 gold 的查询；本卡测在脚本构造的真实形状 fixture 上（见下）。
- **解析器**（脚本内，非生产）：`yyyy年m月d日` / `yyyy-m-d` / `yyyy年m月` / `m月d日`（当年）/
  `最近N天` / `最近一周` / `最近一个月` / `今天|昨天|前天` / `本周|上周` / `这个月|上个月` / `今年|去年`。
- **fixture**：3 主题 × 5 个**两两不相交**的窗口（今天/昨天/前天/上个月/2026年8月15日）= 15 条，
  长度按真实形状轮换（12/300/830 字符）；正文**不提窗口词**（事实只能靠日期区分）；
  另加 1 条 800+ 字符、正文含字面 `上个月` 的无关干扰项。15 条查询 = `<主题> <窗口词>`，gold = 窗口内那条。
- **臂**：`w0.3`/`w1.0` = 窗口腿（`created_at` 落在解析区间 → score 1，权重 0.3/1.0）；
  `hard` = 窗口腿提供候选 + 融合池限制在窗口内（空窗口回退）。
- **数字**：

  | 臂 | 基线（top1 / in_top3 / missing） | 臂（top1 / in_top3 / missing / 平均名次） | 守卫误伤 | 解析正确 |
  |---|---|---|---|---|
  | w0.3 | 1 / 1 / 14 | 2 / 10 / 0 / 2.80 | 0/5 | 15/15 |
  | w1.0 | 1 / 1 / 14 | 5 / 14 / 0 / 2.07 | 0/5 | 15/15 |
  | hard | 1 / 1 / 14 | 5 / 14 / 0 / 2.07 | 0/5 | 15/15 |

  **top1 只有 5/15 是设计使然，不是解析错**：窗口是"主题无关"的——`缓存 今天` 的窗口里同时有
  `部署 今天`、`限流 今天` 两条别主题的事实，臂只能把候选收窄到窗口内（实测返回 `[1,6,11]`，gold 1 排第 1），
  窗口内再排序才是主题的活。所以本卡能证明的是"**时间窗把 missing 14→0、把 gold 拉进 top3**"，
  不是"top1 全中"。

  守卫集：`缓存 / 部署 / 限流 / 缓存怎么配置 / 部署流程` —— 解析器全部返回"无时间表达"，
  臂与基线的返回 id **逐条相同**（误伤 0）。反事实：把字面含 `上个月` 的干扰项移除后，
  `缓存/部署/限流 上个月` 的 gold 名次各**升 1 位**——证明该干扰项确实在抢位，而不是巧合。
- **裁决**：**采纳（带条件）**。判据"窗口 gold rank 显著改善 且 守卫误伤 = 0"成立：
  `missing 14→0`、`in_top3 1→10/14`、误伤 0、解析 15/15。
  **条件（必须与结论同读）**：真实库没有任何带时间语义的查询，本结论只覆盖脚本构造的真实形状 fixture；
  上生产前需要用真实时间查询集复核，且解析器要按 hindsight/dateparser 的教训继续做误判审计。
- **旁证（顺手测到的真实缺陷，仅记录不改）**：像 `限流 上个月` 这种"2 字 CJK 词 + ≥3 字时间词"的查询，
  `gradedTerms` 只会产生时间词的 3-gram（2 字 run 不产 3-gram），所以**FTS 腿完全看不到主题词**。
  这不是本卡的考察层，但它说明混合中英/CJK 长度的查询在词法腿上有盲区。
- **复现**：`node mem/scripts/spikes/bench-a2-time-window.mjs`
- **原始 JSON**：[raw/a2-time-window.json](raw/a2-time-window.json)

## 8. P1-3 · A7/F2：融合后门槛弃答是否可行

- **做法**：对真实 20 + 冻结 41 收集融合分分布；对真实集做固定阈值扫描，看能否分开"有 gold / 无 gold"；
  同时记录语义腿的**绝对** cosine（floors 实际使用的尺度）作对照。
- **数字**：融合 top-1 分位数 `min 0.15 / p10 0.45 / p25 0.70 / p50 1.0 / max 1.0`（天花板 = Σweights = 1.0）；
  语义 top-1 cosine `min 0.3637 / p50 0.6356 / max 0.8706`；真实集里**无 gold 查询的 top-1 最高 0.70**，
  **有 gold 查询的 top-1 最低 0.30** ⇒ 两个分布重叠；**能分开两类查询的阈值数 = 0**。
- **裁决**：**不适用**。`retrieval-core/src/fusion.ts` 的 `fuse` 按每腿自身最大值归一（每腿头部恒为 1.0），
  融合分**只能同查询内比较**；`store/floors.ts` 的模块注释正是这么写的，并把门槛放在各腿的**绝对原始分**上。
  因此"融合后门槛弃答"没有可用的绝对尺度；正确做法是继续钉每腿绝对原始分（现有机制）。本卡把该判定
  用分布证明出来，而不是硬凑一个阈值。
- **关于"两条臂"**：本卡按派单规定是**可行性判定**（做法 = 分位数对比 + 代码核对），不是分数函数 A/B；
  被比较的两个"尺度"就是**融合分**与**语义腿绝对 cosine**（另有真实集"有 gold / 无 gold"两组做可分性对照）。
- **复现**：`node mem/scripts/spikes/bench-a7-fused-score-scale.mjs`
- **原始 JSON**：[raw/a7-fused-score-scale.json](raw/a7-fused-score-scale.json)

## 9. P2-4 · A6：信封逐臂分（只量成本，无质量 A/B）

- **信封**：每个返回 hit 带 `legs: {semantic|fts|jaccard: {raw, norm}}`（`norm` = `fuse` 用的最大归一值）。
- **数字**（真实 20 查询、86 hits）：现载荷 87 554 B → 96 907 B，**+9 353 B**，
  平均 **+108.76 B/hit**、**+10.68%**；`JSON.stringify` 总耗时 0.2585 → 0.3418 ms（**+0.001 ms/hit**）；
  `admin.stats`（面板轮询读的载荷）现 481 B。
- **说明**：该项对检索质量无影响，只给成本数字供排期；**未做**质量 A/B（派单明确要求不做）。
  作为尺度对照的"另一侧"是**不含信封的同一份生产载荷**（87 554 B / 0.2585 ms），不是一条行为臂。
- **口径提醒**：该读数是在多张卡并行、loadavg ~13.6 的主机上取的（见 JSON 的 `loadavg`），
  绝对毫秒含主机噪声，字节数是确定的。
- **复现**：`node mem/scripts/spikes/bench-a6-envelope-cost.mjs`
- **原始 JSON**：[raw/a6-envelope-cost.json](raw/a6-envelope-cost.json)

## 10. 未测项与原因（没有数字就是未测）

| 项 | 为什么未测 |
|---|---|
| **P2-1 L1/B1 主体·属性 spike** | 需要一套规则式 subject/attribute 抽取 + 查询侧主体判定 + 2 字 CJK 的 3-gram 盲区处理，并配套"碰撞载体反事实"与 20 条抽取精度抽样。它是 P2 里成本最高的一档（真值需要人工判定），而 P0 已经给出 5 项**不采纳**的实测依据、满足验收的"≥3 项"。按 P0→P1→P2 的顺序，本轮在 A2 收尾处停止，**不猜结论**。 |
| **P2-2 L3 pilot 长事实分块** | 需要真模型对 `N>512` 的事实做 K≤3 次分块编码 + max-over-K 聚合，并量向量数 / RSS / 写入延迟倍数。派单先验不利（被点名的干扰项 53/336 字符，N=512 时只影响约 9/84），成本最高。未做 pilot，**未测**。 |
| **P2-3 A4 索引文本并入实体名/日期** | 需要在**临时库**上建真实列 + 第二张 external-content FTS 表 + 触发器 + 与实体重扫联动，再量索引字节与 p50。属于"改 schema 形状"的一卡，实现量大于本轮余量；**未测**。 |

三项的共同原因一句话：本轮把预算花在 P0 全部四项 + P1 三项 + 便宜的 A6 上（都产出了可复核的数字），
P2 剩余三卡没有在**不猜**的前提下做完的余量。

## 11. 复现命令

```bash
# 共享脚手架被所有脚本 import，无需单独运行
node mem/scripts/spikes/bench-f4-fts-score.mjs
node mem/scripts/spikes/bench-l2-two-leg-admission.mjs
node mem/scripts/spikes/bench-a5-multiplicative-boost.mjs
node mem/scripts/spikes/bench-a8-budget-boxing.mjs
node mem/scripts/spikes/bench-a3-entity-merge.mjs
node mem/scripts/spikes/bench-a2-time-window.mjs
node mem/scripts/spikes/bench-a7-fused-score-scale.mjs
node mem/scripts/spikes/bench-a6-envelope-cost.mjs
```

每个脚本：只读真实库 → `VACUUM INTO` 快照 → 临时 `dataHome` 跑 → 结束删除临时目录；
`--json <path>` 可改输出位置。模型需已在 `~/.avantf/env/models`（`bge-base-zh-v1.5`）；**本轮未下载任何模型**。

## 12. 实测 / 推断 / 未覆盖

**实测（本机、本次运行，2026-10-05 23:40–23:55 Asia/Shanghai；Node v22.23.2）**

- 全部 identity 断言（见 §1 表）与冻结集 41 条的七项汇总（复现存档）。
- F4 三臂在两条网络上的全部读数与"融合分 0/20 变化"的诊断。
- L2 两档 δ 的 gold/命中删除数与 49/86 单腿分布。
- A5 四臂的次序变化数与零质量位移。
- A8 四档真实预算 + 两档冻结预算的返回数 / 半截数 / gold 数。
- A3 三档阈值的 15 条实体查询读数、扇出、袋宽与 20 对抽样审计。
- A2 的解析 15/15、守卫 0 误伤、gold 名次表与反事实。
- A7 的融合/语义分位数与"0 个可分阈值"。
- A6 的字节/耗时数字。

**推断（有代码或数据依据，未直接端到端观测）**

- A2 的"hard"形态（窗口腿供候选 + 池限制）是在脚本里验证的原型；把它做成生产机制还涉及
  config/工具面/守卫的落地，本轮**未**实现（本任务禁止）。
- A3 的"2 字 CJK 名无 3-gram、所以本卡触及不到 5 条主查询"是从 `trigrams()` 的定义推出的，
  与"三档读数完全相同"的观测一致，但没有单独做字符 bigram 变体的测量。

**未覆盖**

- `knowledge` 库（文档切片）：本任务只测记忆库。
- 跨库路由（`rt.recall` 走的是单库 `memory.search`；跨库路径未测）。
- 规模效应：A4/L3/A8 若需 2k/10k 合成规模，本轮未做（派单允许用脚本合成，但没有余量）。
- P2-1/P2-2/P2-3 三卡（见 §10）。
