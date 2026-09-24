# `avantf-mem` 设计文档（v2.2 定稿）

> 一个 DSH 原生 Cordis 插件 + 可选 MCP 能力。**记忆（无用户隔离 + 共享单库）** 与 **文档知识库（类型/领域 → 来源两级分类）** 共用一套**内部可替换**的检索/重排底座，提供**跨记忆与文档的混合检索**，供 **agent 上下文**使用，并在 **会话视图标签条**（对话 / 轨迹 之后）提供「记忆」「知识」两个标签页。

---

## 1. 范围与定位

| 项 | 定稿 |
|---|---|
| 仓库 | `git@gitee.com:ffeng86/avantf-mem.git`（独立仓库） |
| 插件 id | `avantf-mem` |
| 交付形态 | **原生 Cordis 插件（默认）** + **保留 MCP 能力**（可选独立入口） |
| 技术 | TypeScript 原生实现（记忆 + 文档知识库 + 跨库检索） |
| 功能范围 | 一次性全面对等：记忆（5 向量库/混合重排/生命周期/矛盾/去重）+ 文档知识库 + 跨库检索 |
| 模型 | **Plan A**：检索本地，生成外部（插件只做检索 + 溯源） |

## 2. 关键领域决策

| # | 决策 | 落点 |
|---|---|---|
| D1 | 记忆**不做用户隔离** | 单一共享库 `~/.avantf/memory/memory.db`；移除 `user_hash` 分区 |
| D2 | KB **按类型/领域分，类型下分来源** | `domain(类型/领域) → source(来源) → chunk` 两级分类 |
| D3 | 跨库检索 | 记忆 + 文档同一次 query，**联合归一化**保证分数可比，`kind/domain/source` 过滤 |
| D4 | 答案生成 | **不做插件内生成**；召回上下文 + 溯源交 agent/UI 模型组织（`kb_answer` 为后置增强） |
| D5 | 文档来源 | 工作区文件（优先）/ 上传 / 粘贴 / 外部 URI |
| D6 | 检索/重排可替换 | **avantf-mem 内部**插件式（注册表+配置），**不是 DSH 插件、不注册 Cordis 服务**，业务流零感知 |

## 3. 数据目录布局（`data_home` 默认 `~/.avantf`）

**数据根怎么定**（⑤→④→②→默认，与「配置分层」同序）：⑤ 调用方的显式实参（CLI 的 `--data-home`、
`buildRuntime({ dataHome })`）→ ④ `$AVANTF_HOME` → ② 插件 profile 里的 `config.dataHome`（**配置值**，
所以环境变量压得过它）→ `~/.avantf`。两个插件的 profile `dataHome` 现在给同一个答案：mem 与 work 都把它
当配置层（work 早先把它塞进显式槽，等于把 ② 提到 ④ 之上，同一个 profile 在两边解析出不同目录，而
`<data home>/prompts` 是两边共享的）。**`configs/common.yaml` 里的 `dataHome` 不参与这一步**：那个文件
就在数据根**之内**，解析根的时候还没读到它，所以它对数据根无效（它是历史遗留的键，见 CHANGELOG）。

```
~/.avantf/                          # data_home（默认）
├─ configs/                         # 全部可编辑配置；缺失或空白时写入全注释默认（见 §10）
│  ├─ common.yaml                   #   公共层（②）
│  ├─ memory.yaml                   #   记忆库覆盖（③，缺失 = 不覆盖）
│  └─ knowledge.yaml                #   知识库覆盖（③，缺失 = 不覆盖）
├─ prompts/                         # 家族共享的用户可编辑系统提示词（前缀区分插件，见 §10）
│  ├─ mem-*.md                      #   记忆插件（@avantf/dsh-mem）
│  └─ work-*.md                     #   工作引擎（@avantf/dsh-work）
├─ memory/
│  └─ memory.db                     # 记忆库 + 记忆读模型(FTS/向量)
└─ knowledge/
   ├─ knowledge.db                  # 知识库 + 知识读模型(FTS/向量)
   └─ docs/                         # 受管文档（每篇一份可编辑 .md，见 §8）
      ├─ .git/                      # knowledge.git.mode=auto（默认）时自动建仓
      └─ <domain>/<source>/<title>.md
```

> **受管资源在族根，且没有 legacy 目录**：DSH 插件由家族底座 `@avantf/dsh-plugin-base` 的环境初始化框架预装，默认族根
> `~/.avantf/env`（`$AVANTF_HOME` 可覆盖），资源落在 `<home>/{runtime,tools,models}`。引擎的内建默认
> **直接指向族根**（`familyToolsDir()` / `familyModelsDir()`）：CLI、MCP、"框架装载失败"的降级路径与测试
> 解析的都是同一个目录，`~/.avantf/{tools,models}` **不再是任何回退**，因此也不需要兼容软链——那条软链
> 曾让 `mkdir -p` 在目标缺失时抛 ENOTDIR，并把"这台机器恰好建过链"变成隐式前提。

**受管文档目录同时是一个 git 仓库**（`knowledge.git`，`mode` 默认 `auto`）：写入路径（`ingest` / 重新摄入 / `remove` / `import`）每完成一次就提交一次，message 形如 `ingest: <domain>/<source>/<title>`。选在这个目录上仓是因为它正好是"内容"这一层——每篇文档一个文件、正文逐字节照存，而 `knowledge.db` 是从它派生的索引，**刻意不入库**（否则每次写入都是二进制大对象的变更）。三条边界：**插件永不添加 remote、永不 push**（远程与推送是用户的事）；提交失败**绝不影响**摄入结果（与 `IngestResult.file_error` 同一条原则，只记一行 warn）；**每次自动提交都带一行 `Automatic: avantf-mem` trailer**，所以 `git log --grep` 就能把机器提交与你自己提交分开；作者优先用机器上**已有的**身份（仓库是你的、你也会在里面手动提交，默认把机器上的提交记成机器人反而是另一种意外），只有机器**完全没有** `user.email` 时才退到**仓库本地的**机器人身份（`avantf-mem <avantf-mem@localhost>`）——那是为了让提交能发生，且**绝不写你的全局 git 配置**。

  git 操作抽成**与具体 store 无关的复用库** `packages/core/src/git.ts` 的 `GitRepo({ root, mode, ignore, identity, logger })`：知识库只是它的第一个使用方（`root` 默认取 `knowledge.docs.dir`）。`root` 可配置正是为了"共享一整个 store"——把它指向 `~/.avantf/knowledge` 甚至 `~/.avantf`，再用 `ignore`（默认已含 `*.db` / `*.db-wal` / `*.db-shm`）把数据库挡在历史之外；`ignore` 只在**建仓时**写入 `.gitignore`，绝不覆盖用户自己写的那份。API 只有 `init` / `commit` / `history` / `branch` / `enabled`，全部不抛错。
  **共享能力的前提是文本表示**：知识库有（`docs/**/*.md`，`kb import <目录>` 就能在新机器上重建）；**记忆库没有** —— `~/.avantf/memory/` 下只有 `memory.db`（+ WAL/SHM），事实只存在于 SQLite 里，提交它等于每次写入都产生一个二进制大对象的变更（不可 diff、不可合并）。要让记忆库可共享，先得有类似受管文档副本那样的**文本导出**（每条事实一行、带 id/时间/来源），那是另一件事，尚未实现。

配置分层（低→高覆盖）：①内建默认 → ②`.avantf/configs/common.yaml`（公共）→ ③`.avantf/configs/*.yaml`（分库覆盖）→ ④环境变量 → ⑤CLI/调用方的显式实参（`--data-home`、`buildRuntime` 的 `dataHome`）。插件 profile 里的 `config.dataHome` 算**配置值**（②），所以 `$AVANTF_HOME` 压得过它 —— 数据根的完整次序见 §3 开头。

- YAML 键名与 zod schema 一致（`semantic`/`rerank`/`vectorStore`/`retriever`/`lifecycle`/`tools`，`vectorStore` 为 camelCase）；段内做一级深合并。
- ④环境变量：`AVANTF_HOME`、`AVANTF_MEM_DB`、`AVANTF_KNOWLEDGE_DB`、`AVANTF_MEM_MODEL_MIRROR`（或 `HF_ENDPOINT`）、`AVANTF_MEM_MODEL_CACHE`、`AVANTF_MEM_AUTO_DOWNLOAD`（`0/false` 禁用一切下载——模型与外部二进制，测试与离线环境用；作为全局 kill-switch 同时作用于适配器构造与 provision 的每个安装路径，优先于显式传参）、`AVANTF_TOOLS_DIR`（受管工具目录覆盖）、`AVANTF_PANDOC`（显式指定 pandoc 可执行文件，优先于受管目录与 PATH）。

- 公共配置放**共享**项（`semantic`/`rerank`/`vectorStore`/`retriever.weight_*`/`lifecycle`/`trust` 默认，以及 `tools`）——记忆与知识共用同一检索底座与嵌入模型，保证跨库分数可比；`tools`（`dir`/`mirror`/`auto_install`）之所以在**公共**层而不是知识库专属，是因为它管的是"这个进程要装的外部东西"（pandoc 二进制与启动预热的嵌入模型），两者共用同一套机制。
- 分库配置放**各自**项（`db.path`、`knowledge.domains/chunk_size/chunk_overlap/source_priority`、`knowledge.ingest.*`——摄入边界属知识库专用，见 §8）。`memory.category_values` 曾在这里，但没有任何生产代码读它（改它不改变行为、设它也不改变行为），已删除；分类词表的**建议值**改由 `CATEGORY_VALUES` 在 `mem_remember` 的字段描述里对模型讲清，而不是假装是一个配置项。
- **`db.path` 解析规则**：`~/` 展开为**用户 home**（与 `dataHome` 同规则）、绝对路径原样使用；留空则回落到数据目录下的 `memory/memory.db`、`knowledge/knowledge.db`（此时 `AVANTF_MEM_DB`/`AVANTF_KNOWLEDGE_DB` 仍可作为环境层覆盖）。`knowledge.docs.dir` 同规则，留空 = `<data_home>/knowledge/docs`（`AVANTF_KNOWLEDGE_DOCS` 可覆盖）。
- **`knowledge.domains` 是写入侧领域清单**（DESIGN §8）：默认 `['design','api','ops','research','notes']`；显式 `[]` = 不限制；非空时还接受 `documents` 里已有的领域。清单外的**新**领域由 store 拒绝，所以"同一个领域两个名字"不能靠随手输入产生——新增领域是改这一项配置的事。

## 4. 总体架构

```
┌────────────────────────────── DSH ──────────────────────────────┐
│ client(浏览器)                          host(Node)               │
│ @avantf/dsh-mem/src/client               @avantf/dsh-mem/src     │
│ 标签页:记忆 / 知识  ◄─host.call─  harness.handle(rpc)           │
│        │                                    memory Service       │
│        └────只传叶子字段───────────────────────├─ 3 个记忆工具(mem_remember/mem_recall/mem_admin)
│                                              ├─ KB 工具(kb_add/kb_list/…)
│                                              └─ 跨库工具(kb_query)
└─────────────────────────────────────────────────┬──────────────┘
                                                   ▼
                    @avantf/mem (core 引擎)  ← 依赖 → @avantf/mem-core (retrieval-core)
         memory.store   knowledge.store   ingestion   lifecycle   cross-router
                            │                          │
                            ▼                          ▼
          @avantf/mem-core：SemanticBackend·Reranker·VectorStore
             (内部可替换注册表 + 配置解析 + 降级 + auto升级) + 三路融合
```

## 5. `retrieval-core`（内部可替换检索/重排底座）

**核心原则**：插拔机制完全收在 `avantf-mem` 库内；**不落成 DSH 插件、不注册 Cordis 服务**；业务流面向稳定接口编程，永不感知具体后端。

```ts
interface SemanticBackend { encode(t): Float32Array; encodeBatch(ts): Float32Array[]; isAvailable(): boolean; dim: number }
interface Reranker        { rerank(q, cands): number[] }
interface VectorStore     { add(id,vec); topk(vec,k): {id,score}[]; fetch(ids); remove(id); rebuild() }
```

- **注册表 + 工厂**（默认适配器内置；可选注册新适配器）：`semanticRegistry{local_bge}`、`rerankRegistry{bge_reranker, none}`、`vstoreRegistry{local_numpy, hnswlib, faiss, pgvector, qdrant}` + `auto`。
- **解析器**（*唯一*知道具体实现的地方）：按 `config.<backend>` 取注册实现；`isAvailable()===false` → 降级（`local_numpy`/`none`/降级权重）；向量库 `auto` 在数量越过 `auto_thresholds.hnswlib` 时**单调升级** `local_numpy → hnswlib`（native 绑定不可用则留在 numpy 并告警）。`faiss/pgvector/qdrant` 目前是**显式告警的适配面**（解析到 numpy）。
- **重排的唯一开关是 `rerank.backend`**：runtime 经 `resolveReranker` 注入两个 store，检索流程只依赖 `Reranker` 接口（`none` = 跳过重排、不加载模型）。语义后端只负责嵌入，重排器加载失败不拖垮语义路径。
- **切换** = 只改 `.avantf/configs/common.yaml` 的 `*.backend`。
- **测试/嵌入方的注入口**：`buildRuntime({ semantic })` 可直接注入一个 `SemanticBackend`（跨库检索一次编码的测试就用它）。这是接缝、不是第二条插拔路径——`dim` 必须等于 `config.semantic.dim`，否则 `buildRuntime` 在打开数据库之前就报错（store 的向量库是按该 dim 建的）；同理，调用方传入的 `queryVector` 长度不符时 store 直接报错，而不是拿错位向量去打分。
- **业务流零感知**：融合流水线、store、工具、路由器、UI 全部只依赖接口。

## 6. 数据模型

```sql
-- 记忆（共享单库；无 user 分区；保持原记忆系统语义）
facts(fact_id, content UNIQUE, category, tags, trust_score, settle_clock, pinned,
      pinned_at, bonus_count, bonus_window_at, last_reinforced_at, archived_clock,
      retrieval_count, helpful_count, last_retrieved_at, hrr_vector, semantic_vector,
      embedding_model, vector_store, status, supersedes_id, archived_at, archive_reason,
      ttl_days, mirror_source, mirror_target, created_at, updated_at)
entities / fact_entities
triples(subj,pred,obj,confidence,source, UNIQUE(fact_id,subj,pred,obj))
contradiction_log(fact_a,fact_b,score,detected_at,resolved,loser_fact_id,resolution,resolved_at)
avantf_stats / eval_results
+ facts_fts(FTS5 trigram) + 记忆 vstore + HRR 向量

-- 知识库（两级分类）
documents(doc_id PK, domain, source, title, source_uri, meta, status,
          created_at, updated_at, UNIQUE(domain,source,title))
doc_chunks(chunk_id PK, doc_id→documents, idx, text, headings_path,
           source_ref, char_start, char_end)
+ doc_chunks_fts(FTS5 trigram) + 知识 vstore
```

- `source_ref`：记忆 `memory:fact:<id>`、文档块 `domain:source:doc_id:idx`。
- **无版本化迁移**：DDL 幂等（`IF NOT EXISTS`），每次打开都执行；这是全新项目、不存在旧库，改 schema 即**重建 DB 文件**（删除 `~/.avantf` 下对应库后重启即可）。
- **信任与遗忘**（自然消退 / 召回加强 / 永久记忆）**已实现**：完整规格见 [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md)，概要与运维见本文 §18。

## 7. 跨库检索（联合融合）

```
query(kind?/domain?/source?)
 ├─ ① memory.retriever：三路(语义/FTS bm25/实体)各自按该腿最大值缩放 → 加权融合 → top-cand(mem)
 ├─ ② knowledge.retriever：同构三路融合 → top-cand(know)
 └─ router 合并两库候选池 → 在合并池上对融合分数做联合 min-max → 统一排序
     → top-k（不改动两库原始结果对象），标注 kind/domain/source/source_ref/score
```

- **分数可比**（§20.17 口径）：两库结果**合并后在合并池上 min-max 归一化**，保证跨库分数同刻度；库内三路融合各自先做路径级归一化（自 §20.17 起是"按该腿最大值缩放"，不是 min-max）。
- **查询只编码一次**：两条腿共用同一个嵌入后端与模型（§3 公共配置），因此 `runtime.query` 先把 query 编码成向量、再把同一个向量传给两条腿（`queryVector`），而不是各腿各自 `encode` 一遍。实测跨库查询 7.57ms → 5.29ms（单次编码 3.7–4.3ms，其余为融合/reinforce 固定开销）。注意**重排仍按腿进行**：`rerank` 属于各 store 的检索流程（§5），所以启用 `bge_reranker` 时一次跨库查询会跑两遍 cross-encoder 前向——这是既定形状（§7 的 ①/② 各自成链路），默认 `rerank.backend: none` 下无代价。
- **过滤**：`kind`（仅记忆/仅文档/全量）、`domain`（仅知识库维度；设置后记忆命中自然被过滤）、`source`（仅文档切片，读命中自带的 `domain`/`source` 字段——由拥有 `documents` 行的 store 填充，因此 domain/source 名里含 `:` 也不会错位；**不要**再从 `source_ref` 解析）；默认按分数自然混合。`quota` 配额未实现（后置）。
- **检索统计只记"真正返回的"**：`kb_query` 为融合做的超额召回不写检索统计，router 过滤后只给最终返回的 fact 记 `retrieval_count`/`last_retrieved_at`（否则会凭空刷新 dormancy 时钟，破坏 `lifecycle.archive_after_days` 归档）。
- **共享底座 = 一套代码 + 联合路由器**，非单一物理索引（贴合两库分离布局）。
- **命中的时间字段**（时间对记忆是信息，不只是元数据）：每条 `RecallHit` 都带 `created_at` 与 `updated_at`，模型在 `mem_recall`/`kb_query` 的返回里直接看得到。记忆命中取 `facts` 行：`created_at` 是**这条记忆第一次被记下**的时间（`update` 时由新行继承旧行的值，见 §11），`updated_at` 是**这一行最后一次被改动**的时间（编辑/pin/强化/归档/restore 写它；**检索与每日结算刻意不写**——所以它从不用来表示"最近被查到"，那是 `last_retrieved_at` 的事，且不外露）。文档命中取所属 `documents` 行的同名两列（`doc_chunks` 没有自己的时钟，重新摄入会替换切片并推进 `documents.updated_at`）。**两个 store 的命中映射都必须填这两个字段**，类型上不做 kind 条件字段——合并结果里任一命中缺时间就是 bug。两个时间计入输出预算（`fitToTokenBudget` 照常参与），不为它改预算口径。
- **非语义腿各自带候选上限（性能审查第 6 步）**：融合只保留 `overFetch`（`limit × over_fetch_factor`）条，所以一条腿返回"整个命中语料"只会让 `fuse` 去归一化并排序整份语料——实测常见词在 33k 语料下 FTS 腿命中全库 33000 行、实体腿 6600 行。现在 FTS 腿按 `bm25` 排序后 `LIMIT max(200, 4×overFetch)`，实体腿按**精确 Jaccard 比率**在 SQL 里预排序后同样截断（旧稿写作"共享实体数"，即 Jaccard 分子——实测该排序量会把 3/10=0.30 排在 2/2=0.67 前面并把它挤出 cap，已改为在 SQL 里算 `shared / (|q| + |f| - shared)`，幸存者再在 JS 里用同一公式复核），知识库侧同形。**上限只约束"跨进 JS 的行"**：FTS5 仍要为每个命中的行算 bm25（`ORDER BY rank` 无法跳过打分），所以它能去掉的是归一化/排序/取文本那一段（33k 行那次 search 203 → 140 ms），不是 FTS 内部的匹配代价——真实查询的命中面比这个合成语料小得多，但这一点必须写清楚，别指望上限能解决一切。`fuse` 保持"全池排序"：池子被上限约束后它已经是几百条量级，改 partial top-k 收益可忽略而不变量更多。**上限对按自身分数序交出条目的腿是分数透明的**（§20.17：归一化改为按该腿最大值缩放，`fusion.spec.ts` 的 cap 差分测试逐位钉住 id 与分数），**但 HRR probe 腿不是**——它按 Jaccard 比率（另一条腿的分数）或 recency 取候选，都不是它自己打的分，cap 可能删掉它自己的最高分（复核 N5）。因此**不要**把不同 cap/`over_fetch_factor` 下的分数当作可比；要真正无条件消除它得改成"库级联合归一化"，本轮不做。
- **HRR probe 腿同样先裁剪**：它原先对**每个** active 事实解码 8 KB 向量并跑 1024 次 `cos`（33k 时实测 1.37 s/次）。现在只对"与查询共享实体"的候选打分——HRR bundle 的原子就是实体名，所以这一步去掉的是 O(N) 而不是有意义的排序信息；抽实体这一步现在一次查询只做一次，jaccard 与 HRR 两条腿共用同一份候选集（probe 以前每查询抽两遍、读两遍）。
- **裁剪必须按该腿真正的分数排序（实施复核 §3.2/§3.3 的修复）**：实体腿第一版按"共享实体个数"截断，而它打的是 `shared / union` —— 实测 cap=1 时保留 shared=3/union=10（0.30）而丢掉 shared=2/union=2（0.67）。现在两条 DAO 都按**精确 Jaccard** 排序（`union = |q| + |f| − shared`，每个候选一次索引内 COUNT；33k 全命中该实体的极端情况下 26.7 ms vs 只按 shared 的 13.6 ms，仍有界）。**HRR 回退**则改成"取最近 `cap` 条"（`ORDER BY created_at DESC`，用 `idx_facts_created`）——原来是一个**没有 ORDER BY 的任意切片**，33k 语料下 3.28 万条永远 probe 不到，且调用方无法说明自己评了哪些；现在确定性、有语义、并**每次进程只告警一次**说明被截断。可达性上限本身是刻意保留的成本取舍（全量 = 1.37 s/次），已写进报告 §4.5。

