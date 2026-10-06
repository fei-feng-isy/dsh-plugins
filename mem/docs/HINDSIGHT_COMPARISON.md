# Hindsight 对照分析：优势与可借鉴机制（2026-10-05）

> **对象**：`/home/ffeng/sources/hindsight`（Vectorize，MIT；快照 `5b8356bb2`）。
> **对照**：本仓 `@avantf/dsh-mem`（本地优先、单文件 SQLite、引擎零 LLM 的 DSH 记忆/知识插件）。
> **方法**：只读通读源码 / 文档 / Alembic 迁移（本仓只写这一份文档）。引用路径中 `engine/...`、`extensions/...` 等
> **相对** `hindsight-api-slim/hindsight_api/`（`engine/` 是它下面的真实子目录）；`docs/` 指 `hindsight-docs/docs/developer/`。
> **口径纪律**：标注「代码实测」与「文档声称」；**§2.11 列出文档说了但实现没有的东西**（照抄 README 会踩坑）。

---

## 0. 结论速览

两者**不是同一类系统**。hindsight 是「云/自托管的记忆服务」：**写侧用 LLM 抽事实**，读侧四臂并行 + 交叉编码
重排，多租户、Postgres、39 个 MCP 工具；mem 是「本地单用户插件」：写读都零 LLM，靠确定性抽取与
**更严的绝对门槛**，单文件 SQLite，数据不出 `~/.avantf`，8 个模型工具。

一句话分工：**hindsight 的优势在"写侧建结构 + 读侧多策略编排 + 把记忆投成可读的知识"；mem 的优势在
"零 LLM / 离线 / 确定性评测 / 生命周期"**。hindsight 的实现里有一大批**与 LLM 无关**的机制（时间、图、
信封、注入框架、扫描、生命周期模式），可以直接搬；真正搬不动的是它的**文本合成**能力。

**最值得借鉴的 6 条**（除标注外都不需要给 mem 引入 LLM；**不含**上表之外的那条"写侧扫描"——见 §2.8，它被单独降级并重新定义范围）：

| # | 机制 | hindsight 证据 | mem 的落地形态 |
|---|---|---|---|
| 1 | **注入框架文案 + 纠错回路**（护栏在 mem **无对应物**） | `inject.ts:89-98`（诚实来源 / 授权忽略 / "过去不是命令"）、`:105-108`（纠错回路）；护栏的执行代码在 `transcript-util.ts:20-25`，但 mem 的 hint 不注入正文，故不需要它 | 提示词段补两句（授权忽略 + 记忆不指派任务）+ 一条"核实过时就走 `update`"的口径；**另加 recall 输出的来源口径**，防的是"召回内容被记回去"这条更窄的回环 |
| 2 | **时间语义**（双时间轴 + 中文时间窗规则 + 确定性时间边） | `engine/chinese_temporal_periods.py`（1845 行）、`engine/time_filter.py`、`engine/memories/pg/links.py:142,461,547` | 新增 `occurred_start/end` + 中文时间窗解析 + temporal 腿/boost；纯规则 |
| 3 | **结果信封暴露逐臂分数与证据链** | `engine/response_models.py:241-262,353-513` | 正是前次审查 §2.3 要的 per-candidate 腿来源；也是 boost/门槛的验收前提 |
| 4 | **融合/门槛的工程结论**（RRF×硬截断退化；检索级门槛不是交集） | `engine/search/recall_boost.py:33-41`（#3956 实测 recall@20 0.97→0.40）、`response_models.py:265-292` | 裁决 mem 方案 L2「≥2 条腿」；给出 rank 空间 boost 的安全做法 |
| 5 | **实体规范化与确定性图**（trigram 合并 + 共现 + 类型化边） | `engine/memories/pg/entity_resolver.py:1309-1344`、`engine/memories/pg/links.py` | mem 有 `entities(name,aliases)`+`fact_entities`，缺 alias 合并、共现、fact↔fact 边 |
| 6 | **评测纪律**（correct+trap 判分、下限取"两个测量态较低者"、冻结语料不带嵌入） | `system-evals/README.md:289`、`test_08_retrieval_metrics.py:63-88` | 直接并入在办的 E0 |

**最不该照搬的**：把 LLM 放进 mem 的引擎（那是 mem 的立身之本）、39 工具的工具面、多租户/bank 抽象、
**没有融合后弃答默认值的 top-k**。**最该警惕的是照抄文档**：§2.11 列了 5 处 README/docs 与实现不符。

---

## 1. 系统画像

