# BORROWABLE_IMPROVEMENTS 的复核：改进是否真的有效（2026-10-06）

> **对象**：`mem/docs/BORROWABLE_IMPROVEMENTS.md`（24 条合并总表，下称「总表」），其**状态列**声称全部来自
> `mem/docs/spikes/` 的三轮测量（R1 23:50 / R2 00:13 / R3 00:32，raw 数据在 `spikes/raw/*.json`）。
> **本文回答一个问题**：这些改进对记忆插件的**功能**是否有效。
> **方法**：两条独立轴 —— ① **代码轴**：逐项打开当前实现，判断"这项落地后会不会只是一个没人读的列"；
> ② **测量轴**：打开 raw JSON 与 bench 脚本，判断"状态列里的'已测否决'是不是数据支持的结论"。
> **口径**：本文所有 `file:line` 与数字均为**本次亲自复核**（2026-10-06 00:35–01:00），
> 与「总表」或其源文档不一致处以本文为准并标注。基线 mem **0.5.0**（HEAD `0450c3e`）。
> **不重复**：改动面/固定税见 `IMPROVEMENT_IMPACT_ANALYSIS.md`，性能账单见
> `IMPROVEMENT_FUNCTIONAL_PERFORMANCE_IMPACT.md`，对 hindsight 引用的核对见 `HINDSIGHT_ANALYSIS_REVIEW.md`。

---

## 0. 一页结论

**总表的"能力面"方向是对的** —— 代码确认 G-A7（溯源）、A6（逐臂信封）、A2（时间腿）、B1（写侧结构）
四处是**真实存在的缺口**，不是想象出来的。

**但它的"状态列"把三种强度完全不同的证据混成了一个词**：

| 证据强度 | 项 |
|---|---|
| **真测量、判对了** | A5（4 臂 5 指标全零位移）、L3（N=128 向量 ×2.66、编码 12.9 s、missing 0→1）、L2、A7 |
| **语料无判别力的空测** | **A3**（15/15 查询在 precision 天花板、7/15 条被改的腿基线为空）、**A4**（受测人群由构造保证为 0） |
| **与自己 raw JSON 相反的措辞** | **F4**（raw 写 `conditional_adopt_only_on_lexically_dominated_networks`，总表写"已封死"） |
| **指标测不到它要修的东西** | **A8**（`gold_kept` 只数 id，而胜出臂 86 条里 21 条**正文为空**） |

**另有三处"接收端"按现在的写法会变成死列** —— 而总表引用的那个先例（`mirror_source`）**不是先例，
是现役缺陷**：它今天仍在给每一个面向模型的事实视图发一个常量 `'user'`（§7.1）。

**还有一个总表没提的代码阻塞**：B1 让调用方供给实体，而 `reindexEntities` 会在下一次版本重扫时
**把它静默清掉**（§6）。

⇒ 建议：总表的**批次与主线保留**，但**状态列返工**（§9 给出逐行改法），并在批次 0 插两件与改进无关的修复（§7）。

---

## 1. 代码轴：真缺口 vs 会变死列

### 1.1 真实缺口（落地即有能力）

