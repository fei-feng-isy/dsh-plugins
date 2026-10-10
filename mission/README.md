# avantf-mission

DSH（DeepSeek Harness）的**任务树引擎**插件：`@avantf/dsh-mission`。

一个任务节点先被尝试执行；发现缺少前提时**由执行者自己**拆解出子节点；子节点全部终态后父节点重新可执行，判断"目标已达成 → 提交给父节点"或"仍需拆解"；直到根节点收敛。

## 设计文档

主文档：[`docs/design/mission-engine-plugin.md`](docs/design/mission-engine-plugin.md)

实现笔记（已知限制、诊断、构建细节；面向用户的发布 README 是
[`packages/plugin/README.md`](packages/plugin/README.md)，npm 页面就是它）：
[`docs/plugin-internals.md`](docs/plugin-internals.md)

参考文档（上游 AvantF 设计的移植分析，主文档按需引用）：

- [`docs/reference/mission-tree-port.md`](docs/reference/mission-tree-port.md) —— 任务树移植的逐层判定
- [`docs/reference/prompt-layer-port.md`](docs/reference/prompt-layer-port.md) —— 四层 prompt 移植的逐层判定

## 包

| 包 | 内容 |
|---|---|
| [`@avantf/mission-core`](packages/core) | 节点模型、状态机、派活循环、worker prompt 构造器。**零 DSH 依赖**，环境事实（活性、spill、时钟、id）全部注入，所以整套任务树行为可以脱离 harness 测试。**内部包，不单独发布**：plugin 的产物同时带上它的运行时（入口内联）与类型（`lib/mission-core/`）|
| [`@avantf/dsh-mission`](packages/plugin) | DSH 插件（两半）：宿主侧服务、9 个模型工具（分 owner / executor 两张面孔）、引导上下文、`agent/pre-step` 钩子、`/mission`（列出或建根）、`/archive`、`/clean`（archive / missions / orphans 三个作用域）三条命令；客户端侧"任务"标签（会话视图条里排在"对话""轨迹"之后）|

## 四条设计原则

| 原则 | 含义 |
|---|---|
| **引擎是程序，不是 agent** | 扫树、派活、回收全部是宿主代码，不花 LLM 调用 |
| **任务单元无状态、用完即弃** | 每次执行是一次新的子 agent，从不等待、从不持有 |
| **拆解由执行者做，不在引擎里做** | "为什么需要这个前提"只有尝试过的人知道 |
| **状态在树里，不在任何会话里** | 节点是唯一的权威状态载体 |

由此得到两个"不需要"：**不需要帧栈 / converge / 回注水位**（没有跨轮持有的执行帧），**不需要 overlay 式上下文切换**（隔离由会话边界天然提供）。

## 关键参数

| 项 | 值 |
|---|---|
| 树深度上限 | 8（根为第 1 层） |
| 单次拆解子任务数 | 至多 6 |
| 单树节点上限 | 200（`decompose` 提交前校验；只数本次新增的节点，复用已有前置任务不计数） |
| 并发任务单元 | CPU 核心数 - 1（可配）；按**已绑定的节点**计数，一次扫描不会超发 |
| 失败预算 `failures` | 5（worker 被回收即失败一次；成功的提交与拆解，含汇总轮，都不消耗） |
| 启动失败预算 `spawnFailures` | 5（派发即失败才 +1，按 `30s × 2^(n-1)` 退避后重试，成功启动即清零） |
| 结果内联阈值 | 2000 字（超出走 `ctx.spillStore` 落盘，并保留后端给的取回指引）|

## 调度语义（v1）

- **容量是派发闸门，不是受理闸门**：`create_mission` / `decompose_mission` **永不因容量失败**，节点进 `ready`
  即排队；候选不满足 `Σ running.weight + candidate.weight ≤ capacity` 就**跳过**（不扣
  `attempts`/`failures`、无冷却、不记 `stalls`，与 unit 租约同纪律）。
- **`capacity` 的推导链** = 配置 → `os.availableParallelism()` → `os.cpus().length` → 4，在**宿主边界**算完注入
  core；**显式配置 as-is 使用**（仅 clamp，不预留），只有探测链派生值才 `max(1, 派生 − 1)`（预留 1 核）。
- **`weight`**（默认 **1**）= "这台机器上大约占几核"，子任务**不继承**父估值。
- **排队 = work-conserving + 老化预留**：等太久就停止接纳新节点、让在跑的排空；`weight > capacity` 者独占整
  机；顺序按**入队时间**而非 weight；等容量的节点在投影里显示 `waitingFor`。
