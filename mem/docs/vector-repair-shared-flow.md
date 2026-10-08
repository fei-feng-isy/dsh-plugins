# 向量自愈：把"修复"做成两库共用的模板流程

> 本文件是一项**实施规格**（派单方写给执行者）。它记录缺口、设计要求与验收标准；实施完成后，
> 结论应回写进 `DESIGN.md`（见 §5），本文件可以留在仓库里作为决策记录。

## 1. 缺口（有证据，不是猜测）

换嵌入空间（默认模型 / 宽度 / 池化 / 归一化 / 输入窗口 / 权重）= **一次数据迁移**：库存里的
`semantic_vector` 属于旧空间，语义腿会**静默跳过**它们。仓库对这件事的要求是硬的
（`AGENTS.md` 的 mem 段）：

> 换空间必须**检测 + 响亮告警 + 有界后台自愈**（分批、可续跑、不阻塞查询、可关闭；手动入口
> `vectors --fix`）；测试必须**复刻真实形状**（库里放旧维向量再上新模型，断言自愈后语义腿重新命中）。

现状：**只有 memory 满足这条**。

| 环节 | memory | knowledge |
| --- | --- | --- |
| 空间 id / 指纹（`store/common.ts` `vectorSpaceOf`） | 共用 | 共用 |
| 检测 + 响亮告警（`common.ts:96` `reportStaleVectors`） | 共用 | 共用 |
| 批处理/让出工具（`common.ts:130/151`） | 共用 | 共用 |
| **有界后台自愈** | `MemoryStore.repairVectors`（`store/memory.ts:1037`）+ `migrateVectorsBatch` / `migrateVectors` / `migrationRemaining` | **无**（只有手动 `reindex`，`store/knowledge.ts:1291`） |
| 后台驱动 | `plugin/src/vectorMigration.ts:52/75` 只调 `rt.memory.*` | 完全不涉及 |

后果（本机实测）：512→768 换模型后，memory 的 92 条 active 在启动期自动迁完
（`mem_admin stats` → `vectors.stale = 0`），而 knowledge 的 21 条 `doc_chunks` 一直停在 512 维，
语义腿对它们失效，**只有人恰好去跑 `kb_reindex` 才会修**。客户端横幅（
`plugin/src/client/index.ts:896`）却已经写着"正在后台分批重算"——那句话目前只对一半的库成立。

这条缺口是**记录在案**的，不是漏改：`store/knowledge.ts:346-349` 的注释写着 "there is no automatic
background migration for the knowledge store **yet**"，`DESIGN.md:507` 把它列为"已知边界"，理由是
"`kb_reindex` 还兼做 FTS/实体重建，不适合无脑后台跑"。本任务要做的正是把它从"已知边界"变成"已覆盖"。

## 2. 设计：模板方法语义，用组合实现（**不要**抽象基类）

**分层事实**（决定了共用应该落在哪一层）：

```
① 机制层  db/port.ts（interface Db）+ db/sqlite.ts（唯一实现）+ db/chunk.ts batches()/inList()
          —— 一份，已共用；DAO 依赖端口、实现注入
② 聚合层  db/dao/*.ts（facts/entities/triples/contradictions/stats/fact_sources | documents/chunks）
          —— 按【聚合】分，不按【库】分；只写本聚合的 SQL 与行映射
③ 编排层  store/*.ts（分块/抽实体/编码/融合/打分/**自愈**）—— 自愈编排目前只在 memory  ❗缺口
```

**要求**：把 ③ 层的自愈流程**固化成一个共用流程函数**，两个 store 只实现原语（关键方法）。
这就是模板方法模式的语义（骨架固定、步骤可替换），但**载体必须是组合**：

- **不要**引入 `MemoryStore` / `KnowledgeStore` 的共同抽象基类。两库本来就没有共同基类
  （`store/memory.ts:286` / `store/knowledge.ts:254` 各自独立），构造、DB、DAO、表全不同；
  为模板方法造基类等于在两个 hub 文件上做结构性改造，违反 `AGENTS.md` 的"不为变小做整体重构 /
  hub 最后动"。
- **要**沿用 `store/common.ts` 已确立的既有风格：**共用自由函数 + store 提供的原语**
  （该文件里只有导出函数与 interface，零 class）。
