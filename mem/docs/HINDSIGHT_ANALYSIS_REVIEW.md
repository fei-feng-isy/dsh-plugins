# Hindsight 对照分析的复核与修正（2026-10-05）

> **对象**：`mem/docs/HINDSIGHT_COMPARISON.md`（下称「对照」），以及同日落地的两份影响分析
> `IMPROVEMENT_IMPACT_ANALYSIS.md`（改动面与固定税）、`IMPROVEMENT_FUNCTIONAL_PERFORMANCE_IMPACT.md`
> （功能后果与性能账单）。
> **本文做什么**：**不重复**那三份的结论，只做三件事 —— ① 逐条核对「对照」引用的 hindsight 源码
> （它自己的口径纪律是"区分代码实测与文档声称"，本文用同一把尺子量它）；② 提出**三处会改变工作项定义**
> 的实质修正（A11 / A1 / A6）；③ 给一条「对照」与两份影响分析都没提的战略判断，并据此调整批次顺序。
> **基线**：mem **0.5.0**（HEAD `0450c3e`，重排能力已整体移除）。hindsight 快照见「对照」抬头。
> **方法**：只读代码；本文只写文档，不改代码。**所有行号均为本次实测**（2026-10-05 23:20–23:40），
> 与「对照」不一致处以本文为准并标注。

---

## 0. 结论速览

1. **「对照」没有编造任何一条引用**——方向性结论全部站得住。但有 **5 处需要就地修正**，其中
   **2 处会误导实现**（A1 要抄的模式表在另一个文件、A11 的护栏指着注释而不是执行代码），
   **1 处错在"别信他们文档"那一节**（§2.11(d) 说 `ts_rank_cd` 是 TF-IDF；hindsight 自己的代码写明它
   **没有 IDF**）。见 §1。
2. **A11 的前提与「对照」自己的 §2.8 矛盾**：mem 的自动提示**不注入任何记忆正文**（实测是一行固定文案 +
   布尔触发），所以 hindsight 那个"剥标签护栏"在 mem 里**没有对应物可建**；mem 真实的回环是
   **recall 工具输出被 `mem_remember` 记回去**，而今天只有 `content UNIQUE` 挡得住**逐字**重复。
   ⇒ A11 拆三块：框架文案留、纠错回路留、剥标签护栏**删**，换成 recall 输出的来源口径。见 §2。
3. **A1 被降级降错了**：「对照」把它排在 E0/信封/时间之后，理由是"单 agent 威胁模型更窄"。但它自己
   §2.8 的论据在本机**已核实为活的**——`~/.avantf/memory` 是带 gitee 远端的 git 仓库，跟踪
   `memory.db`/`-wal`/`-shm`。A1 是全表最便宜的一项（纯函数、S、不动排序、**不移动 41 条冻结数字**），
   用"质量收益"压"不可逆泄密面"是把两件事放上了同一把尺子。见 §3。
4. **顺带发现一个两份影响分析都漏了、且现在就在生效的隐患**：把 `-wal`/`-shm` 和 `memory.db` 一起提交，
   与密钥无关，是**数据完整性**问题（restore 可能把 db 快照配上不匹配的 WAL）。修法在**用户侧**
   （`.gitignore` + 提交前 checkpoint），mem 侧最多在健康面板加一条警告。见 §3.2。
5. **A6 必须做成按调用可选**（`include_scores` 默认关）。两份影响分析都算出"每 hit +30–60 token、
   limit=10 每轮 +0.3–0.6k"，然后当既定成本接受了；而 hindsight 自己把 `include_based_on`/`include_trace`
   **默认关**，mem 的既有纪律也是"没内容就不花一个 token"。这条会改变 A6 在契约上的**形状**
   （多一个入参，不只是多几个出参），趁没动手先定。见 §4。
6. **战略判断（三份文档都没转成决策）**：hindsight 的 DSH 支持已发布，A 系列大部分是**补齐平价**
   （A2/A3/A6/A10 对手都有），而 mem 真正领先、且对手**最难追**的两处（遗忘/生命周期、版本化派生溯源）
   **没有任何改进项在投资**。见 §5。

