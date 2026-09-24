# @avantf/dsh-work：实现笔记（开发文档）

> 这是**开发文档**：实现要点、已知限制、诊断与构建细节。
> **面向用户的发布 README 是 `packages/plugin/README.md`**（npm 页面就是它），
> 设计文档在 `docs/design/work-engine-plugin.md`。三份文件的读者不同，不要互相搬运。

DSH（DeepSeek Harness）原生 Cordis 插件：**工作树引擎**。

一个工作节点先被尝试执行；发现缺少前提时**由执行者自己**拆解出子节点；子节点全部终态后父节点重新可执行，判断"目标已达成 → 提交给父节点"或"仍需拆解"；直到根节点收敛。

## 它给一个会话加了什么

| 贡献 | 作用 |
|---|---|
| 宿主服务 `avantfWork` | 拥有工作树、存储域与派活循环；Remote 面给"工作"标签读树（`snapshot`）、读单个工作详情（`detail`）、**按需读回落盘的完整结果**（`result`）、删工作（`delete`），并把每次变更推给已打开的标签（`watch`，stream 调用）|
| 9 个模型工具，分两张面孔 | `create_work` / `adjust_work` / `note_work` / `decompose_work` / `submit_work` / `work_result` / `list_works` / `finish_work` / `cancel_work`。**owner 面孔**（顶层会话）见 6 个：`create_work`/`adjust_work`/`work_result`/`list_works`/`finish_work`/`cancel_work`；**executor 面孔**（工作单元）见 3 个：`note_work`/`decompose_work`/`submit_work`。`note_work` 只给执行者：它写下本轮自己的分析，而 `decompose_work` 会拒绝一个没写过分析的拆解。回收是引擎自己的事，不给模型一个手动回收的工具 —— 见下。**owner 看不到工作内部**：`list_works` 只说一个工作还在跑、或者反复出过问题（`troubled`，是历史而非现值），不报它被拆成了什么、各部分什么状态 —— owner 只对整棵树有动作（`adjust_work` / `cancel_work`），内部结构是引擎的事 |
| 一段静态系统提示词段 | 告诉模型**什么时候**该把活交出去（判据是"能不能连验收标准一起交出去"，不是复不复杂；需要拆与不需要拆的都算）、以及"谁在等、别轮询、别替它做"。参数怎么填、工作能不能包含某类内容都**不在这段里**（前者属于工具的说明，后者由 owner 自己判断）。与 `create_work` 的授权判据同一个判据，worker 视角返回空串。**正文可编辑**：家族共享目录 `<data home>/prompts/work-tree-guide.md`（缺失或空白写回默认，启动时读一次；见根 README「自定义系统提示词」） |
| 一段引导上下文 | 每轮把树的状态写进 owner 的 prompt |
| 一个 `agent/pre-step` 钩子 | 过滤 worker 结算通知、决定某一步带什么进模型；引擎的唤醒信号在没有可处理状态时被**清空**（不是 reject，reject 会截断这一轮并把队列搁置）|
| `/archive` 命令 | 把本会话**已完成**的 work 会话记录标记为归档（走 workspace registry 的官方接口，durable、可 unarchive）。只标记，**不释放磁盘** |
| `/clean` 命令 | 释放磁盘：`/clean` 无参数=列出可清理的（干跑）、`/clean all` 清理所有**已归档**的、`/clean <work-xxxxxxxx>` 只清一个 |
| `/work` 命令 | 无参数：列出本会话拥有的工作树；**带文本：用它建一个根工作**（等价于 agent 调 `create_work`）|
| **"工作"标签**（客户端半边）| 会话视图条里排在"对话""轨迹"之后的第三个标签，用树形展示本会话的工作树；**引擎一变就推给标签**（`watch` 流），点工作标题按需读该工作详情并在**弹窗**里按标签展示（左侧"内容/上下文/拆解信息/纠偏/结果/子工作"，右侧一次一个分区、单独滚动；空的分区不出现，每个分区前有一行说明它装什么；工作标题是弹窗的标题栏，连同节点 id/状态/派发次数/深度）；**每棵**工作树的标题栏带"删除"按钮（二次确认；树还在跑时按钮可见但禁用并说明原因）；**在跑的节点默认展开、已完成的默认折叠**（点击可覆盖，且覆盖之后不再被状态改回）|

## 安装到一个 DSH profile

```bash
# 开发：装成 link: 软链 —— profile 的 node_modules/@avantf/dsh-work 直接指向本仓库，
#       重新编译就是最新版本，没有"打包 → 复制 → 忘了复制"这一步
pnpm link:profile            # 切 runtime peer 软链 → 装/刷新 link: 依赖 → 校验（--check 只校验）
# 等价的手工第一步：
dsh plugin --profile web add link:/home/qunqi/opensource/avantf-work/packages/plugin

# 发布：从 registry 装。底座 `@avantf/dsh-plugin-base` 是插件的 peer，
#       pnpm 关掉了 autoInstallPeers 不会自动装，所以要显式一起装（npm 会自动带上它）
dsh plugin --profile web add @avantf/dsh-plugin-base
dsh plugin --profile web add @avantf/dsh-work

# 两种都要在 profile 的 cordis.patch.yml 里挂载这一行
- insert:
    - id: avantf-work
      name: '@avantf/dsh-work'
```

**判据是 `profile/node_modules/@avantf/dsh-work` 本身是 symlink。** pnpm 的 `nodeLinker: hoisted`（本机 profile 的配置）对 `link:` 规格照旧建软链 —— 已实测。若 profile 的 manifest 写着 `link:`、`node_modules` 里却是解包出来的副本（本机 16:54 之前就是这个状态），表现就是"改了代码、重启还是旧行为"；在 profile 目录里重跑一次 install（`pnpm install`）即可落到软链上，`pnpm link:profile --check` 会直接把这种状态报成 FAIL。

