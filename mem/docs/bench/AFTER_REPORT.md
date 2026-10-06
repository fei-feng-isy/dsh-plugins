# mem 基准报告 · after

> mem-bench/1 · 生成于 2026-10-05T20:50:03.547Z · 本文件由 `run.mjs` 与 `baseline.json` 同一次运行写出。

## 0. 运行头与可比性

| 项 | 值 |
| --- | --- |
| label | after |
| git HEAD | 19d36e03b204d1d4ebc577e718e5e4046d73ccf3 |
| git status 条目数 | 64 |
| mem/packages 干净 | false |
| node | v22.23.2 |
| pnpm | 12.4.1 |
| platform | linux/x64 |
| cpus | 12 |
| loadavg | 1.06/1.07/1.18 |
| seed | 20261006 |
| pinned now | 2026-10-06T00:00:00+08:00 |
| 复现命令 | `node mem/scripts/bench/run.mjs --out mem/docs/bench/after.json --seed 20261006` |

### 0.1 真实语料指纹（只读快照）

| 项 | 值 |
| --- | --- |
| live db sha256 | adc8b0df392c7a5542788fe837c8babdba00144c106026b457d68eba178f6548 |
| snapshot sha256 | 73e7b1eaa4a617c7a418c7b7334653a055fb501b8145448695fd7217ba77aebd |
| corpus 来源 | live-vacuum-into |
| corpus 身份 sha256 | 73e7b1eaa4a617c7a418c7b7334653a055fb501b8145448695fd7217ba77aebd |
| 固定副本 | — |
| active | 90 |
| archived | 79 |
| 长度 min/p25/median/p75/max | 9/243/313/409/882 |
| user_version | 9 |
| 向量空间数 | 1 |
| 实体行/去重名/边 | 2305/2305/7790 |

### 0.2 合成语料指纹

| 语料 | 行数 | seed | 生成器版本 | cache | 录入 ms | runtime ms | db bytes | 内容 sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| synth-2000 | 2000 | 20261006 | synth-v1 | true | 159793 | 54.8485 | 29028352 | fbdf87ad49e5743e60ba30402096aa51932d16aeafb8c3db637ab54f297810e8 |
| synth-10000 | 10000 | 20261006 | synth-v1 | true | 1504795 | 274.7203 | 144785408 | 77ac8628b39510930ca6745bf4cb8128d5d5e3e75051adf8d98c1e09fb418e00 |


**可比性**：`compare.mjs` 把指标分成两类——**严格可比轴**（冻结 41、合成 2k/10k、确定性写入/生命周期、E3）与 **语料漂移轴**（真实快照上的 A2/A3/A5/B4/B5/C1real/C2/C4/D3/E1/E2）。前者只要求 harness/schema、seed、pinned now、frozen fixture、node/pnpm 一致；后者还必须 `corpus.real.identity_sha256` 与 `active` 一致。真实语料漂移时后者显式标为"不可严格比较"，不会被默认判成可比。

> `--snapshot <path>` 可把某次运行固定在同一份库副本上（`corpus.real.corpus_source=pinned`）；此时活库完全不被读取。

## A 轴 · 检索质量

