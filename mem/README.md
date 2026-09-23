# avantf-mem

用 TypeScript 编写的 DSH 原生**记忆 + 文档知识库**，支持交叉检索。它既是 DeepSeek Harness 的**原生 Cordis 插件**，同时保留以 **MCP server** 运行的能力。

- **记忆** — 结构化事实 + SPO 三元组 + 实体；混合检索（语义嵌入 + FTS5 + 实体 Jaccard）；生命周期管理（信任衰减 / TTL / 归档 / 矛盾 / 去重）。不做用户隔离：agent 上下文共用单一存储。
- **知识库** — 文档按 `domain（类型/领域）→ source` 分类并切分为 chunk；支持 ingest / import / 浏览 / 与记忆交叉检索；
  写入侧的 `domain` 受 `knowledge.domains` 清单约束（默认 `design/api/ops/research/notes`，显式 `[]` = 不限制；非空时还接受库里已有的领域），`source` 可留空（缺省 `default`）；
  每篇文档在 `~/.avantf/knowledge/docs` 留一份**可编辑副本**，用编辑器改完点「重新摄入」即可回写索引；
  **支持 PDF**（抽取文本层，含中文 CID 字体；扫描件没有文本层会明确报错），可直接摄入 **pandoc 能读的全部格式**（`.docx/.docm/.odt/.epub/.html/.htm/.xhtml/.tex/.rst/.ipynb/.csv/.tsv/.org/.rtf/.fb2/.opml/.bib/.docbook/.man/.typ`）以及 `.xlsx`（先转成 Markdown 再入库：用了哪条转换器随 `converter` 回报（带版本，如 `pandoc-3.11`）、没能带过来的内容随 `warnings` 透出），其他二进制（图片、pptx、旧版 .doc/.xls/.ppt 等）会被拒绝并说明原因；GBK/GB18030 等中文旧编码会自动解码并在结果里标出 `encoding`。pandoc 由家族底座 `@avantf/dsh-plugin-base`（内含环境初始化框架）在启动时按钉死的版本装到受管族根 `~/.avantf/env/tools/pandoc/`（国内镜像优先、官方源兜底，装不了就明确报错；无底座的 CLI/MCP 与降级路径仍用 legacy 目录 `~/.avantf/tools`）。
- **交叉检索** — 一次查询同时覆盖记忆与文档，且分数可比（联合归一化），用于 agent 上下文。
- **内部可插拔检索** — `SemanticBackend` / `Reranker` / `VectorStore` 可在 `retrieval-core` 内部替换（注册表 + 配置 + 优雅降级 + 自动升级），无需改动业务流程。
- **方案 A** — 检索在本地完成（onnx `bge-small-zh-v1.5` + `bge-reranker`）；答案生成在外部（DSH / agent 模型）。

完整架构与路线图见 [DESIGN.md](DESIGN.md)，DSH 分步安装手册见 [docs/INSTALL.md](docs/INSTALL.md)，向量后端选型见 [docs/VECTOR_STORES.md](docs/VECTOR_STORES.md)，预装设施现状（家族底座 `@avantf/dsh-plugin-base` 的环境初始化框架接管：item 清单、受管根、legacy 降级与迁移配方）见 [docs/PROVISIONING.md](docs/PROVISIONING.md)。

## 目录结构（工作区）

```
~/.avantf/                 # 默认 data_home
├─ config.yaml             # 公共配置（semantic / rerank / vectorStore / retriever / lifecycle）
├─ memory/
│  ├─ memory.db            # 记忆存储 + 记忆读模型
│  └─ config.yaml          # 记忆专属覆盖
└─ knowledge/
   ├─ knowledge.db         # 知识存储 + 知识读模型
   └─ config.yaml          # 知识专属覆盖
```

## 包结构

| 目录 | 包名 | 用途 |
|---|---|---|
| `packages/retrieval-core` | `@avantf/mem-core` | 可插拔检索底座：接口 + 注册表 + 配置解析 + 降级 + 融合 |
| `packages/core` | `@avantf/mem` | 引擎：记忆存储、知识存储、摄入、生命周期、矛盾检测、交叉检索路由 |
| `packages/contract` | `@avantf/mem-contract` | 工具 / 检索 / 管理契约的唯一来源（zod） |
| `packages/convert` | `@avantf/mem-convert` | 文档格式 → Markdown 的独立转换库（注册表 + pandoc 包装器 + xlsx；core 依赖它，构建时内联进插件） |
| `packages/provision` | `@avantf/mem-provision` | 依赖获取唯一入口：外部二进制（pandoc）与启动预热（嵌入模型 + 分词器）的 artifact 注册表 + 受管目录 + 镜像下载 |
| `packages/plugin` | `@avantf/dsh-mem` | DSH 原生 Cordis 插件（宿主 service + tools + RPC + 两个 `conversation.view` 客户端标签页「记忆」「知识」） |
| `packages/cli` | `@avantf/mem-cli` | CLI（memory / kb / contrad / query / maintenance） |
| `packages/mcp` | `@avantf/mem-mcp` | 可选的 MCP server 入口（stdin/stdout，复用契约） |

> **家族基础设施**：启动期环境初始化与宿主兼容门禁都在家族底座
> [`@avantf/dsh-plugin-base`](../base/plugin-base)（`base/plugin-base`，合并后的唯一底座；
> 从前独立的 `@avantf/dsh-envinit` / `@avantf/dsh-compat` 已并入它，两个旧包不再发新版本、已死）
> 负责——它把资源预装到受管族根（默认 `~/.avantf/env`），并在启动时跑兼容门禁。本仓把底座声明为插件的
> **peerDependency**（peer 区间 `^0.1.0`，已发布到 registry；另在 `devDependencies` 里声明 `^0.1.3`，
> `pnpm install` 即装上一份）：**不内联、也不按 specifier import**——插件唯一的静态引用是内联的零依赖
> `bootstrap`（`packages/plugin/src/envinit-bootstrap.js`），它按
> `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` 从插件自己的依赖树解析底座、
> 动态 `import()` 并校验版本，拿不到就一条 `envinit: WARNING` 后**照常降级挂载**。插件在**运行时**从底座取用
> 门禁规则/探针/复查、envinit provisioner 与 prompt 文件层 `PromptFiles`（work 还取底座的 `resolveDataHome`），
> 所以修这些共享代码只需发一次底座。仍留在插件里、改它们需要发插件的是：`typert` `strict` wire codec 与端点/
> 字段/结果符号字面量（照抄宿主约定的两三行，描述符在模块加载期就要组装），以及各插件自己的 logger 与
> "底座缺席时"的降级 fallback；底座 kit 另外导出 `createPluginLogger`、`familyHome` 等，插件可在运行时取用。`scripts/link-envinit.mjs`（`pnpm build:dsh` 会自动跑）
> 从**安装副本** vendor `bootstrap`；只有要就地联调底座时才用 `DSH_ENVINIT=<checkout>` 显式指定，不再隐式
> 发现兄弟 checkout。**发布顺序是底座先于插件**；`zod` 由根 `pnpm-workspace.yaml` 的 catalog 统一成一份
> （`zod: 4.6.5`，跟随已安装 dsh 的版本），底座的 `zod` peer 保持 `>=4.4.3 <5`。改 `base/**` 里的共享代码后，
> **两个插件的完整门禁都要重跑**（mem：`pnpm build:dsh` + `node scripts/mount-smoke.mjs`；work：
> `pnpm release:check` + mount-smoke）；判据是"这条知识能不能靠**一次底座发布**修好"——能就在运行时从底座
> 取用，不能（只是两三行照抄宿主约定的字面量）可以留在插件里，但要写明"改它需要发插件"。详见
> [docs/RELEASING.md](docs/RELEASING.md)。

