# unit 与租约：同一范围只有一个执行者（2026-10-02）

> 目标：让"两条并行线改同一个文件"**由引擎状态保证不可能**，而不是靠派单者的纪律。
> `DOMAIN_VERSION` 保持 1（新增字段带默认值），既有守卫（`startingClaims` / `wakingClaims` /
> reclaim CAS / 预算语义）一律不动。

## 一、要解决的问题

实测（2026-10-02）：W7 与 W8 两条并行线**都要改 `mission/packages/plugin/src/host.ts`**，引擎把两条都
派了出去。根因不是执行者不听话，而是引擎只按**节点状态**决定派发：`NodeRecord` 上没有任何
resource / lease 概念，并发度是宿主级一个数，`create_mission` 也没有"这件事会碰哪里"的旋钮。

这与本仓对互斥的既有立场是同一条（见 `tree.ts` 的 `decompose`：*exclusive through node state,
never prompt discipline*）：**互斥必须落在状态里**。提示词只能引导，正确性必须由状态机保证。

## 二、`unit`：字段与入参

### 2.1 字段

```ts
node.unit: string | null   // 这件事将要改动的范围（一个目录或文件）—— 租约键
```

- **持久化**，且是 `NodeRecord` 的必填字段（值可为 `null`）。
- **缺省 `null` = 不声明范围 = 不参与租约 = 今天的行为**，逐位一致：`null` 的节点在派发判断里
  只是让 `held.has(node.unit)` 短路，别的分支一个都不变。
- 旧记录兼容：`domain.ts` 用 `z.string().nullable().default(null).catch(null)`（缺失读 `null`；
  非字符串的脏值也降级成 `null`，**不能让老文档解析失败**）；`normalizeLoaded()` 在唯一的载入
  边界把它读成 `null`。`DOMAIN_VERSION` **仍为 1**（`single` 布局的版本比较是精确相等，任何
  bump 都会 brick 掉全部既有安装）。

### 2.2 入参

| 工具 | 入参 | 缺省语义 |
|---|---|---|
| `create_mission` | `unit?: string` | 不写 = `null`（根没有父可继承，所以根是唯一的声明点） |
| `decompose_mission` | `children[].unit?: string` | **不写 = 继承父的 unit**（安全默认：同范围的兄弟不会同时跑） |

空白字符串（`"   "`）是**显式的 opt-out**：写成空白表示"这个子任务不占任何范围"，与"没写 →
继承父"区分开。根上的空白同样读作"不声明"。

**文案口径**（面向模型，不出现"树/节点"这类形状词，见 `wording.spec.ts`）：

- `unit` = 「这件事将要改动的范围（一个目录或文件）」；
- 并写明「同一范围同一时刻只有一个任务在跑」。

### 2.3 复用（去重）节点保留自己的 `unit`

拆解去重会把已有节点复用为另一个父的前提。复用节点**不改** `unit`：那是它在被创建时声明的
范围，而且它可能正以那个范围在 `running`（改它等于改一个别人正持有的资源）。新子节点的
`unit` 由 `resolveChildUnit(parent.unit, spec.unit)` 解析。

## 三、租约：位置与生命周期

### 3.1 没有可变租约表 —— 租约是节点状态的投影

> **一个 unit 的持有者 = 该 unit 上唯一那个 `running` 节点。**

实现是 `mission/packages/core/src/dispatch.ts` 里的纯函数：

- `heldUnits(scopes)`：所有 `running` 节点的 `unit` 集合；
- `unitHolder(scopes, unit, exceptId?)`：某个 unit 的持有者；
- `normalizeUnit` / `resolveChildUnit`：声明与继承的解析。

**为什么不做一张表**：只有 `running` 节点持租约，而"离开 `running`"的路径有八九条
（submit / decompose / reclaim / cancel / 终态 / 打开时降级 / 删树）。一张可变表必须在**每一条**
路径上释放，漏掉一条就是该 unit **永久卡死**。投影进状态则释放不可能被忘记 —— 这正是"由引擎
保证"该有的形状。

#### 3.1.1 租约键是归一化后的路径（2026-10-02 补）

排除靠的是**字符串相等**，而 `unit` 是模型自由填写的文本：同一个目录会被写成 `a/b`、`a/b/`、
`./a/b`、`a\b` 四种。于是"两条并行线改同一处由引擎保证不可能"只在两个 agent 恰好写出**逐字节相同**
的字符串时成立。`normalizeUnit` 因此做**保守的文本归一**（在唯一的解析点：声明、继承、载入都走它）：

| 归一 | 例子 |
|---|---|
| `\` 读作 `/`，冗余分隔符折叠 | `a\b`、`a//b` → `a/b` |
| 去尾斜杠、去 `.` 段 | `./a/b/` → `a/b` |
| 词法解析 `..`（不查文件系统，不解析符号链接） | `a/b/../c` → `a/c` |
| 开头的 `/` 最多留一个（`//srv/x` 与 `/srv/x` **不**合并） | `/a/b/` → `/a/b` |
| 前导 `..` 保留（不同作用域不互相吞并） | `../a` → `../a` |

**v1 明确不覆盖：包含关系。** `a` 与 `a/b` 是两个不同的键，父目录不会排斥它下面的文件，反之亦然。
只有"同一个范围"（归一化后相等）是引擎保证的互斥；需要隔离的调用方必须在两个节点上写**同一个**范围
（工具文案推荐写相对仓库根的目录路径，如 `mission/packages/core`）。做成路径前缀/包含判定要引入
"哪个范围更大"的语义（两个目录的公共子目录算谁的），留给 v2。

### 3.2 跨根

