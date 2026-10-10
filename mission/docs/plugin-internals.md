# @avantf/dsh-mission：实现笔记（开发文档）

> 这是**开发文档**：实现要点、已知限制、诊断与构建细节。
> **面向用户的发布 README 是 `packages/plugin/README.md`**（npm 页面就是它），
> 设计文档在 `docs/design/mission-engine-plugin.md`。三份文件的读者不同，不要互相搬运。

DSH（DeepSeek Harness）原生 Cordis 插件：**任务树引擎**。

一个任务节点先被尝试执行；发现缺少前提时**由执行者自己**拆解出子节点；子节点全部终态后父节点重新可执行，判断"目标已达成 → 提交给父节点"或"仍需拆解"；直到根节点收敛。

## 它给一个会话加了什么

| 贡献 | 作用 |
|---|---|
| 宿主服务 `avantfMission` | 拥有任务树、存储域与派活循环；Remote 面给"任务"标签读树（`snapshot`）、读单个任务详情（`detail`）、**按需读回落盘的完整结果**（`result`）、删任务（`delete`）、**批量删除本会话已关闭任务树**（`cleanFinished`，面板「清理已完成」与 `/clean missions all` 共用）、**点击时查找历史任务的执行者会话**（`resolveExecutorSession`），并把每次变更推给已打开的标签（`watch`，stream 调用）|
| 9 个模型工具，分两张面孔 | `create_mission` / `adjust_mission` / `note_mission` / `decompose_mission` / `submit_mission` / `mission_result` / `list_missions` / `finish_mission` / `cancel_mission`。**owner 面孔**（顶层会话）见 6 个：`create_mission`/`adjust_mission`/`mission_result`/`list_missions`/`finish_mission`/`cancel_mission`；**executor 面孔**（任务单元）见 3 个：`note_mission`/`decompose_mission`/`submit_mission`。`note_mission` 只给执行者：它写下本轮自己的分析，而 `decompose_mission` 会拒绝一个没写过分析的拆解。回收是引擎自己的事，不给模型一个手动回收的工具 —— 见下。**owner 看不到任务内部**：`list_missions` 只说一个任务还在跑、或者反复出过问题（`troubled`，是历史而非现值），不报它被拆成了什么、各部分什么状态 —— owner 只对整棵树有动作（`adjust_mission` / `cancel_mission`），内部结构是引擎的事 |
| 一段静态系统提示词段 | 告诉模型**什么时候**该把活交出去（判据是"能不能连验收标准一起交出去"，不是复不复杂；需要拆与不需要拆的都算）、以及"谁在等、别轮询、别替它做"，并附一句**写法提示**（要交付长规格或长清单时，先写进仓库里的文件、描述里指向它 —— 超长工具参数是实测的失败源）。参数怎么填、任务能不能包含某类内容都**不在这段里**（前者属于工具的说明，后者由 owner 自己判断）。与 `create_mission` 的授权判据同一个判据，worker 视角返回空串。**正文可编辑**：家族共享目录 `<data home>/prompts/mission-tree-guide.md`（缺失或空白写回默认，启动时读一次；见 [`../README.md`](../README.md) 的「自定义系统提示词」） |
| 一段引导上下文 | 每轮把树的状态写进 owner 的 prompt |
| 一个 `agent/pre-step` 钩子 | 过滤 worker 结算通知、决定某一步带什么进模型；引擎的唤醒信号在没有可处理状态时被**清空**。唯一的例外是**结算通知独占的第一批**（`step === 1` 且整批只有自家结算通知、队列里没有可服务的输入、`admitStep` 也没有 owner 要动的事）—— 那一处返回 `reject`，因为宿主 `dsh-time-context` 会在我们的决策之后往空批次里追加时间注记，清空等于白跑一次模型；其余任何情形都不拒绝（reject 会截断这一轮并把队列/工具结果搁置，见 §4.2）|
| `/archive` 命令 | 把本会话**已完成**的 mission 会话记录标记为归档（走 workspace registry 的官方接口，durable、可 unarchive）。只标记，**不释放磁盘** |
| `/clean` 命令 | 两个作用域，删除必须同时给作用域与目标：`/clean`（无参数）=只读总览、`/clean archive [all\|mission-xxxxxxxx]` 清理本会话已完成的 worker 会话日志（三步一趟完成：标记归档 → 释放记录 → 取消归档）、`/clean orphans [all\|root-xxxxxxxx]` 清理 owner 会话已不存在或不可观测的孤立任务树 |
| `/mission` 命令 | 无参数：列出本会话拥有的任务树；**带文本：用它建一个根任务**（等价于 agent 调 `create_mission`）|
| **"任务"标签**（客户端半边）| 会话视图条里排在"对话""轨迹"之后的第三个标签，用树形展示本会话的任务树；**引擎一变就推给标签**（`watch` 流），点任务标题按需读该任务详情并在**弹窗**里按标签展示（左侧"内容/上下文/拆解信息/纠偏/结果/子任务"，右侧一次一个分区、单独滚动；空的分区不出现，每个分区前有一行说明它装什么；任务标题是弹窗的标题栏，连同节点 id/状态/派发次数/深度）；**每棵**任务树的标题栏带"删除"按钮（二次确认；树还在跑时按钮可见但禁用并说明原因）；**在跑的节点默认展开、已完成的默认折叠**（点击可覆盖，且覆盖之后不再被状态改回）|

## 安装到一个 DSH profile

```bash
# 开发：装成 link: 软链 —— profile 的 node_modules/@avantf/dsh-mission 直接指向本仓库，
#       重新编译就是最新版本，没有"打包 → 复制 → 忘了复制"这一步
pnpm link:profile            # 切 runtime peer 软链 → 装/刷新 link: 依赖 → 校验（--check 只校验）
# 等价的手工第一步：
dsh plugin --profile web add link:/home/qunqi/opensource/avantf-mission/packages/plugin

# 发布：从 registry 装。底座 `@avantf/dsh-plugin-base` 是插件的普通运行期依赖，
#       装插件时自动带上，不用单独装一条
dsh plugin --profile web add @avantf/dsh-mission

# 两种都要在 profile 的 cordis.patch.yml 里挂载这一行
- insert:
    - id: avantf-mission
      name: '@avantf/dsh-mission'
```

**判据是 `profile/node_modules/@avantf/dsh-mission` 本身是 symlink。** pnpm 的 `nodeLinker: hoisted`（本机 profile 的配置）对 `link:` 规格照旧建软链 —— 已实测。若 profile 的 manifest 写着 `link:`、`node_modules` 里却是解包出来的副本（本机 16:54 之前就是这个状态），表现就是"改了代码、重启还是旧行为"；在 profile 目录里重跑一次 install（`pnpm install`）即可落到软链上，`pnpm link:profile --check` 会直接把这种状态报成 FAIL。

**`link:` 安装有一条硬约束：运行期插件的 `@deepseek-ai/*` 必须解析到"宿主跑的那份 dsh"**，因为软链安装下插件是从本仓库的 realpath 解析 peer 的。所以仓库里的 peer 软链只指向**已安装的 dsh**（`scripts/link-dsh.mjs`，`--runtime [dshDir]` 可指定安装位置）：

| 指向 | 谁需要 |
|---|---|
| **已安装的 dsh**（`~/.npm-global/.../dsh`） | 编译（`tsc` 看到的就是宿主运行的那份声明，不再需要 harness 源码 checkout）与运行期（与宿主共享同一份 cordis / schemastery / zod，宿主才不会拒绝我们写进存储域的记录） |

