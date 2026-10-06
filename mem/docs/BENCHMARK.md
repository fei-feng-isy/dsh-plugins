# mem 记忆插件基准测试（规格 v1）

> 目的：给记忆插件打出一组**可重复、可比对**的分数，用于**方案实施前**取基准、**实施后**再测一次并保存差异。
> 约束：离线、零运行期依赖、不改生产代码（测量任务只写 `mem/scripts/bench/**` 与 `mem/docs/bench/**`）。
> 隐私：沿用既有协议——真实库只读快照（`VACUUM INTO`）、正文只在进程内、派生字符串落 `/tmp`、
> 仓库产物只放聚合（无 `text`/`content` 键、无出现在活库正文里的 CJK 串）。

## 0. 运行形态与产物

| 命令 | 作用 |
|---|---|
| `node mem/scripts/bench/run.mjs --out mem/docs/bench/<label>.json` | 跑全套，写出机器可读结果 |
| `node mem/scripts/bench/compare.mjs a.json b.json` | 生成逐项差异表（人读） |

- `<label>`：`baseline`（实施前）/ `after`（实施后）。
- 每次运行**必须**记录：`git rev-parse HEAD`、`git status --porcelain` 摘要、`loadavg`、Node/pnpm 版本、
  语料指纹（active 条数、长度中位/分位、`user_version`、db sha256）、随机种子、复现命令。
- **同一 harness、同一语料、同一种子**是两次测量可比的前提；任何一项变化必须在报告里写明。
- 语料：① **真实快照**（只读，隐私协议见上）；② **合成规模语料**（2k / 10k 行，固定种子生成，
  用于性能项；不读真实正文）；③ **合成质量语料**（分布敏感形状：长段落 + 含碎片字面的干扰项 + 反事实臂）。

## 1. 评分轴与指标

### A. 检索质量（权重最高，全部在融合层测）

| 指标 | 定义 | 说明 |
|---|---|---|
| `A1` 冻结 41 聚合 | `P@k / R@k / MRR / nDCG@k / must_include_pass_rate / must_exclude_pass_rate / empty_rate` | **必须用与冻结断言同源的确定性 stub 口径**（`test/eval_zh.spec.ts` 的 `selfQueryStub`：`eval-self-query-stub` / `eval-collision-stub`）——这是"默认路径逐字节不变"的**唯一有效口径**（用真模型会引入与实现无关的漂移）；7 个数字必须与断言逐位一致，另记录 `(ids, scores)` 指纹。**同一批查询再用真模型跑一遍作参考**，但**不参与前后判定** |
| `A2` 派生查询集 | top-1 / top-3 内 gold、missing、平均名次；**按形状分组**：实体-字面 / 实体-别名 / 时间 / 属性 / 自指 / 守卫(空) | 派生引擎复用第四轮（`bench-r4-lib.mjs` 的规则）：查询不得含 gold 唯一字面；带无关守卫。**真模型口径**（质量分数只在真模型下有意义），并把模型/维度/权重 revision 记入指纹 |
| `A3` 守卫不误伤 | 无时间词守卫的返回与基线逐条相同；无关守卫返回空 | |
| `A4` 反事实哨兵 | 移除碰撞碎片后 gold 回到首位（每条哨兵单独报） | 分布敏感行为的三条要求之一 |
| `A5` 可解释性 | 结果是否带逐腿原始分（能力标志 + 打开时的载荷字节/命中） | 实施前应为"不支持" |

### B. 写入与生命周期

| 指标 | 定义 |
|---|---|
| `B1` 去重 | 逐字重复 `add` → 行数不变；改写重复 → 近重复分数分布（不改判定即只报数） |
| `B2` 矛盾 | 注入真矛盾对 → 是否上报；假对 → 是否误报；裁决后败方是否归档、胜方是否保留 |
| `B3` 取代链 | `update` → 旧行归档、新行带 `supersedes_id`、反向可查 |
| `B4` 覆盖 | `valid_from` 非空占比、`fact_sources` 有来源占比、`assert_count>1` 条数（实施前预期 0） |
| `B5` 实体列 | `entity_type` / `extraction_method` 的 distinct 取值数（实施前预期各 1） |

