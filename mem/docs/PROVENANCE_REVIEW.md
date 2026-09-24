# derived-state 溯源改动复核（工作区未提交改动）

> **范围**：`ee0a4d8` 之上的 25 项未提交改动，其中 23 项是 **derived-state 溯源**这一组
> （`facts.entities_version` / `facts.conflict_checked`、`reindexEntities` 扫帚、`retriever.leg_cap`、
> `fusion.ts` 归一化改 `scaleByMax`），2 项属于**启动延迟**那一组（见 §8）。
> **状态**：改动在工作区，**未提交**。被审版本 = `ee0a4d8` + 该 25 项；对方作者最后一次写入 20:44，
> 本复核期间未再变动（行号以该版本为准，后续编辑会漂移）。
> **性质**：**只读复核**，未修改对方任何文件；§8 的修复只动本作者自己的两个文件。
> **方法**：一轮自审（读完全部 diff 的机制部分 + 关键 SQL/调用点）+ 两路**只读**子审查
> （① provenance 机制：迁移/DAO/扫帚/矛盾队列/CLI/插件 ② 测试质量：7 个测试文件逐条断言）。
> 子审查每一条 load-bearing 结论都由本作者回代码或探针核实，条目内注明来源。
>
> **结论**：**2 条阻断缺陷**（其中 1 条相对 HEAD 是**回归**）、**7 项应修**、**5 项 nit**；
> 测试侧 **7 处空白 + 3 处空/弱断言**。迁移 step 6 的机制、`reindexEntities` 的事务边界、
> 持久化队列的方向、eval 基线重冻的诚实度都**没问题**。修复顺序见 §6。

---

## 0. 证据标签与门禁

| 标签 | 含义 |
|---|---|
| 【自审·实测】 | 本作者本次用探针/命令跑出的结果 |
| 【子审查·实测】 | 子审查跑出的结果（条目内注明是否被本作者复现） |
| 【读码确证】 | 读码即可确定（语句形状、调用点、谓词、复杂度） |
| 【推断】 | 机制确证，量级未测 |

**门禁**：`pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm typecheck:dsh` 在最终工作区
**全绿：444 tests**（contract 36 / retrieval-core 76 / core 278 / plugin 35 / mcp 7 / cli 12）。
期间一次 `packages/core/test/knowledge.spec.ts > never blocks on a FIFO` 失败，**是负载抖动**：
该用例 spawn 子进程、自带 20 s 的 kill deadline，却受 vitest 默认 5 s 超时约束；单独跑
**2.2 s 通过**，且本组改动只把 `knowledge.ts` 的 cap 抽成 `legCapFor`（`git diff` 可确认），
未触及 ingest 守卫。

---

## 1. 阻断缺陷（2 条）

### B1 `conflict_checked` 的盖章不以"嵌入腿真的跑过"为条件 —— 相对 HEAD 是**回归**

**位置**：`packages/core/src/store/memory.ts:550-555`
```ts
const rows = this.facts.pendingConflictRows(budget)
if (rows.length === 0) return []
const logged = this.contradictions.checkMany(rows.map((r) => r.fact_id))
this.facts.markConflictChecked(rows.map((r) => r.fact_id))   // ← 无条件
```

**为什么是回归**【读码确证】：HEAD 的 `detect()` 里有
`for (const id of changedIds) if (vectors.has(id)) this.changed.delete(id)`
（`git show HEAD:packages/core/src/lifecycle/contradiction.ts:247`）——只有**真的取到向量**的行才离开待办；
新 `detect()`（`contradiction.ts:199-209`）**丢掉了 `embeddingPass` 返回的 vectors**，于是"取到了没有"这个信息在盖章时已经不存在。

**两个事实不一致**【读码确证】：
- 队列谓词只看**数据库列**：`dao/facts.ts:220` `WHERE status='active' AND conflict_checked=0 AND semantic_vector IS NOT NULL`；
- 嵌入腿的向量来自**活的内存索引**：`store/memory.ts:180-185` 用**位置参数**传 `(ids) => this.vstore.fetch(ids)`
  （所以按名字 grep `fetchVectors` 只会在 detector 内部命中）。

**失败场景**：DB 里有向量、活索引取不到 —— 异 space / 异维度（本机启动时就报过
"7 vector(s) were written in another space"）、另一进程写的向量、索引重建时缺失的行 ——
`embeddingPass` 里 `if (!vecC) continue` 跳过、什么都不记录，而调用方**照样盖 1**；
持久化标记意味着这一行**再也不会被复查**。这正是这个持久化队列要修掉的那类静默丢失。

**【子审查·实测，本作者已复核代码路径】** 真实 `MemoryStore`（`:memory:` + 假 512 维后端）探针：
正常 `add` 后 `conflict_pending=0`；随后 `vstore.remove(id)` 并把该行 `conflict_checked` 重置为 0 →
`checkContradictions()` 返回 `[]`、`conflict_pending` 1→0、`conflict_checked` 0→1。

**附带问题**：`test/lifecycle.spec.ts:671-686` 用"只种进 DB 的向量"把**这个有问题的语义钉住了**
（`:679` pending 仍为 1、`:683` 变 0），所以它现在是"记录行为"，不是"守卫正确性"。