## 8. 摄入管线（文档知识库）

- 入口：`kb_ingest(source_uri|text, domain, source)`、`kb_import`(批量)。来源：工作区路径（优先）/上传/粘贴/外部 URI；`source_uri` 会被**解析读取**（本地文件路径或 http(s) fetch），绝不把 URI 字符串当正文入库。
- **共享入口 `KnowledgeStore.ingestRequest(req, mode)`：① plan → ② classify → ③ 各自流程**。三种入参（`text` / `source_uri` / `paths`）都先过同一段 plan：校验 `domain` 允许清单、确认三者之一、用 store 里**唯一的分类器 `classifySource`** 判定 text / URL / 本地文件 / 目录，并按身份规则算出每个目标（text → `deriveDocTitle(text)`；URL → URL 字符串；本地文件 → `realpath` 的 basename；目录 → 逐个被收下文件的 basename，绝不用目录名；`paths` 的优先级高于 `text`，`text` 高于 `source_uri`）再查 `documents` 的 `(domain, source, title)` 唯一索引。**plan 不读文件内容、不发网络请求**（只需要 `stat`/`realpath`/`readdir`，以及调用方已经拿在手里的 `text`），所以冲突在读取/抓取之前就已知——一条冲突的 `source_uri` 即便指向不可达的 loopback URL、或指向一个读取时会被拒的二进制文件，答案也是冲突而不是抓取/解码错误（测试与 mount smoke 都按这条可观察断言钉住）。③ 再按 kind 派发到 `ingest` / `ingestUri` / `importPaths`（`sync` 的 stale 重新摄入与 `adopt` 认领后重新摄入仍直接走 `ingest`），这三处的**替换语义不变**。判定"是什么"从此只有一处：`ingestUri` 也调用 `classifySource`，不再自带 `^https?://` 分支。
- **两个模式，共用一个入口**：`rt.kb`（界面「入库」与 CLI）是 **replace** 模式——命中已存在身份时返回结构化冲突清单（`conflict:true` + `conflicts[{doc_id,title,path}]` + `would_overwrite`/`would_add`）且**什么都不写**，只有调用方带 `overwrite: true` 重跑才替换；`rt.kbAdd`（模型面 `kb_add` 走它）是 **add** 模式——单篇命中就抛可行动的中文错误（已有 `doc_id`、标题、受管文件绝对路径，两条出路：换标题另存 / 改那份 `.md` 后索引自动跟随），**永不替换**。`paths` 批量在 add 模式下**不是全有全无**：已存在的逐条进 `ImportResult.failed`（带同样可行动的原因），其余照常导入——100 个文件不会因为 1 个已存在而整体失败；replace 模式下则是**全有全无**：只要有冲突就先弹二次确认、一条都不写，确认后整体重跑（部分写入 + 弹窗是说不清的状态）。因此 `kb_add` 三种入参（text / source_uri / paths）都是只新增，界面则"冲突绝不静默覆盖、但确认后 URL 可重新抓取、目录可重新导入"。**`overwrite` 只加在 `KbUnion`（内部引擎 API：界面远端面与 CLI 走它），绝不进 `KB_ADD_TOOL.input`**——8 个模型可见工具的 schema 一个字段都不多，"只新增"是引擎 API 层面的模式，不是模型能翻的开关。
- **缺省标题从正文推导**（`deriveDocTitle`：优先第一个 Markdown ATX 标题并跳过围栏代码块，否则首个非空行去掉 `#`/`>`/`-`/`*`/`+`/`1.`/`1)` 行首标记，截断到与文件名同一条 `MAX_SEGMENT`，全空白兜底 `untitled`），不再回退到 `source`——`source` 缺省是同一个 `default`，曾让同一领域的所有无标题粘贴塌成同一身份并静默互相覆盖。**替换语义保留在 store 的 `ingest`**：`ingestUri` / `importPaths` / `sync` 的 stale 重新摄入 / `adopt` 认领后重新摄入都走它，语义不变。
- **分类写入身份与 `domain` 清单**：`source` 可省略，契约默认 `default`，`IngestResult`/frontmatter/身份 `(domain, source, title)` 与受管路径 `<domain>/<source>/<title>.md` 一律用**解析后**的值（省略 source 不会落出一个空目录段）。`domain` 受 `knowledge.domains` 约束：默认一小组通用领域（`design`/`api`/`ops`/`research`/`notes`，见 §3），**显式空数组 `[]` = 不限制**；非空时允许值 = 配置清单 ∪ `documents` 表里已有的领域（收窄清单不能让历史文档再也无法重摄入），清单外的**新**领域被拒绝并列出全部允许值。校验落在 store（`KnowledgeStore.ingest` / `importPaths` / `ingestUri`，它们持有 `config.knowledge`）而不是工具层，所以 agent 工具、CLI、MCP 与界面走的是同一条闸门；界面只是把清单 ∪ 库内已有领域渲染成下拉，不承担守卫职责。允许集合在 store 里是**可变内存集合**（启动时由「配置清单 ∪ 库内已有领域」播种），界面「+」（`kbAddDomain`）新增时同步写入 store 配置并加入该集合，所以新增领域当次会话即可用。`source` 的缺省也落在 store（`ingest`/`ingestUri`/`importPaths` 的 `source = DEFAULT_KB_SOURCE`）：缺省属于身份规则，绕过契约直调 `rt.kb`/store 的调用者不会产出 `domain/undefined/title` 这种身份。
- 处理：load → 分块（**段落+Markdown 标题感知**，`chunk_size/overlap` 可配，char 偏移忠实于原文，`headings_path` 落库；硬切分块之间恰好共享 `overlap` 个字符，不叠加）→ **实体在摄入期抽取**并写 `chunk_entities`（检索期零重扫）→ 逐块 encode → 写 `doc_chunks` + 知识读模型。
- **摄入边界（体量）**：`text` 上限 20M 字符；`source_uri` 本地文件先 `stat` 校验字节上限、http(s) 按流式字节上限读取并带 30s 超时，避免先整份读进内存再校验；`kb_import` 的每个文件走同一条 `stat`（普通文件 + 字节上限）。**只读普通文件**：FIFO/socket/设备等非普通文件直接拒绝——同步 `readFileSync` 读一个 FIFO 会永久阻塞，卡死的是整个宿主事件循环，而不是这一次工具调用。
- **摄入边界（可达范围）**：`source_uri`/`kb_import` 的路径会被**读取**，读到的内容进索引后又能被 `kb_query` 检索回上下文——不加限制就是一个「读任意文件 / 探内网」的原语（间接提示注入）。因此默认收紧、按资源种类各留一个显式开关（配置在 `~/.avantf/configs/knowledge.yaml`）：
  - 本地路径必须落在允许根内（`knowledge.ingest.local_roots`，留空 = 进程工作区即 cwd），比较前先 `realpath`，`..` 与符号链接都逃不出去；`allow_outside_workspace: true` 整体放开。
  - `http(s)` 默认拒绝 loopback/私网/链路本地（含 `localhost`、`*.local`、`*.internal`、`169.254.169.254`、CGNAT 等；`new URL()` 会把 `http://2130706433/`、`[::ffff:127.0.0.1]` 等写法规范化后再判），`allow_private_network: true` 放开。**重定向逐跳复检**（手动跟随，上限 5 跳）——交给传输层自动跟随会被一个公网 URL 直接弹进 `127.0.0.1`。
  - 已知范围外：域名**解析结果**为私网（DNS rebinding）不在防护内（undici 未暴露 resolve-then-pin 钩子）；字面量写法已全部覆盖。
  - **选择器（知识页「选择」）走的是同一组限制**：`browseDirectory` 用 `resolveLocalSource`，所以它列不出来的目录，摄入也读不了（反之亦然，二者不会各说一套）。
    默认只允许 `local_roots`（空 ⇒ 进程 cwd）——注意 GUI 场景下 cwd 是 **DSH profile 目录**（`dsh web` 从那里启动），于是默认等于"只能摄入 profile 里的文件"；
    `allow_outside_workspace: true` 时选择器**从家目录起步**（而不是那个 cwd），并在标题里如实写"不限制范围"，而不是显示一条它并不遵守的边界。
- 摄入/重建索引为**等待完成语义**：调用返回时 FTS/实体/向量索引均已就绪（向量编码 best-effort，模型不可用时可稍后 `kb_reindex`）。
- **分批调用模型：实测否决（性能审查第 7 步）**。审查建议"把逐块 encode 改成 `encodeBatch`"，照做之后**入库慢了 1.79×**。原因是批前向会把批内每一项 **padding 到该批最长的那条**，而真实块长跨度 53–550 字符（中位 303）：对 299 个真实块实测 **串行 31.2 ms/块、按文档顺序分批 55.7 ms/块、按长度排序后分批 31.9 ms/块**。所以知识库摄入**保持逐条 encode**；`LocalBgeBackend.encodeBatch` 仍然正确（且内部按长度排序，保证"不劣于串行"，短文本 100 字符时 9.96 → 6.71 ms 仍有收益），只是不再被摄入路径使用。**这是本仓第二处"经实测被否决的直觉方案"**（第一处是 partial 索引修冲突查找），两处都在 `scripts/bench-*.mjs` 里留有可复跑的反例。
- **真正省下时间的是写侧与重建侧**（同一轮）：向量按 16 条一个事务写入（自动提交 14.2 µs/行 vs 事务内 2.2 µs/行），事务绝不跨 `await`；`kb_reindex` 不再在收尾 `reloadIndex()`——刚编码出的向量当场 `vstore.add`，而全量重载会重读每个 BLOB 并重建索引。实测（7841 块、零 stale）：**reindex 1756 → 236 ms**；同一语料 `kb ingest` 37.4 → **35.1 ms/块**（控制变量：同一份 299 块语料 37.4 → 35.1、4499 块 33.7 → 31.5）。
- **逐块尽力语义要覆盖"写"而不只是"编码"（实施复核 §3.7 的修复）**：向量写入被移出 `try` 之后，一次 `SQLITE_BUSY`（多进程争用正是本改动的场景）会让 `kb_ingest` 在文档已提交、旧向量已驱逐之后**整条 reject**，其余块静默未编码。现在 `vstore.add`/`setVectors` 与编码同在一个**每块**边界内，失败计入一次可见的告警计数；机器可读信号仍是 reindex 的 `vectors_stale > vectors_encoded`。
- **格式管线（字节 → 正文）**：读到的是**字节**，**先过转换器注册表**（`@avantf/mem-convert`，一个不依赖 core/contract 的独立包），再按魔数判定怎么变成正文（`store/document_text.ts`）。注册表按**注册顺序 = 具体优先**取第一个认领者，认领者转换失败就**明确报错**（带转换器 id）而不产出垃圾；没有认领者才走下面的文本/PDF/二进制路径。**转换必须发生在二进制拒绝之前** —— docx/xlsx 都是 ZIP，先判魔数会把它们当"已知二进制"直接拒掉。已支持：**pandoc 能读的全部格式**（`.docx/.docm/.odt/.epub/.html/.htm/.xhtml/.tex/.rst/.ipynb/.csv/.tsv/.org/.rtf/.fb2/.opml/.bib/.docbook/.man/.typ`，表在 `converters/pandoc.ts` 的 `PANDOC_READERS`，一个包装器按 `--from=<reader>` 认领一批格式），以及 `.xlsx`（内置 `exceljs`——pandoc 没有电子表格 reader，所以这一条留在本包：每个 sheet 一个小节 + GFM 表；超 2000 行/64 列的截断进 `warnings`）。**pandoc 优先且是前提**（用户决策）：同一个 `.docx` 在每台机器上产出同一份 Markdown，`converter` 字段因此是**版本限定**的（`pandoc-3.11`），跨机器的语料差异可见。pandoc 由家族底座 `@avantf/dsh-plugin-base` 的环境初始化框架装到族根 `<home>/tools/pandoc/<版本>/`（`<home>` 默认 `~/.avantf/env`；版本钉死在代码里；国内镜像模板优先、官方源兜底；下载→sha256 校验→解压→**原子 rename**；缺了就明确报错并给三平台安装命令，绝不静默降级）。**明确不做**（每一项都只差一个 `MarkdownConverter`，管线不改）：PDF（保持下面的 `unpdf` 文本层）、旧版 OLE `.doc/.xls/.ppt`（只有 LibreOffice 能读，而 LibreOffice **只探测、不自动安装**，被认领后按名报错）、`.pptx`、图片/OCR。**ZIP 的区分靠中央目录条目名**：docx/xlsx/pptx/epub 魔数相同，只有条目名（`word/document.xml` / `xl/workbook.xml` / `ppt/presentation.xml` / `mimetype=application/epub+zip`）能分开；扩展名**只作提示**（显式给出的文件可以不带正确扩展名），本包内实现了一个 ~60 行的 EOCD+中央目录读取器，不新增 zip 依赖。转换产物是 `{markdown, converter, warnings, title?}`：`IngestResult.converter` 回报哪条转换器产的、`warnings` 透出没能带过来的内容（图片、公式、被截断的表格），受管副本 frontmatter 增加 `converter` 字段。然后才按魔数走既有三条路：① `%PDF-` → 用 `unpdf`（自带 pdfjs 构建，2.1MB、无需外部 CMaps 资源）抽取文本层；抽完对 **康熙部首/兼容区**（U+2E80–2EFF、U+2F00–2FDF、U+F900–FAFF）做定向 NFKC 归一化 —— 有些中文 PDF 会把「网站」报成「⽹站」，不归一化就搜不到；只归一化这三个区段，全角标点（，。！？）原样保留。② 已知二进制魔数（zip/Office、PNG/JPEG/GIF/BMP、RIFF、gzip/7z/RAR、OLE、ELF、wasm、SQLite、音频、字体、PostScript）或前 8KB 含 NUL → **拒绝**并在错误里报出检测到的类型（**不是 pandoc/xlsx 认领的 ZIP 仍然走这里**，比如普通 zip、pptx）。③ 其余按**文本**解码，顺序是 **BOM → 严格 UTF-8 → 严格 GB18030**：UTF-8/UTF-16 由 BOM 认（BOM 必须先于 NUL 嗅探，否则 UTF-16 文本会被误判成二进制）；不是合法 UTF-8 的按 GB18030 解（GBK 的超集，中文 .txt 常见）——**用了哪种编码会随摄入结果回报**（`IngestResult.encoding`），猜错可见而不是隐形。只有两种解码都失败（如 `0xFF`、截断的多字节尾巴）才报错。④ PDF 抽不到文本层（扫描件/图片型）→ **报错**，绝不入库空文档。历史教训：这三类以前都是**静默**变成垃圾切片（`readFileSync(…,'utf8')` 直接当正文），`kb_query` 还会把 PDF 语法碎片当命中返回。
- **依赖获取先归家族底座 `@avantf/dsh-plugin-base` 的环境初始化框架，legacy 路径才归 `@avantf/mem-provision`（§12.1、[docs/PROVISIONING.md](docs/PROVISIONING.md)）**：DSH 宿主里，**真正的外部制品**——pandoc 二进制与嵌入模型缓存——作为 item 声明给底座，由它 `探测 → 获取 → 校验 → 落盘 → 报告`（兼容门禁**不再是 item**：门禁就是底座本身，见 §12.1）；底座装载失败、以及 CLI/MCP 这两条没有 DSH 宿主的路径，才走 `@avantf/mem-provision` 的 artifact 注册表。artifact 机制的形状与转换器注册表同构（`Artifact{id,version,isPresent,install,verify}` + `registerArtifact`/`ensure`/`ensureAll`），因为两件事同形：一组各自知道怎么认领自己输入的东西，注册起来，由一个函数统一到达。探测优先级固定：① 配置/环境显式指定 → ② 受管目录 `<tools.dir>/<tool>/<version>/bin/<binary>` → ③ `PATH` 上的系统安装（win32 按 `PATHEXT` 探测，与 `open.ts` 探编辑器同一套） → ④ 都没有就**明确报错**（附各平台安装命令）。插件挂载点在 legacy 路径上做**一次**非阻塞 sweep（`provisionToolchainAsync`），每个 artifact 一行结果；用到的那一刻（`ensurePandoc`）再 `ensure` 一次，缺了就是明确错误而不是静默降级。**npm 依赖归 pnpm / 框架，不归这个模块。**
- **`import` 的跳过是可见的**：目录遍历只收一份**精选白名单** `.md/.markdown/.txt/.json/.jsonl/.yaml/.yml/.pdf/.docx/.docm/.odt/.epub/.html/.htm/.xhtml/.tex/.rst/.ipynb/.csv/.tsv/.org/.rtf/.xlsx`（不跟随符号链接），其余文件进 `skipped`（前 20 个）+ `skipped_total`；**显式给出的文件路径不看扩展名**（`import ./x.csv` 照收），被拒绝的二进制进 `failed` 而不是 `skipped`。白名单是单一真源（`store/source_picker.ts` 的 `INGESTABLE`，`knowledge.ts` 导入它）。
- 管理：`kb_list_docs(domain?,source?)`、`kb_doc_detail`、`kb_remove_doc`、`kb_reindex`、`kb_sync`。
- **受管文档副本（知识维护的落点）**：每篇文档在 `knowledge.docs.dir`（默认 `<data_home>/knowledge/docs`）下有一份可编辑的 `.md`，路径 `<domain>/<source>/<title>.md`（每段做文件名清洗；同名冲突时按**文件里记的 `doc_id`** 判定归属，属别人的那份加 `~<doc_id>` 后缀，绝不互相覆盖）。文件头是 frontmatter，记 `doc_id / domain / source / title / source_uri / ingested_at / content_hash`（转换来的文档多一个 `converter`），正文**逐字节等于摄入的文本**——`content_hash` 比的是文件正文，所以任何归一化（哪怕补一个换行）都会让文档"刚摄入就显示被改过"。`converter` 是**可选**字段：文本/PDF 文档不写它，改动前写下的老文件也没有它，解析必须照常（`renderDocFile` 跳过 `undefined`，不写 `converter: undefined` 这种非法 JSON）。
  - **它是副本，不是原文件**：`source_uri` 只在摄入时被读取一次，此后编辑/删除受管文件永远碰不到它。代价要说清：源文件之后的改动不会自动进来，要重新摄入才算数。
  - **修改 = 改受管文件本身，索引自动跟随**：文档的改动不再是一次「重新入库」调用，而是agent（或用户）用普通文件工具改那份 `.md` —— 拿到路径的唯一入口是 `kb_list`（它把每篇的绝对路径带出来）。同步由插件在 `tools/result` 之后自动完成：`KnowledgeStore.corpusDrift()` 只 `stat`（每篇一次、不读内容）回答"哪几个文件看起来变了"，命中的才跑 `sync({docId})`（它按正文哈希裁决 stale，只重摄入真正改过的）；文件集合变了或有文件不见了才升级为全量对账。`sync` 因此**不在模型可见工具面**里 —— 模型不需要、也不该手动同步；界面保留「同步文件」按钮作手动兜底。指纹只当**触发器**：同秒编辑、粗粒度文件系统、`cp -p` 都能骗过它，真正的判据始终是正文哈希。
  - `remove` 连同受管文件一起删（先删文件；文件删不掉就中止，避免留下"行没了文件还在"的孤儿）；`ingest` 写文件失败不算摄入失败，只在结果里带 `file_error`，`sync` 会把该文档报成 `missing`。
  - 打开方式：`kb_open_doc(doc_id, target=file|dir)` 是**纯 UI 方法**（没有对应的 agent 工具），由宿主按 `knowledge.open.editor`（留空则自动探测 `$AVANTF_EDITOR` → `$VISUAL`/`$EDITOR` → `code` → `cursor` → 平台打开器）拉起编辑器；路径由宿主从 `doc_id` 解析，客户端不传路径。

## 9. 模型（Plan A）

