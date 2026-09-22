# 信任与遗忘模型（自然消退 / 召回加强 / 永久记忆）

> 状态：**已实现（M0–M5）**，本文即行为规格；DESIGN §18 是概要。
> 审核：一轮 R1–R17 + 自查 R18–R21 + 二轮 R22–R25/S1–S4 已全部落入本文（逐条落点见 §13）。
> 实现落点：`core/src/lifecycle/{trust,presence,tick,maintenance}.ts`、`store/memory.ts`、`contract/{config,types,tools}.ts`、
> `runtime.ts`、CLI `trust|pin|unpin`、设置页徽章/剩余天数/固化按钮、插件与 MCP 的心跳。
> 本文是 `lifecycle` / `trust_score` 的唯一权威规格；实现后本文转正并同步 DESIGN.md §11。

## 0. 决策记录

| # | 决策 | 结论 | 来源 |
|---|---|---|---|
| D1 | 老化时钟 | **活跃日（presence clock）**，不采用挂钟：人类记忆没有"停机"这个概念，不能类比 | 用户 |
| D2 | 停机计时 | 每次"在场"最多计入 **1 天**（`gap_cap_days = 1`） | 用户 |
| D3 | 在场定义 | **进程存活**（`presence.mode = process`）：进程启动 + 运行中心跳 | 用户 |
| D4 | 兜底 | **有**：连续 `idle_calendar_days = 365` 个日历日没被使用 → 归档 | 用户 |
| D5 | 遗忘线 | **trust = 0 即遗忘（归档）**，取消 `0.2` 地板 | 用户 |
| D6 | 永久记忆 | **trust = 1 即永久**（`pinned`），0.9 为提升阈值、达到即 snap 到 1.0 | 用户 |
| D7 | 衰减形状 | **线性**（指数永不归零，与 D5 冲突） | 本规格 |
| D8 | 寿命 | 新事实 `start = 0.5`，**90 个活跃日**归零 ⇒ `decay_per_day = 0.5 / 90 = 0.005555…` | 用户（90 天合理） |
| D9 | 检索排序 | trust **不参与**融合/重排（保持 29 查询基线不变） | 本规格 |
| D10 | 与现有「记忆维护」的关系 | **表面尽量保持现状**（入口/命令/报告键/页面交互不变，只做追加）；但**不得为保持现状而让新模型妥协** | 用户 |
| D11 | 永久提升路径 | **只有显式 `helpful`（feedback）能 pin**；recall 永不 pin（`permanent_on_recall` 键删除，R3） | 本规格（审核） |
| D12 | `enabled=false` 的范围 | 停 presence / 结算 / 召回加强 / pin；**TTL、idle 兜底、purge 照跑**（否则"仅展示"会变成"仅堆积"，R14） | 本规格（审核） |

其余参数见 §7：**默认值已确认采用**（`enabled: true`、`recall_delta 0.03`、`recall_marginal_decay 1.0`、`recall_ceiling 0.85`、`feedback_daily_cap 0`、`heartbeat_minutes 60`、`tick_max_facts 5000`）——实现时不再调整。

## 1. 目标与非目标

**目标**
1. 消退**自动**发生：不依赖任何人手动跑 `maintenance`，也不依赖进程"一直开着"。
2. 召回**加强**记忆，但短时间内的加强有限（日配额），符合"人类短时间加强有限"。
3. 重要记忆可固化为**永久**，不再消退。
4. 一切可观测（剩余寿命、配额余量、永久列表）、可测（注入时钟）、幂等、多进程安全。
5. **不改变检索排序**：29 查询评测基线必须**逐位不变**（精确值见 §9「基线守卫」，M1 动工前先固化）。

**非目标**
- 不让 trust 影响检索"排多前"（如需，另开 `retriever.trust_weight`，默认 0）。
- 不改知识库：`documents/doc_chunks` 无 trust，`crossQuery` 不引入 trust。
- 不做用户隔离/多租户（AGENTS.md：记忆是共享单库）。

## 2. 模型

### 2.1 时间基准：活跃日时钟

全局单调递增的"有效天数" `clock`（存在现有 `avantf_stats` 表，不新增表）：

```
avantf_stats['trust_clock']      REAL     有效天数累计
avantf_stats['trust_last_seen']  TIMESTAMP UTC 上次在场时刻

每次"在场"（进程启动 / 心跳）：
  gap     = max(0, (now − last_seen) / 86400)     # 挂钟间隔（UTC）
  counted = min(gap, gap_cap_days)                # D2：停机只计 1 天
  clock  += counted
  last_seen = now
```

- 常开 / 每天启动：`gap ≈ 1 天 ≤ cap` ⇒ **与日历 1:1**，D8 的"90 天"语义不变。
- 停机 90 天后启动：`counted = 1` ⇒ 记忆只老 1 天（D1/D2）。
- 多进程：整个读改写放进 `db.transaction(...).immediate()`，第二个进程读到新 `last_seen` ⇒ `gap ≈ 0`，不重复计。
- 时钟回拨/未来时间戳：`gap = max(0, …)`。
- 自愈：初始化时 `clock = max(存量值, MAX(facts.settle_clock))`，避免元数据丢失导致事实永不结算。

### 2.2 每条事实的状态与公式

```
facts.trust_score    REAL     结算值（截至 settle_clock 的信任）
facts.settle_clock   REAL     上次结算时的 clock
facts.pinned         INTEGER  0/1，永久（D6）

eff(f) = pinned ? 1 : clamp(trust_score − step × (clock − settle_clock), 0, 1)
剩余活跃日 = eff / step            # pinned 视为 ∞；非 active 见 §6
settle(f): trust_score = eff(f); settle_clock = clock
遗忘: eff ≤ forget_threshold (=0) 且 !pinned → archived('forgot')
永久: 显式反馈后 next ≥ permanent_threshold(0.9) → pinned=1, trust_score=1.0（snap，D6/D11）
```

**写入硬规则（R1，必须遵守）**