**修法形状**：`embeddingPass` 已经返回它取到的向量表 —— 让 `detect()` 把"每行是否真的取到向量"回报给调用方，
`markConflictChecked` 只盖**取到的那些（加上不需要向量的结构性判定已完成的行）**；或恢复 HEAD 那条守卫的语义。
修完必须同时覆盖 B2 与 S3 的两条路径。

### B2 写入路径在**吞掉**检测异常之后照样盖章

**位置**：`store/memory.ts:271-275`（`add`）与 `:357-358`（`update`）
```ts
const contradictions = is_new || revived ? this.detectContradictions(fact_id) : []
if (indexed) this.facts.markConflictChecked([fact_id])      // :275
```
`detectContradictions` 的实现（`memory.ts:302-304`）：
```ts
} catch (error) {
  retrievalLogger().warn(`contradiction check failed for fact ${factId}: ${describeError(error)}`)
  return []                                                  // ← 异常被吞掉，调用方看不出来
}
```
而它自己的注释（`memory.ts:288-290`）明确承诺："Best-effort — … **the marker only moves when this
returns without throwing**"。承诺与实现相反。

**【子审查·实测】** 让 `vstore.fetch` 抛：只看到一条
`contradiction check failed for fact 1` 警告，`conflict_checked=1`、`conflict_pending=0` ——
检测失败的那一行被永久标成已检查。

**修法形状**：`detectContradictions` 返回 `{ conflicts, complete: boolean }`（或让异常传播），
调用方只在 `complete` 时盖章。

---

## 2. 应修（7 条）

### S1 `entities_version` 可空 + 谓词排除 NULL ⇒ 滚动升级的行被静默豁免

- **DDL**：`db/schema.ts` `entities_version INTEGER`（**无 NOT NULL / DEFAULT**）；`db/conn.ts:94`
  的 `addColumnIfMissing(..., 'INTEGER')` 同样。
- **谓词**：`dao/facts.ts:170` / `:180` 用 `entities_version < :version`；SQLite 里 `NULL < 1` 为 NULL
  ⇒ **NULL 行永不入选**，而 `countStaleEntities` 把它算作"干净"。
- **真实路径**【读码确证】：本仓**明确支持多进程**同时开库。滚动升级时仍在跑的 **pre-v6 进程**用它那份
  `INSERT`（`git show HEAD:packages/core/src/db/dao/facts.ts:138-147`，列里没有 `entities_version`）写入已升级的库
  ⇒ 这些行永远 NULL、永远不被扫帚采纳。
- **两库语义不一致**：知识库侧同名列（`store/knowledge.ts:416`）用 `!==` 判断，能处理 NULL。
- **注释是错的**：`schema.ts` 写 "the migration backfills existing rows to 0 so the NULL case cannot
  reintroduce it" —— 回填只覆盖迁移那一刻的行。
- **【子审查·实测】** fresh v6 库上 `INSERT INTO facts (content, settle_clock) VALUES (...)` →
  `entities_version=null`、`stale=0`、`staleRows=0`（总行数 1）。
- **修法形状**：DDL 与 ALTER 都改成 `INTEGER NOT NULL DEFAULT 0`（或把谓词写成 NULL-safe）。

### S2 迁移回填**过度标记**：不可用的向量也被算作"检查过"

`db/conn.ts:105` `UPDATE facts SET conflict_checked = 1 WHERE semantic_vector IS NOT NULL`。
**【子审查·实测】** 构造 pre-step-6 库（删两列+索引、`user_version=5`）并塞一条 **3 字节垃圾向量**：
迁移后 `conflict_checked=1`、`pendingConflictRows=[]`、`conflict_pending=0`；之后 `vectors_fix`
把它重编码，也不会再检查。异 space 的向量同理（与 B1 是同一个"DB 列 ≠ 可用向量"的根因）。
**修法形状**：回填条件至少要与"能被当前 space 解码"对齐（例如按 `embedding_model`/`vector_store`
过滤），无法判断时**宁可留 0**（代价是重扫一次，不是永久丢失）。

### S3 文档写了、代码没实现：换向量不重置 `conflict_checked`

`DESIGN.md:500` 称 "`setSemanticVector` / `clearVectors` 一律重置为 0，因为'检查过'只对**当时那个向量**成立"。
**【读码确证】** `dao/facts.ts:281`（`UPDATE facts SET semantic_vector = ?, embedding_model = ?, vector_store = ?`）
与 `:530`（`semantic_vector = NULL, embedding_model = NULL`）**都没有碰 `conflict_checked`**；
全仓写 `conflict_checked` 的地方只有：INSERT `0`（`:145`）、迁移 `1`、`markConflictChecked` `1`。
**失败场景**：换模型 → `vectors_fix` 丢掉旧向量并重编码 → 所有事实仍是 `conflict_checked=1`
⇒ 嵌入腿在**新向量空间**永不运行，而 `conflict_pending` 报 0。**修法**：按文档实现重置（或改文档，但那是错的语义）。