## 已实现里程碑

| # | 状态 |
|---|---|
| M0 工作区 + 配置分层 + `~/.avantf` 布局 + 记忆 schema | ✅ |
| M1 HRR 代数 + 确定性原子 + 实体/三元组 | ✅ |
| M2 记忆混合检索 + 35 查询一致性测试台 | ✅（测试配置下的冻结基线 MRR 0.971，R@k 0.957） |
| M3 本地 ONNX BGE + 重排模型（惰性降级） | ✅ |
| M4 5 种向量库注册表接口 + 自动升级 | ✅（local_numpy 与 hnswlib 为具体实现；`auto` 达阈值自动升级；faiss/pgvector/qdrant 是会显式告警的适配器接口） |
| M5 生命周期 + 矛盾检测 + 去重 | ✅ |
| M6 可插拔注册表定型 + 测试 | ✅ |
| M7 DSH 宿主插件（service + tools + RPC） | ✅（可构建；运行需要 DSH profile） |
| M8 客户端记忆页（`conversation.view` 标签页「记忆」） | ✅（可构建；渲染需要 web bundle） |
| M9 知识存储 + 交叉检索 | ✅ |
| M9b 知识维护（受管文档副本 + `kb sync` + 标签页 编辑/打开目录/删除/重新摄入） | ✅ |
| M9c 格式管线（PDF 文本抽取 / 二进制与编码拒绝 / 导入跳过可见） | ✅ |
| M9d 文档转换（`@avantf/mem-convert`：ZIP 按中央目录区分，接入摄入管线） | ✅ |
| M9e 转换切到 pandoc 优先 + 依赖预装（`@avantf/mem-provision`：pandoc 钉版本装进 `~/.avantf/tools`，模型预热并入同一 sweep；删掉被取代的 mammoth/turndown/csv 内置） | ✅ |
| M10 客户端知识页（`conversation.view` 标签页「知识」） | ✅（可构建；渲染需要 web bundle） |
| M11 完整 CLI 子命令 | ✅ |
| M12 MCP 入口（stdio，复用契约） | ✅（`tools/list` 与 8 个工具的 `tools/call` 都在 CI 里真实派发过） |
| M13 一致性回归 | ✅ |
| M13b 发布（1.0 待 tag） | ⏳ 见 [docs/RELEASING.md](docs/RELEASING.md)：`pnpm release:check` + 打 tag，尚未切版本节 |

> **验证边界（重要）**：M7/M8/M10 在本仓库内只经过**编译与类型检查**（CI 跑到的那部分），
> 而它们的**运行时**——插件真的能 mount 进 DSH、两页真的能渲染——只能在有 harness 的机器上验证，
> 即 `pnpm typecheck:dsh` 与 `pnpm build:dsh`（后者内含 mount smoke）。这两步是**本地门禁**，CI 没有
> harness（其传递依赖并非全部发布到 npm）。因此：**打 tag 必须在跑过 `pnpm release:check` 的机器上做**，
> 发布清单与"支持的宿主窗口"见 [docs/RELEASING.md](docs/RELEASING.md)。

## 模型引导（镜像/自动下载）

当 DSH 插件接入后，启动时**异步**加载语义 / 重排模型（不阻塞 `apply`）。**模型的下载落点与来源由家族框架决定，不再由终端用户的 `~/.avantf/configs/common.yaml` 决定**：

- `mem:model` 是框架的 `model-cache` item，用 **`flat` 布局**落到 `<home>/models/<repo>/<file>`——正是 `@huggingface/transformers` 在其 `cacheDir` 下读的形状。文件列表只对**默认仓库**写死运行时真正会取的四个（`config.json` / `tokenizer.json` / `tokenizer_config.json` / `onnx/model.onnx`）；改过 `semantic.local_model` 的仓库**不写列表**，交给框架按仓库自身的文件清单装，不会因为固定的六件套与仓库不符而 `failed`。运行时因此复用框架装好的那一份，不会二次下载；`buildRuntime` 在框架接管模型根时**延迟**后端构造时的预热，预热只从 `mem:model` 到达终态的回调开始，不会和框架的安装抢同一份文件。
- 缓存目录 = 框架的族根 `<home>/models`（`~/.avantf/env/models`，由 `managedRoots` 设成内建默认）；`config.yaml` 里的 `semantic.cache_dir` / `rerank.cache_dir` 会被**忽略并告警**。运维用 `AVANTF_MEM_MODEL_CACHE` 把缓存指到别处时，运行时读那一份，`mem:model` **不再声明**——否则框架会在族根再装一份没人读的完整副本。
- 镜像默认 `https://hf-mirror.com`，`config.yaml` 里的 `semantic.mirror` / `rerank.mirror` 同样被忽略；运维只能用环境变量逃生口（见下）。
- 模型 item 拿不到时按**降级**处理：`semantic.auto_download` 打开就由运行时自己取；关闭时 item 仍会声明，但框架判为 `skipped (policy/download-disabled)`、运行时也只读磁盘，检索退回 FTS+entity，**绝不拒载**。

```yaml
# ~/.avantf/configs/common.yaml
semantic:
  local_model: Xenova/bge-small-zh-v1.5   # ⚠️ transformers.js 需要 ONNX 仓库
  auto_download: true                     # 启动时自动下载（false 则只在已缓存时加载）
rerank:
  backend: bge_reranker               # 默认 none（不重排）；重排的唯一开关
  local_model: Xenova/bge-reranker-base # ONNX 版重排模型（默认值）
  auto_download: true
```

