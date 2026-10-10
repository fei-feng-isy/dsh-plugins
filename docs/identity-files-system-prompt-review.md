# 评审：用工作区身份文件替换 system prompt（2026-10-10）

> 本文是对 [`identity-files-system-prompt.md`](identity-files-system-prompt.md)（下称**方案**）的**落地前评审**：
> 结论、逐条核验证据、对方案的修订要求、建议的第一步、待拍板的开放项。
>
> **基线与方法**：运行版本 `@deepseek-ai/dsh` **0.2.0-rc.2**（全局安装产物，路径见 §7）+ 上游 checkout
> `/home/qunqi/opensource/harness/deepseek-harness`；web profile 在 `~/.dsh/profiles/web`。评审方式是**读实现与
> 类型**（未做实机 spike，见 §5）。**凡与方案冲突处，以本文 §4 的「修订要求」为准**（每条点名方案小节）。

## 1. 结论

**机制可行。** `complete: true` 是上游唯一能"整段取代" system prompt 的扩展点，方案对它的用法、服务名、
注册写法、以及"文件 → 文本"的取值来源，**逐条在真机代码里对上**（§2）。但有 1 处事实错误、1 处明显低估、
2 处验收/落地补强、1 个可选增强：

| 编号 | 类型 | 一句话 |
| --- | --- | --- |
| **R1** | 低估（最重要） | `complete` 顶掉的 section 远不止"第一方工具指引"：web profile 配置里**有 20 个包**会注册 section（含 Agent Teams / plan mode / goal / subagent / jobs / web / workflow / MCP…） |
| **R2** | 事实错误 | 0.2.0-rc.2 的 web profile **没有**"推理翻译"插件（全量搜过包名与 preset）→ 需求 4（思考用中文）**没有任何开关** |
| **R3** | 验收补强 | §7 要断言**具名清单**的 section 消失，并**断言 runtime context 仍在**（安全相关通道） |
| **R4** | 落地补充 | 新树要加 `pnpm-workspace.yaml` glob；**边界守卫是发现式的**（不用改守卫）；**私有 manifest 不许带 `version`** |
| **R5** | 可选增强 | 加 `mode: 'filter'`：用 `system-prompt/assemble` 瀑布**只删指定 section**——"替换身份但保留能力指引"的中间路（方案 §4.4 一笔否掉瀑布是过头了） |

## 2. 逐条核验：方案 §3 的 11 条事实

| # | 方案主张 | 我验到的证据（installed 产物） | 判定 |
| --- | --- | --- | --- |
| 1 | system prompt = 有序 section 拼接；空 section 消失、其余空行连接 | `dsh-system-prompt/lib/index.js:113-115`：`map(…) .filter(t => t.length > 0) .join("\n\n")` | ✓ |
| 2 | `complete: true` 在瀑布**之后**成为**唯一** section；同 scope ≥2 个生效 complete → 装配抛错 | 同文件 `:335-336`（`multiple complete prompt sections are active: "a", "b"`）、`:356-362`（`sections: [completeSection]`） | ✓ |
| 3 | `text` 支持函数、每次装配求值；`interpolate` 默认 `true`，`{{name}}` **严格**解析（未注册/无值/写错 → 抛错） | 类型 `lib/types/index.d.ts:60-62`；实现 `lib/index.js:160`（malformed）、`:169`（unknown）、`:172`（has no value） | ✓ |
| 4 | `{{provider}}/{{model}}/{{cwd}}` 由 agent-loop 注册，`cwd` 取 `agent.session.header.cwd` | `dsh-agent-loop/lib/index.js:1564-1566` | ✓ |
| 5 | section 的 `text` provider 能拿到 `AssembleContext.agent` | `dsh-agent/lib/types/runtime-types.d.ts:15-18`（dsh-agent 合并了该接口） | ✓ |
| 6 | runtime context 是独立 user 角色快照，**不受** complete 影响；`suppressRuntimeContext()` 可关 | `lib/index.js:356-362`：恢复**只替换 `sections`**，`contexts` 原样保留；类型 `:265` 有 `suppressRuntimeContext` | ✓ |
| 7 | `agent-instructions` 注入的是 **user 角色** `<system-reminder>` | `dsh-agent-instructions/lib/index.js:111-112`、`:780`（"Build the **user-role** message"）、`:1271`（`agent/pre-step`） | ✓ |
| 8 | 候选文件名可配，但只收**同目录文件名**；全局两个根只读固定名 `AGENTS.md` | `lib/index.js:17`（默认 `["AGENTS.md","CLAUDE.md"]`）、`:76`（`!/[\\/]/.test(candidate)`） | ✓（"全局根固定名"未单独复核） |
| 9 | web-app 宿主行 `disabled: true`，由 preset 以 `maxBytes: 65536` 挂载 | `dsh-web-app/cordis.patch.yml:549-550`、`dsh-web-app/presets/standard.patch.yml:16-19` | ✓ |
| 10 | profile 行覆盖是**整段替换 `config`**；preset 声明也是整体替换 | 未找到方案所引位置的对应源码 | **未复核**（只影响"若曾把三个名字加进候选时怎么改"，见 §8） |
| 11 | 0.2.0-rc.2 的 API 面：`section`/`assemble`/`getSectionOrder`/`suppressRuntimeContext`；**无** `refreshContext` | `lib/types/index.d.ts:226-294`（`section(): () => void`、`assemble(): Promise<PromptAssembly>`） | ✓ |

