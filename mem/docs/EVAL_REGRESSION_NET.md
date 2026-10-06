# P-02 回归网：派生评测与两种运行模式

> 面向实现/维护者。方案见 `IMPLEMENTATION_PLAN.md` P-02；本文件说清**跑什么、在哪跑、改了什么会红**。

## 1. 两个新指标在哪

`evaluateCases`（`mem/packages/core/src/eval/runner.ts`）的返回对象现在有三个字段：

| 字段 | 内容 |
|---|---|
| `perQuery` | 逐查询明细（**形状未变**：bench 的 `(ids, scores)` 指纹就建在它上面） |
| `summary` | **恰好 7 个键**，被 `eval_zh.spec.ts:318` 用 `toEqual` 精确断言 |
| `ranking` | **兄弟字段**：`n_queries` / `mean_ndcg_at_k` / `top3_relevant_total` / `mean_top3_relevant` / `top3_hit_rate` |

**两个新指标绝不能进 `summary`**：那是 41 条冻结数字的精确断言，多一个键立刻红，而"数字漂了"与"键集变了"混在一起就无法分诊。`ranking` 是纯增量，所以原有 41 条断言逐位不变。

nDCG 用**二值相关性**，IDCG 取 `min(|expected|, k)` 个理想位——与 bench harness（`mem/scripts/bench/lib/quality.mjs` 的 A1 `ndcg_at_k`）同一口径，因此两者按构造一致。

## 2. 派生引擎（确定性，不调模型）

`mem/packages/core/src/eval/derive.ts`：

- `synthesizeCorpus(n, seed)` 生成长度分布对齐**真实活库**（`BASELINE_REPORT.md` §0.1：9/243/313/409/882 字符）的语料；
- `analyzeCorpus(facts)` 报告实际分布（`in_band_rate`）——**要断言，不要相信生成器**；
- `deriveCases(facts, opts)` 为每条 gold 事实派生一条查询：
  - 查询 = **bridge 片段**（确定性 nonce；gold 不含它）+ gold 的**共享**片段（`df >= 2`，即"非唯一字面"）；
  - **主动植入**一条**无关且足够长**的 carrier，字面包含 bridge 与全部共享片段（要求 ②）；
  - 记录该查询对**非 gold 事实**的**片段碰撞率**；
  - `no_time_word` 守卫：含时间词的候选**丢弃**并计数，不会出现在产出里；
  - `irrelevant` 负控制：与任何事实都不共享片段的查询，检索器必须返回空。

反事实臂（要求 ③）由 `derived_runner.ts` 的 `runDerivedCaseStub` 证明：base 臂 carrier 必须排在 gold 之前，**去掉 carrier 后 gold 必须回到首位**。这是 fixture 的自检——证明钉的是真病理而不是巧合——所以它用确定性 stub 即可成立，不依赖模型。

> 为什么 bridge 是 nonce：引擎不得调用模型，真实改写的桥梁片段（`我是谁？` → `用户是谁` 引入 `用户是`）产不出来。nonce 起同样的机械作用（gold 没有、无关事实有），碰撞算术完全相同。

## 3. 怎么跑

```bash
pnpm -C mem build                                  # 脚本读 lib/，与 bench 同一约定
node mem/packages/core/scripts/derived_eval.mjs --mode stub      # 或 pnpm -C mem/packages/core eval:derived:stub
node mem/packages/core/scripts/derived_eval.mjs --mode real      # 或 pnpm -C mem/packages/core eval:derived:real
```

- 产出默认写到**临时目录**（`$TMPDIR/avantf-derived-eval/derived-<mode>.json`），**不进仓库**；`--out` 可覆盖。
- `--mode stub` 无模型、瞬时，**exit 1 当且仅当**三条碰撞自检或两条守卫不成立——这是 PR 档。
- `--mode real` 用真实嵌入后端（下载模型、慢），**只报告**排序结果（gold/carrier 名次、must_include/must_exclude）。它不设门禁：fixture 的保证由 stub 档承担，把模型更新引起的排序观测变成红灯只会导致反复"重新冻结"而不是评审。

## 4. CI 接线（**待办，本轮未改 `.github/`**）

批次 0 的改动边界是 `mem/packages/**` 与非 bench 的 `mem/docs/**`，`.github/workflows/ci.yml` 不在其中，所以**两个 job 尚未加入**。收口时请把下面两段加进 `.github/workflows/ci.yml`：

```yaml
  # PR 档：确定性 stub，无模型、无网络、秒级。
  derived-eval-stub:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 12 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C mem build
      - run: node mem/packages/core/scripts/derived_eval.mjs --mode stub

  # 夜间档：真模型。只报告、不门禁（见 §3）。
  derived-eval-real:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 12 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C mem build
      - run: node mem/packages/core/scripts/derived_eval.mjs --mode real --out derived-real.json
      - uses: actions/upload-artifact@v4
        with: { name: derived-eval-real, path: derived-real.json }
```

（夜间 job 需要 workflow 顶层加 `on: schedule: - cron: '0 18 * * *'`；`if` 分支避免 PR 触发真模型。）

## 5. 什么时候会红

- `eval_metrics.spec.ts`：nDCG/top-3 的定义、`ranking` 是兄弟字段（`summary` 仍恰好 7 键）。
- `eval_derive.spec.ts`：长度分布、确定性、查询不含 gold 唯一字面、植入的 carrier、反事实臂、两条守卫。
- `eval_zh.spec.ts`：41 条冻结数字逐位不变 + `ranking` 非空洞。
- `derived_eval.mjs --mode stub`：三条碰撞自检与两条守卫全过。