> **ONNX 注意**：`@huggingface/transformers`（transformers.js）需要 **ONNX 模型仓库**。
> `Xenova/bge-small-zh-v1.5`（或 `onnx-community/bge-small-zh-v1.5`）是 ONNX 版；
> `BAAI/bge-small-zh-v1.5` 是 PyTorch 版，**不能直接用于 transformers.js**（会因找不到 ONNX `model.json` 而降级）。
> 配置默认值即 ONNX 仓库 `Xenova/bge-small-zh-v1.5`（开箱即有语义检索），加载成功后产出真实 512 维向量。
> **镜像不一定可达**：`hf-mirror.com` 在部分网络下 80/443 均连接超时（ICMP 也不通），此时语义路径会降级；把镜像环境变量换成可达的 HF 镜像即可（例如 `https://aifasthub.com`，实测可用——它 302 到 `us.aws.cdn.hf.co`）。权重落到族根后即离线可用。

镜像与落点的优先级（只剩环境变量这一层，`config.yaml` 不再是真相来源）：

- 镜像：`AVANTF_MEM_MODEL_MIRROR`（或 `HF_ENDPOINT`）> 默认 `https://hf-mirror.com`；环境层把它写进 `semantic.mirror` / `rerank.mirror`，因而同时喂给 `mem:model` 的 `spec.endpoint` 与适配器的 `remoteHost`。
- 缓存目录：`AVANTF_MEM_MODEL_CACHE` > 框架族根 `~/.avantf/env/models`（无框架的 CLI/MCP 与降级路径为 `~/.avantf/env/models`）；环境层同样写进 `semantic.cache_dir` / `rerank.cache_dir`，设了它就不再声明 `mem:model`。
- 下载总闸：`AVANTF_ENVINIT_AUTO_DOWNLOAD=0`（家族级）或 `AVANTF_MEM_AUTO_DOWNLOAD=0`（本项目）——任一为 `0` 都会经环境层落进 `semantic.auto_download` / `rerank.auto_download`，框架与运行时**同时**停手。

- 模型未就绪时检索**自动降级**到 FTS + 实体 Jaccard（`isAvailable()` = false）；下载完成后自动升级到 `0.55 / 0.30 / 0.15` 三路融合。**降级不是终态**：启动预热失败后，后续检索/索引会自动重试（同一时刻只跑一次，最短间隔 30s），无需重启进程；`vectors_fix` 则会当场等待一次完整尝试。`auto_download: false` 时不重试（本地缺失是确定性的）。CLI 启动时同步预热；插件与 MCP 异步预热（MCP 先应答 `initialize`，再后台加载模型）。
- `@huggingface/transformers` 已声明为 `@avantf/mem-core` 的 **optionalDependency**，`pnpm install` 会自动装上（无需额外 `pnpm add`），由适配器动态加载；首次运行时从镜像下载 BGE 权重（约 95MB，之后离线）。即使装不上也只是语义路径降级，不会报错。
- 重排的唯一开关是 `rerank.backend`（默认 `none`，不加载任何重排模型）；语义后端只负责嵌入。
- agent 工具统一返回 `{ok:true,result}` / `{ok:false,error,violations}`（DSH 工具与 MCP server 一致）；`db.path` 里的 `~/` 展开为**用户 home**，留空则落在数据目录下。

## 自定义系统提示词

注入给模型的三个 systemPrompt 段落的**正文**可以自己改，一段一个文件。这些文件与家族其它插件（如工作引擎 `@avantf/dsh-work`）的提示词**集中在一个目录**，用**文件名前缀**区分归属：

```
~/.avantf/prompts/                  # 家族共享的提示词目录
├─ mem-memory-usage.md      # 记忆：何时该记、不要记什么（order 3000）
├─ mem-knowledge-usage.md   # 记忆：何时该查库、何时该入库（order 3010）
├─ mem-kb-edit.md           # 记忆：怎么改一篇既有文档（order 3020）
└─ work-tree-guide.md       # 工作引擎的（`work-` 前缀；由 @avantf/dsh-work 维护）
```

每个插件**只读写自己前缀的文件**：别人的文件、以及任何不在清单里的 `.md`，既不会被读、也不会被写或删。

- 插件启动时**自动创建**属于它的那几个文件，内容就是内置的默认提示词；**空文件会被重新填回默认**（不是"禁用这一段"），删掉也会重建。
- **文件全文就是提示词**：不要写标题、注释或 frontmatter —— 它们会一字不差地进入每一轮 prompt。要给别人看的说明写在这里，不要写进文件。
- **只在插件初始化时读一次**：改完要**重启 dsh** 才生效（和 host 半边改代码同一条规则）。段落名与注入位置（order）由代码固定，改文件名不会换位置；目录里其它 `.md` 不会被读取，也不会报错。
- 自己写的文本只做一次**软检查**（超过 400 字、出现"衰减/遗忘/信任度"这类保留机制词、出现"因为/否则"这类解释措辞）并各记一条警告，**不截断、不拒绝** —— 这三类是实测过的退化形状，提醒一句而已。
- 文件读不了或写不了（只读文件系统、权限不足、路径被目录占住）只记一条警告并退回内置默认，**绝不影响插件挂载**。

## 信任与遗忘（自然消退 / 召回加强 / 永久记忆）

记忆按**活跃使用日**老化（不是挂钟）：进程启动与心跳推进“活跃日”，每次最多计
`trust.presence.gap_cap_days`（默认 1 天），所以**停机 90 天只相当于老了 1 天**，而常开时与日历 1:1。

- 新事实 `trust = 0.5`，线性衰减 `0.5 / 90` 每活跃日 ⇒ **90 个活跃日到 0 即归档遗忘**（`forgot`）；
- **召回会加强**：`≤0.5` 直接抬回 `0.5`，否则 `+0.03`，封顶 `0.85`；每条事实每 24h 最多 3 次有效加强，且**召回永远不会变成永久**；
- **永久记忆**：`helpful` 累计到 `0.9` 自动固化（trust 定格 1.0，不再消退/归档/清理），也可显式固化；
- **主动遗忘**：反复 `unhelpful` 把它压到 0 会立即归档；
- **兜底**：连续 `idle_calendar_days`（默认 365）日历日没被使用 → `idle` 归档；
- 排序不受影响：trust **不参与**检索排序（35 查询评测基线是精确断言）。

