# Changelog

All notable changes to `avantf-mem` are documented here.

## [Unreleased]

### Changed（检索相关性门槛：绝对分门槛打在融合之前，`0` = 关）
- 三条检索腿各加一个**绝对门槛**，打在**每条腿的原始分**上、`fuse()` **之前**（`core/src/store/floors.ts`，
  经 `HybridContext.floors` 下发，两条 store 的腿各自应用）：语义腿余弦 `min_semantic_similarity`
  （默认 **0.5**）、FTS 腿**逐行**命中的**不同查询词元数** `min_fts_terms`（默认 **2**，词元复用
  `store/lexical.ts` 的 `relevanceTerms()`）、实体腿 Jaccard 比值 `min_jaccard`（默认 **0.2**）。
  **等于门槛保留**，只丢严格小于；三者 `0` = 关闭。不能用融合分当门槛：`retrieval-core/src/fusion.ts`
  的 `scaleByMax` 让每条腿的头名恒为 1.0，融合分只在一次查询内可比（DESIGN §20.19）。
- **降级放宽**：语义后端不可用（走 `DEGRADED_WEIGHTS`）时，`min_fts_terms` 的**生效值降为 1**；配置的
  `0` 仍为 `0`。
- **可观察行为变更**：`RecallResult`（`mem_recall.search`、`kb_query`、跨库）新增 `floors`（生效门槛）
  与每腿 `dropped_by_floor`（`{semantic,fts,jaccard,hrr}`）；检索健康度新增
  `candidates_dropped_by_floor`。这样"结果为空"能区分"门槛挡掉了 N 条"和"本来就没有候选"。HRR 探针的
  候选集被 Jaccard 门槛收窄（原始候选非空但被清空时**不再**回退到"最近 cap 条"）。图路径
  （`probe`/`related`/`reason`/`chain` 的图查询与 `ask` 的三元组路径）不套门槛。**工具描述与 systemPrompt
  段一字未动。**
- **标定与重冻**：35 条中文评测集、模型实测打开（其余两个门槛置 0 以隔离语义旋钮）：0.40/0.45/0.50 三档
  P@k/R@k/MRR/must_include 相同，`must_exclude` 0.5143 → 0.5429 → **0.6000**、总命中 66 → 62 → 60 → 56；
  0.55 起质量掉档（MRR 0.9857 → 0.9571、must_include → 0.9429、首次出现空结果）。**取拐点 0.50 为默认。**
  降级路径（`eval_zh.spec.ts` 的精确断言）七个汇总数字**逐位不变**：该 spec 跑的是无模型路径，生效门槛
  `{semantic:0.5, fts:1, jaccard:0.2}`，实测 35 条查询的 `dropped_by_floor` 合计
  `{semantic:0, fts:0, jaccard:0, hrr:0}`（语义腿不在、FTS 门槛放宽为 1、Jaccard 门槛在这套小语料上没
  砍到候选）——原因与复核写进该 spec 注释，边界行为由新增的 `test/floors.spec.ts` 在两条 store 上钉住。
  **换嵌入模型必须按 DESIGN §20.19 重新标定**（0.5 只在 `Xenova/bge-small-zh-v1.5`、dim 512、mean+normalize
  下成立）。

### Changed（数据库系统统一为运行时内置的 `node:sqlite` + DSH Desktop 支持）
- **存储层只剩一个实现：运行时的 `node:sqlite`，`better-sqlite3` 被彻底移除**（`db/sqlite.ts` 是唯一的
  适配器；原来的驱动选择器 `db/binding.ts` 与第二个适配器 `db/sqlite_node.ts` 一并删除）。原因是它无法被
  统一：`better-sqlite3` 是 NAN 扩展，`.node` 绑死在**一个** `NODE_MODULE_VERSION` 上，而 DSH Desktop 把
  profile 宿主跑在 Electron 里（实测 Electron 44：`process.versions.modules = 149`，`dsh.cmd` 就是
  `DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`），上游预编译只到 `electron-v132`，于是
  `new Database()` 抛 "Could not locate the bindings file"、记忆库整块不可用。内置模块就在跑插件的那个
  运行时里（Node 22.13 / 23.4 起免 flag；实测 Node 22.23 带 SQLite 3.51.3、Electron 44 带 3.53.1，两边
  FTS5 与 `trigram` 都在），一份实现服务所有宿主，不再有第二条需要被证明"行为一致"的代码路径。
  `db/port.ts` 的端口与它之上的契约逐条不变：位置参数与裸名命名参数、语句未用到的命名参数被忽略、BLOB
  一律返回 `Buffer`、`pragma()` 读写、事务与 `SAVEPOINT` 嵌套。`runtime init` 行现在是
  `sqlite=node:sqlite <版本>`——SQLite 版本随宿主的运行时走，正是排查"两台主机行为为何不同"要看的那一项。
- **新增能力探测**（`sqliteProbe()`；`probeModule()` 用假模块把三条拒绝分支都单测到）：打开内存库之后
  还要过两关——**FTS5 必须在**（两个 schema 在 open 那一刻就建 fts5 虚表），**必须支持"语句未用到的命名
  参数"**（`setAllowUnknownNamedParameters`，Node 22.15 / 23.11 才有；DAOs 会把同一份参数对象交给用了
  不同子集的语句，`FactsDao.purgeArchived` 就是那条）。任一不满足都给**一句原因**，插件按原有语义降级
  挂载（8 个工具回 "memory unavailable"，不拖垮宿主启动），而不是等到 DDL 抛错或 lifecycle tick 挂掉。
  真正的库文件打不开（损坏 / 被锁 / 更新版本的 schema）**不会**被当成驱动问题，仍按原样报出自己的原因。
- **环境要求收紧为 `node: ">=22.15.0 <23 || >=23.11.0"`**（写进 `engines` 与 README）：这是"内置模块免
  flag"（22.13 / 23.4）与"支持未用到的命名参数"（22.15 / 23.11）的交集。低于该下限的宿主照常挂载，只是
  记忆库不可用并报出原因。
- **依赖面归零**：`better-sqlite3` 与 `@types/better-sqlite3` 从两个 manifest 移除，catalog 条目与
  `allowBuilds.better-sqlite3` 一并删掉。安装期不再有 SQLite 原生模块需要放行构建（`pnpm approve-builds`
  只剩 nodejieba / hnswlib-node / onnxruntime 这些可选加速件），"postinstall 构建失败 → 整单 `pnpm add`
  回滚、插件根本装不进来"这类失败也随之消失。
- **声明组合包（`dsh.bundle.patch` → 随包的 `cordis.patch.yml`）**：DSH Desktop 的「插件」页与
  `plugin_manager` 只接受组合包，此前本包在界面上装不了、只能手写挂载行。`dsh plugin add` 装本包时
  会自动把它选进 `dsh.profile.bundles`（实测），挂载行随包插入，所以装完通常什么都不用做；只有用
  npm / yarn 装、或手工编辑 profile 包清单而没有选中组合包时，才需要自己写那一行。两条都做也不会挂
  两次（loader 按条目 id 去重，实测只挂载一次）。
- **知识库的文档转换在 Windows/DSH Desktop 上终于可用**（底座修复）：`@avantf/dsh-plugin-base` 的
  `binary-archive` provider 之前按**声明的名字**落盘，而 Windows 的 pandoc 归档里是 `pandoc.exe`，
  于是装成了 `bin/pandoc`——Windows 无法执行没有扩展名的 PE 镜像，`--version` 探针失败，刚下载的
  223 MB 被隔离。现在落盘与 `install.json` 的 `entry` 都用归档里的真实文件名，实测 Desktop 上
  `mem:pandoc installed (installed 3.11)`，且第二次启动认作 `present`。
- **新增 `test/sqlite_adapter.spec.ts`**（取代 `sqlite_backend.spec.ts`）：对唯一的适配器断言那份 `Db`
  契约（多语句 exec / 位置与命名参数 / 未用到的命名参数 / pragma 读写 / 事务与 savepoint 嵌套 / BLOB
  归一化为 `Buffer` / FTS5 / 语句缓存 / close），并用假模块覆盖能力探测的三条拒绝分支与启动描述行。

### 维护提示（装机实测，别凭直觉）
- **`dsh plugin add` 请带上版本号**。pnpm ≥ 10 的 `minimumReleaseAge` 会避开刚发布的版本：不钉版本时
  `add @avantf/dsh-mem` 会解析到几天前那一版，而旧版的 peer 区间可能不含当前宿主的 dsh（例如
  `0.2.0-rc.2`），于是宿主的安装门禁**直接拒绝这一单并回滚 profile**
  （`installation rejected: … is incompatible with dsh 0.2.0-rc.2`）。README 的安装步骤已改成钉版本。

## [0.3.1] - 2026-09-28

### Fixed（dsh 0.2.0-rc 线：声明区间漏了新 rc 线）
- **dsh peer 区间补上 `^0.2.0-rc.2`**（现为 `^0.1.5-rc.2 || ^0.1.7-rc.2 || ^0.2.0-rc.2`）：dsh 从 0.2.0-rc.2 起，
  宿主的插件管理器在 boot 时读插件的 `peerDependencies` 判兼容，判不兼容就**直接禁用该插件行**
  （`dsh: disabling profile plugin row "avantf-mem" … incompatible with dsh 0.2.0-rc.2`）。而按 semver 的预发布
  规则，`^0.1.x` 的上界 `<0.2.0` 不接受 `0.2.0-rc.2`，于是插件**能跑却因声明被整行禁用**。已在本机对
  0.2.0-rc.2 实测：`typecheck:dsh`、`test:dsh`、mount smoke 全绿，代码零改动——只有声明变，故为 patch。
- 维护提示（**实测出来的，别凭直觉**）：dsh 的启动门用
  `semver.satisfies(runtime, range, { includePrerelease: true })` 判定（`dsh-app-boot` 的 peer 检查）。该选项会把
  caret 的上界写成 `-0` 形式，于是 `^0.2.0-rc.2` 实际是 `>=0.2.0-rc.2 <0.3.0-0`，**覆盖整条 0.2.x 线**：
  `0.2.0-rc.5`、`0.2.1-rc.1`、`0.2.9-rc.3`、0.2.x 的正式版全部放行（逐条实测过）。**所以只有跨 minor 线**
  （`0.3.0-rc.1` 出现时）**才需要补一条** `|| ^0.3.0-rc.x`，同线内的任何 dsh 更新都不必再发版。
  另一侧比它更严的是**安装期**：pnpm/npm 默认**不带** includePrerelease（预发布必须同 tuple），所以同线内的新
  rc tuple（`0.2.1-rc.1`）会给出 unmet peer 告警——那只是告警，不影响加载。补声明前先对那条线跑
  `node ../scripts/check-old-dsh.mjs mem --floor <新线>` 与本机门禁，确认能跑再写。

## [0.3.0] - 2026-09-28

### Changed（条件提示合并为一条，判定塌成布尔）
- **记忆 / 知识两个条件上下文合并成一个** `avantf:mem-hint`（order 130）：`kb_query` 本身就是跨库检索
  （文档切片 + 记忆事实），两库任意一侧命中就渲染同一句
  （`[avantf-mem] 记忆或知识库里有与上条用户消息相关的内容；需要时用 kb_query 检索。`），否则渲染
  空串（零 token）。旧的 `avantf:memory-hint` / `avantf:knowledge-hint` 各点一个工具，模型照做就是两次
  重叠调用——记忆事实从 `mem_recall` 回来一次、又混在 `kb_query` 的融合结果里回来一次；合并后
  `memory↔knowledge` 翻转也不再追加新快照（实测约占这些会话快照追加总数的四分之一、约 22k 字符）。
  `mem_recall` 仍是记忆专有动作（chain / probe / reason / contradict）的工具，那件事归常驻的记忆用法段
  与它自己的描述。
- **`AvantfRuntime.relevance(text)` 由四值 `RelevanceHit` 改为 `boolean`**：只回答"要不要提示"；两个库的
  探针仍各自跑（`||` 短路：记忆命中就不再探知识）。
- **判定只认用户发的消息**：`agent/inbox/inserted` 也承载插件唤醒与子代理通知，非
  `source.kind === 'user'` 的插入不再改写提示（此前一条"任务 n1 已结束"的唤醒会改写"与上条用户消息
  相关"的判定）。

### Added（跨版本门：对区间下限跑 LOCAL 步骤）
- **`pnpm check:old-dsh`**（工作区根的 `scripts/check-old-dsh.mjs <base|mem|mission>`；mem 侧入口
  `pnpm -C mem check:old-dsh`）：从插件自己的 dsh peer 区间取**下限**、在临时目录装一份全部钉在该版本的
  dsh 闭包、用 `npm_config_prefix` 让 `link-dsh` 指向它，然后跑该包的 LOCAL 步骤
  （`link-dsh` → `typecheck:dsh` → `build:dsh`，含 `test:dsh` 与 mount smoke），**无论成败都恢复现场**。
  已作为**最后一步挂进 base / mem / mission 三个 `release:check`**（它要重新链接并重建产物，所以必须排在
  `pack` 之后）。LOCAL 门禁原本只对着本机装的 dsh，"新改动是否偷偷要求了更新的宿主"要等运维装了旧版才
  暴露；这条命令把发现提前到本地（实测 `0.1.5-rc.2` 下限下三个包全绿）。缓存 `$TMPDIR/avantf-old-dsh-<floor>`，
  支持 `--list` / `--fresh` / `--floor`。
- **`test/provision.spec.ts` 的 healthy-host 用例改为显式构造**（`declared = runtime`，新增 `HEALTHY_SPEC`）：
  src 运行时读不到 `lib/dsh-build.json`，`declared` 会回退到 peer 区间**下限**，那条用例于是隐含假设
  "本机装的 dsh 恰好等于下限"——只在区间刚为该版本抬过时成立，换台机器就变红（在 rc.3 机器上实测红、
  在下限 rc.2 下实测绿），而红的原因不是插件有问题。

### Fixed（dsh 0.1.7：Typert 契约移动 + peer 区间不含 0.1.7-rc）
- **wire face 不再 import registry 的 schema 类型**：0.1.7 把 `TypertSchema{name,schema}` 换成
  `TypertSchemaFactory{name,create}`、并从 `dsh-typert-registry/types` 移除了前者，同一代里 `TypertCodec`
  也去掉了 `.schema` 成员——`src/remote.ts` 因此在 0.1.7 上编译失败（`TS2305` + 两处 `TS2339`）。现在按
  mission 的既有做法**结构化声明** entry（两个成员都带：0.1.5 读 `schema`、0.1.6+ 调 `create()`），schema 值
  用本包自己的 `z.ZodType`，从 codec 上取 schema 也改为本地访问器；host 的 `TypertCodec` 类型里还有没有
  `schema` 这个名字，不再影响本包编译。
- **dsh peer 区间放宽为 `^0.1.5-rc.2 || ^0.1.7-rc.2`**：按 semver 的预发布规则，`^0.1.5-rc.2` **不接受**
  `0.1.7-rc.2`（而这正是 registry 上的 `latest`），于是插件实际能跑在 0.1.7-rc 宿主上、声明里却写着
  "不支持"（安装期表现为 unmet peer 告警）。disjunction 同时保留 0.1.5 线与 0.1.7-rc 线；`floorOf` 仍取
  `0.1.5-rc.2`，跨版本门的语义不变。

## [0.2.0] - 2026-09-24

### Changed（底座换包：`@avantf/dsh-envinit` → `@avantf/dsh-plugin-base`）
- **插件声明的底座换成 `@avantf/dsh-plugin-base`**：peer 区间 `>=0.3.0 <1.0.0`（**required**，不在
  `peerDependenciesMeta` 里标 optional），`devDependencies` 同一条区间；旧的 `@avantf/dsh-envinit` peer
  作废（它的 optional → required 演变见 0.1.1）。升级时宿主 / profile 里要提供这一份底座，
  否则按下面的降级路径挂载。
- **底座由宿主提供、按 file URL 动态加载**：插件对底座**唯一**的静态引用，是 vendor 进
  `packages/plugin/src/envinit-bootstrap.js` 并**内联**进产物的零依赖 bootstrap（`scripts/link-envinit.mjs`
  从工作区的底座构建逐字节 vendor，`scripts/copy-envinit-bootstrap.mjs` 拷进 `lib/`）；启动时它用
  `createRequire(import.meta.url).resolve('@avantf/dsh-plugin-base/package.json')` 解析到那份安装副本、
  用内联的 `supportedRange` 校验版本，再 `await import()` 它的入口。源码里没有一句静态
  `import ... from '@avantf/dsh-plugin-base'` —— 那会让底座缺席时插件模块在 import 阶段就失败。
- **底座缺失或接口世代不同时只降级、照常挂载**：拿不到底座（或版本超出区间）时打一条
  `envinit: WARNING`，提示词层退回插件**内置的默认正文**、兼容门禁跳过（`compat:` WARNING），
  工具 / service / Remote / UI 全部照常注册，**绝不拒载**。运行时用底座自己的 `checkInterface` /
  `readInterfaceRequirement` 比对"构建时所对的世代"与"加载到的世代"：`incompatible` 只是不用底座的共享
  能力，`cannot-tell` 只告警。
- **构建期烧入接口世代**：`scripts/link-envinit.mjs` 在 vendor 的同一步把底座版本与接口世代写进
  `lib/interface-version.json`（当前 `{"baseVersion":"0.3.1","interfaceVersion":1}`，随 `files: ["lib"]` 发布），
  运行时由 `src/interface_gate.ts` 从 `lib/index.js` 旁读回 —— 产物自己说得出它是为哪一代底座编译的。

### Changed（数据目录收敛：配置进 configs/，受管根只认族根）
- **配置集中到 `~/.avantf/configs/`**：`common.yaml`（原 `~/.avantf/config.yaml`）、`memory.yaml`
  （原 `~/.avantf/memory/config.yaml`）、`knowledge.yaml`（原 `~/.avantf/knowledge/config.yaml`）；
  分层与键名不变。`common.yaml` **缺失或空白时写入全注释默认模板**（与 prompt 文件同一条规则：文件有
  任何内容就是用户的，绝不重写；模板全注释 ⇒ 物化它不改变任何行为），失败只告警并退回内建默认。
- **不再有 `~/.avantf/{tools,models}` 回退**：内建默认直接指向族根（`familyToolsDir()` /
  `familyModelsDir()`：`$AVANTF_HOME` 否则 `~/.avantf/env`），CLI / MCP / 降级 sweep / 测试解析同一个
  目录，兼容软链因此不再需要（它让 `mkdir -p` 在目标缺失时抛 ENOTDIR，并把"某台机器建过链"变成隐式前提）；
  插件里"框架没给 pandoc 就退回 legacy 目录"的分支随之删除。`@avantf/mem-contract` 新增
  `familyHome`/`familyToolsDir`/`familyModelsDir`，`@avantf/provision` 以其零依赖方式镜像一份，
  由 `core/test/family_paths.spec.ts` 钉住两者不漂移。

### Fixed（数据根：profile 的 `dataHome` 归配置层）
- **插件 profile 里的 `config.dataHome` 是配置值（②），`$AVANTF_HOME`（④）压得过它**：它此前被直接塞进
  引擎的显式槽（⑤），于是设了 profile `dataHome` 的用户在 mem 这半边环境变量静默失效，而 mission 那半边
  同一条配置被环境变量压过 —— 同一个 profile 解析出两个目录，而 `<data home>/prompts` 是两边**共享**的
  （一边编辑的提示词另一边读不到）。现在两个半边同层；`mem/packages/plugin/test/data_home.spec.ts` 钉住
  这一层，`family_pin.spec.ts` 继续钉住两份解析器本身。
- **文档同步**：`DESIGN.md`（§3 开头与「配置分层」）、`docs/INSTALL.md`、`docs/PROVISIONING.md`、
  `packages/plugin/README.md` 与根 `AGENTS.md` 都改成 ⑤ 显式实参 → ④ `$AVANTF_HOME` → ② profile 的
  `dataHome` → `~/.avantf`，并写明 `configs/common.yaml` 里的 `dataHome` **不参与**这一步（那个文件在
  数据根之内，解析根时还没读到它），所以它对数据根无效。
- **默认 `common.yaml` 模板不再推荐 `dataHome`**：它在模板里被列成一个可写旋钮，而写在里面永远不会生效
  （文件在数据根之内）—— 与 `memory.category_values` 同一类"文档教了一个没用的键"。模板改为一句说明数据
  根由谁决定；schema 里的字段保留（它是解析器那个"配置层"参数的承载体），`config_files.spec.ts` 加一条
  断言防止它被写回模板。

### Added（系统提示词改为用户可编辑）
- 三个 systemPrompt 段落的正文改为**磁盘上的文件**，放在**家族共享**的 `<data_home>/prompts/`：`mem-memory-usage.md` / `mem-knowledge-usage.md` / `mem-kb-edit.md`（同目录下任务引擎用 `mission-` 前缀；各插件只动自己前缀的文件）。
  插件 `apply` 时缺失或空白则写入内置默认，有内容则逐字注入（去首尾空白、剥 BOM、CRLF→LF）；段落名与 order 仍由代码
  固定（`plugin/src/prompt.ts` 的 `PROMPT_FILES`），文件只提供正文；**只在初始化时读一次**（改完重启 dsh 生效）；
  读/写失败只告警并退回默认，绝不阻断挂载。用户文本不经硬守卫，只做一次软检查并各记一条警告（超 400 字 /
  命中 `RETENTION_VOCABULARY` / 命中"因为"这类因果措辞），**不截断、不拒绝**。ensure/read/fallback 按"每段只差
  路径与默认正文"抽成通用件 `PromptFiles`（`packages/plugin/src/prompt_files.ts`：注入 io、永不抛错）。该件与任务引擎
  的镜像件同路径、同形，便于 diff 与将来抽公共包。README 新增「自定义系统提示词」，DESIGN §3/§10 同步；`mount-smoke` 预置一份被编辑过的
  文件，断言它逐字进入 prompt、另两份按默认创建、且软检查的警告确实发出。

