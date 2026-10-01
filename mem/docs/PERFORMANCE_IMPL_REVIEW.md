# 性能优化实施复核（`PERFORMANCE_REVIEW.md` §9 第 1–7 步）

> **范围**：`docs/PERFORMANCE_REVIEW.md` §9 落地顺序第 1–7 步的**实施改动**（第 8 步未做）。
> **状态**：改动在工作区，**未提交**。
> **性质**：只读复核，未修改任何生产代码。
> **方法**：一轮自审 + 三路独立子审查（hnswlib 适配器 / 检索腿与评测 / 固定开销与写侧）。
> 每条结论标注证据来源；凡能一条命令验证的（查询计划、运行时探针、差分测试、基准复跑）都实际跑过。
>
> **结论**：收益真实，量级与进度表一致；**未发现阻断缺陷**。但有 **6 项语义/排名/资源回归**应修，
> 一类**"守门守不住"**的系统性问题，以及 **3 项本报告已提出、实施时漏掉**的项。修复顺序见 §8。

---

## 1. 方法与证据等级

| 标签 | 含义 |
|---|---|
| 【自审·复现】 | 本轮复核作者用临时脚本/生产入口跑出的结果 |
| 【子审查·复现】 | 子审查跑出的结果，条目内注明（部分由本作者再复核） |
| 【读码确证】 | 读码即可确定（语句形状、调用点、复杂度） |
| 【推断】 | 机制确证，量级未测 |

**复现手段**：临时 data home + 生产入口；注入式确定性语义后端（隔离 ONNX）；`EXPLAIN QUERY PLAN`；与 `HEAD` 的**差分测试**（jieba 重构）；`hnswlib-node` 的 C++ 源码核对；合成规模基准复跑。

**基线（自审实跑）**：`pnpm -r test` → **413 通过**（改动前 391）；`pnpm typecheck` → 0 错误；`pnpm build` → ok；`pnpm typecheck:dsh` → 0。

---

## 2. 收益确认为真（自审复跑基准）

`node scripts/bench-memory.mjs --mode vec --sizes 2000 --iterations 8`，与报告 §3.2 的改动前基线对照：

| 指标 | 改动前（报告基线，n=2000） | 本次实测 |
|---|---|---|
| `remember update` | 664 ms | **2.9 ms** |
| `buildRuntime`（启动） | 763 ms | **50.5 ms** |
| `recall search` | 18.4 ms | **14.1 ms** |
| `remember add` | 6.0 ms | **3.2 ms** |

方向与量级均与进度表一致。（绝对值受迭代次数/热态影响，不作为门禁。）

---

## 3. 应修：语义 / 排名 / 资源回归

### 3.1 `reinforced_today` 语义变了，且钉它的测试失去判别力【自审·复现】

- **位置**：`packages/core/src/db/dao/facts.ts` 的 `bonusStatedToday`（合并原 `countReinforcedToday` + `sumBonusGrantedToday` 时丢掉了 `bonus_count > 0`）。
- **症状**：`trust_diagnose.reinforced_today` 的文档含义是"今天**消耗了配额**的 fact 数"，现在变成"24h 窗口活跃的 fact 数"。而 `add` 会盖窗口（`facts.ts` INSERT 写 `bonus_count = 0, bonus_window_at = ?`），所以**每个今天新增的事实都被计入**。
- **证据**：【自审·复现】只 `add`、从未 recall：`add` 后 `bonus_count=0 / bonus_window_at=<now>` → `reinforced_today = 1`。
- **连带**：`packages/core/test/memory.spec.ts:503` 的断言（add + `reinforce` 后 `toBe(1)`）在**不调用** `reinforce` 时也成立 ⇒ 该断言不再判别任何东西。
- **修法**：合并语句里恢复 `AND bonus_count > 0`（`SUM(bonus_count)` 不受影响，一行改动），并让上述测试重新有判别力。

### 3.2 实体腿截断按 `shared` 排序，丢掉该腿打分最高的文档【自审·复现 + 子审查·复现】