| 维度 | Hindsight | dsh-mem |
|---|---|---|
| 形态 | FastAPI 服务 + Postgres/pgvector（Oracle 23ai 同源） | DSH 插件，单文件 SQLite |
| 租户模型 | Postgres **schema/租户** + 每表 `bank_id` 列（无 RLS）；每 bank 独立 MCP 端点 | 单用户；记忆库 + 知识库两个 store |
| 写入 | **LLM 抽事实/实体/关系/时间**，500 ms–2 s/批（`docs/performance.md:32`）；**另有零 LLM 的 `chunks` 模式**（`engine/retain/fact_extraction.py:3295`） | 零 LLM：jieba 实体 + 启发式三元组 + 嵌入 |
| 读取 | 4 臂并行 + RRF + 交叉编码重排，100–600 ms；**读路径 0 次生成式 LLM 调用**（只有 1 次查询嵌入） | 语义 + FTS trigram + 锚点实体 + HRR；按腿最大值归一加权和 + **每腿绝对门槛** |
| 门槛 | 每臂默认绝对门槛：语义 **0.3**、关键词 **0.0**、图种子 ≥0.3、时间臂 ANN ≥0.1；**融合后弃答门槛可选、默认无** | 每腿绝对门槛默认开且逐腿标定（语义 0.5 / Jaccard 0.2 / FTS 词数）+ 自动放宽档 |
| 时间模型 | `occurred_start/end`（事件时间）+ `mentioned_at`/`created_at`（得知时间）；**无有效期区间、无 TTL/遗忘** | `created_at`/`updated_at` + 生命周期活跃日钟 `settle_clock`；**有**逐日信任衰减/闲置清理 |
| 结构 | `world`/`experience`/`observation` 三类 + canonical entities + 共现 + 7 种 typed links | `facts(category)` + `doc_chunks`；`entities`/`fact_entities`/`triples`（启发式） |
| 派生层 | observations / mental models / knowledge pages（后台 LLM 合成，读时无 LLM） | 无派生层；知识库是**用户文档**（managed .md + 分块索引） |
| 生命周期 | 观察合并（LLM）、近似重复合并（cos≥0.97 + 全文复核）、**无遗忘**（`access_count` 因无人读写被删列） | trust 逐活跃日衰减、强化日上限、闲置 365 天清、pin、矛盾日志与裁决 |
| 写入/读取 LLM | 写侧 1 次/3k 字符；读侧 0；reflect 有 | 全部 0 |
| 注入/浮现 | hook：**每条用户消息无条件 recall**；注入框架 + 纠错回路 + 反馈环护栏 | 8 工具（模型主动调）+ **词法重叠才触发的同步 hint** + 提示词段 |
| 评测 | LongMemEval-s 94.6%、BEAM 10M 64.1%（**正文数字只在博客**；BEIR SciFact 有可复现 harness 与冻结下限，LongMemEval/BEAM 走外部 AMB 夜间作业） | 41 条中文冻结集（**精确断言，PR 门**）+ 真实库回归脚本 |
| 安全 | **44 条** PII/密钥正则（redact/block，`extensions/memory_defense.py:167-238`）+ 审计 + webhook；"不回溯"仅为 docs 声明（代码里没有这条约束）；为"自动捕获 + 多租户"设计 | `ingest_guard.ts`（SSRF/路径越界）；敏感信息仅提示词约定（**范围裁决见 §2.8**） |
| 工程规模 | 39 MCP 工具、104 REST、4 语言 SDK、25+ provider、控制台 | 8 模型工具 + 2 个 UI 页签 |
| **版本化溯源** | **行上没有抽取器/提示词/模型版本**（只有 `content_hash` 与可选 `llm_requests`） | **`entities_version` + 有界重扫**（mem 这一项领先，别丢） |

---

## 2. Hindsight 的结构性优势（带证据）

### 2.1 写侧：LLM 抽取 + 确定性规范化，检索要用的维度在写入时就建好

`retain` 的 13 个阶段（`engine/retain/orchestrator.py:1351` 起）：分组/文档 → （可选）敏感信息扫描 →
append/delta 门（按 chunk `content_hash` 跳过未变块）→ 按 ~3000 字符分块 → **生产者/消费者流式**（LLM 抽取
并发 32，DB 消费者小批提交）→ 抽取 LLM（唯一 LLM）→ 嵌入（事实文本拼上可读日期与实体名）→ 退化事实过滤 →
Phase 1（实体解析 + ANN，事务外）→ **Phase 2（单事务：`memory_units` + `unit_entities` + temporal/semantic/causal 边）** →
提交后全局 ANN（`top_k=20`，阈 0.7）→ 观察异步合并。

抽取产出的每条事实带 `what/when/where/who/why`、`fact_type ∈ {world, assistant}`、`occurred_start/end`、
`entities[]`、`causal_relations[{target_index, caused_by}]`（`engine/retain/fact_extraction.py:161,243,261`）。

**对比 mem**：`facts` 只有 content/category/tags(死列)/trust/时间戳/向量；`entities(name UNIQUE, aliases='', entity_type='unknown')`
无 mention_count/无别名词典；`triples` 谓词被本仓实测为噪声（`没有:12 / 发布:9 / 默认:8…`，`mem/docs/SELF_QUERY_RELEVANCE.md` §3.3）。

**廉价、可立刻借鉴的两处**：
- `text_signals`：把实体名与日期 token **追加进被 FTS 索引的文本**（`engine/retain/fact_extraction.py` / `orchestrator`），
  关键词腿立刻受益，零新表；
- **批内实体按 trigram Jaccard（默认 0.5）合并**（`engine/memories/pg/entity_resolver.py:219-311`）——纯 CPU，
  mem 已有 trigram/FTS 基建。

### 2.2 读侧：四臂并行 + RRF + 交叉编码重排 + 分级预算（读路径零生成式 LLM）

| 臂 | 触发 | 候选/分数 | 默认绝对门槛 |
|---|---|---|---|
| semantic | 常开 | 每 fact_type `UNION ALL`，`1-(embedding<=>$1)`，HNSW | 余弦 **0.3**（`config.py:1309`） |
| keyword | `enable_text_search` 且查询有词元 | native 是 `ts_rank_cd`（**cover-density，无 IDF**；hindsight 自己的代码写明 `bm25_term_selection.py:5,146`，真 BM25 是独立的 ParadeDB `pg_search` 臂） | **0.0**（`config.py:1316`）；查询最多 16 个最低 df 词元 |
| graph | `enable_graph_retrieval` 且种子存在 | 种子 = 语义 top-20 ≥0.3；3 条 CTE：实体/共现（每实体 LATERAL 上限 200）+ 语义 kNN + 因果 | 种子 ≥0.3 |
| temporal | `enable_temporal_retrieval` 且有时间窗 | 窗口重叠 + ANN ≥0.1；池 60/type → 10 个覆盖入口 → 沿 temporal/causal 边扩散（衰减 0.7、因果 ×2.0/1.5、≤5 跳） | ANN ≥0.1 |

