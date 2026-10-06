# 改进项先测后改：测量战役第二轮（BORROWABLE §6 遗项）

> **本报告只测量、不实现。** 未改 `mem/packages/**`、默认配置 / CHANGELOG / 版本号，也未改第一轮报告。
> 机制原型全部活在 `mem/scripts/spikes/bench-r2-*.mjs` 里；真实库全程只读（`VACUUM INTO` 快照 +
> 临时 `dataHome`；R2-4/R2-8 只对**快照副本**做 `ALTER`，生产库一个字节都没碰）。报告与 raw JSON
> **不含任何真实正文**（按 key 自查：无 `text`/`content` 类长字符串，见 §11）。
> 派单规格见 [IMPROVEMENT_SPIKE_BRIEF_ROUND2.md](IMPROVEMENT_SPIKE_BRIEF_ROUND2.md)；第一轮成果见
> [IMPROVEMENT_SPIKE_RESULTS.md](IMPROVEMENT_SPIKE_RESULTS.md)。
> 共享脚手架 [bench-spike-lib.mjs](../scripts/spikes/bench-spike-lib.mjs) **向后兼容地**扩展了若干钩子
> （`arm.weights` / `arm.semantic` / `degradedSemantic()` / `openWritable()` / `rssMiB()` / `loadavg()` + 几个额外 import），
> 既有调用方行为逐字不变（第一轮脚本不改、仍可运行）。

## 0. 总表

