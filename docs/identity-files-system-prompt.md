# 用身份文件替换 system prompt：需求与实施规格 v2（2026-10-10）

> **本版是重写**。v1 的核心机制（`complete: true` 的 section）已被否决：它会把 web profile 里
> **20 个包**注册的能力指引 section 一起顶掉（见 [`identity-files-system-prompt-review.md`](identity-files-system-prompt-review.md) R1），
> 而那正是本次要避免的。v2 改用**按名字的瀑布过滤 + 身份 section**，只替换身份、不动任何其它 section。
>
> 范围：新增插件包 `@avantf/dsh-identity`（宿主半边 + 浏览器半边）、它在 web profile 的挂载、身份/预设的
> 磁盘布局、设置页 UI、验收证据。**不改上游 dsh 仓**。发布面**已定**：它是插件族的**第 4 个可发布包**，
> 编译 / 打包 / 发布形态与 mem、mission **完全一致**（§7）。
>
> 与评审的关系：R1 由机制更换解决；R2 接受（需求 4 无开关，本文不承诺）；R3 的验收口径在 §9 重写；
> R4 的三条落地补充在 §7/§8 落实；R5 的 `mode: 'filter'` 成为**主机制**。

## 1. 需求（用户口径）

1. 身份由配置目录里的三个文件承载：`IDENTITY.md`（**身份**——你是谁、叫什么、扮演什么角色）、
   `SOUL.md`（**灵魂**——语气、价值观、行事风格、判断取舍的原则）、`RULES.md`（**规则**——硬约束、
   必须做与禁止做）。三者合起来**取代**现有 system prompt 里的身份部分。
2. **不覆盖其它包注册的 section**：工具指引、Agent Teams、plan mode、goal、subagent、jobs、web、
   workflow、MCP 等的能力指引**一条不少、一字不改**。
3. 三个文件都不存在或都为空时，**加载原生 system prompt**（不是空 prompt）。
4. 文件按 **profile** 隔离（web profile 一套，cli profile 另一套）。
5. UI 放**设置页**（不是像 mem/mission 那样放主窗口），且要有：
   - 一个总开关：开启即替换 system prompt；
   - 三个文件的查看与编辑。
6. 内置三个预设身份：**程序员 / 助理 / 分析师**；且**每个预设都是多语言的**——用哪种语言**跟随 dsh 的语言
   设置**，某个预设**没有当前语言的版本时退回英文**。
7. 预设身份可修改、可新增；它们放在预设目录下（如 `presets/coder/`）。
8. 包里要内置这些预设的资源文件，插件**首次运行时**把它们释放到预设目录。
9. 形态与家族一致：`@avantf/dsh-identity` 的编译 / 打包 / 发布方式与 `@avantf/dsh-mem`、`@avantf/dsh-mission`
   相同（同一套 `build:dsh` / 门禁 / 发布面）。

非目标：不改上游；不做"推理语言"开关（上游没有这个能力）；不接管 `AGENTS.md` 的既有行为；
不替别的包改写它们注册的 section 文本；**工作区级（按会话 cwd）覆盖不在本版**——身份按 profile 隔离
（v1 的"放工作区 `IDENTITY.md`"被本节取代；将来若要"每个项目一套身份"，再在 `profiles/<name>/`
之上加一层 cwd 覆盖，读取顺序不变、机制不用改）。

## 2. 结论：为什么不能用 `complete`

`complete: true` 的语义是"装配之后，把整份 `sections` 换成我这一条"：

```js
// ~/.npm-global/.../@deepseek-ai/dsh-system-prompt/lib/index.js:355-362
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', assembly, context, ...)
if (completeSection === void 0 && !runtimeContextSuppressed) return transformed
return { ...transformed,
  sections: completeSection === void 0 ? transformed.sections : [completeSection],  // ← 全部顶掉
  contexts: runtimeContextSuppressed ? [] : transformed.contexts }
```

代价不是"能配置的"，而是这条语义本身：被顶掉的是 web profile 里 20 个包注册的全部 section
（`dsh-tools`、`dsh-tool-{bash,fs,fs-search,pwsh,jobs,web,workflow,goal,ralph,subagent}`、`dsh-subagent`、
`dsh-experimental-tool-agent-team`、`dsh-plan-mode`、`dsh-mcp-resources`、`dsh-file-reference-local`、
`dsh-client-ui-deliverables`、`dsh-persona`、`dsh-web-app`、`dsh-system-prompt`；实测交集复现 20 个）。

**上游给的"外科手术"入口是同一条瀑布**，类型注释写得很明确：

```ts
// dsh-system-prompt/lib/types/index.d.ts:16-27
/**
 * Expert waterfall over the assembled sections, contexts, tools, and variables.
 * ... A registered complete section is restored after this waterfall, so listeners
 * cannot add to or replace the prompt when a complete section is active.
 * @mode waterfall
 */
'system-prompt/assemble'(assembly, context, next): Promise<PromptAssembly>
```

即：**只要不注册 complete，瀑布的返回值就是权威的**。这就是 v2 的机制。

## 3. 替换机制（最终设计）

### 3.1 "身份"是具名 section，不是一团不可分的文本

0.2.0-rc.2 实机里与身份相关的 section 只有这几条，其余全是能力指引：

| section 名 | order | 内容 | 注册者 |
| --- | --- | --- | --- |
| `harness:identity` | **-1000** | `You are an AI agent powered by DeepSeek Harness.` | `dsh-system-prompt` 服务自身（`lib/index.js:216-219`，由 `Config.includeHarnessIdentity` 控制，默认 true） |
| `deployment:persona-prefix` | 0 | `You are a coding agent powered by the {{model}} model.` | 服务 config（`personaPrefix`）+ `web-app` patch；preset 的 `persona` 行在会话作用域**同名遮蔽**它 |
| `deployment:persona-suffix` | 10200 | `Your working directory is {{cwd}}.` | 同上（保留：这是信息，不是身份） |
| `harness:source` | 10000 | checkout 路径那段英文 | `dsh-app-boot`（`HARNESS_SOURCE_SECTION`） |
| `app:web-surface` | 10100 | Web UI 那段英文 | `dsh-web-app`（`app:web-surface`） |

所以"替换身份" = **具名删掉前两条 + 在同槽位插入自己的 section**。`order` 用
`systemPrompt.getSectionOrder('HARNESS_IDENTITY')`（公开 API，返回 -1000），身份因此排在
persona 与所有工具指引之前，与原生位置一致。

### 3.2 注册 + 瀑布具名过滤

