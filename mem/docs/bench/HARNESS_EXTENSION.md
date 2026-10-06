# 基准 harness 扩展说明（batch 0/1 之后）

> 本文件说明**只加探针、不改既有定义**的 harness 扩展（T2 报的三处口径限制），以及**语料漂移下的可比性策略**。
> 规格仍是 `mem/docs/BENCHMARK.md`（v1，未改）；产物与差异表的新字段由本次扩展引入。
> 边界：只改 `mem/scripts/bench/**` 与 `mem/docs/bench/**`；**没有**改 `mem/packages/**`（harness 只观察与调用）。
> 本任务**不跑 after 复测**（P-11 尚在实现）——这里交付的是"扩展后的 harness + 说明 + 自检"。

## 0. 为什么不能改既有定义

前后两次测量可比的前提是**同一判据**：一旦改了 `A5`/`B4`/`E1`/`E2` 的判定逻辑，`baseline.json` 里的数字就不再是同一把尺子量出来的，
`compare.mjs` 的 delta 全部失效（`BENCHMARK.md` §3.4：判据变更必须单独提交并标"判据已变"）。

因此本扩展的纪律是：

1. **既有探针与指标原样保留**，包括它们"测不到新能力"这个事实（例如 `A5.per_leg_scores=false`、`B4.supported=false`、`E1.applicable=false`）。
2. 新能力只用**新函数 + 新指标键**衡量（`A5b`/`B4b`/`E1b`/`E2b`）。
3. 每个新指标在产物里带 `new_probe: true`，并进入顶层 `new_probes` 清单；`compare.mjs` 把只出现在后一侧（或带该标记）的指标
   **单列为"新增探针"，绝不作为 delta**。

## 1. 新增探针清单

| 探针 | 轴 | 测什么 | 实现 | 既有对照（不动） |
|---|---|---|---|---|
| `A5b` | A | 经**真实调用路径**（`rt.recall({ action:'search', include_scores:true })`）取逐腿原始分：字段是否存在、字段名、命中上的取值形状、**载荷字节**；并**同时**做一次"不传 `include_scores`"的对照，确认默认仍不支持 | `lib/quality.mjs` `runExplainabilityIncludeScores` | `A5`（`runExplainability`，默认不传 ⇒ `per_leg_scores=false`） |
| `B4b` | B | 从**产品面**读覆盖率：把快照复制成可写副本 → 产品 `buildRuntime` 打开并迁移 → `admin stats` 的 `sources` / `validity`；`assert_count>1` 走 `admin list`+`admin detail` 数一遍，并与运行时连接直接 count 交叉核对 | `lib/quality.mjs` `runCoverageAdminProbe` | `B4`（`runWriteAxis` 里读 v9 快照的 `fact_sources` **列**） |
| `E1b` | E | 在**临时副本**上跑产品迁移（`VACUUM INTO` 快照 → `copyFile` → 产品打开升到 v10），与**全新库**逐项对照 schema 签名（`user_version`、`sqlite_master` 对象、`facts`/`fact_sources` 列、`schema_migrations`） | `lib/perf.mjs` `runIntegrityOnTempCopy` | `E1`（只读活库 v9 快照 ⇒ 恒为 `n/a`） |
| `E2b` | E | 调产品自己的 `db/invariants.ts`（`validityInvariantViolations`）在迁移后的副本与全新库上各跑一次；再在**第三个全新库**里**植入两条违规**（`archived/replaced` 且 `valid_to IS NULL`；`valid_to < valid_from`），要求检查**报出**它们（非永真证明） | `lib/perf.mjs` `runIntegrityOnTempCopy` | `E2`（只读探针，覆盖不到 P-07 不变量） |

要点：

- **`A5b` 报的载荷字节**是同一 query/limit 下 `JSON.stringify(RecallResult)` 的字节数，`include_scores` 缺席 vs `true` 两次之差；只写
  字段名/存在性/字节数，**从不写逐腿分值本身**。
- **`B4b` 的 `assert_count>1`**：`admin stats` 目前没有这一项，所以用 `admin list`+`admin detail`（产品面）数一遍，并对运行时连接直接
  count 一遍，两个数都报且给出 `assert_count_cross_check`；`field_sources` 逐项写明每个数字来自哪个面。
