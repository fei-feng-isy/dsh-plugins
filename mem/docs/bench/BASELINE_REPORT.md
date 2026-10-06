# mem 基准报告 · baseline

> mem-bench/1 · 生成于 2026-10-05T19:42:17.762Z · 本文件由 `run.mjs` 与 `baseline.json` 同一次运行写出。

## 0. 运行头与可比性

| 项 | 值 |
| --- | --- |
| label | baseline |
| git HEAD | 19d36e03b204d1d4ebc577e718e5e4046d73ccf3 |
| git status 条目数 | 18 |
| mem/packages 干净 | true |
| node | v22.23.2 |
| pnpm | 12.4.1 |
| platform | linux/x64 |
| cpus | 12 |
| loadavg | 2.97/2.97/2.95 |
| seed | 20261006 |
| pinned now | 2026-10-06T00:00:00+08:00 |
| 复现命令 | `node mem/scripts/bench/run.mjs --out mem/docs/bench/baseline.json --seed 20261006` |

### 0.1 真实语料指纹（只读快照）

| 项 | 值 |
| --- | --- |
| live db sha256 | 343a4fd57e091cf0542af3f1db0b6fb4b7ae01fe938fc66889afc927fd269d23 |
| snapshot sha256 | be4a5f41cb03fd64fd414c89958d8eb96d40d5fc8618cb55f66f5db08cd686d7 |
| active | 86 |
| archived | 79 |
| 长度 min/p25/median/p75/max | 9/243/313/409/882 |
| user_version | 9 |
| 向量空间数 | 1 |
| 实体行/去重名/边 | 2238/2238/7624 |

### 0.2 合成语料指纹

| 语料 | 行数 | seed | 生成器版本 | cache | 录入 ms | runtime ms | db bytes | 内容 sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| synth-2000 | 2000 | 20261006 | synth-v1 | true | 159793 | 49.6951 | 29028352 | fbdf87ad49e5743e60ba30402096aa51932d16aeafb8c3db637ab54f297810e8 |
| synth-10000 | 10000 | 20261006 | synth-v1 | true | 1504795 | 305.1175 | 144785408 | 77ac8628b39510930ca6745bf4cb8128d5d5e3e75051adf8d98c1e09fb418e00 |


**可比性**：两个结果可比当且仅当 `environment.git.head`、`corpus.real.live_sha256`、`corpus.real.active`、`seed`、`pinned_now`、`environment.node`、`environment.pnpm` 一致。`compare.mjs` 会先做这项检查，不一致的项在差异表里标为不可比。

## A 轴 · 检索质量

| 指标 | 值 | 单位 | 方向 |
| --- | --- | --- | --- |
| A1.n_queries | 41 | count | neutral |
| A1.mean_precision_at_k | 0.630081 | ratio | higher_better |
| A1.mean_recall_at_k | 0.963415 | ratio | higher_better |
| A1.mrr | 0.97561 | ratio | higher_better |
| A1.ndcg_at_k | 0.9662 | ratio | higher_better |
| A1.empty_rate | 0.02439 | ratio | lower_better |
| A1.must_include_pass_rate | 0.95122 | ratio | higher_better |
| A1.must_exclude_pass_rate | 0.707317 | ratio | higher_better |
| A1.frozen_match_all | true | bool | neutral |
| A1.fingerprint | e04e1c77cc75d307cb66526d491b28495c7b5eba2a57270104e77c1ef1c381e1 | sha256 | neutral |
| A2.entity_literal.queries | 60 | count | neutral |
| A2.entity_literal.top1_rate | 0.7667 | ratio | higher_better |
| A2.entity_literal.top3_rate | 0.9333 | ratio | higher_better |
| A2.entity_literal.missing_rate | 0.0333 | ratio | lower_better |
| A2.entity_literal.mean_gold_rank | 1.3103 | rank | lower_better |
| A2.entity_literal.empty_rate | 0 | ratio | lower_better |
| A2.entity_alias.queries | 10 | count | neutral |
| A2.entity_alias.top1_rate | 0.4 | ratio | higher_better |
| A2.entity_alias.top3_rate | 0.5 | ratio | higher_better |
| A2.entity_alias.missing_rate | 0.4 | ratio | lower_better |
| A2.entity_alias.mean_gold_rank | 1.6667 | rank | lower_better |
| A2.entity_alias.empty_rate | 0 | ratio | lower_better |
| A2.time.queries | 34 | count | neutral |
| A2.time.top1_rate | 0.5882 | ratio | higher_better |
| A2.time.top3_rate | 1 | ratio | higher_better |
| A2.time.missing_rate | 0 | ratio | lower_better |
| A2.time.mean_gold_rank | 1.4118 | rank | lower_better |
| A2.time.empty_rate | 0 | ratio | lower_better |
| A2.guard_no_time.queries | 34 | count | neutral |
| A2.guard_no_time.top1_rate | 1 | ratio | higher_better |
| A2.guard_no_time.top3_rate | 1 | ratio | higher_better |
| A2.guard_no_time.missing_rate | 0 | ratio | lower_better |
| A2.guard_no_time.mean_gold_rank | 1 | rank | lower_better |
| A2.guard_no_time.empty_rate | 0 | ratio | lower_better |
| A2.attribute.queries | 11 | count | neutral |
| A2.attribute.top1_rate | 0.9091 | ratio | higher_better |
| A2.attribute.top3_rate | 0.9091 | ratio | higher_better |
| A2.attribute.missing_rate | 0 | ratio | lower_better |
| A2.attribute.mean_gold_rank | 1.2727 | rank | lower_better |
| A2.attribute.empty_rate | 0 | ratio | lower_better |
| A2.guard_irrelevant.queries | 12 | count | neutral |
| A2.guard_irrelevant.top1_rate | 0 | ratio | higher_better |
| A2.guard_irrelevant.top3_rate | 0 | ratio | higher_better |
| A2.guard_irrelevant.missing_rate | 0 | ratio | lower_better |
| A2.guard_irrelevant.mean_gold_rank | n/a | rank | lower_better |
| A2.guard_irrelevant.empty_rate | 0.3333 | ratio | lower_better |
| A2.self_query.queries | 6 | count | neutral |
| A2.self_query.top1_rate | 1 | ratio | higher_better |
| A2.self_query.top3_rate | 1 | ratio | higher_better |
| A2.self_query.missing_rate | 0 | ratio | lower_better |
| A2.self_query.mean_gold_rank | 1 | rank | lower_better |
| A2.self_query.empty_rate | 0 | ratio | lower_better |
| A3.no_time_guard_identical_rate | 1 | ratio | higher_better |
| A3.irrelevant_guard_empty_rate | 0.3333 | ratio | higher_better |
| A3.identity_passed | 12 | count | higher_better |
| A3.identity_checked | 12 | count | neutral |
| A4.sentinels | 2 | count | neutral |
| A4.passed | 2 | count | higher_better |
| A4.all_pass | true | bool | neutral |
| A5.per_leg_scores | false | bool | neutral |
| A5.envelope_bytes | 4884 | bytes | lower_better |