```ts
// src/index.ts（要点，非最终代码）
export const name = 'avantf-identity'
export const inject = ['systemPrompt']

const OWN = 'avantf:identity'

export function apply(ctx: Context, config: Config): void {
  const state = createIdentityState(ctx, config)   // 文件读取 + (mtimeMs,size) 缓存 + 渲染

  // ① 身份文本占 HARNESS_IDENTITY 槽位（-1000）；关/缺失时返回 ''，空 section 会被 renderPrompt 丢掉
  ctx.effect(() => ctx.systemPrompt.section({
    name: OWN,
    order: ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY'),
    interpolate: config.interpolate,               // 默认 false：文件即字面量
    text: () => state.render(),
  }), 'avantf-identity:section')

  // ② 只摘掉被点名的 section，其余原样放行
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()                          // cordis waterfall：不调 next 会否决整条链
    const own = out.sections.find((s) => s.name === OWN)
    const applicable = config.enabled && own !== undefined && own.text.length > 0
      && (config.replaceScope === 'all' || isMainAgent(context))
    const drop = new Set<string>(applicable ? config.drop : [OWN])
    if (drop.size === 0) return out
    return { ...out, sections: out.sections.filter((s) => !drop.has(s.name)) }
  })
}
```

要点与理由：

- **cordis waterfall 的正确形状**是 `await next()` 之后再返回改过的对象（`cordis/lib/index.js:317-325`：
  监听器签名是 `(...args, next)`，不调 `next` 即否决后续，最外层返回值是最终值）。
- 全局监听器对**所有 scope 都生效**（`dsh-scope/lib/index.js:327-340`：`scopeOf(listenerCtx) === undefined`
  一律放行；子代理的 `tag` 也能匹配到自己的链路），所以要自己按作用域收窄。
- `drop` 默认 `['harness:identity', 'deployment:persona-prefix']`。两个名字都在上游类型里点名过：
  persona 的两个名字是**导出的常量**（`PERSONA_PREFIX_SECTION` / `PERSONA_SUFFIX_SECTION`），
  `harness:identity` 目前**只有字面量**（`PromptSectionOrderName.HARNESS_IDENTITY` 是数字，不是名字）——
  用一条断言 + spike 钉住它，上游改名时测试先红。
- 身份 section 的注入口径：**不设 `complete`**，普通 section 即可（`PromptSection` 只有 `complete`/`interpolate`
  两个可选开关）。

### 3.3 作用域：只改主会话，子代理零影响

`AssembleContext` 带 `agent`（`dsh-agent/lib/types/runtime-types.d.ts:15-18` 合并进该接口），
子代理会话的 header 有明确标记（`dsh-session/lib/types/types.d.ts:58-94`：`origin?: 'subagent'`、
`delegationDepth?: number`、`parentSession?`；`dsh-subagent` 造子会话时写 `origin: 'subagent'` +
`delegationDepth`，见 `dsh-subagent/lib/index.js:401,478-479`）：

```ts
function isMainAgent(context: AssembleContext): boolean {
  const header = context.agent?.session.header
  return header?.origin !== 'subagent' && (header?.delegationDepth ?? 0) === 0
}
```

- `replaceScope: 'session'`（**默认**）：主会话替换；子代理/Agent Teams 成员**逐字保持原生**，
  既不被删 `harness:identity`，也看不到我们的身份 section。这直接兑现需求 2 的"不动别人的东西"。
- `replaceScope: 'all'`：子代理也替换（可选；但会与 `dsh-subagent` 给子代理挂的
  `deployment:persona-prefix`（`dsh-subagent/lib/index.js:517-520`）冲突——**因此默认不是它**）。

### 3.4 开关与"没有文件 → 原生"（需求 3）

- **开关** = 插件 Config 里的 `enabled` 字段（`.volatile()`）。宿主 `settings` 服务（`dsh-settings`）
  会把带 volatile 字段的插件 Config 投影成设置表单，并把写入落到 **profile patch** 再走 Loader 热重载
  （`dsh-config-editor/lib/index.js:71-133`：`writeFileAtomic(patchPath)` + `reconcileProfilePatches(..., [entryId])`）——
  所以开关**天然 per-profile、不需要自建状态文件**；但**写入后不会改动运行中的会话**——它和文件内容一起
  按会话冻结（§3.6），新会话才生效。
- **缺失语义**：三个文件都不存在或读出来都是空 → `render()` 返回 `''` → 该 section 被 `renderPrompt` 丢弃
  （`lib/index.js:113-115`：`map(...).filter(t => t.length > 0).join('\n\n')`），瀑布也不删任何东西 ⇒ **原生 prompt**。
  **部分存在**（只有 `SOUL.md` 等）→ 用存在的那几个，不视为缺失。
- 不提供 `onMissing: 'error'`：装配路径上抛错会毁掉一次模型调用，收益为零。

### 3.5 读取、刷新、预算、插值

- **v1（采用）同步读 + 缓存**：键 `(mtimeMs, size)`，未命中才 `readFileSync`。文件是几十 KB 级。
- **UI 写入后立即失效缓存**（RPC 写完就 invalidate）；外部编辑器改动靠 mtime 感知。
  **读到新内容 ≠ 运行中的会话会变**：装配按会话冻结（§3.6），所以下一次装配读到新内容适用于
  **下一个会话**；README 要写清这条。
- **预算** `maxBytes`（默认 65536，`0` = 不限）：超限时整体截断到上限并在末尾追加一行可见 notice，
  同时 `logger.warn` 报出被截断的文件名。**不按文件丢弃**（`RULES.md` 往往是最后、也是最要紧的一份）。
- **插值** `interpolate`（默认 `false`）：文件里出现 `{{...}}` 默认按字面量保留；设为 `true` 时按上游
  严格插值语义（未注册变量会让装配抛错）——README 必须写清这条失败语义。
- **渲染**：按 `IDENTITY.md` → `SOUL.md` → `RULES.md` 顺序拼接非空正文，段间一个空行；
  **不加标题、不加 frontmatter**（"文件全文就是提示词"，与家族 `PromptFiles` 同口径）。

### 3.6 会话内冻结（KV 缓存）

**规则：一个会话用哪个身份，取决于这个会话开始时磁盘上是什么。会话进行中改文件 / 应用预设 / 动开关，
都不影响这个会话；下一个会话才读到新内容。**

为什么必须这样：

- 系统提示词在**每一次模型调用前**重新装配（`dsh-agent-loop` 的 `preStep()` →
  `systemPrompt.assemble(...)`，`packages/core/agent-loop/src/agent.ts:272`），每次装配都会调用我们
  section 的 text provider。若 provider 每次读盘，用户一改身份，**运行中的会话提示词就在读者眼皮底下换了人**；
- 同时请求前缀变了，供应商的 KV / 前缀缓存对那个会话作废。harness 对"提示词中途变化"本身有缓存友好的
  处理（能力允许的 series 上把新文本**追加在已缓存历史之后**、不重写前缀，见 `dsh-agent-loop` 的
  `SystemPromptProjection`，`src/runtime-context.ts`），但"提示词不该在一个会话里变"是产品判断：
  改身份的自然含义是"下一个会话"，不是"这条对话中途换人"。

实现（`src/session-freeze.ts` + `src/index.ts`）：

- text provider 取 `sessionKeyOf(context)`（= `context.agent.session` 对象：`dsh-agent` 的
  `assembleContextFor(agent)` 把 agent 同时放进 `agent` 与 `scope`），用 **`WeakMap` 按会话对象**
  冻结第一次读到的文本；键随会话对象被 GC 回收，长跑宿主不会攒垃圾；