| 项 | 代码现状（实测） | 判断 |
|---|---|---|
| **G-A7** `fact_sources` + 反向溯源 | 事实→文档溯源**今天是零**：`facts` 表无来源列；memory 侧的 `source_ref` 是**读时用自身 id 现造**的 `memory:fact:${id}`（`core/src/store/memory.ts:1443`）。对照 kb 侧：chunk→document 已完备（`doc_chunks.doc_id` + `db/dao/chunks.ts:105`） | ✅ **真缺口**。但必须与写侧 `source_ref` 同批，否则重演 `mirror_source` |
| **A6** 逐臂证据信封 | `store/hybrid.ts:409`：`fuse(legs.map(leg => ({weight, scores})), overFetch)` —— 每腿的原始 `scores` Map 传进去后**只返回融合结果，原始逐腿分被丢弃**；`RecallHit` 只有单一 `score`（`contract/src/types.ts:102-139`）；`RecallResult.dropped_by_floor` 是**聚合计数**不是 per-candidate 溯源（`:195-214`） | ✅ **真缺口**，且是 A5/A7/A2/A10 的验收前提（总表这点判断正确） |
| **A2** 时间腿 | 引擎里**没有任何自然语言时间解析**：只有 `parseUtcTs`/`formatUtcTs`（UTC 戳，`lifecycle/trust.ts:51-62`）、SQL `julianday` 算术、以及把"何时/什么时候"当三元组槽位通配（`entities/extract.ts:106-109`）。腿是 per-store 注入（`hybrid.ts:142`，memory 在 `memory.ts:1393-1421` 建 4 腿）⇒ 加第 5 腿是 **`memory.ts` 的局部改动**，不动共享编排器 | ✅ **真缺口**（需求另说，见 §5）。**硬约束**：`unionLegs` 按**下标**合并、"A store returning a different leg count for one variant is a contract violation"（`hybrid.ts:477-479`）⇒ 时间腿必须在**自指增广的两遍里都存在**。权重契约今天恰好 3 键（`types.ts:198`），HRR 靠**共享 jaccard 权重**维持它（`memory.ts:1406`）⇒ 时间腿照此先例可保住 3 键；改成 4 键会动 `types.ts:198/221`、配置与 4 个 spec 的精确形状断言 |
| **B1** 最小集（`entities` + `event_date`） | `mem_remember` 的 `add` 今天只接 `content` / `category` / `ttl_days`（`contract/src/tools.ts:103-108`），无任何结构参数 | ✅ **真缺口**，但有阻塞（§6）。另：**没有任何地方度量或约束工具 schema 体积**（只有 `MAX_QUERY_CHARS` 管查询文本，`tools.ts:45`）⇒ 总表算的"+447/+1638 字符"是文档侧预算，无代码强制 |
| **A1 / A11** | 写入路径**无任何内容检查**：`store/ingest_guard.ts` 只是 `kb_add` 的 SSRF/路径边界（http `:81-134`、本地根 `:137-171`），从不看事实正文；`prompt.ts:44-59` 有"敏感信息只记存放位置"，但**没有**"授权忽略无关记忆"与"记忆是过去的记录、不指派任务" | ✅ **真缺口**（详见 `HINDSIGHT_ANALYSIS_REVIEW.md` §2–§3） |

### 1.2 会变成死列（除非同批带写侧**和**读侧）

| 项 | 代码现状（实测） | 为什么是死列 |
|---|---|---|
| **G-A1/A2** `valid_from/valid_to` + `superseded_by` | `supersedes_id` **已存在**，是刻意的 PLAIN 列（`db/schema.ts:32-39` 有整段注释解释为什么不做自引用 FK：那条 FK 曾让 purge 失败→回滚整个 tick→**进程起不来**），**已建索引**（`:65`）。写入点：`insertRevision`/`linkSupersede`（`db/dao/facts.ts:250-256,462-463`）经 `applySupersede`（`memory.ts:1808-1818`），唯一触发是 `update`（`:532-543`）。读取点：`toDetail`→`FactDetail.supersedes_id`（`memory.ts:1892`）、设置面板（`plugin/src/client/index.ts:834`）、purge 解链（`facts.ts:1004-1011`） | ① **没有任何检索腿读 `supersedes_id`** —— 被取代的行退出检索是因为 `archiveSuperseded` 改了 `status`，而每条腿都过滤 `status='active'`。② `superseded_by`（反向）用 `idx_facts_supersedes` **已可查**，存一份是**可派生的冗余**（除非要在行上渲染）。③ `valid_to` 与既有 TTL 归档语义**不同**：TTL 到期是**归档=隐藏**（`lifecycle/tick.ts:66-67`「pinned is NOT exempt」），而 `valid_to` 按总表是"active + 有截止期，照常返回"⇒ 没有独立读路径（时间腿或渲染约定）它就是**第二个没人消费的到期列** |
| **G-A6** `assert_count` | 重复写入时走 `changes === 0` 分支：`findByContent` → `is_new=false`，仅归档行才 revive（`memory.ts:1762-1785`）；`add` 返回 `RememberResult{fact_id,is_new,revived,entities,contradictions?}`（`:457`、`types.ts:267-278`）；工具描述**已明写** no-op（`tools.ts:313-314`）。重复 add **不给** trust bonus、不动任何计数器 | ① **调用方今天就已经知道是重复**（`is_new:false, revived:false`），丢的只是**次数**。② 现有计数器全是**读侧**的（`retrieval_count`/`helpful_count`/`bonus_count`，`memory.ts:1512-1516`、`trust.ts:98-149`）⇒ `assert_count` 确实是新的**写侧**信号。③ 但 trust 按 D9 **从不参与排序**（`types.ts:28-31` 的注释原文：「It never influences ranking (TRUST_MODEL.md D9)」）⇒ 没有排序/面板/stats 读者，它就是 `mirror_source` 第二 |
| **G-A8** 受约束 `entity_type` + 白名单 | `entities` 的唯一生产 INSERT 是 `INSERT OR IGNORE INTO entities (name) VALUES (?)`（`db/dao/entities.ts:23`）—— 三个列**从不被命名**，永远是 `'unknown'`/`''`/`'regex'`（`schema.ts:94-96`）。读取点：**零**（`namesForFact`/`bagsForFacts` 只 select `e.name`，`entities.ts:46-72`；无腿、无过滤、无 UI 读 `entity_type`） | 上线即 **100% 回落值**（R2-4 实测现存只有 1 个 distinct 值，与此一致）。**但有一半是免费的，见 §7.2** |