> 任何**新建 / 复活 / 继承**写入——`add`、`revive`、`update` 的新行——都**必须显式落 `settle_clock = clock`**。
> `settle_clock` 是 **NOT NULL 且无默认值**（S1）——漏写直接报错，数据库层替你执法。否则活跃日时钟已走到第 100 天时新写的事实会在下一次 tick 被
> `step × (100 − 0) ≈ 0.556 > start` 一次性扣穿，新记忆**立即遗忘**。
> 所有写路径一律把 `trust_score` 钳到 `[0, 1]`（下限是 0，不是地板，D5）。

### 2.3 召回加强（含日配额）

**触发面（R5，写死）** —— "recall" = 任何把 fact 作为 hit 返回给调用方的检索：

| 路径 | 是否加强 / 刷新使用时间 |
|---|---|
| `search`、`probe`（含 HRR 腿） | ✅ |
| `ask`（三元组直接命中 `askByPattern` **与** hybrid fallback） | ✅ |
| `chain`、`reason` | ✅（它们也返回 fact hits） |
| `query`（跨库） | 只加强 router 过滤后**最终返回**的 fact 命中（沿用现行纪律；内层 `track:false` 的 search 必须**同时**跳过统计与加强，R21） |
| `related` | ❌ 它返回的是实体共现、不是 fact → 既不加强也不刷新 `last_retrieved_at` |

```
on recall(facts):
  for f:
    if !active: continue                       # S3：先判状态，归档行既不 settle 也不加强
    if f.pinned: 只记 last_retrieved_at / retrieval_count；continue
    settle(f)
    # 配额窗口用**日历 24h**（"每天"是日历概念，与活跃日时钟解耦）
    # bonus_window_at 由 add 写入（R25），故不存在 NULL 分支
    if now − bonus_window_at ≥ 24h: bonus_count = 0; bonus_window_at = now
    if bonus_count < recall_daily_cap:
        gain = recall_delta × marginal_decay ^ bonus_count      # marginal_decay=1 即等额
        next = eff ≤ recall_floor(0.5) ? recall_floor            # 用户规则：≤0.5 → 置回 0.5
                                       : max(eff, min(recall_ceiling(0.85), eff + gain))   # R2：只增不减
        if next > eff + 1e-9:                                    # R10：零增益不耗配额
            trust_score = next; bonus_count += 1; last_reinforced_at = now
    # 超配额 / 零增益：不加 trust（但下面两行照记）
    last_retrieved_at = now; retrieval_count += 1
```

- **只增不减（R2）**：`max(eff, …)` 保证"被 `helpful` 推到 0.88（未 pin）的事实被召回一次不会掉回 0.85"。
- **零增益不耗配额（R10）**：`eff == recall_floor`（含所有新事实）或已达 `recall_ceiling` 时，召回是 no-op，不 `bonus_count++`、不写 `last_reinforced_at`。
- **两层防滥用（D11 / R3）**：**日配额**（防一天内刷分）+ **`recall_ceiling`**（防长期高频顶到永久）。recall **永不 pin**——永久只认显式 `helpful`。

### 2.4 显式反馈

```
on feedback(f, ±1):
  if !active: 只记 helpful_count（夹 ≥0）；trust 不变；return   # 归档行不复活
  if pinned:  只记 helpful_count（夹 ≥0）；trust 不变；return   # R7：pinned 不因反馈改值
  settle(f)
  next = clamp(eff + delta, 0, 1)          # 下限 0，不是地板（D5）
  if next ≥ permanent_threshold: pin()      # trust_score := 1.0, pinned := 1（D6）
  elif next ≤ forget_threshold: archived('forgot')   # unhelpful = 主动遗忘
  trust_score = next
```

`unhelpful` **不解除** `pinned`（永久单向，必须显式 `admin unpin`；pinned 期间连 trust 值都不动，避免"显示 1 而库存 0.95"的不一致，R7）。

### 2.5 兜底（D4）

```
if !pinned && active && now − COALESCE(last_retrieved_at, created_at) > idle_calendar_days(365):
    archived('idle')
```

日历判定，独立于活跃日时钟：极端情况下（几乎不启动、活跃日永远攒不够）也终会清理。
`last_retrieved_at` 的语义是"**最近一次被使用**（检索返回，或手动 `restore`/`revive`）"——见 §2.6（R18）。

### 2.6 与现有机制的关系

| 机制 | 关系 |
|---|---|
| `add` | `trust_score = start(0.5)`、**`settle_clock = clock`（显式写；该列 NOT NULL 且无默认，漏写即报错，R1/S1）**、`pinned=0`、`bonus_count=0`、**`bonus_window_at = CURRENT_TIMESTAMP`（窗口自创建起算，消除 NULL 分支，R25）**、`created_at = now`、`last_retrieved_at = CURRENT_TIMESTAMP`（`insertRevision` 显式写；对 `add` 与 `created_at` 同值，对继承老 `created_at` 的 `update` 则是必需的 idle 保护，见 §2.7） |
| `ttl_days` | 独立，到期归档 `'ttl'`；**不受 pinned 保护**（显式指令优先），且优先级高于 `forgot` |
| `last_retrieved_at` | "最近一次被使用"：检索返回、`restore`、`revive`、以及 `update` 的新行都刷新；idle 兜底判据 + 观测。**不外露**（不进工具返回），与 `updated_at` 是两件事 |
| `updated_at` | **退出衰减**，回归"行被修改"语义（衰减用 `settle_clock`）：编辑分类/TTL、pin/unpin、强化、归档、`restore` 写它；**检索命中与每日结算不写**。随 `mem_recall` 的命中呈现给模型（"更新于"），见 §2.7 |
| `archive_reason` | `manual / replaced / ttl / forgot / idle / contradiction`（**`age` 被 `forgot` 取代**）。`contradiction` 是矛盾裁决归档败方时写的值（`contradict_resolve` + `loser_fact_id`），此前只在代码里出现、未列入本表，导致 `trust_diagnose.archived_by_reason` 会报出一个文档外的键 |
| **所有归档路径** | `manual archive()`、`replaced`、`ttl`、`forgot`、`idle` **都必须写 `archived_clock = clock`**（无例外，保持不变量干净）；purge 在 `archived_clock IS NULL` **或** `trust.enabled=false` 时回退日历判据（R19/R22） |
| `update`（supersede） | 新行**继承**结算后的 trust 与 pinned（`inherit_trust_on_update=true`），`settle_clock = clock`；**并继承旧行的 `created_at`、写入新的 `updated_at`、刷新 `last_retrieved_at`**（见 §2.7）；旧行 `archived('replaced')` + `archived_clock`（R20） |
| `revive`（重新 add 同内容） | 视为一次"使用"：settle 后抬到 `recall_floor`，刷新 `last_retrieved_at`；**pinned 行保持 pinned 与 trust=1**；不改 `created_at`（R20） |
| `restore` | 若 `archive_reason='forgot'` 或 `trust ≤ forget_threshold` → 抬到 `recall_floor`；否则保留 trust（**与 `revive` 有意不同**：`revive` 是用户重新断言了同一条内容，无条件抬到 `recall_floor`；`restore` 只是撤销一次归档，不构成新断言，所以只保证"不会被下一次 tick 立刻再判死"，不额外加分。两者对同一条低 trust 的 idle 归档事实会给出不同的 trust，这是设计而非漂移）。两种都：`settle_clock = clock`、**`last_retrieved_at = now`**（否则 idle 兜底会立刻再归档，R18）、清归档字段、按持久化向量重新入索引；pinned 行保持 pinned（R4/R18/R20） |
| `pinned` | 不结算、不自动归档、无反馈改值、`purge_skips_pinned=true` 不清理（永久承诺） |
| `pinned ∧ TTL` | TTL 到期照归档（显式指令），且因 `purge_skips_pinned` **永久滞留**于 archived；可 restore 回来（R12：接受此语义并如实展示） |
| 知识库 | 不涉及（无 trust） |

