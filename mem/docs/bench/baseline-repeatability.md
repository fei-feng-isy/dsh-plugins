# mem 基准差异 · baseline → baseline-repeat

> 2026-10-05T19:42:17.762Z → 2026-10-05T19:42:45.169Z

## 1. 可比性

### 1.1 严格可比轴（判据口径）

| 检查 | baseline | baseline-repeat | 一致 |
| --- | --- | --- | --- |
| harness schema | mem-bench/1 | mem-bench/1 | true |
| frozen fixture sha256 | 74be2927ff17…d3a958 | 74be2927ff17…d3a958 | true |
| seed | 20261006 | 20261006 | true |
| pinned now | 2026-10-06T0…+08:00 | 2026-10-06T0…+08:00 | true |
| node | v22.23.2 | v22.23.2 | true |
| pnpm | 12.4.1 | 12.4.1 | true |

| 信息项（不参与判定） | baseline | baseline-repeat | 一致 |
| --- | --- | --- | --- |
| git HEAD | 19d36e03b204…73ccf3 | 19d36e03b204…73ccf3 | true |
| harness digest | e27bec18b83fe5d2 | e27bec18b83fe5d2 | true |
| snapshot sha256 | be4a5f41cb03…d686d7 | be4a5f41cb03…d686d7 | true |
| corpus 来源 | live-vacuum-into | live-vacuum-into | true |

### 1.2 语料漂移轴（真实语料身份）

| 检查 | baseline | baseline-repeat | 一致 |
| --- | --- | --- | --- |
| corpus identity sha256 | be4a5f41cb03…d686d7 | be4a5f41cb03…d686d7 | true |
| live db sha256 | 343a4fd57e09…269d23 | 343a4fd57e09…269d23 | true |
| active facts | 86 | 86 | true |
| user_version | 9 | 9 | true |

> `live db sha256` 只是 `memory.db` 主库文件的 sha：写入还在 `-wal` 侧车文件里时它会**滞后**，所以它只作信息项，**不参与判定**——语料身份以 `VACUUM INTO` 快照（`identity sha256`）为准。

- 真实语料身份一致，语料漂移轴可严格比较
- 严格可比轴（判据口径）: **true**
- 合成语料（2k/10k）: **true**
- 语料漂移轴（真实快照）: **true**
- 总体可比（= 严格口径 + 合成语料 + 语料轴）: **true**
- harness 判据一致: **true**

### 1.3 按轴可比性

| 轴 | 严格可比指标 | 语料漂移指标 | 新增探针 | 结论 |
| --- | --- | --- | --- | --- |
| A | 13 | 48 | 0 | 漂移轴可比 |
| B | 11 | 6 | 0 | 漂移轴可比 |
| C | 10 | 17 | 0 | 漂移轴可比 |
| D | 6 | 3 | 0 | 漂移轴可比 |
| E | 3 | 7 | 0 | 漂移轴可比 |

## 2. 逐项差异

> 新增探针不在本表；它们列在 §1.3 与 §3.1，永远不作为 delta。

### A 轴