---

## 1. 证据核对

### 1.1 需要就地修正的 5 处

| # | 「对照」写的 | 实测 | 影响 |
|---|---|---|---|
| V1 | §1/§2.8/A1：**45 条**正则；引用 `extensions/memory_defense.py` + `extensions/builtin/memory_defense_regex.py` | **44 条**，全在 `hindsight-api-slim/hindsight_api/extensions/memory_defense.py:167-238`（`_REDACTION_PATTERNS` 声明在 `:167`，编译在 `:239`；`REDACT`/`BLOCK` `:26-27`；`enabled: bool = False` `:50`；按 bank 解析 `:109,:128`）。`builtin/memory_defense_regex.py` 只有 **57 行**，是扩展装配 | **会误导实现**：A1 要抄的是那份模式表，照引用去 `builtin/` 会抄到空壳 |
| V2 | §2.8：「自认"不回溯"」 | 代码里**没有**这句话；只在 `hindsight-docs/docs/developer/memory-defense/index.md:15,41`（"Existing memories are not retroactively scanned"） | 这是**策略选择**，不是实现约束。mem 若要做回溯扫描没有技术障碍——真障碍是 git 历史清不掉（§3.1） |
| V3 | §2.11(d)：native 关键词后端是 `ts_rank_cd`（**TF-IDF**） | hindsight 自己的代码：`engine/search/bm25_term_selection.py:5`「`ts_rank_cd` — which **has no IDF** and is not index-backed」，另见 `:146`「Native tsvector has no IDF and ranks every `@@` match」。真 BM25 是独立的 ParadeDB `pg_search` 臂（`engine/sql/postgresql.py:400-409`） | 错在"文档说了实现没有"那一节，性质上最该改。**且改对之后论据更强**：见 §1.3 |
| V4 | §2.9/A11：反馈环护栏在 `inject.ts:80-84` | 那 6 行是"CALIBRATED framing"的**注释**（`:75-77` 只是说明 `<hindsight_memory>` 是 LOAD-BEARING）。**执行代码在另一个文件**：`hindsight-integrations/coding-agents/src/core/transcript-util.ts:20-25`（`MEMORY_TAG_RE`，10 个标签含 `hindsight_memory`；`stripInjectedMemory()`） | **会误导实现**：指着注释会让人以为"写段文案就有了护栏"。见 §2 |
| V5 | 行号漂移：§2.6 引 `recall_boost.py:38-41`；§2.7 引 `response_models.py:275-295`；§2.2 的"最坏 −23%/+27%" | `#3956` 在 `:33`，「1/61 → 1/360，a factor of 5.9」在 `:35-37`，`lexicographic` 在 `:38`，「measured: recall@20 0.97 → 0.40」在 `:41` ⇒ 证据跨 **`:33-41`**。`MinScores` 文档串在 **`:265-292`**。`−23%/+27%` 源码里**没有**（零 grep 命中），但可由 α=0.2/0.2/0.1 推出：`0.9·0.9·0.95=0.7695`、`1.1·1.1·1.05=1.2705` | 只是精度，不影响结论。建议标注「推导值，非源码原文」 |

**另一处文档体例问题**：「对照」第 5-6 行的路径约定写「引用路径中 `engine/` 等指
`hindsight-api-slim/hindsight_api/`」。`engine/` 其实是 `hindsight_api/` 下的**真实子目录**
（实测 `hindsight-api-slim/hindsight_api/engine/search/recall_boost.py` 存在）。按字面读会把 8 条 Python
引用全解析成 file-not-found —— 本次核查的第一遍就是这么踩的。建议改成
「`engine/...` **相对** `hindsight-api-slim/hindsight_api/`」。

### 1.2 已核实为**准确**的引用（可以安全依赖）