- 模板的"步骤"用**一个 adapter 接口**表达（下面的契约），流程本身写成导出函数。测试可以喂
  **假 adapter** 直接验边界（批次 / 停止 / 无进展），这正是这种载体的好处。

### 2.1 共用流程持有（**只能有一份**）

- 批次循环、`limit`/`batchSize`、每批之间 `yieldToEventLoop()`
- `shouldStop`（插件卸载 / runtime 关闭）、`onProgress`、`remaining` 计算
- **顺序不变量**：先让不可用向量离场（清字节 / 从活索引 evict）→ 再编码写回 → 写回同时进活索引
- 模型预热策略：显式修复（`dry_run: false` 且调用方是操作者动作）可以**等**模型；后台不等
- **"本批没有进展 ⇒ 停这一趟，留给下一次心跳重试"**（不要原地打转）
- `semantic.auto_migrate === false` 时：一条警告、零改动（手动入口仍可用）
- `dry_run`：只报告不写
- 日志：**每条日志带库名**，措辞与现有 `plugin/src/vectorMigration.ts` 的 info/progress/complete/
  no-progress 四类保持一致

### 2.2 store adapter 实现的原语（关键方法）

```ts
interface VectorRepairTarget {
  readonly store: 'memory' | 'knowledge'
  vectorSpace(): string
  /** { stale, space_stale, legacy? } —— 与 common.ts:53 的 StaleVectorCounts 同形 */
  vectorSpaceHealth(): StaleVectorCounts
  /** 要离场的 id（宽度不符 / 记录空间非当前）与要重编码的行；limit 生效 */
  classifyVectors(limit: number): VectorsClassification
  /** 清掉不可用字节；返回真正清掉的条数。knowledge 若用覆盖写可返回 0 */
  dropVectors(ids: readonly number[]): number
  /** 编码并写回（含进活索引）；返回 encoded/failed。逐行隔离编码与写入失败 */
  reencodeVectors(limit: number): Promise<{ encoded: number; failed: number }>
  /** 可选：显式修复时等模型就绪 */
  warmup?(): Promise<boolean>
}
```

映射到现有实现：

- memory：`classifyVectors`（已在 `store/memory.ts:974`）、`vectorSpaceHealth`（`:426`）、
  `facts.clearVectors` + `evictVectors`、`facts.missingVectorRows` + `setSemanticVector`
  —— 基本是把 `repairVectors`（`:1037`）**机械地**拆成这些原语，行为与既有断言一字不变。
- knowledge：`vectorSpace`（`:942`）已有；`vectorSpaceHealth` 从 `reloadIndex()` 的**内联计数**提出；
  `reencodeVectors` 复用已分好批的 `encodeAndStore`（`:889`，它已按 `WRITE_BATCH` 分批、逐块隔离失败、
  返回 `encoded/failed`）；**不得**调用 `reindex` 里的 FTS/实体那两步。

### 2.3 **留在 store、不许上提**的领域差异（这是正确的差异，别统一掉）

- memory 写向量会 `conflict_checked = 0`（矛盾检测的嵌入腿依赖向量，向量换空间 ⇒ 旧检查作废）；
  knowledge 没有矛盾语义。
- knowledge 的向量有效性还多一维**内容哈希**（`vectorReusable`：`content_hash === contentHash(text)`），
  因为块的正文可被重新摄入原地替换；事实改内容是**新修订**，不是原地改。
- memory 有 `hrr_vector` 列与 HRR probe 腿；knowledge 的腿是 FTS + 语义 + 实体。
- DAO 调用（`facts.*` ↔ `chunks.*`）、活索引 evict 的具体对象。
- 报告里的破坏性步骤：memory 有 `dropped`，knowledge 通常为 0。

**判据一句话**：差异只允许存在于"领域语义 / 数据形状"；凡是"同为向量资源的同一条不变量"
（宽度/空间判据、离场、批处理、让出、停止、续跑、预热、报告口径）**只能有一份实现**。

### 2.4 驱动与手动入口

- `plugin/src/vectorMigration.ts` 改成**遍历两个 store**（memory、knowledge 各跑一趟，或各跑一批；
  自选更简单的一种并说明），一个 `semantic.auto_migrate` 同时管两库。
