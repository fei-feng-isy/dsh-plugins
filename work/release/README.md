# @avantf/dsh-work

DSH（DeepSeek Harness）原生**工作树**插件：把一件能连验收标准一起交出去的事交给引擎，由它在后台逐级派给一次性执行者；执行者发现自己缺前提时**自己**拆出前置工作，前置工作全部收尾后父工作重新可执行，直到根工作收敛。

引擎是宿主代码，扫树、派活、回收都不花模型调用；模型只出现在工作单元内部（执行、拆解、汇总）和 owner 的对话里。

## 它给一个会话加了什么

- **9 个模型工具**，按 agent 分成两张面孔：
  - owner（顶层会话）6 个：`create_work` / `adjust_work` / `work_result` / `list_works` / `finish_work` / `cancel_work`
  - executor（工作单元）3 个：`note_work` / `decompose_work` / `submit_work`
- **一段静态系统提示词段**：什么时候该把活交出去 —— 判据是"能不能连验收标准一起交出去"，不是复不复杂。
- **一段引导上下文**：每轮把本会话工作树的状态写进 owner 的 prompt。
- **一个 `agent/pre-step` 钩子**：过滤 worker 结算通知，决定某一步带什么进模型。
- **三条命令**：
  - `/work`：列出本会话的工作树；后面跟文本则用这段文本建一个根工作；
  - `/archive`：把本会话**已完成**的 worker 会话标记为归档（只标记，不释放磁盘）；
  - `/clean`：释放磁盘 —— 无参数是干跑清单，`/clean all` 清理所有**已归档**的，`/clean <work-xxxxxxxx>` 只清一个。
- **一个「工作」标签**：会话视图条里排在「对话」「轨迹」之后，树形展示本会话的工作树；引擎一变就把变更推给标签（`watch` 流），点开某一行才按需读该工作的详情。

执行者**从不等待、也不持有**子工作的进度：结果走树，不走进度流。所以 owner 侧的 `list_works` 只说一件工作还在跑、还是反复出过问题，不报它内部被拆成了什么。

## 一次典型用法

```text
/work 把 X 改成 Y；验收：Z 命令能过
```

1. 引擎把根工作派给一个**一次性执行者**（新会话，prompt 只含工作链与当前节点的完整内容）。
2. 执行者发现缺前提 → `note_work`（写下这次的分析）→ `decompose_work`（拆出前置工作，并写明每一项"为什么需要"）。
3. 子工作全部终态后父工作重新可执行；这一轮的两种合法结局就是 `submit_work`（交结论）与继续拆解。
4. 根工作 `done` 时 owner 被唤醒：`work_result` 读结论，`finish_work` 收尾（保留记录并归档）。
5. 方向要改 → `adjust_work(root_id, adjustment)`：纠偏写进根工作并沿工作链下传，同时作废该工作名下未完成的子工作；整棵树不要了 → `cancel_work(root_id)`。
6. 全过程可以在「工作」标签里跟着看；已结束的树可以在那里删除（一次删掉整棵树）。

## 安装到一个 DSH profile

需要**两个**包：宿主入口已经把内部引擎 `@avantf/work-core` 的运行时**内联**进 `lib/index.js`，类型面随包放在 `lib/work-core/`；但家族底座 `@avantf/dsh-plugin-base` 是插件的 **peer**，pnpm 关掉了 `autoInstallPeers`，所以装机方要显式把它一起装上。底座一个包里装着启动期环境初始化框架、宿主兼容门禁与两个插件共享的 kit。

```bash
# 1) 装这两个包（= 在 profile 目录里各执行一次 pnpm add）
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

- **peer 必须解析到宿主那一份**：`@deepseek-ai/*` 与 `zod` 由 profile 上层的 `~/.dsh/profiles/node_modules` 解析，不要在 profile 里再装 `cordis` / `schemastery` / `zod` —— 第二份对象身份会让存储域的校验器拒绝本插件写入的记录。
- **`@avantf/dsh-plugin-base` 是 required peer**：插件用它做启动期环境初始化与兼容门禁——两者现在都在底座**这一个**包里。npm 这类会自动安装 peer 的包管理器会跟着装上它；pnpm（关掉了 `autoInstallPeers`）与 yarn 不会，所以要按上面的命令显式装。缺了只是降级挂载（一条 `envinit: WARNING` + 退回 legacy 机制），绝不拒载。
- **配置**：`maxConcurrent`（并发上限）、`staleMs`（沉默窗口）、`sessionsRoot`（worker 会话目录根，默认 `<dsh home>/sessions`）。`cordis.example.yml` 是一份最小示例。
- **数据**：工作树走 DSH 存储域（`avantf_work`）；worker 是真实会话，日志在 `~/.dsh/sessions` 下。`/archive` 只改归档标记，要真正腾磁盘用 `/clean all`。

### 升级 / 卸载

```bash
dsh plugin --profile <PROFILE> add @avantf/dsh-work@<version>   # 升级到某个版本
dsh plugin --profile <PROFILE> remove @avantf/dsh-work          # 卸载
# 再删掉 cordis.patch.yml 里那段 `- id: avantf-work` 挂载项，然后重启 dsh
```

## 环境要求

- **Node ≥ 22**、**pnpm**
- 没有第三方运行时依赖（`dependencies` 为空）：只 import 宿主以 peer 提供的 `@deepseek-ai/*` 与 `zod`，以及 required peer `@avantf/dsh-plugin-base`（底座只在启动期由内联 bootstrap 按文件 URL 动态装载，绝不静态 import、绝不 bundle）。

## 这个包是怎么来的

`@avantf/dsh-work` 是**自包含**的：`pnpm build:dsh` 先用 `tsc` 编译，再用 esbuild 把内部引擎 `@avantf/work-core` 内联进宿主入口（external 只有 `@deepseek-ai/*`、`zod`、`@avantf/dsh-plugin-base` 和相对路径的 `./envinit-bootstrap.js`），并把 core 的声明复制进 `lib/work-core/`、把声明里对 `@avantf/work-core` 的引用改写成相对路径。底座的零依赖 bootstrap 是从 `@avantf/dsh-plugin-base` 的安装副本里**复制的文件**，按相对路径 import，绝不被 bundle。

本仓库是它的发布源码：`pnpm build:dsh` 在本地构建，`pnpm pack:plugin` 打出上面那一个包，`pnpm release:check` 跑完整门禁。

## 许可

MIT。