### 2.7 `created_at` / `updated_at` 的语义（记忆是带时间的）

- **`created_at` = 这条记忆第一次被记下的时间。** `add` 写当前时间；`update`（supersede）的新行**继承被归档行的 `created_at`**（`insertRevision` 在 INSERT 列清单里显式命名该列——找不到旧行，即首次 `add`，才用当前时间）。因此 `created_at` 回答的是"我什么时候记下这件事"，而不是"这行文字是什么时候写下的"。
- **`updated_at` = 这一行最后一次被改动的时间。** 编辑分类/TTL、pin/unpin、强化、归档、`restore` 写它；**检索命中与每日结算不写**（检索只动 `last_retrieved_at`，结算只动 `trust_score`/`settle_clock`）。所以它与 `last_retrieved_at` 是两件事：前者是"被改过"，后者是"被用过"（后者不外露，只喂 idle 判据）。
- 两者都随命中返回给模型（`mem_recall`/`kb_query`）：记忆取 `facts` 行，文档命中取所属 `documents` 行。

**继承 `created_at` 对两条判据的后果（都是刻意的）：**

1. **idle 兜底**（§2.5）读 `COALESCE(last_retrieved_at, created_at)`。一条很老的记忆刚被 `update` 时，新行继承的 `created_at` 会让它**下一次 tick 就判 idle**。所以 supersede 的 INSERT 同时显式把 `last_retrieved_at` 置为 `CURRENT_TIMESTAMP`——"用户重新断言了它"本身就是一次使用。**idle 判据本身不改。**
2. **TTL**（§2.6 的 `ttl_days` 行）读 `created_at`。继承后**更新不延长寿命**：一条 `ttl_days=7` 的记忆在第 6 天被改写，仍会在第 7 天到期归档。语义是"这条只在最初记录后 N 天内有效"，而不是"每次改写续期 N 天"；要延长必须显式给一个新的 `ttl_days`（那是另一次显式指令）。

管理端 `mem_admin list` 的排序仍是 `created_at DESC`（"第一次记录的新旧"），**不**改用 `updated_at`：pin/强化这类非内容变更会把行顶到最前，且需要新索引。

## 3. 数据模型（DDL）

```sql
-- facts 新增
settle_clock        REAL NOT NULL            -- 上次结算的活跃日；**无 DEFAULT**：INSERT 漏写即报错（R1/S1）
pinned              INTEGER DEFAULT 0
pinned_at           TIMESTAMP
bonus_count         INTEGER DEFAULT 0        -- 当前窗口内已加强次数
bonus_window_at     TIMESTAMP                -- 日历 24h 窗口起点
last_reinforced_at  TIMESTAMP                -- 观测
archived_clock      REAL                     -- 归档时的活跃日（purge 用活跃日）
-- facts 现有：trust_score REAL DEFAULT 0.5（语义改为"结算值"）

CREATE INDEX IF NOT EXISTS idx_facts_trust  ON facts(status, pinned, settle_clock);
CREATE INDEX IF NOT EXISTS idx_facts_idle   ON facts(status, pinned, last_retrieved_at);
CREATE INDEX IF NOT EXISTS idx_facts_ttl    ON facts(status, ttl_days);
CREATE INDEX IF NOT EXISTS idx_facts_purge  ON facts(status, pinned, archived_clock);
```

**无迁移**：按项目政策（全新项目、无旧数据），改 schema = 删除 `~/.avantf` 下对应库后重启。

## 4. 批量 SQL（tick 的实现；**执行顺序即编号顺序**）