`pnpm build:dsh` / `pnpm typecheck` 都先链接已安装的 dsh 再编译，并把它留在那里。`zod` 不由这里链接：它由本工作区安装，版本在根 `pnpm-workspace.yaml` 的 catalog 里跟随该 dsh（`@deepseek-ai/dsh-storage-domain` 用自己的 zod 标注记录 schema，旧版本是另一套不兼容类型）。手工链接用 `node scripts/link-dsh.mjs`，校验用 `pnpm link:profile --check`。

插件有**两半**：

- **宿主行**：注册服务、工具、提示词与钩子，在进程启动时 import 一次 —— **改它必须重启 `dsh`**。`patchReload: live` 换不了插件代码：`cordis-plugin-loader` 的 entry `update()` 在 diff 不含 `name`/`inject`/`group` 时只 `_patchContext`（连重挂都不做），进了 import 分支也命中 Node 的 ESM 缓存（这条路径没有 cache-busting query），而 `cordis-plugin-hmr` 在本机是 `root: []` 挂着的、模块级 HMR 等于关闭。本机实测：重写 `cordis.patch.yml` 触发"重载"后 80 秒，新建的树记录里仍没有新代码才会写的字段 —— 进程跑的仍是启动时那份模块。所以"更新插件后行为没变"通常不是修复无效，而是代码根本没换；判断前先确认进程是重启之后起的；
- **客户端半边**（`lib/client.js`）：注册"任务"标签，由 shell 的模块表加载 —— 改它只需重新构建并刷新页面。视图挂载时读一次快照，之后**跟着引擎的变更流刷新**（见下），`timer` 服务只在宿主没有 `watch` 时才作为 5 秒兜底（`timer` 是**可选**服务，本机浏览器侧根本没挂）。

客户端半边的两条硬约束（都来自真实踩坑）：

1. **不注入 `remote.avantfMission`，只注入 `remote`**。boot 审计对任何仍 pending 的注入项会抛错、整棵 web 树起不来，而自建命名空间只有在本插件自己 `$mount` 之后才存在。命名空间挂载后用 `ctx.get('remote.avantfMission')` 读取。
2. **客户端对 Context 用结构化接口**。`ctx.slots` 与 `conversation.view` 座位的真实类型来自 `ui-renderer` / `ui-conversation` 对 `ui-slots` 的 declare-merge，而已安装的 dsh 不带 `dsh-client-ui-slots` 包（shell 把它塞进浏览器模块表），只有 harness checkout 能解析。既然编译只依赖已安装的 dsh，`ctx.slots` / `ctx.locale` / `ctx.remote` 的形状就在本文件里本地声明（与 `@avantf/mem-dsh` 同法）。

`@deepseek-ai/*` 与 `zod` 全部按 **peer dependency** 对待：`@deepseek-ai/*` 由 `scripts/link-dsh.mjs` 链接到已安装的 dsh，`zod` 由本工作区安装但版本跟随该 dsh，从而与宿主共享同一份 cordis / schemastery / zod 身份。这一点是硬要求 —— 第二份 zod 会让存储域的校验器拒绝本插件写入的记录。

## 配置

```yaml
- id: avantf-mission
  name: '@avantf/dsh-mission'
  config:
    # 并发任务单元上限；省略 = CPU 核心数 - 1（给 owner 自己的回合留一个核）
    maxConcurrent: 6
    # 容量闸门（核当量，主闸门）：候选要满足 Σ running.weight + weight ≤ capacity 才派发；
    # 省略 = os.availableParallelism() - 1（夹取 1..64，预留 1 核给宿主/UI）。装不下只排队，绝不拒绝。
    # capacity: 11
    # 被容量反复推迟超过这个时长后，该任务预约整机（不再接纳新节点，等在跑的排空再派发它）。
    # 默认 5 分钟，下限 1 分钟。
    # capacityWaitMs: 300000
    # 空闲内存下限（字节）：低于它只推迟派发，绝不拒绝。默认 256 MiB，0 = 关闭这道门。
    # minFreeMemoryBytes: 268435456
    # worker 多久**没有任何产出**就视为卡死（毫秒，默认 30 分钟，下限 1 分钟）
    # 度量的是"多久没产出"，不是"多久没事件"：只有模型输出（assistant/message）、
    # 工具调用（tool/call）与工具结果（tool/result）才算产出；provider 重试
    # （assistant/attempt）与路由快照（request/header、request/context）只证明会话还活着。
    # 所以多步慢活不会被误判，而一个只重试、不产出的 worker 会被回收。
    staleMs: 1800000
    # 单轮派发的墙钟硬上限（毫秒，默认 1 小时，下限 10 分钟且不低于 staleMs）：无论 worker
    # 报了多少事件，超过即按"活着但无产出"回收。它是传输层一直刷新时间戳时的兜底，不看进度时间戳。
    roundMs: 3600000
    # worker 会话目录根（默认 <dsh home>/sessions）。只有直接位于其下、名字正好是 session id 的
    # 目录才会被触碰；根给错只会"什么都删不到"。
    # sessionsRoot: /home/me/.dsh/sessions
    # 宿主投影缓存目录（默认 <dsh home>/storages/session_projcache/sessions）。宿主保留已释放会话的
    # 投影缓存且没有驱逐 API，/clean 在释放记录时删掉对应文件；只认 mission-<8 hex>.json 形状。
    # projectionCacheRoot: /home/me/.dsh/storages/session_projcache/sessions
```

## `/archive` 与 `/clean`（worker 会话日志与孤儿任务树）

worker 是真实会话，所以每派活一次就多一个会话目录（本机实测每个约 40 KB）。两条命令分工明确：

- **`/archive`**：把本会话已完成的 mission 会话标记为归档。走 `workspaceRegistry.archiveSession()` —— harness 的官方接口，durable，可用 unarchive 撤销。**它只改标记，不释放任何磁盘。** 它是 `/clean` 的便捷前置，但**不再是必须**的：`/clean archive` 自己会先归档。
- **`/clean`**：两个作用域同形，**只给作用域永远只列不删**，删除必须 `all` 或具体 id；旧的无作用域形式 `/clean all`、`/clean <mission-id>` 一律报错并指路（不静默当别名）：
  - `/clean`（无参数）→ 只读总览：archive 作用域的可清理清单（含**保留状态**两行与幽灵 id 一节）+ orphans 作用域的按原因分组清单；
  - `/clean archive` → 只列 archive 作用域（同样带保留状态）；`/clean archive all` → 一趟清理本会话所有**已完成（非运行）**的 worker 会话记录（**手动全清，不受 `keepWorkers` 保留数限制**），走**三步生命周期：标记归档 → 释放记录 → 取消归档**（尚未归档的先调 `archiveSession`，归档成功后才删目录，删完再调 `unarchiveSession` 撤掉标记），并在**释放记录的同一步**删掉它的投影缓存残留（见下）；`/clean archive <mission-xxxxxxxx>` → 只清这一个（同样三步，且必须在**本会话**的 worker 里找到）；
  - 输出分桶说明发生了什么：**归档并清理 N 个**（逐个标出"本次归档 / 原本已归档"）、**清理残留投影缓存 M 个**（与 N 分开报，见下）、**已删除但取消归档失败 X 个**（删除成立，只记日志/输出，不回滚）、**因仍在运行跳过 M 个**、**不属于本会话跳过 K 个**、以及**对账清理了 G 个幽灵 id**。没有 `workspaceRegistry` 时直接报"无法归档 ⇒ 无法清理"，一个记录都不删（归档标记来自 registry，没有它就无从授权释放）；
  - 清单把「已完成未归档」（记录仍在、值得清理）与「已归档但记录已不在（幽灵）」（记录已释放、只剩标记）分开显示：前者要删，后者只需取消归档；
  - `/clean orphans` → 只列孤立任务树（按原因分节）；`/clean orphans all` → 删除列出的每一棵；`/clean orphans <root-xxxxxxxx>` → 只删一棵；
  - 删除前**逐个重新探测** owner：期间变回可观测的、或已经不存在的树会被跳过并在输出里说明。这是唯一允许触碰别的会话的任务树的路径，且仅当该树的 owner 不存在或不可观测。