### S4 `reindexEntities` 重写了冲突检测的输入，却不失效检查状态、也不重跑检测

`store/memory.ts:810-824` 每个事实重写 `fact_entities` + `triples`（**两条冲突腿的输入**）+ HRR bundle，
只盖 `entities_version`。**【推断，机制确证】** `ENTITY_EXTRACTOR_VERSION` 升级后，三元组变了、
由新三元组隐含的**结构性**（极性/异宾语）冲突永不入日志，而 `conflict_pending` 读数是 0。
**修法形状**：扫帚在同一事务里把 `conflict_checked` 重置为 0（或对"三元组真的变了"的行重置），
让下一次 drain 重新判定。

### S5 扫帚的触发面与并发

- `store/memory.ts:804` 的 docstring 称 "Awaited by `maintenance`" —— **不成立**【读码确证】：
  `MemoryStore.maintenance()` 与 admin 路径（`runtime.ts:277-279`）都不调用它，`ADMIN_ACTIONS`
  （`contract/tools.ts:134`）里也没有 reindex 动作；设置页按钮走的是 admin maintenance。
- `plugin/src/index.ts:240` 把扫帚放在 `if (heartbeatMinutes > 0)` 内 ⇒ 配 `heartbeat_minutes: 0`
  （"仅启动跑一次"）时它在任何进程都不运行；且首次 beat 在挂载后 60 min。
- `:252` 的 `void rt.memory.reindexEntities(...)` **没有 in-flight 守卫** ⇒ 慢 beat 会重叠并重复选中同一批。

**修法形状**：进 `maintenance`（MCP-only / 设置页用户才够得着）+ 加在飞标记 + 明确首次触发的时机。

### S6 CLI 路径把整份 stale 语料一次读进内存

`cli/src/index.ts:203` `reindexEntities(Number.MAX_SAFE_INTEGER)` + `dao/facts.ts:167-173`
一条 `SELECT fact_id, content … LIMIT 9007199254740991`。**【子审查·实测】** better-sqlite3 会正确绑定这个 LIMIT
并返回**全部** stale 行；100k 事实的规则升级 = 一个含 100k 条文本的 JS 数组。插件路径是有界的 2000。
**修法形状**：CLI 也分批（如 2000/批循环直到 `deferred=0`），或让 `reindexEntities` 内部按块推进。

### S7 `idx_facts_conflict_pending` 复制了每条向量，却永远不可能 covering

`db/schema.ts:88` / `db/conn.ts:108`：`(status, conflict_checked, semantic_vector)`。
drain 查询还要 `SELECT fact_id, content`（`dao/facts.ts:219`），所以第三列只用来提供
`IS NOT NULL` 的范围，**行照样要回表** —— "不碰行"的理由自相矛盾。
**【子审查·实测】** 计划为
`SEARCH facts USING INDEX idx_facts_conflict_pending (status=? AND conflict_checked=? AND semantic_vector>?)`（无 COVERING）；
20 000 事实 × 2 048 B 向量：`page_count` 有索引 **44 120** vs `DROP INDEX` + `VACUUM` 后 **21 137**（4 096 B 页）
⇒ 索引本身 ≈ **94 MB**，比它复制的向量还大。**修法形状**：去掉 blob 列（或 partial index +
把"是否有向量"变成独立小列）。

---

## 3. nit（5 条）

- **N1** 两个扫帚查询的计划都以 `USE TEMP B-TREE FOR ORDER BY` 收尾【子审查·实测】⇒ 首次扫帚
  （`entities_version < ?` 命中全库）时 `LIMIT budget` **截不住排序**；`staleEntityRows` 在两次探针里
  一次是 `SCAN facts`、一次是索引 seek ⇒ `schema.ts` 里 "makes that a RANGE seek, not the scan shape"
  的注释**依赖统计信息**，不是结构性保证。
- **N2** `entities_version` 表达不了 tagger 的变化：`extract.ts:89` 是手写常量，nodejieba
  （`optionalDependencies`）缺失时 `tagText` 返回 null、走正则回退，而 `dao/facts.ts:149` 仍盖当前常量
  ⇒ 与 `DESIGN §20.15` / `memory.ts:804` 里 "or to the tagger" 的说法不符。
- **N3** `rebuilt = rows.length` 计的是"访问过"而非"改过"（`memory.ts:824`）；负 budget 在 SQLite 里
  等价 `LIMIT -1` = 无界（当前无调用方）；fresh-walk 迁移测试（`db_lifecycle.spec.ts:43-65`）**不断言**
  两个新列/索引（只有 upgrade 路径断言）；删掉 `lifecycle.contradiction_pending_max` 是**软破坏**：
  loader 对未知键只 warn "unknown config key(s) ignored"，老配置会**静默**失去那个上界。
