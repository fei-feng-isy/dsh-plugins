# avantf-work

DSH（DeepSeek Harness）的**工作树引擎**插件：`@avantf/dsh-work`。

一个工作节点先被尝试执行；发现缺少前提时**由执行者自己**拆解出子节点；子节点全部终态后父节点重新可执行，判断"目标已达成 → 提交给父节点"或"仍需拆解"；直到根节点收敛。

## 设计文档

主文档：[`docs/design/work-engine-plugin.md`](docs/design/work-engine-plugin.md)

实现笔记（已知限制、诊断、构建细节；面向用户的发布 README 是
[`packages/plugin/README.md`](packages/plugin/README.md)，npm 页面就是它）：
[`docs/plugin-internals.md`](docs/plugin-internals.md)

参考文档（上游 AvantF 设计的移植分析，主文档按需引用）：

- [`docs/reference/worktree-port.md`](docs/reference/worktree-port.md) —— 工作树移植的逐层判定
- [`docs/reference/prompt-layer-port.md`](docs/reference/prompt-layer-port.md) —— 四层 prompt 移植的逐层判定

## 包

| 包 | 内容 |
|---|---|
| [`@avantf/work-core`](packages/core) | 节点模型、状态机、派活循环、worker prompt 构造器。**零 DSH 依赖**，环境事实（活性、spill、时钟、id）全部注入，所以整套工作树行为可以脱离 harness 测试。**内部包，不单独发布**：plugin 的产物同时带上它的运行时（入口内联）与类型（`lib/work-core/`）|
| [`@avantf/dsh-work`](packages/plugin) | DSH 插件（两半）：宿主侧服务、9 个模型工具（分 owner / executor 两张面孔）、引导上下文、`agent/pre-step` 钩子、`/work`（列出或建根）、`/archive`、`/clean` 三条命令；客户端侧"工作"标签（会话视图条里排在"对话""轨迹"之后）|

## 四条设计原则

| 原则 | 含义 |
|---|---|
| **引擎是程序，不是 agent** | 扫树、派活、回收全部是宿主代码，不花 LLM 调用 |
| **工作单元无状态、用完即弃** | 每次执行是一次新的子 agent，从不等待、从不持有 |
| **拆解由执行者做，不在引擎里做** | "为什么需要这个前提"只有尝试过的人知道 |
| **状态在树里，不在任何会话里** | 节点是唯一的权威状态载体 |

由此得到两个"不需要"：**不需要帧栈 / converge / 回注水位**（没有跨轮持有的执行帧），**不需要 overlay 式上下文切换**（隔离由会话边界天然提供）。

## 关键参数

| 项 | 值 |
|---|---|
| 树深度上限 | 8（根为第 1 层） |
| 单次拆解子工作数 | 至多 6 |
| 单树节点上限 | 200（`decompose` 提交前校验；只数本次新增的节点，复用已有前置工作不计数） |
| 并发工作单元 | CPU 核心数 - 1（可配）；按**已绑定的节点**计数，一次扫描不会超发 |
| 失败预算 `failures` | 5（worker 被回收即失败一次；成功的提交与拆解，含汇总轮，都不消耗） |
| 启动失败预算 `spawnFailures` | 5（派发即失败才 +1，按 `30s × 2^(n-1)` 退避后重试，成功启动即清零） |
| 结果内联阈值 | 2000 字（超出走 `ctx.spillStore` 落盘，并保留后端给的取回指引）|

## 依赖的 DSH 既有能力

不自建，直接用：子 agent 生成（`ctx.subagents`，continuable + 预留 child id）、宿主 KV（`ctx.storageDomain`）、提示词注册表（运行时上下文）、`agent/pre-step`（唤醒与过滤）、`ctx.agents`（活性）、`ctx.sessionQuery`（owner 存亡判据）、`ctx.spillStore`（超长结果）、`ctx.interval`（兜底扫描）。