`heldUnits` / `unitHolder` 扫描**所有树**，不按树过滤（连已归档的树也计入，安全方向优先）：
撞车本来就是跨树发生的（两个 owner 的任务改同一个文件，与两个兄弟改同一个文件是同一件事），
按树内串行解决不了。宿主级一个进程一份树状态，所以租约天然是宿主级、跨根任务。

### 3.3 获取点（在树锁内，原子）

三个**进入 `running`** 的路径都做同一次检查，`MissionTree.unitRefusal()`：

| 路径 | 说明 |
|---|---|
| `dispatch` | 引擎常规派发；**获取点** |
| `adoptParked` | parked 会话的唤醒 |
| `adoptContinuation` | 冷唤醒（`lastWorkerId`） |

检查**必须在锁内重做**，不能只信 `nextDispatchable` 的过滤：唤醒路径是在锁外读快照后绑定的，
两次 pass 可能插在"看起来空闲"和"置 running"之间。

`nextDispatchable` 仍然**先跳过**被持有的候选（避免浪费一次 claim / 一次拒绝），但那是优化，
正确性在锁内那一次检查。被拒的候选返回 `unit-busy`，**不消耗任何预算**（不 `attempts`、
不 `failures`、不冷却）：被别的范围挡住是"还不到时候"，不是失败。

### 3.4 释放点

节点离开 `running` 的每一条路径即释放，全部由状态改变自动完成：

| 路径 | 去往 |
|---|---|
| `submitResult` | `done` |
| `decompose` | `blocked`（子未终态）/ `ready`（全复用终态） |
| `reclaim('vanished'｜'stalled')` | `interrupted` |
| `reclaim('spawn-failed')` | `interrupted` |
| `reclaim('wake-failed')` | `ready` |
| `cancelSubworks` / `cancelTree` / `failExhausted` | `failed` |
| `reconcileOnOpen`（重启/热重载降级） | `interrupted` |
| `destroyTree` / `deleteTree` | 记录消失 |

`interrupt` 本身不改状态，是随后的 `reclaim` 让节点离开 `running`，因此也在上表内。

### 3.5 parked 与冷唤醒不改变归属

被唤醒的节点**仍是同一个 unit 的持有者**，租约不需要转移：`adoptParked` / `adoptContinuation`
只是把它重新置 `running`（同一个 `unit` 字段），并复用同一次租约检查。parked 节点是 `ready`
（不持租约），所以它的 unit 在停放期间是空闲的；唤醒时若该 unit 已被别人持有，唤醒被拒、
地址留在节点上，等持有者让出后重试。

## 四、无死锁论证

> **只有 `running` 节点持租约，而 `running` 节点从不等待别的节点。**

- 一个节点在等前提时是 **`blocked`**，不持租约，也不可派发；
- 一个 `running` 节点要么 `submit_mission`（→ `done`），要么 `decompose_mission`（→ 立刻
  `blocked` 并释放）；
- 一个节点**至多持有一个 unit**，不存在"持有一个 unit、同时等另一个 unit"的请求边。

因此等待图里没有"持有并等待"的边，也就不存在环：租约只会把一个候选**推迟**到当前持有者
自己停下来，而持有者总会自己停下来。

`blocked` 父节点不占 unit 这一点是关键的配套：父拆解出同 unit 的子任务后，如果它还占着租约，
那些子任务将永远无法开跑（真正的死锁）。测试 ③ 钉住这一条。

## 五、未声明 = 今天的行为

`unit === null` 的节点：

- 不进 `heldUnits`；
- `nextDispatchable` 对它的新判断只有 `held.has(null)` 这一步短路；
- `unitRefusal` 直接返回 `undefined`。

三个获取点、释放点、预算、CAS、`startingClaims` / `wakingClaims` 全部不变。测试 ⑤ 用三个
`unit` 未声明的根在 `maxConcurrent: 3` 下一次全派出来钉住"逐位一致"。

## 六、落点

| 文件 | 改动 |
|---|---|
| `core/src/types.ts` | `NodeRecord.unit`、`ChildSpec.unit`、`RefusalCode += 'unit-busy'` |
| `core/src/dispatch.ts` | **新模块**：租约代数 + 派发候选选择（从 `tree.ts` 抽出的派发路径） |
| `core/src/tree.ts` | `nextDispatchable` 委托；三个获取点的锁内检查；`makeNode` / `createRoot` / `decompose` / `normalizeLoaded` 带上 `unit` |
| `core/src/index.ts` | 导出新模块 |
| `plugin/src/domain.ts` | `unit: z.string().nullable().default(null).catch(null)` |
| `plugin/src/host.ts` | `createWork(..., unit?)` 贯穿到 `createRoot` |
| `plugin/src/tools.ts` | `create_mission.unit` / `children[].unit` 的声明与读取（`optionalUnit`） |

## 七、测试（8 条验收性质）

| # | 性质 | 落点 |
|---|---|---|
| ① | 同 unit 两节点，任一时刻至多一个 `running` | `core/test/unit-lease.spec.ts` |
| ② | 不同 unit 可同时 `running` | 同上 |
| ③ | `blocked` 父节点不占 unit（同 unit 的子任务能跑） | 同上 |
| ④ | reclaim 后 unit 释放、可再派（含锁内 `unit-busy` 拒绝） | 同上 |
| ⑤ | 未声明 unit 的行为与今天逐位一致 | 同上 |
| ⑥ | 不双跑（跨根/跨 owner 同 unit 只起一个执行者） | 同上 + `plugin/test/unit-lease.spec.ts` |
| ⑦ | 旧记录缺 unit 读成 `null` | 同上 + `plugin/test/domain.spec.ts` |
| ⑧ | 持久化往返（含 `DOMAIN_VERSION` 仍为 1） | `plugin/test/domain.spec.ts` |
