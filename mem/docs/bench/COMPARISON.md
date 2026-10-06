# mem 基准差异 · baseline → after

> 2026-10-05T19:42:17.762Z → 2026-10-05T20:50:03.547Z

## 1. 可比性

### 1.1 严格可比轴（判据口径）

| 检查 | baseline | after | 一致 |
| --- | --- | --- | --- |
| harness schema | mem-bench/1 | mem-bench/1 | true |
| frozen fixture sha256 | 74be2927ff17…d3a958 | 74be2927ff17…d3a958 | true |
| seed | 20261006 | 20261006 | true |
| pinned now | 2026-10-06T0…+08:00 | 2026-10-06T0…+08:00 | true |
| node | v22.23.2 | v22.23.2 | true |
| pnpm | 12.4.1 | 12.4.1 | true |

| 信息项（不参与判定） | baseline | after | 一致 |
| --- | --- | --- | --- |
| git HEAD | 19d36e03b204…73ccf3 | 19d36e03b204…73ccf3 | true |
| harness digest | e27bec18b83fe5d2 | 34cf72bf3493c347 | false |
| snapshot sha256 | be4a5f41cb03…d686d7 | 73e7b1eaa4a6…77aebd | false |
| corpus 来源 | live-vacuum-into | live-vacuum-into | true |

### 1.2 语料漂移轴（真实语料身份）

| 检查 | baseline | after | 一致 |
| --- | --- | --- | --- |
| corpus identity sha256 | be4a5f41cb03…d686d7 | 73e7b1eaa4a6…77aebd | false |
| live db sha256 | 343a4fd57e09…269d23 | adc8b0df392c…8f6548 | false |
| active facts | 86 | 90 | false |
| user_version | 9 | 9 | true |

> `live db sha256` 只是 `memory.db` 主库文件的 sha：写入还在 `-wal` 侧车文件里时它会**滞后**，所以它只作信息项，**不参与判定**——语料身份以 `VACUUM INTO` 快照（`identity sha256`）为准。

- 真实语料已漂移（corpus identity sha256、active facts；active 86→90，identity be4a5f41cb03…→73e7b1eaa4a6…）⇒ 该轴不可严格比较
- 严格可比轴（判据口径）: **true**
- 合成语料（2k/10k）: **true**
- 语料漂移轴（真实快照）: **false**
- 总体可比（= 严格口径 + 合成语料 + 语料轴）: **false**
- harness 判据一致: **false**（**判据已变**）
  - 新增指标（新增探针）: 22 个：`A5b.include_scores_supported`、`A5b.default_still_unsupported`、`A5b.leg_field_count`、`A5b.leg_non_null_on_first_hit`、`A5b.final_score_field_present`、`A5b.payload_bytes_default`、`A5b.payload_bytes_with_flag`、`A5b.payload_bytes_delta`、`B4b.product_face_supported`、`B4b.source_coverage`、`B4b.valid_from_coverage`、`B4b.assert_count_gt1`、`B4b.assert_count_cross_check`、`B4b.migrated_on_open`、`E1b.input_user_version`、`E1b.upgraded_user_version`、`E1b.fresh_user_version`、`E1b.migrated_equals_fresh`、`E1b.diff_parts`、`E2b.fresh_violations`、`E2b.upgraded_violations`、`E2b.planted_violation_detected`
  - 两侧都测到却消失的指标: 无
  - 结论: 判据已变 —— **仅新增探针**（既有指标未移除；新探针结果只列 §3.1，不得当作 delta）
- 语料漂移不一致项: corpus identity sha256、active facts

### 1.3 按轴可比性

| 轴 | 严格可比指标 | 语料漂移指标 | 新增探针 | 结论 |
| --- | --- | --- | --- | --- |
| A | 13 | 48 | 8 | **该轴不可严格比较**（语料漂移） |
| B | 11 | 6 | 6 | **该轴不可严格比较**（语料漂移） |
| C | 10 | 17 | 0 | **该轴不可严格比较**（语料漂移） |
| D | 6 | 3 | 0 | **该轴不可严格比较**（语料漂移） |
| E | 3 | 7 | 8 | **该轴不可严格比较**（语料漂移） |