### Docs
- `docs/RELEASING.md` 新增 **§1.1「一次发布的完整顺序」**：把 2026-09-21 发 0.1.1 的实际步骤固化成可复刻的
  命令序列（提交 → 盖版本/切 CHANGELOG → 严格门禁 + pack --mount → tag/push → sync:rc + 发布树门禁 →
  只发一个包 → **按 registry 反向确认**），并写明两个坑：2FA 账号上 publish 可能只是"staged 待批准"
  （CLI 仍打印 ✅）、以及 staged 时的处理（批准 / Bypass 2FA token）。§5 清单顶部加指针。

### Fixed（发布流程，发 0.1.1 时暴露）
- `scripts/mount-smoke.mjs` 的错误行引用了**未定义**的 `describeError`：只要 smoke 本身失败，摘要就被
  一个 `ReferenceError` 取代、真正的原因看不见（本次把"发布树没装原生依赖"掩盖了一轮）。改为文件内定义。
- `docs/RELEASING.md` §2 补一条：发布树要先 `pnpm install --frozen-lockfile`（**不带**
  `--ignore-scripts`，node_modules 已存在时用 `pnpm rebuild`）装出原生模块，否则全新 `avantf-mem-rc`
  的 mount smoke 会因 `better-sqlite3` 缺 binding 而降级挂载、判 FAIL。

## [0.1.1] - 2026-09-21

### Changed（`@avantf/dsh-envinit` 从 optional peer 改为 required peer）
- 去掉 `peerDependenciesMeta` 里的 `optional`：框架已是 registry 上的正式依赖（`^0.1.3`），把它标成
  optional 会让"没装"看起来像正常状态。npm 这类会自动安装 peer 的包管理器现在会跟着装上（多个插件共用
  顶层那一份）；pnpm 关掉 `autoInstallPeers`（本仓如此）与 yarn 不会自动装，此时在宿主/profile 里显式写
  一条即可。缺了仍然只是**降级挂载**（一条提示 + 退回 legacy 机制），绝不拒载。README 的
  「安装到一个 DSH profile / 本地开发」两节按这个语义改写。
- 插件同时把框架声明进 `devDependencies`（同一条 `^0.1.3`），`pnpm install` 即装上，`link-envinit.mjs`
  从安装副本 vendor 那份零依赖 bootstrap——本地开发**不需要任何 checkout**（`DSH_ENVINIT=<checkout>`
  才是要就地改框架时的显式选择）。

## [0.1.0] - 2026-09-21

首版发布：包名 `@avantf/dsh-mem`，版本号从 `1.0.x` 重置为 `0.1.0`。

本仓此前以 `@avantf/mem-dsh` 走完 `1.0.0-rc.1` → `1.0.0` → `1.0.1` → `1.0.2` 的发布尝试，
整包在 npm 上被删除；那些版本号按 npm 政策不可复用。插件改名后以 `@avantf/dsh-mem` 全新发布，
版本号**从 `0.1.0` 重新开始**，`1.0.x` 的历史不再计入本包。原先只当作里程碑清单的 `0.1.0`（2025-09-09）
即下面的「初版（M0–M13）」。

本轮是一次全仓审查后的集中修复：**功能面**（MCP 四个知识工具上线即坏、UI「认领文件」静默失效、
知识库摄入报喜不报忧）、**架构面**（两张会各自漂移的双胞胎表：工具派发与检索编排；provision 的信任锚）、
**持久层与生命周期**（FTS tokenizer 跨构建漂移、若干查询形状与索引、tick 预算语义与文档对齐）。

### Changed（框架升到 0.1.3）
- peer / dev 区间 `@avantf/dsh-envinit: ^0.1.2` → `^0.1.3`；`minimumReleaseAgeExclude` 同步为
  `@avantf/dsh-envinit@0.1.3`（`0.1.2` 已从 npmjs 整包删除，registry 上可装的只有 `0.1.3`）。
- 重新 vendor `packages/plugin/src/envinit-bootstrap.{js,d.ts}`（0.1.3）。

### Changed（框架升到 0.1.2：模型成为框架 item，落盘与镜像离开 config.yaml）
- peer / dev 区间 `@avantf/dsh-envinit: ^0.1.1` → `^0.1.2`；`minimumReleaseAgeExclude` 同步为
  `@avantf/dsh-envinit@0.1.2`（0.1.1 已从 registry 删除，只有 0.1.2 可装）。
- 新增清单项 `mem:model`（`model-cache`，根 `models`，`background`）：消费框架 0.1.2 新增的
  `spec.layout: flat` 落盘布局，文件落到 `<home>/models/<repo>/<file>`——正是语义后端按
  `<repo>/<file>` 读取的形状，所以框架装的这一份就是运行时读的那一份，不再有第二份下载；文件列表
  显式声明，镜像走该项的 `endpoint`；拿不到时按 degrade 处理（退回 FTS+entity，不拒载）。
- **下载落点与镜像不再由 `~/.avantf/config.yaml` 决定**：`semantic.cache_dir` / `semantic.mirror`
  及 `rerank` 同名键会被忽略并各告警一次；落点取框架给的 `roots.models`，运维只保留
  `AVANTF_MEM_MODEL_CACHE` / `AVANTF_MEM_MODEL_MIRROR`（或 `HF_ENDPOINT`）逃生口。
- 语义预热移到 `mem:model` 的 `onSettled` 之后：先等文件落盘，再让运行时去读；跳过/失败时照样预热，
  由 `semantic.auto_download` 决定"自己取"还是"降级"。
- 重新 vendor `packages/plugin/src/envinit-bootstrap.{js,d.ts}`（0.1.2）。

### Changed（框架升到 0.1.1：bootstrap 只解析，不再自愈）
- peer / dev 区间 `@avantf/dsh-envinit: ^0.1.0` → `^0.1.1`；`pnpm-workspace.yaml` 的
  `minimumReleaseAgeExclude` 同步为 `@avantf/dsh-envinit@0.1.1`。
- **0.1.1 已发布到 registry**：插件以 **peerDependency** 加一条 **devDependencies** 消费它
  （`autoInstallPeers: false` 下 peer 不会被自动安装，`pnpm install` 因此从 registry 解析并装上），
  构建与运行都用这份安装副本；工作区里不再有 `overrides: link:../dsh-envinit`，也不需要
  `DSH_ENVINIT`。`DSH_ENVINIT=<checkout>` 只是显式就地联调框架的 opt-in，兄弟 checkout 从不被隐式发现。
- `loadFramework()` 不再接受 `home` / `range`：0.1.1 的 bootstrap 只校验它自己烘焙的 `supportedRange`
  （包管理器那份框架在不在、版本对不对）；插件声明的区间仍经 `createProvisioner({ envinitRange })`
  **按清单**判定（`unsupported-envinit`），不再被 bootstrap 提前拦成整实例降级。
- 重新 vendor `packages/plugin/src/envinit-bootstrap.{js,d.ts}`（0.1.1）：框架缺失或超出
  `supportedRange` 时不再有私有副本 / registry 下载 / integrity pin，只是一条 WARNING + legacy 降级。

### Changed（框架改为消费 npm 发布包）
- `@avantf/dsh-envinit` 已发到 registry（0.1.0），插件从"本地 checkout"切到"registry 安装"：
  - `packages/plugin/package.json` 在 **devDependencies** 里补一条 `@avantf/dsh-envinit: ^0.1.0`
    （peer 声明保留；`autoInstallPeers: false` 下 peer 不会被自动安装，构建期必须有真身可核对）；
  - `scripts/link-envinit.mjs` 的来源改为**安装副本**（`packages/plugin/node_modules/@avantf/dsh-envinit`），
    且**不再隐式发现兄弟 checkout**（`<repo>/../dsh-envinit`、`$HOME/sources/dsh-envinit` 都不再自动使用；
    要就地联调框架用 `DSH_ENVINIT=<checkout>` 显式指定，此时才软链并据此 vendor）；
  - 指向仓库**之外**的链接被判定为"不是安装"：`--check` 与构建会响亮失败并给出 `pnpm install`，
    不再静默地拿 checkout 里的 bootstrap 出构建。
- 同步更新 `build-plugin.mjs` / `assert-envinit-artifacts.mjs` 的提示语，以及 README / DESIGN / RELEASING /
  INSTALL / DSH_INTEGRATION / PROVISIONING / AGENTS 中"尚未发布、需要手动 checkout"的表述。