> **判据**（与总表 §2.3 的"依赖链"一致，但更严）：一列要算"有效"，必须同时有**写侧供应商**和
> **读侧消费者**。总表把"接收端先行"当原则，但接收端本身没有读者时，它连"收件箱"都不是 —— 只是迁移成本。

---

## 2. 测量轴：四处"已测否决"不成立

### 2.1 F4 —— 总表的措辞与它自己的 raw JSON **相反**

`spikes/raw/round2-r2-1-f4-negative-control.json` 的 verdict 逐字为：

```json
{ "positive_control_passed": true,
  "any_production_arm_divergence": true,
  "call": "conditional_adopt_only_on_lexically_dominated_networks" }
```

而 `spikes/IMPROVEMENT_SPIKE_BRIEF_ROUND2.md:32-33` 预注册的规则是：三臂在 degraded 网络上**仍**逐条相同 ⇒
否决封死；**若出现分歧 ⇒ 改判"仅在词法主导的网络上有效（附条件）"**。分歧出现了（4/20 条 id 改变）。

⇒ 总表 §0 的「**F4 已封死**」用的是**留给无分歧那一支的措辞**。这是一个**判断**被写成了**测量结论**。
（该卡的正面对照本身是合格的：`inverted` 臂用 `v → (min+max) − v` 反转 FTS 腿次序、保留分数区间，
在 `degraded`/`fts_only` 上改了 4/20 条 id、在 `live_sem0` 上改 0 条 ⇒ 证明"0 位移"是真 null 而不是脚手架瞎了。）

### 2.2 A4 —— 否决是**同义反复**，而且与 B1 **自相矛盾**

`scripts/spikes/bench-r2-8-index-text-merge.mjs`：

- `:52` 受测人群取自 `select fe.fact_id, e.name from fact_entities fe join entities e …`
- `:105` 判据是 `!String(r.content).includes(String(r.name))`

而这些实体名**本来就是 mem 自己的抽取器从同一份 `content` 抽出来的**（`entitiesFromTokens(tokens, content)`）
⇒ `entity_names_not_verbatim_in_content = 0 / 2803` 是**构造保证**的，**任何语料都测不出非零**。
脚本自己知道这一点（`:19`「A population of zero answers the first clause before any cost is considered」），
`IMPROVEMENT_SPIKE_RESULTS_ROUND2.md:283` 也留了 caveat（"若写侧将来允许与正文不同的实体名/别名，结论会变"）。

⇒ **总表 `:89` 写"没有可改善人群"、`:161` 列入"已测否决"，把 caveat 丢了。**
而**关键矛盾**是：让这个人群非零的**唯一途径**，就是同一份总表里 **B1 要做的"调用方供给实体"**。
**A4 被判死的理由，正是 B1 要创造的东西。** 总表的批次表把 B1 放批次 1、A4 放批次 3，顺序上会自然暴露这件事，
但正文没有一处写"A4 的否决以 B1 不落地为前提"。