| 「对照」的断言 | 实测位置 |
|---|---|
| 逐臂分数信封，未召回为 `null` | `engine/response_models.py:241-262`（`final` `:251`、`reranker` `:252`、`semantic` `:256`、`keyword` `:259`，行号与「对照」**完全一致**）；`MemoryFact` `:353`、`source_fact_ids` `:418`、`scores` `:422`、`RecallResult` `:463-513` |
| 「门槛不是交集」原文 | `engine/response_models.py:265-292`，含 "an intersection would discard the strong single-arm matches that hybrid retrieval exists to find"；`:285-288` 明确 `reranker`/`final` 才是 per-result 谓词 ⇒ §2.7 对 L2 的反证**成立** |
| RRF 加权退化的修法在 rank 空间 | `engine/search/recall_boost.py`：`BoostWeights(rank_divisor, additive)` `:57-68`、`BOOST_LEVELS` low/medium/high = 2.0/4.0/8.0 `:109-111`、应用于 `boosted_rrf_score()` `:115`、divisor 取值 `:137`；被替换的旧 `high` 是 `w=7` `:39-40` |
| 乘性 boost（α 封顶）与设计理由 | `engine/search/reranking.py`：α=0.2/0.2/0.1 `:35-37`；理由 `:186-191`（"ensures the influence of these secondary signals is always proportional to the base relevance score"）；公式 docstring `:194-198`；实现 `:300-304` |
| 中文时间规则 1845 行 | `engine/chinese_temporal_periods.py` 实测 **1845 行**；繁→简 `str.maketrans` `:15-18`、`_CHINESE_NUMERAL_PREFIX_CHARS` `:19`、`_CHINESE_TEMPORAL_FOLLOWER_CHARS` `:22`、`_CHINESE_TEMPORAL_FOLLOWER_PREFIXES` `:33`。`engine/time_filter.py` 存在，140 行 |
| 实体解析权重与阈值 | `engine/memories/pg/entity_resolver.py`：`name_similarity * 0.5`（SequenceMatcher）`:1311-1312`、共现 `* 0.3` `:1318`、7 天新鲜度 `* 0.2` `:1328-1330`、`threshold = 0.6` `:1341`、`round(best_score,6) >= threshold` `:1343`；批内 trigram 合并 `_find_intrabatch_similar_pairs` `:219-311`、`intrabatch_merge_similarity = 0.5` `:463` |
| 确定性时间边 | `engine/memories/pg/links.py:142` 与 `:547` 均为 `weight = max(0.3, 1.0 - (time_diff_hours / time_window_hours))`；`:461` `time_window_hours = 24`。**7 种 link_type**（`hindsight_api/models.py:308` 的 CHECK）：`temporal, semantic, entity, causes, caused_by, enables, prevents` |
| 零 LLM 的 `chunks` 抽取模式 | `engine/retain/fact_extraction.py`（3627 行）：`_extract_facts_chunks` 在 **`:3295`**（「对照」行号精确命中）、docstring `:3300`「chunks mode: no LLM call, no entity extraction」、分派 `:3394` |
| `text_signals` 真实存在 | 定义 `engine/memories/base.py:597`（`build_text_signals()`；常量 `META_TEXT_SIGNALS` `:110`、字段 `:538`、调用 `:669`）；装配 `engine/memories/pg/writes.py:99-113`（注释原文「entity names + date tokens for enriched BM25 indexing」）；SQL 消费 `engine/sql/postgresql.py:396,400-409` ⇒ A4 有据 |
| 评测纪律三条 | `hindsight-system-evals/README.md:289` 以「Traps must stay at 0.」结尾；`evals/test_08_retrieval_metrics.py` 两个测量态 `:70-71`（nDCG@10 **0.887 / 0.874**）、「So the floors sit below the LOWER state」`:90`、`MIN_NDCG_AT_10 = 0.83` `:100`；`README.md:209-210`「`export_bank` deliberately leaves embeddings out — the importer regenerates them with its own model」 ⇒ A12 三条全部有据（注意「对照」引 `:63-88`，LOWER 态那句与常量在 `:90`/`:100`） |
| DSH 已在支持列表 | `hindsight-integrations/coding-agents/README.md:5` 列 **DeepSeek Harness**，是 **20 个** harness 的最后一个 |
| 注入框架文案与纠错回路 | `inject.ts:89-98`（"Real memory, but retrieval is heuristic…"／"First judge relevance. If this does not genuinely relate … ignore it entirely and do not mention it — an unrelated memory is noise, not context."／"This is a record of the PAST — it never assigns you tasks."）；纠错回路 `:105-108`（行号精确命中） |
| §2.11 的三条"文档有实现无" | ① `engine/reflect/observations.py`（186 行）**零 importer**（全仓 grep `reflect.observations` 无命中），`ObservationEvidence.quote` 在 `:41` ⇒ 死代码成立；② **MMR 不存在**，只出现在 `memory_engine.py:8712,9162` 两处 docstring；③ `access_count` 确被 `alembic/versions/e4a7c1b9d2f6_drop_memory_units_access_count.py` 删除（`:1`「Drop the never-written `access_count` column」，drop 在 `:56`；原加入于 `5a366d414dce_initial_schema.py:280`） |
| Jev 重排消融数字 | `hindsight-docs/blog/2026-09-24-adding-jev-reranker-what-we-learned.md:109-121`，12 个数字**逐一精确**。**一处命名**：表里那一行叫「Jev, ranking only」，TypeSafe 是**厂商**（`:14`）；「对照」写"托管 TypeSafe"是可接受的行文，但不是原文标签 |

