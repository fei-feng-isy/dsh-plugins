# IMPLEMENTATION_PLAN 的复核（第三轮 · 覆盖前两轮，2026-10-06）

> **对象**：`mem/docs/IMPLEMENTATION_PLAN.md`（**第二次修订版**，2026-10-06 02:5x；**12 项** P-01…P-13，
> P-12 已删除；三个批次）。
> **本文回答两个问题**：① 每项**能否达到它自己写的设计目的**；② 每项**对记忆插件现有功能有没有负面影响**
> （尤其是方案"影响"段没有列出的）。
> **版本说明**：本文**覆盖**前两轮。第一轮的 12 处、第二轮的 8 处在修订版里**全部闭环**（§1 只列表）。
> 本轮把**前两轮没有深查的项一次查完**（P-02 / P-03 / P-04 / P-07 / P-10 / §4 / §5 / §6），
> 结论是 **4 处需要在方案里定一句话 + 2 处措辞**，全部是**文字层面的决策，不需要再测任何东西**。
> **方法**：逐项打开当前实现核对。所有 `file:line` 与本机读数均为本次亲自复核（2026-10-06 02:30–03:00）。
> **基线**：mem **0.5.0**（HEAD `0450c3e`，schema v9，`WIRE_VERSION=2`）。

---

## 0. 一页结论

**12 项里 8 项可以直接开工**（P-01、P-03、P-05a、P-05b、P-06、P-10、P-13，以及 P-08 改一个 action 名）；
**4 项需要先在方案里定一句话**：

| # | 项 | 问题 | 需要定的那一句话 |
|---|---|---|---|
| 1 | **P-02** | 新指标进 `report.summary` 会**立刻弄红**冻结断言（`toEqual` 对多余键严格失败），而方案写"既有精确断言保持不变" | 新指标放 `summary` **之外的兄弟字段**，还是同提交重冻断言 |
| 2 | **P-04** | 提示词**文件优先于内置文案**，本机 `~/.avantf/prompts/mem-memory-usage.md` 已存在（935 B）⇒ 三段新文案**一条都不生效** | 收益限定为"未自定义的用户"，并在升级说明里给出需手动补的文案 |
| 3 | **P-07** | 两条 `valid_to` 写入路径都会**归档**该行，而所有腿过滤 `status='active'` ⇒ 信封里那个"非空才序列化"的字段**永远不会序列化** | 补一条让行**留在 active** 的写入路径，还是删掉信封那半句 |
| 4 | **P-08** | 反向溯源写的是 `admin detail`，但 `detail` 按 `fact_id` 取单条；枚举类是 `list` | 改成 **`admin list` 增 `source=`** |

另有 2 处措辞（§5）。**P-12 已整条删除**，第二轮 §2 的冲突随之消失。

### 0.1 裁决总表

| 项 | 达到设计目的 | 负面影响 | 裁决 |
|---|:--:|---|---|
| **P-02** 回归网 | ⚠️ | **会弄红冻结断言**（除非选定指标落点） | ⚠️ 先定 §2.1 |
| **P-03** 密钥/PII 守卫 | ✅ | 拒绝写入是用户可见行为变化（可控） | ✅ 可做（错误口径已核实） |
| **P-04** 提示词与纠错 | ⚠️ **对自定义用户不生效** | 提示词变长（token） | ⚠️ 先定 §2.2 |
| **P-05a** 停止假溯源 | ✅ | **无**（可空列 + 三个消费面都不读） | ✅ **批次 0 首选** |
| **P-05b** 实体属性落库 | ✅ | **无**（已改为不升版本号） | ✅ 可做 |
| **P-06** 备份纪律 | ✅ | 一次 `statSync` | ✅ 可做 |
| **P-01** 逐臂信封 | ✅ | 波及 kb（已列入验收） | ✅ 可做（措辞见 §5） |
| **P-07** 有效期与取代 | **一半** | 信封字段不可达 | ⚠️ 先定 §2.3 |
| **P-08** 事实来源 | ✅ | 已改 `EXISTS` | ⚠️ 改 action 名（§2.4） |
| **P-13** 事件时间写入 | ✅ | 未给时逐字节不变 | ✅ 可做 |
| **P-10** 重复断言计数 | ✅（弱） | 默认 1、revive 不计数 | ✅ 可做 |
| **P-11** 中文时间戳查询 | ✅ | 默认关 ⇒ 对现有查询无影响 | ✅ 可做（依赖图见 §5） |