- `mem_admin vectors_fix`：**覆盖两库**，新增可选 `store: 'memory' | 'knowledge'`（省略 = 两库），
  `dry_run` 语义不变。**报告改为分库结构**（例如 `stores: { memory: …, knowledge: … }` + 共享字段
  `semantic_available` / `dry_run`），公共子集为
  `{ stale, space_stale, dropped, encoded, failed, semantic_available }`，各库可带自己的补充字段
  （memory 的 `missing`/`unindexed`/`would_warm` 保留）。**这是工具面语义变化**：契约类型、
  `runtime.ts` 分派、**CLI**（`cli/src/index.ts:332` 的 `vectors --fix` 输出）与相关测试都要同步改；
  client 半边**不消费**该报告（只读 `stats.vectors`），无需改。
- `kb_reindex`：**语义不变**（FTS + 实体 + 向量，手动重入口）。自动的只做向量那一半——这正好化解
  `DESIGN.md:507` 给的理由。

### 2.5 硬要求：不许留下"改一边、另一边也要改"的结构

- 流程只能在共用模块里存在一份：批次常量、`yieldToEventLoop` 调用、停止/续跑/无进展规则、
  `auto_migrate` 判断、dry-run 分流**都不得**出现在 `store/memory.ts` / `store/knowledge.ts` 里。
- **证明方式（必须做）**：加一个测试，用一个**第三人造 adapter**（假 store）驱动同一个共用流程，
  断言批次/停止/无进展/remaining 语义成立。它证明"新增一个库只需要写 adapter，不需要改流程"。
- 两个 store 的原语测试各自独立，但**不许**复制流程的测试意图（批次/停止等只在共用流程的测试里测）。

## 3. 验收标准

1. `memory` 既有四个用例（`core/test/vector_migration.spec.ts`：有界批次 / `auto_migrate:false`
   变异守卫 / 同宽模型替换 / 重启可续跑）**全绿且断言不变**（允许必要的构造方式调整，但断言的
   语义与数值口径不得放宽）。
2. **knowledge 版同形四例**（新增 `core/test/knowledge_vector_migration.spec.ts` 或并入既有文件）：
   ① 旧**维**向量 → 告警一次 → 自愈后语义腿重新命中那些块；② 同宽异空间（另一个 model 串）→
   同样被抓到并自愈；③ `semantic.auto_migrate: false` → 只告警、零改动（变异守卫）；④ 迁移中途
   重开 runtime → 从数据库续跑。fixture 用**旧维向量**（512 字节×2 的 BLOB 或 2048 字节）贴合真实形状。
3. **假 adapter 测试**：共用流程被第三人造 adapter 驱动，边界语义成立（§2.5）。
4. `vectors_fix`：两库默认 + `store` 过滤 + `dry_run` 各有断言；报告分库字段齐全。
5. `pnpm -C mem build && pnpm -C mem typecheck && pnpm -C mem typecheck:dsh` 全绿。
6. 文档：`DESIGN.md:507` 的"已知边界"改为"已覆盖"（写清两库共用流程、`kb_reindex` 仍是 FTS/实体
   重入口）；`AGENTS.md` 由**派单方**在收口时同步（那份文件当前有用户未提交的改动，执行者**不要**碰）。
7. **不要**动版本号与 CHANGELOG（`version:set` / 版本段由派单方在发版时处理）。

## 4. 验证分工（本仓纪律）

- 执行者**只做针对性验证**：`pnpm -C mem build`（typecheck 依赖产出的 `lib/*.d.ts`，必须排在前面）
  → `pnpm -C mem typecheck` → `pnpm -C mem typecheck:dsh` → **只跑新增/改动的测试文件**；
  报告"实际跑了什么 / 每个测试证明了哪条要求 / 有哪些没能验证"。
- 执行者**不要**跑：`pnpm check:fast` / `check:release` / `check:old-dsh` / `pack:plugin` / mount smoke
  —— 收口分档由派单方统一跑。

## 4.5 同批要收敛的其它"两份实现"（派单方审计结果，2026-10-08）

用户要求：**凡是可共用的业务流程都收敛成一份实现**，不是只做自愈。以下是逐组实测（`store/` 两文件对照
+ 逐行归一化 diff），按实施顺序排列。**每个阶段都适用上面的设计纪律**（组合式模板、流程只能有一份、
不引入基类、领域差异留各 store、第三人造 adapter 证明、不改版本/CHANGELOG/AGENTS.md）。