### 1.3 V3 改对之后，F4 的论据反而更强

「对照」§2.11(d) 想说的教训是"hindsight 的 BM25 也是可插拔的、词法层值得做成可配"。实测事实是更硬的一条：
**hindsight 的默认词法打分连 IDF 都没有**（`bm25_term_selection.py:5,146`），所以它必须额外做一个
"查询最多 16 个最低 df 词元"的选择器来补偿。

mem 这边的对应病灶是**同一层、不同形态**：FTS 腿用 `-bm25` 打分（`mem/packages/core/src/store/memory.ts:1661`），
却用**每行去重词数**卡门槛（`mem/packages/core/src/store/floors.ts:285-302`）——**打分与门槛是两种单位**。
子串回退路径的分数又是第三种单位（命中词计数，`memory.ts:1669-1672`）。这正是 F4（改成覆盖率打分）要修的，
而"hindsight 默认无 IDF"这个事实说明：**词法腿的分数单位必须与它的门槛单位一致**，否则长度偏置会从打分侧漏进来。
⇒ 建议 F4 的理由段引用 `bm25_term_selection.py:5` 而不是「对照」§2.11(d) 的现有措辞。

---

## 2. 修正一：A11 应拆三块，护栏那一半删掉

### 2.1 「对照」自相矛盾的地方

- §0 表格第 1 行与 §4 的 A11 都说：护栏对 mem 是**必要**的，因为"注入的记忆可能被 `mem_remember` 二次记住"。
- 但 §2.8（第 203-206 行）自己写对了：**mem 的自动提示不是内容注入**，`rt.relevance(text)` 只算一个布尔。

实测站在 §2.8 那边：

| 事实 | 位置 |
|---|---|
| 注入的全部内容就是**一行固定文案** | `mem/packages/plugin/src/hints.ts:26-27`：`'[avantf-mem] 记忆或知识库里有与上条用户消息相关的内容；需要时用 `kb_query` 检索。'` |
| 触发是**布尔**，不带分数、不带正文 | `mem/packages/core/src/store/lexical.ts:57`（`RelevanceHit` = boolean）、`:138-140`（`matched >= 2` 个词元）；词元 = latin/digit ≥5 字符 + 每个 CJK 3-gram，上限 24（`:60,63,74-84`） |
| 挂载点与条件 | `mem/packages/plugin/src/index.ts:749-781`：只在 `agent/inbox/inserted` 且 `source.kind === 'user'`（`:760`）时算，由 context provider `avantf:mem-hint`（order 130）渲染（`:770-780`） |
| 空串 = 零 token | `hints.ts:32-33`：`renderContextSections` 丢弃空文本 |