- **RRF，k=60**：`Σ 1/(60+rank)`，四臂等权，只用名次（`engine/search/fusion.py:29-109`）；另有 `interleave_fusion`
  （轮转，保证每臂头部一席）用于合并去重（`fusion.py:112-176`）。
- **重排**：默认本地 `cross-encoder/ms-marco-MiniLM-L-6-v2`，批 32，**候选上限 300**，超时 300 s；原始 logit 走
  sigmoid、已校准的 [0,1] 原样透传；超时保留已打分前缀、尾部回 RRF 序（`engine/search/reranking.py`）。
- **乘性 boost（α 封顶）**：`final = CE × (1+0.2(recency−0.5)) × (1+0.2(temporal−0.5)) × (1+0.1(proof−0.5))`，
  合计最坏 −23%/+27%（`reranking.py:174-304`）。设计理由写明：乘性使次级信号**永不能压过主相关性**。
- **预算分级** `low/mid/high = 100/300/1000` 或按 `max_tokens` 的 2.5%/7.5%/25%（夹 20–2000）贯穿每臂 LIMIT、
  图遍历与重排候选（`engine/memory_engine.py:1600-1648`）。
- **cap-then-hydrate**：臂只带回 id+分数，正文在 300 截断**之后**才取（`memory_engine.py:9794-9812`）。
- **信封**：每个结果带 `scores{final, reranker, semantic, keyword}`（该臂没召回则为 `null`）+ `source_fact_ids`，
  顶层还有 `entities` / `chunks` / `source_facts` / `source_facts_truncated` / `trace`（`engine/response_models.py:241-262,353-513`）。

### 2.3 时间：当成一等检索维度，而且规则化

- **双时间轴**：事件时间（`occurred_start/end`）vs 得知时间（`mentioned_at`/`created_at`）——存储层是
  bi-temporal，但**没有有效期区间**、没有 supersede 时间线（`docs/retain.md:140-163`）。
- 查询侧**不用 LLM**：`DateparserQueryAnalyzer` 用 dateparser + 自研规则，并**按"实际携带的日期信号"给每个匹配
  打分**，拒绝 "we/me/did" 这类误判（`engine/query_analyzer.py:385-470`）；解析放在单工作线程上，实测事件循环
  停顿 1318 ms → 2.8 ms（`engine/temporal_extraction.py:18-37`）。
- **中文专用规则 1845 行**（`engine/chinese_temporal_periods.py`）：繁→简归一、中文数词前缀、后随字符边界表，
  因为 dateparser 对中文常返回 None 或整段子串误判。
- **时间边是确定性的**：24 小时硬窗内建边，权重 `max(0.3, 1 − gap/window)`（`engine/memories/pg/links.py:142,461,547`）。
- 窗口内选择**相关性优先**，再**按桶分散**取每桶最强（避免最密段吃满结果），窗口中心给邻近 boost。
- **明确不是过滤器**：`TemporalWindow` 只影响 temporal 臂，"窗口外的事实仍由其它臂返回"（`response_models.py:318-330`）。

**对比 mem**：查询侧**完全没有时间语义**（`created_at` 在信封里但不参与排序）。中文时间规则是最可直接翻译的资产。

### 2.4 信念演化：observations —— **实现比文档弱**，但生命周期模式可搬

- 观察**就是** `memory_units` 里 `fact_type='observation'` 的行，**没有独立表、没有置信度列**
  （`confidence_score` 随 `opinion` 类型一起被删）；`proof_count = len(distinct source_memory_ids)` 是**计数不是分数**。
- **文档说的"证据引文"在活模型里不存在**：`engine/reflect/observations.py:37-56` 的 `ObservationEvidence{quote}`
  与 `compute_trend` **没有任何模块 import**（死代码，`docs/observations.mdx` 的措辞超前于实现）。
- **没有数值化信念更新**（无贝叶斯/log-odds）：演化是 LLM 返回 `{creates,updates,deletes}` JSON；UPDATE 是
  **原地改文本 + 并集 sources + 放宽时间 + 把旧文本快照进 `observation_history`**（上限 50 条）
  （`engine/consolidation/{prompts.py,consolidator.py:2806-2858}`）。"refine 而非覆盖"= 保留行 + 改文本 + 追加证据。
- 调度：写后自动（`enable_auto_consolidation` 默认开）+ 周期补扫 + 队列 worker；**候选选择是一次标志位扫描**
  （`consolidated_at IS NULL AND consolidation_failed_at IS NULL … LIMIT n`），既有观察由**每条事实的嵌入召回**取并集得来；
  有界（50 取、100 轮、每次 8 条/LLM、4 组并行）（`engine/memories/pg/reads.py:383-407`、`consolidator.py:2320-2374`）。
- **失败语义值得抄**：不可处理的行打 `consolidation_failed_at` **永久排除**（"不能无限重试"）；瞬时失败退避重试、
  但**同 bank 已有待处理任务时跳过**；一次 LLM 响应产生的所有写**在一个事务里，且事务内不含 LLM/嵌入调用**。
- **近重复合并**：cos ≥0.97 后逐对 LLM 判定 merge/keep（"差一个数字/否定/实体就分开"）。

**mem 的确定性等价物**：同一行形状（`kind='belief'`）+ 证据 id 列表 + proof_count 是**计数**；合并规则可用
"共享锚点实体 × 语义相似 ≥ 阈值"（mem 的 `lifecycle/contradiction.ts:25` 已有这个组合），**不静默重写文本**。