新增探针清单（基线与本次都没有 delta 语义）：
- `A5b.include_scores_supported`
- `A5b.default_still_unsupported`
- `A5b.leg_field_count`
- `A5b.leg_non_null_on_first_hit`
- `A5b.final_score_field_present`
- `A5b.payload_bytes_default`
- `A5b.payload_bytes_with_flag`
- `A5b.payload_bytes_delta`
- `B4b.product_face_supported`
- `B4b.source_coverage`
- `B4b.valid_from_coverage`
- `B4b.assert_count_gt1`
- `B4b.assert_count_cross_check`
- `B4b.migrated_on_open`
- `E1b.input_user_version`
- `E1b.upgraded_user_version`
- `E1b.fresh_user_version`
- `E1b.migrated_equals_fresh`
- `E1b.diff_parts`
- `E2b.fresh_violations`
- `E2b.upgraded_violations`
- `E2b.planted_violation_detected`

## 2. 逐项差异

> 新增探针不在本表；它们列在 §1.3 与 §3.1，永远不作为 delta。

### A 轴

| 指标 | baseline | after | Δ | Δ% | 方向 | 判定 | 可比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1.n_queries | 41 | 41 | 0 | 0.0% | neutral | same |  |
| A1.mean_precision_at_k | 0.630081 | 0.630081 | 0 | 0.0% | higher_better | same |  |
| A1.mean_recall_at_k | 0.963415 | 0.963415 | 0 | 0.0% | higher_better | same |  |
| A1.mrr | 0.97561 | 0.97561 | 0 | 0.0% | higher_better | same |  |
| A1.ndcg_at_k | 0.9662 | 0.9662 | 0 | 0.0% | higher_better | same |  |
| A1.empty_rate | 0.02439 | 0.02439 | 0 | 0.0% | lower_better | same |  |
| A1.must_incl…s_rate | 0.95122 | 0.95122 | 0 | 0.0% | higher_better | same |  |
| A1.must_excl…s_rate | 0.707317 | 0.707317 | 0 | 0.0% | higher_better | same |  |
| A1.frozen_match_all | true | true | n/a | n/a | neutral | same |  |
| A1.fingerprint | e04e1c77cc75…c381e1 | e04e1c77cc75…c381e1 | n/a | n/a | neutral | same |  |
| A2.entity_li…ueries | 60 | 60 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| A2.entity_li…1_rate | 0.7667 | 0.75 | -0.0167 | -2.2% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.entity_li…3_rate | 0.9333 | 0.9 | -0.0333 | -3.6% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.entity_li…g_rate | 0.0333 | 0.05 | 0.0167 | 50.2% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.entity_li…d_rank | 1.3103 | 1.3333 | 0.023 | 1.8% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.entity_li…y_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.entity_alias.queries | 10 | 10 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| A2.entity_al…1_rate | 0.4 | 0.4 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.entity_al…3_rate | 0.5 | 0.5 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.entity_al…g_rate | 0.4 | 0.4 | 0 | 0.0% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.entity_al…d_rank | 1.6667 | 1.6667 | 0 | 0.0% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.entity_al…y_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.time.queries | 34 | 34 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| A2.time.top1_rate | 0.5882 | 0.5882 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.time.top3_rate | 1 | 1 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.time.missing_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.time.mean_gold_rank | 1.4118 | 1.4118 | 0 | 0.0% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.time.empty_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.guard_no_time.queries | 34 | 34 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| A2.guard_no_…1_rate | 1 | 1 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.guard_no_…3_rate | 1 | 1 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.guard_no_…g_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.guard_no_…d_rank | 1 | 1 | 0 | 0.0% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.guard_no_…y_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.attribute.queries | 11 | 11 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| A2.attribute.top1_rate | 0.9091 | 0.9091 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.attribute.top3_rate | 0.9091 | 0.9091 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.attribute…g_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.attribute…d_rank | 1.2727 | 1.2727 | 0 | 0.0% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.attribute.empty_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.guard_irr…ueries | 12 | 12 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| A2.guard_irr…1_rate | 0 | 0 | 0 | n/a | higher_better | 不可比 | 不可比（语料漂移） |
| A2.guard_irr…3_rate | 0 | 0 | 0 | n/a | higher_better | 不可比 | 不可比（语料漂移） |
| A2.guard_irr…g_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.guard_irr…d_rank | n/a | n/a | n/a | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.guard_irr…y_rate | 0.3333 | 0.3333 | 0 | 0.0% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.self_query.queries | 6 | 6 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| A2.self_query.top1_rate | 1 | 1 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.self_query.top3_rate | 1 | 1 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A2.self_quer…g_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A2.self_quer…d_rank | 1 | 1 | 0 | 0.0% | lower_better | 不可比 | 不可比（语料漂移） |
| A2.self_query.empty_rate | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| A3.no_time_g…l_rate | 1 | 1 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A3.irrelevan…y_rate | 0.3333 | 0.3333 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A3.identity_passed | 12 | 12 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| A3.identity_checked | 12 | 12 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| A4.sentinels | 2 | 2 | 0 | 0.0% | neutral | same |  |
| A4.passed | 2 | 2 | 0 | 0.0% | higher_better | same |  |
| A4.all_pass | true | true | n/a | n/a | neutral | same |  |
| A5.per_leg_scores | false | false | n/a | n/a | neutral | 不可比 | 不可比（语料漂移） |
| A5.envelope_bytes | 4884 | 4884 | 0 | 0.0% | lower_better | 不可比 | 不可比（语料漂移） |