**清理是"标记归档 → 释放记录 → 取消归档"三步，一趟完成**：作用域 = 本会话的 + 已结算的（`isOurWorker` 且 `!live`）。尚未归档的先归档，归档**成功之后**才删会话记录，删完再撤掉标记；归档失败（或部署里根本没有 registry）就**保留记录**并在输出里说明。第三步是 best-effort：**取消归档失败不回滚删除** —— 文件已经没了，留着标记只会变成幽灵 id（更糟）；失败进输出与日志，留给下次对账。**运行中的 worker 永不触碰** —— 用户明确不要打断它们，要清就得等它结束；别的会话的 worker 只被计入"不属于本会话跳过"，绝不删。

**自动保留（`keepWorkers`，默认 10）：只数已完成的，每属主会话各留最新 N 个。** 光靠手动 `/clean` 会让磁盘随派活次数无界增长，所以插件加了一条按数量的自动策略，复用上面同一条链路（`cleanWorkers(..., { retain: N })` 只收窄候选集）：

- 候选 = **本属主会话的、`mission-*` 的、`!live`** 的 worker，按会话头 `createdAt` **降序**取最新 N 个保留，其余释放。**live 既不算名额、也不释放**：13 个已完成 + 4 个在执行 → 释放 3 个（最旧的已完成）；3 个已完成 + 8 个在执行 → **零释放**。
- **按属主会话各自保留**：命令路径（`/clean` 清单）用调用者会话；挂载与扫描路径用任务库里已知的属主会话（`host.ownerSessionIds()`，取自 `tree.trees()` 的 `ownerSessionId`）逐个跑。
- **触发点**：① 挂载时一次（链在 `host.start()` 的 `ready` 上、**不 await** —— `apply` 必须能在存储还没打开时返回；链尾 `catch`，不留未处理拒绝）；② 每轮 `host.sweep()` 之后（`host.onSweep` 注册，**不新造计时器**）。
- **`keepWorkers = 0` 关闭自动保留**（= 保留全部），**不是**"一个都不留"；配置 schema 只接受非负整数，代码再把 `<= 0` 当关闭。
- **自动保留 vs 手动全清**：自动只释放**超出 N 的旧记录**；`/clean archive all` 是显式手势，一次释放本会话**所有**已完成记录，**不受 N 限制**。
- **best-effort**：释放失败只 warn，绝不影响挂载与命令结果；**绝不中断任何 live worker**。
- **`/clean` 清单分两行显示**：「已完成 worker：X 个（保留最新 10 → 可自动清理 Y 个）」与「正在执行：Z 个（不计入保留名额、不会被清理）」。

**"幽灵 id"对账（为什么存在第三步）**：归档标记的唯一作用是授权释放记录。记录一删，标记就再没有意义 —— 但它是 durable 写进 registry 的，删除目录并不会顺手清掉它。留下的后果是**子智能体列表**（以及一切读 `archivedSessionIds` 的面）会一直把已经删掉的会话显示出来：本机实测 `archivedSessionIds` 里积了 64 个 `mission-*`，而磁盘上只剩 3 个。因此插件在**挂载时**与 **`/clean archive all` 里**各跑一次对账（`reconcileArchivedGhosts`），对每条"已归档、`mission-*` 形状、且**会话语料库 `sessionQuery.listSessions()` 与 `sessionsRoot` 都查不到**"的 id 调 `unarchiveSession`。边界是刻意收窄的：只用 `mission-*` 形状（非本插件形状绝不碰）、只在**缺席被证实**时动手（没有 `sessionQuery` 时判"无法证明"而不是"不存在"，一条都不动）、仍然存在的记录不动。宿主接口本身是幂等的（"An id that is not archived resolves without writing"），所以重复挂载/重复对账安全。

**第四层：投影缓存残留（"看不见的 worker"）。** 释放会话目录并不是最后一个落盘痕迹。宿主 `dsh-session-projection-cache` 给每个会话在 `<dsh home>/storages/session_projcache/sessions/<id>.json` 存一份 durable 投影检查点：`session/created` 时写、`session/disposed` 时 `flushSoft('detach')` 后**刻意保留**（为了重开时预热），而且**没有公开的驱逐 API**（域里的 `delete(`/`clear(` 只是它内部 Map 的操作）。于是记录删掉之后，父会话仍能把这份缓存里的 `rows.subagent` 读回来，把它当作一个子代理列出来 —— 用户看到"清完 worker 但列表里还在"。实测现场（2026-10-03）：磁盘上 mission 会话目录 **0**、归档登记表里 mission id **0**，而缓存目录里有 **70 个 `mission-*.json`**，与 UI 上那批 worker 数量一致。

所以 `/clean` 在**释放记录的同一步**删掉该 worker 的缓存文件，对账也把它当作一层：

- **对账的输入是缓存目录本身，不是归档集合**（`purgeOrphanProjectionCache` / `orphanProjectionCacheIds`）。这一点是必须的：U2 让"删除记录后取消归档"，所以归档集合通常是**空的**，从它出发一个文件都清不到；枚举 `mission-<8 hex>.json` 才对得上现场。
- 删的条件与幽灵 id **共用同一条缺席判据**：该 id 在 `sessionQuery.listSessions()` 与 `sessionsRoot` **都查不到**才删；`sessionQuery` 不可读时**一条不动**（缺席未被证实）。仍在用的会话（含**运行中的 worker**）的缓存绝不触碰。
- 只认 `^mission-[0-9a-f]{8}\.json$` 形状的非 mission 文件绝不碰；文件/目录缺失或删除失败都只 warn，**绝不影响挂载与命令成功**；**不改**宿主的 `session_projcache.json` 索引（那是 storage domain 的文件，与宿主自身写入并发会打架）。
- 挂载时跑一次：只有在**确有可考虑对象**（缓存目录里有 mission 形状文件，或有 mission 形状归档标记）时才读语料库，否则直接跳过 —— 普通挂载的"零会话读"成本不变。

**为什么"删除"要自己动手**：harness 的会话持久化只有 `create`/`open`/`list`/`stat`，**没有 delete**，GUI 也只有归档。所以释放磁盘只能由本插件删目录，护栏写在 `src/workerSessions.ts`（缓存文件那一层在 `src/projectionCache.ts`）：

1. 只认本插件派出的 worker（claim id 形状 `mission-<8 hex>` + 头里 `origin: subagent`、`delegationDepth: 1`、`parentSession` 是本会话）；
2. 绝不动仍在运行的会话（结算后的 worker 没有 agent、也没有打开的写入者）；
3. **标记归档 → 删除 → 取消归档**：`/clean archive` 自己写归档标记，因此不再需要先跑 `/archive`；归档失败或有记录未归档的部署（无 registry）时**不删**；删成功后调 `unarchiveSession` 撤掉标记（失败只记日志，不回滚删除），挂载时再对账清掉历史遗留的幽灵 id 与投影缓存残留；
4. 目录必须**正好以 session id 命名**、且位于配置的会话根之下（`config.sessionsRoot`，默认 `<dsh home>/sessions`）；缓存文件必须是 `<config.projectionCacheRoot>/<id>.json`（默认 `<dsh home>/storages/session_projcache/sessions`）且名为 `mission-<8 hex>.json` —— 根给错时"什么都删不到"，而不是删错东西。

