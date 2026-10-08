# @avantf/dsh-mission

DSH（DeepSeek Harness）原生**任务树**插件：把一件能连验收标准一起交出去的事交给引擎，由它在后台
逐级派给一次性执行者；执行者发现自己缺前提时**自己**拆出前置任务，前置任务全部收尾后父任务重新可
执行，直到根任务收敛。

引擎是宿主代码，扫树、派活、回收都不花模型调用；模型只出现在任务单元内部（执行、拆解、汇总）和
owner 的对话里。

## 主要功能

- **9 个模型工具**，按 agent 分成两张面孔：
  - owner（顶层会话）6 个：`create_mission` / `adjust_mission` / `mission_result` / `list_missions` /
    `finish_mission` / `cancel_mission`
  - executor（任务单元）3 个：`note_mission` / `decompose_mission` / `submit_mission`
- **一段静态系统提示词段**：什么时候该把活交出去 —— 判据是"能不能连验收标准一起交出去"，
  不是复不复杂。
- **一段引导上下文**：每轮把本会话任务树的状态写进 owner 的 prompt。
- **一个 `agent/pre-step` 钩子**：过滤 worker 结算通知，决定某一步带什么进模型。
- **三条命令**：
  - `/mission`：列出本会话的任务树；后面跟文本则用这段文本建一个根任务；
  - `/archive`：把本会话**已完成**的 worker 会话标记为归档（只标记，不释放磁盘）；
  - `/clean`：释放磁盘、清理已完成任务树或孤儿记录，三个作用域 —— 无参数只列不删。
    **先分清两层，别清错对象**：`archive` 清的是 worker **会话记录**（`$DSH_HOME/sessions` 下的真实日志），
    `missions` 清的是**任务树**（本插件存储域里的记录）——两者互相独立：删掉会话日志不会动任务树，
    删掉任务树也不会动会话日志。所以本会话只有已关闭任务树时，`/clean archive all` 会回一句
    「没有可清理的 mission 会话」并**在末尾指路**「另有 N 棵已关闭的任务树可清理：/clean missions all」，
    无参 `/clean` 总览与 `/archive` 同样会在某一层为空、另一层有内容时给出这句跨作用域指引。
    `/clean archive all` 一趟清理本会话所有**已完成**的 worker 会话记录，走**三步**：
    **标记归档 → 释放记录 → 取消归档**（最后一步失败只记日志，不会把已删的记录找回来）；
    释放记录的同时**删掉它的投影缓存残留**（`<dsh home>/storages/session_projcache/sessions/
    <mission-id>.json`）——宿主保留已释放会话的投影缓存且没有驱逐 API，不删它子智能体列表就还会
    把那一次派活显示出来；输出把两个数字分开报：「释放会话记录 N 个 / 清理残留投影缓存 M 个」；
    `/clean archive <mission-xxxxxxxx>` 只清一个（同样三步）；**运行中的 worker 永不触碰**，
    要清它得等它结束；
    除手动清理外，插件还会**自动按数量保留**：每个属主会话最多留**最新 10 个已完成**的 worker
    （配置项 `keepWorkers`，默认 10；按会话头的 `createdAt` 降序，越新越保留），挂载时与每轮后台
    sweep 都会把超出的、更旧的已完成记录按同一套三步链路释放。**正在执行的 worker 不占名额、
    永不被清理**——所以「保留 10」= 保留最新 10 个**已完成**的（13 个已完成 + 4 个在执行 → 释放
    3 个；3 个已完成 + 8 个在执行 → 一个都不释放）。`keepWorkers: 0` 表示**关闭自动保留**
    （保留全部），**不是**"一个都不留"。`/clean` 清单把两组分开报：
    「已完成 worker：X 个（保留最新 10 → 可自动清理 Y 个）」与「正在执行：Z 个（不计入保留名额、
    不会被清理）」。**自动保留 vs 手动全清**：前者是后台按数量释放，后者 `/clean archive all`
    不受保留数限制，一次释放本会话所有已完成的 worker 会话记录；
    清单把「已完成未归档」与「已归档但记录已不在（幽灵）」分开显示：幽灵是历史遗留的归档标记
    （记录已释放、标记还在），挂载时与 `/clean archive all` 都会对账取消归档；
    同一次对账还会**以投影缓存目录为输入**（不是以归档集合为输入——记录释放后会取消归档，归档集合
    通常是空的），只删"会话语料库与会话目录**都查不到**该 id"的 `mission-*` 缓存文件，否则子智能体
    列表会一直显示那些已经删掉的会话；
    `/clean missions` 列出本会话**已收尾**（`finish_mission`，即已关闭 / 已归档）的**任务树**，
    `/clean missions all` 一次删掉它们，输出「已清理 N 棵已完成任务（跳过 M 棵仍在进行）」并逐个列出根 id。
    **只删任务树记录，不动 worker 会话记录**——两者是不同的层：任务树是本插件在存储域里的记录，
    由 `finish_mission` 关闭、由 `missions` 作用域批量删除；worker 会话记录是 `$DSH_HOME/sessions`
    下的真实会话日志，由 `archive` 作用域（先归档再释放）处理。判据是**已关闭**（`closedAt` 非空）：
    还没 `finish_mission` 收尾的任务树**一律跳过**并单列「未收尾（仍在进行或尚未收尾）」，
    绝不批量删除；要单独删一棵（含已完成未收尾的）用「任务」面板上那棵树的「删除」按钮。
    `missions` 只接受 `all`（单棵删除是面板的手势）；
    `/clean orphans` 列出 owner 会话已不存在或不可观测的任务树，`/clean orphans all` 或
    `/clean orphans <root-xxxxxxxx>` 清理它们（删除前会重新探测 owner，期间恢复的树会跳过）。