### B 轴

| 指标 | baseline | after | Δ | Δ% | 方向 | 判定 | 可比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1.verbatim_…hanged | true | true | n/a | n/a | neutral | same |  |
| B1.rewrite_new_rows | 6 | 6 | 0 | 0.0% | neutral | same |  |
| B1.near_dup_…ty_p50 | 0.8571 | 0.8571 | 0 | 0.0% | neutral | same |  |
| B1.dedup_ok | true | true | n/a | n/a | neutral | same |  |
| B2.true_pair_reported | true | true | n/a | n/a | neutral | same |  |
| B2.false_pair_reported | false | false | n/a | n/a | neutral | same |  |
| B2.adjudicat…ive_ok | true | true | n/a | n/a | neutral | same |  |
| B2.adjudicat…ive_ok | true | true | n/a | n/a | neutral | same |  |
| B2.contradiction_ok | true | true | n/a | n/a | neutral | same |  |
| B3.chain_ok | true | true | n/a | n/a | neutral | same |  |
| B3.reverse_lookup_hits | 1 | 1 | 0 | 0.0% | neutral | same |  |
| B4.valid_from_coverage | n/a | n/a | n/a | n/a | higher_better | 不可比 | 不可比（语料漂移） |
| B4.fact_sources_coverage | n/a | n/a | n/a | n/a | higher_better | 不可比 | 不可比（语料漂移） |
| B4.assert_count_gt1 | n/a | n/a | n/a | n/a | neutral | 不可比 | 不可比（语料漂移） |
| B4.supported | false | false | n/a | n/a | neutral | 不可比 | 不可比（语料漂移） |
| B5.entity_type_distinct | 1 | 1 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |
| B5.extractio…stinct | 1 | 1 | 0 | 0.0% | higher_better | 不可比 | 不可比（语料漂移） |

### C 轴

