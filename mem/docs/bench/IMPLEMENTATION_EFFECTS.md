# 实施效果对照：12 项 ↔ 实测证据

> 产物：`mem/docs/bench/baseline.json`（实施前）· `after.json`（实施后）· `COMPARISON.md`（逐项差异 + 可比性分层）
> · `AFTER_REPORT.md`（人读）· `JUDGE_CHANGES.md`（判据变更）· `HARNESS_EXTENSION.md`（新增探针）。
> 口径：同一 harness、同一语料、同一种子（`--seed 20261006`）。**严格可比轴**（冻结 41、合成 2k/10k、
> 确定性写入/生命周期、D1/D2、E3）承担精确结论；**真实语料轴已漂移**（active 86→90），对比工具已显式标注不可严格比较。

## 一、分数

| composite | baseline | after | 说明 |
|---|---|---|---|
| quality | 91.256 | **91.256** | 冻结 41 的 8 个指标 + `(ids,scores)` 指纹**逐字节不变**（默认路径未被改动） |
| write_health | 100 | **100** | 逐字去重 / 矛盾真伪 / 取代链三条不变量保持 |
| safety | **0** | **100** | 设计内 14/14 正例被拒（见 §二 P-03）；反例误拒 0 |
| perf | 100 | **100** | 自比基线；新腿默认关 ⇒ 默认路径无成本 |

## 二、逐项证据

| 项 | 实测证据 |
|---|---|
| **P-01** 逐臂信封 | `A5b`：`include_scores:true` 下 `hits[].scores` 含 `fts/jaccard/semantic`，载荷 Δ663 B；**不传 flag 时仍然没有逐腿分**（默认零成本）。kb 一次性对照：14 查询 / 25 命中 / **0 差异**（`BATCH1_KB_COMPARISON.md`） |
| **P-02** 回归网 | 冻结 41 七键 + nDCG 全部不变；派生网 `derived_eval.mjs --mode stub` → exit 0、`collision self-checks: PASS`（已进 CI 的 `build-test`）；夜间真模型臂 = `.github/workflows/derived-eval-real.yml`（只报告不门禁） |
| **P-03** 密钥守卫 | `D1`：20 样本中**设计内 14/14 被拒**（`rejection_rate_in_design=1`）、`D2` 误拒 0；设计外家族如实列出（slack webhook / sendgrid / huggingface / jwt / ssn / twilio） |
| **P-04** 提示词 | `prompt_section.spec.ts` 14/14；三段可粘贴文案在 `PENDING-RELEASE-NOTES.md`（文件优先于内置，故自定义用户需手动补） |
| **P-05a** 假溯源 | 模型面/`admin` 载荷不再含 `mirror_source`/`mirror_target`；`A1` 与指纹不变；`check:fast mem` 绿 |
| **P-05b** 实体列 | `B5write`（**新探针，产品面**）：本代码写出的库里 `entity_type` = `n/eng/x`、`extraction_method` = `jieba`（3 条链接）；旧行走默认值 ⇒ 单一取值 1 → 3 |
| **P-06** 备份纪律 | `admin stats.wal` 报告 WAL 字节与提醒（一次 `statSync`）；`INSTALL.md` §7.0.1 写明不版本化 `-wal`/`-shm` 与 `wal_checkpoint(TRUNCATE)`；未引入 git/子进程 |
| **P-07** 有效期 | `E1b`：临时副本 **9→10** 且 `migrated_equals_fresh=true`（`diff_parts=[]`）；`E2b`：干净库 0 违反、**植入违规被检出**；信封里 `valid_to` 非空才序列化 |
| **P-08** 溯源 | `B4admin`（**产品面**）：新表 + `admin stats` 覆盖率可读（真实语料 `source_coverage 0/90` — 尚无人传 `source_ref`，属采纳而非能力）；腿内 `EXISTS`、放宽档重试不受 `source=` 影响（测试） |
| **P-10** 断言计数 | 新行默认 1、纯重复 +1、**revive 不计**；`admin detail` 可见（测试） |
| **P-11** 时间窗腿 | **默认关** ⇒ `A1` 不变；只读 `valid_from`（无 `created_at` 回退）、SQL 带日期形状守卫；16 条解析器边界测试 |
| **P-13** 事件时间 | `remember` 可选 `event_date`/`valid_until`；`B4admin` 的 `valid_from_coverage` 在产品面可读（真实语料 0/90，同上属采纳问题） |

## 三、如实交代的边界

1. **真实语料轴不可严格比较**（active 86→90、快照 sha 不同）：该轴上的 A2/C1real/B4/B5/D3/E1/E2 只作参考；
   精确结论来自冻结 41、合成语料与确定性检查。
2. **覆盖率在真实数据上是 0**：`source_ref`/`event_date` 是新参数，尚无调用方使用；能力由写-探针与单测证明，
   **采纳率是产品期问题**（方案里的门槛：2 周内 ≥30%，否则降级该列的展示面）。
3. **D1 判据已变**（样本 v1 掩码 → v2 真实形状 + 设计内/外分层），见 `JUDGE_CHANGES.md`；因基线时**不存在守卫**，
   `0 → 100` 的增量在任何样本集下都成立。
4. **活库未被迁移**（仍是 `user_version=9`）：产品的下一次启动会把它升到 v10；测量一律在临时副本上进行。
5. `E1b/E2b` 在临时副本上执行；`E2b.upgraded_violations.retired_without_valid_to=58` 是**历史行**的既有事实
   （旧代码归档时没有 `valid_to`），不是检查失效。
6. **未发版**：版本号仍 `0.5.0`、`CHANGELOG` 未动、未 publish。