### 阶段 1（本文件 §1–§3）：向量自愈 + 打开即健康

`reloadIndex()` 也是两份：memory（`store/memory.ts:399`，12 行归一化）与 knowledge（`store/knowledge.ts:342`，
20 行）**流程同构**——`vectorCachePath` → `reloadVectorIndex` → 统计同一个 `{stale, space_stale, legacy}`
三元组 → `reportStaleVectors`，差别只在"读哪些持久化行"与告警文案里的手动入口名。它正是
`vectorSpaceHealth()` 的数据来源，所以与自愈同批收敛：**装载 + 健康统计 + 告警**一份实现，
per-store 原语 = 读本库的持久化向量行。

### 阶段 2：编码写回（encode → 进活索引 → 持久化 + 记空间）

- memory：`maybeIndexSemantic`（`store/memory.ts:535`，27 行，单行版；失败分两类并各自告警）
- knowledge：`encodeAndStore`（`store/knowledge.ts:889`，46 行，按 `WRITE_BATCH` 分批、逐行隔离、报 `encoded/failed`）
  + `indexChunks`（`:801`）

**同一流程两份形状**：编码一行 → `vstore.add` → 写回 `(bytes, space)`。收敛为一份"批量编码写回"原语，
per-store 提供"读要编码的行 / 写一行向量（含本库副作用）"。**留在各 store**：memory 的
`setSemanticVector` 会 `conflict_checked = 0`（矛盾重排）、knowledge 的 `content_hash` 复用与 `failed` 计数。

### 阶段 3：实体版本清扫（select stale → extract → 写行 → 升版本）

- memory：`reindexEntities`（`store/memory.ts:1272`，31 行；`entitySweepInFlight` 守卫、`budget`、
  `{rebuilt, deferred, skipped}` 报告、`tagText`+`triplesFromTokens`+HRR+`requeueConflictCheck`）
- knowledge：`replaceChunkEntities`（`store/knowledge.ts:962`，8 行）**加上**散在 `reindex`（`:1291`）里的
  stale 选择与 `setEntitiesVersion`

**同一骨架**：按 `entities_version != ENTITY_EXTRACTOR_VERSION` 选行 → 逐行抽取并写行 → 批量升版本 →
报告"重建了多少 / 还剩多少"。收敛为一份清扫循环（含 in-flight 守卫与 budget），per-store 原语 =
"一行文本 → 要写的实体/三元组行 + 本库副作用"。**留在各 store**：抽取器与写行内容（memory 的三元组 +
HRR + 矛盾重排；knowledge 的 `chunk_entities`）。

### 阶段 4：检索腿的构造与地板（**纯结构抽取，行为逐字节不变**）

- memory：`searchLegs`（`store/memory.ts:1423`，54 行归一化）
- knowledge：`searchLegs`（`store/knowledge.ts:1412`，35 行归一化）

逐行对照后**确认为同一骨架写了两遍**：`leg()` 包装的 `capped: (raw ?? scores).size === ctx.legCap`
语义、`applyTermFloor`/`applyScoreFloor` 的应用次序、"语义后端不可用 → 等权空腿 + `droppedByFloor: 0`"
的回退，连解释注释都是同一段话。差异全在**腿的集合与候选来源**（memory 有共享的锚点/候选集、
`hrrPath`、`timeWindowPath`；knowledge 的 jaccard 是查询驱动的异步腿）。

收敛为一份"腿运行器"（腿包装/上限信号/地板应用/并发等待/回退），per-store 提供"腿清单 + 文本读取 +
候选来源"。**硬约束（AGENTS 明写）**：这是纯结构抽取，**行为必须逐字节不变**——
`core/test/eval_zh.spec.ts` 的冻结数字、每腿 `leg`/`capped`/`droppedByFloor` 标签、
`RecallResult.weights` 的三键契约、以及"并集不收窄 / 非自指查询逐字节不变"三样都要有证据。

### 阶段 5（小件，可并入任一阶段）

`evictVectors` 在两侧各是一个 3 行包装（`store/memory.ts:1318` / `store/knowledge.ts:740`），直接调
`common.ts:70` 的共用函数即可，包装可删；`vectorSpace()` 两侧已同形，不必动。