| 指标 | baseline | after | Δ | Δ% | 方向 | 判定 | 可比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1.real_snapshot.p50_ms | 28.5327 | 22.4486 | -6.0841 | -21.3% | lower_better | 不可比 | 不可比（语料漂移） |
| C1.real_snapshot.p95_ms | 49.6057 | 40.9154 | -8.6903 | -17.5% | lower_better | 不可比 | 不可比（语料漂移） |
| C1.synthetic_2k.p50_ms | 35.4171 | 31.9858 | -3.4313 | -9.7% | lower_better | better |  |
| C1.synthetic_2k.p95_ms | 44.2903 | 39.2005 | -5.0898 | -11.5% | lower_better | better |  |
| C1.synthetic_10k.p50_ms | 79.4922 | 79.1582 | -0.334 | -0.4% | lower_better | better |  |
| C1.synthetic_10k.p95_ms | 102.4538 | 100.0639 | -2.3899 | -2.3% | lower_better | better |  |
| C2.remember_add.p50_ms | 32.8701 | 33.3057 | 0.4356 | 1.3% | lower_better | 不可比 | 不可比（语料漂移） |
| C2.remember_add.p95_ms | 34.3826 | 35.0679 | 0.6853 | 2.0% | lower_better | 不可比 | 不可比（语料漂移） |
| C3.build_runtime_real_ms | 7.1715 | 8.4284 | 1.2569 | 17.5% | lower_better | 不可比 | 不可比（语料漂移） |
| C3.build_runtime_2k_ms | 49.6951 | 54.8485 | 5.1534 | 10.4% | lower_better | worse |  |
| C3.build_runtime_10k_ms | 305.1175 | 274.7203 | -30.3972 | -10.0% | lower_better | better |  |
| C3.db_bytes_real | 3584000 | 3604480 | 20480 | 0.6% | lower_better | 不可比 | 不可比（语料漂移） |
| C3.db_bytes_2k | 29028352 | 29028352 | 0 | 0.0% | lower_better | same |  |
| C3.db_bytes_10k | 144785408 | 144785408 | 0 | 0.0% | lower_better | same |  |
| C3.rss_mib_real | 922 | 949.9 | 27.9 | 3.0% | lower_better | 不可比 | 不可比（语料漂移） |
| C3.rss_mib_2k | 922.3 | 950.2 | 27.9 | 3.0% | lower_better | worse |  |
| C3.rss_mib_10k | 1029.6 | 1034.9 | 5.3 | 0.5% | lower_better | worse |  |
| C4.prep_share | 0.0098 | 0.0097 | -0.0001 | -1.0% | neutral | 不可比 | 不可比（语料漂移） |
| C4.prep_p50_ms | 0.1281 | 0.1235 | -0.0046 | -3.6% | lower_better | 不可比 | 不可比（语料漂移） |
| C4.semantic_share | 0.6691 | 0.7295 | 0.0604 | 9.0% | neutral | 不可比 | 不可比（语料漂移） |
| C4.semantic_p50_ms | 15.5835 | 14.2993 | -1.2842 | -8.2% | lower_better | 不可比 | 不可比（语料漂移） |
| C4.fts_share | 0.1841 | 0.1207 | -0.0634 | -34.4% | neutral | 不可比 | 不可比（语料漂移） |
| C4.fts_p50_ms | 3.9522 | 2.0214 | -1.9308 | -48.9% | lower_better | 不可比 | 不可比（语料漂移） |
| C4.jaccard_share | 0.0037 | 0.0037 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| C4.jaccard_p50_ms | 0.0047 | 0.0039 | -0.0008 | -17.0% | lower_better | 不可比 | 不可比（语料漂移） |
| C4.hrr_share | 0.1333 | 0.1364 | 0.0031 | 2.3% | neutral | 不可比 | 不可比（语料漂移） |
| C4.hrr_p50_ms | 3.3407 | 3.3149 | -0.0258 | -0.8% | lower_better | 不可比 | 不可比（语料漂移） |

### D 轴

| 指标 | baseline | after | Δ | Δ% | 方向 | 判定 | 可比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1.samples | 20 | 20 | 0 | 0.0% | neutral | same |  |
| D1.rejection_rate | 0 | 0.7 | 0.7 | n/a | higher_better | better |  |
| D1.scanner_detected | 20 | 20 | 0 | 0.0% | neutral | same |  |
| D2.samples | 8 | 8 | 0 | 0.0% | neutral | same |  |
| D2.false_rejection_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| D2.repo_flag…trings | 0 | 0 | 0 | n/a | lower_better | same |  |
| D3.facts_scanned | 86 | 90 | 4 | 4.7% | neutral | 不可比 | 不可比（语料漂移） |
| D3.facts_wit…rn_hit | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| D3.total_hits | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |

### E 轴