- **N4 文档自相矛盾（四处）**：`DESIGN.md:120`（"三路各自 min-max"，已不成立）；
  `DESIGN.md:131`（本仓上一轮提交的 cap 段仍写 min-max，并引用**已被删除**的
  "known behaviour" 测试）；`DESIGN.md:259`（仍在讲已删除的 `contradiction_pending_max` /
  `conflict_pending` / `evicted`，与新的 `:508-512` 直接冲突）；`docs/PERFORMANCE_REVIEW.md:495`
  （§10.2 第 3 条门槛仍以 `changed.size` 为断言，而该结构已不存在）。
  `DESIGN.md`「分数可比」条（原 `AGENTS.md:8`）的 "min-max over the *merged* pool" 对**跨库**那一步仍成立（router 的
  `normalizeMergedScores` 未变），但读者会误读成库内也是 min-max。
- **N5 归一化的不变性声明过强**：`fusion.ts` 头部、`contract/src/config.ts` 的 `leg_cap` 注释、
  `DESIGN.md:520` 都写"最大值必然属于 cap 删不掉的那一条" —— **对 HRR 腿不成立**：
  其候选集由 **Jaccard 排序**裁剪（`dao/entities.ts` 的 `candidateFactsForAnyEntity`）或按 **recency**
  取（`dao/facts.ts` 的 `activeHrrRows`，`memory.ts:1130-1162` 调用），cap 完全可能删掉该腿的最大值。
  而**唯一的 store 级差分测试**用 `action: 'search'`（`test/recall.spec.ts:236`），
  而 `includeHrr` 只在 `action: 'probe'` 打开（`runtime.ts:236`）⇒ 恰好在"不变性结构性成立的那两条腿"
  上验证，**从未验证 HRR**。声明应收窄为"cap 按该腿自身分数排序时才成立"，并补一条 probe 路径的差分。

---

## 4. 测试质量审计（22 条断言的结论汇总）

**结实（变异会让它们失败）**：`scaleByMax` 的 `{1:2}→1`、`{1:0}→0`、全负集合→全 0 分支；
`fuse` 保留 zero-total（子审查用探针复现：HEAD 的 `if (s>0)` 会让它返回 `[]`）；`score` 相同按 id 升序的 tiebreak；
cap 差分（探针证明 HEAD 的 min-max 实现会让它失败，因此它真的守住了这次改变）；
`recall.spec.ts` 的 `legs_capped` 0 / >0；`lifecycle.spec.ts` 的 `conflict_pending` 重启与空 drain；
`memory.spec.ts` 的 `reindexEntities`（实体行**替换**而非追加、HRR bundle 跟着动、二次 no-op、当前规则的行走 `{0,0}`）；
`entities.spec.ts` 的 jieba 只加载一次（结果级 memo 会失败）；`db_lifecycle.spec.ts` 的迁移清单 `[3,4,5,6]`。

**空白（按价值排序）**：
1. **v6 回填零断言** —— `db_lifecycle.spec.ts:90` 虽插入 2 行 fact 并走到 `:102`，但**不检查两个新列的取值**；
   删掉 `conn.ts` 的两条 `UPDATE` 也能全绿。
2. `deferred > 0` 从未断言 ⇒ 生产里把 `deferred: 0` 硬编码可全绿（CLI 的 `entities_stale`、
   插件的 beat 日志在非零情形都没测）。
3. 三元组"替换而非追加"没读回（`triples.deleteForFact`/`insertTriples` 无断言）。
4. `checkContradictions` 的**部分 drain**（budget < pending）没测。
5. `retriever.leg_cap` 在 contract 侧无默认值/非负/往返测试（只有 store 级差分用到）。
6. `legs_capped` 只有 FTS 腿触发过；HRR 腿 / `activeHrrRows` 回退 / `RetrievalHealth` 完整载荷都没测。
7. HRR 腿的 cap 行为（N5）与"嵌入腿是否真的跑了"（B1）没有测试。

**空/弱断言**：`lifecycle.spec.ts:682` `expect(Array.isArray(logged)).toBe(true)`（类型就是数组，恒真）；
`fusion.spec.ts:31-32` 的降序断言在"实现就是降序排序"下只能因 NaN 失败；
`recall.spec.ts:250` `unlimited.length > 0` 在该语料下恒真。

**建议补的三条**（子审查给出、本作者同意）：
① `db_lifecycle.spec.ts`：手工造 v5 库 + ≥2 行 fact（一行有 `semantic_vector`、一行没有）→ 升级后断言
`entities_version=0`（两行都有）且 `conflict_checked=1` **只**给有向量的那行。
② `memory.spec.ts`：种 N 行 stale，`reindexEntities(k<N)` → `deferred = N-k`，再跑一次收尾；
并断言三元组是替换不是追加、新写入的事实盖了 `ENTITY_EXTRACTOR_VERSION`。
③ `fusion.spec.ts` + `recall.spec.ts`：一个**会删掉该腿最大值**的 cap（3 选 2 且被删的是最高分）；
store 级用 `action:'probe'`（唯一打开 HRR 的路径）构造"实体共享事实数 > legCap、且 HRR 最高分者排在
Jaccard cap 之外"的语料 —— 要么修好声明，要么把声明限定范围。

---

## 5. 没有问题的部分

- **迁移 step 6 的机制**【子审查·实测 + 本作者读码】：编号连续、追加在末尾，每条语句幂等，
  `migrate()` 把 step + audit + `user_version` 放在同一事务；在 pre-step-6 库上连跑两次得到**相同状态**。