- **平台探针（`ResourceProbe`）**：**`null` = 本平台无此信号，绝不等于"空闲"**，只能让调度更保守；压力信号与
  子进程归属的适配器留给 v2。

完整推导、阈值理由与逐条守卫见 [`docs/design/2026-10-02-capacity.md`](docs/design/2026-10-02-capacity.md) 与
[`docs/design/mission-engine-plugin.md`](docs/design/mission-engine-plugin.md) §9.2.1。

## 枢纽文件（hub）

超过 800 行的枢纽是 `packages/plugin/src/host.ts` · `packages/core/src/tree.ts` ·
`packages/plugin/src/client/MissionTreeView.tsx` · `packages/plugin/src/index.ts`；跨树通用的"触及即抽 / 不为变小做
整体重构 / 名单只作观察"见根 `AGENTS.md`。

## worker 会话的自动保留

每个任务单元都是一次**真实会话**，日志会持续堆在 `$DSH_HOME/sessions` 下。插件按**数量**保留：每个
属主会话最多留**最新 10 个已完成**的 worker（配置项 `keepWorkers`，默认 **10**；按会话头的 `createdAt`
降序，越新越保留），超出的、更旧的已完成记录在**挂载时**与**每轮后台 sweep** 时，按与 `/clean archive all`
相同的链路（**标记归档 → 释放记录 → 取消归档 → 清投影缓存残留**）自动释放。

- **清理是四步生命周期**：标记归档 → 释放会话记录 → **取消归档** → **清投影缓存残留**。第三步去掉 durable
  的幽灵归档 id，第四步清宿主替已 dispose 会话保留、**且无驱逐 API** 的投影缓存——少任一步都会在"子代理"列表
  里留下幽灵条目（实测曾显示 70 个）。
- **正在执行的 worker 不占名额、永不被清理**：13 个已完成 + 4 个在执行 → 只释放最旧的 3 个已完成；
  3 个已完成 + 8 个在执行 → 一个都不释放（已完成 3 ≤ 10）。
- **`keepWorkers: 0` 关闭自动保留**（保留全部），**不是**"一个都不留"；负数与 0 同义（配置 schema 只接受
  非负整数，代码再把 `<= 0` 当作关闭）。
- 与**手动全清**的区别：`/clean archive all` 是用户显式动作，一次释放本会话**所有**已完成的 worker 会话
  记录，**不受保留数限制**；自动保留只是在后台按数量维持上限。
- `/clean` 清单把两组分开报：「已完成 worker：X 个（保留最新 10 → 可自动清理 Y 个）」与
  「正在执行：Z 个（不计入保留名额、不会被清理）」——这样"数字为什么停在 10"是可见的。
- 所有自动释放动作都是 **best-effort**：失败只记 WARN，绝不影响挂载与命令结果；live worker 不做任何
  中断。

## 任务时间戳（你会看到什么）

每个任务节点记**受理 / 第一次派发 / 结束**三个时刻，派生**排队时长 / 执行时长 / 总时长**。
`list_missions`、`mission_result`、`/mission`、任务面板、以及任务结束时给属主的运行时通知都显示同一句
人类可读的时间（本地时区 `MM-DD HH:MM` + 相对时长），例如
`派发 10-03 17:21（排队 45s） → 结束 10-03 17:23（耗时 2m10s）`；还没派发的显示 `等待中（受理 …）`。
旧记录缺字段显示 `—`。字段语义、打点位置与兼容性见设计文档 §2.1.1，
用户视角的完整说明见发布 README（[`packages/plugin/README.md`](packages/plugin/README.md)）的
「你会看到什么：时间」。

## 依赖的 DSH 既有能力

不自建，直接用：子 agent 生成（`ctx.subagents`，continuable + 预留 child id）、宿主 KV（`ctx.storageDomain`）、提示词注册表（运行时上下文）、`agent/pre-step`（唤醒与过滤）、`ctx.agents`（活性）、`ctx.sessionQuery`（owner 存亡判据）、`ctx.spillStore`（超长结果）、`ctx.interval`（兜底扫描）。

**不自己实现**：子 agent 的生成后端、会话持久化、压缩。

## 自定义系统提示词

告诉模型"什么时候该把活交出去"的那段静态系统提示词（`avantf:mission-tree-guide`），**正文可以自己改**。它与家族其它插件（如记忆插件 `@avantf/dsh-mem`）的提示词**集中在一个目录**，用**文件名前缀**区分归属：