| 指标 | baseline | after | Δ | Δ% | 方向 | 判定 | 可比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1.applicable | false | false | n/a | n/a | neutral | 不可比 | 不可比（语料漂移） |
| E1.live_user_version | 9 | 9 | 0 | 0.0% | neutral | 不可比 | 不可比（语料漂移） |
| E1.fresh_user_version | 9 | 10 | 1 | 11.1% | neutral | 不可比 | 不可比（语料漂移） |
| E1.live_chai…_fresh | true | false | n/a | n/a | neutral | 不可比 | 不可比（语料漂移） |
| E2.applicable | false | false | n/a | n/a | neutral | 不可比 | 不可比（语料漂移） |
| E2.active_su…chived | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| E2.supersede…issing | 0 | 0 | 0 | n/a | lower_better | 不可比 | 不可比（语料漂移） |
| E3.wire_version | 2 | 2 | 0 | 0.0% | neutral | same |  |
| E3.host_stamps_wire | true | true | n/a | n/a | neutral | same |  |
| E3.client_sk…resent | true | true | n/a | n/a | neutral | same |  |

判定汇总（仅计可比项）：better 6 / worse 3 / same 34 / info 0

## 3.1 新增探针结果（不与基线做 delta）

**A 轴**

| 指标 | baseline | after | 说明 |
| --- | --- | --- | --- |
| A5b.include_…ported | n/a | true | 新增探针 |
| A5b.default_…ported | n/a | true | 新增探针 |
| A5b.leg_field_count | n/a | 3 | 新增探针 |
| A5b.leg_non_…st_hit | n/a | 2 | 新增探针 |
| A5b.final_sc…resent | n/a | true | 新增探针 |
| A5b.payload_…efault | n/a | 4884 | 新增探针 |
| A5b.payload_…h_flag | n/a | 5547 | 新增探针 |
| A5b.payload_bytes_delta | n/a | 663 | 新增探针 |

**B 轴**

| 指标 | baseline | after | 说明 |
| --- | --- | --- | --- |
| B4b.product_…ported | n/a | true | 新增探针 |
| B4b.source_coverage | n/a | 0 | 新增探针 |
| B4b.valid_from_coverage | n/a | 0 | 新增探针 |
| B4b.assert_count_gt1 | n/a | 0 | 新增探针 |
| B4b.assert_c…_check | n/a | true | 新增探针 |
| B4b.migrated_on_open | n/a | true | 新增探针 |

**E 轴**

| 指标 | baseline | after | 说明 |
| --- | --- | --- | --- |
| E1b.input_user_version | n/a | 9 | 新增探针 |
| E1b.upgraded…ersion | n/a | 10 | 新增探针 |
| E1b.fresh_user_version | n/a | 10 | 新增探针 |
| E1b.migrated…_fresh | n/a | true | 新增探针 |
| E1b.diff_parts | n/a | 0 | 新增探针 |
| E2b.fresh_violations | n/a | 0 | 新增探针 |
| E2b.upgraded_violations | n/a | 58 | 新增探针 |
| E2b.planted_…tected | n/a | true | 新增探针 |

## 3. composite（仅趋势）

| composite | baseline | after | Δ | 可比性 |
| --- | --- | --- | --- | --- |
| quality | 91.256 | 91.256 | 0 | 严格可比轴 |
| write_health | 100 | 100 | 0 | 严格可比轴 |
| safety | 0 | 100 | 100 | 严格可比轴 |
| perf | 100 | 100 | 不可比 | 语料漂移轴 |

## 4. 实施前应为 0 / 不支持的项

| 项 | baseline | after | 备注 |
| --- | --- | --- | --- |
| A5 逐腿原始分 | unsupported | unsupported |  |
| B1 近重复判定 | unsupported（改写新增行 6） | unsupported（改写新增行 6） |  |
| B4 覆盖列 | unsupported（0） | unsupported（0） |  |
| B5 实体列 distinct | entity_type=…thod=1 | entity_type=…thod=1 |  |
| D1 写入侧密钥守卫 | 0.0%（0/20） | 70.0%（14/20） |  |
| E1 迁移一致性 | n/a | n/a |  |
| E2 不变量 | n/a | n/a |  |
| E3 WIRE_VERSION | 2 | 2 |  |
| 【新增探针】A5b 带 …的逐腿原始分 | n/a | supported | 新增探针 |
| 【新增探针】B4b 产品…stats） | n/a | supported | 新增探针 |
| 【新增探针】E1b 临时副本迁移 | n/a | supported（与全新库一致） | 新增探针 |
| 【新增探针】E2b 不变量 + 植入违规 | n/a | supported（植入违规被检出） | 新增探针 |


