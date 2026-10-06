# Graphiti 对照分析：优势与可借鉴机制（2026-10-05）

> **对象**：`/home/ffeng/sources/graphiti`（getzep/graphiti，Apache-2.0；本地快照，274 个 `.py`）。
> **对照**：本仓 `@avantf/dsh-mem`（本地优先、单文件 SQLite、引擎零 LLM 的 DSH 记忆/知识插件）。
> **方法**：只读通读 `graphiti_core/`、`mcp_server/`、`server/`、`spec/` 与 README/CLAUDE.md；本仓**只写这一份文档**，
> 未改任何代码、配置、CHANGELOG，也未改 mem 现有四份文档。
> **口径纪律**：每条优势/机制都标注 **〔代码事实〕**（我在该行读到并引用）、**〔文档声称〕**（README/CLAUDE.md/注释
> 这么说）或 **〔推断〕**（我从代码推出的结论，无直接断言）。§6 单列"文档声称 vs 实现不符"。
> **对派单简要的两点更正**（先读文件后的事实）：`spec/` 里**没有**本体/类型规范，只有一份
> `spec/driver-operations-redesign.md`（942 行，driver 分层重构草案）；`graphiti_core/migrations/`
> 只有一个 **0 字节**的 `__init__.py`（无模式迁移机制）。因此"prescribed vs learned ontology"与"迁移"
> 两条只能按**代码里真实存在的东西**来核（见 §2.5 与 §6 末段的说明）。
> **路径约定**（同 `HINDSIGHT_COMPARISON.md` 的做法，省略公共前缀以便阅读）：
> 不带目录的 `README.md`/`CLAUDE.md` 指 **graphiti 仓库根**；`edges.py`/`nodes.py`/`search_*.py` 等裸名指
> **`graphiti_core/`**（个别在 `graphiti_core/search/`、`graphiti_core/utils/maintenance/`、
> `graphiti_core/prompts/`、`graphiti_core/driver/`、`graphiti_core/cross_encoder/` 下，按唯一名可解析）；
> `mcp_server/...`、`server/...` 为完整相对路径；mem 侧裸名指 `mem/packages/core/src/`（`contract/src/...`、
> `core/test/...` 分别指契约包与测试目录）；`store/*`、`db/*`、`lifecycle/*` 均在 `mem/packages/core/src/` 下。

---

## 0. 结论速览

两者不是同一类系统。graphiti 是"**写侧 LLM 把非结构化输入抽成时序知识图谱**"的框架，读侧多方法候选 +
可插拔 rerank，图与索引都压在 Neo4j/FalkorDB/Kuzu/Neptune 上；mem 是"**写读都零 LLM、单文件 SQLite、
靠绝对门槛而非 rerank 定序**"的本地插件。graphiti 的实现里有一批**与 LLM 无关**的机制可以直接搬：
**双时间列**、**"失效但保留历史"的落库与渲染约定**、**MinHash/LSH + 熵门的确定性实体去重**、
**Union-Find 传递合并**、**逐结果平行 scores 数组**、**episode 溯源与反向溯源**、**受约束的实体类型校验**。
真正搬不动的是它的**生成式抽取/判定**能力与**图库专属的索引与遍历**。

**最值得借鉴的 8 条**（细节、证据、成本与影响见 §4；均不需要给 mem 引入 LLM）：

| # | 机制 | graphiti 证据 | mem 落地形态（一句话） |
|---|---|---|---|
| G-A1 | **双时间：事件时间与系统时间分离** | `edges.py:271-280`、`nodes.py:322-325` | `facts` 增可空的 `valid_from/valid_to`，`created_at/updated_at` 保持"得知/改写"语义 |
| G-A2 | **失效即保留历史**（带有效期返回，由读者判"现在是否成立"） | `edge_operations.py:538-573,820-847`、`search_helpers.py:52-70` | 只标注 `superseded_by/valid_to`，**不改状态、不改候选集**，信封里返回"已被谁取代" |
| G-A3 | **近重复实体归并**（精确名优先 + 熵门 + MinHash/LSH + Jaccard≥0.9） | `dedup_helpers.py:31-36,52-85,103-128,220-279` | 写侧 `entities` 归并，复用**已存在却无人读写**的 `entities.aliases` 列 |
| G-A4 | **传递合并 + 规范 id**（Union-Find，取字典序最小 uuid） | `bulk_utils.py:584-621` | 实体别名图传递闭合，`fact_entities` 指向规范实体 |
| G-A5 | **逐结果证据信封**（每类结果一个平行 scores 数组） | `search_config.py:121-129`、`search.py:235-244` | 正是本仓在办 A6：`RecallHit.scores{leg}` + `final`（graphiti 只到 core，没进 MCP） |
| G-A6 | **verbatim 快速路径 + 重复断言累积** | `edge_operations.py:684-695` | 重复 `add` 不再纯 no-op：`assert_count+1 / last_asserted_at`，不进打分只进信封 |
| G-A7 | **episode 溯源与反向溯源** | `edges.py:267-270`、`graphiti.py:1690-1705`、`mcp_server/...:1059-1096` | `fact_sources`（或 `facts.sources`）+ 走现有 `mem_admin detail` 反查，**不加工具** |
| G-A8 | **受约束的实体类型 + 白名单校验** | `entity_types_utils.py:20-37`、`node_operations.py:152-186,301-306` | `entities.entity_type` 从 jieba 词性改为"写侧显式类型 or unknown"，引擎只校验 |

**最不该照搬的**：RRF（名次即证据，§4-N1）、MMR / cross-encoder（模型依赖，N2/N3）、
按密度分块的 chunker（N4）、把图遍历当一等腿（N5）。**最该警惕的是照抄宣称**：§6 列了 7 处
README/CLAUDE.md/注释与实现不符，其中"learned ontology"与"query what's true now"两条会直接误导设计。

---

## 1. 系统画像

| 维度 | Graphiti | dsh-mem | （Hindsight，第三列，取自本仓对照文档） |
|---|---|---|---|
| 形态 | Python 框架 + 可选 MCP/REST 服务；图库外置 | DSH 插件，单文件 SQLite ×2（memory/knowledge） | FastAPI 服务 + Postgres/pgvector |
| 存储后端 | **4 个 provider**：Neo4j / FalkorDB / Kuzu / Neptune（`driver/driver.py:59-64`） | 1 个：SQLite（+ 本地 vstore） | 1 个：Postgres（Oracle 同源） |
| 租户/分区 | `group_id` 贯穿全部节点/边/索引（`graph_queries.py:66-70`） | 单用户；两个 store 各自一个库 | schema/bank 多租户 |
| 写入 | **LLM 抽取**实体/边/时间戳，再 LLM 去重与矛盾判定；每 episode 至少 2 次生成式调用，且按抽出的边**逐条**再调（`graphiti.py:1179-1206`、`edge_operations.py:726-733,788-794`） | 零 LLM：`nodejieba` POS 实体 + SVO 启发式三元组（`entities/extract.ts`） | 写侧 LLM 抽事实/实体/关系/时间 |
| 读取 | 按对象类型（edge/node/episode/community）各自跑 `bm25 + cosine + bfs`，再 rerank；**四类结果不互相融合**，各回各的数组（`search.py:168-244`） | 四腿（语义/FTS trigram/锚点实体 Jaccard/HRR）→ 每腿绝对门槛 → 按腿最大值归一加权和 → 切片 → 预算（`store/hybrid.ts`、`store/floors.ts`） | 四臂 + RRF + cross-encoder 重排 |
| 时间模型 | **双时间**：`valid_at/invalid_at`（事件时间，LLM 抽）+ `created_at`（入库）+ `expired_at`（系统失效时刻）（`edges.py:271-280`）；episode 另有 `valid_at`（引用时间） | 只有 `created_at/updated_at` + 活跃日钟 `settle_clock`；**没有有效期/失效语义**；显式 `update` 用 `supersedes_id` 串修订链（`store/memory.ts:519-554`） | `occurred_start/end` + `mentioned_at`，**无有效期区间** |
| 门槛 | 语义腿 SQL 内 `score > sim_min_score`（**默认 0.6**，`search_utils.py:65`、`search_config.py:83`）；全文/BFS 腿无门槛；`reranker_min_score` 默认 0（`search_config.py:118`） | 三条腿各有绝对门槛 + 只放宽不收窄的自动二次 pass + 弃答（`store/floors.ts:119,212-229`） | 每臂默认门槛更松，融合后弃答默认关 |
| 派生层 | Community（label propagation 聚簇 + LLM 树形摘要，`community_operations.py:93-213`）；Saga（线性 episode 链） | 无派生层；知识库是**用户文档**（managed `.md` + 分块索引，"路径即真相"） | observations / mental models / pages |
| 溯源 | 边带 `episodes: list[uuid]`（逗号串落库）+ `MENTIONS` 边；有**反向溯源**工具（episode→节点/边） | `RecallHit.source_ref = memory:fact:<id>`（自指）；`mirror_source` 恒为常量 `'user'`、`mirror_target` 从不写入（`db/dao/facts.ts:256`、`db/schema.ts:56-57`），两列只是空壳；无"这条事实从哪来" | 只有 `content_hash` 与可选 `llm_requests` |
| 生命周期 | **没有遗忘**：失效靠 LLM 判定 + `expired_at`；无 TTL/衰减 | trust 逐活跃日衰减、强化日上限、闲置 365 天清理、pin、矛盾日志与裁决 | 无 TTL；`access_count` 被删列 |
| 版本化派生 | **无**抽取器/提示词版本 | `entities_version` + 有界重扫（`facts.entities_version`，schema.ts:51） | 无 |
| 评测 | `tests/` 53 个 py 文件（含 mock 图库）；**无冻结质量集** | 41 条中文冻结集（7 项精确断言，`core/test/eval_zh.spec.ts:318-326`）+ 真实库回归脚本 | 夜间真模型 harness |
| 工具/服务面 | MCP **13** 个工具 + REST 10 条路由 + OTel/telemetry + token 计费 | **恰好 8** 个模型工具（`TOOL_SPECS`）+ 2 个 UI 页签 | 39 MCP 工具 |
| 依赖 | openai/anthropic/gemini/groq 等 **9** 个 llm client 模块、**4** 个 embedder 实现、**3** 个 cross-encoder 实现（各有一个 ABC）、4 个 driver；`sentence-transformers` 可选 | 零运行期依赖；`zod` 只做 required peer；`nodejieba` 可选且可降级 | 25+ provider |
| 模式迁移 | `graphiti_core/migrations/` 是**空包**（0 字节）；索引靠 `IF NOT EXISTS` 幂等建 | 1..N 编号迁移，**单向**（`db/migrations.ts:75-105`）；memory 已到 v9 | Alembic |