| 角色 | 模型 | 本地 | 说明 |
|---|---|---|---|
| 嵌入 | `Xenova/bge-small-zh-v1.5`(512 维, ONNX·transformers.js) | ✅ 本地离线 | 默认值即 ONNX 仓库（`BAAI/*` 为 PyTorch，不可用于 transformers.js）；换模型需同步改 `semantic.dim` 并 `reindex` |
| 重排 | `Xenova/bge-reranker-base`(cross-encoder) | ✅ 本地离线 | `rerank.backend` 是重排唯一开关（默认 `none` 关闭） |
| 生成 | **外部**（DSH/agent 或 UI 模型） | ❌ 非本地 | Plan A：插件只检索，不生成 |

## 10. 工具面（agent 上下文）

实际暴露给模型的工具名以契约为准（`packages/contract/src/tools.ts` 的 `ToolSpec.name`），
下表即当前实现；每个工具的 action 不拆成独立工具，而是同一工具的一个 `action` 取值：

| 工具名 | action | 作用 | 类别 |
|---|---|---|---|
| `mem_remember` | add / update / remove / helpful / unhelpful | 记忆写入与反馈（共享库，无用户隔离；add/update 当场做矛盾检测） | 记忆 |
| `mem_recall` | search / ask / chain / probe / reason / related / contradict | 记忆检索与图查询 | 记忆 |
| `mem_admin` | stats / list / detail / archive / restore / pin / unpin / trust_diagnose / vectors_diagnose / vectors_fix / contradict_check / maintenance | 记忆运维与诊断（`contradict_check` 为幂等补扫） | 记忆 |
| `kb_add` | — | **只新增**一篇（text / source_uri / paths 批量）；同一 `(domain, source, title)` 已存在时**拒绝** | 知识 |
| `kb_list` | — | 列出文档并带出**受管 .md 的绝对路径**（`doc_id` + `domain/source` 过滤）；给 `doc_id` 时返回该篇详情+切片。**改一篇既有文档的入口** | 知识 |
| `kb_remove` | — | 删除一篇（连同受管副本）；不可逆，只在用户明确要求时 | 知识 |
| `kb_reindex` | — | 重建索引（可选限定 domain、dry_run） | 知识 |
| **`kb_query`** | —（单对象入参，无 action） | **跨库检索**（`kind/domain/source` 过滤；`quota` 未实现，见 §7） | 跨库 |

- **统一的 agent 返回值信封**：DSH 工具与 MCP server 都返回 `{ok:true,result}` / `{ok:false,error,violations}`（`ToolEnvelope`，契约单源）；参数先经 zod 校验，违规以 `violations` 逐字段回传，模型据此重试。
- **MCP `inputSchema` 由契约派生**：判别联合输出 `oneOf`（每个 action 自带 `required`），并携带 zod 的边界/默认值；顶层 `properties` 供不解析 `oneOf` 的客户端兜底。工具描述必须覆盖其全部 action（有测试守卫）。**字段级"哪些 action 必填"必须由 schema 推导，不能靠作者手写**：字段在联合里是逐分支声明的，而模型可见面有两处（MCP 的顶层 `properties` 与 DSH 工具参数），两处都调用契约的 `mergedFieldDescription`——它剥掉作者写的 `action=… 时必填`，换成推导出的完整集合 `【detail/archive/restore/pin/unpin 必填】`。此前 DSH 侧取的是"第一个声明该字段的分支"的原文，于是 `mem_admin.fact_id` 只写 `action=detail`（实际 5 个 action 必填）、`contradiction_id` 完全没写 action、`mem_recall.entity` 漏了 `related`——模型只能靠一次 `violations` 重试学回来；`tool_schema.spec.ts` 现在逐字段断言两个面完全一致。
- **prompt 里只放"怎么调用工具"**：每个工具的描述（含各 action 与参数含义）必须足以让模型正确调用（上一条就是它的守卫）。描述**只讲"是什么"**——不讲"为什么"、不讲"返回什么"、**也不讲"怎么做 / 何时用"**（流程与时机归三个 systemPrompt 段落，返回值自己会说话）：结果的形状 / 字段 / 上限 / 标志位一律不写，过程与时机也不写，理由与机制留在本文档与 CHANGELOG。契约测试用**三张**可维护的禁用词表逐条扫描工具描述与字段说明（返回描述类 + 解释类 + 流程/时机类），报出违规的具体条目——第三条守卫在它第一次运行时就从 `mem_remember.fact_id` 里抓出一处"先用 mem_recall 查得"的残留。**已知并接受的覆盖缺口**：`kb_reindex` 的"何时才需要重建"、`mem_recall` 七个 action 与 `mem_admin` 十二个 action 各自的语义，删掉描述里的"何时/怎么用"后哪儿都没有——这是刻意的（名字自明 + 返回值会纠正），**不要为此把它们写回提示词段**（那三段是 132/185/92 字、刚定稿）。三类硬信息仍是必须保留的"是什么"——action 枚举（每个 action 字面量都要在描述里出现）、字段级【哪些 action 必填】标记（由 schema 派生，不手写）、参数取值语义（`ttl_days` 的 `0=不设有效期`、`max_tokens` 的 `0=不限制`、`kind` 的取值枚举等）。**记忆消退/强化/保留策略一律不写进 prompt**：模型既观察不到这些时钟，也没有正当动作（唯一"能做"的事是重写事实去刷新寿命，恰恰会破坏策略本身）；`helpful`/`pin` 只作为**动作名**出现，不解释其内部效果。契约测试逐条扫描工具描述与参数描述，禁止出现衰减/消退/遗忘/强化/信任度等字样；**提示词只说"该怎么做"，不解释"为什么"**：段落与工具描述都是动作与约束，理由一律留在本文档与 CHANGELOG（写在提示词里只会每步都花 token，且不改变动作）。**插件再注册三个 systemPrompt 段落**（`avantf:memory-usage` order 3000、`avantf:knowledge-usage` order 3010、`avantf:kb-edit` order 3020）补上工具描述承载不了的那半句——描述说的是"调用**做了什么**"，说不出"**什么时候该主动伸手**"，而模型的默认行为是等指令。所以两个段落都只讲**时机**，不讲任何保留机制：记忆段（发现重要且跨会话仍成立的事实就 `add`，不必等用户开口；不要存临时聊天、一次性任务中间态、代码里能读到的内容），知识库段（**先给知识的定义**——用户提供的成篇资料：文档、长说明、规范、综述；回答涉及已入库资料的问题前先用 `kb_query` 检索，命中就按 `source_ref` 引用原文；主动入库，且一句话的事实归记忆、不入知识库；`kb_add` 只新增、同名拒绝。**这段为什么必须存在**（实测，但不写进提示词）：用户刚入库《Cgroup v2 技术综述》，同一时间问「cgroup v2 的内存保护」模型却没查——当时的提示词只提名记忆工具，而 `kb_query` 的描述以「记忆事实」开头、读起来像记忆工具。记忆段则**只讲写侧**（何时该记、不要记什么）："回答前先检索"这条已删除，因为每条用户消息现在都会带上条件提示（`avantf:mem-hint`），常驻规则只会每步白花 token）`kb_add` 的**写侧允许主动**：值得长期留存的成篇内容（用户给的文档、长说明、现成的规范/综述/踩坑记录）由 agent **主动** `kb_add`，不必等用户开口 —— 一句话的事实才走 `mem_remember`（`mem_remember.content` 只有 `min(1)`、**没有长度上限**，不写清这条的话整篇文档会被塞进一条事实，而库里反而没有可检索、可引用 `source_ref` 的文档）；`kb_add` 只新增，重复的三元组会被**拒绝**），第三段讲**怎么改一篇既有文档**（这是实测补的：模型被要求"更新知识库"时用**新标题**又建了一篇《… · 补遗》，原文成了过时且重叠的第二篇 —— 所以现在明确"先用 `kb_list` 拿路径，再用文件工具改那份 .md"；删除只在用户明确要求时用 `kb_remove`）。**这里有一条被实测推翻的直觉**：最初写的是"用 `edit` 定点改、**不要**用 `write` 整篇覆盖"（因为 frontmatter 是身份载体），但 `edit` 在实际执行中会失败，此时整篇重写是必需的动作 —— 所以约束撤掉，改由**带守卫的自动认领**承担后果：重写丢掉 frontmatter 后，`sync` 会自动把它认领回路径命名的那篇（守卫见 §8）。**换言之兜底是这类重写的指定恢复手段，不是"只给事故用"的安全网**；提示词不再规定用哪个文件工具，只规定改哪一份。（同一份 `RETENTION_VOCABULARY` 词表由契约导出，插件单测用它扫描该段落，两个守卫不会各自漂移）。段落文本放在 `plugin/src/prompt.ts`（而非 `index.ts`）：插件的 `pnpm test` 在 CI 里跑，而入口的 `@deepseek-ai/*` 运行时导入只存在于 harness 工作区；`inject`/注册的配对由 `scripts/mount-smoke.mjs` 用真实 Cordis 上下文验证。**段落正文是用户可编辑的**：每段一个文件放在**家族共享**的 `<data_home>/prompts/`（`mem-memory-usage.md` / `mem-knowledge-usage.md` / `mem-kb-edit.md`；工作引擎用同一目录、`work-` 前缀），插件在 `apply` 里**只读一次**（改完重启 dsh 生效，与 host 半边改代码同一条规则）；缺失或空白会被原子写入内置默认（空文件不是"禁用该段"），有内容则**逐字注入**（去首尾空白、剥 BOM、CRLF→LF），文件不可读写只告警并退回默认、**绝不阻断挂载**。**文件只提供正文**：段落名与 order 由 `plugin/src/prompt.ts` 的 `PROMPT_FILES` 清单固定，所以编辑文件不可能移动段落位置或改掉 harness 去重的名字；清单外的 `.md` 被忽略（不报错）。`prompt_section.spec.ts` 的四类守卫（<400 字、必须点名工具、不得含 `RETENTION_VOCABULARY`、不得含因果措辞）**只守内置默认**——用户文本不受约束（那是用户的 prompt），但会经 `promptTextWarnings` 做一次**软检查**并各记一条警告（超 400 字 / 命中 `RETENTION_VOCABULARY` / 命中因果措辞），不截断、不拒绝。ensure/read/fallback 这套流程按"每段都一样、只差路径与默认正文"抽成通用件 `PromptFiles`（`plugin/src/prompt_files.ts`：注入 io、永不抛错），调用方只给一份清单。它放在**插件**而不是引擎，是为了与工作引擎（`@avantf/dsh-work`）的镜像件**同路径**（那边 `packages/plugin/src/prompt_files.ts`，同形同规则）——work 的引擎刻意不带 Node 类型，引擎侧的家对它不可用；两仓无共享文件工具包，路径一致才让 diff 有意义、将来抽公共包也是机械动作。
- **工具结果是"事实视图"，不含保留诊断**：`mem_admin` 的 `list`/`detail` 在**模型可见面**（DSH 工具与 MCP 分发）会去掉 `trust_score`/`remaining_days`/`helpful_count`（契约的 `modelFacingToolResult`，两个边界各调一次）；Remote/设置页调用同一条 `DISPATCH`/`rt.admin`，拿到完整字段。要看这些数字的调用方用**显式诊断**动作（`trust_diagnose`/`vectors_diagnose`，原样透传）。`retrieval_count` 保留：它是使用统计，不是保留旋钮。

## 11. 去重与矛盾（保留原语义）

- **去重**：`facts.content UNIQUE` + `INSERT OR IGNORE` 幂等；撞已归档行→复活(`revived`)；`supersedes_id` 修订链 + 旧事实归档。**不做近重复自动合并**。
- **`category`/`ttl_days` 的一条规则**（三个分支一致）：**显式给出的值一定落到存活的那一行；未给则保留该行原有值；全新行才用默认值**（`general` / `0`）。`add` 与 `update` **都接受这两个字段**（`ttl_days` 曾在 update 分支缺失，被 zod 静默剥离：工具描述写着"显式一定生效"，实际却是 no-op），且 `ttl_days: 0` 是**取消有效期**的显式取值（列与生命周期步骤都以此编码"无有效期"，判定条件是 `ttl_days > 0`），所以约束既能设也能撤。实现落在 `persistFact` 一处：它接收 `undefined` 表示"调用方没指定"，并在插入（新行继承被改写事实的 category/ttl）、复活、以及纯重复三分支里统一执行该规则。之所以必须区分"未指定"与"默认值"：`INSERT OR IGNORE` 命中时若用默认值回写，就等于"重复 add 把已有分类重置成 general"；而 `update` 过去直接传 `undefined`，等于"改写一次就把显式 TTL 清成 0"。`update` 的修订继承 category/ttl 与它继承 `trust`/`pinned` 同理（同一逻辑事实的改写）；**并且继承被改写行的 `created_at`、写入新的 `updated_at`**——见下一条的修订时间规则。
- **修订的时间语义（`created_at` 继承 / `updated_at` 前移）**：`update` 生成的新行**显式继承**被归档行的 `created_at`（`insertRevision` 把 `created_at`/`updated_at`/`last_retrieved_at` 都写进 INSERT 列清单、不再依赖列 DEFAULT，所以"继承"是显式行为而不是巧合；找不到旧行——即首次 `add`——才用当前时间）。`updated_at` 在新行上取 `CURRENT_TIMESTAMP`，语义仍是"这一行被改动过"。三处交互都是刻意的：① **idle 兜底**读 `COALESCE(last_retrieved_at, created_at)`，继承老 `created_at` 会让刚更新的记忆**下一次 tick 就被判 idle**——所以同一条 INSERT 也把 `last_retrieved_at` 显式置为 `CURRENT_TIMESTAMP`（"用户重新断言了它"本身就是一次使用），idle 判据本身不改；② **TTL** 按 `created_at` 计，因此继承后**更新不延长寿命**（"这条只在最初记录后 N 天内有效"），到点即归档，见 [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md) §2.7；③ `mem_admin list` 仍 `ORDER BY created_at DESC`（列表表达"第一次记录的新旧"），**不**改成 `updated_at`——那会让 pin/强化这类非内容变更把行顶到最前，且要新增索引。
- **矛盾**（三档）：① 三元组极性冲突 0.95（同 subj+obj，谓词极性相反）；② 同 subj+pred 异 obj 0.5（默认<阈值 0.6，不写日志）；③ 嵌入兜底 `overlap×sim`（实体≥2、Jaccard≥0.5、sim∈[0.75,0.97]，`sim>0.97` 视为近重复返 0）。
- **写入即检测**：`add`/`update` 落库后立刻对该事实跑一次检测（`checkOne`），返回值里带 `contradictions`——**该事实当前全部未处理冲突**（`other_fact_id` + `score`，按分数降序，最多 `MAX_REPORTED_CONFLICTS=20` 条，完整列表仍在 `contradict`/设置页），不只是本次新入账的：`maybeLog` 会跳过已 open 的配对，所以只回传新入账会把「合并进一条已有冲突的事实」显示成无冲突。**只有写入真的改变了状态才报告**（`add`：`is_new || revived`；`update`：再加 `newId !== fact_id`——合并进既有事实也归档了一个修订），因此 `add` 命中完全重复的内容、`update` 重存同一内容都是静默 no-op。`admin contradict_check` 退化为**补扫**：消费 `notifyChanged` 积压的 id（含"写入时模型不可用、嵌入腿没能比对"的旧事实），已 open 的配对不会重复记账——幂等追赶，不是第二个写入者。**待办集只保留"还没能跑嵌入腿"的事实**：`checkOne`/`check` 在拉到向量后就把它从队列里删掉（否则每次写入都留一条，队列与补扫代价都随写入量无界增长），补扫失败时队列不清空（下次重试）。**补扫队列在内存里**：只在同一进程内追赶，进程重启（或从 CLI/MCP 这种独立进程调用）时队列为空；`vectors_fix` 会给它刚补上向量的事实重新入队，否则"模型不可用 + 重启 + 之后再没被改写"的事实永远不会被嵌入腿检查。
- **离开 active 即结案**：事实被归档/被修订取代/被遗忘时，它名下的 open 矛盾行会被 `resolveForFact` 置为 resolved（`loser_fact_id` = 该事实），`list` 也只展示两侧都 active 的配对。否则 `update` 每次都会为同一逻辑冲突再记一条，且旧行会一直指向已归档的旧修订——而 API 面没有 resolve 入口，这些行只增不减。
- **单条检测的代价（候选集的两级无损收窄）**：第一级是"与该事实共享至少一个实体"的 active 事实（一次 `fact_entities` self-join，`idx_fact_entities_entity`）；第二级按打分公式的必要条件再剪：令 `p = max(EMBED_OVERLAP_MIN, threshold / EMBED_SIM_DUP_MAX)`（因 `score = 重叠 × 余弦 ≤ 重叠 × simDupMax`），则任何可能入库的配对必须满足 **共享实体数 ≥ ⌈p·|A|⌉**（由 `|A∪B| ≥ |A|`）且 **|B| ≤ ⌊|A|/p⌋**（由 `|A∩B| ≤ |A|` 且 `|A∩B| ≥ p·|B|`），外加打分器自身的 `|·| ≥ EMBED_MIN_ENTITIES`。两级都只做**必要条件**过滤，所以不会丢掉任何可能达到阈值的配对。效果：`|A|=2` 时共享 1 个实体的候选上限只有 `(1/3)×0.97≈0.32`，整个这类 hub 直接被剪掉（实测 3 万 hub：保留候选 200ms → 剪掉后 23ms，剩余部分是 SQL 聚合本身的成本）。
- **代价与语料规模无关（靠索引点查，不扫全库）**：结构腿按 `(subj,obj,pred)`／`(subj,pred)` 走 `idx_triples_subj`／`idx_triples_obj`，实体腿走 `idx_fact_entities_entity`（显式 `INDEXED BY` 固定 `mine → other → facts` 的 join 顺序）。两条结构查询必须写成 `JOIN facts f ON f.fact_id = t.fact_id AND f.status='active'`，**不能**写成 `fact_id IN (SELECT fact_id FROM facts WHERE status='active')`——后者会让 SQLite 每次调用都物化全部 active id，实测 30 万三元组上零命中仍要 202ms／145ms，且成本随语料增长；JOIN 版为 0.18ms／0.13ms。`ANALYZE` 统计信息由生命周期 tick 与 `maintenance()` 里的 `PRAGMA optimize` 维护（否则规划器会退化成覆盖索引全扫：实测 115ms → 0.13ms；统计信息新鲜时 `optimize` 是 0.05ms 的空操作）。
- **增量**：对子 `(min,max)` 归一化；`contradiction_log.resolved` 三态 `0=open/1=resolved/2=false_positive`。

## 12. UI（`conversation.view` 两个标签页）

两个标签页注册进会话视图标签条（`conversation.view`），排在 **对话（0）/ 轨迹（10）之后**，因此它们与对话同处主窗口、按会话切换；面板内的数据是全局共享的（记忆库无用户隔离），不随会话变化。

**设置页不再承载这两个面板**：它们此前**同时**在 `settings.section` 保留一份（理由是会话语义为空白时标签条整条隐藏，设置页是那时唯一可达的入口）。现在标签条是唯一入口，设置页里的「记忆」「知识」已移除，`dsh.client.inject` 也不再需要 `@deepseek-ai/dsh-client-ui-settings`。**代价**：全新会话在发出第一条消息之前看不到这两个标签页（标签条随会话头部一起隐藏）；面板本身可从任一会话的标签条进入。