| 指标 | 值 | 单位 | 方向 | 探针 |
| --- | --- | --- | --- | --- |
| A1.n_queries | 41 | count | neutral | 基线 |
| A1.mean_precision_at_k | 0.630081 | ratio | higher_better | 基线 |
| A1.mean_recall_at_k | 0.963415 | ratio | higher_better | 基线 |
| A1.mrr | 0.97561 | ratio | higher_better | 基线 |
| A1.ndcg_at_k | 0.9662 | ratio | higher_better | 基线 |
| A1.empty_rate | 0.02439 | ratio | lower_better | 基线 |
| A1.must_include_pass_rate | 0.95122 | ratio | higher_better | 基线 |
| A1.must_exclude_pass_rate | 0.707317 | ratio | higher_better | 基线 |
| A1.frozen_match_all | true | bool | neutral | 基线 |
| A1.fingerprint | e04e1c77cc75d307cb66526d491b28495c7b5eba2a57270104e77c1ef1c381e1 | sha256 | neutral | 基线 |
| A2.entity_literal.queries | 60 | count | neutral | 基线 |
| A2.entity_literal.top1_rate | 0.75 | ratio | higher_better | 基线 |
| A2.entity_literal.top3_rate | 0.9 | ratio | higher_better | 基线 |
| A2.entity_literal.missing_rate | 0.05 | ratio | lower_better | 基线 |
| A2.entity_literal.mean_gold_rank | 1.3333 | rank | lower_better | 基线 |
| A2.entity_literal.empty_rate | 0 | ratio | lower_better | 基线 |
| A2.entity_alias.queries | 10 | count | neutral | 基线 |
| A2.entity_alias.top1_rate | 0.4 | ratio | higher_better | 基线 |
| A2.entity_alias.top3_rate | 0.5 | ratio | higher_better | 基线 |
| A2.entity_alias.missing_rate | 0.4 | ratio | lower_better | 基线 |
| A2.entity_alias.mean_gold_rank | 1.6667 | rank | lower_better | 基线 |
| A2.entity_alias.empty_rate | 0 | ratio | lower_better | 基线 |
| A2.time.queries | 34 | count | neutral | 基线 |
| A2.time.top1_rate | 0.5882 | ratio | higher_better | 基线 |
| A2.time.top3_rate | 1 | ratio | higher_better | 基线 |
| A2.time.missing_rate | 0 | ratio | lower_better | 基线 |
| A2.time.mean_gold_rank | 1.4118 | rank | lower_better | 基线 |
| A2.time.empty_rate | 0 | ratio | lower_better | 基线 |
| A2.guard_no_time.queries | 34 | count | neutral | 基线 |
| A2.guard_no_time.top1_rate | 1 | ratio | higher_better | 基线 |
| A2.guard_no_time.top3_rate | 1 | ratio | higher_better | 基线 |
| A2.guard_no_time.missing_rate | 0 | ratio | lower_better | 基线 |
| A2.guard_no_time.mean_gold_rank | 1 | rank | lower_better | 基线 |
| A2.guard_no_time.empty_rate | 0 | ratio | lower_better | 基线 |
| A2.attribute.queries | 11 | count | neutral | 基线 |
| A2.attribute.top1_rate | 0.9091 | ratio | higher_better | 基线 |
| A2.attribute.top3_rate | 0.9091 | ratio | higher_better | 基线 |
| A2.attribute.missing_rate | 0 | ratio | lower_better | 基线 |
| A2.attribute.mean_gold_rank | 1.2727 | rank | lower_better | 基线 |
| A2.attribute.empty_rate | 0 | ratio | lower_better | 基线 |
| A2.guard_irrelevant.queries | 12 | count | neutral | 基线 |
| A2.guard_irrelevant.top1_rate | 0 | ratio | higher_better | 基线 |
| A2.guard_irrelevant.top3_rate | 0 | ratio | higher_better | 基线 |
| A2.guard_irrelevant.missing_rate | 0 | ratio | lower_better | 基线 |
| A2.guard_irrelevant.mean_gold_rank | n/a | rank | lower_better | 基线 |
| A2.guard_irrelevant.empty_rate | 0.3333 | ratio | lower_better | 基线 |
| A2.self_query.queries | 6 | count | neutral | 基线 |
| A2.self_query.top1_rate | 1 | ratio | higher_better | 基线 |
| A2.self_query.top3_rate | 1 | ratio | higher_better | 基线 |
| A2.self_query.missing_rate | 0 | ratio | lower_better | 基线 |
| A2.self_query.mean_gold_rank | 1 | rank | lower_better | 基线 |
| A2.self_query.empty_rate | 0 | ratio | lower_better | 基线 |
| A3.no_time_guard_identical_rate | 1 | ratio | higher_better | 基线 |
| A3.irrelevant_guard_empty_rate | 0.3333 | ratio | higher_better | 基线 |
| A3.identity_passed | 12 | count | higher_better | 基线 |
| A3.identity_checked | 12 | count | neutral | 基线 |
| A4.sentinels | 2 | count | neutral | 基线 |
| A4.passed | 2 | count | higher_better | 基线 |
| A4.all_pass | true | bool | neutral | 基线 |
| A5.per_leg_scores | false | bool | neutral | 基线 |
| A5.envelope_bytes | 4884 | bytes | lower_better | 基线 |
| A5b.include_scores_supported | true | bool | neutral | **新增探针** |
| A5b.default_still_unsupported | true | bool | neutral | **新增探针** |
| A5b.leg_field_count | 3 | count | neutral | **新增探针** |
| A5b.leg_non_null_on_first_hit | 2 | count | neutral | **新增探针** |
| A5b.final_score_field_present | true | bool | neutral | **新增探针** |
| A5b.payload_bytes_default | 4884 | bytes | neutral | **新增探针** |
| A5b.payload_bytes_with_flag | 5547 | bytes | neutral | **新增探针** |
| A5b.payload_bytes_delta | 663 | bytes | neutral | **新增探针** |