**孤儿任务树的判定是三态，不是布尔**（`MissionTree.orphanedTrees()`，`TreeDeps.probeOwner`）：

- `exists` —— owner 会话还在（含"有活 agent"这条短路）；树照常；
- `missing` —— `sessionQuery` 明确回答会话不存在：`MissionEngine.reconcileOrphans()` 在启动与每次 sweep 自动销毁（先 `interruptWorker` 再 `destroyTree`）；
- `unobservable` —— 宿主**答不上来**（例如 session 存储迁移拒绝一条旧日志、或没有挂 `sessionQuery`）：既不当存在、也**绝不销毁**（"说不清"不是"没了"；树可回收，被毁的任务不能），留给 `/clean orphans` 人工处理。

启动与 sweep 的对账只打**一条聚合报告**（`orphans: N tree(s) ... (unobservable: X, missing: Y); run /clean orphans`），不再每棵树一条 WARN；集合没变就不重复打。插件侧探针有 5 分钟 TTL 缓存，命令的清单与删除路径都**绕过缓存**重新探测。

## `/mission`

```
/mission                          列出本会话的任务树与状态汇总
/mission <任务描述>                用这段文字建一个根任务
/mission list   /mission ls           显式走列表模式
```

`/mission <文本>` 与 agent 调 `create_mission` 走**同一条路径**（同一个 `host.createWork`），所以配额、归属校验、派活、引导层、`pre-step` 门控全部一致，不需要模型参与。

约定：

- **多行输入**：第一行作标题，整段作描述；
- **标题行过长**（>80 字符）会被截断并加省略号 —— 标题在整棵树里都是"一行"的语义（任务链每层渲染一行），所以粘一整段不能把它撑开，完整文本仍在描述里；
- **不带 owner 分析**：斜杠命令没有"分析"可带，就不编一个；根节点的 `context` 为空，第一个执行者收到的 prompt 如实反映这一点；
- 被拒绝时（例如子 agent 会话不能建树）返回 `error` 结果并带上稳定 code，而不是抛异常。

## 任务时间戳（“什么时候开始、什么时候结束”）

节点上记三个时刻（语义与打点见设计文档 §2.1.1）：`createdAt`（受理，进入 `ready`）、
`dispatchedAt`（**第一次**派出执行者，进入 `running`；回收 / 重派 / 续跑都不改写）、
`endedAt`（进入终态）。派生三个时长（`packages/core/src/timing.ts`：`queueMs` / `runMs` /
`totalMs`，都钳到 `>= 0`），格式化在 **`timeFormat.ts` 一个模块**里，宿主半边与浏览器半边共用
（客户端 bundle 不能 import `mission-core`，所以它是一份**无依赖**的纯函数，而不是客户端自己抄一份）。

四个显示面 + 运行时通知，用的是同一句话：

```
等待中（受理 10-03 17:20）                                            # 还没派发
派发 10-03 17:21（排队 45s） → 进行中                                   # 已派发、未结束
派发 10-03 17:21（排队 45s） → 结束 10-03 17:23（耗时 2m10s）            # 已结束
等待中（受理 …，结束 …，未派发）                                        # 排队中被取消
```

| 显示面 | 位置 | 形态 |
|---|---|---|
| `list_missions` | `tools.ts` | 每个任务行尾 ` ｜ 派发 … → 结束 …` |
| `mission_result` | `tools.ts` | 头部状态行 ` ｜ 派发 … → 结束 …`；`data` 另带 `created_at` / `dispatched_at` / `ended_at` |
| `/mission` | `host.ts` `describe()` | 列表行尾同一句 |
| 任务面板 | `client/MissionTreeView.tsx` | 行上紧凑（`耗时 3m` / `起 10-03 17:21`）；弹窗标题下一行完整三时刻 `受理 … ｜ 派发 … ｜ 结束 …` |
| 运行时通知 | `host.ts` `notifyOwner()` | `任务 <id> 已结束（已完成）：派发 … → 结束 …` —— 这正是"跑完不知道什么时候结束"的原痛点 |

时间用**本地时区** `MM-DD HH:MM` + 相对时长（`45s` / `2m10s` / `1h5m` / `2d3h`），**不打印裸 ISO**；
文案中文（命令面板是中文界面）。旧记录 / 旧宿主缺字段时显示 `—`（`timingDetail`）或干脆不显示行上标记
（`timingBadge`），**绝不报错、也不显示 1970**。

**兼容性怎么证的**：两个字段在 `domain.ts` 里是 `.nullable().default(null).catch(null)`，
`DOMAIN_VERSION` 仍为 1；core 的 `normalizeLoaded` 也覆盖它们（`storedTimeOrNull`），所以
**裸记录路径**（store 直接给 core，不经 zod）同样读到 `null`。`test/domain_defaults_pin.spec.ts`
的字段表**从 `nodeSchema.shape` 派生**：新增带默认字段若不写进表就会让断言红——本字段就是被它
自动收进断言的。插件测试 `test/timing.spec.ts` 另有"旧记录缺字段 → `null` + 面板显示 `—`"的用例。
字段进 wire 的 `nodeSchema` / `detailNodeSchema` 时是**可选 + `default(null)`**：旧客户端收到新字段
不会炸（zod object 默认丢弃未知键），新客户端对旧宿主的缺字段显示 `—`。**未动
`SNAPSHOT_WIRE_VERSION`**：按既有规则它只跟 Remote **方法集**走，新增可选字段不 bump。

## 日志

插件**自己带一个日志出口**（`src/log.ts`），每一行都写两处：可见的一处走 stderr（宿主侧）或浏览器 console（客户端侧），另一处镜像进 `ctx.logger`。

原因是 DSH 的 `ctx.logger` 目前写的是**缓冲的 exporter**，行不会到终端 —— 对一个"整件事就是在后台跑引擎"的插件，这意味着"这一行挂上了吗"和"那个节点为什么一直没被派活"从外面完全无法回答。本机实测：`@avantf/mem-dsh` 的启动日志可见、而本插件改前的启动日志不可见，差别就在这里。

打点位置（都带 `[avantf-mission]` 前缀）：

| 时机 | 行 |
|---|---|
| `apply` 进入 | `mounting: config=… inject=…` |
| typert 注册后 | `typert host face registered (namespace avantfMission, 7 invocations: snapshot, detail, result, delete, cleanFinished, resolveExecutorSession, watch)` |
| 工具注册后 | `registered N tools: …` |
| 挂载收尾 | `mounted: /mission command, 9 tools (/archive, /clean), guidance context, pre-step gate` |
| 开存储域 | `start-up: opening the mission-tree storage domain` |
| 载入完成 | `start-up: loaded N tree(s), M node(s)` / 孤儿树销毁时 WARN |
| 引擎就绪 | `engine ready: capacity=… (source=…, reserved=…) concurrency=… depth=… failure-budget=… children<=…` |
| 每次变更 | `create_mission: root …` / `decompose_mission: … -> created […]` / `submit_mission: …` / `finish_mission: …` / `cancel_mission: …` |
| 派活与回收 | `dispatched <node> as <claim>` / `dispatch of <node> failed: …` / `sweep: reclaimed N node(s)…` |
| 唤醒 owner | `root <id> reached <status>; woke owner <session>`（owner 不在线时 WARN） |
| 卸载 | `unmounting` |
| 客户端挂载 | `client half mounting: …` / `Remote namespace mounted: …` / `registered the conversation.view seat: id=missions order=20` |

**刻意不打点的**：`agent/pre-step` 的每次放行/剔除/拒绝。它每步都跑（包括第一步之后的**空批次**），逐次打印会把上面这些真正的转折点淹掉；判断它为什么清空批次或拒绝请用返回的原因（`admitStep` 是纯函数，只回答"有没有只有 owner 能做的事"）。

