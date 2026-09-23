# AGENTS.md — 合并后的 `dsh-plugins` 工作区

`base/`、`mem/`、`work/` 是**一个**仓库。它们从前是四个（`dsh-envinit`、`dsh-compat`、
`avantf-mem`、`avantf-work`）；这份文件说明合并保证了什么、以及这里的改动**不能**破坏什么。
每个子树仍保留自己的 `AGENTS.md`/`DESIGN.md` 管自己的领域 —— 先读这一份。

## 发布面：恰好三个包

| 目录 | 包 | 是什么 |
| --- | --- | --- |
| `base/plugin-base` | `@avantf/dsh-plugin-base` | envinit（启动期环境初始化）**+** 宿主兼容性门禁 **+** 共享 kit —— 一个包、一次发版 |
| `mem/packages/plugin` | `@avantf/dsh-mem` | 记忆/知识 DSH 插件 |
| `work/packages/plugin` | `@avantf/dsh-work` | 工作树 DSH 插件 |

其余所有工作区包（`@avantf/mem-*`、`@avantf/work-core`、CLI/MCP）都是 `private: true`，会被内联进
使用它的那个插件。`scripts/release-check.mjs` 会在可发布集合不是这三个时失败。

- **旧**包 `@avantf/dsh-envinit` 与 `@avantf/dsh-compat` 已死：代码住在 base 里，不再有新版本，
  任何地方都不许再提它们的名字。
- 插件把 base 当作 **REQUIRED peer** 依赖，范围要宽到能吃下一个 base 的 patch 或 minor
  （`^0.1.0`）。它同时在 `devDependencies` 里声明同一个 base（`^0.1.0`），好让 `pnpm install`
  有东西可解析；根 `pnpm-workspace.yaml` 里的 `linkWorkspacePackages: true` 让这一条指向
  `base/`，绝不会变成下载。
- 宿主/profile **显式**安装 `@avantf/dsh-plugin-base` **和**两个插件
  （`autoInstallPeers: false`）。会自动装 peer 的 npm 式安装器则会顺带把 base 装上。
- **`zod` 只解析出一份。** 根 catalog 一行 `zod: 4.6.5`（已安装 dsh 自带的版本）。base 自己的
  peer 保持 `>=4.4.3 <5`，于是同一份 base 既服务本工作区、也服务宿主的 4.6.5。改 catalog 那一行，
  永远不要改 `package.json`。
- **发布顺序：base → 插件。** 插件的 required peer 必须已经在 registry 上；
  `scripts/release-check.mjs` 会断言插件 peer 范围内存在一个已发布的 base 版本
  （只在发布前试跑时用 `--allow-missing-base`）。任何 tarball 都不许带 `link:`/`file:` 说明符。

## 家族的三条硬约束

1. **被 provision 的代码既不打包、也不静态 import。** 插件对 base 的唯一静态引用，是 vendor 进
   `packages/plugin/src/envinit-bootstrap.js` 并**内联**进产物的零依赖 bootstrap。一句静态的
   `import ... from '@avantf/dsh-plugin-base'` —— 或者字面量的动态
   `import('@avantf/dsh-plugin-base')` —— 都会让 base 缺席时插件模块加载失败，而那正是插件
   **绝不能**有的失败。
2. **base 由框架/宿主提供，并按 file URL 动态加载。** 启动时内联的 bootstrap 用
   `createRequire(import.meta.url).resolve('@avantf/dsh-plugin-base/package.json')` 解析出它，再
   `import()` 结果，然后拿内联的 `supportedRange` 校验版本。缺失或超出范围 → 一条
   `envinit: WARNING`，插件照常挂载。
3. **发布有序、路径干净。** 先 base，后插件；已发布的 manifest 里永远不出现 `link:`/`file:`。

## 唯一的判断准则：这条知识能不能靠一次 base 发版修好？

每次你要决定一块知识放 `base/`（运行时消费）还是留在插件里，就问这一句：
**“这条知识必须能靠一次 base 发版修好吗？”**

