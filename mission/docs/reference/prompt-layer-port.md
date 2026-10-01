# 四层 Prompt 移植到 DSH：设计文档

> 2026-09-15 · 状态：待实施
> 源：`src/avantf/base/prompt/`（AvantF 自有引擎）
> 目标：DeepSeek Harness（DSH，本机 `@deepseek-ai/dsh@0.1.5-rc.1`，profile `web`）

## 背景与问题

AvantF 的 prompt 侧是「四层架构」（`CLAUDE.md` 的 `build_prompt()` 4 段结构）：

| 段 | 实现 | 内容 |
|---|---|---|
| 1 固定身份层 | `StableLayer` + `IStableExtPrompt` 扩展 | 身份 prompt、项目约束（`ProjectPrompt`）、工具规则（`ToolRegistry`） |
| 2 对话历史 | `MessageRouter` → `MessageLayer` | `_api_formats`（LLM 上下文）+ `_messages`（写缓冲）+ 落盘 + 压缩 |
| 3 动态层 | `DynamicLayer` + `IDynamicExtPrompt` | 每次调用重建，priority 回退链（第一个非空者胜出），如 `TodoistManager` |
| 4 临时层 | `TempLayer` | 单次消费的 system 提示：验证提示、loop guard 警告、工具异常 |

问题：这套机制是**在自家 imperative Python 循环里**手写出来的。DSH 是 Cordis 插件体系，
prompt 组装、会话历史、压缩、恢复全部由框架持有。所以「能否移植」的真实问题不是
「代码能不能翻成 TypeScript」，而是：

> 四层模型里，哪几层该交给 DSH、哪几层才是 AvantF 真正需要保留的资产？

## 目标

- 给出四层到 DSH 的**逐层判定**：直接映射 / 需适配 / 无等价。
- 让 AvantF 的 prompt **内容**（身份、项目约束、工具规则、动态进度、临时提示）能进入 DSH。
- 让 `IStableExtPrompt` / `IDynamicExtPrompt` 这套**扩展契约**在 DSH 上有对应写法，
  扩展作者的心智模型不用换。
- 明确划出**不搬**的部分，避免重复实现框架已有能力。

## 非目标

- 不把 AvantF 的引擎（`Session` / `AgentEngine` / `TurnRunner` / TUI）搬进 DSH。
- 不用 AvantF 的 Python 运行时去驱动 DSH 的模型请求（那是另一条"外挂后端"路线，本设计不涉及）。
- 不实现"不落盘、单步可见"的注入通道 —— 见 §4.4，DSH 架构不变量排除了它。

## 关键结论（先读这段）

1. **段 1（StableLayer）与段 2（历史）在 DSH 是一等公民，直接映射。**
   段 2 尤其不该移植：DSH 的会话日志 + `deriveMessages()` 已经是 append-only 模型，
   且自带 fork / resume / replay / 压缩，`MessageLayer` 的双轨 + 手写落盘是重复实现。
2. **段 3（DynamicLayer）可移植，但语义必须改写**：DSH 的 `context()` 会物化成
   **持久 user 角色快照**，不是"每次调用重建的瞬时消息"。
   正确做法是让 provider **只在底层事实真正变化时返回不同文本**（框架对相同文本去重）。
3. **段 4（TempLayer）在 DSH 没有等价机制**，必须重新设计成
   「按状态出现、变化时才写的动态段」。这不是妥协：它是 DSH 事件溯源不变量的直接后果，
   而改写后的形态在 KV cache 上反而比"每步都注入"更好。
4. **扩展契约（`priority` 排序 + 非空回退链）能原样保留**，只是注册方式从
   命令式 `register(ext)` 变成声明式 `section({name, order, text})`。

## 现状

### AvantF 侧的实现要点（源证件）

`src/avantf/base/prompt/prompt.py:25-32` — 四层线性拼接：

```python
def build_prompt(self) -> list[dict]:
    messages = []
    messages.extend(self.stable.build())
    messages.extend(self.history.build())
    messages.extend(self.dynamic.build())
    messages.extend(self.temp.build())
    return messages
```