```bash
avantf-mem trust            # 诊断：活跃日时钟 / 永久数 / 今日加强量 / 待遗忘数
avantf-mem pin 12           # 固化为永久记忆
avantf-mem unpin 12         # 解除永久
avantf-mem maintenance      # 强制跑一次完整生命周期 pass（结算/TTL/遗忘/清理）
```

```yaml
# ~/.avantf/configs/common.yaml
trust:
  decay_per_day: 0.0055556    # 0.5/90 ⇒ 90 活跃日归零
  recall_daily_cap: 3         # 每条事实每 24h 最多加强次数
  recall_ceiling: 0.85        # 召回单独能到的上限（< 永久阈值 0.9）
  permanent_threshold: 0.9    # 达到即固化（helpful 路径）
  idle_calendar_days: 365     # 日历兜底
  presence:
    gap_cap_days: 1           # 每次在场最多计 1 天（停机不饿死记忆）
    heartbeat_minutes: 60     # 长驻进程的心跳间隔；0 = 只在启动时接续
  enabled: true               # false = 停用衰减/加强/pin（TTL/idle/purge 仍跑）
```

完整规格与决策记录见 [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md)，概要与运维见 [DESIGN.md](DESIGN.md) §18。

## 发布

每个包都声明了 `publishConfig.access=public` 与 `prepublishOnly=pnpm build`。
**打 tag 之前先跑一次发布门禁**（它会检查 6 个包版本一致、CHANGELOG 已切版本节、`[Unreleased]` 已清空，
并依次跑 frozen-lockfile / build / typecheck / test / `typecheck:dsh` / `build:dsh`+mount smoke）：

```bash
pnpm release:check
```