- **能 → base 拥有它，插件在运行时从加载到的 base 模块上取。** 这就是 kit 不是一个私有包、
  插件也不许内联它的原因。今天从 base 运行时取得的有：
  - 兼容性门禁：规则、探针、裁决、报告、注册后校验（`runtimeFromCompat(framework)`），
  - envinit provisioner：`createProvisioner`、三个 provider 工厂、`ITEM_SCHEMA_VERSION`
    以及各 item 种类，
  - 提示词文件层 `PromptFiles`（两个插件都从加载到的 base 上构造 `kit.PromptFiles`）。
- **一处刻意的镜像，由测试钉住。** 家族/数据路径解析有**两份**副本，且必须都留着：
  `base/plugin-base/src/kit/family.ts` 是正本，work 的 `promptDir` 从加载到的 base 上取
  `kit.resolveDataHome`；而 `@avantf/mem-contract` 的 `family.ts` 保留自己那份无依赖副本，
  因为 CLI 与 MCP server 没有 DSH 宿主、从不加载 base。有一个测试把两份副本钉在一起。
  这是“一次 base 发版就够了”**唯一**不成立的地方 —— 改这个约定等于一次 base 发版**加**一次
  mem 引擎改动 —— 而这是刻意的：无 base 的路径必须能用。
- **不能 → 它可以留在插件里，但要在这里写明，并接受改动它需要一次插件发版。** 已记录的
  插件本地知识：
  - Typert 的 `strict` codec 信封，以及 `<pkg>#<namespace>/<method>:<field>` 类型符号辅助
    （`mem/packages/plugin/src/remote.ts`、`work/packages/plugin/src/wire.ts`）。它们只是镜像
    生成器约定的几行，且在模块加载时组装；描述符组装本身两个插件确实不同（work 多出
    `stream`/取消；mem 多出 `acceptsUndefined` 参数辅助）。**base kit 也导出了
    `strictCodec` / `endpointId` / `fieldSymbol` / `resultSymbol` 作为正本副本，所以插件
    *可以*从加载到的模块上取 —— 但今天这两处各留各的，改**它们**需要一次插件发版。**
  - 插件 logger。它在 `apply` 里、base 解析**之前**就建好了（base 加载器自己需要一个 sink 来
    上报），所以它不可能来自加载到的模块；`base/kit` 仍然导出 `createPluginLogger` 作为新插件
    的正本副本。
  - 各插件的 compat SPEC 与 envinit item 清单：它调用哪些 service/方法、哪些 dsh 包标识宿主、
    它的 wire schema 名、它的事件、它的中文报告字符串，以及它的
    `mem:pandoc` / `mem:model` / `work:*` item。只有那个插件自己知道。
  - 各插件内置的默认提示词正文与其 client/UI 半边，以及无 base 时的兜底（work `prompt.ts` 里
    `resolveDataHome` 的默认参数、mem `prompt.ts` 里的默认 section 文本）。兜底不是第二份权威
    实现：它只在 base 缺席时运行。

## base 缺失时的降级（绝不拒绝挂载）

| 能力 | base 缺席时 |
| --- | --- |
| 提示词文件层 | 插件用**自己**内置的默认正文（是它的内容，不是 kit 的副本） |
| 兼容性门禁 | 一条 `compat:` WARNING，门禁跳过。裁决语义永不变：只有**被证实**的不兼容才拒绝挂载，“说不清”只是一条备注，版本差异只是警告，什么都不抛 |
| 资源 provision（pandoc/model） | 旧的 `@avantf/mem-provision` / legacy-tools-dir 路径 |
| 工具、service、Remote、UI 各个面 | 不受影响 —— 插件完整挂载 |

## 构建入口：一条命令，插件自动发现

```
pnpm build:dsh            # 全部插件，按目录名字典序（当前 mem、work；每个都会先构建 base）
pnpm build:dsh mem        # 只构建记忆插件
pnpm build:dsh work       # 只构建任务插件
pnpm build:dsh base       # 只构建 base（tsc；不出插件产物、不跑挂载冒烟）
```

