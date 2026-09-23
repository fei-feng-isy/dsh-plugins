# avantf-mem

DSH（DeepSeek Harness）原生记忆插件：给 agent 一份可长期检索的**记忆**和一个**文档知识库**，
以进程内 Cordis 插件的形式提供 5 个模型工具、两段用法提示和两个设置页。

## 特性

- **5 个模型工具**
  - `mem_remember`：新增 / 改写 / 删除事实，或对某条事实反馈有用/没用（写入后立刻做矛盾检测）
  - `mem_recall`：混合检索（语义 + 全文 + 实体）、三元组方向问答、链路推理、实体探查、矛盾查询
  - `mem_admin`：列表 / 详情 / 归档恢复 / 检索统计 / 记忆保留诊断 / 向量索引诊断与修复 /
    矛盾补扫与裁决 / 维护
  - `kb_add` / `kb_list` / `kb_remove` / `kb_reindex`：新增文档（文本/文件/URL 或批量导入目录，同名拒绝）、
    列表（带出受管 .md 的绝对路径与切片详情）、删除、重建索引；**改一篇既有文档就是改那份 .md**（用 `edit`，索引自动跟随）
  - `kb_query`：跨「记忆事实 + 文档切片」的统一检索，结果带来源标注
- **混合检索 + 联合融合**：库内三路（语义 / FTS bm25 / 实体 Jaccard，另有 HRR 实体探查腿），
  跨库在合并候选池上做联合归一化——记忆与文档切片因此处于同一分数刻度。
- **记忆是活的**：活跃使用日时钟、结算 / TTL / 遗忘 / 闲置 / 清理五段生命周期、去重与修订链、
  写入即做的矛盾检测；派生状态（实体 / 三元组 / HRR bundle）跟着**规则版本**走，可批量重抽。
- **文档知识库**：Markdown 标题感知分块、摄入期抽实体（检索期零重扫）、可增量重建索引；
  `domain` 受 `knowledge.domains` 清单约束（默认 `design/api/ops/research/notes`，显式 `[]` = 不限制；库里已有的领域始终可用），`source` 可留空（缺省 `default`）；
  摄入文本与 **PDF**（抽取文本层，中文 CID 字体可用；扫描件会明确报错），并把 **pandoc 能读的文档格式**
  （`.docx`/`.odt`/`.epub`/`.html`/`.tex`/`.rst`/`.csv` 等）与 **`.xlsx`** 先转成 Markdown 再入库
  （用了哪条转换器随 `converter` 回报且带版本，如 `pandoc-3.11`，没能带过来的内容随 `warnings` 透出）；其他二进制（图片 / pptx / epub / 旧版 .doc/.xls/.ppt / 可执行文件）
  会被拒绝并说明检测到的类型；GBK/GB18030 等中文旧编码会自动解码并在结果里标出 `encoding`。
- **知识可维护**：每篇文档在 `~/.avantf/knowledge/docs/<domain>/<source>/<title>.md` 留一份可编辑副本（frontmatter 记着它属于哪篇文档）——用你自己的编辑器改，回到「知识」页点「重新摄入」即把改动拉回索引；删除文档会连同这份副本一起删除，`source_uri` 指向的原文件始终不被改动。
- **可插拔、可降级**：语义后端 / 重排 / 向量库都走内部注册表；模型、hnswlib、分词器任一缺失都
  自动降级（FTS + 实体 / numpy 向量库 / 正则抽取），不会因此退出。
- **两个主窗口标签页**（在 对话 / 轨迹 之后，DSH `conversation.view`）：**记忆**（浏览、编辑、
  归档恢复、反馈、矛盾裁决）与 **知识**（打开即文档列表，每行可查看切片 / 编辑 / 打开目录 / 重新摄入 / 删除，另有按需展开的跨库查询、入库（URL / 本地文件 / 本地目录 / 粘贴文本共用一个输入，带本地选择器；知识域为下拉、来源可留空）/同步文件/重建索引）。
- 系统提示词里只加**两段**用法提示（何时该主动记忆、何时该先检索记忆，何时该先查知识库），不解释内部保留策略。

## 这个包是怎么来的

`@avantf/dsh-mem` 是**自包含**的：构建时插件需要的引擎代码被**内联打包**进 `lib/index.js`，
所以 `npm install @avantf/dsh-mem` 只需要 `better-sqlite3` / `yaml` / `zod` / `unpdf` /
`exceljs`（以及可选的 `@huggingface/transformers` / `hnswlib-node` / `nodejieba`）。
家族那一侧没有运行期依赖：底座 `@avantf/dsh-plugin-base`（**一个包**，内含环境初始化框架、启动兼容门禁
与两个插件共享的 kit）由 DSH 宿主以 **peer** 提供；插件只把它的零依赖 bootstrap 内联进产物，底座本身
**绝不被 bundle、也绝不被静态 import**（静态 import 会在底座缺席时让整个插件模块加载失败）。npm 这类会
自动安装 peer 的包管理器会跟着装上它；pnpm 关掉 `autoInstallPeers` 时要显式装（见下方安装步骤）。
`@deepseek-ai/*` 同样由 DSH 宿主以 peer 方式提供（见下方「安装到一个 DSH profile」）。

本仓库是它的源码与构建脚本所在处：`pnpm build:dsh` 在本地构建，`pnpm pack:plugin` 打出上面那一个包，
`pnpm release:check` 跑完整门禁。

## 环境要求

