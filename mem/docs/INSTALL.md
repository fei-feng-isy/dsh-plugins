# 安装到 DeepSeek Harness（DSH）

面向「在另一台机器 / 另一个 DSH 实例上，从本仓库安装 `@avantf/dsh-mem`」的可复制步骤。
本文是操作手册；**为什么**要这些步骤见文末[第 9 节](#9-背景为什么需要这些非常规接线) 与 [DSH_INTEGRATION.md](DSH_INTEGRATION.md)。

---

## 0. 约定

| 记号 | 含义 | 本机实际值（示例） |
|---|---|---|
| `<AVANTF>` | 本仓库根目录 | `/path/to/avantf-mem` |
| `<HARNESS>` | DeepSeek Harness 源码 checkout | 自动发现（见 2.2）；必要时用 `DSHHARNESS` 指定 |
| `<PROFILE>` | 要装入的 DSH profile 名 | `web` |
| `~/.dsh` | `DSH_HOME`（profile / 会话 / 设置） | — |
| `~/.avantf` | 插件数据目录（记忆库 + 知识库（含 `knowledge/docs` 受管文档）） | — |
| `~/.avantf/env` | 家族底座 `@avantf/dsh-plugin-base` 的**受管族根**（`tools` / `models`）；设了 `AVANTF_HOME` 时族根就是 `$AVANTF_HOME`（注意：它与**数据根**是两个不同的根，只是都以 `AVANTF_HOME` 为兜底） | — |

命令中出现的 `<AVANTF>` / `<HARNESS>` 请替换成真实绝对路径。

---

## 1. 前置条件

- **Node ≥ 22**（`node -v`）
- **pnpm**（`pnpm -v`；插件构建用 `tsdown`，已作为 devDependency 固定为 `0.22.2`）
- **一个可用的 DSH checkout**，且已构建过（能正常 `pnpm dsh web` 打开 GUI）
- 本仓库已 clone 到本地

> 插件构建会读取 harness 内部的包与 `clientBundle` 预设，所以 **必须能访问 DSH 源码 checkout**，不能只用一个已打包的 `dsh` 二进制。

---

## 2. 构建

```bash
cd <AVANTF>

# 2.1 引擎包（contract / retrieval-core / core / convert / provision / cli / mcp）
pnpm install
pnpm build

# 2.2 DSH 插件（含客户端 bundle）
pnpm build:dsh
```

> `DSHHARNESS` **不再需要**：`pnpm build:dsh` 只对着**已安装的全局 dsh**（`npm i -g @deepseek-ai/dsh`）
> 编译、类型检查与挂载，client preset 是仓库自带的 pin 住的副本。harness checkout 只在本地恰好有它时，
> 被可选的自带 preset 漂移核对（`node scripts/check-preset-drift.mjs`）用到，不参与编译。

`pnpm build:dsh` 做了三件事：

1. `scripts/link-dsh.mjs` 把**已安装的全局 dsh** 里的
   `@deepseek-ai/{cordis,schemastery,dsh-tools,dsh-system-prompt,dsh-typert-protocol,dsh-typert-registry,dsh-util-values}`
   软链进 `packages/plugin/node_modules/`（这些包未全部发布到 npm；`dsh-system-prompt` 只用于
   `Context.systemPrompt` 的**类型**增强——插件用它注册唯一的"记忆用法"段落，运行时的服务由宿主提供）；

   > **链的是哪份 dsh，就跑哪份 dsh。** 邻居包只有一个来源：**已安装的全局 dsh**（`npm root -g`）。
   > 插件与宿主必须是**同一份拷贝**——`ctx.typert.register()`
   > 注册的表、工具注册表都靠对象身份，两份拷贝会在运行时对不上（同一类问题本仓库已踩过一次：
   > zod 曾在插件进程里同时存在 v3 与 v4 两个身份，见 DESIGN §20.11）。
   > 所以运行 `dsh web` 的必须是同一个全局 dsh。
2. 在自带 preset 根 `packages/plugin/vendor/dsh-client-preset/packages/client/avantf-dsh-mem/`
   放一个 **manifest stub**（软链到插件的 `package.json`）——`clientBundle` 预设用
   `packages/*/*/package.json` 的 glob 定位包元数据，而 glob **不跟随软链目录**；
3. `tsc`（类型检查 + 产出 `lib/types/`）→ `tsdown`（产出 node 面与浏览器面）。

> **家族底座的接线也在这个脚本里**（`scripts/build-plugin.mjs`）：编译**前**跑
> `scripts/link-envinit.mjs`——从 `packages/plugin/node_modules/@avantf/dsh-plugin-base`（`pnpm install` 从
> registry 装上的底座，底座同时是 peer 与 devDependency；**一个包**里装着环境初始化框架、启动兼容门禁与
> 两个插件共享的 kit）取零依赖的
> `dist/bootstrap.js`/`dist/bootstrap.d.ts`，vendor 成 `packages/plugin/src/envinit-bootstrap.{js,d.ts}`
> （`--check` 只核对安装与 vendor 的内容，不改任何东西）；要就地改底座，用 `DSH_ENVINIT=<checkout>` 显式指定——
> 该 checkout 会被链进插件树并作为 vendor 来源（不再有隐式的兄弟 checkout 发现）。
> `packages/plugin` 的 `build` 脚本在 `tsc` 与
> `tsdown` 之间用 `scripts/copy-envinit-bootstrap.mjs` 把它放进 `lib/types/`，这样 tsdown 才会真正内联；
> 编译**后**跑 `scripts/assert-envinit-artifacts.mjs` 断言 bootstrap 已内联、`@avantf/dsh-plugin-base`
> 没有按 specifier 被引入、`lib/client.js` 干净。

**产物形态（不要改变）**

| 文件 | 内容 |
|---|---|
| `packages/plugin/lib/index.js` | node 面（ESM），DSH 加载的插件入口 |
| `packages/plugin/lib/client.js` | 浏览器面，**必须是** `window.__ModuleLoader__.load({id, factory})` 工厂 |
| `packages/plugin/lib/types/**` | `tsc` 的 JS + `.d.ts`（`tsdown` 从这里再打包） |

> ⚠️ **不要用纯 `tsc` 产出 client 面**。DSH 会把 `exports["./client"]` 指向的文件**原样字节**拼进浏览器 combo 脚本，
> 纯 ESM（`import ... from 'react'`）在那里无法执行。

**构建自检**

```bash
node scripts/mount-smoke.mjs
# harness 自动发现；不在候选位置时用 DSHHARNESS=<HARNESS> 覆盖
# 期望：MOUNT SMOKE OK — … 且列出 8 个工具、avantfMemory、avantfMem remote、typert host face
```

---

## 3. 让 profile 能解析到插件与它的 peer 底座

从 registry 安装（发布形态）——底座是插件的 **peer**，pnpm 关掉了 `autoInstallPeers`，所以要显式一起装：

```bash
cd ~/.dsh/profiles/<PROFILE>
pnpm add @avantf/dsh-plugin-base @avantf/dsh-mem
```

从源码 checkout 开发时，只 link 插件就够：软链的插件从**它自己的依赖树**解析底座（`pnpm install` 已按插件
的 `devDependencies` 把它装在那里），而引擎包（`@avantf/mem` / `@avantf/mem-contract` / `@avantf/mem-retrieval` …）
在构建时已经内联进 `lib/index.js`，**不需要**再装：

```bash
cd ~/.dsh/profiles/<PROFILE>
pnpm add <AVANTF>/packages/plugin
```

---

## 4. 挂载插件

编辑 `~/.dsh/profiles/<PROFILE>/cordis.patch.yml`（不存在就新建）：

```yaml
- insert:
    - id: avantf-mem
      name: '@avantf/dsh-mem'
      config:
        mode: cordis          # 进程内插件仅支持 cordis；MCP 独立运行 @avantf/mem-mcp
        # dataHome 建议省略（默认 ~/.avantf）。它是配置值（第 ② 层），
        # 会被 AVANTF_HOME（第 ④ 层）压过：想用 profile 定住数据目录，就别设 AVANTF_HOME。
```

> 数据目录优先级（DESIGN §3）：这里的 `dataHome`（②，配置值）< `AVANTF_HOME`（④）< CLI 的
> `--data-home`（⑤）。`~/.avantf/configs/common.yaml` 里那条 `dataHome` **不参与** —— 那个文件就在
> 数据根里面，解析根时还没读到它。公共/分库配置放 `~/.avantf/configs/common.yaml` 与
> `~/.avantf/configs/{memory,knowledge}.yaml`。

> 该 profile 需要 `patchReload`（`web`/`headless` 等模板默认 `live`）。
> 临时试装可以不改 profile：`dsh web --patch <overlay.yml>`，overlay 内容同上。

---

## 5. 语义检索配置（默认已启用 ONNX 模型）

新建 `~/.avantf/configs/common.yaml`：

```yaml
semantic:
  backend: local_bge
  local_model: Xenova/bge-base-zh-v1.5   # ⚠️ 必须是 ONNX 仓库（默认值已是它）
  dim: 768
  auto_download: true
```

> 默认仓库 `Xenova/bge-base-zh-v1.5` 是 768 维 fp32 ONNX：**首次下载约 389 MB、首次冷启（下载 + 加载）约
> 16.6 s**；权重落到族根后即**离线可用**（本机二次从缓存加载实测约 0.9 s）。一行 `semantic.local_model`
> 换成别的仓库时，`semantic.dim` 必须同步改（向量库按它建，不一致会在以后表现为乱码分数），并 `reindex`。
>
> 语义路径拿不到时检索**自动降级为 FTS + 实体 Jaccard**，功能仍可用（只是没有语义召回），绝不拒载。

> `semantic.cache_dir` / `semantic.mirror`（以及 `rerank` 的同名键）在 `config.yaml` 里**已不再生效**：
> 框架接管了模型的落点与来源，这两个键会被忽略并打一条告警。落点固定是框架族根
> `<home>/models`（默认 `~/.avantf/env/models`）；镜像用运维环境变量
> `AVANTF_MEM_MODEL_MIRROR`（或 `HF_ENDPOINT`）覆盖，缓存目录用 `AVANTF_MEM_MODEL_CACHE` 覆盖。
>
> 默认配置即 ONNX 仓库，**不写 `~/.avantf/configs/common.yaml` 也能获得语义检索**：框架的 `mem:model` item 以
> **`flat` 布局**把文件装到 `<home>/models/<repo>/<file>`（正是 `@huggingface/transformers` 读的形状），
> 运行时的后端构造预热在框架接管模型根时被**延迟**，只从该 item 到达终态的回调开始，所以复用这一份、
> **不二次下载**。默认仓库只声明运行时真正会取的四个文件（`config.json` / `tokenizer.json` /
> `tokenizer_config.json` / `onnx/model.onnx`）；`semantic.local_model` 换成别的仓库时不再写死清单，
> 由框架按仓库自身的文件清单装。
> 离线/测试环境可设 `AVANTF_ENVINIT_AUTO_DOWNLOAD=0`（家族级，一次关掉全家插件的预装，运行时的自有
> 下载路径也一起停）或 `AVANTF_MEM_AUTO_DOWNLOAD=0`（本项目）禁用下载（检索优雅降级为 FTS+实体）；
> `semantic.auto_download: false` 时 item 仍会声明，但框架判为 `skipped (policy/download-disabled)`、
> 零网络，磁盘上已有的缓存仍会加载。
> 用 `AVANTF_MEM_MODEL_CACHE` 把缓存目录指到族根以外时，运行时读那个目录，`mem:model` **不再声明**
> （否则框架会在族根再装一份没人读的副本）。

- `BAAI/bge-base-zh-v1.5` 是 **PyTorch** 仓库，transformers.js 找不到 `onnx/model.onnx`，
  会**优雅降级**为 FTS + 实体检索（功能可用，只是没有语义召回）。
- 启动日志会直接打印降级原因，便于确认。
- 优先级：环境变量 `AVANTF_MEM_MODEL_MIRROR` / `HF_ENDPOINT` > 默认镜像；环境层④ 把它写进
  `semantic.mirror` / `rerank.mirror`，因而同时喂给 `mem:model` 的 `spec.endpoint` 与适配器（`config.yaml`
  不再参与）。

---

## 5.1 外部工具与受管目录（pandoc）

文档转换（`.docx`/`.odt`/`.epub`/`.html`/`.tex`/`.rst`/`.csv`… → Markdown）走 **pandoc**：
由家族底座 `@avantf/dsh-plugin-base`（内含环境初始化框架）在启动时作为 `mem:pandoc` **后台派发**（不阻塞挂载），摄入路径在用到
的那一刻再确认一次。同一份 `~/.avantf/configs/common.yaml` 里的一组 `tools` 键控制它：

```yaml
tools:
  dir: ~/.avantf/env/tools    # 受管安装根目录；省略 = 框架族根 <home>/tools（默认 ~/.avantf/env/tools）；
                              # AVANTF_TOOLS_DIR 可覆盖；无框架的 CLI/MCP 与降级路径用 legacy ~/.avantf/tools
  mirror:                     # 镜像模板，按顺序尝试，官方源始终最后兜底
    - https://ghfast.top/{url}
    - https://ghproxy.net/{url}
    - https://gh-proxy.com/{url}
  auto_install: true          # false = 只用本机已有的（受管目录 / PATH），不下载
```

**受管目录布局**（版本化，可并存/回滚；族根 `home` = `$AVANTF_HOME`，否则 `~/.avantf/env`）：

```
~/.avantf/env/tools/pandoc/3.11/      # 插件默认
├─ bin/pandoc          # 解压出的可执行文件（Linux 静态链接、macOS/Windows zip 里的那份）
└─ install.json        # 记录版本 / 来源 URL / sha256 / 安装时间

~/.avantf/tools/pandoc/3.11/          # legacy：CLI/MCP 与"框架装载失败"的降级路径
```

**探测优先级**（固定，缺了就明确报错，不静默降级）：

1. `AVANTF_PANDOC`（或配置里的显式路径）；
2. 受管目录 `<tools.dir>/pandoc/<钉死版本>/bin/pandoc`（插件默认 `<home>/tools`，即 `~/.avantf/env/tools`；不再有 legacy 目录）；
3. `PATH` 上的系统安装（Windows 按 `PATHEXT` 探测 `pandoc.exe` 等）；
4. 都没有 → 报错并给出三平台安装命令。

版本**钉死在代码里**（当前 `3.11`）：不同 pandoc 渲染不同，所以 `converter` 字段带版本（`pandoc-3.11`），
跨机器的语料差异因此可见；发现的是别的版本会被明确拒绝，`AVANTF_PANDOC` 是唯一的例外通道。

**三平台手动安装**（自动安装不可用时；VERSION 换成你要的版本）：

```bash
# Linux：官方静态链接 tarball（不挑系统库，适合放进受管目录）
curl -L -o /tmp/pandoc.tar.gz https://github.com/jgm/pandoc/releases/download/3.11/pandoc-3.11-linux-amd64.tar.gz
mkdir -p ~/.avantf/env/tools/pandoc/3.11/bin
tar xzf /tmp/pandoc.tar.gz -C /tmp && cp /tmp/pandoc-3.11/bin/pandoc ~/.avantf/env/tools/pandoc/3.11/bin/pandoc
# 或者系统包管理器：sudo apt install pandoc（仓库版本通常较旧）
# 无框架的 CLI/MCP：把上面的 ~/.avantf/env 换成 ~/.avantf（legacy 目录）

# macOS
brew install pandoc
# 或官方 zip：https://github.com/jgm/pandoc/releases 的 pandoc-<版本>-<arch>-macOS.zip

# Windows（PowerShell）
winget install --source winget JohnMacFarlane.Pandoc
# 或官方 zip：https://github.com/jgm/pandoc/releases 的 pandoc-<版本>-windows-x86_64.zip
```

> 手工放进受管目录也可以（`<bin/pandoc>` 可执行即可，`install.json` 只是来源记录）。
> `AVANTF_ENVINIT_AUTO_DOWNLOAD=0`（家族级）或 `AVANTF_MEM_AUTO_DOWNLOAD=0`（本项目）会禁用预装下载
> （模型与工具），适合离线机器。
> **镜像状态（本机实测 2026-09-17）**：三个国内代理域名都不可达（DNS 不解析或 TLS 链被替换），
> 官方源可用（约 8 秒 / 35 MB）。失败时日志会列出**每一个**试过的源与原因（URL + HTTP 状态码/
> 校验不符），不会只说"安装失败"。

### 5.1.1 从旧目录迁移到族根（一次性）

框架接管之前，pandoc 与模型落在 `~/.avantf/{tools,models}`；现在是族根 `~/.avantf/env/{tools,models}`，
而**引擎的内建默认直接指向族根**（CLI、MCP、"框架装载失败"的降级路径与测试都解析同一个目录）。
`~/.avantf/{tools,models}` 不再是任何回退，所以**不要给它建兼容软链**——那条软链会让
`mkdir -p`（末段是软链且目标不存在时）抛 `ENOTDIR`，还会把"这台机器恰好建过链"变成隐式前提。

有旧副本就搬过去，然后删掉旧目录（避免两份几百 MB）：

```bash
mkdir -p ~/.avantf/env/tools ~/.avantf/env/models

# 1) 搬 pandoc：框架读得懂旧副本的 install.json（别名表 id→name、sha256→integrity、url→tarball、
#    binary = 可执行文件名），旧副本会被直接认领而不是重下。
mv ~/.avantf/tools/pandoc ~/.avantf/env/tools/

# 2) 搬模型缓存（transformers.js 的 <org>/<name>/<file> 形状；不是 `models--*`）
mv ~/.avantf/models/* ~/.avantf/env/models/

# 3) 删掉旧目录（若存在），以及已死的旧 compat 目录（`dsh-compat` 与 `env/compat` 都不再被任何代码读写）
rm -rf ~/.avantf/tools ~/.avantf/models ~/.avantf/dsh-compat ~/.avantf/env/compat
```

搬完重启 `dsh web`：日志里 pandoc 一行 `envinit: mem:pandoc present/installed`、检索与文档转换都正常即可。
用了 `AVANTF_HOME` 时族根就是它本身（数据与受管资源同树）。

**旧版 `.doc/.xls/.ppt`（OLE）**：只有 LibreOffice 能读，本项目**只探测、不自动安装**（数百 MB）。
装了 `soffice` 会被探测到并在错误信息里提示；没装就按名拒绝。

---

## 6. 重启并验证

**必须整进程重启**：

```bash
# 在运行 dsh web 的终端按 Ctrl-C，然后
cd <HARNESS> && pnpm dsh web
```

> DSH 的 `patchReload: live` 只重放**配置**，不会重新 `import` 模块；Node 的模块缓存意味着改代码/换
> `node_modules` 后不重启就不会生效。

**期望在 stderr 看到**（插件日志走 stderr，见第 8 节）：

```
[avantf-mem] INFO plugin mount: mode=cordis dataHome=...
[avantf-mem] INFO runtime init: dataHome=... memory.db=... knowledge.db=... semantic=local_bge/...
[avantf-mem] INFO runtime ready in ...ms (embeddings warm asynchronously)
[avantf-mem] INFO envinit: mem:pandoc installed (… 3.11)          # 家族框架后台派发；已存在=present，失败=skipped/failed
[avantf-mem] INFO envinit: mem:model installed (installed <sha>) # flat 模型：<home>/models/<repo>/<file>
[avantf-mem] INFO model bootstrap: warm start — model=... mirror=... cache=...
[avantf-mem] INFO semantic: embedding model ready ... (dim=768, ...ms)
[avantf-mem] INFO tool registered: mem_remember / mem_recall / mem_admin / kb_add / kb_list / kb_remove / kb_reindex / kb_query
[avantf-mem] INFO remote registered: avantfMem (client ctx.remote.avantfMem.*)
[avantf-mem] INFO typert registered: avantfMem host face (5 invocations)
[avantf-mem] INFO plugin ready: 8 tools + avantfMemory service + avantfMem remote
```

> 每个预装项一行、前缀 `envinit:`，`action` 取值 `present / installed / skipped / failed`；失败还会打一条
> `envinit: <id> is failed (…)`，`mem:pandoc` 失败时接着落回 legacy tools 目录并重置解析缓存。
> **`mem:model` 是预装项**：框架以 `flat` 布局把它装到 `<home>/models/<repo>/<file>`，成功时打印
> `envinit: mem:model installed|present (…)`，预热在该行之后才开始（框架接管模型根时，后端构造期的预热
> 已被延迟，不会和框架抢同一份文件）；`skipped (policy/download-disabled)`/失败时仍会预热，由
> `semantic.auto_download` 决定运行时自己联网取还是退回 FTS+entity（表现为一条
> `semantic: embedding model unavailable …`）。设了 `AVANTF_MEM_MODEL_CACHE` 时不出现该行——运行时读
> 那个目录，插件不声明 item。
> 兼容门禁**不是 item**：门禁就是底座本身，由内联 bootstrap 在启动时动态装载；只有拿不到底座时才打 `envinit: WARNING`。
> 只有在**框架装载失败**、退回旧机制时，才会看到旧的 `provision[...]` 行与 `~/.avantf/tools` 路径。

**三步验收**

1. 会话里让 agent 记住一条事实 → 工具 `mem_remember` 被调用；
2. 新会话里召回 → `mem_recall` / `kb_query` 命中；
3. 会话视图标签条里出现 **记忆** 与 **知识** 两个标签页（排在 对话 / 轨迹 之后）；
   浏览器控制台应出现 `[avantf-mem] client apply: avantfMem remote mounted`。
4. 「知识」页入库一篇文档后，`~/.avantf/knowledge/docs/<domain>/<source>/<title>.md` 出现同名文件；
   点该行的 **编辑** 能在你的编辑器里打开它，改完保存后点 **重新摄入**，徽标消失、检索到新内容。
5. 用 `--uri` 摄入一个 **PDF**：返回的 `chunks` 不为 0，且检索 PDF 里某句话能命中（说明抽的是文本层而不是 `%PDF-` 语法）。
6. 用 `--uri` 摄入一个 **`.docx` / `.csv`**：返回值里带版本化的 `converter`（如 `pandoc-3.11`），且检索文档里的标题或单元格内容能命中。

---

## 7. 升级 / 卸载

**升级**

```bash
cd <AVANTF> && git pull
pnpm install && pnpm build
pnpm build:dsh          # harness 自动发现；必要时 DSHHARNESS=<HARNESS> 覆盖
# 然后重启 dsh web
```

**卸载**

1. 删除 `~/.dsh/profiles/<PROFILE>/cordis.patch.yml` 里的 `avantf-mem` insert 行；
2. （可选）`cd ~/.dsh/profiles/<PROFILE> && pnpm remove @avantf/dsh-mem @avantf/mem @avantf/mem-retrieval @avantf/mem-contract`；
3. 数据仍在 `~/.avantf/`，需要时手动删除。

---

## 7.1 放宽摄入/选择器的目录范围

默认（`knowledge.ingest.local_roots` 为空）只允许**进程 cwd**：GUI 场景下那是 **DSH profile 目录**
（`dsh web` 从那里启动），所以默认等于"只能摄入 profile 里的文件"。按需在
`~/.avantf/configs/knowledge.yaml` 里放宽（**改完需要重启 dsh**，配置在启动时读一次）：

```yaml
ingest:
  local_roots:        # 多个根；选择器与摄入共用，选择器从第一条开始
    - ~
    - ~/opensource
  # 或者整盘放开（选择器从家目录起步，摄入不再拦）：
  # allow_outside_workspace: true
```

**代价**：摄入的内容会进索引、并能被 `kb_query` 检索回来，所以这条边界防的是"被一段恶意文档操纵的
agent 把任意可读文件拉进语料库"。放开后 `~/.ssh/id_rsa`、浏览器 cookie 这类文件同样在范围内。

---

## 7.2 Windows / macOS

插件本身是**平台中立**的：路径全部走 `node:path`（没有手拼 `/`）、客户端半跑在浏览器里、PDF 抽取与
编码识别（BOM / UTF-8 / GB18030）都是纯 JS。仍需知道的几件事：

| 能力 | Windows | macOS |
|---|---|---|
| 「选择」目录选择器 | ✅ 与 Linux 同一实现（宿主按摄入边界列举目录）；`C:\` 的上级停在自己 | ✅ 同左 |
| 「编辑」/「打开目录」 | `cmd /c start ""` 交给系统默认程序；PATH 上的 `code`/`cursor` 会按 `PATHEXT`（`code.cmd`/`.exe`）探测 | `open` 交给默认程序；PATH 上的 `code`/`cursor` 直接可用 |
| 摄入：文本 / PDF / pandoc 能读的文档格式 / xlsx / 编码识别 | ✅ 除 pandoc（受管外部二进制，启动时预装）外均为纯 JS（`unpdf` 自带 pdfjs，`exceljs` 纯 JS） | ✅ |
| 存储层 | ✅ 无需任何原生模块：用运行时自带的 `node:sqlite`（Electron 44 与 Node ≥ 22.13/23.4 都带） | ✅ 同左 |
| 可选 `@huggingface/transformers`（语义检索） | ✅ 安装时按平台下载 `onnxruntime-node` 二进制 | ✅ |
| 可选 `nodejieba`（中文分词） | ⚠️ `node-pre-gyp` 预编译 + 回退编译；编不出来就退化为正则抽取 | ⚠️ 同左 |
| 可选 `hnswlib-node`（HNSW 向量库） | ⚠️ **没有预编译，必须本地 C++ 工具链**；编不出来就退化为 numpy 向量库 | ⚠️ 同左 |

- **包装脚本会被拦**：pnpm 10 / npm 默认阻止依赖的 install 脚本。放行方式见 profile 的
  `pnpm-workspace.yaml` 里的 `allowBuilds:`（本仓的 profile 把它列成 `true`）；不放行时原生模块不会编译，
  插件仍能启动，但会退化为 FTS + 实体检索（`mem_admin stats` 与日志会说明）。
- **模型下载**：首次使用本地嵌入模型时需要能访问模型源（默认 `hf-mirror.com`，可用
  `AVANTF_MEM_MODEL_MIRROR`/`HF_ENDPOINT` 改）；拿不到就退化为 FTS + 实体检索。
- **长路径（Windows）**：受管副本是 `<data_home>/knowledge/docs/<domain>/<source>/<title>.md`，每段截到 80 字符，
  但整串仍可能超过传统的 260 字符上限 —— 把 `data_home` 放在短路径下，或启用 Windows 长路径支持。
- **仓库里的开发脚本**（`pnpm cleanup:dsh` 等）是 bash，Windows 上需要 WSL 或 git-bash；
  这些脚本不进发布包。
- **实测边界**：以上平台分支在 WSL/Linux 上验证，纯逻辑部分（路径形状、命令名、保留字清洗）有单测钉住；
  Windows/macOS 的**真机**未跑过。

---

## 7.3 知识域清单（`knowledge.domains`）

文档的 `domain` 是**受控取值**：同一份资料随手写成两个领域名，检索与浏览就会各看到一半。默认给出一小组
通用领域，清单之外的**新**领域会被写入侧拒绝（错误里列出全部允许值），agent 工具 / CLI / MCP / 界面走
的是同一条闸门；把新领域加进清单就是一次配置改动：

```yaml
# ~/.avantf/configs/knowledge.yaml
domains:              # 允许的领域；库中已有的领域始终仍然可用
  - design
  - api
  - ops
  - research
  - notes
# domains: []         # 显式空数组 = 不限制（任何领域都接受）
```

- 清单**非空**时，「知识」页的 domain 控件是**下拉**（选项 = 清单 ∪ 库里已有领域），不提供自由输入；
  清单**为空数组**（不限制）时退回自由输入。
- **在界面上新增领域，不用手改配置**：「知识」页的**入库表单**里，domain 标签那一行的**右侧**有一个
  **「+ 新增领域」**按钮（与下拉框右对齐；查询面板的 domain 过滤没有这个按钮）。点开输入名字、确认后：
  - 名字写回本文件（`~/.avantf/configs/knowledge.yaml`）的顶层 `domains` 列表，**文件里的注释原样保留**；
    `domains` 键不存在时会创建；
  - 该领域**立即生效**——store 的允许集合是内存里的，新增时同步加入，**不必重启 `dsh`**（手改配置仍需重启）；
  - 名字 trim 后不能为空，也不能含 `/` 或 `\`（它会成为受管目录的一级目录名）；如果这个名字已经在
    下拉的选项里（清单里、库里已有、或本次刚加的），就直接选中它，**不会重复写**。
- **`domains: []` = 不限制**：此时控件退回自由输入，也**不提供「+」**——往一个"不限制"的清单里追加一项，
  会把它静默变成受限清单，所以这种配置下不需要（也不应该）用 `+`。
- 库中**已经存在**的领域（例如清单收窄之前写入的旧领域）始终可用，也会出现在下拉里。
- `source` 与领域无关，始终可留空，缺省为 `default`。
- `title` 也可留空：缺省**从正文推导**——正文里第一个 Markdown 标题（跳过围栏代码块里的 `#`），
  否则第一行（去掉行首的 `#`、`>`、列表符号等）；正文全空白时为 `untitled`。
- **界面「入库」不会静默覆盖**：如果算出的 `(domain, source, title)` 已经存在——不论来源是 URL、本地文件/目录还是粘贴文本——
  界面先弹一个确认框：摘要「将覆盖 N 篇 / 新增 M 篇」+ 命中文档的 `doc_id`/标题/受管路径（超过 8 篇截断显示，其余只报数量）。
  此刻**一条都不写**；确认后才带 `overwrite: true` 整体重跑（URL 会重新抓取、目录会重新导入），**取消则什么都不写**。
- **agent 的 `kb_add` 三种入参都只新增、不覆盖**：`text`、`source_uri`（本地文件或 URL）、`paths` 都不会替换已有文档。
  单篇命中时直接**拒绝**，错误里给出已有 `doc_id`、标题和它的受管文件绝对路径；`paths` 批量则**逐条**处理——已存在的记进
  结果的 `failed`（带同样的原因），其余照常导入，不会因为一个已存在就整体失败。要另存一篇就换一个标题；**要改一篇文档，
  请用 `kb_list` 拿到路径、用普通文件工具改那份受管 `.md`，索引会自动跟随**（不要重新入库同一篇）。
- **CLI**：`avantf-mem kb ingest --uri …` / `kb import …` 默认**不覆盖**——冲突时报错（退出码非 0），错误里带冲突清单。
  要刷新一个 URL 或重新导入一个目录，加 `--overwrite`（界面确认框是等价入口）。
- 配置在启动时读一次；用界面「+」新增的领域本次会话立即生效，手改本文件才需要重启 `dsh`。

---

## 8. 排错速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 日志里 `semantic: embedding model unavailable … Could not locate file …/onnx/model.onnx` | 配的是 PyTorch 仓库，或镜像不可达 | 改成 ONNX 仓库（如 `Xenova/bge-base-zh-v1.5`），检查 `mirror` |
| 标签条里看不到「记忆」「知识」 | `exports["./client"]` 指向的文件不存在／不是自注册 bundle；或 `dsh.client.inject` 缺客户端包边 | 确认 `lib/client.js` 存在且含 `__ModuleLoader__.load`；`dsh.client.inject` 至少含 `@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-api-remotes` |
| 页面显示「avantfMem Remote 未挂载」 | 客户端没挂载自己的 typert contribution | 客户端 apply 里 `await ctx.remote.$mount(clientContribution)`，再用 `ctx.get('remote.avantfMem')` 取（**不能**把 `remote.avantfMem` 写进插件 `inject`：boot 审计 pending 条目会整体失败） |
| 整个 web 界面崩塌／设置入口消失 | 有客户端条目 pending 或 apply 抛错 | `packages/client/web/src/boot.ts#assertEntriesActive` 会因 pending 条目整体 throw；检查控制台 `[avantf-mem]` 报错 |
| 改了代码/依赖但行为没变 | DSH live reload 不重新 import 模块 | 重启 `dsh web`（宿主半的改动必须重启；客户端半会热重载） |
| 「编辑」按钮报「没有可用的编辑器」 | 宿主探测不到编辑器 | 在 `~/.avantf/configs/knowledge.yaml` 里设 `open:
  editor: code`（或 `$EDITOR` / `$AVANTF_EDITOR`） |
| 文档行一直显示「文件已修改 · 待重新摄入」 | 受管文件被改过而索引还是旧的 | 点该行「重新摄入」，或用「同步文件」一次拉回全部 |
| 界面入库弹出「已存在同名文档：将覆盖 N 篇 / 新增 M 篇」 | 算出的身份已有文档（replace 模式绝不静默覆盖，命中的一条都不写） | 确认=覆盖并整体重跑（URL 重新抓取、目录重新导入）；取消=什么都不写。要另存一篇就换标题；要改这一篇点该行「编辑」改受管 `.md` |
| `kb_add` 报 `已存在同一篇文档（doc_id=…）` | `kb_add` 只新增：`text`/`source_uri`/`paths` 命中已有身份都被拒（批量时该条进 `failed`，其余照常导入） | 换一个标题另存；要改这一篇用 `kb_list` 拿路径后改受管 `.md` |
| 摄入报 `PDF 没有可抽取的文本层` | 扫描件/图片型 PDF 没有文本层 | 先做 OCR 转成文本再入库（本项目不做 OCR） |
| 摄入报 `不支持的二进制文件（PNG 图片）` 之类 | 图片 / pptx / epub / 旧版 `.doc/.xls/.ppt`（OLE）等不是可转换的正文 | 图片先 OCR、旧版 Office 另存为新格式（`.docx`/`.xlsx`）再入库；目录导入会把这些记进 `skipped` 而不是静默丢弃 |
| 摄入报 `文档转换失败（pandoc-3.11）…` | pandoc 认领了这份文档但没能转出正文（如只有图片/公式的 docx，或 XML 损坏） | 报错里带 pandoc 的 stderr 与 `--from=` 用的 reader；先确认文档确实含可索引文本 |
| 启动日志 `envinit: mem:pandoc is failed (…)`（无框架时是 `provision[pandoc]: 失败 — …`） | 三个国内镜像与官方源都不可达（本机实测三个代理域名均不可用） | 按第 5.1 节手动安装并放进族根受管目录 `<home>/tools/pandoc/`（无框架的 CLI/MCP 为 `~/.avantf/env/tools`），或设 `AVANTF_PANDOC` 指向已有 pandoc；失败时插件落回 legacy tools 目录并重置解析缓存，日志里列出每个源的 URL 与失败原因 |
| 启动日志 `semantic: embedding model unavailable …`（`fetch failed` / `连接超时` / `local-only miss`） | 模型是框架的 `mem:model` item，以 flat 布局装在 `<home>/models/<repo>/<file>`；它 `skipped`/`failed` 时仍会预热，缺文件且 `semantic.auto_download` 允许时运行时才会自己去镜像取——`https://hf-mirror.com` 在部分网络下不可达（本机实测连接超时） | 已有缓存时这条只是"没有走网络"，检索照常；确认缓存形状是 `<home>/models/<org>/<name>/<file>`（transformers.js 的形状，**不是** `models--*`），以及启动日志里有 `envinit: mem:model installed|present`。要补齐：把 `AVANTF_MEM_MODEL_MIRROR` / `HF_ENDPOINT` 指向可达端点后重启（`config.yaml` 的 `semantic.mirror` 已不生效），或把离线副本放进 `<home>/models/<org>/<name>/`；纯本地环境设 `semantic.auto_download: false`，它就只读磁盘、不再联网。设了 `AVANTF_MEM_MODEL_CACHE` 时没有这个 item：运行时读你指定的目录，缓存不在那里且 `semantic.auto_download` 打开时由运行时自己去取 |
| 启动日志出现 `memory: schema upgraded X → Y (applied: …)` / `knowledge: schema upgraded …` | **正常**：插件打开数据库时把老库自动升到本构建的最新 schema（版本化 step，每步一个独立事务；库已最新时**不会**出现这行） | 无需处理。想确认升级了什么，看 `applied:` 里的编号与 step 名。升级是同步的：中途别杀进程，单步失败会整体回滚、下次启动重试 |
| 启动日志出现 `memory unavailable: …`（工具仍注册，但每次调用都回这条） | 数据库打不开或迁移失败：库被别的进程锁住、目录不可写、某个迁移 step 抛错，或库由**更新**的版本写过（`SchemaDowngradeError`）。插件刻意降级为不可用，而不是让整个宿主起不来 | 先看冒号后的具体错误。操作前备份数据目录：`cp -a ~/.avantf ~/.avantf.bak-$(date +%F)`。`SchemaDowngradeError`＝插件比库旧：升回原版本，或恢复升级前的备份。SQL 错误（`no such column/index` 等）＝迁移脚本与库形状不符：带上完整错误和 `~/.avantf` 备份开 issue，不要手改库 |
| 摄入的文本是乱码 | 文件是 GB18030/GBK **以外**的旧编码（windows-1252、big5、shift_jis…）；UTF-8/UTF-16/GB18030 会自动识别 | 看返回里的 `encoding` 字段确认用了哪种解码，再先转成 UTF-8 入库 |
| 摄入报 `无法作为文本解码` | 既不是合法 UTF-8 也不是合法 GB18030（如 `0xFF`、截断的多字节尾巴） | 先 `iconv -f <原编码> -t UTF-8` 转码再入库 |
| 摄入报 `知识域「X」不在允许清单里` | `X` 既不在 `knowledge.domains` 里，也不是库中已有的领域 | 用清单里的领域；或在「知识」页入库表单里点 domain 旁的「+ 新增领域」（立即生效），或手改 `~/.avantf/configs/knowledge.yaml` 的 `domains`（`domains: []` = 不限制，改完重启 `dsh`）（见 §7.3） |
| 构建通过但运行时崩（例如某图标/变量未定义） | `tsdown` **不做类型检查** | 构建管线必须先 `tsc` 再 `tsdown`；单独 `tsdown` 会放过类型错误 |
| 启动日志出现 `compat:` 警告 | 产物声明的宿主版本与运行的不一致，或宿主 API 已变。只看版本号不同（探针通过）时插件照常加载，只是提醒；若出现 `compat: INCOMPATIBLE` / `compat: REFUSING to load` / `plugin not loaded`，说明真身探针（`register` → 精确 key 复查 → `toJSONSchema`）证明 API 不兼容，插件**整体不加载**（可用 `/mem` 命令问原因），且后台资源项（pandoc / 模型）一步都不派发 | 用当前 dsh 重建：`pnpm build:dsh`（插件只对着已安装的全局 dsh 编译）；或换回匹配的 dsh 版本后重启 `dsh web`。详见 DESIGN §12.1 |
| 启动日志出现 `envinit: WARNING — @avantf/dsh-plugin-base is unavailable (…)` / `… could not be made available; …` | 内联 bootstrap 没能让底座可用：peer 没安装（`node_modules` 不完整），或树上那份版本超出 bootstrap 烘焙的 `supportedRange`。**插件照常挂载**（门禁判定缺席，工具/service/prompt/remote 都注册），只是少了启动兼容性检查这道安全网，资源预装退回 legacy 路径 | 正常安装里不应出现：确认 `pnpm install` 装上了 `@avantf/dsh-plugin-base`（它是 peer；pnpm 关掉 `autoInstallPeers` 时要显式装），并跑过 `pnpm build:dsh`（它会跑 `scripts/link-envinit.mjs` 从安装副本 vendor bootstrap）。**没有下载可重试、也没有受管 compat 根可修**——底座不在就只是降级挂载。就地联调底座时才用 `DSH_ENVINIT=<checkout>` |
| 族根里出现第二份 zod | 不应发生：底座与插件从同一棵依赖树解析 `zod`，必须是同一份（两份 zod 的 schema identity 不兼容，见 DESIGN §20.11） | 检查插件的 `zod` 是否可解析；旧的 compat 目录（`<home>/compat`、`<dataHome>/dsh-compat`）都不再被读写，可以直接删除 |
| 启动即报 `toJSONSchema() threw … Undefined cannot be represented in JSON Schema` | wire face 里可选字段写成了 `z.union([z.undefined(), X])`；这个形状宿主投影不出来，真身探针会把它读成不兼容 | 改成 `X.optional()`（本仓已改，见 DESIGN §12.1 末段）；`test/provision.spec.ts` 会逐个 schema 断言可投影 |
| 数据落在 `~/.avantf/.avantf/` | 旧版 `db.path` 默认值 bug（已修） | 升级到当前版本后重启；把 `~/.avantf/.avantf/{memory,knowledge}` 里的 DB 移到 `~/.avantf/{memory,knowledge}` |
| 终端看不到插件日志 | DSH 的 `ctx.logger` 只挂了**缓冲** exporter | 插件日志走 stderr（本仓库已如此），stdout 留给 CLI/MCP 的 JSON |
| `onnxruntime-node` postinstall 报 `302` | 它去 NuGet 取可选二进制被重定向 | **非致命**：包内自带 CPU `napi-v6` 绑定，`require('onnxruntime-node')` 正常 |
| 客户端 bundle 里看到 `zod` 被内联 | 客户端挂的是 `src/remote.ts` 的 strict codec contribution | 预期行为（单一事实来源）；不想内联就改回轻量直通 codec，代价是描述符两份 |
| `packages/plugin/vendor/dsh-client-preset/packages/client/avantf-dsh-mem/` 又出现了 | `link-dsh.mjs` 每次 `build:dsh` 都会重建 manifest stub | 预期行为；生成物已在 `.gitignore` 里 |
| 构建/类型检查都通过，但宿主认不到工具或 typert face 对不上 | 插件链的 dsh 拷贝与**正在运行的** dsh 不是同一份 | 重跑 `node scripts/link-dsh.mjs` 对齐到你要运行的那份全局 dsh 并重启 `dsh web`（见 §2.2 的提示） |

---

## 9. 背景：为什么需要这些非常规接线

1. **插件必须是标准 Cordis 插件**：模型工具用 `ctx.tools.register(defineTool(...))` 注册，
   客户端↔宿主用 `TypertRemoteService`。DSH 的「动态包」`harness` 全局只在 `node:vm` 沙箱里存在，
   而沙箱禁用 `require`/fs/网络，与本插件（内置 SQLite 存储 + 模型下载）矛盾。
2. **客户端半部必须是 DSH 的 client bundle**：宿主会扫描 Loader 里声明了 `dsh.client` 的包，
   把它 `exports["./client"]` 的文件字节拼进浏览器 combo 脚本，因此必须是
   `clientBundle` 预设产出的 `window.__ModuleLoader__.load` 工厂。
3. **Remote 命名空间要自己挂载**：DSH 客户端只自动挂载 harness 自己的生成清单
   （`packages/api/remotes/src/client/index.ts`），树外插件必须自挂载；
   而宿主对任意注册的 `TypertRemoteService` / `ctx.typert.register` 都是动态认领的。
4. **构建要用 harness 预设**：`clientBundle` 会 glob `<HARNESS>/packages/*/*/package.json` 读包元数据，
   所以需要一个 manifest stub（第 2 节第 2 步）。

---

## 10. 相关文档

- [DSH_INTEGRATION.md](DSH_INTEGRATION.md) — 接线细节与客户端/宿主形态
- [VECTOR_STORES.md](VECTOR_STORES.md) — 向量后端选择
- [TRUST_MODEL.md](TRUST_MODEL.md) — 信任与遗忘模型规格（自然消退 / 召回加强 / 永久记忆，待实现）