- **位置**：`packages/core/src/db/dao/entities.ts:150`（`ORDER BY shared DESC, fa.fact_id ASC`），同形于 `packages/core/src/db/dao/chunks.ts:266`；截断施加于 `packages/core/src/store/memory.ts:829-835`。
- **症状**：该腿的分数是 `shared / union`（在 `jaccardPath` 计算），但截断只按 `shared` 排 ⇒ 保留"共现实体多"的行、丢掉"jaccard 高"的行。
- **证据**：【自审·复现】260 候选 / cap 200：丢弃的 60 条里最高 jaccard = **0.500**，而保留集里最低 = **0.333**。
- **影响面**：当 >`legCap`（默认 200）条事实共享 ≥2 个查询实体时触发；那些文档失去 jaccard 贡献，在降级路径下可能整条离开融合池。
- **修法**：按 `shared/union` 排序（或按 jaccard 过取后再截断）。

### 3.3 HRR 回退是无排序的任意切片，且回退条件与其注释不符【子审查·复现】

- **位置**：`packages/core/src/store/memory.ts:1042-1044`、`packages/core/src/db/dao/facts.ts:436`（`LIMIT ?` 且**无 `ORDER BY`**）。
- **症状**：`recall.probe` 的实体匹配不到任何事实时，`candidates` 为空 ⇒ 回退成"按 fact_id 取前 cap 条"。注释说这条分支是"查询里没有可抽实体"，但条件是 `candidates.length > 0`，所以"**有实体但匹配不到**"也走它。
- **证据**：【子审查·复现】260 条事实下返回集恰为前 200 个 `fact_id`；33k 规模下 **32.8k 条事实永远无法被 probe 到**。新增测试（`recall.spec.ts:96-98`）只断言 `Array.isArray`，因此恒通过。
- **修法**：给回退加 `ORDER BY`（无排序就不该截断），或修正回退条件——两者取其一，并把可达性写进报告。

### 3.4 截断改变的是**排名**，不只是剪枝【子审查·复现】

- **位置**：`packages/retrieval-core/src/fusion.ts:45`（本次未改）。
- **症状**：`minMaxNormalize` 对**每条腿各自的分数集合**归一化，腿变小会重新缩放所有幸存者；且超出 cap 的文档直接失去该腿的贡献。
- **证据**：【子审查·复现】对构建产物 `fuse`：语义腿第一、FTS 第 900 名的那条从 #1 变 #2；FTS 第 250 名的纯 FTS 文档在截断后完全消失。
- **影响面**：实际被 `overFetch`（默认 50）限制，所以常见形态是"top-50 池内的文档失去 FTS 贡献"，而不是"top-50 消失"。评测集语料 ≤3 条，`legCap` 永不生效 ⇒ **完全未被测试覆盖**。
- **修法**：截断改为"过取后按融合分再截"，或对融合保持各腿分数集合不变（先算后截）。

### 3.5 快照与指纹是两个文件、非原子提交【子审查·复现 + 自审读码确证】

- **位置**：`packages/retrieval-core/src/adapters/hnswlib.ts:374-390`（`persist` 先 rename 索引、再 `writeFileSync` 元数据）。
- **症状**：单文件原子、**成对不原子**。两个写者交错可留下 `(index_B, meta_A)`。`restore` 的校验是 `meta.n === rows.length && meta.fingerprint === fingerprintOf(rows)`——只把 meta 与**当前语料**比对，**没有任何东西把 meta 绑定到图文件**（自审读码确证），所以错配的一对**能通过校验**。
- **证据**：【子审查·复现】`topk` 返回已驱逐的 id 1（score 1.0）、`getCurrentCount()` 1000 vs `count()` 997。
- **严重度限定（自审补充）**：下游 `semanticPath` 用 `facts.activeIdsIn(...)` 过滤候选（`memory.ts` 对应实现），所以**不会返回不存在的行**；真实危害是"用陈旧图给仍存在的 id 排序"+ 计数不一致。仅崩溃中断是安全的（新图 + 旧 meta 必然在 `n` 或指纹上不符）。
- **修法**：把这一对做成**单一原子提交点**（两个文件都写成带 nonce 的临时名，最后一次 rename 才生效）。

### 3.6 墓碑计数是进程内的，但图跨进程持久化【子审查·复现】