```sql
-- ① 结算：只碰"活跃日整数位跨越过"的行 → 每条事实每个活跃日最多结算一次（R8）
--    谓词天然幂等；同一日内多次心跳不会重复写。
UPDATE facts
   SET trust_score = MAX(0, MIN(1, trust_score - :step * (:clock - settle_clock))),
       settle_clock = :clock
 WHERE status = 'active' AND pinned = 0
   AND CAST(settle_clock AS INTEGER) < CAST(:clock AS INTEGER);
-- 需要预算时用等价子查询形式（最老的先算；maintenance 用 budget=∞ 即上面的全量形式）：
--   ... AND fact_id IN (SELECT fact_id FROM facts
--        WHERE status='active' AND pinned=0 AND CAST(settle_clock AS INTEGER) < CAST(:clock AS INTEGER)
--        ORDER BY settle_clock ASC LIMIT :tick_max_facts)

-- ② TTL 到期（日历；pinned 不豁免；优先于 forgot，R6）
UPDATE facts
   SET status='archived', archived_at=CURRENT_TIMESTAMP, archived_clock=:clock, archive_reason='ttl'
 WHERE status='active' AND ttl_days > 0
   AND julianday('now') - julianday(created_at) > ttl_days
 RETURNING fact_id;

-- ③ 到期遗忘（① 已把 trust clamp 到 0）
UPDATE facts
   SET status='archived', archived_at=CURRENT_TIMESTAMP, archived_clock=:clock, archive_reason='forgot'
 WHERE status='active' AND pinned=0 AND trust_score <= :forget_threshold
 RETURNING fact_id;

-- ④ 兜底 idle（日历）
UPDATE facts
   SET status='archived', archived_at=CURRENT_TIMESTAMP, archived_clock=:clock, archive_reason='idle'
 WHERE status='active' AND pinned=0
   AND julianday('now') - julianday(COALESCE(last_retrieved_at, created_at)) > :idle_calendar_days
 RETURNING fact_id;

-- ⑤ 物理清理（活跃日窗口；archived_clock 缺失 **或 trust.enabled=false** 时回退日历，R19/R22）
--  disabled 时 clock 冻结，活跃日分支会恒为 0 > N 而永久停摆，故必须按日历走。
DELETE FROM facts
 WHERE status='archived' AND pinned=0
   AND CASE WHEN :enabled = 1 AND archived_clock IS NOT NULL
            THEN :clock - archived_clock > :purge_after_archived_days
            ELSE julianday('now') - julianday(archived_at) > :purge_after_archived_days
       END
 RETURNING fact_id;
```

- **forgot 的粒度（S2）**：③ 读的是**已结算**的 `trust_score`，而 ① 每个活跃日只结算一次，所以"连续 90 活跃日不用 → forgot"实际是 **90~91 个活跃日**（最多晚 1 个活跃日）。这是有意接受的代价：把 ③ 改成 eff 表达式会让它无法走索引、变成每次心跳全表扫 active 行，把 R8 消掉的写放大换成读放大。**窗口内的正面作用**：这段时间 `eff = 0` 但事实仍 `active`，仍可被检索，且一旦被召回会 floor-raise 回 `recall_floor` —— 相当于"最后一次机会"。
- **预算分批（R8，已修正）**：**五步都受同一个 `tick_max_facts` 限制**。① 按 `settle_clock` 升序 `LIMIT`（最老优先，返回 `skipped` 供下轮继续）；②③④ 返回 `archived_deferred`、⑤ 返回 `purged_deferred`，报告本轮预算用尽后还剩多少行。
  本节此前写作"只有 ① 分批，②③④⑤ 只命中临界行、本身廉价"，与实现不符，而且错在要紧的方向上：五步都跑在 tick 的**同一个 `IMMEDIATE` 事务**里，写锁在整个事务期间持有，所以一次不分批的归档/清理在大库上会把其他进程（以及启动路径——tick 就是在 store 构造时跑的）堵到它跑完为止。给每一步封顶才是把锁时间压住的手段，`*_deferred` 让积压可见而不是静默。
- 调用方拿到 `RETURNING fact_id` 后 **evict 向量**（沿用现有 `archived_ids` / `purged_ids` 机制）；批量淘汰优先走 `VectorStore.removeMany(ids)`（存在时），避免逐条 remove 在 hnswlib 上退化成 O(N²)。

## 5. 控制流与触发点

| 时机 | 动作 | 落点 / 顺序 |
|---|---|---|
| **进程启动** | presence → tick（①②③④⑤）→ **`reloadIndex`** | **`MemoryStore` 构造函数内、`reloadIndex` 之前**（R9）。tick 在 reloadIndex 之前 ⇒ 索引只装载 tick 后的 active 集，**无需额外 evict**。 |
| **心跳**（长驻，可选，默认 60min） | presence + ②③④⑤；**① 只在活跃日整数位跨越时执行**（见 §4 谓词） | plugin `ctx.effect(() => setInterval)`；MCP `setInterval().unref()`；CLI 无（一次性进程靠启动那一次）。R8 |
| **写路径** | 单事实 `settle` → 加强/反馈 → 判钉 → 判归档 →（若归档则 evict 向量） | `memory.ts` 的 `reinforce()` / `applyFeedback()` / `update()` / `restore()` / `revive()` |
| **`admin maintenance`** | 强制**全量** tick（忽略预算）+ purge + 报告；**仍需 evict**（跑在活索引上） | `runtime.admin` → `memory.maintenance()` |
| **读路径** | 只算 `eff()`，**不写库**；非 active 行见 §6 展示规则 | `toSummary()` / `get()` |

> 因此："停机 90 天后启动" → 启动那一次 presence 只加 1 天 → 记忆**仍在**（剩余 ≈89 活跃日）。

## 6. 契约 / 工具 / UI 变化

**types**（`contract/src/types.ts`）
- `FactSummary` + `pinned: boolean`、`trust_score`、`remaining_days: number | null`
- **展示规则（R11）**：`status === 'active'` → `trust_score = eff()`、`remaining_days = eff/step`；**非 active** → `trust_score` 按存量值**原样展示**、`remaining_days = null`；`pinned` → `remaining_days = null`（永不遗忘）。`eff()` 只对 active 计算，绝不出现负的剩余天数。
- `FactDetail` + `settle_clock`、`pinned_at`、`last_reinforced_at`、`bonus_count`、`bonus_window_at`

**tools**（`contract/src/tools.ts`）
- `AdminUnion` + `trust_diagnose`、`pin`、`unpin`
- `trust_diagnose` 返回字段（R17/R24）：`clock`、`active`、`pinned`、`forgetting_soon`（≤7 活跃日内到期）、**`reinforced_today`（今日消耗过配额的事实数）、`bonus_granted_today`（今日有效加强总次数）**、`idle_candidates`、`archived_by_reason{ttl,forgot,idle,manual,replaced}`、`oldest_settle_clock`
  - 配额是**每条事实** 3 次/24h，因此不提供"全库剩余配额"这类无良定义的单一数字（R24）。
- `REMEMBER_TOOL` / `RECALL_TOOL` 描述补充：召回即加强（有日配额与上限，**不会**变成永久）、`helpful` 达 0.9 → 永久、`≤0` 遗忘、`unhelpful` 不解除永久