`src/avantf/base/prompt/layers.py` — `priority` 降序插入（`bisect`），稳定层带缓存
（`_cache` / `_token_cache` + `invalidate()`），动态层是回退链（`DynamicLayer.build()`：
第一个返回非空者胜出），临时层 turn 结束 `consume()` 清空。

`src/avantf/base/prompt/interface.py` — 三个契约：`IStableExtPrompt`
（`priority` / `stable_prompt(designate)` / `tokens(designate)`）、
`IDynamicExtPrompt`（`priority` / `build_prompt()`）、`IMessageLayer`。

已有扩展实例：`base/prompt/project.py`（`ProjectPrompt`，priority 90，加载 `PROJECTS.md`）、
`base/tools/registry.py`（`ToolRegistry`，priority 30，工具 `usage_guide`）、
`base/harness/todoist/manager.py`（`TodoistManager`，priority 80，动态进度）。

### DSH 侧的能力（按本机已安装包的类型契约与 README 核对）

`@deepseek-ai/dsh-system-prompt` 提供 `ctx.systemPrompt`：

| API | 语义 | 对应 AvantF 的 |
|---|---|---|
| `section({name, order, text, complete?})` | 有序段，order 升序（同 order 按名字 code-unit 序） | `IStableExtPrompt` |
| `context({name, order, text})` | 动态 runtime context，物化为**持久 user 角色快照** | `IDynamicExtPrompt` |
| `variable(name, provider)` | `{{name}}` 严格插值，未注册/求值 undefined 都抛错 | 无（新增能力） |
| `tools(provider)` | 工具 schema 贡献（加法，不遮蔽） | `ToolRegistry._api_tools` |
| `suppressRuntimeContext()` | 抑制本作用域全部 runtime context | 无 |

排序位次由 `SECTION_ORDERS` 集中分配（`HARNESS_IDENTITY: -1000`、`DEPLOYMENT_PERSONA_PREFIX: 0`、
`TOOL_*: 1000-2900`、`TOOLS_SDK: 5000`、`DEPLOYMENT_PERSONA_SUFFIX: 10200`；
`CONTEXT_ORDERS`: `SANDBOX_POLICY: 110`、`APPROVAL_POLICY: 115`、`SUBAGENT_DELEGATION: 120`）。
`getSectionOrder(name)` 只认这些名字，未知名字返回 `undefined`，随后 `section()` 抛
`order must be a finite number` —— 第三方必须用**自由数字**。

作用域：注册的可见性取自注册时的 `ctx`（`@deepseek-ai/dsh-scope`），
合并语义是 `Map.set` 链式覆盖 = **最近作用域赢同名**，即 agent scope 遮蔽全局。
同层重名直接抛错。段与段的拼接发生在渲染期（`renderPrompt`，空行连接），
**最终合成一条 system 消息文本**。

profile 形态（本机实测 `~/.dsh/profiles/web/`）：`package.json` 声明
`dsh.profile.bundles`，`cordis.patch.yml` 是用户 patch 层。本机已有一个可照抄的先例：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: avantf-mem
      name: '@avantf/mem-dsh'
      config:
        mode: cordis
        dataHome: '~/.avantf'