**插件集合是发现出来的，不是列出来的**：一个**插件树** = 顶层目录，其 `package.json` 里有一个
`build:dsh` 脚本。所以新增插件（比如 `notes/` + `@avantf/dsh-notes`）只要自己带上构建脚本，
`pnpm build:dsh notes` 立刻可用 —— `scripts/build-dsh.mjs` 和 `scripts/lib/plugins.mjs` **一个字都
不用改**，也没有第二份清单会忘记更新。`scripts/lib/plugins.mjs` 里的 `discoverPlugins()` 做这件事，
`prove-base-swap.mjs` 读同一个集合，因此新插件不会被任一门禁漏掉。目标名就是目录名；`base` 是唯一的
非插件目标（它按包名 `@avantf/dsh-plugin-base` 在 `base/` 下被发现）。

`scripts/build-dsh.mjs` **只做路由**：真正的构建仍在各子树（`mem/scripts/build-plugin.mjs`、
`work/scripts/build-plugin.mjs`、base 的 `tsc`），因为各条流水线确实不同 —— 合并的只是“该进哪棵树”
这条记忆。目标之后的旗标原样转给该插件自己的 `build:dsh`（`pnpm build:dsh mem --fresh`、
`pnpm build:dsh work --skip-link`，各插件认什么用 `pnpm build:dsh <目标> --help` 问它自己）；**不带
目标时任何旗标都会被拒绝**，因为旗标是插件私有的：`--fresh` 只属于 mem，转给别的插件只会在前一个插件
已经重建完之后把整轮跑挂。

### 新增一个插件时要动什么

**不用动**（发现式）：`pnpm build:dsh <目录名>`；`pnpm proof:base-swap` 读同一份发现结果，所以新插件
自动进入它的检查 —— 还没跟上家族布局（缺 `packages/plugin`）或还没构建时，它会把这一项**报出来**，
不会静默跳过。

**要动，而且都是刻意的**：

- 根 `pnpm-workspace.yaml` 的 `packages:` 加一条 `<tree>/packages/*`。不加以外，它的包不进工作区：
  `pnpm install` 不装、`pnpm -r build|test` 不覆盖（`pnpm build:dsh <tree>` 仍然能跑，因为那是该目录
  自己的脚本）。
- 根 `scripts/release-check.mjs` 的**可发布集合**加一行。那里刻意写死包名：可发布面是要被审查的，
  不该被自动发现悄悄放大。
- 插件自己那一份：`packages/plugin/package.json` 里 base 是 required peer（`^0.1.0`）+ 同版本
  `devDependencies`、自己的 `build:dsh`、`scripts/mount-smoke.mjs`（`proof:base-swap --mount` 要求）。
- 依赖版本一律写进根 `pnpm-workspace.yaml` 的 `catalog:`，各 `package.json` 只写 `"catalog:"`。

`pnpm guard` **不在**这个清单里：它按同一份发现结果扫每一棵树，新插件自动适用四条规则（不许 import
别棵树的包、相对路径不许出树、产物里不许按值 import base、`@avantf/*` 只能是本树的包）。

## 版本：每个组只记在一个 manifest 里

一个**版本组** = 一个顶层子树（`base` / `mem` / `work`），它的版本**只记录在一处**——该组那个可发布包的
manifest：

| 组 | 版本记录在 | 组内其余 manifest |
|---|---|---|
| `base` | `base/plugin-base/package.json` | 无（就它一个） |
| `mem` | `mem/packages/plugin/package.json` | `mem/package.json` + `packages/{core,contract,convert,provision,retrieval-core,cli,mcp}` —— **都不带 `version`** |
| `work` | `work/packages/plugin/package.json` | `work/package.json` + `work/packages/core` —— 都不带 `version` |

私有 manifest **不写版本号**：它们不会被发布（插件把引擎内联进产物，工作区里按路径链接），写一份就是多一处
要改、多一处会漂。这也意味着**切版本就是改一个文件**，没有任何"同步/派生"步骤：

```bash
pnpm version:set mem 0.1.2   # 只改 mem/packages/plugin/package.json
pnpm version:check           # 打印三组版本；私有 manifest 一旦又长出 version 就报错
pnpm version:prune           # 把私有 manifest 上多余的 version 删掉（唯一可能的漂移）
```