| 卡 | 裁决 | 关键数字（全部可指回 raw JSON） | 脚本 | 原始 JSON |
|---|---|---|---|---|
| **R2-1 F4 正面对照** | **不采纳（维持第一轮）+ 归因更正** | 正面对照**通过**（注入反转在 degraded / fts_only 上改变 4/20 查询的返回 id）。三臂生产分歧：语义关闭网络 **19/20 同 id、16/20 同分**（有 1 条尾部分歧），语义在场 zero-weight 网络 **20/20 全同**。分歧查询是 `插件的安装方法`（非 gold）：bm25/hybrid `[122,144,147,98,120]` vs coverage `[122,96,98,99,116]`；top1/top3 质量**零位移**（degraded 8/11、live_sem0 10/11）。 | [bench-r2-1-f4-negative-control.mjs](../scripts/spikes/bench-r2-1-f4-negative-control.mjs) | [raw/round2-r2-1-f4-negative-control.json](raw/round2-r2-1-f4-negative-control.json) |
| **R2-2 A2 真实语料时间查询集** | **采纳（条件解除，名次口径）** | 从快照**派生 14 条**窗口查询（话题实体 df 2–8 + 窗口词，查询不含 gold 唯一字面）：基线 `in_top3 14/14`、`top1 3/14`、平均名次 **1.8571**；窗口腿 w0.3 / w1.0 / hard `top1 14/14`、平均名次 **1.0**、`missing 0`。守卫 **14/14 逐条同 id**、解析 **14/14**、守卫误报 **0**。预注册的 `in_top3` 判据因基线 14/14 **饱和**而无法判别（如实记录）。 | [bench-r2-2-real-time-queries.mjs](../scripts/spikes/bench-r2-2-real-time-queries.mjs) | [raw/round2-r2-2-real-time-queries.json](raw/round2-r2-2-real-time-queries.json) |
| **R2-3 gradedTerms 2 字盲区** | **不实现（只出数字与建议）** | 61 条真实+冻结查询里**受影响形态 = 1 条（1.64%）**；派生 20 条形态查询上生产 FTS 腿命中 gold **0/20**，脚本内 `fix_or`（OR 形状）**20/20**，而 `fix_naive`（并入 2 字 run）**0/20** —— 它把可达性门槛从 1 抬到 2，反而封死；单独话题词（回退路径）**20/20**。 | [bench-r2-3-graded-terms-blindspot.mjs](../scripts/spikes/bench-r2-3-graded-terms-blindspot.mjs) | [raw/round2-r2-3-graded-terms-blindspot.json](raw/round2-r2-3-graded-terms-blindspot.json) |
| **R2-4 G-A1/A2/A6/A8 默认不变 + 不变量** | **四项均可行（默认逐字节不变成立）** | 副本上 5 条 `ALTER` 用时 **2 ms**；20 条真实查询的 **id + 分数逐字节不变**（脚本与产品双向）、FTS 候选集相同、identity **20/20**。不变量 SQL 干净时 **0** 违反，**植入违规 = 1**（证明检查器会失败），回滚后 **0**。标注：`valid_from 85 / valid_to 2 / superseded_by 2 / assert_count>1 1`；实体约束类型回落 **2232/2232（100%）**。 | [bench-r2-4-ga-schema-unchanged.mjs](../scripts/spikes/bench-r2-4-ga-schema-unchanged.mjs) | [raw/round2-r2-4-ga-schema-unchanged.json](raw/round2-r2-4-ga-schema-unchanged.json) |
| **R2-5 G-A7 来源覆盖率** | **只能生产期测** | 上界代理：managed kb 文档 **0** 篇 ⇒ 实体/12 字 shingle 重叠 **0/85（0%）**。现存唯一溯源形字段 `mirror_source` **85/85 有值但只有 1 个 distinct 值（长度 4）** ⇒ 不携带"哪一篇来源"的信息；正文含路径形 token 的 **19/85（22.4%）**。生产期 instrument：`stats.facts_with_source_ref / total`，阈值 ≥30%（2 周内）。 | [bench-r2-5-source-coverage.mjs](../scripts/spikes/bench-r2-5-source-coverage.mjs) | [raw/round2-r2-5-source-coverage.json](raw/round2-r2-5-source-coverage.json) |
| **R2-6 L1/B1 主体·属性 spike** | **不采纳** | 规则抽取覆盖 **82/85（0.9647）**，精度代理（对生产 triple subj 的一致率）**1/82（0.0122）**。`subject==用户` 组 **6 条**；含 `用户` 的 15 条里 **9 条主体不是用户**；`用户是` 载体 **#160（不在组内）**。`我是谁？` 基线 `[4,117,103,25,36]`（gold 已 #1）：filter 臂**收窄并集 15→6** 且把 gold 查询 top1 **10→6、missing 1→5**；groupleg 臂保并集但 **#103/#117 仍在 top3**；反事实（移除 #160）**结果不变**。 | [bench-r2-6-subject-attribute.mjs](../scripts/spikes/bench-r2-6-subject-attribute.mjs) | [raw/round2-r2-6-subject-attribute.json](raw/round2-r2-6-subject-attribute.json) |
| **R2-7 L3 长事实分块 pilot** | **不采纳** | **N=512**：长文 9/85、块 18、向量 85→94（**×1.1059**）、编码 2260 ms；top1 **9→8**、top3 10→10；长笔记名次**变差 16 / 变好 1**。**N=128**：长文 79/85、块 220、向量 85→226（**×2.6588**）、编码 12915 ms；top1 9→9、top3 10→10、missing **0→1**；长笔记名次**变差 112 / 变好 14**。`chunk_capped` 按构造恒等于基线。RSS 679.4→701 MiB；写入编码倍数 **×0.9231**（整事实编码本就被窗口截断，故未呈 K 倍）。 | [bench-r2-7-chunking-pilot.mjs](../scripts/spikes/bench-r2-7-chunking-pilot.mjs) | [raw/round2-r2-7-chunking-pilot.json](raw/round2-r2-7-chunking-pilot.json) |
| **R2-8 A4 索引文本并入** | **不采纳** | "只含实体名"的改善人群为 **0**：**2803 个 (事实,实体) 对里，实体名 100% 已经逐字出现在正文中** ⇒ 实体名并入索引文本**不可能**带来新命中。实体名查询命中 gold 生产 **9/10** vs fts2 **9/10**（零改善）；日期查询 **9/10 → 10/10**（合成、真实库 0 条时间查询）。成本确定：库 **3 555 328 → 3 887 104 B（×1.0933）**、p50 **25.40 → 28.03 ms（+10.35%）**。 | [bench-r2-8-index-text-merge.mjs](../scripts/spikes/bench-r2-8-index-text-merge.mjs) | [raw/round2-r2-8-index-text-merge.json](raw/round2-r2-8-index-text-merge.json) |

