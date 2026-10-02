# DSH Desktop 兼容性：方案与证据（2026-10-01）

> ## ⚠ 先读这条：本文分两轮，第 1–5 节不是现状
>
> **第 1–5 节是第 1 轮的提案与记录**（当时的设计是"两个驱动 + 运行期回退"），**第 6 节起才是最终形态**：
> 单实现 `node:sqlite`、`better-sqlite3` 已彻底移除、`AVANTF_MEM_SQLITE_DRIVER` 与 `db/binding.ts` 都不存在，
> 且插件后来由 `work` 改名为 `mission`。照着第 1–5 节行动会去找已被删除的环境变量与 optional 依赖——
> **以第 6 节为准。**
>
> **后续（2026-10-01）：插件已改名为 `@avantf/dsh-mission`（目录 `mission/`）。** 本文保留当时的名字
> —— 文中的 `work/`、`@avantf/dsh-work`、`@avantf/work-core`、`create_work`、`avantf_work`、`work-` 前缀、
> 「工作」标签，现在分别是 `mission/`、`@avantf/dsh-mission`、`@avantf/mission-core`、`create_mission`、
> `avantf_mission`、`mission-`、「任务」。改名原因见下面的第 6 节末段。

这一轮的目标：**让 `@avantf/dsh-mem` 与 `@avantf/dsh-mission` 能在 DSH Desktop 上安装、挂载、真正可用，
同时不改变 Linux/WSL 上的行为、依赖面与发布流程。** 任务树**未提交**，三处版本号**未动**。

本文是这次改动的唯一记录：第一节是实测出来的事实，第二节是逐文件方案，第三节解释为什么 Linux 不受影响，
第四节是验证记录，第五节是没做的事。

> **后续（同日）：数据库系统已统一，§2.1 的"两个驱动"被取代。** 按"能靠一次实现改动修好、就不留两条
> 需要被证明一致的代码路径"的判断，`better-sqlite3` 被**彻底移除**（适配器、驱动选择器、两个 manifest
> 的依赖、catalog 与 `allowBuilds` 条目、`AVANTF_MEM_SQLITE_DRIVER` 全部下线），引擎只跑运行时的
> `node:sqlite`。本文保留当时的过程记录；**当前状态以第 6 节为准**，§2.1/§3/§5 中关于回退与钉死驱动的
> 描述只作历史。

---

## 1. 事实基线（全部在本机实测，不是推断）