- **开关也被冻结**：`sectionText(enabled)` 在开关关着时返回 `''`，那个 `''` 就是该会话保留的值；
  因此 waterfall 里"是否删掉原生身份段"的判定按**冻结后的文本**（`own.text.length > 0`），
  **不再看实时 `enabled`** —— 否则中途关开关会让原生身份回来，提示词照样变；
- 装配里没有 session 对象时（裸探针 / 单测 fixture）**不冻结**，按实时读取。

**兼容性**：text provider 形式（`text: (context) => string`）在**所有已声明的 dsh peer 行**上都存在，包括
下限 0.1.5-rc.2——核对了那一版自己的 `PromptSection` 声明（`text: string | ((context: AssembleContext) => string)`）
**与实现**（`dsh-system-prompt/lib/index.js:339`：`typeof section.text === "function" ? section.text(context) : section.text`），
以及它的 `dsh-agent/lib/index.js:258` `assembleContextFor(agent)` 同样返回 `{ agent, scope: agent }`。所以这一版
源码在各行都能编译、且冻结在各行都成立。（该文件 `interpolate` 字段在 0.1.5 缺席仍是既有的编译约束：注册参数
必须先放进变量。）

### 3.7 与 v1 的差异

| 维度 | v1 | v2 |
| --- | --- | --- |
| 取代方式 | `complete: true` | 瀑布具名删除 + 普通 section |
| 影响面 | 顶掉全部 20 个 section | 只删 2 个具名 section，其余逐字不变 |
| 子代理 | 一并被顶掉 | 默认完全不受影响 |
| 开关 | 无 | Config volatile 字段；与内容一起**按会话冻结**，新会话生效 |
| 文件位置 | 会话 cwd（工作区） | 数据根下按 profile 隔离 |
| 验收 | `sections.length === 1` | 具名清单 + 与关闭态**逐字 diff**（§9） |

## 4. 目录归属（需求 3 的取舍）

### 4.1 结论

**放数据根，不放 `~/.dsh/profiles/<name>`**：

```
<data home>/identity/
  profiles/<profile>/          # 生效身份（提示词唯一读取源）
    IDENTITY.md  SOUL.md  RULES.md
  presets/<preset>/            # 预设库（内置 3 个 + 用户新增/修改）
    IDENTITY.md  SOUL.md  RULES.md
```

`<data home>` 由家族 `resolveDataHome()` 解析（`$AVANTF_HOME` → 配置的 `dataHome` → `~/.avantf`，
见 `base/plugin-base/src/kit/family.ts:52-80`，实测默认 `~/.avantf`）。`<profile>` 取
**`ctx.profileContext.name`**（`dsh-app-boot/lib/types/profile-context.d.ts:15-31`：`name`/`dir`/`patchPath`/`home`，
"Present only in a profile launched by dsh"），缺失时回退到插件 Config 的 `profile`，再回退 `'default'`。

### 4.2 为什么不放 `~/.dsh/profiles/web`

1. **它不是我们的地盘。** `~/.dsh`（或 `$DSH_HOME`，见 `dsh-app-boot` 关于 `DSH_HOME` 的说明）是宿主的
   profile 目录，装的是 composition：`cordis.patch.yml`、`package.json`、lock。`dsh plugin add/remove`、
   `reconcileProfilePatches`、`sanitizeProfile` 都会读写它——用户内容放进去会跟宿主的重写搅在一起。
2. **拿不到、也不该硬编码。** 家族 API（`resolveDataHome`）只认数据根；profile 目录名要靠
   `profileContext`，路径还要考虑 `DSH_HOME` 重定位。硬编码 `~/.dsh` 等于把插件绑死在宿主的一个目录约定上。
3. **职责与所有权。** 身份/灵魂/规则是**用户自己的内容**——和 `memory/`、`knowledge/`、`configs/`、`prompts/`
   同类，该住数据根。备份、迁移、`AVANTF_HOME` 沙箱重定向才会把它们一起带走。
4. 你直觉里对的那一点我们**保留**了：目录名里的 `<profile>` 让"这套身份属于哪个 profile"一眼可见——
   只是它挂在数据根下，而不是宿主的 composition 目录里。

（命名统一为**单数 `identity/`**，与家族 `memory/`、`knowledge/` 一致；需求 3 里的 `identities/`
与需求 7 里的 `identity/` 不一致，取后者。）

## 5. 预设身份（需求 6/7/8）

### 5.1 语言模型（先定这条，布局跟着它走）

- **预设是多语言的**：每个预设**按语言一套三文件**。
- **生效身份不按语言分层**：`profiles/<name>/` 仍是**平坦的三个文件**——它是"用户自己的那段文本"，
  写哪种语言由用户决定，提示词只读它。语言只在**应用预设**这一刻起作用（+ UI 里选显示哪种语言）。
- **应用时的语言解析顺序**：
  1. 客户端此刻的语言（`ctx.locale` 的 snapshot `.active`，**含浏览器委派的结果**）——UI 触发的应用永远走这条；
  2. 无客户端时（脚本、无浏览器）：宿主的 `locale` 设置命名空间 `preference`
     （`dsh-client-locale/lib/index.js:5-15`：只有用户显式选过才写下来；`Config.preference` 是 volatile 字段）；
  3. 都没有 → `en`（`FALLBACK_LOCALE = 'en'`，`dsh-client-locale/lib/client.js:1135`）。
- **预设缺该语言 → 退回英文那一套**（需求 6 的原话）。`en` 也缺 → 该预设视为损坏：报错、跳过，
  **不静默复制一份空身份**。
- 应用成功后把 `activePreset` / `activeLocale` 记进插件 Config（volatile 字段，随 profile patch 持久化）。
  此后 dsh 语言变了、而身份仍来自**未被编辑过**的预设时，设置页提示"可用新语言重新应用"，
  **绝不静默改写用户内容**；`activePreset` 为空即"自定义"。

### 5.2 磁盘布局与内置资源

```
<data home>/identity/
  profiles/<profile>/{IDENTITY,SOUL,RULES}.md            # 生效身份（平坦，任意语言）
  presets/<preset>/<locale>/{IDENTITY,SOUL,RULES}.md     # 预设库（多语言）
  .provisioned                                           # 内置预设的释放标记（含包版本）
```

仓库里的内置资源（**至少 `zh` 与 `en`**；三个预设 × 2 语言 × 3 文件 = 18 份）：

```
identity/packages/plugin/assets/presets/coder/{zh,en}/{IDENTITY,SOUL,RULES}.md        # 程序员
identity/packages/plugin/assets/presets/assistant/{zh,en}/{IDENTITY,SOUL,RULES}.md    # 助理
identity/packages/plugin/assets/presets/analyst/{zh,en}/{IDENTITY,SOUL,RULES}.md      # 分析师
```

- 预设 id 用 kebab-case（`coder` / `assistant` / `analyst`），**id 即目录名**；显示名放客户端 i18n 字典
  （`settings.identity` 命名空间）按 id 查表，用户新增的预设回退显示 id。语言字符取自 dsh 已发布的语言
  （`dsh-client-locale/lib/index.js:11` `LOCALE_IDS = ['zh','en']`）；将来 dsh 加语言，预设要**补目录**，
  缺失时自动落到 `en`，不会坏。