## 设计要点

**引擎是程序，不是 agent。** 扫树、派活、回收全部是宿主代码，不花 LLM 调用。LLM 只出现在任务单元内部（执行、拆解、汇总）与 owner 的对话里。

**任务单元无状态、用完即弃。** 每次执行是一次新的子 agent 会话，prompt 只含任务链（各层仅 title + 一行背景）与当前节点的完整内容。执行者**从不等待、从不持有** —— 它的 prompt 里没有子任务进度，因为那正是诱导等待的信息。

**拆解由执行者做。** "为什么需要这个前提"只有尝试过的人知道，所以子任务的 `context`（拆解原因）由拆解者写入，并沿任务链向下传递。

**状态在树里。** `running` 节点的 `claimedBy` 记录持有者 session id，用于：活性判断（持有者还在吗）、结果写入校验（身份即凭证）、以及控制面（取消时该打断谁）。

**两个终态工具互斥靠状态机，不靠提示词。** 终态节点不可再拆解；**还有未终态子任务**的节点不可提交结果 ——
子任务全终态的那次派活正是汇总，它的两种合法结局就是"提交结论"与"继续拆解"，两方向都在树锁内按节点状态判定。

**回收不给模型工具。** 引擎自己就能判定"这次执行废了"：worker 会话消失（`subagent/end` 或每 60 秒的扫描按活性判定）、holder 仍 live 但**没有任何产出**超过 `staleMs`、或这一轮超过 `roundMs` 硬上限（默认 1 小时）—— 后两种会**先打断** worker 再回收，然后同一次扫描里重新派活。
模型看不到 worker 的进度（结果走树，不走进度流），所以它没有任何引擎没有的信息可供判断；一个手动回收工具只会多出一条"把健康节点打断、白烧一次失败预算、丢掉已有产出"的路径。曾有过的 `reclaim_work` 正是因此删除：
它既不打断在跑的 worker（比自动路径更弱），也没有任何测试覆盖。

**"跑了很久"与"卡住了"是两件事。** 判据是"多久没**产出**"，不是"多久没**事件**"：只有模型输出（`assistant/message`）、工具调用（`tool/call`）与工具结果（`tool/result`）才刷新 `progressAt`；其他事件（provider 的 `assistant/attempt`、路由快照 `request/header`/`request/context`、边界与提示词事件）只刷新 `activityAt`，证明会话对象还活着。于是有三种判定，按顺序：**完全没有事件**超过 `staleMs` → `stalled`（照旧扣 `failures` 并记 `stalls`）；**一直有事件但没有产出**超过 `staleMs` → `hung`（不扣任何预算）；**这一轮超过 `roundMs`** → `hung`（同样不扣）。`roundMs` 的兜底不看 `progressAt`，所以传输层把时间戳一直刷下去也拦得住 —— 这正是 2026-10-02 卡死 7.5 小时的那条盲区（实测 `progressAt` 始终是"+0 分"）。
记录来自旧版本时没有 `activityAt`：两个时钟都退回 `progressAt`，判定与旧版完全一致（加一条 `roundMs` 兜底）。

**`hung` 与 `stalled` 的预算语义不同，但共用同一套 owner 知会。** `stalled` 是"这个节点反复沉默"，扣 `failures`、记 `stalls`，到阈值会标 failed —— 那是节点的问题。`hung` 是传输层故障（provider 一直重试、流卡住），不是任务失败，所以**不扣 `failures`/`spawnFailures`、不进冷却、不记 `stalls`**；但它**不是无上限重试**（N2 修复）：每回收一次 `hungCount + 1`（**连续**计数，任一真实产出即清零，重新派发**不**清零），**每一次 `hung` 都打一条诊断日志**（`hung: worker on <node> … unproductive …`，否则"每次派发都卡在传输层"不可诊断），累计到 `maxHungsBeforeReport`（3）时命中 `isTroubledNode`，引擎走与 stalled **完全相同**的通道通知 owner（同一个 `notifyStalled` 回调、同一个 `isTroubledNode` 门槛、同一个 `stalledNotifiedAt` 持久标记，每节点至多一条消息）。`attempts` 照旧不回滚。

**回收只认"确实没了"。** 续期子会话是异步物化的：节点绑定与子 agent 注册之间有几十毫秒的窗口，这期间的 claim **算 live**（`startingClaims`）—— 否则一次落在窗口里的扫描会把正在启动的 worker 判成"消失"并重派，而第一个 worker 还活着、它的每次提交都被拒（实测：5 个节点的三级树跑了 **13 个 worker**，每个节点白烧一次 attempts）。启动结束后仍无活体，才按"消失"回收。

**卡死知会是节制的。** 首次停摆只记在节点上（`stalls`），引擎自己就恢复了，不值得占 owner 一轮；**同一节点第二次停摆**、或**这次停下来之后 attempts 就要用尽**时，才给 owner 一条消息（"没有进展 N 分钟，执行者已打断、任务重新排队 —— 第 N/5 次尝试"）。这条消息的"只报一次"靠节点上的 `stalledNotifiedAt` 持久化标记，和终态唤醒同源 —— 否则 60 秒一次的扫描会变成刷屏。

**刷新由引擎负责，不由面板猜。** 谁变了只有引擎知道，所以由它说：`watch` 是一个 `mode: 'stream'` 的 Remote 调用（harness 自己的 `session/control` 用同一种模式），引擎每变一次就往该 session 的每个打开的流里 yield 一帧，标签收到帧就重读快照。这样不需要固定频率轮询，也不需要从会话日志里"推断"树动没动。保留的两条兜底是：会话侧 revision（`useChat`/`useSession`，免费，能覆盖推送还没到的工具调用）和 5 秒 `timer`（宿主没有 `watch`，或流连着两次一帧都没给 —— 健康的流一定会先给一帧开场，所以"什么都没来"就是"这条流不能用"）；帧里只有一个 revision 号，权威数据永远来自 `snapshot`/`detail` 的读取。**详情按需读**：点开某一行才调 `detail`，因为一个结果最多 2 KB，而快照每次变更都要重读，通常关着的面板不该为它付钱；**读出来后在弹窗里按标签看**，形制照 DSH"设置"面板（遮罩 + 定宽卡片 + 左侧分区栏 + 右侧唯一滚动区），所以一份长详情既不撑高树，也不会把另一棵树顶出视口；**任务标题是弹窗的标题栏**而不是一个分区（连同节点 id/状态/派发次数/深度），因为它必须在切换分区时始终可见。**超过 2 KB 的结果点了才读**：`result` 是另一次按需调用，宿主把 spill 的文件读回来（这是它自己写的产物），面板就地展开全文并替换掉"开头那段"——因为开头本来就是全文的第一片。locator 仍留在屏幕上：它按契约是不透明的，`SpillStore` 只定义 `saveText`（明确写着没有 retrieval API），所以宿主只在它**是绝对路径**时读它，否则回一条原因——面板的按钮与降级文案都由这一点决定。`内容` 与 `上下文` 挨着但回答不同问题（**要达成什么** vs **为什么需要它**：前者是验收对象，后者是拆解者写的前提），两个分区各带一行说明；`拆解信息` 渲染的是 `note_mission` 留下的 `analysisNotes`（含最近一条写于第几次派发）—— 它是判活的那个全新会话唯一能看到前任推理的地方，此前只有引擎读得到。

