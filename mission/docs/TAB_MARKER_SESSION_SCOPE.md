# 修复：`任务` 标签状态点的三个缺陷（跨会话泄漏 / 会话身份取错 / 漏翻转不自愈）

> 用户实测（2026-10-09）：
> ① 在**有任务执行中**的会话里，`任务 ●` 正确；
> ② 切到**另一个没有任务的会话**，`任务` 后面**也有点**（跨会话泄漏）；
> ③ 之前还观察到"点消失了一段时间，直到本轮会话开始才回来"（漏翻转后不自愈）。

## 1. 已核实的根因（三条，逐条有据，不要再自行调研）

1. **标签是全局一份**。宿主 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 的 `viewTabs()`
   遍历 `slots.entries("conversation.view")` 时**不带任何会话过滤**，全应用只有一个
   `conversationViews` 快照店，`refreshViews()` 的触发源只有三个（`conversation.view` 注册表变化 /
   locale / config）。⇒ 我们的 `seatOptions.label` 这个 thunk 被所有会话共用。
2. **会话身份取错**。`mission/packages/plugin/src/client/status.ts` 的 `mainSessionId()` 扫描
   `byId` 取**第一个** `retainedBy.mainView > 0` 的会话。而宿主**自己的**正确算法是
   （`dsh-client-ui-session/lib/client.js:283`，`publishMain()`）：

   ```js
   const currentId = this.current.value.key;                    // ← 当前选中的会话（响应式 store）
   const nextId = currentId !== undefined && retainInfo(currentId).retainedBy.mainView > 0
     ? currentId                                               // ← 我们缺的就是这一支
     : Object.values(byId).find(c => c.retainedBy.mainView > 0)?.id;   // ← 我们只抄了这条兜底
   ```

   ⇒ 当多个会话都被主视图保留（都开着）时，我们的标记会一直属于"第一个"，而你在看另一个 ⇒ **泄漏**。
3. **只在翻转时自愈**。`status.ts` 的 `setRunning` 只在判定翻转时通知，客户端据此重注册座位
   （`index.ts` 的 `rearmSeat`）——宿主才有机会重投影。若某次翻转漏掉（读失败 / 客户端半边彼时未挂载 /
   两个翻转压缩在同一个 30 秒轮询窗口内，例如一批 2–3 秒的 worker），标签会**无限期停在旧值**，
   直到别的触发源出现 ⇒ 用户看到的"点消失一段时间又自己回来"。

## 2. 要达成的行为

| 场景 | 期望 |
|---|---|
| 当前会话**有**任务在跑 | `任务 ●` |
| 当前会话**没有**任务（哪怕别的会话在跑） | 逐字 `任务`（**不再泄漏**） |
| 切换会话 | 标签在**切换后尽快**正确（应当接近即时，而不是等 30 秒轮询或永不更新） |
| 任一次翻转被漏掉 | 最多约 2 分钟内**自愈**（有界重注册） |
| 老/异常宿主（`uiSession` 缺席） | 退回今天的目录启发式（`mainSessionId`），绝不抛错、绝不空白 |

## 3. 落点（按此顺序）

1. **`client/status.ts`（会话身份）**
   - 保留 `mainSessionId`（作为**兜底**，供没有 `uiSession` 的宿主），新增"当前会话"读取：
     经 `ctx.get('uiSession')`（**每次读取时**解析，服务可能晚挂载）取当前选中会话的 key。
     宿主读法是 `this.current.value.key`；请同时兼容快照式 API（`current.getSnapshot?.().key`）——
     两种都试，取到即用，取不到返回 `undefined`。
   - `getSessionId` 的新顺序：**当前选中会话** → `mainSessionId` 兜底 → `undefined`。
   - 单元测试：给假 `uiSession`（含 `current`），断言"当前会话优先"；`uiSession` 缺席/抛错时退回启发式；
     现状的 `mainSessionId` 用例保留。
2. **`client/index.ts`（会话切换即时刷新）**
   - 订阅当前会话的变化（`uiSession` 的 `current` 是 store：优先 `subscribe`，没有就退回 30 秒轮询），
     变化时 `rearmSeat()` 一次 —— 让宿主重投影，标签**切换即更新**，而不是等下一个翻转。
   - 必须：订阅在插件卸载时释放；回调里不得抛错；不得形成回环（重注册只读状态）。
3. **`client/status.ts` + `client/index.ts`（漏翻转自愈 H1）**
   - 判定为 `running` 期间做**有界重注册**：进入 running 时一次 + 之后每 `TAB_STATUS_POLL_MS`
     的整数倍（建议每 2 分钟）最多一次，直到回到 idle 停止。
   - **不要**每个轮询周期都注册（会 churn 宿主 store）；**不要**在 idle 期间重注册。
   - 单元测试：running 期间推进假时钟 → 断言发生**有界**次数的重注册（每秒一次这类写法必须被判失败）；
     回到 idle 后不再注册；dispose 后彻底停止。
4. **文档**：把"标记语义 = 当前会话"写进 `mission/docs/TAB_STATUS_INDICATOR.md`（补一节"语义与已知边界"），
   并说明宿主标签条是全局一份、我们靠"跟随当前会话 + 翻转/切换时重注册"让它正确。

## 4. 验收（针对性验证）

- 单测覆盖：① 当前会话有 running ⇒ `任务 ●`；② 当前会话无 running 而**别的**会话有 ⇒ 逐字 `任务`；
  ③ 切换会话（假 store 推新 key）⇒ 触发一次重注册；④ running 期间有界自愈、idle 不注册、dispose 停止；
  ⑤ `uiSession` 缺席 ⇒ 退回启发式且不抛错。
- 既有断言不得放宽：`client-status.spec.ts` / `client-view.spec.tsx` 里现有的翻转、零查询、拒绝路径用例全绿。
- 边界：只改 `mission/packages/plugin/**`（client 源 + 测试 + 必要的 docs）；**不发版、不改版本号**（由派单方统一
  在 mission 0.4.0 里发）。执行者只做针对性验证（改动涉及的构建/类型检查 + 只跑新增或改动的测试文件），
  回报"实际跑了什么 / 每条测试证明了哪条 / 哪些没验证"；`pnpm check:fast mission` 由派单方收口。
- 视觉确认（浏览器）由派单方/用户做：在 A 会话跑一个任务 → 切到 B 会话 → 标签应**逐字「任务」**；切回 A ⇒ `任务 ●`。