---

## 2. Graphiti 的结构性优势（带证据）

每小节末尾回答派单要求的那句：**"零 LLM、单文件 SQLite 的 mem 能搬到哪一层"**。

### 2.1 双时间模型：事件时间由 LLM 抽，失效执行是确定性规则 〔代码事实〕

四个时间戳各有明确归属（都在数据模型上，不是注释）：

| 字段 | 所在 | 语义 | 谁写 |
|---|---|---|---|
| `valid_at` | `EntityEdge`（`edges.py:274-276`）、`EpisodicNode`（`nodes.py:322-325`） | 事实/引用**在世界上**开始成立的时间 | 抽取提示词直接产出（`prompts/extract_edges.py:171-172`），没产出的走一次小模型补抽（`edge_operations.py:576-620`） |
| `invalid_at` | `EntityEdge`（`edges.py:277-279`） | 事实停止成立的时间 | 同上（`extract_edges.py:172,256`） |
| `created_at` | `Edge` 基类（`edges.py:54`）、`Node` 基类（`nodes.py:98`） | **入库**时刻（系统时间） | `utc_now()` |
| `expired_at` | `EntityEdge`（`edges.py:271-273`） | 系统**判定它被取代**的时刻 | `resolve_extracted_edge` / `resolve_edge_contradictions` 里 `utc_now()`（`edge_operations.py:570,823,838`） |

**失效链条**（这一段是全仓最值得读的 60 行）：

1. 新的边抽出后，候选分两批：**同端点的 `related_edges`**（用于判重）与**混合检索出来的
   `edge_invalidation_candidates`**（`edge_operations.py:392-430`；注意候选**不限于同端点**，是整图 hybrid top-N）；
2. 两次候选一起送进 LLM，返回 `EdgeDuplicate{duplicate_facts, contradicted_facts}`（`prompts/dedupe_edges.py:20-35,43-79`）；
   **"矛盾"是模型判的**，不是规则；
3. 但**执行失效是纯规则**（`resolve_edge_contradictions`，`edge_operations.py:538-573`）：
   - 若旧边 `invalid_at <= 新边 valid_at`（时间上本来就早于新事实）→ **不失效**；
   - 否则若 `旧边 valid_at < 新边 valid_at` → `旧边.invalid_at = 新边.valid_at`、`旧边.expired_at = now`，
     旧边**保留在库里**并随 episode 一起落盘（`graphiti.py:1215` `entity_edges = resolved_edges + invalidated_edges`）；
   - 反向也处理：新边的 `valid_at` 若早于某个候选 → **新边自己被立刻失效**（`edge_operations.py:826-839`）。
4. **硬前提**：`resolve_edge_contradictions` 的两个分支都要求 `valid_at is not None`（`edge_operations.py:553-568`）。
   没有事件时间的边**永远不会被自动失效**——即"双时间"是这套机制的地基，不是装饰。

**读侧不把它当过滤器**：`search_helpers.py:52-70` 把**失效的也算进上下文**，并在提示词里明说
"Facts with an invalid_at date of 'Present' are considered valid"；`SearchFilters` 的四个时间谓词全部
**默认 None**（`search_filters.py:55-67`），core 的两条默认路径都传空 `SearchFilters()`（`graphiti.py:1639,1684`）。
这是**设计选择**（把"哪条还成立"交给读者），不是纯遗漏——但 README 的措辞与它不符（§6.2）。

> **零 LLM、单文件 SQLite 的 mem 能搬到哪一层**：**能搬机制**（列、字段归属、"失效=标注不删除"、
> "时间只作可选谓词/一腿"）；**搬不了"谁判定事件时间与矛盾"**——那部分必须由写侧调用方模型显式给（§4-G-B2）。

### 2.2 写侧确定性去重：精确名优先 → 熵门 → MinHash/LSH → Jaccard 阈值 〔代码事实〕

`dedup_helpers.py` 是一段**纯 CPU、零模型**的实体消解，参数全部是常量（`:31-36`）：

- `_normalize_string_exact`：小写 + 折叠空白（`:39-42`）；
- **熵门**：字符 Shannon 熵 ≥ `1.5` **且**（长度 ≥ 6 或 ≥ 2 个词）才允许走模糊路径（`:52-85`）——
  短/低熵名字（"user"、"用户"这类）**直接交回 LLM**，因为 trigram 集合没有判别力；
- `_shingles` 3-gram（`:88-94`）→ `_minhash_signature` 32 个排列、`blake2b` 确定性哈希（`:97-114`）→
  `_lsh_bands` 4 条一带（`:117-128`）；
- 合并阈值 `_FUZZY_JACCARD_THRESHOLD = 0.9`（`:34`），且**精确名命中永远先试、且不受熵门限制**（`:235-248`）；
- 重复判定命中时**提升标签**：把通用 `Entity` 升级成更具体的类型（`_promote_resolved_node`，`:170-189`）。

匹配到重复后，uuid 的归并是**并查集 + 字典序最小**（`bulk_utils.py:584-621` `UnionFind`/`compress_uuid_map`，
`bulk_utils.py:566-579` 用它把"3→2、2→1"压成"3→1"）。**这条在批量路径上是唯一在用的确定性 merge**。

> **能搬到哪一层**：**完全可搬**（纯 CPU + 现有 `entities/fact_entities` 表；mem 已有 trigram/FTS 基建与
> `name UNIQUE`）。见 §4-G-A3/A4。

### 2.3 读侧：按对象类型独立的多方法 + 可插拔 rerank + 每类一个平行 scores 数组 〔代码事实〕

- 四个 scope（edge/node/episode/community）**并发独立**跑（`search.py:168-225`），每个 scope 内：
  `bm25`（= 后端全文索引）、`cosine_similarity`（`WHERE score > min_score`）、`bfs`（变长路径）
  三选若干，每路取 `2 * limit`（`search.py:284-311`），合并成一个 uuid map；
- **rerank 是一组可换的实现**（`search_config.py:53-77`）：`rrf`、`node_distance`、`episode_mentions`、
  `mmr`、`cross_encoder`（edge/node 五个，community 三个，episode 两个）；
- **RRF 的实际 k 不是 60**：`rrf(results, rank_const=1)`，分数 `Σ 1/(rank+1)`（`search_utils.py:1775-1790`）；
  调用点全部用默认值（如 `search.py:374,397,421`）。仓库内没有任何 k=60 的声明（`README`/`CLAUDE.md` 都没写 RRF 的 k）——
  arXiv 论文（README:89 只有链接，正文不在仓库）常被引用的 k=60 属**未能验证**，不在本对照里当事实用；
- **MMR 不是迭代 MMR**：单趟算 `λ·cos(q,c) + (λ−1)·max_sim(c,·)` 再整体排序（`search_utils.py:1901-1939`），
  没有贪心去冗余的循环；
- **cross_encoder 是"每候选一次生成式调用"**：`OpenAIRerankerClient.rank` 对每条 passage 发一次
  `max_tokens=1` + logprobs 的 chat 请求（`cross_encoder/openai_reranker_client.py:56-95`），默认模型
  `gpt-4.1-nano`（`:28`）；`CrossEncoderClient` 是 ABC（`cross_encoder/client.py:20-38`），
  **没有零模型降级实现**——不传就默认 `OpenAIRerankerClient()`（`graphiti.py:224-227`）；
- **逐结果证据**：`SearchResults` 为每一类结果配一个**平行 scores 数组**
  （`edge_reranker_scores` 等，`search_config.py:121-129`，`search.py:235-244`）；
  `SearchResults.merge` 只是 extend 拼接（`search_config.py:131-159`）。**但这层没进 MCP**：
  `to_edge_result` / `format_fact_result` 都不回传 rerank 分数（`mcp_server/src/utils/formatting.py:26-38,64-82`）。

> **能搬到哪一层**：**信封可搬**（平行数组 → mem 的 `RecallHit` 逐腿分数，即本仓 A6）；
> **rerank 不可搬**（RRF 的名次语义与 mem 的绝对门槛哲学冲突；MMR/CE 需要模型或句向量矩阵）。见 §4-G-A5。