**`link:` 安装有一条硬约束：运行期插件的 `@deepseek-ai/*` 必须解析到"宿主跑的那份 dsh"**，因为软链安装下插件是从本仓库的 realpath 解析 peer 的。所以仓库里的 peer 软链只指向**已安装的 dsh**（`scripts/link-dsh.mjs`，`--runtime [dshDir]` 可指定安装位置）：

| 指向 | 谁需要 |
|---|---|
| **已安装的 dsh**（`~/.npm-global/.../dsh`） | 编译（`tsc` 看到的就是宿主运行的那份声明，不再需要 harness 源码 checkout）与运行期（与宿主共享同一份 cordis / schemastery / zod，宿主才不会拒绝我们写进存储域的记录） |

`pnpm build:dsh` / `pnpm typecheck` 都先链接已安装的 dsh 再编译，并把它留在那里。`zod` 不由这里链接：它由本工作区安装，版本在根 `pnpm-workspace.yaml` 的 catalog 里跟随该 dsh（`@deepseek-ai/dsh-storage-domain` 用自己的 zod 标注记录 schema，旧版本是另一套不兼容类型）。手工链接用 `node scripts/link-dsh.mjs`，校验用 `pnpm link:profile --check`。

插件有**两半**：

- **宿主行**：注册服务、工具、提示词与钩子，在进程启动时 import 一次 —— **改它必须重启 `dsh`**。`patchReload: live` 换不了插件代码：`cordis-plugin-loader` 的 entry `update()` 在 diff 不含 `name`/`inject`/`group` 时只 `_patchContext`（连重挂都不做），进了 import 分支也命中 Node 的 ESM 缓存（这条路径没有 cache-busting query），而 `cordis-plugin-hmr` 在本机是 `root: []` 挂着的、模块级 HMR 等于关闭。本机实测：重写 `cordis.patch.yml` 触发"重载"后 80 秒，新建的树记录里仍没有新代码才会写的字段 —— 进程跑的仍是启动时那份模块。所以"更新插件后行为没变"通常不是修复无效，而是代码根本没换；判断前先确认进程是重启之后起的；
- **客户端半边**（`lib/client.js`）：注册"工作"标签，由 shell 的模块表加载 —— 改它只需重新构建并刷新页面。视图挂载时读一次快照，之后**跟着引擎的变更流刷新**（见下），`timer` 服务只在宿主没有 `watch` 时才作为 5 秒兜底（`timer` 是**可选**服务，本机浏览器侧根本没挂）。

客户端半边的两条硬约束（都来自真实踩坑）：

1. **不注入 `remote.avantfWork`，只注入 `remote`**。boot 审计对任何仍 pending 的注入项会抛错、整棵 web 树起不来，而自建命名空间只有在本插件自己 `$mount` 之后才存在。命名空间挂载后用 `ctx.get('remote.avantfWork')` 读取。
2. **客户端对 Context 用结构化接口**。`ctx.slots` 与 `conversation.view` 座位的真实类型来自 `ui-renderer` / `ui-conversation` 对 `ui-slots` 的 declare-merge，而已安装的 dsh 不带 `dsh-client-ui-slots` 包（shell 把它塞进浏览器模块表），只有 harness checkout 能解析。既然编译只依赖已安装的 dsh，`ctx.slots` / `ctx.locale` / `ctx.remote` 的形状就在本文件里本地声明（与 `@avantf/mem-dsh` 同法）。

`@deepseek-ai/*` 与 `zod` 全部按 **peer dependency** 对待：`@deepseek-ai/*` 由 `scripts/link-dsh.mjs` 链接到已安装的 dsh，`zod` 由本工作区安装但版本跟随该 dsh，从而与宿主共享同一份 cordis / schemastery / zod 身份。这一点是硬要求 —— 第二份 zod 会让存储域的校验器拒绝本插件写入的记录。

## 配置

```yaml
- id: avantf-work
  name: '@avantf/dsh-work'
  config:
    # 并发工作单元上限；省略 = CPU 核心数 - 1（给 owner 自己的回合留一个核）
    maxConcurrent: 6
    # worker 多久**没有任何进展**就视为卡死（毫秒，默认 30 分钟，下限 1 分钟）
    # 度量的是"沉默多久"，不是"跑了多久"：worker 每次往自己会话里追加事件都会刷新
    # 这个窗口，所以多步慢活不会被误判；单个工具调用本身可能长时间无事件，那种情况
    # 调大这个值即可。
    staleMs: 1800000
```

## `/archive` 与 `/clean`（worker 会话日志）

worker 是真实会话，所以每派活一次就多一个会话目录（本机实测每个约 40 KB）。两条命令分工明确：

- **`/archive`**：把本会话已完成的 work 会话标记为归档。走 `workspaceRegistry.archiveSession()` —— harness 的官方接口，durable，可用 unarchive 撤销。**它只改标记，不释放任何磁盘。**
- **`/clean`**：
  - `/clean`（无参数）→ 干跑：列出可清理的（已归档）与"已完成但未归档"的数量和体积；
  - `/clean all` → 删除所有**已归档**的 worker 会话目录，报告释放的字节；
  - `/clean <work-xxxxxxxx>` → 只删这一个（需在清单里、且不在运行）。

**为什么"删除"要自己动手**：harness 的会话持久化只有 `create`/`open`/`list`/`stat`，**没有 delete**，GUI 也只有归档。所以释放磁盘只能由本插件删目录，护栏写在 `src/workerSessions.ts`：

1. 只认本插件派出的 worker（claim id 形状 `work-<8 hex>` + 头里 `origin: subagent`、`delegationDepth: 1`、`parentSession` 是本会话）；
2. 绝不动仍在运行的会话（结算后的 worker 没有 agent、也没有打开的写入者）；
3. `/clean all` 只碰**已归档**的 —— 丢弃一定是有人明确做过的决定；单独指定 id 才跳过这道闸；
4. 目录必须**正好以 session id 命名**、且位于配置的会话根之下（`config.sessionsRoot`，默认 `<dsh home>/sessions`）—— 根给错时"什么都删不到"，而不是删错东西。

