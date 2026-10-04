# 换更强的分词器，能否提高记忆插件的命中率？——量化测量（Q2-measure）

> 状态：**测量报告**，未改任何产品代码（`mem/packages/**` 一字未动）、未提交、未改版本号/CHANGELOG。
> 新增：`mem/scripts/bench-entity-channel.mjs`（只读测量脚本，只打印数字与 id）与本报告。
> 日期：2026-10-04。本机：node v22.23.2，装有 `nodejieba@2.6.0`，模型缓存
> `~/.avantf/env/models/Xenova/bge-base-zh-v1.5`(768) 与 `bge-small-zh-v1.5`(512) 均在。

**一句话结论：在 shipped 配置（语义腿可用）下，换更强的分词器对命中率/准确率不可能有可测量的提升
——实体+HRR 通道在冻结评测集 41 条上 ON/OFF 六项指标逐位相同，在真实库 80 条上 14 条查询 top-1 零变化。
分词器只可能影响这一条通道，而这条通道在真实库上还被 Jaccard 分母（每事实中位 31 个实体 vs 门槛 0.2）
结构性掐死：1 实体查询能触达的事实只有 2/80。真正的杠杆是实体腿的分母/门槛，不是分词器。**

---

## 0. 先给定的实现事实（复核过，全部成立）

| 事实 | 复核方式 | 结果 |
|---|---|---|
| 分词只喂实体抽取：`entities/extract.ts` 的 `jieba.tag()` | 读 `extract.ts:124-148` | ✓ 只有 `tagText()` 调 `jieba.tag()`；`entitiesFromTokens` 消费其产物 |
| 实体产物影响两条共享候选集与门槛的探针：实体腿（Jaccard）与 HRR | `store/floors.ts:175`、`memory.ts:1383-1417` | ✓ HRR 的候选 = `[...jaccardFloored.scores.keys()]`，`leg:'jaccard'` 共用权重/门槛 |
| FTS 腿不经分词 | `store/lexical.ts` 的 `relevanceTerms()`（CJK 3-gram + 拉丁词） | ✓ |
| 语义腿不经分词 | 嵌入模型 | ✓ |
| ⇒ 换分词器结构上只可能影响"实体+HRR"这一条通道 | 上述四条 | ✓（本报告的测量范围） |

### 权重与门槛（确切数字，来源：`contract/src/config.ts`、`contract/src/types.ts:221`）

| 通道 | 默认档权重（本机 `buildRuntime` 读回实测，与源码默认逐位一致） | `DEGRADED_WEIGHTS`（语义腿不可用） |
|---|---|---|
| semantic | **0.55** | 0 |
| fts | 0.30 | 0.65 |
| **jaccard（实体腿，HRR 共用同一权重）** | **0.15** | **0.35** |

- HRR 探针**没有第 4 个权重**：`memory.ts:1402-1415` 明确让它与 Jaccard 腿共用 `ctx.weights.jaccard`。
- 门槛默认：`min_semantic_similarity=0.5`、`min_fts_terms=2`（degraded 放宽到 1）、**`min_jaccard=0.2`**；
  自动放宽档 `LOOSE_FLOORS` 把 Jaccard 降到 **0.15**（`store/floors.ts:104`）。
- 融合按每条腿自身最大值归一（`retrieval-core/src/fusion.ts`），所以"实体腿命中"的**得分总是 1.0×权重**，
  **与分词质量无关**——分词质量只决定"哪些事实成为候选、是否过门槛"。

---

## 1. 通道开 vs 关：对照表

**关（OFF）的实现方式（纯配置，不碰代码）**：`weight_jaccard = 0` **且** `min_jaccard = 1`。
两者都要：权重 0 才不吃融合分；门槛 1 才把候选集清空（HRR 候选集就是 Jaccard 幸存者）。
只设权重 0 时，零分候选仍会被 `fuse` 池化（`fusion.ts:81` 注释：total 0 也保留）。

### 1a. 冻结评测集（16 用例 / 41 条查询，语义腿用 shipped 的 `Xenova/bge-base-zh-v1.5`/768 真实加载）