### 2.4 图能力全部下沉到 driver 的 operations，缺失时有通用 Cypher 兜底 〔代码事实〕

- `GraphDriver` 是 ABC，带四个可选的能力接口：`search_interface`、`graph_operations_interface`、
  `graph_ops`、以及按对象类型的一整套 `*_ops`（`driver/driver.py:90-213`）；
- 特化实现优先、否则回落通用 Cypher，有两种等价写法：`if driver.search_interface: return ...`
  （如 `search_utils.py:312-322`）与 `try: ... except NotImplementedError: pass`
  （`:458-464,1799-1805,1858-1864`）——这是全仓最一致的一种降级模式；
- 图库差异被收进 `graph_queries.py`：全文索引的创建/查询语法按 provider 分叉
  （`:85-135,146-175`），向量余弦函数按 provider 分叉（`:155-164`），范围索引在 `:71-81`；
- **但没有任何向量索引**：全仓（含测试）没有 `CREATE VECTOR INDEX` / `db.index.vector.*`；
  `edge_similarity_search` 是 `WHERE vector.similarity.cosine(...) > $min_score ORDER BY score DESC LIMIT` 的
  **精确扫描**（`search_utils.py:419-443`）。所谓"低延迟/可扩展"（README:127-130）在开源核里靠的是
  `LIMIT` 与并发，不是 ANN。这是**局限而不是优势**，列在这里是为了避免误搬"索引"这一层。

> **能搬到哪一层**：**只能搬设计约束**——"后端差异收敛在一层适配里"这条纪律 mem 已经用
> `db/port.ts` + 单个 SQLite 实现满足；**图库专属索引/遍历完全不能搬**（见 §4-C1）。

### 2.5 本体：只有 prescribed，没有 learned 〔代码事实〕

- 类型是 `dict[str, type[BaseModel]]`，**运行时参数**，随每次 `add_episode` 传入（`graphiti.py:1053-1057`）；
- 它们被转成带 id 的上下文塞进抽取提示词（`node_operations.py:152-186`），模型回 `entity_type_id`；
- **越界 id 回落到 `Entity`**（`node_operations.py:301-306`），`excluded_entity_types` 用来整类丢弃（`:308-311`）；
- 校验只有一条：自定义类型的字段名**不得与 `EntityNode` 内置字段重名**（`entity_types_utils.py:20-37`）；
- 边侧同理：`edge_types` + `edge_type_map[(src_label, dst_label)] -> [type_name]`，按端点标签选出候选类型
  （`edge_operations.py:457-486`），再让模型在允许集合里选。
- 全仓 grep 不到"learned/discover/emerge 新类型并持久化"的任何实现（`spec/` 也不是本体规范）。

> **能搬到哪一层**：**"受约束的类型 + 白名单校验 + 越界回落"这层机制完全可搬**（零 LLM，引擎只当校验器）；
> **"类型从哪来"只能由写侧给**（§4-G-A8 + G-B1）。

### 2.6 溯源：边上有 episode 列表，且有反向溯源工具 〔代码事实〕

- `EntityEdge.episodes: list[str]`（`edges.py:267-270`），落库是一个逗号串（`models/edges/edge_db_queries.py:81,95`）；
- 重复事实命中 verbatim 快速路径时**只追加 episode uuid**（`edge_operations.py:684-695`）——即"同一句话被独立
  说过几次"是**累积出来的**；
- `get_episodes_by_mentions` / `get_mentioned_nodes` 提供双向查询（`search_utils.py:110-136`）；
- MCP 有专门的 `get_episode_entities` 工具："Use this to trace provenance: given one or more episode UUIDs,
  return the graph elements that those episodes produced"（`mcp_server/src/graphiti_mcp_server.py:1059-1096`）；
- 原文可关：`store_raw_episode_content=False` 时 episode 的 `content` 在落库前被清成 `''`（`graphiti.py:146,214,750-751`）。

> **能搬到哪一层**：**机制完全可搬**（一张 `fact_sources` 表或 CSV 列 + 两条查询）；mem 今天**完全没有**
> "这条记忆从哪来"的路径，而 `mirror_source` 恒为常量 `'user'`、`mirror_target` 从不写入——
> 两列只是空壳，不能当可复用的溯源。

### 2.7 确定性分块与"BM25 的零索引近似" 〔代码事实〕

- `content_chunking.py`：`~4 字符/token` 估算（`:26-38`），**只有"够长且实体密度高"才切**
  （`should_chunk`，`:62-90`），阈值走环境变量（`helpers.py:45-55`）——动机是 LLM 的 token 上限；
- 批量写路径里用**词集合重叠**当 BM25 的近似：注释原文 "Approximate BM25 by checking for word overlaps
  (this is faster than creating many in-memory indices)"（`bulk_utils.py:518-531`），重叠即候选，
  否则才付一次余弦。

> **能搬到哪一层**：分块策略**不建议搬**（mem 的知识库已按段落/标题切分并保留 `headings_path`，
> 见 §4-N4）；"**先用零成本精确信号筛候选，再付向量代价**"这条**已在 mem 存在**
> （`ContradictDetector.structuralPass` 先于 `embeddingPass`，`lifecycle/contradiction.ts:219-230`），无需再搬。

### 2.8 模型类抽象与"缺省降级"：ABC 齐全，但没有零模型兜底 〔代码事实〕

- 四个 ABC 平行：`EmbedderClient`（`embedder/client.py:30-38`；`create` 抽象、`create_batch` 默认
  `raise NotImplementedError()`）、`LLMClient`（`llm_client/client.py:75`）、`CrossEncoderClient`
  （`cross_encoder/client.py:20-38`）、`GraphDriver`（`driver/driver.py:90`）；
- **缺省永远是云客户端**：不传就 `OpenAIClient()` / `OpenAIEmbedder()` / `OpenAIRerankerClient()`
  （`graphiti.py:218-227`）。"可插拔"只保证**能换**，不保证**离线可跑**——要离线必须自己注入实现；
- 嵌入维度是**环境变量 + frozen 配置**：`EMBEDDING_DIM` 默认 1024（`embedder/client.py:23,27`），默认模型
  `text-embedding-3-small`，返回值被截断到 `embedding_dim`（`embedder/openai.py:24,60,66`）；
- **唯一的本地实现 `GLiNER2Client` 也不是零 LLM**：只把**实体抽取（NER）**放在本地 CPU 小模型
  （205M–340M 参数），其余边/矛盾/摘要仍委托给一个**必需**的通用 `llm_client`；`llm_client=None`
  直接 `ValueError`（`llm_client/gliner2_client.py:47-79`）；
- **没有通用降级**：余弦腿 / MMR 需要向量，缺向量时只有 Kuzu 分支显式短路
  `embedding_size == 0 → return []`（`search_utils.py:1278-1281,1488-1492`），其余 provider
  没有"无向量就退回纯词法"的路径。

> **能搬到哪一层**：**只能搬设计约束**——"每个模型能力一个 ABC + 显式注入"这条 mem 已用自己的
> `registerSemanticBackend` / `registerVectorStore`（`retrieval-core/src/registry.ts:66,69`；语义腿不可用时
> `resolveFloors(..., semAvail=false)` 抬高 FTS 门槛继续作答，`store/floors.ts:212-219`）满足；
> 而"缺省即云"与"无向量无降级"**不可搬也不该搬**：mem 的前提就是缺省零依赖、缺模型时**必须降级而非报错**。

---

## 3. mem 不该丢的优势（对照后明确写出）

1. **零 LLM + 离线 + 单文件**：graphiti 每 episode 至少 2 次生成式调用，且**按边逐条**再调
   （去重/矛盾/时间戳/属性，`edge_operations.py:726-733,788-794,813`）；mem 的写入路径一次模型调用都没有。
   这是结构性差异，不是调优差异。
2. **可冻结的确定性评测**：41 条中文集 7 项精确断言（`core/test/eval_zh.spec.ts:318-326`）。
   graphiti 有 53 个测试文件（我抽样看到的都是 mock 图驱动的行为测试），**没有冻结质量集**——
   它的质量结论不可复现地依赖模型。
3. **绝对门槛 + "只放宽不收窄" + 弃答**（`store/floors.ts:119,212-229`）：graphiti 的融合前门槛只有语义腿
   `sim_min_score=0.6`，且**融合后没有任何弃答机制**（`reranker_min_score` 默认 0，`search_config.py:118`），
   "结果只要被任一腿召回就会出现"——正是 mem 2026-10-04 事故要避免的形状。**mem 的答案是严格的那一侧，
   不要因为 graphiti 没有就以为可以省。**
4. **生命周期比 graphiti 丰富**：trust 逐活跃日衰减、强化日上限、闲置清理、pin、矛盾日志与人工裁决
   （`lifecycle/`）；graphiti **没有遗忘**——失效要么靠 LLM，要么靠调用方显式改 `expired_at`。
5. **版本化派生溯源**：`facts.entities_version` + 有界重扫（`schema.ts:40-52`）让"换了抽取规则"能追到旧行；
   graphiti 的边上**没有任何抽取器/提示词/模型版本**。
6. **知识库"路径即真相"**：`kb_*` 把用户文档存成可编辑、可 git 的 managed `.md`；graphiti 的 Community
   是**派生视图**（删了能重生，不能当源）。两者互补，mem 不应把自己的知识库降级为派生页。