- **一个「任务」标签**：会话视图条里排在「对话」「轨迹」之后，树形展示本会话的任务树；引擎一变就把
  变更推给标签，点开某一行才按需读该任务的详情，并在弹窗里按「内容 / 上下文 / 拆解信息 / 纠偏 /
  结果 / 子任务」分区查看（任务标题就是弹窗标题；每个分区前有一行说明它装什么；上下文 / 拆解信息 /
  纠偏 / 子任务都是一条一个框；结果超过 2 KB 时节点只留开头，点「查看完整结果」把全文读回来就地展开）。
  **节点 id 本身就是入口**：记录上已有执行者会话句柄时，点它直接打开那个会话（标明进行中 / 已结束）；
  历史记录没有句柄时，点击的那一刻才去查找（渲染期不读任何会话日志），命中就打开，找不到 / 从未派发 /
  宿主不支持会各自给一句原因，而不是一个点不动的死链。**句柄指向的会话已被保留策略回收**时不再跳转，
  直接说明「可能已被清理」——不会跳进一个读不出历史的空会话。
  **标签上的状态点**：**当前这个会话**有任务在执行时显示 `任务 ●`，空闲时逐字 `任务`；它跟随你正在看的
  会话（别的会话在跑不会点亮你这里），切换会话后随即更新。
  标签顶部还有一个**「清理已完成」**按钮（二次确认），一次删掉本会话全部**已关闭**的任务树——与
  `/clean missions all` 同一条宿主调用；没有已关闭的任务树时按钮禁用并说明原因，本会话没有任务树时
  按钮不出现。

执行者**从不等待、也不持有**子任务的进度：结果走树，不走进度流。所以 owner 侧的 `list_missions` 只说
一件任务还在跑、还是反复出过问题，不报它内部被拆成了什么。

### 你会看到什么：时间

跑久了最想知道的是"这件事什么时候开始、什么时候结束"。每个任务节点都记**受理**（进入待执行）、
**第一次派发**、**结束**三个时刻，四个地方都会显示，用的是同一句话（本地时区 `MM-DD HH:MM` +
相对时长，中文）：

| 你在哪看 | 看到什么 |
|---|---|
| `list_missions` | 每个任务行尾多一段：`派发 10-03 17:21（排队 45s） → 结束 10-03 17:23（耗时 2m10s）` |
| `mission_result` | 结果头部同一段；`data` 里另有 `created_at` / `dispatched_at` / `ended_at` 三个原始时刻 |
| `/mission` | 列表行尾同一段 |
| 「任务」面板 | 行上紧凑显示：已结束的任务是 `耗时 3m`，在跑的是 `起 10-03 17:21`；点开详情的弹窗里是完整三行 `受理 … ｜ 派发 … ｜ 结束 …` |
| 任务结束时的通知 | 属主收到的唤醒消息从「任务 XXXX 已结束（已完成）。」补成「任务 XXXX 已结束（已完成）：派发 … → 结束 …（耗时 …）。」——不用再翻面板就知道它跑了多久 |