```

`@avantf/mem-dsh` 的形状就是本设计要复制的形状（`inject = ["tools","typert","systemPrompt"]`，
`apply` 里一次 `ctx.systemPrompt.section(MEMORY_PROMPT_SECTION)`，
段定义 `{ name: 'avantf:memory-usage', order: 3000, text: '…' }`）。

## 设计

### 4.1 逐层映射判定

| AvantF 层 | DSH 落点 | 判定 |
|---|---|---|
| `StableLayer`（身份 + 扩展，priority 降序） | `systemPrompt.section()`（全局或 preset scope）+ 身份层用 `dsh-persona` 的 `prefix` | **直接映射** |
| `MessageRouter` / `MessageLayer`（历史 + 双轨 + 落盘 + 压缩） | session 日志 surface 事件 + `deriveMessages()` + `dsh-compaction*` + `dsh-spill*` | **不移植**（框架已有一等实现，且带 fork/resume/replay） |
| `DynamicLayer`（回退链，每次调用重建） | `systemPrompt.context()`（回退链用「返回 `''` 即不贡献」保留） | **需适配**（瞬时 → 持久快照 + 去重节流） |
| `TempLayer`（单次消费） | **无等价**；重新设计为「状态驱动的动态 `section`」 | **重新设计** |

### 4.2 段 1：StableLayer → section + persona

**落点**：`dsh-persona` 行装身份层（`prefix`），其余扩展各占一个 `section`。

```yaml
# .agent-presets/avantf/agent.cordis.yml（节选）
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: 当前工作目录：{{cwd}}。
    prefix: |-
      <AvantF 的身份 prompt 原文>

- id: prompt-layers
  name: '@avantf/prompt-dsh'
  config:
    stable:
      - { name: 'avantf:project', order: 100, text: '…PROJECTS.md 内容…' }
      - { name: 'avantf:tool-guide', order: 200, text: '…工具 usage_guide…' }
    dynamic:
      - { name: 'avantf:todoist', order: 10, kind: 'todoist' }
```

设计要点：

1. **persona 必须在 preset scope 内挂载**。`dsh-system-prompt` 自己无条件注册了
   `deployment:persona-prefix`，全局再挂 `dsh-persona` 会撞名报错 —— 这是刻意的，
   preset 的作用正是遮蔽部署人设。所以 AvantF 的身份层不能走 profile 层，只能走 preset。
2. **priority → order**：AvantF 是降序（`priority: 90` 比 `30` 靠前），DSH 是升序。
   换算约定：`order = 100 - priority`，或直接手工给 AvantF 扩展分配 order 常量。
   建议显式常量表（写在插件里），不依赖换算，避免两套数轴混淆。
3. **位次选在第三方空档**：per-tool 指导占 1000–2900，toolset 级占 5000。
   建议第三方扩展统一用 **3000 起的空档**，与已安装的 `@avantf/mem-dsh`（3000）一致。
4. **缓存不再手写**。`StableLayer._cache` / `_token_cache` / `invalidate()` 是 AvantF
   为"身份构建一次"做的优化；DSH 里段文本每次组装都重新求值，若扩展内容昂贵
   （例如要读文件），在**插件内部**按依赖做缓存，依赖变化时再让 provider 返回新文本。
5. **`tokens(designate)` 不需要移植**。AvantF 靠它算 `overhead_tokens()`；
   DSH 有 `dsh-token-meter` 与请求序列的前缀稳定性判定，段文本成本随渲染内容自动计入。
6. **`designate`（master / 念头区分）不要移植**。DSH 的对应机制是
   **作用域**：子 agent 有自己的 `agent.ctx`，需要"只对某个 agent 生效"就在该 scope 注册，
   而不是在段文本里做 `if designate == 0` 分支。AvantF 的 `ToolRegistry.is_for(designate)`
   同理 → 改用 `ctx.tools.get(name, scope)` 或按 scope 注册。
7. **工具段与工具 schema 是两件独立的事**。DSH 里工具 schema 走 `tools` 注册表，
   工具指导走 section；不要试图用段文本去描述 schema。

### 4.3 段 2：MessageLayer → 不移植

| AvantF 机制 | DSH 对应 | 处理 |
|---|---|---|
| `_api_formats`（LLM 上下文）+ `_turn_api_formats`（turn 暂存） | session 日志 surface 事件；请求由 `deriveMessages()` 派生 | 删除 |
| `commit_turn()` / `discard_turn()` | `agent-loop` 的 turn/step 边界；被中断的 turn 自然不落盘 | 删除 |
| `_messages` 写缓冲 + `mark_all_saved()` | 日志即真源，无"写缓冲"概念 | 删除 |
| `messages.jsonl` / `context.jsonl` + `_auto_load()` | `dsh-session-persistence-jsonl`；`_set_reload_alert()` 的"以上是历史"提示由 DSH 的恢复语义处理 | 删除 |
| `tool_outputs/` 外置（`_TOOL_EXTERNALIZE_BYTES`）+ `{ref, len}` 占位 | `dsh-spill` / `dsh-spill-policy` / `dsh-output-retention` | 删除 |
| `Compactor`（pinned / recent / `_sanitize_pairs` / `_align_keep_boundary`） | `dsh-compaction` + `dsh-compaction-basic` + `dsh-compaction-tool-result-pruner` | 删除 |
| `estimate_tokens()` 增量累计 + `_FULL_RECOUNT_STRIDE` | `dsh-token-meter` | 删除 |

唯一需要迁移的是**压缩策略的意图**（"小 user 消息当锚点钉住、摘要作为 system 消息插入、
tool_use/tool_result 配对必须完整"）。DSH 的压缩实现走 `surfaceOp: {op:'replace'}` 遮蔽旧节点
（原文仍留在日志里），配对保护由框架负责。若确实需要 AvantF 那条"小 user 消息钉住"的策略，
应在 DSH 侧写成 compaction 策略插件，而不是搬 `Compactor` 的代码。

### 4.4 段 3：DynamicLayer → context（语义改写）

**机制保留，语义改写。**

回退链**可以原样保留**：`context()` 的 provider 返回 `''` 表示"不贡献"，
所以 `TodoistManager` 那种"第一个非空者胜出"的写法直接成立：

```js
for (const ext of DYNAMIC)                       // 已按 order 升序排好
  ctx.systemPrompt.context({
    name: ext.name,
    order: ext.order,
    text: (context) => ext.render(context.agent) ?? '',   // '' 即降级
  })