7. **工具面恰好 8 个、零运行期依赖**：graphiti 是 13 个 MCP 工具 + REST + OTel + 4 driver + 9 个 llm client +
   4 个 embedder + 3 个 cross-encoder 的可插拔矩阵。mem 的窄面是它能在 DSH 里"零依赖挂载"的前提。

---

## 4. 可借鉴清单

**分档**：**A** = 零 LLM、零图库、可直接做；**B** = 需要 LLM，给"由写侧调用方模型显式提供结构"的等价形态；
**C** = 不适用。每条含五件事：**机制 → graphiti 证据 → mem 落地形态 → 成本与风险 → 影响评估**
（符号沿用 `IMPROVEMENT_IMPACT_ANALYSIS.md`：迁移 ✅/–、动 41 条冻结数字 ✅/–、wire ✅/–、规模 S/M/L、价值）。
每条末尾给出**"能搬到哪一层"**。

### A 档：零 LLM 可搬

#### G-A1 双时间列：事件时间与系统时间分离

- **机制**：把"事实在世界上何时成立"（`valid_at/invalid_at`）与"系统何时知道/何时判定它失效"
  （`created_at/expired_at`）分成两组字段，两组都可空、都只在有值时才参与语义。
- **证据**：`edges.py:271-280`（三个字段的 docstring）、`edges.py:54`（`created_at` 在 Edge 基类）、
  `nodes.py:322-325`（episode 的 `valid_at` = 引用时间）。
- **mem 落地形态**：`facts` 增两个**可空**列 `valid_from/valid_to`——**不替换** `created_at/updated_at`
  （mem 的 `created_at` 已有一个语义很硬的约定：跨 supersede 继承原行的 `created_at`，
  见 `contract/src/types.ts:119-125`）。写入侧可选（契约增可选 `valid_from/valid_to`；
  未给则为 NULL = "未知"）；检索侧**默认不加任何时间谓词**（保持"并集不收窄"），
  时间候选做成**可选一腿或可选过滤**（借用 graphiti 的 `DateFilter` 形状：`is_null/is_not_null` 也是一等操作，
  `search_filters.py:27-35`）。memory schema v9 → v10（`db/conn.ts:170` 之后追加），知识库不动。
- **成本与风险**：迁移 + 契约 + 一次 wire bump；风险是"给了 `valid_to` 之后有人把它当过滤器"——
  必须在契约文档里写死"时间只作标注/可选腿"（否则违反本仓红线）。另一个风险是**空值语义**：
  graphiti 里 `valid_at is None` 会让失效规则整体不触发（`edge_operations.py:553-568`），
  mem 若照此，则"没给事件时间的事实永不失效"，需要显式记在文档里。
- **影响评估**：迁移 **✅**（memory v10；kb 无 facts 表）· 数字 **–**（默认不参与打分）· wire **✅**（`WIRE_VERSION 2→3`）·
  规模 **M** · 价值 **高**（是 G-A2/G-A6/G-A7/G-B2 的地基，也是"事件时间"这一整层的入口）。
- **能搬到哪一层**：**能搬机制**（列 + 可选谓词）；**搬不了"事件时间由谁给"**（→ G-B2）。

#### G-A2 失效即保留历史：标注取代关系，而不改状态、不改候选集

- **机制**：新事实取代旧事实时，旧行**留在库里**并带上"截止到某时"与"被谁取代"；渲染层把它当历史一起给读者，
  由读者判"现在是否成立"。
- **证据**：`edge_operations.py:538-573`（确定性写 `invalid_at/expired_at`）与 `:820-847`（新边也可能被立即失效）；
  `graphiti.py:1215`（失效边与新边一起落盘）；**渲染约定** `search_helpers.py:52-70`
  （"Facts with an invalid_at date of 'Present' are considered valid"）。
- **mem 落地形态**：**不改 `status`**（仍是 `active/archived` 两值，`contract/src/types.ts:18`）——
  只在 G-A1 的 `valid_to` 之外加一个 `superseded_by INTEGER`（指向新 fact_id，行已有 `supersedes_id`
  指向旧行，正好是对称的两列）。写侧的三种来源：① 显式 `update`（今天已有：archive 旧行 + 新行
  `supersedes_id`，`store/memory.ts:519-554`）；② `contradict_resolve` 判 `true_positive` 时
  除了归档 loser，还写 `loser.valid_to = winner.valid_from`、`loser.superseded_by = winner.fact_id`
  （今天只归档，`contradiction.ts:189-191`）；③ 写侧显式 `replaces`（→ G-B2）。
  `RecallHit` 增 `valid_to/superseded_by` 两个可空字段；提示词段加一句"带 superseded_by 的事实是历史记录，
  不是当前状态"。
- **成本与风险**：与 G-A1 同一批迁移，成本主要是**契约与提示词**；风险是"归档 + 标注"两条路径同时存在时
  可能出现"已归档又被标成 superseded"的不一致——需要一条不变量：`superseded_by` 只写在
  `status='archived' OR valid_to IS NOT NULL` 的行上，且归档时清 `superseded_by`（照 `purgeArchived` 清
  `supersedes_id` 的既有先例，`db/dao/facts.ts:1004-1013`）。**这是本清单里"零 LLM 搬到的最高价值一层"。**
- **影响评估**：迁移 **✅**（与 A1 同批）· 数字 **–**（不动候选与排序；若哪天真把 `valid_to` 变成过滤谓词，
  那就是另一条要重冻的改动）· wire **✅**（与 A1 同一次 bump）· 规模 **M** · 价值 **高**。
- **能搬到哪一层**：**能搬机制**（标注 + 渲染约定）；**"谁判定取代"搬不了**（→ G-B2）。

#### G-A3 近重复实体归并：精确名优先 → 熵门 → MinHash/LSH → Jaccard 阈值

- **机制**：见 §2.2 的完整参数链。
- **证据**：`dedup_helpers.py:31-36`（阈值常量）、`:39-49`（两级规范化）、`:52-85`（熵门）、
  `:88-128`（3-gram shingle / 32 排列 MinHash / 4 一带 LSH）、`:220-280`（精确名永远先试，模糊路径加熵门与 0.9 阈值）。
- **mem 落地形态**：落在 `EntitiesDao.linkFact`（`db/dao/entities.ts:21-31`）之前——
  先按**规范化名**查 `entities`，未命中再按 MinHash/LSH 桶查近重复；命中则把新名字追加进
  **`entities.aliases`**（该列**今天没有任何代码读写**，schema.ts:95）并把 `fact_entities` 指向规范实体。
  中文侧建议把 shingle 换成"字符 2-gram + 音译无关的确定性归一"（`_shingles` 的 3-gram 对 2 字中文名会退化成
  空集，`dedup_helpers.py:88-94` 对 `len(cleaned) < 2` 有兜底但没有 2 字名的 shingle），
  熵门阈值必须**在本仓真实语料上重标**（graphiti 的 1.5 是按英文名调的）。旧行归并走既有
  `entities_version` 有界重扫通道（只对 memory 库；knowledge 的 `chunk_entities` 是另一套，见风险）。
- **成本与风险**：**会动实体袋 → 会动 41 条数字**（entity leg 的 Jaccard 分母变了），必须重冻 + 解释 +
  一次性 kb 对照（R7）。**必须先做离线 spike**：统计"本仓真实库里有多少实体名对落在 Jaccard≥0.9"——
  如果占比接近 0，这条就不值得开（很可能如此：mem 的实体是 jieba 名词，形态差异主要是全半角与空白，
  已在 `normalizeWrite` 覆盖）。**共享面警告**：`entities/extract.ts` 被 memory/knowledge 共用，
  但 `entities` 表只在 memory 库——改动不要顺手动抽取器，否则 kb 无评测网。
- **影响评估**：迁移 **–**（复用 `aliases` 死列；若改成别名表则 ✅）· 数字 **✅** · wire **–** · 规模 **M** ·
  价值 **中**（取决于 spike 结果；机制本身完全可搬）。
- **能搬到哪一层**：**完全可搬**（纯 CPU；这是本清单里最"原样不改编"的一条）。

#### G-A4 传递合并 + 规范 id（Union-Find）

- **机制**：把重复对（a→b、b→c）压成（a→b→c 归到字典序最小的 c），避免"链式重复"在库里留下多份规范实体。
- **证据**：`bulk_utils.py:584-603`（`UnionFind`，path compression，按字典序挂根）、
  `:606-621`（`compress_uuid_map`）、`:566-579`（批量路径的实际使用）。
- **mem 落地形态**：`entities` 归并的一次性扫描里照搬：把 `aliases` 里的"别名→规范名"视为边，
  做并查集闭包后**一次性重写** `entities` + `fact_entities`（`fact_entities` 是 `(fact_id, entity_id)` 主键，
  重写要点 `INSERT OR IGNORE` 后再删旧行，避免主键冲突——mem 的 `linkFact` 已是 `OR IGNORE` 幂等，
  `db/dao/entities.ts:21-31`）。
- **成本与风险**：写侧一小段；风险是**并发写**（DSH 宿主、CLI、MCP 三个进程打开同一库，
  `schema.ts:172-179` 的注释已说明这一点）——归并扫描必须在单事务里做，且要么只做一次（受
  `entities_version` 门控），要么幂等可重入。
- **影响评估**：迁移 **–** · 数字 **✅**（与 A3 同一批重冻，单独做没有意义）· wire **–** · 规模 **S** ·
  价值 **中**（A3 的收尾；顺带让矛盾检测的"共享实体数"更准，`lifecycle/contradiction.ts:269-277`）。