**纠偏只有一个动作，后果由引擎承担。** `adjust_mission` 之后，引擎**自动作废该任务名下还没完成的子任务**（作废 = 标记失败 + 打断在跑的执行者，锁内原子完成），任务随即回到汇总轮按新方向重新规划；**已完成并交出结果的不受影响**。理由与 `reclaim_work` 被删除时相同：这是"方向变了"的机械后果，不是 master 需要记住的第二个动作 —— 多一个动词只会多出一种半成品状态（纠偏差了、旧方向的活还在烧模型调用）。因此模型面上没有 `cancel_subworks`；该能力保留为引擎自己的原语。

**纠偏记在 `NodeRecord.corrections`，并由任务链下传。** 不混进 `context`（那是拆解者写的"为什么存在这个任务"）：纠偏是 owner 对已派出去的活的指令，作者与生命周期都不同 —— 混在一起时任务链只渲染 `context[0]`，纠偏对任何后代都不可见。现在当前节点以独立的"纠偏:"块渲染，任务链逐层带出各层的纠偏，所以写在根上的纠偏会到达任何后代。取消子任务时**每个被改动节点的全部父节点**都要重算聚合状态（复用前提是共享的，否则另一个分支会永远卡在 `blocked`），并且取消写下的 `result` 必须同时置 `hasResult`、汇总块必须带子节点状态 —— 否则模型读到的是"（未提交结果）"加一句"都已完成"。

**纠偏不必"停下再重派"，而且只有一个动作。** 任务派出去后 master 停下，用户再开会话发现方向要改时，只需 `adjust_mission(root_id, adjustment)`：纠偏写进**根任务**的 `corrections`（持久、之后每次派发都带着，并经任务链下传到后代），若此刻有执行者在跑就直接投递给它；同一调用里引擎还会作废该任务名下未完成的子任务，让它立刻按新方向重新规划。**"记录 + 投递"两条都做**是必需的：根任务大半生在等子任务（没有持有者），而每次派发都是全新会话。作废只向下走（任务本身、父任务、兄弟任务都动不了），要结束整棵树用 `cancel_mission`。

**纠偏不只要写给执行者，还要写给查看者。** `corrections` 落库、进 prompt 只解决了"执行"这一半：面板的行与详情、以及 `mission_result` 当初只渲染 `title` / `description` / `result`，而标题是**创建时**的目标 —— 于是被纠偏过的任务读起来就是"目标 X、结果是 Y"，两者之间空无一物；纠偏虽然在库里，却没有任何查看面读它（`/mission` 的索引行也一样）。现在四个面都带上：快照的行投影（`NodeView`）带 `corrections`，行上渲染"已纠偏 N 次"标签、文本挂在 tooltip；`detail`（`NodeDetail`）在"任务内容"与"本任务提交的结果"**之间**给出完整"纠偏"块；`mission_result` 把纠偏列在结果之前、`data` 里再带一份；`/mission` 的索引行只报次数。**目标本身不改写**：纠偏是叠在原始目标旁边的历史，改写 `title`/`description` 会把"当初要什么"抹掉，而回溯要的正是这两者对照。行投影因此带上了一个不在"行必须轻"豁免之列的字段，判据是它在**折叠状态**下就必须可见，且文本短、条数少。

**模型可见文本已全部中文**，包括工具体内的**拒绝文案**（`节点 X 不是由你持有`、`任务 X 处于 执行中；还不能收尾`、`收尾前先用 mission_result 读根结果` 等）与工具返回、`/mission` 的列表输出；节点状态在两处共用一张中文表（`statusLabel`）。日志仍为英文（面向排查者）。

**用语：交出去的那件事叫"任务"。** "任务树"只指它被逐步分解之后的形态；工具名因此不带 tree（`list_missions` 列出你拥有的任务）—— 从 master 的视角只有任务。 模型可见文本里不再写"能在这一轮做完就别建树" —— 一件较独立的任务即使能在一轮里开始，交给引擎执行也是正当用法；判据落在"是不是一件可交出去的任务"（独立任务 / 要调研 / 多步 / 要跑一阵 / 逐步分解 / 碰多个文件或系统）。**owner 侧连内部形态也不给**：`list_missions` 只说一个任务还在跑、还是反复出过问题，`show_work`（逐个节点列出整棵树、带 `depth`/`attempts`/`result_ref`）已删除 —— owner 能做的两件事（`adjust_mission` / `cancel_mission`）都只吃根任务 id，看得见却动不了的层级没有存在的理由。

**模型可见文本一律中文，且只讲"做什么 / 怎么做"。** 四类文本都是：静态段（`avantf:mission-tree-guide`）、每轮的动态状态行（`avantf:mission-tree`）、worker 的派发 prompt、9 个工具的描述与参数说明。写法约束：**不写"为什么"** —— 不讲执行者看不到对话、不讲引擎为什么要重派、不讲隔离与配额的道理，只留判据（能不能连验收标准一起交出去）与禁令（不要轮询、不要替子任务干活）—— 参数怎么填交给工具的说明。工具名保持英文标识符（`decompose_mission` 等），因为那是模型必须原样调用的名字。

**工具面孔：每个 agent 只带自己那一半。** 一次注册、两套可见性：owner（顶层会话）看 `create_mission`/`adjust_mission`/`mission_result`/`list_missions`/`finish_mission`/`cancel_mission`，executor（任务单元）看 `note_mission`/`decompose_mission`/`submit_mission`。不做的话每个 agent 的 schema 都带着另一半用不上的工具，而且是"可见但必然被拒"（`create_mission`→`no-authority`，`note_mission`/`decompose_mission`/`submit_mission`→`not-owner`），并且 worker 能读到别的节点 —— 与"worker 的 prompt 不含兄弟进度"的设计意图冲突。机制分两半：executor 走派活请求的 `toolFilter.deny`（harness 给任何被委派子会话施加的同一个 scoped `restrict()`）；owner 在 `agent/created` 时对该 agent 施加 scoped 限制，并用组装瀑布按 `context.agent` 过滤 `assembly.tools` 兜底（`tools.restrict()` 只在 scoped context 上合法，全局限制会被 harness 直接拒绝）。**遮蔽不是授权**：边界仍是工具体内的拒绝，面孔只管模型看不看得见；测试里有一条"每个注册工具必须恰好落在一张面孔"的不变量。

**策略进系统提示词，机制留在工具描述里。** "什么时候该把活交出去"此前只写在 `create_mission` 的工具描述里 —— 工具描述讲机制，策略却要模型自己从工具清单里翻出来。现在它是一段静态 section（位次 `TOOL_JOBS`，与 `create_mission` 用同一个"能不能建树"的判据），讲三件事：**判据**（能不能连验收标准一起交出去，而不是复不复杂 —— 不需要拆的任务同样适合交给它，一次派发就做完；需要拆的就交给执行者拆出前置任务、由引擎逐级派下去）、**任务是什么**（跨会话持久化，由引擎逐级派给一次性执行者）、**边界**（任务树与"起一个子 agent 去干活"在"交出去"上重叠 —— 执行者是一次性的、跑起来联系不上、看不到对话，所以需要看见这段对话 / 需要来回追问 / 需要脚本化扇出的委派该用 `subagent` / `subagent_fork` / `workflow`；但"我已经想清楚了"不在排除之列），外加一句**写法提示**（交付长规格或长清单时先写进仓库里的文件、描述里指向它 —— 超长工具参数是已实测的失败源，`b273150`）。**刻意不写两组东西**：参数怎么填（`title` / `description` / `analysis` 属于工具的说明，同一个请求里就读得到，静态段不重复一遍），以及任务能不能包含某类内容（master 自己决定一件任务为了什么，读回结果是 `mission_result` 的事）—— 两条都有测试盯着。同一边界也写在 `create_mission` 的工具描述里。另四类从来没写过的（节点状态词表、`note_mission`/`decompose_mission`、id/存储/面板、读结论与收尾机制）在 `prompt.ts` 的注释和设计文档 §6.0 里各列了一次，并有禁用词表的测试盯着。