**统计**：8 卡全部有裁决 —— **不采纳 4**（R2-1 维持 / R2-6 / R2-7 / R2-8，其中 R2-6/R2-7/R2-8 是本轮新增的不采纳实测依据）、
**采纳 1**（R2-2，条件解除但换名次口径）、**可行 1**（R2-4，四项结构性改动在副本上均成立）、
**不实现 1**（R2-3，脚本内前后对照 + 建议）、**只能生产期测 1**（R2-5）。

---

## 1. 口径与共同纪律（沿用第一轮，缺一条该卡作废）

- **快照**：`~/.avantf/memory/memory.db` 以只读连接 `VACUUM INTO` 到临时目录；本次 **85 条 active**、
  正文长度 **中位 313**。每个 runtime 用另一临时 `dataHome`，`configs/common.yaml` 由脚本现写。
- **生产臂 identity 断言**：有检索 pass 的卡（R2-1/2/3/4/6/8）都记录 `identity.{checked,passed}`；
  **R2-5（覆盖率计数）与 R2-7（纯向量 pilot，不跑 recall）没有生产 pass，identity = N/A**。
- **正面对照（R2-1 专属、卡成立的前提）**：注入一个必定改排序的改动并证明脚手架能检测到。
- **臂间同候选集**：只换被考察的那一层，其余逐字相同。
- **隐私**：脚本只打印/写 id、长度、日期、分数、实体名与计数；正文只在内存中参与打分或子串判定。

---

## 2. R2-1 · F4 的正面对照（最优先，最便宜）

- **第一轮的张力**：`我是谁？` 网络上三臂逐条同分同序，但 `fts_leg_head_differs 2/20` 而
  `fused_scores_differ 0/20`。读数 (a)「FTS 腿在返回集里没有说话权」与 (b)「分数函数真的不影响交付排序」
  无法区分。
- **网络**（语义腿被拿掉 / 权重置零）：
  | 网络 | 语义腿 | 权重（sem / fts / jac） |
  |---|---|---|
  | `degraded` | 不可用（stub `isAvailable()=false`） | 0.00 / 0.65 / 0.35（生产 `DEGRADED_WEIGHTS`） |
  | `fts_only` | 不可用 | **0.00 / 1.00 / 0.35** |
  | `live_sem0` | 可用但不计分 | 0.00 / 1.00 / 0.35 |
- **臂**：`bm25`（生产）/ `coverage` / `hybrid` / **`inverted`（正面对照：把 FTS 腿自身次序反转且保持原始分区间
  `v → (min+max) − v`）**。
- **数字**（20 条真实查询）：

  | 网络 | 三臂同 id | 三臂同分 | FTS 腿头部不同 | 正面对照改 id | 三臂 gold top1（11 条） |
  |---|---|---|---|---|---|
  | degraded | **19/20** | 16/20 | 5/20 | **4/20** | 8/11（三臂相同） |
  | fts_only | **19/20** | 16/20 | 5/20 | **4/20** | 8/11（三臂相同） |
  | live_sem0 | 20/20 | 20/20 | 2/20 | 0/20 | 10/11（三臂相同） |

  唯一分歧查询 = `插件的安装方法`（非自指、无 gold）：bm25/hybrid `[122,144,147,98,120]`、
  coverage `[122,96,98,99,116]` —— **只动尾部、不动 top-1**。
- **正面对照结论**：**通过**。注入反转在语义关闭的两个网络上改变 4/20 查询的返回 id，说明"零位移"不是
  脚手架的盲区。
- **裁决**：**不采纳（维持第一轮）**，但**更正归因**：
  - 不能说"FTS 腿没有说话权"——在 `fts_only`（FTS 全权）上它**有**话语权，仍有 19/20 查询三臂同 id；
  - 分数函数**可观测**（1/20 尾部位移、4/20 融合分变化），但**零质量收益**（top1/top3 在三条网络上三臂全等）；
  - `live_sem0` 的 20/20 全同说明**语义腿主导**确实是第一轮"0/20 位移"的原因之一，但那不是"没测到"。