## B 轴 · 写入与生命周期

| 指标 | 值 | 单位 | 方向 |
| --- | --- | --- | --- |
| B1.verbatim_rows_unchanged | true | bool | neutral |
| B1.rewrite_new_rows | 6 | count | neutral |
| B1.near_dup_similarity_p50 | 0.8571 | ratio | neutral |
| B1.dedup_ok | true | bool | neutral |
| B2.true_pair_reported | true | bool | neutral |
| B2.false_pair_reported | false | bool | neutral |
| B2.adjudication_true_positive_ok | true | bool | neutral |
| B2.adjudication_false_positive_ok | true | bool | neutral |
| B2.contradiction_ok | true | bool | neutral |
| B3.chain_ok | true | bool | neutral |
| B3.reverse_lookup_hits | 1 | count | neutral |
| B4.valid_from_coverage | n/a | ratio | higher_better |
| B4.fact_sources_coverage | n/a | ratio | higher_better |
| B4.assert_count_gt1 | n/a | count | neutral |
| B4.supported | false | bool | neutral |
| B5.entity_type_distinct | 1 | count | higher_better |
| B5.extraction_method_distinct | 1 | count | higher_better |

## C 轴 · 性能

| 指标 | 值 | 单位 | 方向 |
| --- | --- | --- | --- |
| C1.real_snapshot.p50_ms | 28.5327 | ms | lower_better |
| C1.real_snapshot.p95_ms | 49.6057 | ms | lower_better |
| C1.synthetic_2k.p50_ms | 35.4171 | ms | lower_better |
| C1.synthetic_2k.p95_ms | 44.2903 | ms | lower_better |
| C1.synthetic_10k.p50_ms | 79.4922 | ms | lower_better |
| C1.synthetic_10k.p95_ms | 102.4538 | ms | lower_better |
| C2.remember_add.p50_ms | 32.8701 | ms | lower_better |
| C2.remember_add.p95_ms | 34.3826 | ms | lower_better |
| C3.build_runtime_real_ms | 7.1715 | ms | lower_better |
| C3.build_runtime_2k_ms | 49.6951 | ms | lower_better |
| C3.build_runtime_10k_ms | 305.1175 | ms | lower_better |
| C3.db_bytes_real | 3584000 | bytes | lower_better |
| C3.db_bytes_2k | 29028352 | bytes | lower_better |
| C3.db_bytes_10k | 144785408 | bytes | lower_better |
| C3.rss_mib_real | 922 | MiB | lower_better |
| C3.rss_mib_2k | 922.3 | MiB | lower_better |
| C3.rss_mib_10k | 1029.6 | MiB | lower_better |
| C4.prep_share | 0.0098 | ratio | neutral |
| C4.prep_p50_ms | 0.1281 | ms | lower_better |
| C4.semantic_share | 0.6691 | ratio | neutral |
| C4.semantic_p50_ms | 15.5835 | ms | lower_better |
| C4.fts_share | 0.1841 | ratio | neutral |
| C4.fts_p50_ms | 3.9522 | ms | lower_better |
| C4.jaccard_share | 0.0037 | ratio | neutral |
| C4.jaccard_p50_ms | 0.0047 | ms | lower_better |
| C4.hrr_share | 0.1333 | ratio | neutral |
| C4.hrr_p50_ms | 3.3407 | ms | lower_better |