（成本侧数字是真的、可用：库字节 ×1.0933、p50 25.40→28.03 ms = **+10.35%**。）

### 2.3 A3 —— "0.7/0.9 零收益"测在**没有判别力**的语料上

我直接读了 `spikes/raw/a3-entity-merge.json` 的 15 行 `rows[].base`：

| 实测 | 值 |
|---|---|
| 基线 `top1=1` 且 `top3=3`（precision@3 **天花板**）的查询数 | **15 / 15** |
| 基线 `entity_leg_size = 0` **且** `fanout = 0`（被改的那条腿**根本不返回东西**）的查询数 | **7 / 15** |
| 样例 | `base: {ids:[29,64,94,95,96], top1:1, top3:3, fanout:0, entity_leg_size:0, entity_leg_top3:[]}` |

⇒ 这个语料**只能显示伤害，不可能显示收益**。全程唯一可检出的位移是 `base` 查询在 t0.5 的 `fanout 15→16`
—— 也就是 `base~base64` 那次**有害**合并。

- **成立的一半**：t0.5 过度合并 **30%**（npm~pnpm、PNPM~npm、base~base64、avantf~avantfWork、
  listPackages~packages、packageId~packages）⇒ **否决 0.5 阈值有依据**。
- **不成立的一半**：「0.7/0.9 **零收益**」。而且 A3 在总表 `:87` 声称的收益是
  「`related/probe/reason` 更准、矛盾检测的共享实体数更准」—— `related`、`probe`、`reason`、矛盾检测
  **一次都没测**（没有任何 recall 类指标）。
- 补充：查询集是 5 个 2 字名 + **10 个最高 df** 的实体名（`gold_size` 41/25/25/22/22/18/16/16/15/15/15），
  即**刻意选在最难判别的方向上**，同时又全部落在 precision 天花板 ⇒ 双重失效。

⇒ 状态应从「❌ 已测否决」改为「**⬜ 未测**（语料无判别力；已测的只有 0.5 阈值的过度合并）」。

### 2.4 A8 —— 指标恰好**看不见**它要修的病

`scripts/spikes/bench-a8-budget-boxing.mjs:92`：`gold_kept: goldKept(prod.ids, q.gold)` —— **只数 id**。

`spikes/raw/a8-budget-boxing.json` 的 `real_summary`（我逐档读过）：

| 预算 | 截断臂（生产） | 装箱臂 |
|---|---|---|
| 80 | 86 条 / `truncated 80` / **`empty_text 21`** / **gold_kept 30** / 1426 tok | 24 条 / 0 / **0** / gold_kept 10 / 2312 tok |
| 150 | 86 / 73 / 10 / 30 / 2683 tok | 30 / 0 / 0 / 10 / 2299 tok |
| 300 | 86 / 62 / 10 / 30 / 5309 tok | 39 / 0 / 0 / 14 / 3879 tok |
| 600 | 86 / 26 / 2 / 30 / 10142 tok | 62 / 0 / 0 / 21 / 8423 tok |

⇒ 预算 80 档，截断臂 **24% 的返回条目正文为空**，却仍记 `gold_kept 30`。**"给了 id 但没给正文"正是装箱
要修的失败模式**，而指标把它算成"保住了"。这个指标**结构上无法**为 A8 记分。

另外两处总表未提：

- `verdicts.frozen_30 = {delta: 0, verdict: "adopt"}` —— **6 档里有 1 档通过**，而总表 `:118` 写"gold 每档都掉"。
- **公平地说，否决在效率轴上站得住**：按 gold/token，预算 80 档截断臂 `30/1426` vs 装箱臂 `10/2312`
  ≈ **6.9× 更高效**。所以正确的结论是「**用 inline 可读性换 token 效率，效率上确实输**」，
  而不是「已测否决（更差）」。这是一次**取舍裁决**，总表 `:118` 的"呈现变化"标签其实已经暗示了这点，
  但状态列的 ❌ 把它写成了测量结论。

---

## 3. 一处更正：L2 **判对了**（附本文自己差点被带错的记录）