- **能搬到哪一层**：**完全可搬**。

#### G-A5 逐结果证据信封：每类结果一个平行 scores 数组

- **机制**：融合/重排之后，结果对象**与分数数组平行返回**，而不是把分数丢掉只留文本。
- **证据**：`search_config.py:121-129`（`SearchResults` 的四个 `*_reranker_scores`）、
  `search.py:235-244`（装配）、`search_config.py:131-159`（`merge` 只 extend，不做二次融合）。
- **mem 落地形态**：这就是本仓**在办的 A6**（`RecallHit.scores{semantic,fts,entity,hrr}` + `final` +
  `source_fact_ids`）。graphiti 能补充的增量只有两点：① **平行数组**比"嵌进 hit"更省（不必为每个 hit 复制
  4 个可空字段），但在 TS/zod 契约下嵌进 hit 更好校验，**mem 保持嵌进 hit**；② **分数数组与结果一起
  在"按类型分开"的层面返回**——提醒 mem 的**跨库 router**（memory+kb 合并）要在合并前各自保留腿分，
  合并后不能再反推（`store/hybrid.ts:481-503` 的 `unionLegs` 用 max 合并，正是"合并会丢来源"的例子）。
- **成本与风险**：与在办 A6 同一条车道，**不要再开第二条**；风险是 `fuse` 在 `retrieval-core`，
  要让它把每腿原始分带出来而不只是融合分（`store/hybrid.ts:409-418` 目前只拿 `fuse()` 的输出）。
- **影响评估**：迁移 **–** · 数字 **–**（只加字段）· wire **✅** · 规模 **M** · 价值 **高（前置）**。
- **能搬到哪一层**：**能搬机制**（graphiti 的证据只到 core 没进 MCP，所以"要不要暴露给模型"由 mem 自己定）。

#### G-A6 verbatim 快速路径 + 重复断言累积（不再纯 no-op）

- **机制**：新输入与已有事实**逐字相同且端点相同**时，不新建行，**把这次输入的来源 uuid 追加到已有行**——
  "被独立说过 N 次"由此变成一个确定性的计数。
- **证据**：`edge_operations.py:684-695`（`_normalize_string_exact` 比较 fact + 同端点 → `resolved.episodes.append`）、
  `episode_mentions_reranker` 用 `MENTIONS` 边数排序（`search_utils.py:1855-1898`），
  且边侧的 `episode_mentions` rerank 是"先 RRF 再按提及数稳定排序"（`search.py:368-374,450-451`）。
- **mem 落地形态**：`mem_remember add` 命中完全重复 content 时今天**静默 no-op**（`tools.ts:313` 明说）。
  改成：仍然不新建行，但 `facts` 增 `assert_count INTEGER DEFAULT 0` 与 `last_asserted_at`（或复用
  `last_reinforced_at`？**不要**——那是 trust 强化，语义不同），`+1` 并返回 `is_new:false, assert_count:n`。
  检索侧**不把它变成 boost**（那会动分），只在 `RecallHit` 里回传 `assert_count`，由调用方模型自己判断
  "这条被独立断言过 3 次"与"只说过 1 次"的差别——这正是 graphiti 把 `episodes` 暴露给读者的用法。
- **成本与风险**：迁移（一列或复用已有列）+ 契约（add 的返回多一个计数）+"重复写入不再是 no-op"是**用户可见行为变化**
  ⇒ 要进 `[0.6.0]`；风险是**内容去重≠事实去重**：同一句话在不同时间说两次，可能确实是同一事实，
  也可能只是客套重复，计数本身不解释，别把它当置信度。
- **影响评估**：迁移 **✅** · 数字 **–**（不进打分）· wire **✅**（`RecallHit` 多字段）· 规模 **S** · 价值 **中**。
- **能搬到哪一层**：**能搬机制**（graphiti 的 `episodes` 累积是纯字符串/数组操作）。

#### G-A7 事实 → 来源 id 列表 + 反向溯源

- **机制**：每条派生结果记它由哪些原始输入产生；并给出**反向查询**（给定来源，列出它产生的东西）。
- **证据**：`edges.py:267-270`（`episodes: list[str]` 字段）、`models/edges/edge_db_queries.py:81,95`（逗号串落库）、
  `search_utils.py:110-136`（`get_episodes_by_mentions` / `get_mentioned_nodes`）、
  `graphiti.py:1690-1705`（`get_nodes_and_edges_by_episode`）、
  `mcp_server/src/graphiti_mcp_server.py:1059-1096`（专门的溯源工具，"given one or more episode UUIDs,
  return the graph elements that those episodes produced"）。
- **mem 落地形态**：新增 `fact_sources(fact_id, kind, ref)`（`kind ∈ {session, kb_doc, tool, manual}`，
  `ref` 是 kb 的 `domain:source:title` 或会话 id）——**比 CSV 列好**，因为要反查（`CREATE INDEX ON
  fact_sources(ref)`）；memory schema 进同一批迁移。读面**不加工具**（守住 8 个）：
  ① `mem_admin detail` 增 `sources`；② `mem_recall` 的 `search` 增可选 `source` 过滤（只作过滤，
  不参与打分）。写面：`mem_remember` 增可选 `source_ref`（→ G-B1 的一部分）；未给则 NULL = "未知来源"，
  **绝不臆造**。反向查询（"这篇文档产生了哪些事实"）走 `mem_admin detail` 的一句 SQL，或后续并入 `kb_*` 的返回。
- **成本与风险**：迁移 + wire + 写侧参数；风险是**覆盖率**——只有当调用方模型愿意传 `source_ref` 时才有值，
  否则整表是 NULL，功能看起来"没生效"。要在 `stats` 里如实报"有来源的事实占比"，
  避免又一个"看起来有、实际全空"的字段（`mirror_source` 就是先例）。
- **影响评估**：迁移 **✅**（与 A1/A2/A6 同批最省） · 数字 **–** · wire **✅** · 规模 **M** · 价值 **中-高**
  （"为什么记得"是 mem 今天完全空白的一层，且与知识库的"路径即真相"天然互补）。
- **能搬到哪一层**：**能搬机制**；**"来源内容由谁给"是写侧的事**（→ G-B1）。

#### G-A8 受约束的实体类型 + 白名单校验（prescribed 的可搬内核）

- **机制**：类型来自一份**封闭集合**，引擎只做校验与回落（越界 → 通用类型），不做发现。
- **证据**：`entity_types_utils.py:20-37`（类型字段不得与内置字段重名）、
  `node_operations.py:152-186`（id ↔ 类型名的上下文）、`:301-306`（越界回落 `Entity`）、
  `:308-311`（整类排除）、`dedup_helpers.py:170-189`（合并时把通用标签升级成具体标签）。
- **mem 落地形态**：`entities.entity_type` 今天存的是 **jieba 词性**（`entities/extract.ts:145` 直接写 `tag`），
  不是类型——这既不是本体也不是可用维度。落地：写侧可选 `entity_types`（封闭枚举，契约 zod 的
  `z.enum`）+ 引擎校验（未知类型**拒绝该条**或回落 `unknown` 并回报）；同时把 `entity_type` 的语义
  从"词性"改成"类型"，旧行由 `entities_version` 重扫改成 `unknown`（**不要猜**）。可选的"标签升级"
  照 `_promote_resolved_node`：一个名字已被 `unknown` 行占用、新写入给了具体类型时，升级而不是新建行。
- **成本与风险**：**会动 `entities.entity_type` 的语义**（用户可见：`mem_admin detail` 显示的类型变了）+
  一次重扫；如果类型**不参与检索**（推荐），41 条数字不动。风险是把类型做成一个"必须填"的字段——
  graphiti 是**可选**的，mem 也应可选，否则零 LLM 的写路径会多一个必填门槛。
- **影响评估**：迁移 **✅**（同一批）· 数字 **–**（不参与打分；若将来参与，另算）· wire **✅**（detail/RecallHit 回传类型）·
  规模 **M** · 价值 **中**。
- **能搬到哪一层**：**能搬机制**（枚举 + 校验 + 回落 + 升级）；**"类型内容由谁给"→ G-B1**。

### B 档：需要 LLM —— 用"写侧调用方模型显式提供"替代

#### G-B1 事实/实体/关系/时间/类型：写侧显式结构参数

- **机制**：引擎调生成式模型，从原始文本一次性抽出实体、三元组、事件时间与类型；随后按抽出的边**逐条**
  再调（属性、去重、时间戳补抽）。
- **证据**：抽取提示词把 `PREVIOUS_MESSAGES/CURRENT_MESSAGE/ENTITIES/REFERENCE_TIME/entity_types`
  一起给模型（`prompts/extract_nodes.py:119,205,239,308,367`；`prompts/extract_edges.py:114-172`），
  逐边属性抽取在 `edge_operations.py:788-805`（含 `apply_capped_attributes` 的尺寸帽）。
- **mem 落地形态**：就是本仓在办的 **B1**：`mem_remember` 增可选 `subject/attribute/entities/event_date/
  valid_from/invalid_from/replaces/source_ref/entity_types`，由**调用方模型**填；引擎只做
  normalize + 校验 + 落库（`normalizeWrite` 已在写入口，`store/common.ts:29-31`）。
  与 graphiti 的差别要写清楚：graphiti 是**引擎调模型**抽；mem 是**调用方模型已经把结构拿在手里**
  （它刚写完那句话），只是没地方放——这正是"零 LLM 引擎"下唯一诚实的等价形态。