**CLI**：`trust`（诊断）、`pin <id>`、`unpin <id>`；`show` 输出 `trust / 剩余活跃日 / pinned`
**UI**：`永久` 徽章、剩余天数、pin/unpin、`立即维护` 按钮
**信封**：不变（`ToolEnvelope` / `unwrapRemoteEnvelope`）

### 6.1 与现有「记忆维护」的兼容边界（D10）

**保持不变（surface 稳定）**

| 面 | 保持 |
|---|---|
| 入口 | `mem_admin {action:'maintenance'}`、`avantf-mem maintenance`、Remote `admin({action:'maintenance'})`；同一个 `runtime.admin` 分支 |
| 语义 | "立刻强制跑一次**完整** pass（忽略 tick 预算）并报告"——从"唯一入口"变成"诊断/兜底入口" |
| 报告键 | 现有 6 个键全部保留：`decayed / archived_ttl / archived_age / purged / purged_ids / archived_ids` |
| 其他 admin 动作 | `stats / list / detail / archive / restore / vectors_diagnose / vectors_fix / contradict_check` 行为不变（`detail` 只做字段追加） |
| 记忆维护页（UI A） | 现有 CRUD / 归档 / 恢复 / 有用·没用 / 详情 / 矛盾列表交互不变；只做**追加**（eff、剩余活跃日、永久徽章、pin·unpin），不重构 |

**报告字段的重新定义（只做加法，不改名）**

- `decayed`：本次结算中 `trust` 数值发生变化的事实数（语义不变）；
- `archived_ttl`：TTL 到期归档数（不变）；
- `archived_age`：**非 TTL 的自动归档数** = `forgot + idle`（键名保留，语义从"久未使用低信任"扩为"老化归档"）；
- `purged / purged_ids / archived_ids`：不变，并继续用于向量 evict；
- **新增**：`settled`、`clock`、`archived_forgot`、`archived_idle`、`skipped`（① 的预算跳过；手动 maintenance 恒为 0）、`archived_deferred`（②③④ 因预算未跑完而剩下的行数）、`purged_deferred`（⑤ 同上）。后两个键是"五步共用预算"（§4）的必然产物：不分批就没有"留给下一轮"这件事，也就不需要报告它。

> 启动 tick 之后手动跑 `maintenance` 通常会看到 `decayed = 0`——这是**正常**的（刚结算过），不是坏了。

**必须改变（新功能优先，不妥协）**

| 现状 | 新模型 | 为什么不能让 |
|---|---|---|
| `decay_per_day: 0.999`（指数） | 线性步长 `0.0055556`（移入 `trust` 段） | 指数永不归零，与 D5「0 = 遗忘」直接冲突 |
| `min_trust_floor: 0.2` | 删除 | D5（地板制造死区与回弹） |
| `archive_after_days: 90`（休眠判据） | 由「活跃日到期(0)」+ `idle_calendar_days` 兜底取代 | D1/D4 的核心 |
| `archive_reason = 'age'` | `'forgot'` / `'idle'` | 语义已不同，沿用旧名会误导 |
| 只有手动 maintenance 会衰减/归档 | 启动 + 心跳 + 写路径都触发 | 这正是"自然消退"的全部意义 |
| `updated_at` 兼任衰减时钟 | `settle_clock`（活跃日） | 一个字段无法同时表示行变更/衰减/反馈 |

**受影响的现有断言（随新功能同步改）**

- `lifecycle.spec.ts`：`archive_reason === 'age'` → `'forgot'`；`archive_after_days` 的构造改为"推进 90 个活跃日"；`archived_age` 计数按新定义（forgot + idle）。
- `maintenance` 报告断言：原 6 键仍在，新键为加法 ⇒ 旧断言无需改写即可继续用。
- `memory.spec.ts` / `cli.spec.ts`：trust 断言改为 `eff` / `剩余活跃日`；`maintenance` 后 `decayed` 允许为 0。

## 7. 配置（`contract/src/config.ts` 新增 `trust` 段）

| 键 | 默认 | 状态 | 说明 |
|---|---|---|---|
| `enabled` | `true` | 已定（默认） | 见下方「`enabled=false` 的范围」（R14） |
| `start` | `0.5` | 已定（默认） | 新事实初始信任 |
| `decay_per_day` | `0.0055556` | **已定** | `0.5/90` ⇒ 90 活跃日归零 |
| `forget_threshold` | `0` | **已定** | 到 0 即遗忘（D5） |
| `permanent_threshold` | `0.9` | 已定（默认） | 达到即永久（D6） |
| `recall_floor` | `0.5` | **规则** | `≤0.5` → 置回 0.5 |
| `recall_delta` | `0.03` | 已定（默认） | 单次增量 |
| `recall_daily_cap` | `3` | **已定（机制）** | 每条事实每 24h 最多**有效**加强次数（R10） |
| `recall_marginal_decay` | `1.0` | 已定（默认） | `0.5` = 递减（0.03/0.015/0.0075） |
| `recall_ceiling` | `0.85` | 已定（默认） | 召回单独能到的上限（< 永久阈值；recall 永不 pin，D11） |
| `feedback_delta` | `0.05` | 已定（默认） | 沿用现值 |
| `feedback_daily_cap` | `0` | 已定（默认） | 0 = 不限；防止 agent 刷 `helpful` 时可设 2。**> 0 时 feedback 与 recall 共用同一个 24h 计数器**（`bonus_count` / `bonus_window_at`），即一条事实当天被召回刷满 `recall_daily_cap` 次后，feedback 也会被拒，反之 feedback 也消耗召回配额。这是有意的"每事实每天一份强化预算"语义（此前未写入本表）；若需要两者独立计数，需为 feedback 单开一列 |
| `inherit_trust_on_update` | `true` | 已定（默认） | 改写时新行继承 trust/pinned（R13） |
| `purge_skips_pinned` | `true` | 已定（默认） | 永久记忆不参与物理清理（R13） |
| `presence.mode` | `process` | **已定** | D3；schema 只接受 `process`（`z.enum(['process'])`）——不实现的值必须**报错**，不能接受后静默忽略 |
| `presence.gap_cap_days` | `1` | **已定** | D2 |
| `presence.heartbeat_minutes` | `60` | 已定（默认） | 长驻进程心跳；`0` = 只靠启动 |
| `idle_calendar_days` | `365` | **已定（机制）** | D4 兜底 |
| `tick_max_facts` | `5000` | 已定（默认） | **五步共用**的每轮上限（R8，见 §4 预算分批） |

