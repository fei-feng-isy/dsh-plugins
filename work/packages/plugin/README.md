# @avantf/dsh-work

DSH（DeepSeek Harness）原生**工作树**插件：把一件能连验收标准一起交出去的事交给引擎，由它在后台
逐级派给一次性执行者；执行者发现自己缺前提时**自己**拆出前置工作，前置工作全部收尾后父工作重新可
执行，直到根工作收敛。

引擎是宿主代码，扫树、派活、回收都不花模型调用；模型只出现在工作单元内部（执行、拆解、汇总）和
owner 的对话里。

## 主要功能

- **9 个模型工具**，按 agent 分成两张面孔：
  - owner（顶层会话）6 个：`create_work` / `adjust_work` / `work_result` / `list_works` /
    `finish_work` / `cancel_work`
  - executor（工作单元）3 个：`note_work` / `decompose_work` / `submit_work`
- **一段静态系统提示词段**：什么时候该把活交出去 —— 判据是"能不能连验收标准一起交出去"，
  不是复不复杂。
- **一段引导上下文**：每轮把本会话工作树的状态写进 owner 的 prompt。
- **一个 `agent/pre-step` 钩子**：过滤 worker 结算通知，决定某一步带什么进模型。
- **三条命令**：
  - `/work`：列出本会话的工作树；后面跟文本则用这段文本建一个根工作；
  - `/archive`：把本会话**已完成**的 worker 会话标记为归档（只标记，不释放磁盘）；
  - `/clean`：释放磁盘 —— 无参数是干跑清单，`/clean all` 清理所有**已归档**的，
    `/clean <work-xxxxxxxx>` 只清一个。
- **一个「工作」标签**：会话视图条里排在「对话」「轨迹」之后，树形展示本会话的工作树；引擎一变就把
  变更推给标签，点开某一行才按需读该工作的详情，并在弹窗里按「内容 / 上下文 / 拆解信息 / 纠偏 /
  结果 / 子工作」分区查看（工作标题就是弹窗标题；每个分区前有一行说明它装什么；上下文 / 拆解信息 /
  纠偏 / 子工作都是一条一个框；结果超过 2 KB 时节点只留开头，点「查看完整结果」把全文读回来就地展开）。

执行者**从不等待、也不持有**子工作的进度：结果走树，不走进度流。所以 owner 侧的 `list_works` 只说
一件工作还在跑、还是反复出过问题，不报它内部被拆成了什么。

## 接入 dsh

```bash
# 1) 装这两个包（在 profile 目录里各装一次）：插件本身，以及家族底座。
#    底座是插件的 peer；npm 这类会自动装 peer 的包管理器会跟着装上，pnpm（关掉 autoInstallPeers）
#    与 yarn 不会，所以要显式装。
dsh plugin --profile <PROFILE> add @avantf/dsh-plugin-base
dsh plugin --profile <PROFILE> add @avantf/dsh-work
```

```yaml
# 2) 挂载插件：编辑 ~/.dsh/profiles/<PROFILE>/cordis.patch.yml（不存在就新建）
- insert:
    - id: avantf-work
      name: '@avantf/dsh-work'
      config:
        maxConcurrent: 6      # 并发工作单元上限；省略 = CPU 核心数 - 1
        # staleMs: 1800000    # worker 多久没有任何进展算卡死（毫秒，默认 30 分钟，下限 1 分钟）
```

```bash
# 3) 重启 dsh（宿主半边在启动时 import 一次；浏览器半边刷新页面即可）
dsh web
```

- `@deepseek-ai/*` 与 `zod` 由 profile 上层的 `~/.dsh/profiles/node_modules` 解析。
  **不要在 profile 里再装** `cordis` / `schemastery` / `zod` —— 第二份对象身份会让存储域的校验器
  拒绝本插件写入的记录。

## 怎么用

一次典型用法：

```text
/work 把 X 改成 Y；验收：Z 命令能过
```

1. 引擎把根工作派给一个**一次性执行者**（新会话，prompt 只含工作链与当前节点的完整内容）。
2. 执行者发现缺前提 → `note_work`（写下这次的分析）→ `decompose_work`（拆出前置工作，并写明每一项
   "为什么需要"）。
3. 子工作全部终态后父工作重新可执行；这一轮的两种合法结局就是 `submit_work`（交结论）与继续拆解。
4. 根工作 `done` 时 owner 被唤醒：`work_result` 读结论，`finish_work` 收尾（保留记录并归档）。
5. 方向要改 → `adjust_work(root_id, adjustment)`：纠偏写进根工作并沿工作链下传，同时作废该工作名下
   未完成的子工作；整棵树不要了 → `cancel_work(root_id)`。
6. 全过程可以在「工作」标签里跟着看；已结束的树可以在那里删除（一次删掉整棵树）。

也可以用命令而不是让模型决定：

```text
/work                                  # 看本会话的工作树
/work 跑一遍全量回归，验收：CI 绿        # 用这段文本建一个根工作
/work_result n0007                     # 读某个工作的完整结论
```

## 配置与数据

- **配置项**：`maxConcurrent`（并发工作单元上限）、`staleMs`（多久没有进展算卡死）、
  `sessionsRoot`（worker 会话目录根，默认 `<dsh home>/sessions`）。
- **数据**：工作树走 DSH 存储域（`avantf_work`）；每个工作单元都是**真实会话**，日志在
  `~/.dsh/sessions` 下。`/archive` 只改归档标记，要真正腾磁盘用 `/clean all`。

## 升级 / 卸载

```bash
dsh plugin --profile <PROFILE> add @avantf/dsh-work@<version>   # 升级到某个版本
dsh plugin --profile <PROFILE> remove @avantf/dsh-work          # 卸载
# 再删掉 cordis.patch.yml 里那段 `- id: avantf-work` 挂载项，然后重启 dsh
```

## 环境要求

- **Node ≥ 22**、**pnpm**
- **没有第三方运行时依赖**：只 import 宿主以 peer 提供的 `@deepseek-ai/*` 与 `zod`，以及安装时随插件
  一起装上的底座 `@avantf/dsh-plugin-base`
- 插件自包含：工作树引擎在构建时已内联进宿主入口，安装不需要额外的家族包

## 从源码构建

构建只对着**已安装的全局 dsh**（`npm i -g @deepseek-ai/dsh`），不需要 harness 源码；在仓库根执行：

```bash
pnpm install
pnpm build:dsh work     # 编译两半（tsc + esbuild → lib/index.js + lib/client.js）→ 真实 Cordis 挂载冒烟
pnpm pack:plugin:work   # 打包成"用户安装的那一个包"（断言引擎已内联、无 link:/file: 残留）
```

`pnpm build:dsh work` 的旗标：`--skip-link`（完全不碰软链）、`--no-verify`（跳过挂载冒烟）。

## 许可

MIT。