## `/work`

```
/work                          列出本会话的工作树与状态汇总
/work <工作描述>                用这段文字建一个根工作
/work list   /work ls           显式走列表模式
```

`/work <文本>` 与 agent 调 `create_work` 走**同一条路径**（同一个 `host.createWork`），所以配额、归属校验、派活、引导层、`pre-step` 门控全部一致，不需要模型参与。

约定：

- **多行输入**：第一行作标题，整段作描述；
- **标题行过长**（>80 字符）会被截断并加省略号 —— 标题在整棵树里都是"一行"的语义（工作链每层渲染一行），所以粘一整段不能把它撑开，完整文本仍在描述里；
- **不带 owner 分析**：斜杠命令没有"分析"可带，就不编一个；根节点的 `context` 为空，第一个执行者收到的 prompt 如实反映这一点；
- 被拒绝时（例如子 agent 会话不能建树）返回 `error` 结果并带上稳定 code，而不是抛异常。

## 日志

插件**自己带一个日志出口**（`src/log.ts`），每一行都写两处：可见的一处走 stderr（宿主侧）或浏览器 console（客户端侧），另一处镜像进 `ctx.logger`。

原因是 DSH 的 `ctx.logger` 目前写的是**缓冲的 exporter**，行不会到终端 —— 对一个"整件事就是在后台跑引擎"的插件，这意味着"这一行挂上了吗"和"那个节点为什么一直没被派活"从外面完全无法回答。本机实测：`@avantf/mem-dsh` 的启动日志可见、而本插件改前的启动日志不可见，差别就在这里。

打点位置（都带 `[avantf-work]` 前缀）：

| 时机 | 行 |
|---|---|
| `apply` 进入 | `mounting: config=… inject=…` |
| typert 注册后 | `typert host face registered (namespace avantfWork, 5 invocations: snapshot, detail, result, delete, watch)` |
| 工具注册后 | `registered N tools: …` |
| 挂载收尾 | `mounted: /work command, 9 tools (/archive, /clean), guidance context, pre-step gate` |
| 开存储域 | `start-up: opening the work-tree storage domain` |
| 载入完成 | `start-up: loaded N tree(s), M node(s)` / 孤儿树销毁时 WARN |
| 引擎就绪 | `engine ready: concurrency=… depth=… failure-budget=… children<=…` |
| 每次变更 | `create_work: root …` / `decompose_work: … -> created […]` / `submit_work: …` / `finish_work: …` / `cancel_work: …` |
| 派活与回收 | `dispatched <node> as <claim>` / `dispatch of <node> failed: …` / `sweep: reclaimed N node(s)…` |
| 唤醒 owner | `root <id> reached <status>; woke owner <session>`（owner 不在线时 WARN） |
| 卸载 | `unmounting` |
| 客户端挂载 | `client half mounting: …` / `Remote namespace mounted: …` / `registered the conversation.view seat: id=works order=20` |

**刻意不打点的**：`agent/pre-step` 的每次放行/剔除。它每步都跑（包括第一步之后的**空批次**），逐次打印会把上面这些真正的转折点淹掉；判断它为什么清空批次请用返回的原因（`admitStep` 是纯函数）。

## 设计要点

**引擎是程序，不是 agent。** 扫树、派活、回收全部是宿主代码，不花 LLM 调用。LLM 只出现在工作单元内部（执行、拆解、汇总）与 owner 的对话里。

**工作单元无状态、用完即弃。** 每次执行是一次新的子 agent 会话，prompt 只含工作链（各层仅 title + 一行背景）与当前节点的完整内容。执行者**从不等待、从不持有** —— 它的 prompt 里没有子工作进度，因为那正是诱导等待的信息。

**拆解由执行者做。** "为什么需要这个前提"只有尝试过的人知道，所以子工作的 `context`（拆解原因）由拆解者写入，并沿工作链向下传递。

**状态在树里。** `running` 节点的 `claimedBy` 记录持有者 session id，用于：活性判断（持有者还在吗）、结果写入校验（身份即凭证）、以及控制面（取消时该打断谁）。

**两个终态工具互斥靠状态机，不靠提示词。** 终态节点不可再拆解；**还有未终态子工作**的节点不可提交结果 ——
子工作全终态的那次派活正是汇总，它的两种合法结局就是"提交结论"与"继续拆解"，两方向都在树锁内按节点状态判定。

**回收不给模型工具。** 引擎自己就能判定"这次执行废了"：worker 会话消失（`subagent/end` 或每 60 秒的扫描按活性判定）、或 holder 仍 live 但**沉默**超过 `staleMs`（默认 30 分钟无进展）—— 后者会**先打断** worker 再回收，然后同一次扫描里重新派活。
模型看不到 worker 的进度（结果走树，不走进度流），所以它没有任何引擎没有的信息可供判断；一个手动回收工具只会多出一条"把健康节点打断、白烧一次失败预算、丢掉已有产出"的路径。曾有过的 `reclaim_work` 正是因此删除：
它既不打断在跑的 worker（比自动路径更弱），也没有任何测试覆盖。

**"跑了很久"与"卡住了"是两件事。** 沉默窗口按 worker **最后一次有进展**起算 —— 每次它往自己的会话里追加事件（一步、一次工具调用、一条消息）都会刷新该节点的 `progressAt`；只有连续沉默超过 `staleMs` 才算卡死。所以一个跑了 40 分钟但一直在推进的工作不会被回收，而一个真卡住的 worker 最多等一个窗口。

**回收只认"确实没了"。** 续期子会话是异步物化的：节点绑定与子 agent 注册之间有几十毫秒的窗口，这期间的 claim **算 live**（`startingClaims`）—— 否则一次落在窗口里的扫描会把正在启动的 worker 判成"消失"并重派，而第一个 worker 还活着、它的每次提交都被拒（实测：5 个节点的三级树跑了 **13 个 worker**，每个节点白烧一次 attempts）。启动结束后仍无活体，才按"消失"回收。

