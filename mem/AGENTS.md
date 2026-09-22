# AGENTS.md

给在 `avantf-mem` 上工作的编码 agent 的指引。

## 架构不变量

- **两个存储，一个检索内核。** `memory` 与 `knowledge` 是各自独立、自足的存储（自己的 DB + 自己的读模型）。两者都建在 `retrieval-core`（`@avantf/mem-core`）之上。
- **跨存储检索 = 联合融合。** memory 与 knowledge 分别查询，然后候选合并、在**合并后的池**上做 `min-max` 归一化，使分数可比。永远不要按存储各自归一化。这里只描述**跨存储**那一步：在单个存储内部，每条腿按自己的最大值缩放（`retrieval-core/src/fusion.ts`），那不是 `min-max`，所以不要把上面的 `min-max` 读成在描述存储内融合。（其中一条腿，即 HRR 探针，可能按非分数顺序截断，因此对截断不具不变性 —— 见 DESIGN §20.17。）
- **检索的可插拔性是内部的。** `SemanticBackend` / `Reranker` / `VectorStore` 通过 `retrieval-core` 内部的注册表 + 配置来替换。业务流（存储、工具、UI）只依赖接口。**不要**把它们注册成 DSH 插件或 Cordis service；不要让 DSH 插件去选择后端。
- **一张派发表，一套检索编排。** contract 工具键 → 运行时的映射**只**住在 `core/src/dispatch.ts`，由 DSH 插件（工具 + Remote 网关）与 MCP server 共享；两个存储都跑的那套检索流程（limit → weights → over-fetch → leg cap → fuse → live filter → rerank → slice → output budget → health event）**只**住在 `core/src/store/hybrid.ts`。这两处都被复制过一次，且两份副本都漂移了：MCP server 对外宣称了四个它自己的 switch 从没听说过的 `kb_*` 工具（每次调用都回 `unknown tool key`），而 `NaN` limit 守卫 / `over_fetch_factor` / `recordLegCapped` 各自只存在于 memory 一侧。不要再分叉这两处 —— 新的工具键进 contract 和 `dispatch.ts`，新的腿进某个存储的 `searchLegs`。
- **Generate 是外部的（Plan A）。** 插件只返回检索到的上下文 + 出处。它绝不在插件内部生成答案。
- **Memory 没有用户隔离** —— 单一共享存储（agent 上下文）。`user_hash` 分区不要引入。

## 约定

