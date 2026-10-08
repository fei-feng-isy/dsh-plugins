# 任务标签状态点（实现规格）

> 目标：Web GUI 里 `任务` 标签在**有任务执行中**时带一个状态标记；**没有任务时只显示 `任务`**（逐字）。
> 本文是实现规格；执行者按它改代码，并把"实际跑了什么 / 证明了哪条 / 哪些没能验证"回报。

## 0. 已勘察的结论（不要再重复调研）

- 标签所在槽是 **`conversation.view`**，其注册选项**只有** `id`(必填) / `order` / `label: string | (() => string)`——
  宿主实时目录里**没有** `badge`/`icon`/`indicator`/`decorate` 字段。
- `label` 是**显示文本**，且**宿主每次投影都会重读 thunk**（目录原文："A thunk is re-read on every projection"）。
  ⇒ 状态只能编进 label 文本；**带颜色的圆点需要改宿主**（本任务不做）。
- 任务插件自己就是这个标签的注册者（`mission/packages/plugin/src/client/index.ts`，`id: 'missions'`，`order: 20`，
  `label: () => t('view.missions')`）。
- **本机 56 个字体、含 emoji 的 0 个** ⇒ 不用 `🟢`（会渲染成方块）。用普通字形。

## 1. 要做的

1. **标记字形**：默认 **`●`**（U+25CF，普通字体覆盖）。做成**一个命名常量**（便于日后换字形）。
   label 形如：空闲 → `任务`；执行中 → `任务 ●`（中间一个半角空格，保持紧凑）。
2. **判定**：存在**至少一个处于 `running`（客户端词表 `执行中`）的任务节点** ⇒ 显示标记。
3. **状态源必须提到插件 body 层**（这是本任务的关键，不是可选优化）：
   现在任务树的刷新（stream / timer / keepalive）挂在 `MissionTreeView` 的 effect 上，**离开该标签就停**
   （代码注释原文："its disposer belongs to the effect, so leaving the tab stops it"）；
   而 `conversation.view` 是一次只渲染一个的列表槽。
   ⇒ 把"是否有 running 节点"做成一**个模块级/插件级信号**，由**插件 body** 持有的订阅更新，
   视图可以复用同一信号（但不再由视图的生命周期决定它是否存在）。
4. **失败安全**：Remote 未挂载、读取失败、数据仍在 loading ⇒ **不显示标记**（**绝不假报"执行中"**）。
5. **生命周期**：订阅必须在插件卸载时可 dispose（沿用该插件既有的 effect/disposer 纪律）；
   轮询间隔**不超过 30 s**（与既有 keepalive 同量级，不要更密）。
6. **本地化**：标记不新增 locale 条目（`label` 仍以 `t('view.missions')` 为主体）。

## 2. 落点与边界

- **改**：`mission/packages/plugin/src/client/index.ts`（label thunk + body 层订阅）；
  如复用更顺，可在 `MissionTreeView.tsx` 提取状态判定（保持既有行为不变）。
- **不改**：DSH 宿主（不改 `conversation.view` 的目录、不重建 web 产物）、`mem/**`、任何其它插件。
- **不加**：新依赖、新工具、新版本号、CHANGELOG（mission 没有 CHANGELOG 文件；版本决策留给派单方）。
- 现有 `conversation.view` 的其它 occupant（`chat`/`trajectory`/`memory`/`knowledge`）行为不得改变。

## 3. 测试与验收（执行者只做针对性验证）

1. 在既有客户端测试基建（`mission/packages/plugin/test/`，参考 `client-view.spec.tsx` 的写法）加**纯逻辑单测**：
   - 无 running ⇒ label 恰好为 `任务`（逐字，无尾随空格）；
   - 有 running ⇒ label 为 `任务 ●`；
   - Remote 未挂载 / 读取失败 ⇒ 不显示标记（失败安全）；
   - 订阅在 dispose 后不再更新（把 disposer 覆盖到）。