家族底座 `@avantf/dsh-plugin-base` 是插件的 **peerDependency**（peer 区间 `^0.1.0`，已发布到 registry）；
插件同时把它声明进 `devDependencies`（`^0.1.3`），`pnpm install` 即装上：
`pnpm build:dsh` 会先跑 `scripts/link-envinit.mjs`，从**安装副本** vendor 它零依赖的 bootstrap；底座
**绝不内联、也绝不按 specifier import**，所以本地开发**不需要任何 checkout**（只有要就地改底座时才用
`DSH_ENVINIT=<checkout>` 显式指定）。**作为可安装包部署时**，底座由 npm 这类会自动安装 peer 的包管理器
跟着装上（多个插件共用顶层那一份）；pnpm 关掉 `autoInstallPeers` 或 yarn 不会自动装，那时在宿主/profile
里显式写一条即可：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
"dependencies": {
  "@avantf/dsh-plugin-base": "^0.1.0",
  "@avantf/dsh-mem": "^0.1.1"
}
```

它保持 **required peer**，缺了只是降级挂载（一条 `envinit: WARNING` + 退回 legacy 机制，绝不拒载）。
宿主自己提供的 peer 才是 `optional`，免得包管理器去 registry 拉一份宿主内部实现。环境初始化框架与启动兼容
门禁现在都在底座**这一个包**里（不再有独立的 `@avantf/dsh-envinit` / `@avantf/dsh-compat`，也不再有
`mem:compat` item 或受管 `runtime` 根上的门禁副本）。发布顺序是**底座先于插件**——`release-check` 在发布
插件前会确认 registry 上已有落在插件 peer 区间内的底座版本；发布前确认
工作区里没有 `link:`/`file:` 覆盖——`pack-plugin.mjs` 会拒绝仍带这类 specifier 的 tarball，
`make-release-tree.mjs` 会拒绝投影这样的工作区。

后三步（链接 / `typecheck:dsh` / `build:dsh` + mount smoke）**只对着已安装的全局 `dsh`**
（`npm i -g @deepseek-ai/dsh`）：邻居包从它软链，`tsc` 因此对着你真正运行的那一份检查，tsdown 的
client preset 用仓库自带的 pin 住的副本（`packages/plugin/vendor/dsh-client-preset/`，见 `ORIGIN.md`）。
所以**没有 harness 源码也能跑完整个门禁**：

```bash
pnpm release:check                  # 7 步全跑，LOCAL 三步走已安装的 dsh
pnpm build:dsh                      # 只重建插件时同理
DSHHARNESS=/nonexistent pnpm build:dsh   # 反证：没有任何编译路径会去解 harness
```

**preset 副本的漂移会自己报出来**（可选核对，不参与编译）：本地刚好有 harness checkout 时，
`link-dsh` / `release:check` 会逐个字节比较那 8 个自带文件与 checkout 的对应文件，不一致就打出是哪些
文件、两侧 revision，并指向 `ORIGIN.md` 的重新对齐步骤（`link-dsh` 打 `WARNING`、release-check 打
`note:`，都不是硬失败——checkout 领先于 pin 是重新对齐前的正常状态）；没有 checkout 时什么都不打。
也可单独跑 `node scripts/check-preset-drift.mjs`（有漂移时 exit 1）。

发布仓库 `../dsh-plugins-rc` 由**整仓投影**生成（`dsh-plugins` 的每个受控文件原样进去，不再是单插件子树），
不要手工编辑。入口在**仓库根**（`pnpm sync:rc` / `pnpm release:tree`），不是本子树：

```bash
pnpm sync:rc                       # 预览 → 确认 → 同步 → 复查 rc 已等于投影（推荐入口）
pnpm sync:rc --dry-run             # 只看漂移，不改任何东西（有漂移则 exit 1）
pnpm version:set mem=0.1.2         # 切版本：只改 mem/packages/plugin/package.json（组内其余 manifest 不带版本）
pnpm sync:rc                       # 投影：版本默认就取开发树
pnpm sync:rc --version mem=0.1.2    # 也可以只给发布树盖一个版本（开发树不动）
pnpm sync:rc --keep-rc-versions     # 反过来：保留 rc 现有的版本号
pnpm sync:rc --yes --commit        # 非交互 + 在 rc 里提交 "release: sync from dsh-plugins@<sha>"
pnpm sync:rc --yes --gate          # 同步后在 rc 里跑三个包的完整发布门禁
```

`pnpm sync:rc` 默认**保留 rc 当前的版本号**（重复同步不会悄悄挪动发布版本），只在你显式传
`--version` 时才盖新版本；它不会碰 `~/.avantf`、不会删 rc 未跟踪的文件（`node_modules/`、`lib/`、`dist/`），
不传 `--commit`/`--gate` 就只做投影 + 复查。整仓投影意味着 rc 里**连测试都在**：同一个仓库形态、同一套
门禁，投影本身不需要剥离规则（唯一不进 rc 的是 RC 工具链自己：`scripts/make-release-tree.mjs` 与
`scripts/sync-release-repo.sh`），`pnpm-lock.yaml` 也原样投影（组版本号不写进锁文件）。

本包的 npm 页面就是 `packages/plugin/README.md` 本身（真实文件，`files` 里有它）；rc 仓库首屏的
`README.md` 由生成器写（本仓库没有根 README 可复制）。插件的 manifest 在 rc 里与开发树**逐字相同**
（引擎与 `react`/`react-dom` 放 `devDependencies` 以便内联，`dependencies` / `optionalDependencies` 就是
引擎的运行时依赖面；底座 `@avantf/dsh-plugin-base` 是 **peer**，本仓另在 `devDependencies` 里声明一条以便
`pnpm install` 装上）。本仓库的 `README.md`（开发向）与 `docs/**` 都会进 rc（rc 是同一个仓库的投影，不是
一份精简的发布物）。

> 这份 manifest 形态是**构建正确性的一部分**，不是发布树的特例：tsdown 的规则是"production 段保持
> import，其余全部内联"，所以引擎一旦回到 `dependencies`，`lib/index.js` 就会悄悄**不内联**——这种产物
> 在本仓库里照样构建、照样通过 mount smoke（workspace 的 node_modules 能解析 `@avantf/*`），
> 但**拷进任何 DSH profile 就起不来**（`Cannot find package '@avantf/mem'`）。`pnpm pack:plugin`
> 就是为这条断言存在的，现在它在**开发树里也成立**：`pnpm build:dsh && pnpm pack:plugin` 可以在本地
> 就把"用户装的那一个包"验完，不必等同步到发布树。发布树的门禁（`release:check`）会带上它，
> 并真实安装+挂载打出来的 tarball。

**版本、升级与回滚、release notes 必须带上的已知限制、以及人工确认清单**都在
[docs/RELEASING.md](docs/RELEASING.md)。要点：6 个包**共用同一个版本号**，但本仓**只发布
`@avantf/dsh-mem`**（引擎内联进 `lib/index.js`；家族侧没有生产依赖——底座 `@avantf/dsh-plugin-base` 是
peer，另在 `devDependencies` 里声明一条以便安装，**底座必须先于插件**发布）；迁移**单向**（升级前备份
`~/.avantf`，降级会被 `SchemaDowngradeError` 拒绝）；插件的 DSH peer 范围就是"支持的宿主窗口"。

另外 5 个包（引擎 / `mem-cli` / `mem-mcp`）在 manifest 里都是 `private: true`：它们只作为本仓库的
源码依赖存在，`pnpm -r publish` 碰不到它们，`release:check` 的 preflight 也会断言"可发布的只有 plugin"。

发布本身（npm registry）是独立动作：

```bash
pnpm --filter @avantf/dsh-mem publish --access public --no-git-checks   # 只这一个
```

## 快速开始（开发）

```bash
pnpm install
pnpm build
# 测试（引擎包：contract / retrieval-core / core / cli / mcp）
pnpm test

# 记忆 CLI
export AVANTF_HOME=$(mktemp -d)
node packages/cli/lib/index.js add "张伟管理李娜"
node packages/cli/lib/index.js search "李娜"
node packages/cli/lib/index.js kb ingest "平台组负责统一网关。" --domain design --source gw.md
node packages/cli/lib/index.js query "张伟" --kind all
```

### 编译 / 校验 / 打包命令一览

产物只有两类（本仓库不使用 `incremental`/`composite`，没有 `*.tsbuildinfo` 之类中间缓存）：

- **引擎包的 `lib/`**：`pnpm build` 产出，5 个包各自 `packages/<pkg>/lib/`（`*.js` + `*.d.ts` + 两种 `.map`）；
- **插件的 `lib/`**：`pnpm build:dsh` 产出，`lib/index.js`（host 半边）、`lib/client.js`（browser 半边）、
  `lib/types/**`（`tsc` 产物，同时是 `tsdown` 的输入——运行时只加载前两个）；打包产物 `dist/*.tgz` 由 `pack:plugin` 生成。

#### 一、构建

| 命令 | 作用 | 产物 / 影响 |
|---|---|---|
| `pnpm install` | 装工作区依赖（7 个工程） | `node_modules/`；`autoInstallPeers: false`，所以 `@deepseek-ai/*` 不入依赖图，由 `link-dsh` 软链 |
| `pnpm build` | **5 个引擎包**（contract / retrieval-core / core / cli / mcp）的 tsc 编译 | `packages/<pkg>/lib/`。**不含插件**（filter 排除了 `@avantf/dsh-mem`），因为插件构建对着已安装的 dsh |
| `pnpm build:dsh` | **插件唯一入口**，自动判断走哪条路：`lib/` 缺失 → 首次编译（必要时 `pnpm install` + `pnpm build`）；`lib/` 在 → 重建（只重建 `src/` 比 `lib/` 新的引擎包）。两条路都是：从**已安装的 dsh** 链接邻居包 → 插件 `tsc + tsdown` → mount smoke | `packages/plugin/lib/{index,client}.js` + `lib/types/**`，约 5–7 秒 |
| `pnpm build:dsh --fresh` | 强制走首次编译（产物缺失/损坏时） | 同上 |
| `pnpm build:dsh --skip-deps` | 完全不碰引擎包（只改插件时更快） | |
| `pnpm build:dsh --no-verify` | 跳过构建后的 mount smoke | |
| `pnpm rebuild:dsh` | `build:dsh` 的别名 | |
| `pnpm -C packages/plugin run bundle` | UI 半边的逃生口：纯 `tsdown`（**不做类型检查**、不跑 mount smoke），**改设置页 UI 用这条，无需重启 dsh**；preset 恒用仓库自带的副本，所以在没有 harness 源码的机器上也能跑 | `lib/{index,client}.js` |
| `pnpm -C packages/plugin run build` | 插件的原始构建（`tsc + tsdown`），就是 `build:dsh` 的第 ③ 步；`tsc` 对着 `link-dsh` 链好的（已安装 dsh 的）类型检查 | `lib/{index,client}.js` + `lib/types/**` |
| `pnpm -C packages/plugin run watch` | `tsdown --watch`：持续重建两个半边；UI 改动自动热替换，host 改动仍需重启 dsh | |
| `pnpm -C packages/<pkg> run build` | 单包编译（`<pkg>` ∈ contract / retrieval-core / core / cli / mcp） | 该包 `lib/` |

#### 二、类型检查与测试

| 命令 | 作用 | 备注 |
|---|---|---|
| `pnpm typecheck` | 5 个引擎包的 **src + test** 类型检查（`tsc -p tsconfig.test.json`） | 无产物；测试类型也是门禁 |
| `pnpm typecheck:dsh` | 插件的 **src + test** 类型检查 | **需要已安装 dsh 的链接**（`link-dsh`），所以 CI 不跑、只在本地跑 |
| `pnpm test` | 6 个包的 vitest（含插件） | |
| `pnpm -C packages/<pkg> run test` | 单包测试 | |
| `pnpm -C packages/<pkg> run typecheck` | 单包类型检查（含 test tsconfig） | |

#### 三、打包与发布门禁

| 命令 | 作用 | 产物 / 备注 |
|---|---|---|
| `pnpm pack:plugin` | 打出"用户安装的那**一个**包"并断言自包含：引擎已内联、依赖里没有 `@avantf/*`、`catalog:` 已落成真实范围、`files` 含 `lib`+`README.md` | `dist/avantf-dsh-mem-<version>.tgz` |
| `pnpm pack:plugin --mount` | 再把 tarball 解进临时 profile **真实安装并挂载**（需要已安装的全局 dsh） | `--out <dir>` 换输出目录，`--keep` 失败时保留 scratch |
| `pnpm release:check` | 发布门禁一条命令：preflight（6 包版本一致 / CHANGELOG 已切 / 只 plugin 可发布 / 声明了 DSH peer）→ frozen-lockfile → build → typecheck → test → 插件 typecheck → `build:dsh`+mount smoke | 打 tag 前必跑；`--allow-uncut` 用于切版本节之前的预跑 |
| `pnpm release:tree --into <rc>`（**仓库根**） | 把 `dsh-plugins` **整仓**投影成发布树，只报告漂移（有漂移 exit 1） | 只管理 rc 跟踪的文件 |
| `pnpm version:set mem X.Y.Z`（**仓库根**） | 切版本：**只改一个文件** `packages/plugin/package.json`（组内其余 manifest 不带版本） | `pnpm version:check` 会拦"私有包又长出版本号"，`pnpm release:check` 也会 |
| `pnpm release:tree --into <rc> --apply` | 同步发布树（版本默认取开发树，`--version mem=X` 可只给 rc 盖） | 规则见根 `scripts/make-release-tree.mjs` 顶部 |
| `pnpm release:tree --out <dir>` | 生成一棵全新的发布树（含生成的根 `README.md`） | |
| `pnpm sync:rc …`（**仓库根**） | 上面的封装：预览 → 确认 → 投影 → 复查（`--dry-run`/`--yes`/`--version <组>=<v>`/`--commit`/`--gate`/`--rc <dir>`） | 默认保留每个组在 rc 里的版本号 |
| `pnpm --filter @avantf/dsh-mem publish --access public --no-git-checks` | 真正发布（**只这一个包**） | 其余 5 个是 `private: true`，`pnpm -r publish` 碰不到 |

#### 四、基准与辅助

| 命令 | 作用 |
|---|---|
| `pnpm bench:vstore` | 向量库规模基准——`vectorStore.auto_thresholds.hnswlib`（默认 2000）的选型依据，同时量 ANN 的召回损失 |
| `pnpm bench:memory` | 记忆库规模基准——检索腿随语料增长、`remember update` 在 hnswlib 之后的 O(N)、启动重建 ANN |
| `pnpm bench:ingest` | 知识摄入基准——用**真实 embedder** 量 ms/chunk 与模型加载时间（摄入瓶颈就是逐 chunk 的 ONNX 编码） |
| `pnpm bench:indexes` | 索引 A/B 实验台——`docs/PERFORMANCE_REVIEW.md` §5 的依据，含一个被实验证伪的部分索引反例 |
| `pnpm bench:reinforce` | 读路径写放大——`search`（`track: true`）触发的语句数与 WAL 字节、开/关 `track` 的延迟对比 |
| `node scripts/mount-smoke.mjs` | 独立挂载自检：真实 Cordis 上下文挂载插件 + 降级挂载（坏 `dataHome`）；peer 恒取自已安装的全局 dsh，期望输出 `MOUNT SMOKE OK` |
| `node scripts/link-dsh.mjs` | 重建插件的 `@deepseek-ai/*` 软链接，**来源恒为已安装的全局 dsh**（`npm root -g`），让插件与宿主共用同一批 cordis/schemastery 实例；不接受任何模式参数。同时给自带 preset 根发布 manifest stub（`packages/plugin/vendor/dsh-client-preset/packages/client/avantf-dsh-mem/package.json`，指向本插件 `package.json` 的软链） |
| `node scripts/check-preset-drift.mjs` | 逐个字节比较自带的 8 个 client-preset 文件与 harness checkout；有漂移时列出文件与两侧 revision 并 exit 1，没有 checkout 时什么都不比、exit 0 |
| `pnpm clean` | 删 `packages/*/{lib,dist}` 与 `node_modules/{.cache,.vite}`；之后 `pnpm build:dsh` 会走首次编译路径 |
| `pnpm cleanup:dsh [--dry-run\|--yes\|--keep-deps\|--profile <p>]` | 从 dsh profile 卸载插件并清 `cordis.patch.yml`（不动 `~/.avantf`，也不动仓库） |

> 各命令的完整旗标以 `--help` 为准：`pnpm build:dsh --help`、`node scripts/make-release-tree.mjs --help`、
> `bash scripts/sync-release-repo.sh --help`、`bash scripts/cleanup.sh --help`。
> 编译产物的清理、插件两个半边的生效规则、链接来源与 client preset 的细节见下文各小节。

### 入库边界（`source_uri` 读什么、能读哪）

`kb_ingest` 的 `source_uri` 会被**读取**（本地文件读盘、http(s) 拉取），读到的内容进索引后又能被
`kb_query` 检索回模型上下文——不设限就是一个「读任意文件 / 探内网」的原语。所以默认收紧，按资源种类
各留一个显式开关（写在 `~/.avantf/configs/knowledge.yaml`，不是公共的 `config.yaml`）：

- **本地路径**必须落在允许根内，默认只有进程工作区（cwd）；比较前先 `realpath`，`..` 与符号链接都逃不出去。
- **`http(s)`** 默认拒绝 loopback/私网/链路本地（`localhost`、`*.local`、`169.254.169.254`、
  `[::ffff:127.0.0.1]`、`http://2130706433/` 等写法都会被规范化后判掉）；**重定向逐跳复检**（上限 5 跳）。

