# 预装设施（Provisioning）现状

> **状态**：已迁移。插件不再自己"确保依赖可用"，而是把**真正的外部制品**声明成 item，交给家族底座
> `@avantf/dsh-plugin-base`（其中的环境初始化框架）统一编排；本仓只保留一条**降级路径**（底座拿不到时，
> 退回 `@avantf/mem-provision` 的 artifact sweep）。本文记录**现在是什么样**；机制细节在底座自己的
> `docs/DESIGN.md`（三层架构、provider 契约、发布锁、状态合并、内联边界）与 `README.md`（公共面与接入
> 步骤），用户侧安装与排错见 [`docs/INSTALL.md`](INSTALL.md)。
>
> **读者**：`@avantf/dsh-mem`（记忆插件）的维护者，以及后续接入这个底座的插件作者。
>
> **一句话**：插件只**声明它需要什么**（`mem:pandoc` / `mem:model`），底座负责
> `解析 → 探测 → 获取 → 校验 → 报告`；昂贵资源一律后台派发、**绝不等待**。启动兼容门禁**不在这个机制里**：
> 门禁就是底座本身（运行期内联 bootstrap 动态装载底座时一并到位），没有 `mem:compat` item、没有下载、也没有
> 受管 compat 根。

---

## 1. 现状：插件只声明 item

启动接线全部在 `packages/plugin/src/envinit.ts`，它从内联 bootstrap 动态装载进来的**底座**上取
`createProvisioner` / `declare` / `ensure`。清单是数据，插件不碰"怎么下载、装到哪、怎么校验"：

| item id | kind | `target.root` | `startup` | 何时声明 | spec 来源 |
| --- | --- | --- | --- | --- | --- |
| `mem:pandoc` | `binary-archive` | `tools` | `background` | `tools.auto_install === true` | `@avantf/mem-provision` 的 `PANDOC_PACKS`（URL / digest 单一真源） |
| `mem:model` | `model-cache` | `models` | `background` | 本地嵌入后端**且**运行时的 `semantic.cache_dir` 就是受管根 | 默认仓库的窄文件清单 + 环境层解析出的镜像 `spec.endpoint` |

- **没有 `mem:compat`**：启动兼容门禁**不再是 item**。门禁的规则 / 探针 / 报告 / 复查都住在底座
  `@avantf/dsh-plugin-base` 里，而底座由内联 bootstrap 在启动时从**插件自己的依赖树**解析、动态
  `import()`（`provision.ts` 直接在动态加载进来的那份底座上跑门禁），所以**没有 npm 下载、没有 integrity
  校验、也没有受管 compat 根**。宿主的 `zod` 仍必须与插件是同一份（identity 敏感），但不再需要"把显式
  peer 目录交给 provisioner"——底座与插件同树解析，天然共用一份。
- **`mem:pandoc`**：`PANDOC_PACKS` 的 URL / sha256 在框架的词汇里重写一遍
  （`format → archive`，二进制从"归档内路径"改成"归档搜索能找到的名字"）。装到
  `<home>/tools/pandoc/3.11/bin/pandoc`，与转换器解析的布局一致——所以交接是配置变化，不是代码变化。
- **`mem:model`**：框架 `model-cache` 的 **`flat` 布局**（0.1.2 起），文件落到
  `<home>/models/<repo>/<file>`——正是 `@huggingface/transformers@4.x` 在其 `env.cacheDir` 下按
  `<repo>/<file>` 读取的形状，所以框架装的这一份就是运行时读的那一份，**没有第二份下载**。`spec.files`
  只对**默认仓库**列出运行时真正会取的四个（`config.json` / `tokenizer.json` / `tokenizer_config.json` /
  `onnx/model.onnx`），避免把仓库里其余量化变体一起拉下来；`semantic.local_model` 换成别的仓库时**省略
  `spec.files`**，由框架按仓库自身的文件清单装——固定清单与仓库不符会让 item `failed`，而运行时本可服务。
  `spec.endpoint` 是环境层解析出的镜像（见 §3）。
  `startup: 'background'`、两个 `onMissing` 轴都是 `degrade`：拿不到模型就退回 FTS+entity，**绝不拒载**。
  语义预热从该 item 的 `onSettled` 开始：框架接管模型根时 `buildRuntime` 给后端传 `deferWarm`，构造期不再
  自己开抓，先等文件落盘再让运行时去看。
- **`mem:model` 在运行时另指缓存目录时不声明**：运维设了 `AVANTF_MEM_MODEL_CACHE`（环境层写进
  `semantic.cache_dir`）时，运行时读的是那个目录，声明 item 只会让族根多出一份没人读的完整副本（约
  190 MB）。此时插件不派发 item，直接预热。

