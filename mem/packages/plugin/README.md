# @avantf/dsh-mem

DSH（DeepSeek Harness）原生记忆插件：给 agent 一份可长期检索的**记忆**和一个**文档知识库**，
以进程内 Cordis 插件的形式提供 8 个模型工具、三段用法提示和两个设置页。

## 主要功能

- **8 个模型工具**
  - `mem_remember`：新增 / 改写 / 删除事实，或对某条事实反馈有用没用（写入后立刻做矛盾检测）
  - `mem_recall`：混合检索（语义 + 全文 + 实体）、三元组方向问答、链路推理、实体探查、矛盾查询
  - `mem_admin`：列表 / 详情 / 归档恢复 / 检索统计 / 记忆保留诊断 / 向量索引诊断与修复 /
    矛盾补扫与裁决 / 维护
  - `kb_add` / `kb_list` / `kb_remove` / `kb_reindex`：新增文档（文本 / 文件 / URL，或批量导入目录，
    同名拒绝）、列表（带出受管 `.md` 的绝对路径与切片详情）、删除、重建索引；
    **改一篇既有文档就是改那份 `.md`**（用 `edit`，索引自动跟随）
  - `kb_query`：跨「记忆事实 + 文档切片」的统一检索，结果带来源标注
- **混合检索 + 联合融合**：库内三路（语义 / FTS bm25 / 实体 Jaccard，另有 HRR 实体探查腿），
  跨库在合并候选池上做联合归一化——记忆与文档切片因此处于同一分数刻度。
- **记忆是活的**：活跃使用日时钟，结算 / TTL / 遗忘 / 闲置 / 清理五段生命周期，去重与修订链，
  写入即做的矛盾检测；派生状态（实体 / 三元组 / HRR bundle）跟着规则版本走，可批量重抽。
- **文档知识库**：Markdown 标题感知分块、摄入期抽实体（检索期零重扫）、可增量重建索引；
  `domain` 受 `knowledge.domains` 清单约束（默认 `design/api/ops/research/notes`，显式 `[]` = 不限制），
  `source` 可留空（缺省 `default`）。可直接摄入文本与 **PDF**（抽取文本层，中文 CID 字体可用；
  扫描件会明确报错），并把 **pandoc 能读的格式**（`.docx`/`.odt`/`.epub`/`.html`/`.tex`/`.rst`/`.csv`
  等）与 **`.xlsx`** 先转成 Markdown 再入库（用了哪条转换器随 `converter` 回报且带版本，如
  `pandoc-3.11`；没能带过来的内容随 `warnings` 透出）。其他二进制（图片 / pptx / 旧版
  `.doc`/`.xls`/`.ppt` / 可执行文件）会被拒绝并说明检测到的类型；GBK/GB18030 等中文旧编码会自动解码
  并在结果里标出 `encoding`。
- **知识可维护**：每篇文档在 `~/.avantf/knowledge/docs/<domain>/<source>/<title>.md` 留一份可编辑副本
  （frontmatter 记着它属于哪篇文档）——用你自己的编辑器改，回到「知识」页点「重新摄入」即把改动拉回
  索引；删除文档会连同这份副本一起删除，`source_uri` 指向的原文件始终不被改动。
- **可插拔、可降级**：语义后端 / 重排 / 向量库都走内部注册表；模型、hnswlib、分词器任一缺失都自动降级
  （FTS + 实体 / numpy 向量库 / 正则抽取），不会因此退出。
- **两个主窗口标签页**（排在 对话 / 轨迹 之后）：**记忆**（浏览、编辑、归档恢复、反馈、矛盾裁决）与
  **知识**（文档列表，每行可查看切片 / 编辑 / 打开目录 / 重新摄入 / 删除；另有跨库查询与入库——
  URL / 本地文件 / 本地目录 / 粘贴文本共用一个输入）。
- 系统提示词里只加**三段**用法提示（何时该主动记忆、何时该先查记忆、何时该先查知识库 / 怎么改一篇
  既有文档），不解释内部保留策略。

## 接入 dsh