2. 改动涉及的构建/类型检查 + **只跑新增或改动的那几个测试文件**（收口由派单方跑该树快档）。
3. **必须回报**：① 实际跑了哪些命令；② 每个测试/命令证明了上面哪一条；③ **哪些没能验证**——
   尤其"浏览器里 `●` 是否真的可见、标签是否真的随状态切换"若无法用浏览器控制确认，必须如实写明这一点，
   不要用"测试通过"替代视觉结论。

## 4. 明确不做

宿主改造、真彩色圆点、计数徽标、脉冲动画、把标记做成可配置项、替换 `id: 'missions'` 单元格的外部插件方案。

## 5. 语义与已知边界（2026-10-09：跨会话泄漏 / 切换不刷新 / 漏翻转不自愈的修复）

### 5.1 标记说的是「当前选中的会话」

宿主的标签条是**全应用一份**：`viewTabs()` 遍历 `slots.entries("conversation.view")` 时**不带会话过滤**，
全应用只有一个 `conversationViews` 快照店 ⇒ 本插件那**一个** `label` thunk 被所有会话共用。
所以标记必须回答"读者正在看的那个会话"，身份按这个顺序解析（`src/client/status.ts`）：

1. **当前选中会话**——客户端 `uiSession` 服务的 `current` 绑定源（宿主自己的算法就是
   `this.current.value.key`，见 `dsh-client-ui-session/lib/client.js` 的 `publishMain()`；同时兼容
   `current.getSnapshot?.().key` 形态）。每次读取时经 `ctx.get('uiSession')` 现解析（服务可能晚挂载）。
2. **目录启发式兜底**——`mainSessionId()`：第一个 `retainedBy.mainView > 0` 的会话。**只在**没有
   `uiSession` / 没有当前选中项 / 服务形状异常时使用（老宿主、无宿主单测）。
3. 两者都取不到 ⇒ `undefined` ⇒ **不显示标记**（绝不假报执行中）。

⇒ 当前会话有任务 ⇒ `任务 ●`；当前会话没有、别的会话在跑 ⇒ **逐字 `任务`**（不再泄漏）。

### 5.2 什么时候让宿主重投影

宿主只在三个触发源重读 label：`conversation.view` 注册表变化 / locale / config。**会话切换不在其中**，
所以标签必须由我们主动 dispose + 重注册座位（`rearmSeat`，`src/client/index.ts`）：

| 触发 | 时机 | 上界 |
|---|---|---|
| **判定翻转** | `false → true` / `true → false`（含读失败导致的 `true → false`） | 每次翻转一对 |
| **会话切换** | 订阅 `uiSession.current.subscribe`，变化时**按新会话立即重读一次**并重注册 | 每次切换一对（新会话判定不同时，重读的翻转会再触发一对） |
| **漏翻转自愈** | 判定为 `running` 期间，每 `TAB_STATUS_REARM_MS`（= 2 分钟，= 30 秒轮询的第 4 个 tick）最多一次 | 每 2 分钟一对；回 idle 立即停止 |

**纪律（实现不得违反）**：① **不要**每个轮询周期都注册（会 churn 宿主 store，自愈骑在轮询 tick 上按窗口计数）；
② **不要**在 idle 期间注册（tick 计数在非 running 时归零）；③ 插件卸载即停止（订阅释放、轮询 dispose、
再注册只读判定，不形成回环）；④ 回调与订阅即使在异常宿主上也不得抛错。

### 5.3 已知边界

- 标签是**文本、全应用一份**，做不了 per-session 徽标/多实例标记——那需要改宿主（本轮不做）。
- `uiSession` 缺席（老宿主）时退回目录启发式：多个会话都开着时仍可能显示"第一个"会话的标记，这是**降级**不是正确；
  有 `uiSession` 的宿主上不存在这个泄漏。
- 漏翻转的自愈上界 ≈ 一个轮询窗口（2 分钟）：这是"有界兜底"而非即时纠正；切换与翻转本身是即时的。
- 宿主既没有 `uiSession` store 又没有计时器时，切换只能靠下一次翻转或目录读取——降级行为，不空白、不抛错。