```
~/.avantf/prompts/               # 家族共享的提示词目录
├─ mission-tree-guide.md    # 任务引擎的（`mission-` 前缀，本插件只读写这个）
└─ mem-*.md              # 记忆插件的（由 @avantf/dsh-mem 维护）
```

本插件**只读写 `mission-` 前缀且在自己的清单里的文件**：别人的文件、以及任何不在清单里的 `.md`，既不会被读、也不会被写或删。

- 插件启动时**自动创建**，内容就是内置默认；**空文件会被重新填回默认**（不是"禁用这一段"），删掉也会重建。
- **文件全文就是提示词**：不要写标题、注释或 frontmatter —— 它们会一字不差地进入每一轮 prompt。
- **只在插件初始化时读一次**：改完要**重启 `dsh`** 才生效。目录里其它 `.md` 不会被读取，也不会报错。
- 自己写的文本只做一次**软检查**（超过预算、出现"任务树/子树/节点/树"这类形状词）并记一条警告，**不截断、不拒绝** —— 这是实测过的退化形状（模型会把一件任务读成"装节点的容器"）。
- 文件读不了或写不了（只读文件系统、权限不足、路径被目录占住）只记一条警告并退回默认，**绝不影响插件挂载**。
- 数据目录按家族分层：**⑤ 显式实参 → ④ `$AVANTF_HOME` → ② 本插件的 `dataHome` 配置 → `~/.avantf`**（与记忆插件同一条分层规则），提示词就在它的 `prompts/` 下 —— 也就是说设了 `$AVANTF_HOME` 时，本插件的 `dataHome` 配置不会把它压掉。

## 开发

编译对齐**已安装的 dsh**（`npm i -g @deepseek-ai/dsh` 那套包），不需要 harness 源码 checkout：

```bash
pnpm install
pnpm build:dsh      # 链接已安装 dsh → 构建两半 → 真实 Cordis 挂载冒烟
pnpm release:check  # 上面这些 + 类型检查 + 单测 + 两个冒烟 + 打包
```

`scripts/link-dsh.mjs` 默认把 peer 链接指向已安装的 dsh（`--runtime [dshDir]` 可指定安装位置）；`zod` 在 `pnpm-workspace.yaml` 的 catalog 里跟随该 dsh 的版本，否则 `@deepseek-ai/dsh-storage-domain` 的记录 schema 会变成另一套不兼容类型。编译不再读 harness 源码 checkout。

