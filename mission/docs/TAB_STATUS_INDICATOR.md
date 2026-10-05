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