⇒ **mem 的上下文里根本没有记忆正文可剥**，`stripInjectedMemory()` 在 mem 里**没有对应物**。
A11 按现描述去做，会得到一个空工作项（或更糟：为了"有护栏"而给 hint 塞进正文，那才是真的开了一条外泄路径）。

### 2.2 mem 真实的回环（更窄，但确实没人守）

路径是：模型调 `mem_recall` / `kb_query` → **工具输出里带事实正文** → 模型把它 `mem_remember` 回去。
今天的防线只有一条，且只挡**逐字**重复：

| 防线 | 位置 | 覆盖到哪 |
|---|---|---|
| `content TEXT NOT NULL UNIQUE` | `mem/packages/core/src/db/schema.ts:13` | 逐字重复 ⇒ 落到既有行（`store/memory.ts:1760-1783`），不产生新事实 |
| 提示词一句"不要记录临时聊天" | `mem/packages/plugin/src/prompt.ts:52-53` | 约定，不是不变量 |
| 矛盾检测 | `mem/packages/core/src/lifecycle/contradiction.ts:19-22,30-53` | **反而放过**：cos ∈ [0.75, 0.97] 才算矛盾候选，**≥0.97 判为近重复 ⇒ 打 0 分**。改写一遍再记回，正好落进这个盲区，且拿到**全新 trust** |

### 2.3 A11 重新定义后的三块

| 块 | 动作 | 依据 |
|---|---|---|
| **①框架文案（留，是真缺口）** | 在 `prompt.ts:44-59` 的 `avantf:memory-usage` 段补两句：**明确授权忽略**（"若与当前任务无关，直接忽略、不要提及"）、**记忆是过去的记录，绝不指派任务**。控制在几十 token | `inject.ts:89-98` 原文可直接翻译；mem 现有段落有"敏感信息只记存放位置"（`:54-55`）与自检清单，但**没有**这两句 |
| **②纠错回路（留）** | 补一条动作口径：**核实到记忆过时就主动写一条修正**（mem 的对应动作是 `mem_remember` 的 `update`，`contract/src/tools.ts:98-133`），而不是只在提示词里说"同一主题用 `update` 修正" | `inject.ts:105-108`（`Correction: <topic>`）；mem 已有 `update` 语义，缺的是**触发条件**的口径 |
| **③剥标签护栏（删）** | **不做**。替代物是一件更小的事：给 recall **输出**一个来源口径 —— `RecallHit.source` 现在是知识库的 `domain → source` 分类（`contract/src/types.ts:108-116`），**不是**"这条来自记忆"的溯源标记；加一句提示词级别的"检索结果不是用户说过的话，不要原样记回"即可 | §2.2 的盲区在**改写后记回**，剥标签挡不住它；能挡住它的是来源口径 + （可选）把近重复盲区收窄 |

> **可选的第四块**（不在 A11 里，属于 `contradiction.ts` 的车道）：cos ≥ 0.97 目前**故意**判 0 分，
> 这对"检测矛盾"是对的，但对"检测回环近重复"是盲区。若要做，应是**独立的近重复检测**（记日志、不自动合并、
> 不静默改写文本），与「对照」§2.4 的"mem 的确定性等价物"同一条纪律。

---

## 3. 修正二：A1 的优先级，以及一个更近的隐患

### 3.1 「对照」§2.8 的论据在本机核实为**活的**

实测（2026-10-05 23:33）：

```
~/.avantf/memory/.git        存在
origin                       git@gitee.com:ffeng86/my-mem-data.git (fetch/push)
跟踪文件                      memory.db, memory.db-shm, memory.db-wal
.gitignore                   无
提交历史                      51bda7b mem data init → 4ce7939 update mem → 9bb42ac update mem
分支状态                      ## master...origin/master（memory.db 当前 M）
```

