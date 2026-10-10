# avantf · base（`base/plugin-base`）

家族底座 `@avantf/dsh-plugin-base` 的**开发向**说明：这棵树自己的约定、接口世代流程与门禁。
面向用户的 npm 页面是 [`plugin-base/README.md`](plugin-base/README.md)；设计取舍见
[`plugin-base/docs/DESIGN.md`](plugin-base/docs/DESIGN.md)，公开接口冻结与版本承诺见
[`plugin-base/docs/INTERFACE.md`](plugin-base/docs/INTERFACE.md) 与发布 README 的「版本承诺」。
整个工作区的公共约束（发布面、家族硬约束、共享逻辑归属、构建与收口）见根 [`AGENTS.md`](../AGENTS.md)。

## 树内约定

- **接口世代与 `plugin-base/api/interface-vN.json` 快照流程**：改 `.` / `./internal` 的公开面就是**接口换代**，与
  包版本是**两条轴**（换代只动接口编号，包版本按普通 semver 走）。
  1. `INTERFACE_VERSION` +1（`plugin-base/src/interface.ts`）；
  2. 新增 `plugin-base/api/interface-vN.json`（上一代的快照**保留**，作为被取代世代的记录）；
  3. 新成员写进 `.` 的接口类型与快照里的两份名单（`exportedValueNames` / `exportedTypeNames`）；
  4. `UPDATE_INTERFACE_SNAPSHOT=1 pnpm -C base/plugin-base test public-surface` 重落快照。不带这个环境
     变量时 `public-surface` 只做比对：快照缺失、名称多一个少一个、`INTERFACE_VERSION` 与档名不一致都失败
     ——它**从不自己发明一个世代**，换代是一次显式动作（新快照 + 版本决定）。
- **kit 成员归置**：`.` 是**显式列举的稳定子集**，只有真实的运行期消费者才放上去；**零运行期消费者的成员
  放在 `./internal`**，`./internal` 不承诺兼容。成员的移出与清退是完整动作：`. ` 上没有、`./internal` 上必须
  有（`createPluginLogger` 随接口 v3 移出 `.`、进了 `./internal`，两棵插件树因此各自持有自己的 logger）。
- **向前兼容是硬要求**：新成员必须**增量**——不改既有成员的形状与语义；顺序敏感的参数用具名对象
  （`resolveDataHome({ explicit, env, configured })`）；可观察文案归调用方（`compatReport` 的 `words`）。
  一次增面绝不能让谁降级、更不能让谁拒载。
- **枢纽文件最后动**：超过 800 行的枢纽是 `plugin-base/src/provisioner.ts` · `plugin-base/src/compat.ts` ·
  `plugin-base/src/conformance.ts` · `plugin-base/src/interface.ts`——**`base/**` 的枢纽最后动**（跨树通用的
  「触及即抽 / 不为变小做整体重构 / hub 名单只作观察不做门禁」见根 `AGENTS.md`）。

## 门禁

- `pnpm build:dsh base` —— tsc 构建本包。
- `pnpm -C base/plugin-base test` —— 本包测试，含 `public-surface` 快照比对（重落快照见上文）。
- `pnpm release:check:base` —— 本包严格门禁：链接 → 编译 → 类型检查 → 测试 → pack。
- `pnpm proof:base-swap[:mount]` —— 产物里没有静态 base import / 内联 kit，**被替换的** base 仍能提供提示词
  读写、根解析与接口门禁。

工作区命令总表、快档 / 发版档的分工与「验证分工」见根 `AGENTS.md` 的「构建与门禁」。