- **复现**：`node mem/scripts/spikes/bench-r2-1-f4-negative-control.mjs`

## 3. R2-2 · A2 的真实语料时间查询集

- **反循环派生规则**（不合成语料）：话题词 = 活跃 df ∈ **[2, 8]** 的实体名（df ≥ 2 保证查询**不含** gold 的
  唯一字面）；窗口 = 该话题词的事实里 `created_at` 落在其中**恰好一条**的窗口；查询 = `<话题词> <窗口词>`，
  gold = 那条；守卫 = `<话题词>` 不带窗口词。
- **窗口覆盖**（真实 now = 2026-10-05 UTC / 2026-10-06 Asia/Shanghai；快照最后一条事实 created_at = 2026-10-04）：

  | 窗口 | 昨天 | 前天 | 本周 | 上周 | 这个月 | 上个月 | 具体日期 | 今天 | 今年 |
  |---|---|---|---|---|---|---|---|---|---|
  | 派生候选 / 采用 | 13 / 2 | 30 / 2 | 11 / 2 | 58 / 2 | 53 / 2 | 61 / 2 | 55 / 2 | **0 / 0** | **0 / 0** |

  今天/今年为 0 是**真实语料的诚实结果**（今天无活跃事实；今年窗口包含某话题词的 ≥2 条事实 ⇒ 无法唯一化）。
- **数字**（14 条派生查询）：

  | 臂 | top1 | in_top3 | missing | 平均名次 |
  |---|---|---|---|---|
  | 基线 | 3/14 | **14/14** | 0 | 1.8571 |
  | w0.3 | **14/14** | 14/14 | 0 | **1.0** |
  | w1.0 | **14/14** | 14/14 | 0 | **1.0** |
  | hard | **14/14** | 14/14 | 0 | **1.0** |

  守卫 **14/14 逐条同 id**（误伤 0）、解析 **14/14 正确**、守卫误报 **0**、identity **14/14**。
- **裁决**：**条件解除 —— 但以名次为准**。预注册判据是 `in_top3` 显著改善；本查询集上基线已 **14/14 饱和**
  （低 df 话题实体本身就把 gold 拉进 top-3），该轴**无法判别**，如实记录而不粉饰。名次轴显著：
  `top1 3→14`、平均名次 `1.8571→1.0`。**必须与结论同读**：这仍是**派生查询**，不是"用户真的会输入时间词"
  的行为证据；A2 的其余条件（解析器误判审计）维持。
- **复现**：`node mem/scripts/spikes/bench-r2-2-real-time-queries.mjs`

## 4. R2-3 · `gradedTerms` 的"2 字话题词 + 时间词"盲区

- **假设**：`限流 上个月` 只产出 `上个月` 的 3-gram ⇒ 2 字话题词对 FTS 腿不可见（因为 term 集非空，
  短查询子串回退不触发）。
- **人群**：61 条真实+冻结查询里，**受影响形态 = 1 条（1.64%）**，就是冻结集的 `CI 用哪个 Python 版本`
  （`版本` 是 2 字 run，`用哪个` 是 3 字 run ⇒ 回退被抑制，`版本` 对 FTS 不可见）。带 2 字 CJK run 的查询
  共 11 条，其中 10 条**没有**可索引 term（回退正常触发）。
- **脚本内前后对照**（20 条从快照派生的形态查询；gold = 含 2 字话题词但不含 3 字词的事实）：

  | 读数 | 命中 gold |
  |---|---|
  | 生产 FTS 腿（原始集） | **0/20** |
  | 脚本内并入 2 字 run 后的原始集 | **20/20** |
  | `fix_naive`（并入后按 **并集长度** 取门槛） | **0/20** |
  | `fix_or`（并集检索，但门槛仍按**可索引 term 数**，子串证据取 max） | **20/20** |
  | 对照：单独话题词（回退路径） | **20/20** |