## B 轴 · 写入与生命周期

| 指标 | 值 | 单位 | 方向 | 探针 |
| --- | --- | --- | --- | --- |
| B1.verbatim_rows_unchanged | true | bool | neutral | 基线 |
| B1.rewrite_new_rows | 6 | count | neutral | 基线 |
| B1.near_dup_similarity_p50 | 0.8571 | ratio | neutral | 基线 |
| B1.dedup_ok | true | bool | neutral | 基线 |
| B2.true_pair_reported | true | bool | neutral | 基线 |
| B2.false_pair_reported | false | bool | neutral | 基线 |
| B2.adjudication_true_positive_ok | true | bool | neutral | 基线 |
| B2.adjudication_false_positive_ok | true | bool | neutral | 基线 |
| B2.contradiction_ok | true | bool | neutral | 基线 |
| B3.chain_ok | true | bool | neutral | 基线 |
| B3.reverse_lookup_hits | 1 | count | neutral | 基线 |
| B4.valid_from_coverage | n/a | ratio | higher_better | 基线 |
| B4.fact_sources_coverage | n/a | ratio | higher_better | 基线 |
| B4.assert_count_gt1 | n/a | count | neutral | 基线 |
| B4.supported | false | bool | neutral | 基线 |
| B5.entity_type_distinct | 1 | count | higher_better | 基线 |
| B5.extraction_method_distinct | 1 | count | higher_better | 基线 |
| B4b.product_face_supported | true | bool | neutral | **新增探针** |
| B4b.source_coverage | 0 | ratio | higher_better | **新增探针** |
| B4b.valid_from_coverage | 0 | ratio | higher_better | **新增探针** |
| B4b.assert_count_gt1 | 0 | count | neutral | **新增探针** |
| B4b.assert_count_cross_check | true | bool | neutral | **新增探针** |
| B4b.migrated_on_open | true | bool | neutral | **新增探针** |

## C 轴 · 性能

| 指标 | 值 | 单位 | 方向 | 探针 |
| --- | --- | --- | --- | --- |
| C1.real_snapshot.p50_ms | 22.4486 | ms | lower_better | 基线 |
| C1.real_snapshot.p95_ms | 40.9154 | ms | lower_better | 基线 |
| C1.synthetic_2k.p50_ms | 31.9858 | ms | lower_better | 基线 |
| C1.synthetic_2k.p95_ms | 39.2005 | ms | lower_better | 基线 |
| C1.synthetic_10k.p50_ms | 79.1582 | ms | lower_better | 基线 |
| C1.synthetic_10k.p95_ms | 100.0639 | ms | lower_better | 基线 |
| C2.remember_add.p50_ms | 33.3057 | ms | lower_better | 基线 |
| C2.remember_add.p95_ms | 35.0679 | ms | lower_better | 基线 |
| C3.build_runtime_real_ms | 8.4284 | ms | lower_better | 基线 |
| C3.build_runtime_2k_ms | 54.8485 | ms | lower_better | 基线 |
| C3.build_runtime_10k_ms | 274.7203 | ms | lower_better | 基线 |
| C3.db_bytes_real | 3604480 | bytes | lower_better | 基线 |
| C3.db_bytes_2k | 29028352 | bytes | lower_better | 基线 |
| C3.db_bytes_10k | 144785408 | bytes | lower_better | 基线 |
| C3.rss_mib_real | 949.9 | MiB | lower_better | 基线 |
| C3.rss_mib_2k | 950.2 | MiB | lower_better | 基线 |
| C3.rss_mib_10k | 1034.9 | MiB | lower_better | 基线 |
| C4.prep_share | 0.0097 | ratio | neutral | 基线 |
| C4.prep_p50_ms | 0.1235 | ms | lower_better | 基线 |
| C4.semantic_share | 0.7295 | ratio | neutral | 基线 |
| C4.semantic_p50_ms | 14.2993 | ms | lower_better | 基线 |
| C4.fts_share | 0.1207 | ratio | neutral | 基线 |
| C4.fts_p50_ms | 2.0214 | ms | lower_better | 基线 |
| C4.jaccard_share | 0.0037 | ratio | neutral | 基线 |
| C4.jaccard_p50_ms | 0.0039 | ms | lower_better | 基线 |
| C4.hrr_share | 0.1364 | ratio | neutral | 基线 |
| C4.hrr_p50_ms | 3.3149 | ms | lower_better | 基线 |