- **`reindexEntities` 的事务边界**：`await tagText()` 在事务**外**，每事实一事务把
  实体行/三元组/HRR bundle/版本章一起提交；`content` 从不原地更新 ⇒ 并发写不会破坏它。
- **持久化队列的方向是对的**：取代内存 `Set` 后跨重启存活、不再需要上界；`countPendingConflicts`
  故意不带向量过滤（把"等模型"的那批也算进落后量）是诚实的设计；drain 在一批内**必然收缩**
  （每一行都被盖章），不会自旋或饿死。
- **eval 基线重冻是诚实的**：`mrr 0.9429 → 0.9714` 的同时明确写出 `must_exclude 0.7429 → 0.6571`
  （12 条违规）及其机制（min-max 把每条腿的最弱项归零 = 事实上的阈值；去掉后 k=2 的尾位会填一个
  共享实体的邻居）。**这是产品取舍，应由仓库主人拍板**，但它不是"漂移掩盖"。
- **2 字查询的 PINNED GAP 被修正得更准确**（缺口是"tagger 判为动词的 2 字词"，而非"tagger 不认识"，
  并用 `风控`→`x` 可被接受作反证），并给出了两条诚实的修法方向（LIKE 回退 / bigram 索引）。
- **`extract.ts` 的 promise memo 无竞态**（赋值在首个 `await` 之前；`entities.spec.ts` 断言尝试次数为 1）。

---

## 6. 提交前建议先处理的三件事

1. **把 `conflict_checked` 的语义定义清楚并按行盖章**：只有**真的跑过嵌入腿**的行才盖 1
   （恢复 per-id 守卫或让 `embeddingPass` 回报成功），同时覆盖 B2 的 catch 路径与 S3 的
   `setSemanticVector`/`clearVectors` 重置。
2. **修 `entities_version` 的 NULL 语义**（`NOT NULL DEFAULT 0` 或 NULL-safe 谓词），
   否则滚动升级期间旧进程写的每一行都被静默豁免。
3. **定扫帚的归属与上界**：放进 store/admin `maintenance`（MCP-only 与设置页用户也能跑）、
   分块替代 `MAX_SAFE_INTEGER`、加 in-flight 守卫。

其后依次：S7（索引去掉向量 blob）、S4（扫帚失效 `conflict_checked`）、S2（迁移回填收窄）、
N5（收窄不变性声明 + 补 probe 差分）、N4（四处文档矛盾）、S6/S5 剩余部分、N1–N3。

---

## 7. 附录：可复现的探针

> 探针的形态（子审查实际跑过的），便于逐条复核。均在临时目录/`:memory:` 上执行，不触碰真实数据。

- **B1**：`buildRuntime`（`:memory:` + 假 512 维语义后端）→ `remember add` → 确认
  `conflict_pending=0` → `rt.memory.vstore.remove(id)`（或等价入口）+
  `UPDATE facts SET conflict_checked=0 WHERE fact_id=?` → 调 `checkContradictions()`：
  预期**不应该**盖章，实际 `logged=[]`、`conflict_pending` 1→0、`conflict_checked` 0→1。
- **B2**：把 `vstore.fetch` 换成抛异常的桩 → 写入一条事实 → 观察
  `contradiction check failed for fact 1` 警告 + `conflict_checked=1`、`conflict_pending=0`。
- **S1**：fresh v6 库上 `INSERT INTO facts (content, settle_clock) VALUES ('x', 0)` →
  `SELECT entities_version, conflict_checked` → 前者为 NULL；`countStaleEntities(1)` 报 0。
- **S2**：把库降级为 pre-step-6（drop 两列 + 两个索引，`PRAGMA user_version=5`），写入一条
  3 字节的 `semantic_vector` → 重新 `migrate` → `conflict_checked=1`、`pendingConflictRows=[]`。
- **S7**：20 000 行 × 2 048 B 向量；`EXPLAIN QUERY PLAN` 确认无 COVERING；
  `PRAGMA page_count` 对比 `DROP INDEX idx_facts_conflict_pending` + `VACUUM` 前后。
- **N1**：对 `staleEntityRows` / `pendingConflictRows` 的 SQL 跑 `EXPLAIN QUERY PLAN`，
  观察 `USE TEMP B-TREE FOR ORDER BY`。
- **变异验证（应补的守卫）**：删掉 `conn.ts` 的两条回填 `UPDATE`、把 `deferred` 硬编码为 0、
  把 `staleEntityRows` 的 `<` 改成 `<=` —— 三者当前都能让测试保持全绿，正是 §4 的空白。

---

## 8. 另一组改动（启动延迟，本作者）：自查出的两处已修

这组改动是 `packages/core/src/modelBootstrap.ts` + `packages/plugin/src/index.ts`（+ 新 spec），
复核中自查出两处并已修复（**未触碰对方的文件**）：