- `pnpm install` 会替换 `packages/plugin/node_modules/@avantf/dsh-envinit` 上遗留的 checkout 软链；
  `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 由 pnpm 自动补上 `@avantf/dsh-envinit@0.1.0`。

### Fixed（框架升到 0.1.0 后的 peer 区间漂移）
- 改名后的门禁才暴露：兄弟 checkout 已出 `@avantf/dsh-envinit@0.1.0`（release 提交、去掉 `private`），
  而插件仍声明 peer `^0.0.0`。后果不是"版本警告"而是**整条框架链路静默降级**：bootstrap 启动时拒绝就地
  解析到的那份副本（区间不满足）→ 转 private 副本 / registry → registry 上还没有这个包（404）→ 框架不可用
  → 插件退回 legacy sweep。日志形态：`bootstrap: the resolved @avantf/dsh-envinit@0.1.0 does not satisfy
  "^0.0.0"; trying the private copy` + `packument request failed: HTTP 404`。
- 修法：peer 区间改 `^0.1.0`，并给 `scripts/copy-envinit-bootstrap.mjs` 补一条**构建期断言**——用框架自己
  的 `satisfiesRange` 校验"内联 bootstrap 的版本 ∈ 插件声明的区间"。原来只断言"vendored 版本 == 链接到的
  框架版本"，两边一起动时它是绿的，正是这次漏掉的那一环。变异验证：区间改回 `^0.0.0` 构建立刻红，并给出
  `does not accept the framework 0.1.0 — bump the range with the framework`。

### Changed（插件改名：`@avantf/mem-dsh` → `@avantf/dsh-mem`）
- 与家族其它包（`@avantf/dsh-mission` / `@avantf/dsh-compat` / `@avantf/dsh-envinit`）命名对齐。
  改的是**包身份**：`packages/plugin` 的 `name`、tsdown 的 client bundle id、Typert 贡献里的 `package`、
  兼容门禁探测 key 的兜底、以及构建/打包/清理脚本（`link-dsh` 在 preset 根下发布的 stub 目录、
  `cleanup.sh`、tarball 名 `dist/avantf-dsh-mem-<ver>.tgz`）、`.gitignore`、CI 过滤、文档与命令示例。
  **协议面不变**：cordis service `avantfMemory`、远端命名空间 `avantfMem`、8 个工具名、存储域
  `avantf_memory` / `avantf_knowledge` 都与包名无关。
- 重新安装：`~/.dsh/profiles/web` 的 `link:` 依赖、`cordis.patch.yml` 的 `name` 与
  `node_modules/@avantf/` 符号链接一并换成新包名（旧链接删除）；host 半边改动需重启 `dsh` 生效。

### Fixed（交接后的复核：测试边界、环境逃生口、分离 promise、vendor 漂移检查）
- **`packages/plugin` 的测试与 CI 的现状对齐**：`test/provision.spec.ts` 与 `test/envinit.spec.ts` 都经
  `src/provision.ts` 拿到 `@deepseek-ai/dsh-tools` 的**值导入**，而 CI 的树里没有 `@deepseek-ai/*`
  （锁文件无条目、`autoInstallPeers: false`、`ci.yml` 不装）——**实测**移走 peers 后这两个文件连加载都
  失败（`2 failed | 10 passed`、`5 failed | 92 passed`），也就是 `ci.yml` 的 "Test (all packages)" 对
  `packages/plugin` 不可能通过，而 `ci.yml` 的注释、`docs/RELEASING.md` §1 与 `vitest.config.ts` 的规则都
  在说相反的话。现在 `PEER_DEPENDENT_SPECS`（`packages/plugin/vitest.config.ts`）是唯一那份清单：默认
  `vitest run` 排除它们（**无 peer 树实测 10 文件 / 92 用例全绿**），新增 `pnpm test:dsh`
  （= `vitest.dsh.config.ts`，只跑这两个文件）由 `scripts/build-plugin.mjs` 调用，三处文档同步改成事实。
- **pandoc 降级分支不再丢掉 `AVANTF_TOOLS_DIR`**：`legacyToolsDir` 原先自己拼内建默认
  （`expandHome(DEFAULT_TOOLS_CONFIG.dir)`），而 `pandocBinary()` 把 `settings.toolsDir` **原样**交给
  `ensurePandoc`，于是"框架可用但 `mem:pandoc` 失败/跳过"这条路上，运维设的逃生口被静默忽略
  （CHANGELOG / PROVISIONING §3 / INSTALL §5 都写着它照旧生效）。现在走
  `resolveToolsDir(parseToolsConfig(...))`，只在结果仍等于族根（= 没人选过）时才回退 `defaultToolsDir()`；
  mount smoke 设 `AVANTF_TOOLS_DIR` 并断言回退行**指向它**（改回旧写法即红）。
- **后台资源预装的分离 promise 补上拒绝处理**：`envinit.ts` 的 `void resources.ensure(...)` 此前没有
  `.catch`，而 Node ≥15 的未处理拒绝是**致命**的（本仓自己的规矩相反：`provisionToolchainAsync` 的注释与
  两个 `*Async` 包装都接住了）。现在补 `.catch` → 一行 WARNING，"拿不到资源"永不是挂载失败；
  `envinit.spec.ts` 新增"ensure 拒绝仍挂载 + 只告警"的用例（去掉 `.catch` 即红）。
- **vendored bootstrap 的漂移检查改为逐字节**：原先只比 `VERSION` 常量，而框架 private 期间它恒为
  `0.0.0`，改一个字节也照样通过；`link-envinit --check` 现在把 `src/envinit-bootstrap.{js,d.ts}` 与框架源
  （同一个 `stripSourceMap` 变换后）逐字节比较（**实测**追加一行注释即 exit 1），与 `dsh-client-preset`
  的纪律一致。
- **文档订正**：`docs/PROVISIONING.md` §6 写明 `AVANTF_HOME` 下三个基准各不相同（族根跟随、legacy
  tools/models 不跟随、旧私有根跟随数据家）；`packages/core/src/modelBootstrap.ts` 的头注释与新不变量
  （底座是 devDependency、由框架预装、插件按文件 URL 装载）对齐。
- **完整审查报告**：[`docs/ENVINIT_REVIEW.md`](docs/ENVINIT_REVIEW.md)（含三处隔离/变异实验的实测数字、
  框架侧两条观察：`unverifiable` 受管副本会被装载、`assertTarballUrl` 未随迁移）。

### Changed（启动接线：环境初始化交给家族框架 `@avantf/dsh-envinit`）
- **插件不再自己"装底座"，改为向框架声明需要什么**：`apply()` 的第一步变成框架的固定时序
  `内联 bootstrap → 装载 @avantf/dsh-envinit → register + declare → 等 blocking 集 → 派发 background 集 → 跑门禁`
  （`packages/plugin/src/envinit.ts`）。清单两项：`mem:compat`（`npm-package`，`startup: 'blocking'`，
  落 `<home>/runtime`，range 读自插件清单的 `devDependencies`，宿主自己的 `zod` 以 `peers[].dir` 显式复用）、
  `mem:pandoc`（`binary-archive`，`background`，落 `<home>/tools`，URL/摘要仍以 `@avantf/mem-provision` 的
  `PANDOC_PACKS` 为唯一真相，只换成框架的词汇 `format → archive`、可执行名而非归档内路径）。
  （`mem:model` / `mem:rerank` 一度也在清单里，真机实测后撤回——见下面的条目。）**耗时但不阻塞启动的
  安装与下载一律 `background`**：派发后立刻返回，插件继续自己的初始化；`mem:pandoc` 失败/跳过时把
  转换器的 managed 目录指回旧目录并清掉解析缓存（退化路径），嵌入模型则由插件在挂载时预热。
- **族根成为引擎的内建默认层，而不是新的优先级**：框架可用时 `RuntimeOptions.managedRoots` 把
  `tools.dir` 设为 `<home>/tools`、`semantic.cache_dir` / `rerank.cache_dir` 设为 `<home>/models`
  （`<home>` = `$AVANTF_HOME` ?? `~/.avantf/env`）。它在 **layer ①**，所以 `config.yaml` 与
  `AVANTF_TOOLS_DIR` / `AVANTF_MEM_MODEL_CACHE` / `AVANTF_PANDOC` 照旧覆盖它；框架不可用时一个都不传，
  旧默认目录与旧 sweep 原样生效。总闸是 `AVANTF_ENVINIT_AUTO_DOWNLOAD=0` 或 `AVANTF_MEM_AUTO_DOWNLOAD=0`
  （两者任一为 0 即离线；缺项落 `skipped(policy/download-disabled)`，不阻塞挂载）。
- **删掉插件自己的底座自愈**：`@avantf/mem-provision` 的 `ensureCompatBase`、`COMPAT_DIR_NAME` 与通用
  `runtimeDeps.ts`（含其测试）整体移除——旧私有根 `<dataHome>/dsh-compat/**` 框架不读不写。
  `@avantf/dsh-compat` 从 `dependencies` 移到 `devDependencies`：只作为"声明区间的唯一真相"，**没有任何
  代码 import 它**（框架把它装进受管目录，插件按文件 URL 装载那份副本）。`@avantf/dsh-envinit` 是**peer**
  （宿主提供、绝不 bundle，插件只 `import type` + 内联 bootstrap 的 `loadFramework()`）。
- **内联边界可证伪**：`scripts/link-envinit.mjs` 把框架的零依赖 `bootstrap.js` vendor 进
  `src/envinit-bootstrap.{js,d.ts}`（框架 0.1.1 已发布，构建与运行都用安装副本；只有显式 `DSH_ENVINIT=<checkout>`
  才链接 checkout 并据它 vendor），插件构建在 `tsc` 与
  `tsdown` 之间把 `.js` 拷进 `lib/types/`（`scripts/copy-envinit-bootstrap.mjs`，构建期断言 bootstrap 版本
  = 链接到的框架版本 + 框架自包含 + peer 区间合法），构建后再由 `scripts/assert-envinit-artifacts.mjs` 与
  `scripts/pack-plugin.mjs` 断言：`lib/index.js` 里 bootstrap 确实被内联、`@avantf/dsh-envinit` 没有以
  说明符形式残留、`lib/client.js` 干净。
- **`warmModels` 拆成两半**：`warmSemantic` / `warmTokenizer`（以及 `warmSemanticAsync` /
  `warmTokenizerAsync`），使插件能在挂载时先热 tokenizer、再热嵌入模型；`warmModels` 仍是两者的组合，
  CLI/MCP 行为不变。
- **模型最终不是 item（真机实测把原方案推翻）**：第一次真机启动出现
  `envinit: mem:model is failed (unknown-error — fetch failed)`（`hf-mirror.com` 本机连接超时）。查下去
  发现这不只是"这次网络不通"：框架的 `model-cache` provider 写的是 `huggingface_hub` 布局
  （`models--<org>--<name>/{blobs,refs,snapshots/<sha>}/…`），而 `@huggingface/transformers@4.x` 的文件
  系统缓存按 **`<repo_id>/<filename>`** 落在 `env.cacheDir`——装好的那份构建里**根本没有 hub 布局的代码**
  （实测：临时目录里只放 hub 布局 → 加载走网络并 `fetch failed`；`src/utils/cache/` 只有 `FileCache.js`，
  `buildResourcePaths()` 对 `main` 修订算出的 cache key 就是 `<repo>/<file>`）。所以 `mem:model` /
  `mem:rerank` 只会下一份运行时永不看的副本，运行时再自己下一份：双份下载、双份磁盘，且 mirror 不可达时
  每次启动都留一条失败行。**改为撤回这两个 item**（`ResourcePlan` 只剩 `pandoc`）：引擎照旧自己从
  `semantic.cache_dir`（仍由 `managedRoots` 指向族根 `<home>/models`，位置只有一处）加载，并按
  `semantic.auto_download` 决定能否联网取；挂载时用 `warmSemanticAsync` 预热。`envinit.spec.ts` 相应断言
  "第二个 provisioner 只注册 binary-archive、清单只有 `mem:pandoc`"。框架侧若要接管模型，需要 provider
  支持扁平布局（或运行时换成认 hub 布局的版本）——已记入 `docs/ENVINIT_REVIEW.md` §7。
- **迁移文档同步纠正**：旧模型缓存是 transformers.js 的 `<org>/<name>/<file>` 形状（**不是** `models--*`），
  迁移命令与排错行一并改正；并写明 CLI/MCP 仍解析 legacy 默认根，所以推荐把旧目录换成指向族根的符号链接
  而不是直接删（本机已这么做：释放约 249 MB 重复副本，两条路径都解析到族根）。
- **文档**：`docs/PROVISIONING.md` 从"阶段 1 提案"改写为现状说明（框架拥有机制、插件只写清单、根目录、
  两段时序、退化路径，以及"先搬后删"的旧目录迁移配方），`AGENTS.md` / `DESIGN.md` §12.1 /
  `docs/INSTALL.md`（新增 `mem:model is failed` 排错行与本地缓存说明）/ `docs/DSH_INTEGRATION.md` /
  `README.md` 同步。

### Added（启动即自动升级：把保证做实、把静默变可见）
- **"改了 base DDL 却忘加编号迁移"现在有守卫**：`packages/core/test/db_upgrade_parity.spec.ts`
  从一个**冻结的 v1 基线**（`packages/core/test/fixtures/schema_baseline.ts`＝base DDL 去掉所有后续
  step 的成果）造出每个中间版本 k 的老库，用完整迁移列表升到最新，再与**全新库**做整体 schema 平价
  （规范化比较 `sqlite_master` 的 `type,name,sql`，忽略 `sqlite_autoindex_*`/FTS 影子表与空白/注释差异；
  表定义按列/约束排序后比较，吸收 `ALTER TABLE ADD COLUMN` 只追加的事实）。两个 store 各一条，memory
  覆盖 k=1..8、knowledge 覆盖 k=1。**为什么不能用 `migrate(migrations.slice(0, k))` 造老库**：那样
  step 1 用的是同一份被改过的 DDL，"老库"和"新库"都拿到新对象，变异测不出来；冻结基线是唯一能看见
  "老库真的没有它"的参照物。变异验证：临时只往 base DDL 加一列或一个索引而不加迁移 → 守卫红（三份
  原始输出见本次提交说明）；复原 → 绿。
- **升级在启动日志里可见**：两个 store 打开后，只在**确实升级**时各打一行（`[avantf-mem]` 口径、英文）
  `memory: schema upgraded 8 → 9 (applied: 9 contradiction-resolved-indexes)` /
  `knowledge: schema upgraded 1 → 2 (applied: 2 chunk-derived-state-provenance)`；库已最新时**不打**，
  不新增每启动一行的噪音（`db/store.ts` 的 `describeMigrationOutcome` 仍能给出 `schema up to date (N)`
  供测试断言）。拼装自已返回的 `MigrationResult`，不碰数据库、不阻塞、不抛错。
- **改 schema 的两处纪律写进文档**（DESIGN §19）：新建表/列/索引必须**同时**加进 base DDL（新库走
  step 1）与一个编号迁移（老库走它）；只用其中一处就是上面那条静默故障。`docs/INSTALL.md` 排错表新增
  两行：`schema upgraded` 是正常自动升级；`memory unavailable` 时备份 `~/.avantf` 并看具体迁移错误
  （库比代码新＝`SchemaDowngradeError`，要升回版本或恢复备份）。

### Fixed（功能面：被 advertise 但不可用的路径）
- **MCP 的 4 个知识工具此前每次调用必失败**：`TOOL_SPECS` 已按契约拆成 8 个（`kb_add` / `kb_list` /
  `kb_remove` / `kb_reindex` 在内），`tools/list` 如实暴露 8 个，而 `packages/mcp/src/index.ts` 的派发
  switch 只认旧的 5 个 key，其余落到 `default` 抛 `unknown tool key`。`mcp.spec.ts` 只断言
  `length === TOOL_SPECS.length`（清单是对的，派发不是），所以门禁看不到。**修法不是补一个 switch**：
  派发表下沉为 `core/src/dispatch.ts` 的**唯一一张**，MCP 与 DSH 插件（工具 + Remote gateway）共用；
  新增 `supportsToolKey`，`core/test/dispatch.spec.ts` 与 `mcp.spec.ts` 都断言"契约里每个 key 都能派发"，
  并对 4 个知识工具跑真实 `tools/call`。`plugin/src/kb_add.ts` 随之删除（其 spec 移到 core）。
- **知识库「认领文件」按钮静默失效**：客户端发 `{action:'sync', doc_id, adopt:true}`，而
  `plugin/src/remote.ts` 的 kb 线协议没声明 `adopt`；strict codec 出站**丢弃未知键**，宿主收到的是
  不带 `adopt` 的 sync，UI 报「认领完成：0 篇」。这与三个矛盾裁决按钮当年的病因完全相同，而守护测试
  `remote_wire.spec.ts` 有两个盲区（正则只匹配 `remote.kb({` 字面量，扫不到三元调用点；spread 属性
  `...(adopt ? {adopt:true} : {})` 不被解析为键）。**修法换成更强的不变量**：五个工具面断言
  "声明字段 ⊇ 契约 union 的全部字段"（客户端要发的字段必须是契约字段才有意义，所以覆盖契约即覆盖
  一切现有与未来调用点，包括包装函数 `kbCall(label, args)` 和条件 spread 这些源码扫描看不见的形状），
  源码扫描保留为 UI-only 方法的第二道网，并顺带补齐 `recall` / `query` 缺的 `max_tokens`。
- **知识库摄入报喜不报忧**：`encodeAndStore` 每个 chunk 的编码/写库失败只进日志，`IngestResult.chunks`
  报的是**切块总数**，结果里没有编码成功数、`degraded` 也不置位——模型不可用或 SQLITE_BUSY 时调用方
  看到"入库成功 N 段"，语义腿实际缺失，只能靠人工 `kb_reindex` 比对 `vectors_stale > vectors_encoded`
  才发现。新增 `IngestResult.vectors_failed`（全成功时**不出现**，健康路径保持安静），模型不可用时
  如实计为全部 chunk。
- **hnswlib 的异常回退指向一个永远为空的索引**：`add()` 在原生成功路径直接 return，`fallback` 从不
  接收向量；`topk` 的 `catch` 却返回 `fallback.topk()` = `[]`，且不置空 `lib`、不记日志——一次
  `searchKnn` 抛错后所有语义查询**永久静默零结果**，而 `stats().native` 仍报 true。现在 catch 里
  置空 `lib` + `rebuildFallback()`（从 `vectors` 重建全量）+ 告警；`topk` 入口补维度守卫（原先只有
  `add` 有），维度不符时明确告警并跳过本次语义检索，而不是返回一个看起来像"没有命中"的空结果。
- **`removeMany` 丢批**：`markDelete` 抛错时 `compact(); return`，批次里剩下的 id 完全没处理——它们仍
  留在 `vectors` 和图里，即"已归档的事实继续能被语义检索命中"，索引与 DB 发散且调用方无从感知。现在
  标记失败只置一个标志、循环走完，最后整批 `reindex()` 一次。
- **`scripts/release-check.mjs` 的 CHANGELOG 切分检查早已静默失效**：正则里的 `\Z` 不是 JS 记号，匹配
  字面字符 "Z"。当前只是碰巧被后文的一个 "Z" 救回来；一旦 `[Unreleased]` 成为末节且后文无大写 Z，
  整个匹配失败 → `unreleased=''` → "[Unreleased] 仍有条目"永不报，门禁在未切分状态下照样 PASSED。
  改为按行切分。同时给 release gate 加了一步"每个包声明的 `types` 入口在构建后**真实存在**"。

### Security
- **自愈下载的信任锚不再交给镜像**：`fetchPackument` 此前 **mirror-first**，而 `downloadVerified` 用
  **同一来源返回的** `dist.integrity` 校验 tarball，校验通过后 `plugin/src/provision.ts` 直接
  `await import()`。默认镜像是三家第三方 GitHub 代理且 `autoInstall` 默认开——任何能应答该 npm URL 的
  代理都能返回自洽的假 packument + 假 tarball，在 dsh 宿主进程内执行任意代码。现在 packument **只从
  registry 取**（它是 checksum 的唯一来源），镜像只用于加速 integrity 已被钉住的 tarball；并新增
  `dist.tarball` 的 scheme 校验（拒绝 `file:`，拒绝 `http:` 降级，除非 registry 自身就是 http）。
  真实 npm 下载用例与"镜像只碰 tarball"用例都在 `provision/test/runtime_deps.spec.ts`。
- **xlsx 解压炸弹前置界限**：`exceljs` 会先解压并物化整个任务簿，`MAX_ROWS/MAX_COLS` 只约束**输出**，
  所以几 MB 的文件声明百万行即可在摄入时耗尽宿主内存。现在按中央目录声明的解压总量封顶（64 MiB，
  远超本转换器会保留的量），超限直接拒绝并给出可操作信息。`zip.ts` 新增 `zipDeclaredCost`，与
  `zipEntryNames` 共用同一份中央目录解析。**这是前置过滤而非保证**：尺寸是归档自己的声明，说谎的归档
  仍会解压——要真正封死得自己带运行上限解压，代码注释里写明了这一点。

### Changed（架构：消掉两张会各自漂移的双胞胎）
- **检索编排合并为 `core/src/store/hybrid.ts`**：`MemoryStore.search` 与 `KnowledgeStore.search` 各有
  一份约 80 行的平行流程，而**漂移全发生在编排层**——`NaN` limit 守卫只在记忆侧（知识库把 NaN 绑进
  SQL `LIMIT` 直接抛，`Promise.all` 让**整个跨库查询**失败）、`retriever.over_fetch_factor` 只在记忆侧
  （知识库硬编码 `limit * 3`，一个旋钮两种含义）、`recordLegCapped()` 只在记忆侧（知识库的腿被 cap
  绑住时健康面板看不到，正是 DESIGN §20.17 要消除的"无人报告"）、rerank 标志一处是 helper 一处是内联。
  现在腿与命中映射由各 store 提供（表与过滤条件本就不同，记忆侧还多一条 HRR 腿），**其余全部只有一份**。
  合并顺带修掉三件事：读路径的腿级隔离（一条腿抛错不再连带炸掉其余腿，写路径本来就有 catch，读路径
  没有）；`reinforce` 移到输出预算**之后**（此前被预算清空文本的命中照样刷新休眠时钟、照样花掉 trust
  配额，而"只有真正返回的命中算召回"这条原则只在跨库路径落实过）；外来向量空间的启动告警补到知识库侧
  （此前只查宽度不查空间，同宽不同模型的向量会静默混排到有人手动 `kb_reindex`）。
  `queryVector` 维度不符归类为 `RetrievalInputError` 并**照常抛出**——它是调用方的配置错误，降级作答
  会把"两个 store 用了不同 backend"这件事藏起来。
- **工具派发表合并为 `core/src/dispatch.ts`**（见上）。`kb_list` 的默认分页与受管文件路径渲染也随之
  只有一份。
- **`vectorSpace` / `evictVectors` / `lexicalProbe` 的重复消掉**（`store/common.ts` 与
  `lexical.ts` 的 `probeTerms`）：`probeTerms` 收原始**词条**而不是已构造的 MATCH 表达式，因为"词条
  → 查询"取决于该 store 的 FTS 表实际用的 tokenizer（见下）。
- **`core` 的公共面收窄**：`src/index.ts` 此前对 20 个模块 `export *`，把 DB 连接/schema、迁移、HRR
  代数、实体抽取、eval runner、git 包装一并对外发布，而三个消费者（插件 / MCP / CLI）加起来只用 10 个
  符号。现在只导出配置、runtime、dispatch、两个 store、共享编排与两个 store 辅助模块；内部件仍可按
  模块路径导入（`scripts/bench-*.mjs` 已改为深路径导入，那本来就是它们的意图）。
- **CLI 的请求真的过契约**：此前是手写 flag + `req as RecallRequest` 强转、无 safeParse，且三处枚举值域
  手抄契约（契约增值域时 CLI 静默不跟、无测试失败）。现在值域从契约导出的 `FACT_STATUSES` /
  `CONTRADICTION_RESOLUTIONS` / `QUERY_KINDS` 取（zod schema 也改用同一份），每个命令的请求都过对应
  union 的 `safeParse`，报错复用共享的 `validationError` 渲染，三个面口径一致。
- **7 个包的 `types` 字段与产物对齐**：都写着 `lib/types/index.d.ts`，而只有 plugin 的 tsconfig 用
  `outDir: lib/types`（tsdown 占着 `lib`），其余包平铺产出 `lib/index.d.ts`。typecheck 能过纯属 TS 在
  types 条件 miss 后回落 default，任何严格按 `exports` 取类型的工具或对外发布即断。release gate 现在
  在构建后校验这些入口真实存在。

### Fixed（持久层与生命周期）
- **FTS tokenizer 的"建表时/查询时"漂移 → 静默零召回**：`CREATE VIRTUAL TABLE IF NOT EXISTS` 永不重建，
  实际 tokenizer 也没被持久化，而查询构造默认再问一次**当前构建**。跨机器/跨 SQLite 构建打开同一个库时，
  两边约定不一致（trigram 表收到整词短语、unicode61 表收到 3-gram），**整条 FTS 腿无声消失且无异常**。
  现在从 `sqlite_master` 读该表**真实**的 tokenizer（`detectFtsTokenizer`），两个 store 都在构造时解析
  一次并显式传给 `buildFtsQuery`；表比当前构建**更弱**时告警一次并指名补救动作（知识库是 `kb_reindex`），
  反向不告警（查询按表构造，召回不受影响）。
- **`triples.ts` 自己文档点名的反模式仍在用**：`objectsForSubject` / `activeFactsBySubject` 用
  `fact_id IN (SELECT fact_id FROM facts WHERE status='active')`，而同文件注释记载该形状在 30 万 triples
  上实测 202 ms（物化全部 active id）、已在他处改为 JOIN。chain 路径每次调用都在付这个代价，现改 JOIN。
- **`facts` 的多行读不再拖 BLOB**：`page`（`mem_admin list` 分页）与 `rowsByIds`（**每次召回**的信任结算）
  都是 `SELECT *`，把 `hrr_vector`(~8 KB) + `semantic_vector`(~2 KB) 逐行搬出来给一个只看标量的调用方。
  改为显式列投影 `FACT_COLUMNS_NO_BLOB`，并由 `db_lifecycle.spec.ts` 对照 `PRAGMA table_info(facts)`
  钉住——新增列忘了加进来会**测试失败**，而不是静默从这两个读里消失。`getById` 刻意保留 `SELECT *`
  （`restore` 要用那一行的持久化向量重新入索引）。
- **`contradiction_log` 的 `resolved` 维度此前无任何索引**：`list(resolved=1) ORDER BY score DESC` 走
  临时 b-tree 全排序，`suppressedPairs` 的 `resolved = 0 OR resolved_by='verdict'` 因为 OR 有一个分支
  无索引而退化为全表扫（日志只在 purge 级联时才收缩）。迁移 v9 补 `(resolved, score DESC)` 与
  `resolved_by='verdict'` 的 partial 索引，后者让该 OR 变成 multi-index OR。
- **`purgeArchived` 的 `LIMIT ${Math.floor(p.budget)}`**：全仓唯一把数值拼进 SQL 文本的地方（`Math.floor`
  使其不构成注入，但形状本身值得消失），改为与同文件其余四处一致的 `LIMIT :budget` 命名参数。
- **`parseUtcTs` 把无时区的 ISO 串按本地时区解析**：库内一律写 UTC，而 `Date.parse` 对无时区 ISO 串按
  **本地**时间处理，会让每个配额窗口与衰减测量偏移一个 UTC offset（在 UTC 里跑的测试看不到，其他时区
  全错）。现在无时区标识一律按 UTC 读，显式 `Z`/`±HH:MM` 保持原样；顺带删掉无人调用的
  `calendarDaysBetween`（名为"calendar days"实返回小数天）。
- **信任写路径改用 `IMMEDIATE` 事务**：`reinforce` 与 `applyFeedback` 是跨进程的读-改-写（每事实 24h
  配额），但行是在事务**外**读的、事务又是默认 DEFERRED（写锁到第一次写才拿），两个进程同时召回/反馈
  同一条事实会各自基于旧 `bonus_count` 授予加成并互相覆盖结算值——配额双花。presence 与 tick 早就用
  `immediate`，这两处现在也是（读行移进事务内）。
- **已裁决的矛盾不再被静默覆盖**：`resolveContradiction` 此前不检查 `row.resolved`，再裁决一次会就地
  覆盖 `resolution` / `loser_fact_id` / `resolved_at` 且无历史。决定性理由是**裁决有第二次裁决撤不回的
  副作用**：判 `true_positive` 且指名败方 A 会归档 A，改判 B 会归档 B 而 A 仍是归档态——那一行只写着一个
  败方，而两条事实都没了，库里没有任何东西能说明这件事。现在返回 `reason: 'already_resolved'` 拒绝；
  "改判"是一项需要设计的能力（它必须能撤销归档），不该由重复调用顺手完成。
- **三处错误吞噬补上可观测性**：`maybeIndexSemantic` 的 `catch { return false }` 把 DB 写错误与编码失败
  一并静默（后者可由 `vectors_diagnose` 发现，前者意味着"向量在活索引里但没落库"，本进程能用、下个
  进程没有，且再无任何提示）；MCP 的心跳 `catch {}` 完全无声（插件侧同一职责有 warn，信任时钟停走会在
  很久以后表现为"事实永不结算/遗忘/清理"）；`modelBootstrap` 的 `void ensureAllAsync(...).then(...)`
  缺 `.catch`（一旦 reject 即 unhandled rejection，而操作员看到的是健康启动）。
- **`documents.status` 死条件移除**：该列从无写入路径（删除是物理 DELETE 并级联到 chunk），两处
  `AND d.status='active'` 恒真，却让人以为"非活跃文档在这里被过滤掉了"（真正把已删文档挡在结果外的是
  JOIN 本身）。

### Pinned（量化后钉住，而不是盲改）
- **HRR 腿的 0.5 相位基线**：实测（dim=1024，5 个 probe × 200 个无关束）无关束相似度均值 0.499–0.503、
  标准差 0.0105–0.0111，200 个里最高只到 0.525–0.536；经 `scaleByMax` 后**最弱的无关候选仍保留最强者的
  0.88–0.90**。也就是说在"与 probe 无共享实体"的候选集内，这条腿接近**常数加成**而非排序信号——在
  `hrrPath` 的正常路径无害（候选按构造都共享实体，共享会把分数顶到 0.5 以上），在**回退路径**（无共享
  实体时改打"最近 `cap` 条事实"）则相当于给最近的事实统一加约 `weight_jaccard × 0.9`。
  扣基线（`max(0, (sim-0.5)*2)`）能让它变得可分辨，但那是**排序语义变更**，而冻结的 35 条中文评测只跑
  `recall.search`、这条腿只在 `recall.probe` 参与——**没有任何现存门禁会因此移动**，所以本轮不改，
  改为把上述数字钉进 `phaseSimilarity` 的文档与 `hrr.spec.ts`，让将来这次改动必须带着 probe 形状的差分
  评测一起做（即 `docs/PROVENANCE_REVIEW.md` N5 一直缺的那条）。
- **`fusion.ts` 补非有限分数守卫**：一个 NaN（损坏的 HRR blob 解出的 NaN 能通过所有区间比较，因为
  NaN 的任何比较都是 false）会污染该候选的合并总分，并让排序比较器返回 NaN——**整个结果顺序变成未定义**，
  而不只是一条分数错。现在非有限分数按"无信息"映射为 0 并留在池里；`hrrFromBytes` 也改为拒绝非有限/越界
  相位（返回 `null`，调用方本就按"跳过该行"处理），`isValidAtom` 补 `Number.isFinite`。
- **`estimateTokens` 补 CJK 标点**：`。、《》` 与全角 `，！？；：` 此前按 4 字符/token 计，与模块自称的
  "故意高估"方向相反（中文被低估），而同文件的 `BREAK` 集合早就认识这些字符。
- **两个 transformers 适配器的 `mod.env` 写法统一**：`mod.env` 是**进程级**、后写覆盖前写，而重排器单独
  设了 `allowLocalModels`、嵌入器没设——看起来像两个适配器有不同策略，实际只是"哪个文件最后被改过"。
  现在由 `applyModelEnv` 一处写全四个键。

### Docs
- `docs/TRUST_MODEL.md`：§4 的"只有 ① 分批"改为"五步共用 `tick_max_facts`"（并说明为什么：五步在同一个
  `IMMEDIATE` 事务里，写锁全程持有，不分批就会把其他进程与启动路径堵死）；§6.1 补
  `archived_deferred` / `purged_deferred`；§2.4 写明 `feedback_daily_cap > 0` 时 feedback 与 recall
  **共用**同一个 24h 计数器（此前未规格化：召回刷满即拒 feedback）；§2.6 的 `archive_reason` 枚举补
  `contradiction`；§2.6 写明 `restore` 与 `revive` 抬升规则**有意不同**；§8 的 `settleValue` /
  `shouldPin` 并不存在（pin/forget 折叠进 `applyFeedbackDelta` 的返回值）。
- `DESIGN.md` §20.17 与 §16 段：HRR 腿的候选排序量从"共享实体数"更正为"精确 Jaccard 比率"（那是该 cap
  的第一版排序量，实测会把 3/10=0.30 排在 2/2=0.67 前面并挤出 cap，早已改），结论不变、论据更新；
  `legs_capped` 现在两库都上报。
- `AGENTS.md`：新增"一张派发表、一份检索编排"不变量（含两次漂移的具体后果，以及新增工具 key / 新增腿
  该改哪里）；更正 eval 的位置与规模（在 `@avantf/mem`、35 条、基线冻结且逐位断言，不在契约包）。
- `README.md`：M12 的状态改为如实（8 个工具的 `tools/call` 在 CI 里真实派发过），并从"只经过编译与类型
  检查"的验证边界清单里移除。
- `lifecycle/tick.ts` 的文件头注释同步为"五步都分批"。


### Added（启动自愈：底座缺失时先装上，再跑门禁；拿不到就告警并照常挂载）
- **背景**：`@avantf/dsh-compat` 已是普通生产依赖，但 `packages/plugin/src/provision.ts` 与
  `packages/core/src/modelBootstrap.ts` 都**静态 import** 它，而 core 被内联进同一个 bundle ——
  底座缺失时 `lib/index.js` 在 import 阶段就抛 `ERR_MODULE_NOT_FOUND`，我们自己的代码一行都跑不到，
  "启动时检查并安装"无从谈起。
- **去掉 core 对底座的静态依赖**：`ProvisionSweepOptions.dshCompat` 由"evidence"改为"**plugin 已算出的
  verdict**"（纯数据 `{ load, status, reason }`），core 只按 `load` 决定环境准备是否开始，并新增一条
  "`load: true`（version-mismatch）照样 provision" 的对侧用例。`pnpm why zod` 里 core 侧那份重复的
  底座 peer 实例随之消失。
- **只有动态加载**：`packages/plugin/src/provision.ts` 不再静态 import 底座；`apply()` 变 `async`，
  先"确保底座可用"、再在 try/catch 里 `await import('@avantf/dsh-compat')`，成功后**构造一次**
  `COMPAT_SPEC` / schema 名（原模块级常量）。产物里只有动态 import 体内的引用。
- **可用性前置，只用 node API**：新增 `packages/provision/src/runtimeDeps.ts`（**通用机制层**：输入
  "要确保的包/区间/peers + home + fromUrl + mirror + autoDownload"，输出结构化报告，**永不抛错**，
  不含包名/数据目录/环境变量等 mem 假设）与薄策略层 `packages/provision/src/compat.ts`（要确保的是
  `@avantf/dsh-compat`、区间取自本插件 `package.json` 的 `dependencies`、失败就告警）。解析顺序：
  ① `require.resolve`（零网络）→ ② 私有目录 `<dataHome>/dsh-compat/<version>/node_modules/@avantf/dsh-compat`
  → ③ 下载：registry packument 选版本、tarball **mirror-first**、按 `dist.integrity`（sha512）**校验**、
  temp + rename **原子展开**。（packument 后来改为**只走 registry**，见下方"安全"一节：它是 integrity 的来源，
  让镜像代它作答等于让发货方自证 checksum。）底座的 `zod` peer **软链复用**本插件已解析到的那一份（不引第三份）；
  `AVANTF_MEM_AUTO_DOWNLOAD=0` 仍由插件解释为 `autoDownload`（关闭时只告警不下载）。
- **拿不到底座时的语义**：一条响亮的英文 `compat: WARNING`，然后**照常挂载**（门禁判定缺席，工具 /
  service / prompt 段与上下文 / remote / 真实 typert face 全部注册）；**不拒载、绝不抛错**，与
  "无法判定 ≠ 不兼容"一致。
- **验收**：`lib/index.js` 里对底座的顶层静态引用为 **0**；`pack:plugin --mount` 新增"底座不可解析"
  scratch 变体，实测**仍然挂载 + WARNING + typert face 仍 10**；私有安装 / integrity / 已存在零网络
  有纯函数单测 + 一个真实 registry 的 `describe.skipIf` 用例；`release:check` **7/7**、
  `pack:plugin --mount` **PACK OK**、`make-release-tree --out` **exit 0**；smoke 既有的正例/负例两条
  compat 断言继续绿。

### Changed（家族底座改用 npm 上的已发布版本：去掉工作区 `link:` 覆盖）
- **背景**：`@avantf/dsh-compat` 此前只存在于兄弟 checkout，`pnpm-workspace.yaml` 用
  `overrides: { "@avantf/dsh-compat": link:../dsh-compat }` 从源码解析它，于是"先建兄弟仓"成了前置条件、
  发布树还必须把这个覆盖投影掉。**0.1.0 已发布**，所以覆盖删掉：plugin 与 core 的
  `dependencies` 仍是 `^0.1.0`，开发树与发布树**都从 registry 解析**（锁文件带 integrity
  `sha512-j4eD09o…`）。兄弟 checkout 从"必需前置"降级为"要就地改底座时的临时便利"——加回覆盖即可，
  但打包/投影前必须去掉。
- **`make-release-tree.mjs`**：原来那对"把 override 文本换成发布侧说明"的 transform 删掉（两棵树文本
  已一致，无需搬运）；改为投影前 `assertNoWorkspaceLinks()`——工作区若仍留着 `link:`/`file:` 覆盖就
  明确报错（发布树没有兄弟 checkout，静默带过去只会在锁文件重生成时炸）。
- **文档同步**：AGENTS.md 的那条不变式、README 的家族底座段与门禁段、`docs/DSH_INTEGRATION.md`、
  `docs/RELEASING.md` 都改成"普通生产依赖 + 从 npm 解析 + 覆盖仅在就地开发时临时使用"。
- **实测（用 registry 版本）**：`pnpm install` 解析到 `@avantf/dsh-compat@0.1.0`
  （`node_modules/.pnpm/@avantf+dsh-compat@0.1.0_zod@4.4.3/…`，带 integrity）；`release:check` **7/7 PASS**；
  `pack:plugin --mount` → **PACK OK**；`make-release-tree --out` → **exit 0**（此前因底座未发布而
  `ERR_PNPM_FETCH_404`，现在整条发布链打通），投影锁文件里底座同样带 integrity、工作区无 `overrides`。
- **一处观察（未改，如实记录）**：workspace 里底座被解析成两个 peer 变体——plugin 侧对着 **zod 4.4.3**
  （与 `@avantf/mem-contract` 同一份，正是 identity 关键那侧），core 侧对着 zod 4.5.4。core 只用
  `verdictOf` / 前缀这类**纯函数**、不构建 schema，所以两份实例不影响正确性；`pnpm why zod` 里
  contract 与 plugin 仍是同一份 4.4.3。若要去掉这份重复，可让 sweep 直接接收已算出的 verdict
  （core 便不再依赖底座），但那是另一件事。

### Changed（版本比较：本产物链接版本可见 + 构建时烧入精确版本；只改可见性与措辞，零行为变化）

- **背景**：`COMPAT_SPEC` 的版本两侧此前都只描述"插件 ↔ 它链接的那份 dsh"，而且 `declared` 取的是 peer
  区间地板 —— 于是 ok 行打印 `running <安装版版本>`（听起来像宿主版本，实际宿主可能是 checkout 的
  `0.1.6-alpha.2`），原地升级安装版 dsh 后再比对也只能得到一次信号很弱的 WARN。

- **`declared` 优先用构建时烧入的精确版本**：新增 `scripts/build-versions.mjs`，在
  `scripts/link-dsh.mjs` 把 peers 链接到安装版 dsh 之后，把逐包精确版本写进
  `packages/plugin/lib/dsh-build.json`（`files: ["lib"]` 已让它随包发布，`pack:plugin` 不需要特例）。
  运行时 `packages/plugin/src/provision.ts` 用底座的
  `readBuildVersions(new URL('./dsh-build.json', import.meta.url), VERSION_PACKAGES, peer地板)` 读回；
  **没有该文件（开发树 / 单测 / 老产物）就逐包回落** peer 区间地板。`tsdown.config.ts` 的注释同步：
  门禁不再需要 `define`，node 面打包与浏览器面读的是同一个 JSON 机制（preset 的 `clean: false` 保证
  先写的 JSON 不被 bundle 清掉）。

- **ok 行不再暗示宿主版本**：`compat: ok — … dsh links: <包> <版本> (versions this build's own links
  resolve; the host identity is not observed)`（原来是 `, running <包> <版本>`）。

- **version-mismatch 警告改成两侧都指名道姓**：`this build was compiled against <包> <构建时版本>, but
  its links now resolve to <现在解析到的版本> — rebuild against this machine's dsh (pnpm build:dsh)`。

- **版本解析不到的 note 同步改措辞**：不再说"运行版 dsh 匹配不上"，改成"本构建没有记录 <包> 的版本
  （既没有烧入版本也没有 peer 地板）" / "本产物的链接解析不到 <包>（本构建编译时对着 X）"。

- **设计边界写进文档**：版本比较只覆盖**本产物 ↔ 它链接的那份 dsh**，**宿主身份未观测**（插件里没有
  任何办法看到宿主自身版本）；checkout 宿主 + 安装版链接时打印安装版版本，是设计边界不是 bug，此时
  只有真身探针是真的防线。底座 README、本仓 DESIGN.md §12.1、`docs/DSH_INTEGRATION.md` 同步。

- **零行为变化**：声明版本与运行版本不同**仍然只 WARN、照常加载**，没有引入任何 `strictVersion` /
  拒载策略位；工具、service、prompt 段、remote、真实 typert face 的注册路径一字未动。

- **验证**：底座 `pnpm build && pnpm typecheck && pnpm test` 全绿（39 条，含新措辞断言与
  `readBuildVersions` 的逐包回落 / 坏文件用例）；mem `pnpm typecheck` / `pnpm test`（plugin 109 条）与
  job `pnpm typecheck` / `pnpm test`（168 条）全绿；两个插件重建后在安装版 `0.1.5-rc.2` 与本地
  `0.1.6-alpha.2` 上各起一次，ok 行为新措辞、mem 的 8 条 `tool registered: mem_*` 与
  `typert registered: avantfMem host face` 仍在；把 `lib/dsh-build.json` 手工改旧后出现新的
  version-mismatch 警告且插件**仍完整加载**（证明没有偷偷变成拒载）。

### Changed（启动兼容性门禁迁到家族底座 `@avantf/dsh-compat`，与 `@avantf/job-dsh` 完全对齐）

- **背景**：这道门禁的规则（判据 / 探针 / 复查 / 报告）此前各自实现：`@avantf/mem-provision` 里一份纯函数
  判据，插件里一份取证探针。家族底座 `@avantf/dsh-compat` 已把这些收口（job 插件先接入），本仓跟着迁移，
  删掉自研实现，只留"只有本插件才知道的东西"。

- **删除**：`packages/provision/src/dsh_compat.ts`（连同单测与 `src/index.ts` 的 re-export）、
  `packages/plugin/src/dsh_compat.ts`（连同单测）。

- **新增** `packages/plugin/src/provision.ts`：薄 `COMPAT_SPEC`（服务契约 / 宿主版本包 / schema 名 / 事件
  清单 / 中文报告文案）+ 组合底座的 `gatherEvidence` 与 `verdictOf`（只跑一次，把**同一份 evidence** 交给
  provision sweep 的纵深防御复查）；`packages/plugin/src/inject.ts` 把 `inject` 单列出来，使"契约覆盖
  `inject`"这条断言可以脱离宿主单测。

- **行为与迁移前一字不变**：探针证明不兼容 → `load:false` **空挂载**（不建 runtime / 数据库、不注册工具 /
  `avantfMemory` / prompt 段与上下文 / remote / 真实 typert face），**绝不抛错**；只有版本号不同 / 版本未知 /
  测不出来 → 照常加载 + 一条 `compat:` 警告；真身注册后由 `verifyRegisteredFaces` 按**精确 key** 复查 20 个
  schema 与 8 个工具名，缺了只 WARN。拒载时多留一条 `/mem` 扩音器命令说明原因与出路
  （`registerMegaphone` + `compatReport`）。日志前缀由 `dsh compat:` 变为底座的 `compat:`。

- **探针就是真身**：`probeTypert: () => hostContribution`（codec 与 schema 项都带 `schema` + `create()`），
  所以"探针通过"从此等于"真身注册会通过"。

- **不再把版本烧进产物**：删掉 `tsdown.config.ts` 的 `__AVANTF_DSH_BUILD_VERSION__` define 与
  `RECORDED_DSH_VERSION`，改由 `readDeclaredVersions(new URL('../package.json', import.meta.url), …)` 读
  自身清单的 peer 区间地板（`runtime` 侧走 `readRuntimeVersions`）。（**后续修正**：peer 地板只是区间下界，
  说不清"我编译时对着哪一版"；现在改成构建时烧入精确版本的 `lib/dsh-build.json`、逐包回落该地板——见本文件
  Unreleased 最上面那条。）

- **被门禁暴露并修掉的真问题**：真实 wire face 的可选字段原写作 `z.union([z.undefined(), X])`，宿主
  `z.toJSONSchema()` 无法投影（*"Undefined cannot be represented in JSON Schema"*），真身探针据此把**健康**
  宿主读成不兼容。改为 `X.optional()`（语义等价），并新增"全部 20 个 schema 逐个可投影"的单测。

- **依赖与发布顺序**：`@avantf/dsh-compat` 进 `packages/plugin` 与 `packages/core` 的 `dependencies`
  （`^0.1.0`），`pnpm-workspace.yaml` 用 `overrides: link:../dsh-compat` 从兄弟 checkout 解析（需先
  `pnpm install && pnpm build`）。底座 zod peer 从 `^4.6.5` 放宽到 `>=4.4.3 <5`（它只造探针 schema：本仓
  catalog 4.4.3 与已安装 dsh 4.6.5 两端都实测 typecheck+test 通过）。`pack-plugin.mjs` /
  `make-release-tree.mjs` 认得这个唯一的外部 `@avantf/*` 依赖（引擎仍必须内联），并拒绝仍带 `link:`/`file:`
  的 tarball。**发布插件前先发底座。**

- **验证**：底座 `pnpm typecheck` + `pnpm test`（36 条；zod 4.4.3 与 4.6.5 各跑一次全绿）；mem
  `pnpm typecheck` / `pnpm test`（plugin 108 条，含 14 条新 provision 单测；core 418 条）/ `pnpm build:dsh`
  （`MOUNT SMOKE OK`，含正/负兼容性用例）/ `pnpm pack:plugin --mount`（`PACK OK`）；真实 0.1.5-rc.2 与本地
  0.1.6-alpha.2 两个宿主各自挂载成功：`compat: ok — 4 service(s) present, probed tools + typert`、8 条
  `tool registered: mem_*`、`typert registered: avantfMem host face (5 tools + 5 UI-only)`。

### Fixed（Typert codec / schema 同时带 `schema` 与 `create()`，一个构建同时服务 0.1.5 与 0.1.6 宿主）

- **背景**：dsh 的 Typert 契约在两代之间动过——0.1.5 的 `validateCodec` 查 `codec.schema.parse`、
  注册表只读 `TypertSchema{schema}`；0.1.6 改查 `codec.create()`、schema 项变成
  `TypertSchemaFactory{create}`，且**每一代只查自己那一项**。所以一个只带 `schema` 的构建在
  0.1.6 宿主上注册失败（`typert: schema "avantfMem/__compatProbe" has no create() factory`），
  启动门禁据此**干净拒载**：8 个工具、`avantfMemory` 服务、`avantfMem` remote 与两个客户端标签页
  全都不出现——这正是"本地编译的 dsh 里 mem 整个不可用"的成因（job 插件此前已用同样手法修好）。

- **改动**（双成员形状，一个构建满足两代校验器）：
  - `packages/plugin/src/remote.ts`：`strict()` 返回 `{ mode:'strict', typeSymbol, schema, create: () => schema }`；
    host face 的每个 schema 项经新的 `declared()` 产出 `{ name, schema, create: () => schema }`
    （0.1.5 的 `TypertSchema` 类型里没有 `create`，所以形状按结构声明、值对两代都可赋值）。
  - 启动门禁的 wire 探针改成**注册真身 contribution**（`provision.ts` 的 `probeTypert: () => hostContribution`），
    于是"探针通过"重新等于"真身注册会通过"（此前探针是相似形状的假 contribution，在 0.1.6 上曾给出假 `ok`）。
    （该文件随后在本次迁移中删除，探针定义改由底座 `@avantf/dsh-compat` 的 `probeTypertRegistry` 执行。）
  - 客户端半边是同一份 `strict()` 生成的 descriptor，浏览器侧的 gateway 校验因此也通过。

- **验证**：`pnpm -C packages/plugin run build`（**注意 `bundle` 只重打 `src/` 里的客户端半边**，
  node 面入口是 `lib/types/index.js`，改了 `remote.ts` 必须走 `build`/`build:dsh`）
  之后，在本地 0.1.6-alpha.2 上重启 dsh：`compat: ok — … probed tools + typert`、8 个工具注册、
  `typert registered: avantfMem host face (5 tools + 5 UI-only)`；浏览器控制台
  `[avantf-mem] client apply: avantfMem remote mounted` + `tabs registered (记忆, 知识)`。
  安装版 0.1.5-rc.2 上行为不变（同一形状的 `schema` 仍被读取）。

### Changed（客户端「记忆」「知识」只留在主窗口标签条，设置页不再重复一份）

- **背景**：两个面板此前**同时**注册进 `conversation.view`（会话视图标签条）与 `settings.section`
  （设置页），后者的理由是"会话为空白时标签条整条隐藏，设置页是那时唯一可达的入口"。产品决定改为
  **标签条是唯一入口**，设置页里的「记忆」「知识」必须去掉。

- **改动**：`packages/plugin/src/client/index.ts` 的 `apply()` 删掉两个 `settings.section` 注册
  （id=`memory`/`knowledge`，order 25/26），面板仍由两个 `conversation.view` 标签
  （id=`memory` order=20、id=`knowledge` order=30）渲染，逻辑与 Remote 依赖一字未动。
  `packages/plugin/package.json` 的 `dsh.client.inject` 同步去掉 `@deepseek-ai/dsh-client-ui-settings`
  —— 它之前唯一的用途就是把 `settings.section` 这个槽位声明进客户端组合，现在没有消费者了。

- **影响与代价**：会话为空白（还没发第一条消息）时，会话视图标签条被 `ui-conversation` 隐藏，
  此时界面里没有到「记忆」「知识」的入口——这是这项取舍的已知代价，面板本身随时可从任一会话的标签条进入。
  文档（`docs/DSH_INTEGRATION.md` §4、`docs/INSTALL.md` 排障表）已同步。

### Added（启动时的 dsh 兼容性门禁：证明不兼容就拒载，版本差异只警告；规则在底座 `@avantf/dsh-compat`）

- **背景**：DSH 的 Typert API 已经动过一次（`TypertSchema { schema }` → `TypertSchemaFactory { create }`），
  失败方式是"插件挂载成功、某个 remote 调用或 schema 投影在运行时才炸"，报错里没有一个字指向版本错配。
  所以启动时做一道门禁，日志前缀 **`compat:`**（英文，属于终端诊断）。

- **判定 / 探针 / 复查 / 报告都在家族底座** `@avantf/dsh-compat`（兄弟仓源码依赖）：本仓的
  `packages/plugin/src/provision.ts` 只声明自己的 `COMPAT_SPEC`（服务契约、宿主版本包、wire schema 名、
  事件清单与中文报告文案），并组合底座的 `gatherEvidence` + `verdictOf`（跑一次，把**同一份 evidence** 交给
  provision sweep 的纵深防御复查）。真身注册后由 `verifyRegisteredFaces` 按**精确 key** 复查 20 个 schema 与
  8 个工具名。详见 DESIGN §12.1。

- **时机与两档严重性**：检查在 `apply()` **最前面**、`buildRuntime(...)` **之前**。
  - **探测证明不兼容**（必需服务/方法缺失、工具探针被拒不认、wire 探针注册被拒 / 查不到 / `toJSONSchema`
    失败）→ **不加载**：不建 runtime、不注册工具 / `avantfMemory` / prompt 段与上下文 / remote / 真实 typert
    face；打出 `compat: INCOMPATIBLE` / `compat: REFUSING to load`，并注册一条 `/mem` 命令说明原因与出路。
  - **仅版本号不同**（探针通过）→ **软提醒**：一条 `compat: WARNING` 写明两侧版本与出路（`pnpm build:dsh`），
    然后**照常挂载**。版本差异是风险信号、不是不兼容的证据；版本解析不到也照常继续。
  - **环境准备跟着这道门**：`provisionToolchainAsync(rt, options)` 的第一步用同一份 evidence 再判一次；
    不兼容 → **不解析、不安装、不预热任何 artifact**，直接返回 `{ skipped: true, status, reason }`。
  - **绝不抛错**：整段检查与"不加载"路径都不抛（历史上一个抛错的 `apply` 让整个 `dsh web` 起不来）。

- **测试（可证伪）**：plugin `test/provision.spec.ts` **14** 条（spec 覆盖 `inject`、codec 双成员、20 个
  schema 全部可投影、健康/拒绝/版本差异/无法探测四种判定、`/mem` 扩音器、精确 key 复查）；core
  `test/model_bootstrap.spec.ts` 断言"不兼容时一点 provision 都没跑"；`scripts/mount-smoke.mjs` 的真实
  Cordis 挂载含正/负两个兼容性用例（负例断言打出 `compat:` 拒载行、注册工具数 0、无 `avantfMemory`、
  无 `avantfMem` remote、typert invocations 0、`apply` 未抛错）。

- **实测**：`pnpm build:dsh` → `MOUNT SMOKE OK`（`compat: OK` / `compat (neg): OK`）；`pnpm pack:plugin --mount`
  → `✓ PACK OK`；`lib/index.js` 内不再有 `0.1.5-rc.2` 常量，改为 `import … from "@avantf/dsh-compat"`，
  `lib/client.js` 内既无常量也无底座引用。正常挂载的 typert 调用数仍是 **10**，未新增 agent 工具，未动三段
  系统提示词。

### Changed（编译彻底收敛：只对着已安装的 dsh，删掉 `--runtime` 与 `--client-only`）

- **一条编译路径**：插件的链接、`tsc` 类型检查、mount smoke、tsdown 的 client preset 全部只依赖
  **已安装（发布）的 dsh** + 仓库自带的 preset 副本，不再存在任何"对着 harness checkout 编译"的分支。
  `scripts/link-dsh.mjs`（现在不接受任何模式参数）、`scripts/mount-smoke.mjs`、`scripts/build-plugin.mjs`、
  `scripts/release-check.mjs` 都不再解析 harness 源码；全仓不再有 `resolveHarness` 调用（只剩可选的漂移
  核对用非致命的 `findHarness`）。
- **preset 恒用仓库自带副本**：`packages/plugin/tsdown.config.ts` 删掉 `AVANTF_TSDOWN_CLIENT_PRESET` 选择器
  与 `resolveHarness('tsdown')` 分支，改为按字面相对路径 import `packages/plugin/vendor/dsh-client-preset/`
  （8 个文件 / 2334 行，逐字节拷贝，来源与重新对齐见 `ORIGIN.md`）。副本只在与 harness 对应文件逐字节
  相等时才可信，所以 `scripts/check-preset-drift.mjs` 保留为**可选**交叉核对：有 checkout 才比、没有就静默
  exit 0，被 `link-dsh` / `release-check` 调用时只出提示、不阻断——它不是编译依赖。
- **删掉两个模式参数**：`build:dsh` 不再有 `--runtime` / `--client-only`；`release:check` 不再有
  `--runtime`（第 5–7 步恒为已安装 dsh，标签统一 `LOCAL: the installed dsh`），两者都会对未知参数报错而
  不是静默接受。`build:dsh` 保留 `--fresh` / `--skip-deps` / `--no-verify`。"只重建浏览器半边"的逃生口
  改为 `pnpm -C packages/plugin run bundle`（纯 tsdown、不 tsc、跳过 mount smoke；因为 preset 恒用自带
  副本，这条在无源码机器上也能跑），README / `docs/RELEASING.md` / `docs/INSTALL.md` / `release/README.md`
  已把替代路径写明，不留能力悄悄消失。
- **删掉 `versionDriftWarning`**：它的前提（`tsc` 对着 checkout 检查）随 dev 链接一起消失，留着只会在
  合成场景里误导；`scripts/harness-path.mjs` 同时删掉强制的 `resolveHarness`，只留非致命的 `findHarness`
  （漂移守卫用）与 `installedDshDir`。这里记下它当年的价值：这台机器上全局 dsh 是 `0.1.5-rc.2`
  （registry 的 `TypertSchema { schema }`），而 harness checkout 的 `lib` 被从它自己的 src
  （`0.1.6-alpha.2`，`TypertSchemaFactory { name, create }`）重建，dev 链接曾让
  `packages/plugin/src/remote.ts`（手写 wire face，正是按运行中的 dsh 写的）报 4 处 TS 错误——**插件
  没错，判定它的版本错了**。`--runtime` 曾是绕开它的开关（保留 runtime 链接并用它跑 `tsc`，不切回）；
  现在编译只看已安装的 dsh，这个问题自然不再存在。
- **发布树投影同步**：`scripts/make-release-tree.mjs` 针对 `release-check.mjs` 的 transform 锚点随本轮文本
  更新（header 与 STEPS），发布树仍能生成，投影里不含任何 checkout 编译路径。
- **实测**：`DSHHARNESS=/nonexistent pnpm build:dsh` → exit 0，两个产物 + `MOUNT SMOKE OK`；
  `DSHHARNESS=/nonexistent pnpm release:check --allow-uncut` → **7/7 PASS**，第 6/7 步标签
  `LOCAL: the installed dsh`；`DSHHARNESS=/nonexistent pnpm -C packages/plugin run bundle` 成功；
  `node scripts/pack-plugin.mjs --mount` → `✓ PACK OK`（tarball 内无 `vendor/`、无 `lightningcss`，两个
  产物里 `grep -c lightningcss` = 0，typert 调用数仍 **10**）；自带 preset 与 harness preset 的三个产物
  仍逐字节相同（`lib/index.js` `95f617af…`、`lib/client.js` `f40de26f…`、`lib/client.js.map`
  `101e7740…`）。
- **未改**：`packages/plugin/src/remote.ts`（它对已安装的 dsh `0.1.5-rc.2` 是正确的）与
  `packages/plugin/src/prompt.ts` 的三段系统提示词；不发布 npm。

### Fixed（入库表单的纵向间距）
- **入库表单的控件行之间补回间距**：表单容器用的是 `.item`（一张卡片：`padding`/`border`/背景），它本身是普通块级元素，所以字段行、`来源 / 粘贴文本` 切换行、来源框和动作行**彼此紧贴**；上一轮删掉入库表单那句说明文字后，字段行与切换行之间唯一的视觉间隔也没了，整块显得拥挤。修法是给这张卡片再加一个 `.form`（`display:flex; flex-direction:column; gap:8px`，与 `.picker` 同一节奏），不引入新的间距数值体系；plugin 单测加守卫（断言用的是 `css.item + css.form`，且样式表里 `.form` 确实是带 `gap: 8px` 的纵向列），`css-modules.d.ts` 同步声明（`css_module_types.spec.ts` 会比对两侧）。

### Fixed（知识查询面板的 domain 说明去掉）
- **去掉下拉下方那句「新增领域请改配置 knowledge.domains」**：查询面板的 domain 与 source 等控件排在同一行，多出这一行说明会让这一格比邻居高，整行的对齐就歪了。入库表单本来也没有这句话（它有「+ 新增领域」按钮，按钮自己说明它做什么）。`DomainField` 现在只渲染「标签行（含可选「+」）+ 下拉」，不再有任何条件说明文字；plugin 单测加了守卫断言客户端源码里不再出现该串。

### Fixed（`kb_add` 在 `source_uri`/`paths` 下"只新增"不成立）
- **实测缺陷（上一轮 CHANGELOG 已记为已知缺口）**：`kb_add({source_uri})` 委派 `rt.kb({action:'ingest', source_uri})` → `ingestUri` 按 URL/basename 解析标题后**替换**；`kb_add({paths})` → `import` → `importPaths` 按 basename **替换**。而契约 `KB_ADD_TOOL.description` 明写"只新增、不修改：同一 `(domain, source, title)` 已存在时会拒绝"——声明与行为不符。
- **修法**：把"校验"从各入口提出来做成一件事——`KnowledgeStore.ingestRequest(req, mode)`，固定顺序 **① plan → ② classify → ③ 各自流程**，并暴露成两个运行时外观：`rt.kb`=**replace**（界面「入库」与 CLI；命中已存在身份时返回结构化冲突清单、**什么都不写**，只有带 `overwrite: true` 重跑才替换），`rt.kbAdd`=**add**（模型面 `kb_add`；单篇命中抛可行动中文错误，**永不替换**）。`kb_add` 三种入参因此都不再替换。
- **plan 先于读取/抓取**：plan 只用 `stat`/`realpath`/`readdir` 加上调用方已经拿在手里的 `text` 算身份并查库，**不读文件内容、不发网络请求**；text/URL/本地文件/目录的判定统一到 store 里唯一的 `classifySource`（`ingestUri` 自带的 `^https?://` 判断删除）。身份规则不变：text → `deriveDocTitle`、URL → URL 字符串、本地文件 → `realpath` 的 basename、目录 → 逐文件 basename（不用目录名）。
- **可观察断言（证伪 plan 抢先）**：core 用"命中冲突的 `source_uri` 指向一个读取时必被拒的 PNG（若读了会得到二进制拒绝）"和"指向不可达/私网 URL `http://127.0.0.1:1/x`（若抓了会得到边界拒绝）"，两条都断言拿到的是**只新增冲突**；mount smoke 在真实 gateway 上重复了 URL 那条。
- **`KB_ADD_TOOL.input` 不加字段**：`overwrite` 只加在 `KbUnion`（内部引擎 API：界面远端面 + CLI）的 `ingest`/`import` 两个分支，字段说明为「已确认覆盖同名文档；缺省拒绝。」；8 个模型可见工具的 schema 一个字段都不多（契约测试断言 `KB_ADD_TOOL` 的 properties 不含 `overwrite`）。typert face 的调用数仍是 **10**（`overwrite` 是既有 `kb` 描述符里的字段，未新增 remote 方法）。
- 覆盖：core 新增 **5** 条（add 模式本地文件冲突不读文件、add 模式 URL 冲突不抓取、replace 冲突写清单且确认后按 doc_id 替换、replace 批量全有全无、add 批量逐条进 `failed` 且其余照常导入），并把原先走 `rt.kb` 断言"抛出"的两条粘贴用例改成断言结构化清单、`ingestUri`/`importPaths` 两条替换用例改走 `overwrite: true` 继续钉住替换语义；plugin `kb_add` 4 → **8** 条（source_uri 本地文件冲突、URL 冲突不抓取、批量只拒已存在的那条、新 source_uri 正常新增）；plugin 新增 `ingest.spec.ts` **7** 条（`ingestConflict`/`conflictMessage` 纯函数 + 三条源码接线守卫：问用户、取消 return、`overwrite: true`）；契约新增 **1** 条（`overwrite` 存在与文案 + 模型面不含）；CLI 新增 **1** 条（无 `--overwrite` 非零退出、带 `--overwrite` 真替换且 `doc_id` 不变）。

### Added（共享摄入入口 + 界面覆盖前二次确认）
- **界面「入库」冲突时先问再写**：命中已存在身份（URL / 本地文件 / 目录 / 粘贴文本一律）时宿主返回 `{conflict:true, error, conflicts:[{doc_id,title,path}], would_overwrite, would_add}` 且**一条都不写**；客户端复用删除文档的二次确认框，标题是摘要「将覆盖 N 篇 / 新增 M 篇」+ 命中文档清单（最多列 8 篇，其余只报数量），确认后带 `overwrite: true` **整体重跑**（URL 重新抓取、目录重新导入），取消则不发第二个请求。多篇命中因此不是"先写一部分再弹窗"。
- **`paths` 批量在 add 模式不是全有全无**：已存在的文件**不写**、逐条进 `ImportResult.failed`（带同样可行动的中文原因），其余照常导入——100 个文件的导入不会因为 1 个已存在而整体失败。界面 replace 模式的批量则相反，是全有全无。
- **CLI**：`kb ingest` / `kb import` 默认不带覆盖确认，冲突时非零退出并说明原因；新增显式旗标 `--overwrite` 仍可刷新一个 URL / 重新导入目录（界面确认框是等价入口）。

### Fixed（粘贴文本不再静默覆盖同一篇）
- **实测缺陷**：`domain=ops` 下连续两次 `rt.kb({action:'ingest', text, domain:'ops'})`（不填 `source`/`title`）都返回同一个 `doc_id`（探针里是 `3`）、都写 `docs/ops/default/default.md`，`list('ops')` 只剩 **1** 篇，第一篇的正文与受管文件被第二次静默重写。根因：`KnowledgeStore.ingest` 的 `const docTitle = title ?? source`，而 `source` 缺省 `DEFAULT_KB_SOURCE='default'`，于是同一领域下所有无标题粘贴塌成身份 `(domain, 'default', 'default')`。
- **修法**：新增 store 的**只新增**入口 `KnowledgeStore.ingestNew`：先解析标题（`title ?? deriveDocTitle(text)`），身份已存在就抛中文错误——给出已有 `doc_id`、标题、受管文件绝对路径（`docFilePathOf`）与两条出路（换标题另存 / 改那份 `.md` 后索引自动跟随）——**不写任何东西**；不存在才显式带标题调用 `ingest`。`rt.kb` 的 `text` 分支改走它，所以 UI / CLI 与 `rt.kb` 直调收敛到同一条闸门（MCP 的 `callSurface` 仍是拆分前的键位、不能分发 `kb_*`，是**既有的、与本轮无关**的缺口，未改）。`kb_add` 自己那段重名预检（`req.title ?? req.source`，与 store 兜底同款、会随标题规则漂移）删除，由 store 统一拒绝；error 里仍保留 `doc_id`/标题/受管路径。
- **只动粘贴这条入口**：`ingestUri`（URL / 本地文件）与 `importPaths`（目录导入）保持同身份替换，`sync` 的 stale 重新摄入与 `adopt` 认领后的重新摄入继续走 `store.ingest`——它们的替换语义由测试反向钉住。`kb_add` + `source_uri`/`paths` 当时仍会替换，是一个**已知缺口**——已在同一条 `[Unreleased]` 的"`kb_add` 在 `source_uri`/`paths` 下只新增不成立"里修掉（`rt.kbAdd` 只新增，替换改由 `rt.kb` + 二次确认承担）。
- 覆盖：core 新增 **6** 条（两次无标题粘贴得到两篇且第一篇正文与受管文件都在、同一首行第二次被拒且错误含 `doc_id`/标题/路径、粘贴 + 显式 title 同身份也被拒、`ingestUri` 同身份仍替换、`importPaths` 同 basename 仍替换、`sync` stale 仍重摄入），并把原先走粘贴入口的 `re-ingesting the same domain/source/title replaces chunks` 改到 `store.ingest` 继续钉住替换语义；plugin 新增 **4** 条走真实 runtime 的 `kb_add` 行为断言（显式 title 被拒、两次无标题粘贴得到两篇、同推导标题被拒并给出 `.md` 路径、三选一缺失仍报错）；`scripts/mount-smoke.mjs` 的 `kb tools` 检查加真实断言（两次无标题粘贴得到两篇），remote 方法数仍为 **10**。

### Changed（粘贴文本的缺省标题从正文推导）
- **`title` 缺省不再用 `source`**：新增确定性 `deriveDocTitle(text)`（`packages/core/src/store/doc_files.ts`，与文件名清洗规则同处，复用同一条 `MAX_SEGMENT=80`）：优先正文第一个 Markdown ATX 标题并**跳过围栏代码块**（避免把 `#include` 当标题），否则第一个非空行去掉行首的 `#`/`>`/`-`/`*`/`+`/`1.`/`1)` 标记，全空白兜底 `untitled`；同一段文本永远得到同一标题（否则"只新增"会变成每次新建）。`KnowledgeStore.ingest` 的 `title ?? source` → `title ?? deriveDocTitle(text)`，函数从 `@avantf/mem` 导出。
- 进模型 / 界面的文案同步：`KbTitleField.describe` 由「文档标题；可选，缺省用 source。」改为「文档标题；可选，缺省取正文首个标题或首行。」；界面标题占位符由「缺省用 source 作标题」改为「缺省取正文首个标题或首行」。三张禁用词表守卫（返回描述 / 解释 / 流程时机）继续全绿。
- 覆盖：core 新增 **6** 条 `deriveDocTitle` 断言（ATX 标题优先且取第一个、围栏内 `#` 不算标题且回退到围栏外首行、无标题取首个非空行并去行首标记、超长截断到 80、全空白 → `untitled`、同文本两次结果相同）。

### Added（知识域标签旁的「+ 新增领域」，写回配置且立即生效）
- **入库表单的 domain 下拉旁新增「+ 新增领域」**，用户不必手改 YAML：点开一个小输入，确认后宿主把名字写回 store 配置 `~/.avantf/knowledge/config.yaml` 的顶层 `domains`。**查询面板的 domain 过滤没有这个按钮**——它只是过滤，加领域在那里没有意义。
- **写配置保留注释且原子落盘**：`packages/core/src/config/domains.ts` 用 `yaml` 的 `parseDocument` + `toString`（不是 `parse`/`stringify`，后者会丢注释），`domains` 已存在时**原地** `seq.add` 以保留键与条目的注释，缺失时创建；临时文件 + `rename` 落盘（与受管文档副本同一先例）。实测：带 `# 注释` 的临时配置追加后注释仍在、`open.editor` 等兄弟键不动、文件不存在时会创建。
- **立即生效**：允许集合改为 store 里的**可变内存集合**（启动时由「配置清单 ∪ `documents` 已有领域」播种），`addDomain` 写盘后同步加入，所以**当次会话即可往新领域入库，不必重启**（配置仍只在启动时读一次，手改文件才要重启）。`domainCatalog()` / `assertDomainAllowed()` 都改为读这个集合，普通写入不再查数据库。
- **校验在 store 与界面两侧一致**：trim 后为空 → 拒绝；含 `/` 或 `\` → 拒绝（它会成为受管路径的一级目录，`sanitizeSegment` 会改写分隔符，放进去就是"下拉显示名 ≠ 目录名"）；已在选项里（配置 ∪ 库内 ∪ 本次新加）→ **直接选中、不重复写**。
- **清单为 `[]`（不限制）时不提供「+」**，且 store 的 `addDomain` 直接拒绝：往"不限制"的清单里追加一项会把它**静默变成受限清单**，这是语义陷阱而不是功能。
- **走新的 UI 专用远端方法 `kbAddDomain`**（`remote.ts` 描述符 + `AvantfMemGateway` 实现 + client 的 `AvantfRemote` 声明三处同步），**不是** agent 工具——agent 仍只受清单约束，这个不对称是刻意的。
- 覆盖：core（writer 保留注释/创建缺失键/不重复；`addDomain` 立即生效、持久化、拒绝空/斜杠/重复、`[]` 时拒绝且文件不动）、plugin（`checkNewDomain` 的 trim/空/斜杠/已存在、`kbAddDomain` 进入 `remote_wire` 的"声明 ⊇ 发送"守卫）、`scripts/mount-smoke.mjs`（走真实 gateway 调 `kbAddDomain`，随后往新领域入库成功，并读回配置文件确认已写）。typert face 调用数 9 → 10。

### Fixed（缺省 `source` 下沉到 store）
- **绕过契约直调 `rt.kb` / `store.ingest` 不再产出 `undefined` 身份**：实测 `rt.kb({action:'ingest', domain:'legacy', title:'旧文档'})` 不传 `source` 时，store 的 `ingest(text, domain, source: string, …)` 没有缺省，身份变成 `legacy/undefined/旧文档`，随后抛出令人困惑的 `文档 upsert 之后找不到自己的行：legacy/undefined/旧文档`。真实入口都被契约（`.default(DEFAULT_KB_SOURCE)`，覆盖工具/UI/MCP）与 CLI（`|| DEFAULT_KB_SOURCE`）兜住了，只有直调 store 的调用者（验证脚本、未来的内部调用者/测试）会踩——缺省属于身份规则，现在和身份规则住在一起：`ingest` / `ingestUri` / `importPaths` 的 `source` 都缺省 `DEFAULT_KB_SOURCE`。新增测试直调 `store.ingest`（不传 source）断言身份 `(d,'default',title)`、受管路径 `<d>/default/<title>.md`、且不含 `undefined` 段。

### Added（知识域写入侧清单 + 来源缺省 `default`）
- **`knowledge.domains` 从"死配置键"变成写入侧领域清单**。此前它只是 `config.ts` 里一个没人读的 `z.array(z.string()).optional()`；现在默认一小组通用领域 `['design','api','ops','research','notes']`，**显式 `[]` = 不限制**（是取值，不是"未设置"）。选择这五个是因为它们通用、互不重叠，且**不承担迁移职责**：库中已有的领域始终仍然可用。
- **校验落在 store，不在工具层**：`KnowledgeStore.ingest` / `importPaths` 持有 `config.knowledge`，所以允许值 = 配置清单 ∪ `documents` 表里已有的领域；清单外的新领域抛中文错误并**列出全部允许值**（含"新增领域请改配置 knowledge.domains"）。放在 store 才能让 agent 工具、CLI、MCP 与界面走同一条闸门——否则随手输入照样能造出新领域，甚至同一领域两种写法。`importPaths` 在遍历前先校验（整目录都是被跳过文件时也拒绝），`ingestUri` 经由 `ingest` 覆盖。
- **库里已有的领域必须并进允许值/下拉**：用户现有库只有一个 `Android`，若收窄清单后它既不能被重摄入、也不在下拉里，就等于把历史数据废掉。这条不是兼容层，是"清单只管新增"的语义。
- **`source` 改为可选且缺省 `default`**：契约里 `ingest`/`import`（以及模型面 `kb_add`）的 `source: z.string().min(1)` → `z.string().optional().default(DEFAULT_KB_SOURCE)`，JSON Schema 里它因此变成可选项、解析后拿到 `'default'`；`IngestResult` / frontmatter / 文档身份 `(domain, source, title)` / 受管路径 `<domain>/<source>/<title>.md` 一并用解析后的值。CLI 的 `--source` 同样可省略（用同一个 `DEFAULT_KB_SOURCE`，不再重复字面量）。空字符串不是缺省（会落出空目录段），所以界面把空 source 作为"未发送"处理。
- **界面（知识页）**：入库表单与查询面板的 domain 都改成下拉，选项 = 配置清单 ∪ 库里已有领域；清单非空时**不留自由输入**（下拉下方不写任何说明文字，见上方 Fixed），清单为 `[]`（不限制）时才退回自由输入。新增 UI 专用远端方法 `kbDomains`（宿主实现 + `@Remote` 描述符，**不是** agent 工具），挂载与每次刷新各取一次；两处来源标签去掉必填标记，占位提示写明缺省 `default`。
- 默认值的选择与后果：保留规格建议的五个通用领域，而不是从现有库派生——派生出的清单会把"此刻恰好有什么"固化成允许值，反而挡不住以后的新领域、也无法解释。后果是默认部署下**新领域必须改一次配置**；既有 `Android` 因为并集规则照常可用。
- 覆盖：契约（source 解析为 `default`、JSON Schema 不再 required、清单默认值与 `[]` 语义）、core（清单外被拒并列出允许值、`[]` 放行、收窄后库内领域仍可用、省略 source 落为 `(domain,'default',title)`）、plugin（下拉选项合并、`kbDomains` 进入 `remote_wire` 的"声明 ⊇ 发送"守卫）、`scripts/mount-smoke.mjs`（走真实 gateway：不带 source 入库后 `source_ref` 为 `notes:default:…`，清单外 domain 被拒且错误列出允许值）。typert face 调用数 8 → 9。
- 规格里的三张禁用词表仍然全过：`domain` 的字段说明是"知识域；取值来自配置 `knowledge.domains`"，`source` 是"来源名；可选，缺省 `default`"——只讲是什么。

### Fixed（启动日志把"每进程预热"说成"安装"）
- **模型那行日志不再像"缺了个依赖"**：`model` 这个 artifact 的 `install` 是**语义预热**（每个进程从本地缓存重新加载一次，所以它的 `isPresent()` 按设计恒为 false），而 sweep 用的通用文案是「本机没有，开始安装（本地）」—— 每次启动都读起来像有东西没装好，实际那份 94.8MB 的 `model.onnx` 自 2026-09-10 就在 `~/.avantf/models` 里、`（本地）` 也已经表示"不下载"。
- 修法：`Artifact` 加一个可选的 **`verb`**（默认 `安装`），sweep 的两行变成 `${verb}中` / `${verb}完成`；**`model` 声明 `verb: '预热'`**，`pandoc` 保持默认（它确实要下载并落盘）。实测：
  `provision[pandoc]: 已就绪（…），无需安装` → `provision[model]: 预热中（本地）` → `provision[model]: 预热完成（1459ms）`。
- 用 artifact 自己声明而不是在 registry 里按 `packs` 分支，是因为**语义只有 artifact 知道**：模型是"每进程重建的内存状态"、pandoc 是"装一份"。（LibreOffice 是**故意的探测型、不进 registry**——代码里写明 an artifact's contract is "how to obtain this"，而它没有 obtain 的路径——所以它从不打印这两行。）
- 新增测试断言动词出现在两行里、且有包的 artifact 仍用默认动词；`docs/INSTALL.md` 的示例日志同步更新（原先那里的 model 行写的就是错的）。
- **汇总行同口径**：`provision: 全部就绪（…）` 原先直接打印 `EnsureResult.source` 的枚举，于是显示 `model=installed`
  —— 与上一行的「预热完成」自相矛盾。现在只有**本次预装提供的**才带动词标签（`model=预热` / `pandoc=安装`），
  已存在的只列 id（来源看它上一行的「已就绪（…（managed））」）。
  追查时发现 `ArtifactSource` 里的 `explicit` / `managed` / `system` **从来没被 sweep 填过**（早返回分支不设 `source`），
  所以没有为它们写映射——不留无人能产生的标签。
- 新增测试断言动词出现在两行里、汇总行按动词呈现、且有包的 artifact 仍用默认动词；`docs/INSTALL.md` 的示例日志
  同步更新为实际输出（原先那里的 model 行写的就是错的）。

### Changed（工具描述收紧到「只讲是什么」）
- **再收紧一档**：工具描述与字段说明**只讲"是什么"** —— 上一轮已删"为什么"与"返回什么"，本轮把**"怎么做 / 何时用"**也删掉（流程与时机归三个系统提示词段，返回值自己会说话）。删掉的 8 处：`mem_remember` 的"不要存临时聊天内容"、`mem_recall` 的"回答涉及过去上下文时先检索"、`mem_admin` 的"（先用 dry_run 看数量）"、`kb_query` 的"回答资料性问题前先查一遍"、`kb_add` 的"此时要改那一篇就用文件工具…或换标题"、`kb_list` 的"要修改一篇既有文档，先用它拿到路径…"与"不知道库里有什么…用 kb_query"、`kb_remove` 的"只在用户明确要求删除时才用；doc_id 从 kb_list 拿"、`kb_reindex` 的"只有怀疑索引与正文不一致…时才需要它"（并去掉与 `dry_run` 字段重复的一句）。
- **新增第三条守卫**（契约测试）：`BANNED_PROCEDURE_WORDING` 词表（`要改`/`先用`/`时才用`/`时才需要`/`只在`/`先查一遍`/`不知道`/`而不是它`/`此时`/`拿路径`…）逐个扫描每个工具描述与字段说明。它在**第一次运行时就抓出一处真残留**：`mem_remember.fact_id` 的"（先用 mem_recall 查得）"，已清掉。这类"拦不住就不会被发现"的漂移从此由测试挡。
- 字数：工具描述 3205 → **2866**（工具描述 2274→1244、字段说明 1701→1622；相对本轮起点 3975 累计 **−27.9%**）。最后 18 字是守卫抓出的 `mem_remember.fact_id` 那处清理（`（先用 mem_recall 查得）`），数字按实测回填。三类硬信息一字未动（action 枚举、`【…必填】` 派生标记、参数取值语义）。
- **已知并接受的覆盖缺口**（写进 DESIGN §10，避免以后翻案）：`kb_reindex` 的"何时才需要重建"、`mem_recall` 七个 action 与 `mem_admin` 十二个 action 各自的语义，删掉描述里的"何时/怎么用"后**哪儿都没有**——用户明确接受（名字自明 + 返回值会纠正），**不要**为此把它们写回提示词段。

### Changed（模型面工具文案只讲"是什么 / 怎么做"：删掉全部"为什么"与"返回什么"）
- **8 个工具的 `description` 与 48 条字段说明逐条过了一遍**（工具描述大改；字段说明改了 4 条，其余本已合规），遵循两条规矩：① 只讲这个调用**做什么**、参数**怎么给**，
  不讲**为什么**（理由/机制/前提/后果留在 DESIGN 与 CHANGELOG）；② **不描述返回**（结果载荷的形状/字段/上限/标志位
  一律不写——方法执行完会给出正确的返回，模型看返回值即可）。删掉的返回描述：`mem_remember` 整段矛盾检测回传说明
  （`返回值里带 contradictions`、`最多 20 条`、"此时应确认…不要放任两条并存"）；`mem_recall` 的"只返回事实与出处"、
  `max_tokens` 的"被截断的命中带 truncated=true"；`mem_admin.offset` 的"返回结果含 total 与 truncated"、
  `contradiction_id` 的返回字段路径 `contradictions[].contradiction_id`、`vectors_diagnose/fix` 的 stale/space_stale
  语义、`semantic_available`/`would_warm` 与"预演报 false 不等于修不了"、`contradict_check` 的队列实现细节、
  `contradict_resolve` 的三取值处置说明（`resolution` 字段已写明，属重复）；`kb_add` 的"转换结果带
  `converter`/`warnings`"、"其余文件跳过并在结果里报出"、"入库是等待完成语义：返回时索引已就绪"；`kb_query` 的
  "返回带来源标注（source_ref）的切片/事实"；`kb_list.doc_id` 的"返回该篇详情（含切片）"。删掉的解释性文字：
  "让随后的 contradict_check 能用嵌入腿比对"、"换模型后这会重编码整张表"、"队列在内存中，进程重启…不会重新扫库"。
- **必须保留的三类硬信息一字未动**：action 枚举（`every action is discoverable from its tool description` 逐条断言）、
  字段级【哪些 action 必填】标记（由 `mergedFieldDescription` 从 schema 派生，未手写）、参数取值语义
  （`ttl_days` 的 `0=不设有效期`、`max_tokens` 的 `0=不限制`、`kind` 的 `all/fact/doc_chunk`、
  `limit` 的 `返回条数上限（1-50）` 等）。
- **新增持久守卫**（`packages/contract/test/contract.spec.ts`）：`BANNED_RESULT_WORDING`（`返回结果`/`返回值`/`返回时`/
  `只返回`/`返回带`/`返回该篇`/`报告里`/`在结果里`/`含切片`/`带 truncated`/`` 带 `converter` ``/`semantic_available`/
  `would_warm`）与 `BANNED_WHY_WORDING`（`因为`/`否则`/`原因是`/`之所以`/`所以`/`让随后的`/`换模型后`/`换模型前`/
  `队列在内存`/`进程重启`）两张常量词表，逐条扫描 `TOOL_SPECS` 的每个描述与字段说明（合并 `properties` **与**每个
  `oneOf` 分支，避免后声明字段逃逸），断言信息报出违规的具体条目。**变异验证**：临时注入"返回结果"与"因为"后，
  两条断言分别以 `kb_remove.description must describe the call, not the result ("返回结果")` 与
  `mem_remember.description must state what to do, never why ("因为")` 失败，恢复后 41/41 通过。同一条守卫还钉住
  保留项（`limit` 的"返回条数上限（1-50）"、`max_tokens` 的 `0=不限制`、`ttl_days` 的"不设有效期"、`kind` 枚举），
  防止下一次"清理"把参数语义一并删掉。
- **有意放弃一条漂移守卫**：`contract.spec.ts` 原先断言 `REMEMBER_TOOL.description` 含
  `` `最多 ${MAX_REPORTED_CONFLICTS} 条` ``，该断言与它对 `MAX_REPORTED_CONFLICTS` 的 import 一并删除。原因：描述
  不再提返回上限，这条守卫失去对象；**常量本身保留**（`core` 的 `openConflictsFor` 仍从契约取上限），上限的正确性
  由 `core/test/lifecycle.spec.ts`（`reported` 长度 = `MAX_REPORTED_CONFLICTS`）继续钉住。常量 docstring 同步改写
  （不再声称"描述里写着这个数"）。
- **前后字数对比（实测，按 `TOOL_SPECS` 的 `description` + 模型可见字段说明的 `.length`）**：工具描述 **2274 → 1565**
  （-709）；字段说明 **1701 → 1640**（-61）；合计 **3975 → 3205**（-770，-19.4%）。按工具：`mem_admin` 1341 → 858
  （-483，仍最大但占比从 34% 降到 27%）、`mem_remember` 705 → 557、`kb_add` 592 → 530、`mem_recall` 572 → 537、
  `kb_list` 295 → 292、`kb_query` 230 → 191、`kb_reindex` 150 → 150、`kb_remove` 90 → 90。
- **测试数**：contract **39 → 41**（删 1 条失效的漂移守卫，新增 3 条：返回描述、解释性措辞、参数语义保留）；其余基线不变。
- **文档同步**：DESIGN §10 的"描述说什么"补上"只讲是什么/怎么做，不讲为什么与返回什么"与禁用词表守卫、§12 的文案
  语言段同步该口径。**系统提示词三段（`packages/plugin/src/prompt.ts`，132/185/92 字）未动**（刚定稿，另有守卫）。

### Fixed（独立验收抓出的两个 provision 缺陷）
- **关掉自动下载时，模型不再预热（语义检索被静默降级）**：下载开关（`tools.auto_install=false` /
  `AVANTF_MEM_AUTO_DOWNLOAD=0`）原先拦在**每个** artifact 的 `resolve` 上，而 `model` 的 `isPresent()`
  按设计恒为 `false`（它必须每次启动都预热），于是它**永远过不了 resolve** —— 明明本机有缓存，却报
  "模型不可用"，检索退化为 FTS+entity。现在**开关只对有 `packs` 的 artifact 生效**（`packs` 就是"要下载"
  的判据）；没有 `packs` 的 artifact（模型、LibreOffice 探测）直接走 `install`，由它自己决定用本地状态。
  同时 `packFor` 不再对无包 artifact 调用（它本来会抛"未声明任何平台包"），`InstallContext.pack` 变为可选，
  声明了包的 artifact 用新的 `requirePack()` 收窄。
- **`installContext` 根本不透传 `artifactEnv`，导致模型预热在默认配置下也失败**：`model` 的 `install`
  就是语义预热，需要拥有模型缓存的 runtime，而它来自 `artifactEnv` —— 这个字段从未被传给 install（只有
  `isPresent`/`verify` 拿到）。于是**每次启动**都报"需要 artifactEnv.runtime"，语义路径不可用。
  挂载冒烟掩盖了它：那里 `AVANTF_MEM_AUTO_DOWNLOAD=0` + 临时 dataHome，"模型失败"本来就是预期。
  现在 `installContext` 原样透传 `artifactEnv`（类型与文档一并补上）。
- 测试：provision 28 通过（新增 3 条：无包 artifact 在关网下仍安装、有包 artifact 被拒且理由点名开关、
  `artifactEnv` 原样送达 install）；`install.spec` 改用 `requirePack`。
- **挂载冒烟新增守卫，防止同类缺陷再被"预期失败"掩盖**：模型预热失败在冒烟里是**预期**（临时 dataHome +
  关网），这正是 `installContext` 漏传 `artifactEnv` 能藏住的原因。现在冒烟截取挂载期间的日志（补
  `console` 方法而不是 `process.stdout.write` —— Node 的 Console 在构造时就绑定了 stream 的 write），
  断言：① sweep 必须收尾（`全部就绪` 或 `n/m 未就绪`）；② **模型失败的理由绝不能是插件自身的管道错误**
  （`需要 artifactEnv` 等）。这一条与缓存/网络无关，所以在任何机器上都可断言。
  **变异验证**：把 `artifactEnv` 透传临时撤掉，冒烟确实 `FAILED swept=true` 并打出
  `provision[model]: 失败 — model artifact 需要 artifactEnv.runtime`；恢复后回到 OK。
- 实测：`release:check` **7/7 PASS**、`pack:plugin --mount` **✓ PACK OK**，且冒烟的模型行从
  `ERROR provision[model]: …自动下载被关闭` 变成 `provision[model]: 安装完成（1565ms）` +
  `provision: 全部就绪（pandoc, model=installed）` —— 在 `AVANTF_MEM_AUTO_DOWNLOAD=0` 下**从缓存**预热。

### Added（依赖预装模块 `@avantf/mem-provision`：把 pandoc 装上，转换切到 pandoc 优先）
- **新工作区包 `packages/provision`（包名 `@avantf/mem-provision`）**：**依赖获取的唯一入口**——
  `Artifact{id,version,isPresent,install,verify}` + `registerArtifact`/`artifacts()`/`ensure`/`ensureAll`，
  与 convert 的转换器注册表同构。它只管**外部二进制与派生运行时状态**（npm 依赖仍归 pnpm），且**不依赖任何
  引擎包**（只用 `node:` 内建），所以被 core/convert 引用后由 tsdown 内联进插件，不新增发布包、不新增运行时依赖。
- **受管安装目录 `~/.avantf/tools/<tool>/<version>/`（版本化，可并存/回滚）**，可执行文件固定在
  `<version>/bin/<binary>`，旁边一份 `install.json` 记录版本 / 来源 URL / sha256 / 安装时间。获取链：
  镜像模板列表优先 → 官方源兜底 → 下载到临时文件 → **sha256 校验**（大小不符与摘要不符分别报错）→
  解压到 `.tmp/` 下的 scratch 目录 → **原子 rename** 到 `<version>/`；每一步失败都带**具体**原因
  （URL / HTTP 状态码 / 期望与实际摘要 / 解压错误），scratch 目录在成功与失败路径上都清理干净。
- **固定探测优先级**：① 配置/环境显式路径（`AVANTF_PANDOC`）→ ② 受管目录 → ③ `PATH` 上的系统安装
  （win32 按 `PATHEXT` 探测，复用 `open.ts` 探编辑器的做法）→ ④ 都没有则**明确报错并给出三平台安装命令**。
  受管目录与系统安装都必须报告**钉死的版本**：不同版本的渲染不同，所以"找到别的 pandoc"会被拒绝而不是静默使用。
- **`tools` 配置段**（`dir` / `mirror` / `auto_install`）：默认**国内镜像优先**、官方源兜底；
  `AVANTF_TOOLS_DIR` 覆盖受管目录，`AVANTF_MEM_AUTO_DOWNLOAD=0` 同时禁用模型与工具的下载。
  **镜像可达性实测（2026-09-17，本机）**：`ghfast.top`/`ghproxy.net`/`gh-proxy.com` 与另外十余个常见
  GitHub 代理**全部不可达**（DNS 不解析，或 TLS 链被替换成自签证书），**官方源可用**（35 MB 约 8 秒）。
  因此镜像列表保留为模板（可用时就用），官方源始终最后兜底，失败时日志列出**每一个**试过的源与原因。
- **注册 `pandoc` artifact（版本钉死 3.11）**：linux-x64 用官方**静态链接** tarball、macOS 用 zip、Windows 用
  zip（不用 msi/pkg：受管目录不该跑安装器）。**sha256 是实测值并写进代码**——pandoc 官方 release 不提供
  checksums 文件（2026-09-17 用 GitHub API 列过 3.11 的全部资产确认），因此四个包的摘要都是当日从官方 URL
  下载后测得、并用 curl 与 Node `fetch` 两次比对（字节数与摘要一致）。Linux 静态二进制在 `env -i` 下可运行，
  不依赖宿主 glibc 之外的库。Linux arm64 未实测，**不给 pack**（宁可明确"不支持该平台"）。
- **启动预装纳入模型预热**：插件挂载点现在只调用**一次** `provisionToolchainAsync(rt, …)`（非阻塞），
  artifact = `model`（嵌入模型 + nodejieba 分词器）与 `pandoc`，每个 artifact 一行结果，失败不阻断其他
  artifact。原来的 `warmModelsAsync` 被吸收为 model artifact 的 `install`（`warmModels` 本身保留给 CLI 的
  等待语义），**不再有两套初始化**；`whenEventLoopIdle` 随之搬到 provision（模型预热仍等宿主就绪信号 + 静默窗口）。
- **用到的那一刻再 `ensure` 一次**：`ensurePandoc` 在每次转换前确认（已有受管副本则零开销），缺失就是明确错误。
- **测试（全部离线、用本地 fixture）**：provision 27 条 —— 起一个 `127.0.0.1` 上的 fixture HTTP 服务，
  用**进程内造的 tar.gz / zip** 把机制测全：下载 → sha256 校验 → 解压（含本包自实现的 ZIP 提取器，
  零 `unzip` 依赖）→ 原子落盘 → 探测优先级 → 摘要不符/大小不符/ZIP SLIP 各自报对步骤且**不留残留**
  （断言 tools 目录为空）→ 镜像回退与"所有源都失败"的完整清单 → offline / `auto_install=false` 不下网。
  另有一条 `describe.skipIf` 的真机用例（探不到就跳过，`git.spec.ts` 的 `hasGit` 是先例）。

### Changed（转换切到 pandoc 优先；删掉被取代的内置转换器）
- **`@avantf/mem-convert` 重写为 pandoc 包装器 + xlsx**：一个转换器认领**一批**格式（表在
  `PANDOC_READERS`，内部是 格式→`--from=<reader>`），**永远显式传 `--from=`**，输出恒为 `-t gfm`
  且用 `--eol=lf --wrap=none` 保证确定性；`sniff` = 内容嗅探 + 扩展名合成（docx/odt/epub 靠 ZIP 条目名、
  HTML 靠内容标记、其余靠扩展名，且**不碰**管线自己的纯文本扩展名）。`converter` 字段**带版本**
  （`pandoc-3.11`），跨机器的语料差异可见。
- **删除被取代的内置转换器**：`mammoth`（docx）与 `turndown`（html，以及它为 GFM 表格加的规则）连依赖一起删掉，
  自带的 CSV 状态机也删掉（pandoc 的 csv/tsv reader 取代它，且不再需要"首行是数值则合成列名"那套判断）；
  `packages/convert` 的 `dependencies`、插件 `dependencies`、`pnpm-workspace.yaml` 的 catalog（含
  `@types/turndown`）四处同步清理。**保留 `xlsx`（exceljs）**：pandoc 没有电子表格 reader。注册顺序
  `pandoc-3.11 → xlsx`（两者不会冲突：pandoc 不认领 `xl/workbook.xml`）。
- **旧版 `.doc/.xls/.ppt`（OLE）按名拒绝**而不是当二进制/文本处理；**LibreOffice 只探测、不自动安装**
  （`detectLibreOffice` + 明确提示），扫描件/OCR 仍搁置。
- **工具描述与文档跟着改**：`kb_add`/`kb_manage` 描述里的"可摄入格式"与批量导入白名单更新为实际支持集；
  `source_picker.ts` 的 `INGESTABLE` 扩成精选白名单（新增 odt/epub/tex/rst/ipynb/tsv/org/rtf 等），并加
  **防漂移测试**：白名单必须覆盖 pandoc reader 表（唯一的例外 `.xml` 走 `PROBE_ONLY_EXTENSIONS`，只有显式
  命名才转换——一个目录里的通用 XML 不是"文档"）。DESIGN §3/§8/§13、README、release/README、docs/INSTALL
  （三平台 pandoc 安装 + 镜像说明 + 受管目录布局）、docs/RELEASING（包计数 8 个开发包 / 4 个发布包）同步更新。
- **真机验收（实测）**：pandoc 3.11 真的装进了 `~/.avantf/tools/pandoc/3.11/bin/pandoc`（走 provision 自己的
  安装路径：下载 → sha256 通过 → 原子落盘 → 探针报告 `pandoc 3.11`）；用 pandoc 自己写出的**真实 .docx**
  （含标题层级、加粗、列表、Word 表格）经摄入管线转成 Markdown 入库，`IngestResult.converter = pandoc-3.11`，
  标题层级与表格完整保留，`kb_query` 能检索到内容。convert 新增真机用例（`describe.skipIf` 探不到就跳过）
  与 core 的摄入用例都跑通。

### Added（文档转换模块 `@avantf/mem-convert`：docx / xlsx / html / csv → Markdown）
- **新工作区包 `packages/convert`（包名 `@avantf/mem-convert`）**：`MarkdownConverter{id,sniff,convert}`
  + `registerConverter` / `converters()` / `convertToMarkdown({bytes,path?})`（按**注册顺序**取第一个认领者，
  无认领返回 `null`）。它**不依赖 core/contract**，新增格式只需实现接口并注册，摄入管线不改。
- **四个转换器（进程内、纯 JS、各自惰性 import）**：`.docx`（`mammoth` docx→HTML → `turndown`；给 turndown
  补了 GFM 表格规则，Word 表格不会被压成一段文字）、`.xlsx`（`exceljs` 逐 sheet 一个小节 + GFM 表，超
  2000 行 / 64 列**截断并写进 `warnings`**）、`.html`/`.htm`（`turndown`，显式移除
  `script`/`style`/`noscript`——turndown 默认会把脚本正文留在结果里）、`.csv`（自带 RFC 4180 状态机：
  引号内的逗号/换行/双引号、逗号/制表符/分号分隔符探测；首行当表头，**首行整行为数值时按数据行处理并合成
  `列N`**）。**明确不做**（各留一个 `MarkdownConverter` 的扩展位）：PDF（保持 `unpdf` 文本层）、旧版
  `.doc/.xls/.ppt`、odt/ods、pptx、epub、图片/OCR。
- **ZIP 靠中央目录条目名区分**：docx/xlsx/pptx/epub 魔数相同，只有
  `word/document.xml` / `xl/workbook.xml` / `ppt/presentation.xml` / `mimetype` 能分开；**扩展名只作提示**
  （docx 命名成 `.txt` 也照样认领，OLE 的 `.doc` 改名 `.docx` 照样被拒）。为此在本包内实现了一个
  ~60 行的 EOCD + 中央目录读取器，不新增 zip 依赖，也不借 mammoth/exceljs 的传递依赖。
- **接入摄入管线（`store/document_text.ts`）**：转换发生在**二进制拒绝之前** —— docx/xlsx 是 ZIP，
  先判魔数会被当「已知二进制」直接拒掉。`DocumentText.via` 增加 `'converter'`；`IngestResult` 增加
  `converter` 与 `warnings`；受管副本 frontmatter 增加**可选** `converter`（`renderDocFile` 跳过
  `undefined`，老文件没有该字段照常解析；正文与 `content_hash` 不受影响）。`sync`/`adopt` 重摄入时把
  frontmatter 里的 `converter` 带回，编辑过的 Markdown 不会丢掉来源。
- **目录白名单**：`source_picker.ts` 的唯一真源 `INGESTABLE` 增加 `.docx/.xlsx/.html/.htm/.csv`
  （picker 与目录遍历共用同一正则）；显式给出的单文件仍不看扩展名。`KB_TOOL` 描述同步更新。
- **发布形态**：`mammoth` / `turndown` / `exceljs` 进 `pnpm-workspace.yaml` 的 `catalog:`，同时进插件
  `dependencies`（纯 JS，保持 import 而非内联）；`@avantf/mem-convert` 进插件 `devDependencies` 以便被
  tsdown 内联。`scripts/make-release-tree.mjs` 的 `PACKAGE_MANIFESTS` / `ENGINE_MANIFESTS` /
  `BROWSER_OR_ENGINE_DEPS` 补上该包：投影出的发布树多一个**被内联的私有引擎包**，而不是第 5 个发布包。
- **测试**：新包 41 条（ZIP 读取器、嗅探、注册表顺序、失败必须明确报错、四个转换器）；core 侧覆盖
  「ZIP 但既不是 docx 也不是 xlsx → 仍按二进制拒绝」（`document_text` 与整条 ingest 路径各一处）、
  frontmatter round-trip（含无 `converter` 的老文件）、白名单新扩展名，以及入库一个 docx 后能检索到内容。

### Fixed（工作区审查报告 15 条的处置）
- **R2-1（高）文档/prompt 与实现自相矛盾**：实现是**带守卫的自动认领**，而 `types.ts`、`tools.ts` 的 adopt
  描述、CHANGELOG 的 `### Added` 段仍写着"绝不自动认领、需人工显式认领"。三处改为实际行为（四条守卫 +
  显式 `adopt` 是立即认领的入口），CHANGELOG 那段重写并消除了与 `### Changed` 段的自我矛盾。
  （审查提到的 `KB_EDIT_PROMPT_SECTION` 那句在更早的提示词精简里已经删掉；审查建议的"改用 `edit`、别用
  `write`"与用户此后的决定相反，故未采纳。）
- **R1-1（中）GBK 描述与实现相反**：`KB_TOOL` 描述、`README.md`、`release/README.md` 说"非 UTF-8 文本会被
  拒绝"，实际 GB18030/GBK 会被**自动解码**并回报 `encoding`（那是这个特性的头号成功案例）。三处订正。
- **R2-2（中）批量导入 = 每文件一次 git 提交 + O(N²) 重新 stat**：新增 `deferCorpusWrites` 与
  `commitCorpus()`，目录导入期间挂起提交与基线刷新，收尾只做**一次**提交（`import: <domain>/<source>（N 篇）`）
  与一次刷新。新测试断言 3 个文件只产生 **1** 个提交且三个文件都在那笔里。
- **R2-3（中）`kb_list` 每行读盘 + 缺省不分页**：新增 `KnowledgeStore.docFilePathOf(doc)`（跳过每行多余的
  `docs.get`），并给面向模型的 `kb_list` 一个**缺省 50 篇**的分页（描述里写明）。逐行的文件读取仍需要
  （路径要靠 frontmatter 解同名冲突），但现在被页大小界住了。
- **R2-4（低）每次工具结果全量对账、无节流**：加 2s 最小间隔，**并安排一次尾随检查**——只丢弃被节流的
  调用会漏掉最后那次编辑。
- **R2-5（低）`lexicalProbe` 不短路**：加 `stopAt` 参数，`relevance()` 传 2（它只问"≥2"）；默认仍返回精确
  计数，校准记录（6/6/2）不受影响。新测试同时断言两种取数。
- **R2-6（低）发布/集成文档工具数陈旧**：`docs/RELEASING.md` 与 `docs/DSH_INTEGRATION.md` 的"5 个工具 /
  一段 prompt"改为 **8 个工具 / 3 段 prompt / 2 个条件 context**。
- **R2-7（极低）`doc_files.ts` 的 JSDoc 错位**：`state()` 的注释被 `stamp()` 顶掉，归位。
- **R2-8（极低）`gitAction='sync'` 是死值**：`sync` 的 stale 重摄入没传该参数，提交信息写成 `ingest:`；
  现在传 `'sync'`，枚举值不再悬空。
- **R1-2（低）`MemoryPanel` 重复的 `reveal()` 挂载副作用**：删掉重复的那一处。
- **R1-3（低）win32 `cmd /c start` 的路径未加引号**：显式加引号，含 `&`/`^` 的标题不再被 cmd 当第二条命令
  解析（`%` 的环境变量展开仍可能发生，属已知残留、影响仅"打开失败"）。
- **R1-4（低）入库表单的陈旧分类竞态**：来源输入变化时**立即清空** `sourceInfo`，去抖窗口内点「入库」不再
  提交上一次的分类。
- **R1-7（极低）`types.ts` 断链 `@link`**：`{@link SKIPPED_REPORTED}` 跨包解析不到，改为纯文本并注明它来自
  `core`。
- **未处置（说明理由）**：R1-5（每次进「知识」tab 的 `sync --dry-run` 全量扫描）——它算 `orphans` 必须全扫，
  与 R2-4 同源，属观察项；R1-6（两份未跟踪的审查报告）——按既定口径**不入库**，留档在工作区。

### Changed（提示词第四轮：允许整篇重写，kb-edit 92 字）
- **不再要求 agent 用 `edit`、也不禁止 `write` 整篇覆盖**：`edit` 在实际执行中会失败，此时重写是必需动作；
  既然已有**带守卫的自动认领**兜住丢 frontmatter 的后果，这条约束就该撤掉。`kb_list` 的工具描述里同样的
  约束一并去掉。**设计立场随之改变**：兜底从"只给事故用的安全网"变成"整篇重写的指定恢复手段"（DESIGN §10 已改）。
- **删掉"不要手动同步，也不要整篇重新入库"**：自动对账已经承担同步，写这句等于描述机制。
- **删除改用用户的原话**："在用户明确要求时使用 `kb_remove` 删除"。
- `kb-edit` 段 132 → **92 字**；三段合计 `132 / 185 / 92 = 409`（本轮系列起点 811）。

### Changed（提示词第三轮精简：516 → 449 字）
- **知识库段删掉"`kb_add` 只新增、同名会拒绝"**：`kb_add` 的**返回值里已经有这条错误**，提示词再复述一遍
  工具的返回就是这一轮要清掉的冗余（工具的**约束**仍写在它的描述里）。
- **两段都删掉"不必等用户开口"**：`主动` 这个祈使句已经承载了同样的信息，多一句只是强调。
- **`kb-edit` 段改用用户的原话开篇**：**"更新知识库时，要在原文上修改或追加，不要新建一个补充文档。"**
  —— 这是用户实际的用法（他会直接叫 agent 去更新知识库），比原来那句"不要用 `kb_add` 另建一篇"更贴
  真实场景。三段的字数现为 `132 / 185 / 132`。

### Changed（提示词精简：只说该怎么做，不解释为什么）
- **三段合计 811 → 516 字**（`memory-usage` 238→140、`knowledge-usage` 354→243、`kb-edit` 219→133），
  且定下一条规矩：**提示词只写动作与约束，理由一律留在 DESIGN 与 CHANGELOG**（写在提示词里每步都要花
  token，又不改变动作）。测试里加了一条守卫，禁止「因为 / 否则 / 原因是 / 之所以 / 身份载体 / 无主文件」
  这类解释性措辞回流。
- **记忆段删掉 recall 引导**（原"回答涉及过去的任务、约定或用户偏好之前，先用 `mem_recall` 检索，不要凭
  印象作答"）：每条用户消息现在都会带上匹配时的条件提示（`avantf:memory-hint`），常驻的"回答前先检索"
  只是每步白花 token。该段从此**只讲写侧**。
- **知识库段给出明确的知识定义**（用户提供的成篇资料：文档、长说明、规范、综述；要按原文查阅的内容），
  并明确边界：一句话的事实属于记忆（`mem_remember`），不要入知识库。删掉 **"踩坑记录"**——那是记忆的
  领地，两边都列就是冲突。
- **保留 `kb_query` 的两条**：回答涉及已入库资料的问题前先检索；命中按 `source_ref` 引用原文。
  其余描述性内容去掉（包括"你看不到库里有什么"——它是要花钱的**解释**，其理由记在 DESIGN §10）。
- **`kb-edit` 段只剩约束**：不要另建一篇、用 `kb_list` 拿路径、用 `edit` 不要 `write` 整篇覆盖、
  不要手动同步。frontmatter 为什么是身份载体、丢了会怎样，从提示词移到 DESIGN。
- 工具描述同步去掉解释：`kb_list` 的 frontmatter 说明、`kb_remove` 的"不可逆（副本一并删掉）"。

### Changed（知识库工具面拆开：改文档 = 改文件）
- **`kb_manage` 从模型面拆成 5 个工具**：`kb_add`（只新增；同一 `(domain, source, title)` 已存在时**拒绝**）、
  `kb_list`（列出文档，**带出受管 `.md` 的绝对路径**；给 `doc_id` 返回详情+切片）、`kb_remove`、`kb_reindex`，
  加上原有的 `kb_query`。**`sync` 不再面向模型**：同步由 `tools/result` 后的自动对账承担，界面保留手动兜底。
  插件的工具列表也改为直接取契约的 `TOOL_SPECS` —— 它原先在 `index.ts` 里**手写**了一份，所以拆完契约后
  插件仍注册着旧的五个（这次就是被这个坑绊了一下）。
- **改一篇既有文档 = 改那份 `.md`**：先用 `kb_list` 拿到路径，再用文件工具改它（提示词明确要求用 `edit` 定点改、
  **不要用 `write` 整篇覆盖**），索引自动跟随。这条修的是一个**实测故障**：模型被要求"更新知识库"时用**新标题**
  又建了一篇（《Cgroup v2 技术综述 · 补遗》），原文成了过时且大面积重叠的第二篇 —— 旧工具的"同名即替换"语义
  只在标题字符串逐字一致时才成立，而 `ingest` 又没有 `doc_id`，所以任何拼写差异都会静默新建。
- **新增第三个提示词段 `avantf:kb-edit`（order 3020，219 字）**：专讲"怎么改一篇既有文档"。原知识库段已到
  382/400 字，塞不下；现在它缩到 354 字，只讲检索与新增。
- **带守卫的自动认领**：整篇覆写丢掉 frontmatter 的文件，`sync` 会**自动**认领回它路径命名的那篇文档并重新摄入。
  四条守卫缺一不可：① 文件**完全没有** frontmatter（声明了任何 `doc_id` 都不算无主）；② 正文**非空**
  （`ingest` 无下限，认领空文件会静默清空该篇）；③ **指纹稳定**（等 250ms 再 stat 一次，避开编辑器"写临时
  文件再 rename"与写盘中途）；④ **路径归属唯一**（`sanitizeSegment` 会把 `a/b` 与 `a-b` 折叠成同一个文件名，
  这种冲突交回人工）。认领的 git 提交 message 用 `adopt:` 而非 `ingest:`。
- 新增/更新的验证：`corpus_drift.spec.ts` 10 条（自动认领成功、拒绝空正文、拒绝共享路径、拒绝别人的文件、
  单篇 sync 不算 orphans 等）；`mount-smoke` 增了一条**走真实 `execute()`** 的检查 —— `kb_list` 带出的路径
  **确实存在**、`kb_add` 对同名三元组**确实拒绝**、对新标题**确实新增**。

### Added（无 frontmatter 的文件：带守卫的自动认领）
- **整篇覆写毁掉 frontmatter 后自动恢复**：`sync` 会把它认领回路径命名的那篇文档并重新摄入。认领要
  **同时**满足四条守卫——① 文件**完全没有** frontmatter（声明了任何 `doc_id` 都不算无主，那是
  `sanitizeSegment` 折叠出的冲突）；② 正文**非空**（`ingest` 只有上限 `MAX_DOC_CHARS`、**没有下限**，
  `chunkText('')` 返回 `[]`，认领空文件会把那篇**静默清空**）；③ **指纹稳定**（等 `ADOPT_SETTLE_MS`
  再 `stat` 一次，避开编辑器"写临时文件再 rename"与写盘中途）；④ **路径归属唯一**（`sanitizeSegment` 会把
  `a/b` 与 `a-b` 折叠成同一个文件名，这种冲突交回人工）。认领的 git 提交 message 用 `adopt:`。
- 报告与界面同步：`sync` 报告里有 `unclaimed`（候选）与 `adopted`（本次认领了几篇）；不满足守卫的候选留在
  `unclaimed` 里，界面该行显示「文件无 frontmatter · 可认领」并给出「认领文件」按钮，
  `kb_manage {action:'sync', doc_id, adopt:true}` 则是立即认领的显式入口。
- 测试 4 条钉住这套行为：**自动认领成功**（dry run 只报告、real sync 认领后正文与 frontmatter 都回正）、
  拒绝空正文、拒绝共享路径、拒绝别人声明的文件——后三者都断言索引里的原文**仍然在**。

### Added（按文件精确定位的自动同步）
- **`KnowledgeStore.corpusDrift()`**：只 `stat` 不读内容，回答"哪几个受管文件看起来变了 / 哪个文件不见了 /
  文件集合是否变了"，成本是**每篇一次 `stat`** 而不是"读+哈希整个语料"。指纹（`mtimeMs:size`）只当
  **触发器**不当判据 —— 同秒编辑、粗粒度文件系统、`cp -p` 都能骗过它，所以 stale 与否仍由 `sync` 的
  正文哈希裁决（宁可多查一次，不能漏）。
- **`tools/result` 之后精确对账**：插件的触发点是"一次工具调用结束"（`tools/result` 是 emit、不被 await，
  所以不会把工具结果阻塞在同步后面；`tools/pre-execute`/`post-execute` 是 waterfall，挂那里会拖慢每一步）。
  指纹变了才动，且**只对变化的 `doc_id` 跑 `sync({docId})`**；文件集合变了或有文件不见了才升级为全量对账。
  启动时对一次账，覆盖 dsh 没运行期间的变化。自写回环会收敛（自己写入后重取基线，`ingest` 之后 sync 是
  no-op）。防重入：一次对账在飞行时，后续事件直接跳过。
- **修掉一个真 bug（新测试抓出来的）**：漂移检查原先用 `pathFor()` 取路径，而它**依赖文件内容**——为解冲突
  会读 frontmatter 的 `doc_id`。于是文件被整篇覆写（frontmatter 丢失）后，`pathFor` 回答的是 `…~1.md`
  这个不存在的路径，`stat` 得到 null，**"文件变了"这件事对专为发现它而写的检查完全不可见**。现在指纹用
  与内容无关的 `basePath`（身份的纯函数），骗不过去。
- **单篇 `sync` 不再走整棵树**：指定 `docId` 时不再计算 `orphans`（那是语料级答案，而那趟遍历正是按篇
  路径要避免的成本）。
- 已知残留（写在明处）：**整篇覆写（frontmatter 丢失）能被发现，但不会被自动重新摄入** —— `sync` 拒绝猜
  "这个文件属于哪篇"。它会被如实报成 `missing` + orphan（「受管文件缺失」徽标），但索引仍是旧的。要自动
  恢复，需要一条"basePath 即身份、无主文件可被该路径命名的文档认领"的规则，那是语义变更，尚未做。

### Added（知识库受管文档目录自动上 git；git 操作抽成复用库）
- **git 操作是一个与具体 store 无关的复用库**：`packages/core/src/git.ts` 的
  `GitRepo({ root, mode, ignore, identity, logger })`，API 只有 `init` / `commit` / `history` /
  `branch` / `enabled`，全部不抛错。知识库只是第一个使用方（`root` 默认取 `knowledge.docs.dir`）。
  抽出它是为了"共享一整个 store"：把 `root` 指向 `~/.avantf/knowledge` 甚至 `~/.avantf`，
  用 `ignore`（默认 `*.db` / `*.db-wal` / `*.db-shm`）把数据库挡在历史外；`ignore` 只在**建仓时**
  写入 `.gitignore`，**绝不覆盖**用户自己写的那份。
  **共享的前提是文本表示**：知识库有（`docs/**/*.md`）；**记忆库没有**——`~/.avantf/memory/` 下只有
  `memory.db`（+ WAL/SHM），提交它等于每次写入都产生一个不可 diff、不可合并的二进制变更。
  要让记忆库可共享，先得有类似受管副本那样的**文本导出**（每条事实一行，带 id/时间/来源），尚未实现。
- **`knowledge.git`（`mode` 默认 `auto`）**：`knowledge.docs.dir`（受管 `.md` 副本所在目录）本身就是一个
  git 仓库 —— 没有仓库时自动 `git init`，每次写入（`ingest` / 重新摄入 / `remove` / `import`）完成即
  自动提交一次，message 形如 `ingest: <domain>/<source>/<title>` / `remove: …`。
  选在这个目录上仓，是因为它正好是"内容"那一层：每篇一个文件、正文逐字节照存；而 `knowledge.db`
  是从它派生的索引，**刻意不入库**（否则每次写入都是二进制大对象的变更）。
- **三条边界**：① 插件**永不添加 remote、永不 push** —— 远程与推送由用户自己决定；
  ② 提交失败**绝不影响**摄入结果（与 `IngestResult.file_error` 同一条原则，只记一行 warn，
  这样 `git` 缺失、索引被锁、仓库不可写都不会把一次成功的摄入变成失败）；
  ③ **每次自动提交都带一行 `Automatic: avantf-mem` trailer**（`git log --grep` 即可区分机器提交与手动提交）：
  作者优先用机器已有的身份（仓库是用户的、他也会在里面手动提交），只有机器完全没有 `user.email` 时才退到
  仓库本地的机器人身份 `avantf-mem <avantf-mem@localhost>`，且**绝不写全局 git 配置**。
  ——这一条是实测后修正的：原先的意图写作「不把自动提交伪装成用户提交」，但实现是「有全局身份就用它」，于是本条仓库的第一条自动提交被记成了 `qunqi.ff <qunqi.ff@alibaba-inc.com>`，与写下的意图不符。现在改为「署名可以是你，但提交必须自带机器标识」。
- 测试 7 条（`test/doc_git.spec.ts`）：自动建仓、无变化不产生空提交、改动提交、**删除提交且内容可从
  历史取回**、本机有全局身份时仍用机器人身份、`off` 完全不碰 git、以及"永不抛错"（缺目录 / git 跑不起来）。
  另两条集成：经 runtime `ingest` 后仓库存在且有一条提交、`remove` 提交删除，以及**提交的内容与摄入正文
  逐字节一致**（历史里那份就是可回滚的正文）。git 不可用的机器上这些用例会 skip 而不是 fail。
- 已知边界（写在明处）：git 给的是**正文的历史与回滚**；"回退文件就等于恢复索引"没有实现也没有验证 ——
  `sync` 只做增量对账，从零用 `docs/` 重建 DB 不是已有能力。

### Changed（知识库允许 agent 主动入库）
- **写侧从"只在用户明确要求时用"改为允许主动**：值得长期留存的**成篇内容**（用户给的文档、长说明、现成的
  规范/综述/踩坑记录）由 agent **主动**用 `kb_manage` 的 `ingest` 入库，不必等用户开口 ——
  一句话的事实仍走 `mem_remember`。补这条区分是因为原先"只在用户明确要求时用"留下了一个真实的坏路径：
  记忆段教它"重要且跨会话仍成立就 `add`"，而一篇长文档完全符合这句话，`mem_remember.content` 又只有
  `min(1)`、**没有长度上限**，于是整篇会被塞进一条事实，而库里没有可检索、可引用 `source_ref` 的文档。
- 段落里同时点明两处语义：同一 `(domain, source, title)` 重复入库是**替换**（改动靠 `ingest` 覆盖或
  `sync` 重新摄入）；**删除仍是唯一的例外**，只在用户明确要求时做 —— 它会连受管副本一起删掉。
- 新增 4 条测试断言把这条政策钉住（点名 `kb_manage`、`主动`/`不必等用户开口`、`替换`、
  `删除只在用户明确要求时做`、以及 ingest 与 `mem_remember` 的区分）。

### Added（记忆 / 知识库的「条件提示」，分别提示）
- **两个条件上下文，各管一个库**：`avantf:memory-hint`（order 130）与 `avantf:knowledge-hint`（131）。
  当用户刚发的消息与**对应**库里的内容相关时才渲染一句
  （`[avantf-mem 插件] 记忆里有与本次提问相关的事实；需要时用 mem_recall 检索。` / 同构的知识库版），
  否则渲染**空串** —— 空文本会被 `renderPrompt`/`renderContextSections` 丢掉，所以"没有相关内容"
  **零 token**。分两条而不是合成一句：两个库回答不同问题、任一方可能是相关的那一方。作者前缀是必需的：
  harness 把运行时上下文物化成**用户角色快照**，不署名会被读成用户自己说的话。
- **判定收敛到一个内部接口**：`AvantfRuntime.relevance(text): RelevanceHit`（`none|memory|knowledge|both`，
  非工具、不面向模型），门槛只存在一处；两个 store 各暴露同步的 `lexicalProbe(text)`。
- **判定是词面的，并且是实测定的**：词 = 拉丁/数字词（≥5 字）+ CJK 三元组，**命中 ≥2 个不同词**才算有
  （单词查询故意不触发）。为什么不是语义：渲染这个提示的 provider 是**同步**的（装配时求值、抛错会掀翻那一步），
  而语义腿要 `encode()`（热模型 ~10–20ms），会输给 `preStep → assemble()` 的时序、晚一步才出现 ——
  即模型已经决定要不要调工具之后。**分离度实测**（真实库、10 条探针）：3 条真命中得 6/6/2 个词，
  7 条无关得 0 或 1；其中英文问句在拉丁词下限 4 字时命中 3 个常见词（`unit`/`test`/`this`），
  收到 5 字下限后只剩 1 个 —— **下限与"≥2"两条都在承重**。保守的代价写在明处：改写式提问会漏
  （实测"我记得之前定过一个关于数据目录的约定"对 34 条记忆命中 0），由常驻的用法提示兜底。
- 状态按 **agent 对象**做键（`WeakMap`）：`dsh-agent` 的 `assembleContextFor` 传的 `scope` 就是 agent，
  而 `agent/inbox/inserted` 的载荷里也被注入了同一个对象，所以两个会话不会看到彼此的提示；
  没有状态或 `none` 都渲染空串。
- 配套：`mount-smoke` 的 `systemPrompt` 桩补上 `context` 半边，并断言两个上下文都注册、且在无状态时渲染空串
  （"注册了但从不渲染"才是这个功能真正的坏法）；`prompt contexts` 一行会打印出来。

### Fixed（提示词只讲记忆、不讲知识库）
- **补上知识库的「什么时候该查」**：新增系统提示词段 `avantf:knowledge-usage`（order 3010，201 字），
  与 `avantf:memory-usage`（order 3000，238 字）同构。这条不是凭空加的，是**实测出来的缺口**：用户当天
  07:45 入库了《Cgroup v2 技术综述》，随后在另一个会话里问 cgroup v2 的内存保护，模型一次都没查 ——
  当时的提示词段只提名 `mem_remember` / `mem_recall`（`kb_query`、`kb_manage`、「知识库」在段内出现
  0 次），而 `kb_query` 的工具描述只说"调用做了什么"、还以「记忆事实」开头（容易被读成记忆工具），
  于是模型没有任何信号去查。事后再跑一次 `kb_query "cgroup v2 的内存保护 memory.min memory.low"`
  是 **score 1.0 的命中**（`memory.min` 硬保护 / `memory.low` 软保护 / 与 v1 的对比全在库内），
  所以这次漏查是真实代价，不是"库里没有"。
  新段落因此点名 `kb_query`、写明**「你看不到库里有什么」**（这句是让模型去"查"而不是凭已知去"判断"
  的关键）、要求**先检索一次再作答**、命中按 `source_ref` 引用原文，并把 `kb_manage` 限定在
  「用户明确要求时用」，避免把每个问题都变成管理调用。
- 配套：`mount-smoke` 的 `promptSections.length === 1` 断言改为 2（并断言新段落含 `kb_query` 与那句
  关键子句），`prompt_section.spec.ts` 扩到 4 条（含"必须点名 `kb_query`"与"不得出现保留词表"，
  两个段落一起扫），DESIGN §10/§12 与 `release/README.md` 里「只加一段用法提示」的说法同步更新。

- **`kb_query` 的描述改为以文档为主语**：原文以「跨"记忆事实 + 文档切片"的统一检索」开头，模型容易
  把它归档成记忆工具（而跨库检索的实际首选恰是文档切片）。现在以「在**用户已入库的文档切片**与记忆事实里
  做统一检索」开头，并补一句「回答资料性问题前先查一遍」——把"何时该用"也压进描述，与新增的提示词段互为兜底。

### Changed（全中文化）
- **界面与弹窗文案全中文**：「记忆」「知识」两个标签页的标题、字段标签、按钮、占位符、状态行、空态、二次确认框、
  失败提示与工具结果摘要全部改为中文，不再夹英文短语。字段标签用「中文（schema 名）」形式
  （`知识域（domain）*`、`来源（source）*`、`标题（title，可选）`、`分类（category）`…），
  便于与工具/CLI 的参数名对上；`aria-label`、按钮 title 一并中文。
- **注入给模型的文字全中文**：5 个工具（`mem_remember` / `mem_recall` / `mem_admin` / `kb_manage` / `kb_query`）
  的 `description` 与每个字段的 `.describe()` 均为中文（各 83–711 字，逐条核对过含汉字）；
  系统提示词段 `avantf:memory-usage`（order 3000，238 字）为中文。
- **参数校验错误里的话是中文**：契约层加 `z.config(z.locales.zhCN())`，于是非法参数回给模型的是
  「…必须是 string 类型」这类中文说明，不再是 zod 的英文默认文案（zod 单副本约束不受影响）。
- **系统报错前加一行中文注解**：`describeError()` 在 errno 原文前补中文解释（`ENOTDIR` → 「期望目录但拿到文件」），
  原文与 `code` 一并保留用于排查；OS 自己产生的英文消息（如 `not a directory`）原样透传，不做翻译。
- **引擎侧错误串中文化**：`core`（摄入/PDF 抽取/编码判定/路径边界/受管副本/文档 DAO/生命周期/运行时装配）
  与 `retrieval-core`（后端注册表、`local_bge`、`local_reranker`、`local_numpy`、`hnswlib`）里
  **会走到界面、工具信封或降级横幅的**报错都改为中文——`memory unavailable: <原因>` 这条链路上
  不会再出现英文原因。三个按文案断言的老测试（`registry.spec.ts`、`hnswlib.spec.ts`、`knowledge.spec.ts`）随文案更新。
- **按钮改名**：知识页 headbar 的「重建全部索引」→ **「重建索引」**（填了 domain 时仍为「重建索引（<domain>）」）。
- 明确**不在本次范围内**的英文：宿主的 `[avantf-mem] INFO/WARN` 启动日志、浏览器 console 行、
  CLI 的 `usage:` 提示——它们是终端诊断输出，不是弹窗文案，且 `model_bootstrap` 等测试按文案断言。

### Changed（「入库」表单）
- **按钮改名**：headbar 上「入库/导入」→ **「入库」**（展开时「收起入库」）。
- **来源与路径合并成一个框**：原来 `source_uri` 与「导入路径」两个字段、两个按钮（入库 / 导入）合并为**一个来源框 + 一个「入库」按钮**。
  入库时由**宿主**判定输入是什么（浏览器只能识别 `^https?://`，`existsSync`/realpath 只有宿主能做），据此前端显示一行提示、派发到既有动作：
  URL → `ingest source_uri`；**已存在的文件** → `ingest source_uri`（用 realpath 后的绝对路径）；**已存在的目录** → `import paths`；
  两条以上路径 → `import`；看不懂的路径形状（如 `~/nope.md`、边界外的路径）→ 明确提示**找不到**并给出边界原因；其余 → 按**粘贴文本**入库。
  **来源与粘贴文本改为二选一**（分段切换，一次只显示一个输入）：同标题下第二次 ingest 会**替换**第一篇，所以两者不能同时入库；
  切换按钮在隐藏的那一边有内容时标注「·有内容」，提示行明说「…里有内容，本次不会入库」，`canIngest` 只读当前可见的那一个
  —— 这样"两个都填"不再是一个可以进入的状态，也不会静默丢掉任何一边（切回去内容还在）。阻塞态提示（如路径找不到）改用警示色。