## 3. 机制选择正确，另补三条**精确语义**

1. **"完全替换"的准确含义**：恢复只替换 `sections`；`tools`（工具 schema）与 `contexts`（runtime context）
   **照旧保留**（`:356-362`）。所以模型仍然看得见**工具定义**、仍然拿得到**沙箱/审批/时间**等上下文，
   真正失去的是"**散文式的能力指引**"——这正是 R1 要量化的那一块。
2. **`text` 是同步的**（类型 `:60`）：方案 §4.1 的 v1（同步读 + `(mtimeMs,size)` 缓存）成立；v1.1 的价值不是
   "更快"，而是**别在装配路径上做同步 I/O**——选它就必须在 README 写清"本轮读到的是上一轮内容"的时序语义。
3. **服务挂载层级**：`system-prompt` 行位于 `dsh-web-app/cordis.patch.yml:16` 的**根**层 → 方案 §5.2 的
   宿主级 `insert` 一行**可行**；与 `persona` 的互斥也确有其事（`persona/src/index.ts:42-52` 有 `complete?: boolean`）。

## 4. 修订要求（对方案的小节）

- **R1 → 方案 §2 表格 + §8.1 + §7.2**
  - §8.1 的代价要写全：实测 web profile 配置里有 **20 个包**会注册 section（静态交集，见 §8）：
    `dsh-tools`、`dsh-tool-{bash,fs,fs-search,pwsh,jobs,web,workflow,goal,ralph,subagent}`、`dsh-subagent`、
    `dsh-experimental-tool-agent-team`、`dsh-plan-mode`、`dsh-mcp-resources`、`dsh-file-reference-local`、
    `dsh-client-ui-deliverables`、`dsh-persona`、`dsh-web-app`、`dsh-system-prompt`。**complete 会把这些全部顶掉**，
    包括 **Agent Teams**、plan mode、goal、subagent、jobs、web、workflow 的能力指引。
  - §7.2 的验收从"第一方工具指引不再出现"改为**断言具名清单**（至少覆盖 Agent Teams / plan mode / tools 三项）。
  - §2 的结论行加一句：`dsh-persona` 的 `complete` 是**替代品**这一条成立；同时它是唯一的既有 complete 使用者，
    与本插件互斥（§8.2 已写 ✓）。
- **R2 → 方案 §8.3**：删掉"可让用户在 Plugins 里启用实验性的 Reasoning translation"。**该插件在 0.2.0-rc.2 的
  web profile 里不存在**（我全量搜过：`@deepseek-ai/*` 包名无 `reason|think|translat`，web-app 的 patch 与 presets
  里也无相关配置）。改成：**需求 4 只能靠身份文件里的措辞影响，不保证**；要真正改变推理语言需上游支持。
- **R3 → 方案 §7** 新增两条验收：
  1. 断言 `assemble()` 结果里 `sections.length === 1` 且 `name === 'avantf:identity'`，同时 `tools.length > 0`
     （工具 schema 未丢）；
  2. 断言 `contexts` **仍非空**（runtime context 未被"完全替换"误伤）——这是安全相关通道。
- **R4 → 方案 §5.1** 补三句：
  - 新树要在根 `pnpm-workspace.yaml` 的 `packages:` 加 glob（当前是 `base/*`、`mem/packages/*`、`mission/packages/*`…）；
  - **边界守卫是发现式的**：`scripts/boundary-guard.mjs` 的 `discoverGuardTrees()` 会自动把新树纳入"只够得到 base 与
    自己"的规则，**不用改守卫**；
  - 私有 manifest **不许带 `version`**（`pnpm version:check` 会报错），版本只在 `pnpm pack` 那一刻临时写入。