**卡死知会是节制的。** 首次停摆只记在节点上（`stalls`），引擎自己就恢复了，不值得占 owner 一轮；**同一节点第二次停摆**、或**这次停下来之后 attempts 就要用尽**时，才给 owner 一条消息（"没有进展 N 分钟，执行者已打断、工作重新排队 —— 第 N/5 次尝试"）。这条消息的"只报一次"靠节点上的 `stalledNotifiedAt` 持久化标记，和终态唤醒同源 —— 否则 60 秒一次的扫描会变成刷屏。

**刷新由引擎负责，不由面板猜。** 谁变了只有引擎知道，所以由它说：`watch` 是一个 `mode: 'stream'` 的 Remote 调用（harness 自己的 `session/control` 用同一种模式），引擎每变一次就往该 session 的每个打开的流里 yield 一帧，标签收到帧就重读快照。这样不需要固定频率轮询，也不需要从会话日志里"推断"树动没动。保留的两条兜底是：会话侧 revision（`useChat`/`useSession`，免费，能覆盖推送还没到的工具调用）和 5 秒 `timer`（宿主没有 `watch`，或流连着两次一帧都没给 —— 健康的流一定会先给一帧开场，所以"什么都没来"就是"这条流不能用"）；帧里只有一个 revision 号，权威数据永远来自 `snapshot`/`detail` 的读取。**详情按需读**：点开某一行才调 `detail`，因为一个结果最多 2 KB，而快照每次变更都要重读，通常关着的面板不该为它付钱；**读出来后在弹窗里按标签看**，形制照 DSH"设置"面板（遮罩 + 定宽卡片 + 左侧分区栏 + 右侧唯一滚动区），所以一份长详情既不撑高树，也不会把另一棵树顶出视口；**工作标题是弹窗的标题栏**而不是一个分区（连同节点 id/状态/派发次数/深度），因为它必须在切换分区时始终可见。**超过 2 KB 的结果点了才读**：`result` 是另一次按需调用，宿主把 spill 的文件读回来（这是它自己写的产物），面板就地展开全文并替换掉"开头那段"——因为开头本来就是全文的第一片。locator 仍留在屏幕上：它按契约是不透明的，`SpillStore` 只定义 `saveText`（明确写着没有 retrieval API），所以宿主只在它**是绝对路径**时读它，否则回一条原因——面板的按钮与降级文案都由这一点决定。`内容` 与 `上下文` 挨着但回答不同问题（**要达成什么** vs **为什么需要它**：前者是验收对象，后者是拆解者写的前提），两个分区各带一行说明；`拆解信息` 渲染的是 `note_work` 留下的 `analysisNotes`（含最近一条写于第几次派发）—— 它是判活的那个全新会话唯一能看到前任推理的地方，此前只有引擎读得到。

**纠偏只有一个动作，后果由引擎承担。** `adjust_work` 之后，引擎**自动作废该工作名下还没完成的子工作**（作废 = 标记失败 + 打断在跑的执行者，锁内原子完成），工作随即回到汇总轮按新方向重新规划；**已完成并交出结果的不受影响**。理由与 `reclaim_work` 被删除时相同：这是"方向变了"的机械后果，不是 master 需要记住的第二个动作 —— 多一个动词只会多出一种半成品状态（纠偏差了、旧方向的活还在烧模型调用）。因此模型面上没有 `cancel_subworks`；该能力保留为引擎自己的原语。

**纠偏记在 `NodeRecord.corrections`，并由工作链下传。** 不混进 `context`（那是拆解者写的"为什么存在这个工作"）：纠偏是 owner 对已派出去的活的指令，作者与生命周期都不同 —— 混在一起时工作链只渲染 `context[0]`，纠偏对任何后代都不可见。现在当前节点以独立的"纠偏:"块渲染，工作链逐层带出各层的纠偏，所以写在根上的纠偏会到达任何后代。取消子工作时**每个被改动节点的全部父节点**都要重算聚合状态（复用前提是共享的，否则另一个分支会永远卡在 `blocked`），并且取消写下的 `result` 必须同时置 `hasResult`、汇总块必须带子节点状态 —— 否则模型读到的是"（未提交结果）"加一句"都已完成"。

**纠偏不必"停下再重派"，而且只有一个动作。** 工作派出去后 master 停下，用户再开会话发现方向要改时，只需 `adjust_work(root_id, adjustment)`：纠偏写进**根工作**的 `corrections`（持久、之后每次派发都带着，并经工作链下传到后代），若此刻有执行者在跑就直接投递给它；同一调用里引擎还会作废该工作名下未完成的子工作，让它立刻按新方向重新规划。**"记录 + 投递"两条都做**是必需的：根工作大半生在等子工作（没有持有者），而每次派发都是全新会话。作废只向下走（工作本身、父工作、兄弟工作都动不了），要结束整棵树用 `cancel_work`。

**纠偏不只要写给执行者，还要写给查看者。** `corrections` 落库、进 prompt 只解决了"执行"这一半：面板的行与详情、以及 `work_result` 当初只渲染 `title` / `description` / `result`，而标题是**创建时**的目标 —— 于是被纠偏过的工作读起来就是"目标 X、结果是 Y"，两者之间空无一物；纠偏虽然在库里，却没有任何查看面读它（`/work` 的索引行也一样）。现在四个面都带上：快照的行投影（`NodeView`）带 `corrections`，行上渲染"已纠偏 N 次"标签、文本挂在 tooltip；`detail`（`NodeDetail`）在"工作内容"与"本工作提交的结果"**之间**给出完整"纠偏"块；`work_result` 把纠偏列在结果之前、`data` 里再带一份；`/work` 的索引行只报次数。**目标本身不改写**：纠偏是叠在原始目标旁边的历史，改写 `title`/`description` 会把"当初要什么"抹掉，而回溯要的正是这两者对照。行投影因此带上了一个不在"行必须轻"豁免之列的字段，判据是它在**折叠状态**下就必须可见，且文本短、条数少。