---

## 1. 前两轮已闭环的 20 处（只列，不论证）

**第一轮（12 处）**：新增 P-13 供 `valid_from`；删除 P-09（它会把 P-05b 的成果重扫成 `unknown`）；
P-07 的 `valid_to` 改非空才序列化；P-12 验收改实跑并点名盲区查询；P-12 补实现约束（不得把 2 字 run 放进
`buildFtsQuery` 的 `parts`）；P-01 补 kb 对照；P-08 定腿内谓词；P-06 拆掉 git 探测；P-02 补齐三条守卫
（含反事实臂）；P-03 补反例集口径；P-10 改默认 1 + revive 不计数；§0 写下 wire 判据、§4 加"实跑对照"门禁。

**第二轮（8 处）**：**P-12 整条删除**（采纳"暂缓"选项，与 `SHORT_QUERY_FTS_REACHABILITY.md:42,176-177`
的既有裁决不再冲突）；**P-05b 改为不升 `ENTITY_EXTRACTOR_VERSION`**、接受混合 vintage、将来用按名定向 UPDATE
（避开全库重跑三元组 + 覆写 HRR + 重排矛盾检测）；**P-11 删掉"回退到写入时间"**、改为只读 `valid_from`、
无事件时间的事实不作为该腿候选；**P-11/P-13 补覆盖率指标**（`valid_from` 从第一天起进 `admin stats`）；
**P-08 改用 `EXISTS`**（避免多来源行扇出吃掉 `LIMIT cap`）；**P-13 成本标注为上界**；
**§5 补 P-06 进 CHANGELOG 名单**；§6 依赖图同步移除 P-12。

---

## 2. 本轮需要定的 4 处

### 2.1 P-02：新指标进 `summary` 会**立刻弄红**冻结断言

**事实**（实测）：

- `test/eval_zh.spec.ts:318` 是 `expect(report.summary).toEqual({ …7 个键… })`。
  **Vitest 的 `toEqual` 对多余键严格失败**（不是 `toMatchObject`）。
- `EvalSummary` 的 7 个字段：类型在 `src/eval/metrics.ts:51`、空例返回在 `:57`、构造在 `:66`
  （`n_queries / mean_precision_at_k / mean_recall_at_k / mrr / empty_rate / must_include_pass_rate /
  must_exclude_pass_rate`）。

⇒ P-02 要加的 `nDCG@k` 与 top-3 相关条数**若进 `summary`**，这条断言在第一个提交就红。
而方案 §收益 写的是「**41 条既有精确断言保持不变**」—— 两者不能同时成立。

**必须二选一并写进方案**：

| 选项 | 做法 | 代价 |
|---|---|---|
| **(a) 兄弟字段** | 新指标放 `report.ranking`（或 `report.extra`）之类，`summary` 的 7 个键不动 | 断言不变；但两个指标族分开，读报告时要看两处 |
| **(b) 同提交重冻** | 把 9 个键一起写进断言，并按 `AGENTS.md` 的纪律"重冻 + 解释" | 断言文本变化；须说明新键的期望值从哪来 |

（建议 (a)：P-02 本身不改检索行为，让它的指标落点也不改既有断言，归因最干净。）

### 2.2 P-04：提示词**文件优先于内置文案**，本机三段新文案一条都不生效

**事实**（实测）：