还没轮到的任务显示 `等待中（受理 …）`（容量是**派发**闸门，受理后可能等很久），排队中被取消的显示
`未派发`。**排队时长**是"受理 → 第一次派发"，**执行时长**是"第一次派发 → 结束"；重试、回收、续跑都
不会改写"第一次派发"那个时刻。旧版本写下的记录缺这两个时刻时显示 `—`，不会报错、也不会显示 1970。

## 接入 dsh

```bash
# 1) 装这两个包：插件本身，以及家族底座。底座是插件的 peer；不开 autoInstallPeers 的包管理器
#    （pnpm / yarn）不会跟着装上，所以要显式装。
#    版本号建议写死：pnpm ≥ 10 的 minimumReleaseAge 会避开刚发布的版本，解析到的旧版本可能不认识
#    当前宿主（它的 peer 区间不含这个 dsh），那一单会被宿主的安装门禁直接拒绝并把 profile 回滚。
dsh plugin --profile <PROFILE> add @avantf/dsh-plugin-base@<version>
dsh plugin --profile <PROFILE> add @avantf/dsh-mission@<version>
```

```yaml
# 2) 挂载插件：装完通常什么都不用做。
#
# 本包声明了组合包（dsh.bundle.patch → 随包的 cordis.patch.yml），所以 `dsh plugin add` 装它时会
# 顺手把这个包选进 profile 的 dsh.profile.bundles（实测），挂载行由随包的 patch 插入；DSH Desktop
# 的「插件」页走的也是这条。只有两种情况才需要自己写那一行：
#   · 用 npm / yarn 装（它们不认识 dsh.profile.bundles）；
#   · 手工编辑 profile 的包清单，而没有把本包选进 bundles。
# 两条路都做也不会挂两次：当前 dsh（0.1.7 / 0.2.0 线）的 loader 按条目 id 去重，只挂载一次（实测）；
# 但 0.1.5 线（仍在本包 peer 区间内）上重复的行 id 会让 profile 树加载失败——所以始终二选一。
#   · 前提：自动选中只在 `dsh plugin add` **跑完**那一刻发生。若它中途被构建提示（pnpm 的
#     approve-builds）拦下（ERR_PNPM_IGNORED_BUILDS、非零退出），依赖装上了但组合包**不会被选中**，
#     事后再 add / install 也不会补选——先答完提示再装，或到 DSH Desktop 的「插件」页启用这个组合包。
#
# 手写的那一行，放在 ~/.dsh/profiles/<PROFILE>/cordis.patch.yml（不存在就新建）：
- insert:
    - id: avantf-mission
      name: '@avantf/dsh-mission'
      config:
        maxConcurrent: 6      # 槽位数上限（同时最多几个任务单元）；省略 = CPU 核心数 - 1
        # capacity: 8         # 容量闸门（核当量）；省略 = availableParallelism - 1（夹取 1..64）
        # capacityWaitMs: 300000  # 容量排队多久后预约整机（毫秒，默认 5 分钟，下限 1 分钟）
        # minFreeMemoryBytes: 268435456  # 空闲内存下限，低于它先不派新任务（默认 256 MiB，0 = 关闭）
        # staleMs: 1800000    # worker 多久没有任何进展算卡死（毫秒，默认 30 分钟，下限 1 分钟）
```

```bash
# 3) 重启 dsh（宿主半边在启动时 import 一次；浏览器半边刷新页面即可）
dsh web
```

### DSH Desktop

Desktop 用的是同一套 profile（profile 名 `desktop`），差别只有三点：

- **界面上只能装组合包**。Desktop 的「插件」页与 `plugin_manager` 只接受声明了 `dsh.bundle.patch`
  的包（本包已声明）：在页面上装它，它会把这个包选进 `dsh.profile.bundles`，并应用随包的
  `cordis.patch.yml`——不用手写挂载行。