- **R5 → 方案 §4.4 改为"备选而非否掉"**：`system-prompt/assemble` 瀑布是 `mode: 'filter'` 的实现手段——注册一个
  高优先级普通 section（不设 complete），再用瀑布把**指定名字**的 section 过滤掉（例如 harness identity），
  从而"**替换身份、保留能力指引**"。注意：瀑布在 complete 恢复**之前**运行，所以 filter 模式与 complete 模式
  **互斥**，要按配置二选一。建议作为**非默认**选项提供，README 写清代价差异。

## 5. 建议的第一步：**离线 spike**（不调模型，约半小时）

比"先建树再试"便宜得多，且能一次验完四件事：

1. 写一个临时插件（20 行）：`inject = ['systemPrompt']`，`ctx.effect(() => ctx.systemPrompt.section({ name:'spike:identity',
   order:0, complete:true, interpolate:false, text: () => readFileSync(tmpPath,'utf8') }))`；
2. 在脚本里拿到 `ctx.systemPrompt` 后调 `assemble(context)` + `renderPrompt(assembly)` 打印：
   ① `sections.length === 1`；② 改临时文件后**下次装配即变**；③ 同时注册两个 complete → 抛
   `multiple complete prompt sections are active`；④ `contexts` 仍在。
3. 过了再按方案 §5 建树、写配置表与验收。

## 6. 待拍板的开放项（方案 §6）与建议

| 项 | 我的建议 |
| --- | --- |
| 是否进可发布面 | **A**：先 private + `link:`；确认好用再考虑当第 4 个可发布包（那要动 `release-check` / gates / AGENTS 表格） |
| 读取/刷新策略 | **v1**（同步 + 缓存）；若在意装配路径的同步 I/O 再上 v1.1，并把时序语义写进 README |
| `onMissing` 默认 | **`keep`**（退回原 prompt，不静默变空） |
| `interpolate` 默认 | **`false`**（文件即字面量；`true` 时文件里任何 `{{未注册}}` 会让每次装配抛错） |
| 是否 `suppressRuntimeContext` | **否**（保留沙箱/审批/时间等必要上下文） |
| 是否做 R5 的 `filter` 模式 | **建议做**（非默认）：它是"想换身份但不想丢 Agent Teams/工具指引"的唯一正路 |

## 7. 本次评审实际读过的坐标

- installed（`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）：
  `dsh-system-prompt/lib/types/index.d.ts:47-70,226-294`、`dsh-system-prompt/lib/index.js:113-115,160,169,172,335-362`、
  `dsh-agent/lib/types/runtime-types.d.ts:15-18`、`dsh-agent-loop/lib/index.js:1564-1566`、
  `dsh-agent-instructions/lib/index.js:17,76,111-112,780,1271`、
  `dsh-web-app/cordis.patch.yml:16,549-550`、`dsh-web-app/presets/standard.patch.yml:16-19`
- 上游 checkout：`packages/preset/persona/src/index.ts:27,42-52,63-69`（存在）
- 本仓：`pnpm-workspace.yaml:1-8`、`scripts/boundary-guard.mjs`（发现式守卫的注释与 `discoverGuardTrees()`）、
  `docs/README.md`（索引）

## 8. 未复核 / 需实机确认（诚实清单）

- 方案 §3 第 **10** 条（profile 行覆盖=整段替换 config、preset `definitions.set`）：**未找到对应源码位置，未复核**。
  它只影响"如果此前把 `IDENTITY.md`/`SOUL.md`/`RULES.md` 加进过 `agent-instructions` 候选"时的处理方式；
  实施时先 `grep` 一遍 profile/preset 的候选配置确认即可。
- §2 里的"**20 个包**"是**静态交集**（配置文件里出现 ∧ 该包 `lib/index.js` 调用了 `systemPrompt.section(`），
  **实际生效面**（哪些在 web 会话里真的注册了 section、是否条件注册）需 spike 或实机确认。
- 方案 §7.7 的实机验收（真实会话 + key）与 §7.1/§7.6 的行为断言：**本次未做**（评审只读代码）。
- "全局两个根只读固定名 `AGENTS.md`"（§3 第 8 条后半）：未单独复核。