- **成本与风险**：契约 + MCP + CLI + client 四处派生 + 形状断言（本仓固定税）；**覆盖率依赖调用方**，
  必须在 `stats` 里报"结构化覆盖率"；**不要**因为字段可选就在引擎里"猜"。
- **影响评估**：迁移 **✅**（新列/新表都要）· 数字 **✅**（若新结构参与检索）· wire **✅** · 规模 **M** ·
  价值 **高（L1 主路线）**。
- **能搬到哪一层**：**只能搬设计约束**（"结构从写侧来"）；内容永远来自模型。

#### G-B2 矛盾判定交由写侧（`contradicts` / `replaces`），引擎只执行确定性失效

- **机制**：冲突**判定**由生成式模型给出（"这条新事实与哪些旧事实矛盾/重复"），但**失效执行**是确定性规则。
- **证据**：判定来自 `prompts/dedupe_edges.py:56-79` 的 `contradicted_facts`；执行见 §2.1 第 3 步与
  `edge_operations.py:538-573`。
- **mem 落地形态**：mem **已经有**判定器（结构性：反极性谓词 + 同 subj/pred 异 obj，
  `lifecycle/contradiction.ts:232-245`；嵌入兜底：实体重叠 × 余弦，`:30-53`），也已经能裁决
  （`contradict_resolve`，`contract/src/tools.ts:224-229`）——缺的只是**裁决之后的"失效"语义**
  （今天只有归档，没有"截止时间 + 被谁取代"）。所以这条与 G-A1/G-A2 是**同一条车道的两半**：
  A 档给列与规则，B 档给"判定从哪来"。**写侧来的三种判定**：① 调用方显式 `replaces: fact_id`；
  ② 调用方显式 `contradicts: [fact_id]`；③ 现有 `contradict_resolve(true_positive, loser)`。
  三者都落到同一个确定性写入（`valid_to/superseded_by/archive_reason`）。
  **不引入 LLM**：mem 永远不自己"判"。
- **成本与风险**：与 G-A1/A2 同批；风险是**误判传播**——写侧给的 `replaces` 是调用方模型的一句话，
  错了会静默让一条正确记忆"失效"。缓解：① 失效**不删行、仍可被 `status:'archived'` 查到**；
  ② `stats` 报"被取代的事实数"；③ `admin list/restore` 提供回滚。
- **影响评估**：迁移 **–**（复用 A1/A2 的列）· 数字 **–** · wire **–**（A1/A2 已 bump）· 规模 **S** ·
  价值 **高**（让 G-A1/A2 有内容可写）。
- **能搬到哪一层**：**只能搬设计约束**（判定必须外置）。

#### G-B3 社群/主题聚簇：确定性聚簇 + 模板渲染（摘要合成留给调用方）

- **机制**：在**全图邻居**上跑 label propagation 得到簇，再用生成式模型做"两两归并"的树形摘要；
  检索时 community 是一个独立 scope（按社区名全文 + 按 `name_embedding` 余弦）。
- **证据**：`label_propagation`（`community_operations.py:93-138`）、树形摘要（`:141-213`）、
  增量并入多数社区（`:340-367`）、community scope（`search.py:764-875`）。
- **mem 落地形态**：mem 有 `fact_entities` 这个二部图，可以做**零 LLM 的聚簇**：
  以共享实体为边、按"共享实体数 / 并集"阈值做连通分量或一轮 label propagation（**不要**照搬
  `get_community_clusters` 的 N 次单节点查询，`community_operations.py:53-78`——SQLite 里一条
  `GROUP BY` 就够），簇的**摘要不合成**，只做**模板渲染**：`成员实体 + 代表事实（按 assert_count/trust 取前 k）`；
  持久化成"scope + 水位线"（本仓 HINDSIGHT 对照的 B3 派生页形态），读时即时渲染 + 水位线缓存。
- **成本与风险**：迁移（scope/水位线表）+ 渲染逻辑；**不要**把它做成检索一等对象（那会动候选集与门槛）；
  风险是 label propagation 的**顺序敏感性**（`community_operations.py:106-131` 按 dict 顺序遍历，
  且 `:97` 注释说"ties 去最大社区"而代码 `:121` 是 `max(社区 id)`，见 §6.5）——mem 若做，
  必须**定义并钉死确定性顺序**（按 entity_id 升序），否则每次重算簇都变。
- **影响评估**：迁移 **✅** · 数字 **–**（若只作只读派生面）或 **✅**（若进检索）· wire **✅**（新读面）·
  规模 **M-L** · 价值 **中**（是"主题/相关"产品面的地基，但不是检索命中率的地基）。
- **能搬到哪一层**：**机制可搬、摘要不可搬**（聚簇是纯 SQL/CPU；摘要必须由调用方模型写）。

#### G-B4 类型化边的属性（custom attributes）

- **机制**：类型化的边是**带字段的模型**，属性抽取有尺寸帽与合并模式；字段名受本体校验约束。
- **证据**：`edge_types: dict[str, type[BaseModel]]` 与 `edge_type_map`（`graphiti.py:1056-1057,1173-1175`）、
  `apply_capped_attributes`（`edge_operations.py:788-805`）、env 控制的尺寸帽（`attribute_utils.py`）。
- **mem 落地形态**：`facts` 增 `attributes TEXT`（JSON，**逐字段校验、有尺寸帽**），由写侧显式给；
  引擎只做"合法 JSON + 白名单字段 + 长度帽 + 深拷贝"的校验。**不要**给任意 JSON 建索引/参与排序。
- **成本与风险**：迁移 + 契约；风险是它变成"什么都能塞"的垃圾抽屉，必须有白名单与帽。
- **影响评估**：迁移 **✅** · 数字 **–** · wire **✅** · 规模 **S-M** · 价值 **低-中**（对零 LLM 引擎，
  结构化属性只有在**检索/渲染真的用它**时才有价值）。
- **能搬到哪一层**：**只能搬设计约束**（字段来自写侧）。

### C 档：不适用

#### G-C1 图库专属索引与遍历

- **机制**：全文/向量检索与图遍历都**下推给图库**：全文索引按 provider 各自建（Neo4j `db.index.fulltext.*`、
  FalkorDB `db.idx.fulltext.*`、Kuzu `CREATE_FTS_INDEX`），向量相似度用图库自带函数，图遍历用变长路径模式。
- **证据**：`graph_queries.py:85-175`（索引与查询构造，含 `:155-164` 的三套向量函数）、
  `search_utils.py:541-558`（`MATCH path = (origin)-[:RELATES_TO|MENTIONS*1..$depth]->(...)`）、
  `:482-501`（Kuzu 用中间节点存边导致的 `depth = bfs_max_depth * 2 - 1`）、
  `community_operations.py:299-313`（`HAS_MEMBER` 成员查询）。
- **mem 落地形态**：**不落地**。SQLite 侧对应物只有 FTS5（mem 已有 trigram external-content 表）与递归 CTE，
  而 mem 刻意不做图遍历（`retrieval-core` 的四条腿没有一条是图腿）。
- **成本与风险**：硬搬要先在图库与 SQLite 之间造一层语义等价物——**做不到**（Lucene 打分、变长路径语义、
  社区成员查询都没有 SQLite 等价物）；把"近似"当成"等价"会静默改变候选集与分数。
- **影响评估**：迁移 **–** · 数字 **–** · wire **–** · 规模 **–** · 价值 **–**（**不适用**）。
- **能搬到哪一层**：**完全不能搬**（唯一可搬的是"引擎自己不做索引、把能力下推"这条设计约束，
  在 SQLite 上就是"用 FTS5 而不是自建倒排"）。

#### G-C2 多后端 driver 抽象（4 provider × 一整套 operations + search_interface）

- **机制**：把每种能力拆成独立的 operations 接口，特化实现缺失时回落到通用 Cypher。
- **证据**：`driver/driver.py:90-213`（`search_interface` / `graph_operations_interface` / `*_ops`）、
  各调用点的特化优先降级（`if driver.search_interface: return` 或 `try/except NotImplementedError`；
  `search_utils.py:312-322,458-464,1799-1805,1858-1864`）。
- **mem 落地形态**：**不落地**。mem 只有一个 SQLite；它已经有 `db/port.ts` 作为唯一的存储接缝，
  再加一层 driver 抽象是纯成本。
- **成本与风险**：为"不存在的第二后端"维护 4 套接口形状，会平白扩大每一次改动的触达面
  （本仓已用 AGENTS 的固定税纪律否决同类抽象）。
- **影响评估**：迁移 **–** · 数字 **–** · wire **–** · 规模 **–** · 价值 **–**（**不适用**）。
- **能搬到哪一层**：**只能搬设计约束**——"缺失能力要有显式兜底"这条纪律 mem 已由 `db/port.ts` +
  腿级 try/catch 满足（`store/hybrid.ts:512-535`）。

#### G-C3 多租户与服务面：`group_id`、13 个 MCP 工具、REST、OTel、token 计费

- **机制**：所有节点/边/索引带 `group_id` 分区；框架自带 MCP 服务、REST 服务、遥测与 token 计费。
- **证据**：`group_id` 贯穿所有查询与索引（`graph_queries.py:66-70`）、MCP 13 个工具
  （`mcp_server/src/graphiti_mcp_server.py:402-1145` 的 13 处 `@mcp.tool`）、REST 10 条路由
  （`server/graph_service/routers/ingest.py:51,73,87` 与 `retrieve.py:17,30,36,44`）、
  `graphiti_core/telemetry/telemetry.py`、`llm_client/token_tracker.py`、`llm_client/cache.py`、
  批量导入（`utils/bulk_utils.py`）。