| 指标 | baseline | baseline-repeat | Δ | Δ% | 方向 | 判定 | 可比 |
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
| A2.entity_li…ueries | 60 | 60 | 0 | 0.0% | neutral | same |  |
| A2.entity_li…1_rate | 0.7667 | 0.7667 | 0 | 0.0% | higher_better | same |  |
| A2.entity_li…3_rate | 0.9333 | 0.9333 | 0 | 0.0% | higher_better | same |  |
| A2.entity_li…g_rate | 0.0333 | 0.0333 | 0 | 0.0% | lower_better | same |  |
| A2.entity_li…d_rank | 1.3103 | 1.3103 | 0 | 0.0% | lower_better | same |  |
| A2.entity_li…y_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.entity_alias.queries | 10 | 10 | 0 | 0.0% | neutral | same |  |
| A2.entity_al…1_rate | 0.4 | 0.4 | 0 | 0.0% | higher_better | same |  |
| A2.entity_al…3_rate | 0.5 | 0.5 | 0 | 0.0% | higher_better | same |  |
| A2.entity_al…g_rate | 0.4 | 0.4 | 0 | 0.0% | lower_better | same |  |
| A2.entity_al…d_rank | 1.6667 | 1.6667 | 0 | 0.0% | lower_better | same |  |
| A2.entity_al…y_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.time.queries | 34 | 34 | 0 | 0.0% | neutral | same |  |
| A2.time.top1_rate | 0.5882 | 0.5882 | 0 | 0.0% | higher_better | same |  |
| A2.time.top3_rate | 1 | 1 | 0 | 0.0% | higher_better | same |  |
| A2.time.missing_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.time.mean_gold_rank | 1.4118 | 1.4118 | 0 | 0.0% | lower_better | same |  |
| A2.time.empty_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.guard_no_time.queries | 34 | 34 | 0 | 0.0% | neutral | same |  |
| A2.guard_no_…1_rate | 1 | 1 | 0 | 0.0% | higher_better | same |  |
| A2.guard_no_…3_rate | 1 | 1 | 0 | 0.0% | higher_better | same |  |
| A2.guard_no_…g_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.guard_no_…d_rank | 1 | 1 | 0 | 0.0% | lower_better | same |  |
| A2.guard_no_…y_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.attribute.queries | 11 | 11 | 0 | 0.0% | neutral | same |  |
| A2.attribute.top1_rate | 0.9091 | 0.9091 | 0 | 0.0% | higher_better | same |  |
| A2.attribute.top3_rate | 0.9091 | 0.9091 | 0 | 0.0% | higher_better | same |  |
| A2.attribute…g_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.attribute…d_rank | 1.2727 | 1.2727 | 0 | 0.0% | lower_better | same |  |
| A2.attribute.empty_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.guard_irr…ueries | 12 | 12 | 0 | 0.0% | neutral | same |  |
| A2.guard_irr…1_rate | 0 | 0 | 0 | n/a | higher_better | same |  |
| A2.guard_irr…3_rate | 0 | 0 | 0 | n/a | higher_better | same |  |
| A2.guard_irr…g_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.guard_irr…d_rank | n/a | n/a | n/a | n/a | lower_better | same |  |
| A2.guard_irr…y_rate | 0.3333 | 0.3333 | 0 | 0.0% | lower_better | same |  |
| A2.self_query.queries | 6 | 6 | 0 | 0.0% | neutral | same |  |
| A2.self_query.top1_rate | 1 | 1 | 0 | 0.0% | higher_better | same |  |
| A2.self_query.top3_rate | 1 | 1 | 0 | 0.0% | higher_better | same |  |
| A2.self_quer…g_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A2.self_quer…d_rank | 1 | 1 | 0 | 0.0% | lower_better | same |  |
| A2.self_query.empty_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| A3.no_time_g…l_rate | 1 | 1 | 0 | 0.0% | higher_better | same |  |
| A3.irrelevan…y_rate | 0.3333 | 0.3333 | 0 | 0.0% | higher_better | same |  |
| A3.identity_passed | 12 | 12 | 0 | 0.0% | higher_better | same |  |
| A3.identity_checked | 12 | 12 | 0 | 0.0% | neutral | same |  |
| A4.sentinels | 2 | 2 | 0 | 0.0% | neutral | same |  |
| A4.passed | 2 | 2 | 0 | 0.0% | higher_better | same |  |
| A4.all_pass | true | true | n/a | n/a | neutral | same |  |
| A5.per_leg_scores | false | false | n/a | n/a | neutral | same |  |
| A5.envelope_bytes | 4884 | 4884 | 0 | 0.0% | lower_better | same |  |

### B 轴

| 指标 | baseline | baseline-repeat | Δ | Δ% | 方向 | 判定 | 可比 |
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
| B4.valid_from_coverage | n/a | n/a | n/a | n/a | higher_better | same |  |
| B4.fact_sources_coverage | n/a | n/a | n/a | n/a | higher_better | same |  |
| B4.assert_count_gt1 | n/a | n/a | n/a | n/a | neutral | same |  |
| B4.supported | false | false | n/a | n/a | neutral | same |  |
| B5.entity_type_distinct | 1 | 1 | 0 | 0.0% | higher_better | same |  |
| B5.extractio…stinct | 1 | 1 | 0 | 0.0% | higher_better | same |  |

### C 轴