**A. 记忆**（`id=memory, order=20`）：**sticky 头部**承载 活动/归档切换、立即维护、未处理矛盾、检索健康度与计数摘要（长列表滚动时控件始终可见）；事实列表**滚动到底自动加载下一页**（监听滚动容器的滚动事件做电平触发；`scrollParentOf()` 向上找真正滚动的那层 —— 这个座位里是会话的 `.scrollBody`，面板自己没有滚动条，`rootMargin` 那类只放大 intersection root 的做法在这里不生效。兜底的「加载更多」同时报剩余条数）；另有编辑（supersedes 修订链）+ 归档/恢复 + 有用/没用反馈 + 单条详情（实体/三元组/检索次数/修订链）+ 未处理矛盾裁决（块渲染在列表之上）。
**B. 知识**（`id=knowledge, order=30`）：**打开即文档列表**（`kb.list` 按 50 篇一页取、滚到底自动加载下一页，sticky 头部显示已加载篇数）；「查询」按钮展开查询面板（输入框自动聚焦，`kind/domain/source` 过滤）→ 结果按 `记忆 / domain → source` 分组标注 `source_ref`；头部另有 **入库**（一个表单：domain/source/title + **一个来源框** + 粘贴文本 + 单一「入库」按钮）、重建索引（范围跟随 domain 过滤）与 **同步文件**（把改过的受管文件拉回索引）。**知识域是下拉，不是自由输入**：选项 = `knowledge.domains` 清单 ∪ 库里已有领域（宿主方法 `kbDomains` 提供，挂载与每次刷新各取一次），清单非空时**不留自由输入**；清单为显式空数组（不限制）时才退回自由输入。**入库表单**的 domain 标签旁另有 **「+ 新增领域」**（查询面板的 domain 过滤**没有**）：点开一个小输入，确认后宿主把它写回 store 配置 `~/.avantf/configs/knowledge.yaml` 的 `domains`（`parseDocument` + `toString` 保留既有注释；临时文件 + 原子 rename 落盘），并同步加入 store 的**可变内存允许集合**，所以**当次会话立即可用、不必重启**（手改配置仍需重启，配置只在启动时读一次）。命名 trim 后为空、或含 `/`、`\` 一律拒绝——这个名字会成为受管路径的一级目录，而 `sanitizeSegment` 会改写分隔符，放进去就会"下拉显示的名字 ≠ 目录名"；已在选项里（配置 ∪ 库内 ∪ 本次新加）的名字**直接选中、不重复写**。清单为 `[]`（不限制）时**不提供「+」**：往不限制的清单里追加一项会把它静默变成受限清单。新增走**新的 UI 专用远端方法 `kbAddDomain`**，**不是** agent 工具——agent 仍只受清单约束，这个不对称是刻意的（自主写入方正是要防的膨胀来源）。查询面板的 domain 过滤用同一个下拉（空选项 = 全部），重建索引的范围跟着它。**来源（source）可留空**（契约缺省 `default`），两处来源标签都不带必填标记。**来源框里 URL / 本地文件 / 本地目录 / 粘贴文本共用一个输入**，「入库」按宿主的分类派发（URL→抓取、文件→`ingest source_uri`、目录→`import`、其余→按文本 ingest），分类结果先显示成一行提示再执行；旁边的 **「选择」** 打开面板内的选择器（宿主按 `knowledge.ingest` 边界逐个目录列举，目录点进去、文件点即选，`other` 条目灰显，边界外的路径根本列不出来）。每行文档有 **查看切片 / 编辑 / 打开目录 / （改过时）重新摄入 / 删除**：`编辑`、`打开目录` 作用在受管副本上，`删除` 二次确认并写明将删除的绝对路径与原文件不受影响；被改过或文件缺失的文档带 `文件已修改 · 待重新摄入` / `受管文件缺失` 徽标。文档列表不做 domain/source 过滤（那是查询的事）。不做答案生成（Plan A）。
两个标签页共用一条**与对话正文同宽**的内容列（`--dsh-chat-content-width`，居中），控件都放在各自的 sticky 头部里，长列表滚动时不会被顶走。
两页经手写的 `avantfMem` Typert Remote 面（remember/recall/admin/kb/query 五个透传方法 + 五个 UI 专用方法 `openDoc`/`classifySource`/`browseDir`/`kbDomains`/`kbAddDomain`）访问 host，每个调用都经契约校验。**信封有两层**：传输层由 DSH 自动包 `{ok,value:<host 返回值>}`，应用层是 gateway 自己的 `{ok,value}|{ok,error,violations}`；客户端统一用 `unwrapRemoteEnvelope()` 逐层拆解（否则页面会把信封当数据，永远显示空列表）。

**文案语言（全中文，边界写死）**：界面与弹窗里的一切可见文字（标签、按钮、占位符、状态行、空态、二次确认、失败摘要）与**注入给模型的文字**（8 个工具的 `description`/字段 `.describe()`、三个系统提示词段 `avantf:memory-usage`/`avantf:knowledge-usage`/`avantf:kb-edit`）都是中文；**这些注入文本只讲是什么 / 怎么做，不讲为什么、也不描述返回什么**（规矩与守卫见 §10）；字段标签写作「中文（schema 名）」以对齐工具/CLI 参数名。参数校验的说明文字靠契约层 `z.config(z.locales.zhCN())` 变中文，系统报错靠 `describeError()` 在 errno 原文前加一行中文注解（原文与 `code` 保留，OS 自己的英文消息透传）。引擎侧（`core` / `retrieval-core`）**会走到界面、工具信封或降级横幅的**报错一律中文 —— `memory unavailable: <原因>` 这条链路上不留英文。**保持英文的是终端诊断**：宿主 `[avantf-mem] INFO/WARN` 启动日志、浏览器 console 行、CLI 的 `usage:` 提示（`model_bootstrap` 等测试按这些文案断言，且它们是给人 grep 的日志而非弹窗）。

**条件提示（有则加、无则不加，只有一条）**：除了三段常驻的用法提示，插件还注册**一个条件上下文** `avantf:mem-hint`（order 130），只在**两个库里至少有一个握有相关内容**时渲染一句话（`[avantf-mem] 记忆或知识库里有与上条用户消息相关的内容；需要时用 `kb_query` 检索。`），否则渲染**空串**——`renderContextSections` 会丢掉空文本，所以"没有相关内容"是零 token。**判定接口因此塌成一个布尔**：`kb_query` 本身就是跨库检索（文档切片 + 记忆事实），"是哪个库命中"不改变任何下游决定，所以插件只问"要不要提示"。**为什么不再分两条**：旧的 `avantf:memory-hint`（130）/ `avantf:knowledge-hint`（131）各点一个工具，模型照做就是两次重叠调用——记忆事实从 `mem_recall` 回来一次，又混在 `kb_query` 的融合结果里回来一次；而且每次 `memory↔knowledge` 翻转都要追加一份新快照（实测占这些会话快照追加总数的约四分之一，约 22k 字符）。`mem_recall` 仍是记忆专有动作（chain / probe / reason / contradict）的工具，那件事归常驻的记忆用法段与它自己的描述。判定只认**用户发的**消息（`agent/inbox/inserted` 载荷里 `source.kind === 'user'`）：同一事件也承载插件唤醒与子代理通知，让它们改写"与上条用户消息相关"的提示是错的。作者前缀（`[avantf-mem]`）不是装饰：harness 把运行时上下文物化成**用户角色的快照**（`dsh-agent-loop` 的 `runtimeContext.project` 返回 "a candidate user message"），不署名就会被读成用户自己说的话。
这条提示的**判定放在 core 的一个内部接口上**（`AvantfRuntime.relevance(text): boolean`，非工具、不面向模型），门槛只存在一处：词 = 拉丁/数字词（≥5 字）+ CJK 三元组（trigram 分词下更短的 CJK 词根本无法表达），**命中 ≥2 个不同词才算"有"**（单词查询故意不触发：一个词不是证据）。为什么是**词面**而不是语义：这个 provider 是**同步**的（`PromptSection.text`/`PromptContext.text` 的函数形式在装配时被同步求值，抛错会掀翻那一步），而语义腿要 `encode()`（热模型 ~10–20ms），会输给 `preStep`→`assemble()` 的时序、晚一步才出现——那正是模型已经决定要不要调工具之后。所以词面判定是**保守**的：改写式提问会漏（实测"我记得之前定过一个关于数据目录的约定"对 34 条记忆命中 0），由常驻的用法提示兜底。判定的分离度是**实测**的，不是拍脑袋：10 条探针里 3 条真命中得 6/6/2 个词、7 条无关得 0 或 1（其中英文问句在 4 字下限时命中 3 个常见词，收到 5 字下限后只剩 1 个——**下限与"≥2"两条都在承重**），门槛 2 与 1 之间有间隔而不是连续体上的一个刻度。状态按 **agent 对象**做键（`WeakMap`：`dsh-agent` 的 `assembleContextFor` 传的 `scope` 就是 agent 本身，`agent/inbox/inserted` 的载荷里也被注入了同一个对象），所以两个会话不会看到彼此的提示。

### 12.1 启动时的 dsh 兼容性门禁（判定/探针/复查都在家族底座 `@avantf/dsh-plugin-base`）

DSH 的 Typert API 已经在我们脚下动过一次（`TypertSchema { schema }` → `TypertSchemaFactory { create }`），而它失败的方式很难查：插件**挂载成功**，然后某个 remote 调用或 schema 投影在**运行时**炸掉，报错里没有一个字指向版本错配。所以启动时做一次门禁，日志前缀 `compat:`（英文，见 §12 的终端诊断规矩）。**规则、探针、报告与复查全部在家族底座 `@avantf/dsh-plugin-base`**（家族共用，与 `@avantf/job-dsh` 同一份）——底座**一个包**里同时装着启动期环境初始化框架与这道门禁（从前独立的 `@avantf/dsh-envinit` / `@avantf/dsh-compat` 已并入它，两个旧包不再发新版本）。启动时内联的零依赖 `bootstrap` 按 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` 从**插件自己的依赖树**解析底座、动态 `import()` 它，门禁直接跑在**动态加载进来的那一份**上：**没有 `mem:compat` item、没有下载、也没有受管 `~/.avantf/env/compat/**`**。本仓只声明"只有本插件才知道的东西"（`packages/plugin/src/provision.ts` 的 `COMPAT_SPEC`：服务契约、宿主版本包清单、wire schema 名、事件清单与中文报告文案，**懒构造**）。

1. **版本（两侧都只描述"本产物 ↔ 它链接的那份 dsh"）**。`runtime` 由 `readRuntimeVersions(VERSION_PACKAGES, import.meta.url)` 从**本包自己的链接**解析 —— 这是"本产物链接现在解析到哪一版"，**不是宿主版本**（插件里没有任何办法看到宿主自身的版本）。`declared` 由 `readBuildVersions(new URL('./dsh-build.json', import.meta.url), VERSION_PACKAGES, peer地板)` 读取：**优先构建时烧入的精确版本**（`scripts/build-versions.mjs` 在 `scripts/link-dsh.mjs` 链接好那份要编译的 dsh 之后写成 `lib/dsh-build.json`；`files: ["lib"]` 让它随包发布），**没有该文件才逐包回落**本包 `package.json` 的 peer 区间地板（`^0.1.5-rc.2` → `0.1.5-rc.2`）。曾经用 tsdown `define` 把构建时版本烧进 node 面（`__AVANTF_DSH_BUILD_VERSION__`）；迁移底座时改回 peer 地板，现在换成"烧入精确版本 + 逐包回落地板"—— peer 地板只是区间下界，说不清"我编译时对着哪一版"。**设计边界**：版本比较只覆盖本产物 ↔ 它链接的那份 dsh，**宿主身份未观测**；ok 行因此写 `dsh links: <包> <版本>` 并注明 "versions this build's own links resolve; the host identity is not observed"，**不用 `running`**；checkout 宿主 + 安装版链接时会打印安装版版本，这是设计边界不是 bug，此时只有真身探针是真的防线。
2. **探针（对着真实注册表）**。`probeTool: toolProbeDeclaration(defineTool)` 注册一个与真实工具同形的探针并在 `finally` 撤掉；`probeTypert: () => hostContribution` **就是把真身 contribution 注册一遍**（codec 与 schema 项都带 `schema` + `create()`）→ 按精确 key 复查 → `toJSONSchema` 投影**我们记录的 zod schema**（工厂化改动会炸的点）→ 撤掉。探针通过即"真身注册会通过"；用"相似形状"的假探针曾在一个 codec 契约已变的 0.1.6 宿主上给出假 `ok`，真身注册随后在 `apply` 中途抛错——那正是这道门禁要避免的半挂载。

**时机与两档严重性**：环境初始化（内联 bootstrap → 动态装载底座 → 跑门禁）在 `apply()` 最前面，这道检查紧随其后、`buildRuntime(...)` **之前**（这样"不加载"是一个什么都没分配的纯 `return`）。

- **探测证明不兼容**（必需服务/方法缺失、工具探针被拒或不认、wire 探针注册被拒 / 查不到 / `toJSONSchema` 失败）→ **不加载**：不建 runtime、不注册工具 / `avantfMemory` / prompt 段与上下文 / remote / 真实 typert face；`return` 前用底座判据打 `compat: INCOMPATIBLE` / `compat: REFUSING to load` 行，并注册一条 `/mem` 命令（`registerMegaphone` + `compatReport`）说明原因与出路。半加载的插件比缺席的插件更难诊断，而缺席至少日志里有原因。
- **仅版本号不同**（探针通过）→ **软提醒**：一条 `compat: WARNING` 写明两侧版本与出路（用本机的 dsh 重建：`pnpm build:dsh`），然后**照常挂载**。版本差异是风险信号、不是不兼容的证据，这一档不能把还能用的插件挡在门外。版本解析不到 → 也照常继续，只在 ok 行里说明"版本未知"。

**环境准备与这道门的先后**：`apply()` 里的固定序列是 `bootstrap（内联；解析底座 → 动态 import() → 校验 supportedRange） → 接口门禁（底座判 verdict） → 跑兼容门禁 → 插件自己的挂载前检查`。接口门禁读插件 bake 的 `{ baseVersion, interfaceVersion }`（`lib/interface-version.json`）与加载到的底座报出的世代：`incompatible`（区间内但另一世代）⇒ 一条 `WARNING` 且**不使用底座的共享能力**（prompt 默认正文、门禁跳过、legacy provisioning），走的正是"底座整个拿不到"那条既有降级路径 —— 工具/service/Remote/UI 照常挂载；`cannot-tell`（老底座没有门禁函数、bake 缺失/畸形）⇒ 只告警并照常使用。没有 item 清单、也没有 blocking 等待集——兼容门禁**不再是** `mem:compat` 这样的预装项，它就是底座本身；`mem:pandoc` / `mem:model` 仍作为 background item 派发，但与门禁无关。**底座整个拿不到**（peer 没装、或版本超出内联的 `supportedRange`）时才一条 `envinit: WARNING`，并退回 legacy sweep `provisionToolchainAsync(rt, options)`（`packages/core/src/modelBootstrap.ts`），它的**第一步**接收**插件已算出的 verdict**（纯数据 `{ load, status, reason }`）。core 被内联进插件同一个 bundle，所以它**不再 import 底座**——否则底座缺失时 `lib/index.js` 在求值阶段就抛 `ERR_MODULE_NOT_FOUND`。`load: false` → **不解析、不安装、不预热任何 artifact**，直接返回 `{ skipped: true, status, reason }` 并打一条 `compat:` 警告——为一条驱动不了的 API 准备环境是白做。插件侧在 `buildRuntime` 之前已经判过并 `return`，这一步是纵深防御。真身注册完成后由 `verifyRegisteredFaces` 按**精确 key** 复查 20 个 schema 与 8 个工具名（不用 `list()` 裸总数，未撤净的探针会污染它）；缺了就只警告（此时已经挂载，没有干净的"不加载"可退）。

**绝不抛错**：整段环境初始化、这道门禁、以及"不加载"路径，都不抛。历史上一个抛错的 `apply` 让整个 `dsh web` 起不来——一次 `throw` 就把宿主一起带走，而这里要给的是一条日志。本插件的 `provision.ts` **对底座没有任何静态 import**：底座由内联 bootstrap 从插件自己的依赖树解析后动态 `import()`（try/catch，失败只告警），加载成功后才**构造一次** `COMPAT_SPEC` / schema 名（原来这些是模块级常量），把 `gatherEvidence` 与 `verdictOf` 组合起来跑一次；verdict 作为纯数据只交给 legacy sweep（core 只读 `load`）。`pnpm why zod` 里 core 侧那份重复的底座 peer 实例随之消失。