### C. 性能（固定语料与查询集，取 p50/p95）

| 指标 | 定义 |
|---|---|
| `C1` 读 | `recall search` 的 p50/p95：真实快照 + 2k + 10k |
| `C2` 写 | `remember add` 的 p50/p95（真实快照） |
| `C3` 启动与体积 | `buildRuntime` 毫秒、db 字节、RSS |
| `C4` 腿级可观测与消融归因 | ① **腿级候选数/门槛丢弃数**（`RetrievalHealth` / `RetrievalHealthSummary` 已有计数器，直接读）；② **消融式成本归因**：对同一查询集，用**直接调核心检索 API**的方式比较 `includeHrr` 开/关、以及语义腿有/无向量（临时 dataHome 里放/不放向量）时的 p50 差值。**不靠生产插桩** |

### D. 加固与安全

| 指标 | 定义 |
|---|---|
| `D1` 正例 | 合成密钥/PEM/连接串样本 → 被拒绝的比例（实施前预期 0） |
| `D2` 反例 | 本仓 `.env.example` / README 里的合法示例 token、文档占位符 → 被误拒的比例（要求 0） |
| `D3` 真实语料误伤估计 | 真实快照里命中模式的**条数**（只报计数，不报内容） |

### E. 完整性与不变量

| 指标 | 定义 |
|---|---|
| `E1` 迁移 | 从每个历史 schema 版本升到最新后与全新库一致（实施前：n/a） |
| `E2` 不变量 | 取代/有效期不变量可由一条 SQL 校验 + **植入违规必须失败**（实施前：n/a） |
| `E3` wire | `WIRE_VERSION` 值 + 两半 skew 行为（实施前：2） |

## 2. 评分换算（便于追踪，不是优化目标）

- `quality = 100 × (0.35·nDCG@k + 0.25·must_include + 0.20·(1 − empty_rate) + 0.20·(1 − must_exclude_fail))`
- `write_health = 100 × (0.4·dedup_ok + 0.3·contradiction_ok + 0.3·chain_ok)`
- `safety = 100 × (D1 正例命中率 × (1 − D2 误拒率))`
- `perf = 100 × (基线 p50 / 本次 p50)`，上限 100（只用于同语料自比）
- 报告里**每个原始指标都单独列出**；上面四个只用于一眼看趋势。

## 3. 前后测协议

1. **实施前**：在"未动 `mem/packages/**`"的 HEAD 上跑 `--label baseline`，产物
   `mem/docs/bench/baseline.json` + `mem/docs/bench/BASELINE_REPORT.md`（含每一项的绝对分与 `(ids,scores)` 指纹）。
2. **实施后**：在方案 12 项落地、门禁通过后，用**同一 harness、同一语料、同一种子**跑 `--label after`，
   产物 `mem/docs/bench/after.json` + `mem/docs/bench/AFTER_REPORT.md`，并用 `compare.mjs` 生成逐项差异。
3. **可比性检查**（写进两份报告）：语料指纹、种子、Node/依赖版本一致；**而且必须"同口径对同口径"**——
   `A1` 只在 **stub 口径**下比较（真模型口径仅供同版本参考），`A2`/`C*` 只在**同一模型与同一表示指纹**下比较；
   模型/维度/pooling/权重 revision 任一变化 ⇒ 该口径下不可比，必须在差异表里屏蔽该项并写明。不一致必须标注。
4. **不得**为了好看而改 harness 的判据；任何判据变更必须单独提交并在报告里标"判据已变"。
5. **不得为了测量而改生产代码**：需要生产插桩才能测的项，**记为 `n/a` 并写明原因**（例如"分腿耗时需插桩"），
   而不是加计时代码或改动 packages。测量任务只写 `mem/scripts/bench/**` 与 `mem/docs/bench/**`。