| 事实 | 值 / 证据 |
| --- | --- |
| Desktop 运行时 | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` **0.2.0-rc.2**；`dsh --version` → `0.2.0-rc.2` |
| profile | `desktop`（`$DSH_HOME=C:\Users\feng\.dsh`），bundles = base + web-app |
| 宿主进程 | **Electron 44 以 node 模式**跑 profile：`main.js` 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 拉起 `dsh-desktop-host/lib/index.js`；实测该进程 `process.versions.modules = 149`（node 24.18.1），而 Desktop 自带的普通 node 是 24.21.0（137） |
| 自带 CLI / 包管理器 | `resources\runtime\cli\bin\dsh.cmd` → `runCli({ manageDesktopProfile: true, packageManager: 自带 pnpm 11.7.0 })`；`dsh plugin --profile <p> <pnpm 参数>` 就是 pnpm 透传 |
| GUI 安装面 | 「插件」页 / `plugin_manager` **只接受组合包**（声明了 `dsh.bundle.patch` 的包）；`inspect` 对其它包回 `not-a-bundle` 并把安装回滚 |
| 驱动可用性 | Electron 44 自带 `node:sqlite`（SQLite 3.53.1），实测 **FTS5 + `trigram` 分词器都在**；Node 22.23 / 24.21 / 25.2 同样可用 |

### 1.1 三个被证实的失败点

1. **不钉版本 → 解析到旧版 → 装不进去。** pnpm ≥ 10 的 `minimumReleaseAge` 避开刚发布的版本（本机实测
   窗口大于 3 天，行为与 7 天一致）：`dsh plugin --profile probe add @avantf/dsh-mission`（不钉版本）解析到
   **0.2.0**，而 0.2.0 的 peer 是 `^0.1.5-rc.2`（不含 `0.2.0-rc.2`），于是宿主的安装门禁拒绝整单并回滚：

   ```
   dsh: installation rejected: Plugin @avantf/dsh-mission@0.2.0 is incompatible with dsh 0.2.0-rc.2:
        peerDependencies {"@deepseek-ai/dsh-agent":"^0.1.5-rc.2", …}
   dsh: restored package.json, pnpm-lock.yaml, and node_modules.
   ```

   mem 同理（0.3.1 才发布一天，被避开 → 拿到 0.2.0）。**已发布的 0.2.2 / 0.3.1 声明是对的**，问题在解析。

2. **界面装不了非组合包。** Desktop 的「插件」页只列/只装组合包；本仓两个包此前都没声明
   `dsh.bundle.patch`，所以在界面上不可安装，只能 `dsh plugin add` + 手写 `cordis.patch.yml`。
   反过来，一旦声明了组合包，**连命令行安装都会自动选中它**（实测：`dsh plugin add` 之后 profile 的
   `dsh.profile.bundles` 自动多出这两个包名），挂载行随包插入。

3. **mem 的存储层在 Electron 下不可用。** `better-sqlite3` 是 NAN 扩展，`.node` 绑死在一个
   `NODE_MODULE_VERSION` 上：

   ```
   node_modules/better-sqlite3 install: prebuild-install warn install No prebuilt binaries found
       (target=24.18.1 runtime=node arch=x64 libc= platform=win32)
   node_modules/better-sqlite3 install: gyp ERR! find VS could not use PowerShell to find Visual Studio …
   [avantf-mem] ERROR runtime unavailable — mounting DEGRADED (tools answer with the reason):
       Could not locate the bindings file. Tried: … lib\binding\node-v149-win32-x64\better_sqlite3.node
   ```

   11.x 的 electron 预编译只到 `v132`，Desktop 是 `v149`；回落源码编译又需要本机有 MSVC。结果是插件
   挂载成 DEGRADED、8 个工具全回 `memory unavailable`。

4. **（顺带发现）Windows 上 pandoc 装完不能用。** base 的 `binary-archive` provider 按**声明的名字**
   落盘，而 Windows 的 pandoc 归档里叫 `pandoc.exe`，于是装成了 `bin/pandoc`：Windows 无法执行没有
   扩展名的 PE 镜像 → `--version` 探针失败 → 新下载的 223 MB 被丢进 `.envinit/.quarantine`：

   ```
   [avantf-mem] WARN quarantined …\tools\pandoc\3.11: …\bin\pandoc 的 --version 探针失败
   ```

   手工把那个文件改名成 `pandoc.exe` 后 `pandoc 3.11` 正常输出（见 §4.4）——即"文件是对的，名字错了"。

**mission 0.2.2 的运行时本身在 Desktop 上没有问题**：实测挂载成功（compat ok、9 个工具、`/mission` 命令、
存储域、`engine ready`）。它的问题只在"装"这一层（第 1、2 条）。

---

## 2. 改动清单

### 2.1 mem 存储层：一个端口，两个驱动（**已被第 6 节取代**：现在只有一个驱动）

| 文件 | 改动 |
| --- | --- |
| `db/sqlite_node.ts` | **新增**：`node:sqlite` 适配器，实现同一个 `Db` 端口（`prepare/exec/transaction/pragma/close`）。`node:sqlite` 通过 `createRequire` 惰性加载——静态 `import` 会让**这个文件**在 Node < 22.5 上加载失败，从而拖垮一个本来完好的插件 |
| `db/binding.ts` | **新增**：唯一决定用哪个驱动的地方。`AVANTF_MEM_SQLITE_DRIVER=better-sqlite3\|node` 可钉死；否则**探测一次**（开一个 `:memory:` 句柄——"模块能 import"说明不了"绑定能用"）；两个都不能用才把两条原因一起抛出；`describeSqliteBackend()` 给日志一行、永不抛 |
| `db/sqlite.ts` | 保留 `better-sqlite3` 适配器，导出改名 `openBetterSqlite`，新增 `betterSqliteProbe()`（含 ABI 诊断：`(no binding for node-v149 on Electron 44.0.0)`） |
| `db/store.ts`、`db/tokenizer.ts` | 只改 import 到 `./binding.js` |
| `db/port.ts` | 注释：绑定是**两个**适配器，由 `binding.ts` 选 |
| `runtime.ts` | `runtime init:` 行追加 `sqlite=<驱动>`（回退时括号里带原因） |

**契约一致性**（回退能成立的前提，四条都在 `test/sqlite_backend.spec.ts` 里对两个驱动断言）：

- 语句缓存规则相同（键是 SQL 文本、上限 2000、`close()` 清空）；
- 命名参数只承诺**裸 key + 任意 SQL 前缀**（`:name`/`@name`/`$name`）——带前缀的 JS key 不在契约里，
  因为 `better-sqlite3` 会抛 `Missing named parameter`；
- **BLOB 一律返回 `Buffer`**（`node:sqlite` 原生给 `Uint8Array`，适配器用零拷贝视图归一化；
  `hrrFromBytes`、`db/vectors.ts` 与 `Buffer.isBuffer` 判断都建立在这个形状上）；
- `transaction()` 嵌套时退化成 `SAVEPOINT`、抛错回滚后原样抛出。

**一处必须的 parity 修复**：`better-sqlite3` **忽略**语句里没用到的命名参数，`node:sqlite` 默认抛
`Unknown named parameter`。`FactsDao.purgeArchived` 正好给一条不含 `purgeModifier` 的语句传了这个键，
于是生命周期 tick 整体挂掉（实测：整套 27 个用例连带失败）。适配器按参考驱动的语义调用
`setAllowUnknownNamedParameters(true)`，而不是让每个 DAO 去预过滤参数。

**发布面**：`better-sqlite3` 从 `dependencies` 移到 `optionalDependencies`。这不是"少装一个依赖"，
而是**失败语义**：作为普通依赖时它的 postinstall 失败会让整单 `pnpm add` 非零退出、宿主把 profile
回滚（`dsh: plugin command failed`）；作为可选依赖时同一次失败只意味着"这个包没构建好"，pnpm 正常
收尾、插件照常安装，由上面的回退接管。两条路径都在本机跑过（§4.2 与 §4.3）。工作区锁文件里只有一处
随之变化：`mem/packages/plugin` 的 importer 把 `better-sqlite3` 从 `dependencies` 挪到
`optionalDependencies`（`pnpm-lock.yaml`，无其它解析变化）。

### 2.2 组合包：让 Desktop 的界面能装

- `mem/packages/plugin/package.json` / `mission/packages/plugin/package.json`：新增
  `dsh.bundle.patch: "./cordis.patch.yml"`，把该文件加进 `files`，并在 `exports` 里暴露它
  （与 `@deepseek-ai/dsh-base` 等官方组合包同一套写法）。
- 新增 `mem/packages/plugin/cordis.patch.yml` 与 `mission/packages/plugin/cordis.patch.yml`：一个
  `- insert:` 层，把插件行插进 profile。
- **装完不需要再手写那一行**（实测）：`dsh plugin add <本包>` 之后，profile 的
  `dsh.profile.bundles` 会自动多出本包，随包的 patch 把行插好；Desktop 的「插件」页是同一机制。
  只有 npm / yarn 安装，或手工编辑 profile 包清单而没有选中组合包时，才需要自己写那行。
- **两条都做也不会挂两次**（实测）：配置树里会出现两行同 id 的条目，但 loader 按条目 id 去重，
  插件只挂载一次（`plugin ready` 只出现一次）。仍是二选一更干净。
  > 2026-10-02 复审补记：去重只是 **0.1.7 / 0.2.0 线** 的行为；`^0.1.5-rc.2` 线（本包 peer 仍覆盖）
  > 上的 loader 对重复行 id 直接抛 `duplicate loader entry id`，profile 树加载失败——两条都做在那里
  > 是**起不来**，不是挂两次。随包 README 与 `cordis.patch.yml` 注释已按此改写。

### 2.3 mission：`$DSH_HOME`

`mission/packages/plugin/src/index.ts` 的 `sessionsRoot` 默认值从 `join(homedir(), '.dsh', 'sessions')`
改为 `join(dshHome(), 'sessions')`（`$DSH_HOME` 优先，未设置时仍是 `~/.dsh`）——与
`scripts/link-profile.mjs`、`scripts/workspace-doctor.mjs` 同一条规则。Desktop 会显式设置 `DSH_HOME`，
`/archive`、`/clean` 读的是同一份会话库，不该靠"默认值恰好相等"。

### 2.4 base：`binary-archive` 保留归档里的真实文件名

`base/plugin-base/src/providers/archive.ts` 的 `install` 之前把找到的可执行物落成 `bin/<声明名>`；
现在落成 **`basename(found)`** 并把它写进 `install.json` 的 `entry`（`probe`/`verify` 本来就以 manifest
的 entry 为准，所以解析侧不需要第二条规则）。新增回归用例
`base/plugin-base/test/archive.spec.ts`：归档里是 `demo.exe`、spec 声明 `demo` → 落盘 `bin/demo.exe`、
manifest `entry: bin/demo.exe`、`resolve()` ready。

### 2.5 文档

- `mem/packages/plugin/README.md`、`mission/packages/plugin/README.md`（随包发布的 npm 页）：安装步骤改为
  **钉版本**、挂载写成两条路、新增「DSH Desktop」小节、环境要求里写清存储层的回退顺序。
- `mem/CHANGELOG.md`：`[Unreleased]` 记录这轮改动 + 一条装机维护提示（minimumReleaseAge）。
- `mem/DESIGN.md` §19：新增「两个驱动，一个端口」段落（为什么、探测语义、契约一致性、发布面），并把
  "唯一 import better-sqlite3 的文件"改成两个适配器的表述。

---

## 3. 为什么 Linux 不受影响（**历史：第 1 轮"两个驱动"下的分析，已被 §6 取代**）

| 改动 | Linux 上的实际行为 |
| --- | --- |
| `node:sqlite` 适配器 | **不会被选中**：探测先试 `better-sqlite3`，能开就用它，代码路径与改动前逐字相同 |
| 探测本身 | 进程内一次 `:memory:` 开/关；`better-sqlite3` 真出问题时（库损坏/被锁）**不回退**，照旧报错，不掩盖故障 |
| `AVANTF_MEM_SQLITE_DRIVER` | 不设置就不生效；非法值会明确报错而不是静默取默认 |
| `better-sqlite3` 移入 optional | Linux 上仍默认安装并优先使用；只有"它构建失败"从"整单失败"变成"退化" |
| 组合包声明 | 声明的只是"被选中时提供哪些行"；选中由安装动作触发，挂载结果与手写同一行等价。既有用户升级后若同时手写过那一行，配置里会多一行冗余，实测 loader 按 id 去重、只挂载一次 |
| `$DSH_HOME` | 未设置时值与 `~/.dsh` 相同；设置了才是修好（此前是不管设置与否都用 `~/.dsh`） |
| base 的落盘改名 | 只在"归档内文件名 ≠ 声明名"时生效；POSIX 上恒等，既有用例逐字通过 |

---

## 4. 验证记录

### 4.1 Linux（WSL Debian，node 22.23，全局 `@deepseek-ai/dsh@0.2.0-rc.2`）

先把 `HEAD` 原样取出到 `/tmp/baseline`（`git archive`，只读、不碰任务树），在那里建立**基线**；再把
本次改动的文件覆盖到 `/tmp/current`（同一文件系统、同一套依赖）跑对比——这样"改动导致的差异"与
"`/mnt/e` 这个 9p 文件系统导致的差异"能分开看：

| 运行 | 结果 | 说明 |
| --- | --- | --- |
| 基线 `/tmp/baseline`（`HEAD`，better-sqlite3） | **6 failed / 496 passed** | 6 条全是 `document_text`/`knowledge` 的 pandoc 转换用例（WSL 没装 pandoc，`AVANTF_MEM_AUTO_DOWNLOAD=0`） |
| 改动后 `/tmp/current`（better-sqlite3） | **6 failed / 521 passed** | 与基线**同一批 6 条**，新增 25 条全绿 → 零回归 |
| 改动后 `/tmp/current`（`AVANTF_MEM_SQLITE_DRIVER=node`） | **6 failed / 521 passed** | 与 better-sqlite3 **逐条相同**：整个引擎在回退驱动上等价 |
| 直接在 `/mnt/e` 任务树跑 | 17 failed | 多出的 11 条是 9p 文件系统下的超时/时序用例；**同一份代码在 ext4 上只有那 6 条**——与本次改动无关 |
| `pnpm guard` | ok | `mem, mission reach only the base and their own trees` |
| `pnpm release:check` | ok | 三个可发布包、base 在插件之前、只有一份 zod、无 `link:`/`file:`（含新的 `files`/`exports`/bundle 字段与 optionalDependencies） |
| `pnpm build:dsh mem` | ok | tsc + tsdown（`lib/index.js` 633 KB / `lib/client.js` 266 KB） |
| `pnpm build:dsh mission` | ok + **MOUNT SMOKE OK** | 挂载冒烟 |
| `pnpm pack:plugin:mem` | **PACK OK** | 自包含断言：引擎已内联、生产依赖都被真正 import、README 首行是包名、`lib/` 无游离文件（`cordis.patch.yml` 随包） |
| `pnpm pack:plugin:mission` | ok | 同上 |
| `pnpm -C base/plugin-base test`（含新增用例） | ok | `archive.spec.ts` 8/8 |

**最后一次验收**（所有改动落地、base 修复重新打包之后）在同一个任务树里整轮重跑，结论不变：
`pnpm guard` ok、`pnpm release:check` ok、`pnpm build:dsh mem` ok、`pnpm build:dsh mission` ok +
`MOUNT SMOKE OK`、`pnpm -C base/plugin-base test` **377/377**、`pnpm pack:plugin:mem` / `:mission` ok。

### 4.2 Desktop（Windows，Electron 44，profile `desktop` 的兄弟 profile `probe2`）

用一个**独立 profile**（`--from-default-profile web --profile probe2`）复现 Desktop 的真实路径，
不碰用户的 `desktop` profile：

1. `allowBuilds: better-sqlite3: true`（**放行**构建，让它真的失败）→ 安装**仍然保留全部依赖**、
   pnpm 正常收尾（这是 optionalDependencies 的意义；作为普通依赖时同一场景会回滚）。
2. `dsh.profile.bundles` 里加上 `@avantf/dsh-mem`、`@avantf/dsh-mission`，`cordis.patch.yml` 保持**空**。
3. 启动（`AVANTF_HOME` 指向临时目录，不动用户数据）：两行都由**组合包**插入，两个插件都挂载：

   ```
   [avantf-mission] INFO registered 9 tools: create_mission, …, cancel_mission
   [avantf-mission] INFO engine ready: concurrency=11 depth=8 failure-budget=5 children<=6
   [avantf-mem]  INFO runtime init: … sqlite=node:sqlite (Could not locate the bindings file. Tried:
                 (no binding for node-v149 on Electron 44.0.0))
   [avantf-mem]  INFO memory: schema upgraded 0 → 9 (applied: 1 base-schema, … 9 contradiction-resolved-indexes)
   [avantf-mem]  INFO knowledge: schema upgraded 0 → 2 (applied: 1 base-schema, 2 chunk-derived-state-provenance)
   [avantf-mem]  INFO runtime ready in 70ms (embeddings warm asynchronously)
   [avantf-mem]  INFO plugin ready: 8 tools + avantfMemory service + avantfMem remote
   ```

   工具是**正常注册**（不是 `DEGRADED`），`memory.db`/`knowledge.db` 连同 WAL 文件真的落在磁盘上，
   嵌入模型也下载并加载成功（`semantic: embedding model ready … dim=512`）。nodejieba 不可用 → 正则
   抽取降级（Windows 上属预期）。

### 4.3 pandoc（base 修复）

修复前：Desktop 上 `mem:pandoc` 被隔离，日志为 `quarantined …\tools\pandoc\3.11: …\bin\pandoc 的
--version 探针失败`；把隔离文件复制成 `pandoc.exe` 后 `pandoc 3.11` 正常输出，证明"文件对、名字错"
（隔离目录里那一份确实是 `pandoc.exe` 的内容，只是被落了名字 `pandoc`）。

修复后（用本地打包的 base 装进独立 profile `probe3`，同样放行构建并让它失败）：

```
[avantf-mem] INFO envinit: mem:pandoc installed (installed 3.11)
%TEMP%\…\tools\pandoc\3.11\bin\pandoc.exe   233626888 bytes
install.json: "entry": "bin/pandoc.exe"
```

同一个已装好的实例在第二次启动时被认作 `mem:pandoc present (managed 3.11)`，不再是"每次下载、
每次隔离"。`install.json` 的 `entry` 就是解析依据，所以修复不需要第二套命名规则。

---

## 5. 没做的事 / 遗留（**历史：写于第 1 轮，其中"回退"相关条目已被 §6 取代**）

- **未提交、未改版本号。** 按"纯修复 → patch"的约定，发版时建议 `mem 0.3.2`、`mission 0.2.3`、
  `base 0.3.2`（base 的改动只动 provider 实现、不加接口成员，**不需要** `INTERFACE_VERSION` +1）。
  发布顺序仍是 base → 插件。
- **`node:sqlite` 是实验特性**：部分 Node 版本会在首次使用时打一行 `ExperimentalWarning`。免 flag 的
  下限是 Node 22.13 / 23.4，而适配器依赖的"忽略未用命名参数"要 22.15 / 23.11（见 §6）——低于该下限
  **不再有 `better-sqlite3` 这条路**（它已被移除），宿主会降级挂载：工具回 `memory unavailable: <原因>`。
- **CLI/MCP 的 pandoc 解析仍写死 `bin/pandoc`**（`@avantf/mem-provision` 的 `managedPandocPath`）。
  Desktop 走的是 base 的 provider，本轮已修好；没有 DSH 宿主的 CLI/MCP 在 Windows 上要装 pandoc 才能
  转换文档，这一条留待后续一并收口。
- **任务树是 CRLF，`HEAD` 是 LF，且没有 `.gitattributes`**（Windows 检出造成，与本次改动无关）。后果：
  `pnpm release:check` 这类按 `^…\n` 锚定解析 YAML 的门禁在 Windows 任务树里会误报"没有 `packages:`"。
  本次把**改动过的文件**归一化成 LF（于是 `git diff` 只显示真正的改动），另加**一个**被门禁直接解析
  的文件 `pnpm-workspace.yaml`（内容零改动，只是把 CRLF 换成 `HEAD` 里的 LF）——归一化之后
  `release:check` 在本任务树里直接通过。其余文件保持原样，没有做全仓换行符批量改写。
- **验证用的临时环境已清理**：profile `probe`/`probe2`/`probe3`、`%TEMP%\avantf-desktop-test*`、
  `%TEMP%\dsh-desktop-test` 与 `/tmp/baseline`、`/tmp/current` 都已删除；只留下一个副作用需要知会——
  第一次探测（还没把 `AVANTF_HOME` 隔离到临时目录时）在用户默认数据根 `~/.avantf` 下建了
  `configs/`、`knowledge/`、`memory/`、`prompts/` 四个默认目录，它们是插件的正常首次初始化产物，
  未做改动。
- **既有用户升级后**：`dsh plugin add` 会自动选中新增的组合包。自己手写过挂载行的人会看到配置里多出
  一行同 id 的条目（实测只挂载一次，不报错）；想干净就把手写的那行删掉，交给组合包。

---

## 6. 后续：数据库系统统一（2026-10-01，同日）

**决定。** 上面 §2.1 的"两个驱动"被**一个实现**取代：`better-sqlite3` 从实现、manifest、catalog 与
`allowBuilds` 里全部移除，引擎只跑运行时自带的 `node:sqlite`（`db/sqlite.ts` = 一个适配器 + `db/port.ts`
的端口）。一并删除：`db/sqlite_node.ts`（并入 `db/sqlite.ts`）、`db/binding.ts`（驱动选择器）、
`AVANTF_MEM_SQLITE_DRIVER`、`test/sqlite_backend.spec.ts`（重写为 `test/sqlite_adapter.spec.ts`）、两个
manifest 的依赖、catalog 条目、`allowBuilds` 条目、`@types/better-sqlite3`。

**判据。** NAN 绑定**在原理上无法统一**：每个 Electron ABI 都要一份自己的产物，等于把"一个数据库系统"
换成"一条 artifact 供应链"；而内置模块就在跑插件的那个进程里（实测 Node 22.23 = SQLite 3.51.3、
Electron 44 = 3.53.1，两边 FTS5 + `trigram` 都在），没有 ABI 可对不上，也没有第二条需要被证明"行为一致"
的代码路径。性能不构成理由：5000 行/100 事务插入 52–56ms(node:sqlite) vs 62–66ms(better-sqlite3)、
5000 次点查 72–80 vs 62–64、FTS 持平。

**下限。** `engines.node = ">=22.15.0 <23 || >=23.11.0"`：内置模块免 flag 是 22.13 / 23.4，而适配器依赖的
"忽略语句未用到的命名参数"（`setAllowUnknownNamedParameters`，DAOs 共用一份参数对象是既定用法，
`FactsDao.purgeArchived` 是那条）到 22.15 / 23.11 才有。低于下限、或该构建缺 FTS5 的宿主照常挂载，8 个
工具回 `memory unavailable` 并报出原因——**不会**拖垮宿主启动。

**探测接进了打开路径**（本轮自查发现并补上的一处）：`sqliteProbe()` 开一个内存库、建一张 fts5 表、再试绑
一次多余命名参数；三条拒绝分支由假模块单测覆盖。`openSqlite` 在碰任何文件之前先问这个判决（每进程一次），
所以不满足的运行时是"打不开库并说明原因"，而不是"跑到 schema 迁移或 lifecycle tick 才炸"。

**验证（本仓，ext4）：**

| 运行 | 结果 |
| --- | --- |
| `pnpm -C mem/packages/core test` | **518 passed / 38 files**（含新的 `sqlite_adapter.spec.ts`） |
| `pnpm build:dsh mem` | ok + **MOUNT SMOKE OK**（8 个工具；degraded 挂载用例仍给出原因） |
| `pnpm build:dsh mission` | ok + **MOUNT SMOKE OK** |
| `pnpm -C mem typecheck:dsh` | ok |
| `pnpm -C base/plugin-base test` | **377 / 377** |
| `pnpm guard` | ok（mem、mission 只够得到 base 与自己的树） |
| `pnpm pack:plugin:mem` | **PACK OK**（tarball manifest：`engines` 在、无任何 SQLite 依赖） |
| `pnpm release:check` | ok（三个可发布包、base 先于插件、只有一份 zod） |

**顺带核实的一条反面结论**（不属于本次改动，但同属"跨系统统一"这个题目，记下来免得再试）：**不要让
Windows 与 WSL 共写同一个 SQLite 文件。** 本机实测（文件放 `/mnt/e`；一侧 WSL node 22.23、一侧 Windows
原生 `node.exe` 25.2.1，四个写者各 200 笔 `BEGIN IMMEDIATE` 事务）：WAL 下 400 笔只落 **200** 笔、DELETE
下只落 **306** 笔，而**四个写者全部报成功、`integrity_check` 仍为 ok**；同 OS 并发与跨 OS 串行都无损。
要统一数据，走内容层（知识库的逐字 `.md` + git），不要走共享库文件。

**未做**：未提交、未改版本号。按"可观察行为变 → minor"，发版时 mem 记一次 minor；`base` 的
`INTERFACE_VERSION` 不需要动（本次没有新增/改动接口成员）。