- **新增「选择」按钮与面板内选择器**：不依赖系统对话框（WSL/远端也能用），由宿主按**与摄入相同的边界**（`knowledge.ingest.local_roots`）逐个目录列举：
  目录点进去、文件点即选、`other` 条目灰显不可选、目录顶部显示"可浏览范围"与「选择此目录」；边界外的目录（如 `/etc`）列不出来。
- **选择器跟随同一条边界**（`browseDirectory` 走 `resolveLocalSource`），但 `allow_outside_workspace: true` 时**从家目录起步**而不是那个 cwd
  （默认的 cwd 在 GUI 场景下是 DSH profile 目录），并在标题里如实显示「不限制范围…」，不显示一条它并不遵守的边界。
  放宽方式与代价见 `docs/INSTALL.md` §7.1。
- 新增两个 **UI 专用**远端方法 `classifySource`（分类）与 `browseDir`（列举）—— 没有对应的 agent 工具；`LocalRoots` 白名单与目录遍历收拢到 core 的
  `store/source_picker.ts`（摄入与选择器共用同一份 `.md/.txt/.json/.yaml/.yml/.pdf` 名单）。

### Fixed（跨平台）
- **带空格的路径不再被判为"找不到"**：`classifySource` 原来先把输入按空白/逗号切分，于是选择器选中的
  `/…/My Docs/a.md` 会被切成三段、判成 `missing`（Linux 上就能复现，Windows 的 `C:\Users\me\My Documents\…`
  更常见）。现在**先整串当一个路径试**，失败再按分隔符解析多路径（多路径里含空格的那条仍是已知限制）。