初审时有一个看起来很强的发现：L2 的 `frozen.d0.2.must_exclude = 0.7073` 高于基线 `0.6585`（27/41→29/41），
而 `bench-l2-two-leg-admission.mjs:143-147` 记录基线时**漏了 `must_exclude`** ⇒ 裁决逻辑
（`:155-160`，只看 `top3Up && !anyGoldRemoved`）**从没检查过交集规则最该动的那条轴**。

**这个"收益"是假的。** 生产冻结断言在 `core/test/eval_zh.spec.ts:325`：

```
must_exclude_pass_rate: 0.7073170731707317      // = 29/41
```

L2 的 d0.2 臂 **恰好等于生产值** ⇒ 该轴**零位移**，总表的「纯删不增 / 收益 0」**判对了**。
被当作"基线"的 `0.6585` 来自 F4 那张卡的 `frozen.bm25` 臂，而 F4 的冻结网络注明
「**strict floors, real embedder, real remember**」（`bench-f4-fts-score.mjs:21`）—— 与 spec 的确定性后端
**不是同一个网络**，两者相差 2 条查询（27/41 vs 29/41）。

⇒ 剩下的有效批评只有弱得多的一条：**裁决逻辑没有检查该检查的轴**（过程缺陷），而不是"结论错了"。
这条批评同样适用于 §2 的其余各卡：**否决的可信度取决于脚本记了什么，而不只是数字是多少。**

---

## 4. 新发现：三轮 spike 的卡之间**没有共同基线**

| 卡 | 冻结 41 的后端 | 真库 | 合成 |
|---|---|---|---|
| F4（R1） | **real embedder**（`bench-f4:21`）⇒ `must_exclude` **27/41** | 85 条快照 × 20 查询 | — |
| L2（R1） | 复现生产断言 ⇒ `must_exclude` **29/41** | 同上 | — |
| R2-1 正面对照 | degraded / fts_only / live_sem0 三个网络 | 同上 | — |
| R2-2（A2） | — | **从快照派生**的 14 条时间查询 | — |
| R2-8（A4） | — | 85 条快照 | 副本上 `ALTER` 出 `facts_fts2` |
| **R3 全部** | — | **完全不碰真库**（`round3-s2-supplier.json: measured_on = "constructed fixture (no live-store read)"`） | 78 条合成事实，`FIXTURE_SEED=20261006` |

⇒ **「已测否决」这四个字在不同行里含义不同**：有的对着 real-embedder 冻结网络，有的对着 stub 冻结网络，
有的对着 85 条快照的 20 条查询，有的对着合成 fixture。总表把它们放进**同一张表、同一个状态列**，
邀请的正是这种跨卡横向比较 —— 而 §3 显示它**不成立**。

**建议**：状态列旁加一列「测量网络」（`frozen-real` / `frozen-stub` / `snapshot-85×20` / `synthetic-78`），
并在 §0 明确"跨网络不可比"。这不改任何裁决，只是让裁决可复核。

---

## 5. A2 的采纳证据是**近循环**的；R3 的两个数字要重标

### 5.1 R2-2 的 gold 就是那条腿的谓词

`scripts/spikes/bench-r2-2-real-time-queries.mjs`：

- `:183-185` 选窗口的条件是 `inWindowFacts.length === 1 && factsWithTopic.length >= 2`，并令
  `gold: inWindowFacts[0]`；
- `:230` `inWindowIds = ids.filter(id => inWindow(id, win))`；
- `:236` 该臂追加的腿给 **`inWindowIds` 里每一条打 1.0**（并复用 `leg: 'fts'` 标签）。

⇒ **腿的谓词与 gold 标签是同一个判断**。`top1 3/14 → 14/14`、`avg_rank 1.8571 → 1.0` 近乎恒真。
R3 的诚实版本（`event_date ≠ created_at`、所有事实同一写入时刻）只有 **`top1 1/3`**，
而它的 `created_at` 对照臂与基线**逐字节相同** ⇒ **R2-2 那个强数字测的是"写入时间"，不是"事件时间"**。

结合总表自己承认的「61 条真实/冻结查询里带时间表达的 = **0**」，A2 的准确状态是：
**能力缺口为真（§1.1）、需求未证、强数字来自循环语料**。批次 2 那句"先造真实时间查询集"
应写成**发布前置条件**（gate），不是备注。