- **位置**：`hnswlib.ts:92`（`tombstones` 进程内）、`:246-250`（`maybeCompact`）、`:344-362`（`restore`）。
- **症状**：restore 回来的图带着**此前所有会话**的死点（`DELETE_MARK` 被文件保留、`searchKnn` 会排除它们），但 `restore` 无法播种计数，`maybeCompact` 只比较**本会话**的删除量与 `max(256, 20% of live)`。
- **证据**：【子审查·复现】6 会话 × 100 次驱逐（每次都是新进程，正是 CLI 的常态：`packages/cli/src/index.ts` 每条命令一个进程并在 `finally` 里 shutdown→flush→persist）后，live 1200→600 而原生图仍有 1200 个元素（50% dead）；`stats().tombstones` 每次都只读到 100。**`compact()` 没有生产调用者**（只有测试与 `bench-vstore.mjs`）。
- **修法**：restore 成功后用 `lib.getIdsList().length - vectors.size` 播种计数（已核实 `getIdsList()` 含已删 label），或把待删数写进 sidecar；并给 `compact()` 一个维护入口。

### 3.7 `encodeAndStore` 的 `try` 范围被缩小，错误处理语义回归【子审查】

- **位置**：`packages/core/src/store/knowledge.ts:271-279`。
- **症状**：原为 `try { encode; vstore.add; setVector } catch {}`（**逐块尽力**）；现在只有 `await this.semantic.encode(...)` 在 `catch` 内，`vstore.add`(278) 与 `chunks.setVectors`(279) 裸露。
- **后果**：`ingest` 已提交文档并驱逐旧向量之后，一次 `SQLITE_BUSY`（`busy_timeout = 5000`，多进程争用正是本改动的前提）或 dim 抛错会让 `ingest` **reject**，其余 chunk 静默未编码；旧代码会 resolve 并继续。`reindex` 同理：一次 DB 错误中止整趟而非跳过一块。
- **修法**：把两步挪回 `try`（或显式记录并继续）。

---

## 4. 本报告已提出、实施时漏掉的

### 4.1 pending 集合仍无界增长【自审·复现】

- `PERFORMANCE_REVIEW.md` §4.8 提出、§10.2 第 3 项把它列为门槛（"语义后端不可用时连写 M 次后 `changed.size` 不增长（当前是 M）"），但**第 8 步的待办清单里没有它**，实现里也没改：`detect` 结尾只删除"**有向量**"的 id。
- **证据**：【自审·复现】无模型下 50 次写入 → `changed.size = 50`，且 **`contradict_check` 连跑两次都不排空**（仍 50）。即注释承诺的"later check can retry exactly those"从未发生，反而是**每次补扫都重处理整个累积积压**。
- **修法**：把"已做过结构检查且无向量"的 id 从队列移除（或加一个上界/淘汰），并补 §10.2 第 3 项那条门禁。

### 4.2 ⑤ purge 仍未纳入预算【自审·读码确证】

- ①②③④ 现在共享预算并报 `archived_deferred`，但 `purgeArchived` 的签名没有 `budget`，调用点也没传（`packages/core/src/lifecycle/tick.ts:72-77`）。
- purge 是**单行代价最高**的一步（老库上带 FK CASCADE 检查，见 `PERFORMANCE_REVIEW.md` §2 的性能陷阱），且运行在同一个 `IMMEDIATE` 事务里 ⇒ 大批积压仍可长时间持有写锁（§4.12 的 `SQLITE_BUSY` 场景）。
- **修法**：与 ②③④ 同形的 `fact_id IN (SELECT ... LIMIT n)` + 报 `purged_deferred`。

### 4.3 §10.2 第 4 项的验收标准未达成【子审查】

- §10.2 第 4 项要求"零 stale 的 `reindex` 不重建 vstore；`encodeBatch` 调用数 > 0"。实测：`encodeBatch` **生产路径零调用者**（`grep` 只命中 `interfaces.ts` 与测试 fake），且**零测试**（`local_bge.spec.ts` 里 batch 相关断言为 0）。实施者已按实测**否决**了批编码（55.7 vs 31.2 ms/块），所以这条标准事实上被放弃，但没有在文档里撤掉。
- **修法**：要么给它一个真实调用点与测试，要么删掉该方法并撤掉接口项，同时把 §10.2 第 4 项改成"不适用 + 理由"。

