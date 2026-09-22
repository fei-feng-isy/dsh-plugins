# TRUST_MODEL.md 审核报告

> 审核对象：`docs/TRUST_MODEL.md` 修订稿（R1–R21 已全部落入正文，含 §13 修订记录）。
> 审核范围：与当前代码（工作区 simplify 轮之后）的一致性、内部自洽、边界情况、可实现性。
> **当前结论：R1–R21 复核全部通过；本轮新发现 R22（P1）+ R23/R24（P3）+ S1–S4 建议项。
> 落完 §4 修订清单（7 条）即可冻结规格、进入 M0。**

---

## 0. 实证核验（均已实际运行）

**SQLite 能力**（§4 批量 SQL 的前提，better-sqlite3 / SQLite 3.49.2）：

| 能力 | 结果 |
|---|---|
| `UPDATE … ORDER BY … LIMIT`（需 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`） | ✅ |
| `UPDATE … RETURNING` | ✅ |
| `DELETE … RETURNING` | ✅ |
| `db.transaction(fn).immediate()` | ✅ |

§4 可按原文实现，无需「先 SELECT 再 UPDATE」的两段式。

**eval 基线**（§9「基线守卫」六个精确值 vs `eval_zh.spec` 实际输出）：**逐位一致** ✅

```
mean_precision_at_k   0.47701149425287354
mean_recall_at_k      0.9482758620689655
mrr                   0.9310344827586207
empty_rate            0.034482758620689655
must_include_pass_rate 0.9310344827586207
must_exclude_pass_rate 0.6896551724137931
```

M0 固化断言可直接照抄上述数字。

**对当前代码的引用核对**：`markRetrieved()`（将被 `reinforce()` 取代）、`VectorStore.removeMany`、
`avantf_stats` 表、`MaintenanceResult` 六键、`runtime.query` 的 `track:false` 纪律、
`MemoryStore.maintenance()`（store 自有 DB 写 + 索引驱逐）——全部与工作区现状一致 ✅。

---

## 1. 总体评价

- 架构与 D1–D12 决策成立：活跃日时钟数学自洽（连续 gap 之和 = 真实时长；单次 gap 封顶
  1 天 ⇒ 常开/每天启动与日历 1:1，停机 90 天只老 1 天）；D12「disabled 时冻结 clock」是
  正确取舍——否则 re-enable 时 ① 会按整个停用期差值一次性结算，造成大规模误遗忘。
- §6.1 兼容边界（报告六键保留 + 纯加法）与现行 `MaintenanceResult` 完全对齐。
- §9 测试矩阵覆盖了全部历史发现对应的回归用例；§13 修订记录提供了完整追溯。
- admin 新 action（`trust_diagnose`/`pin`/`unpin`）经契约 union → DSH 工具 / MCP
  inputSchema / Remote gateway 透传 / CLI 全自动到达，零网关改动（契约单源红利）。

## 2. 历史发现复核状态（R1–R21：全部落点，抽样验算通过）

| # | 级别 | 一句话 | 复核 |
|---|---|---|---|
| R1 | P0 | 新写入必须显式 `settle_clock = clock`（否则新事实被一次扣穿即刻遗忘） | ✅ §2.2 硬规则 + §2.6 add 行 + DDL 注释（另见 S1：建议升级为 DB 级约束） |
| R2 | P0 | ceiling 会把高 trust 往下压 | ✅ `max(eff, min(ceiling, eff+gain))`，验算：0.88 召回后不降 |
| R3 | P1 | `permanent_on_recall` 死配置 | ✅ 键已删除，D11「recall 永不 pin」 |
| R4 | P0 | restore forgot 事实 → 下个 tick 再归档 | ✅ 抬到 `recall_floor` |
| R5 | P1 | recall 触发面未定义 | ✅ §2.3 触发面表（related 排除自洽；query 沿用 track 纪律） |
| R6 | P1 | TTL 不在自动 tick | ✅ §4 ②，pinned 不豁免、优先于 forgot |
| R7 | P1 | pinned 的 feedback 无守卫 | ✅ §2.4 双守卫（archived / pinned 均只记 helpful_count） |
| R8 | P2 | 心跳全表结算写放大 | ✅ 整数位跨越谓词；验算：扣减量用真实差值，门控只限写频不改累计量；同日多次心跳零写 |
| R9 | P1 | 启动 tick 与 reloadIndex 顺序 | ✅ presence → tick → reloadIndex，启动零额外 evict；maintenance 在活索引上跑仍需 evict——两处落点区分正确 |
| R10 | P2 | 零增益耗配额 | ✅ `next > eff + 1e-9` 门；新事实（eff=0.5）召回为真 no-op |
| R11 | P2 | 归档行 eff 展示 | ✅ §6 展示规则（非 active 原样 + `remaining_days=null`） |
| R12 | P2 | pinned ∧ TTL limbo | ✅ 明确接受：归档但不清理、可 restore |
| R13 | P3 | 缺 `inherit_trust_on_update` / `purge_skips_pinned` | ✅ 已入 §7 表 |
| R14 | P2 | `enabled=false` 范围 | ✅ D12 + §7 范围表（但引出 R22；且见 S4） |
| R15 | P3 | 旧键静默 strip | ✅ 改为通用未知键 warn（但措辞有洞，见 R23） |
| R16 | P3 | 基线「逐位不变」无载体 | ✅ §9 六个精确值（已实测核对一致）+ §11 M0 前置 |
| R17 | P3 | trust_diagnose 字段缺清单 | ✅ 已列（但 `quota_left_today` 定义有问题，见 R24） |
| R18 | P0 | restore/revive 刷新 `last_retrieved_at`（解 idle 死循环） | ✅ §2.5/§2.6 |
| R19 | P0 | 所有归档路径写 `archived_clock` + purge NULL 日历回退 | ✅ §2.6/§4 ⑤（但与 R22 交互） |
| R20 | P2 | revive/update 的 pinned 语义 | ✅ §2.6 |
| R21 | P2 | query 内层 track:false 同时跳过统计与加强 | ✅ §2.3 触发面表 |

## 3. 当前未决问题

### R22（P1）`enabled=false` × purge：D12 说「purge 照跑」，但冻结的 clock 使活跃日分支永不满足

- **位置**：§7 enabled=false 范围表 × §4 ⑤ × §2.6「所有归档路径写 `archived_clock`」
- **问题**：disabled 时 presence 停 → clock 冻结在值 C。此期间 TTL/idle 归档写入
  `archived_clock = C`；⑤ 的主分支 `:clock − archived_clock > N` 即 `C − C = 0 > 365`
  **永假**；disabled 之前的旧归档行（`archived_clock ≤ C`）同样停止老化。purge 实际停摆，
  与表格「▶️ 照跑」直接矛盾；re-enable 后这些行还要重新等满一个活跃日窗口。
- **建议修订**（最省改动，复用已有 NULL 回退）：
  > `trust.enabled=false` 期间，归档路径**不写** `archived_clock`（留 NULL），⑤ 的 CASE
  > 自动落到日历分支 `julianday(archived_at)` —— purge 在 disabled 下按日历照跑，
  > re-enable 后新归档恢复活跃日语义。

### R23（P3）R15 的规则文本覆盖不到它自己举的例子

- **位置**：§7「配置健壮性（R15）」
- **问题**：规则写「**已知 section 下的未知键**」warn，但两个示例——`vector_store`
  （应为 `vectorStore`）与 `semantics`（应为 `semantic`）——都是**根级**拼错。按字面
  实现，这两个例子恰好不会触发警告。
- **建议修订**：改为「**根级未知键 + 已知 section 内的未知键**都 warn 一次」。

### R24（P3）`quota_left_today` 在 per-fact 配额下无良定义

- **位置**：§6 `trust_diagnose` 字段清单
- **问题**：配额是**每条事实** 3 次/24h；全库范围的「今日配额余量」用单个数字说不清
  （求和？分布？最小值？）。
- **建议修订**：替换为两个良定义计数——`reinforced_today`（今日消耗过配额的事实数）
  与 `bonus_granted_today`（今日有效加强总次数）。

### S1（建议）DDL `settle_clock REAL NOT NULL DEFAULT 0`：删掉 DEFAULT，让数据库执法

无迁移政策下表是全新建的，`DEFAULT 0` 没有存在理由；去掉后任何遗漏显式赋值的 INSERT
**直接报错**，把 R1 从「注释级约束」升级为「数据库级约束」。§9 的 R1 用例照旧有效。

### S2（建议）③ forgot 的判定粒度受 ① 的整数日门控拖累

③ 的谓词读**已结算**的 `trust_score`；trust 在活跃日中途穿 0 时，要等下一次整数位跨越
（最长 1 个活跃日）才被归档——「连续 90 活跃日不用 → forgot」实际是 90~91。二选一写死：
(a) 在 §4/§12 注明该粒度并接受；(b) ③ 直接用 eff 表达式
`trust_score − :step × (:clock − settle_clock) <= :forget_threshold`，彻底解耦 ① 的频率
（代价：③ 不再是纯索引扫描，但反正只命中临界行）。

### S3（微小）§2.3 伪代码顺序

`settle(f)` 写在 `if !active: continue` **之前**——归档行也会被 settle 一次（白写一行）。
两行对调即可。

### S4（P2）§7 enabled=false 表缺「显式反馈」行，且圈码与 §4 冲突

- 表中没有 `helpful/unhelpful` 的停/跑条目（「trust 仅展示」暗示应停 trust 变更、
  `helpful_count` 照记，但没写死）。
- 该表的 ①②③④⑤ 编号与 §4 SQL 编号**不是一套**（§7 的②=召回加强，§4 的②=TTL；
  §7 的③=TTL，§4 的③=forgot），交叉阅读极易看错——建议 §7 表改用机制名，不用圈码。

## 4. 修订清单（落完即冻结）

1. §7/§2.6/§4：`enabled=false` 时归档不写 `archived_clock`，⑤ 走日历回退（**R22**）
2. §7 R15 措辞：根级 + section 内未知键都 warn（R23）
3. §6：`quota_left_today` → `reinforced_today` + `bonus_granted_today`（R24）
4. §3：`settle_clock` 去掉 `DEFAULT 0`（S1，可选）
5. §4/§12：forgot 粒度注明，或 ③ 改 eff 表达式（S2，二选一）
6. §2.3：伪代码先判 active 再 settle（S3）
7. §7：enabled=false 表补「显式反馈」行；圈码改机制名（S4）