- 映射与规则只在 `scripts/lib/versions.mjs` 一处（哪个 manifest 是载体、哪些必须没有版本），
  `scripts/version.mjs`（CLI）、`scripts/release-check.mjs`（门禁 2b 段）、`mem/scripts/release-check.mjs`
  的 preflight 与 `scripts/make-release-tree.mjs`（投影）都读它。
- CI 跑 `pnpm version:check`，所以"又给私有包加回版本号"这类回归在评审前就红。
- **`workspace:*` 指到的私有包，版本只在打包那一刻存在。** `pnpm pack` 会把 `workspace:*` 改写成
  **目标包的 `version`**，所以那些被引用的包在打包时必须有一个版本可读；但它们不发布，于是版本由
  `scripts/lib/versions.mjs` 的 `withWorkspaceVersions()` 在 `pnpm pack` 期间临时写进去、`finally` 里逐字
  还原（mem 的 4 个引擎包 + work 的 core；见两个 `pack-plugin.mjs`）。仓库里不留副本，忘了还原会被
  `pnpm version:check` 抓住、`pnpm version:prune` 收拾。
- 投影默认**取开发树的版本**；`pnpm sync:rc --version mem=X` 只给发布树盖章（改的同样是那一个载体），
  `--keep-rc-versions` 保留发布树现有版本。投影还会断言发布树的形态与开发树同规则（私有 manifest 无版本）。
- **版本不是发布**：`mem/CHANGELOG.md` 的版本节仍要自己切（mem 自己的 release gate 检查第一个版本节
  == 当前版本、`[Unreleased]` 为空）。

## 要跑的门禁

| 命令 | 它证明什么 |
| --- | --- |
| `pnpm version:check`（`scripts/version.mjs`） | 每个组的版本只记在它的可发布 manifest 里，私有 manifest 不带版本（回归即红） |
| `pnpm guard`（`scripts/boundary-guard.mjs`） | 每个**被发现**的插件树只够得到 base 与自己的包：①不许 import 别棵树的包；②相对路径不许走出本树（唯一例外是 `scripts/lib/`）；③会被打进产物的文件不许**按值** import base（只能 `import type` / `typeof import(…)`，测试不受此限）；④其余 `@avantf/*` 必须是本树的包。**实现只有一份**：`base/plugin-base/test/boundary.spec.ts` 直接 spawn 这个脚本并断言它扫到了每一棵树，不再各写一份规则 |
| `pnpm release:check`（`scripts/release-check.mjs`） | 可发布集合恰好是那三个、其余都是 private；peer 是 required 且范围够宽；base peer 的 zod 是 `>=4.4.3 <5`；`catalog.zod` 是 4.6.5；没有 `link:`/`file:`；registry 上已有兼容的 base |
| `pnpm proof:base-swap`（`scripts/prove-base-swap.mjs`） | 构建出的插件产物里既没有静态 base import 也没有内联的 kit 声明，且插件**构建产物**的 bootstrap 能加载一份**被替换**的 base 并从它取提示词读写与根解析，产物字节一致 |
| `pnpm proof:base-swap:mount` | 同上，外加两个插件针对构建产物 + 工作区 base 的完整 Cordis 挂载冒烟 |
| `pnpm release:check:base` / `:mem` / `:work` | 各包自己的 typecheck → build → test → pack 门禁 |

### 改动 `base/**` 下任何共享代码之后

要把**两个**插件都回归一遍，因为 base 的改动可能弄坏任意一个，而 base 自己的测试里没有任何一项
会走到插件的挂载：

```
# mem（在 mem/ 里）
pnpm build:dsh && node scripts/mount-smoke.mjs
# work（在 work/ 里）
pnpm release:check && node scripts/mount-smoke.mjs
```

从仓库根看，同样两行是
`pnpm build:dsh mem && node mem/scripts/mount-smoke.mjs` 与
`pnpm build:dsh work && node work/scripts/mount-smoke.mjs`（两条命令末尾的挂载冒烟其实已经在插件
自己的 `build:dsh` 里跑过一遍）。`pnpm proof:base-swap:mount` 把两个挂载冒烟当作一个门禁一起跑；
上面那两行是只迭代单个插件时用的。

