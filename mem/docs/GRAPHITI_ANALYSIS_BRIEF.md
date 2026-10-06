# 派单简要：graphiti 对照分析（交付一份文档）

> 本文是**派单用简要**，不是交付物。执行者：按本文做完后，交付物只有一份文档
> `mem/docs/GRAPHITI_COMPARISON.md`。**不要**改任何代码、配置、CHANGELOG，也**不要**改 mem 现有的四份文档。

## 0. 目标

读懂 `/home/ffeng/sources/graphiti`（getzep/graphiti，时序知识图谱框架，Python，MIT/Apache 见仓库），
回答一个问题：**对本仓的记忆插件 `@avantf/dsh-mem`（`mem/` 子树）来说，graphiti 有哪些可参考、可落地的优化？**

结论要**可分档、可排期、可验收**，而不是综述。

## 1. 输入

- 目标仓库：`/home/ffeng/sources/graphiti`（**只读**）。关键目录：`graphiti_core/`（`search/`、`models/`、
  `prompts/`、`driver/`、`embedder/`、`cross_encoder/`、`migrations/`、`namespaces/`）、`server/`、
  `mcp_server/`、`spec/`（本体/类型规范）、`tests/`、`examples/`、`README.md`、`CLAUDE.md`、`AGENTS.md`。
- 本仓对照物：`mem/`（引擎 `mem/packages/core`、契约 `mem/packages/contract`、检索内核
  `mem/packages/retrieval-core`、插件 `mem/packages/plugin`）。
- **格式与纪律模板（先读这三份，照着写）**：
  - `mem/docs/HINDSIGHT_COMPARISON.md` —— 结构（系统画像 / 优势 / 不该丢的优势 / A-B-C 分档借鉴 / 文档声称 vs 实现不符）；
  - `mem/docs/IMPROVEMENT_IMPACT_ANALYSIS.md` —— 影响评估的符号与维度（迁移 / 动冻结数字 / wire / 规模 S-M-L / 价值）；
  - `mem/DESIGN.md` 与 `mem/docs/SELF_QUERY_RELEVANCE.md` —— mem 的检索与门槛设计（读它们才知道哪条建议装得进去）。

## 2. 交付物结构（必须齐全）

`mem/docs/GRAPHITI_COMPARISON.md`，章节：

1. **系统画像**：graphiti vs mem（可把 hindsight 作为第三列，一行一条）。
2. **graphiti 真正的优势**：每条带 `文件:行号` 证据；**逐条标注**是「代码事实」还是「文档声称」还是「推断」。
3. **mem 不该丢的优势**（对照后明确写出，避免借鉴时拆掉自己的地基）。
4. **可借鉴清单**，按能否在 mem 约束下落成分三档：
   - **A 档**：不需要 LLM、不需要图数据库，可直接做；
   - **B 档**：需要 LLM —— 给出"由写侧调用方模型显式提供结构"的等价形态；
   - **C 档**：不适用（多租户 / 专业图库 / 规模问题）。
   每条写清四件事：**机制是什么 → graphiti 证据 → mem 的落地形态 → 成本与风险**。
5. **影响评估表**：沿用 `IMPROVEMENT_IMPACT_ANALYSIS.md` 的符号（迁移 ✅/–、动 41 条冻结数字 ✅/–、
   wire ✅/–、规模 S/M/L、价值高/中/低）。
6. **文档声称 vs 实现不符**清单（README/CLAUDE.md 说了但代码里没有的，逐条列出）。
7. **与在办路线的关系**：与 E0 评测集、A6 逐臂信封、L2 重写、F4 FTS 分数、以及"写侧显式结构化（B1）"的先后与依赖；
   最后给一个**建议批次**（哪些可并行、哪些必须串行）。

## 3. 必须核实的重点（graphiti 的卖点，逐条查代码，不要转述 README）

- **双时间模型与边失效**：`valid_at` / `invalid_at`（事件时间）与 `created_at` / `expired_at`（系统时间）如何存储、
  何时写入、检索时如何用；新事实与旧事实冲突时"失效旧边"的具体机制（是 LLM 判定还是规则）。
- **混合检索**：`graphiti_core/search/` 里 cosine + BM25 + BFS 图遍历如何组合、用什么融合（RRF？权重？k 值？）、
  reranker 有哪些（MMR / node distance / episode mentions / cross-encoder）与默认顺序。
- **实体与边的去重/消解**：重复实体如何合并、边冲突如何判定、是否有"边失效 + 新边建立"的历史保留。
- **社群检测与摘要**：算法（如 label propagation）、何时重算、摘要如何进入检索。
- **本体**：`spec/` 与 `graphiti_core` 的"prescribed vs learned ontology"是什么；自定义实体/边类型如何传导到抽取与检索。
- **溯源**：episode（原始输入）与节点/边的关系；检索结果里能不能拿到出处。
- **抽象与降级**：`driver/`、`embedder/`、`cross_encoder/`、`llm_client/` 的可插拔接口与"缺省降级"行为。
- **存储依赖**：Neo4j / FalkorDB / Kuzu 等，各自的索引（全文、向量）怎么建——**明确哪些是图库专属、SQLite 无法平移**。

对每一条都要回答一句：**"零 LLM、单文件 SQLite 的 mem 能搬到哪一层？"**（能搬机制 / 只能搬设计约束 / 完全不能搬）。

## 4. mem 的硬约束（判断"可落地"的依据）

- 引擎**零 LLM**（写读都不调生成式模型）、**离线**、数据不出 `~/.avantf`、零运行期依赖、`zod` 只做 required peer。
- **单文件 SQLite**；FTS5（trigram；`facts_fts` 是 external-content 表）；向量在本地 vstore（**1 fact = 1 vector** 是硬身份）。
- **模式迁移单向**（DB 由更新版本建过则旧 build 拒绝启动）；**wire 有版本号**（当前 2）；
  工具面**恰好 8 个**；契约 `@avantf/mem-contract` 是唯一真源。
- **41 条中文冻结评测集是精确断言**：任何动候选/分数/被索引文本的改动都要重冻 + 解释。
- **共享层**：`entities/extract.ts` 与 `store/hybrid.ts` 被 memory 与 knowledge 两个 store 共用，而 **kb 没有评测网**。
- 用户可见改动要进 `[0.6.0]`（0.5.0 已发布，`[Unreleased]` 必须为空）。

## 5. 纪律

- graphiti **只读**；mem **只写交付物这一份文档**。
- 引用一律 `路径:行号`；不能核实的写"未能验证"，**不要猜**。
- 禁止把 README/论文的宣传当事实；发现不符要单列（第 6 节）。
- 每条建议必须给出**mem 侧的落地形态**与"会不会移动冻结数字 / 要不要迁移 / 要不要动 wire"，否则不算完成。
- 不实现任何改进；不跑服务、不装依赖、不跑测试套件（允许只读的 grep/读文件/统计脚本）。

## 6. 验收

1. `mem/docs/GRAPHITI_COMPARISON.md` 存在，七节齐全。
2. A/B/C 三档合计 ≥ 8 条建议，每条含"机制 / 证据 / mem 落地形态 / 成本风险 / 影响评估"五项。
3. 至少 **3 条明确"不采纳"**并给出理由（证明不是无差别搬运）。
4. "文档声称 vs 实现不符" ≥ 3 条（若确实没有，写明核查范围与结论）。
5. 所有引用行号可在 `/home/ffeng/sources/graphiti` 中复核；标注了三档证据强度。
6. 没有修改 `/home/ffeng/sources/graphiti` 或本仓任何代码/配置/CHANGELOG。