`lifecycle` 段移除 `decay_per_day` / `min_trust_floor` / `archive_after_days`（被 `trust` 取代，属破坏性配置变更，记 CHANGELOG）；保留 `purge_after_archived_days`（语义变为**活跃日**）与 `contradiction_threshold`。**不再新增 `permanent_on_recall`**（D11）。

**`enabled=false` 的范围（R14，写死）**

| 机制（不用圈码，避免与 §4 的 SQL 编号混淆，S4） | `enabled=false` 时 |
|---|---|
| presence / `clock` 推进 | ⏹ 停（clock 冻结；re-enable 后首次 presence 的 gap 仍被 `gap_cap_days` 截为 1 天，不会一次性补算） |
| 衰减结算（§4 ①） | ⏹ 停（`eff()` 读路径退化为直接返回存量 `trust_score`） |
| 召回加强 / 配额 | ⏹ 停（`last_retrieved_at` / `retrieval_count` 照记） |
| 自动 pin / snap | ⏹ 停 |
| 显式反馈 `helpful` / `unhelpful` | ⏹ trust 变更停（`helpful_count` 照记；与 pinned/archived 守卫同语义） |
| 显式 `admin pin` / `unpin` | ▶️ 照跑（显式指令，与手动归档同类） |
| `restore` / `revive` | ▶️ 照跑（不 settle；trust 按 §2.6：forgot→`recall_floor`、revive→抬到 `recall_floor`） |
| TTL 归档 | ▶️ 照跑（显式指令） |
| idle 兜底 | ▶️ 照跑（日历） |
| purge | ▶️ 照跑（**按日历**，见 §4 ⑤ 的 `:enabled` 开关，R22） |
| 手动 `archive` / `remove` | ▶️ 照跑 |
| 只读路径（`trust_diagnose` / `list` / `detail` / 检索） | ▶️ 照跑 |

**配置健壮性（R15/R23）**：`loader` 对**根级未知键 + 已知 section 内的未知键**都 warn 一次。注意两个示例——`vector_store`（应为 `vectorStore`）与 `semantics`（应为 `semantic`）——都是**根级**拼错，规则里只写"section 内"会恰好漏掉它们。通用拼写保护，**不针对历史键名**（本项目无兼容承诺）。

## 8. 模块划分（新增文件）

```
core/src/lifecycle/trust.ts     纯函数：effectiveTrust / displayTrust / remainingDays /
                                grantRecallBonus / applyFeedbackDelta / parseUtcTs / formatUtcTs
                                （pin 与 forget 不是独立函数，而是 applyFeedbackDelta 返回值
                                 FeedbackOutcome 的两个布尔位；全部注入 clock/now，无 DB 依赖）
core/src/lifecycle/presence.ts  全局时钟：readClock / advancePresence(now, cap)（IMMEDIATE 事务）
core/src/lifecycle/tick.ts      runTrustTick(db, cfg, {clock, budget}) →
                                {settled, archived_ids, purged_ids, skipped,
                                 archived_deferred, purged_deferred}
core/src/lifecycle/maintenance.ts  保留为"强制全量 tick + purge + 报告"
core/src/store/memory.ts        reinforce() 取代 markRetrieved()；
                                applyFeedback/update/restore/revive/archive 接入 settle 与 archived_clock
```

## 9. 测试矩阵

| 组 | 用例 |
|---|---|
| 纯函数 | 线性衰减、clamp [0,1]、pinned 豁免、`remaining = eff/step`、snap 到 1.0 |
| presence | 停机 90 天 ⇒ `clock += 1`；连续启动 ⇒ 1:1；时钟回拨；缺行初始化；元数据丢失自愈；两进程并发只推进一次（`presence_process.spec.ts` 用**两个真实 OS 进程** + vite-node 跑源码，断言「落库 clock == 各进程 counted 之和」；去掉 `.immediate()` 该用例即失败） |
| **写入硬规则（R1）** | clock 推进到 100 活跃日**之后**新增事实 → 下一个 tick **不得**归档它；`revive`/`update` 新行同样 |
| 召回加强 | `≤0.5 → 0.5`；`>0.5 → +Δ`；第 4 次不加值；跨 24h 配额恢复；`marginal_decay`；`ceiling` 封顶；**recall 永不 pin**（D11）；pinned no-op |
| **只增不减（R2）** | trust=0.88（未 pin）被召回 → trust **不下降**；eff=ceiling 时召回 → 无变化且不耗配额（R10） |
| **零增益（R10）** | 新事实（eff=0.5）连续召回 3 次 → trust 不变、`bonus_count` **仍为 0**、`last_reinforced_at` 不发 |
| 反馈 | `helpful` 达 0.9 → pinned 且 trust=1.0；`unhelpful` 到 0 → 立即归档；`unhelpful` 不解除 pinned；**pinned 期间 feedback 不改 trust（R7）**；对 archived 行的 feedback 不改 trust |
| **restore（R4/R18/R20）** | restore 一条 `forgot` → 下一次 tick 仍 active 且 trust ≥ recall_floor；restore 一条 `idle`（`last_retrieved_at` 一年前）→ 下一次 tick **不得**再归档（idle 时钟已刷新）；pinned 行 restore 后仍 pinned |
| tick | ① settle（整数位跨越才写）+ ②ttl + ③forgot + ④idle + ⑤purge；**连续 10 次心跳只产生 1 次 ① 写**（R8）；重复 tick 幂等；`archived_clock` 驱动 purge |
| **purge（R19）** | 手动 `archive()` / `replaced` / `ttl` 归档的行在 clock > 365 时**不得**被立即删除；`archived_clock IS NULL` 时按 `archived_at` 回退判定 |
| **触发面（R5/R21）** | 仅通过 `ask`（三元组直接命中）/`chain`/`reason` 命中的事实：`last_retrieved_at` 刷新、idle 不误杀、配额按语义计；`related` 不刷新；`query` 内层 `track:false` 不加强，最终命中才加强 |
| 展示（R11） | `list(status:'archived')`：trust 原样、`remaining_days=null`；pinned 行亦 null |
| limbo（R12） | pinned + TTL 到期 → 归档但永不被 purge；restore 后仍 pinned |
| enabled（R14） | `enabled=false` 时按 §7 表格逐项断言停/不停 |
| 集成（关键） | **写入 → 模拟停机 90 天 → 启动 → 记忆仍在（≈89 活跃日）**；连续 90 个活跃日不用 → `forgot`；回填 `last_retrieved_at` 400 天 → `idle` 兜底；pinned 400 活跃日不动 |
| **基线守卫（R16）** | 先把当前基线固化为**精确断言**：`mean_precision_at_k 0.47701149425287354`、`mean_recall_at_k 0.9482758620689655`、`mrr 0.9310344827586207`、`empty_rate 0.034482758620689655`、`must_include_pass_rate 0.9310344827586207`、`must_exclude_pass_rate 0.6896551724137931`；再断言 trust 取 0/1 时检索顺序完全一致 |