```yaml
# ~/.avantf/configs/knowledge.yaml
ingest:
  local_roots: ['/srv/docs']        # 额外允许的根；留空 = 仅工作区
  allow_outside_workspace: false    # true = 不限制本地路径
  allow_private_network: false      # true = 允许拉取内网地址
```

被拒绝时会明确告诉你缺哪个开关（错误信息里带配置键与文件路径）。已知范围外：域名**解析结果**为私网
（DNS rebinding）不在防护内。

### 知识域清单（`knowledge.domains`）

文档的 `domain` 是**写入侧的受控取值**：同一个领域随手写成两个名字，检索与浏览就会各看到一半。默认给出
一小组通用领域，非空清单之外的**新**领域会被 store 拒绝（错误里列出全部允许值），agent 工具 / CLI / MCP / 界面
都走这同一道闸门：

```yaml
# ~/.avantf/configs/knowledge.yaml
domains:              # 允许的领域；库中已有的领域始终仍然可用
  - design
  - api
  - ops
  - research
  - notes
# domains: []         # 显式空数组 = 不限制（任何领域都接受）
```

「知识」页的 domain 控件读同一份清单（并入库里已有的领域），清单非空时是**下拉、不留自由输入**——新增领域
请改这一项配置。`source` 则始终可留空，缺省为 `default`。