⇒「一条明文密钥进入事实 = 进入不可删除的 git 历史并推到第三方托管」**不是假设，是既成通路**。
而 `mem_remember` 的 `add` 只接 `content` / `category` / `ttl_days`（`contract/src/tools.ts:103-108`），
`content` **无长度上限**（只有查询侧有 `MAX_QUERY_CHARS = 2000`，`:45`），写入路径上
**没有任何内容检查**——`store/ingest_guard.ts` 只是 `kb_add` 的 SSRF / 路径越界边界
（http `:81-134`、本地根 `:137-171`；DNS rebinding 明确列为 out of scope `:19-23`），**从不看事实正文**。

**成本对照**：A1 是全表最便宜的一项 —— 纯函数、S 规模、与排序**零耦合**、**不移动 41 条冻结数字**
（两份影响分析在这一点上一致）。把"提升检索质量"排在它前面，是拿**可逆的质量收益**压**不可逆的泄密面**。

⇒ **建议 A1 从批次 7 提到批次 0/1。** 「对照」§2.8 结尾那句"优先级不第一"应改为
"**在带远端备份的数据根上，它是性价比最高的一项**"（并保留"更根本的防线在上游工具输出 redaction、
属于 DSH/harness 层"这个正确的边界）。

### 3.2 顺带发现：跟踪 `-wal`/`-shm` 本身就是隐患（与密钥无关）

WAL 与 SHM 是**瞬态**文件：`-wal` 是尚未 checkpoint 回主库的事务日志，`-shm` 是共享内存索引
（本就不该落盘）。把它们和 `memory.db` 一起提交，意味着任意一次 restore 都可能把**某个时刻的 db 快照**
配上**另一个时刻的 WAL** —— 结果要么回退到更早状态，要么恢复失败/损坏。

- **修法在用户侧**：`~/.avantf/memory/.gitignore` 排除 `memory.db-wal` / `memory.db-shm`；
  提交前跑 `PRAGMA wal_checkpoint(TRUNCATE);` 让 `-wal` 清空并把事务并回主库。
- **mem 侧可做的（可选、S）**：健康面板 / `mem_doctor` 类入口检测到"数据根是 git 仓库且跟踪了 `-wal`/`-shm`"
  时给一条 WARNING。这属于"环境故障降级、绝不杀宿主"的家族口径，只是一条日志。
- **不要做的**：不要由 mem 自动改写用户的 `.gitignore` 或自动 checkpoint —— 那是用户的数据根与备份流程。

> 这条比 A1 的 44 条正则**更该先做**，因为它现在就在生效，且修法是两行配置。

---

## 4. 修正三：A6 要按调用可选（`include_scores` 默认关）

A6（信封暴露逐臂分 + 融合后分）是批次 1 的前置，这点三份文档一致，本文同意：没有逐臂 provenance，
A5 的 boost、A7 的弃答、A2/A10 的新腿全都只能"看结果猜原因"，L2 的重写也没有落点。
而 mem 今天的信封确实**只有一个融合分**：`RecallHit` 的字段是
`kind / ref_id / text / score / domain / source / source_ref / entities / created_at / updated_at / truncated?`
（`contract/src/types.ts:102-139`），**没有**任何"这条靠哪条腿进来"的记录；`RecallResult` 里的
`dropped_by_floor{semantic,fts,jaccard,hrr}` 是**聚合计数**，不是 per-candidate 溯源（`:195-214`）。

但 FUNCTIONAL 那份算出 **每 hit +30–60 token、limit=10 时每轮 +0.3–0.6k**，然后当**既定成本**接受了。
两处依据说明它不该是既定成本：

1. **hindsight 自己默认关**：`include_based_on` / `include_trace` 默认 false（「对照」§2.9 已记录，但没用到 A6 上）。
2. **mem 的既有纪律就是"没内容不花 token"**：`hints.ts:32-33`（空串被 `renderContextSections` 丢弃）。

⇒ **A6 的契约面应该是**：`recall` 增 `include_scores`（**默认 false**）。