**受影响的现有测试**（实现时同步改）：`lifecycle.spec.ts` 的 `age` 归档用例（→ `forgot`）与 `archive_after_days` 用法；`memory.spec.ts` 的 trust/向量断言；`cli.spec.ts` 的 `vectors` 输出（不变）与新 `trust` 子命令。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 检索刷分把记忆刷成永久 | 日配额 + `recall_ceiling` + **recall 永不 pin**（D11）；可选 `feedback_daily_cap` |
| **心跳写放大（R8）** | ① 只在活跃日整数位跨越时执行（每条事实每天最多 1 次写）；②③④⑤只命中临界行，且**五步同受 `tick_max_facts` 封顶**（§4）；该预算因此是对每日新到期量的上限，不会永久追赶 |
| **purge 误删（R19）** | 所有归档路径写 `archived_clock` + purge 对 NULL 回退日历判据 |
| **restore 死循环（R4/R18）** | forgot → 抬到 `recall_floor`；idle → 刷新 `last_retrieved_at` |
| 评测基线漂移 | trust 不进排序 + §9「基线守卫」的**精确数字**断言（M1 前置固化） |
| 启动时全库结算变慢 | 批量 SQL + 索引 + 五步都分批（① 最老优先，见 §4） |
| 多进程重复推进时钟 | `IMMEDIATE` 事务 + 原子读改写；`busy_timeout=5000` |
| 时钟回拨 / 元数据丢失 | `gap=max(0,…)`；初始化自愈 `clock ≥ max(settle_clock)` |
| 永久不可逆 | 单向 + 显式 `unpin`；`purge_skips_pinned`；pinned 期间 feedback 不改值（R7） |
| 停机期被"饿死" | D1–D3：活跃日时钟 + `gap_cap=1` |
| 极端长期不用 | D4：`idle_calendar_days` 兜底 |
| pinned ∧ TTL 滞留（R12） | 明确接受：归档但不清理，可 restore |
| KB 被误伤 | trust 仅存在于 memory；`crossQuery` 不引入 trust |

## 11. 分阶段实施

| 阶段 | 内容 | 交付/验收 |
|---|---|---|
| **M0 前置** | ① 把 eval 基线固化精确断言（R16）；② 配置未知键 warn（R15） | 基线测试由宽松阈值改为精确数字；把 `vector_store` 写进 YAML 会得到一条警告 |
| **M1 地基** | `trust` 配置；DDL 新列/索引（`settle_clock` NOT NULL **无默认**，S1）；`trust.ts` + `presence.ts` 纯函数与时钟；写入硬规则（R1）的单测 | 纯函数与手算一致；presence 停机 90 天只计 1 天；clock=100 后新增事实不被归档 |
| **M2 加强 + 永久** | `reinforce()` 取代 `markRetrieved()`（含 R5 触发面、R2 只增不减、R10 零增益、R21 track）；`applyFeedback`（R7）；pin/snap（D11）；`update` 继承、`revive`/`restore`（R4/R18/R20）；archive 写 `archived_clock`（R19） | §9 的召回加强 + 反馈 + restore + purge 用例全绿 |
| **M3 自动遗忘** | `tick.ts`（五段 SQL）；构造顺序 presence → tick → reloadIndex（R9）；心跳策略（R8）；TTL（R6）；`idle` 兜底；purge（R19/R22）；向量 evict | 停机 90 天启动 → 仍在；90 活跃日不用 → `forgot`；连续心跳只写一次 ①；重复 tick 幂等 |
| **M3b maintenance 薄壳化** | `runMaintenance` = `runTrustTick({budget: ∞})` 的包装，保留原报告键 + 新键 | `maintenance` 报告与原 6 键兼容；`maintenance` 后 `decayed` 可为 0 |
| **M4 表面** | `trust_diagnose`（R17 字段）/`pin`/`unpin`；CLI；UI 徽章/剩余天数/立即维护；prompt 指引；DESIGN/README/CHANGELOG | 工具/CLI/UI 一致；文档与实现同步 |
| **M5 标定** | 180 天虚拟仿真（脚本化 recall 序列 → 存活曲线）；微调 `recall_delta`/`ceiling` | 曲线符合直觉且基线不变 |

## 12. 验收清单

全部通过（2026-09-11），逐项覆盖如下（`trust.spec` / `trust_acceptance.spec` / `trust_simulation.spec` /
`lifecycle.spec` / `memory.spec` / `eval_zh.spec`；`trust_acceptance.spec` 专收此前只落在规格里、没有对应用例的行）：

- [x] 不跑任何手工命令：写入 → 停机 90 天 → 启动，记忆**仍在**（剩余 ≈89 活跃日）— `trust_simulation.spec`
- [x] **活跃日推进到 100 天后新增的事实，下一个 tick 不会被归档**（R1）— `memory.spec`
- [x] 连续 90~91 个活跃日未被 recall → `archived('forgot')`（粒度 ≤1 活跃日，S2），向量已 evict —
  `lifecycle.spec` + `trust_acceptance.spec`（tick 归档后 `indexed` 归零）
