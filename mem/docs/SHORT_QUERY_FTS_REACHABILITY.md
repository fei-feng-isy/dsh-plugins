# 短中文查询的 FTS 可达性：2 字查询不再「三腿全空」（任务 E1）

> 状态：**实现 + 测量报告**。只改 `mem/**`：`packages/core/src/{db/tokenizer.ts,db/dao/{facts,chunks}.ts,store/{lexical,floors,hybrid,memory,knowledge}.ts}`
> 与相应 spec，新增测量脚本 `mem/scripts/bench-short-query.mjs` 与本文件；**未提交**、**未改版本号 / CHANGELOG**、
> **未改默认模型**、**未动向量 / 表示指纹**。
> 日期：2026-10-04。本机：node v22.23.2、`node:sqlite` = SQLite 3.51.3、模型 `Xenova/bge-base-zh-v1.5`(768)
> 在 `~/.avantf/env/models` 缓存内；活库 `~/.avantf/memory/memory.db`（80 条 active）**只读**，
> 所有真实库测量都在 `copyFileSync` 出的临时副本上做。

**一句话结论：2 字 CJK 查询在 trigram 表里没有第二个可用的词元（实测 `facts_fts` 的 27906 个词元长度全部是 3），
所以词法腿改为回退到 FTS5 trigram 表仍然支持的 `content LIKE '%…%'` 子串谓词，精度守卫是「该行必须原样包含这串字」，
取词规则只在这类查询上改变（长查询逐字节不变）。语义腿不可用的窗口里，活库 2 字实体型查询「top-1 命中该词」
从 3/5 → 5/5（live）、2/5 → 5/5（degraded）；冻结 41 条评测集四个臂七项指标逐位不变、逐查询结果零移动
（它本来就看不见这个形状，见 §4）；代价是这条回退每次一次 O(active 语料) 扫描（活库 0.16–0.94 ms，合成 33k 条 23–44 ms）。**

---

## 1. 先查清 tokenizer 与索引内容（不猜）

对**真实库副本**直接读 `sqlite_master` / `fts5vocab` / 跑一条 `MATCH` 与一条 `LIKE`：

| 事实 | 复核方式 | 结果 |
|---|---|---|
| `facts_fts` 的 tokenizer | `SELECT sql FROM sqlite_master` | `fts5(content, content='facts', content_rowid='fact_id', tokenize='trigram')` |
| `doc_chunks_fts` 的 tokenizer | 同上（knowledge.db） | `fts5(text, content='doc_chunks', content_rowid='chunk_id', tokenize='trigram')` |
| 索引里实际有哪些词元 | `CREATE VIRTUAL TABLE tv USING fts5vocab(facts_fts,'row')` | **27906 个词元，长度全部 = 3**（`SELECT length(term) L, count(*) GROUP BY L` → `3:27906`） |
| 2 字 `MATCH` 是否可达 | `WHERE facts_fts MATCH '"李娜"'` / `'"冯飞"'` / `'"缓存"'` | **一律 0 行**（带引号的 2 字短语、带 `*` 的前缀式都试过，均为 0） |
| 3 字 `MATCH` 是否可达 | `MATCH '"数据库"'` | 3 行 —— 索引本身健康 |
| 单字/双字是否是**可检索词元** | 上两行 | **不是**。3-gram 索引里没有 2-gram/1-gram |
| FTS5 trigram 表是否支持子串谓词 | `WHERE content LIKE '%冯飞%'` | **是**（返回 4,5,6 行）；`LIKE` 在模式 <3 字符时退化为扫描（SQLite 只在 ≥3 字符时用得上 trigram 索引） |

⇒ **「更细粒度」只能落在谓词上，不能落在索引词元上**：回退形态 = `content LIKE '%<2 字串>%'`，代价一次 O(语料) 扫描。

---

## 2. 回退形态与精度守卫（实现）

- `store/lexical.ts` 新增 `substringTerms(text)`：**长度恰好为 2** 的 CJK 串本身（去重、`MAX_TERMS` 上界）。
  **1 字不回退**（单字不是证据，且会命中大半个库）；**拉丁短词不回退**（`MIN_LATIN` 的判定不变）。
