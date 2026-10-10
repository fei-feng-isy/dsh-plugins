# @avantf/dsh-identity

用你自己的三个文件替换 DSH（DeepSeek Harness）系统提示词里的**身份部分**。

装好之后，设置面板会多出一个**「身份」页**：一个总开关、三个可编辑的文件、以及一个多语言的预设库。
打开开关，会话第一轮的系统提示词就以你的身份文件开头；关掉开关，提示词与没装这个插件时**逐字相同**。

## 它改什么、不改什么

只替换两段：

- `harness:identity` —— `You are an AI agent powered by DeepSeek Harness.`
- `deployment:persona-prefix` —— `You are a coding agent powered by the <model> model.`

其它一切原样放行：工具指引、Agent Teams、plan mode、goal、subagent、jobs、web、workflow、MCP……
所有其它插件注册的 section **一条不少、一字不改**；`tools` 与上下文快照也不受影响。
`deployment:persona-suffix`（工作目录）保留——它是信息，不是身份。

**子代理完全不受影响**：默认只在主会话替换。被派出去的子代理（以及 Agent Teams 成员）看到的提示词与
未安装本插件时完全相同，包括 `dsh-subagent` 给它自己的 persona。

## 三个文件

| 文件 | 写什么 |
|---|---|
| `IDENTITY.md` | 你是谁、叫什么、扮演什么角色 |
| `SOUL.md` | 语气、价值观、行事风格、判断取舍的原则 |
| `RULES.md` | 硬约束：必须做与禁止做 |

渲染规则：按 `IDENTITY` → `SOUL` → `RULES` 的顺序拼接**非空**正文，段间一个空行；
**文件全文就是提示词**——不加标题、不加 frontmatter。三个文件都不存在或都为空 ⇒ 自动回到原生提示词。

文件按 **profile** 隔离，住在你的数据目录里（默认 `~/.avantf`，可用 `AVANTF_HOME` 改）：

```
<data home>/identity/
  profiles/<profile>/{IDENTITY,SOUL,RULES}.md     # 生效身份
  presets/<preset>/<locale>/{…}.md                # 预设库
```

## 安装

```bash
dsh plugin add @avantf/dsh-identity
```

随包声明了组合包（`dsh.bundle.patch`），`dsh plugin add` 会把它选进 profile 的 `dsh.profile.bundles`，
由 patch 插入挂载行。也可以手动装成普通依赖，再把下面这行加进 profile 的 `cordis.patch.yml`
（组合包与手写行**二选一**）：

```yaml
- insert:
    - id: avantf-identity
      name: '@avantf/dsh-identity'
```

安装请**钉版本号**：pnpm ≥ 10 的 `minimumReleaseAge` 会避开刚发布的版本，解析到的旧版本可能不认当前宿主。

装好后**重启 `dsh web`**（宿主半边只在启动时加载），刷新页面即可在设置里看到「身份」页。

## 用起来

1. 打开设置 →「身份」，先打开「启用身份」。
2. 三个框里写你的身份；点保存 → **新会话生效**：当前正在进行的会话提示词**保持不变**（会话中途换人既突然，
   又会让该会话的 prompt 缓存全部作废），开一个新会话就用新内容。
3. 想从预设开始：在「身份」下拉里选一个——按你当前的语言取该预设的那一套，缺该语言时退回英文；选择会覆盖
   生效身份（有二次确认）。下拉右侧的「删除」删掉选中的预设；预设全删光时下拉自然为空。
4. 「存为新预设」把当前生效身份存成一个新的预设 id（小写字母、数字与连字符）。预设库是**只读模板**：
   要改某套预置的内容，直接编辑数据根下 `presets/<id>/<locale>/*.md`。
5. 身份文件都清空、或关掉开关 → 同样在**新会话**里回到原生提示词。

## 几个要知道的语义

- **一个会话用哪个身份，取决于这个会话开始时磁盘上是什么**。会话进行中改文件、应用预设、动开关，都不影响
  这个会话；下一个会话才读到新内容。这样身份不会在读者眼皮底下换人，也不会中途作废该会话的 prompt 缓存。
- **`{{...}}` 默认按字面量保留**。打开「插值」后按上游的严格插值语义处理：文件里引用了没注册的变量会让
  **那一次装配失败**（因此默认关闭）。唯一的例外是 dsh `0.1.5` 线：那一代的 system-prompt 还不认识这个
  开关，**永远按严格插值处理**——在它上面 `{{...}}` 无法保持字面量，文件里就不要写完整的 `{{name}}`。
- **预算**：渲染后的身份默认上限 64 KiB。超了会整体截断并在末尾追加一行可见提示，同时日志里点出哪个文件超了
  （不按文件丢弃，因为 `RULES.md` 往往最要紧）。
- **缓存**：插件按 `(mtimeMs, size)` 缓存文件读取；在 UI 里保存会立即失效，用外部编辑器改动则在下一次装配时
  被感知——但如上一条，**新读到的内容只在下一个会话生效**。
- **KV cache**：会话内提示词不变 ⇒ 前缀缓存不动；改动在新会话生效，那时才重建一次前缀。
- 与 `dsh-persona` 的 `complete: true` **不再冲突**（本插件不用 `complete`）；两者同时开启时仍是 persona 的
  `complete` 生效。
- 环境故障（数据目录只读、预设资源缺失）只写一条 WARNING，插件照常挂载——**绝不因为环境问题拒绝加载或杀掉宿主**。

## 内置预设

| id | 身份 | 语言 |
|---|---|---|
| `coder` | 程序员 | `zh` / `en` |
| `assistant` | 助理 | `zh` / `en` |
| `analyst` | 分析师 | `zh` / `en` |

首次运行时整棵语言目录树被释放到 `<data home>/identity/presets/`；**只补缺失、永不覆盖**，你删掉的预设
不会被重建。

## 许可

MIT
