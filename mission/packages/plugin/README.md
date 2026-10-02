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
  - `/clean`：释放磁盘或清理孤儿任务树，两个作用域同形 —— 无参数只列不删，删除必须给 `all` 或具体 id：
    `/clean archive all` 清理本会话所有**已归档**的 worker 会话记录，`/clean archive <mission-xxxxxxxx>` 只清一个；
    `/clean orphans` 列出 owner 会话已不存在或不可观测的任务树，`/clean orphans all` 或
    `/clean orphans <root-xxxxxxxx>` 清理它们（删除前会重新探测 owner，期间恢复的树会跳过）。
- **一个「任务」标签**：会话视图条里排在「对话」「轨迹」之后，树形展示本会话的任务树；引擎一变就把
  变更推给标签，点开某一行才按需读该任务的详情，并在弹窗里按「内容 / 上下文 / 拆解信息 / 纠偏 /
  结果 / 子任务」分区查看（任务标题就是弹窗标题；每个分区前有一行说明它装什么；上下文 / 拆解信息 /
  纠偏 / 子任务都是一条一个框；结果超过 2 KB 时节点只留开头，点「查看完整结果」把全文读回来就地展开）。

执行者**从不等待、也不持有**子任务的进度：结果走树，不走进度流。所以 owner 侧的 `list_missions` 只说
一件任务还在跑、还是反复出过问题，不报它内部被拆成了什么。

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
# 两条路都做也不会挂两次（loader 按条目 id 去重，实测只挂载一次），但配置里会多一行冗余——二选一。
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

- `@deepseek-ai/*` 与 `zod` 由宿主提供（profile 上层的运行时解析表）。
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
/mission_result n0007                     # 读某个任务的完整结论
```

## 配置与数据

- **配置项**：`capacity`（容量闸门，核当量；默认由 `os.availableParallelism()` 派生并预留 1 核）、
  `maxConcurrent`（槽位数上限）、`capacityWaitMs`（容量排队多久后预约整机）、`minFreeMemoryBytes`
  （空闲内存下限，低于它先不派新任务）、`staleMs`（多久没有进展算卡死）、
  `sessionsRoot`（worker 会话目录根，默认 `<dsh home>/sessions`）。
  容量是**派发闸门**：装不下只会排队，绝不拒绝；`mission_result` 与「任务」面板会显示每个排队中的
  任务在等什么。
- **数据**：任务树走 DSH 存储域（`avantf_mission`）；每个任务单元都是**真实会话**，日志在
  `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）下。`/archive` 只改归档标记，要真正腾磁盘用
  `/clean archive all`。

## 升级 / 卸载

```bash
dsh plugin --profile <PROFILE> add @avantf/dsh-mission@<version>   # 升级到某个版本
dsh plugin --profile <PROFILE> remove @avantf/dsh-mission          # 卸载
# 再清掉挂载项：B 路（手写的行）删掉 cordis.patch.yml 里那段 `- id: avantf-mission`；A 路（组合包）
# 把包名从 profile 的 `dsh.profile.bundles` 里去掉即可，或在 DSH Desktop 的「插件」页上卸载。
# 然后重启 dsh。
```

## 环境要求

- **Node ≥ 22**、**pnpm**
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