- **构建期把 `assets/` 拷进 `lib/assets/`，运行期用 `new URL('./assets/presets/<id>/<locale>/…', import.meta.url)`
  定位**（先例：`mission/scripts/build.mjs:96-120` 的 `copyVendoredBootstrap()`、`mem/src/interface_gate.ts:83`
  的 `new URL(relative, import.meta.url)`）。**不要把资源留在包根**：`scripts/lib/pack-plugin.mjs:919-922`
  的通用断言要求 `files` 收 `lib` 或 `lib/...`，只有进了 `lib/` 才既随包、又能被 `import.meta.url` 定位。
- `files` 里显式列 `"lib/assets"`；`identity/scripts/pack-plugin.mjs` 的 `requiredEntries` 加
  `package/lib/assets/presets/<id>/<locale>/*.md`（照 `mem/scripts/pack-plugin.mjs:53-66`）。
- 家族先例说明：现有包随包发过 `.md` 的**只有 README**，内置提示词正文都是 TS 常量；我们这是第一个
  随包发 `.md` 资源的包，所以打包断言要自己加，别指望通用断言替你覆盖路径。

### 5.3 首次运行物化（**与语言无关**）

- 插件挂载时（`apply` 内、异步收进降级状态，**绝不留下未处理 rejection**）：把包内
  `assets/presets/<id>/` **整个语言目录树**复制到 `<data home>/identity/presets/<id>/`——物化不需要知道语言，
  语言只在应用时选。
- **只补缺失，永不覆盖**：目标文件已存在（哪怕只有 1 个字符）就不动它；用户删掉的预设**不重建**
  （删过就不再是"首次"）——用一次写入的 `<data home>/identity/.provisioned` 标记记录"内置预设已释放过"，
  此后只补**包内新增而磁盘上没有**的预设目录。
- 目录只读/权限失败 → 一条 WARN，插件照常挂载（家族口径：环境故障降级，不杀宿主）。

### 5.4 四个动作（UI 语义）

| 动作 | 行为 |
| --- | --- |
| 应用预设 | 按 §5.1 解析出语言 `L` → `presets/<id>/<L>/` 三个文件 → `profiles/<name>/`，**覆盖**（二次确认）；`<L>` 缺失则用 `en` |
| 编辑当前身份 | 直接写 `profiles/<name>/`（平坦三文件，不涉及语言目录） |
| 编辑预设 | 在 UI 选定的语言下写 `presets/<id>/<L>/`，**不影响当前生效身份**（UI 必须写明） |
| 存为新预设 | `profiles/<name>/` → `presets/<新 id>/<当前语言>/`；id 校验 `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`，同名拒绝；UI 提示"可再补其它语言版本" |

生效身份**只有一份来源**：`profiles/<name>/`。不做"预设被改动就自动同步生效身份"这种隐式联动。

## 6. UI（需求 4/5）

### 6.1 结论：注册一个**设置面板导航页** `settings.section`

设置页由宿主提供，插件按三条现成通道接入：

1. **页面本体 = `settings.section`（list / root）**。这是设置面板的**专属扩展点**：注册一条即得到
   "左侧导航一项 + 右侧内容一栏"——比塞进 Plugins 页的卡片更贴合"UI 放设置页"这条需求。
   该 slot 由 `dsh-client-ui-settings-general` 的 `SettingsRoot`（`sidebar.settings` 的占用者）
   声明（`dsh-client-ui-settings-general/lib/client.js:1112-1132` 声明、
   `:337` 渲染 `renderSlot('settings.section', { close }, { only: active })`），
   契约类型在 `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:11-125`
   （`owner: SettingsSectionOwnerProps { close: () => void }`）。现存占用者：
   `general`(0) / `models`(10) / `plugins`(15) / `agent-presets`(20) / `account`。

   ```ts
   // src/client/index.ts（要点）
   export const inject = ['slots', 'remote', 'locale']

   ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'identity: dictionaries')
   ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
     name: 'settings.section',
     id: 'identity',            // 必须是新 id：复用已占用的 id 会进别人的格子/替换它
     order: 25,                 // 落在 account 之后
     locale: NS,                // 'settings.identity'
     label: () => t('nav'),     // label thunk 每次投影重读，切语言不需重注册
     inject: () => ({ hooks: { identity: store } }),
   }, IdentitySection)), 'ui-identity:section')
   ```

   参考实现：`dsh-client-ui-settings-plugins/lib/client.js:201-215`（id `plugins`, order 15）、
   `dsh-client-ui-settings-models/lib/client.js:4059-4074`、`dsh-client-ui-settings-general/lib/client.js:1171-1179`。
   **本仓有先例**：`@avantf/dsh-mem` 曾经就注册进 `settings.section`（id `memory`/`knowledge`，order 25/26），
   后按产品决定撤掉（`mem/CHANGELOG.md:919-927`）——这条路走通过，撤回时还顺带摘掉了
   `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-ui-settings`。
   组件只会收到 `{ close }`，其余数据自己经 Remote 取。

2. **开关与少量配置 = 插件 Config 的 `.volatile()` 字段**。`settings` 服务会把该插件行的
   Config 投影成表单、把写入落到 profile patch 并热重载（证据见 §3.4）。字段：
   `enabled`（开关）、`interpolate`、`replaceScope`、`drop`、`maxBytes`、`profile`。
   我们的插件**关掉自动表单**（`settings.configure({ auto: false })`，
   `dsh-client-ui-settings-general/lib/index.js:6-12` 就是这种用法），因为整页由我们自己的浏览器半边渲染，
   避免同一份配置出现两处；volatile 字段仍可经客户端 `ctx.configForms.get('<行 id>')` 读出与写回
   （`SettingsFormModel` + `settings*Field`，来自 `@deepseek-ai/dsh-client-ui-primitives`）。
   字段含 `activePreset` / `activeLocale`（应用预设时写入，用于"语言变了要不要重新应用"的提示）。
   若只想做"一个开关、不写自定义页"，退路是 `settings.general.item`（一行偏好，`{id, order}`）。