### DSH 插件构建

`@avantf/dsh-mem` 是一个**标准 DSH Cordis 插件**（不是动态包）。它引用
`@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-typert-protocol`，而后者的传递依赖并未全部单独发布，
因此需要在 **DSH harness 工作区内部**构建：

```bash
pnpm build:dsh                 # 自动判断：没编译过就首次编译，编译过就重建
node scripts/mount-smoke.mjs   # 挂载验证（harness 自动发现；必要时用 DSHHARNESS 覆盖）
```

引擎包（`@avantf/mem-*`、CLI、MCP）可独立构建与测试；只有 DSH 插件包
（`@avantf/dsh-mem`）与 harness 工作区耦合。

### DSH 插件：改完源码后怎么编译、怎么生效

插件的 `~/.dsh/profiles/web/package.json` 用 `link:` 直接指向本仓库的 `packages/*`，
**没有拷贝步骤**：重建 `lib/` 即可。但插件有**两个半边**，生效方式不同：

| 改了什么 | 需要重建 | 需要重启 dsh | 需要刷新页面 |
|---|---|---|---|
| `packages/plugin/src/client/**`（设置页 UI，→ `lib/client.js`） | `pnpm -C packages/plugin run bundle`（或完整 `build:dsh`） | **不用** | 通常不用 |
| `packages/plugin/src/**` 其余（host 半边，→ `lib/index.js`） | `build:dsh` | **要** | 重启即整页重载 |
| `packages/{core,contract,retrieval-core}/src`（引擎包） | `build:dsh`（自动重建变更的引擎包） | **要** | — |
| `~/.dsh/profiles/web/cordis.patch.yml` | 不用 | **不用**（profile 配了 `patchReload: live`） | — |

生效规则来自 DSH 自己的两条链路（`dsh-web-app/cordis.patch.yml` 与 `dsh-base/cordis.patch.yml`）：

- **browser 半边**：`client-hmr` 行被**无条件挂载**，它每 **500 ms** `stat` 一次每个
  `dsh.client` 行的 bundle 文件，mtime/size 变了就重算 rev，并通过 `/plugins/events`（SSE）
  推送 `rebuilt` 帧，浏览器半边据此热替换该模块 → 重建即生效。
- **host 半边**：唯一的模块热重载通道 `hmr`（`@deepseek-ai/cordis-plugin-hmr`）在 `dsh-base` 里是
  **`disabled: true`**，本 profile 没有打开；node ESM 模块在 profile 启动时 import 一次并缓存
  → 必须重启 dsh 进程。

一条命令 `pnpm build:dsh`（= `node scripts/build-plugin.mjs`）自动判断走哪条路：

| 状态 | 模式 | 做什么 |
|---|---|---|
| `packages/plugin/lib/{index,client}.js` 缺失 | **首次编译** | 必要时 `pnpm install` → `pnpm build`（引擎包）→ 插件 tsc+tsdown |
| 两个产物都在 | **重建** | 先只重建 `src/` 比 `lib/` 新的引擎包（都没变就跳过）→ 插件 tsc+tsdown |

两条路都会：从**已安装的 dsh** 链接邻居包 → 构建 → 挂载验证，最后告诉你还需不需要重启 dsh。约 5–7 秒。

```bash
pnpm build:dsh                 # 自动（首次编译 / 重建）
pnpm build:dsh --fresh         # 强制走首次编译
pnpm build:dsh --skip-deps     # 完全不碰引擎包（只改插件时更快）
pnpm build:dsh --no-verify     # 跳过挂载验证
pnpm rebuild:dsh               # build:dsh 的别名
```

只改 UI 时用 `pnpm -C packages/plugin run bundle`：纯 tsdown、**不做类型检查**、不跑挂载验证，
`client-hmr` 会自动热替换；要类型检查就用完整的 `pnpm build:dsh`。

#### 清理编译产物

```bash
pnpm clean      # 删掉 packages/*/lib、packages/*/dist、以及 node_modules 下的 .cache / .vite
```

`packages/*/lib` 是**唯一**的编译产物（6 个包，约 2 MB；插件只用 `lib/`，没有 `dist/`），
且本项目不使用 `incremental`/`composite`，所以没有 `*.tsbuildinfo` 之类会残留的增量缓存。
`clean` 后再跑 `pnpm build:dsh`，会自动走**首次编译**路径（模式判定见上）。

有两样东西 `clean` **故意不动**（它们不是编译产物，删了反而要重新搭环境）：

- `packages/plugin/node_modules/@deepseek-ai/*` 符号链接与 harness 里的 stub 目录
  `<harness>/packages/client/avantf-dsh-mem/`：由 `link-dsh` 维护，重建插件时会重新发布；
- `node_modules/.pnpm-*` 等 pnpm 自身的状态文件。

#### 接入 / 切换来源 / 移除（源码接入）

profile 里的插件就是**一条 `link:` 依赖**（发布构建把引擎内联进 `lib/index.js`，开发构建从插件自己的
`packages/plugin/node_modules/@avantf/*` workspace 链接解析引擎，所以只需要 `@avantf/dsh-mem` 一条）：