| 指标 | baseline | baseline-repeat | Δ | Δ% | 方向 | 判定 | 可比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1.real_snapshot.p50_ms | 28.5327 | 25.965 | -2.5677 | -9.0% | lower_better | better |  |
| C1.real_snapshot.p95_ms | 49.6057 | 47.229 | -2.3767 | -4.8% | lower_better | better |  |
| C1.synthetic_2k.p50_ms | 35.4171 | 33.1371 | -2.28 | -6.4% | lower_better | better |  |
| C1.synthetic_2k.p95_ms | 44.2903 | 40.5855 | -3.7048 | -8.4% | lower_better | better |  |
| C1.synthetic_10k.p50_ms | 79.4922 | 82.1442 | 2.652 | 3.3% | lower_better | worse |  |
| C1.synthetic_10k.p95_ms | 102.4538 | 103.9975 | 1.5437 | 1.5% | lower_better | worse |  |
| C2.remember_add.p50_ms | 32.8701 | 33.3128 | 0.4427 | 1.3% | lower_better | worse |  |
| C2.remember_add.p95_ms | 34.3826 | 35.3023 | 0.9197 | 2.7% | lower_better | worse |  |
| C3.build_runtime_real_ms | 7.1715 | 6.7003 | -0.4712 | -6.6% | lower_better | better |  |
| C3.build_runtime_2k_ms | 49.6951 | 49.7449 | 0.0498 | 0.1% | lower_better | worse |  |
| C3.build_runtime_10k_ms | 305.1175 | 270.7461 | -34.3714 | -11.3% | lower_better | better |  |
| C3.db_bytes_real | 3584000 | 3584000 | 0 | 0.0% | lower_better | same |  |
| C3.db_bytes_2k | 29028352 | 29028352 | 0 | 0.0% | lower_better | same |  |
| C3.db_bytes_10k | 144785408 | 144785408 | 0 | 0.0% | lower_better | same |  |
| C3.rss_mib_real | 922 | 947.9 | 25.9 | 2.8% | lower_better | worse |  |
| C3.rss_mib_2k | 922.3 | 948.5 | 26.2 | 2.8% | lower_better | worse |  |
| C3.rss_mib_10k | 1029.6 | 1028 | -1.6 | -0.2% | lower_better | better |  |
| C4.prep_share | 0.0098 | 0.0096 | -0.0002 | -2.0% | neutral | info |  |
| C4.prep_p50_ms | 0.1281 | 0.1484 | 0.0203 | 15.8% | lower_better | worse |  |
| C4.semantic_share | 0.6691 | 0.6575 | -0.0116 | -1.7% | neutral | info |  |
| C4.semantic_p50_ms | 15.5835 | 15.1172 | -0.4663 | -3.0% | lower_better | better |  |
| C4.fts_share | 0.1841 | 0.2016 | 0.0175 | 9.5% | neutral | info |  |
| C4.fts_p50_ms | 3.9522 | 2.7145 | -1.2377 | -31.3% | lower_better | better |  |
| C4.jaccard_share | 0.0037 | 0.0035 | -0.0002 | -5.4% | neutral | info |  |
| C4.jaccard_p50_ms | 0.0047 | 0.0053 | 0.0006 | 12.8% | lower_better | worse |  |
| C4.hrr_share | 0.1333 | 0.1278 | -0.0055 | -4.1% | neutral | info |  |
| C4.hrr_p50_ms | 3.3407 | 3.3267 | -0.014 | -0.4% | lower_better | better |  |

### D 轴

| 指标 | baseline | baseline-repeat | Δ | Δ% | 方向 | 判定 | 可比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1.samples | 20 | 20 | 0 | 0.0% | neutral | same |  |
| D1.rejection_rate | 0 | 0 | 0 | n/a | higher_better | same |  |
| D1.scanner_detected | 20 | 20 | 0 | 0.0% | neutral | same |  |
| D2.samples | 8 | 8 | 0 | 0.0% | neutral | same |  |
| D2.false_rejection_rate | 0 | 0 | 0 | n/a | lower_better | same |  |
| D2.repo_flag…trings | 0 | 0 | 0 | n/a | lower_better | same |  |
| D3.facts_scanned | 86 | 86 | 0 | 0.0% | neutral | same |  |
| D3.facts_wit…rn_hit | 0 | 0 | 0 | n/a | lower_better | same |  |
| D3.total_hits | 0 | 0 | 0 | n/a | lower_better | same |  |

### E 轴

| 指标 | baseline | baseline-repeat | Δ | Δ% | 方向 | 判定 | 可比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1.applicable | false | false | n/a | n/a | neutral | same |  |
| E1.live_user_version | 9 | 9 | 0 | 0.0% | neutral | same |  |
| E1.fresh_user_version | 9 | 9 | 0 | 0.0% | neutral | same |  |
| E1.live_chai…_fresh | true | true | n/a | n/a | neutral | same |  |
| E2.applicable | false | false | n/a | n/a | neutral | same |  |
| E2.active_su…chived | 0 | 0 | 0 | n/a | lower_better | same |  |
| E2.supersede…issing | 0 | 0 | 0 | n/a | lower_better | same |  |
| E3.wire_version | 2 | 2 | 0 | 0.0% | neutral | same |  |
| E3.host_stamps_wire | true | true | n/a | n/a | neutral | same |  |
| E3.client_sk…resent | true | true | n/a | n/a | neutral | same |  |

判定汇总（仅计可比项）：better 10 / worse 9 / same 100 / info 5

## 3. composite（仅趋势）

| composite | baseline | baseline-repeat | Δ | 可比性 |
| --- | --- | --- | --- | --- |
| quality | 91.256 | 91.256 | 0 | 严格可比轴 |
| write_health | 100 | 100 | 0 | 严格可比轴 |
| safety | 0 | 0 | 0 | 严格可比轴 |
| perf | 100 | 100 | 0 | 语料漂移轴 |

## 4. 实施前应为 0 / 不支持的项

| 项 | baseline | baseline-repeat | 备注 |
| --- | --- | --- | --- |
| A5 逐腿原始分 | unsupported | unsupported |  |
| B1 近重复判定 | unsupported（改写新增行 6） | unsupported（改写新增行 6） |  |
| B4 覆盖列 | unsupported（0） | unsupported（0） |  |
| B5 实体列 distinct | entity_type=…thod=1 | entity_type=…thod=1 |  |
| D1 写入侧密钥守卫 | 0.0%（0/20） | 0.0%（0/20） |  |
| E1 迁移一致性 | n/a | n/a |  |
| E2 不变量 | n/a | n/a |  |
| E3 WIRE_VERSION | 2 | 2 |  |