---

## 5. 元发现一：多处"守门"守不住

这是本轮最值得记录的一类问题——**断言存在，但无法失败**：

1. **空洞断言**（自审确证）：`packages/core/test/recall.spec.ts:116-117` 用 `'缓存失效策略'` 调 `candidateFactsForAnyEntity` 并断言 `length <= 7`；而 `'缓存失效策略'`**不是任何事实的实体名**（jieba 抽出的是 `失效`/`策略`）⇒ 返回 `[]`，断言恒成立。删掉 SQL 的 `LIMIT` 或把方法 stub 成 `[]` 都能通过。（同测试的 FTS 那半是真的会咬人的。）
2. **把缺口钉成期望**：`packages/core/test/eval_zh.spec.ts:90` 断言 2 字词 `缓存` 的检索结果 `toHaveLength(0)`。缺口因此被固定为"正确行为"——**将来修好它（加 LIKE/前缀回退）反而会让测试失败**。这是给下一个实施者埋的陷阱。
3. **评测集扩展没覆盖它要覆盖的形状**：新增 6 条查询里只有 **5** 条是 2 字（`数据库` 是 3 字），且这 5 条**全部走实体腿**（jieba 标为名词）⇒ 恰好是**本来就任务**的形状；真正坏掉的形状（FTS `null` + 实体为空）被排除在外。断言 `twoCharQueries.length >= 5` 以 0 余量通过。
4. **冻结基线不守护本次改动**：用新代码跑**旧的 29 条**，六项指标与改动前**逐字节相同**（小语料下 `legCap` 永不生效）。因此进度表把 `P@k 0.477→0.567、MRR 0.931→0.943` 归因于第 6 步是**误导**：6 条新查询全部通过，聚合值机械上升。同一行还写着"冻结基线在改动后逐字节不变"，与指标上升自相矛盾（真实含义应是"旧 29 条不变"）。
5. **契约文档过时**：`packages/retrieval-core/src/interfaces.ts:45-50` 仍写 hnswlib "每次删除重建整个索引"，而本轮已把它变成 O(k)。

---

## 6. 元发现二：收益在"模型可用"路径，守卫在"模型不可用"路径

`packages/core/vitest.config.ts` 关闭模型下载，所以 CI 里**所有向量/编码断言都跑在降级路径上**。直接后果：

- 本次改动的收益**全部**在模型可用路径；而守护它的测试在模型不可用路径 ⇒ 真实的编码/ANN/入库行为**在 CI 里没有断言**。
- `reindex` 的新写路径（跳过 `reloadIndex`）**套件根本没覆盖**，子审查只能用**注入式确定性语义后端**端到端验证（结论为 CLEAN，见 §7）。
- 真实 ONNX 编码数字（如 ingest 33.7 ms/块）在本环境无法复现。

**建议**：把"注入确定性语义后端验证向量写路径"固化成常规测试（子审查的探针就是这个形状），并在 §10.3 的守卫清单里点明这条不对称。

---

## 7. 已核对为 CLEAN（不必再怀疑）

**P0 修复（`supersedes_id` purge）**
- 谓词**只构造一次**并插入 unlink/delete 两条语句 ⇒ 选择集不可能漂移；两个分支（active-day / calendar）**互斥**；active-day 分支还顺手改成 sargable（`archived_clock < clock - days`），且语义与旧 `CASE` 严格等价。【自审·读码确证】
- 新库 DDL 去掉该 FK；老库**保留索引**并有明确理由（SQLite 无法 `ALTER TABLE` 去 FK，删索引会让 FK 检查退化）。【自审·读码确证】

**迁移与索引**
- 迁移 step 4/5 幂等（`IF NOT EXISTS` / `IF EXISTS`）且带版本号。【自审·读码确证】
- **表达式索引真的被用**：`countIdleCandidates` 与 tick ④ 的计划都是 `SEARCH facts USING COVERING INDEX idx_facts_idle_cutoff (status=? AND pinned=? AND <expr><? )`；`archiveForgotten` → `idx_facts_forget`；`bonusStatedToday` → `idx_facts_bonus_window (bonus_window_at>?)`。【自审·复现】
- `settleBudgeted` 的谓词确为 `idx_facts_trust` 上的 index seek ⇒ **印证了进度表对 §4.6 的自我更正**（成本在写不在读）。【自审·复现】