```bash
# 接入一个 checkout（示例：开发仓库 / 发布仓库）
dsh plugin --profile web add link:/home/qunqi/opensource/avantf-mem/packages/plugin
dsh plugin --profile web add link:/home/qunqi/opensource/avantf-mem-rc/packages/plugin

# 移除接入（只是把 profile 依赖删掉，不动挂载配置）
dsh plugin --profile web remove @avantf/dsh-mem

# 切换来源 = 先移除、再接入（同一条命令换路径）
dsh plugin --profile web remove @avantf/dsh-mem
dsh plugin --profile web add link:/home/qunqi/opensource/avantf-mem-rc/packages/plugin

# 看现在接的是谁
dsh plugin --profile web ls --depth 0
readlink -f ~/.dsh/profiles/web/node_modules/@avantf/dsh-mem
```

- **`cordis.patch.yml` 不用改**：它按包名 `@avantf/dsh-mem` 挂载，换来源只换 link 目标；
- **必须重启 dsh 才生效**：宿主半边在启动时 import 一次并缓存，客户端模块图也是启动时构建
  （`patchReload: live` 只让 patch 配置热加载，不会换模块）。重启之前运行中的进程不受影响；
- `dsh plugin … add/remove` 只改 profile 的 `package.json` / `lockfile` / `node_modules`；
  **不在 manifest 里的残留 `@avantf/*` 符号链接 pnpm 不会回收**（切换来源后我遇到过三条），确认后手动 `rm`；
- 换到发布仓库（`avantf-mem-rc`）后，改开发仓库的代码**不再**影响运行中的 dsh：
  要重新走 `pnpm sync:rc` → `cd <rc> && pnpm build:dsh` → 重启 dsh。

#### 卸载插件（cleanup.sh）

```bash
pnpm cleanup:dsh --dry-run      # 先看计划与 patch diff，不改任何东西
pnpm cleanup:dsh                # 交互确认后执行
pnpm cleanup:dsh --yes          # 非交互
pnpm cleanup:dsh --keep-deps    # 只改 patch，保留 profile 依赖
```

做两件事：

1. 从 `~/.dsh/profiles/<profile>/cordis.patch.yml` 与**home 层** `~/.dsh/cordis.patch.yml`
   （dsh 会把它叠在每个 profile 之上）中，**外科式**删掉 `- id: avantf-mem` 这一项，
   以及被删空的 `- insert:` 父项；其他插件条目、注释、缩进原样保留。
   改前备份为 `cordis.patch.yml.bak.<时间戳>`，并且**双重护栏**：剩余 `- id:` 集合必须恰好
   等于「改前 − avantf-mem」，改后文件必须仍能载入 dsh（dsh 要求顶层是 YAML **数组**，
   所以删空时会自动补回 `[]`），否则整体中止且不写任何文件。
2. 通过 `dsh plugin --profile <profile> remove @avantf/dsh-mem @avantf/mem @avantf/mem-contract
   @avantf/mem-core` 卸掉 profile 依赖（更新 package.json/lockfile 并删除
   `node_modules/@avantf/*`）；命令行里**只出现这四个包名**，不会碰其他插件。

**故意不动**（脚本结束时会逐条提示）：`~/.avantf/**`（数据库 / 配置 / 受管资源）、仓库（源码、`lib/`、
`packages/plugin/node_modules/@deepseek-ai` 链接）、harness 里的 stub、`~/.cache/huggingface`。
要连数据一起清（不可逆，先备份）：

```bash
tar czf ~/avantf-data-$(date +%F).tgz -C ~ .avantf/memory .avantf/knowledge .avantf/configs .avantf/prompts
rm -rf ~/.avantf/memory ~/.avantf/knowledge ~/.avantf/configs/common.yaml ~/.avantf/models ~/.avantf/env
```

> profile 配了 `patchReload: live`，所以 patch 一改，运行中的 dsh 会**立刻卸载**该插件（当前会话的
> avantf-mem 工具也会同时消失）；建议之后冷启动一次 dsh 确认启动无报错。
>
> 数据目录不是本插件独占的：`~/.avantf` 里还有旧项目的 `venv/ logs/ agents/ skills/ sessions/
> system.json` 等，**不要 `rm -rf ~/.avantf`**，只删 `memory/ knowledge/ config.yaml models/ env/`
> （`env/` 是框架族根：受管的 `runtime/ tools/ models/`；`models/` 是 legacy 缓存目录）。

#### 链接：只有「已安装的 dsh」一个来源（重要）

插件要 import `@deepseek-ai/*`，而**编译与运行必须是同一份**：

- 邻居包只有一个来源：**已安装的全局 dsh**（`node scripts/link-dsh.mjs`，从 `npm root -g` 下的
  `@deepseek-ai/dsh/node_modules/@deepseek-ai/*` 软链）。插件与运行中的 profile 共用同一批
  cordis/schemastery 实例，`ctx.typert.register` 与工具注册表都靠对象身份，链一份而跑另一份会在运行时
  对不上。`pnpm build:dsh` 的第一步就是它，链接保持不动（不再有"构建时切到 checkout、之后再切回"）。
- 编译**不需要 harness 源码**，也就没有第二种链接来源：`tsc` 与 mount smoke 都对着
  已安装的 dsh，`node scripts/link-dsh.mjs` 不接受任何模式参数。

client preset 的来源同样是固定的：仓库自带的 pin 住的副本
（`packages/plugin/vendor/dsh-client-preset/`，8 个文件 / 2334 行，逐字节拷贝；来源与重新对齐见
`ORIGIN.md`）。`tsdown.config.ts` 按字面相对路径 import 它，不经过任何 checkout 解析，也没有 env
开关。harness checkout 只被可选的漂移核对用到（`node scripts/check-preset-drift.mjs`），不参与编译。

只改了 UI 时用 `pnpm -C packages/plugin run bundle`（纯 tsdown，不做类型检查）。

#### 连续开发

```bash
pnpm -C packages/plugin run watch   # tsdown --watch：持续重建 lib/index.js + lib/client.js（不做类型检查）
```

UI 改动边写边自动热替换；host 改动仍需重启 dsh。
（tsdown 的 client preset 按当前根 glob `packages/*/*/package.json` 找本插件的 manifest，所以 `link-dsh`
会在自带 preset 根下发布 stub `packages/client/avantf-dsh-mem/package.json`——指向
`packages/plugin/package.json` 的软链；stub 被删掉时重跑一次 `link-dsh` 或 `pnpm build:dsh` 即可。）