- **关键发现**：朴素的"把 2 字 run 也纳入取词"**不生效甚至更糟**——它把可达性门槛从 `min(cfg,1)=1`
  抬到 `min(cfg,2)=2`，于是只含话题词的 gold 被判 **1 < 2** 丢弃。有效形态是 **OR 形状**：检索并入、
  但门槛仍由可索引 term 数钳制，子串证据作为 max 而不是 AND。
- **裁决**：**不实现**（本轮禁止改生产；`relevanceTerms` 被既有测试钉）——只给数字与上述建议。
- **复现**：`node mem/scripts/spikes/bench-r2-3-graded-terms-blindspot.mjs`

## 5. R2-4 · G-A1/A2/A6/A8 的"默认不变 + 不变量"（快照副本 ALTER 模拟）

- **模拟**：副本上 `ALTER TABLE facts ADD COLUMN valid_from / valid_to / superseded_by / assert_count INTEGER NOT NULL DEFAULT 1`、
  `ALTER TABLE entities ADD COLUMN entity_type_v2 TEXT`，共 5 条、**2 ms**；按提案写入标注。
- **断言**：
  1. **默认检索逐字节不变 = true**：20 条真实查询的**返回 id + 融合分**在未改快照与副本上完全相同
     （脚本 pass 与产品 `rt.recall` 双向都比），`facts_fts` 候选集也相同；副本上 identity **20/20**。
  2. **不变量**：`superseded_by IS NOT NULL AND status <> 'archived' AND valid_to IS NULL` 一条 SQL 判定。
     干净副本 **0 违反**；**植入一条违规 → 1**（检查器会失败）；回滚 → **0**。
     即 `superseded_by` 只可能出现在 archived 或 `valid_to` 非空的行。
  3. **带标注的 active 行仍出现**：2 条 `active + valid_to` 的事实照常返回、名次不变（"能否渲染标注"是
     wire 改动，见下）。
- **标注读数**：`valid_from 85`、`valid_to 2`、`superseded_by 2`、`assert_count>1 1`；实体 **2232**，
  遗留 `entity_type` 只有 **1 个 distinct 值** ⇒ 白名单外回落 **2232/2232（100%）**。
- **裁决**：**G-A1/A2/A6/A8 四项均可行**"，代价与 wire 改动：
  | 项 | 迁移 | wire / 写侧 | 默认不变 |
  |---|---|---|---|
  | G-A1 | 1 个可空列（`valid_from`）；历史有效期还需 `valid_to` + 回填策略 | `RecallHit`/detail 增 `valid_from`（契约 + wire 版本） | ✅ |
  | G-A2 | 2 个可空列（`valid_to`/`superseded_by`） | 结果渲染"被谁取代/截止何时" + admin 审计 | ✅（不变量可一条 SQL 验证） |
  | G-A6 | 1 列 `DEFAULT 1`（SQLite 元数据级 ALTER） | `RememberResult` 增 `assert_count` | ✅ |
  | G-A8 | **无需新列**（`entity_type` 已在），但需要真实类型来源 + 白名单 + 回落 + 重扫 | 实体枚举进契约 | ✅（当前 100% 回落 ⇒ 上线前必须先解决类型来源） |
- **复现**：`node mem/scripts/spikes/bench-r2-4-ga-schema-unchanged.mjs`

## 6. R2-5 · G-A7 来源覆盖率（能测多少测多少）

- **离线可测的上界代理**：managed kb 文档 **0 篇 / 0 chunk / 0 chunk_entity** ⇒ "来源可推断"的事实
  **0/85（0%）**（按实体名 0、按 12 字 shingle 0）。**上界为 0 本身是诚实结论**：这一轮没有任何 kb 文档，
  重叠无从谈起。
- **现存同形字段的现实**：`mirror_source` **85/85 有值、但只有一个 distinct 值（长度 4）** ⇒ 这个"上一代
  溯源字段"不携带"哪一篇来源"的信息，正是 brief 点名要防的"字段存在、永远为空/无效"。另外 **19/85（22.4%）**
  的事实正文含**路径形 token**（`.../x.md` 一类），是"这份记忆可能源自某文档"的弱信号。