- **Windows 上的编辑器探测**：原来只探裸命令名，而 Windows 的 shim 是 `code.cmd`/`.exe` → 永远探不到、
  静默退回系统默认程序。现在按 `PATHEXT`（默认 `.COM;.EXE;.BAT;.CMD`）探测。
- **Windows 保留设备名**：`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` 即使带扩展名也仍是设备名
  （`CON.md`），受管副本会写不出去；现在清洗为 `_CON` 这样的前缀形式。
- 跨平台能力与各原生依赖的取舍写进 `docs/INSTALL.md` §7.2（含"哪些是实测、哪些只是推理"）。

### Added
- **PDF 摄入（A+B+D 一起做）**：读到的是**字节**，先按魔数判定再决定怎么变成正文（新的
  `packages/core/src/store/document_text.ts`）：
  - `%PDF-` → 用 **`unpdf`** 抽取文本层（自带 pdfjs 构建，解包 2.1MB，无需外部 CMaps/字体资源）。
    抽完对**康熙部首/兼容区**（U+2E80–2EFF、U+2F00–2FDF、U+F900–FAFF）做定向 NFKC 归一化 ——
    实测有些中文 PDF 会把「网站」抽成「⽹站」，不归一化就搜不到；只归一化这三个区段，全角标点原样保留。
  - 已知二进制魔数（zip/Office、PNG/JPEG/GIF/BMP、RIFF、gzip/7z/RAR、OLE、ELF、wasm、SQLite、
    音频、字体、PostScript）或前 8KB 含 NUL → **拒绝**，错误里报出检测到的类型。
  - 其余按文本解码，顺序 **BOM → 严格 UTF-8 → 严格 GB18030**：UTF-8/UTF-16 由 BOM 认（BOM 必须先于
    NUL 嗅探，否则 UTF-16 文本会被误判为二进制），不是合法 UTF-8 的按 GB18030 解（GBK 超集，中文 .txt
    常见），**用了哪种编码随 `IngestResult.encoding` 回报**；两种解码都失败才报错。
    这条是被实测打回来的：原先"替换字符占比 >1% 且 >100 个才拒绝"对**短 GBK 文件永不触发**（一段十几字的
    GBK 中文只有 ~18 个坏字符），会被当 UTF-8 乱码静默入库 —— 而当时的单测恰好把 GBK 字节重复 20 次，
    正好越过了那个下限，等于把洞藏起来了。现在按"严格解码能否通过"判定，不需要任何阈值。
  - PDF 抽不到文本层（扫描件/图片型）→ **报错**，绝不入库空文档。
  - 实测（真实样本）：11 页中文 PDF 412ms 抽出 1302 汉字、0 替换符；7 页英文论文 52ms。