**不自己实现**：子 agent 的生成后端、会话持久化、压缩。

## 自定义系统提示词

告诉模型"什么时候该把活交出去"的那段静态系统提示词（`avantf:work-tree-guide`），**正文可以自己改**。它与家族其它插件（如记忆插件 `@avantf/dsh-mem`）的提示词**集中在一个目录**，用**文件名前缀**区分归属：

```
~/.avantf/prompts/               # 家族共享的提示词目录
├─ work-tree-guide.md    # 工作引擎的（`work-` 前缀，本插件只读写这个）
└─ mem-*.md              # 记忆插件的（由 @avantf/dsh-mem 维护）
```

本插件**只读写 `work-` 前缀且在自己的清单里的文件**：别人的文件、以及任何不在清单里的 `.md`，既不会被读、也不会被写或删。

- 插件启动时**自动创建**，内容就是内置默认；**空文件会被重新填回默认**（不是"禁用这一段"），删掉也会重建。
- **文件全文就是提示词**：不要写标题、注释或 frontmatter —— 它们会一字不差地进入每一轮 prompt。
- **只在插件初始化时读一次**：改完要**重启 `dsh`** 才生效。目录里其它 `.md` 不会被读取，也不会报错。
- 自己写的文本只做一次**软检查**（超过预算、出现"工作树/子树/节点/树"这类形状词）并记一条警告，**不截断、不拒绝** —— 这是实测过的退化形状（模型会把一件工作读成"装节点的容器"）。
- 文件读不了或写不了（只读文件系统、权限不足、路径被目录占住）只记一条警告并退回默认，**绝不影响插件挂载**。
- 数据目录 = 插件配置 `dataHome` → `$AVANTF_HOME` → `~/.avantf`（与记忆插件同一条优先级），提示词就在它的 `prompts/` 下。

## 开发

编译对齐**已安装的 dsh**（`npm i -g @deepseek-ai/dsh` 那套包），不需要 harness 源码 checkout：

```bash
pnpm install
pnpm build:dsh      # 链接已安装 dsh → 构建两半 → 真实 Cordis 挂载冒烟
pnpm release:check  # 上面这些 + 类型检查 + 单测 + 两个冒烟 + 打包
```

`scripts/link-dsh.mjs` 默认把 peer 链接指向已安装的 dsh（`--runtime [dshDir]` 可指定安装位置）；`zod` 在 `pnpm-workspace.yaml` 的 catalog 里跟随该 dsh 的版本，否则 `@deepseek-ai/dsh-storage-domain` 的记录 schema 会变成另一套不兼容类型。编译不再读 harness 源码 checkout。