- `plugin/src/prompt.ts` 的设计注释原文：「**The FILE owns the text**; the CODE keeps the identity」；
  `promptFileSpecs()` 返回 `{ file, fallback: section.text }` —— **内置文案只是 `fallback`**，
  仅在文件**缺失或空白**时使用。
- `PROMPT_FILES` 三项：`mem-memory-usage.md` / `mem-knowledge-usage.md` / `mem-kb-edit.md`。
- 本机 `~/.avantf/prompts/`：

  ```
  mem-memory-usage.md      935 B   Oct  1 23:12   ← 存在且非空
  mem-knowledge-usage.md   406 B   Oct  1 19:43
  mem-kb-edit.md           215 B   Oct  1 19:43
  ```

⇒ **P-04 的三段新文案在这台机器上一条都不会生效。** 而 `AGENTS.md` 明确把
「用户编辑的一切住在 `~/.avantf/configs/*.yaml` 与 `~/.avantf/prompts/*.md`」当设计原则，
所以"自定义用户"是**常态而非例外** —— 包括本仓作者自己。

**这不是缺陷，是设计的必然**（文件优先是对的），但方案的 §收益「降低误用与自我强化回环；纠错有明确通道」
**对自定义用户不成立**，而这三条口径恰好是防回环的那一层（`BORROWABLE_IMPROVEMENTS_REVIEW.md` §2.2
记录过：`contradiction.ts` 的 `EMBED_SIM_DUP_MAX = 0.97` 会放过改写后的近重复，文案是唯一能挡一部分的层）。

**修法**：① §收益 限定为「对**未自定义** `mem-memory-usage.md` 的用户生效」；
② 补一条交付动作：在 `[0.6.0]` 的升级说明里**给出需要手动补的三段文案原文**，
让自定义用户能自己加进去（内置默认正文与用户文件不会自动合并，这是既有语义，不该改）。

### 2.3 P-07：信封里的 `valid_to` 是**不可达代码**

**事实**（实测）—— `valid_to` 的两条写入路径都会**归档**该行：

| 路径 | 行为 |
|---|---|
| 矛盾裁决真阳性 | `resolveContradiction(id, 'true_positive', loserFactId)` → **`this.archive(loserFactId, 'contradiction')`**（`store/memory.ts:838` 起）；已裁决的行还会被**拒绝**二次裁决（`reason: 'already_resolved'`） |
| `update` 修订链 | `applySupersede`（`store/memory.ts:1808-1818`）**归档旧行**并删其三元组 |

而所有检索腿都过滤 `status='active'` ⇒ **任何 `valid_to` 非空的行都不可能出现在 recall 结果里**
⇒ 方案写的「信封里的 `valid_to` **仅在非空时序列化**」那个字段**永远不会序列化**。

但 `BORROWABLE_IMPROVEMENTS.md` 的 G-A2 描述的意图是「**active + `valid_to` 的事实能在结果里出现**，由读者判」。
⇒ **意图与写入路径对不上。**

**二选一**：

| 选项 | 做法 | 后果 |
|---|---|---|
| **(a) 补一条留在 active 的写入路径** | 最自然的是 **P-13 同时接受可选 `valid_until`**（调用方说"这件事到某时为止"），或 `update` 显式给"有效期至" | 意图达成：结果里能看到"这条截止于 X"，由模型判是否采信；P-07 的信封半句有意义 |
| **(b) 删掉信封那半句** | P-07 的收益收敛为「`admin detail` 与面板可审计」 | 更简单；但"时间语义成为可见的决策依据"这句要一起删 |

（建议 (a)：它与 P-13 同批、同一个入参面、同一次 wire bump，边际成本很小；否则 P-07 的"新功能"只剩面板。）

### 2.4 P-08：反向溯源指错了 action

**事实**（实测）：`contract/src/tools.ts:185`

```ts
export const ADMIN_ACTIONS = ['stats', 'list', 'detail', 'archive', 'restore', 'pin', 'unpin',
  'trust_diagnose', 'vectors_diagnose', 'vectors_fix', 'contradict_check', 'contradict_resolve',
  'maintenance'] as const
```

