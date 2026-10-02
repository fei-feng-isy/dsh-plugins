# avantf · DSH 插件家族

给 [DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的两个原生插件，
外加一个共享底座。三个包各自发布、各自有 README：

| 包 | 是什么 | 面向用户的入口 |
| --- | --- | --- |
| [`@avantf/dsh-mem`](mem/packages/plugin/README.md) | 记忆 + 文档知识库 | 8 个模型工具、两个主窗口标签页（记忆 / 知识） |
| [`@avantf/dsh-mission`](mission/packages/plugin/README.md) | 任务树引擎 | 9 个模型工具、三条命令（`/mission` `/archive` `/clean`）、一个「任务」标签 |
| [`@avantf/dsh-plugin-base`](base/plugin-base/README.md) | 前两个共用的底座（必装） | 不直接面向用户：提示词文件层、路径解析、宿主兼容门禁 |

两个插件都依赖底座，但**互不依赖**：可以只装一个，也可以两个都装。只装一个时下面的路径与提示词
约定同样成立；两个都装时它们共享同一套。

## 安装

```bash
# 底座是插件的 required peer：pnpm / yarn 不会自动跟着装，要显式装一条。
dsh plugin --profile <PROFILE> add @avantf/dsh-plugin-base@<version>
dsh plugin --profile <PROFILE> add @avantf/dsh-mem@<version>       # 只装记忆插件
dsh plugin --profile <PROFILE> add @avantf/dsh-mission@<version>   # 只装任务插件
```

- **版本号建议写死**：`pnpm ≥ 10` 的 `minimumReleaseAge` 会避开刚发布的版本，解析到的旧版本可能不
  认识当前宿主（它的 peer 区间不含这个 dsh），那一单会被宿主的安装门禁直接拒绝并把 profile 回滚。
- **装完通常不用手写挂载行**：两个插件都声明了组合包（`dsh.bundle.patch` → 随包的
  `cordis.patch.yml`），`dsh plugin add` 装它时会把它选进 profile 的 `dsh.profile.bundles`，挂载行
  由随包的 patch 插入；只有用 npm / yarn 安装，或手工编辑 profile 包清单而没有选中组合包时，才需要
  自己写那一行。**组合包与手写行是二选一**——各包 README 的「接入 dsh」一节写了确切后果。
- **重启 dsh 才生效**（宿主半边只在启动时加载一次；浏览器半边刷新页面即可）。DSH Desktop 用的是同
  一套 profile（profile 名 `desktop`），差别见各包 README。

每个包自己的安装前提（Node 版本、原生可选依赖、`pnpm approve-builds` 该勾什么）以该包 README 为准。

## 数据根与 `AVANTF_HOME`

插件把用户自己的数据与可编辑文本放在**数据根**下。解析顺序（左边的先赢）：

1. **调用方显式传入的值** —— 只有程序化入口会用到这一层（如今是 MCP 入口的 `dataHome` 选项）；普通
   dsh 挂载不会用到它；
2. **`$AVANTF_HOME`**；
3. **profile 里配置的 `dataHome`**（写在插件行的 `config` 里）；
4. **`~/.avantf`**（默认）。

> 注意：`<数据根>/configs/common.yaml` 里也有一条 `dataHome`，但它**不参与**解析——那个文件在数据
> 根之内，解析根的时候还没读到它。要改数据根请用上面的第 2 或第 3 层。

数据根下住着：

- `memory/`、`knowledge/` —— 记忆库与知识库（含 `knowledge/docs/<domain>/<source>/` 下的受管文档副本）；
- `configs/*.yaml` —— mem 的配置文件（`common.yaml` / `memory.yaml` / `knowledge.yaml`；mission 的配置
  项直接写在 profile 的插件行 `config` 里）；
- `prompts/*.md` —— 模型可见的提示词正文（见下一节）。

`AVANTF_HOME` 还有第二重身份：它是**家族 / 受管根**（未设置时是 `~/.avantf/env`），底座把环境框架
管理的资源放在 `<家族根>/tools`（外部二进制，如 pandoc）与 `<家族根>/models`（模型权重与缓存）。
所以设置 `AVANTF_HOME` 会把"用户数据"和"托管资源"一起挪到同一个前缀下——沙箱、测试，或想把两者放在
一起时用它；不设置时两者是分开的（数据在 `~/.avantf`，托管资源在 `~/.avantf/env`）。

数据文件只住在数据根的 `memory/`、`knowledge/` 之下，永不搬出；你**编辑**的一切都住在数据根的
`configs/*.yaml` 与 `prompts/*.md`（默认即 `~/.avantf/...`），绝不放在数据库旁边。升级前先备份数据
根：数据库迁移是单向的。

## 共享的 `prompts/` 约定

两个插件的模型可见提示词正文放在**同一个目录** `<数据根>/prompts/`，每个插件只碰自己前缀的文件：

| 插件 | 文件 |
| --- | --- |
| mem（`mem-*`） | `mem-memory-usage.md`、`mem-knowledge-usage.md`、`mem-kb-edit.md` |
| mission（`mission-*`） | `mission-tree-guide.md` |

- **文件就是提示词**：正文整段注入（首尾空白去掉、BOM 剥掉、CRLF 归一），没有 frontmatter，也没有
  要剥掉的注释头——你写什么，模型就看到什么。
- **缺失或为空时写入内置默认**：只要文件里有一个可见字符，它就归你，插件不再覆盖（写错也照用）。
- 目录里**不在上表**的 `.md` 会被忽略：不读、不写、不删——两个插件因此能安全地共用这个目录，也方便
  你把整个家族的模型可见文本放在一处 diff。
- **只在启动时读一次**：改完重启 dsh 才生效（这样"进程生命周期内 prompt 不变"）。文件在启动时按需
  创建，误删一个会在下次启动补回默认内容。

底座缺失或比插件要求的更旧时，插件照常挂载，但提示词层降级为插件**内置的默认正文**，且不往磁盘写
文件；其余能力（工具、service、界面）不受影响。

## 两个插件各自的入口

- **mem**：8 个模型工具 —— `mem_remember` / `mem_recall` / `mem_admin` / `kb_add` / `kb_list` /
  `kb_remove` / `kb_reindex` / `kb_query`；两个主窗口标签页（记忆 / 知识）承载浏览、编辑、检索与入库；
  兼容性拒载时保留一条 `/mem` 命令说明原因。三段提示词（上表三份 `mem-*` 文件）。
- **mission**：9 个模型工具（owner 6 / 执行者 3）；三条命令 `/mission`（看树或用文本建根任务）、
  `/archive`（归档已完成的执行者会话）、`/clean`（释放磁盘 / 清理孤儿树）；一个「任务」标签显示本会话
  的任务树，节点 id 可直接跳到执行者会话。任务树数据走 DSH 存储域，每个任务单元都是**真实会话**，
  日志在 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）。提示词是上表的 `mission-tree-guide.md`。

## 卸载

```bash
dsh plugin --profile <PROFILE> remove @avantf/dsh-mem        # 或 @avantf/dsh-mission
```

卸载**不动数据根**：记忆库、知识库、提示词文件、模型缓存与执行者会话日志全部保留。两个包都装时
逐个卸载。挂载项的去留（组合包 vs 手写行）见各包 README。

## 细节

- 每个包的功能清单、配置项、完整安装 / 升级 / 卸载说明：见上表各自的 README。
- 设计取舍与内部约定：`mem/DESIGN.md`、`mission/docs/**`、`base/plugin-base/docs/**`——仓库内文档，
  不随包发布，面向维护者。