插件挂载时的环境初始化交给家族底座 `@avantf/dsh-plugin-base`（peer 区间 `^0.1.0`；本仓另在 `devDependencies` 里声明同一个范围，由 `linkWorkspacePackages: true` 链到本地 `base/`）：插件内联一份零依赖 `bootstrap`，它按 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` 从**插件自己的依赖树**解析底座，再动态 `import()` 并校验版本落在内联的 `supportedRange` 内。底座**一个包**里装着启动期环境初始化框架与宿主兼容门禁（从前独立的 `@avantf/dsh-envinit` / `@avantf/dsh-compat` 已并入它，且不再发新版本），因此这里**没有 `work:compat` item、没有下载、也没有受管 `~/.avantf/env/compat/**`**：门禁就是底座本身。`scripts/link-envinit.mjs` 从**安装副本** vendor 出要内联的 bootstrap（`pnpm build:dsh` / `pnpm typecheck` / `pnpm link:profile` 会自动跑）；`--check` 为"缺安装"给 `pnpm install`、为"副本漂移"给重跑脚本，两种建议各自可执行。要就地联调底座，用 `DSH_ENVINIT=<checkout>` 显式 opt-in（此时脚本把该 checkout 链进插件并据此 vendor）；兄弟 checkout **永不隐式发现**。**作为可安装包部署时**，底座由 npm 这类会自动安装 peer 的包管理器跟着装上（多个插件共用顶层那一份）；pnpm 关掉 `autoInstallPeers` 或 yarn 不会自动装，那时把 `"@avantf/dsh-plugin-base": "^0.1.0"` 与 `"@avantf/dsh-work": "0.1.0"` 一起写进宿主/profile 的 `dependencies` 即可。它保持 **required peer**，缺了只是降级挂载（一条 `envinit: WARNING` + 退回 legacy 机制，绝不拒载）；宿主自己提供的 peer 才是 `optional`，免得包管理器去 registry 拉一份宿主内部实现。共享业务逻辑在**运行时**从底座那份取用（兼容门禁规则/探针/复查、envinit provisioner、prompt 文件层 `PromptFiles`，以及本插件的 `resolveDataHome`），所以修这些共享代码只需一次底座发布、不必重建插件——仍留在插件里的是 `typert` `strict` wire codec 与端点/字段/结果符号字面量（照抄宿主约定的两三行，描述符在模块加载期就要组装）以及本插件自己的 logger 与底座缺席时的 fallback 默认参数，改它们**需要发插件**；底座 kit 另外导出 `createPluginLogger`、`familyHome` 等，插件可在运行时取用。**改 `base/**` 里的共享代码后，两个插件的完整门禁都要重跑**：work 侧 `pnpm release:check` + mount-smoke，mem 侧 `pnpm build:dsh` + `node scripts/mount-smoke.mjs`。判据："这条知识能不能靠**一次底座发布**修好"——能就从底座运行时取，不能（两三行字面量）可留在插件但须注明改它要发插件。详见 `packages/plugin/README.md` 的「环境初始化」一节。

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
| `@avantf/work-core` 单测（`pnpm test`，数量以门禁为准） | 状态机、终态工具双向互斥、配额、聚合就绪、拆解去重、启动对账、纠偏与子工作取消、拆解分析门禁（`analysis-missing` / `no-analysis`）、prompt 措辞与「执行本工作时写下的分析」一节的渲染次序 |
| `@avantf/dsh-work` 挂载级测试（`pnpm release:check`，数量以门禁为准） | 真实 Cordis Context + 真实事件链；覆盖"递归拆分：root → 子工作 → 孙工作 → 逐层聚合 → 根收敛"整条链路、两张工具面孔（含 `note_work` 对 owner 不可见 / 对 worker 可见）、`note_work` → `decompose_work` 的完整门禁序列与真实聚合 prompt 片段、结构化参数容错（数组 / JSON 文本 / 一行一条）、旧文档缺 `analysisNotes` 仍能 parse 且 `DOMAIN_VERSION` 仍为 1、`typert.register` 抛错时照常挂载、纠偏、复用边的可见性、`/archive` 与 `/clean` 的护栏、环境初始化（envinit）的门禁/拒绝/复查形状、直接挂载 `apply` 的两条环境出口（拒绝挂载、准备期间被卸载）、真实 `@avantf/dsh-plugin-base` 的版本漂移告警，以及工作页无树时的空态 |
| 宿主挂载冒烟 | 对**已安装 dsh** 跑（`pnpm build:dsh` 的一部分）：门禁由底座 `@avantf/dsh-plugin-base` 本身提供（没有 `work:compat` item、不下载、没有受管 compat 根）；冒烟会断言门禁走的是哪一侧，走 ABSENT 路径时明说 `ABSENT, as documented`，不是静默。**底座没装进插件会红**（bootstrap 只警告并降级挂载，降级态不许当成绿），所以先 `pnpm install` |
| 客户端 bundle 冒烟 | 沙箱执行 `lib/client.js`，断言自注册、插件形状、"工作"标签座位与 order、不注入 dotted remote key |

**尚未在真实 dsh 会话里由模型驱动跑过完整工作**，见设计文档 §十二 的验收清单。