- **生产期必须 instrument 的指标**（离线测不到"调用方愿不愿意传 `source_ref`"：没有会话日志）：
  - **主指标**：`admin.stats` 暴露 `facts_with_source_ref / total_active_facts`（不加第 9 个工具，复用面板轮询的载荷）。
  - **副指标（同一批"接收端"一起上）**：`valid_to` 非空占比、`assert_count>1` 占比、受约束 `entity_type` 覆盖率、
    `mirror_source` 非空但有意义的占比。
  - **验收阈值**：写侧参数上线后 **2 周内 ≥30%** 的活跃事实带 `source_ref`；低于此判为下一个 `mirror_source`，
    应当撤掉而不是留着。
- **裁决**：**只能生产期测**（代理数字 0% + 上述 instrument 规格）；不编覆盖率。
- **复现**：`node mem/scripts/spikes/bench-r2-5-source-coverage.mjs`

## 7. R2-6 · L1/B1 主体·属性 spike（含 `用户是` 碰撞载体反事实）

- **抽取规则**（无 LLM）：`subject` = 事实里**全局活跃 df 最高**的实体（并列取字典序）；
  `attribute` = 该 subject 对应的最高置信度 triple 的 `pred`（否则该事实最高置信 triple 的 pred）。
- **判定方法（必须与结论同读）**：brief 要 20–30 条**人工判定**，但人工判定要看正文，而本轮边界**禁止打印
  任何真实正文**。因此精度用**独立抽取器**（生产 triple 的 `subj`，POS/模式族 vs 文档频率族）做
  **规则-对-判据的一致率代理**；30 条抽样只记录**实体名/谓词名**（见 JSON 的 `extraction.sample`）。
- **数字**：
  - 覆盖 **82/85 = 0.9647**；精度代理 **1/82 = 0.0122**（df 规则与 triple subj 几乎从不一致）。
  - `subject == 用户` 的组 **6 条**（`[4,25,43,103,117,131]`）；含 `用户` 的 **15 条**里 **9 条主体不是用户**；
    `用户是` 载体 **#160**（**不在**用户组里）。
  - `我是谁？`（gold #4）：
    | 臂 | 返回 id | 池大小 | #103/#117 是否在 top3 | gold 名次 |
    |---|---|---|---|---|
    | 基线 | `[4,117,103,25,36]` | 15 | 是 | 1 |
    | filter（收窄） | `[4,117,103,25,43]` | **6（收窄）** | 是 | 1 |
    | groupleg w0.15 / w0.5 | `[4,117,103,25,43]` | 15（保并集） | 是 | 1 |
    | 反事实：移除 #160 | `[4,117,103,25,36]` | 14 | 是 | 1 |
  - **伤 gold**（11 条有 gold 查询）：baseline top1 10 / top3 10 / missing 1；**filter 6 / 6 / 5**；groupleg 10 / 10 / 1。
  - identity **20/20**。
- **裁决**：**不采纳**。三条独立理由：① filter 臂结构性地**收窄并集**（15→6）且让 gold 查询 `top1 10→6、missing 1→5`；
  ② groupleg 臂保并集但**什么也没排除**（#103/#117 仍在 top3）；③ 反事实是**空结果**——2026-10-04 的
  `用户是` 载体病已被 0.4.2 的逐 variant clamp 关闭，gold 本来就是 #1，分组不再有可修的东西。
  另：规则抽取精度代理 1.2% ⇒ 该形态的 subject 判定在当前语料上不可用。
- **复现**：`node mem/scripts/spikes/bench-r2-6-subject-attribute.mjs`

## 8. R2-7 · L3 长事实分块 pilot（真模型，不下载）