```bash
# 1) 装这两个包：插件本身，以及家族底座。底座是插件的 peer；不开 autoInstallPeers 的包管理器
#    （pnpm / yarn）不会跟着装上，所以要显式装。
#    版本号建议写死：pnpm ≥ 10 的 minimumReleaseAge 会避开刚发布的版本，解析到的旧版本可能不认识
#    当前宿主（它的 peer 区间不含这个 dsh），那一单会被宿主的安装门禁直接拒绝并把 profile 回滚。
dsh plugin --profile <PROFILE> add @avantf/dsh-plugin-base@<version>
dsh plugin --profile <PROFILE> add @avantf/dsh-mem@<version>

# 2) 原生依赖只剩**可选**的加速件（分词 / 向量索引 / 嵌入模型）。它们缺失只会降级检索质量，
#    不影响记忆库本身——存储层用的是运行时自带的 node:sqlite，没有需要编译的数据库模块。
cd ~/.dsh/profiles/<PROFILE>
pnpm approve-builds --all     # 勾选 nodejieba / hnswlib-node / onnxruntime，可按需
```

```yaml
# 3) 挂载插件：装完通常什么都不用做。
#
# 本包声明了组合包（dsh.bundle.patch → 随包的 cordis.patch.yml），所以 `dsh plugin add` 装它时会
# 顺手把这个包选进 profile 的 dsh.profile.bundles（实测），挂载行由随包的 patch 插入；DSH Desktop
# 的「插件」页走的也是这条。只有两种情况才需要自己写那一行：
#   · 用 npm / yarn 装（它们不认识 dsh.profile.bundles）；
#   · 手工编辑 profile 的包清单，而没有把本包选进 bundles。
# 两条路都做也不会挂两次（loader 按条目 id 去重，实测只挂载一次），但配置里会多一行冗余——二选一。
#
# 手写的那一行，放在 ~/.dsh/profiles/<PROFILE>/cordis.patch.yml（不存在就新建）：
- insert:
    - id: avantf-mem
      name: '@avantf/dsh-mem'
      config:
        mode: cordis          # 进程内插件
        # dataHome 建议省略（默认 ~/.avantf）。它是配置值，会被 AVANTF_HOME 压过。
```

```bash
# 4) 重启 dsh（宿主半边需重启，浏览器半边会热重载）
dsh web
```

### DSH Desktop

Desktop 用的是同一套 profile（profile 名 `desktop`），差别只有三点：

- **界面上只能装组合包**。Desktop 的「插件」页与 `plugin_manager` 只接受声明了 `dsh.bundle.patch`
  的包（本包已声明）：在页面上装它，它会把这个包选进 `dsh.profile.bundles`，并应用随包的
  `cordis.patch.yml`——不用手写挂载行。
- **用它自带的 dsh**：`<安装目录>/resources/runtime/cli/bin/dsh.cmd`（或在设置里把 `dsh` 装进 PATH）。
- **重启应用**才生效：Desktop 的宿主半边与浏览器半边一起启动，不像 Web 那样热更。

Desktop 的宿主进程是 **Electron**（`NODE_MODULE_VERSION` 与同版本 Node 不同）。这正是本插件不依赖任何
SQLite 绑定的原因：存储层用运行时自带的 `node:sqlite`，它就在跑插件的那个进程里，没有预编译产物要匹配、
也不需要用户装 C++ 工具链。启动日志里 `sqlite=node:sqlite <版本>` 就是它；两个宿主写的是同一个 SQLite
文件格式，换宿主不需要迁移数据。

- 插件的 `@deepseek-ai/*` peer 由宿主提供（profile 上层的运行时解析表），`dsh plugin add` 不会另装一份。
  **不要在 profile 里再装** `cordis` / `schemastery` / `dsh-tools`——两份对象身份会让工具与 typert
  注册表对不上。

## 怎么用

工具是给模型用的，通常不用你手写；这里是最常见的几种用法。

```text
记住这条：发布窗口是每周四 20:00；验收标准是灰度零回滚。
```

```text
我之前定过的数据目录约定是什么？（→ mem_recall，返回命中事实与来源）
```