**功能与开关**：`auto_install: false` 的 pandoc 拿不到 item，框架不会去取操作者明确关掉的东西。模型侧不同：
`semantic.auto_download: false` 时 item **仍会声明**，但只对该 kind 关掉下载，框架的终态是
`skipped (policy/download-disabled)`（只探磁盘、零网络，这行日志就是诊断），运行时也只读本地缓存；
`auto_download: true` 时才由运行时自己联网取。

## 2. 启动顺序

`packages/plugin/src/envinit.ts` 在 `apply()` 里**第一个**被调用，顺序固定：

```
bootstrap（内联；解析底座 → 动态 import() → 校验 supportedRange） → 派发 background item 集 → 插件自己的挂载前检查（兼容门禁）
```

1. **bootstrap（内联）**：`packages/plugin/src/envinit-bootstrap.js`，零依赖，负责让
   `@avantf/dsh-plugin-base` 可用：用 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')`
   **只从插件自己的依赖树解析**那一份（包管理器装的），校验它落在 bootstrap
   烘焙的 `supportedRange` 内，再动态 `import()`。它**不安装任何东西**——没有私有副本、不下载、
   不校验 tarball；解析不到或版本不被接受就一条 `envinit: WARNING` + 降级挂载。
2. **装载底座**：`@avantf/dsh-plugin-base` **只通过一个动态 `await import()` 出现**（bootstrap 返回的那份
   模块），绝无顶层 value import（有的话，坏树时 bootstrap 还没跑就抛 `ERR_MODULE_NOT_FOUND`）。共享能力
   （门禁规则/探针/复查、envinit provisioner、prompt 文件层 `PromptFiles`；work 另取 `resolveDataHome`）
   也从这份模块上取——所以这些共享逻辑只需一次底座发布即可修，不必重建插件产物。底座 kit 另外导出
   `createPluginLogger` 与 `familyHome` 等族根路径工具，插件可在运行时取用；`typert` `strict` codec 与符号
   字面量、各插件自己的 logger 与降级 fallback 则留在插件里，改它们需要发插件。
3. **派发 `background` item 集**：`mem:pandoc` 与 `mem:model` 只声明、只派发，**不等待**；它们到达终态时经
   `onSettled` 回调。调用方继续自己的初始化。**没有 blocking item、也没有等待集**——门禁不再是 item。
4. **挂载前检查 = 兼容门禁**：底座动态加载完成后跑判定 / 探针 / 复查（细节见 [DESIGN.md §12.1](../DESIGN.md)）。

**昂贵资源永不阻塞启动**：

- 嵌入模型是后台 item（见 §1）：插件**不等**它，但把它到达终态的回调当作"继续初始化"的那一步——
  文件落盘后才 `warmSemanticAsync`，运行时读的就是底座写的那份 `semantic.cache_dir`（族根）。
  它跳过/失败时仍然预热：`semantic.auto_download` 打开则由运行时自己联网取，关闭则退回 FTS+entity。
- `mem:pandoc` 失败 / 跳过 → 落回 legacy tools 目录并 `resetPandocResolution()`，下一次解析重新探测，
  不会把一次失败的下载钉死在这个进程里。
- nodejieba 分词器的预热**不变**：它不需要 provisioning（是可选 npm 依赖），仍然藏在宿主的就绪信号后面
  （`loader.await()`，避免和宿主启动抢主线程）。

## 3. 受管根与下载闸

**两个根是不同的东西，别混**：

- **族根 / 受管根（family root）** = `$AVANTF_HOME`（若已设置），否则 `~/.avantf/env`。**受管资源**在它
  下面：`<root>/tools`、`<root>/models`（以及控制面 `<root>/.envinit`）。
- **数据根（data root）** = ⑤ 显式实参 → ④ `$AVANTF_HOME` → ② `configs/common.yaml` 里的 `dataHome` → `~/.avantf`。注意两层的区别：插件 profile 里写的 `dataHome` 是**调用方给的显式实参**（⑤，因此压过环境变量，见 INSTALL），而 `configs/common.yaml` 里那条是配置层（②，被环境变量压过）。
  **用户数据与可编辑文本**在它下面：`memory/`、`knowledge/`、`configs/*.yaml`、`prompts/*.md`。

```
<home>/tools/…        # 二进制归档；pandoc → <home>/tools/pandoc/3.11/bin/pandoc
<home>/models/…       # 模型缓存：框架以 flat 布局写 <org>/<name>/<file>，运行时按同一形状读
<home>/models/.envinit/…  # flat 模型的侧车（revision 记录 + 内容寻址 blob），运行时不读
<home>/.envinit/…     # 框架控制面（锁 / 状态 / 临时 / 隔离）
```