### 2.5 派生视图：mental models / knowledge pages

- **mental model** = 常驻问题（`source_query`）+ 答案（`content`/`structured_content`）+ `reflect_response` +
  水位线 `last_memory_seen_at` + 触发方式（`engine/memory_engine.py:16578-16580`）；
- **知识页 = mental model + 一个 `knowledge_pages` 树节点**（`parent_id` 自引用级联，`kind ∈ {folder,page}`，
  同层名不区分大小写唯一）（`alembic/versions/a9b8c7d6e5f4_add_knowledge_pages.py:44-73`）；
- **陈旧是数据水位线，不是时钟**：`staleness = 作用域内有记忆在 last_memory_seen_at 之后被写`
  （`memory_engine.py:2001-2039`）；
- 刷新是**快照有界的 reflect**（`created_before` 截止 + delta 用 `created_after`）；**读取 = 一次 SELECT + 陈旧查询，无检索无 LLM**；
- **delta 按 id 寻址**：`delta_ops` 指向 section/block 的 id，未被提到的内容**物理拷过去**（"prose drift 结构上不可能"，
  `engine/reflect/delta_ops.py:14-30`）；
- 版本化：`mental_model_history` + `reflect_response.based_on`；**撤回扫描**：`based_on` 里的 id 已无活行 → 标记撤回
  （`engine/reflect/retractions.py:12-27`）。

**对比 mem**：mem 的知识库是**用户资料**（`kb_add` → managed `.md` + 分块索引），**没有自维护派生页**。
可直接搬的确定性形态：**page = 持久化的 scope + 渲染规则**（内容即时渲染 + 水位线缓存），这同时把前次审查 L1 的
"subject 分组"变成一个**可读、可投影、可搜索**的产品面。

### 2.6 融合与重排的工程教训（对 mem 直接可用）

`engine/search/recall_boost.py:33-41` 记录了一次**实测事故**（issue #3956）：

- RRF k=60 在 300 候选窗口内跨度只有 `1/61 → 1/360`（**5.9 倍**）；任何加权 `w > 5.9` 就退化成**字典序**
  （被加权臂占满 300 槽），实测 `recall@20 0.97 → 0.40`；
- 修法：**在 rank 空间提升**（`rank / rank_divisor`，divisor 2/4/8）而不是缩放 RRF 分数；且明确加性 bump 不解决 CE 校准。