## D 轴 · 加固与安全

| 指标 | 值 | 单位 | 方向 | 探针 |
| --- | --- | --- | --- | --- |
| D1.samples | 20 | count | neutral | 基线 |
| D1.rejection_rate | 0.7 | ratio | higher_better | 基线 |
| D1.scanner_detected | 20 | count | neutral | 基线 |
| D2.samples | 8 | count | neutral | 基线 |
| D2.false_rejection_rate | 0 | ratio | lower_better | 基线 |
| D2.repo_flagged_example_strings | 0 | count | lower_better | 基线 |
| D3.facts_scanned | 90 | count | neutral | 基线 |
| D3.facts_with_any_pattern_hit | 0 | count | lower_better | 基线 |
| D3.total_hits | 0 | count | lower_better | 基线 |

## E 轴 · 完整性与不变量

| 指标 | 值 | 单位 | 方向 | 探针 |
| --- | --- | --- | --- | --- |
| E1.applicable | false | bool | neutral | 基线 |
| E1.live_user_version | 9 | version | neutral | 基线 |
| E1.fresh_user_version | 10 | version | neutral | 基线 |
| E1.live_chain_equals_fresh | false | bool | neutral | 基线 |
| E2.applicable | false | bool | neutral | 基线 |
| E2.active_supersedes_target_not_archived | 0 | count | lower_better | 基线 |
| E2.supersedes_target_missing | 0 | count | lower_better | 基线 |
| E3.wire_version | 2 | version | neutral | 基线 |
| E3.host_stamps_wire | true | bool | neutral | 基线 |
| E3.client_skew_module_present | true | bool | neutral | 基线 |
| E1b.input_user_version | 9 | version | neutral | **新增探针** |
| E1b.upgraded_user_version | 10 | version | neutral | **新增探针** |
| E1b.fresh_user_version | 10 | version | neutral | **新增探针** |
| E1b.migrated_equals_fresh | true | bool | neutral | **新增探针** |
| E1b.diff_parts | 0 | count | lower_better | **新增探针** |
| E2b.fresh_violations | 0 | count | lower_better | **新增探针** |
| E2b.upgraded_violations | 58 | count | lower_better | **新增探针** |
| E2b.planted_violation_detected | true | bool | higher_better | **新增探针** |

## 新增探针（不与基线做 delta）

以下探针由本次 harness 扩展引入，基线里没有对应指标；`compare.mjs` 只把它们单列，**绝不**伪装成 delta。

| 探针 | 轴 | 测什么 | 实现 | 可比性 |
| --- | --- | --- | --- | --- |
| A5b | A | 带 include_scores 的逐腿原始分 | lib/quality.mjs runExplainabilityIncludeScores | 语料漂移轴 |
| B4b | B | 产品面覆盖率（admin stats） | lib/quality.mjs runCoverageAdminProbe | 语料漂移轴 |
| E1b | E | 临时副本产品迁移 vs 全新库 | lib/perf.mjs runIntegrityOnTempCopy | 语料漂移轴 |
| E2b | E | 产品不变量 + 植入违规非永真自检 | lib/perf.mjs runIntegrityOnTempCopy | 语料漂移轴 |

## 评分 composite（仅用于趋势，见规格 §2）