- **`import` 的跳过可见**：目录遍历只收 `.md/.txt/.json/.yaml/.yml/.pdf`（不跟随符号链接），其余文件进
  `skipped`（前 20 个路径）+ `skipped_total`；「知识」页的导入结果会显示「跳过 N 个非文本文件」。

### Changed
- **知识维护（受管文档副本）**：每篇文档在 `knowledge.docs.dir`（默认 `<data_home>/knowledge/docs`）
  落一份**可编辑的 `.md`**，路径 `<domain>/<source>/<title>.md`，frontmatter 记
  `doc_id / domain / source / title / source_uri / ingested_at / content_hash`，正文逐字节等于摄入文本。
  文档身份仍由 `(domain, source, title)` 决定，文件里记的 `doc_id` 用来判定归属 —— 于是改名/改标题
  不会变成第二篇文档，同名冲突也不会互相覆盖（别人的那份加 `~<doc_id>` 后缀）。
- **`kb_manage {action:'sync'}`**（CLI `avantf-mem kb sync [doc_id] [--dry-run]`）：比对受管文件的正文
  哈希，报出 `stale`（被改过）/ `missing`（文件不在）/ `orphans`（没有文档认领的文件）；不带 `dry_run`
  时把 stale 的文档**按文件正文重新摄入**（同一个 `doc_id`，切片整体替换、向量重编码）。**不做文件监视**
  —— 同步是显式动作，用户选择手动。