**模型可见文本已全部中文**，包括工具体内的**拒绝文案**（`节点 X 不是由你持有`、`工作 X 处于 执行中；还不能收尾`、`收尾前先用 work_result 读根结果` 等）与工具返回、`/work` 的列表输出；节点状态在两处共用一张中文表（`statusLabel`）。日志仍为英文（面向排查者）。

**用语：交出去的那件事叫"工作"。** "工作树"只指它被逐步分解之后的形态；工具名因此不带 tree（`list_works` 列出你拥有的工作）—— 从 master 的视角只有工作。 模型可见文本里不再写"能在这一轮做完就别建树" —— 一件较独立的工作即使能在一轮里开始，交给引擎执行也是正当用法；判据落在"是不是一件可交出去的工作"（独立工作 / 要调研 / 多步 / 要跑一阵 / 逐步分解 / 碰多个文件或系统）。**owner 侧连内部形态也不给**：`list_works` 只说一个工作还在跑、还是反复出过问题，`show_work`（逐个节点列出整棵树、带 `depth`/`attempts`/`result_ref`）已删除 —— owner 能做的两件事（`adjust_work` / `cancel_work`）都只吃根工作 id，看得见却动不了的层级没有存在的理由。

**模型可见文本一律中文，且只讲"做什么 / 怎么做"。** 四类文本都是：静态段（`avantf:work-tree-guide`）、每轮的动态状态行（`avantf:work-tree`）、worker 的派发 prompt、9 个工具的描述与参数说明。写法约束：**不写"为什么"** —— 不讲执行者看不到对话、不讲引擎为什么要重派、不讲隔离与配额的道理，只留判据（能不能连验收标准一起交出去）与禁令（不要轮询、不要替子工作干活）—— 参数怎么填交给工具的说明。工具名保持英文标识符（`decompose_work` 等），因为那是模型必须原样调用的名字。

**工具面孔：每个 agent 只带自己那一半。** 一次注册、两套可见性：owner（顶层会话）看 `create_work`/`adjust_work`/`work_result`/`list_works`/`finish_work`/`cancel_work`，executor（工作单元）看 `note_work`/`decompose_work`/`submit_work`。不做的话每个 agent 的 schema 都带着另一半用不上的工具，而且是"可见但必然被拒"（`create_work`→`no-authority`，`note_work`/`decompose_work`/`submit_work`→`not-owner`），并且 worker 能读到别的节点 —— 与"worker 的 prompt 不含兄弟进度"的设计意图冲突。机制分两半：executor 走派活请求的 `toolFilter.deny`（harness 给任何被委派子会话施加的同一个 scoped `restrict()`）；owner 在 `agent/created` 时对该 agent 施加 scoped 限制，并用组装瀑布按 `context.agent` 过滤 `assembly.tools` 兜底（`tools.restrict()` 只在 scoped context 上合法，全局限制会被 harness 直接拒绝）。**遮蔽不是授权**：边界仍是工具体内的拒绝，面孔只管模型看不看得见；测试里有一条"每个注册工具必须恰好落在一张面孔"的不变量。

**策略进系统提示词，机制留在工具描述里。** "什么时候该把活交出去"此前只写在 `create_work` 的工具描述里 —— 工具描述讲机制，策略却要模型自己从工具清单里翻出来。现在它是一段静态 section（位次 `TOOL_JOBS`，与 `create_work` 用同一个"能不能建树"的判据），讲三件事：**判据**（能不能连验收标准一起交出去，而不是复不复杂 —— 不需要拆的工作同样适合交给它，一次派发就做完；需要拆的就交给执行者拆出前置工作、由引擎逐级派下去）、**工作是什么**（跨会话持久化，由引擎逐级派给一次性执行者）、**边界**（工作树与"起一个子 agent 去干活"在"交出去"上重叠 —— 执行者是一次性的、跑起来联系不上、看不到对话，所以需要看见这段对话 / 需要来回追问 / 需要脚本化扇出的委派该用 `subagent` / `subagent_fork` / `workflow`；但"我已经想清楚了"不在排除之列）。**刻意不写两组东西**：参数怎么填（`title` / `description` / `analysis` 属于工具的说明，同一个请求里就读得到，静态段不重复一遍），以及工作能不能包含某类内容（master 自己决定一件工作为了什么，读回结果是 `work_result` 的事）—— 两条都有测试盯着。同一边界也写在 `create_work` 的工具描述里。另四类从来没写过的（节点状态词表、`note_work`/`decompose_work`、id/存储/面板、读结论与收尾机制）在 `prompt.ts` 的注释和设计文档 §6.0 里各列了一次，并有禁用词表的测试盯着。

**对比度：文字一律用 label token，不用 opacity 调暗。** 之前用 `opacity` 做次级文字变暗，而归档树又叠了一层 `.avwf-tree-settled { opacity: .75 }` —— 两者相乘后，次级文字在亮/暗主题里只剩约 2.7:1 / 3.5:1，12px 小字实际读不了。现在：条目底色 `bg-layer-1`，正文 `label-primary`，次级文字（状态汇总、根 id、meta、上下文、详情标签）`label-secondary`；实测对比度 亮 `18.9:1` / `5.8:1`、暗 `15.0:1` / `10.4:1`，两套主题都过 4.5:1。归档不再整块变淡（`已归档` 标记已经说明了），改为虚线边框。状态是**色相**而不是文字色：`--avwf-status` 由状态类发布，只喂给圆点和徽标底色，徽标文字仍是 `label-primary`（状态色当文字在亮色主题下只有 2.3:1）。顺带修掉：样式里原来的 `--dsh-color-*` 在 DSH 设计平台里**根本不存在**（只有 `--dsw-*`），所以那几处颜色一直在用硬编码兜底值。