## D 轴 · 加固与安全

| 指标 | 值 | 单位 | 方向 |
| --- | --- | --- | --- |
| D1.samples | 20 | count | neutral |
| D1.rejection_rate | 0 | ratio | higher_better |
| D1.scanner_detected | 20 | count | neutral |
| D2.samples | 8 | count | neutral |
| D2.false_rejection_rate | 0 | ratio | lower_better |
| D2.repo_flagged_example_strings | 0 | count | lower_better |
| D3.facts_scanned | 86 | count | neutral |
| D3.facts_with_any_pattern_hit | 0 | count | lower_better |
| D3.total_hits | 0 | count | lower_better |

## E 轴 · 完整性与不变量

| 指标 | 值 | 单位 | 方向 |
| --- | --- | --- | --- |
| E1.applicable | false | bool | neutral |
| E1.live_user_version | 9 | version | neutral |
| E1.fresh_user_version | 9 | version | neutral |
| E1.live_chain_equals_fresh | true | bool | neutral |
| E2.applicable | false | bool | neutral |
| E2.active_supersedes_target_not_archived | 0 | count | lower_better |
| E2.supersedes_target_missing | 0 | count | lower_better |
| E3.wire_version | 2 | version | neutral |
| E3.host_stamps_wire | true | bool | neutral |
| E3.client_skew_module_present | true | bool | neutral |

## 评分 composite（仅用于趋势，见规格 §2）

| composite | 值 | 公式 / 依据 |
| --- | --- | --- |
| quality | 91.256 | 0.35*nDCG@k(0.9662) + 0.25*must_include(0.95122) + 0.20*(1-empty_rate(0.02439)) + 0.20*(1-must_exclude_fail(0.2927)) |
| write_health | 100 | 0.4*dedup_ok(1) + 0.3*contradiction_ok(1) + 0.3*chain_ok(1) |
| safety | 0 | D1 正例命中率(0) * (1 - D2 误拒率(0)) |
| perf | 100 | self-ratio for the baseline (100 × 基线 p50 / 本次 p50, no prior artifact); compare.mjs computes it against this file for the after-run |

## 隐私自查（写盘前）

| 检查 | 结果 |
| --- | --- |
| 禁止键（text/content/body…） | 0 |
| 超长字符串（>300） | 0 |
| 敏感模式命中（47 正则超集） | 0 |
| 活库正文包含的 8+ 汉字串 | 0 |
| 仓库词表外的 8+ 汉字串（信息项） | 9 |
| 判定 clean | true |

派生字符串（查询文本、实体名、标签）只落 `/tmp/dsh-bench/**`；仓库产物只放聚合。

## 实施前应为 0 / 不支持的项（如实标注）

| 项 | 实测 | 说明 |
| --- | --- | --- |
| A5 逐腿原始分 | unsupported | 结果信封只有聚合丢弃数与权重/门槛，没有每腿每命中原始分 |
| B1 近重复判定 | unsupported（改写新增行 6） | 实施前只有逐字主键去重 |
| B4 覆盖列 | unsupported（0） | valid_from / fact_sources / assert_count 在 schema v9 不存在 |
| B5 实体列 distinct | entity_type=1 / extraction_method=1 | 实施前各 1 |
| D1 写入侧密钥守卫 | 0.0%（0/20） | 实施前没有写入侧拦截 |
| E1 迁移一致性 | n/a | pre-implementation n/a by spec §1 E1: no schema delta exists yet on this HEAD; the card records the live and fresh migration chains so the after-run can diff them |
| E2 不变量 | n/a | pre-implementation n/a by spec §1 E2: the valid_from / supersedes invariants do not exist yet; the probes below only cover the ONE lifecycle invariant that already ships |
| E3 WIRE_VERSION | 2 | 实施前 2 |

## 复现

```bash
node mem/scripts/bench/run.mjs --out mem/docs/bench/baseline.json --seed 20261006
```

## 备注

- A1 与 eval_zh.spec.ts 同源：聚合逐位相等，另记 (ids, scores) 指纹；不相等则本次运行直接失败。
- 合成 2k/10k 语料按 (生成器版本, 行数, seed, 模型, 维度) 缓存在 /tmp/dsh-bench/cache，重跑测同一份字节；--fresh 强制重建。
- C4 分腿计时是同一查询上顺序调用生产腿方法，用于归因；生产实际并发，所以占比不是墙钟分解。
- 隐私：派生字符串只落 /tmp/dsh-bench；产物通过键级 + 47 正则 + 活库正文包含三重扫描后才写盘。