1. **`waitFor` 没有硬上限**（与 DESIGN 里"两条路径都要有硬上限"的说法不符）：宿主 loader 若永不 settle，
   分词就永不预热，之后每次首次查询都要付那 ~1.2 s。现在
   `Promise.race([waitFor.catch(() => undefined), delay(cap)])`，`waitForCapMs` 可注入（默认 30 s），
   并补了两条测试（信号 reject 仍预热 / 信号永不 resolve 时靠 cap 结束；
   **去掉 race 的变异会让测试 5 s 超时失败**）。
2. **测试名与负载敏感性**：`gives up at maxWait` 实际走的是"maxWait 装不下一个静默窗口"的**早返回分支**
   （参数 quiet 1000 / maxWait 50）→ 改名为 `returns at once when maxWait cannot fit another quiet window`；
   `waited < 300` 放宽为 `< 1000`（断言的是"没等满 maxWait"，具体值受负载影响）。
   `model_bootstrap.spec.ts` 现在 8 条全绿。

---

## 9. 复核（第二轮：报告提交后对方已完成修改）

> **被审版本**：`ee0a4d8` + 28 项未提交改动（对方 21:11–21:25 的一轮修复，改动量 1020 → 1699 行）。
> **门禁**：**451 tests 全绿**（contract 37 / retrieval-core 76 / core 284 / plugin 35 / mcp 7 / cli 12）
> + `pnpm typecheck` + `pnpm typecheck:dsh`。
> **方法**：§1–§4 的每一条都回到代码核对；对两条 blocker 的修复另做**变异验证**（把修复改回原样，
> 看新测试是否失败）。

### 9.1 逐条裁决

| 编号 | 裁决 | 证据 |
|---|---|---|
| **B1** 无条件盖章 | ✅ **已修** | 检测器新增 `CheckResult.complete`：`embeddingPass` 只在**从活索引取到该行向量**时才把它算作 complete（实体数低于 floor 的行也算，因为再跑也不会变），`checkContradictions` 只盖 `checked.complete`；另加 drain **游标**（`conflictDrainCursor` + `fact_id > :after` + 到尾部回绕），使"不可完成的行"不会挡住后面的行。**变异验证**：改回无条件盖章 → 新测试 `drains the queue only when the LIVE INDEX can serve the vector, not when the column has one` 失败（`expected +0 to be 1`） |
| **B2** 吞掉异常仍盖章 | ✅ **已修** | `detectContradictions` 返回 `{conflicts, complete}`，catch 返回 `complete:false`；三条写路径（`add` / `update` / `restore`）都按 `check.complete` 盖章；新测试 `a FAILED check leaves the row queued (a caught failure is not a completed check)` |
| **S1** `entities_version` NULL 语义 | ✅ **已修（比建议更彻底）** | DDL 与 ALTER 都是 `INTEGER NOT NULL DEFAULT 0` —— 这也覆盖了**滚动升级期间旧进程 INSERT 不写该列**的情形（它走列默认值 0，不再产生 NULL）；保留 `WHERE entities_version IS NULL` 的修复语句并注明是为"跑过中间版 step 6"的库。测试断言两列的 `notnull/dflt_value` 与升级后两行都是 0 |
| **S2** 迁移回填过度标记 | ✅ **已修，理由比建议更完整** | 迁移**不再回填** `conflict_checked`，注释给出根因："数据库答不了'活索引能否服务这行 blob'，而 open 时也不知道当前向量空间"。代价（升级后一次有界的追赶）被明确接受；测试注释同时列出它守的两个变异（nullable ALTER / 恢复 `WHERE semantic_vector IS NOT NULL` 的 shortcut） |
| **S3** 换向量不重置 | ✅ **已修** | `setSemanticVector` 与 `clearVectors` 都追加 `conflict_checked = 0`；新增批量 `requeueConflictCheck` |
| **S4** 扫帚不失效冲突检查 | ✅ **已修** | `reindexEntities` 在**同一事务**里 `requeueConflictCheck([row.fact_id])`（实体/三元组/HRR/版本章/队列标记一起动） |
| **S5** 触发面与并发 | ✅ **已修** | `maintenance()` 现在 `await this.reindexEntities()` 并返回 `entities`（MCP/设置页可达，docstring 的 "Awaited by maintenance" 变真）；`entitySweepInFlight` 守卫（重入返回 `skipped: true`）；负 budget 被 clamp |
| **S6** CLI 无界 | ✅ **已修** | CLI 改为按 `ENTITY_SWEEP_BATCH` 循环到 `deferred === 0`，并在 `rebuilt === 0`（被守卫挡住）时退出 |
| **S7** 索引复制向量 | ✅ **已修（改法比建议更好）** | 索引变成 **partial**：`ON facts(status, fact_id) WHERE conflict_checked = 0` —— blob 列去掉，且 drain 计划变为 `SEARCH facts USING INDEX idx_facts_conflict_pending (status=? AND fact_id>?)`，**无 TEMP B-TREE** |
| **N1** 排序临时 B 树 | ⚠️ **本报告撤回** | 在有 `ANALYZE` 统计信息的 5000 行库上，`staleEntityRows` 的计划是 `SEARCH facts USING INDEX idx_facts_entities_version (entities_version<?)`，**没有 TEMP B-TREE**。原结论是空表/无统计的假象，原作者对索引的改动也让另一条查询变干净 |
| **N2** tagger 不进版本 | ✅ **转为设计决定** | docstring 明确：版本只覆盖**规则**；把 tagger 折进去会让一次"能力失败"（nodejieba 加载不了）触发用**更差**抽取器的全量重建 |
| **N3** 其他 nit | ✅ **已修** | 负 budget clamp；`rebuilt` 的"访问过 ≠ 改过"变成显式说明；fresh-walk 迁移测试现在断言两个新列 |
| **N4** 四处文档矛盾 | ✅ **已修** | `DESIGN.md:120` 改为"各自按该腿最大值缩放"；`known behaviour` 字样清零；`DESIGN.md:259` 重写为持久化队列并写明旋钮删除的理由；`docs/PERFORMANCE_REVIEW.md` §10.2 第 3 条改为"`conflict_pending` == M 且**跨进程仍在**"，并显式标注"**原写法已作废（溯源改动）**"及其原因 |
| **N5** 不变性声明过强 | ✅ **已修（取本报告给出的第二个选项：限定范围 + 记录缺口）** | `fusion.ts` 头部改为"**对按自身分数序交出条目的腿**成立"，并点名 HRR probe 是唯一例外；`DESIGN.md` 新增 §20.17 与"不变量成立的边界（复核 N5）"；`AGENTS.md` 同步改写并指向 §20.17。HRR 腿的 probe 差分测试**仍未加**，但已作为已知缺口写进文档（本报告明确允许这种收尾） |
| 测试空白 1–5 | ✅ **已补** | v6 回填（有/无向量两行 + 断言队列谓词仍能找到有向量那行）；`deferred` 非零（`{rebuilt:2,deferred:1}` → `{rebuilt:1,deferred:0}`）；三元组**替换**而非追加（`__stale__` 标记消失）；**部分 drain**（`checkContradictions(1)` 逐条推进）；`retriever.leg_cap` 的 contract 侧默认值/非负/往返 |
| 测试空白 6–7 | ⚠️ **仍缺** | `legs_capped` 仍只由 FTS 腿触发（HRR 腿 / `activeHrrRows` 回退 / `RetrievalHealth` 完整载荷无测试）；HRR 腿的 cap 差分（已按 N5 记入文档缺口） |