| 消费方 | 是否打开 | 理由 |
|---|---|---|
| 模型日常调用 | **否** | 不给每次工具调用加 ~5% 上下文税 |
| 两个 UI 页签 / 健康面板 | 是 | 面板本来就展示 `weights`/`floors`，逐臂分是同一类诊断信息 |
| bench / E0 验收 / 事故复现脚本 | 是 | 这正是 A6 作为"验收前提"的用途 |
| 真实库回归脚本 | 是 | 「并集不收窄、非自指逐字节不变」的证据需要逐臂分才能出 |

**为什么现在就要定**：这决定 A6 是"只加出参"还是"加一个入参 + 出参"。前者不动工具 schema，
后者要过契约 → MCP inputSchema → CLI → client 四处派生 + 形状断言（`contract.spec.ts` / `tool_schema.spec.ts`），
并计入那次 `WIRE_VERSION` bump（当前 = 2，见 `IMPROVEMENT_IMPACT_ANALYSIS.md` §1）。事后改比现在定贵。

---

## 5. 战略判断：平价 vs 护城河（三份文档都没转成决策）

「对照」§2.9 记了一笔"在同一个宿主上，mem 与 hindsight 是并存/竞争关系"，但没有往下推。推一步：

**A 系列的大部分是补齐平价，不是扩大优势。**

| 项 | hindsight 有吗 | mem 做完的性质 |
|---|---|---|
| A2 时间语义 | 有（1845 行中文规则 + 双时间轴 + 确定性时间边） | **平价** |
| A3 实体规范化/共现 | 有（0.5/0.3/0.2 @ 0.6 + trigram 合并 + 共现表） | **平价** |
| A6 逐臂信封 | 有（`RecallScores`） | **平价** |
| A10 图边 | 有（7 种 link_type） | **平价** |
| A5 乘性 boost | 有（α 封顶） | **平价** |
| — | 对手另有：写侧 LLM 抽取、CE 重排、reflect、自维护知识页、无条件召回 | mem **刻意不做**，填不平 |

反过来，「对照」§3 列的 mem 真正领先的两处，恰好是对手**最难追**的：

| mem 的护城河 | hindsight 的现状 | 为什么难追 |
|---|---|---|
| **遗忘 / 生命周期**：逐活跃日 trust 衰减、强化日上限、`idle_calendar_days=365` 闲置清理、pin/permanent、矛盾日志与裁决（`lifecycle/tick.ts` 五步预算事务、`lifecycle/trust.ts`） | **无 TTL / 无遗忘**；"衰减"只是排序里 ±10% recency；`invalidated_memory_units` 只由人工 curation 写入 | 要引入遗忘语义就得动它的多租户存储模型与"记忆是资产"的产品叙事 |
| **版本化派生溯源**：`entities_version`（`db/schema.ts`，迁移 v6）+ 有界重扫 `reindexEntities`（`store/memory.ts:1202-1231`，批 2000，谓词 `status='active' AND entities_version < ?`）+ `ENTITY_EXTRACTOR_VERSION`（`entities/extract.ts:89`） | **行上没有抽取器/提示词/模型版本**，只有 `content_hash` 与可选 `llm_requests` | 它的派生层由 LLM 产出，行级版本化意味着承认"抽取器换代 = 全库重跑 LLM"的成本 |

**而改进清单里没有任何一项在投资这两处**（A13 只是借 hindsight 的生命周期*模式* —— 水位线陈旧、毒行标记、
撤回扫描 —— 方向反而是向对手看齐）。

⇒ **建议先回答一个问题再排期**：这个插件的目标是"和 hindsight 打平"还是"在本地 / 零 LLM / 生命周期这条轴上拉开"？

- 若**打平**：A2 → A3 → A6 的顺序合理，按两份影响分析的批次走。
- 若**拉开**：应给护城河单开一条车道（更细的遗忘策略、把 `entities_version` 的溯源模式推广到
  嵌入空间指纹与派生视图），而且它们的实现成本**低于** A2 —— 对手那 1845 行中文规则 mem 只能自己写
  （零运行期依赖红线 ⇒ 不能用 dateparser，见 `IMPROVEMENT_IMPACT_ANALYSIS.md` §1）。