- **「知识」标签页的文件维护入口**：文档行加 **编辑**（在编辑器里打开受管文件）、**打开目录**、
  **重新摄入**（仅改过时出现）、**删除**（二次确认，写明将删除的绝对路径，并说明 `source_uri` 指向的
  原文件不会被改动）；被改过/文件缺失的文档带 `文件已修改 · 待重新摄入` / `受管文件缺失` 徽标；
  头部加 **同步文件（N）** 一次拉回全部改动，摘要行显示 `N 篇文档 · M 篇待重新摄入 · K 个无主文件`。
- **`openDoc` 远端方法**（UI 专用，没有对应的 agent 工具）：宿主按 `doc_id` 解析路径后交给编辑器 ——
  自动探测顺序 `knowledge.open.editor`（或 `$AVANTF_EDITOR`）→ `$VISUAL`/`$EDITOR` → `code` → `cursor`
  → 平台打开器（macOS `open`、Linux `xdg-open`、WSL 回退 `explorer.exe` + `wslpath`）。客户端不传路径。

### Changed
- `knowledge` 配置新增 `docs.dir`（留空 = `<data_home>/knowledge/docs`，`AVANTF_KNOWLEDGE_DOCS` 可覆盖）
  与 `open.editor`；`IngestResult` 新增 `file` / `file_error`（写副本失败不算摄入失败）。