```

但必须理解三处语义差异：

1. **它落成 user 角色消息，不是 system**。DSH 把 runtime context 物化为带
   `source.kind='plugin'` 来源标注的**持久 user 快照**，文本头部固定为
   `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`
   —— 旧快照不删除，只是被声明为"已被取代"。所以模型看到的不是"当前进度"，
   而是"一串历史进度 + 最新的那条有效"。**AvantF 的动态层文本必须能承受这种超集语义**
   （写"当前待办：…"，不要写"相比上次变化：…"）。
2. **相同文本不产生事件**（这是好事）。框架维护 `retained.text`，内容不变直接跳过。
   所以高频抖动的 provider（例如把当前时间、工具计数器塞进动态层）只会不断追加快照，
   既不省 token 也击穿 KV 前缀复用。**动态层的文本必须只在真实状态迁移时变化**，
   必要时加节流（`dsh-time-context` 用 `refreshIntervalMs` 就是这个套路）。
3. **抑制是作用域级**：`suppressRuntimeContext()` 一旦被任意祖先层调用，整个作用域的
   context 全空 —— 不能只抑制某一条。

**逐次高频的内容不要走 `context()`。** `TodoistManager._window`（上次签收→现在的工具活动）
这类每步都在变的东西，正确的落点是 **inbox 消息**：`agent.inject(message)`（不唤醒，
下个 pre-step 认领）或 `agent.steer(message)`。注意它同样是**持久 user 消息**，
DSH 没有"不落盘"的通道（见 §4.5）。

### 4.5 段 4：TempLayer → 重新设计（无等价）

DSH 的架构不变量是**「模型可见即已记录」**：请求内容必须是会话日志的纯函数
（`deriveMessages()` + 请求对象 deep-frozen），只有 4 类带 `surfaceOp` 的 surface 事件
能投影出消息，`agent/request` 明文禁止修改消息，`llm/stream` 的请求不可改写。
因此**不存在"只对单步可见、且不落盘"的注入通道** —— `TempLayer` 没有对应物。

按 `turn_runner.py` 里 TempLayer 的四种实际用法分别给出落点：

| TempLayer 用例（`turn_runner.py`） | DSH 落点 |
|---|---|
| 循环保护警告（`:234`）、工具异常提示（`:251`） | 这些是**对模型的即时纠偏**。落点：`agent.inject()`（持久 user 消息）+ 状态去重（同一警告不重复注入） |
| 验证提示"已修改 X，请验证"（`:275`） | 同上；或做成状态驱动的动态段（"存在未验证修改"这个状态的文本） |
| CompletionGate 截断提醒（`:328`，`nudge`） | 一类**一次性请求重试**。DSH 里对应 `agent/turn-stopping`（serial）→ `agent.steer()`；或状态驱动的动态段（"上次响应疑似被截断"） |
| steer/插话提示"前面有 N 条用户新消息"（`:363`、`:374`） | 这是**对话边界感知**。DSH 的 steer 语义已原生表达"这是插话"（`agent/steer()` 在最近 step 边界被认领），不需要再注入一条提示；若仍需，走状态驱动的动态段 |

**推荐形态（照抄 `dsh-plan-mode`）**：段只注册一次，`text` 是读当前状态的 provider；
状态不变 → 渲染不变 → 零额外事件、零 cache 失效；状态切换 → 恰好一次持久变更。
`dsh-plan-mode` 还额外做到"等到下一个被接受的 pre-step 才提交"，避免半轮切换 ——
AvantF 的 mode 指令应沿用这个时序。

**不要做的**：用两次持久 `replace` 去模拟"出现→消失"。那会在日志里永久留下两条事件，
并因 `replaceGeneration` 递增击穿从首条被遮蔽节点起的 KV cache 复用。

### 4.6 扩展契约怎么落

AvantF 的扩展是 Python 类 + 命令式注册；DSH 侧建议分两层：

- **内容层（推荐先做）**：插件只做声明式注册，段与 context 清单来自配置。
  这样 `PROJECTS.md`、工具指南、动态进度都能进 DSH，且不需要写 TS 类。
- **契约层（按需）**：若希望 AvantF 扩展作者继续用 `IStableExtPrompt` 那套心智，
  在插件里暴露一个注册表：

```js
// @avantf/prompt-dsh
export const name = 'avantf-prompt'
export const inject = ['systemPrompt']

