# 任务标签状态点 · 修复一：让标签真的会刷新

> 本文接 `mission/docs/TAB_STATUS_INDICATOR.md`（原规格）。上一轮已按原规格实现并通过单测与打包，
> 但**在 GUI 里不会生效**——下面是已核实的宿主机制与修法。

## 1. 已核实的阻塞（不要再自行调研，直接采信）

安装版宿主 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`：

- `viewTabs()`（`:17972-17983`）把 label **当场解析成字符串**：
  `label: resolveSlotLabel(entry.options.label) ?? entry.options.id`；
- `conversationViews`（`:17992`）是快照 store，只在 `refreshViews()`（`:18003-18011`）里被 `set`；
- `refreshViews` 的**全部触发源只有三个**（`:18013-18015`）：
  `slots.subscribe("conversation.view", refreshViews)`、`ctx.locale.subscribe(refreshViews)`、
  `ctx.configForms.developerTools.enabled.subscribe(refreshViews)`。

⇒ **任务运行状态变化不会触发重投影**：标签会一直停在启动时算出的值，直到上述三类事件之一发生。
原规格里"宿主每次投影都会重读 thunk"是对的，但**没有任何东西去投影**。

## 2. 修法（在插件侧，不改宿主）

**在 running 状态发生翻转时，对该槽做一次注册表变更**，从而让 `slots.subscribe("conversation.view")` 触发
`refreshViews()` → 标签重新解析。

具体：`ctx.slots.inject('conversation.view', () => register(...))` 里拿到的 disposer，在
**`isRunning()` 布尔值翻转**时 `dispose()` 旧注册、用**完全相同的选项**重新 `register`：

- 选项必须逐项相同：`name: 'conversation.view'`、`id: 'missions'`、`order: 20`、`locale: NS`、
  `label: () => missionTabLabel(...)`，并传**同一个 `View` 组件引用**（引用不同会改变元素身份）；
- **只在布尔翻转时做**（一次任务生命周期最多两次），不要按轮询周期反复注册；
- 必须在插件卸载时可 dispose（沿用既有 `ctx.effect` 纪律），不要留下悬空注册；
- **不能形成回环**：重注册 → `refreshViews` → 读 label thunk（只读状态，不触发任何注册）。

### 必须一并确认/处理的两点

1. **视图重挂载风险**：确认宿主渲染选中视图时是**按 id 键控**还是按 entry 身份。若按身份 ⇒ 重注册会让
   `MissionTreeView` 重挂载（展开态/滚动位置丢失）。若有风险，把视图的本地 UI 状态提到模块级（或改用既有持久化），
   使重挂载无感；**不要**因此改成"轮询里反复注册"。
   （`refreshViews()` 末尾会对每个 binding 调 `restoreView(sessionId)`，而 `activateView` 对同一个 active id 是幂等激活——
   这一条已在宿主代码里确认，不属于风险。）
2. **失败安全**：Remote 未挂载 / 读取失败 / loading ⇒ 不显示标记，且**不要**为此触发重注册（没翻转就不动）。

## 3. 验收（执行者做针对性验证；该树快档由派单方收口）

1. 单测（扩 `test/client-status.spec.ts`）：
   - 翻转时**恰好**发生一次重注册（用假 slots 记录 register/dispose 调用序列）；
   - 空闲 ⇒ `任务`（逐字）；有 running ⇒ `任务 ●`；
   - 反复读取同一状态**不产生额外注册**（无回环）；
   - dispose 后翻转不再产生注册。
2. 用**宿主同款机制**做一次集成级证明：假 `slots` 暴露 `subscribe`，断言"重注册后 subscribe 监听器被调用"⇒
   等价于宿主会执行 `refreshViews()`。
3. 重建客户端产物：`cd mission && node scripts/build-client.mjs`；产物里应含 `\u25CF` 与 `任务`。
4. **回报**：实际跑了什么、证明了哪条、**哪些没验证**（浏览器视觉仍由派单方/用户在页面上确认）。

## 4. 边界

只改 `mission/packages/plugin/**`（client 源 + 测试）。不改 DSH 宿主、不改 `mem/**`、不加依赖、不改版本号。