- **`E2b` 的 `upgraded_violations` 允许非零**：一个 v9 老库里，`archive_reason IN ('replaced','contradiction')` 的历史行没有 `valid_to`
  （那时列还不存在），迁移无法凭空回填——这是**如实报告的历史事实**，不是"检查坏了"。非永真性由**植入违规**那一步证明：
  `fresh_violations=0`、植入后 `retired_without_valid_to` 与 `valid_to_before_valid_from` 各 `+1`。
- **绝不迁移用户的活库**：所有会写的步骤都先在 `/tmp/dsh-bench/**` 下复制；活库只经 `VACUUM INTO`（只读源）被读取一次。

## 2. 可比性策略：严格可比轴 vs 语料漂移轴

活库已经漂移：基线是 `active=86`（`snapshot_sha256=be4a5f41…`），本任务期间是 `active=88`（`snapshot_sha256=f585c245…`）。
**真实语料轴的前后对比因此天然不再严格可比**。扩展做两件事：

### 2.1 `--snapshot <path>`：把某次运行钉在同一份库副本上

```bash
# 先用 VACUUM INTO 造一份固定副本（只读源：活库）
node -e "const {L}=await import('./mem/scripts/bench/lib/common.mjs');L.snapshotDb(L.DEFAULT_DB,'/tmp/bench/pinned.db')"
# 之后每次运行都指向它；此模式下活库完全不被读取（corpus.real.live_sha256=null）
node mem/scripts/bench/run.mjs --snapshot /tmp/bench/pinned.db --out mem/docs/bench/after.json
```

- `corpus.real.corpus_source` 记 `pinned` / `live-vacuum-into`，`pinned_snapshot_basename` 记副本名（不写绝对路径）。
- `corpus.real.identity_sha256` 是**实际被测那份字节**的 sha；`VACUUM INTO` 对同一源是确定性的，所以 live 跑与"用同一份快照 pinned 跑"
  会比较相等，而活库本身漂移时必然不等。

### 2.2 `compare.mjs` 的分层判定

| 类别 | 判据 | 指标 |
|---|---|---|
| **严格可比轴** | harness schema、frozen fixture sha、seed、pinned now、node、pnpm 一致；合成 2k/10k 若两侧都跑则另需内容 sha 一致 | `A1`（冻结 41）、`A4`、`B1`/`B2`/`B3`、`D1`/`D2`、`E3`、`C1.synthetic_*`、`C3.*(2k/10k)` |
| **语料漂移轴** | 除上述外，还要求 `corpus.real.identity_sha256`、`active`、`user_version` 一致 | `A2`/`A3`/`A5`、`B4`/`B5`、`C1.real_snapshot`、`C2`、`C3.*_real`、`C4`、`D3`、`E1`/`E2` |

- 漂移时差异表**显式**写"真实语料已漂移（…；active 86→88，identity …）⇒ 该轴不可严格比较"，对应行标 `不可比（语料漂移）`，
  `总体可比` 为 **false**，进程退出码 1——**不会默认判"总体可比: true"**。
- **身份只看快照 sha**：`corpus.real.live_sha256` 是 `memory.db` **主库文件**的 sha，写入还没 checkpoint 时会滞后——实测活库
  86→88 之后 `live_sha256` 仍与基线完全相同，只有 `VACUUM INTO` 出来的 `identity_sha256` 变了（`be4a5f41…` → `f585c245…`）。
  因此 `compare.mjs` 把 live sha 降为信息项，语料可比性由 `identity_sha256` 决定（`A5b`/`B4b` 等新探针同此口径）。
- `git HEAD` 降为**信息项**：before/after 本来就该在不同 commit 上，规格 §3.3 的可比性要求是"同一 harness、同一语料、同一种子"。
- 判据变化单独标注：harness digest 不同 → "判据已变"；若同时满足"只新增指标、两侧都测到的指标无一消失"，写
  **"判据已变 —— 仅新增探针"**，把新探针结果只放在 §3.1，绝不混进 delta 表。
- 轴覆盖不同（`--axes` 只跑部分轴）时，未跑轴的指标标 `未运行`，不算"消失"、不参与判定。

## 3. 产物新增字段

`run.mjs` 产物（`mem/docs/bench/<label>.json`）：