### 5.2 R3 的 43.59% 是**假设的回声**，不是测量

`spikes/raw/round3-s3-variance.json` 的 `annotators`：

```
A: { seed: 20261006, rule: "canonical truth as constructed" }
B: { seed: 20261007, rule: "same facts, second session wording: 50% of facts use the surface form
     seen in the note instead of the canonical name, 15% drop one entity, 60% of topic subjects
     use a surface form, 25% attribute synonym, 20% event date +/-1 day" }
```

⇒ B 是一张**手写的扰动表**，A 是构造时的真值。所以 `43.59%`（折叠同义后 `19.23%`）是**这张表被回声回来**，
不是"真实模型两次标注的一致性"。真正**测到**的是扰动穿过生产管线后的位移：14 条查询里 **7 条 id 完全相同、
6 条 top-3 改变、1 条 top-1 改变**、平均位移 1.36 位。总表 §6 把"真实 agent 的合规率/一致性率"列为**未测**
是**诚实且自洽**的 —— 风险只在于 `:74` 把 43.59% 与实测数字并列，读者会把它当数据。

### 5.3 R3 的预注册门槛**返回 false**

`spikes/raw/round3-s2-supplier.json`：

```
decision_rule: { material_gain: true, no_gold_loss: true, union_not_narrowed_by_grouping: true,
                 retention_at_50pct: { entity_top1: 0.3333, entity_top3: 0.4, … } }
             → primary_retention_passes: false
               alternative_reading_passes: true
```

`IMPROVEMENT_SPIKE_RESULTS_ROUND3.md:17` 预注册的采纳条件是「A3 在 50% 合规下仍保留 **≥50%** 的增益」；
`:226` 自己写「**不成立**（alias top-3 保留 **40%**、top1 保留 33%）」。承载实质增益的正是 alias 族
（`A2 15/18`），而它没过关；`:26` 那条"判据的实际读法"把门槛收窄到"承载实质增益的那个类别"，
时间族保留 100%（但只有 3 条查询）。

⇒ 总表 `:74` 报了"50% 合规只保留 40%"这个**数**，但没有报"**预注册判据的 primary 读法返回 false、
采纳靠的是 alternative 读法**"。B1 的状态应从「⚠️ 有条件采纳」改为
「⚠️ **预注册主判据未通过，按备选读法采纳**」——差别在于谁承担举证责任。

---

## 6. B1 的代码阻塞：调用方供给的实体会被重扫**静默清掉**

`core/src/store/memory.ts:1208-1226`（`reindexEntities` 的循环体，实测）：

```ts
const entities = normalizeWrites(entitiesFromTokens(tokens, row.content).map((e) => e.name))  // :1212 只从 content 抽
this.db.transaction(() => {
  this.entities.unlinkFact(row.fact_id)          // :1215 先解掉全部现有链接
  this.linkEntities(row.fact_id, entities)       // :1216 再按 content 重新链
  …
  this.facts.setEntitiesVersion([row.fact_id], ENTITY_EXTRACTOR_VERSION)
  this.facts.requeueConflictCheck([row.fact_id])
})()
```

而 `fact_entities` 是**裸的两列**，没有任何来源/供应者字段（`db/schema.ts:99-103`，实测）：

```sql
CREATE TABLE IF NOT EXISTS fact_entities (
  fact_id   INTEGER REFERENCES facts(fact_id) ON DELETE CASCADE,
  entity_id INTEGER REFERENCES entities(entity_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, entity_id)
)
```

⇒ **B1 落地后，任何一次 `ENTITY_EXTRACTOR_VERSION` 升版重扫都会把调用方供给的实体链接删掉、
只留 content 抽出来的那部分**，而且不会有任何日志。这正是 `AGENTS.md` 里那条纪律要防的形态
（"改嵌入空间就是一次数据迁移…而没有任何告警"）在实体侧的重演。

**B1 的前置因此是**：`fact_entities` 需要 link 级来源（或重扫时的合并规则：只 unlink `method='regex'` 的链接）。
自然的归宿是**现在已经死掉的 `entities.extraction_method`**（§1.2）—— 但它是 **per-name** 不是 **per-assertion**，
所以必须动 `fact_entities` 本身。总表把 G-A8 排在批次 2、B1 排在批次 1，**顺序反了**：
来源标记必须与 B1 **同批**，否则第一次重扫就吃数据。