- **做法**：生产嵌入后端 `bge-base-zh-v1.5`（本机缓存、`autoDownload: false`）、事实向量取自快照
  `semantic_vector`；对 `len > N` 的事实分 **K = min(3, ceil(len/N))** 个连续近等长块并编码；
  聚合 `chunk_max` = 各块 cosine 的最大值、`chunk_capped` = `min(chunk_max, 整事实 cosine)`。
  **不写任何库、不建第二个向量库**，名次由原始 cosine 重算。
- **数字**（20 条真实查询、11 条有 gold 中 10 条可判）：

  | N | 长文/总 | 块数 | 向量数 | 向量比 | 编码 ms | top1 | top3 | missing | 长笔记名次 变差/变好 | 长笔记在基线 top5 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | 512 | 9/85 | 18 | 85→94 | ×1.1059 | 2260 | 9→**8** | 10→10 | 0→0 | **16 / 1** | 1 |
  | 128 | 79/85 | 220 | 85→226 | ×2.6588 | 12915 | 9→9 | 10→10 | **0→1** | **112 / 14** | 79 |

  `chunk_capped` 在两档上恒等于基线（按构造不可能超过整事实分）。RSS **679.4 → 701 MiB**；
  8 条长文的写入编码 **2056.66 → 1898.56 ms（×0.9231）**——会话先预热、再逐事实交替计时，**没有**呈 K 倍：
  整事实编码本来就只覆盖窗口内的那段（超出部分被截断），分块把同一段拆开编，总量相当。
  这也说明"分块会放大写入"的先验在这条后端上**不成立**。
- **裁决**：**不采纳**（两档都不成立）。N=512 上 top1 **下降**且长笔记名次变差远多于变好；N=128 上
  top3 不升、missing +1、向量 ×2.66、编码 ~13.6 s，长笔记名次变差 112 次。"唯一可能改变数量级"的项
  在真实 20 条查询网络上**没有**给出 top-3 收益，代价却确定。
- **复现**：`node mem/scripts/spikes/bench-r2-7-chunking-pilot.mjs`

## 9. R2-8 · A4 索引文本并入实体名/日期

- **做法**（副本）：`ALTER TABLE facts ADD COLUMN index_text`（= 正文 + 实体名 + 日期 token 五种形态）+
  第二张 external-content FTS 表 `facts_fts2`（trigram）+ 三个同步触发器，只建在副本上；建完后 `VACUUM` 再量字节。
- **人群**：**2803 个 (事实,实体) 对中，实体名 100% 已经逐字出现在正文里（0 例外）** ⇒ "只有实体名命中"
  的查询在本题上**不存在可改善的人群**。**60/85** 条事实正文不含自己的日期字面（日期并入的唯一人群）。
- **数字**：
  | 读数 | 生产 FTS 腿 | fts2 腿 |
  |---|---|---|
  | 实体名查询（10 条，gold = 该实体的事实集）命中 | 9/10 | **9/10（零改善）** |
  | 日期查询（10 条合成，真实库 0 条时间查询）命中 | 9/10 | **10/10（+1）** |
  | 库大小 | 3 555 328 B | **3 887 104 B（×1.0933，< 2×）** |
  | p50（20 条查询 ×3 轮） | 25.40 ms | 28.03 ms（**+10.35%，< +20%**） |

  `facts_fts2` shadow tables = 282 624 B；identity **20/20**。
- **裁决**：**不采纳**。成本两项都过关（×1.09、+10.35%），但**收益为零**：实体名已经全在正文里，第二张表
  对实体名查询不多命中一条；日期那 +1 建立在"真实库 0 条时间查询"的合成集上（与 R2-2 是同一类缺失需求）。
  结论：A4 的收益取决于"查询词不在正文、只在实体/日期"的形态，本语料**没有这个形态**。
- **复现**：`node mem/scripts/spikes/bench-r2-8-index-text-merge.mjs`

---

## 10. 未测 / 边界（没有数字就是未测）