- **mem 落地形态**：**不落地**。mem 是单用户本地插件（工具面 8 个、无服务、无遥测、无计费），
  多租户在 mem 的定位里不存在。
- **成本与风险**：引入 `group_id` 会把每一个 SQL 谓词、每一张索引、每一次契约派生都乘以一个维度，
  而收益（隔离多用户）在单文件单用户的插件里是零。
- **影响评估**：迁移 **–** · 数字 **–** · wire **–** · 规模 **–** · 价值 **–**（**不适用**）。
- **能搬到哪一层**：**完全不能搬**（连设计约束都不需要：mem 的隔离边界是"一个数据根 = 一个库文件"）。

### 明确不采纳（不是"暂缓"，是**不该搬**）

| # | 不采纳的东西 | 理由 |
|---|---|---|
| **N1** | **RRF 融合**（`search_utils.py:1775-1790`，`Σ 1/(rank+1)`） | "名次即证据"会给偶然命中发与压倒性证据**同样的票**：一条只在全文腿排第 3 的无关文本，与在语义腿排第 1 的正确事实，RRF 分差只有 `1/2 − 1/4`。这正是 mem 2026-10-04 自指事故的形状（`docs/SELF_QUERY_RELEVANCE.md`），也是本仓已裁决 L2「≥2 条腿」方向错误的原因（`HINDSIGHT_COMPARISON.md` §2.7）。mem 的答案只能是**绝对门槛 + 证据定序**，两者不可混用一套打分。 |
| **N2** | **MMR reranker**（`search_utils.py:1901-1939`） | ① 它算的是 `n×n` 候选相似度矩阵——mem 的向量在本地 vstore 且 **1 fact = 1 vector 是硬身份**，为 MMR 取句向量/矩阵是结构性代价；② 现实现**不是迭代 MMR**（单趟重打分，没有贪心去冗余），搬过来只会得到一个名字对、语义弱的排序器；③ mem 0.5.0 已整体移除重排能力（`WIRE_VERSION 1→2`），重开有单独条件（`DESIGN.md` §5.1）。 |
| **N3** | **cross-encoder / `OpenAIRerankerClient`**（`cross_encoder/`、`graphiti.py:224-227`） | 模型依赖（违反零 LLM 红线），且 OpenAI 那个实现是**每候选一次生成式调用**（`openai_reranker_client.py:56-95`）——成本随候选数线性增长，还会在某一候选没有 logprobs 时整体抛错（`scores` 用 `continue` 跳过而 `zip(..., strict=True)` 要求等长）。mem 的候选预算（`overFetch=5×limit`、`legCap`）与它组合起来是性能陷阱，不是能力。 |
| **N4** | **按密度分块的 chunker**（`content_chunking.py:62-90`） | 它的动机是**LLM 的 token 上限**（"large entity-dense inputs"会让抽取崩溃），mem 的知识库写入路径**没有 LLM**；且 mem 的 `chunkText` 已经按段落/标题切分并保留 `headings_path/charStart/charEnd`（`store/knowledge.ts:651,672-681`），比"字符/token 估算 + 密度启发式"对文档更合适。 |
| **N5** | **把图遍历当一等检索腿**（`edge_bfs_search` / `MATCH path *1..depth`，`search_utils.py:450-571`） | ① 实现是**变长路径枚举**（所有长度 ≤ depth 的路径），不是真正的前沿有界 BFS，在稠密图上会路径爆炸，且是图库专属；② mem 已有的**锚点实体腿**直接用 `fact_entities` 做一跳关联（`store/entity_leg.ts` + `activeFactsForEntity`/`activeFactsForAllEntities`），`related`/`reason` 已经覆盖了"一跳邻居"的语义；③ 在 SQLite 上做 `WITH RECURSIVE` 需要先证明**实测收益**，而 mem 的纪律是"没有 E0 不动候选集"。 |

---

## 5. 影响评估表（可直接并入 `IMPROVEMENT_IMPACT_ANALYSIS.md` 的批次表）

符号同该文档：**迁移** ✅/–、**动 41 条冻结数字** ✅/–、**wire** ✅/–、规模 **S/M/L**、价值 **高/中/低**。

| 项 | 触达面 | 迁移 | 数字 | wire | 规模 | 价值 | 主要风险 |
|---|---|:--:|:--:|:--:|:--:|---|---|
| **G-A1** 双时间列 `valid_from/valid_to` | 迁移（memory v10）+ 契约 + wire + 写侧可选参数 | ✅ | – | ✅ | M | 高 | 空值语义要写死（`NULL` = 未知，不触发任何失效）；默认不得成为过滤器 |
| **G-A2** 失效即保留历史（`superseded_by` + 渲染约定） | 与 A1 同批；`contradiction.ts` 裁决路径 + 提示词段 | ✅ | – | ✅ | M | 高 | "归档"与"标注失效"两条路径的不一致；`purgeArchived` 要清新列（照 `supersedes_id` 先例） |
| **G-A3** MinHash/LSH + 熵门实体归并 | `EntitiesDao.linkFact` + `entities.aliases`（死列）+ 重扫 | – | ✅ | – | M | 中 | **先 spike**（真实库命中率）；阈值要为中文重标；勿动共享 `extract.ts` |
| **G-A4** Union-Find 传递合并 | 同 A3 的扫描（单事务、可重入） | – | ✅ | – | S | 中 | 三进程并发打开同一库；必须幂等 |
| **G-A5** 逐结果证据信封 | 契约 `RecallHit` + `fuse` 保留各腿原始分 + client + remote | – | – | ✅ | M | 高（前置） | 与在办 A6 重复 ⇒ **合并不新开** |
| **G-A6** 重复断言累积 | 迁移（一列）+ 契约返回 + wire + `[0.6.0]` | ✅ | – | ✅ | S | 中 | "重复写入不再静默"是用户可见行为变化；计数≠置信度 |
| **G-A7** `fact_sources` + 反向溯源 | 迁移（新表 + 索引）+ 契约 `source_ref` 参数 + `admin detail`/`recall` 过滤 | ✅ | – | ✅ | M | 中-高 | 覆盖率依赖调用方；必须在 `stats` 如实报占比 |
| **G-A8** 受约束实体类型 + 校验 | 契约 `entity_types` + `entities.entity_type` 语义 + 重扫 + `[0.6.0]` | ✅ | – | ✅ | M | 中 | 语义变更用户可见；类型必须**可选** |
| **G-B1** 写侧显式结构参数 | 契约 + MCP + CLI + client 四处派生 + 形状断言 | ✅ | ✅ | ✅ | M | 高 | 覆盖率依赖调用方；引擎不得"猜" |
| **G-B2** 矛盾判定交写侧 + 确定性失效 | 复用 A1/A2 的列；`contradicts/replaces` 参数 | – | – | – | S | 高 | 误判传播 ⇒ 需要 `stats` 计数 + 回滚入口 |
| **G-B3** 主题聚簇（模板渲染，不合成） | 迁移（scope/水位线）+ 渲染 + 只读面 | ✅ | –/✅ | ✅ | M-L | 中 | 顺序敏感 ⇒ 必须钉死确定性遍历序；不作检索一等对象 |
| **G-B4** `facts.attributes`（写侧给、白名单、尺寸帽） | 迁移 + 契约 | ✅ | – | ✅ | S-M | 低-中 | 退化成垃圾抽屉；不建索引、不排序 |
| **G-C1/C2/C3** | — | — | — | — | — | — | **不适用**（图库专属 / 多后端抽象 / 多租户服务面） |
| **N1–N5** | — | — | — | — | — | — | **明确不采纳**（见 §4 表） |

**固定税提示**（沿用 `IMPROVEMENT_IMPACT_ANALYSIS.md` §1）：本清单里**只有 G-A1/A2/A6/A7/A8 与 G-B1/B3/B4
需要迁移**，应尽量**合并成一次编号迁移**（memory v9→v10），否则会连续抬高单向迁移墙；
**动 41 条冻结数字的只有 G-A3/A4（以及将来的 G-B3 若进检索）**，应串行成批、每批一次重冻 + E0 回归；
**需要 wire bump 的有 A1/A2/A5/A6/A7/A8 + B1/B3/B4**——它们应共享**一次** `WIRE_VERSION 2→3`，
而不是每人一次。

---

## 6. 文档声称 vs 实现不符

**核查范围**：`README.md`（711 行）、`CLAUDE.md`（181 行）、`graphiti_core/**` 的 docstring 与注释、
`mcp_server/README.md`、`server/README.md`、`spec/driver-operations-redesign.md`。
**结论**：**有**，7 条；其中 §6.1–6.3 会直接影响"该不该借鉴"的判断，§6.4–6.7 是能力/口径层面的偏差。