#### 阶段 6：检索入口的选项组装与结果投影（两 store，编排层）

`memory.search`（`store/memory.ts:1360`）与 `knowledge.search`（`store/knowledge.ts:1340`）把入参映射成
`hybridSearch` 的选项对象时**逐字相同**：同样的字段清单、同样的
`...(x === undefined ? {} : { x })` 转发写法、同样的调用形状；差异只有三处（memory 不显式传
`overFetch`、memory 把结果投影成 `RecallResult` 的字段子集、knowledge 多一个 `opts.onResult`）。

**这不是吹毛求疵，仓库自己已经记过事故**：`knowledge.hybridDeps` 的注释写着——"They used to be copied
here, and **every fix landed on the memory side only** — a `NaN` limit reached this store's SQL and took the
whole cross-store query down with it, `retriever.over_fetch_factor` meant something different per store, and a
capped knowledge leg was invisible to the health counters."（`store/hybrid.ts` 就是那一次收敛的结果。）

收敛目标：**"入参 → HybridOptions"的映射与 hybrid 调用只写一份**（放 `store/hybrid.ts` 或 `store/legs.ts`），
per-store 只给差异字段（`overFetch` 来源、结果投影、`onResult`/`onReturn`）。
`hybridDeps` 的两份对象字面量可顺手用同一个工厂收敛（收益较低：它本来就是"每库 adapter"，但工厂能把
契约字段集中一处，避免将来加字段漏一边）。

### 阶段 7：DAO 层的**算法与契约**（不是单条 SQL）

逐对量化（Dice on 归一化 3-gram，`db/dao/` 内）后，确认同构且值得收敛的是**算法**：

- **实体候选查询的评分公式与排序契约**：`entities.ts:189 candidateFactsForAnyEntity` ↔
  `chunks.ts:290 candidatesByEntityNames` —— 公式**逐字相同**
  （`CAST(shared AS REAL) / (? + MIN(total - shared, ?)) DESC, total ASC, <id> ASC`），批处理与
  `GROUP BY`/`LIMIT` 同形；差异只有表名、`total` 子查询的表、以及各自的过滤谓词（memory：`status='active'`
  + category + `EXISTS fact_sources`；knowledge：join `documents` + domain/source）。
  **收敛为共用片段/助手**：评分公式、排序次序、批处理循环只写一份；两条 SQL 语句按表保留。
- **`setEntitiesVersion`**：`facts.ts:452` ↔ `chunks.ts:152`，同一条批量 `UPDATE … SET entities_version = ?`
  只差表名与 id 列（一个返回 `changes`、一个返回 void）。收敛为共用助手（表名/列名作参数）。
- **`ftsSubstringSearch`**：两侧同名（18/14 行），同一个"分词器驱动的 LIKE 回退"；收敛批处理与回退逻辑，
  SQL 按表保留。
- **`activeDocFrequency`（`entities.ts`）↔ `docFrequency`（`chunks.ts`）**：同一个"每个名字被多少行承载"的
  查询形状。

**明确不收敛**（写下来是为了让下一个人不必重新判断）：单条语句的 `count*` / `get` / `delete` / `list`
样板（实测相似度高的那些，如 `countAll ↔ count`，相似只是 `prepare().get()` 的样板）。把表名/列名参数化
会把可读性与索引推理一起牺牲，属于 §2 分层里的"聚合层按聚合分"——**不是分叉**。

## 明确**不**收敛（属于领域差异或有意的选择）

- memory 的 HRR 列/腿、`conflict_checked` 重排、信任/寿命/lifecycle 清扫（knowledge 没有这些域）。
- knowledge 的 `content_hash` 复用、文档/路径/`sync`/`corpusDrift`（memory 没有文档层）。
- 每条腿的 cap / `over_fetch_factor` / 门槛常数（语料形状不同，§20 按库标定）。
- DAO 的 SQL（按聚合分，不是分叉——见 §2 分层）。

### 开放问题（报告，不强行统一）