重排消融（`hindsight-docs/blog/2026-09-24-adding-jev-reranker-what-we-learned.md:105-124`，LoCoMo）：
30 候选时本地 MiniLM recall@1 0.800 / nDCG@10 0.850 / **0.12 s**，托管 TypeSafe 0.950/0.957/**0.027 s**；
240 候选时 0.583/0.682/**0.41 s** vs 0.783/0.856/0.063 s。**候选数是成本的主变量**——这对 mem 那条"17.3 s"的结论是重要补证。

**对比 mem**：mem 是"每腿最大值归一 + 配置权重求和"，权重不会退化成字典序，但**每腿头恒为 1.0**——正是
2026-10-04 自指事故（某腿偶然头部压过另一腿压倒性证据）的结构性原因。两条路线各有病：**RRF 的"名次即证据"
会给偶然命中发同样的票**。hindsight 的答案是"融合只是预筛，判定交给 CE"；mem 的答案只能是"**绝对门槛 +
证据定序**"（所以方案 L2「≥2 条腿」方向错了，见 §2.7）。

### 2.7 「门槛不是交集」——一段可以直接引用的权威反证

`engine/response_models.py:265-292`（`MinScores` 文档，类在 `:265`、"intersection" 那句在 `:281`）原文大意：

> `semantic`/`keyword` 是**检索级**门槛，各自只约束**它自己那一臂**；四臂融合后"结果只要被**任一**臂召回过
> 就会出现在响应里"，单个非空分数**一定**过它自己的门槛，所以**同时设置两者并不会把结果限制成"两者都过"**——
> "an intersection would discard the strong single-arm matches that hybrid retrieval exists to find"。

以及：要"低置信弃答"，正确工具是**融合后**的 `reranker`/`final` 门槛（per-result 谓词），**不是**检索级门槛。

⇒ 这与本仓前次审查对 L2 的判定完全一致，而且是一个独立系统在同一问题上**选择了相反设计并写明理由**。

### 2.8 写侧安全：Memory Defense —— **它的威胁模型与 mem 不同，不能整条搬**

`extensions/memory_defense.py` + `extensions/builtin/memory_defense_regex.py` + `docs/memory-defense/index.md`：
44 条正则覆盖 AI/云 key、连接串、私钥、已知 PII 格式（模式表在 `extensions/memory_defense.py:167-238`，44 条已核；`builtin/memory_defense_regex.py` 57 行只是装配）；命中 `[REDACTED:类型]`（redact）或整条丢弃（block，全 block → 422）；
**按 bank 策略、默认关**，命中发 webhook + 审计，预览是**指纹不是原文**；**自认"不回溯"**。

**为什么它需要这些东西**：hindsight 的主要写入路径是**自动捕获完整会话**（hook 在 `Stop` 时整段 upsert）、
多租户 bank、导出/备份/SIEM——内容不受"调用方是否想记"控制，且一次泄漏会跨租户或进第三方 LLM。
**mem 没有这三件事**：写入是模型显式的一次 `mem_remember`、单用户、无自动捕获。

**但"单 agent"不等于"不需要"**，两处仍然成立、且与多租户无关：

1. **持久化本身才是风险**：agent 会把工具输出（`.env`、命令输出、网页）转写成事实；"只记存放位置、不记明文"
   是**提示词约定，不是不变量**——mem 自己就把这条规则**记成了一条事实**（`memory:fact:117`），说明它需要被反复提醒。
   一旦写入，它就比"当时在上下文里瞥见过"更糟：**durable**。
2. **数据根是用户可备份/可同步的地方**：本机实测 `~/.avantf/memory` **本身是一个 git 仓库，且带远端**
   （`origin git@gitee.com:ffeng86/my-mem-data.git`，跟踪 `memory.db`/`-wal`/`-shm`）。⇒ 一条明文密钥进入事实，
   就等于进入**不可删除的 git 历史**并推到第三方托管。这类风险恰好在 mem 的默认数据布局下被放大，
   而 hindsight 的"不回溯"在这里更致命（sweep 清不掉历史）。

**要把话说准的一处**：mem 的自动提示**不是内容注入**——`rt.relevance(text)` 只算一个布尔 `RelevanceHit`，
渲染成一条 system-prompt 贡献（`plugin/src/index.ts:750-775`），内容只有在模型真正 `recall` 时才出现。
所以"每条消息自动外泄"不成立；风险落在**两个点**：模型主动 recall 时、以及**DB / git 备份 / 同步**这条静态路径。
后者才是这层守卫真正要挡的。

**因此结论是"要，但只做很小的一层，且动作不同"**：

| 维度 | hindsight（cloud，自动捕获） | mem（单 agent，显式写入）建议 |
|---|---|---|
| 范围 | 每个 bank 的策略引擎 | **只对 `mem_remember` 写的事实**；`kb_add`/文档**不扫**（文档是用户的源文件，抹改会破坏"路径即真相"，且示例 token 合法存在于 `.env.example`/README） |
| 动作 | redact（静默改写）+ block(422) | **拒绝并给出原因 + 建议改记"存放位置"**，或警告并要求显式覆盖；**不做静默 redact**——调用方以为存了 X 却得到 Y，对记忆系统是更坏的失败 |
| 模式 | **44 条** + 可扩展策略 | **只收高置信形状**（provider 前缀、PEM 块、带凭据的连接串、Luhn 卡号、身份证格式），不做熵启发式 |
| 回溯 | 明确不做 | **也不做**（git 历史本来也清不掉；真出事的处置是轮换密钥 + 重写远端历史，不是扫 DB） |
| 范围外 | 多租户 webhook/审计/SIEM | 全部不需要 |

**优先级（已按复核上调）**：这是一条**小、独立、与排序无耦合、且不移动 41 条冻结数字**的车道；在本机数据根
**带 git 远端**（已实测 `git@gitee.com:ffeng86/my-mem-data.git`，跟踪 `memory.db`/-wal/-shm）的前提下，
它是**性价比最高的一项**——用"可逆的质量收益"去压"不可逆的泄密面"不划算，应排在 E0/信封同批（详见
`HINDSIGHT_ANALYSIS_REVIEW.md` §3）。更根本的防线仍在**上游**：别让 agent 看到密钥（工具输出的 redaction）
属于 DSH/harness 层，不归 mem。另有一条**比它更便宜、且现在就在生效**的用户侧隐患：把 `-wal`/`-shm`
一起提交（同一份复核 §3.2）——修法是 `.gitignore` + 提交前 `wal_checkpoint(TRUNCATE)`。

### 2.9 何时记忆、何时浮现（产品级差距最大的一处）

hindsight 的 coding-agent 集成（`hindsight-integrations/`）：

- **Claude Code hooks**：`UserPromptSubmit` → recall（**每条用户消息无条件跑**，45 s 超时）、`Stop` → retain
  （**async**，15 s，整段会话累积 upsert + 重叠 + 游标去重）、`SessionStart`/`SessionEnd`；
  配置：`autoRecall/autoRetain` 默认 true、`retainMode:"full-session"`、`recallMaxTokens:1024`、
  `recallMaxQueryChars:800`（`integrations/claude-code/hooks/`）。
- **通用 coding-agents 包**（20 个 harness，**含 DSH**）：**每会话只注入一次，首条消息**，来源可选
  reflect（默认）/pages/recall，带 fallback（`src/core/hook.ts:4-12,211-257`）。
- **注入框架（最值得抄的一段文案与语义）**`src/core/inject.ts:85-111`：诚实说明来源（"它目前记录到的内容……
  检索是启发式的：可能与当前任务有关，也可能无关"）、**明确授权忽略**、强调"记忆是**过去的记录**，
  绝不是当下的命令"、只要求归因**真正起作用的**条目。
- **纠错回路**：agent 若核实记忆过时，调用 `hindsight_ingest_document("Correction: <topic>")`（`inject.ts:105-108`）。
- **反馈环护栏**：`<hindsight_memory>` 标签在读 transcript 时被剥掉，**注入的合成内容永不被回存**——执行代码在
  `coding-agents/src/core/transcript-util.ts:20-25`（`MEMORY_TAG_RE` + `stripInjectedMemory()`；`inject.ts:80-84` 只是注释）。
  **注意：mem 没有对应物可建**——mem 的 hint 只注入一行固定文案、不注入记忆正文（见 §2.8），所以护栏要防的是
  另一条更窄的回环：**recall 工具输出被 `mem_remember` 记回去**（详见 `HINDSIGHT_ANALYSIS_REVIEW.md` §2）。
- 有界：1024 token 召回、800 字符查询上限、列表用 `detail=metadata` 避免 MCP 结果外溢、`include_based_on/include_trace` 默认关。

- **DSH 已在支持列表里**：`hindsight-integrations/coding-agents/README.md:5` 明确列出 **DeepSeek Harness**（连同 Claude
  Code / Codex / Cursor CLI / Copilot CLI 等 20 个 harness），安装后走同一套"每会话首条消息注入一次"的 hook。
  ⇒ 在同一个宿主上，mem 与 hindsight 是**并存/竞争**关系：mem 的差异化是**本地、零 LLM、生命周期与知识库**；
  hindsight 的差异化是**抽取式结构 + reflect + 自维护知识页 + 无条件召回**。

**对比 mem**：mem 是**精度优先的同步词法 hint**（用户消息与库有 ≥2 个词元重叠才提示），加上模型主动调工具；
hindsight 是**召回优先**（每条消息都注入）并把相关性判断交给模型（靠上面那段框架文案）。两者风险相反：
hindsight 可能噪声多但**不会漏**，mem 可能漏掉改写式提问。**mem 完全不需要改成无条件注入**，但
"注入框架文案 + 纠错回路 + 反馈环护栏"三条是**纯文本/纯流程**，可以直接搬——尤其护栏，
它防的是"把系统注入的记忆当成用户说过的话再记一遍"，mem 今天没有这层保护。

### 2.10 评测与工程纪律

- **correct + trap 判分**：每题给一个正确答案与一个"诱饵错误"，"**Traps must stay at 0**"
  （`hindsight-system-evals/README.md:289`）——比 mem 现在的 `must_include/must_exclude` 更狠，且直接测"会不会被病态干扰项骗"。
- **冻结下限取"两个测量态中较低的那个"**：BEIR 实测 nDCG@10 0.887/0.874 → 下限设 0.83
  （`hindsight-system-evals/evals/test_08_retrieval_metrics.py:63-88`）。mem 的"重冻并解释"可以吸收这条**设限方法**。
- **冻结语料 fixture 导出时不含嵌入**（`system-evals/README.md:200-260`）：把"换嵌入模型"变成自变量而不是常量——
  对 mem 的 E0 直接适用。
- **门禁分层**：质量评测在**夜间 cron** 跑（`hindsight-system-evals` + AMB LoComo/LongMemEval），PR 只跑**stub 模型的确定性
  system-tests**（`.github/workflows/perf-test.yml:6`）。这正好印证 mem 的"快档/发版档"分层，且给出"确定性 stub 进 PR、真模型进夜间"的形态。
- **成本账**：把每次 LLM 调用从 `/llm-requests` 读回来计价（含缓存创建/命中）（`system-evals/README.md:76-120`）。
- **协议一致性测试**：MCP 工具的两处声明（stdio/HTTP）由 `tests/test_mcp_tool_pair_parity.py` 钉住——与 mem 的
  "契约是唯一真源 + `supportsToolKey` 断言每个 key 都能派发"是同一类守卫。
- **缺口**：仓库**没有任何 ablation 表**；README 的 LongMemEval SOTA 只有图片与链接，正文数字在博客里（91.4% → 94.6% LongMemEval-s，BEAM 10M 64.1%），arXiv 论文只给了链接、无committed摘要。

### 2.11 文档说了、实现没有的（照抄前的清单）

| docs/README 的说法 | 实现事实 |
|---|---|
| 观察带"exact quotes"证据 | 活模型只有 `source_memory_ids` id 数组；引文模型是**死代码**（`engine/reflect/observations.py` 无人 import） |
| "关键词 BM25" | native 后端是 `ts_rank_cd`（**cover-density，无 IDF**；`bm25_term_selection.py:5,146`；真 BM25 要 ParadeDB `pg_search` 臂）——这条是**代码事实**，hindsight 自己的 docs 反而写成 TF-IDF |
| 有 MMR / 类型配额 | 代码里**没有 MMR**（docstring 是陈旧的）；去重只有 `prefer_observations` |
| 观察带 confidence / 信念强度 | 没有置信度列（随 `opinion` 类型删除），只有整数 proof_count；无任何数值更新 |
| `access_count` 参与重要性 | 该列**因为没人读写被迁移删掉** |
| LongMemEval SOTA 可复现 | 仓库只给图片/链接与夜间 harness；正文数字在博客 |

---

## 3. mem 相对 hindsight 的优势（不要丢）

1. **零 LLM + 离线 + 隐私**：hindsight 写侧必须调 LLM（500 ms–2 s/批，数据出本机或需自托管大模型）。
   对"个人助手的长期记忆"这是**结构性**优势。（注：hindsight 自己也提供零 LLM 的 `chunks` 抽取模式，
   说明"LLM 抽取"是可选件而非必要条件——mem 只是把可选件默认关掉。）
2. **可冻结的确定性评测**：mem 的 41 条中文集是**精确断言**且进 PR 门；hindsight 的质量结论依赖夜间真模型 harness
   与博客，数字随抽取模型漂移。
3. **生命周期比 hindsight 丰富**：mem 有逐活跃日 trust 衰减、强化日上限、`idle_calendar_days=365` 闲置清理、
   pin/permanent、矛盾日志与裁决；hindsight **没有 TTL/遗忘**，"衰减"只是排序里的 ±10% recency，
   `invalidated_memory_units` 只由人工 curation 写入。
4. **门槛更严且有弃答**：mem 的每腿绝对门槛默认开且逐腿标定（含自动放宽档，且"只放宽不收窄"）；
   hindsight 的每臂默认门槛更松（语义 0.3 vs 0.5）且**融合后弃答默认关闭**。
5. **版本化派生溯源**：mem 的 `entities_version` + 有界重扫让"换抽取规则/换分词"能追到旧行；
   hindsight **行上没有抽取器/提示词/模型版本**，只有 `content_hash` 与可选的 `llm_requests`。
6. **知识库的"路径即真相"**：mem 的 `kb_*` 把用户文档存成可编辑、可 git 的 managed `.md`；hindsight 的知识页是
   **派生视图**（删了能重生，但不能作为源）。两者互补，mem 不应把自己的知识库降级为派生页。
7. **部署与依赖**：单文件 SQLite、无服务、无 Postgres、无 25 provider、无 39 工具面；符合插件零运行期依赖的门禁。

---

## 4. 可借鉴清单（按"零 LLM 约束下能否落地"分档）

### A 档：不需要 LLM，可直接做

| # | 机制 | 证据 | mem 落地形态 | 成本 | 风险/注意 |
|---|---|---|---|---|---|
| A1 | **写侧密钥守卫**（**只对事实、只拒绝、不静默改写**） | `extensions/memory_defense.py`（但范围/动作按 §2.8 重新定义） | `mem_remember` 前置高置信模式检查：命中则**拒绝并提示改记"存放位置"**（或警告 + 显式覆盖）；不碰 `kb_add` 文档 | 小（纯函数 + 测试） | 精确率是全部：误伤会永久污染记忆；样本要用本仓自己的 `.env.example`/README 里的合法示例 token 做反例 |
| A2 | **时间语义** | `chinese_temporal_periods.py`、`time_filter.py`、`links.py:142` | ① `facts` 增 `occurred_start/end`（可空，写侧可选给出）；② 中文时间窗解析（先做相对期 + 绝对期）；③ temporal 腿/boost + 确定性时间边 | 中（规则集是主要工作量） | 新腿/新分要重标门槛；时间窗**只作一腿**（不做过滤器），保住"并集不收窄" |
| A3 | **实体规范化 + 共现** | `entity_resolver.py:1309-1344`（0.5·SequenceMatcher + 0.3·共现 + 0.2·7 天新鲜度，阈 0.6）、`entity_cooccurrences` | trigram Jaccard 合并 + `mention_count`/`last_seen` + 共现计数/边 | 中 | 必须升 `ENTITY_EXTRACTOR_VERSION` + 扫描，否则旧行不合并（静默双 vintage） |
| A4 | **`text_signals`：把实体名/日期 token 并入被索引文本** | `engine/retain`（`text_signals` 列） | FTS 索引文本 = content + 实体名 + 日期 token | 小 | 会动 FTS 原始分 → 冻结点重测 |
| A5 | **乘性 boost（α 封顶）** | `reranking.py:174-304` | recency/trust/proof/时间邻近做成 `1+α(signal−0.5)`，α 0.1–0.2 | 小 | 会移动冻结数字 ⇒ 重冻 + E0 回归；**不要**做成硬过滤（即本仓否决过的 pinned 豁免形态） |
| A6 | **信封暴露逐臂分与融合后分**（**按调用可选：`include_scores` 默认 false**，复核 §4） | `response_models.py:241-262`；hindsight 自己把 `include_based_on`/`include_trace` 默认关 | `RecallHit` 增 `scores{semantic,fts,entity,hrr}`（该臂没召回为 null）+ `final` + `source_fact_ids`；模型日常调用不开，UI/bench/E0/回归脚本开 | 中（要穿过 `fuse` 保留 provenance；加**入参** ⇒ 契约/MCP/CLI/client 四处派生 + 形状断言） | 前次审查 §2.3 的前置；也是所有 boost/门槛验收的前提；不给每次工具调用加 ~5% 上下文税 |
| A7 | **"弃答"用融合后分数（可选）** | `MinScores`（final/reranker 是 per-result 谓词） | recall 增可选 `min_final`；默认仍走现有每腿门槛 + 自动放宽 | 小 | 与"无门槛 top-k"相反，只作显式开关 |
| A8 | **预算装箱兜底** | `fact_budget.py:43-87` | ① 放不下的**跳过并继续**装后面的（mem 现在截断文本）；② **实在放不下也整条返回 top-1**（mem 现在可能返回空文本条目） | 小 | mem 现有"广度优先 + 保留 source_ref"有价值，做成模式而非替换 |
| A9 | **`fact_kind` 枚举** | `memory_units.fact_type`（CHECK，非自由文本） | 在脏 `category` 之外增受约束 `kind`；category 保留 | 小-中（迁移 + ~百处读写面） | 是 L1/observations 的前提 |
| A10 | **确定性 fact↔fact 边** | `memory_links`（7 种 link_type，权重 0..1）；先只搬 temporal/entity 两类 | 时间邻近边 + 共享锚点实体边；因果边留给写侧参数 | 中 | 与 HRR 探针职责重叠，需 A/B；不要一次上 7 种 |
| A11 | **注入框架 + 纠错回路 + 反馈环护栏** | `inject.ts:80-111,105-108` | 改提示词段/hint 文案；加"注入内容不进回存"的剥标签或来源标记 | 小 | 文案要短；护栏是必需品不是优化 |
| A12 | **评测纪律** | `system-evals/README.md:289`、`test_08_retrieval_metrics.py:63-88` | ① correct+trap 判分；② 下限取"两个测量态中较低者"；③ 冻结语料**不带嵌入**；④ 确定性 stub 进 PR、真模型进夜间 | 中（E0 的一部分） | 与在办的 E0 是同一条车道，直接吸收 |
| A13 | **生命周期模式**：水位线陈旧 + 毒行标记 + 撤回扫描 + 有界快照 | `memory_engine.py:2001-2039`、`reads.py:377-495`、`retractions.py:12-27`、`observation_history`（上限 50） | ① 陈旧判据用"作用域内是否有更晚写入"而不是时钟；② 派生失败行打标永久排除（mem 已有 `reindexEntities` 骨架）；③ `based_on` id 无活行→撤回；④ 有界历史快照 | 中 | 都是零 LLM；② 要防止"永久排除"把可修复行也排除，需人工重置入口 |
| A14 | **interleave 融合模式**（轮转保证每臂头部一席） | `fusion.py:112-176` | 作为第二融合模式（用于"双胞胎/去重"型检索），可对 41 条集做 A/B | 小 | 只作模式，不改默认 |
| A15 | **cap-then-hydrate** | `memory_engine.py:9794-9812` | 腿只回 id+分，正文在截断之后取 | 小 | SQLite 下收益有限（无网络往返），量过再决定 |
| A16 | **查询预算分级** | `memory_engine.py:1600-1648` | 把 `over_fetch_factor`/`leg_cap` 打包成 `low/mid/high`（重排上限已随 0.5.0 移除，不参与） | 小 | 纯配置面，先文档化 |

### B 档：需要 LLM —— 用"写侧显式给出 / 调用方模型"替代

| # | 机制 | hindsight 怎么做 | mem 的等价路线 |
|---|---|---|---|
| B1 | 事实/实体/关系/时间抽取 | `engine/retain/fact_extraction.py`（LLM + JSON schema；含零 LLM 的 `chunks` 模式） | `mem_remember` 增可选 `subject/attribute/entities/event_date/links` 参数，由调用方模型填；引擎只校验/规范化 |
| B2 | observations（信念合并） | `engine/consolidation/`（LLM 决定 creates/updates/deletes） | 确定性近似：按 subject/实体聚簇 + 模板渲染 + 证据 id 列表；**不重写事实文本** |
| B3 | mental models / knowledge pages 合成 | 后台 LLM + 按 id 的 delta 编辑 | "持久化 scope + 即时渲染 + 水位线缓存"（见 §2.5），合成留给调用方模型 |
| B4 | reflect（深度问答） | `engine/reflect/`（agentic loop；**零 DB 写入**，回写全在 mental-model 刷新管线） | 不在 mem 定位内；DSH 侧模型自己会多轮检索 |
| B5 | 语义/因果边、观察合并的全文复核 | LLM `caused_by`、cos≥0.97 后逐对判定 | 因果边由写侧给；合并用确定性阈值 + 保守策略（mem 已有 `contradiction.ts` 的组合） |

### C 档：不适用（多租户/云/规模问题）

Postgres schema/租户隔离与 API-key 鉴权、admission control（`max_in_flight` + 503/Retry-After）、
transfer/export 备份、Prometheus/OTel/Grafana、每 bank MCP 端点、Citus/Oracle 兼容层、pgvector 索引健康与
每 bank 部分索引、39 工具面、25+ provider 网关、LLM 成本计量、冷归档表（`invalidated_memory_units`）、
FUSE `fs mount`（mem 的 managed `.md` 已覆盖"投影到磁盘"）。

---

## 5. 与在办改动的关系 + 建议顺序

| 在办项 | 本分析的关系 |
|---|---|
| **E0 真实形状评测集** | 直接吸收 A12（correct+trap、下限取低态、语料不带嵌入）；A2/A3/A5/A10 都会动候选或排序，**没有 E0 不敢上** |
| **L2「≥2 条腿」** | `MinScores` 文档是独立反证（§2.7）：交集式准入会丢单腿强命中；弃答要用融合后分数（A7） |
| **L4 实体过滤** | A3 是正确方向（规范化 + 共现 + 类型），不是"过滤泛词"；hindsight 的 `tanh` 饱和与 mem 的饱和并集同源 |
| **F4 FTS 分数** | A4（text_signals）与 F4 同层、可同批；hindsight 的"BM25 可插拔后端 + jieba/中文分词"说明词法层本身值得做成可配 |
| **重排** | **0.5.0 已整体移除**（`0450c3e feat(mem)!`：删配置键、统计字段、`retrieval-core/src/rerank.ts` 与本地适配器，`WIRE_VERSION 1→2`）；重开条件见 `DESIGN.md` §5.1 | hindsight 把它当默认判定器，但有 300 候选上限、批 32、超时降级、`rrf` 直通、`trace` 报告与消融数据（候选数=成本主变量）。**本节只在"要不要重新引入"时适用**——那时先补这四件事，再谈 17.3 s |
| **A1 写侧密钥守卫** | 与排序零耦合、不移动冻结数字 ⇒ **提到批次 0/1**（复核 §3.1：数据根带 git 远端时，性价比最高；A 档最便宜的一项）。同时做**用户侧的 `-wal`/`-shm` 不提交 + checkpoint**（复核 §3.2，比 A1 更便宜且现在就在生效） |
| **A13 生命周期模式** | 与 `reindexEntities`/`contradiction_log` 同源，可作为同一条"派生状态纪律"车道 |

建议插入顺序：**A6（信封，**`include_scores` 默认关**，复核 §4）→ E0(+A12) → A1（密钥守卫，复核 §3.1 上调）→ A2/A3 spike → A4/F4 → A5/A7/A8 → A9/A10/A13 → A11（按复核 §2 拆三块）→ B1**。

---

## 6. 一句话总结

Hindsight 值得借鉴的**不是"它比 mem 准"**（那来自写侧 LLM + CE 重排，mem 刻意不做），而是它在
**时间语义、实体图、证据信封、注入框架、写侧安全、生命周期纪律**上沉淀出的**可分离机制**；
其中大部分**不需要 LLM**，可以直接搬进 mem，且多数能与当前路线图并行。
同时它在两件事上**明显不如 mem**——**遗忘/生命周期**与**版本化派生溯源**——借鉴时要守住这两处。