**环境的实际来源（底座在运行时被动态装载）**：底座不再由插件自己解析 / 下载。`@avantf/dsh-plugin-base` 是插件的 **peerDependency**（peer 区间 `>=0.3.0 <1.0.0`，并在 `devDependencies` 里再声明同一条 `>=0.3.0 <1.0.0` 以便 `pnpm install` 装上）；底座本体**绝不内联**，插件也**绝不按 specifier import** 它——唯一的静态引用是内联的 `bootstrap`（`packages/plugin/src/envinit-bootstrap.{js,d.ts}`，由 `scripts/link-envinit.mjs` 从**安装副本** vendor 底座的 `dist/bootstrap.js`，经 `lib/types/` 在 `tsc` 与 `tsdown` 之间被 tsdown 内联进 `lib/index.js`），它用 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` 解析底座、动态 `import()` 并校验版本；拿不到就一条 `envinit: WARNING`，插件**照常挂载、降级**。**运行期还有第二代接口轴**：底座 `.` 上的 `checkInterface` / `readInterfaceRequirement` 是接口世代的主契约；插件 bake 自己构建时的世代，启动时用它比对，`incompatible` 走同一条降级路径（不用底座共享能力、仍挂载），`cannot-tell` 只告警（`docs/INTERFACE.md` §3）。**共享业务逻辑在运行时从底座取用**（门禁规则/探针/复查、envinit provisioner、prompt 文件层 `PromptFiles`，以及 work 用的 `resolveDataHome`），所以修这些共享逻辑只需一次底座发布、不必重建插件产物。仍留在插件里、改它们需要发插件的是：`typert` `strict` wire codec 与端点/字段/结果符号字面量（照抄宿主约定的两三行，描述符在模块加载期就要组装），以及各插件自己的 logger 与"底座缺席时"的降级 fallback（work `prompt.ts` 的 `resolveDataHome` 默认参数、mem 的默认提示词正文）。底座 kit 另外导出 `createPluginLogger`、`familyHome` / `familyToolsDir` / `familyModelsDir` / `expandHome` 与 Typert 符号工具，插件都可以在运行时从加载到的模块上取用；`@avantf/mem-contract` 的 `family.ts` 则是给没有 DSH 宿主的 CLI/MCP 用的镜像，由测试钉住两份一致。插件声明的资源项只剩**真正的外部制品**：`mem:pandoc`（`binary-archive`，根 `tools`，`background`，仅 `tools.auto_install` 时）＋ `mem:model`（`model-cache`，根 `models`，`background`，`flat` 布局 + 镜像 `spec.endpoint`，仅本地嵌入后端**且**运行时的 `semantic.cache_dir` 就是受管根时；默认仓库只声明运行时真正会取的四个文件，改过仓库则省略 `spec.files`，交给框架按仓库自身的清单装）。`flat` 布局把文件落到 `<home>/models/<repo>/<file>`，正是 `@huggingface/transformers@4.x` 按 `<repo>/<file>` 读取的形状，所以框架装的这一份就是运行时读的那一份，没有第二份下载；框架 0.1.2 之前它只写 hub 布局（`models--<org>--<name>/snapshots/<sha>/`），运行时永不读，模型因此曾被排除在 item 之外。族根 = `$AVANTF_HOME`，否则 `~/.avantf/env`；框架装载后 `<home>/tools` 与 `<home>/models` 成为 `tools.dir` 与 `semantic.cache_dir`/`rerank.cache_dir` 的**内建默认层**（`managedRoots`）；`tools.dir` 仍可被 `config.yaml` 与环境逃生口（`AVANTF_TOOLS_DIR` / `AVANTF_PANDOC`）覆盖，**模型的落点与镜像不再由 `config.yaml` 决定**——`semantic.cache_dir` / `semantic.mirror`（及 rerank 同名键）会被忽略并告警，只剩运维环境逃生口 `AVANTF_MEM_MODEL_CACHE` / `AVANTF_MEM_MODEL_MIRROR`（或 `HF_ENDPOINT`），两者都由环境层写进 `semantic` / `rerank` 的同名键——镜像因此到得了 `mem:model` 的 `spec.endpoint`，缓存覆盖则让 `mem:model` 不再声明（否则族根会多出一份没人读的副本）。下载总闸：`AVANTF_ENVINIT_AUTO_DOWNLOAD=0`（家族）或 `AVANTF_MEM_AUTO_DOWNLOAD=0`（本项目），任一为 `0` 都经环境层落进 `semantic.auto_download` / `rerank.auto_download`，框架与运行时同时停手。昂贵资源只后台派发、绝不等待：`mem:pandoc` 失败/跳过时落回 legacy tools 目录并重置 pandoc 解析缓存；嵌入模型在该 item **到达终态后**由 `warmSemanticAsync` 预热（`warmModels` 拆成了 `warmSemantic` / `warmTokenizer` 及各自的 `*Async`）——框架接管模型根时 `buildRuntime` 给后端传 `deferWarm`，构造期不再自己开抓，先等文件落盘再让运行时去看，跳过/失败时照样预热，让 `semantic.auto_download` 决定"自己取"还是"降级"；nodejieba 分词器的预热不变（仍藏在宿主就绪信号之后）。**底座装载失败时的语义（按能力降级）**：一条 `envinit: WARNING`，然后**照常挂载**完整插件。逐项降级：prompt 文件层不可用 → 用插件自带的默认提示词正文（那些默认值本来就在插件里，不是重复）；兼容门禁不可用 → 走既有的 `compat:` WARNING 路径、门禁跳过（判定语义不变：只有**被证明**的不兼容才拒载，"无法判定"是 note，版本差异只是 warning，绝不抛错）；资源预装（pandoc 二进制 item、嵌入模型 item）不可用 → 走 legacy `@avantf/mem-provision` / legacy tools 目录（默认 `~/.avantf/tools`、`~/.avantf/models`）；tools / service / Remote / UI 各面不受影响、照常挂载。CLI 与 MCP 永远走这条 legacy 路径。**绝不因"拿不到底座"拒载，也绝不抛错**（与"无法判定 ≠ 不兼容"一致）。

**设施层面的现状另见 [docs/PROVISIONING.md](docs/PROVISIONING.md)**：item 清单、两阶段启动、受管根与下载闸、legacy 路径与"迁移已有机器"的配方都在那里；三层架构、provider 契约、发布锁与状态合并等**机制**在底座自己的 `docs/DESIGN.md`（`@avantf/dsh-plugin-base`）——本仓不复制。

**依赖与发布顺序**：`@avantf/dsh-plugin-base` 是**peerDependency**（peer 区间 `>=0.3.0 <1.0.0`，另在 `devDependencies` 里声明同一条 `>=0.3.0 <1.0.0` 以便 `pnpm install` 装上；顺序是**先发 base 再发插件**，插件的发布门禁会断言 registry 上已有落在该区间内的版本），`scripts/link-envinit.mjs`（`pnpm build:dsh` 自动跑）从安装副本 vendor 它零依赖的 `bootstrap`；要就地改底座用 `DSH_ENVINIT=<checkout>` 显式指定。环境初始化框架与兼容门禁现在都在底座**这一个包**里（`@avantf/dsh-envinit` / `@avantf/dsh-compat` 已死，不再发新版本），发布顺序因此是**先发底座、再发插件**：`release-check` 在发布插件前会确认 registry 上已有落在插件 peer 区间内的底座版本。打包 / 投影会拒绝仍带 `link:`/`file:` 的产物（`pack-plugin.mjs` 与 `make-release-tree.mjs`）。底座的 zod peer 放宽到 `>=4.4.3 <5`；`zod` 在**根** `pnpm-workspace.yaml` 的 catalog 里统一成一份（合并后是 `4.6.5`，跟随已安装 dsh 的版本），所以同一份底座既服务本工作区、也服务已安装的 dsh。

**改共享代码后的回归规矩**：`base/**` 里任何共享逻辑改动，两个插件的完整门禁都要重跑——mem：`pnpm build:dsh` + `node scripts/mount-smoke.mjs`；work：`pnpm release:check` + mount-smoke。**判据（runtime-base 还是 plugin-local）**：问"这条知识**能不能靠一次底座发布修好**？"——能 → 在运行时从底座取用；不能（只是照抄宿主约定的两三行字面量）→ 可以留在插件里，但必须写明"改它需要发插件"。家族三条硬约束（不变量）：① envinit 式 provision 绝不被 bundle、绝不被插件静态 import；② 底座由框架/宿主提供、按文件 URL 动态加载；③ 发布顺序 base → 两个插件，tarball 不带 `link:`/`file:`。

**一个被这次门禁暴露出来的真问题**：真实 wire face 里可选字段曾写作 `z.union([z.undefined(), X])`，它接受与 `X.optional()` 相同的载荷，却是宿主 JSON-Schema 投影看不见的形状——`z.toJSONSchema()` 直接抛 *"Undefined cannot be represented in JSON Schema"*。真身探针会投影这套 schema，于是健康宿主被读成不兼容；现在这些字段一律写成 `X.optional()`（`test/provision.spec.ts` 对全部 20 个 schema 逐个断言可投影）。


## 13. 仓库结构（pnpm workspace）

```
avantf-mem/
├─ package.json · pnpm-workspace.yaml · tsconfig.base.json
├─ DESIGN.md · README.md · cordis.example.yml
│  （LICENSE 随包走：packages/plugin/LICENSE —— npm 页面与许可证文件都要在包目录里）
└─ packages/
   ├─ retrieval-core/   # @avantf/mem-core —— 可替换检索底座
   ├─ core/             # @avantf/mem —— 引擎
   ├─ contract/         # @avantf/mem-contract —— 契约单源（zod）
   ├─ convert/          # @avantf/mem-convert —— 文档格式 → Markdown（注册表，core 依赖并内联进插件）
   ├─ provision/        # @avantf/mem-provision —— legacy 依赖获取（外部二进制 + 启动预热；DSH 插件默认由 @avantf/dsh-plugin-base 的环境初始化框架提供，见 §12.1）
   ├─ plugin/           # @avantf/dsh-mem —— host + client 两页 UI
   ├─ cli/              # @avantf/mem-cli
   └─ mcp/              # @avantf/mem-mcp —— MCP（可选）
```

## 14. 里程碑

| 阶段 | 交付 | 验证 |
|---|---|---|
| M0 | workspace + `contract` + 配置分层 + `~/.avantf` 布局 + 记忆侧检索 | 目录生成、两库可建、FTS 检索冒烟 |
| M1 | 实体/三元组 + HRR | 单测转 vitest |
| M2 | 记忆混合检索（FTS+实体+语义） | 29 查询 P@k/MRR 对拍 |
| M3 | ONNX BGE + bge-reranker | 维度/归一化正确 |
| M4 | 5 向量库 + auto 升级 | 各后端读写一致 |
| M5 | 生命周期 + 矛盾 + 去重 | decay/archive/contradict 对齐 |
| M6 | `retrieval-core` 内部可替换（注册表/降级/auto） | 切后端零改动业务流 |
| M7 | host 插件（服务+工具+RPC） | 原生三工具 + kb 工具可用 |
| M8 | client 标签页「记忆」 | 页面 CRUD + 时间浏览 |
| M9 | 知识库摄入 + 分块 + 跨库 `query` | 跨库召回 + `source_ref` 正确 |
| M10 | client 标签页「知识」 | domain→source 浏览 + 跨库查询 |
| M11 | CLI | 子命令对齐 |
| M12 | MCP + 挂载示例 | stdio smoke + 挂载成功 |
| M13 | 回归（含跨库用例）+ 打包发布 | eval + vitest 通过 |

## 15. 质量门禁

- **评估集对拍**：Python 29 条中文关系型查询（P@k 0.4425→0.5057、MRR 0.8448→1.0、方向错误率 37.9%→6.9%）搬入测试，每里程碑重跑。
- **同数据跨语言 diff**：`tests/parity/` 同一批事实喂 Python/TS，比对 recall top-k 与三元组。
- **DB 互换冒烟**：Python 写 → TS 读 → 再写 → Python 读。
- **跨库用例**：记忆+文档同 query 命中、`source_ref` 溯源正确。
- **插拔验证**：切 `semantic/vstore/rerank` 后端，业务流不改动、结果一致（允许模型质量差异）。

## 16. 风险

| 风险 | 缓解 |
|---|---|
| ONNX vs torch 嵌入非逐位等价 | 独立重算 + `reindex`；评估集验收 |
| nodejieba POS 一致 | 实测 + 29 查询回归 |
| `node:sqlite` 不保证 FTS5/trigram | 用 `better-sqlite3`；**建表前**做内存库 tokenizer 自检，`trigram` 不可用时降级 `unicode61` 并告警（不污染真实库、也不因 DDL 抛错而打不开库） |
| 两库分离的跨库可比性 | 联合 min-max 归一化；插拔验证用例 |
| client 页打包（外部包） | client 页为第一方 harness 模块 / workspace link |
| 原生 ANN 绑定编译 | 提供 `local_numpy` 降级 + 构建前置文档 |

## 18. 信任与遗忘（自然消退 / 召回加强 / 永久记忆）

规格：[docs/TRUST_MODEL.md](docs/TRUST_MODEL.md)（冻结版，代码即规格）。

- **时钟**：老化按**活跃日**（`avantf_stats.trust_clock`）而不是挂钟。每次"在场"（进程启动 / 心跳）最多计 `trust.presence.gap_cap_days`（默认 1 天）⇒ 常开与日历 1:1，**停机 90 天只老 1 天**。
- **刻度**：`trust ∈ [0,1]`，**0 = 遗忘（归档 `forgot`）**，**1 = 永久**（`pinned`）。新事实 `start = 0.5`，线性 `decay_per_day = 0.5/90` ⇒ 90 个活跃日归零。
- **召回加强**：`≤ recall_floor(0.5)` 直接抬回 0.5，否则 `+recall_delta`（默认 0.03），封顶 `recall_ceiling(0.85)`；**每条事实每 24h 最多 `recall_daily_cap(3)` 次有效加强**，零增益不消耗配额；**召回永不 pin**。
- **显式反馈**：`helpful/unhelpful` 各 `±feedback_delta(0.05)`；累计 ≥ `permanent_threshold(0.9)` → `pinned` 并 snap 到 1.0；`unhelpful` 压到 0 → 立即归档。pinned/archived 只记 `helpful_count`。
- **自动执行**：构造顺序 `presence → tick → reloadIndex`；tick 五段 SQL（结算 / TTL / forgot / idle / purge），常驻进程（插件、MCP）按 `presence.heartbeat_minutes`（默认 60）心跳；`admin maintenance` = 强制全量 pass（报告键向后兼容，新增 `settled/clock/archived_forgot/archived_idle/skipped/archived_deferred`）。
- **预算覆盖全部五段（性能审查第 5 步；⑤ 在实施复核第 3 批补齐）**：`tick_max_facts` 原只约束 ①，而 tick 是**一个** `IMMEDIATE` 事务、与 host/CLI/MCP 共享 `busy_timeout = 5 s`——一次 pass 归档 14400 行就等于把写锁按住那么久。现在 ②③④ 也吃同一预算（`archiveExpiredByTtl`/`archiveForgotten`/`archiveIdle` 各带 `budget`），没做完的部分留在库里并由 `archived_deferred` 报出来（`budget: 0` 的 `admin maintenance` 仍是全量、不设上限，这是"现在就清理"的语义）。留档而不是静默丢弃，是因为"旧事实为什么还活着"必须能从 tick 的返回值回答。
- **五段谓词全部 sargable（同一轮）**：`CAST(settle_clock AS INTEGER)` 换成 `settle_clock < CAST(:clock AS INTEGER)`（对 `settle_clock >= 0` 等价，见 `FactsDao.SETTLE_PREDICATE` 的证明），idle 换成与表达式索引同形的 `julianday(COALESCE(...)) < julianday('now', :modifier)`，purge 的 `CASE` 拆成"活跃日 / 日历日"两支（两支互斥且与原 `CASE` 等价，`archived_clock < :clock - :days` 因此能走 `idx_facts_purge` 的 range）。实测（120k 行）：待结算计数 **5.86 → 0.22 ms**、forget **15.7 → 5.7 ms**、idle **26.7 → 0.7 ms**、purge **10.8 → 0.6 ms**；**但 `settleBudgeted` 本身没变快**（15.5 → 15.8 ms）——那 5000 行的 UPDATE + 索引维护才是它的成本，扫描早已是索引序 + `LIMIT`。整趟 tick 在 33k 语料上 254 → **162 ms**。
- **兜底**：连续 `idle_calendar_days`（默认 365）日历日没被使用 → `archived('idle')`，即使活跃日攒不够也终会清理。
- **永久保护**：`pinned` 不结算、不自动归档、`purge_skips_pinned` 不清理；退出需显式 `admin unpin`。
- **检测队列在库里，不再在内存里（§20.16）**：`ContradictDetector.changed` 只装"等待**嵌入腿**复检"的事实，而嵌入腿在模型不可用时永远跑不了——于是队列每次写入 +1 且永不排空（实测 30 次写入 → 30 条，`contradict_check` 连跑两次仍是 30，即每次补扫都重跑整个积压），并且**随进程消失**（重启后再也拿不到那次检查）。现在队列是 `facts.conflict_checked`，`MemoryStore.checkContradictions(budget)` 有界排水，`trust_diagnose` 用 `conflict_pending` 报"落后多少"；`lifecycle.contradiction_pending_max` / `contradiction_evicted` 随之删除——不是上界被放宽，而是**不再需要上界**（队列不是内存结构），被丢弃的 id 也不再存在（这正是它要消灭的取舍）。**purge（⑤）也纳入 tick 预算**并报 `purged_deferred`——它是单步最贵的一段（老库上每删一行都有 FK 级联查找）且与他人共享同一个 `IMMEDIATE` 事务。
- **排序无关**（D9）：trust **不参与**融合/重排，评测集基线是**精确断言**（`eval_zh.spec` 六项数值冻结）。评测集从 29 条扩到 **35 条**（性能审查 §4.4：原集里汉字数 ≤2 的查询为 0，而 `buildFtsQuery` 对 2 字 CJK 直接返回 `null`——最该被守护的形状恰好没被覆盖；新增名字类/术语类/多命中 2 字查询各若干，实测 P@k 0.477→0.567、MRR 0.931→0.943；其后融合层去掉 min-max 缩放，35 条基线**再次重冻**为 MRR 0.9714、R@k 0.9571，见 §20.17）。**2 字术语里抽取器不认识的那些仍然无腿可用**（如 `缓存`：既可被 trigram 拒绝、也不被 jieba 抽成实体），这是一条**已知缺口**并已被专门测试钉住（`eval_zh.spec.ts` 的 "PINNED GAP"）——修它要引入 LIKE/前缀回退，属于召回语义变更，不在性能审查范围内。
- **运维**：`mem_admin {action:'trust_diagnose'|'pin'|'unpin'}`、CLI `avantf-mem trust|pin|unpin`、「记忆」标签页的徽章 / 剩余活跃日 / 永久记忆 / 立即维护。
- **无迁移**：facts 新列随 DDL 建库生效，改 schema 仍是删库重建（§6）。
- **schema 升级已改为版本化迁移**（§19）：`PRAGMA user_version` + `schema_migrations` 审计，旧库按 step 逐级升级——上一行的"删库重建"作废（§11 的 open 配对唯一索引就是第一个真正的升级 step）。

## 17. 待办（已定，无需再决）

- `kb_answer`（UI/工具“让模型生成带引用答案”）为**后置增强**，默认不实现。
- 若未来要**全本地 RAG**，需另行加本地生成 LLM 模块（非本阶段范围）。

## 19. 数据库访问与 schema 生命周期

**端口，而不是 DBHelper。** 引擎与数据库的对话面是 `db/port.ts` 的 `Db`：`prepare / exec / transaction / pragma / close` 五个方法（正是全仓实际用到的全部驱动 API：104 处 `prepare`、11 `exec`、9 `transaction`、6 `pragma`、4 `close`，且没有任何 `pluck/raw/iterate/columns/function` 之类的语句扩展）。`transaction()` 返回的 runner 带 `immediate()/deferred()/exclusive()`——presence 时钟与生命周期 tick 的跨进程 read-modify-write 必须用 `BEGIN IMMEDIATE`（两进程 presence 测试就是这条的守卫）。**唯一 import `better-sqlite3` 的文件是 `db/sqlite.ts`**：换绑定是一次适配器改动，而不是几十处调用点的散弹。

**刻意不做的事**：不引查询构造器/ORM，也不抽象方言。FTS5（`trigram` + `bm25()` + 外部内容表与触发器）、`julianday`、`INSERT OR IGNORE`、部分唯一索引、`INDEXED BY` 都是**承载语义与性能**的 SQLite 特性（§7 的查询计划修复正是靠 `INDEXED BY`），把它们藏到 helper 后面只会更难表达；端口只固定"怎么调用"，SQL 仍是 SQL。**同步**同样是设计前提：`persistFact` 是一次全同步的写（事务内不 await），tick 是一次同步 pass，异步驱动不适配本端口——**矛盾检测刻意在事务提交之后**跑（`store/memory.ts` 的注释："After the commit, never inside the transaction"），所以它既不延长写锁、也不是"端口必须同步"的原因。（本节此前写成"`persistFact` 在事务内跑矛盾检测"，与代码相反；性能审查把这句话纠正成代码事实。）

**`supersedes_id` 不再是自引用外键（性能审查的 P0 修复）**：它原本是 `REFERENCES facts(fact_id)`（`ON DELETE NO ACTION`），而一次 `update` 会让**活动行引用已归档的旧修订**。于是第 ⑤ 段 purge（`DELETE ... status='archived'`）在修订链跨过 `purge_after_archived_days` 后必然抛 `SQLITE_CONSTRAINT_FOREIGNKEY`——这不是"少删几行"：整趟 tick 是**一个** `IMMEDIATE` 事务，它被整体回滚，而 tick 又是从 `MemoryStore` 构造器里跑的 ⇒ **进程再也起不来**，且没有任何自愈路径。触发窗口有**两个分支、单位不同**（`purgeArchived` 的 `CASE`）：`trust.enabled=1` 且 `archived_clock` 非空时按**活跃日**（默认 365；谓词是严格 `>`，所以即使配 `0` 也要先跨过一个活跃日）；否则按**日历日**（配 `lifecycle.purge_after_archived_days: 0` 时归档后约一秒即成立——这条合法配置下缺陷是**立即**引爆的，已端到端复现）。修复分两半：

- `purgeArchived` **先解引用再删**：两条语句共享**同一段谓词文本**（避免"该删哪些行"在两步之间漂移），都在调用方的 `IMMEDIATE` 事务内，所以外部观察不到中间态。这一步让**老库**（外键还在）不再崩。
- **新库 DDL 不再声明这个外键**（`supersedes_id INTEGER`）：没有任何查询按它过滤，唯一的消费者就是那条 FK 检查。老库保留 `REFERENCES` 与 `idx_facts_supersedes`——SQLite 不能用 `ALTER TABLE` 去掉外键，而删掉那条索引会让老库**仍在**的 NO ACTION 检查从索引 seek 退化成表扫（实测 purge 慢 119×）。老库余留的性能陷阱需一次 `facts` 表重建才能根除，单独立项（重建要连带处理 `facts_fts` 外部内容表与三个触发器），本轮刻意不做。

两条分支各有回归测试（active-day 分支需回填 `archived_clock`；calendar 分支用 `trust.enabled:false` + `purge_after_archived_days:0`，无需回填），另加"新库 DDL 不含该外键"的断言与"链过期后新进程仍能启动"的端到端用例（`test/lifecycle.spec.ts`）。

**schema 生命周期（初始化 / 升级）**：`db/store.ts` 的 `openStoreDb({path, schema, tokenizer})` 统一执行"建目录 → 共享 PRAGMA（`foreign_keys`/`busy_timeout`/`WAL`/`synchronous`）→ 版本检查 → 逐个 step"，任何一步失败即关闭句柄（否则 better-sqlite3 会锁住文件）。版本存 `PRAGMA user_version`，同时把每个已应用 step 记进 `schema_migrations`（审计）；**step、它的版本号与审计行在同一个事务里**，所以不会出现"版本说升级了、数据却回滚了"。step 列表要求 1..N 连续且唯一（`validateMigrations`），配错在启动时就报错。**step 1 是基础 schema，必须保持幂等**：版本机制出现之前的库 `user_version = 0` 但表已在，adoption 只能是一次 no-op + 盖章；memory 的 step 2 是"每个配对只留一条 open 矛盾行"（先去重再建部分唯一索引，见 §11）。两个 store 现在只声明自己的 schema（`MEMORY_SCHEMA`/`KNOWLEDGE_SCHEMA`），不再各写一套 open。

**启动即自动升级（可见 + 被守卫）**：`buildRuntime` 打开记忆库、`KnowledgeStore` 构造器打开知识库，两者都走 `openStoreDb`，所以**插件启动时数据库自动升到本构建的最新版本**，没有单独的"迁移命令"要运维记得跑。升级**发生**时各打一行只读诊断（英文，`[avantf-mem]` 口径）——`memory: schema upgraded 8 → 9 (applied: 9 contradiction-resolved-indexes)` / `knowledge: schema upgraded 1 → 2 (applied: 2 chunk-derived-state-provenance)`；**没有升级时不打**（库已最新是常态，每启动一行会淹掉信号），`describeMigrationOutcome` 仍能给出 `schema up to date (9)` 供测试断言。诊断由已返回的 `MigrationResult` 拼出，不碰数据库、不阻塞、不抛错。

**失败一律降级，绝不阻断宿主**：迁移抛错 → 该步事务整体回滚 → `openStoreDb` 关闭句柄并抛出 → `buildRuntime` 抛出 → 插件 `apply` 的 try/catch 把它变成 `memory unavailable: <原因>`：8 个工具照常注册、每个回答带原因，但没有 `avantfMemory` service（客户端页签也随之不可用）。这是**刻意的**设计，一条实测教训：让 `apply` 抛错会被 DSH loader 当成"加载失败的插件行"，整个 `dsh web` 因此起不来——一个记忆插件的环境问题（库锁住、目录不可写、库比代码新）不该有这种代价。`SchemaDowngradeError`（库 `user_version` 比本构建新）同样走这条降级路径，并在信息里告诉运维"是降级、要升回或恢复备份"。

**改 schema 的两处纪律（本守卫强制）**：新建**表 / 列 / 索引**必须**同时**出现在两处——base DDL（`db/schema.ts` 的 `DDL` / `db/knowledge.ts` 的 `KNOWLEDGE_DDL`，新库由 step 1 得到）**和**一个编号迁移 step（老库由它得到；列用 `addColumnIfMissing`，索引用 `CREATE INDEX IF NOT EXISTS`）。漏掉后者是**静默故障**：step 1 在老库上早已标记执行过，`CREATE TABLE/INDEX IF NOT EXISTS` 对已存在的对象是空操作，于是新对象只进新库、老库永远没有，直到运行时才以"列不存在"的形式爆出来。`db_upgrade_parity.spec.ts` 就是抓这个的守卫：它从一个**冻结的 v1 基线**（`test/fixtures/schema_baseline.ts`，base DDL 去掉所有后续 step 的成果）造出每个中间版本 k 的老库，用完整迁移列表升到最新，再与**全新库**做整体 schema 平价（规范化比较 `sqlite_master` 的 `type,name,sql`，忽略 `sqlite_autoindex_*`/FTS 影子表等内部对象与空白/注释差异；表的列与约束定义**排序后**比较，以吸收 `ALTER TABLE ADD COLUMN` 只会追加的事实）。守卫**不能**用 `migrate(schema.migrations.slice(0, k))` 造老库——那样 step 1 用的是同一份（被改过的）DDL，新对象在两侧都有，变异测不出来；冻结基线是唯一能看见"老库真的没有它"的参照物。变异验证：临时只往某 store 的 base DDL 加一列或一个索引而不加迁移 → 守卫红；复原 → 绿。

**DAO 层（已完成）**：端口之上按聚合一个 DAO，**业务 SQL** 全部落在 `db/dao/`：memory 侧 `facts`/`entities`/`triples`/`contradictions`/`stats`，knowledge 侧 `documents`/`chunks`（含 `chunk_entities` 与两条 `doc_chunks_fts` 腿）。schema DDL 与迁移 step 按定义留在 `db/{schema,conn,knowledge,migrations}.ts`，`db/tokenizer.ts` 自带一段建在 `:memory:` 上的分词器探针——这两类不是"某个聚合的查询"，不该塞进 DAO。**两个 store 与 `lifecycle/*` 现在都是零内联 SQL**：只做业务编排（分块、抽实体、编码、融合、打分），每次取数/落库经 DAO 方法。DAO 只依赖 `Db` 端口，因此仍不承诺换方言，但"换调用形状/加审计/批处理"是改一处而不是扫全仓；`batches()`（`db/chunk.ts`）统一处理会随语料增长的 `IN (...)`，避免绑定参数上限静默废掉某条检索腿。

**迁移 step 4：列表排序与冲突查找的索引（性能审查第 4 步）**。四条改动，每条都带"为什么不是别的做法"：

- **`idx_facts_created(status, created_at DESC)`**：`list` 的 `ORDER BY created_at DESC LIMIT ?` 原先没有可用索引，planner 把整个 status 集合排序（33k 行、行内含 8KB blob 时实测 124 ms → 2.1 ms）。
- **同一查询必须 `INDEXED BY`**：这是个反直觉但实测的结论——**一旦 `sqlite_stat1` 存在，planner 会把这条查询翻回 `SCAN facts` + temp b-tree**（33k 行下复现），而 lifecycle tick 每次都调 `PRAGMA optimize`，也就是**每次启动都会建立统计并把修复悄悄撤销**。所以 `page()` 的**未过滤**分支钉死 `INDEXED BY idx_facts_created`。**有 category** 的分支刻意不钉：planner 用 `idx_facts_status_category` 只取该 category 的行再排序（亚毫秒），而钉 created_at 索引会改成"按时间序走整个索引并逐行过滤"（实测一个只有 17 行的 category 在 33k 库里要 9.8 ms）——为省一个索引把快路径换成慢路径是坏交易。两个形状因此拆成两条语句，也让 `(? IS NULL OR category = ?)` 这个让成本模型失准的谓词消失。
- **删掉 `idx_facts_idle`**：它无事可用——idle 谓词把列包在 `COALESCE` + `julianday` 里（`FactsDao.archiveIdle`），生产谓词的 plan 实际走 `idx_facts_purge(status, pinned)`。它唯一的作用是让**每次召回**的 `touchUsage` 多维护一个索引（实测 40k 行 46 µs → 36 µs）。老库由 step 4 `DROP INDEX`。
- **`idx_contradict_fact_a` / `idx_contradict_fact_b`（非 partial）**：`idx_contradict_open_pair` 是**部分**唯一索引，所以 planner 既不能用它服务 `(fact_a = ? OR fact_b = ?) AND (resolved = 0 OR resolved_by = 'verdict')`（`OR resolved_by` 不蕴含 `resolved = 0`），也不能用它服务**外键的 CASCADE 检查**。两个普通索引让这些形状都变成 MULTI-INDEX OR：suppress 60.8 → 0.06 ms、`resolveForFact` 9.4 → 0.14 ms（10 万 open 对），purge 的 `DELETE` 计划里两次 `SCAN contradiction_log` 也变回 SEARCH。**只加 partial 索引是无效的**——这条被实测证伪，`scripts/bench-indexes.mjs` 保留那个反例。
- **`suppressedPairsFor(factId)`**：单条写入只可能与自己相关的配对冲突（`maybeLog(fid, other, …)`），读整个日志是纯浪费（10 万 open 对时 60.8 ms/次写 → 0.06 ms）。批量扫描 `check()` 仍读全量一次。
- **`resolveForFacts(ids)`**：每个归档 id 一条 UPDATE 的循环是 O(归档数 × 日志)，且在 tick 的**单个** IMMEDIATE 事务里（实测 1000 个 id、10 万 open 对：逐条 88.3 ms → 两条语句/500 个 id 的 6.6 ms，关闭 1859 行完全相同，因为"哪一侧匹配就用哪一侧做 loser"）。


**预编译语句缓存（性能审查第 7 步）**：better-sqlite3 **没有**自己的语句缓存——每次 `prepare()` 都新建 `Statement` 并跑一次 `sqlite3_prepare_v3`（实测 6–8 µs，而复用一条语句只要 0.4 µs）。DAO 是按调用点现 prepare 的，一次检索约 20 条、一次写入 15–22 条，于是"编译"成了每次调用的固定税。缓存放在端口适配器里一处（`db/sqlite.ts`），键是 SQL 文本：键空间由代码里那 ~40 个 `.prepare(` 站点加上 `batches()` 产生的几种 `IN (...)` 宽度构成，天然有界；端口没有游标 API，所以复用语句对 `all`/`get`/`run` 都可重入；`close()` 时整表清空（语句依附于该句柄）。

**不存在 `count(sql)` / `query(sql)` 之类"把 SQL 交给调用方编译"的透传**：诊断报告要的每个数字也是 DAO 上意图命名的方法（`countActive` / `countPinnedActive` / `countForgettingWithin` / `countReinforcedToday` / `sumBonusGrantedToday` / `countIdleCandidates`）。透传看着省事，实际两头不占：SQL 文本留在 store 里，任何"统一批处理/加审计/改调用形状"的动作都还得回到 store 改，而 DAO 却接受任意语句（不批处理、不类型化、不可审计）。

**留在 store/lifecycle 的 `db` 用法只有两类**：跨 DAO 的 `db.transaction(...)`（`store/memory.ts` 三处、`store/knowledge.ts` 的 ingest、`lifecycle/presence.ts`、`lifecycle/tick.ts`）与维护命令 `db.pragma('optimize')`（`store/memory.ts` 的 tick/maintenance 收尾）。前者是编排的原子边界，跨多个 DAO 时它不属于任何单个聚合，`presence.ts` 的 `tx.immediate()` 也正需要在这一层表达；后者不是查询，而是"刷新 planner 统计"的落库动作（§7 的 130 ms → 0.08 ms 正靠它）。`db/vectors.ts` 的 `reloadVectorIndex` 同样改为接收 DAO 读出的行，自己不再跑 SQL（两个 store 共用同一段 dim 校验/跳过逻辑）。

## 20. 模型面文本的预算、派生状态与自评

参考实现（OpenViking，AGPLv3）在"上下文工程"上有三处值得吸收的做法，本节记录**移植后的形态**与不做的事。所有实现均为自写，只借设计。

### 20.1 输入上界（嵌入与重排）

**问题**：transformers.js 在超过模型窗口时**静默截断**（`feature-extraction` 与 `text-classification` 都以 `truncation: true` + tokenizer 的 `model_max_length` 分词）。发版模型 `bge-small-zh-v1.5` / `bge-reranker-base` 的窗口是 512 token，而中文约 1 字 1 token——800 字的块只有前 ~510 字进入向量，无异常、无日志，且 FTS 索引的是全文，所以"释义式提问命中尾部"会漏而无人察觉。

**做法**：`retrieval-core/src/text_budget.ts` 提供机制（CJK 感知估算 → 在句/逗边界处截断 → 解析有效窗口），adapter 负责应用与告警：

- `LocalBgeBackend.encode()` 在送模型前按 `窗口 − 2`（`[CLS]/[SEP]`）截断，超限时 `recordTruncation('embedding')` 并只告警一次；
- `LocalReranker` 对 `[query, doc]` **成对**序列计量：文档预算是 `窗口 − query − 3`（query 永不截断，否则改变被评分的问题本身），下限 16 token；
- 窗口来源优先**已加载 tokenizer 声明的 `model_max_length`**，其次配置，最后 512；配置 `semantic.max_input_tokens` / `rerank.max_input_tokens`（0 = auto）只能**收紧**，永不放宽。哨兵值（1e30 之类）视为未声明。

**配套**：`knowledge.chunk_size` 默认从 800 改为 500 —— 由发版模型的窗口推导（512 − 2 特殊 token，留余量取整），并由 contract 测试断言 `chunk_size ≤ DEFAULT_MODEL_WINDOW_TOKENS − 2`，避免以后有人凭手感调大。`chunk_overlap` 按同一比例保持 10%。

### 20.2 输出预算（检索结果）

`retrieval-core/src/budget.ts` 的 `fitToTokenBudget`：单条上限 = 平均份额 ×2（分数带很窄，把整个预算给第一名是坏赌注），先给每条最小份额，再用剩余预算从高分到低分"加深"；**超预算只降级文本、不丢条目**——条目仍带 `source_ref`，调用方知道它存在并能显式取回。被缩短的命中带 `truncated: true`（与 20.1 的静默截断相反，这里必须可见）。

预算来源：配置 `retriever.max_output_tokens`（默认 8000，0 = 不限）+ 按次参数 `max_tokens`（`recall.search` / `kb_query`）。跨库查询在**融合之后**应用预算（逐腿限流会让知识侧的 token 花在随后被融合丢掉的命中上），因此 `runtime.query` 把两条腿的预算抬到 0 再统一收口。

### 20.3 派生状态与增量重建

`doc_chunks` 新增三列（knowledge 迁移 v2，基表 DDL 同步更新）：`content_hash`（**只看正文**，绝不含时间戳/path）、`embedding_model`（**向量空间标识** `backend/model/dim`，不是后端名）、`entities_version`（抽取规则版本，`ENTITY_EXTRACTOR_VERSION`）。

`reindex` 因此从"无条件全量重做"变成按行判定：实体只在摘要或版本变化时重抽，向量只在缺失、空间不符或正文变化时重编码；`dry_run` 只报告计划不写入（含不重建 FTS）。报告区分 `vectors_stale`（计划）与 `vectors_encoded`（实际），模型不可用时两者不等——报告不会把"做不了"伪装成"没活干"。

迁移路径是**一次自我修复**：老库三列为 NULL ⇒ 首次 reindex 全部视为过期，之后即收敛。

`content_hash` 的**实际触发面很窄**，注释里写明以免被误当作增量的主要依据：`ingest` 永远是"删块 + 插新块"而非原地改 `doc_chunks.text`，所以重摄带来的变化表现为**新行**（无向量），而规则变化由 `entities_version` 覆盖；摘要只在**绕过 ingest 的文本改写**（手工改库、或将来的原地编辑）上才触发——那正是"向量描述着已不存在的文本"这一必须防住的场景，`knowledge.spec.ts` 直接改行把它钉住。

事实侧同样记录向量空间（`facts.embedding_model`），并且**可修**而不只是可见：`vectors_diagnose` 把"字节可用但空间不符"单列为 `space_stale`（与维度不符的 `stale` 分开），`vectors_fix` 在拿到模型时清掉并重编码这些向量、报告 `space_stale` 计数，`dry_run` 先给数量。**不放在打开时做**：启动时的重载仍只按维度过滤——否则每个老库升级后语义腿都会被静默清空——只在进程内告警一次，并说明这些向量**仍在参与排序**。

### 20.4 写入侧自评（正交双指标）

`core/src/eval/write_metrics.ts` + `test/write_side_eval.spec.ts`：用**不参与解析的身份 token**（`category`，不是正文里的标记——正文标记会落进抽取器解析的主谓宾，实测 5 种写法里 4 种会压掉它本该触发的信号）给每个语句一个身份，对每个场景同时评两个**刻意独立**的指标：

- `action_success`（结构）：该发生的操作发生了（新修订已归档、配对已开、配对已关），只看计数；
- `information_integrity`（内容）：每个语句**恰好存活一次**——`live` 在活动语料里恰好一次，`retired` 在归档里存在且不在活动语料里。

合成分数会掩盖"哪一半坏了"；这两个指标各自可单独失败。该套件上线即发现一个真实缺陷：`false_positive` 裁决后的配对会被后续 sweep 重新打开（pending 集合在嵌入不可用时永不清空），因此 `contradiction_log` 增加 `resolved_by`（memory 迁移 v3，老行回填 `auto`）：`auto`（事实离开语料，restore 后允许再检出）与 `verdict`（显式裁决，sweep 不得复活）由此区分。

**场景必须是可置换的，而这一条由测试强制。** 五个场景共用一个 store，因此"某个断言只在它恰好第一个跑时才成立"是**关于顺序的断言，不是关于写路径的**——上一轮就真的发生过（`archived_reason_count` 在整库上计数）。现在：

- 每个场景**自足**：自己的身份 token（跨场景唯一）、自己的主题，因此可以任意次序执行；
- 每个观测**只落在该场景命名的事实上**（`live` + `retired`）：档案原因与 `open_conflicts` 都按 token 作用域化，整库计数一律不用；
- 场景内部的动作作用于**自己的那一对**（`ownPair` 按事实 id 找配对），而不是"列表里的第一条"——后者在换序后会把裁决落到别的场景的事实上；
- 套件跑**六个顺序**（自然序、逆序、以及四个轮转，保证每个场景都当过一次第一个）并断言**整份报告逐字节相同**（含 detail，所以数字变了即使仍通过也会失败）。

不跑全部 120 种排列：每个顺序都是一整趟写路径（含抽取），而轮转已经让每个场景与每一个邻居分离过。反证：把 `open_conflicts` 还原成整库计数，逆序即报 `order 4,3,2,1,0` → `action_success_rate` 0.6，失败用例的 detail 直接写着 `open_conflicts=1 expected 0`。

### 20.5 检索健康度

`retrieval-core/src/stats.ts` 的进程级计数（与 `retrievalLogger()` 同风格）：每腿的查询数/空结果/命中数/时延、语义腿在线率、重排使用与回退、三类截断（嵌入/重排/输出）。两条 store 的 `search` 记录，`mem_admin stats` 的 `retrieval` 段与设置页「检索健康度」呈现，`maintenance()` 与 runtime shutdown 落 `avantf_stats` 快照、store 打开时恢复——**不重蹈参考实现"重启即清零"的覆辙**，否则长期降级会被看成健康进程。

### 20.6 向量库规模（证据而非感觉）

`scripts/bench-vstore.mjs` 测 numpy vs hnswlib 的构建/查询/召回：2000 条（dim 512, k=50）时 3.3 ms → 0.83 ms 而 recall 0.999（复现另一台机器上为 2.7 ms → 0.83 ms：**比值随 CPU 变，绝对值才可对照**，判断阈值时应自己重跑脚本而不要引用本行的数字），故 `auto_thresholds.hnswlib = 2000` 成立；不往下调的原因是原生索引**构建**约 0.9 s（8000 条时约 8 s；升级与每次批量驱逐都要付），且几百条时暴力检索已是亚毫秒。8000 条时 recall 降到 0.89——大语料该动的是 `hnswlib_ef_search`。

**同时修掉一个真实缺陷**：adapter 从未调用 `setEf`，于是走 hnswlib 自己的默认 `ef = 10`，在该语料上只能召回 0.45 的真 top-10——"为加速升级到 ANN"实际是**召回悬崖**。现在按 `max(ef_search, 8k)` 设置搜索束宽（默认 256），并由 `hnswlib.spec.ts` 的召回测试钉住（反证：把默认降到 16 该测试失败）。

**束宽缓存必须按索引实例做键**：`reindex()`/`rebuild()` 是**替换**原生索引，而新索引的 `ef` 回到 hnswlib 的默认 10。缓存若只记数字，`setEf(256)` 会被判为"已生效"而跳过——于是**每次归档/清除/重摄/`kb reindex` 之后**召回静默掉回 0.44，`vectors_diagnose` 也看不出来。故 `ef` 与"在哪一个索引上生效"一起缓存，并由 `hnswlib.spec.ts` 的"替换索引后束宽仍然生效"一条钉住（反证：还原为只比数字，该测试得 0.51 < 0.95 而失败）。`vectors_diagnose` 增加 `store` 与 `space_stale`，让后端迁移与换模型都可见。

**驱逐改为墓碑，不再重建整张图（性能审查的修复）**：`removeMany` 曾对每次驱逐做一次全量重建，实测 8000 条时**删 1 个 id 花 6.3 s**（`remember update`、`archive`、tick 的批量驱逐都走这条路）。现在用 `markDelete` 墓碑：被删标签立即从 `searchKnn` 结果中消失，但图结构不动 —— 实测 **1000 个 id = 0.19 ms**（`bench-vstore` 现在直接测这一项，并断言 `rebuilds_after_one = 0`，把机制而不是耗时钉住）。墓碑仍会被遍历、仍占空间，所以 `maybeCompact()` 在墓碑超过 `max(256, 活的 20%)` 时做一次真正的重建；`compact()` 也作为公开的"立即压实"入口。`add` 同一个 id 会取消墓碑（对绑定实测过）。

**迁移改为惰性**：`auto` 过去在 `rebuild()`（启动路径）和 `add()`（写路径）里就地把 numpy 升级成 hnswlib，于是**每个进程启动**都要付一次全量构建（实测 2000 条 0.75 s、8000 条 6.3 s、16000 条 14.7 s），连 `avantf-mem list` 这种根本不检索的命令也付。现在跨界只记"欠一次升级"，真正构建发生在**第一次 `topk`** 或显式 `prepare()`；端到端实测（4000 条向量）：启动 103 ms、`remember update` 11.3 ms。`bench-memory --mode vec` 的 `startup` 与 `update` 两列就是这条的守卫。

**原生索引落盘（`attachPersistence`）**：图是可序列化的结构，过去却从不落盘。现在两个 store 各自把快照放在**自己的数据库旁边**，文件名含**向量空间**（`<db>.memory.db.<space>.hnsw`）：换模型/换宽度会落到另一个文件名，不可能加载另一个空间的图。快照是否可用由**指纹**判定——id 集合**加上每行向量抽样 8 个坐标**。只比 id 是不够的：`kb reindex` 换文本后 chunk id 一个不变，只有向量变了，只比 id 就会加载一张描述"已不存在文本"的图（这条有专门测试）。读取一律 `readIndexSync(path, false)`（`allowReplaceDeleted = true` 时，重新添加一个快照里标记为删除的标签会抛错，实测）；写入走"临时文件 + `rename`"，因为同一 data home 可能有多个进程；`shutdown()` 里 `flush()` 一次（实测 8000 条约 1.5 ms）。端到端：4000 条向量下首个查询从 3128 ms（现建）降到 51 ms（恢复），快照 8.8 MB。

**落盘带出一个新陷阱**：`readIndexSync` 之后 `ef` 又回到默认 10，而 `efOn` 指的正是**同一个对象**（在同一实例上加载，实例键不会变化）——只靠实例键这一层会判"已生效"而跳过重放。所以 `restore()` 必须显式清 `efOn`；`hnswlib.spec.ts` 的"从快照恢复后仍能召回"一条守着它。

**快照是单文件、文件名即指纹（实施复核 §3.5 的修复）**：第一版把指纹写进一个 sidecar，并拿它与**当前语料**比对——meta 与它伴随的图之间没有任何绑定，交错的两个写者可以留下 `(index_B, meta_A)` 并通过校验。现在指纹直接进文件名（`<prefix>.<fingerprint>.hnsw`）：**一次 rename 就是全部提交**，另一个行集的快照在**另一个文件名**下（找不到就是找不到），其他行集的旧快照会被尽力清理。快照前缀里的向量空间用 `encodeURIComponent` 转义（有损替换会把 `a/b` 与 `a_b` 映射到同一个名字，正是"空间进名字"要防的碰撞），且 `:memory:` 返回 `null`（否则会在进程工作目录写出 `:memory:.…hnsw`）。

**墓碑计数必须来自图本身（实施复核 §3.6 的修复）**：图比进程活得久，所以"我有多少墓碑"不能是**本会话**的集合。实测四会话 × 100 次驱逐：live 1200 → 800 而原生图始终 1200、计数器每次都读 100，永不压实。现在计数是**推导量**（`graphElements − live`）：restore 时用 `getIdsList().length`（**包含**已删 label）播种，只有图真的新增元素时才 +1——这顺带修掉本改动自己引入的一个记帐 bug：重新添加一个已墓碑化的 id（不在 live map、但在图里）曾被当成新元素。于是第 3 个会话在**累计**死点比例越过阈值时压实，报告值与图一致。`compact()` 同时纳入 `VectorStore` 可选接口并由 `admin maintenance` 调用（"现在就清理"的语义），不再只有测试用它。

### 20.7 明确不做

- **不引 LLM 进核心路径**：意图分析、摘要生成、rerank 服务都留在可选位置；核心检索在无模型时仍完整（降级到 FTS + 实体）。
- **不做自动注入**：模型面文本仍只由显式工具调用产生——`systemPrompt` 里只有一个**用法**段落（何时该记、何时该先检索，§10），不放任何保留/衰减描述。
- **不抄服务端形态**：多租户、ACL、OAuth、加密、VFS 挂载与路径锁对嵌入式单用户是纯复杂度。
- **AGPLv3 代码不落地**：参考实现只提供设计与数字，实现全部自写。

### 20.8 评审后补的四处

§20.1–20.6 落地后逐条复读实现与测试，补了四处。共同点是**每一处都靠"新加的测试能不能抓住回归"来确认**，而不是靠读代码通过。

1. **判决要有出口，出口要带得住 id**（§20.4 的延伸）。`mem_remember` 的 `contradictions[]` 增加 `contradiction_id`：裁决动作只认行 id，而写路径本来就知道它——原来的 payload 只给 `other_fact_id`，刚写出冲突的调用方还得绕一趟 `mem_recall contradict` 去取。同时修掉 `contradict_resolve` 的字段描述：它原先写"来自 `mem_admin` 的 `list`"，而 `list` 列的是**事实**，永远产不出 id（模型面引用了不存在的东西，正是本仓库契约测试防这一类问题的初衷）。`true_positive` 不带 `loser_fact_id` 的语义（确认冲突但不判哪条错、两条都留、配对永久关闭）由 `lifecycle.spec.ts` 写定。
2. **输出预算第二趟的两件事要分开**（§20.2 的延伸）。`fitToTokenBudget` 里 `grow < 4` 时用 `break` 会连后面的条目一起放弃——"这一条已基本完整"（`continue`）与"没有预算可花了"（`break`）是两回事。`budget.spec.ts` 用一条"首个被截断的条目只剩 1 token 可补"的构造钉住（反证：还原为 `break`，第三条停在 10 字符而断言要求 > 12）。
3. **断言不得被静默跳过**（§20.4 的延伸）。`write_metrics` 的 `archived_reason_count` 原先只在 `archived_reason` 存在时读取，于是"什么都没归档"这种独立写法（本就该由计数表达）不产生任何检查。现在单独给出时表示"任意原因"的计数，并由一条针对该形状的单测钉住。
4. **健康度要有一条覆盖 live 分支的测试**（§20.5 的延伸）。除本例外，所有套件都在模型关闭下运行，`semantic_live_rate` 只被断言过 0——而"语义腿到底活着没有"恰是这个计数器存在的理由。`retrieval_budget.spec.ts` 用 `buildRuntime({ semantic })` 注入一个常在线的后端，断言 `degraded === false` 且 `semantic_live_rate === 1`。

### 20.9 评审后补的第二轮

第二轮复读的是**"报告与断言是否真的说了它该说的话"**，三处都属同一类：机制正确，但读它的人会被误导或被顺序绑架。

1. **预演不能读成"修不了"**（§20.5 的延伸）。`vectors_fix` 的 dry-run 故意**不加载模型**（否则一个声称"只诊断不写入"的动作会去下载），于是它只能回答"此刻是否已加载"。只给 `semantic_available` 会让操作者把 `false` 读成"这次修复不可能"，而真实执行会先热身、很可能成功。现在报告同时给 `would_warm`（在任何热身**之前**计算，两种模式都报）：`would_warm=true` + dry-run 表示"要真跑才知道"，`would_warm=true` + 真实执行 + `semantic_available=false` 才是"热身试过并失败"。`VectorsFixReport` 因此从内联返回类型提为具名类型，两个字段的语义写在它上面。
2. **写入侧指标必须与场景顺序无关**（§20.4 的延伸）。`archived_reason_count` 原先在整库上计数，而五个场景共用同一个 store —— 单独给出的 `0` 只因为"它恰好是第一个跑的"才成立，换个顺序就会因别人的归档而失败。现在观测里的归档原因**带身份 token**（`{token, reason}`），计数只落在该用例自己命名的 `live`/`retired` 上；"这个用例的两条事实里没有一条被归档"本就是它真正要断言的东西。一条纯单测（构造一个含无关归档事实的观测）把"忽略无关事实"与"自己命名的事实仍然被强制"两个方向都钉住。
3. **裁决要能从页面到达，摘要要带得住句柄**（§20.4 的延伸）。裁决此前只有模型工具与 CLI 能到，而设置页的矛盾列表已经握着 id：每行加「判 #a 错 / 判 #b 错 / 误报（两条都对）」三个动作，命名输家的两个标为危险态（会归档该事实），`after` 钩子复用 `mutate` 刷新该列表（`runReactAction` 的 `refreshFirst` 只刷事实页）。写冲突的一行摘要同时带上配对 id（`#4 @0.95（矛盾 #3）`，旧 host 无此字段时回退原格式）。
4. **返回形状与描述必须说同一件事**（§20.8 第 1 条的同类）。逐动作类型一落地就暴露 `recall.related` 返回的是**共现实体与次数**（`{entity, count}[]`），而工具描述写的是"找与实体相关的事实"——模型会因此期待可引用的命中（`ref_id`/`content`）却拿到一张实体表。类型只修好了内部调用方，**模型面的那句话仍须单独改**：`related=列出与该实体共同出现的其他实体及共现次数（是实体清单，不是事实本身）`。`recall.spec.ts` 的用例相应去掉强制类型转换并断言键集恰为 `{entity, count}`，把这个形状钉住。

另有一处**门禁本身没有生效**：本轮新增的 `tsconfig.test.json` 由 `pnpm typecheck` 驱动，而 CI 只跑 `pnpm build` 与 `pnpm test` —— 本地抓到 5 个问题的同一条命令，在流水线里一次都不会跑。`ci.yml` 已补上 `pnpm typecheck`，位置在 build **之后**（包的 `typecheck` 经 `lib/*.d.ts` 读依赖，声明必须先产出）。

### 20.10 第三轮：把三处"靠人读"的风险变成机器可查

§20.9 结尾列出的三条残留风险，共同点是**当前值恰好正确、但没有任何东西阻止它变错**。逐条处理，其中一条已有现成活例。

1. **分发类型的断言换成检查**（§20.9 的延伸）。`return { ...api, remember: api.remember as RememberDispatch, … }` 里的 `as` 绕过了校验，所以"发明一个返回类型"（`related` 曾声明成 `Promise<RecallResult>`）可以编译并欺骗所有调用方。现在每个成员写成 `StoreResult<Store, 'method'>`（即产生它的那个方法的 `Awaited<ReturnType>`），而**没有任何 store 方法产生**的两个 payload —— `{error}`（`DispatchError`）与 `admin.stats`（`AdminStatsResult`）—— 具名并在返回处用 `satisfies` 断言。反证：把 stats 的 `retrieval` 改名，构建即失败（`TS2353`）。
2. **plugin 全无 typecheck 覆盖，原因是一个写错的断言而非真实不兼容**（§20.9 的延伸）。`src/remote.ts` 把 wire schema 断言成**本包**的 `z.ZodType`，而该字段由**harness** 的 zod 定型：plugin 锁 4.4.3、harness 自带 4.6.2，两者之间 `ZodType` 增了成员，所以那个 cast 永远不可能可赋值。改断言成 `TypertSchema['schema']` 后 `tsc -p packages/plugin/tsconfig.test.json` **干净**，plugin 的 src 与 spec 首次进入检查。`pnpm typecheck:dsh` 是这条门禁；它需要 DSH harness，因此留在本地步骤（CI 没有 harness），并在 AGENTS.md 写明，而不是悄悄放弃。
3. **`css.detail` 用在一个从未定义过它的样式表上**（本轮新引入）。CSS module 声明此前是 `Record<string, string>`，于是任何类名都能通过类型检查、运行时解析为 `undefined`，元素静默丢掉样式。现在声明列出确切的 21 个类，补上缺失的 `.detail` 规则（纯堆叠容器，字体由子元素承担），并由 `test/css_module_types.spec.ts` 从 `pages.module.css` 反推键集、两侧任一漂移即失败（反证：加一条 `.ghost` 规则，测试点名它）。

### 20.11 统一到一个 zod（contract 3 → 4.4.3）

**问题**：插件进程里同时驻留**两个大版本**的 zod —— `3.25.76`（contract，用于 `spec.input.safeParse`）与 `4.4.3`（plugin 自己的 Typert wire face），harness 还自带 `4.6.2`。同名类型三个身份，§20.9 那个"永远不可能可赋值"的 cast 就是它的产物。

**约束与决策**：不能反向统一（harness 要求 v4 wire codec），所以只能全部升到 v4。关键是**两个包必须解析到同一份物理拷贝**，而"同版本"不能靠人守：版本现在写在**根** `pnpm-workspace.yaml` 的 `catalog:` 里（合并四个仓之后是 `zod: 4.6.5`，**精确、非 caret**，跟随已安装 dsh 的版本；本节写作时的值是 `4.4.3`），所有消费方都写 `"zod": "catalog:"` —— 想不一致都做不到。用 caret 会解析到 4.6.x，于是又出现"两个 v4 副本、`ZodType` 差成员"的同一类问题；catalog 同时把工具链（`typescript` / `@types/node` / `vitest`）与全部第三方运行时依赖收在一处，使"这个项目跑在什么上面"只有一个答案。`pnpm why zod` 现在给出一份（contract + dsh，合并后 work 也共用它），MCP SDK 自带的 `4.5.4` 是第三方树——我们只把**纯 JSON Schema**交给它，不传 schema 对象——harness 自带的那份（本节写作时是 4.6.2，现在是 4.6.5）在仓库之外。

**迁移只在两个文件**（已实测）：`contract/src/tools.ts` 的派生器与 `plugin/src/tool_schema.ts`。v4 的映射是：`def.type`（小写）取代 `_def.typeName`；`def.shape` 是**对象**而非函数；字面量的值在 `def.values`；`ZodEffects` 分支消失（本仓无 `refine`/`transform`，属死代码，直接删）。**失败仍是静默的**——读错键不会抛错，只会把每个字段压成 `{}`——所以判据是钉死的形状断言（contract 29 条 + plugin 16 条），迁移开始时它们正好报了 6 处失败。

**两个必须记住的点**：

- **`z.toJSONSchema` 必须传 `io: 'input'`**。它决定 `required`：带 `.default()` 的字段在**输入**侧是可选的（这正是 `safeParse({})` 的行为），在输出侧才是必有。默认 io 会把每个有默认值的字段标成必填。字段级 JSON Schema 现在由它生成，手写的 `switch (typeName)` + `constraintsOf` 整段删除——MCP 与 DSH 两侧从此共用一个机制，而不是两套手写。另外 v4 会给每个无上界的 `z.number().int()` 挂 `maximum: 9007199254740991`（意为"无上界"），已剥离，免得模型去读一个没有意义的限制。
- **`.default({})` 必须改成 `.prefault({})`**（config 里 10 处）。v4 不仅把 `.default()` 的校验基准改成输出类型，还**不再把默认值过一遍 schema**：`sub.default({})` 现在得到裸 `{}`，而 v3 会填好子 schema 自己的默认值。写成字面量则等于把每一层默认值抄两遍（漂移源），`prefault` 才是等价的。**

**残留**：harness 的 zod（4.6.2）仍是仓库外的另一份 v4，所以 `TypertSchema['schema']` 那句断言保留（§20.10 第 2 条）。要让那句也消失，得把 dsh 变成 workspace 依赖——那是另一个决定。

### 20.12 第四轮：结果类型入 contract，设置页不再手抄

§20.10 把"每个 action 返回什么形状"钉在了产生它的 store 方法上（`StoreResult<Store, 'method'>`），但形状本身仍然是**匿名的**——内联在 store 的返回位置，或具名却留在 `core`。于是设置页没有任何东西可 import，只能**手抄一份镜像**：`FactRow`/`FactDetail`/`DocRow`/`DocDetail`/`ContradictionRow`/`StatsRow`/`RetrievalHealthRow`/`RecallHit` 八个 interface。

这不是洁癖问题，仓库里已有活的漂移：设置页的 `RetrievalHealthRow` **少了 `rerank_fallback`**，而服务端的 `RetrievalHealthSummary` 一直带着它——两侧都编译通过，那个字段永远不会被渲染出来，也没有任何东西会红（与 `css.detail` 同一类：一个从未被定义的镜像名）。

现在按 AGENTS.md 的约定（"每个 UI payload 类型都从 `@avantf/mem-contract` 派生"）把 15 个形状命名入库：`KindHealth` / `RetrievalHealth` / `RetrievalHealthSummary` / `StatsSummary` / `FactPage` / `TrustDiagnostic` / `VectorsDiagnostic` / `VectorsFixReport` / `IngestResult` / `ImportResult` / `ReindexReport` / `DocumentSummary` / `DocumentRecord` / `DocumentChunk` / `DocumentDetail`。随之：

- **retrieval-core 只留下计数**：健康度的类型上移到 contract（设置页要渲染它们，而 contract 是唯一能被 UI 依赖的那一层），`stats.ts` 不再自己声明形状。
- **store 返回具名类型**，因此"实现"与"声明"不可能分叉；DAO 的 `DocumentRow`/`DocumentDetailRow` 变成 contract 类型的**别名**——在 DAO 里加一列而不更新 contract，是类型错误，而不是悄悄多出一个字段上到线上。
- **设置页删掉八个镜像**，改成 `import type`（`verbatimModuleSyntax` 下会被完全擦除：客户端 bundle 只增 70 字节，仍然只运行时依赖 `@avantf/mem-contract/remote` 子路径）。
- **边界上的 cast 一并消失**：`callRemote<FactPage>` / `<StatsSummary>` / `<RecallResult>` 让类型从泛型参数来，删掉 `as StatsRow`、`as FactDetail`，`admin.detail` 的 `{error}` 分支改用 `'fact_id' in value` 收窄而不是双重 cast。

**刻意不做**：Remote 边界的**请求**仍写 `Record<string, unknown>`。把它按 action 收窄需要改线上 API 形状（每个 action 一个 Remote 方法，或一张请求/响应映射表），而宿主 `call()` 返回的本来就是 `value: unknown`；现在只把**返回**诚实标成 `RemoteEnvelope<unknown>`，类型断言集中在 `unwrapRemoteEnvelope<T>` 这一处（它本来就负责容忍各种网关形状）。

### 20.13 第五轮：性能审查（两个正确性缺陷 + 把基准长期化）

对整个记忆系统做了一轮性能审查，完整报告与逐项证据在 [`docs/PERFORMANCE_REVIEW.md`](docs/PERFORMANCE_REVIEW.md)（含实测数字、机制、规模拐点、最小修复、以及一处**被实测证伪**的直觉方案）。本节只记**已实施**的部分与结论性的设计决定。

**① 一个会让系统起不来的缺陷（已修，见 §19 末段）**：purge 撞 `supersedes_id` 自引用外键 ⇒ 整趟 tick 回滚 ⇒ 构造器里的 tick 让**进程无法启动**、且不自愈。修法是"先解引用再删 + 新库不再声明该外键"，两条分支各一条回归测试，外加端到端"重启仍能开库"用例。

**② 健康度计数曾把"腿"当"用户查询"（已修）**：`kb_query` 一次调用会让计数器 +2（memory 腿 + knowledge 腿），而 `zero_result_rate` 只统计 memory 腿——`knowledge.search` 在"融合后没有任何候选"时**早于** `recordRetrieval` 返回，于是知识库的零结果从未被计入；`by_kind` 里 `cross` 一次都没出现过，尽管类型注释把它列为三个取值之一。现在：

- 两条 store 的 `search` 各有一个 `recordStats`（默认 true）开关，跨库路由把它**双双关掉**，改为在融合与预算之后**自己记一条 `kind: 'cross'`**；事件里的 `results` 是**调用方真正拿到的条数**、`latencyMs` 是整条跨库查询（含一次 encode 与融合）。
- `knowledge.search` 把"记一次事件"提成一个出口，**空结果也记**。
- 计数口径因此恢复为"一次用户查询一条事件"，`zero_result_rate`/`avg_latency` 的分母才是查询而不是腿。这也让 §10.2 的回归门槛（`avg_*`、`zero_result_rate`）成为一把可信的尺子——**先修尺子再量基准**，因为这两个计数器是 45901a9 才引入的，没有历史基线要保。
- `recordStats` 与 `track` 是两件事：`track` 管休眠时钟（跨库查询对 memory 传 false，只对真正返回的命中做 `reinforce`），`recordStats` 管健康计数。

**③ 基准方法与脚本长期化**（此前是一次性临时文件，现已进仓库并挂 `package.json`）：

| 入口 | 脚本 | 钉住的结论 |
|---|---|---|
| `pnpm bench:memory` | `scripts/bench-memory.mjs` | 规模阶梯（`--mode db` 隔离 SQL/FTS/实体/HRR；`--mode vec` 走 hnswlib）、**每条腿的候选扇出**、写入/生命周期耗时、RSS 与库体积 |
| `pnpm bench:indexes` | `scripts/bench-indexes.mjs` | 索引 A/B（`facts.page` 排序、`contradiction_log` 三种查询形状、DELETE 的外键子程序计划），并**保留被证伪的 partial 索引对照** |
| `pnpm bench:reinforce` | `scripts/bench-reinforce.mjs` | 读路径写放大：同一批查询在 `track=true/false` 下的 p50 与各自 WAL 字节 |
| `pnpm bench:ingest` | `scripts/bench-ingest.mjs` | **真模型**入库：ms/chunk、单块固定成本、`kb_query`、`reindex` dry/全量/重复、带向量的启动 |
| `pnpm bench:vstore` | `scripts/bench-vstore.mjs` | （§20.6 已有）numpy vs hnswlib 的构建/延迟/召回 |

每个脚本头部写明它支撑报告里的哪一节、以及**为什么必须这样测**（例如"stub 语义后端是刻意的：这些数字要隔离 store 而不是 embedder"、"用真模型的那一个脚本才有资格谈 ms/chunk"）。**P0 的复现不长期化**为脚本，而是变成单元测试——它守的是正确性，必须进 CI 而不是靠人跑。

**固定开销（同一轮，实测于 n=2000 合成语料）**：`remember add` 6.0 → **1.42 ms**、`remember update` 9.7 → **2.15 ms**、`search` 18.4 → **10.1 ms**、`admin list` 12.1 → **0.87 ms**。四项改动：① HRR `atom()` 进程内 memo（纯函数、确定性，每次命中省下 `dim/32` 次 SHA-256 + `dim` 次 BigInt 除法，实测 ~0.7 ms/原子），返回的数组因此是**共享**的（`bundle()` 只读）；边界是**字节预算 16 MiB + FIFO 增量淘汰**（一条恰好 `dim*8` 字节 ⇒ dim=1024 时 2048 条）——按条数设限会让 dim 大的进程按比例多占内存，而溢出时整表 `clear()` 又会让接下来的调用集中重算（正是 memo 想省掉的那笔），所以两者都不取；② 一次写入只做**一遍 jieba 分词**（`tagText` → `entitiesFromTokens`/`triplesFromTokens`，原先 entities 与 triples 各 tag 一遍）；③ `maxTokens <= 0` 时三个调用点**直接跳过** `fitToTokenBudget`（它会为求和 `used_tokens` 走遍每条，而这三处都丢弃该值——预算模块自身的语义与其单测保持不变）；④ 上面的预编译语句缓存。注意 `add` 的 4.2× 有语料成分：合成语料的实体名高度重复，memo 命中率高；真实语料省下的是"每次命中一次 256×SHA-256"。

**§9 全部完成**：最后的相邻项也在发布就绪那轮落地（`CHANGELOG.md` 的 release readiness 一节）。memory 侧 `facts_fts` 的 rebuild 走**迁移 v8**（`INSERT INTO facts_fts(facts_fts) VALUES('rebuild')`）——FTS5 的 external-content 表能从内容表重建索引，这是把"触发器出现之前写入的行"重新纳入 FTS 腿的唯一办法；它是幂等的，对 fresh/已索引的库只是一次语料遍历。`initClock` 也接上了：它原先有实现有测试却没有生产调用者，于是"元数据行丢了而事实还在"会让所有生命周期窗口从 0 起重算、行永远不过期；现在它跑在 **store 打开时**（`max(存储值, MAX(settle_clock))`，一次索引扫描），而不是每次 presence——后者会让这趟扫描骑在每个心跳上。

### 20.14 第六轮：启动延迟（主因是宿主的前端 combo 重组；我们那段同步分词已挪出启动窗口）

`dsh web` 从回车到第一条 log 实测 **4.84–4.94 s**、到 URL 行 **7.33–7.74 s**（三次运行）。用 `--cpu-prof` 归因：**主因在宿主**，本仓库只修了我们自己那一小段。

**主因（属 deepseek-harness，本轮只做分析，未改其源码，也未改全局安装的副本）**：

- 单文件 self time 最大的是 `@deepseek-ai/dsh-client-modules`（**4.22 s**），其中 `newlineCount` **3.14 s**：启动期它把 55 个前端 bundle（合计 **11.15 MB**，全都没有 `.map`）**重组 4–5 遍**（每个 loader 波次一次），每遍都要"逐字符数换行 + 造 identity source map（`sourcesContent` 里塞进整份源码）+ JSON + SHA-256"。
- `for (const char of value)` 数一遍 11.15 MB 要 **268 ms**，`indexOf` 循环只要 **5.5 ms**（48×）——那 3.14 s 纯粹是"用最慢的方式反复数换行"。
- 其余：~150 个宿主插件的模块加载 ≈1.3 s、native/GC/V8 ≈1.0 s、**我们的插件 0.026 s**（模块 import 150 ms + `apply` 37 ms；`plugin mount` 就打在 `apply` 第一行，所以"第一条 log"其实是"我们的 apply 开始"，宿主此前一行都不打）。我们的 row 是组合树最后一行、会触发最后一次重组，但那次重组的字节 98% 是宿主的 55 个 bundle（我们 186 KB / 11.15 MB）。
- 三条可选改法（**均未落地**，属宿主仓库）：`newlineCount` 换 `indexOf` 循环；`identitySectionMap` 的 `mappings` 用 `';AACA'.repeat(lines - 1)` 替代 `Array.from(...).join(';')`；`ClientModuleRegistry` 在 boot 期只累积 `dirty`、由首次读取图时（`graph()`/index 注入/`/plugins` 路由）合成一次，之后恢复 eager 逐波语义以保 HMR。为了量化收益，曾在**全局安装的副本**上临时试过这三条并随后**完整还原**（`md5` 与原始一致）：第一条 log **1.61 s**、URL **3.17 s**、`newlineCount` self **1.76 → 0.17 s**、58 个 combo 资源全部 200。要落地请走上游。

**我们侧（已修，`packages/core/src/modelBootstrap.ts`）**：nodejieba 的词典解析是**主线程同步**的 ~1.2 s（profile 里 `nodejieba/index.js` self 1.31 s），原先在宿主还没启动完时就开始，等于和宿主抢同一个线程——实测打印 URL 只比我们的 `tokenizer ready` 晚 **0.09 s**，即**我们的解析就是压住启动的最后一段**。现在：

- `warmModelsAsync` 接受一个就绪信号 `waitFor`，插件传 **`loader.await()`**——正是 web app 打印 URL 前等待的那个 Promise（`packages/bundle/web-app`）；拿不到该服务时退化为下面的 idle 门。
- 再叠加 `whenEventLoopIdle()`：要求事件循环连续 **300 ms** 按时触发定时器才开解析。300 ms 不是随手取的：首屏请求（index + 58 个 combo）就在 URL 行后几百毫秒内到达，实测 50 ms 窗口时解析仍恰好压在 URL 那一刻，首屏会排在它 1.2 s 后面；300 ms 窗口跨不过那波请求之间的空隙，解析因此落在首屏之后（实测解析完成于 URL 后 ~1.3 s，期间请求 15 ms 内被服务）。
- `waitFor` 是**同步点而不是前置条件**：宿主启动失败也要预热（`.catch(() => undefined)`）。CLI 路径（`warmModels` 被 `await`）**不设门**——那里进程本来就空闲，设门只会给每条命令白加一个静默窗口；MCP 用 `warmModelsAsync`，因此拿到 idle 门但没有 `waitFor`。
- 实测（宿主保持原样）：URL **7.4 → 6.24 s**，第一条 log 4.94 → 4.75 s（这一项本来就与我们无关）。若宿主侧那三条改法落地，同一 profile 下可到 ~3.2 s（上段数字）。

结论：**启动期任何主线程同步工作都不得与宿主启动争线程**；能拿到宿主的就绪信号就等它，拿不到就用"静默窗口"近似，且两条路径都要有硬上限（`IDLE_MAX_WAIT_MS = 10 s`）以免忙宿主永远等不到。

**后续修正：解析的 memo 必须在"进行中的 Promise"上，而不是在结果上**（`entities/extract.ts` 的 `loadJieba`）。原实现是 `if (jiebaModule !== undefined) return` —— 检查在 `await import()` **之前**、之后不复查，于是两个并发调用者各自跑一次同步解析。这条竞态本来就存在，但**上面的推迟把它从"启动瞬间"拉宽到"启动后 `waitFor` + 静默窗 + 解析"这一整段**：窗口内到达的一次写入会看到 `undefined` 而自己开始解析，等门打开后暖机再解析一次。实测：并发两个调用者 **2436 ms**（单次 1091 ms，2.2×）。改为 `jiebaLoad ??= loadJiebaOnce()`（赋值发生在第一个 `await` 之前）后为 ~1.0×。守它的是 `jiebaLoadAttempts()` 计数 + `entities.spec.ts` 里一条**并发**测试（用 `vi.resetModules()` 拿全新模块注册表，否则结果级 memo 也能通过）；反证：换回结果级 memo，该测试报 `expected 2 to be 1`。失败仍按原策略缓存（一次失败 = 该进程终生走正则，不每次重试）。

### 20.15 派生状态跟着"规则"走，不跟着"写入"走（memory 侧补齐杠杆）

`doc_chunks` 早有 `content_hash` / `embedding_model` / `entities_version`，而 `facts` 只有 `embedding_model`。这个不对称意味着三件事在 memory 侧都做不到：改抽取规则后**老事实永远旧**、增量重建无从判断、以及"等嵌入器"的状态只能放在内存里。memory 迁移 v6 补齐两列：

- **`entities_version`**（与 chunk 侧同名同义）：这一行的实体/三元组是**哪一版规则**产出的。写入时盖章；`reindexEntities(budget)` 按 `entities_version < 当前版` 批量重抽——**一事务一行**，实体行、三元组行、**HRR bundle**（它是实体名的 bundle，不跟着改就会继续拿已经不存在的名字打分）与版本章一起动，并把 `conflict_checked` **重置**（两条冲突腿读的正是刚被重写的东西，旧判决是关于一个不复存在的 fact 的）。语义向量不动：它编码的是**内容**。版本号管的是**规则**，不含"本次进程有没有 nodejieba"——分词器是异步加载的可选依赖，把它算进版本会让一次能力失败触发全库用**更差**的抽取器重建。
- **`conflict_checked`**：这一行的**嵌入腿**矛盾检查是否针对**当前**向量跑过。写入时盖章的条件不是"模型可用/有向量"，而是**这次检测真的拿到了这一行的向量**（见下）；`setSemanticVector` / `clearVectors` 一律重置为 0，因为"检查过"只对**当时那个向量**成立。

**可达路径**：`maintenance` 现在是 `async`，并且**自己各跑一趟有界 pass**——`entities: {rebuilt, deferred, skipped}` 与 `conflicts: {checked, logged, pending}`——这两趟够得着的正是 MCP 用户和设置页用户；它**不**挂在 `heartbeat_minutes` 后面（那个可以是 0 = 只在启动跑）。插件在**挂载时**就跑第一趟实体 sweep（改规则不用等第一拍，默认 60 分钟），之后每拍一趟；CLI 的 `maintenance` 命令则把**两半**的余量都**分批**排空（`entities.deferred` 与 `conflicts.pending` 各自归零为止），分批而不是一次性 `MAX_SAFE_INTEGER`：sweep 会 `SELECT content`，一把抓会把全部 stale 文本先读进内存。冲突那半尤其需要这条路径：v6 迁移**故意不回填** `conflict_checked`（数据库答不了"活索引能否服务这行 blob"），所以升级后**所有带向量的行**一次进入待办，只能靠 `contradict_check`（每次 2000）或这里的 drain 排空；CLI 的循环在"这一趟一个都没完成"时退出（向量不在活索引里的行永远不会被盖章，否则就是死循环），`pending` 保持 > 0 正是诚实。`reindexEntities` 自带**在飞守卫**（心跳与 maintenance 都是周期性的，两个 pass 会选中同一批行重复打标），撞上时返回 `skipped`；冲突 drain 用**游标**（`fact_id > cursor`，到尾部回绕）保证"不可完成的行"不挡住后面的行。`trust_diagnose` 报 `entities_stale` 与 `conflict_pending`，让"派生状态落后于代码"和别的诊断一样可见。

**迁移 v7（重定义索引必须单独一步）**：`idx_facts_conflict_pending` 在中间版 step 6 里是 `(status, conflict_checked, semantic_vector)`——把每条 2 KB 向量复制进索引键，而 drain 查询还要 `SELECT content`，**永远不可能 covering**，那个 blob 列纯属代价。改成 partial `(status, fact_id) WHERE conflict_checked = 0` 之后，drain 计划是 `SEARCH … (status=? AND fact_id>?)` 且无临时 B 树。但**不能**把新定义塞回 step 6：`CREATE INDEX IF NOT EXISTS` 按**名字**判存在，而跑过中间版的库 `user_version` 已经是 6、step 6 不会重跑 —— 于是新定义落在 step 7（`DROP INDEX IF EXISTS` + create，对 fresh/v5 库是幂等的空操作）。这是重定义索引在版本化 schema 里的固定代价，step 5 的 `DROP INDEX IF EXISTS idx_facts_idle` 是同一先例。 紧随其后的 **v8** 只做一件事——对 `facts_fts` 执行一次 FTS5 `'rebuild'`，把 v6/v7 之前写入、FTS 触发器还不存在的那些行重新纳入 FTS 腿（见 §20.13 末段）。

失败与边界：`staleEntityRows` 用 `entities_version < ?`（**不是** `!= ?` 或 `IS NULL OR`）以吃到 `idx_facts_entities_version` 的范围 seek，且排序与该索引同序（`entities_version, fact_id`），预算才真的约束了**读**而不只是**建**；列是 `NOT NULL DEFAULT 0`，迁移的 ALTER 因此把老行填成 0，**并且**让"名字里没有这一列"的 INSERT（滚动升级期间仍在跑的旧进程）也落在 0 而不是 NULL——NULL 在 `entities_version < ?` 里永远不成立，那样行会被永久静默豁免。`linkFact` 是 `INSERT OR IGNORE`（追加语义），所以重抽必须先 `unlinkFact`——否则旧名字会和新名字并存，而版本章会宣称它们是最新的（`memory.spec.ts` 的 `__stale_marker__` 用例钉住这一条）。

### 20.16 队列不该放在内存里（矛盾检测的 pending 持久化）

矛盾检测的"等嵌入器"队列原本是 `ContradictDetector` 里的一个 `Set`：它**随进程消失**（重启后那些事实再也拿不到嵌入腿检查），会无界增长，需要配置上界（`contradiction_pending_max`），还得再报一个"被丢掉多少条"才诚实。现在：

- 检测器**不再持有 pending**：只回答"这些 fact 与谁冲突"（`checkOne` / `checkMany`），队列归 `facts.conflict_checked` 所有。
- `MemoryStore.checkContradictions(budget = 2000)` 是**有界排水**：取 `conflict_checked = 0 AND 有向量` 的一批，跑检测，**在跑完之后**盖章（抛错就不盖 ⇒ 积压保留，与旧注释承诺的一致，而旧实现因为集合随进程死亡根本做不到）。
- 盖的章只给**这次真的拿到向量**的行：`checkOne` / `checkMany` 返回 `{ logged, complete }`，`complete` 是"这次握着它的向量"，而不是"没记下冲突"。两者必须分开——`logged = []` 既可能是"检查过、没有冲突"，也可能是"根本没能检查"。队列谓词问的是**数据库列**（`semantic_vector IS NOT NULL`），而嵌入腿的向量来自**活的内存索引**，两者可以不一致（异 space、别的进程写的、索引重建时缺的行）：按列盖章就是给一次没跑过的检查盖上永久豁免——正是这个持久化队列要消灭的那类静默丢失。拿不到向量的行留在队列里，`conflict_pending` 继续报它，由 `vectors_fix`（它会重置标记）清掉。写入路径同理：`detectContradictions` 捕获异常后返回 `complete: false`，调用方因此不盖章（旧版对异常返回 `[]`，调用方照盖不误）。
- **排水一定有进展（旧设计的"每行都被盖章所以不会自旋"不再成立）**：队列按 `fact_id` 取，若某行永远完不成，它就会**卡在队头**并把后面的行全部饿死。所以排水带一个**续跑游标**：取"上一次尝试过的 id 之上"的一批，取空则从头再来。游标是**调度状态**不是派生状态——重启后从头重试一遍，代价是重复一批、没有别的（`memory.spec.ts` 的"不能评分的行不该挡住后面的行"用例钉住这一条，去掉游标它会把队列卡在 2 条）。
- 于是 `contradiction_pending_max` 这个旋钮被**删掉**了（设计上的简化，不是回归）：不再需要上界，因为队列不是内存结构；`trust_diagnose` 用 `conflict_pending` 报"落后多少"。
- **迁移不替老行猜**：`conflict_checked` 不留回填（`UPDATE … SET conflict_checked = 1 WHERE semantic_vector IS NOT NULL` 看着省钱，代价是把"索引能不能服务这个向量"当成已知——迁移看不见索引，当前 space 也由配置与已加载模型决定，开库时都不存在）。代价是一次**有界的补扫**（排水按批，且只取有向量的行），收益是不会有老行被永久豁免。

**计数口径**：诊断的 `conflict_pending` **不带** `semantic_vector IS NOT NULL` 过滤（排水才需要），否则模型不可用时——正是队列增长的那段时间——诊断会报 0，把"一条都没检查"显示成"没有积压"。这条被 `lifecycle.spec.ts` 的"重启后仍是 6"用例钉住。

### 20.17 腿 cap 从"已接受的畸变"变成"可测量的不变量"

**问题**：每条非语义腿有 cap（`retriever.leg_cap`，默认 0 = 派生 `max(200, 4×overFetch)`），而 `fuse` 原本按**每条腿自己返回的集合**做 min-max 归一化——被 cap 剪掉的尾巴**正是**归一化的下界，于是剪尾会**重缩放所有幸存者**并可能改变排名。旧测试把这个效应当"已接受"钉住了（"the cap is a cost bound and the pool is reranked afterwards"）。

**改法**：归一化改为**按该腿自身的最大值缩放**（`scaleByMax`）。对**按自身分数序交出条目**的腿，最大值必然属于 cap 删不掉的那一条，所以 `v / max` 在有无 cap 时是同一个数 ⇒ **腿的贡献对 cap 不再敏感**；幅度信息保留（rank 融合会丢掉它）。同时补了显式 tiebreak（`score` 相同按 id 升序——缩放后的分数比 min-max 更容易撞，而旧顺序是 Map 插入序），并让"每条腿分数全为 0"的退化情形仍留在池里（`s > 0` 过滤曾把它整条丢掉）。

**不变量成立的边界（复核 N5）**：FTS 腿（按 `bm25`）与实体腿（按精确 Jaccard）都是上面那种腿；**HRR probe 腿不是**——它的候选按 **Jaccard 比率**（`candidateFactsForAnyEntity`；本节旧稿写作"共享实体数"，那是该 cap 的第一版排序量，实测会把 3/10=0.30 排在 2/2=0.67 前面，已改）或按 **recency**（`activeHrrRows` 回退）取，两者都**不是**这条腿自己打的分（相位相似度），所以 cap 完全可能删掉它自己的最高分。所以准确的声明是"cap 按该腿自身分数排序时才透明"，而不是无条件成立。现有 store 级差分测试走 `action: 'search'`，而 `includeHrr` 只在 `probe` 打开 ⇒ 它恰好只在"结构性成立的那两条腿"上验证过，HRR 从未被验证（缺一条 `probe` 路径的差分，见 `docs/PROVENANCE_REVIEW.md` N5）。

**代价（实测，已重冻基线）**：min-max 把每条腿的**最弱项归零**、`fuse` 又丢弃总分为 0 的条目——那是一个**事实上的阈值**。去掉后 35 条评测查询里 `mrr` **0.9429 → 0.9714**（rank-1 正确 33/35 → 34/35），而 `must_exclude` **0.7429 → 0.6571**：12 条违规**全部**是"答案仍在第 1 位、k=2 的尾位填了一个共享实体的邻居"（问"李娜管理谁"，也返回"张伟管理李娜"）。本仓没有绝对分数阈值（这是刻意的），所以记录数字而不是造一个阈值去贴合它。

**守护**：`recall.spec.ts` 的差分测试——同一语料、同一查询，**cap 实际绑住**（`legs_capped > 0`）时 top-5 的 **id 与分数**必须与"无 cap"逐位相同，并用 cap=2 作对照证明该断言会失败。计数器 `recordLegCapped()`（`retrievalHealth.legs_capped`）是"这条腿是否被剪"唯一可观测的信号（`size === cap`，与 tick 的预算判定同形）。**两个库都上报**：该计数器曾只在记忆库侧调用，知识库的腿被 cap 绑住时健康面板看不到——正是本节要消除的"无人报告"，随检索编排骨架合并到 `core/src/store/hybrid.ts` 后由同一处代码上报。

**cap 值多少：实测（2000 条语料，20 条金标 + 1980 条弱匹配，查询命中全库，每档 20 次取 p50）**

| `leg_cap` | p50 | 头部与"无 cap"相同？ |
|---|---|---|
| 派生（200） | **4.42 ms** | 是（id + 分数逐位） |
| 50 | 2.95 ms | 是 |
| 100 | 3.24 ms | 是 |
| 400 | 4.84 ms | 是 |
| 无 cap | **13.19 ms** | — |

结论：**cap 本身值 3.0×**（13.19 → 4.42 ms），派生默认已经吃到了这份收益；再降到 50 只多拿 1.5×，**但这次实验不足以支持下调**——金标事实在两条腿里都很强，剪尾在构造上不可能影响它们，而真正会受害的形状（只在一条腿强、在另一条腿刚好排在 cap 之外、靠多腿累加进 top-k）**没有被覆盖**。降到 `overFetch`(=50) 更等于把一侧余量归零，而"cap ≥ k"只是必要条件、不是充分条件。因此**默认保持派生 200（4× 池子）**；要在大语料上下调，先按同一差分测试在非退化语料上量，而不是凭 2k 的数据外推。

**方法论注记（这次实验自身踩到的坑）**：第一版用的语料里每条事实形状相同，所有分数都是 1.0——于是"头部与无 cap 相同"**恒真**，和"空洞断言"是同一种东西。凡"顺序/头部不变"这类断言，必须先确认语料让分数有区分度，否则它证明的只是"这个测试不会失败"。

**评测边界（写进 §10 的验收清单）**：eval 是**小语料上的排名回归门**，不是覆盖门——它对任何"语料量级以下才生效"的改动（cap、抽样、截断）**天然盲**（旧 29 条在截断代码下逐字节相同）。因此：凡改候选集/截断/排序，**eval 通过不能作为"召回无变化"的证据**，必须同时有 (a) 一个能让 cap 生效的差分测试，与 (b) 一个计数器，让"是否绑住"在生产里可观测。

### 20.18 第 5 项（2 字缺口）被实测否定，按诊断修正收口

原建议是"把未标注的 ≥2 字 CJK 串也当实体"。**实测推翻**：`缓存` 不是"未标注"，jieba 把它标成 **动词 `v`**——`维护 / 负责 / 加入 / 离开 / 审核 / 发布 / 值班` 同样是 `v`。所以那条规则会把**每个动词**变成实体，污染实体腿以及它喂的 Jaccard 分母；而 `风控` 能命中恰恰因为它是 `x`（已在 `ENTITY_EXTRA` 里）。缺口的准确表述是"**被标注器判为动词的词**"。

因此不做抽取层改动，只把 `eval_zh.spec.ts` 的 PINNED GAP 用例按实测改写（标题与注释都改成"动词"口径），并记下两条**词法层**候选修法及其代价：`LIKE '%…%'` 回退（2 字模式没有可用的 trigram 索引，等于每次查询一次 O(语料) 扫描）或写入时维护的 bigram 索引。两者都是召回语义决策，各自单独立项。