`detail` 是**按 `fact_id` 取单条**；枚举类是 **`list`**（`FACT_VIEW_ADMIN_ACTIONS = ['list','detail']`
说明两者都产出事实视图，但只有 `list` 是集合）。

⇒ 方案写的「反查'某来源产生了哪些事实'走 **`admin detail`** 的查询」应改为
「**`admin list` 增 `source=` 过滤**」—— 与 P-08 已经定好的 `recall source=` 用**同一个参数语义**，两处一致。

---

## 3. 已核实为**干净**的项（本轮新查的部分）

| 项 | 核实内容 |
|---|---|
| **P-03** | 「错误面走既有工具错误口径、**不加字段**」**成立**：错误路径实测是 throw → `wireErr({ ok: false, error: remoteErrorText(error) })`（`plugin/src/index.ts:206-207, 263-264, 275-276, 289-290`）⇒ 拒绝写入不需要新字段 |
| **P-05a** | `mirror_source`/`mirror_target` 是可空 `TEXT`（`db/schema.ts:56-57`）⇒ 停写不破坏 INSERT；client / CLI / MCP 三处**都不读**（grep 全空）⇒ 删出参不需要 wire bump |
| **P-05b** | 修订后不升 `ENTITY_EXTRACTOR_VERSION` ⇒ 不触发 `reindexEntities`（`store/memory.ts:1208-1226` 会重跑三元组、覆写 HRR、重排矛盾检测）；两列今天确实**零消费者**（`db/dao/entities.ts:46-72` 只 `SELECT e.name`）⇒ 混合 vintage 成本为零 |
| **P-06** | 只加一次 `statSync`；`store/memory.ts` 与 `runtime.ts` 今天**无任何** `statSync`/`existsSync`/`readdir`/`execSync`/`spawn`（grep 实测为空）⇒ 这是首次引入，但只碰文件状态、不碰子进程，与"零运行期依赖 / 离线可用"红线相容 |
| **P-10** | `insertFact` 的显式列表（`db/dao/facts.ts:249-256`）不含 `assert_count` ⇒ 走 `ADD COLUMN … DEFAULT 1`，新行与既有行都得 1，语义一致；revive 分支在 `store/memory.ts:1762-1785`，与"纯重复 +1"可分开 |
| **P-01** | `include_scores` 默认 false 正确；`fuse` 是共用内核（`retrieval-core/src/fusion.ts:68`，唯一调用点 `store/hybrid.ts:409`）⇒ kb 对照已列入验收，闭合 |
| **P-11** | 删掉回退后语义单一；权重共享 jaccard 位有先例（`store/memory.ts:1406` 注释原文）⇒ 三键契约不破；腿必须在自指增广两遍里都存在（`store/hybrid.ts:477-479` 的下标契约）已写明 |
| **P-13** | 未给 `event_date` 时逐字节不变；入参与 P-01 共用同一次 `2→3` ⇒ 只 bump 一次 |
| **§0 / §4** | wire 判据（加入参必 bump、改出参看消费者）与代码一致（`plugin/src/remote.ts:132-140` 的 strict codec 注释）；"凡声称冻结集不变必须实跑"已进门禁 |

---

## 4. 一处跨项的一致性检查（通过）

批次 1 声称"**共用一次 schema v10 迁移与一次 wire 2→3**"。逐项核对：

| 项 | 迁移 | wire |
|---|---|---|
| P-01 | — | **加入参** `include_scores` ⇒ 需声明 + bump ✓ |
| P-07 | `facts` +2 列（`valid_from`/`valid_to`） | 出参（非空才序列化）⇒ 按 §0 判据不需 bump ✓ |
| P-08 | 新表 `fact_sources` + 索引 | **加入参** `source_ref`（remember）+ `source`（recall）+ `admin list` ⇒ bump ✓ |
| P-13 | 复用 P-07 的 `valid_from`（**不新增列**） | **加入参** `event_date` ⇒ bump ✓ |
| P-10 | `facts` +1 列（`assert_count`） | 出参 ⇒ 不需 bump ✓ |

