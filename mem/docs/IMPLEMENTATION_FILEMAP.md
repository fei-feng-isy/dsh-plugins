# mem 实施：文件地图与派单建议（执行者用）

> 配套 `docs/IMPLEMENTATION_PLAN.md`（做什么/怎么做/影响/收益）。本文只做一件事：把 12 项**落到文件与函数**，
> 减少实现期的试错。所有行号是 2026-10-06 03:0x 的实测位置，实现时以现场为准。

## 0. 共用落点

| 面 | 位置 | 说明 |
|---|---|---|
| schema 迁移 | `mem/packages/core/src/db/conn.ts` | `{ version, name, up(db) }` 数组，现有到 **v9**；新增即 **v10**（列 + 表 + 索引都写在这一步，且同时写进 base DDL，使全新库从第 1 步就得到） |
| base DDL | `mem/packages/core/src/db/schema.ts` | 新列/新表必须同时出现在这里（既有注释记录了这个"两处一致"的约定） |
| 工具契约（唯一真源） | `mem/packages/contract/src/tools.ts` | `TOOL_SPECS`（`:453`）→ MCP `jsonSchema`（`mem/packages/mcp/src/index.ts:51`）、CLI argv、UI payload 全由它派生；动作联合 `ADMIN_ACTIONS`（`:185`）、`RECALL_ACTIONS`（`:133`） |
| 形状断言 | `contract/test/contract.spec.ts`、`tool_schema.spec.ts` | 任何 schema 变化都要在这里补断言 |
| wire | `mem/packages/plugin/src/remote.ts` | `WIRE_VERSION = 2`（`:267`）+ 顶部逐版记录；strict codec 会**静默丢弃未声明键** ⇒ 新增可选字段必须在对应 `direct(...)` 里声明（`plugin/test/remote_wire.spec.ts` 钉住 `declared ⊇ contract`）。**BUMP RULE：只对新增/删除 `@Remote` 方法与删除被解引用的载荷字段 bump** ⇒ 本方案 12 项都不涉及，`WIRE_VERSION` 保持 2 |
| 写入路径 | `mem/packages/core/src/store/memory.ts` | `add()`（`:422`）、`update` / `applySupersede`（`:1808` 起）、`archive()`、`insertFact` 列清单在 `db/dao/facts.ts:249-256` |
| 检索编排 | `mem/packages/core/src/store/hybrid.ts` | 唯一调用点 `fuse(...)`（`:409`）；腿数/下标契约（`:477-479`）；放宽档重试（`:426-439`） |
| 融合内核 | `mem/packages/retrieval-core/src/fusion.ts` | `scaleByMax`（`:49-60`）、`fuse`（`:68-90`）——**memory 与 knowledge 共用** |
| 腿 | `store/memory.ts:1393-1421`（4 条腿）、`store/entity_leg.ts`（锚点 `selectAnchors:93`）、`store/lexical.ts`、`db/dao/facts.ts`（`ftsSearch` / `ftsSubstringSearch`） |
| 统计载荷 | `mem/packages/core/src/runtime.ts` | `admin.stats` 分支（`:358`，类型 `:143`）；客户端消费在 `plugin/src/client/index.ts:666` |
| 提示词 | `mem/packages/plugin/src/prompt.ts` | 三段正文是**常量**（`MEMORY_PROMPT_SECTION` 等），`PROMPT_FILES`（`:132`）映射到 `<data_home>/prompts/mem-*.md`；**文件优先、内置只是 fallback** |
| 评测 | `mem/packages/core/test/eval_zh.spec.ts` | `:318` 是 `expect(report.summary).toEqual({7 键})`（**多一个键就红**）；新指标放 `report` 的兄弟字段 |

## 1. 逐项落点