### 9.2 本轮新发现（两条）

**R1（should-fix，一行修复）重定义同名索引时没有 DROP。**
`db/conn.ts` 的 step 6 用 `CREATE INDEX IF NOT EXISTS idx_facts_conflict_pending ON facts(status, fact_id)
WHERE conflict_checked = 0`；SQLite 的 `IF NOT EXISTS` **只看名字**，所以一个已经跑过**中间版 step 6**
（旧定义含 `semantic_vector`）的库会继续保留那个 ≈94 MB 的 blob 索引，且拿不到新的 partial 计划 ——
列那一边他们专门写了修复语句，索引这一边漏了。
**影响面**（只读核对）：本机实盘库 `~/.avantf/memory/memory.db` 现在是 **`user_version = 5`、两列都不存在**，
下次启动会走**新版** step 6，**不受影响**；受影响的只有作者自己的 dev/测试库与任何跑过中间版构建的库。
**为什么测试没抓到**：`db_lifecycle.spec.ts` 的用例是先把两个索引 `DROP` 掉、再降级到 v5，
模拟的是"干净的 v5 库"，不是"跑过中间版 step 6 的库"。
**修法**：create 之前加 `DROP INDEX IF EXISTS idx_facts_conflict_pending`（幂等；step 5 的
`DROP INDEX IF EXISTS idx_facts_idle` 就是同一做法的先例）。

**R2（question，产品决定，不是 bug）升级后的冲突待办由谁排空？**
S2 选择"不回填 `conflict_checked`"之后，升级会让**所有带向量的行**一次性进入待办。实体扫帚现在由
`maintenance`（与插件 heartbeat）推动，但 `maintenance` **不 drain 冲突队列** —— 冲突侧只有显式
`contradict_check` 会推进，且每次 2000。`conflict_pending` 是诚实的（这正是报告 §10.2 要的性质），
所以现状不是缺陷；但既然 `maintenance` 已经是"clean up now"的入口，是否也在其中带一次**有界**的
冲突 drain，值得仓库主人定一下。

### 9.3 第二轮结论

第一轮的 **2 条 blocker 与 7 项应修全部落地**，nit 里 N2–N5 也处理了（N5 按"限定范围 + 记录缺口"收尾），
测试空白补上了 5/7 处；本报告自己的 N1 经复核**撤回**（是小表假象）。
两条 blocker 的修复都带**会咬的测试**（变异验证见 9.1 的 B1/B2 行）。
剩余：**R1**（一行 `DROP INDEX`，影响面限于跑过中间版的库）与 **R2**（一个产品决定），
外加仍缺的两处测试（`legs_capped` 的 HRR 侧、HRR cap 差分 —— 后者已按 N5 记入文档缺口）。

---