### 脚本住在哪里，以及为什么有些脚本**没有**被合并

- 根 `scripts/` 拥有所有关于**工作区**的东西：`release-check.mjs`（可发布集合、base 先于插件的
  顺序、只有一份 `zod`）、`boundary-guard.mjs`、`prove-base-swap.mjs`、`build-dsh.mjs`（统一的
  `pnpm build:dsh [<插件目录>|base]` 入口）、`clean.mjs`，以及
  `scripts/lib/{harness-path,bootstrap-version,plugins}.mjs`。`plugins.mjs` **不登记任何插件**：
  它按“顶层目录 + `build:dsh` 脚本”发现插件集合（外加按包名发现 base），所以新增插件不碰它；
  `build-dsh.mjs` 与 `prove-base-swap.mjs` 读的是同一个发现结果。（踩过的坑：`.gitignore`
  里那条构建产物规则 `lib/` 会连 `scripts/lib/` 下的**新**文件一起吞掉 —— 加它之后新文件不会出现在
  `git status` 里，`harness-path.mjs` / `bootstrap-version.mjs` 就这样长期没进仓库，克隆出来的树根本
  构建不了。已用 `!scripts/lib/**` 反制，且反制必须排在规则**之后**。）
- 两个真正一模一样的辅助被提到 `scripts/lib/`，各自的副本已**删除**；`mem/scripts/*` 与
  `work/scripts/*` import 根上那两份（不再有重复文件留存）。
- 插件的流水线**刻意**留在各自插件里 —— `link-dsh` / `link-envinit` / `mount-smoke` /
  `pack-plugin` / `release-check` 有 80 %+ 是不同的实现，参数是各插件自己的包集合、自己的打包
  流水线（mem：`tsc` + 钉住的 tsdown client preset；work：`tsc` + esbuild + core 类型搬迁）和
  自己的 item 清单。把脚本合成一个参数化的，就得为每处差异加一个 switch，而那正是本仓库拒绝的
  “假抽象”。共享的**骨架**住在 `scripts/lib/` 和 `base/` 里；真正一模一样的脚本才会被提上去 ——
  两个辅助，以及**整仓投影**（`make-release-tree.mjs` + `sync-release-repo.sh`，见下）都是这样
  提上来的：投影是仓库级操作，没有“每个插件一份”的版本。
- `mem/scripts/release-check.mjs` 仍然是 mem 范围内的门禁（它只断言那里的
  `mem/packages/plugin` 可发布）；**全仓库**的断言 —— 恰好
  `@avantf/dsh-plugin-base`、`@avantf/dsh-mem`、`@avantf/dsh-work`，其余 private —— 在
  `scripts/release-check.mjs`。
- 有且只有**一个** `pnpm-workspace.yaml` 和一个 catalog：根上那份。按子树的 workspace 文件
  （`mem/pnpm-workspace.yaml`、`work/pnpm-workspace.yaml`、`base/*/pnpm-workspace.yaml`）已删除，
  所以 `pnpm -C work …` 走的是合并后的工作区（用 `pnpm -C work list` 验证）。