- `gradedTerms(text) = relevanceTerms(text)` **非空则原样返回**，为空才退回 `substringTerms(text)` ——
  **整条查询级别**的回退，所以任何"今天能产生一个词元"的文本取词**逐字节不变**（`test/lexical.spec.ts` 对冻结 41 条逐条机器断言）。
  混合形状（如 `缓存失效 李娜`）仍只走 `MATCH`：两条取词路径的分数（bm25 vs 命中计数）不可比，混进一条腿会破坏 cap/归一化的既有不变量。
- `store/floors.ts` 的 `applyTermFloor` 与 `store/hybrid.ts` 的可达性钳制改用 `gradedTerms`；`resolveFloors` 报的
  `floors.fts` 与实际判定同源 ⇒ **回报即实际**。2 字单串查询的 `floors.fts` 从"配置的 2"变成 **1**（钳制；degraded 下本来就是 1）。
- 腿侧：`memory.ts` / `knowledge.ts` 的 `ftsPath` 在 `buildFtsQuery` 返回 `null` **且** `substringTerms` 非空时，
  改走 `FactsDao.ftsSubstringSearch` / `ChunksDao.ftsSubstringSearch`；谓词由 `db/tokenizer.ts#likeSubstring` 共用一份
  （`ESCAPE` 转义调用方文本里的 `%`/`_`/`\`），`rank` = 该行含几个查询词元。
- **精度守卫有两层**：① 搜索谓词本身就是「该行必须**连续**包含这串字」（不是"共享任意一个 trigram"）；
  ② 逐行门槛对**多个** 2 字串要求 `min(配置, 串数)` 个都在（实测 `冯飞 插件` 在 live+strict、配置 2 下只剩 1 条
  同时含两串的事实，25 条候选被门槛丢掉；配置 1/0 时并集 10 条）。
- **hint 路径不变**：`lexicalProbe` 仍只用 `relevanceTerms`（同步路径不能放 O(语料) 扫描），2 字查询在 hint 里依旧是
  `{terms:0, matched:0}`（沉默）。

---

## 3. 三腿全空：修前是什么样、怎么复现

真实库（80 条 active、每事实实体数中位 **31**）里，一条 2 字查询在语义腿不可用时：

| 腿 | 为什么空 | 实测（degraded + strict） |
|---|---|---|
| semantic | 后端不可用 | 0 候选 |
| fts | `buildFtsQuery('阿里') === null` | **连候选都没有**（`dropped_by_floor.fts = 0`，而不是"被门槛丢掉"） |
| jaccard | 1 实体查询 vs 31 实体事实 ⇒ Jaccard ≈ 1/31 ≪ 0.2 | `dropped_by_floor.jaccard = 1…23` |

`冯飞` / `阿里` / `插件` / `任务` 因此 `hits = 0`；`缓存`（PINNED GAP 记的那条 `v` 标签动词）连实体腿都没有。
**变异验证**（把 `SUBSTRING_RUN` 由 2 改成 0，即关掉回退；改后重建 core 再跑同一脚本）：

- `node scripts/bench-short-query.mjs --json /tmp/e1-mutation.json` 与修前 `/tmp/e1-before.json`
  **三个 section 逐字节相同**（eval 四个臂、real 两个模式、unrelated 全部 `identical: True`）；
- 同一份 JSON 里 `阿里/插件/任务` 在 degraded 下 `hits=0` 且 `dropped={semantic:0, fts:0, jaccard:≥1, hrr:0}` ——
  「三腿全空」被精确复现：semantic 腿不在、fts 腿无候选、jaccard 腿丢光。

---

## 4. 量化收益：前后对照

### 4a. 冻结评测集 41 条（`semantic-live` = 真模型 768；`semantic-degraded` = 不可用 stub；两档 floors）

| 语义腿 / 档 | P@k | R@k | MRR | must_include | must_exclude | empty | 与修前 |
|---|---|---|---|---|---|---|---|
| live / production | 0.6423 | 0.9878 | 1.0000 | 0.9756 | 0.6585 | 0 | **逐位不变** |
| live / strict | 0.6423 | 0.9878 | 1.0000 | 0.9756 | 0.6585 | 0 | **逐位不变** |
| degraded / production | 0.6301 | 0.9634 | 0.9756 | 0.9512 | 0.7073 | 0.0244 | **逐位不变** |
| degraded / strict | 0.6301 | 0.9634 | 0.9756 | 0.9512 | 0.7073 | 0.0244 | **逐位不变** |

- 修前/修后 **逐查询 actual ids 零移动**（脚本里 `per_query` 直接对拍，四个臂都是 `moved = []`）。
- 六条 2 字查询（李娜/张伟/王强/网关/风控…）修前就由**实体腿**答对：这些用例都是 **3 条事实**的小语料，
  1 实体查询的 Jaccard ≈ 1/3 ≫ 0.2 —— 这正是这个形状一直"隐形"的原因。
- ⇒ **没有重新冻结**。`eval_zh.spec.ts` 的七个冻结数字不动，新增的是一段"RE-VERIFIED，STILL UNCHANGED"注释，
  写清"不是回退无效果，而是这个集合看不见它"，并指向本文件与 `scripts/bench-short-query.mjs`。
- 该 spec 里原来那条 PINNED GAP 用例（`缓存` 2 字动词标签"无腿可达"）**按仓库规矩显式移动**：
  现在断言 MATCH builder 仍然表达不了它（`buildFtsQuery('缓存') === null` 保留），同时断言这条腿**已经绕过去答出来**，
  并补了"无关 2 字查询仍为空"的反向断言。

### 4b. 本机真实库副本 80 条 active（`floors: 'strict'`，limit=5）

查询集 = 6 自指（我是谁？/我叫什么/我的名字/我是做什么的/我叫啥/本人是谁）+ 3 非自指（插件的安装方法/任务怎么拆分/知识库在哪里）
+ 5 条 2 字实体型（冯飞/阿里/用户/插件/任务）+ 5 条无关 2 字守卫（量子/三文/宋朝/边牧/诗云）。

| 指标 | 语义腿 live 修前 → 修后 | 语义腿 degraded 修前 → 修后 |
|---|---|---|
| 2 字实体型查询 **top-1 文本含该词** | **3/5 → 5/5** | **2/5 → 5/5** |
| 2 字实体型查询**非空** | 3/5 → 5/5 | 2/5 → 5/5 |
| 6 条自指查询 top-1 = 身份事实 | 6/6 → **6/6**（逐条 ids 不变） | 3/6 → **3/6**（逐条 ids 不变） |
| 3 条非自指查询结果 | **逐条 ids 不变** | **逐条 ids 不变** |
| 5 条无关 2 字查询 | 5/5 仍为空 | 5/5 仍为空 |

逐条（top-1 在所有情形下都**没有**变差）：

| 查询 | live 修前 ids → 修后 ids | live top-1 | degraded 修前 ids → 修后 ids | degraded top-1 |
|---|---|---|---|---|
| 冯飞 | [4] → [4,5] | 4（身份事实，不变） | [4] → [4,5] | 4（不变） |
| 阿里 | [5] → [5] | 5（不变） | **[] → [5]** | 5 |
| 用户 | [4,117,103] → [4,117,103,25,36] | 4（不变） | [4,103] → [4,103,25,36,43] | 4（不变） |
| 插件 | **[] → [29,64,94,95,96]** | 29（新，含"插件"） | **[] → [29,64,94,95,96]** | 29 |
| 任务 | **[] → [95,96,97,112,116]** | 95（新，含"任务"） | **[] → [95,96,97,112,116]** | 95 |

**语义腿 live 不回归**：自指/非自指逐条 ids 不变；2 字查询只有"原本空 → 有结果"和"尾部多出含该词的事实"两种变化，
top-1 一个都没被挤掉；冻结集 live 两档七项指标逐位不变（含 must_exclude）。

### 4c. `min_fts_terms` 标定口径重测（§20.19 关心的那条）

取词规则只对**修前根本没有词元**的查询改变，所以"每行命中几个不同查询词元"这个口径对**所有原本可判定的查询**没有变化。
对这个新形状本身重测（活库副本、strict、live 与 degraded 各扫一遍 `min_fts_terms ∈ {0,1,2,3}`）：

- 单串 2 字查询（冯飞/阿里/用户/插件/任务）：四档结果**逐条相同**，`floors.fts` 报 `0/1/1/1`
  —— 钳制把 ≥2 的配置压到 1，**门槛在这个形状上不可达**，与 §20.20⑤ 的既有结论一致；无关查询在所有档位下**仍为空**。
- 多串 2 字查询（`冯飞 插件`，live+strict）：配置 2/3 → 生效 2 → **只 1 条**（两串都在），25 条候选被门槛丢掉；
  配置 1/0 → 只剩并集（`limit=10` 截断，返回 10 条）。⇒ **门槛在多串时是有效的精度旋钮**，不是装饰。
- 结论：**`min_fts_terms` 的默认 2 不需要改，也不需要为新形状重标**；2 字单串查询由钳制降到 1，
  多串查询仍按配置判定。§20.19 的表一/表二不受影响（它们是在语义旋钮扫描里、`min_fts_terms=0` 隔离下测的）。

---

## 5. 代价（写清楚）

`LIKE '%…%'` 在 2 字符模式上没有可用索引 ⇒ 这条回退是 **O(active 语料)** 扫描，且**只在 `buildFtsQuery` 返回 `null` 时**发生。
本机实测同一条生产 SQL（`facts` 表、`status='active'`）：

| 语料 | 查询 | 命中 | 耗时 |
|---|---|---|---|
| 活库 80 条 / 26 KB 正文 | 插件 / 任务 / 缓存 / 冯飞 | 23 / 18 / 4 / 2 | **0.94 / 0.21 / 0.20 / 0.16 ms** |
| 活库（无命中） | 量子 | 0 | **0.16 ms** |
| 合成 33k 条 / 4.8 MB 正文 | 插件（无命中） | 0 | **23.3 ms**（全扫描） |
| 合成 33k 条 | 任务（命中占多数） | 200（cap） | **44.1 ms**（`ORDER BY rank` 要给全部命中排序） |

对照：`bench-memory` 在 10k 语料上 search p50 = 52.9 ms（DESIGN §20.21③），所以这条回退在 33k 上的一次扫描与之同量级，
且只有 2 字查询会付。**替代方案**是写入时维护 bigram 索引（§20.18 记的同一个候选）——那是 schema + 触发器改动，
本轮不选；若将来这条扫描进了 profile，再单独立项。

---

## 6. 验证（实际跑了什么）

| 命令 | 证明 |
|---|---|
| `node scripts/bench-short-query.mjs --json /tmp/e1-before.json`（修前）与 `…/e1-after.json`（修后） | §4 的四臂对照表、活库 14 条 + 无关守卫；两份 JSON 逐查询对拍 |
| `SUBSTRING_RUN: 2 → 0` 变异 + `pnpm -C mem/packages/core build` + 同一脚本 → `/tmp/e1-mutation.json` | §3：三个 section 与修前**逐字节相同**（三腿全空复现、指标回到修前） |
| `min_fts_terms ∈ {0,1,2,3}` 扫描（活库副本，live/degraded，单串 + 多串） | §4c 的门槛口径结论 |
| `pnpm -C mem build` + `pnpm -C mem typecheck` + `pnpm -C mem typecheck:dsh` | 全树编译与类型通过（core 的 `lib/*.d.ts` 先产出） |
| `pnpm -C mem test`（7 个包，含 core 45 文件 609 用例） | 全绿；其中新增/改动：`lexical.spec.ts`（+3 例，含"冻结 41 条逐条 `gradedTerms === relevanceTerms`"）、`floors.spec.ts`（+3 例）、`fts_tokenizer.spec.ts`（+3 例，含 `LIKE` 转义与真实 SQLite 命中）、`hybrid.spec.ts`（拆出 2 字钳制断言）、`eval_zh.spec.ts`（PINNED GAP 显式移动 + 冻结数字注释） |
| `pnpm -C mem/packages/core exec vitest run test/eval_zh.spec.ts` | 41 条冻结汇总**逐位不变**；自指哨兵、碰撞哨兵、R16 全绿 |

**长查询逐字节不变**有两条独立证据：① `test/lexical.spec.ts` 的 REGRESSION 用例对冻结 41 条逐条断言
`gradedTerms(q) === relevanceTerms(q)`（唯一不同的是 5 条 2 字查询）；② §4a/§4b 里所有 ≥3 字查询的 actual ids
修前修后零移动。

## 7. 没能验证 / 明示的边界

- **没有真实标注语料上的 2 字查询 P@k/MRR**：活库没有 gold 标签，2 字查询的判据是"top-1 文本是否原样包含该词"
  （§4b），这是词法一致性判据，不是相关性判据。
- **多串 2 字查询的排名质量未标定**：只验证了门槛在丢候选（`冯飞 插件` 25 条），没验证"两串都在"是否总是更好。
- **混合形状不回退**是刻意的（§2），但代价是 `缓存失效 李娜` 里 `李娜` 仍不被搜索——这是已知边界，未做实验证明它值得改。
- 合成 33k 语料的形状是"同一条模板 × 33000"（命中/不命中两个极端），不是真实分布；23–44 ms 只能当量级参考。
- `LIKE` 的分数（命中词元数）与 bm25 不可比，只在"同一查询只有一条腿路径"的前提下使用；若将来两条路径要合并进同一条腿，
  必须先解决量纲与 cap 不变量。
- 未动：`lexicalProbe`/hint 行为、门槛默认值、权重、向量/表示指纹、默认模型、版本号、CHANGELOG、AGENTS.md。

## 8. 复现命令

```bash
cd /home/ffeng/sources/dsh-plugins/mem

# 前后对照（冻结 41 条四臂 + 活库副本 14 条 + 无关 2 字守卫）
node scripts/bench-short-query.mjs --json /tmp/e1.json
node scripts/bench-short-query.mjs --skip real,unrelated   # 只跑冻结集
node scripts/bench-short-query.mjs --skip eval              # 只跑活库副本 + 守卫

# 官方冻结基线（应与 §4a 的 degraded 两行逐位相同）
pnpm -C packages/core exec vitest run test/eval_zh.spec.ts

# 变异验证：把 packages/core/src/store/lexical.ts 的 SUBSTRING_RUN 改成 0 后重建，再跑第一个命令，
# 结果应与修前 JSON 逐字节相同；还原成 2 再重建。
pnpm -C packages/core build
```

---

## 附记（2026-10-06）：混合形状的边界**只到词法腿**，融合层由实体腿接住

本文 §2/§2a 的裁决（两条取词路径分数不可比、不合并）**继续有效**。补充的是对"混合形状里 2 字话题不被搜索"
这一已知边界的**影响范围实测**——它不需要靠合并词法路径来修：

1. **2 字 CJK 名保留为实体**：`entities/extract.ts:141` 只丢弃 `length < 2` 的词元 ⇒ `李娜`/`张伟` 这类名字
   在查询侧与写入侧都会进实体集合；
2. **df=1 也算锚点**：`store/entity_leg.ts:93-103` 的 `selectAnchors` 条件只有
   `frequency > 0 && frequency <= anchorCeiling(corpus)` ⇒ 只出现在一条事实里的 2 字名同样会被选中；
3. **候选按名索引取**：`store/memory.ts:1363-1367` 用这些锚点走 `candidateFactsForAnyEntity(...)`，
   即按 `entity.name` 索引取事实，**不经过 FTS 取词**。

⇒ 对 `缓存失效 李娜` 这类查询，2 字 run 在**词法腿**不可见，但**实体腿已经能按该名字取到相关事实**；
融合是各腿归一后的加权和，因此该形状在融合层并不存在"取不到"的结构性缺口。
这一点与另一次实测一致：把子串候选注入 fts 腿后，**冻结 41 条的 id 与分数逐字节不变**
（`spikes/raw/round4-s7-fixor.json` 的 `frozen_41`：`byte_identical_ids: 41`、`byte_identical_scores: 41`）。

**后续若要动这一块**：先用评测网在**融合层**证明混排形状确有缺口（现有证据只到腿级），
并且**优先走实体索引路线**（把 2 字 run 当实体查，复用实体腿自己的权重/门槛/cap），
而不是合并 `bm25` 与子串两条取词路径——后者要处理量纲、cap 与 `LIKE '%…%'` 的无索引全语料扫描，
而收益至今未在任何融合级测量上出现。