**对比度：文字一律用 label token，不用 opacity 调暗。** 之前用 `opacity` 做次级文字变暗，而归档树又叠了一层 `.avwf-tree-settled { opacity: .75 }` —— 两者相乘后，次级文字在亮/暗主题里只剩约 2.7:1 / 3.5:1，12px 小字实际读不了。现在：条目底色 `bg-layer-1`，正文 `label-primary`，次级文字（状态汇总、根 id、meta、上下文、详情标签）`label-secondary`；实测对比度 亮 `18.9:1` / `5.8:1`、暗 `15.0:1` / `10.4:1`，两套主题都过 4.5:1。归档不再整块变淡（`已归档` 标记已经说明了），改为虚线边框。状态是**色相**而不是文字色：`--avwf-status` 由状态类发布，只喂给圆点和徽标底色，徽标文字仍是 `label-primary`（状态色当文字在亮色主题下只有 2.3:1）。顺带修掉：样式里原来的 `--dsh-color-*` 在 DSH 设计平台里**根本不存在**（只有 `--dsw-*`），所以那几处颜色一直在用硬编码兜底值。

**条目的填充与文字色取自设计 token。** 树框的底色用 `--dsw-alias-bg-layer-1`、文字色用 `--dsw-alias-label-primary` —— 就是 `@avantf/mem-dsh` 的"记忆"条目用的那两个 token（由 shell 为明暗两套主题统一定义），所以两个标签读起来是同一块界面而不是外来控件；token 不存在时这两条声明在计算值阶段失效，退化为透明/继承，不会变成错的颜色。除颜色外没有改动条目样式（边框、圆角、间距、字号都还是本插件原来的）。

**面板对齐对话正文列，不通栏。** 根节点用 `width: 100%; max-width: var(--dsh-chat-content-width); margin: 0 auto`，也就是 `@avantf/mem-dsh` 的"记忆"页用的同一条规则与同一个共享属性（由 `ui-conversation` 的根发布、`ui-chat` 的消息列也以它居中），两个标签于是共用一个轴线与一个宽度；属性缺失时 `max-width` 在计算值阶段失效退化为 `none`（即回到通栏）。根节点不设左右内边距，因为"树框"本身就是条目，它的左右边界要落在"记忆"条目落的地方。

**列表是窗口化的，数据也尽量瘦。** 树的条数超过阈值（25 棵）时，面板按"棵树"窗口化渲染：滚动高度覆盖全部历史（画布按虚拟总高撑开），但真正挂载的只有视口附近的几棵（`@tanstack/react-virtual`，`overscan` 5，行高先估后量），这跟"轨迹"表用的是同一套机制、同一个库；不足阈值时走普通 flex 列，也就是视图测试覆盖的那条路径。同时，摘要只带**行上真正要用的字段**：一个节点的 `description` 不在摘要里（行从不显示它，全文走按需的 `detail`），因为这份摘要**每次引擎变更都要重传一遍**。

**展开的默认值跟着任务状态走。** 一个还在跑（或可执行/等待/中断）的节点默认展开 —— 它拆出来的子任务一出现就能看到；一个 `done` / `failed` 的节点默认折叠，于是一棵跑完的树收成一行，一条已经结束的分支不再压住还活着的部分。点击 twisty 存的是**覆盖值**而不是展开状态本身：所以"我手动展开过这一个"不会在它结束时被改回去，而没被点过的节点会一直跟着自己的状态走。

**删除的单位是整棵任务树，不是任务节点。** 面板上的按钮在**树**的标题栏（文案就是"删除"，作用域写在悬停说明里），不在行上：一次点击删掉这棵树、它的全部节点和它的存储记录。节点不是可删除的对象 —— 兄弟节点的前提、汇总的来龙去脉和树的身份都在同一条记录里，从一棵活的树里抠掉一个节点只会留下一个收敛不了的树。删除只接受**已经结束**的树（根为 `done` / `failed`）：还在跑的树归引擎管，提前结束它是 `cancel_mission` 的语义，所以按钮对活树可见但禁用、并在悬停里说明。**`finish_mission` 是另一种"结束一棵树"**：它保留记录并归档（面板里置灰显示"已归档"），删除则是把它整条移出列表；两者都作用于整棵树，区别只在留不留数据。删除不可恢复。**三个 owner 工具只认根 id**：`adjust_mission` / `finish_mission` / `cancel_mission` 拿到子任务 id 一律回 `not-root`（`finish_mission`/`cancel_mission` 原先按 ROOT 查表，会把"这不是根任务"说成「任务 X 不存在」）。

**一次独立核对（2026-09-23）修掉的四处。** 一件真实任务（拆成 4 个前置任务、汇总交出报告）挖出：① `no-caller` 九个工具都会产生、却不在 `RefusalCode` union 里（按 union 穷举的消费者会漏），已并入；② 纯空白文本能落库（`create_mission` 标题/内容、`submit_mission` 结果、`adjust_mission` 纠偏），补 `blank-text` 拒绝，**但分层不动** —— 工具层只拒空串、空白归引擎判，与 `note_mission` 的 `no-analysis` 同源，把 trim 塞进工具层的 `str()` 会让那些码失去可达的产生点（这一点被 `decompose-analysis.spec.ts` 的一条测试当场拦下）；③ "反复出过问题"的三个渠道口径不一，抽成 `isTroubledNode` 唯一判据并给"连续起不来执行者"补上 owner 提醒；④ `finish_mission`/`cancel_mission` 对子 id 回 `not-root`。

## 关键参数

| 项 | 值 |
|---|---|
| 树深度上限 | 8（根为第 1 层） |
| 单次拆解子任务数 | 至多 6 |
| 单树节点上限 | 200（`decompose` 提交前校验；只数本次新增的节点，复用已有前置任务不计数） |
| 并发任务单元 | CPU 核心数 - 1（可配）；按已绑定节点计数 |
| 产出窗口 | 30 分钟（可配 `staleMs`，下限 1 分钟）；按 worker 最后一次**产出**（模型输出 / 工具调用 / 工具结果）起算，超时先打断再回收为 `stalled`（完全无事件）或 `hung`（有事件无产出，不扣预算） |
| 轮级上限 | 1 小时（可配 `roundMs`，下限 10 分钟且不低于 `staleMs`，否则低于产出窗口会在 `stalled` 之前触发）；从进入 `running` 起算的墙钟硬上限，超过即回收为 `hung`，不看进度时间戳、不扣预算 |
| 失败预算 `failures` | 5（worker 被回收才 +1，达阈值标 failed；成功的提交与拆解，含汇总轮，都不消耗） |
| 启动失败预算 `spawnFailures` | 5（派发即失败才 +1，按 `30s × 2^(n-1)`（上限 10 分钟）退避后重试；成功启动即清零；达阈值标 failed） |
| 连续卡住计数 `hungCount` | 3（每次 `hung` 回收 +1，任一真实产出即清零；累计到 3 命中 `isTroubledNode`，走与 stalled 相同的 owner 知会通道） |
| 卡死知会 | 同一节点第 2 次停摆，或卡住计数达上限，或停摆后失败预算将用尽（`failures ≥ 4`）时给 owner 一条消息，每节点至多一次 |
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