- **用它自带的 dsh**：`<安装目录>/resources/runtime/cli/bin/dsh.cmd`（或在设置里把 `dsh` 装进 PATH）。
- **重启应用**才生效：Desktop 的宿主半边与浏览器半边一起启动。

`/archive` 与 `/clean` 读的 worker 会话目录取 `$DSH_HOME/sessions`（未设置时 `~/.dsh/sessions`），
Desktop 会显式设置 `DSH_HOME`，所以两边指向的是同一个会话库。

- `@deepseek-ai/*` 与 `zod` 由宿主提供（profile 上层的运行时解析表）。`zod` 与家族其它插件一样声明为
  **required peer**（`>=4.4.3 <5`）：存储域的记录 schema 由它校验，宿主那一份必须是唯一一份。
  **不要在 profile 里再装** `cordis` / `schemastery` / `zod` —— 第二份对象身份会让存储域的校验器
  拒绝本插件写入的记录。

## 怎么用

一次典型用法：

```text
/mission 把 X 改成 Y；验收：Z 命令能过
```

1. 引擎把根任务派给一个**一次性执行者**（新会话，prompt 只含任务链与当前节点的完整内容）。
2. 执行者发现缺前提 → `note_mission`（写下这次的分析）→ `decompose_mission`（拆出前置任务，并写明每一项
   "为什么需要"）。
3. 子任务全部终态后父任务重新可执行；这一轮的两种合法结局就是 `submit_mission`（交结论）与继续拆解。
4. 根任务 `done` 时 owner 被唤醒：`mission_result` 读结论，`finish_mission` 收尾（保留记录并归档）。
5. 方向要改 → `adjust_mission(root_id, adjustment)`：纠偏写进根任务并沿任务链下传，同时作废该任务名下
   未完成的子任务；整棵树不要了 → `cancel_mission(root_id)`。
6. 全过程可以在「任务」标签里跟着看；已结束的树可以在那里删除（一次删掉整棵树）。

也可以用命令而不是让模型决定：

```text
/mission                                  # 看本会话的任务树
/mission 跑一遍全量回归，验收：CI 绿        # 用这段文本建一个根任务
/clean missions                           # 列出本会话已关闭（可批量清理）的任务树，只列不删
/clean missions all                       # 一次删掉本会话全部已关闭的任务树（未收尾的跳过并报原因）
```

## 配置与数据

- **配置项**：`capacity`（容量闸门，核当量；默认由 `os.availableParallelism()` 派生并预留 1 核）、
  `maxConcurrent`（槽位数上限）、`capacityWaitMs`（容量排队多久后预约整机）、`minFreeMemoryBytes`
  （空闲内存下限，低于它先不派新任务）、`staleMs`（多久没有进展算卡死）、`roundMs`（单轮派发的墙钟
  上限，默认 1 小时，下限取 10 分钟与 `staleMs` 中的较大者）、
  `sessionsRoot`（worker 会话目录根，默认 `<dsh home>/sessions`）、
  `projectionCacheRoot`（宿主投影缓存目录，默认 `<dsh home>/storages/session_projcache/sessions`；
  `/clean` 只删其中形如 `mission-<8 hex>.json` 的文件）、
  `keepWorkers`（每个属主会话自动保留的**已完成** worker 数，默认 **10**；按 `createdAt` 降序保留
  最新的，正在执行的不占名额、永不清理；设为 **0** 关闭自动保留 = 保留全部）、
  `dataHome`（avantf 数据根，默认 `$AVANTF_HOME`，否则 `~/.avantf`；本插件只用其 `prompts/` 子目录）。
  容量是**派发闸门**：装不下只会排队，绝不拒绝；「任务」面板会显示每个排队中的任务在等什么
  （`mission_result` 只在任务终态可读 —— 排队中的任务不是终态，所以那条通道读不到等待原因）。
- **提示词文件**：`<数据根>/prompts/mission-tree-guide.md` —— 决定"什么时候该把活交出去"的那段静态
  提示词正文。缺失或为空时插件写入内置默认，**只在启动时读一次**，改完重启 dsh 生效；同目录下
  mem 插件的 `mem-*.md` 与本插件无关（各自只碰自己前缀的文件）。未装底座时退回内置默认正文，且不往
  磁盘写文件。