| 项 | 状态与原因 |
|---|---|
| G-A7 的真实覆盖率 | **只能生产期测**：无会话日志（调用方是否传 `source_ref` 是写侧行为），且本机 managed kb 为 0 篇 ⇒ 连重叠上界都是 0。instrument 规格见 §6。 |
| G-A2 "带标注渲染" | 只测到"`active + valid_to` 行仍以**相同名次**返回"；把它**渲染出标注**需要 wire 改动，本轮不实现 ⇒ 不测。 |
| R2-1 的冻结 41 网络 | 本轮把预算放在"语义关闭"的三条真实网络上（张力就在那里）+ 正面对照；冻结集的 F4 已由第一轮覆盖。 |
| 规模效应 | 全部在 85 条活跃事实上测；A4/L3 若需 2k/10k 规模未做（本轮无余量）。 |
| knowledge 库检索 | 只读其文档/chunk **计数**（R2-5）；kb 检索路径未测。 |

## 11. 复现命令与隐私自查

```bash
node mem/scripts/spikes/bench-r2-1-f4-negative-control.mjs
node mem/scripts/spikes/bench-r2-2-real-time-queries.mjs
node mem/scripts/spikes/bench-r2-3-graded-terms-blindspot.mjs
node mem/scripts/spikes/bench-r2-4-ga-schema-unchanged.mjs
node mem/scripts/spikes/bench-r2-5-source-coverage.mjs
node mem/scripts/spikes/bench-r2-6-subject-attribute.mjs
node mem/scripts/spikes/bench-r2-7-chunking-pilot.mjs
node mem/scripts/spikes/bench-r2-8-index-text-merge.mjs
```

每个脚本：只读真实库 → `VACUUM INTO` 快照（R2-4/R2-8 另做一份**副本**再 `ALTER`）→ 临时 `dataHome` 跑 →
结束删除临时目录。模型需已在 `~/.avantf/env/models`（`bge-base-zh-v1.5`）；**本轮未下载任何模型、未装任何依赖**。

**隐私自查**（对 `raw/round2-*.json` 递归扫描）：不存在 `text`/`content` 键，且除构造性 SQL/规则文本外
**没有任何长度 > 300 的字符串**；脚本只在内存里读正文。自查结果：8/8 JSON clean。

## 12. 实测 / 推断 / 未覆盖

**实测（本机、本次运行，2026-10-06 Asia/Shanghai；Node v22.23.2）**

- R2-1：三网络 × 4 臂的全部 id/分数、正面对照的 4/20 变化、divergent query 明细、degraded runtime identity 20/20。
- R2-2：9 个窗口的派生候选数、14 条查询三臂名次表、守卫 14/14、解析 14/14、identity 14/14。
- R2-3：61 条查询的形态人群、20 条派生查询的四种取词口径命中表、identity 20/20。
- R2-4：5 条 ALTER 的 2 ms、默认不变（id+分，脚本与产品双向）、不变量 0/1/0（含植入对照）、标注计数、identity 20/20。
- R2-5：kb 计数 0、重叠 0/85、`mirror_source` 85/85 单值、路径形 19/85。
- R2-6：覆盖 0.9647 / 精度代理 0.0122、用户组 6 条、载体 #160、两条臂的 id 表与 11 条 gold 查询的伤害表、identity 20/20。
- R2-7：两个 N 的向量数/编码耗时/名次表、RSS、写入编码倍数、identity N/A（无 recall pass）。
- R2-8：人群 0/2803、字节 ×1.0933、p50 +10.35%、实体/日期命中表、触发器 3 个、identity 20/20。

**推断（有代码或数据依据，未直接端到端观测）**

- R2-4 的"迁移成本"是列数 + 一次 `ALTER`；SQLite 追加可空/带默认值的列是元数据操作（实测 5 条 2 ms），
  但**回填**（`valid_from = created_at` 等）与重扫的线上成本未测。
- R2-8 的"实体名并入索引文本"收益为零是从"实体名 100% 是正文子串"推出的，与命中表一致；
  若写侧将来允许与正文不同的实体名/别名，结论会变。

**未覆盖**

- 任何生产代码 / 配置 / CHANGELOG / 版本号改动（本轮禁止）。
- `knowledge` 检索路径与跨库路由。
- 2k/10k 合成规模下的 A4 / L3。
- G-A7 的真实覆盖率（见 §10）。