- **worker 的内部扇出是允许的，只有 `send_message` / goal / 六个 owner 工具被摘。** deny 列表是 `send_message` / 三个 goal 工具 / 六个 owner 工具；`subagent` / `subagent_fork` / `workflow` / `ralph` 都不摘 —— 起子 agent 是节点内部的手段，树只认节点与结果，所以「引擎是唯一派活者」只在树这一层成立。代价如实记录：worker 自发的子 agent 不在树上、结果不回填节点、失败无人回收、递归也绕开节点配额（`CAPACITY.maxNodesPerTree = 200` 只保证树这一层有天花板）；失去的是归因与可观测性。口径与 2026-09-20 / 2026-10-10 两次决定见设计文档 §5.4.1。
- **工具面按运行时裁决收窄，而不是按预检。** `toolFilter` 由运行时的 `tools.restrict()` 校验，而它能接受的名字集合与"父 agent 可见的名字集合"并不相等：子 agent 继承的是**父 agent 所在 preset 的组合**（`agentPresets.composeFrom` 把子作用域挂到 preset 的 mount scope），**不是父 agent 自己的作用域**。因此按 agent 平面注册的工具（例如 `tool-subagent` 在启用 standing `modelSelectionSettings` 时按 Agent 安装的 `subagent`）对父可见、对子不可继承，`restrict()` 会拒绝**整个** filter。本插件的对策：首次 `startContinuable` 失败且错误来自 `tools.restrict()` 时，**从名单里去掉被点名的工具并重试一次**（只失去那一个工具的隔离，而不是让整棵树因为派活失败烧完 attempts）。要完全避免，需要上游把这类工具注册到 preset 作用域。
- **worker 会读到 `dsh-tool-goal` 的目标指引，但没有对应工具**（仅当该部署挂载了 goal 工具时）。 该插件的 `tool:goal` 段落是静态文本、不做作用域判断，而 worker 会加入 owner 的 preset 组合。无法从第三方插件干净遮蔽：同名段落会连 owner 一起替换，而它不导出自己的指引文本。工具面本身按部署收窄（deny 只列部署真实注册过的名字，未知名字会让 `tools.restrict()` 直接抛错）。后果有界（worker 调 goal 工具会以 `UNKNOWN_TOOL` 失败，且 `requireDirectHuman` 本就拒绝它），浪费一个回合而已；正确修法在上游——把那段改成 `(context) =>` provider，在工具不可见的作用域返回空串（`dsh-plan-mode` 的 `plan:policy` 就是这个写法）。

## 看运行情况（诊断）

```bash
pnpm workers:usage                    # 全部 worker 会话：工具使用直方图 + 越权/扇出尝试 + 失败调用
pnpm workers:usage -- --tree <root>   # 只看某棵树的节点
pnpm workers:usage -- --strict        # 出现"调了不存在的工具"就非零退出（用于 CI/巡检）
```

每个任务单元都是一次真实会话，所以**策略问题可以直接从落盘的会话里读出来**：worker 有没有伸手去够不该有的工具（`send_message` / goal 工具）、有没有把该走树的结果改走消息、有多少次派活白烧在一个错误上、某个节点当年花了几个 worker。§"已知限制"里内部扇出的口径，就用它决定 —— 只读，不改任何东西。

## 环境初始化（`@avantf/dsh-plugin-base`）

插件挂载的第一步不是注册工具，而是**把环境准备好**——交给家族底座 `@avantf/dsh-plugin-base`（普通运行期依赖，区间 `>=0.3.0 <1.0.0`，**装插件即自动带上**；本仓另在 `devDependencies` 里声明逐字相同的范围，并由根 `pnpm-workspace.yaml` 的 `linkWorkspacePackages: true` 链到本地 `base/`）。底座**一个包**里装着启动期环境初始化框架与宿主兼容门禁（从前独立的 `@avantf/dsh-envinit` / `@avantf/dsh-compat` 已并入它，且不再发新版本）。时序固定为：

```
内联 bootstrap（解析底座 → 动态 import() → 校验 supportedRange）→ 接口门禁（底座判 verdict）→ 跑挂载前检查（兼容门禁）
```

- **它要准备什么**：不再有 item 清单，也**没有 `mission:compat`**——门禁就是底座本身。本插件像记忆插件一样注册手写的 Typert wire face，有同一个运行时错配风险：契约挪了以后**挂载成功**，然后在某个 remote 调用里炸，报错里没有版本信息，所以启动时用底座自带的规则 / 探针 / 复查跑一次门禁。
- **底座怎么被找到**：内联 bootstrap 用 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` 从**插件自己的依赖树**解析（正常就是 `node_modules/@avantf/dsh-plugin-base`），再动态 `import()`；版本不在内联 `supportedRange` 内 → 一条 `envinit: WARNING`，插件**照常挂载、降级**。绝不静态 `import` 底座、绝不 bundle 底座：静态 import 会在底座缺席时让整个插件模块加载失败。
- **唯一内联件是 bootstrap**：本插件是 `tsc` 直出（没有打包器），所以底座构建产物里的零依赖单文件 `bootstrap.js` 被**拷进产物**、按相对路径 import。`scripts/build.mjs` 负责拷贝并断言它与**安装的**底座同版本。底座本包是插件的**普通运行期依赖**（`dependencies` 里两棵树逐字相同的宽区间；另有同区间 `devDependencies` 让本仓 pnpm 链到本地 `base/`），且**不得被静态 value import**——坏树时静态 import 会先于 bootstrap 抛错，插件连"解析底座并留下 WARNING"这一步都做不到（`pack-plugin.mjs` 断言这两条）。
- **拿不到就降级，不拒载**：底座不可解析 → 一条 `envinit: WARNING`，插件照常挂载（工具、服务、prompt 段、Remote face 全注册），门禁跳过并退回 legacy provisioning；门禁包装不上或门禁本身跑不起来，同样 WARNING 后继续。**接口世代不匹配也一样**：插件 bake 的 `INTERFACE_VERSION` 与加载到的底座报出的不同（区间内但另一世代）⇒ 一条 `WARNING` 且**不使用底座的共享能力**（prompt 层退回本插件内置正文、门禁跳过），走的正是"底座拿不到"那条降级路径，仍**照常挂载**；`cannot-tell`（老底座没有 `checkInterface`/`readInterfaceRequirement`、bake 缺失/畸形）⇒ 只告警、照常使用。判定语义不变：只有**被证明的破坏**（`probe-failed`）才拒载，"无法判定"只是 note，版本差异只是 warning，绝不抛错。
- **共享逻辑从底座运行时取**：兼容门禁规则/探针/复查、envinit provisioner、prompt 文件层 `PromptFiles`、以及本插件的数据根解析 `resolveDataHome`，都在运行时从动态 import 的那份底座上取用——所以修这些共享逻辑**只需发一次底座**，不必重建插件产物。仍留在插件里、改它们**需要发插件**的是：`typert` `strict` wire codec 与端点/字段/结果符号字面量（照抄宿主约定的两三行，描述符在模块加载期组装），以及本插件自己的 logger 与底座缺席时的 fallback 默认参数。底座 kit 另外导出 `familyHome`、`familyToolsDir`、`familyModelsDir`、`expandHome` 等，插件可在运行时取用；`createPluginLogger` 已随接口 v3 移出 `.`、进了不承诺兼容的 `./internal`，两棵树因此各自持有自己的 logger。改 `base/**` 里的共享代码后，两个插件的完整门禁都要重跑（mission：`pnpm release:check` + mount-smoke；mem：`pnpm build:dsh` + `node scripts/mount-smoke.mjs`）。
- **异步那一档**：`startup: 'background'` 的项由框架派发、不占挂载预算，完成时回调 `onSettled` 再做后续；本插件的门禁是 blocking，加项不改代码。
- **家目录**：族根 `home` = `$AVANTF_HOME`，默认 `~/.avantf/env`；锁、状态都在它下面。任务树与 worker 日志**不在这里**（前者走宿主 `ctx.storageDomain`，后者在 `~/.dsh/sessions`）。

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