3. **文件/预设的读写走自建 Remote**（typert），与 mem/mission 同一条路：
   宿主半边 `class IdentityGateway extends TypertRemoteService { constructor(ctx){ super(ctx, 'avantfIdentity') } }`
   + `@Remote('…')` 方法与手写描述符（照 `mission/packages/plugin/src/wire.ts:8-55` 的 `strict`/`direct`），
   `ctx.typert.register(hostContribution)`；浏览器半边 `await ctx.remote.$mount(clientContribution)`，
   再用 `ctx.get('remote.avantfIdentity')` 取代理。
   方法面（最小集）：`status()`、`listPresets()`、`readProfile()`、`writeProfileFile(name, text)`、
   `applyPreset(id)`、`saveAsPreset(id)`、`readPreset(id)`、`writePresetFile(id, name, text)`、`deletePreset(id)`。

   **三个必须避开的坑（都有血案）**：
   - **Remote 的返回值是信封 `{ ok, value }`，必须剥一层**。实测（2026-10-10，真机）：页面收到的字段
     就是 `ok, value`，于是 `status.drop` 为 `undefined`、渲染在 `status.drop.join` 上抛错、整页空白；
     宿主侧探针证明宿主返回是完整的，丢在 host→page 之间。**只能剥一层**——本插件自己的 `WriteResult`
     自带 `ok`，照抄 mem 的两层解包会把 `{ok:false,error}` 当成应用信封吃掉、丢掉 `error`/`files`。
     剥皮收在 `src/client/api.ts` 的 `unwrapRemote` / `wrapRemote` 一处，页面各调用点只看到 payload。
   - **绝不把 `remote.avantfIdentity` 写进 cordis `inject`**：仓外包的 namespace 只在自己 `$mount()` 之后
     才存在，写进 inject 会让该 client entry 永远 pending，启动审计直接抛错、整棵 web 树挂掉
     （`mem/packages/plugin/src/client/index.ts:8-13`、`mem/docs/DSH_INTEGRATION.md:167-173`）。
   - **出参必须全部在 wire schema 里声明**：严格 codec 会剥掉未声明字段（漏声明 = 静默空请求，
     `mem/packages/plugin/src/remote.ts:150-158` 记的正是这个事故）。
   - **渲染里不许对 wire 字段直接 `.join(...)` / `.find(...)`**：少一个字段就让 React 拆掉整棵子树、
     页面全白（同一次事故）。列表字段一律走兜底，并在缺字段时把"实收字段"渲染出来当现场证据。
   - **读客户端服务前先核对成员名**（这一条是同一个坑踩了三次的总结）：`configForms` 是**服务**
     （表单在 `get(rowId)` 上）、locale 面是 `bind` + **`getSnapshot`**/`subscribe`（**没有** `snapshot()`）。
     成员名猜错大多**不报错**，只是静默走 fallback——第一次让开关永远"未就绪"，第二次让 `applyPreset`
     永远按 `en` 解析。抄 `packages/client/**`（本机 checkout `/home/qunqi/opensource/harness/deepseek-harness`）
     的原生用法，或至少让 fallback 在日志里说话。

### 6.2 页面内容与实现约束

- 顶部：**只有标题**（刷新 / 关闭按钮已去掉：每次动作都会刷新自己改过的东西，退出由设置壳自己的关闭控件负责）。
  界面文案一律说**身份**（标题、开关标签、覆盖确认都一样），不再出现"身份文件"。
- **开关卡**：只有一个复选框（绑定 `configForms` 的 `enabled`，实时生效）。**不写任何解释文案**（回退提示也已去掉）。
  **开关未开启时，下面两张卡完全不渲染**——页面只剩标题 + 开关；开关一开才出现身份选择与三个编辑器。
- **身份卡（在文件卡之前，卡内没有标题文字）**：**一个下拉列表，选项只有预设 id**（不缀语言列表）；当前生效的预设
  就是选中项。**没有"自定义"占位项**——身份是手写的时候下拉就是空的；预设被删光时下拉自然也没有选项。
  `删除` 作用于选中的那一个，靠卡片右内边距对齐（与左侧下拉距边框的距离一致）。**没有独立的"编辑"按钮**——见下面的语义说明。
- **文件卡（无标题）**：三个文件的 `textarea`（只有文件名标题，**不再显示每份的字节数**）+ `保存` + `存为新预设`。
- **数据流语义（别读错）**：三个编辑器 + `保存` 写的是**当前生效身份**（`profiles/<name>/`），**不是**下拉里选中的
  那个预设；下拉只负责"选用 / 删除"；`存为新预设` 把当前生效身份复制成预设库里的新条目。因此**改已有预设的内容
  只能直接改磁盘**（`presets/<id>/<locale>/*.md`）。若要让"保存 = 改选中的预设"，那是另一条数据流，需要显式改。
- **两个弹窗都是页面内的**（固定遮罩 + 卡片，`z-index: 1100`——设置面板自己是 1000），**不用
  `window.confirm` / `window.prompt`**；外观直接镜像宿主 `ui-primitives/Modal.module.css`：遮罩
  `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`，卡片 `--dsw-alias-bg-layer-2` + `--dsw-elevation-prominent` +
  `--dsw-radius-panel`（设置面板本身用的也是这两个 token，所以两者同料）；输入框 / 按钮用
  `Input.module.css` / `Button.module.css` 的 token（`--dsw-alias-button-primary-fill` +
  `--dsw-alias-label-primary-foreground`——早先手写的 `brand-primary` + `#fff` 在暗色主题下是白底白字）：
  - 选中预设 / 删除预设 → 确认弹窗；确认后才动 `profiles/<name>/`（保护用户手写内容）；
  - `存为新预设` → 弹窗输入名字，确定才写入。
  为什么不用宿主现成的 `Modal` / `RiskConfirmation`（`@deepseek-ai/dsh-client-ui-primitives`）：它是
  **客户端包**，而本插件没有链它——要用就得进 `link-dsh` 的 LINKS + `versions.ts` 的 bake 名单 + 声明一个
  dsh 侧 peer，为一个弹窗不值当（家族两个插件都刻意不 import 宿主客户端包）。将来想换回原生组件，是一处
  受控改动。
- **不显示状态栏**（profile / 数据目录 / `drop` / 文件数等一律不展示）。只在 wire 字段缺失时渲染**一行红字诊断**
  （缺了哪些字段 + 实收字段），正常时不存在——这行是这次三个线上事故唯一能定位的现场证据。
- **语言**：`applyPreset` / `readPreset` / `saveAsPreset` 一律带 **`ctx.locale.getSnapshot().active`**
  （dsh 当前显示的语言）；预设缺该语言时由宿主回退 `en`。
- **样式**：只用设计 token，且每个都写硬编码 fallback（`var(--dsw-alias-state-error-primary, #d9534f)`）——
  token 缺失时退化为继承色而不是错色。常用：`--dsw-alias-bg-base` / `-bg-layer-1` / `-bg-layer-2` /
  `-bg-overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-label-primary/secondary`、
  `--dsw-alias-brand-primary`、`--dsw-alias-state-{error,warn,success,idle}-primary`、
  `--dsw-specific-sidebar-fill`；暗色由 `body[data-ds-dark-theme]` 切换。
- **i18n**：`ctx.locale.register(NS, { zh, en })`（typed 形式要求把**已发布的每种语言都补齐**，
  mission 就是这么做的：`mission/packages/plugin/src/client/index.ts:44-45,283,313`；mem 是刻意全中文，不跟）。
- **客户端构建管线跟随 `mission`**：`tsc` 出类型 → `esbuild --bundle --format=cjs --minify` →
  手写 `window.__ModuleLoader__.load` 外壳 → `lib/client.js`；`EXTERNAL` 列表必须与 shell 的模块表逐一对应
  （`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`；
  见 `mission/scripts/build-client.mjs:27-37`），并保留它的两条 metafile 断言（shell 包不得被 inline、
  zod 只允许 `en` locale）。管线选择本身见 §11 第 6 条。