本文不裁决这个问题（那是产品决策），只指出：**当前清单隐含选了"打平"，而这个选择没有被明确做过。**

---

## 6. 建议顺序（与 `IMPROVEMENT_IMPACT_ANALYSIS.md` §7 的差异用**粗体**标出）

| 批次 | 内容 | 与既有批次表的差异 |
|---|---|---|
| **0** | E0 + A12（评测纪律）、**A6（带 `include_scores` 默认关）**、**A1（写侧密钥守卫）**、**用户侧：`.gitignore` 掉 `-wal`/`-shm` + 提交前 checkpoint** | A1 **从批次 7 提前**（§3.1）；A6 **先定契约形状**（§4）；wal/shm 是**新增项**，两份影响分析都没有（§3.2） |
| **1** | **A11 重新定义后的 ①②（框架文案 + 纠错回路 + recall 输出来源口径）；③剥标签护栏删除** | A11 **从批次 7 提前**（纯文案、与排序零耦合），且**范围收窄**（§2.3） |
| 2 | L2 重写（按可靠性×量级定序）+ F4 | 不变；**F4 的理由段改引 `bm25_term_selection.py:5`**（§1.3） |
| 3 | A5 + A7 + A8 + A16 | 不变 |
| 4 | A2（时间）+ A4（索引文本）+ F1 | 不变；A4 的规模已被更正为 **M**（external-content FTS5 over `content` only，`db/schema.ts:193-214`，需新增真实列或第二张表 + 与实体重扫联动） |
| 5 | A3 + A13 + 升 `ENTITY_EXTRACTOR_VERSION` | 不变；A3 与 A4 **必须同批**（同一条实体管道的两个消费者） |
| 6 | A9 + A10 + B1 + B2/B3（合并成**一次**迁移） | 不变 |
| **—** | **护城河车道（新）**：遗忘策略细化 + 溯源模式推广 | **新增**，是否开由 §5 的产品裁决决定 |
| — | L1/L3 完整实现 | 不变；先做不动 schema 的可逆 spike |

---

## 7. 待办：「对照」需要就地改的 6 行

| 位置 | 改成 |
|---|---|
| §1 表格"安全"行、§2.8 首段 | 45 条 → **44 条**；模式表位置 → `extensions/memory_defense.py:167-238`（`builtin/memory_defense_regex.py` 是 57 行装配） |
| §2.8「自认"不回溯"」 | 标注：这是 **docs 声明**（`memory-defense/index.md:15,41`），代码里没有对应实现 |
| §2.11(d) | `ts_rank_cd`（TF-IDF）→ `ts_rank_cd`（**cover-density，无 IDF**，`bm25_term_selection.py:5,146`）；真 BM25 是 ParadeDB `pg_search` 臂 |
| §2.9 / §4 A11 | 护栏的引用 → `coding-agents/src/core/transcript-util.ts:20-25`（`stripInjectedMemory()`）；并按 §2.3 重定义 A11 的三块 |
| §2.2 / §2.6 / §2.7 行号 | `recall_boost.py:33-41`；`response_models.py:265-292`；`−23%/+27%` 标注为**推导值** |
| 抬头第 5-6 行 | 路径约定改为「`engine/...` **相对** `hindsight-api-slim/hindsight_api/`」 |

---

## 8. 一句话结论

「对照」的证据链**可信到可以照着排期**（无一条编造，方向性结论全部复核通过），但有 **5 处引用缺陷**要先改掉；
在此基础上，本文改了三处工作项的定义 —— **A11 删掉一半、A1 提到最前、A6 做成默认关的可选出参** ——
并新增一项两份影响分析都漏掉的**用户侧数据完整性隐患**（跟踪 `-wal`/`-shm`）；
最后指出一个未被明确做过的产品选择：**当前清单隐含选了"与 hindsight 打平"，而 mem 真正的护城河没有车道。**