## 10. 第三轮：§9 的剩余项已处理（本轮由审查方实施）

> §9.2 的 R1/R2 与 §9.1 末尾"仍缺"的两处测试，经仓库主人授权由本审查方直接修掉。
> 门禁：**455 tests 全绿**（contract 37 / retrieval-core **77** / core **287** / plugin 35 / mcp 7 / cli 12）
> + `pnpm typecheck` + `pnpm typecheck:dsh` + `pnpm build:dsh`（含 mount smoke）。

- **R1 → 迁移 v7**。关键修正：**不能把新索引定义塞回 step 6**——`CREATE INDEX IF NOT EXISTS` 按**名字**
  判存在，而跑过中间版的库 `user_version` 已经是 6，step 6 根本不会重跑。所以新增
  `version: 7, name: 'conflict-pending-index-partial'`：`DROP INDEX IF EXISTS idx_facts_conflict_pending`
  + 重建为 partial `(status, fact_id) WHERE conflict_checked = 0`（对 fresh/v5 库是幂等的空操作；
  step 5 的 `DROP INDEX IF EXISTS idx_facts_idle` 是同一先例）。
  新测试 `replaces the intermediate BLOB conflict index a v6 database may carry (step 7)`：手工造一个
  `user_version = 6` 且带旧 BLOB 索引的库 → 重开后 `applied === [7]`，索引 SQL 不再含 `semantic_vector`
  且含 `WHERE conflict_checked = 0`；再开一次 `applied === []`。
  **变异验证**：删掉那条 `DROP` → 测试失败（旧 BLOB 索引存活）。既有的三处 `applied` 断言同步改为
  `[3,4,5,6,7]` / `[4,5,6,7]` / `[6,7]`。
- **R2 → `maintenance` 也 drain 冲突队列（有界）**。`MemoryStore.drainConflicts(budget)`（公开，返回
  `{logged, checked, pending}`）承接原 `checkContradictions` 的实现，后者退化为 `.logged` 的薄包装
  （既有调用方与测试不受影响）；`maintenance()` 现在各跑**一趟**并返回
  `entities: {rebuilt, deferred, skipped}` 与 `conflicts: {checked, logged, pending}`。
  CLI 的 `maintenance` 对**两半**都分批排空到归零，且冲突循环在"这一趟 `checked === 0`"时退出——
  向量不在活索引里的行永远不会被盖章，否则就是死循环；`pending > 0` 是诚实的。
  `cli.spec.ts` 增加 `conflicts` 断言；`lifecycle.spec.ts` 新增
  `maintenance carries ONE bounded conflict pass and reports what is left`（一行可达 + 一行不可达 →
  `{checked: 1, logged: 0, pending: 1}`，同时断言实体半 `{0,0,false}`）。
- **缺测①`legs_capped` 的 HRR 侧** → `recall.spec.ts` 的 HRR 探针测试断言计数器被触发，并断言
  `retrievalHealth().legs_capped === retrievalHealthSummary().legs_capped`（页面读的快照与摘要一致）。
- **缺测②HRR cap 差分** → 两半都补上：
  - unit（`fusion.spec.ts`）：`pins the BOUNDARY of that invariance: a set that loses its maximum IS
    rescaled` —— 把"cap 移除最大值"的算术钉死（幸存者 2 从 0.556 变 1.0、3 从 0.278 变 0.5），
    注释写明"若 HRR 腿改成按分数裁剪，这个期望必须翻成相等"。
  - store（`recall.spec.ts`）：同一查询、同一语料，把**Jaccard 最低**的那行的 `hrr_vector` 手写成
    **探针自己的 bundle**（phase similarity 1.0 = 该腿的最大值），`leg_cap: 2` 恰好把它裁掉 →
    `probe` 结果不再包含它；同时断言"无 cap 时包含它"与两处 `legs_capped` 一致。
  - 两条都**不是**靠"分数不同"这种弱断言，而是靠"该腿的最大值被 cap 移除"这一结构性事实。

**§9 的结论因此更新为**：两轮意见**全部清空**（R1/R2 已修、两处缺测已补），我对 N1 的原始判断仍是撤回状态。
文档同步：`DESIGN.md` §20.15 的"可达路径"重写（两半各一趟 + CLI 各自分批 + 冲突半为什么尤其需要它）、
新增"迁移 v7（重定义索引必须单独一步）"一段；`CHANGELOG.md` 增 "review round 3" 一节。

**顺带修掉的预存在抖动（不在本次改动范围内，但让门禁随机红）**：
`packages/core/test/knowledge.spec.ts` 的 `never blocks on a FIFO` 用例**自己 spawn 一个 20 s deadline 的子进程**，
却受 vitest 默认 **5 s** 测试超时约束 —— 今天在两轮门禁里各失败一次（单独跑 2.2 s 通过）。已给它显式
`30_000` 超时（断言仍然是子进程的 `timedOut` 标志，所以外层上限**必须**高于内层 deadline，这一点写进了注释）。
这不是本次改动引入的：`knowledge.ts` 在这两轮里只多了 `legCapFor` 的抽取，该用例在此之前就存在。