- **数据**：任务树走 DSH 存储域（`avantf_mission`）；每个任务单元都是**真实会话**，日志在
  `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）下，投影缓存在
  `$DSH_HOME/storages/session_projcache/sessions`（默认 `~/.dsh/storages/...`）下。`/archive` 只改
  归档标记、不释放磁盘；`/clean archive all` 一趟完成三步「标记归档 → 释放记录 → 取消归档」并在释放
  记录时一并删掉它的投影缓存残留（运行中的 worker 要等它结束）。
  自动保留（`keepWorkers`，默认每属主会话保留最新 10 个已完成）用**同一条三步链路 + 清缓存**，
  在挂载时与每轮 sweep 释放超出的旧记录；`keepWorkers: 0` 关闭它，`/clean archive all` 的手动全清
  不受保留数限制（两者的区别见上文 `/clean` 一节）。
  归档标记是释放记录的授权，记录没了它就该被取消；遗留的标记（幽灵 id）会在挂载时与
  `/clean archive all` 对账清理 —— 只对 `mission-*`、且会话语料库与会话目录都查不到的 id 动手。
  同一趟对账还清**投影缓存残留**：宿主保留已释放会话的投影缓存且没有驱逐 API，所以本插件在释放记录时
  把它删掉；对账以缓存目录本身为输入（归档集合通常是空的），只删"语料库与会话目录都查不到"的
  `mission-*` 缓存文件，**仍在用的会话（含运行中的 worker）的缓存绝不触碰**。

### 存储域打不开时：降级挂载，绝不带崩宿主

存储域（`avantf_mission`）打不开 —— 后端被占用、损坏、磁盘只读等环境故障 —— 时，插件**照常挂载**：

- 终端里是**一条 ERROR**，写明打不开的原因；
- 9 个工具、3 条命令、提示词段都照常注册，但每个工具都不执行，只返回**"任务引擎未就绪（存储域未能
  打开）：<原因>，修复后重启 dsh 即可恢复"**；`/mission` 也用同样的原因报告；
- **不会**留下未处理的 Promise 拒绝，**不会**把 dsh 进程带崩（未处理拒绝在 dsh 里是整代 fatal）。

理由：存储域打不开是**环境**故障，不是插件与宿主不兼容。旧行为把它一路抛成未处理拒绝，一次存储抖动
就会 `exit(1)` 带走整个 dsh —— 而这与"插件缺了底座也要完整挂载"的家族规矩相反。修复存储后重启 dsh
即可恢复；期间插件是"挂着的诊断面"，不是坏行。

## 升级 / 卸载

```bash
dsh plugin --profile <PROFILE> add @avantf/dsh-mission@<version>   # 升级到某个版本
dsh plugin --profile <PROFILE> remove @avantf/dsh-mission          # 卸载
# 再清掉挂载项：B 路（手写的行）删掉 cordis.patch.yml 里那段 `- id: avantf-mission`；A 路（组合包）
# 把包名从 profile 的 `dsh.profile.bundles` 里去掉即可，或在 DSH Desktop 的「插件」页上卸载。
# 然后重启 dsh。
```

## 环境要求

- **Node `>=22.15.0 <23 || >=23.11.0`**、**pnpm**
- **没有第三方运行时依赖**：只 import 宿主以 peer 提供的 `@deepseek-ai/*` 与 `zod`，以及安装时随插件
  一起装上的底座 `@avantf/dsh-plugin-base`
- 插件自包含：任务树引擎在构建时已内联进宿主入口，安装不需要额外的家族包

## 从源码构建

构建只对着**已安装的全局 dsh**（`npm i -g @deepseek-ai/dsh`），不需要 harness 源码；在仓库根执行：

```bash
pnpm install
pnpm build:dsh mission     # 编译两半（tsc + esbuild → lib/index.js + lib/client.js）→ 真实 Cordis 挂载冒烟
pnpm pack:plugin:mission   # 打包成"用户安装的那一个包"（断言引擎已内联、无 link:/file: 残留）
```

`pnpm build:dsh mission` 的旗标：`--skip-link`（完全不碰软链）、`--no-verify`（跳过挂载冒烟）。

## 许可

MIT。