**条目的填充与文字色取自设计 token。** 树框的底色用 `--dsw-alias-bg-layer-1`、文字色用 `--dsw-alias-label-primary` —— 就是 `@avantf/mem-dsh` 的"记忆"条目用的那两个 token（由 shell 为明暗两套主题统一定义），所以两个标签读起来是同一块界面而不是外来控件；token 不存在时这两条声明在计算值阶段失效，退化为透明/继承，不会变成错的颜色。除颜色外没有改动条目样式（边框、圆角、间距、字号都还是本插件原来的）。

**面板对齐对话正文列，不通栏。** 根节点用 `width: 100%; max-width: var(--dsh-chat-content-width); margin: 0 auto`，也就是 `@avantf/mem-dsh` 的"记忆"页用的同一条规则与同一个共享属性（由 `ui-conversation` 的根发布、`ui-chat` 的消息列也以它居中），两个标签于是共用一个轴线与一个宽度；属性缺失时 `max-width` 在计算值阶段失效退化为 `none`（即回到通栏）。根节点不设左右内边距，因为"树框"本身就是条目，它的左右边界要落在"记忆"条目落的地方。

**列表是窗口化的，数据也尽量瘦。** 树的条数超过阈值（25 棵）时，面板按"棵树"窗口化渲染：滚动高度覆盖全部历史（画布按虚拟总高撑开），但真正挂载的只有视口附近的几棵（`@tanstack/react-virtual`，`overscan` 5，行高先估后量），这跟"轨迹"表用的是同一套机制、同一个库；不足阈值时走普通 flex 列，也就是视图测试覆盖的那条路径。同时，摘要只带**行上真正要用的字段**：一个节点的 `description` 不在摘要里（行从不显示它，全文走按需的 `detail`），因为这份摘要**每次引擎变更都要重传一遍**。

**展开的默认值跟着工作状态走。** 一个还在跑（或可执行/等待/中断）的节点默认展开 —— 它拆出来的子工作一出现就能看到；一个 `done` / `failed` 的节点默认折叠，于是一棵跑完的树收成一行，一条已经结束的分支不再压住还活着的部分。点击 twisty 存的是**覆盖值**而不是展开状态本身：所以"我手动展开过这一个"不会在它结束时被改回去，而没被点过的节点会一直跟着自己的状态走。

**删除的单位是整棵工作树，不是工作节点。** 面板上的按钮在**树**的标题栏（文案就是"删除"，作用域写在悬停说明里），不在行上：一次点击删掉这棵树、它的全部节点和它的存储记录。节点不是可删除的对象 —— 兄弟节点的前提、汇总的来龙去脉和树的身份都在同一条记录里，从一棵活的树里抠掉一个节点只会留下一个收敛不了的树。删除只接受**已经结束**的树（根为 `done` / `failed`）：还在跑的树归引擎管，提前结束它是 `cancel_work` 的语义，所以按钮对活树可见但禁用、并在悬停里说明。**`finish_work` 是另一种"结束一棵树"**：它保留记录并归档（面板里置灰显示"已归档"），删除则是把它整条移出列表；两者都作用于整棵树，区别只在留不留数据。删除不可恢复。**三个 owner 工具只认根 id**：`adjust_work` / `finish_work` / `cancel_work` 拿到子工作 id 一律回 `not-root`（`finish_work`/`cancel_work` 原先按 ROOT 查表，会把"这不是根工作"说成「工作 X 不存在」）。

**一次独立核对（2026-09-23）修掉的四处。** 一件真实工作（拆成 4 个前置工作、汇总交出报告）挖出：① `no-caller` 九个工具都会产生、却不在 `RefusalCode` union 里（按 union 穷举的消费者会漏），已并入；② 纯空白文本能落库（`create_work` 标题/内容、`submit_work` 结果、`adjust_work` 纠偏），补 `blank-text` 拒绝，**但分层不动** —— 工具层只拒空串、空白归引擎判，与 `note_work` 的 `no-analysis` 同源，把 trim 塞进工具层的 `str()` 会让那些码失去可达的产生点（这一点被 `decompose-analysis.spec.ts` 的一条测试当场拦下）；③ "反复出过问题"的三个渠道口径不一，抽成 `isTroubledNode` 唯一判据并给"连续起不来执行者"补上 owner 提醒；④ `finish_work`/`cancel_work` 对子 id 回 `not-root`。

## 关键参数

| 项 | 值 |
|---|---|
| 树深度上限 | 8（根为第 1 层） |
| 单次拆解子工作数 | 至多 6 |
| 单树节点上限 | 200（`decompose` 提交前校验；只数本次新增的节点，复用已有前置工作不计数） |
| 并发工作单元 | CPU 核心数 - 1（可配）；按已绑定节点计数 |
| 沉默窗口 | 30 分钟（可配 `staleMs`，下限 1 分钟）；按 worker 最后一次有进展起算，超时先打断再回收 |
| 失败预算 `failures` | 5（worker 被回收才 +1，达阈值标 failed；成功的提交与拆解，含汇总轮，都不消耗） |
| 启动失败预算 `spawnFailures` | 5（派发即失败才 +1，按 `30s × 2^(n-1)`（上限 10 分钟）退避后重试；成功启动即清零；达阈值标 failed） |
| 卡死知会 | 同一节点第 2 次停摆，或停摆后失败预算将用尽（`failures ≥ 4`）时给 owner 一条消息，每节点至多一次 |
| 结果内联阈值 | 2000 字（超出走 `ctx.spillStore` 落盘并留定位符 + 取回指引） |

## 复用的宿主能力