---

## 7. 两个**现役**缺陷（与改进项无关，建议插进批次 0）

### 7.1 `mirror_source` / `mirror_target` 不是"死列先例"，是**正在发货的缺陷**

- 唯一写入点把 `mirror_source` **硬编码成 `'user'`**（`db/dao/facts.ts:250-256`，实测：
  `.run(v.content, v.category, v.ttlDays, 'user', v.supersedesId, …)`）。
- `mirror_target` **全仓没有任何写入点** —— grep 只命中 4 处非写入引用：DDL `schema.ts:57`、
  SELECT 列表 `facts.ts:31`、detail 映射 `memory.ts:1891`、契约类型 `types.ts:83`。
- 两者都进 `FactSummary`/`FactDetail`（`memory.ts:1880,1891`；`types.ts:37,83`），
  且**不在** `RETENTION_DIAGNOSTIC_FIELDS = ['trust_score','remaining_days','helpful_count']`（`types.ts:59`，实测）
  ⇒ **不被 `withoutRetentionDiagnostics` 剥掉**。

⇒ **每一个面向模型的事实视图都携带一个常量 `'user'` 和一个常量 `null`**，白占 token、零信息。
总表 §2.3 用它当"新列全空"的先例是对的，但更该说的是：**这个先例今天还在生产环境里花钱。**
建议批次 0 顺手处理（剥出模型面，或给 `mirror_*` 一个真实语义）。

### 7.2 抽取器**已经算出** `type` 和 `method`，六个调用点全部丢掉

- `entities/extract.ts:10-14`：`interface ExtractedEntity { name: string; type: string; method: string }`
- 六个调用点一律 `.map((e) => e.name)`：`store/memory.ts:431`、`:530`、`:1212`、`:1363`；
  `store/knowledge.ts:963`、`:1534`
- 唯一 INSERT 只写 `(name)`：`db/dao/entities.ts:23`

⇒ **G-A8 的引擎侧一半根本不需要供应商** —— 值已经在手，被扔了六次。这是全表**最便宜**的一项
（不需要调用方合规、不需要白名单、不需要等 B1），而两份影响分析都把它当"需要重扫 + 上线 100% 回落值"的
M 级项。**准确的说法是**：`type`/`method` 落库 = S 级、立即可做、且是 §6 那个 link 级来源的**必要前置**；
"受约束白名单 + 校验回落"才是需要供应商的那一半。

---

## 8. 结论分档

| 判断 | 项 | 依据 |
|---|---|---|
| **有效**（代码确认真缺口，机制成立） | **G-A7** 溯源、**A6** 逐臂信封、**A2** 时间腿（能力成立、需求待证）、**B1** 最小集（需先解 §6）、**A1**、**A11①②** | §1.1 |
| **有条件有效**（同批不带**写侧+读侧**就是死列） | **G-A1/A2**（`superseded_by` 冗余、`valid_to` 需独立读路径）、**G-A6**（需读者）、**G-A8**（引擎侧一半免费、白名单一半需供应商） | §1.2、§7.2 |
| **裁决需返工**（不该写"已测否决"） | **F4** → 附条件采纳（raw JSON 原文如此）；**A4** → 条件否决，**B1 落地后必须重测**；**A3** → 未测（语料无判别力，声称的收益从未测）；**A8** → 取舍裁决（token 效率上确实输，但不是"更差"） | §2 |
| **判对了** | **L2**、**A5**、**A7**、**L3** | §3；A5/L3 见源文档 |
| **证据需重标** | **R2-2 的 A2 强数字**（循环语料）、**R3 的 43.59%**（手写扰动表）、**B1 的采纳**（预注册主判据 false） | §5 |
| **跨卡不可比** | 所有"冻结 41"数字：real-embedder 27/41 vs stub 29/41 | §4 |
| **与改进无关但该修** | `mirror_source`/`mirror_target`；抽取器 `type`/`method` 落库 | §7 |

---

## 9. 待办：总表需要改的行