| 项 | 改哪些文件 | 关键动作 |
|---|---|---|
| **P-02** 回归网 | `core/src/eval/metrics.ts`（新指标）、`core/src/eval/**`、`scripts/`（派生引擎）、CI 工作流 | 指标进 `report.ranking` 兄弟字段；派生引擎确定性、三条碰撞要求（含反事实臂） |
| **P-03** 密钥守卫 | `core/src/store/` 新模块 + `store/memory.ts` 的 `add/update` 入口 | 命中即拒绝、走既有错误面（`plugin/src/index.ts` 的 `wireErr`），不加字段 |
| **P-04** 提示词 | `plugin/src/prompt.ts`（三段常量） | 同时准备 `[0.6.0]` 升级说明里的可粘贴文案 |
| **P-05a** 假溯源 | `db/dao/facts.ts`（停写常量）、`contract/src/types.ts`（视图字段）、`plugin/src/client/**`（面板） | 列留用不删；client/CLI/MCP 三处已确认不读 |
| **P-05b** 实体列 | `db/dao/entities.ts`（INSERT 带两列）、`store/memory.ts:431,530`、`store/knowledge.ts:963`、`entities/extract.ts`（已返回 type/method） | **不升 `ENTITY_EXTRACTOR_VERSION`**；接受新旧混合 |
| **P-06** 备份纪律 | `core/src/runtime.ts`（stats 字段）、`docs/INSTALL.md` / `README` | 只加一次 `statSync` 的 WAL 告警；git 跟踪检查只写文档 |
| **P-01** 逐臂信封 | `retrieval-core/src/fusion.ts`（返回逐腿分）、`contract/src/types.ts`（`RecallHit.scores/final`）、`store/hybrid.ts`、`contract/src/tools.ts`（`include_scores`）、`plugin/src/remote.ts`（wire） | 默认 false；**kb 对照**（≥10 条） |
| **P-07** 有效期 | `db/conn.ts` v10 + `db/schema.ts`、`store/memory.ts`（`applySupersede`、矛盾裁决）、`runtime.ts`（detail 输出） | `valid_from`/`valid_to` 可空；**反向"被谁取代"从 `supersedes_id` 派生，不新增列**；不变量 SQL 可验 |
| **P-08** 溯源 | `db/conn.ts` v10（新表 + 索引）、`db/schema.ts`、`store/memory.ts`（add 写入）、`contract/src/tools.ts`（`source_ref` / `source=` / `admin list` 的 `source=`）、`runtime.ts`（detail/list）、腿的 SQL（**腿内 `EXISTS` 谓词**） | 覆盖率进 stats；放宽档重试不受 `source=` 影响 |
| **P-13** 事件时间 | `contract/src/tools.ts`（`event_date` / `valid_until`）、`store/memory.ts`（写 `valid_from` / `valid_to`，**不归档**）、`plugin/src/remote.ts`（wire） | 与 P-01 共用同一次 `2→3` |
| **P-10** 重复断言 | `db/conn.ts` v10 + `db/schema.ts`（`assert_count DEFAULT 1`）、`db/dao/facts.ts`（`insertFact` 不含该列 ⇒ 用默认）、`store/memory.ts:1762-1785`（`changes === 0` 分支 +1，**revive 不计**）、`runtime.ts`（detail） | 读者 = `add` 返回 + `admin detail` |
| **P-11** 时间窗腿 | `core/src/store/` 新模块（中文时间解析）+ `store/memory.ts:1393-1421`（第 5 条腿，共享 jaccard 权重位）+ `config`（默认关）+ `runtime.ts`（`valid_from` 覆盖率） | **只读 `valid_from`，不回退写入时间**；两遍自指增广里都存在；前置 P-02/P-13 |

## 1.5 三处已核到行号的精确编辑清单

**P-05a（停发假溯源）**——`mirror_source` / `mirror_target` 的全部触点（已 grep）：

| 位置 | 动作 |
|---|---|
| `db/dao/facts.ts:250` 起的 INSERT 列清单与 `'user'` 常量 | 停止写入（改为 NULL 或从列清单移出） |
| `db/dao/facts.ts:31` `FACT_COLUMNS_NO_BLOB` | 若要连 SELECT 一起收，**先**去掉投影读取、再改这里 |
| `core/src/store/memory.ts:1880,1891` 详情投影 | 去掉这两个字段（依赖顺序：先这里，再 `FACT_COLUMNS`） |
| `contract/src/types.ts:37,83`（`FactSummary.mirror_source` / `FactDetail.mirror_target`） | 从模型面类型移除；同步 `contract.spec.ts` 形状断言 |
| `db/schema.ts:56-57` | **不动**（列留用、可空 `TEXT`） |
| client / CLI / MCP | 已确认不读（无需改动） |

**P-05b（实体属性落库）**——类型要一路带下去，签名会变：

| 位置 | 动作 |
|---|---|
| `db/dao/entities.ts:21` `linkFact(factId, names: readonly string[])` | 改为接受 `{name,type,method}[]`（或 `names` + 并行的 type/method），INSERT 时写三列；同名重复链接**首次写入优先**（`INSERT OR IGNORE` 保持既有行不变） |
| `core/src/store/memory.ts:1821` `linkEntities(fact_id, entities: string[])` | 同上改成带类型；调用点 `:1217`（重扫，**不改行为**）、`:1782`、`:1789`（写路径） |
| `store/memory.ts:431,530` 的 `.map((e) => e.name)` | 改为传完整对象（这两处是写路径的丢弃点）。**`store/knowledge.ts:963` 的同类丢弃点不在批次 0 范围内**（knowledge 的 `chunk_entities` 只有 `(chunk_id,name)`，写这两列必须加迁移）⇒ 留在后续批次或单独任务 |
| `store/memory.ts:1212`（`reindexEntities`） | **不改**（不升 `ENTITY_EXTRACTOR_VERSION`） |