| 语义腿 | floors 档 | 臂 | P@k | R@k | MRR | must_include | must_exclude | empty | 返回集变动 | 丢 top-1 |
|---|---|---|---|---|---|---|---|---|---|---|
| **live** | production | ON | 0.6423 | 0.9878 | **1.0000** | 0.9756 | 0.6585 | 0 | 2 | 0 |
| live | production | OFF | 0.6423 | 0.9878 | **1.0000** | 0.9756 | 0.6585 | 0 | | |
| live | strict | ON | 0.6423 | 0.9878 | 1.0000 | 0.9756 | 0.6585 | 0 | 2 | 0 |
| live | strict | OFF | 0.6423 | 0.9878 | 1.0000 | 0.9756 | 0.6585 | 0 | | |
| **degraded** | production（默认档） | ON | 0.6301 | 0.9634 | **0.9756** | 0.9512 | 0.7073 | 0.0244 | 9 | 2 |
| degraded | production | OFF | 0.6301 | 0.9634 | **0.9512** | 0.9512 | 0.8537 | 0.0244 | | |
| **degraded** | strict | ON | 0.6301 | 0.9634 | **0.9756** | 0.9512 | 0.7073 | 0.0244 | 19 | 12 |
| degraded | strict | OFF | 0.4106 | 0.7195 | **0.7073** | 0.7073 | 0.8537 | 0.2683 | | |

**自检（证明测量器忠实）**：`degraded/production/ON` 一行 = `0.6301 / 0.9634 / 0.9756 / 0.9512 / 0.7073 / 0.0244`，
与 `core/test/eval_zh.spec.ts:304-312` 冻结的 41 条基线**逐位相同**（该 spec 因 vitest 禁用模型缓存而在
degraded 下跑这 41 条）——本脚本复现了官方基线，因此上表的 A/B 可信。

语义腿 live 时两臂的 2 条差异**只在第 2 个槽位，top-1 不动**：

| 查询 | ON | OFF | expected |
|---|---|---|---|
| 生产环境的 Python 版本要求 | [0, 1] | [0, 2] | [0] |
| CI 用哪个 Python 版本 | [1, 2] | [1, 0] | [1] |

degraded/strict 下丢 top-1 的 **12 条**（OFF 全空的有 10 条）：
`李娜/张伟/王强/网关/风控`（2 字查询，FTS 因 trigram 索引**不可达**，`buildFtsQuery` 返回 null ⇒
实体腿是唯一一条腿）、`周会什么时候开`、`日志怎么收集`、`我是谁？`、`我是做什么的`、`本人是谁`
（自指族靠改写文本的实体 `用户` 进候选）、`订单服务的主库是什么`、`CI 用哪个 Python 版本` 等。

### 1b. 本机真实库（80 条 active，复制到临时 dataHome；原库只读）

查询集：自指族 6（`我是谁？/我叫什么/我的名字/我是做什么的/我叫啥/本人是谁`）+ 非自指 3
（`插件的安装方法/任务怎么拆分/知识库在哪里`）+ 实体型 5（`版本号/插件/任务/用户/dsh`）。

| 模式 | 臂 | top-1 被通道改变 | 自指族 top-1 = 身份事实 | HRR 探针 vs 无 HRR top-1 变化 |
|---|---|---|---|---|
| **语义腿 live** | ON | **0/14** | 6/6 | **0/14** |
| 语义腿 live | OFF | — | 6/6 | — |
| 语义腿 degraded | ON | **2/14** | 3/6 | **0/14** |
| 语义腿 degraded | OFF | — | 3/6 | — |

degraded 下改变的 2 条：`版本号`（ON #103 → OFF #155）、`用户`（ON #4 → OFF 空）。
live 下所有查询 top-1 逐条相同，`overlap@5` 3–5，说明通道只动尾部。

**为什么 live 下通道几乎无效——Jaccard 分母（本报告最重要的结构性发现）**：
真实库每条事实的实体数中位 **31**、均值 **32.4**。查询通常只抽出 1–2 个实体，于是即使**全部**命中，
Jaccard = `|q∩f| / |q∪f| = 1/(1+31-1) = 0.032`，**远低于 `min_jaccard=0.2`**。实测每条查询
`dropped_by_floor.jaccard` 12–38，只有约 1–2 个候选能过 0.2 门槛。

| 查询实体数 k | 能过 `min_jaccard=0.2` 的事实数 |
|---|---|
| 1 | **2 / 80** |
| 2 | 3 / 80 |
| 3 | 7 / 80 |
| 5 | 21 / 80 |

（能过门槛的条件是 `k / n ≥ 0.2`，n = 事实实体数；80 条里实体数 ≤5 的只有 2 条。）

---

## 2. 分词错误的规模（真实库只读统计，只打印计数与打码例子）

### 2a. 事实/实体规模

