# 批次 1 · P-01 知识库对照（一次性证据）

> 2026-10-06 · 对照脚本 `/tmp/kb-compare.mjs`（**一次性、不入库**；`/tmp` 下，不在 `mem/scripts/**`）
> Windows/机器：linux/x64，node v22.23.2。

## 为什么需要这张表

`fuse()`（`packages/retrieval-core/src/fusion.ts`）是 **memory 与 knowledge 共用的融合内核**，而知识库没有冻结评测网
（`eval_zh.spec.ts` 只覆盖记忆侧 41 条）。P-01 改了它的返回形状（新增逐腿证据），因此必须给出一次性的知识库前后对照，
证明 `include_scores` 默认关时 `kb_query` 的 **id / 顺序 / 分数逐字节不变**。

## 方法

同一份脚本、同一份语料、同一个降级语义后端（无模型，确定性 FTS+实体腿），两个时点各跑一次：

```bash
# 前：批次 0 树（改动前），已构建的 lib
node /tmp/kb-compare.mjs /tmp/kb-before.json
# 后：批次 1 树，pnpm -C mem build 之后
node /tmp/kb-compare.mjs /tmp/kb-after.json
```

脚本在**临时 data home** 里录入 14 篇固定文档（design / api / ops / research / notes 五个域），再用完全相同
的 14 条查询跑 `rt.query({ limit: 5, max_tokens: 0 })`（默认参数，**不传** `include_scores`），逐条记录
`{kind, ref_id, score, source_ref}`。

## 结果

| 项 | 值 |
| --- | --- |
| 文档数 | 14 |
| 查询数 | **14**（≥10） |
| 返回命中总数 | 25 |
| 空结果查询 | 0 |
| **前后逐字节不同的查询** | **0** |

逐条比对的是 `JSON.stringify` 后的整行（kind / ref_id / **顺序** / score / source_ref），
即 `(ids, scores)` 指纹 + 顺序：**25/25 命中完全一致**。

## 结论

`fuse` 的新增逐腿证据是**纯增量**：默认路径（`include_scores` 未给）下知识库检索的候选、顺序与分数一字未变；
证据只在显式打开时附加（详见 `packages/core/test/fact_provenance.spec.ts` 的交叉对照：打开前后
`hits.map(h => h.ref_id)` 相等、`final` 等于原 `score`）。

## 备注（不构成门禁）

- 本对照是一次性验收证据，**不是** CI 门禁；知识库仍没有冻结评测网。
- 记忆侧的默认路径由既有冻结断言守住：`packages/core/test/eval_zh.spec.ts` 的 41 条汇总数字
  （`n_queries=41`、`mean_precision_at_k=0.6300813008130081`、`mean_recall_at_k=0.9634146341463414`、
  `mrr=0.975609756097561`、`empty_rate=0.024390243902439025`、`must_include_pass_rate=0.9512195121951219`、
  `must_exclude_pass_rate=0.7073170731707317`）与 `docs/bench/BASELINE_REPORT.md` 的 A1 七项逐一相等。