| composite | 值 | 公式 / 依据 |
| --- | --- | --- |
| quality | 91.256 | 0.35*nDCG@k(0.9662) + 0.25*must_include(0.95122) + 0.20*(1-empty_rate(0.02439)) + 0.20*(1-must_exclude_fail(0.2927)) |
| write_health | 100 | 0.4*dedup_ok(1) + 0.3*contradiction_ok(1) + 0.3*chain_ok(1) |
| safety | 100 | D1 正例命中率(1) * (1 - D2 误拒率(0)) |
| perf | 100 | self-ratio for the baseline (100 × 基线 p50 / 本次 p50, no prior artifact); compare.mjs computes it against this file for the after-run |

## 隐私自查（写盘前）

| 检查 | 结果 |
| --- | --- |
| 禁止键（text/content/body…） | 0 |
| 超长字符串（>300） | 0 |
| 敏感模式命中（47 正则超集） | 0 |
| 活库正文包含的 8+ 汉字串 | 0 |
| 仓库词表外的 8+ 汉字串（信息项） | 34 |
| 判定 clean | true |

派生字符串（查询文本、实体名、标签）只落 `/tmp/dsh-bench/**`；仓库产物只放聚合。

## 实施前应为 0 / 不支持的项（如实标注）

| 项 | 实测 | 说明 |
| --- | --- | --- |
| A5 逐腿原始分 | unsupported | 结果信封只有聚合丢弃数与权重/门槛，没有每腿每命中原始分 |
| B1 近重复判定 | unsupported（改写新增行 6） | 实施前只有逐字主键去重 |
| B4 覆盖列 | unsupported（0） | valid_from / fact_sources / assert_count 在 schema v9 不存在 |
| B5 实体列 distinct | entity_type=1 / extraction_method=1 | 实施前各 1 |
| D1 写入侧密钥守卫 | 70.0%（14/20） | 实施前没有写入侧拦截 |
| E1 迁移一致性 | n/a | pre-implementation n/a by spec §1 E1: no schema delta exists yet on this HEAD; the card records the live and fresh migration chains so the after-run can diff them |
| E2 不变量 | n/a | pre-implementation n/a by spec §1 E2: the valid_from / supersedes invariants do not exist yet; the probes below only cover the ONE lifecycle invariant that already ships |
| E3 WIRE_VERSION | 2 | 实施前 2 |
| 【新增探针】A5b 带 include_scores 的逐腿原始分 | supported | 经 rt.recall 传 include_scores=true；默认不传时 per_leg_scores_default=false |
| 【新增探针】B4b 产品面覆盖率（admin stats） | supported | 来源覆盖率 / valid_from 覆盖率来自 admin.stats；assert_count>1 经 admin list+detail 交叉核对 |
| 【新增探针】E1b 临时副本迁移 | supported（与全新库一致） | VACUUM INTO 快照 → 复制 → 由产品打开升级；绝不迁移活库 |
| 【新增探针】E2b 不变量 + 植入违规 | supported（植入违规被检出） | 调用产品 db/invariants.ts 的 validityInvariantViolations；另植入违规样本确认非永真 |

## 复现

```bash
node mem/scripts/bench/run.mjs --out mem/docs/bench/after.json --seed 20261006
```

## 备注

- A1 与 eval_zh.spec.ts 同源：聚合逐位相等，另记 (ids, scores) 指纹；不相等则本次运行直接失败。
- 合成 2k/10k 语料按 (生成器版本, 行数, seed, 模型, 维度) 缓存在 /tmp/dsh-bench/cache，重跑测同一份字节；--fresh 强制重建。
- C4 分腿计时是同一查询上顺序调用生产腿方法，用于归因；生产实际并发，所以占比不是墙钟分解。
- 隐私：派生字符串只落 /tmp/dsh-bench；产物通过键级 + 47 正则 + 活库正文包含三重扫描后才写盘。
- 本次 harness 相对基线新增 4 个探针（A5b/B4b/E1b/E2b），见 result.new_probes 与 metric.*.new_probe；既有探针与指标定义未改动。
- 真实语料轴用 corpus.real.identity_sha256（VACUUM INTO 快照的字节 sha）判可比；活库主文件 sha 会因 WAL 滞后，只作信息项。