| 指标 | 值 |
|---|---|
| active 事实 | 80 |
| **零实体事实** | **0** |
| fact→entity 链接 | 2589 |
| 去重实体名（active 内） | 1333（全表含归档 2139） |
| 每事实实体数 min/p25/中位/p75/max/均值 | **3 / 23 / 31 / 41 / 66 / 32.4** |
| **单字符 CJK 实体** | **0**（全表 4 个单字符实体全部非 CJK） |

**"单字符 CJK 实体占比"这个症状在本实现里结构上不可能出现**：`extract.ts:141` 有 `if (w.length < 2) continue`，
单字符词元一律丢弃。过度切分的真实症状不是"多出单字实体"，而是**专名被拆散后整体丢失**。

### 2b. 过度切分 / 丢弃规模（对 80 条事实逐条跑 `tagText`，13415 个词元）

| 指标 | 值 | 占比 |
|---|---|---|
| 全部词元 | 13415 | 100% |
| 因 `length<2` 被丢弃 | 6210 | **46.3%** |
| 其中 CJK 单字 | 1902 | 14.2% |
| **其中 POS = `nr`（人名，被拆散后丢弃）** | **10** | 0.07% |
| 其中 POS = `ns`/`nt`（地名/机构名） | 0 | 0% |

**打码例子（`tagText` 实测）**：

| 输入（打码） | jieba 输出 | 结果 |
|---|---|---|
| `用户的名字是张三`（公开 fixture 名） | `用户:n / 的:uj / 名字:n / 是:v / 张:q / 三:m` | 张三被拆成量词+数词，**两个都被拒 → 专名整体丢失** |
| `用户的名字是冯**。`（真实身份事实） | `用户:n / 的:uj / 名字:n / 是:v / 冯**:x / 。:x` | 整名一个 `x` 词元，**保留**（`ENTITY_EXTRA` 接受 `x`） |
| `我是谁？` | `我:r / 是谁:x / ？:x` | **多出伪实体 `是谁`**（代词+动词被合成一个 `x`），真实库 0 条事实含它 ⇒ 死实体，只把查询实体集撑大 |
| `用户是谁`（自指改写） | `用户:n / 是:v / 谁:r` | 抽出 `用户`，正确 |
| `缓存` | `缓存:v` | 动词标签 → **不是实体**；且 2 字 CJK 使 `buildFtsQuery('缓存') === null` ⇒ 该查询无任何腿可达（与 `eval_zh.spec.ts` 的 PINNED GAP 用例一致） |

**结论**：专名拆散在本语料是小规模现象（10 个 `nr` 词元 / 13415，约 0.07%），且**依名字而异**
（张三丢、冯飞留）；主要噪声其实是"伪实体"（如 `是谁`）与"动词标签导致 2 字词不可见"。

### 2c. 存储列不可用于判断抽取路径（实测）

真实库 2139 个实体**全部**记 `extraction_method='regex'`、`entity_type='unknown'`，看起来像走了正则回退；
但逐事实比对：抽样 12 条事实的**存储实体集与当前 jieba 输出逐名完全相同**（32/32、47/47、46/46 …）。
原因是 `entities` 表的这两列只有 schema 默认值（`db/schema.ts:94-96`），`linkFact` 只写 `name`
（`db/dao/entities.ts:21-31`）——**这两列是死列，不能用它判断分词器是否生效**。

---

## 3. 换分词器的收益与代价（评估，未实施）

### ① 理论上限 = 第 1 节量到的"通道价值"

因为分词只喂这一条通道，且实体腿的得分恒为"1.0×权重"（与分词质量无关），换分词器**最多**只能在
"把本该进候选的事实拉进候选 / 把它抬过门槛"这一层产生作用。所以上界就是通道自身的 ON/OFF 差值：

| 运行配置 | 通道价值（上界） | 换分词器的可能收益上界 |
|---|---|---|
| **shipped：语义腿 live**（评测集 / 真实库） | 六项指标 **0**；真实库 **0/14** top-1 | **0**（命中率无处可涨，评测集 MRR 已经是 1.0） |
| 语义腿 down + 默认档（自动放宽） | 评测集 ΔMRR +0.0244（2 条各掉一档 = 1.0 个倒数排名单位），其余五项 0 | ≤ +0.0244 MRR |
| 语义腿 down + strict | 评测集 ΔP@k +0.2195 / ΔR@k +0.2439 / **ΔMRR +0.2683** / Δmust_include +0.2439 / 多 10 条不空；真实库 2/14 top-1 | ≤ 该量级，且**只在语义腿宕机窗口** |
| 真实库任意模式 | 通道被 Jaccard 分母掐死（1 实体查询触达 2/80 事实） | 分词器**修不了**分母：抽更多实体只会让分母更大 |

