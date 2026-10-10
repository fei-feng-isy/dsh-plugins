# avantf-identity

DSH（DeepSeek Harness）的**身份文件**插件：`@avantf/dsh-identity`。

它把系统提示词里的**身份部分**换成用户自己的三个文件——`IDENTITY.md`（身份）、`SOUL.md`（灵魂）、
`RULES.md`（规则），**不动任何其它 section**。权威规格：根目录
[`docs/identity-files-system-prompt.md`](../docs/identity-files-system-prompt.md)（v2）。

## 机制（一句话）

注册一条普通 section `avantf:identity`（占据 `HARNESS_IDENTITY` 的槽位 order `-1000`），再用一条
`system-prompt/assemble` 瀑布监听器**按名字**删掉 `harness:identity` 与 `deployment:persona-prefix`。

**绝不用 `complete: true`**：那条语义是"用我这一条替换整份 `sections`"，会把 web profile 里 20 个包注册的
能力指引一起顶掉。

## 树布局

| 路径 | 内容 |
|---|---|
| `packages/plugin` | 唯一的包：宿主半边（`src/`）+ 浏览器半边（`src/client/`） |
| `packages/plugin/assets/presets/<id>/<locale>/` | 内置预设资源（3 预设 × 2 语言 × 3 文件），构建期拷进 `lib/assets/` |
| `packages/plugin/test/` | `mechanism.spec.ts`（规格 §9.1 的断言 + P6 会话冻结）、`session_freeze.spec.ts`、渲染、预设、路径 pin、wire |

## 本树专有约定

- **磁盘布局**（`src/paths.ts` 是唯一定义处）：`<data home>/identity/{profiles/<profile>/{IDENTITY,SOUL,RULES}.md, presets/<id>/<locale>/*.md, .provisioned}`。
  生效身份**只有一份来源** `profiles/<profile>/`；改预设不影响它，只有"应用"写它。
- **只补缺失、永不覆盖**：内置预设的释放记录在 `.provisioned` 的 `presets` 列表里，所以"删掉一个内置预设"是永久的，
  而"包内新增的预设"仍会被补出来。
- **数据根的 base-less 兜底是一份刻意的镜像**（`src/paths.ts` 的 `resolveDataHomeMirror`），
  由 `test/paths.spec.ts` 对着**已链接的 base** 逐例比对钉住；改它 = base + identity 两处。
- **两个必须避开的坑**：绝不把 `remote.avantfIdentity` 写进 cordis `inject`（client entry 会永久 pending、
  启动审计抛错）；出参必须在 wire schema 里全声明（严格 codec 会剥未声明字段）。
- **dsh 下限 0.1.5 的编译约束**：那一代的 `PromptSection` 没有 `interpolate`，所以注册 section 的参数必须
  先放进变量再传（fresh object literal 会被 TS 的 excess-property 检查拒绝，`pnpm check:old-dsh identity`
  就是这条的看门人）。在 0.1.5 上该字段被忽略，宿主永远严格插值——README（发布面）已写明。
- **会话内冻结**（`src/session-freeze.ts` + `src/index.ts` 的 text provider）：身份文本按 `context.agent.session`
  对象冻结（WeakMap），开关也随之冻结——waterfall 的删段判定看**冻结后的文本**而不是实时 `enabled`。
  理由与验证见规格 §3.6；`mechanism.spec.ts` 的 P6 是端到端看门人。
- **设置页 slot**：`ctx.slots.inject('settings.section', …)`，id `identity`、order 25（在 `account` 之后）。
- **发布面**：第 4 个可发布包，`build` / `pack` / 门禁与 mem、mission 同一套形态
  （`scripts/lib/plugins.mjs` 是发现式的：本树根 `package.json` 的 `build:dsh` 是唯一的登记点）。
- **测试面**：`pnpm -C identity test`；`pnpm check:fast identity` 是日常档。