> **已死的目录**：兼容门禁不再有 item，所以旧布局留下的 compat 受管根（`<home>/compat/**`，含
> `<home>/runtime/**` 这类为旧 `mem:compat` 准备的 npm 根）与更早的私有根 `<dataHome>/dsh-compat/**`
> **都不再被任何代码读写**，可以手工删除。删它们不影响任何东西。

底座装载成功后，`tools.dir` / `semantic.cache_dir` / `rerank.cache_dir` 的**内建默认层**
（`RuntimeOptions.managedRoots` → `LoadConfigOptions.managedRoots`）指向族根：

- `tools.dir` = `<home>/tools`
- `semantic.cache_dir` / `rerank.cache_dir` = `<home>/models`

**优先级**：`tools.dir` 仍是普通配置，`config.yaml` 与环境逃生口（`AVANTF_TOOLS_DIR`、
`AVANTF_PANDOC`）照旧覆盖。**模型的落点与镜像不一样**：它们是受管项，`config.yaml` 里的
`semantic.cache_dir` / `semantic.mirror`（以及 rerank 的同名键）会被忽略并告警，只剩环境逃生口
`AVANTF_MEM_MODEL_CACHE` / `AVANTF_MEM_MODEL_MIRROR`（或 `HF_ENDPOINT`）。这两个变量由**环境层④**
写进 `semantic.cache_dir` / `semantic.mirror`（rerank 同名键一起写），所以 `rt.config` 就是真相：
镜像会到 `mem:model` 的 `spec.endpoint`，缓存覆盖则让 `mem:model` 不再声明（见 §1）。

**下载总闸（两个开关，任一为 `0` 即关闭下载）**：

- `AVANTF_ENVINIT_AUTO_DOWNLOAD=0` —— 家族级开关，一次关掉全家插件的 provisioning，**并且**经环境层
  把 `semantic.auto_download` / `rerank.auto_download` 置 false，运行时自己的下载路径也一起停；
- `AVANTF_MEM_AUTO_DOWNLOAD=0` —— 本项目的开关（CLI / MCP / 测试都认它）。

## 4. `@avantf/mem-provision` 还留什么

底座接管的是**插件（DSH 宿主）**的预装。`@avantf/mem-provision` 保留：

- **pandoc 的 URL / sha256 清单** `PANDOC_PACKS`（连同 `PANDOC_ARTIFACT_ID` / `PANDOC_VERSION` /
  `PANDOC_BINARY`）——单一真源，底座的 item 从这里重写。
- **legacy artifact sweep** `provisionToolchainAsync`（`packages/core/src/modelBootstrap.ts`）与
  `ensurePandoc` 的"用到那一刻再确认一次"，只服务**降级路径**。
- **CLI 与 MCP server 永远走 legacy 路径**：它们没有 DSH 宿主，也就没有底座。
- LibreOffice 的"只探测、不安装"照旧。

已删除：`packages/provision/src/compat.ts` 的 `ensureCompatBase` 与 `COMPAT_DIR_NAME`、通用层
`packages/provision/src/runtimeDeps.ts`，以及它们的测试。**兼容门禁不再是 item**（门禁就是底座本身），
所以为它准备的 npm 下载 / integrity 校验与受管 compat 根（`<home>/compat/**`）也一并消失；更早的私有
npm 根 `<dataHome>/dsh-compat/**` 同样**不再被读写**。

## 5. 降级路径（有意保留）

底座**整体**装载失败时：插件打一条 `envinit: WARNING …`，然后**照常挂载完整插件**，退回迁移前的机制——
`provisionToolchainAsync` 在 legacy 默认目录 `~/.avantf/tools` 与 `~/.avantf/models` 上做 artifact sweep。
此时引擎不会拿到 `managedRoots`，`tools.dir` / `cache_dir` 回到内建默认。降级是**按能力**的：prompt 文件层
缺失就用插件自带的默认提示词正文（默认值本来就在插件里），兼容门禁缺失就走 `compat:` WARNING 路径并跳过
（判定语义不变：只有被证明的不兼容才拒载），pandoc / 嵌入模型 item 缺失就走 legacy 目录。client 半 / 工具 /
service / prompt / Remote 面都正常注册——"拿不到底座"不是"不兼容"，绝不因此拒载，也绝不抛错。

## 6. 迁移已有机器到新根

**先确认新环境工作，再删旧目录。** 为避免重新下载，先**搬**再删：

