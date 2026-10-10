# AGENTS.md 与 README 的职责重构（2026-10-10）

> 本文件是**实施规格**（派单方写给执行者）。纯文档改动。范围：根 `AGENTS.md`、**新建** `base/README.md`、
> `mem/README.md`、`mission/README.md`、**删除**根 `README.md`，以及清理指向被删文件的引用。

## 1. 要求（用户口径）

1. **`AGENTS.md` 只保留整个项目的公共约束**（跨三包 / 跨树都成立的东西）。
2. **各包/各树专有的约束搬到该树自己的 README**（开发向 README，**不是**随包发布的那个 npm 页面）。
3. **仓库根 `README.md` 与 `AGENTS.md` 的功用重复 → 只保留 `AGENTS.md`**，即**删除根 `README.md`**。

## 2. 关键区分：两套 README，别搬错地方

| 文件 | 是什么 | 本次能不能动 |
| --- | --- | --- |
| `base/plugin-base/README.md`、`mem/packages/plugin/README.md`、`mission/packages/plugin/README.md` | **随包发布的 npm 页面**（刚改成"功能 / 使用 / 示例"，不写实现细节与仓库内部内容） | **一行都不要动** |
| `mem/README.md`、`mission/README.md`、**新建的 `base/README.md`** | **开发向 README**：写该树的开发约定、内部结构、门禁、hub 文件清单等 | 本次的落点 |

## 3. `AGENTS.md` 的保留 / 迁出清单

**保留（项目公共）**：三个可发布包的定义与关系；发布面（可发布集合、发布顺序、base 是普通依赖 + 两树同区间 +
一份副本、唯一 zod、dsh peer 链、从 dev 仓发布）；家族三条硬约束；base 缺失/更旧时的降级契约；家族统一失败
口径（环境故障降级、绝不杀宿主）；「新增插件怎么用 base」；「共享逻辑：归谁 + 怎么抽」；版本记录规则与版本号
含义;「发布 README 与 CHANGELOG 的内容要求」；构建与门禁（命令、两档、验证分工、纪律）；测试替身与 fixture
口径；边界与路径（家族根/数据根，跨树）；架构裁决记录。

**迁出到各树 README**（判据：只有那一棵树成立的东西）：

- `## 体量与枢纽文件（hub）` 里**每棵树的清单与其取舍** → 对应树的 README（mem 的 6 个 hub 文件与"SQL 形状
  慎动"、mission 的 4 个、base 的 4 个）；跨树都成立的规矩（"触及即抽、不专门开重构线"、"不为变小做整体重构"、
  "hub 名单只作观察不做门禁"）留在 AGENTS。
- `## 子树约定 → mem` 整段 → `mem/README.md`（工具面 8 个 `TOOL_SPECS` 与 `kb_manage` 不在模型面；两库共用
  `core/src/store/hybrid.ts` 与 `dispatch.ts` 不许分叉；融合必须按可靠性定序与"并集不收窄/非自指查询逐字节
  不变"的证据要求；改嵌入空间=数据迁移与表示指纹规则；`eval_zh` 41 条冻结数字；`typecheck` 必须在 `build`
  之后、`typecheck:dsh` 的范围；读 zod 内部的正确姿势；`mem/CHANGELOG.md` 的段落规则）。
  其中**跨树**的部分保留在 AGENTS：例如"读 zod 用 `def.shape`/`def.values`/`toJSONSchema`"（mission 也用）
  按需要两处保留**一处正本 + 另一处一行指针**，不要留两份会漂移的真相。
- `## 子树约定 → mission` 整段 → `mission/README.md`（调度语义 v1：容量是派发闸门、provider 探针 `null` 语义、
  排队与老化预留；worker 清理四步生命周期与 `keepWorkers` 保留策略）。
- base 的树内约定（`INTERFACE_VERSION` 与 `api/interface-vN.json` 快照流程、kit 成员归置、`base/**` 枢纽
  "最后动"、base 自身的门禁与契约）→ 新建的 `base/README.md`。

要求：**搬完不许留两处会漂移的"同一真相"**——AGENTS 里凡迁出的内容要么删除、要么留一行指针指向该树 README；
各树 README 也不要整段复制 AGENTS 的公共条款。

## 4. 删除根 `README.md`

- `git rm README.md`（它现在的内容与 AGENTS 重复；安装/数据根/共享 prompts/卸载 等段落已分别有归属：
  用户安装说明在三份发布 README，数据根与路径在 AGENTS「边界与路径」，`prompts/` 约定在 AGENTS 或 mem 开发 README，
  卸载在发布 README）。**先逐段确认去向**，不许丢信息。
- **全仓清理悬挂引用**：`grep -rn "README\.md" --include=*.md --include=*.mjs --include=*.js --include=*.json .
  -not -path "*/node_modules/*"`，把指向根 README 的链接改到 AGENTS.md 或对应树 README；指向发布 README 的保留。
- 报告里写清一个副作用：GitHub 仓库首页默认渲染 `README.md`，删掉后首页不再有渲染的说明页、只剩文件列表
  （`AGENTS.md` 仍是唯一入口文档）。这是用户明确选择，照做即可，但要写进收尾报告。

## 5. 验收

1. `AGENTS.md` 里**不再有只对单棵树成立的内容**：收尾报告给一张"逐节去向表"（原章节 → 保留/迁到哪个文件/删除）。
2. 根 `README.md` 已删；`grep` 结果里**没有任何指向它的悬挂引用**。
3. 各树 README 含迁入的约束，且与 AGENTS **不重复**（抽查若干条，确认只有一处正本）。
4. **三份发布 README 零改动**（`git diff --stat` 里不出现它们）；`package.json` / 版本 / CHANGELOG / 代码
   **零改动**。
5. 定向核验（执行者跑）：`pnpm guard`、`pnpm prepublish:assert`（都会读到 README 存在性与首行，确认没被这次
   删除误伤）；`git status` 里只有文档文件。
6. 收口由派单方跑（`pnpm check:fast` 视改动而定 + 发版档在发版时跑）。

## 6. 边界

- 只动文档：根 `AGENTS.md`、`base/README.md`（新建）、`mem/README.md`、`mission/README.md`、根 `README.md`（删除），
  以及为消除悬挂引用而必须改的少量文档里的链接。
- **不碰**三份发布 README、不改 `package.json`/版本/CHANGELOG、不改任何代码与门禁脚本。
- 不重新引入已被删除的旧规则（例如"base 必须是 required peer / 绝不放 dependencies"）；开工前**重新完整读一遍
  当前的 `AGENTS.md`**（它刚被另一个任务改过）。

## 7. 参考坐标

- `AGENTS.md`（当前全貌，尤其 `## 体量与枢纽文件`、`## 子树约定`、`## 边界与路径`）
- `README.md`（待删）、`docs/README.md`（docs 索引，**保留**）
- `mem/README.md`、`mission/README.md`（已有开发 README，迁入目标）
- `base/plugin-base/docs/`（base 的开发文档所在地；`base/README.md` 是新建的树级入口）