子 agent 生成（`ctx.subagents`，continuable + 预留 child id）、宿主 KV（`ctx.storageDomain`）、提示词注册表（运行时上下文）、`agent/pre-step`（过滤与放行）、`ctx.agents`（活性）、agent inbox（清掉自己排队的信号 / 取出排在信号后面的消息）、`ctx.sessionQuery`（owner 存亡）、`ctx.spillStore`（超长结果）、`ctx.interval`（兜底扫描）。

**不自己实现**：子 agent 的生成后端、会话持久化、压缩。

## 测试

```bash
pnpm -r test        # core + plugin 单测（真实 Cordis Context，stub 掉 DSH 服务；条目数以本次运行为准）
pnpm build:dsh      # 链接 → 构建 → 挂载冒烟
```

plugin 的测试用真实事件链驱动 `agent/pre-step`，且默认 decision 与 agent loop 一致
（`[...inbox 认领, 运行时上下文快照]`）—— 这正是挂载冒烟曾经看不见的区间：
把 `next()` stub 成空批次，会让"丢掉全部运行时上下文"和"唤醒不产生模型回合"两个缺陷同时隐身。

## 已知限制

- **worker 的隔离只覆盖主要几条路：`workflow` / `ralph` 没有被摘。** deny 列表是 `send_message` / `subagent` / `subagent_fork` / 三个 goal 工具（`create_work` 可见但执行时被 `no-authority` 拒），而 `workflow` 的 `agent()` 与 `ralph` 的每一轮都会起子 agent —— 它们不在树上、结果不回填节点、失败无人回收，递归也绕开节点配额。要么把它们一并加进 deny（隔离严密，代价是节点内部不能再自行扇出：N 个同构条目只能串行或分轮拆解、结构化中间结果只能自己拼字符串塞进结果、独立视角与"迭代到判据满足"都没有工具），要么承认隔离是"防住主要几条路"。取舍列在设计文档 §5.4.1。
- **工具面按运行时裁决收窄，而不是按预检。** `toolFilter` 由运行时的 `tools.restrict()` 校验，而它能接受的名字集合与"父 agent 可见的名字集合"并不相等：子 agent 继承的是**父 agent 所在 preset 的组合**（`agentPresets.composeFrom` 把子作用域挂到 preset 的 mount scope），**不是父 agent 自己的作用域**。因此按 agent 平面注册的工具（例如 `tool-subagent` 在启用 standing `modelSelectionSettings` 时按 Agent 安装的 `subagent`）对父可见、对子不可继承，`restrict()` 会拒绝**整个** filter。本插件的对策：首次 `startContinuable` 失败且错误来自 `tools.restrict()` 时，**从名单里去掉被点名的工具并重试一次**（只失去那一个工具的隔离，而不是让整棵树因为派活失败烧完 attempts）。要完全避免，需要上游把这类工具注册到 preset 作用域。
- **worker 会读到 `dsh-tool-goal` 的目标指引，但没有对应工具**（仅当该部署挂载了 goal 工具时）。 该插件的 `tool:goal` 段落是静态文本、不做作用域判断，而 worker 会加入 owner 的 preset 组合。无法从第三方插件干净遮蔽：同名段落会连 owner 一起替换，而它不导出自己的指引文本。工具面本身按部署收窄（deny 只列部署真实注册过的名字，未知名字会让 `tools.restrict()` 直接抛错）。后果有界（worker 调 goal 工具会以 `UNKNOWN_TOOL` 失败，且 `requireDirectHuman` 本就拒绝它），浪费一个回合而已；正确修法在上游——把那段改成 `(context) =>` provider，在工具不可见的作用域返回空串（`dsh-plan-mode` 的 `plan:policy` 就是这个写法）。

## 看运行情况（诊断）

```bash
pnpm workers:usage                    # 全部 worker 会话：工具使用直方图 + 越权/扇出尝试 + 失败调用
pnpm workers:usage -- --tree <root>   # 只看某棵树的节点
pnpm workers:usage -- --strict        # 出现"调了不存在的工具"就非零退出（用于 CI/巡检）
```

每个工作单元都是一次真实会话，所以**策略问题可以直接从落盘的会话里读出来**：worker 有没有伸手去够不该有的工具（`workflow` / `ralph` / `subagent` / `send_message`）、有多少次派活白烧在一个错误上、某个节点当年花了几个 worker。§"已知限制"里 `workflow` / `ralph` 要不要摘，就用它决定 —— 只读，不改任何东西。

## 环境初始化（`@avantf/dsh-plugin-base`）

插件挂载的第一步不是注册工具，而是**把环境准备好**——交给家族底座 `@avantf/dsh-plugin-base`（peer 区间 `>=0.3.0 <1.0.0`；本仓另在 `devDependencies` 里声明同一个范围，并由根 `pnpm-workspace.yaml` 的 `linkWorkspacePackages: true` 链到本地 `base/`）。底座**一个包**里装着启动期环境初始化框架与宿主兼容门禁（从前独立的 `@avantf/dsh-envinit` / `@avantf/dsh-compat` 已并入它，且不再发新版本）。时序固定为：

```
内联 bootstrap（解析底座 → 动态 import() → 校验 supportedRange）→ 接口门禁（底座判 verdict）→ 跑挂载前检查（兼容门禁）
```