memory **从不** `rebuildFts`，knowledge 在 `reindex` 里调 `chunks.rebuildFts()`。实测两侧的 FTS 都由
触发器维护（`db/schema.ts:224` 的 `facts_ai/ad/au`、`db/knowledge.ts:63` 的 `chunks_ai/ad/au`），所以
knowledge 那次重建是**防御性**的、memory 没有也不缺。若实施中发现它与触发器重复或仍有必要，**报告结论**，
本任务不改这一处行为。

## 4.6 第二轮收敛（本仓配对审计的剩余项）

第一轮把七条流程收敛完之后，`pnpm -C mem audit:flows`（本目录的审计工具）仍报出三处"同一流程两份实现"。
逐对读过之后确认**都是真同流程**，处置如下（纪律与 §2/§4.5 完全一致：组合式模板、流程只能一份、
不引入基类、行为逐字节不变、领域差异留各 store）。

### 4.6.1 `ftsPath` → 共用 `ftsLeg`（放 `store/legs.ts`）

- memory：`store/memory.ts` 的 `ftsPath`（20 行）；knowledge：`store/knowledge.ts` 的 `ftsPath`（14 行）。
- **逐行同构**：`buildFtsQuery(query, ftsTokenizer)`（共用）→ 非空则 DAO `ftsSearch(...)` 取负 bm25；
  否则 `substringTerms(query)`（共用）→ 空则返回空表 → DAO `ftsSubstringSearch(...)` 取 `rank`。
- 差异只有三处：DAO 对象；**scope 参数的形状与顺序**（memory `(category, cap, source)` /
  knowledge `(domain, source, cap)`）；注释长度。
- 收敛形状：`ftsLeg({ query, cap, scope, search, substringSearch })`，两个 store 只传自己的 DAO 与 scope。
  **`-rank` / `rank` 的符号约定、短查询回退、空表语义必须逐字保留。**

### 4.6.2 `semanticPath` → 共用 `semanticLeg`（放 `store/legs.ts`）

- memory：`store/memory.ts` 的 `semanticPath`（21 行）；knowledge：`store/knowledge.ts` 的 `semanticPath`（32 行）。
- **同一流程**：`vec = queryVector ?? encode(query)` → 维度检查（抛 `RetrievalInputError`，两侧文案相同）
  → `onVector?.(vec)` → `vstore.topk(vec, max(50, k))` → 空则返回空表 → **过滤** → 映射 id→score。
- 差异只在**过滤那一步**：memory 总是走 DB 集合查询（`facts.activeIdsIn(ids, category, source)`，
  因为 vstore 不知道 status/archived），knowledge 在无 `domain`/`source` 时**短路跳过过滤**，
  否则取 `chunks.meta(ids)` 逐行比较 domain/source。
- 收敛形状：`semanticLeg({ queryVector, onVector, encode, dim, topk, filterTopk })`，其中
  `filterTopk(ids) => ReadonlySet<number> | undefined`（`undefined` = 全部保留，knowledge 的无 scope 短路
  就用它表达）。**`max(50, k)`、维度错误文案、空 topk 早退、返回 Map 的插入顺序都必须逐字保留。**

### 4.6.3 `bagsForFacts` ↔ `entityBags` → 共用 `entityBags(db, …)`（放 `db/dao/shared.ts`）

- `db/dao/entities.ts` 的 `bagsForFacts`（17 行）与 `db/dao/chunks.ts` 的 `entityBags`（15 行）：
  同一个"按行 id 取实体名袋子、按 `batches()` 分批"的流程。
- 差异两处：SQL 形状（memory 要 `JOIN entities` 取名字；knowledge 直接读 `chunk_entities`）；
  **缺省语义**——memory 先把每个请求 id 种成 `[]`（调用方可假定存在），knowledge 只返回有实体的行
  （调用方用 `?? []` 兜）。
- 收敛形状：`entityBags(db, ids, { table, keyColumn, joinEntities })`，另给 memory 的"种空数组"
  一个显式选项（或由 memory 的薄包装补种）。**两种缺省语义各自保持不变**，用测试钉住。
- `shared.ts` 已有 `entityCandidateTail` / `entityCandidates` / `setEntitiesVersionBatch` /
  `queryDocFrequency` / `likeSubstringLeg`，本项与它们并列，不重复造。

### 验收（本轮）

1. 每一对都必须有**行为等同**的证据：优先像 `core/test/legs.spec.ts` 那样保留一个参考实现做 golden 比对，
   或在测试里对"新旧两条路径"断言 ids + scores + 顺序逐字节相同；