- **RC 投影：整仓，不是单插件。** 发布用的投影仓是 `../dsh-plugins-rc`（可用 `$AVANTF_RC` 覆盖），
  由**仓库根**的两个脚本维护，子树里没有对应脚本：
  - `scripts/make-release-tree.mjs` —— 把 `dsh-plugins` 的**每个受控文件**整仓投影过去（`--into <dir>`
    报漂移、`--apply` 落盘、`--out <dir>` 生成一棵新树）。rc 因此是**同一个仓库形态**：一个根
    workspace、一个 catalog、`base/`+`mem/`+`work/`、测试与文档都在，所以投影**不需要任何剥离规则或
    逐文件转换**，`pnpm-lock.yaml` 也原样投影（组版本号不写进锁文件）。唯一不进 rc 的是 RC 工具链自己
    （这两个脚本），根 manifest 里对应的两条 script 也一并去掉 —— 发布仓是生成的，它不生成任何东西。
  - `scripts/sync-release-repo.sh` —— 推荐入口：预览 → 确认 → 投影 → 复查 →（`--commit`）提交 →
    （`--gate`）在 rc 里跑门禁。rc 不存在时会自动 `git init`。`--gate` 是**产物级**门禁
    （install → guard → `release:check --offline` → 三个包各自的 `release:check` → `proof:base-swap`），
    其中 mem 传 `--allow-uncut`：同步不是切版本，`[Unreleased]` 未清空这类**发布簿记**不该拦住一次同步；
    真正发布前要在 rc 里不带该旗标跑一次 `pnpm release:check:mem`。
  - **版本按组（group）走**，组就是顶层子树：`base` / `mem` / `work`。`--version mem=0.1.2` 只盖 mem
    这一组**记录版本的那一个 manifest**（该组的可发布包 `mem/packages/plugin/package.json`）—— 组内其余
    manifest 是私有的、根本不带版本，所以没有"组内不齐"这回事；不带组名则三组一起盖。
    `pnpm sync:rc` 默认**取开发树的版本**（每组来自它的载体 manifest），而 `--keep-rc-versions` 才是
    "保留 rc 当前的组版本、让 rc 停在开发树前面"的那个可选开关；无论哪种，三组的取/留都会打印出来，
    不会悄悄挪动。三个包在同一个 rc 仓库里，tag 用组前缀（`mem-vX.Y.Z`）。
  - 判据（为什么是整仓）：单插件投影必须把测试剥掉、把被内联引擎的运行时依赖面**重新推导**一遍，
    因为一个子树里没有它要内联的引擎包；整仓投影没有这些推导，rc 里能跑与开发树**同一套**门禁。
    两个旧成因（投影树没有 workspace 文件 / 没有根 `scripts/lib/`）也随“整仓”一起消失。

## 四条工作原则

1. **复用代码与业务逻辑。** 两个插件需要同一行为，它就属于 `base/`（或属于一个被内联的共享私有
   引擎包）—— 不是复制一份。kit 与兼容性门禁之所以存在，正是因为这些东西被复制过一次、然后
   漂移了。
2. **不为复用而复用。** 共享本身不是目的；错误的抽象比重复更糟。刻意不复用之处，以及原因：
   - **两个内核**：`@avantf/mem`（检索/知识引擎）与 `@avantf/work-core`（工作树状态机）不共享
     任何领域模型。把它们合并会把两条无关的生命周期耦合在一起。
   - **两个 client 半边**：浏览器产物是两套不同的 UI、由不同的 remote 驱动；只有它们的构建
     ABI（钉住的 harness preset）是共享的。
   - **各插件的 envinit item 清单与 compat SPEC**：只有插件自己知道它注册了什么。
3. **改完共享代码，回归每一个插件。** 见上面的命令。base 自己的测试过了，不代表这次改动做完
   了。
4. **插件是彼此独立的产品。** 各自拥有包名、版本、打包与发布；绝不互相 import（连相对路径也
   不行）；任一个都能在另一个缺席时装上、升级或卸掉。

## 边界与路径

- 保持 `mem/` ↔ `work/` 零 import（有门禁把守）。共享代码一律走 `base/`。
- `AVANTF_HOME` 设的是**家族/受管根**（`$AVANTF_HOME`，否则 `~/.avantf/env`；资源在
  `<root>/tools`、`<root>/models`）。**数据根**是显式 `common.dataHome` → `$AVANTF_HOME`
  → 配置 → `~/.avantf`；用户数据与可编辑文本住在那里（`memory/`、`knowledge/`、
  `configs/*.yaml`、`prompts/*.md`）。这两个根刻意不同 —— 不要混为一谈。
- 兼容性门禁现在属于 base：不再有 `mem:compat`/`work:compat` item，也没有受管的
  `~/.avantf/env/compat/**` 下载了。机器上如果还留着 `~/.avantf/env/compat/`（或旧的
  `<dataHome>/dsh-compat/`），可以手工删掉 —— 没有任何东西读它。
- 数据文件永不搬出 `~/.avantf/{memory,knowledge}`；用户**编辑**的一切都住在
  `~/.avantf/configs/*.yaml` 与 `~/.avantf/prompts/*.md`，绝不放在数据库旁边。