- TypeScript，`module: NodeNext`。相对 import 带 `.js` 扩展名。
- 工具/配置 schema 的唯一真源是 `@avantf/mem-contract`（`zod`）。每个工具 schema、MCP inputSchema、CLI 参数与 UI payload 类型都由它派生。
- **依赖版本住在 `pnpm-workspace.yaml` 的 `catalog:` 里**，以 `"catalog:"` 引用。改 catalog 那一行，永远不要改 `package.json`。`zod` 在那里被精确钉住，因为 `@avantf/mem-contract` 与 `@avantf/dsh-mem` 必须加载**同一份**副本：两份副本 —— 哪怕同一个 major —— 类型身份也不兼容，这正是当初被迫写 `TypertSchema['schema']` 转换的原因（DESIGN §20.11）。`pnpm why zod` 必须让 `@avantf/mem-contract` 与 `@avantf/dsh-mem` 一直解析到**一份**副本 —— 它也会列出 `@modelcontextprotocol/sdk` 下面的一份传递副本，那不是我们的：MCP server 交给那个 SDK 的是纯 JSON Schema，从来不是 schema 对象，所以没有 zod 身份跨过边界。
- **`@avantf/*` 家族依赖是被 provision 的，不是被打包的。** `@avantf/dsh-plugin-base` —— **一个**包，承载家族的环境初始化框架、它的宿主兼容性门禁（规则 / 探针 / 裁决 / 报告 / 注册后校验）以及共享 kit（`src/kit/**`）—— 是插件的 **peerDependency**（peer 范围 `^0.1.0`；插件同时在 `devDependencies` 里声明 `^0.1.3`，好让 `pnpm install` 装上它），且**绝不打包**、**绝不以说明符 import**：插件唯一的静态引用是一个内联进产物的零依赖 bootstrap（`packages/plugin/src/envinit-bootstrap.js`，从已安装 base 的 `dist/bootstrap.js` vendor 而来），它用 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` 解析 base、动态 `import()` 它，并用内联的 `supportedRange` 校验版本。引擎（`@avantf/mem*`）留在 `devDependencies` 里让 tsdown 内联。旧的 `@avantf/dsh-envinit` 与 `@avantf/dsh-compat` 包**已死**：不再有新版本，也没有任何东西依赖它们。本地开发不需要 checkout：`scripts/link-envinit.mjs`（由 `pnpm build:dsh` 运行）读取已安装的 base，把它的零依赖 `dist/bootstrap.js`/`dist/bootstrap.d.ts` vendor 进 `packages/plugin/src/envinit-bootstrap.{js,d.ts}`（`DSH_ENVINIT=<checkout>` 是显式 opt-in，改为软链一个 checkout 并从那里 vendor）；宿主半边由 tsdown 从 tsc 产物打包，所以 `scripts/copy-envinit-bootstrap.mjs` 在 **`tsc` 与 `tsdown` 之间**把 vendor 来的 bootstrap 移进 `lib/types/`，随后 `scripts/assert-envinit-artifacts.mjs` 断言 bootstrap 已内联、base 从未以说明符被 import、`lib/client.js` 是干净的（`scripts/pack-plugin.mjs` 在打包出的 tarball 上再断言同一套）。**先发布 base，再发布插件**：发布门禁（`scripts/release-check.mjs`）会拒绝发布一个插件，除非 registry 上已经有一个落在该插件可接受 peer 范围内的 `@avantf/dsh-plugin-base` 版本。Tarball 绝不能带 `link:`/`file:` 说明符（`scripts/pack-plugin.mjs` 与 `make-release-tree.mjs` 都会拒绝）。整个合并工作区的 `zod` 从**根** `pnpm-workspace.yaml` 的 `catalog:` 解析出**一份**（`zod: 4.6.5`，跟随已安装 dsh 自带的版本）—— 改 catalog 那一行，永远不要改 `package.json`；base 的 `zod` peer 保持宽范围 `>=4.4.3 <5`，让同一份 base 既服务工作区、也服务已安装的 dsh。共享业务逻辑在**运行时**从 base 消费，所以那里的修复只需**一次** base 发版、不必重建插件 —— 唯一的例外是 `typert` 的 `strict` wire codec 和那几个字面量描述符约定，它们留在各插件里（只是镜像宿主约定的一两行）；改这些需要一次插件发版。**家族的三条硬约束**（不变量）：(1) envinit 式 provision **绝不打包、绝不静态 import**；(2) base 由**框架/宿主提供，并按 file URL 动态加载**；(3) **发布顺序是 base → 插件**，且 tarball 不带 `link:`/`file:`。**“运行时取自 base 还是留在插件？”的判断准则**：问*“这条知识必须能靠一次 base 发版修好吗？”* 能 → 运行时从 base 取。不能（它只是两三行字面量、镜像一条宿主约定）→ 可以留在插件里，但那时要写明**“改它需要一次插件发版”**。改完 `base/**` 下的共享代码后，要把**两个**插件的完整门禁都重跑：mem `pnpm build:dsh` + `node scripts/mount-smoke.mjs`，work `pnpm release:check` + mount-smoke。
- **插件的 `@deepseek-ai/*` 必须与运行中的 `dsh` 是同一份副本。** `scripts/link-dsh.mjs` 只从**已安装**的全局 dsh（`npm root -g`）链接它们，别处都不链接；链一份、跑另一份，插件拿到的宿主就与它的运行宿主不同，而 `ctx.typert.register`/工具注册表是按对象身份做键的。插件的**编译、类型检查与挂载只针对已安装的 dsh** —— 没有 checkout 模式，也没有模式开关。tsdown 的 client preset 是**钉在本仓库里**的逐字副本（`packages/plugin/vendor/dsh-client-preset/`，8 文件 / 2334 行，来源与重新对齐步骤见其 `ORIGIN.md`），以字面相对说明符 import，从不由环境变量选择，所以构建完全不需要 harness 源码。那份副本定义了浏览器半边的 ABI，因此逐字复制，且必须与钉住的 harness 修订保持字节一致。harness checkout **只**被可选的漂移交叉校验 `scripts/check-preset-drift.mjs` 使用（有 checkout 时也会以 `link-dsh` WARNING / `release-check` 备注的形式打印）—— 它从不参与编译、类型检查或挂载。不要裁剪或“简化”那份副本；它必须移动时，逐字重新复制、更新 `ORIGIN.md`，并重新验证 harness-preset 构建与 vendored-preset 构建产出的 `lib/index.js` + `lib/client.js` sha256 相同。
- 读 zod 内部：用 `def.type` / `def.shape`（是对象）/ `def.values`，并优先用 `z.toJSONSchema(schema, { io: 'input' })`，而不是手搓派生。读错内部是**静默**的 —— 字段会摊平成 `{}` 且不报类型错 —— 所以 `contract.spec.ts` / `tool_schema.spec.ts` 里钉住的形状断言才是门禁，而不是可选覆盖。不要在嵌套 schema 上用 `.default({})`：v4 不会把默认值送进去解析 —— 用 `.prefault({})`。
- 配置分层：内置默认 → `.avantf/configs/common.yaml` → 存储配置 → 环境 → 显式。除非设计需要，不要新增优先级层级。
- 每个领域单元都要加测试。检索对齐门禁是中文评测集（`packages/core/src/eval` + `packages/core/test/eval_zh.spec.ts`，35 条查询 —— 起初 29 条，后来补上了“两个 CJK 字符”那种形状）；它的汇总数字是**冻结**的、按位精确断言，所以任何会移动检索结果的改动都必须重新冻结这些数字并解释移动原因。它住在 `@avantf/mem`，不在 `@avantf/mem-contract`：评测驱动的是存储，而 contract 没有可驱动的运行时。
- `pnpm typecheck` 也检查 `test/`（每个包的 `tsconfig.test.json`）：让只存在于测试里的类型保持诚实 —— 一个引用了不存在的类型、或引用了运行时永远不会返回的形状的 spec，是转译器**不会**报告的错误。CI 在 `pnpm build` **之后**跑这一步（包通过各自产出的 `lib/*.d.ts` 读依赖）。
- `pnpm typecheck:dsh` 覆盖 `packages/plugin`（src + specs）。它是**本地**门禁：它通过已安装的 DSH harness 解析 `@deepseek-ai/*`，而 CI 没有这个，所以动插件之前要手工跑。它之所以与 `pnpm typecheck` 分开，正是这个原因，而不是因为插件可以豁免这条规则。

## 目录结构

不要把数据文件搬出 `~/.avantf/{memory,knowledge}`；用户**编辑**的一切都住在
`~/.avantf/configs/*.yaml` 与 `~/.avantf/prompts/*.md`，绝不放在数据库旁边。守住 `retrieval-core` 边界：适配器在 `retrieval-core`，存储在 `core`，`plugin` 里的 DSH 插件是一层薄壳（不做后端选择）。