- **生效方式**：client 半边由 `client-hmr` 以 500ms stat-poll **热重载**（改完重建即可见）；
  host 半边要重启 `dsh web`。

## 7. 插件形态（包、树、构建、发布面）

### 7.1 命名与目录（与 mem/mission 一致）

| 项 | 值 |
| --- | --- |
| 包名 | `@avantf/dsh-identity` |
| 插件 `name` | `avantf-identity`（同 `avantf-mem` / `avantf-mission` 的格式） |
| 行 id / settings 命名空间 | `avantf-identity` |
| 树 | `identity/packages/plugin`（与 `mem/packages/plugin`、`mission/packages/plugin` 同形） |
| 浏览器半边 | 同包 `src/client/`，manifest 里 `exports['./client']` + `dsh.client`（下面这段） |

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-ui-settings-general",  // 声明 settings.section 的那个 entry
      "@deepseek-ai/dsh-client-ui-settings",          // slot 契约与 configForms 所在包
      "@deepseek-ai/dsh-api-remotes"                  // ctx.remote.$mount 的桥
    ]
  }
}
```

`dsh.client.inject` 只决定**模块图装载顺序**；真正让设置页出现的是运行时
`ctx.slots.inject('settings.section', …)`（§6.1）。

### 7.2 需要动的文件（新增树）

**守卫是发现式的、发布面是审查式的**：`scripts/lib/plugins.mjs:54-70` 的 `discoverPlugins()` 扫"顶层目录 +
根 `package.json` 有非空 `build:dsh`"，并期望 `<tree>/packages/plugin/package.json` 存在。所以：

1. **`identity/package.json` 必须带 `build:dsh`**（否则整棵树对 `pnpm build:dsh identity`、`guard`、
   `prove-base-swap` 都不可见）；
2. 根 `pnpm-workspace.yaml` 的 `packages:` 加 `- "identity/packages/*"`；
3. `scripts/boundary-guard.mjs` **一个字不用改**（`:53` 从 `discoverGuardTrees()` 取树）。

**发布面已定**：它是插件族的第 4 个可发布包，`build` / `pack` / 门禁 / 发布顺序**与 mem、mission 同一套形态**
（同 `build:dsh` 发现式入口、同 `prepublishOnly` → `prepublish-assert.mjs` → `pack-plugin.mjs`、同 peer 链规则、
同 `publishConfig.access: public`）。因此下面这些**硬编码的等值断言**必须逐处同步（否则 `release:check` 直接红）：

| 文件 | 位置 | 改什么 |
| --- | --- | --- |
| `scripts/release-check.mjs` | `:94-99` `PUBLISHABLE`、`:100` `WORKSPACE_PATTERNS`、`:104-107` `PLUGINS` | 加 `identity` |
| `scripts/prepublish-assert.mjs` | `:46-52` `PUBLISHABLE`、`:60` `WORKSPACE_PATTERNS` | 与 release-check **刻意各一份**，两边都要改 |
| `scripts/lib/versions.mjs` | `:29` `VERSION_GROUPS` | 加 `identity` 组 |
| `scripts/check-tier.mjs` | `:89-115` `FAST`、`:125-127` `RELEASE`、`:139` USAGE、`:233` 段名白名单、`:257` 文案 | 快档/发版档都要加 |
| `scripts/check-dsh-lines.mjs` | `:42` `MANIFESTS` | 本插件声明 dsh peer，必须加，否则它的行漏检 |
| `scripts/check-old-dsh.mjs` | `:71-91` 步骤表、`:223` | 要跑 dsh 下限门时 |
| `scripts/clean.mjs` | `:32-33` | 加组 |
| 根 `package.json` | `:16-19`、`:22-23` | `release:check:identity`（+ 可选 `pack:plugin:identity`） |
| `AGENTS.md` | `:7-9` 表、`:20` "恰好三个包"、`:93-95` "要动四处"、`:134-136` 版本表 | 表格与数字 |
| `docs/RELEASING.md` | `:5-10`、`:80-82` | 发布顺序表与 publish 命令 |
| `.github/workflows/ci.yml` | `:93`、`:136-145` | 决定 proof / mount smoke 覆盖 |

### 7.3 base 依赖、门禁会怎么拦你、与降级

- 插件需要 `resolveDataHome`（家族约定，属 base 的共享知识），因此**按家族规矩用 base**：
  唯一静态引用是 vendor 并**内联**进产物的零依赖 bootstrap（`@avantf/dsh-plugin-base/bootstrap` 的
  `loadFramework()`），运行期动态 `import()` 加载到的模块，取成员而不复制。
- **这不是可选项，而是门禁的硬要求**：`scripts/lib/gates.mjs:54-68` 的 `baseDependencyProblems()` 对
  `release-check` 的 `PLUGINS` 里每个包断言"`dependencies` 里必须有 base（且区间可发布、与另一棵树逐字相同）"；
  想进发布面又只在 peer 里写它，会被直接判 FAIL。
- **每个被发现到的树都必须自带 bootstrap 与接口烘焙**：`scripts/prove-base-swap.mjs:135-139` 要求
  `<tree>/packages/plugin/lib/index.js` 存在，`:219-235` 要求内联 bootstrap，`:344-347` 要求
  `lib/interface-version.json` 能被 `readInterfaceRequirement` 读到，`:432-437` 还要 mount smoke。
  所以本插件即使**没有需要 provision 的资源**（无外部二进制、无模型、无 npm 包），也仍然要：
  vendor bootstrap + `checkInterface` / `readInterfaceRequirement` 接口门禁 + `lib/interface-version.json`
  + `scripts/mount-smoke.mjs`；只是**不需要** provisioner 与 envinit item 清单。
- **base 缺席**时降级：数据根回退 `$AVANTF_HOME` → `~/.avantf`（家族规则的最后两层），其余功能照常；
  这条兜底是**刻意的镜像**，必须像 mission 的 `prompt.ts:116-128` 那样用一条跨树测试对 linked base 钉住，
  并在 `AGENTS.md` 的镜像清单里登记（否则第四次修改会被漏掉）。
- **`profileContext` 的类型不要靠新增 peer**：`@deepseek-ai/dsh-app-boot` 不在 mem/mission 的
  `link-dsh.mjs` 链接表里，为拿一个类型把它加进来会牵动 manifest 与发布门禁。运行时用
  `ctx.get('profileContext')` 不需要 import 任何包，类型上照家族对 typert 符号的做法在本地声明一个
  最小镜像 `interface { name: string; dir: string; patchPath: string; home: string }` 即可，并容错它为 `undefined`
  （非 profile 启动时不存在）。
- `peerDependencies` 按家族规则声明 dsh 侧 peer 链（现状 `^0.1.5-rc.2 || ^0.1.7-rc.2 || ^0.2.0-rc.2`，
  以 `pnpm check:dsh-lines` 为准）；`Config` schema 用宿主的 `@deepseek-ai/schemastery`；
  **不新增运行期依赖**（`node:fs` 足够）。
- 版本：发布面已定，所以**版本只记在 `identity/packages/plugin/package.json`**（`scripts/lib/versions.mjs:29`
  的 `VERSION_GROUPS` 加一个 `identity` 组），用 `pnpm version:set identity x.y.z` / `pnpm version:check`
  管；组内其它 manifest（若将来有）与私有包**一律不许带 `version`**（`versions.mjs:100-108` 断言）。

### 7.4 随包内容

```
package.json  cordis.patch.yml  README.md（首行 `# @avantf/dsh-identity`）  LICENSE
lib/index.js  lib/client.js  lib/types/**
lib/envinit-bootstrap.js          # vendor 并内联的零依赖 bootstrap
lib/interface-version.json        # 构建期烘焙的接口世代（prove-base-swap 要读）
lib/dsh-build.json
lib/assets/presets/{coder,assistant,analyst}/{zh,en}/{IDENTITY,SOUL,RULES}.md
```

`cordis.patch.yml` 形如：`- insert: [{ id: avantf-identity, name: '@avantf/dsh-identity' }]`
（组合包与手写行**二选一**，与 mission 的 `cordis.patch.yml` 同规矩）。
包内还需要（不随包）：`scripts/build.mjs`（含 `copyVendoredBootstrap()` 与 `copyAssets()`）、
`scripts/pack-plugin.mjs`、`scripts/mount-smoke.mjs`、`tsconfig.json`、`tsconfig.test.json`、`vitest.config.ts`。

## 8. 挂载

- **自己用（先走这条）**：`~/.dsh/profiles/web/cordis.patch.yml` 加一行，或在 profile 的
  `package.json` 的 `dependencies` 写 `"@avantf/dsh-identity": "link:/…/dsh-plugins/identity/packages/plugin"`。
- 行里的 `config` 只写需要覆盖的字段（`enabled` 等由设置页写回同一个行）。
- 与 `AGENTS.md` 的分工不变：**不要把三个文件名加进 `agent-instructions` 候选**，`AGENTS.md` 继续走
  原有的 user 角色通道（嵌套发现、预算裁剪、改动可见性都不回归）。
- 与 `dsh-persona` 的 `complete: true` **不再冲突**（我们不用 complete），但两者同时开启时仍是
  persona 的 complete 赢——README 里点一句即可，不必做互斥自检（v1 的那条自检需求作废）。

## 9. 验收

### 9.1 第一步：离线 spike —— **已执行，18/18 通过**（2026-10-10）

脚本：`/tmp/dsh-identity-spike/spike.mjs`（隔离环境：`node_modules/@deepseek-ai` 软链到已装 dsh 的
`.../@deepseek-ai/dsh/node_modules/@deepseek-ai`；只挂 `dsh-system-prompt` 服务 + 12 个扮演"其它包的
section"的替身 section + 一个 tools provider + 一个 context，**不调模型、不起宿主、不碰真实 profile**）。
运行：`cd /tmp/dsh-identity-spike && node spike.mjs`。

实测结果（全部 `ok`）：

| 断言 | 结果 |
| --- | --- |
| `getSectionOrder('HARNESS_IDENTITY') === -1000` | ✓ |
| 原生装配以 `harness:identity` 开头，`deployment:persona-prefix` 就是部署那句 | ✓ |
| **在根作用域重复注册 `harness:identity` 会抛** | ✓ `prompt section "harness:identity" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)` |
| 挂载但关闭 → 装配与原生**逐字相同** | ✓ |
| 打开 → `harness:identity` 与 `deployment:persona-prefix` 消失 | ✓ |
| 打开 → 我们的 section 排在第 0 位、文本就是文件内容 | ✓ |
| 打开 → **其余 13 个 section 的名字与文本逐字相同** | ✓ |
| 打开 → 段数 = 原生 − 2 + 1 | ✓ |
| 打开 → `tools` 与 `contexts` 逐字相同 | ✓ |
| 子代理（`origin:'subagent'`、`delegationDepth:1`）→ 与原生逐字相同，保留 `harness:identity`，看不到我们的 section | ✓ |
| 带**真实子作用域**且子作用域自带 persona → 子代理保留自己的 `deployment:persona-prefix`，装配与原生逐字相同 | ✓ |
| 全局瀑布监听器**在 scoped 装配里也被调用** | ✓ |

主会话的实际迁移：

```
native : harness:identity → deployment:persona-prefix → plan:policy → team:policy → tool:bash → … → app:web-surface → deployment:persona-suffix
with   : avantf:identity  →                           plan:policy → team:policy → tool:bash → … → app:web-surface → deployment:persona-suffix
child  : （与 native 逐字相同）
```

两个顺带确认的事实：装配后的 section 形状只有 `{ name, text }`（**没有 `order`**，所以字节比对是
名字+文本）；重复注册的报错本身就把"per-agent override 走 `agent.ctx`"指了出来——那是"按 agent 覆盖身份"
的官方路线，我们在 `replaceScope: 'session'` 里没有用它，但记在这里备查。

**建树后**把这 12 条断言原样搬成 `identity/packages/plugin/test/mechanism.spec.ts`（同一条路径、同一批
替身 section），它就变成回归测试，而不是一次性脚本。

**v1 的 `sections.length === 1` 断言作废**（那是 complete 的验收，不是我们的）。

### 9.2 单测（离线，不依赖 dsh 宿主）

- 渲染：三文件按序拼接；部分缺失；全空 → `''`；`maxBytes` 截断 + notice；`{{unknown}}` 在
  `interpolate: false` 下原样保留、在 `true` 下落回上游语义。
- 瀑布：`enabled=false` → 一处都不删；`enabled=true` → 只删 `drop` 名单；名字不在装配结果里 → 不炸。
- 作用域：`origin:'subagent'` / `delegationDepth>0` → 只隐藏自己、不删别人。
- 预设：首次物化只补缺失、不覆盖已有文件；id 校验；应用/另存为的目录语义；只读目录 → WARN 不抛。
- 路径：对 linked base 的 `resolveDataHome` 跨树钉住（base 缺席兜底那条镜像）。
- 契约镜像：`Config` 的 volatile 字段形状用 `def.shape` / `z.toJSONSchema(..., {io:'input'})` 断言，不读私有实现。

### 9.3 实机（web profile，需 key 由用户提供）

1. 设置面板出现**身份页**（`settings.section`, id `identity`）；开关关闭时提示词与未安装插件时一致；
2. 打开开关并填入三份中文文件：会话第一轮的系统提示词**以身份文件开头**，且
   `harness:identity` / `You are a coding agent powered by …` **都不再出现**；
3. 同一轮里工具 schema 仍在，工具指引、Agent Teams、plan mode 的 section **一条不少**；
4. 点一次 Agent Teams：**成员子会话的提示词与未开启本插件时逐字一致**；
5. 在 UI 改一个字保存 → **该会话的提示词不动**（会话内冻结）；开一个新会话才看到新内容；文件删空同样只对新会话生效；
6. `AGENTS.md` 的基线注入与嵌套增量注入行为不变（需求回归项）。

## 10. 风险与降级

| 风险 | 处置 |
| --- | --- |
| `'harness:identity'` 是字面量，上游可能改名 | 断言 + spike 钉住；改名时测试先红，且有"名字不存在就什么都不删"的兜底（不会误删别的 section） |
| 用户 `drop` 里写进能力指引的名字 | `drop` 只接受字符串数组；README 写明默认值语义；不为它做白名单（用户显式要求时才生效） |
| profile patch 被设置页改写 | 这是宿主既有机制（其它插件同样如此）；`configEditor` 有 revision 冲突检测 |
| 目录只读 / 预设物化失败 | 全程 WARN + 降级，绝不抛（`apply` 内异步必须 await 或收进降级状态，**不用 `void promise`**） |
| KV cache | **会话内冻结**（§3.6）：运行中的会话提示词不变，前缀缓存不动；改动在**新会话**生效，那时才重建一次前缀 |
| 上游 API 漂移 | 按 0.2.0-rc.2 API 面写；peer 链 + `pnpm check:dsh-lines` 管兼容 |

## 11. 已拍板（2026-10-10）

1. **发布面 = 第 4 个可发布包**：与 mem、mission **同一套编译 / 打包 / 发布形态**（§7）。
   不做 `private` 过渡：它要给人装，`release-check` / `prepublish-assert` / `AGENTS.md` 表格 /
   版本组 / `check-tier` 树名一次改齐（§7.2 的清单）。
2. **`replaceScope` 默认 `'session'`**：子代理与 Agent Teams 成员零影响；`'all'` 只在用户显式要求时用。
3. **默认 `drop = ['harness:identity', 'deployment:persona-prefix']`**：`persona-suffix`（工作目录）保留。
4. **默认预设 = `assistant`（助理）**：开启开关、身份文件为空时，用当前语言的那一套填充
   （缺则 `en`）。
5. **接受"改预设不影响生效身份"**：只有"应用预设"会写 `profiles/<name>/`（§5.4）。
6. **客户端打包管线跟随 mission 的 esbuild + CSS-in-TS**：本方案不改 mem 的管线；
   "第三块面板"那条工作区级裁决不因此重开。
7. **预设多语言**：语言跟随 dsh 设置，缺该语言退回英文（§5.1）。
8. **会话内冻结（2026-10-10 追加）**：身份文本与开关**按会话冻结**——一个会话用它开始时磁盘上的身份，
   中途改文件 / 应用预设 / 动开关都不影响它；新会话读新内容。理由：提示词不该在读者眼皮底下换人，
   且中途变化会作废该会话的 KV / 前缀缓存（§3.6）。UI 文案随之从下一轮生效改为新会话生效。

剩余待确认的只有一个**实现细节**，不影响开工：`settings.section` 页在导航里的 `order`
（暂定 25，落在 `account` 之后）与页标题文案。

## 12. 本次核验坐标（0.2.0-rc.2 实机）

- `dsh-system-prompt/lib/index.js:97-99`（排序：order 后按名字）、`:113-115`（空 section 丢弃 + 空行连接）、
  `:204-222`（Config 的 `includeHarnessIdentity` 与 `harness:identity`）、`:228-236`（section 注册/遮蔽文档）、
  `:323-336`（complete 唯一性检查）、`:355-362`（瀑布在 complete 恢复**之前**）
- `dsh-system-prompt/lib/types/index.d.ts:16-27`（`system-prompt/assemble` 瀑布契约）、`:38-42`
  （`AssembleContext.scope`）、`:47-70`（`PromptSection`）、`:114`（`HARNESS_IDENTITY: -1000`）、
  `:226-294`（`SystemPrompt` 服务面）
- `dsh-scope/lib/index.js:27-38`（同名重复即抛）、`:132-200`（`ScopedLayers.merge`：作用域链按名字遮蔽）、
  `:327-340`（`scopeTarget`：无作用域监听器一律放行）
- `dsh-agent/lib/types/runtime-types.d.ts:15-18`（`AssembleContext.agent`）
- `dsh-session/lib/types/types.d.ts:58-94`（`SessionHeader.origin/parentSession/delegationDepth`）
- `dsh-subagent/lib/index.js:401,478-479,517-520`（子会话标记 + 子代理 persona）
- `dsh-settings/lib/index.js`（`SettingsForms`：`describe/update/replace/mutate`、`configure({auto})`、
  `volatileForm`、`applies:'live'`）
- `dsh-config-editor/lib/index.js:18,71-133`（写 profile patch + `reconcileProfilePatches` 热重载）
- `dsh-app-boot/lib/types/profile-context.d.ts:15-31`（`profileContext.name/dir/patchPath/home`）
- `dsh-client-ui-settings-general/lib/index.js:6-12`（`settings.configure({auto:false})` 用法）、
  `lib/client.js:1112-1132`（注册 `sidebar.settings` 并**声明 `settings.section`**）、`:337`（渲染它）、
  `:1171-1179`（`general` 页注册样例）
- `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:11-125,154-157`（`settings.section` 契约与 owner props）
- `dsh-client-ui-settings-plugins/lib/client.js:201-215`、`-models/lib/client.js:4059-4074`
  （`settings.section` 注册样例；`id`/`order`/`label`/`locale`/`children`）
- `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:73-152`（Plugins 页的 slot 契约，退路用）
- `dsh-typert-protocol/lib/types/types.d.ts:66,344-349,357`（`TypertRemoteService` / contribution / `$mount`）
- `dsh-client-locale/lib/index.js:5-15`（`locale` 设置命名空间 + volatile `preference`，只有显式选择才落盘）、
  `:11`（`LOCALE_IDS = ['zh','en']`）、`lib/client.js:1135`（`FALLBACK_LOCALE = 'en'`）、
  `lib/types/client/index.d.ts:49-57,120-121`（`LocaleSnapshot.active` / `snapshot()`）、
  宿主半边导出的 `LOCALE_SETTINGS_NAMESPACE` / `LOCALE_PREFERENCE_FIELD`
- `dsh-web-app/cordis.patch.yml:16-20`（web 的 persona 文案）、`:42-43,289-295`（browser roster 装载 `ui-*` 行）、
  `~/.dsh/profiles/web/package.json`（本 profile 的 bundles：base / web-app / 三个 experimental / mem / mission）
- 本仓：`base/plugin-base/src/kit/family.ts:32-80`（两个根与 `resolveDataHome`）、
  `base/plugin-base/src/kit/prompt_files.ts`（"文件即正文 / 永不覆盖 / 原子写 / 只补缺失"的既有纪律）、
  `mem/packages/plugin/src/remote.ts:39-109,150-158`（手写 typert descriptor 范式 + 严格 codec 剥键事故）、
  `mission/packages/plugin/src/wire.ts:8-55`（更短的等价版）、
  `mem/packages/plugin/src/client/index.ts:8-13,1755-1760`（**不许 inject 点号 remote key** + `$mount` 取用）、
  `mission/scripts/build-client.mjs:27-37,94-146`（esbuild 管线与两条 metafile 断言）、
  `mem/CHANGELOG.md:919-927`（mem 撤掉自己 `settings.section` 注册的记录）、
  `mission/packages/plugin/cordis.patch.yml`（bundle 行样例）