- `corpus.real.corpus_source` / `pinned_snapshot_basename` / `identity_sha256`；
- `axes.A.A5b`、`axes.B.B4admin`、`axes.E.E1b`、`axes.E.E2b`（新探针原始结果）；
- `metrics.*.new_probe = true` 与 `metrics.*.comparability`（`strict` / `corpus_drift`）；
- 顶层 `new_probes: [{ id, axis, title, source, comparability, note }]`；
- `unsupported` 里新增 4 条 `【新增探针】…` 台账；
- `notes` 增加两条（新增探针、语料身份判定）。

人读报告（`<LABEL>_REPORT.md`）在每个指标表新增"探针"列（`基线` / **新增探针**），并有独立的
"新增探针（不与基线做 delta）"小节。

## 4. 怎么做 after 复测（P-11 落地后）

```bash
# 1) 冻结一份语料副本（如果要固定语料；否则默认对活库做只读 VACUUM INTO）
node -e "const {L}=await import('./mem/scripts/bench/lib/common.mjs');L.snapshotDb(L.DEFAULT_DB,'/tmp/bench/pinned.db')"

# 2) 全套 after（与 baseline 同 seed / now；harness 已扩展，digest 会变，compare 会标"仅新增探针"）
node mem/scripts/bench/run.mjs \
  --label after --out mem/docs/bench/after.json \
  --report mem/docs/bench/AFTER_REPORT.md \
  --seed 20261006 [--snapshot /tmp/bench/pinned.db]

# 3) 逐项差异（before=baseline，after=after）
node mem/scripts/bench/compare.mjs mem/docs/bench/baseline.json mem/docs/bench/after.json \
  --out mem/docs/bench/AFTER_DIFF.md
```

- **不要**在没有 `--snapshot` 的情况下指望真实语料轴严格可比；漂移会被如实标注。
- 若要严格对比真实语料轴：两次运行必须用**同一份** `--snapshot`（或都跑在同一份未漂移的活库快照上）。
- `A1` 仍要求与 `eval_zh.spec.ts` 的冻结聚合逐位相等，不相等时 `run.mjs` 直接失败（这是既有行为，未改）。
- 判据变化是预期的（新增探针会改变 harness digest）；`compare.mjs` 会把它标成"仅新增探针"，既有指标仍按原判定比较。

## 5. 本次自检（在临时库上真实执行）

| 自检 | 结果 |
|---|---|
| `baseline.json` 仍能解析 | ✅（`JSON.parse` 与字段读取正常） |
| `compare(baseline, baseline-repeat)` 仍给出原有结论 | ✅ `总体可比: true`、`better 10 / worse 9 / same 100 / info 5`、退出码 0（新探针缺失不崩） |
| 4 个新探针在**临时库**上被真实执行到判定 | ✅ 见下 |
| 隐私门 0 命中 | ✅ 新产物与差异表 `forbidden_keys/patterns/containment` 全 0，`clean:true` |
| 只改 `mem/scripts/bench/**` 与 `mem/docs/bench/**` | ✅ |

新探针自检输出（`--snapshot` 固定副本，`active=88`，输入 `user_version=9`）：

- `A5b`：`include_scores_flag_supported=true`；`field_path=hits[].scores`；腿字段 `fts`/`jaccard`/`semantic`（该 query 无 `hrr` 腿），
  首命中非空腿 2 条；`final` 字段存在；载荷字节 `default=4884 / with_flag=5547 / Δ=663`。同一次运行里既有 `A5.per_leg_scores=false` 不变。
- `B4b`：`product_face_supported=true`，`migrated_on_open=true`（9→10）；`sources.coverage=0`、`validity.coverage=0`（老语料确实 0，不是
  "unsupported"）；`assert_count_gt1=0`，与直接 count 交叉核对一致。
- `E1b`：`input=9 → upgraded=10 = fresh=10`，`migrated_equals_fresh=true`，`diff_parts=[]`。
- `E2b`：全新库 `0`；迁移后的老库 `retired_without_valid_to=58`（历史行，如实报告）；**植入违规后两项各 +1，`detected=true`**。

> 自检只写 `/tmp`，不在 `mem/docs/bench/` 落任何 after 产物。
> `mem/docs/bench/baseline-repeatability.md` 已用扩展后的 `compare.mjs` 从**同一对**基线产物重新生成：结论与逐项判定不变
> （`总体可比: true`、`better 10 / worse 9 / same 100 / info 5`），只是排版换成了新的分层可比性格式。