- **Node ≥ 22**、**pnpm**
- **构建插件需要一份 DSH 源码 checkout**：插件用到 harness 内部的工具/typert 声明与
  `clientBundle` 预设，这些没有全部发布到 npm
- `better-sqlite3` 必需（原生模块）；`nodejieba` / `hnswlib-node` / `@huggingface/transformers`
  为可选依赖，缺失时自动降级

## 从源码构建

```bash
pnpm install
pnpm build          # 构建插件内联的引擎部分
pnpm build:dsh      # 插件（tsc + tsdown → lib/index.js + lib/client.js），随后自动跑 mount smoke
pnpm typecheck      # 引擎包的 src 类型检查（--noEmit）
pnpm pack:plugin    # 打包成"用户安装的那一个包"（断言引擎已内联、catalog: 已落成真实范围）
pnpm release:check  # 一次性跑完上面这些门禁（含插件的 mount smoke 与上面的打包断言）
```

`pnpm build:dsh` **只依赖已安装的全局 dsh**（`npm i -g @deepseek-ai/dsh`）：邻居包从它软链，tsdown
的 client preset 用仓库自带的 pin 住的副本，所以不需要 harness 源码（`DSHHARNESS` 也不再被编译路径读取）。
单独自检挂载：`node scripts/mount-smoke.mjs`（在真实 Cordis 上下文里挂载，期望输出 `MOUNT SMOKE OK`）。

> 插件链接与运行宿主必须是**同一份** `@deepseek-ai/*`：`scripts/link-dsh.mjs` 恒定从**已安装的全局
> dsh** 链接，链一份而跑另一份会让工具与 typert 注册表因对象身份不同而对不上。

## 安装到一个 DSH profile

需要**两个**包：插件的 host 半边已经把整份引擎内联进 `lib/index.js`，装机方不必再装引擎包
`@avantf/mem*`；但家族底座 `@avantf/dsh-plugin-base` 是插件的 **peer**——npm 这类会自动安装 peer 的包
管理器会跟着装上它，pnpm（关掉 `autoInstallPeers`）与 yarn 不会，所以要显式装（见下）。

```bash
# 1) 装这两个包（= 在 profile 目录里各执行一次 pnpm add）
dsh plugin --profile <PROFILE> add @avantf/dsh-plugin-base
dsh plugin --profile <PROFILE> add @avantf/dsh-mem

# 2) 放行原生依赖的构建：pnpm 10+ 默认忽略 postinstall，而 better-sqlite3 是记忆库的存储层。
#    不放行时插件仍会正常挂载，但 8 个工具都会回 "memory unavailable"（自动降级，不会拖垮宿主启动）。
cd ~/.dsh/profiles/<PROFILE>
pnpm approve-builds --all     # 至少勾选 better-sqlite3；nodejieba / hnswlib-node 可选
```

```yaml
# 3) 挂载插件：编辑 ~/.dsh/profiles/<PROFILE>/cordis.patch.yml（不存在就新建）
- insert:
    - id: avantf-mem
      name: '@avantf/dsh-mem'
      config:
        mode: cordis          # 进程内插件
        # dataHome 建议省略（默认 ~/.avantf）。写上它会覆盖 AVANTF_HOME。
```

```bash
# 4) 重启 dsh（宿主半边需重启，浏览器半边会热重载）
dsh web
```

- **peer 必须解析到宿主那一份**：插件的 5 个 `@deepseek-ai/*` peer 由 profile 上层
  `~/.dsh/profiles/node_modules` 解析（`dsh plugin add` 不会另装一份），不要在 profile 里再装
  `cordis` / `schemastery` / `dsh-tools`——两份对象身份会让工具与 typert 注册表对不上。
- **数据目录**：`~/.avantf`（可用 `AVANTF_HOME` 覆盖），记忆库、知识库（含 `knowledge/docs` 下的受管文档副本）与模型缓存都在其中。
- **配置**：`~/.avantf/config.yaml`（可选）。语义模型默认从 `hf-mirror.com` 下载/缓存，
  也可指向本地模型目录离线运行；`cordis.example.yml` 是一份最小插件配置示例。
- **升级前先备份 `~/.avantf`**：数据库迁移是单向的，用旧版本打开新库会被明确拒绝。

### 升级 / 卸载 / 换版本

```bash
# 升级（或重装）到某个版本：同一条命令，换版本号即可
dsh plugin --profile <PROFILE> add @avantf/dsh-mem@<version>

# 卸载：先删掉 profile 依赖
dsh plugin --profile <PROFILE> remove @avantf/dsh-mem
# 再删掉 ~/.dsh/profiles/<PROFILE>/cordis.patch.yml 里那段 `- id: avantf-mem` 挂载项
#（该文件顶层必须是 YAML 数组：删空就写 `[]`，否则 dsh 启动会拒绝加载）

# 两者都需要重启 dsh 才生效（宿主半边在启动时 import 一次）
dsh web
```

如果你手上是**本仓库的源码 checkout**（用 `link:` 装的），卸载可以一步到位：

```bash
pnpm cleanup:dsh --dry-run     # 先看计划与 patch diff，不改任何东西
pnpm cleanup:dsh --yes         # 外科式删 patch 项（不碰其他插件）+ 卸 profile 依赖
```

它**不动 `~/.avantf`**（记忆库、知识库、模型缓存都保留）；要连数据一起清，命令里会提示，
但注意那一步不可逆、且 `~/.avantf` 可能还有别的项目在用。


## 许可

MIT，见 [LICENSE](LICENSE)。