**tick 预算**
- ②③④ 共用预算、`archived_deferred` **只在真的耗尽预算时**才统计（`length === budget`）；`fact_id IN (SELECT ... LIMIT :budget)` 幂等且**不可能超过预算**（外层受内层 id 集约束）。【自审·读码确证】
- 已知小瑕（nit）：`countArchiveBacklog` 是三个谓词计数之**和**，同时满足两条谓词的行会被计两次，故 `archived_deferred` 可能大于真实待处理行数。

**诊断谓词重写**
- `bonusStatedToday` 的字符串比较（`bonus_window_at > datetime('now','-1 day')`）与旧 `julianday` 谓词在 1h / 23h / 24.5h / 25h / 48h 五个边界**完全等价**——前提是 `formatUtcTs` 输出 `YYYY-MM-DD HH:MM:SS`（UTC），与 `datetime()` 同格式。【自审·复现】

**矛盾检测 DAO**
- `suppressedPairsFor` 与原 `suppressedPairs` 在"只查该 fact 的配对"上等价（`maybeLog` 两侧必有一侧是 changed id 这一不变量成立）。【自审·读码确证】
- `resolveForFacts` 与逐 id `resolveForFact` 等价，含"两条边都在批内"的情形（靠 `resolved = 0` 保证只处理一次）；守门测试用**原始行**覆盖了两条分支并断言 loser 是离开语料的那条。【自审 + 子审查】
- `.changes` 求和与逐 id 版本在"两边都在批内"时不同，但 `retireConflicts` 的返回值在**两个调用点都被丢弃** ⇒ 无消费者。【自审·读码确证】

**hnswlib（单进程）**
- `vectors` 对 `count()`/`fetch()` 是权威，已删 id 先移出再 `markDelete` ⇒ `fetch` 不会返回已删向量；`topk` 不会返回已删 id；全删后 `count()` 0、`topk` `[]`；未知 id 的删除是 no-op。【子审查·复现】
- 压缩：只从 `vectors` 重建 ⇒ 不丢行、不复活；`tombstones.clear()` 只在原生构建成功后。**`efOn` 在每个替换点（`reindex`/`rebuild`/`restore`）都重置**——实测 compact 后 `ef` 回到默认、下一次查询恢复 256。【子审查·复现】
- 快照指纹覆盖 **id 集 + 每行 8 个抽样坐标**（升序），所以同 id 重编码会被拒绝；`reindex` 保留 id、换文本+向量的形状被专门测试钉住。路径名内嵌**向量空间** ⇒ 换模型/换宽不会误载。【子审查】
- `add` 对已在图中的 id 是**原地更新**：C++ 源码级确证（`hnswalg.h:1159-1175`：解除墓碑 → `updatePoint` → 返回同一内部 id；抛错分支由 `replace_deleted=false` 把关）⇒ `reindex` 免 reload 是安全的。【子审查·源码确证】

**语句缓存**
- 按 `SqliteDb` 实例、键为 SQL 文本、`close()` **先清后关**；无 DAO 把 statement 存进字段；`close()` 后使用是抛错而非 UB；**schema 变更后 SQLite 会自动重新 prepare**（实测 `ALTER TABLE` 后取到新列）；绑定错误不会被共享语句继承。【子审查·复现】
- nit：键空间随**数据**增长（实测 20 次 `add` 打开 17 个新键，15 个是同一条 `IN (?,…)` 的不同元数）；最坏 ≈ 19 个 IN 站点 × 500 ≈ 9.5k 条，无 LRU、无上限（仅 `close()` 清空）⇒ 长驻进程单调增长。注释低估了这一点。

