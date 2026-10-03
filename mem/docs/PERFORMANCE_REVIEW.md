# avantf-mem 性能审查报告

> 范围：整个记忆系统（memory + knowledge + retrieval-core + DB/DAO 层 + 生命周期 + 启动 + 多进程）。
> 性质：**只读审查**，未修改任何生产代码。本报告落盘时工作区干净在 `b9b5b34`。
> 结论摘要：发现 1 个会让系统**彻底起不来**的功能缺陷，以及 4 条随规模变坏的主线、若干固定开销项。修复顺序见 §9。
>
> **独立复核（复审记录）**：报告落盘后另起一轮，用命令重跑了其中最尖锐、最影响结论的断言——P0 的完整复现（含抛错栈与"不自愈"）、2 字中文的 FTS 缺口、死索引的实际查询计划、两处计数失真、两处过时注释。**逐条成立，无需撤回任何结论**；复核同时补出 4 处边界（"2 字查询的评测盲区"与"计数失真须前置"会改变 §9 的顺序），并收紧 2 处措辞（`purge_after_archived_days` 配 `0` 不是"立刻"触发；该键在 `lifecycle` 段而非 `trust` 段）。改动处均标【复核】，证据标签见 §1，顺序表相应调整为 8 步。
>
> **实施进度（本文档落盘后按 §9 顺序推进；本节的数字是**实施后**的复测，正文其余部分是审查当时的基线）**
>
> | §9 步 | 状态 | 实施后的复测 |
> |---|---|---|
> | 1 P0 purge FK | ✅ 已实施 | 两条分支各有回归测试；端到端"链过期后新进程仍能启动"；新库 DDL 不再声明该外键 |
> | 2 健康度计数 | ✅ 已实施 | 一次 `kb_query` = 一条 `kind:'cross'` 事件；知识库零结果也计数（测试 3 条） |
> | 3 hnswlib 墓碑/惰性升级/落盘 | ✅ 已实施 | 删 1 个 id **0.016 ms**（原为全量重建，8000 条 5.9 s）；启动 4000 条 **103 ms**（原 763 ms@2k/6.3 s@8k）；重启后首个查询 **3128 → 51 ms**；`remember update` **11.3 ms**（原 664 ms@2k） |
> | 4 索引与定向查询组（迁移 step 4） | ✅ 已实施 | `list` 首页 **124 → 2.1 ms**（33k/8KB 行）；suppress **60.8 → 0.06 ms**、`resolveForFact` **9.4 → 0.14 ms**、批量退休 **88.3 → 6.6 ms**（10 万 open 对）；删 `idx_facts_idle`（46 → 36 µs/次召回） |
> | 5 tick 谓词与预算化（迁移 step 5） | ✅ 已实施 | 待结算计数 **5.86 → 0.22 ms**、forget **15.7 → 5.7 ms**、idle **26.7 → 0.7 ms**、purge **10.8 → 0.6 ms**（120k 行）；整趟 tick 33k 语料 **254 → 162 ms**；②③④ 现在共享预算并报 `archived_deferred`。**注意**：`settleBudgeted` 本身没变快（15.5 → 15.8 ms）——它的成本是 5000 行 UPDATE + 索引维护，不是扫描 |
> | 6 评测集 + 检索腿 top-N / HRR | ✅ 已实施 | 评测集 **29 → 35 条**（新增 2 字形状），指标上升（P@k 0.477→0.567、MRR 0.931→0.943）**全部来自新增的 6 条查询，不是排序变好**；对**旧 29 条**用新代码复跑，六项指标与改动前**逐字节相同**（实施复核 §5.4 复核了这一点——它的真实含义是"小语料下 cap 从未生效"，而**不是**"cap 无害"）。search 203 → **140 ms**、probe **1366 → 150 ms**（33k）。**上限只约束跨进 JS 的行**——FTS5 仍为每个命中行算 bm25；`缓存` 这类 2 字术语仍无腿可用，已用专门测试钉为已知缺口；cap 的融合层影响（§3.4）仍是已记录的取舍：该语义在 `memory.ts` 的 cap 注释与 DESIGN §7 写明，行为由 `fusion.spec.ts` 的一条 "known behaviour" 测试钉住（裁剪会让幸存者被重新缩放、名次可能翻转），cap 生效条件下的候选正确性由"语料 > legCap"的新测试守着 |
> | 7 知识库写侧与固定开销 | ✅ 已实施 | **批编码实测否决**（真实块长下按文档顺序分批 55.7 vs 串行 31.2 ms/块，1.79× 慢；按长度排序后持平）⇒ 摄入保持逐条 encode，只保留写侧与重建侧：**reindex 1756 → 236 ms**（7841 块、零 stale）、ingest 37.4 → **35.1 ms/块**（同语料控制变量）；语句缓存/atom memo/单次分词/空预算短路四项让 n=2k 下 add 6.0→**1.42 ms**、update 9.7→**2.15 ms**、search 18.4→**10.1 ms**、list 12.1→**0.87 ms**。**时代注记**：本行数字产自 better-sqlite3 / SQLite 3.49 与本审查当时的机器；引擎其后整体切到 `node:sqlite`，现机器上的重冻基线（2k：search 12.65 / add 4.16 ms；10k：search 52.9 / add 12.0 ms，命令与环境一并记录）见 DESIGN §20.21 ③ |
> | 8 相邻项（`facts_fts` rebuild、`initClock`、过时注释） | ⏳ 待做 | §19 的过时注释已在第 1 步一并纠正 |
>
> | 复核修复（`PERFORMANCE_IMPL_REVIEW.md` §8） | ✅ 批次 1–4 已实施 | 语义/排名/错误处理 4 项、hnswlib 快照与跨会话墓碑、pending 有界 + purge 预算、文档更正与 nit；详见 `CHANGELOG.md` 的 implementation review 三段 |
> | 复核修复批次 5（本轮自查的三项非阻塞项） | ✅ 已实施 | ① `encodeBatch` 生产零调用被撤回为**行为判据**（§10.2 第 4 项）+ 3 条单测（顺序还原/长度分组/回退）；② §3.4 的 cap 与融合归一化关系写进 `memory.ts` 注释 + DESIGN §7 + `fusion.spec.ts` 一条 known-behaviour 测试（明确不改归一化）；③ `ATOM_CACHE` 从"8192 条、溢出全清"改为 **16 MiB 字节预算 + FIFO 增量淘汰**（+1 测试）——原实现对 dim=1024 是 64 MiB 且每次溢出把整个词表丢掉重算 |
>
> **实施中新发现（正文没有的三条）**：① `page()` 的计划**会被 `PRAGMA optimize` 翻回 `SCAN facts` + temp b-tree**（33k 行复现）——所以那条索引必须 `INDEXED BY` 钉住，并且**计划级断言必须在显式 `ANALYZE` 之后跑**才有意义；② 指纹只覆盖 id 不足以判定向量快照有效（`kb reindex` 保留 id、换掉文本与向量），指纹因此加入"每行抽样 8 个坐标"；③ §4.6 把 tick 的各段都记为"全扫"，但**拆开量之后 `settleBudgeted` 的成本其实在写不在读**（5000 行的 UPDATE + `idx_facts_trust` 维护 ≈ 15 ms，扫描早已是索引序 + `LIMIT`）——所以第 5 步的收益来自待结算计数/forget/idle/purge 四条，而不是那条 UPDATE，优化它需要减少写放大（合并语句或降低推送频率），不属于本轮。

---

## 目录