2. 冻结的 `core/test/eval_zh.spec.ts` 数字**原样通过**；
3. 两个 store 里不得再出现 `-r.rank`/`substringTerms(...)` 的成对写法与"种空数组"的循环——
   只允许转发参数与提供 DAO 原语；
4. `pnpm -C mem audit:flows` 重跑后，这三对的分数应落到"薄转发"档（`< FLOW_MIN_LINES` 或
   仅剩参数差异），且不引入新的流程级候选；
5. 不动版本号 / CHANGELOG / 根 `AGENTS.md`；验证分工照旧（执行者只跑 build/typecheck/定向测试，
   收口由派单方跑 `check:fast mem`）。

## 5. 参考坐标（行号可能随相邻改动漂移，按符号名找）

- `mem/packages/core/src/store/common.ts:53` `StaleVectorCounts`、`:70` `evictVectors`、
  `:96` `reportStaleVectors`、`:130` `yieldToEventLoop`、`:151` `forEachYielding`
- `mem/packages/core/src/store/memory.ts:426` `vectorSpaceHealth`、`:974` `classifyVectors`、
  `:1037` `repairVectors`、`:1138` `migrateVectorsBatch`、`:1160` `migrateVectors`
- `mem/packages/core/src/store/knowledge.ts:889` `encodeAndStore`、`:942` `vectorSpace`、
  `:955` `vectorReusable`、`:1291` `reindex`、`:346` 那条"yet"的注释
- `mem/packages/plugin/src/vectorMigration.ts`（整个文件是驱动 + 日志 + 生命周期）
- `mem/packages/plugin/src/index.ts:629` `createVectorMigration` 装配点（`:675` 启动门后、`:696` 心跳）
- `mem/packages/core/src/runtime.ts:200/459` `vectors_fix` 分派；`mem/packages/cli/src/index.ts:329`
  `vectors --fix` 输出
- `mem/packages/core/test/vector_migration.spec.ts`（memory 的四个用例，是 knowledge 版的样板）
- `mem/DESIGN.md:507`（要改的"已知边界"）、`AGENTS.md` 的 mem 段（派单方改）

## 6. 现场验收材料：**不要碰真实数据根**（派单方与执行者都适用）

**硬禁令**：本任务（以及任何测试）**不得**对真实数据根 `~/.avantf` 执行修复、重建或迁移类动作——
特别是 `kb_reindex` / `mem_admin vectors_fix` / `avantf-mem vectors --fix` / `kb sync`（写入类）。
所有测试一律用**临时 dataHome**（仓库既有测试的写法）。

原因：真实库里**刻意留着**一份现场验收材料——

| 库 | 现场状态（2026-10-08 实测） | 功能落地后应当变成 |
| --- | --- | --- |
| `~/.avantf/knowledge/knowledge.db` 的 `doc_chunks` | **21 条**，全部 2048 字节 = **512 维**，`embedding_model = 'local_bge/Xenova/bge-small-zh-v1.5/512'` | **自动**重编码进当前空间 `v2/local_bge/Xenova/bge-base-zh-v1.5/768@p=mean;n=1;w=0`，无需人工 `kb_reindex` |
| `~/.avantf/memory/memory.db` 的 `facts` | 92 条 active 全部已在当前空间（对照物：同一台机器上 memory 早已自动迁完） | 保持不变 |

提前跑一次 `kb_reindex` 会把这份材料**永久变得不再可测**（21 条会被立刻修好，自愈也就无从验证）。

**派单方收口时的现场验收步骤**（任务收敛、门禁绿了之后）：

1. 用本地构建重装 profile 并重启 `dsh web`（host 半边只在 boot 加载）；
2. 观察启动日志：knowledge 应打出"belong to an OLDER embedding space … re-encoding in the background"
   （检测 + 响亮告警），随后是迁移进度/完成行，且**日志带库名**；
3. 复测数据库：`doc_chunks` 的 21 条应变成 3072 字节且 `embedding_model` 等于当前空间；
   `mem_admin stats` 应不再报 knowledge 侧 stale；
4. 反向检查：不重启、也不跑任何手动入口的情况下达成——这正是"有界后台自愈"的现场证据。