**"NER 式抽取"同理**：它能改变的只是"抽出哪些名字"，改变不了 `overlap/union` 的算术，也改变不了
0.15/0.35 的权重。在语义腿 live 时更是连候选集都不缺。

### ② 换 Rust 实现（`@node-rs/jieba`）：已知差异（来源见链接，**未安装、未实测**）

- 包 `@node-rs/jieba@2.0.3`，**license MIT**，N-API 预编译二进制（**不需要 node-gyp/C++ 工具链**），
  是 [`jieba-rs`](https://github.com/messense/jieba-rs) 的绑定：<https://registry.npmjs.org/@node-rs/jieba/latest>
- API 形状与本仓用法**兼容**：`tag(sentence, hmm?) → {tag, word}[]`（与 nodejieba 的 `{word, tag}` 同形），
  但要用 `Jieba.withDict(dictBuffer)` / `new Jieba()` 构造实例：<https://unpkg.com/@node-rs/jieba@2.0.3/index.d.ts>
- 自定义词典是一等 API：`Jieba.withDict(Buffer.from(lines))` / `loadDict()`：
  <https://unpkg.com/@node-rs/jieba@2.0.3/README.md>
- 上游自测基准（README，nodejieba vs @node-rs/jieba）：
  `Cut 1184 词` 8,246 vs 6,392 ops/s（**≈1.29×**）；`Tag 1184 词` 3,174 vs 2,672 ops/s（**≈1.19×**）；
  `Tag 246,568 词` 11 vs 7 ops/s（**≈1.5×**）：<https://unpkg.com/@node-rs/jieba@2.0.3/README.md>
- **本机实测的当前代价**（nodejieba，独立进程）：首次 `load()` **949 ms**（与任务给的 1285ms 同量级），
  预热后 `tag(100 字)` **0.029 ms**、`tag(9 字)` **0.007 ms**；RSS **43 MB → 300 MB**（加载后）。
- **未能验证**：@node-rs/jieba 的**首次加载时间与常驻内存**（未安装、不改依赖，无法测）；它仍需把
  词库读进内存（包 unpacked 11.3 MB），所以"省内存"是**未证推断**，不能当成收益。命中率方面它
  与本节的结论无关——它只是同一个算法的更快实现，**不改变抽取结果**。

### ③ 自定义词典：更便宜的杠杆，但当前**没有任何入口**

- 确认无入口（全仓 grep `user_dict|userDict|loadDict|load_dict|insertWord|jieba.load` 只命中一处注释
  与一个测试名）：`extract.ts:70` 只调 `jieba.load()` **无参数**；`contract/src/config.ts` 里**没有**
  `entities` / `dict` 任何配置项。
- 库本身支持：`nodejieba` 的 `load({ userDict })` 就在其 typings 里
  （`node_modules/nodejieba/types/index.d.ts`），只是本仓从不使用。
- **预期收益估计（基于第 2 节的过度切分占比）**：
  - 专名拆散规模 ≈ 10 个 `nr` 词元 / 13415 = **0.07%**，且依名字而异；把它全部修好，也只能让这些
    名字进候选；而它们的 Jaccard 还要面对 31 个实体的分母。
  - 在冻结评测集上可给出**反例**：给身份事实加词典项 `张三`，41 条查询**没有一条**会抽出 `张三`
    （`我是谁？` 抽的是 `是谁`，改写抽的是 `用户`）⇒ top-1 变动 0；反而 `我的名字` 的 union 3→4、
    Jaccard 0.333→0.25（仍过 0.2，无损但方向为负）。**预期收益 ≈ 0，符号可能为负。**
  - 词典真正能救的是"2 字动词标签词"（如 `缓存`）：入典后可被实体腿服务，但仅当语义腿 down、
    且事实实体集足够窄（1 实体查询只有 2/80 条事实能过 0.2 门槛）。所以它是**降级窗口的补丁**，
    不是常态命中率的杠杆。

---

## 4. 结论（三情形逐一）

**(a) 成立（shipped 配置）**：实体+HRR 通道在冻结评测集（语义 live，41 条）上**六项指标逐位相同、
仅 2 个第 2 槽位移动**，在真实库（80 条，14 条查询）上 **top-1 零变化**；HRR 探针的边际影响 **0/14**。
⇒ **换更强的分词器对命中率/准确率是无感的**；唯一真实收益落在**首载/内存**这条轴上
（前提是换的实现真能省——而这一点本报告未测得，见 ②）。
不建议为此单开一条改动线；若哪天因为其它理由换 Rust 实现，本报告说明它**不会动检索行为**。

**(b) 只在"语义腿不可用"窗口里成立，而且最该改的不是分词器**：
degraded+strict 下通道值 ∆P@k **+0.2195**、∆R@k **+0.2439**、∆MRR **+0.2683**、∆must_include **+0.2439**，
且没有它时 41 条里有 **10 条答案变空**；真实库 degraded 下 2/14 条 top-1 被它决定。但即使在这个窗口，
**绑定约束是 Jaccard 分母与 0.2 门槛**（1 实体查询只能触达 **2/80** 条事实；典型查询最高 Jaccard 0.03–0.09），
不是分词质量。**最该改的点排序**：① 实体腿的打分/门槛（分母稀释：改 overlap 系数、按 IDF 加权、
或按查询实体宽度归一，而不是 min_jaccard 一刀切）；② 其次才是词典（且收益 ≈ 0，见 ③）；
③ 换分词器排在最后，收益上界仍被 ①②卡住。

> **后续（2026-10-04 任务 E2，已落地）**：① 已按"锚点实体（IDF 过滤）+ 饱和并集"修补，见
> `packages/core/src/store/entity_leg.ts` 与 `DESIGN.md` §20.19 续——1 实体查询从 **2/80** 变为
> "共享锚点即过门槛"（例：知识库 0.026→0.25、阿里 0.167→0.25、用户 2→14），泛词（插件/任务）反而
> 不再成为锚点；冻结评测集四臂**逐位不变、未重冻**。本报告（b）的**测量**因此仍是历史事实，只有
> "绑定约束"这一句被后续修复取代。

**(c) 不适用**——数据足够下结论。**未能验证/推断明示**：
- 真实库没有 gold 标注，1b 的判据是"ON/OFF 逐条同一性"与"自指族 top-1 = 已知身份事实"，不是 P@k/MRR；
- `@node-rs/jieba` 未安装：其首载时间、常驻内存**未实测**；上游基准是**外部数据**不是本机数据；
- "NER 式抽取"的上界是**论证**（通道价值 + 分母算术），未做实现级实验；
- 评测集里 35/41 条在官方冻结跑法下是 degraded；本报告额外用真实 768 模型跑了 semantic-live 一档，
  两档都给了（这正是"live 下通道无感"这一结论的来源）。

---

## 5. 可复现命令

```bash
cd /home/ffeng/sources/dsh-plugins/mem

# 全量（三段：冻结集 A/B、真实库 A/B(+HRR)、实体质量统计）—— 约 3–5 分钟
node scripts/bench-entity-channel.mjs --json /tmp/entity-channel.json

# 只跑冻结评测集（live 与 degraded 两种语义腿 × ON/OFF × production/strict）
node scripts/bench-entity-channel.mjs --skip real,stats --json /tmp/eval.json

# 只跑真实库副本（原库只读；live 与 degraded 两种模式）
node scripts/bench-entity-channel.mjs --skip eval,stats --json /tmp/real.json

# 只跑实体质量统计（只读，只打印计数/打码例子）
node scripts/bench-entity-channel.mjs --skip eval,real

# 官方基线（用于核对 1a 的自检）：degraded/ON 一行应与它逐位相同
# （本条已实测跑过：Test Files 1 passed / Tests 5 passed）
pnpm -C mem/packages/core exec vitest run test/eval_zh.spec.ts

# 既有门槛扫描工具（本报告未改动，供交叉参照）
pnpm -C mem bench:floors -- --model Xenova/bge-base-zh-v1.5 --dim 768
```

脚本参数：`--model/--dim/--cache-dir/--real-db/--skip eval,real,stats/--json`；
`--skip` 可任意组合。脚本**不写** `~/.avantf`（真实库先 `copyFileSync` 到临时目录再打开，只读原库）。

## 6. 本次没有改的东西（纪律）

- `mem/packages/**` 实现代码：**未改**（本报告的全部结论来自配置旋钮 `weight_jaccard` / `min_jaccard`
  与只读查询）；
- 版本号 / `CHANGELOG.md`：**未改**；
- git：**未提交**；
- 新增文件仅两个：`mem/scripts/bench-entity-channel.mjs`（测量脚本）与本文件。
