# 两次启动异常：原因分析与修复说明（2026-09-20）

启动日志里的两条错误互不相关，是两条独立的故障链：

1. `cannot get required service "agents" in inactive context`
2. `workspace domain is inconsistent: path '…/avantf-work' is claimed by both workspace '33be4fa9…' and workspace 'ad4562b4…'`

第 1 条是本插件（`@avantf/dsh-work`）自身的问题；第 2 条来自 dsh 的 workspace registry 持久化数据，
与本插件无关，但它是**阻断启动**的那一条。

---

## 一、INACTIVE_EFFECT：异步启动活过了自己的 fiber

### 链路

`packages/plugin/src/index.ts` 在 `apply` 里 `void host.start()`（fire-and-forget），
`open()` 要经历多个 `await`：开存储域 → 建树 → 读取/对账。dsh 在加载校验/重载时会
**挂载后立刻卸载**，于是 `open()` 还在飞的时候 fiber 已经被 dispose。Cordis 的
dispose 第一步就是 `this.uid = null`（`cordis/lib/index.js` Fiber 构造器里的 disposer），
之后任何必需服务的读取都会命中反射层：

```
error.message = `cannot get required service "${prop}" in inactive context`
```

`ownerExists()` 里的 `this.ctx.agents.get(...)` 正是这种读取，于是 `open()` 抛出
`INACTIVE_EFFECT`。这条 promise 没有人 await（`apply` 只 `.catch(e => { log.error; throw e })`
再抛出），于是成为 **unhandled rejection**；dsh 的 `installFailLoud`
（`dsh-app-boot/lib/index.js`）捕获它并打印

```
dsh: fatal load failure: Error: cannot get required service "agents" in inactive context
```

然后 `exit(1)`。日志里 `aborting before reconcile` 出现在 fatal 之后，是因为 fatal 路径会
先 dispose 根 fiber —— 这反过来证明：**那条 abort 分支当时是被触发的**。

### 根因（核实版）

`70403a7` 的 `host.ts` **没有任何守卫**：`stillActive()` 只存在于 `index.ts`，是 `apply` 在
`await loadCompat(...)` 之后的前置检查（那段代码注释里就写着「reload/unload 落在 await 里」）。
`open()` 自己一路往下走，卸载之后照样读 `this.ctx.agents`，于是抛出 `INACTIVE_EFFECT`；
`apply` 里那个 `.catch` 只负责记录再抛出，**没有人 await 这条 promise**，所以它是 unhandled
rejection，落进 dsh 的 `installFailLoud` → `fatal load failure` → `exit(1)`。

> 更正：本轮修改最初把根因写成「守卫读错了 fiber（读到了根上下文）」，并用
> `stillActive: () => stillActive(ctx)` 注入去"修"它。**那是我读错了**——
> 在类内部读 `this.ctx.fiber.uid` 拿到的就是插件自己的 fiber（我用变异测试和运行时
> 插桩都验证过：卸载后它是 `null`，守卫判定为死，abort 分支正常触发）。我看到 uid 为 0
> 是因为从**类外**通过可追踪代理读 `ctx.get('avantfWork')`：那个对象回答的 `ctx` 是
> 「取得服务时所处的上下文」，在根部取回时就是根。两者是不同对象、不同 fiber。
> 所以那个注入已回退，`stillActive()` 回到 `host.ts` 的私有方法。

### 修复（已落地）

- `host.ts` 新增守卫（原来的缺口）：`open()` 在每次 `await` 之后、任何 `ctx` 读取之前
  检查 fiber 是否还活着；不活就主动 `close()` 本次拿到的 domain（`stop()` 早于
  `this.domain` 赋值执行，它什么也没关），跳过对账与 sweep 后干净返回。
- `host.ts` 的 `start()` 在 `open()` 外再包一层：失败时若 fiber 已 dispose，
  记为 `WARN start-up did not finish before unmount; ignored: …` 并**吞掉**；
  否则照旧抛出、照旧由 `apply` 记录 `start-up FAILED`。这样"卸载后才落地"的失败
  （存储单元被关掉、在两次 await 之间被卸载）也不会再变成 unhandled rejection。
- `index.ts` 的 `apply` 前置检查保持不变，`:667` 的 `markReady(ready)` 也照旧。

### “是否完全避免”

- 这一条：是。触发路径被两层覆盖（能看见的 dispose 由守卫拦，看不见的时序由 `start()`
  的 catch 拦），失败最多退化成一条 WARN，不会再 fatal。