1. [方法与证据等级](#1-方法与证据等级)
2. [P0·功能缺陷：purge 撞 `supersedes_id` 外键 → 启动抛错](#2-p0功能缺陷purge-撞-supersedes_id-外键--启动抛错)
3. [实测数字总表](#3-实测数字总表)
4. [逐项发现](#4-逐项发现)
5. [已验证的修复（事前/事后都实测）](#5-已验证的修复事前事后都实测)
6. [已经做对、不要动](#6-已经做对不要动)
7. [相邻发现（非性能）](#7-相邻发现非性能)
8. [内存与存储占用](#8-内存与存储占用)
9. [落地顺序](#9-落地顺序)
10. [验证方案与回归门槛](#10-验证方案与回归门槛)
11. [附录：基准方法与脚本](#11-附录基准方法与脚本)

---

## 1. 方法与证据等级

四条并行子审查（读路径 / 写路径 / 入库与启动 / 生命周期与索引）+ 本报告作者在真机上跑的合成数据基准，互相交叉验证。

**证据标签**

| 标签 | 含义 |
|---|---|
| 【实测·本次】 | 本报告作者本次跑出的数字 |
| 【实测·子审查】 | 子审查跑出的数字（未由本作者逐一复现，标注在条目内） |
| 【代码确证】 | 读码即可确定（查询形状、语句条数、索引缺失、复杂度） |
| 【推断】 | 机制确证，量级未测 |
| 【复核】 | 报告落盘后由独立一轮重跑该断言得到的结果（见 §2「独立复核」、§4.4、§4.11、§4.13、§6.1、§7.5） |

**测量环境**：Node v22.23.2 / better-sqlite3 11.10.0（SQLite 3.49.2）/ hnswlib-node 2.1.1 / nodejieba 2.6.0 / 12 核。hnswlib 构建数字与仓库既有 `scripts/bench-vstore.mjs` 一致，可复现。

**方法要点**

- 记忆/向量侧基准用**注入的确定性 stub 语义后端**隔离 ONNX（除知识库那一轮用真模型 `Xenova/bge-small-zh-v1.5`）。
- 合成语料：`性能优化记录：svc-payment-{i%200} 针对 cache-layer-{i%50} 的{verb}（条目 i）`，每事实 3 实体 + 1 三元组 + 8KB `hrr_vector`；行内含 blob 这一点与真实库同形。
- 规模阶梯 2k / 8k / 10k / 16k / 33k / 40k / 100k，`all` 报告 p50。
- 修复验证采用**事前/事后对照 + `EXPLAIN QUERY PLAN`**，其中一条直觉方案被实测证伪（见 §5.3）。

---

## 2. P0·功能缺陷：purge 撞 `supersedes_id` 外键 → 启动抛错

**这是本报告的最高优先级项：它不是性能问题，而是会让记忆系统完全无法启动的缺陷。**

### 复现（生产 DDL + 生产入口，临时 data home）

```
add(...)                        → fact 1
update(fact_id=1, ...)          → fact 2 (active, supersedes_id=1)；fact 1 (archived)
PRAGMA foreign_keys             → 1
DELETE FROM facts WHERE fact_id=1
  → SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed
runMaintenance(db, cfg, {budget:0})
  → SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed
buildRuntime({dataHome})
  → 抛错（栈：MemoryStore.trustTick → runTrustTick → purgeArchived → facts.js:412）
```

### 机制【代码确证】

- `facts.supersedes_id INTEGER REFERENCES facts(fact_id)` 是 **NO ACTION 自引用外键**（`packages/core/src/db/schema.ts:32`）。
- `applyPragmas` 打开 `foreign_keys=ON`（`packages/core/src/db/store.ts:17`）。
- 任何一次 `update` 都会留下"活动行引用已归档旧修订"的形态（`packages/core/src/store/memory.ts:1147-1151`：`linkSupersede` → `archiveSuperseded`）。
- `purgeArchived` 直接 `DELETE FROM facts ... status='archived'`，不先解引用（`packages/core/src/db/dao/facts.ts:540-553`）。

### 后果【实测·本次】

- `runTrustTick` 在 `MemoryStore` **构造函数**里被调用（`packages/core/src/store/memory.ts:155`），无 try/catch；`buildRuntime`（`packages/core/src/runtime.ts:188`）也不包 ⇒ **插件 / CLI / MCP 启动直接失败**。
- 整趟 tick 是**一个 `tx.immediate()`**（`packages/core/src/lifecycle/tick.ts:79`），失败后 settle/TTL/idle 一起回滚。
- **没有自愈路径**：缺陷行不会被清理，之后每次启动都会再炸。心跳路径只吞日志（`packages/plugin/src/index.ts:216-220`、`packages/mcp/src/index.ts:99-104`），此后生命周期彻底停摆。

### 触发条件

配置键是 **`lifecycle.purge_after_archived_days`**（`packages/contract/src/config.ts:161`）——不在 `trust` 段下；写成 `trust.*` 会被 loader 判为未知键并忽略。但**触发条件是 `CASE` 的两个分支，两支的单位不同**（`facts.ts:544-548`）：任一 `update` 造的修订链，只要它被**当次 purge 谓词**命中，就会让这一趟 tick 抛错。

- **active-day 分支**（`trust.enabled = 1` **且** `archived_clock IS NOT NULL`，**默认走这条**）：`:clock - archived_clock > :purgeAfterDays`，单位是**活跃日**。谓词严格不等 ⇒ 配 `0` 也需**至少跨过一个活跃日**；同一 tick 内归档的行 `clock - archived_clock = 0` 因此不触发。【复核】按 `lifecycle.purge_after_archived_days: 0` 直接复现时 `purged: 0` 且不抛错；把 `archived_clock` 回填 `−1`（= 一个活跃日前）后立刻复现。
- **calendar 分支**（`trust.enabled = false` **或** `archived_clock IS NULL`，即 ELSE 支）：`julianday('now') - julianday(archived_at) > :purgeAfterDays`，单位是**日历日**。配 `0` 时归档后约一秒即成立。【复核·本次】用配置文件端到端复现：`trust: {enabled: false}` + `lifecycle: {purge_after_archived_days: 0}` ⇒ 第一次 `buildRuntime` 正常 → `add` + `update`（形成引用链）→ **第二次 `buildRuntime` 抛 `SQLITE_CONSTRAINT_FOREIGNKEY`**（`purgeArchived → tick.js:25`）。也就是说：**在这条合法配置下"时间炸弹"是立即引爆的**，不需要等 365 天。
- 附注：`config.ts:162` 对该键的注释写的是 "measured in ACTIVE days since `archived_clock`"，**只描述了第一支**；默认 `trust.enabled = true`（所以默认路径是 365 活跃日），但一旦走 calendar 分支，默认 365 就是 365 **日历日**——系统不是每天使用时，比 365 活跃日更早到。

> **写回归测试要覆盖两支**，不能只回填一种：active-day 分支需把 `archived_clock` 回填到窗口外（只把配置改成 `0` 会让测试"通过"而缺陷仍在）；calendar 分支用 `trust.enabled: false`（或把 `archived_clock` 置 NULL）配 `purge_after_archived_days: 0` 即可复现，**无需回填**。


### 为什么测试是绿的

现有测试只覆盖了 `contradiction_log.loser_fact_id` 那条 FK（`packages/core/test/lifecycle.spec.ts:639-657`），**没有**用修订链测过 purge。

### 现存数据风险（只读查了副本）

`~/.avantf/memory`：clock=0、7 条 active、0 条 archived、0 条 `supersedes_id` ⇒ **当前不在风险里**，修复不需要数据订正。

### 修法

1. **解引用后再删**（同一事务）——这是让**老库**不再崩的实际修复：

   ```sql
   UPDATE facts SET supersedes_id = NULL
    WHERE supersedes_id IN (<待 purge 的 fact_id 集合>);
   -- 然后 DELETE
   ```

   `toDetail` 对 NULL 已优雅降级（`packages/core/src/store/memory.ts:1213`；UI `packages/plugin/src/client/index.ts:467`）。
2. **新库 DDL 去掉这条 FK**（`supersedes_id INTEGER`，无 `REFERENCES`）：全仓没有任何查询按 `supersedes_id` 过滤，唯一消费者就是 FK 检查。
   【复核·本次修正】**老库保留 `REFERENCES` 与 `idx_facts_supersedes`**：SQLite 无法用 `ALTER TABLE` 去掉外键，而老库的 FK 仍在 ⇒ 删掉这条索引会让每次删除的 FK 检查从索引 seek 退化成表扫（更慢）。所以本轮只让**新库**不再生成这个陷阱；老库的余留（§2「同一 FK 的性能陷阱」）需要一次 `facts` 表重建迁移才能根除，单独立项——重建要连带处理 `facts_fts`（外部内容表 `content='facts'`，FTS5 的内部配置不会随 `ALTER TABLE RENAME` 改写）与 `facts_ai/ad/au` 三个触发器，风险远高于收益。
3. **守门测试**：`add → update → 回填 archived_clock 到窗口外 → runMaintenance`，断言不抛异常且 `purged_ids` 含旧修订。

### 同一 FK 的性能陷阱（子审查实测）

`sqlite_stat1` 覆盖 `idx_facts_supersedes` 后，该 FK 的检查计划由 `SEARCH ... (supersedes_id=?)` 变为**无约束全索引 SCAN**，而检查按每个被删行执行 ⇒ 子审查实测 60k facts 删 6000 行：**98ms → 11 669ms（119×）**；`foreign_keys=OFF` 回到 70ms。

本作者复核到的部分：`EXPLAIN QUERY PLAN DELETE FROM facts WHERE status='archived' ...` 的 FK 子程序里**确实**打印了 `SEARCH facts USING COVERING INDEX idx_facts_supersedes (supersedes_id=?)`，即"每删一行跑一次检查"这一成本承担者成立；119× 的绝对值未独立复现（复核脚本在 ANALYZE 段因合成数据主键冲突中断）。修掉上面的 FK 后此陷阱自动消失。

### 独立复核【复核】

用生产 DDL + 生产入口（临时 data home）重跑了整条链路，**全部与上述一致**：

```
add → fact 1                     update(fact_id=1) → fact 2 (active, supersedes_id=1) / fact 1 (archived)
PRAGMA foreign_keys              → 1
maintenance()                    → THROW FOREIGN KEY constraint failed
DELETE FROM facts WHERE fact_id=1 → THROW FOREIGN KEY constraint failed
重开 buildRuntime(...)            → THROW，栈 = FactsDao.purgeArchived → tick.js:25 → SqliteStatement.all
再重开一次                        → 仍 THROW（确认不自愈）
```

两点补充：

1. **knowledge 侧没有同类缺陷【复核】**。**knowledge 库**的 DDL 里只有两个外键，且都带动作：`doc_chunks.doc_id → documents(doc_id) ON DELETE CASCADE`（`db/knowledge.ts:28`）与 `chunk_entities.chunk_id → doc_chunks(chunk_id) ON DELETE CASCADE`（`:42`）。对照：**memory 库有 8 个外键**（`schema.ts:32,56,57,66,80,81,85`），其中**唯一无动作（NO ACTION）的正是 `supersedes_id`**。所以"不必全库排查外键"的结论成立，但范围应说成 knowledge 库——memory 库里的其余 6 个都带 CASCADE/SET NULL，不会产生本节这种"父行删不掉"的形态。
2. **它是"最近才可能发生"，不是"一直如此"【推断】**：修订链需要 `update` 造出 `supersedes_id` 非空的行，再等归档窗口过期。现存库 clock=0、无 archived、无 `supersedes_id`（报告作者已只读确认；本次复核未重跑该查询），所以两条路都还没走到——但默认窗口是 365 活跃日，**这是一个会随时间自动到期的时间炸弹**，不是"可能永远不会发生"。修法 2（去掉 FK）不改变任何查询行为，因此没有理由为了"看它会不会真发生"而推迟。

---

## 3. 实测数字总表

### 3.1 记忆侧（stub 语义，隔离 ONNX；每行含 8KB hrr + 实体 + 三元组）

| 操作 p50 (ms) | N=2k | N=10k | N=33k |
|---|---|---|---|
| `recall search`（选择性查询） | 18.4 | 74.4 | 234.5 |
| `recall search`（常见词，全库命中） | 18.3 | 94.4 | 314.6 |
| `recall search`（零命中） | 0.35 | 0.21 | 0.36 |
| `recall probe`（含 HRR 腿） | 91.1 | 451.9 | 1366.4 |
| `kb_query`（跨库） | 14.8 | 79.2 | 262.2 |
| `admin list`（limit 50） | 12.1 | 50.0 | 153.8 |
| `admin contradict_check` | 9.3 | 99.2 | 299.3 |
| `admin trust_diagnose` | 25.9 | 47.9 | 160.9 |
| `admin vectors_diagnose` | 8.8 | 10.3 | 41.6 |
| `admin stats` | 0.9 | 0.8 | 1.5 |
| `remember add` | 6.0 | 18.9 | 43.2 |
| `remember update`（无向量后端） | 9.7 | 19.1 | 44.5 |
| `trustTick`（预算 5000） | 80.0 | 280.9 | 356.2 |
| `maintenance`（settleAll） | 27.3 | 260.1 | 1322.5 |
| 候选扇出 FTS（常见词 / 选择性） | 2000 / 110 | 10000 / 550 | 33000 / 1815 |
| 候选扇出 jaccard（常见词 / 选择性） | 400 / 0 | 2000 / 0 | 6600 / 0 |
| HRR 候选行数 | 2000 | 10000 | 33000 |
| RSS | 398MB | 525MB | 775MB |
| memory.db | 19.1MB | 94.4MB | 312.5MB |

### 3.2 向量侧（stub 语义 + 真向量，`auto`→hnswlib）

| 指标 | N=2k | N=8k | N=16k |
|---|---|---|---|
| 种子耗时 | 5.4s | 22.0s | 41.3s |
| `buildRuntime`（含建索引） | 763ms | **6285ms** | **14688ms** |
| `remember update` | 664ms | **6303ms** | **13872ms** |
| `recall search`（选择性） | 20.3 | 64.5 | 122.0 |
| `recall probe` | 90.6 | 340.5 | 625.2 |
| `kb_query` | 18.6 | 60.8 | 114.2 |
| `admin list` | 15.3 | 46.3 | 82.1 |
| `remember add` | 7.2 | 20.1 | 23.6 |
| `maintenance` | 52.3 | 218.3 | 668.0 |
| RSS | 434MB | 629MB | 893MB |
| memory.db | 26.4MB | 104.4MB | 208.5MB |

### 3.3 知识库（**真模型** `bge-small-zh-v1.5`）

| 指标 | 299 chunks（76.6k 字符） | 4499 chunks（1.16M 字符） |
|---|---|---|
| `kb ingest` | 11.19s（**37.4ms/chunk**） | 151.5s（**33.7ms/chunk**） |
| 单块 encode（~300 字符） | — | **39.3ms** |
| 短文本 ingest（15 字符） | — | 4.55ms |
| `kb_query` | 9.1ms | **73.8ms** |
| 启动（重开含向量） | 5.6ms | **1635.6ms** |
| `reindex dry_run`（零 stale） | 4.2ms | 39.1ms |
| `reindex` 全量（**零 stale**） | 15.3ms | **1755.8ms**（第二次 1748ms） |
| 空库 `recall search`（真模型可用） | 4.26ms | — |

> **口径校正**：`DESIGN.md` §7 的 "encode 3.7–4.3ms" 是**短查询**的编码成本（本报告实测空库 search 4.26ms、15 字符 ingest 4.55ms）。编码成本随 token 数增长（本机约 0.1ms/token），**450 字符 chunk ≈ 35ms**——不要拿查询的 4ms 去推算入库。

### 3.4 微基准

| 项 | 值 |
|---|---|
| `estimateTokens`（1960 字符） | 57–62µs（约 30ns/字符，逐字符正则） |
| `truncateToTokens`（1960 字符） | 191µs |
| `fitToTokenBudget`（500 条 × ~350 字符） | 11.2–12.2ms |
| `pragma optimize`（bulk 插入后 / 第二次） | 9.5ms / 0.05ms |
| `track=true` vs `false` 每次 search 的 WAL | **8.6KB vs 0**；p50 +0.4ms（5k 语料、100 次） |
| `db.prepare` 每次现场编译 | 4.31µs vs 复用 1.29µs（子审查：6–8µs vs 0.4µs） |

---

## 4. 逐项发现

每条格式：**机制 → 拐点 → 证据 → 最小修复**。

### 4.1 hnswlib 下每次写入驱逐 = 全量重建 ANN 索引【实测·本次】

- **机制**：`removeMany` → `reindex()` 从 `this.vectors` 全量重建原生索引（`packages/retrieval-core/src/adapters/hnswlib.ts:156-183`）；`count() ≥ 2000` 时 `auto` 升级到 hnswlib（`packages/retrieval-core/src/adapters/auto_vstore.ts:19,62-75`；阈值 `packages/contract/src/config.ts:79`）。触发点：`update` 后驱逐 superseded（`packages/core/src/store/memory.ts:1133`）、反馈遗忘（`:396`）、`archive`（`:324`）、tick/maintenance 批量驱逐（`:170`、`:709`）。
- **拐点**：N≥2000。一次 update/archive 的成本 ≈ 一次全量建索引。
- **证据**：本次 `remember update` p50 **664ms@2k / 6303ms@8k / 13872ms@16k**（对照同规模无向量后端：9.7/19.1/44.5ms）。子审查独立测得 build 1.64s@2k、9.82s@10k，`removeMany([1 id])` 1.62s / 9.09s。
- **修复**：`remove()` 用 `markDelete` 墓碑，`vectors` Map 仍作 `fetch/count` 权威，墓碑占比超阈值再 compact；或把驱逐攒到 tick 一次性重建。已确认本机 `hnswlib-node` 暴露 `markDelete / unmarkDelete / getIdsList / writeIndex / readIndex`（`HierarchicalNSW.prototype` 实测）。**不要**改 `evictVectors` 优先 `removeMany` 的调用形状。
- **动这段代码前必读**：同一条 `reindex()` 路径此前还带着一个**召回**缺陷（不是成本）：`setEf` 的缓存只记数字，而 `reindex()`/`rebuild()` 会**替换**原生索引（新索引的 `ef` 回到默认 10），于是每次驱逐之后束宽不再重放、召回从 1.00 掉到 0.44。现在缓存按**索引实例**键控（`hnswlib.ts:49-57`，§6.8 列为"不要动"）。把它改成墓碑方案后，索引替换的时机变了——**重建后重放束宽这条不变式必须一起保住**，否则修完成本会静默换回召回问题。`hnswlib.spec.ts` 的"驱逐替换索引后束宽仍生效"一条就是守它的。

### 4.2 启动成本：HNSW 同步重建且从不落盘【实测·本次】

- **机制**：`AutoVectorStore.rebuild` 在 reload 后立刻 `maybeUpgrade()`（`auto_vstore.ts:57-75`），执行点在 `memory.ts:156` / `knowledge.ts:139` 的**构造器**里（同步）；原生索引从不持久化 ⇒ 每个进程启动都付一次全量 build。插件 `apply` 同步调用（`packages/plugin/src/index.ts:188,203`）；CLI 每条命令先 `buildRuntime`（`packages/cli/src/index.ts:86`），连 `list`/`stats` 都付。
- **证据**：`buildRuntime` 0.76s@2k / **6.29s@8k / 14.69s@16k**（记忆侧）；知识库 4499 chunks → **1.64s**。子审查另测 25.5s@20k。
- **修复**：(a) 升级推迟到首次 `topk`，纯 DB 命令零成本；(b) 用 `writeIndex/readIndex` 落盘，键含 `vectorSpaceId`+条数（换模型自动失效）；(c) 只读命令跳过 vstore 构建。

### 4.3 `admin list` 分页 O(N)：缺排序索引【实测·本次，已用索引验证】

- **机制**：`facts.page` = `ORDER BY created_at DESC LIMIT ? OFFSET ?`（`packages/core/src/db/dao/facts.ts:278-286`），现有索引是 `(status,category)` / `(status,pinned,settle_clock)` / `(status,ttl_days)` / `(status,pinned,archived_clock)`，**没有 `created_at`** ⇒ 计划 `SEARCH facts USING INDEX idx_facts_purge (status=?) | USE TEMP B-TREE FOR ORDER BY`，每次把 status 命中的全部行排序。
- **证据**：33k 行、行内含 8KB blob 时 store 级 `admin list` = **124.4ms**（原始 page SQL 120.7ms；`countInStatus` 1.09ms；显式列清单只降到 104.9ms ⇒ **瓶颈是排序不是 blob 宽度**）。加 `(status, created_at DESC)` 后 **2.13ms**（原始 page 0.84ms），建索引 116ms。40k 无 blob 表同样：7.25ms → 0.53ms。
- **附注**：行内 `hrr_vector`/`semantic_vector` 位于记录前部、`created_at` 在其后，所以排序还要穿过 blob 溢出页；深翻页 `ORDER BY fact_id DESC OFFSET 20000` 实测 75.4ms ⇒ 深翻页需 keyset 分页。
- **修复**：新增 `(status, created_at DESC)`（一条 migration）。

### 4.4 非语义检索腿无 LIMIT + `fuse` 全池排序【实测·本次 + 代码确证】

- **机制**：`facts.ftsSearch`（`facts.ts:449-457`）、`entities.activeFactsForAnyEntity`（`entities.ts:131-143`）、`chunks.ftsSearch`（`chunks.ts:250-260`）、`chunks.candidatesByEntityNames`（`chunks.ts:230-247`）、`facts.activeHrrRows`（`facts.ts:394-400`）**都没有 LIMIT**；只有语义腿被 `overFetch` 截断（`memory.ts:945`、`knowledge.ts:493`）。`fuse` 对合并池做 3× min-max + **全量 sort**（`packages/retrieval-core/src/fusion.ts:41-61`）。
- **拐点**：命中面随语料线性。实测 33k 时常见词 FTS 命中 **全库 33000**，jaccard 命中 6600（20%）；2k→33k（16.5×）时 search 18→234ms（13×，近似线性）。
- **修复**：FTS 腿加 `ORDER BY bm25(...) LIMIT :cap`、jaccard 侧 top-N 截断、`fuse` 改 partial top-k。**这改变候选集语义，需要 29 查询评测集把关。**
- **附带·查询形状**：`buildFtsQuery` 对无空格中文生成 `len-2` 个 trigram 且**不去重不封顶**（`packages/core/src/db/tokenizer.ts:84-90`）——80 字查询 = 78 个 trigram 的 OR；同时 **2 字中文被直接跳过**（`:86`），FTS 腿静默为空（召回缺口，非性能）。

  **这个缺口比"附带"更重，且评测集看不见它【复核】**。实测 `buildFtsQuery`：

  | 查询 | 输出 |
  |---|---|
  | `李娜` / `网关` / `中文` | **`null`** |
  | `数据库` | `"数据库"` |
  | `张伟管理李娜` | `"张伟管" OR "伟管理" OR "管理李" OR "理李娜"` |

  两侧调用方在 `null` 时**返回空腿**，不是降级为别的检索：`memory.ts:1017-1018`、`knowledge.ts:510-511` 都是 `if (!ftsQuery) return new Map()`。在无模型的降级路径下，一次 2 字查询只剩 jaccard（权重 0.35）一条腿；即使语义腿在线，缺的恰恰是**为精确名字/术语而存在的词法腿**——而中文里 2 字词正是人名与术语的常态（评测集自己的实体名 `李娜`/`张伟` 就是 2 字）。

  **关键**：29 条评测查询里**汉字数 ≤2 的有 0 条**（全部是"李娜管理谁"这类句子式查询）。所以"改检索腿需 29 查询评测集把关"（§9 第 6 步）**对这条改动是不设防的**——同一句话里既说要用评测集守护 FTS 腿、又说 FTS 腿在最常见的 2 字形状上是空的，两者不能并存。**动手改 FTS 腿之前，先往评测集加 2 字查询**（名字类 + 术语类各若干），否则那次改动会让 2 字查询的情况在无声中变坏或变好都无从判断。门槛写法见 §10.2 第 10 项。

### 4.5 HRR probe O(N·1024)【实测·本次 + 代码确证】

- **机制**：`hrrPath` 拉全部 active 的 8KB `hrr_vector`（`facts.ts:394-400`）后逐行 `hrrFromBytes` + `phaseSimilarity`（1024 次 cos），产出的 Map 有 N 条 ⇒ 成为 fuse 的**第 4 条腿**，池子≈N。33k 行 = 每次 probe 读 **264MB** blob。另 `atom()` 每实体 256 次 SHA-256（`packages/core/src/hrr/atoms.ts:21-48`），**每次写都重算**（`memory.ts:1066`，且在判重**之前**，纯重复 add 也付）。
- **证据**：probe p50 **91 / 452 / 1366ms**（2k/10k/33k），比同规模 search 慢 4–6×。子审查实测 `atom` 0.72ms/实体、4 实体 `encodeHrrEntityVector` 3.06ms、`hrrToBytes` 0.80ms ⇒ **约 3.9ms/写**（与一次 ONNX 编码同量级）。
- **修复**：probe 先用实体/jaccard 候选裁剪再算相位相似；`atom` 加进程内 memo（纯函数、确定性）；重新评估 hrr dim=1024（**8KB/行 > 语义向量 2KB**，100k facts = 800MB 存储）。

### 4.6 生命周期 tick / maintenance【实测·本次 + 实测·子审查】

- **机制**：`runTrustTick`（`packages/core/src/lifecycle/tick.ts:41-79`）五段，只有 ① 受 `tick_max_facts`（默认 5000）限制（且只限制**被 UPDATE 的行数**，不限制扫描量），②③④⑤ 无预算；`maintenance()` 传 `budget: 0` ⇒ `settleAll` 全表 UPDATE（`packages/core/src/lifecycle/maintenance.ts:49`）。`retireConflicts` 对每个归档 id 一条 autocommit UPDATE（`memory.ts:722-724`）。
- **实测·本次**：`trustTick` 80 / 281 / 356ms（2k/10k/33k），33k 时 `settled=5000, skipped=28000`（一次补不完）；`maintenance` 27 / 260 / **1322ms**。`pragma optimize` 首次 9.5ms、其后 0.05ms ⇒ **不是**主要成本。
- **实测·子审查**：180k active 时一次标准 tick **194ms**，但单次归档 **14400 行**（预算 5000 完全没约束住归档量）；`retireConflicts` 在 99k 未决冲突下，999 个 id = **6331ms**；②③④⑤ 的谓词不可 sargable（`CAST` / `trust_score<=?` / `COALESCE+julianday` / `CASE`）⇒ 每 tick 固定 O(active)+O(archived)。
- **修复**：`retireConflicts` 批量化成两条 `UPDATE ... fact_a IN (...)` / `fact_b IN (...)`；`tick_max_facts` 推广为对所有段的预算（至少对 `archived_ids` 截断）；按 §5.3 的建议补索引并把谓词改 sargable。

### 4.7 矛盾检测的冲突日志：全表读 + OR 破坏索引【实测·本次 + 实测·子审查】

- **机制**：每次新建/复活写都调 `suppressedPairs()`（`packages/core/src/lifecycle/contradiction.ts:183` → `dao/contradictions.ts:47-54`），谓词 `resolved = 0 OR resolved_by = 'verdict'` **无法使用** partial 唯一索引 `idx_contradict_open_pair(fact_a,fact_b) WHERE resolved=0`（该 OR 不蕴含 `resolved=0`）⇒ `SCAN contradiction_log`；`resolveForFact`（`dao/contradictions.ts:107-116`）与 `openConflictsFor`（`:147-162`）的 `(fact_a=? OR fact_b=?)` 同样退化。
- **实测·本次**（100k open pairs，实际只命中 2 行）：suppression 全表读 **60.8ms / 99998 行**；`resolveForFact` 形状查询 4.03ms（`SCAN ... USING COVERING INDEX idx_contradict_open_pair`）；实际 UPDATE **9.43ms**；`openConflictsFor` 形状 5.05ms（SCAN + temp b-tree）。子审查另测 99k 未决：95.6ms 查询 + 40.3ms 建 Set / 每次写。
- **修复（已实测，见 §5.3）**：非 partial `(fact_b)` 索引 ⇒ 0.031ms / UPDATE 0.083ms / open 0.037ms；suppression 改为**按 fact 定向读** ⇒ 0.06ms。

### 4.8 写入路径的规模相关项【实测·子审查】

- **hub 候选无上界**：`findEntitySharing`（`contradiction.ts:232-240`）只剪部分候选，热点实体可让候选数 = hub 大小 H；`candidateFacts` 实测 H=1k/10k/30k/100k → **2.9 / 17.8 / 66.7 / 233.1ms**，随后逐对 `detectContradictionEmbedding` 2.49µs/对（dim=512、E=3）⇒ 3 万候选再约 75ms。端到端 `add` H=0/1k/10k/30k → 9.6 / 19.8 / 39.1ms（与本次 add 6.0→43.2ms 的曲线吻合）。
- **结构性浪费**：结构腿第二条查询固定分 `OBJECT_CONFLICT_SCORE = 0.5`（`contradiction.ts:13`）< 默认阈值 0.6 ⇒ **永远不可能记账**，却每个三元组跑一次（`contradiction.ts:203-204` 调 `findSameSubjPredOtherObj`，`contradiction.ts:284` 的 `maybeLog` 直接 return）；T≤8 ⇒ 每次写最多 8 条白跑。
- **模型不可用时的退化**：`changed` 集合无界增长（实测连写 300 次 → `size = 300`），且 `embeddingPass` **先建候选宇宙再发现有向量**（`contradiction.ts:246-256` vs `:269`）⇒ SQL 白跑；`maybeIndexSemantic` 的 catch 完全静默（`memory.ts:276-278`），dim 漂移这类系统性失败看不见。
- **FTS 触发器写放大**：memory 实测 5000 行 ~40 字符：带触发器 **205.9ms** vs 去掉 **35.1ms** ⇒ **5.9×**（体积 1.17×）；子审查另测 100k 行 14.3µs/行 → 60.0µs/行（4.2×）。

### 4.9 每次调用的固定开销【实测·本次 + 实测·子审查】

- **语句无缓存**：DAO 每次 `prepare`（better-sqlite3 无 JS 层缓存）；一次 `search` ≈20 条 SQL、`add` 15 条、`update` 22 条 ⇒ 纯编译 65–95µs。【子审查实测：prepare 6–8µs vs 复用 0.4µs】
- **重复 add 的浪费**：`add` 在判重前算 HRR（**3.9ms**）且仍做 `linkEntities/insertTriples`（每实体 3 条语句）——重复 add 实测 10 条语句中 6 条是这部分。
- **jieba 每写两遍**：`extractEntities` 与 `extractTriples` 各自 `jieba.tag()`（`memory.ts:216-217`）；实测 len=20/200/2k/20k → 合计 **0.44 / 0.78 / 5.81 / 48.2ms**（约 1.1ms/千字符/遍）。写入侧没有长度守卫（embedding 侧已有 `bound()`）。
- **`maxTokens: 0` 仍全量估 token**：`fitToTokenBudget` 的无预算分支照样逐条估算并复制（`packages/retrieval-core/src/budget.ts:49-53`），而 3 个调用点（memory / knowledge / router）**全部丢弃 `used_tokens`** ⇒ 跨库查询对同一批文本估 2–3 遍。
- **`estimateTokens` 逐字符正则**：约 30ns/字符（`text_budget.ts:47-55`）；`truncateToTokens` 对同一段文本至少扫 2 遍。
- **读路径写放大**：`recall search` 默认 `track=true` ⇒ 每次 13 条写语句（`memory.ts:878-899`）；实测 **WAL 8.6KB/次搜索**、p50 +0.4ms（跨库 `kb_query` 已 `track=false`）。
- **`SELECT *` 取 blob**：`getById/findByContent/rowsByIds/page` 都把 8KB HRR + 2KB 向量读进只需标量列的路径；`reinforce` 一次最多 overFetch 行 ⇒ 约 500KB blob I/O/查询。
- **`presence` 冗余**：`advancePresence` 已 `new StatsDao`，却仍调 `readClock/readLastSeen` 各再 new 一次（每次 presence 3 个 DAO 对象、2 次多余编译，约 7µs）；`readClock` 在 `memory.ts` 被调 11 处，`persistFact` 一次写调 2 次。

### 4.10 知识库入库与 reindex【实测·本次（真模型）+ 实测·子审查】

- **串行编码是绝对主成本**：真模型实测 **33.7–37.4ms/chunk**，1.16M 字符 ingest = **151.5s 单次同步调用**；`encodeBatch` 生产代码**零调用**且实现本身是串行循环（`packages/retrieval-core/src/adapters/local_bge.ts:174-178`）⇒ 即使调用也不会批处理。按 `MAX_DOC_CHARS=20M`【推断】一次 ingest 约 25 分钟。
- **`setVector` 逐块 autocommit**：`knowledge.ts:242` / `:391` → `chunks.ts:107-111`；实测 14.2µs/行 vs 单 tx 2.2µs/行。
- **FTS trigram 触发器写放大**：knowledge 实测 5000 chunks：**313ms vs 15ms（20.9×）**，全量 `rebuildFts` 只要 32ms。
- **零 stale 的 reindex 仍付全量**：实测 4499 chunks = **1.76s**（两次一致），其中 HNSW 重建约 1.6s；根因是末尾 `reloadIndex()` 全量重载（`knowledge.ts:398`），而刚 encode 出的 `vec` 就在手上。
- **单文档多次整份驻留**：源串 + `lines[]` + `chunks[]`（1.10×）+ SQLite 页 + `texts()` 回读（`knowledge.ts:176,228`）+ `extracted[]`（`knowledge.ts:274-281`，实为同步块，会卡住宿主事件循环）同时存在；`MAX_DOC_CHARS=20M` / `MAX_DOC_BYTES=80MB`。
- **`importPaths`**：逐文件串行 `await this.ingest`（`knowledge.ts:303-322`）+ 递归 spread（`:537-546`）。
- **保留项**：`vectorReusable` 的 sha1 守卫（实测 380MB/s；`dry_run` 39.1ms@4499 chunks）是"已编码"的判据，**不要删**；短路顺序已最优。

### 4.11 索引缺口与死索引【实测·子审查 + 部分本次复核】

现有索引见 `packages/core/src/db/schema.ts:41-46,63,75-77,92,124`。

| 表 | 谓词 | 现有索引 | 建议 | 拐点 / 收益 | 写代价（150k insert） |
|---|---|---|---|---|---|
| facts | `ORDER BY created_at DESC LIMIT/OFFSET`（`facts.ts:283`） | 无 | `(status, created_at DESC)` | ≥20k：首页 26–38ms → **0.4ms**；OFFSET 100k 490ms → 6–10ms | +2.3µs/行，+1659 页 |
| facts | idle `COALESCE(last_retrieved_at,created_at)`（`facts.ts:532`、诊断 `:364`） | `idx_facts_idle` **用不上** | 表达式索引 + 谓词改 sargable | ≥50k：33–212ms → 0.1–0.3ms | +1.8µs，+1715 页 |
| facts | `trust_score <= ?`（`facts.ts:518`） | 无 | `(status,pinned,trust_score)` | ≥50k：18.6–27.4ms → 0.1–0.3ms | +1.6µs，+1048 页 |
| facts | `bonus_count>0 AND julianday(...)`（`facts.ts:337-338` 与 `:351`） | 无 → SCAN | `(bonus_count,bonus_window_at)` + 谓词改写 | ≥20k：13.4–16.2ms → 0.5–0.7ms | +0.2µs，+432 页 |
| contradiction_log | `resolved=0 AND (fact_a=? OR fact_b=?)`（`contradictions.ts:113`） | partial ⇒ OR 全扫 | 非 partial `(fact_b)` + 拆两条 UPDATE | ≥1k 归档×有未决：5.7ms/条 → µs | 低 |
| contradiction_log | `resolved=0 OR resolved_by='verdict'`（`contradictions.ts:50`，每次写） | 无 → SCAN | 定向查 / `(resolved,resolved_by)` | 99k 未决：95.6ms+40.3ms/写 | 低 |
| triples | `subj IN (...) AND fact_id IN (SELECT ... status='active')`（`triples.ts:95,110`） | autoindex ⇒ 从子查询驱动 = O(active) | 用 `triples.ts:27-41` 的 JOIN 重写 | ≥100k：每次 `chain`/`ask` O(active) | 无 |
| fact_entities | `e.name=?` join（`entities.ts:102-112`） | 有索引但计划不用 | 加 `INDEXED BY idx_fact_entities_entity` | ≥200k 链接 | 无 |
| documents | `ORDER BY updated_at DESC`（`documents.ts:49`） | 无 | `(updated_at DESC)` | ≥10k 文档才明显，低优先 | 低 |
| facts | `semantic_vector IS NOT NULL`（`facts.ts:48,93,388`） | 无 → SCAN | 部分索引（收益有限，**可不动**） | ≥100k：18ms/次 | 中 |

**死索引 / 半死索引**

| 索引 | 谁在用 | 结论 |
|---|---|---|
| `idx_facts_idle`（`schema.ts:44`） | **没有任何查询能用**（两个 idle 谓词都被 `COALESCE`+`julianday` 包住；本次实测该谓词的 plan 走 `idx_facts_purge`） | **纯负担**：本次实测 `touchUsage(10 ids)` @150k 行 **36µs → 27µs（1.33×）**；子审查在另一表形下测得 2.4×。方向一致，**建议删**（收益按 1.3–2.4× 区间表述） |
| `idx_facts_supersedes`（`schema.ts:42`） | 只被 NO ACTION FK 检查使用，无查询按 `supersedes_id` 过滤 | 保留的唯一理由是 FK，而该 FK 正是 §2 的根源 ⇒ 去 FK 后一并删 |
| `idx_contradict_loser`（`schema.ts:92`） | FK `ON DELETE SET NULL` | **有用，别删**（`test/lifecycle.spec.ts:639` 在守它） |

**死索引判断已独立确证【复核】**：对生产 idle 谓词本身跑 `EXPLAIN QUERY PLAN`（而非简化形状），得到

```
SELECT fact_id FROM facts WHERE status='active' AND pinned=0
  AND julianday('now') - julianday(COALESCE(last_retrieved_at, created_at)) > 365
→ SEARCH facts USING INDEX idx_facts_purge (status=? AND pinned=?)
```

`idx_facts_idle (status, pinned, last_retrieved_at)` 完全没被选中——列被 `julianday(COALESCE(...))` 包住，无法用于范围约束，计划退回到只按 `(status, pinned)` 定位。同一条对照（`trust_score <= 0`）也是同一个计划，与表中"无索引、需全扫 active+unpinned"一致。**删它是安全的**。

**我复核到的一条加强证据**（本次）：`EXPLAIN QUERY PLAN DELETE FROM facts WHERE status='archived' AND pinned=0` 的 FK 子程序为

```
SEARCH facts USING COVERING INDEX idx_facts_purge (status=? AND pinned=?)
SEARCH contradiction_log USING COVERING INDEX idx_contradict_loser (loser_fact_id=?)
SCAN contradiction_log          ← fact_a 的 CASCADE（partial 索引用不上）
SCAN contradiction_log          ← fact_b 的 CASCADE
SEARCH triples USING COVERING INDEX idx_triples_fact (fact_id=?)
SEARCH fact_entities USING COVERING INDEX sqlite_autoindex_fact_entities_1 (fact_id=?)
SEARCH facts USING COVERING INDEX idx_facts_supersedes (supersedes_id=?)
```

即**每删一行**都会跑两次 `SCAN contradiction_log`。这让非 partial `(fact_a)`/`(fact_b)` 索引的价值比"只修 OR 查找"更大：它同时服务 OR 查找、`resolveForFact`/`openConflictsFor`、以及 purge 的 CASCADE 检查。（本次实测：40k facts 删 4000 行 = 33.9ms。）

### 4.12 并发 / 多进程【实测·子审查 + 代码确证】

- 打开方式：DSH host / CLI / MCP 各自打开同一个库，`WAL + busy_timeout=5000`（`packages/core/src/db/store.ts:18-19`）。
- `runTrustTick` 是**单个 `IMMEDIATE` 事务**（`tick.ts:79`），内含 ②③④⑤ 的全表/全索引扫 + purge 的 FK 动作 ⇒ 单次 tick >5s 时其他进程的写路径 `SQLITE_BUSY` 失败（§2 的 stat1 场景或大批归档可直接触发）。
- **已做对**：向量索引变更在 DB 事务**之外**（`memory.ts:170`、`:1132-1133`）；`advancePresence` 锁持有微秒级；`WAL + synchronous=NORMAL` 不放大 fsync。

### 4.13 可观测性【实测·子审查：无需改动】

- `retrievalHealth()` 是 O(#kinds) 的普通对象拷贝（`packages/retrieval-core/src/stats.ts:86-88`），**不是** Map 复制；`flushHealth` 只在 `maintenance()` / `shutdown()` 调用；`retrievalLogger()` 不在热路径。
- `admin stats` 的真实成本是 `countByStatus()` 的两条 `COUNT(*) WHERE status=?`（实测各 **7ms@180k**）。
- **两处计数失真**（正确性，非性能）：`knowledge.search` 在 `ids.length===0` 时**早于** `recordRetrieval` 返回（`knowledge.ts:442` vs `:468`）⇒ 零结果只统计 memory 腿；`kb_query` 不记 `kind:'cross'` ⇒ 一次跨库查询被记成 2 条腿事件，`avg_*` 的分母是"腿"不是"用户查询"。

  **两处均已独立确证【复核】**：`:442` 的 `if (!ids.length) return []` 确实在 `:468` 的 `recordRetrieval` 之前；`kind: 'cross'` 在 `packages/core/src/**` 里**零次出现**（虽然 `RetrievalEvent.kind` 的注释把它列为三个取值之一）。

  **这条要排在性能任务之前做**（§9 第 2 步）：§10.2 第 9 项要把 `avg_*` 与 `zero_result_rate` 当回归门槛，而这两个失真正好改变这两类数字的定义（零结果漏计知识腿；分母从"用户查询"变成"腿"）。**先修计数、再量基准**，否则 before/after 是拿一把坏尺子量出来的——而且这两个计数器本身是新近引入的（`45901a9`），所以此刻还没有任何历史基线需要保留。

---

## 5. 已验证的修复（事前/事后都实测）

### 5.1 `admin list` 排序索引

| 项 | 修复前 | 修复后 | 手段 |
|---|---|---|---|
| 原始 page SQL @33k（8KB blob/行） | 120.7ms | **0.84ms** | `(status, created_at DESC)` |
| store 级 `admin list` | 124.4ms | **2.13ms** | 同上（建索引 116ms） |
| 原始 page SQL @40k（无 blob） | 7.25ms | 0.53ms | 同上（建索引 22.5ms） |
| 计划 | `SEARCH facts USING INDEX idx_facts_purge (status=?) \| USE TEMP B-TREE FOR ORDER BY` | `SEARCH facts USING INDEX bench_idx_facts_status_created (status=?)` | — |

### 5.2 冲突日志索引（100k open pairs，实际命中 2 行）

| 查询形状 | 修复前 | 修复后（非 partial `(fact_b)`） | 倍数 |
|---|---|---|---|
| `resolveForFact` 查找 | 4.03ms（`SCAN ... idx_contradict_open_pair`） | **0.031ms**（MULTI-INDEX OR） | 130× |
| 实际 `UPDATE ... resolved=1` | 9.43ms | **0.083ms** | 114× |
| `openConflictsFor` 查找 | 5.05ms（SCAN + temp b-tree） | **0.037ms** | 136× |
| 每次写的全表 suppression 读 | **60.8ms / 99998 行** | 定向读 **0.06ms** | 1000× |

### 5.3 被实测**证伪**的直觉方案

只加 **partial** 索引 `(fact_b, fact_a) WHERE resolved = 0` **无效**：`openConflictsFor`/`suppressedPairs` 的谓词含 `OR resolved_by='verdict'`，不蕴含 `resolved = 0`，partial 索引无法使用；`UPDATE` 的 OR 在该组合下也仍然 `SCAN`（实测计划字符串未变）。必须用**非 partial** 索引（或把 OR 拆成两条各自可 seek 的语句）。

---

## 6. 已经做对、不要动

1. **事务内绝不 await**：慢 ONNX 编码与矛盾检测都在事务提交**之后**（`memory.ts:1131-1133`、`:226`、`:228`）；全仓 9 处 `transaction` 全部同步。别把 detect 挪进事务。
   ⚠️ 顺带修正一处**过时注释**：`packages/core/src/db/port.ts:14-17` 与 `DESIGN.md:265` 写"`persistFact` 在事务内跑矛盾检测"，与代码不符。【复核】两处都已确认：`port.ts` 的原文是 "`persistFact` runs contradiction detection inside its transaction"，`DESIGN.md:265` 的原文是"`persistFact` 在事务内跑矛盾检测"，而 `memory.ts:1132` 的注释明确写着 **"After the commit (see `applySupersede`), never inside the transaction"**，`add` 侧的检测也发生在 `persistFact` 返回之后（`memory.ts:213`）。注释描述的是**代码明确拒绝的做法**。
2. **先建索引再自检**（`memory.ts:222-228`）：让新事实参与自己的冲突检查，顺序别调换。
3. **重复 add 短路**（`memory.ts:228,232`）：不 notify / 不 detect / 不 encode，也不重报已 open 的冲突——刻意的静默 no-op。
4. **`batches()`（500/语句）** 覆盖所有随语料增长的 `IN`（`db/chunk.ts:13-19`），并有 3.3 万 hub 回归测试（`test/lifecycle.spec.ts:137-164`）。改回单条 `IN` 会让一条腿**静默失效**。
5. **`INDEXED BY idx_fact_entities_entity`**（`entities.ts:84-99`，115ms→0.13ms）与结构腿的 JOIN 重写（`triples.ts:27-41`，202ms→0.18ms）+ 对应计划测试（`test/lifecycle.spec.ts:121-135`）。注意 `triples.ts:95,110` 仍有同类反模式（§4.11）。
6. **`evictVectors` 优先 `removeMany`**（`memory.ts:727-731`）：调用形状是对的，问题在 hnswlib 的实现（§4.1）。
7. **vstore 增删在事务提交之后**（防回滚后索引与库不一致）。
8. **`efOn` 按索引实例键控 ef**（`hnswlib.ts:49-57,108-120`）：rebuild 后必须重放束宽，否则召回掉回 0.44；别改成只比数字。
9. **跨库只编码一次**（`runtime.query` 把 queryVector 传给两库）：`DESIGN.md` §7 的 7.57→5.29ms 就靠这条。
10. **`fitToTokenBudget` 的 pass-2 记账**与"只降级文本、不丢条目 + `truncated` 可见"（`budget.ts:44-47,61-62,92-105`）；要改的只是 `maxTokens<=0` 分支。
11. **外部内容 FTS5 + `content UNIQUE` + `INSERT OR IGNORE` 幂等**；触发器只对 `UPDATE OF content`（`schema.ts:148`），写路径 content 从不 UPDATE ⇒ `facts_au` 根本不触发。
12. **`reloadVectorIndex` 两库共用、dim 不符跳过并告警一次**；`vectorSpaceId` 含 backend/model/dim（`db/vectors.ts:32-34`）；**`vectorReusable` 的 sha1 守卫保留**。
13. **`chunkText` 是 O(n)**（实测 µs/char 随规模单调下降）、`pragma optimize` 的频率与设计注释一致（stat 新鲜 0.05ms）、`WarmGate` 观测式重试、健康快照持久化恢复。
14. **`WAL + synchronous=NORMAL + busy_timeout`**、**`settleBudgeted` 子查询走 `idx_facts_trust` 索引序无 temp b-tree**、**`retrievalHealth` 按 kind 拷贝**、**`idx_contradict_loser`**。

---

## 7. 相邻发现（非性能）

审查过程中发现的、不属于性能范畴但值得单独立项的问题：

1. **P0**：`supersedes_id` FK 让 purge 抛错并阻断启动（§2）——**功能缺陷**。
2. **memory 侧 `facts_fts` 没有 rebuild 路径**：全仓只有 `doc_chunks_fts` 有（`dao/chunks.ts:225-227`）。迁移 v1 用 `CREATE VIRTUAL TABLE IF NOT EXISTS` 接纳旧库时 FTS 为空、触发器只对之后的行生效 ⇒ **老事实永远不在 FTS 腿里，且没有任何命令可补建**。建议补一个与 knowledge 同形的 rebuild 并接进 `maintenance()`。
3. **2 字中文查询的 FTS 腿静默为空**（`tokenizer.ts:86`）。
4. **健康度计数两处失真**（§4.13）。
5. **`initClock` 无生产调用者**（仅测试用）——但它丢掉的是一套自愈承诺【复核】。它的 docstring 写明这是 **spec §2.1 的时钟自愈**：`max(readClock, maxSettleClock)`，即"元数据行丢失而事实还在时，时钟不得落后于它们的 `settle_clock`"。而 `advancePresence` **不做这件事**——它只做 `clock + min(gapDays, gap_cap_days)`，默认每次 presence 最多推进 **1 天**。全仓 grep 该函数只有定义、无调用点。

   后果：一旦时钟落后于 `settle_clock`（元数据丢失/库从备份恢复/更早的版本写入过 `settle_clock` 而没有同步时钟），受影响的事实**在时钟追上来之前不会被 settle**，而追赶速度是每次启动 1 活跃日——不是设计里写的"直接 snap 到 `max`"。**二选一**：把它接进启动路径（或 `advancePresence` 的开头），或者删掉函数并把"自愈"从 presence 的注释与 spec 叙述里撤掉。留着一个"看起来实现了、实际从不执行"的安全网，比没有它更糟。

   **若选择"接上"，三个实现要点【复核·本次】**：① 放进 `advancePresence` 的 `IMMEDIATE` 事务内（或同事务之前）——否则两个进程同时启动会各 `max` 一次互相覆盖，而 `advancePresence` 的 IMMEDIATE 正是为这类跨进程 RMW 准备的；② **只在确有落后时**才跑：`maxSettleClock()` 是全索引扫描（子审查实测 200k 行约 10–13ms），无条件挂在冷启动路径上会把它加到每次启动；③ 判据可直接用 `readClock(db) < (maxSettleClock() ?? 0)`。
6. **`DESIGN.md:265` / `db/port.ts:14-17` 的过时注释**（§6.1）。

---

## 8. 内存与存储占用

| 项 | 数值 | 证据 |
|---|---|---|
| 启动峰值 / 原始向量字节 | **3×**（local_numpy）/ **4.8×**（auto 升级瞬间叠加 native） | 【实测·子审查】N=20k dim=512（原始 39.1MB）→ BLOB 39.1 + 解码 39.1 + 归一化 39.1 = 117MB（RSS +137MB），再加 hnsw native +70.8MB |
| 进程 RSS（本次） | 434 / 629 / 893MB @2k/8k/16k（vec 模式） | 【实测·本次】 |
| `hrr_vector` | **8KB/行**（> 语义向量 2KB）；100k facts = 800MB | 【代码确证】`schema.ts:27` |
| blob 读取 | better-sqlite3 对 `SQLITE_BLOB` **恒用 `Buffer::Copy`** ⇒ 每行一份新拷贝；`bytesToFloat32` 再拷；`local_numpy` 归一化又拷 | 【实测·子审查】 |
| 单文档驻留 | 源串 + lines + chunks(1.10×) + DB 页 + 回读 + extracted 同时存在 | 【实测·子审查】 |

**修复**：`bytesToFloat32` 在 4 字节对齐时用 `new Float32Array(buf.buffer, byteOffset, len)` 零拷贝视图；`reloadVectorIndex` 改吃 generator（峰值约 −33%）；去掉 hnsw `rebuild` 里的 `[...rows]` 冗余物化。

---

## 9. 落地顺序

| 顺序 | 项 | 类型 | 实测代价 | 备注 |
|---|---|---|---|---|
| **1** | `supersedes_id` purge FK：解引用后删 + 新库 DDL 去 FK + 回归测试 | **正确性** | 启动直接抛错 | 现存库无历史数据要订正；**应最先做**。回归测试覆盖**两个分支**（active-day 需回填 `archived_clock`；calendar 分支用 `trust.enabled:false` + `purge_after_archived_days:0`，无需回填），见 §2「触发条件」。**不要**对老库 `DROP INDEX idx_facts_supersedes`：老库的 FK 仍在，去掉这条索引会让每次删除的 FK 检查退化成全表扫 |
| **2** | 健康度计数两处失真（`knowledge.search` 早退漏记零结果；`kind:'cross'` 从未记录） | **正确性** | 无（改动极小） | **插在这里的理由**：§10.2 要用 `avg_*` / `zero_result_rate` 当门槛，而这两处正好改变它们的定义。先修尺子再量 |
| **3** | hnswlib：`markDelete` 墓碑 + 惰性升级 + 索引落盘 | 性能 P0 | update 13.9s@16k；启动 14.7s@16k | 收益最大；用 `hnswlib.spec.ts` 召回测试与 `bench-vstore.mjs` 作门禁；**注意保住 §4.1 末尾的束宽不变式** |
| **4** | `(status, created_at DESC)` + 非 partial `(fact_a)`/`(fact_b)` + `retireConflicts` 批量化 + 定向 suppression + 删 `idx_facts_idle` | 性能 P1 | list 124→2ms；冲突查找 4.0→0.03ms | 小改动、可独立验证；同时修好 purge 的 CASCADE |
| **5** | tick 各段 sargable 谓词 + 预算化（idle 表达式索引 / trust_score / bonus） | 性能 P2 | tick 194ms@180k，单次归档 14400 行 | 多进程 `SQLITE_BUSY` 的根因 |
| **6** | **先扩评测集**（2 字中文查询，见 §4.4/§10.3），**再**改检索腿 top-N + HRR 候选裁剪 + `triples.ts:95,110` 改 JOIN | 性能 P2 | search 315ms@33k；probe 1366ms@33k | 顺序不能反：现有 29 条查询里没有 2 字形状，拿它把关等于不设防 |
| **7** | 知识库真 batch encode + `setVector` 单事务 + `reindex` 免 reload + 固定开销（语句缓存 / atom 缓存 / jieba 单次 / `maxTokens==0` 短路 / `SELECT` 显式列） | 性能 P3 | ingest 151s/1.16M 字符；零 stale reindex 1.76s | 分期做 |
| **8** |（可选）§7 的相邻项：memory 侧 `facts_fts` 补 rebuild、`initClock` 接上或删除、两处过时注释 | 正确性/卫生 | 老库 FTS 永远为空 | 与性能任务解耦，可并行 |

---

## 10. 验证方案与回归门槛

### 10.1 计划级门禁（照抄 `test/lifecycle.spec.ts:121-130` 的 `plan(sql, params)` 辅助）

- 断言 tick ① 为 `SEARCH facts USING COVERING INDEX idx_facts_trust (status=? AND pinned=?)` 且不含 `SCAN facts`。
- 断言 ②③④⑤ 各自吃到目标索引（`idx_facts_ttl` / 新 `(status,pinned,trust_score)` / 新表达式索引 / `idx_facts_purge`）。
- **关键**：对 `EXPLAIN QUERY PLAN DELETE FROM facts WHERE status='archived' AND pinned=0 ...` 单独断言——只有这个 plan 会打印 FK 子程序（`idx_contradict_loser` / `SCAN contradiction_log ×2` / `idx_facts_supersedes`），是抓 §2 性能陷阱的唯一入口。
- 同一组断言在 `ANALYZE` **前后**、`PRAGMA optimize` **前后**各跑一遍（plan 差异只在这些时机出现）。
- 死索引守卫：遍历全部生产 SQL，断言没有任何语句的 plan 引用 `idx_facts_idle`。

### 10.2 断言式基准（写成门槛，而不只是打印数字）

1. `hnswlib` 下单次 update **不随 N 线性增长**。
2. `add`/`update` 的**语句条数不随 N 与 open 冲突数增长**（用包装 `Db` 端口计数；注意 FTS 触发器语句不在端口计数里，写放大必须用耗时/体积对比测）。
3. 语义后端不可用时连写 M 次：`trust_diagnose().conflict_pending` 等于 M，且**新进程在同一库上仍是 M**、`checkContradictions()` 返回空（`lifecycle.spec.ts` 的"排队 6 条 / 重启后仍是 6"）。**原写法"`changed.size` 不增长"已作废（溯源改动）**：`changed` 是检测器里的内存集合，已随 §20.16 的持久化队列删除，那个断言的**对象不存在了**——而且它守的性质也反了：队列现在**应当**随"模型不可用期间的写入"增长（那是诚实的落后量），要守的是它**不丢**（跨进程仍在）而不是它不涨。
4. 零 stale 的 `reindex` **不重建 vstore**；`encodeBatch` **不劣于逐条 encode**（`pnpm bench:ingest` 的 ms/块 ≤ 逐条基线）且三条行为各有单测（顺序还原 / 长度分组 / 无法批答时回退逐条）。**原写法"`encodeBatch` 调用数 > 0"已撤回（实施批次 5）**：摄入路径当初申报的正是"改成调用 `encodeBatch`"，实测按文档顺序分批反而慢 1.79×（§4.6 与 §9 第 7 步），所以生产路径**刻意不调用**它；把"调用数 > 0"当门槛等于把一个已被实测否决的方案写回代码。方法保留在接口上（短而均匀的文本仍有 9.96 → 6.71 ms/文本的收益），门槛因此改成"**不比逐条更慢** + 三条行为被钉住"。
5. 合成阶梯 10k / 50k / 200k：逐条测 tick 的 6 条 SQL + `page()` + `retireConflicts(1000 ids)` + `touchUsage(10 ids)`，拟合成 µs/行并设上限。
6. 索引 A/B 必须**同时**量写代价：150k 行插入 µs/行与 `PRAGMA page_count`（基线：6 索引 13.8µs/行 & 11904 页）。
7. 多进程：两个连接打开同一临时库，A 跑 tick/maintenance，B 反复 `remember`，断言不出现 `SQLITE_BUSY`；把"先 `ANALYZE`"作为第二用例复现 stat1 场景。
8. 微基准守卫：`db.prepare` 循环 200k 次 vs 复用 statement（5.8–8.7µs vs 0.4–0.9µs）。
9. **健康度计数自洽**（前置项，§9 第 2 步）：一次知识库查询零命中后 `zero_result_rate` 必须上升；一次 `kb_query` 必须只让 `queries` +1（`by_kind` 记 `cross`），而不是 +2。当前两条都不成立——门槛只有在计数器被修好之后才有意义。
10. **2 字中文查询的召回门槛**（§9 第 6 步的前置）：评测集加入 2 字查询后，断言 FTS 腿**非空**（或在明确决定放弃该形状时，断言 `buildFtsQuery` 的返回被显式记录并计数）。否则无法判断"检索腿 top-N"那次改动对最常见的查询形状做了什么。

### 10.3 优化期间必须保持绿的守卫

`knowledge.spec.ts`（手改行触发 `content_hash`、增量 reindex）、`hnswlib.spec.ts`（驱逐替换索引后 ef 仍生效的召回、阈值召回）、`lifecycle.spec.ts`（查询计划、3.3 万 hub、loser FK purge）、`test/db_lifecycle.spec.ts`、`write_side_eval.spec.ts`（写入侧五场景的六个顺序、逐字节相同的报告）。

**外加一项需要先扩、再当成门槛用的守卫**：`eval_zh_relations.jsonl` 目前 29 条查询**全部**是句子式（汉字数 ≤2 的为 0），而"检索腿加 top-N"（§9 第 6 步）改的正是候选集，`HRR 候选裁剪`改的是 probe 腿——两个改动都落在评测集**唯一没有覆盖**的形状（2 字词）附近。所以扩展评测集**是那次改动的组成部分，不是可选的后续**：先加 2 字查询（名字类 `李娜`/`张伟`、术语类 `网关`/`缓存`），确认它们在**改动前**就跑出可解释的结果，再动腿。

---

## 11. 附录：基准方法与脚本

本次审查的基准方法已**长期化到 `scripts/`**（不再是临时文件）；每个脚本的头部注释记录了它支撑报告里的哪一节、以及为什么必须这样测。入口已挂进 `package.json`：

| 脚本 | 入口 | 内容 / 支撑的结论 |
|---|---|---|
| `scripts/bench-memory.mjs` | `pnpm bench:memory` | 记忆/向量侧规模阶梯：`--mode db`（无向量、stub 不可用 ⇒ 纯 SQL/FTS/实体/HRR）与 `--mode vec`（真向量、stub 可用 ⇒ `auto` 越过 2000 迁到 hnswlib）。逐操作 p50/p95、**每条腿的候选扇出**（机制）、RSS、DB 体积、tick/maintenance。支撑 §3.1/§3.2、§4.1/§4.2/§4.4/§4.5/§4.6 |
| `scripts/bench-indexes.mjs` | `pnpm bench:indexes` | 索引 A/B：`facts.page` 排序索引、`contradiction_log` 的三条查询形状、DELETE 的**外键子程序计划**，并**保留被证伪的 partial 索引对照**。支撑 §5、§4.7、§4.11 |
| `scripts/bench-reinforce.mjs` | `pnpm bench:reinforce` | 读路径写放大：同一批查询在 `track=true/false` 下的 p50 与各自 WAL 字节、被改写的不同事实数。支撑 §4.9 |
| `scripts/bench-ingest.mjs` | `pnpm bench:ingest` | **真模型**知识库入库：模型加载、ms/chunk、单块固定成本、`kb_query`、`reindex` dry/全量/重复、带向量的启动。支撑 §3.3、§4.10、§4.2 |
| `scripts/bench-vstore.mjs` | `pnpm bench:vstore` | （既有）numpy vs hnswlib 的构建/延迟/召回，`auto_thresholds.hnswlib` 的证据 |

`bench-fk.mjs`（P0 复现）**不长期化为基准脚本，而是变成单元测试**——它守的是一个正确性缺陷，必须进 CI 而不是靠人跑脚本（见 §9 第 1 步与 §10.3）。§5.2 的冲突日志 A/B 现在由 `bench-indexes.mjs` 承担。

**可复现性**：hnswlib 构建/召回数字与 `scripts/bench-vstore.mjs` 一致；ONNX 编码成本随 token 数（本机约 0.1ms/token）而不是固定值，报告入库吞吐时必须按 chunk 长度换算。脚本默认规模刻意留小（`bench:memory` 默认 2k/10k、`bench:ingest` 默认 300/4500 chunks），大 size 用 `--sizes` / `--chunks` 显式传。