- **`remove` 现在连同受管文件一起删**：先删文件，文件删不掉就中止（避免"行没了文件还在"的孤儿）；
  文件本就不存在不算错误。

### Changed
- **契约里 `import` 的措辞改准**：原文「仅 .md/.txt/.json/.yaml/.yml，其余按类型跳过」只对**目录**成立 ——
  显式给出的文件路径本来就不看扩展名。现在分开写，并把 PDF 支持与三条拒绝（二进制 / 扫描件 / 非 UTF-8）
  写进 `kb_manage` 的描述，避免 agent 因为一句不准的话而不去导入 `.csv`/`.pdf`。
- **「知识」标签页重做：打开即文档列表，「查询」按需展开**。原先常驻搜索框 + 过滤条、文档列表还要点
  「展开知识库管理」才出现；现在页面主体就是**文档列表**（进入标签页即加载），「查询」按钮展开一个
  查询面板（输入框自动聚焦，回车即检索，含 类型/domain/source 过滤与分组结果），按钮排布与「记忆」
  一致（sticky 头部：查询 / 入库·导入 / 重建索引 + 文档计数），「展开知识库管理」按钮随之删除。
- **两个标签页的左右不再顶格**：`.section` 用 `--dsh-chat-content-width`（会话内容列宽，`ui-chat` 的
  消息列也用它）+ `margin: 0 auto` 居中，标签页与对话正文同一条轴、同一个宽度。
- **文档列表固定展示整个知识库**：domain/source 只作用于**查询**（以及重建索引的范围），不再过滤列表
  —— 否则在查询面板里每敲一个字都会触发一次 `kb.list`。
- **「记忆」标签页：控件不再被长列表顶到看不见**。「查看未处理矛盾」「查看检索健康度」原本在事实列表
  **下方**，条目一多就得滚到最后才点得到；现在与 活动/归档/立即维护 一起放进 **sticky 头部**
  （`position: sticky` 贴住会话滚动容器，配色沿用轨迹视图 sticky 工具栏的 `bg-base` + `border-l2`），
  展开的矛盾/健康度块也改到**列表之上**渲染 —— 点开即见，并把面板滚回顶部而不是让内容出现在视野上方；
  sticky 条用与页面同色的 `--dsw-alias-bg-base`（不引入色带）配 `--dsw-alias-border-l2` 分线。
- **「记忆」列表改为滚动自动加载**：滚到底自动拉下一页（**滚动监听**，不是 `IntersectionObserver` ——
  见下方"复核修正"）；「加载更多」按钮保留为兜底兼剩余条数提示，摘要行在有更多时提示
  「（继续滚动自动加载）」。这个标签页的滚动容器是**会话外层** `.scrollBody`（`.viewArea` 为
  `flex: 1 0 auto`、随内容长高），所以没有自造内滚动。
- **两个客户端面板从「设置」搬到主窗口标签条**：改为注册进 `conversation.view`（排在 对话(0) / 轨迹(10)
  之后，`order` 20 / 30），文案由「记忆维护」「知识查询」改为「**记忆**」「**知识**」；面板的内容与交互
  一行未动（同一个 `avantfMem` Remote、同一套 CRUD / 检索 / KB 管理）。
  **两个面板同时在 `settings.section` 保留一份**（标签同为「记忆」「知识」）：会话为空白时标题栏
  连同标签条被整体隐藏，设置是那时唯一可达的入口。
- **面板内与标签重复的 `h3` 标题删掉**（搬到标签条后，标签名就是标题）：`pages.module.css` 的 `.title`
  规则随之删除，`css-modules.d.ts` 的类名清单同步删除 —— 那份"类名必须与样式表逐一对齐"的测试
  （`css_module_types.spec.ts`）会挡住任何只删一边的遗漏。
- `packages/plugin/package.json`：`dsh.client.inject` 首项改为 `@deepseek-ai/dsh-client-ui-conversation`
  （`conversation.view` 的所有者），并保留 `@deepseek-ai/dsh-client-ui-settings`（`settings.section`
  的所有者）；包描述改为 "client tabs 记忆/知识"。

### Fixed（插件 UI 复核的 4 条阻断 + 9 项应修）
- **B1 · 所有「矛盾裁决」按钮 100% 失效（1.0.2 既存）**：`remote.ts` 的 `admin` wire schema 没声明
  `contradiction_id` / `resolution` / `loser_fact_id`，而 codec 在**出口**解析参数、zod 对象会**剥掉**未知键，
  于是出网的只剩 `{action}`，宿主契约校验必然失败。已补齐三个字段，并新增
  `test/remote_wire.spec.ts`：**从客户端源码里提取所有 `remote.<method>({…})` 的字段**，断言每个都在
  wire schema 里声明过（拿掉任一字段该测试即失败）。
- **B2 · 空白会话没有入口**：`conversation.view` 的 chrome 在空白会话被隐藏，两个面板一度不可达；
  现在同时在 `settings.section` 注册（见上）。
- **B3 · `admin.list` 缺 seq guard**：滚动自动加载会在没有用户动作的情况下发请求，与 活动/归档 切换
  竞态，把活动行拼进归档列表并覆盖其计数。已加 `listGuard`，`switchStatus` 也主动使在途页失效。
- **B4 · 知识页失败后无恢复路径**：`docs === null` 同时表示"未加载"和"失败"，而唯一的刷新按钮被删；
  失败态现在显式提示并提供「重试」。
- **M1 · `kb.list` 无分页**：契约加 `limit`/`offset`，DAO 加 `LIMIT/OFFSET`，客户端按 50 篇一页取并用
  与记忆相同的滚动自动加载（`limit` 缺省时行为不变，CLI/MCP 仍是全量）。
- **M2/M3/M8 · 滚动自动加载重写为滚动监听**：`rootMargin` 对祖先滚动容器**不生效**（规范上只放大
  intersection root 的矩形），所以"300px 预取"从未发生；observer 又只在阈值翻转时回调，一次失败就
  再也不重试。现在按滚动事件做**电平触发**（失败后下一次滚动即重试），滚动容器由 `scrollParentOf()`
  向上查找获得；面板挂载时回到自身顶部（座位只换 view 子节点、保留 `scrollTop`）。
- **M4 · 查询无守卫**：连按回车会让慢的旧回复覆盖新结果，且先返回者把共享 `loading` 清掉；已加
  `queryGuard` 与独立的 `queryLoading`。
- **M5 · 滚动会抹掉 mutation 的错误行**：`load` 只在 `offset === 0`（刷新）时清错误，追加不清。
- **M6 · 入库/导入表单不进视野**：展开时与 查询 一样调 `reveal()`。
- **M7 · 分页漂移导致重复 key 与漏行**：追加时按 id 去重，分页锚点改用"宿主已给出的行数"
  （`nextOffset`/`docsOffset`）而不是去重后的 `rows.length`。
- **M9 · 关闭区块不会作废在途回复**：收起矛盾/健康度时 `begin()` 一次，迟到的回复不会把它重新打开。
- **D1/D2 · `docs/DSH_INTEGRATION.md` 陈旧**：`dsh.client.inject` 代码块补上 `ui-conversation`；
  "两个 Cordis fiber"的描述改为 shipped 实际的单 fiber（`inject = ['slots','remote']` +
  `ctx.get('remote.avantfMem')`）。

### Added（记忆的时间语义：命中带创建/更新时间；修订继承创建时间）
- **`RecallHit` 新增 `created_at` / `updated_at`**，记忆与知识命中都填（记忆取 `facts` 行，文档切片取
  所属 `documents` 行）：`mem_recall`/`kb_query` 的命中行从此把"什么时候记下、什么时候改过"直接交给模型。
  `created_at` 是这条记忆第一次被断言的时间，`updated_at` 是这一行最后一次被改动的时间——**检索与每日
  结算不写 `updated_at`**（检索只动不外露的 `last_retrieved_at`），所以它从不表示"最近被查到"。契约、
  两个 store 的命中映射、设置页查询面板（原信息行补时间）与记忆详情弹窗（"创建于 X / 更新于 Y"）同步；
  列表行仍只显示 `created_at`。`mem_recall` 的工具描述刻意不加"返回带时间"的字样（描述只讲"是什么"）。
- **`update`（supersede）的新行继承被归档行的 `created_at`**：`insertRevision` 现在把
  `created_at`/`updated_at`/`last_retrieved_at` 显式写进 INSERT 列清单（不再依赖列 DEFAULT），调用方把
  被取代行的 `created_at` 传下去，找不到旧行（首次 `add`）才用当前时间。**`last_retrieved_at` 在同一条
  语句置为 `CURRENT_TIMESTAMP`**：继承老 `created_at` 的修订否则会在下一次 tick 被判 idle 归档
  （"用户重新断言了它"本身就是一次使用）。`updated_at` 取新时间，仍是"这一行被改动过"。
  **TTL 因此按"最初记录时间"计算——更新不延长寿命**（`ttl_days=7` 的记忆第 6 天被改写，第 7 天照常
  到期），管理列表排序仍是 `created_at DESC`。语义与两条判据的后果写进 `docs/TRUST_MODEL.md` §2.7 与
  `DESIGN.md` §7/§11。新增回归：supersede 的 `created_at` 继承与 `updated_at` 前移、更新过的老记忆
  不被立刻 idle 归档、TTL 按最初记录时间到期、命中行带两个时间且检索不写 `updated_at`。冻结的
  `eval_zh` 数字未动（加字段不改分数）。

### 初版（M0–M13）

### Added
- **M0** monorepo workspace + config layering (`~/.avantf`) + memory schema (better-sqlite3)
- **M1** HRR algebra (bind/bundle/phaseSimilarity) + SHA-256 deterministic atoms + entity/triple extraction (nodejieba)
- **M2** memory hybrid retrieval (semantic + FTS5 trigram + entity Jaccard) + 29-query parity harness
- **M3** local ONNX BGE (`@huggingface/transformers`, mirror-configurable, lazy) + bge-reranker + async model bootstrap on DSH startup
- **M4** pluggable vector-store surface + `local_numpy` + real `hnswlib` ANN backend
- **M5** lifecycle (trust decay / ttl / age archive / purge) + contradiction detection (polarity 0.95, same-subj/pred diff-obj 0.5, embedding fallback) + dedup
- **M6** internal pluggable retrieval registry (SemanticBackend/Reranker/VectorStore, third-party registration, degradation, auto)
- **M7** DSH native Cordis host plugin (`avantfMemory` service + 5 model tools + package-private RPC)
- **M8** client memory-maintenance page (`settings.section`, id=memory)
- **M9** knowledge store (domain→source→chunk) + cross-retrieval (joint fusion)
- **M10** client knowledge-query page (`settings.section`, id=knowledge)
- **M11** CLI (memory / kb / query / contrad / maintenance / vectors_*)
- **M12** MCP server (stdio, reuses tool contracts)
- **M13** parity regression + publish config + README + CI workflow + mount smoke

### Notes
- Plan A: retrieval local, answer generation external.
- Memory has no user isolation (single shared store); KB is `domain → source`.
- `ask` is direction-aware (triple-slot match) with a layered fallback to hybrid search.