- 回归测试：`pnpm --filter @avantf/dsh-work test`（`test/lifecycle-open.spec.ts` 两个用例）。
- 需要重启 `dsh web` 才会加载重新构建的 `lib/`（进程正在使用旧代码）。

---

## 二、workspace 域自相矛盾：同一路径被两个 workspace 记录占用

### 是什么

dsh 的 `WorkspaceRegistry` 在启动时先 `validateStoredState`，再谈自愈。校验规则里
“一个路径只能有一个 workspace 记录”是硬约束（`dsh-workspace/lib/index.js:684`）。
持久化数据里出现两条同路径记录，就在**注册表构建之前**抛出，整个进程加载失败——
并且 dsh 没有任何自动修复路径，下次启动仍然失败，只能手工改 JSON。

本机证据：

| 文件 | 状态 |
| --- | --- |
| `~/.dsh/storages/workspace.json.bak-20260920-120104` | 6 条记录，`33be4fa9…` 与 `ad4562b4…` 都声明 `/home/qunqi/opensource/avantf-work`，复现出与日志逐字相同的报错 |
| `~/.dsh/storages/workspace.json` | 5 条记录，已手工剔除多余的一条，校验通过 |

两条记录的时间戳显示：`ad4562b4…` 创建于 `2026-09-20T03:47:03.292Z`，而会话
`session-fe1ab1e6…` 的头部时间是 `03:47:03.330Z`（相差 38 ms）——说明是**那条会话创建时**
新登记了一个 workspace，而当时同路径的 `33be4fa9…` 早已存在（创建于 09-16）。
`33be4fa9…` 当时的 session 列表被“干净地”改写，说明写入方持有的是**旧快照**。

### 机制判断（按可能性排序）

1. **同一 `$DSH_HOME` 下多个 dsh 进程 / 实例共享 `~/.dsh/storages/workspace.json`。**
   `dsh-storage-json` 的注释写得很直白：*a unit file has exactly one writer per process
   and last-write-wins is correct*。两个进程各自内存里都认为“这个路径还没有记录”，
   各自 `put` 一条记录并写整个文件，后写的覆盖前写的 —— 结果正好是“两条同路径记录 +
   会话列表被改写”。
2. **历史手工改过 `workspace.json`。** 该文件刻意做成人类可读、可编辑（这是后端存在的理由）。
   一次不完整的“删记录/挪会话”会留下今天这种状态；`ad4562b4…` 只有 1 个 session，
   很像合并时被漏掉的一条。
3. 并发创建竞态：`WorkspaceRegistry.create` 内部有“先查同路径再建”的守卫，且
   `createCanonical` 又被 `enqueueOperation` 串行化，单进程内基本排除；但它防不住跨进程。

### 恢复：新增 `scripts/workspace-doctor.mjs`

dsh 本身没有修复工具，所以仓库里补了一个（规则就是从 `validateStoredState` 抄下来的，
schema 直接 import dsh 自带的 `@deepseek-ai/dsh-workspace`，不重复定义）：

```bash
pnpm workspace:doctor                          # 只读诊断，默认文档 ~/.dsh/storages/workspace.json
pnpm workspace:doctor -- --file <path>         # 诊断别的文档
pnpm workspace:doctor -- --fix                 # 先备份再写回修复后的文档
```

`--fix` 的取舍是保守的：同路径时保留 session 更多的那条，把另一条的 session 并过去，
删掉多余记录与顺序表项；顺序重复/缺失这类“丢了数据”的矛盾一律不动，交给人判断。
在本次的真实损坏副本上验证过：能逐字报出与 dsh 相同的错误，修复后校验通过。

### “是否完全避免”

- 本仓库这一侧没有可改的地方：那是 dsh 的持久化层，插件只能读 workspace registry。
- 数据层面以后不会“越用越坏”：只要不再出现“两个进程同时写同一个 `$DSH_HOME`”，
  以及不再手工编辑该 JSON 做半截合并，就不会重现。
- 如果再出现：先 `pnpm workspace:doctor`，`--fix` 之前它一定会先写备份；
  并把“当时是不是同时跑着第二个 dsh（headless / 另一个 web / CLI 批处理）”记下来，
  那基本就是根因。

---

## 三、两条错误的相互关系

第 1 条让插件在那个进程里 fatal，第 2 条让 workspace 插件在后续启动里 fatal。
即：即使没有第 1 条，只要 `workspace.json` 里那双记录还在，`dsh web` 同样起不来；
反过来，修掉第 1 条也不会让第 2 条消失。两条都需要各自处理：
代码侧改动解决第 1 条，`workspace-doctor` 负责第 2 条的诊断与恢复。