**其它固定开销**
- **jieba 单次分词与 `HEAD` 差分测试**：24 个文本（否定 `不喜欢`、时态 `加入了`、拉丁、混排、空串、纯空白）下实体与三元组**逐字节相同**，0 处不一致；两个消费方都不改token 数组。【子审查·差分】
- `atom` memo：键 `${dim}\u0000${name}`（**含 dim**）、**字节预算 16 MiB + FIFO 增量淘汰**、共享数组只读；唯一生产消费者是 `encode.ts`/`algebra.ts`（都产出新数组）。【自审 + 子审查】【批次 5 更新：原为「上限 8192 条、溢出整表 `clear()`」——在 dim=1024 下那等于 64 MiB，且清空后下次查询要集中重算；同时把本行的字面 NUL 换成 `\u0000` 转义，此前那个字节让整份文档在 grep/git 眼里是二进制】
- **没有**实现零拷贝 Float32 视图（报告 §8 的建议未落地）⇒ 别名/对齐风险不适用；`vectors.ts` 的唯一改动是 `vectorCachePath`。【自审 + 子审查】
- `maxTokens == 0` 短路在三处（`router.ts`、`memory.ts:912`、`knowledge.ts:530`）与 `budget.ts` 的无预算分支**等价**（后者本就原样返回、不复制），`maxTokens > 0` 路径未动。【子审查·复现】
- 健康度计数：1 次 `kb_query` = **恰好一条** `kind:'cross'` 事件（两条腿 `recordStats:false`），知识库零结果会计数；`retrieval_budget.spec.ts` 断言精确值。【自审 + 子审查】

---

## 8. 建议修复顺序

| 顺序 | 项 | 类型 | 依据 |
|---|---|---|---|
| **1** | `reinforced_today` 恢复 `bonus_count > 0`；让 `memory.spec.ts:503` 重新有判别力 | 语义 | §3.1 |
| **2** | 实体腿按 `shared/union` 截断（或按 jaccard 过取再截） | 排名 | §3.2 |
| **3** | HRR 回退加 `ORDER BY`（或修正回退条件），并把可达性写进报告 | 排名 | §3.3 |
| **4** | `encodeAndStore` 把 `vstore.add`/`setVectors` 挪回 `try` | 错误处理 | §3.7 |
| **5** | 快照改为**单一原子提交点** | 正确性（多进程） | §3.5 |
| **6** | restore 时播种墓碑计数；给 `compact()` 一个生产入口 | 资源 | §3.6 |
| **7** | pending 集合有界化 + 补 §10.2 第 3 项门禁 | 资源/正确性 | §4.1 |
| **8** | purge 纳入预算并报 `purged_deferred` | 锁持有时间 | §4.2 |
| **9** | 截断对融合排名的影响：改为"先算分后截"或按融合分过取 | 排名 | §3.4 |
| **10** | 文档更正：进度表第 6 步的评测归因（P@k 上升是机械的）、§4.6 自更正搬进正文、`interfaces.ts:45-50` 过时描述、§10.2 第 4 项标注"不适用+理由" | 文档 | §5.2–5.5、§4.3 |
| 杂项 | `vectorCachePath` 净化有损/快照文件不清理/`:memory:` 潜伏；`limit` 三层统一用 `Number.isFinite`；`encodeGroup` 拿不到 `dims` 时回退逐条；`ATOM_CACHE` 溢出改淘汰；`countArchiveBacklog` 去重 | nit | §3、§7 |

---

## 9. 本次未验证 / 边界

1. **真实 ONNX 编码数字无法在本环境复现**（CI 与套件都禁用模型下载）；进度表里的 ingest 吞吐、批编码对比（55.7 vs 31.2 ms/块）**只有实施者的数字**，本轮未独立复现。
2. **多进程竞态是推理 + 受控复现**，不是线上观测：交错 rename 的顺序被手工构造，真实触发概率未测。
3. **合成语料与生产分布不同**：子审查用的合成实体分布放大了 §3.2 的现象（>200 条共享 ≥2 实体）；生产中触发频率未知。
4. **未复核**：`scripts/bench-*.mjs`（新增 4 个脚本）与 `bench-vstore.mjs` 的改动本身只做了可运行性检查，未审查其测量方法是否有偏。
5. **本文件与父报告 `docs/PERFORMANCE_REVIEW.md` 都未纳入 git**（`git status` 显示为未跟踪）。本仓此前已发生过"未跟踪文件的原文不可恢复"（一次测试文件被覆盖后只能凭描述重写），建议尽早提交。