**统计字段的共同落点**——`StatsSummary`（`contract/src/types.ts:357-368`）是 `mem_admin stats` 的载荷类型，
**P-06（WAL 告警）、P-08（来源覆盖率）、P-11（`valid_from` 覆盖率）三处都往这里加字段**，实现在
`core/src/runtime.ts:358` 的 `case 'stats'`，客户端渲染在 `plugin/src/client/index.ts:666`。
⇒ 三处按批次先后追加即可，但**类型与渲染要一起改**，否则 `StatsSummary` 与 UI 会短暂不一致（同一提交内完成）。



**P-02（回归网）**：评测模块 = `core/src/eval/{loader,metrics,runner,write_metrics}.ts`；
`runner.ts:36` 返回 `{ perQuery, summary: aggregate(all) }` ⇒ 新指标在**同一返回对象里加兄弟字段**（如 `ranking`），
与 `aggregate` 并列计算；`metrics.ts:51` 是聚合类型。派生引擎放 `core/src/eval/` 下新模块（确定性、不调模型）。

**P-03（密钥守卫）**：`store/memory.ts:422` 的 `add()` 先 `normalizeWrite` 再分词——守卫插在**归一化之后、分词之前**
（或在 `update` 的同位置），命中即 `throw`（该文件既有先例 `throw new Error('内容不能为空')`，
插件侧经 `wireErr` 变成工具错误面）。注意：**今天没有任何针对事实正文的检查**；
`store/ingest_guard.ts` 是 **kb 的 source 边界**（路径/SSRF），与内容无关，别混用。

**P-11（默认关的腿）**：retriever 配置面在 `core/src/config/config_files.ts`（既有键样例：`weight_fts: 0.30`、
`min_fts_terms: 2`），腿开关的既有先例是 `includeHrr`（在 `memory.ts:1393-1421` 的腿装配处读取）⇒
新腿按同一模式加一个默认 `false` 的配置键，并在腿装配处按它决定是否 append。



## 2. 派单建议（按批，不按项）

| 任务 | 范围 | 为什么这样切 |
|---|---|---|
| **T1** 批次 0 | P-02 / P-03 / P-04 / P-05a / P-05b / P-06 | 零迁移、互不冲突；可并行内部项但同一批一次收口 |
| **T2** 批次 1 | P-01 / P-07 / P-08 / P-13 / P-10 | **一次 v10 迁移必须在同一批内一次做完**（拆开会产生两次迁移）；**新增可选字段只需在 `remote.ts` 对应 codec 声明、不 bump**（BUMP RULE 只对新增/删除 `@Remote` 方法与删除被解引用的载荷字段生效；本方案都不涉及） |
| **T3** 批次 2 | P-11（默认关） | 依赖 T1 的回归网与 T2 的 `valid_from` |
| **收口** | 两档门禁 + 基准复测 | 由派单方执行；复测用同一 harness、同一语料、同一种子 |

**容易踩的坑（实现时逐条对照）**：
1. 新指标不要进 `report.summary`（`toEqual` 对多键严格）；
2. `valid_to` 若只由归档路径写入 ⇒ 信封字段永远序列化不到（P-13 的 `valid_until` 是它的可达路径）；
3. 腿内过滤用 `EXISTS`，不用 `JOIN`（多来源会行扇出吃 `LIMIT cap`）；
4. 新腿必须在自指增广的两遍里都存在（编排按腿下标合并，腿数不一致属契约违例）；
5. `fuse` 改返回形状会同时影响 memory 与 knowledge（kb 无评测网 ⇒ 必须附对照）；
6. 未给新入参时**逐字节不变**：用既有 `identityCheck` 与 `(ids, scores)` 指纹证明；
7. **不升 `ENTITY_EXTRACTOR_VERSION`**（会全库重跑三元组 + 覆写 HRR + 重排矛盾检测）；
8. **新增可选字段：声明进 codec，但不要 bump**——`remote_wire.spec.ts` 会因为没声明而红，`WIRE_VERSION` 不会因为多一个可选字段而需要动（BUMP RULE 见 `remote.ts:245-258`）。