插件挂载时的环境初始化交给家族底座 `@avantf/dsh-plugin-base`（普通运行期依赖，区间 `>=0.3.0 <1.0.0`，**装插件即自动带上**；本仓另在 `devDependencies` 里声明逐字相同的范围，由 `linkWorkspacePackages: true` 链到本地 `base/`）：插件内联一份零依赖 `bootstrap`，它按 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` 从**插件自己的依赖树**解析底座，再动态 `import()` 并校验版本落在内联的 `supportedRange` 内。底座**一个包**里装着启动期环境初始化框架与宿主兼容门禁（从前独立的 `@avantf/dsh-envinit` / `@avantf/dsh-compat` 已并入它，且不再发新版本），因此这里**没有 `mission:compat` item、没有下载、也没有受管 `~/.avantf/env/compat/**`**：门禁就是底座本身。`scripts/link-envinit.mjs` 从**安装副本** vendor 出要内联的 bootstrap（`pnpm build:dsh` / `pnpm typecheck` / `pnpm link:profile` 会自动跑）；`--check` 为"缺安装"给 `pnpm install`、为"副本漂移"给重跑脚本，两种建议各自可执行。要就地联调底座，用 `DSH_ENVINIT=<checkout>` 显式 opt-in（此时脚本把该 checkout 链进插件并据此 vendor）；兄弟 checkout **永不隐式发现**。**作为可安装包部署时**，底座随插件自动装上（多个插件共用同一份，前提是两棵树的区间逐字相同）。它是一条普通依赖，缺了只是降级挂载（一条 `envinit: WARNING` + 退回 legacy 机制，绝不拒载）；宿主的 `@deepseek-ai/*` 运行时 peer 是 `optional`，免得包管理器去 registry 拉一份宿主内部实现；**唯一例外是 `zod`** —— 它与 mem 一样声明为 **required peer**（`>=4.4.3 <5`，见 `packages/plugin/package.json`），让宿主那份成为唯一一份：存储域的记录 schema 由它校验，第二份副本的对象身份不同、会拒绝本插件写入的记录。共享业务逻辑在**运行时**从底座那份取用（兼容门禁规则/探针/复查、envinit provisioner、prompt 文件层 `PromptFiles`，以及本插件的 `resolveDataHome`），所以修这些共享代码只需一次底座发布、不必重建插件——仍留在插件里的是 `typert` `strict` wire codec 与端点/字段/结果符号字面量（照抄宿主约定的两三行，描述符在模块加载期就要组装）以及本插件自己的 logger 与底座缺席时的 fallback 默认参数，改它们**需要发插件**；底座 kit 另外导出 `familyHome`、`familyToolsDir`、`familyModelsDir`、`expandHome` 等，插件可在运行时取用；`createPluginLogger` 已随接口 v3 移出 `.`、进了不承诺兼容的 `./internal`，两棵树因此各自持有自己的 logger。**改 `base/**` 里的共享代码后，两个插件的完整门禁都要重跑**：mission 侧 `pnpm release:check` + mount-smoke，mem 侧 `pnpm build:dsh` + `node scripts/mount-smoke.mjs`。判据："这条知识能不能靠**一次底座发布**修好"——能就从底座运行时取，不能（两三行字面量）可留在插件但须注明改它要发插件。详见 `packages/plugin/README.md` 的「环境初始化」一节。

浏览器半边由 `scripts/build-client.mjs`（esbuild）打成 `lib/client.js`，由 `scripts/client-smoke.mjs` 在无浏览器环境验证。**不使用 harness 的 tsdown 客户端预设** —— 它要求目标包在 harness 工作区内可被 glob 到，第三方仓用它会需要往 DSH 源码树里放 stub。客户端半边对 Context 用结构化接口（已安装的 dsh 不带 `dsh-client-ui-slots` 包），因此 `tsc` 只依赖已安装的 dsh。

单独手动对齐已安装 dsh 验证（用户实际加载的那套包）：

```bash
node scripts/link-dsh.mjs
node scripts/build.mjs
node scripts/mount-smoke.mjs --runtime
```

## 状态

宿主与客户端两半都已实现，并通过本地验证：

| 验证 | 内容 |
|---|---|
| `@avantf/mission-core` 单测（`pnpm test`，数量以门禁为准） | 状态机、终态工具双向互斥、配额、聚合就绪、拆解去重、启动对账、纠偏与子任务取消、拆解分析门禁（`analysis-missing` / `no-analysis`）、prompt 措辞与「执行本任务时写下的分析」一节的渲染次序 |
| `@avantf/dsh-mission` 挂载级测试（`pnpm release:check`，数量以门禁为准） | 真实 Cordis Context + 真实事件链；覆盖"递归拆分：root → 子任务 → 孙任务 → 逐层聚合 → 根收敛"整条链路、两张工具面孔（含 `note_mission` 对 owner 不可见 / 对 worker 可见）、`note_mission` → `decompose_mission` 的完整门禁序列与真实聚合 prompt 片段、结构化参数容错（数组 / JSON 文本 / 一行一条）、旧文档缺 `analysisNotes` 仍能 parse 且 `DOMAIN_VERSION` 仍为 1、`typert.register` 抛错时照常挂载、纠偏、复用边的可见性、`/archive` 与 `/clean`（archive / missions / orphans 三个作用域）的护栏、环境初始化（envinit）的门禁/拒绝/复查形状、直接挂载 `apply` 的两条环境出口（拒绝挂载、准备期间被卸载）、真实 `@avantf/dsh-plugin-base` 的版本漂移告警，以及任务页无树时的空态 |
| 宿主挂载冒烟 | 对**已安装 dsh** 跑（`pnpm build:dsh` 的一部分）：门禁由底座 `@avantf/dsh-plugin-base` 本身提供（没有 `mission:compat` item、不下载、没有受管 compat 根）；冒烟会断言门禁走的是哪一侧，走 ABSENT 路径时明说 `ABSENT, as documented`，不是静默。**底座没装进插件会红**（bootstrap 只警告并降级挂载，降级态不许当成绿），所以先 `pnpm install` |
| 客户端 bundle 冒烟 | 沙箱执行 `lib/client.js`，断言自注册、插件形状、"任务"标签座位与 order、不注入 dotted remote key |

**尚未在真实 dsh 会话里由模型驱动跑过完整任务**，见设计文档 §十二 的验收清单。