```text
把 ~/docs/cgroup-v2.pdf 收到知识库的 ops 域下。（→ kb_add source_uri，转换器与告警随结果回报）
```

```text
看看知识库里关于「内存保护」的原文。（→ kb_query，结果带 source_ref，可据此引用）
```

改一篇已经入库的文档：先用 `kb_list` 拿到那份 `.md` 的路径，再用编辑器改它，回到「知识」页点
「重新摄入」；或直接对模型说"更新这篇文档"。

常见维护动作：

```text
检查记忆库的检索与索引状态。（→ mem_admin trust_diagnose / vectors_diagnose / stats）
把矛盾检测的积压扫一遍。（→ mem_admin contradict_check，再对每条判 true_positive / false_positive）
```

## 配置、数据与提示词

- **数据目录**：默认 `~/.avantf`。记忆库、知识库（含 `knowledge/docs` 下的受管文档副本）与模型缓存
  都在其中。
- **配置**：`~/.avantf/configs/` 下的三份 YAML —— `common.yaml`（公共项，缺失时按注释模板自动创建）、
  `memory.yaml`、`knowledge.yaml`；只写你要改的项，其余取内置默认。`dataHome` 也可以写在 profile 的
  config 里，但环境变量 `AVANTF_HOME` 会压过它。
- **提示词文件**：`~/.avantf/prompts/mem-memory-usage.md`、`mem-knowledge-usage.md`、`mem-kb-edit.md`。
  缺失或为空时插件写入默认内容，**只在启动时读一次**，改完重启生效。
- **语义模型**：默认从 `hf-mirror.com` 下载并缓存，也可指向本地模型目录离线运行。
- **升级前先备份 `~/.avantf`**：数据库迁移是单向的，用旧版本打开新库会被明确拒绝。

## 升级 / 卸载 / 换版本

```bash
# 升级（或重装）到某个版本：同一条命令，换版本号即可
dsh plugin --profile <PROFILE> add @avantf/dsh-mem@<version>

# 卸载：先删掉 profile 依赖（这一步同时会取消该组合包的选中）
dsh plugin --profile <PROFILE> remove @avantf/dsh-mem
# 再清掉挂载项：用组合包装的，包名已随上一步从 profile 的 `dsh.profile.bundles` 里去掉，无需再动；
# 自己手写过那一行的，删掉 ~/.dsh/profiles/<PROFILE>/cordis.patch.yml 里那段 `- id: avantf-mem`
#（该文件顶层必须是 YAML 数组：删空就写 `[]`，否则 dsh 启动会拒绝加载）。
# DSH Desktop 的「插件」页上卸载会连着取消选中与依赖一起做。
```

两者都需要重启 dsh 才生效。卸载**不动 `~/.avantf`**：记忆库、知识库、模型缓存全部保留。

## 环境要求

- **Node `>=22.15.0 <23 || >=23.11.0`**、**pnpm**。记忆与知识两个库都建在运行时自带的 `node:sqlite`
  上，这个区间是它的两个下限的交集：模块免 flag（22.13 / 23.4）与"忽略语句未用到的命名参数"
  （22.15 / 23.11）。低于该下限（或该构建缺 FTS5）时插件照常挂载，但 8 个工具都回
  `memory unavailable` 并给出原因，不会拖垮宿主启动
- `nodejieba` / `hnswlib-node` / `@huggingface/transformers` 都可选：缺失时分别降级为正则抽取 /
  numpy 向量库 / 纯词法检索
- 插件自包含：检索与知识引擎在构建时已内联进产物，安装不需要额外的家族包（只要底座，
  由宿主以 peer 提供）

## 从源码构建

构建只对着**已安装的全局 dsh**（`npm i -g @deepseek-ai/dsh`），不需要 harness 源码；在仓库根执行：

```bash
pnpm install
pnpm build:dsh mem      # 插件两半（tsc + tsdown → lib/index.js + lib/client.js），随后自动跑挂载冒烟
pnpm pack:plugin:mem    # 打包成"用户安装的那一个包"（断言引擎已内联、依赖版本已落成真实范围）
```

## 许可

MIT。