| 位置 | 现状 | 应改成 |
|---|---|---|
| §0 第 1 条 | 「质量/精度方向的候选**全部被否决**（F4 已封死、L3、A4、A3、A5、A7、A8…）」 | 「**A5/L3/A7 被测量否决、L2 判对**；**F4 的 raw 结论是附条件采纳**；**A3/A4 的 null 来自语料无判别力**（A4 的人群由构造保证为 0）；**A8 是取舍裁决**（其指标看不见它要修的病）」 |
| §0「状态列全部来自 `IMPROVEMENT_SPIKE_RESULTS.md`」 | 与事实不符 | 状态来自**三轮**（R1/R2/R3），且其中 **16 项是 ⬜ 未测**；建议同时加「测量网络」列（§4） |
| §2.4 A3 行 | ❌ 已测否决 | ⬜ **未测**（15/15 在 precision 天花板、7/15 腿为空）；已测的只有"0.5 阈值过度合并 30%"⇒ **只否决 0.5** |
| §2.4 A4 行 | ❌ 已测否决，"没有可改善人群" | ⚠️ **条件否决**：人群为 0 是**构造保证**（实体名来自同一份 content）；**B1 落地后必须重测**。成本数字保留（×1.0933、+10.35% p50） |
| §2.7 A8 行 | ❌ 已测否决（更差） | ⚖️ **取舍裁决**：inline 可读性 vs token 效率（80 档 6.9× 差距）；`gold_kept` 只数 id、胜出臂 21/86 条**正文为空**；`frozen_30` 的 verdict 是 **adopt** |
| §2.7 F4（§4 第 157-159 行） | 「F4 已封死」 | 「F4 raw 结论 = `conditional_adopt_only_on_lexically_dominated_networks`（正面对照通过、生产臂出现分歧）；**维持不采纳是判断，不是测量**」 |
| §2.1 A2 行 | ✅ 采纳（条件已解除，名次口径） | ✅ 采纳，但**条件未解除**：R2-2 的 gold 与腿谓词同构（`bench-r2-2:183-185` vs `:236`）⇒ 强数字近循环；R3 诚实版只有 `top1 1/3`；**发布前置**=真实时间查询集 |
| §2.3 B1 行 | ⚠️ 有条件采纳 | ⚠️ **预注册主判据未通过**（`primary_retention_passes: false`），按备选读法采纳；并补 §6 的**重扫阻塞**为前置 |
| §2.3 G-A8 行 | ✅ 可行性已验（M） | 拆两半：**`type`/`method` 落库 = S、立即可做、无需供应商**（值已被算出后丢弃 6 次）；**白名单 + 校验 = M、需供应商** |
| §3 批次表 | G-A8 在批次 2、B1 在批次 1 | **来源标记必须与 B1 同批**（否则第一次重扫吃数据）；`type`/`method` 落库提到**批次 0** |
| §3 批次 0 | — | **新增两件现役缺陷修复**：`mirror_source`/`mirror_target` 出模型面（§7.1） |
| §2.2 G-A1/A2 行 | ✅ 可行性已验 | 补：`supersedes_id` **已存在且有索引**、反向已可查 ⇒ `superseded_by` 是可派生冗余；`valid_to` 无独立读路径即死列（§1.2） |
| §2.2 G-A6 行 | ✅ 可行性已验 | 补：重复写入**调用方今天已知**（`is_new/revived`）；`assert_count` 需先有读者（trust 按 D9 不参与排序） |

---

## 10. 一句话

**总表指的方向对（能力面、接收端先行、纪律），但它的状态列需要返工**：
四项"已测否决"里，**一项与自己 raw JSON 相反（F4）、一项的受测人群由构造保证为零（A4）、
一项测在没有判别力的语料上（A3）、一项的指标看不见它要修的病（A8）**；
而三项"可行性已验"的接收端（`superseded_by` / `assert_count` / `entity_type`）在没有读者的情况下
**就是 `mirror_source` 的复制品** —— 那个"先例"今天还在库里，每条事实都在给模型发一个常量 `'user'`。
最便宜的有效改进不在总表的任何一行里：**把抽取器已经算出、却被丢弃六次的 `type`/`method` 落库**（§7.2）。