- [x] `pinned` 记忆 400 活跃日不动、不被 purge、feedback 不改其 trust — `memory.spec` + `trust_acceptance.spec`
- [x] 一天内 recall 第 4 次不再加值；跨 24h 恢复配额；零增益召回不耗配额 — `trust.spec` + `memory.spec`
- [x] 高频 recall 只能到 `recall_ceiling`，**任何情况都不会变成永久** — `trust.spec` + `trust_simulation.spec`
- [x] trust=0.88 的事实被召回后**不下降**（R2）— `memory.spec`
- [x] `helpful` 达 0.9 → `pinned` 且 trust 显示 1.0 — `memory.spec`
- [x] `unhelpful` 反复 → 到 0 立即归档；不解除已有 `pinned` — `memory.spec`
- [x] `restore` 一条 `forgot` 或 `idle` 事实 → 接下来两次 tick 仍是 active（R4/R18）— `memory.spec`
- [x] 手动归档/`replaced`/`ttl` 的行在长时钟下**不会**被 purge 误删（R19）— `lifecycle.spec` + `trust_acceptance.spec`
- [x] 仅通过 `ask`/`chain`/`reason` 命中的事实不被 idle 误杀（R5）— `trust_acceptance.spec`
- [x] 连续 365 日历日没被使用 → `idle` 兜底归档 — `lifecycle.spec` + `trust_simulation.spec`
- [x] `enabled=false`：按 §7 范围表逐项符合；且其间新归档的行按**日历**被 purge（不被冻结的 clock 卡住，R22）—
  `lifecycle.spec` + `trust_acceptance.spec`（§7 逐行）
- [x] 新事实首次召回即计入配额窗口，无 NULL 分支（R25）— `trust_acceptance.spec`
- [x] 两个 runtime 指向同一 DB 同时启动 → 时钟只推进一次 — `trust.spec`（两连接）+ `presence_process.spec`
  （两个真实 OS 进程 + 共享 rendezvous，断言 clock == Σ counted）
- [x] eval 六项指标与固化值**逐位相同**；trust 0/1 检索顺序一致 — `eval_zh.spec`（两条断言：精确六值 + 全库
  trust 取 0 / 1 时 29 条查询的返回序列完全相同，R16）
- [x] `pnpm build` / `typecheck` / `test` / plugin build / mount-smoke 全绿 — 217 tests（contract 25 /
  retrieval-core 30 / core 145 / mcp 6 / cli 11）

> 读出的信任值走 `displayTrust()`（R11）：`active` 给 `eff()`，**非 active 给存量值**——`effectiveTrust()` 的
> 衰减公式对归档行在数学上仍然成立，因此投影层不得直接用它。

## 13. 修订记录（一轮 R1–R17 + 自查 R18–R21 + 二轮 R22–R25/S1–S4，共 29 条）

| # | 级别 | 落点 |
|---|---|---|
| R1 | P0 | §2.2「写入硬规则」、§2.6 `add` 行、§3 DDL 注释、§9/§12 用例 |
| R2 | P0 | §2.3 公式 `max(eff, min(ceiling, eff+gain))`、§9/§12 |
| R3 | P1 | **删除 `permanent_on_recall`**（D11）；§2.3 防滥用改两层、§7 表、§9/§12 |
| R4 | P0 | §2.6 `restore` 行（forgot/低 trust → `recall_floor`）、§9/§12 |
| R5 | P1 | §2.3「触发面」表、§9 用例 |
| R6 | P1 | §4 语句 ②（TTL 入 tick）、§2.6 优先级、§9 |
| R7 | P1 | §2.4 pinned/archived 守卫、§9/§12 |
| R8 | P2 | §4 ① 谓词（整数位跨越）+ 五步共用预算、§5 心跳行、§10、§9 |
| R9 | P1 | §5 启动行（构造内 presence → tick → reloadIndex，零额外 evict） |
| R10 | P2 | §2.3 零增益不耗配额、§7（"有效加强次数"）、§9/§12 |
| R11 | P2 | §6 展示规则（非 active 原样 + null）、§9 |
| R12 | P2 | §2.6 `pinned ∧ TTL` 行、§10、§9 |
| R13 | P3 | §7 表新增 `inherit_trust_on_update` / `purge_skips_pinned` |
| R14 | P2 | §7「`enabled=false` 的范围」表、§9 |
| R15 | P3 | §7「配置健壮性」：**通用未知键警告**（非历史键特判） |
| R16 | P3 | §9「基线守卫」精确六项 + §11 M0 前置 |
| R17 | P3 | §6 `trust_diagnose` 字段清单 |
| **R18** | **P0** | §2.6 `restore` 刷新 `last_retrieved_at`（解 idle 死循环）、§10、§9/§12 |
| **R19** | **P0** | §2.6「所有归档路径写 `archived_clock`」、§4 ⑤ 回退、§10、§9/§12 |
| **R20** | P2 | §2.6 `revive`/`update` 的 pinned 语义、§9 |
| **R21** | P2 | §2.3 触发面表内 `query`/`track:false` 纪律、§9 |
| **R22** | P1 | §4 ⑤ 的 CASE 增 `:enabled` 开关；§2.6 归档路径行；§7 范围表（disabled 时 purge 按日历） |
| **R23** | P3 | §7 配置健壮性：根级 + section 内未知键都 warn |
| **R24** | P3 | §6 `quota_left_today` → `reinforced_today` + `bonus_granted_today` |
| **R25** | P2 | §2.6 `add` 写 `bonus_window_at`；§2.3 注明无 NULL 分支（二轮自查） |
| S1 | 建议 | §3 `settle_clock` 去掉 `DEFAULT 0`（NOT NULL 执法，§2.6 add 行注明） |
| S2 | 建议 | §4 取 (a)：forgot 粒度 ≤1 活跃日 + "最后一次机会"说明 |
| S3 | 建议 | §2.3 伪代码先判状态再 `settle` |
| S4 | 建议 | §7 范围表改机制名 + 补 4 行（反馈/显式 pin/restore·revive/只读） |