const STABLE_ORDER = { project: 100, toolGuide: 200, /* … */ }

export function apply(ctx, config) {
  for (const s of config.stable ?? [])
    ctx.systemPrompt.section({ name: s.name, order: s.order ?? 3000, text: s.text })
  for (const c of config.dynamic ?? [])
    ctx.systemPrompt.context({
      name: c.name, order: c.order ?? 10,
      text: (context) => renderDynamic(c, context.agent),   // '' 即降级
    })
}
```

关键差异（必须写进契约文档）：

| AvantF | DSH | 说明 |
|---|---|---|
| `priority`（降序，任意 int） | `order`（升序，任意有限数） | 数轴方向相反 |
| `stable_prompt(designate) -> list[dict]` | `text: (ctx) => string` | 返回字符串而非消息列表 |
| 多条 system 消息 | 段在渲染期拼成**一条** system 文本 | 想"原子成段"只能走 `context()` |
| `build_prompt() -> list[dict]` | `context.text -> string` | 空列表降级 → 空字符串降级 |
| `register(ext)` 命令式 | `section()` / `context()` 声明式 | 返回 disposer，非永久 |
| `tokens(designate)` | 不需要 | 框架计量 |
| `reborn()` / `reset()` | agent 生命周期 + effect disposer | 由 scope 卸载 |

### 4.7 Token 与 KV cache 影响

- **段文本**：每次请求重复，成本随渲染内容增长；内容与顺序不变时前缀稳定、可复用。
- **动态 context**：只在变化时新增一条持久快照，**每条快照都会一直占用上下文直到被压缩遮蔽**。
  这是移植动态层时最容易踩的坑。
- **设计约束**：动态层文本必须"低频、离散、单调"（状态迁移才变），
  不能是连续量（时间戳、计数器）。
- **`complete: true`** 能让某段成为唯一 system 提示，此时其他段与 assemble 监听器都加不进文本 ——
  若 AvantF 想要"身份层完全锁定整个 prompt"，这是现成开关；但一旦开启，
  工具指导与 runtime context 也随之消失，慎用。

## 实施计划

分三步，每步可独立验收：

1. **验证链路（最小）**
   - 新建用户 preset 目录 `~/.dsh/.agent-presets/avantf/`（当前不存在），
     写 `preset.yml`（`name` / `description`）与 `agent.cordis.yml`。
   - 先只放 `dsh-persona` + 一条 `@avantf/mem-dsh`（已安装，直接复用）验证 preset 能被选中。
   - 验收：`dsh --dump-config` 无报错；会话里选到该 preset；模型能复述 persona 文本。
2. **移植段 1**
   - 用 profile 层 `cordis.patch.yml` 挂一个只注册 `stable` 段的插件行（先不进 preset，
     降低作用域调试成本）。
   - `PROJECTS.md` → 一个段（对应 `ProjectPrompt`）；工具指南 → 每工具一个段
     （对应 `ToolRegistry` 的 `usage_guide`）。
   - 验收：段文本在模型回答中可复现；改配置后 `patchReload: live` 生效；
     空文本段不产生任何文本。
3. **移植段 3 / 段 4**
   - `TodoistManager.build_prompt()` → `context()`，并改写为"只写当前状态"的文本。
   - `turn_runner.py` 的 Mode 指令与验证提示 → 状态驱动的动态 `section`（照 `dsh-plan-mode`）。
   - 高频活动窗口 → `agent.inject()`。
   - 验收：状态不变时**不产生新事件**（对比两次请求的 session 事件数）；
     状态迁移时恰好产生一次；KV 前缀在这些变化之间保持稳定。

## 风险与验证

| 风险 | 说明 | 验证方式 |
|---|---|---|
| 第三方 preset 行解析 | 新 preset 里的插件行能否从 profile `node_modules` 解析，**本轮只做了类型/doc 层核对，未做端到端实验** | 实施步骤 1 的验收；失败则退回 profile 层挂载 |
| `dsh-persona` 全局撞名 | 在 profile 层挂 `dsh-persona` 会与注册表自身的 `deployment:persona-prefix` 撞名并抛错 | 只在 preset scope 内挂；全局身份改用 `dsh-system-prompt` 的 `config.personaPrefix` |
| 段位次冲突 | 第三方必须用自由 order；`getSectionOrder('X')` 对未知名字返回 `undefined` 会让 `section()` 抛错 | 段名与 order 集中在一张常量表；启动时 `dsh --dump-config` + 日志核对 |
| 动态层刷屏 | 每步变化的文本会不断追加持久快照，token 与 cache 双输 | 实施步骤 3 的"事件数不变"验收；高频内容改走 `agent.inject()` |
| `complete: true` 误用 | 一旦某段声明 complete，其余段与 runtime context 全部消失（context 仍可被 `suppressRuntimeContext` 影响） | 默认不用；需要时单独验证 |
| 多条 system 消息 | 本机实测 DeepSeek 适配器**逐条**发送 `system` 消息（`serializeMessages` 不做合并），但该多节点形态由 agent-loop 的 `SystemPromptProjection` 独立控制，不由插件直接决定 | 不依赖多 system 消息承载段语义；需要原子成段时用 `context()` |

## 未决问题

1. AvantF 的 `Priority` 数轴（降序）是否统一换算成 order（升序），还是重排一套 order 常量？
   —— 建议重排，避免两套数轴长期混淆。
2. `PROJECTS.md` 这类**工作区文件**内容是走 `section({text: fn})` 每次读盘，
   还是交给 `dsh-agent-instructions`（它已支持 AGENTS.md/CLAUDE.md + 预算 + touch 刷新）？
   —— 后者更省事，但候选文件名与 `PROJECTS.md` 不同。
3. 动态层的"回退链"是否需要保留？DSH 的 `context()` 各条独立贡献、按 order 拼接，
   与"回退链只取第一条非空"是不同语义。若 AvantF 确实依赖回退语义，
   就必须在插件内部合并成一条 context。