- **它要准备什么**：不再有 item 清单，也**没有 `work:compat`**——门禁就是底座本身。本插件像记忆插件一样注册手写的 Typert wire face，有同一个运行时错配风险：契约挪了以后**挂载成功**，然后在某个 remote 调用里炸，报错里没有版本信息，所以启动时用底座自带的规则 / 探针 / 复查跑一次门禁。
- **底座怎么被找到**：内联 bootstrap 用 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` 从**插件自己的依赖树**解析（正常就是 `node_modules/@avantf/dsh-plugin-base`），再动态 `import()`；版本不在内联 `supportedRange` 内 → 一条 `envinit: WARNING`，插件**照常挂载、降级**。绝不静态 `import` 底座、绝不 bundle 底座：静态 import 会在底座缺席时让整个插件模块加载失败。
- **唯一内联件是 bootstrap**：本插件是 `tsc` 直出（没有打包器），所以底座构建产物里的零依赖单文件 `bootstrap.js` 被**拷进产物**、按相对路径 import。`scripts/build.mjs` 负责拷贝并断言它与**安装的**底座同版本。底座本包**只能是 peer**（外加一条 `devDependencies` 让 pnpm 装上），且**不得被静态 value import**——坏树时静态 import 会先于 bootstrap 抛错，插件连"解析底座并留下 WARNING"这一步都做不到（`pack-plugin.mjs` 断言这两条）。
- **拿不到就降级，不拒载**：底座不可解析 → 一条 `envinit: WARNING`，插件照常挂载（工具、服务、prompt 段、Remote face 全注册），门禁跳过并退回 legacy provisioning；门禁包装不上或门禁本身跑不起来，同样 WARNING 后继续。**接口世代不匹配也一样**：插件 bake 的 `INTERFACE_VERSION` 与加载到的底座报出的不同（区间内但另一世代）⇒ 一条 `WARNING` 且**不使用底座的共享能力**（prompt 层退回本插件内置正文、门禁跳过），走的正是"底座拿不到"那条降级路径，仍**照常挂载**；`cannot-tell`（老底座没有 `checkInterface`/`readInterfaceRequirement`、bake 缺失/畸形）⇒ 只告警、照常使用。判定语义不变：只有**被证明的破坏**（`probe-failed`）才拒载，"无法判定"只是 note，版本差异只是 warning，绝不抛错。
- **共享逻辑从底座运行时取**：兼容门禁规则/探针/复查、envinit provisioner、prompt 文件层 `PromptFiles`、以及本插件的数据根解析 `resolveDataHome`，都在运行时从动态 import 的那份底座上取用——所以修这些共享逻辑**只需发一次底座**，不必重建插件产物。仍留在插件里、改它们**需要发插件**的是：`typert` `strict` wire codec 与端点/字段/结果符号字面量（照抄宿主约定的两三行，描述符在模块加载期组装），以及本插件自己的 logger 与底座缺席时的 fallback 默认参数。底座 kit 另外导出 `createPluginLogger`、`familyHome` 等，插件可在运行时取用。改 `base/**` 里的共享代码后，两个插件的完整门禁都要重跑（work：`pnpm release:check` + mount-smoke；mem：`pnpm build:dsh` + `node scripts/mount-smoke.mjs`）。
- **异步那一档**：`startup: 'background'` 的项由框架派发、不占挂载预算，完成时回调 `onSettled` 再做后续；本插件的门禁是 blocking，加项不改代码。
- **家目录**：族根 `home` = `$AVANTF_HOME`，默认 `~/.avantf/env`；锁、状态都在它下面。工作树与 worker 日志**不在这里**（前者走宿主 `ctx.storageDomain`，后者在 `~/.dsh/sessions`）。

`scripts/link-envinit.mjs` 的职责是**从安装副本 vendor bootstrap**，`pnpm build:dsh` / `pnpm typecheck` /
`pnpm link:profile` 都会自动跑它；`--check` 分别报"缺安装"（修法 `pnpm install`）与"副本漂移"（修法重跑脚本）。
要就地联调底座，用 `DSH_ENVINIT=<checkout>` 显式指定（此时脚本会把该 checkout 链进插件并据此 vendor）；
**不再有隐式发现**——底座已发布，一个恰好并列的兄弟目录不该悄悄变成构建来源。

## 从源码构建

编译对齐**已安装的 dsh**（`npm i -g @deepseek-ai/dsh` 那套包），不需要 harness 源码 checkout。

```bash
pnpm install
pnpm build:dsh      # 链接已安装 dsh + 从安装的底座 vendor bootstrap → 构建两半 → 真实 Cordis 挂载冒烟
pnpm typecheck      # 链接已安装 dsh + 从安装的底座 vendor bootstrap → tsc --noEmit
pnpm link:profile   # 装/刷新 profile 里的 link: 依赖，并校验模块身份
pnpm release:check  # typecheck + build:dsh + 单测 + client 冒烟 + 打包
```

`pnpm build:dsh` 的旗标：`--skip-link`（完全不碰软链）、`--no-verify`（跳过冒烟）。peer 链接始终指向**已安装的 dsh**（`scripts/link-dsh.mjs`，`--runtime [dshDir]` 可指定安装位置），冒烟也在同一套链接下跑 —— 也就是运行时装的那一份。`zod` 在根 `pnpm-workspace.yaml` 的 catalog 里跟随该 dsh 的版本，否则 `@deepseek-ai/dsh-storage-domain` 的记录 schema 是另一套不兼容类型。

客户端半边由 `scripts/build-client.mjs` 用 esbuild 打成 `lib/client.js`（`window.__ModuleLoader__.load` 契约，shell 提供的模块保持 external）。**不使用 harness 的 tsdown 预设**：它按 `packages/*/*/package.json` 反查目标包，第三方仓要跑就得往 DSH 源码树里写一个 stub，而本项目不改 DSH 源码。客户端半边对 Context 用结构化接口（已安装的 dsh 不带 `dsh-client-ui-slots` 包，`ctx.slots` / `conversation.view` 座位只能对着 checkout 做 declare-merge），所以 `tsc` 只依赖已安装的 dsh。

`node scripts/client-smoke.mjs` 在无浏览器环境下执行打好的 bundle（沙箱里给出 `window`/`document`/`require` 桩），断言：自注册、导出 `name`/`inject`/`apply`、只注册一个 `conversation.view` 座位且 order > 10、`inject` 里没有 dotted remote key、以及挂载了自带的 Remote contribution。

对齐**已安装的 dsh** 验证（用户实际加载的那套包）—— 上面两个脚本已包含这一步，手工跑是：

```bash
node scripts/link-dsh.mjs
node scripts/build.mjs
node scripts/mount-smoke.mjs --runtime
```