```bash
mkdir -p ~/.avantf/env/tools ~/.avantf/env/models

# 1) 搬 pandoc：框架读得懂 legacy 的 install.json 形状（别名表 id→name、sha256→integrity、
#    url→tarball、binary = 可执行文件名），所以旧副本会被认领而不是重下。
mv ~/.avantf/tools/pandoc ~/.avantf/env/tools/

# 2) 搬模型缓存（transformers.js 的 <org>/<name>/<file> 形状；不是 hub 的 models--*）
mv ~/.avantf/models/* ~/.avantf/env/models/

# 3) 已死的旧目录：旧私有底座目录 + 旧 compat 受管根，都不再被读写，直接删
rm -rf ~/.avantf/dsh-compat ~/.avantf/env/compat
```

搬完重启 `dsh web`，看日志里 pandoc 一行 `envinit: mem:pandoc present/installed`、检索 / 文档转换都
正常，再处理旧目录。**若还在用 CLI / MCP（它们没有 DSH 宿主，仍解析 legacy 默认根）**，建议把旧目录
换成指向族根的符号链接而不是直接删——一份数据、两条路都通（本机就是这么做的）：

```bash
rm -rf ~/.avantf/tools ~/.avantf/models
ln -s env/tools  ~/.avantf/tools
ln -s env/models ~/.avantf/models
```

**用了 `AVANTF_HOME` 时三个基准各不相同，别照抄路径**：① **族根**跟随它（`resolveHome()`）——
搬迁目标是 `$AVANTF_HOME/tools`、`$AVANTF_HOME/models`；② 族根 `~/.avantf/env/tools` /
`~/.avantf/models` **不跟随**（`resolveToolsDir` 与 `expandHome` 只认 `homedir()`，要改得设
`AVANTF_TOOLS_DIR` / `AVANTF_MEM_MODEL_CACHE`）；③ 旧私有根 `<dataHome>/dsh-compat` 跟随的是**数据家**
——`AVANTF_HOME` 会改它，所以第 3 步要删的是 `$AVANTF_HOME/dsh-compat`（旧 compat 受管根则跟随**族根**，
即 `$AVANTF_HOME/compat`，同样可以直接删）。

## 7. 历史

本文档原先是阶段 1 的**提案**：在 `@avantf/mem-provision` 内自建一个通用 npm-provider
（`runtimeDeps.ts`）加一层 mem 策略（`compat.ts` 的 `ensureCompatBase`），并计划抽成暂名
`@avantf/dsh-boot` 的共享包。那条路线**没有继续**——同一时期家族把"插件启动期环境初始化"做成了
独立框架 `@avantf/dsh-envinit`（三层架构 + 可插拔 provider + 发布锁；该框架后来与兼容门禁
`@avantf/dsh-compat` 一起并入家族底座 `@avantf/dsh-plugin-base`，两个旧包不再发新版本），本插件改为接入它，
阶段 1 的 `runtimeDeps.ts` / `compat.ts` 及其测试随之删除。§1 的 item 表就是当年那张"三层架构"
清单的落地形态。

## 8. 代码索引

- 插件接线与 item 清单：`packages/plugin/src/envinit.ts`（`mem:pandoc` / `mem:model`；
  **没有 `mem:compat`**）、`packages/plugin/src/provision.ts`（门禁 spec 与底座的动态加载）。
- 内联 bootstrap：`packages/plugin/src/envinit-bootstrap.{js,d.ts}`（由
  `scripts/link-envinit.mjs` 从**安装的**底座 vendoring；`scripts/copy-envinit-bootstrap.mjs` 在
  `tsc` 与 `tsdown` 之间把它放进 `lib/types/`；`scripts/assert-envinit-artifacts.mjs` 断言它真的内联、
  底座没被按 specifier 引入、client 产物干净；`scripts/pack-plugin.mjs` 对 tarball 再断言一次）。
- legacy 路径：`packages/core/src/modelBootstrap.ts`（`provisionToolchainAsync` /
  `warmSemantic` / `warmTokenizer` 及其 `*Async` 版本）、`packages/provision/src/`（artifact registry、
  `tools.ts`、`fetch.ts`、`platform.ts`、`zip.ts`、`artifacts/{pandoc,libreoffice}.ts`、`PANDOC_PACKS`）。
- 底座：`@avantf/dsh-plugin-base` 的 `docs/DESIGN.md` 与 `README.md`（本仓不复制机制细节）。
- 相关设计：`DESIGN.md` §12.1（兼容门禁与启动接线）、`docs/DSH_INTEGRATION.md`（宿主集成）、
  `docs/INSTALL.md`（用户侧安装、受管根与排错）。