| # | 位置 | 声称 | 实现事实 | 判定 |
|---|---|---|---|---|
| **6.1** | `README.md:123-124`、`CLAUDE.md:13` | "**Prescribed & Learned Ontology**: define entity and edge types upfront (prescribed), or **let structure emerge from your data (learned)**. Start simple, evolve as patterns appear." | 全仓 grep 不到"发现/学习/持久化新类型"的实现：类型只是每次 `add_episode` 传入的 `dict[str, type[BaseModel]]`（`graphiti.py:1053-1057`），模型回 `entity_type_id`，越界回落 `Entity`（`node_operations.py:301-306`）。**"learned" 没有任何代码对应物** | 〔文档声称〕无实现 |
| **6.2** | `README.md:119-120`、`graphiti.py:1625-1626` docstring | "When information changes, old facts are invalidated — not deleted. **Query what's true now**, or what was true at any point in time."；docstring 另有"The search is performed using **the current date and time as the reference point** for temporal relevance." | 默认检索**不排除** `expired_at`：`SearchFilters` 四个时间谓词全默认 `None`（`search_filters.py:55-67`），core 默认路径传空 `SearchFilters()`（`graphiti.py:1639,1684`），MCP 的 `search_memory_facts` 只在调用方显式给日期串或 `edge_types` 时才造过滤（`mcp_server/src/utils/type_config.py:163-194`），**且没有暴露 `expired_at is null` 这种"当前成立"谓词**。全仓（含 server/mcp/examples）grep 不到任何 `expired_at IS NULL` 默认过滤 | 〔文档声称〕与实现不符（含"当前时间作为参照"的 docstring 无对应代码） |
| **6.3** | `README.md:127-128`、`CLAUDE.md:12` | "Hybrid Retrieval: combines semantic embeddings, **keyword (BM25)**, and graph traversal" | 关键词腿调用的是**后端的全文索引**：Neo4j `CALL db.index.fulltext.queryRelationships("edge_name_and_fact", $query)`（`graph_queries.py:175`）、FalkorDB `db.idx.fulltext.*`、Kuzu `QUERY_FTS_INDEX`（`:169,173`）。graphiti **自己不算 BM25**；唯一的"BM25"字样是批量路径的注释"Approximate BM25 by checking for word overlaps"（`bulk_utils.py:518`）。枚举名叫 `EdgeSearchMethod.bm25`（`search_config.py:34`）不代表打分是 BM25 | 〔文档声称〕措辞不准（打分由 Lucene/后端 FTS 决定，不可移植） |
| **6.4** | `README.md:119` + `bulk_utils.py:559` | "old facts are invalidated — not deleted" | 批量写入路径**明确不追踪失效**：`add_episode_bulk` 的 `dedupe_edges_bulk` 里注释 "**For now we won't track edge invalidation**"，`resolve_extracted_edge` 返回的 `invalidated_edges` 被丢弃（只用 `duplicates`，`bulk_utils.py:559-579`） | 〔代码事实〕实现内的显式缺口（不是 README 的错，但"自动失效"对 bulk 不成立） |
| **6.5** | `community_operations.py:97` 注释 | "Ties are broken by going to the **largest community**" | `:121` 是 `new_community = max(community_candidate, curr_community)` —— 按**社区 id 的数值大小**选，不是按簇规模 | 〔文档声称〕注释与实现不符 |
| **6.6** | `search_utils.py:1870` 注释 | `episode_mentions_reranker` 里写 "Find the shortest path to center node" | 该函数的查询是 `MATCH (episode:Episodic)-[:MENTIONS]->(n:Entity) RETURN count(*)`（`:1871-1898`）——没有 center node、没有路径。注释是从 `node_distance_reranker` 复制过来的陈旧的 | 〔文档声称〕注释陈旧（不影响行为） |
| **6.7** | `CLAUDE.md:14,70`、`README.md:159` | "Integration with **Neo4j and FalkorDB** as graph storage backends"；"`driver/` - Database drivers for Neo4j and FalkorDB" | 代码里 `GraphProvider` 有 **4** 个：`NEO4J/FALKORDB/KUZU/NEPTUNE`（`driver/driver.py:59-64`），且有对应的 4 套 operations 目录；README:159 的安装要求也列了 Neptune/Kuzu（且标 Kuzu deprecated） | 〔文档声称〕落后于实现 |

**另外两处派单简要的预期 vs 仓库事实**（不计入上表，供参考）：`spec/` 只有
`driver-operations-redesign.md`（不是本体/类型规范）；`graphiti_core/migrations/` 是 **0 字节的空包**
（不存在模式迁移机制，索引靠 `IF NOT EXISTS` 幂等建，`graph_queries.py:70-81`）。

---

## 7. 与在办路线的关系 + 建议批次

| 在办项 | 本分析的关系 |
|---|---|
| **E0 真实形状评测集** | **前置**。G-A3/A4 一定会动实体袋（进而动 entity leg 的 Jaccard）；G-B3 若进检索会新增候选。没有 E0，"实体归并到底有没有用"无法归因——而这条很可能**本来就该是 0**（先 spike，见 §4-G-A3 风险）。 |
| **A6 逐臂信封** | **本清单的 G-A5 就是它**，不新开车道。graphiti 的增量只有"平行数组 + merge 只拼接"这一条设计注记，用来提醒**跨库 router 合并前必须带走各腿分**（`store/hybrid.ts:481-503`）。 |
| **L2 重写「≥2 条腿」** | graphiti 的 RRF 是**反向证据**：名次融合会把单腿强命中与单腿偶然命中拉平（§4-N1）。mem 继续走"绝对门槛 + 证据定序"。 |
| **F4 FTS 分数** | 与 G-A1/A2 无耦合；graphiti 的"关键词腿只是后端 FTS 的分数"（§6.3）说明**不要指望从它那里抄到打分公式**——F4 要自己定。 |
| **B1 写侧显式结构化** | 本清单的 **G-B1 就是它**；**G-A1/A2/A6/A7/A8 是它的"接收端"**：先把列与读面建好（零 LLM 可先做），B1 才有地方落。顺序上 **A1/A2/A6/A7/A8 先于 B1**，否则 B1 的字段无处可写。 |
| **A1 写侧密钥守卫 / A11 提示词** | 与本清单无耦合，可任意穿插（`HINDSIGHT_COMPARISON.md` §5 已定优先级）。 |

### 建议批次

| 批次 | 内容 | 迁移 | wire | 并行/串行 | 验收 |
|---|---|:--:|:--:|---|---|
| **0** | **先做 G-A3 的离线 spike**（真实库上统计实体名近重复比例、`aliases` 死列的可复用性）；**不动代码** | – | – | 可与批次 1 **并行** | 产出一张"命中率 / 会变的实体袋规模"表；若命中率 ≈ 0 ⇒ G-A3/A4 **降级为不做**并记录 |
| **1** | **G-A5（=在办 A6）**：逐腿分 + `final` 进信封 | – | ✅（`WIRE_VERSION 2→3`） | **必须先行**（其余动分项的验收前提） | 非自指查询**候选/顺序/分数逐字节不变**，只多字段；两个 wire spec 更新；kb 对照 |
| **2** | **一次迁移窗口**：G-A1 + G-A2 + G-A6 + G-A7 + G-A8（+ G-B4 的 `attributes` 若同批）合成 **memory v10** | ✅ | ✅（**若与批次 1 同一个发版窗口落地，则共用那一次 `2→3`；若批次 1 已单独发过，这里要 `3→4`**——不要在同一版本里 bump 两次，也不要少 bump 一次） | 串行（同一批迁移） | 默认检索候选/顺序/分数逐字节不变；`db_upgrade_parity` 全覆盖；`stats` 如实报 `assert_count`/`sources` 覆盖率 |
| **3** | **G-B1 + G-B2**：写侧结构参数 + `replaces/contradicts` 落到 G-A1/A2 的列 | –（复用） | –（复用） | 串行在批次 2 之后 | 冻结集重冻 + 解释（若新结构参与检索）；`contradict_resolve` 后 `valid_to/superseded_by/archive` 三者一致；回滚入口可用 |
| **4** | **G-A3 + G-A4**（**仅当批次 0 的 spike 支持**） | – | – | 串行（一次重冻） | 重冻 + 解释；事故 fixture（单腿强命中）不退化；两 store + 一次性 kb 对照（`extract.ts` 是共享面） |
| **5** | **G-B3**（主题聚簇 + 模板渲染，只读面） | ✅ | ✅ | 可与批次 3/4 **并行**（不同枢纽：不碰 `hybrid.ts`） | 确定性顺序钉死（按 `entity_id` 升序）；重算两次结果逐字节一致 |
| — | **N1–N5、G-C1/C2/C3** | — | — | **不做** | 本文件 §4 已写明理由 |

每批收口：**快档**（该树 build + typecheck + 全套测试 + guard + 自测）；涉及 base/接口/发布面时升级到**发版档**；
用户可见改动进 `[0.6.0]`（先 `pnpm version:set mem 0.6.0`，且 `[Unreleased]` 保持为空）。

---

## 8. 一句话总结

Graphiti 值得借鉴的**不是"它的检索更准"**（那来自写侧 LLM 抽取 + 可插拔 rerank，mem 刻意都不做），而是它在
**双时间与失效语义、确定性实体去重（MinHash/LSH/并查集）、逐结果证据信封、episode 溯源与反向溯源、
受约束类型校验**上沉淀出的**可分离机制**——其中 8 条**不需要 LLM、不需要图库**，且多数能与当前路线图
（E0 / A6 / B1）**合并成同一条车道**。同时它在三件事上**明显不如 mem**：**遗忘与生命周期**、
**版本化派生溯源**、**绝对门槛与弃答**——借鉴时守住这三处；它的图库专属索引/遍历、多后端抽象与
多租户服务面则**完全不适用**，不要因为"框架里有"就搬。