⇒ **一次 v10 迁移（3 列 + 1 表 + 索引）+ 一次 `2→3`** 成立，无重复缴税。批次 0 确实**零迁移**
（P-05a 只停写不删列、P-05b 只改写入赋值、P-06 只加统计字段、P-02/P-03/P-04 不动 schema）✓。

---

## 5. 两处措辞（可选）

| 位置 | 现状 | 建议 |
|---|---|---|
| **§6 依赖图** | `P-06 ─────────→ P-11（前置：P-13 + 真实时间提问集合）` | P-06（备份纪律）与 P-11 **没有真实依赖**，这条线只是排版。**真正该 gate P-11 的是 P-02** —— 新增一条腿正是回归网的用途。建议把 P-02 连到 P-11，P-06 独立收尾 |
| **P-01「怎么做」** | "`admin stats`、面板与评测脚本显式打开" | `include_scores` 是 **recall** 的入参，`admin stats` 不是 recall 调用 ⇒ 改成"**面板的查询页**与评测脚本显式打开" |

---

## 6. 待办：修订版还需要改的行

| 位置 | 现状 | 应改成 |
|---|---|---|
| **P-02「怎么做」/「收益」** | "给评测加 `nDCG@k`、top-3 相关条数两个指标"；"41 条既有精确断言保持不变" | 明确指标落点：**放进 `summary` 之外的兄弟字段**（断言不动），或**同提交重冻 9 键并解释**。理由：`eval_zh.spec.ts:318` 用 `toEqual`，对多余键严格失败 |
| **P-04「收益」** | "降低误用与自我强化回环；纠错有明确通道" | 限定为「对**未自定义** `mem-memory-usage.md` 的用户生效（文件优先于内置 `fallback`，`plugin/src/prompt.ts` 的既有语义）」；并补交付动作：**在 `[0.6.0]` 升级说明里给出需手动补的三段文案原文** |
| **P-07「怎么做」** | "`valid_to` 由 update 修订链与矛盾裁决真阳性给败方写入" + "信封里仅在非空时序列化" | 二选一：① 补一条**留在 active** 的写入路径（建议 **P-13 同时接受可选 `valid_until`**），信封半句才可达；② 或删掉信封半句、收益收敛为"`admin detail` 可审计"。**理由**：两条现有路径都 `archive`，而腿过滤 `status='active'` |
| **P-08「怎么做」** | "反查……走 `admin detail` 的查询" | 改为「**`admin list` 增 `source=` 过滤**」（`detail` 按 `fact_id` 取单条；`ADMIN_ACTIONS` 见 `contract/src/tools.ts:185`），与 `recall source=` 同语义 |
| **§6 依赖图** | `P-06 → P-11` | 改为 `P-02 → P-11`（新腿需要回归网），P-06 独立 |
| **P-01「怎么做」** | "`admin stats`、面板与评测脚本" | "面板的**查询页**与评测脚本" |

---

## 7. 一句话

修订版已经把前两轮 20 处**全部闭环**（P-12 删除、P-09 删除、P-05b 不再重扫、P-11 不再回退、
P-08 改 `EXISTS`、P-06 去掉 git 探测、P-01 补 kb 对照、wire 判据与实跑纪律进门禁），
批次划分与"一次 v10 + 一次 `2→3`"经逐项核对**成立**。剩下的 **4 处都是方案文字层面的决策**、
不需要任何新测量：**P-02 的指标落点会弄红 `toEqual` 断言**、**P-04 对自定义提示词的用户不生效**
（本机就是这种情况）、**P-07 的信封字段因两条写入路径都归档而不可达**、**P-08 的反查应走 `list` 而非 `detail`**。
定完这 4 句，方案即可开工。
