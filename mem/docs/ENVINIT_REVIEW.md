# 启动环境初始化交接审查（家族框架 `@avantf/dsh-envinit`）

> **范围**：`1856de5` 之上的**工作区未提交改动**——插件启动接线从"自己确保底座可用"改为向家族框架
> **声明 item**（`mem:compat` 阻塞 / `mem:pandoc`·`mem:model`·`mem:rerank` 后台）；`@avantf/dsh-compat`
> 由 `dependencies` 降为 `devDependencies`；`@avantf/dsh-envinit` 成为插件 **peer**（`^0.0.0`，对应
> 兄弟 checkout 的 `0.0.0`/`private`）；`packages/provision` 的 `compat.ts` 与 `runtimeDeps.ts`
> （含其 341 行测试）整体移除；新增 vendored 零依赖 bootstrap 与四个脚本；族根成为引擎的
> **layer ① 内建默认**（`RuntimeOptions.managedRoots`）。共 29 个文件（8 个新增；本审查自身新增的
> 文件见 §5，不计入这 29 个）。
> **状态**：审查完成，§5 的修复**已实施并回归**；§3 的两条为**框架侧**，本仓不动。
> **方法**：读完全部 diff（源码 / 脚本 / 文档）→ 端到端门禁实测（`build:dsh`、`pack:plugin --mount`、
> `typecheck`、`typecheck:dsh`、`test`）→ 三处**隔离/变异实验**：① 把 `packages/plugin/node_modules/@deepseek-ai`
> 移走（复刻 CI 条件）后跑插件测试；② 在兄弟 checkout `../dsh-envinit` 上核对迁移承诺（legacy
> `install.json` 认领、packument 信任锚、`fiber.uid` 语义）；③ 核对文档承诺与环境逃生口的真实生效路径。
> **结论**：迁移本身**干净**——获取/校验/原子落盘/锁这套机制整体搬到框架，且**信任锚没有丢**
> （packument 只从 registry 取、`dist.integrity` 强制且校验、tarball 才允许走镜像）。发现
> **1 条高**（H1：插件测试在 CI 条件下跑不起来——先于本次改动，但正落在改动中心）、
> **4 条低**（L1 环境逃生口、L2 分离 promise、L3 vendor 漂移检查、L4 迁移文档措辞）、
> **2 条框架侧观察**（O1/O2，本仓不修）。

---

## 0. 证据标签与门禁

| 标签 | 含义 |
|---|---|
| 【实测】 | 本次用命令/探针跑出的结果（命令与输出在条目内） |
| 【读码确证】 | 读码即可确定（语句形状、调用点、谓词） |
| 【推断】 | 机制确证，量级未测 |

**门禁（修复前，本机 dev 树）**：`pnpm build:dsh` exit 0（三档启动 profile 全绿）、
`pnpm pack:plugin --mount` → **PACK OK**、`pnpm typecheck` / `pnpm typecheck:dsh` / `pnpm test` 全绿，
插件 **112 tests / 12 文件**。

**隔离实验（H1 的证据）**：`mv packages/plugin/node_modules/@deepseek-ai /tmp/…`（复刻 CI：锁文件里
没有 `@deepseek-ai` 条目、`autoInstallPeers: false`、`ci.yml` 也不装它）→ 插件测试
`Test Files 2 failed | 10 passed (12)`、`Tests 5 failed | 92 passed (97)`，两个文件是**模块加载**
失败（`Failed to load url @deepseek-ai/dsh-tools … in src/provision.ts`），不是断言失败。

---

## 1. 高

### H1 插件测试在 CI 条件下**跑不起来**（先于本次改动，但正落在改动中心）

**现象**。`packages/plugin/test/provision.spec.ts`（自 `f0ea87c` 起）与**本次新增**的
`test/envinit.spec.ts` 都经 `src/provision.ts` 拿到 `@deepseek-ai/dsh-tools` 的**值导入**；
`src/provision.ts → src/remote.ts` 里其余 `@deepseek-ai/*` 都是 `import type`（被擦除），所以两个文件
恰好是唯二的受害者——【实测】移走 peers 后：`provision.spec.ts` **0 test collected**、
`envinit.spec.ts` **5/5 失败**，其余 10 个文件 92 个用例**全绿**。

**为什么这是"高"**。CI 的 "Test (all packages)" 对 `packages/plugin` 不可能通过（`pnpm -r` 默认
bail，插件排最后，前面全绿也白搭），而三处文档在说相反的话：
`.github/workflows/ci.yml` 末尾的注释（"Its harness-free units … run here like every other package's；
`packages/plugin/test` must stay clear of `@deepseek-ai/*` imports for that to hold"）、
`docs/RELEASING.md` §1（"所以 CI 只能跑到 harness-free 的单元"）、
`packages/plugin/vitest.config.ts` 的头注释（同一条规则）。**规则是对的，违反规则的文件没人拦**：
`provision.spec.ts` 违反在先（旧账），`envinit.spec.ts` 加入在后（本次），而 `src/envinit.ts` 又把
`src/provision.ts` 拉进了同一个模块图——以后任何触碰 envinit 的 spec 都会重蹈覆辙。

**修法**（§5 已实施）：让默认 `vitest run` 只跑 harness-free 的那 10 个文件，两个 peer 依赖 spec
改为本机门禁（新 `test:dsh`，接进 `build:dsh`），三处文档同步改成事实。

---

## 2. 低

### L1 pandoc 降级分支丢掉 `AVANTF_TOOLS_DIR`

`legacyToolsDir()`（`packages/plugin/src/index.ts`）自己拼内建默认
（`expandHome(DEFAULT_TOOLS_CONFIG.dir)`），而核心自己的 `setPandocProvisioning`（`runtime.ts:220`）
走的是 **env-aware** 的 `resolveToolsDir(parseToolsConfig(...))`，且 `pandocBinary()` 用 settings 里的
`toolsDir` **原样**（`packages/convert/src/pandoc.ts`：`ensurePandoc({ toolsDir: settings.toolsDir, … })`）。
所以"框架可用、但 `mem:pandoc` 失败/跳过"这条路上，运维设的 `AVANTF_TOOLS_DIR` 被静默忽略——
而 CHANGELOG、`docs/PROVISIONING.md` §3、`docs/INSTALL.md` §5 都写着该逃生口照旧生效。
【读码确证】：`resolveToolsDir` 先是 `AVANTF_TOOLS_DIR`，再 `expandHome(config.dir)`，从不看族根。
**修法**：改走 `resolveToolsDir(parseToolsConfig(rt.config.common.tools))`，只在结果仍等于
`env.roots.tools`（= 运维没选过）时才回退 `defaultToolsDir()`。

### L2 `void resources.ensure(...)` 是这批新代码里唯一没挂 `.catch` 的分离 promise

`packages/plugin/src/envinit.ts` 的 `provisionResources` 里，
`void resources.ensure({ only, onSettled })` 【读码确证】没有 `.catch`；框架的 `ensure` 没有顶层
try/catch（内部有 10 处守卫、后台项自带 catch，且 `ensure` 的消费者是"报告制"，所以**实际风险小**），
但 Node ≥15 的未处理拒绝是**致命**的，而本仓自己的规矩相反：`provisionToolchainAsync` 的注释写着
"detached promise 的拒绝没人接，严格宿主上会把进程带走"，`warmSemanticAsync` / `warmTokenizerAsync`
两个包装也都 catch 了。**修法**：补 `.catch` → 一行 WARNING（"拿不到资源"永远不该是挂载失败）。

### L3 vendored bootstrap 的漂移检查**只有版本号**

`scripts/bootstrap-version.mjs` 只正则抓 `export const VERSION`，而框架 private 期间 `VERSION` 恒为
`0.0.0`，于是 `link-envinit --check` 与 `copy-envinit-bootstrap.mjs` 区分不了"同一版本的不同构建 /
被手改过的副本"——与仓库对 `packages/plugin/vendor/dsh-client-preset` 的纪律（**逐字节** + sha256 对比，
`ORIGIN.md` 记来源）不成比例。缓解是真的（构建路径每次都重拷、`typecheck:dsh` 经链接的 `.d.ts` 能抓 API
漂移），但 `--check` 模式作为"只读核对"应当能发现内容漂移。**修法**：`--check` 下把
`src/envinit-bootstrap.{js,d.ts}` 与框架源（同一个 `stripSourceMap` 变换后）**逐字节**比较。

### L4 `docs/PROVISIONING.md` §6 的 `AVANTF_HOME` 措辞混了两个基准

§6 末尾："若用了 `AVANTF_HOME`，上面路径里的 `~/.avantf` 换成它，族根则是 `$AVANTF_HOME` 本身。"
三条路径只有一条半对【读码确证】：
① 族根：跟随 `AVANTF_HOME`（`resolveHome()`）——**对**；
② `~/.avantf/env/tools`、`~/.avantf/models`：**不跟随**（`expandHome` 用 `homedir()`，
`resolveToolsDir` 从不读 `AVANTF_HOME`）；
③ 旧私有根 `~/.avantf/dsh-compat`：跟随的是**数据家**（`resolveDataHome` 认 `AVANTF_HOME`），所以
它**会**跟着走——与 ② 相反。
照这句做的运维会把 pandoc / 模型搬到错地方（症状是重下一遍，不是坏事，但文档是错的）。
**修法**：把三条路径各自的基准写清楚。

---

## 3. 框架侧观察（本仓不动，供上游开 issue）

### O1 `unverifiable` 的受管副本会被直接 `import()`

框架的 npm provider 对**没有 `install.json`**（或缺 `integrity`）的受管版本目录只 warn 一次
（`providers/npm.ts`：`unverifiable: … 按可用处理`，"detects corruption but not a tampered source"），
本仓的 mount smoke 还**刻意**用这种副本证明"复用而非重下"（seed 的 `install.json` 不带 integrity）。
后果：同用户可在 `<home>/runtime/@avantf/dsh-compat/<version>/` 放一份任意代码，被装进宿主进程。
这是**刻意的**家族级取舍（威胁模型是同用户文件写），但它是**前排那道兼容门禁**的宿主。要收紧就得
在框架侧把"无记录 = 不可用（重取）"，然后重新 vendor 本仓副本。

### O2 `assertTarballUrl` 没有跟着迁移

上一轮为 `runtimeDeps.ts` 加的"tarball URL scheme 校验"（拒绝 `file:`、拒绝 http 降级，除非 registry
本身是 http）在框架的 npm provider 里**不存在**【读码确证：`src/providers/npm.ts` 只校验
`dist.integrity` 必需 + `verifyIntegrity` + 入口不出包目录】。真正封死"镜像自洽 packument + 自洽
tarball"那条 RCE 的是"**packument 只从 `spec.registry ?? DEFAULT_REGISTRY` 取** + integrity 强制"
（框架做到了，且镜像列表只喂 `archive` 下载），所以这是**纵深防御的净损失**而非缺口。值得上游补回。

---

## 4. 核对过、成立的三条"承诺"（避免误伤，特此记录）

1. **信任锚没丢**：`fetchPackument` 只向 `${registry}/${name}` 取（registry 默认 npmjs.org，插件不传
   镜像），`dist.integrity` 缺失即拒（"只有 shasum 的包一律拒绝"），tarball 校验后才 `import()`。
2. **迁移配方可信**：`docs/PROVISIONING.md` §6 说"旧 `install.json` 会被认领而不是重下"——
   `aliasLegacyManifest` 确把 `id→name`、`sha256→integrity`（hex→SRI）、`url→tarball`、
   `binary→entry=bin/<binary>`，而 legacy pandoc 写的正是 `{id, version, binary, url, sha256}`，
   且准入条件是 `manifest.version === spec.version` 与可执行物存在——**对得上**。
3. **`stillActive` 不是猜的**：`fiber.uid` 是 cordis 的真实生命周期标记（dispose 置 `null`，此后
   effect API 抛 `INACTIVE_EFFECT`），与注释一致；形状未知时按"活着"处理，最坏退回改动前的行为。

---

## 5. 修复记录（本次）

| # | 修法 | 验收（本次实测） |
|---|---|---|
| H1 | `packages/plugin/vitest.config.ts` 的 `PEER_DEPENDENT_SPECS` 是唯一那份清单：默认 `vitest run` 排除这两个 spec，新增 `vitest.dsh.config.ts` + `pnpm test:dsh`（只跑它们）由 `scripts/build-plugin.mjs` 调用；`ci.yml` 注释、`docs/RELEASING.md` §1/§2 同步 | 移走 peers（复刻 CI）后 `pnpm test` 的插件部分 **10 文件 / 92 用例全绿**；`pnpm test:dsh` **2 文件 / 21 用例全绿**（含 §L2 新增的那条） |
| L1 | `legacyToolsDir` 改走 `resolveToolsDir(parseToolsConfig(...))`，只在结果仍等于族根时回退 `defaultToolsDir()`；mount smoke 设 `AVANTF_TOOLS_DIR=<home>/tools-override` 并断言回退行**指向它** | `build:dsh` / `pack:plugin --mount` 日志：`envinit: falling back to /tmp/avf-mount-data-*/tools-override for pandoc` + `provisioning: OK (…回退到 AVANTF_TOOLS_DIR…)`（改回旧写法即红） |
| L2 | `resources.ensure(...)` 补 `.catch` → 一行 WARNING；`envinit.spec.ts` 新增"ensure 拒绝仍挂载 + 只告警"用例 | **变异验证**：去掉 `.catch` → `test:dsh` 红（1 failed + 1 unhandled error）；补回 → 21 用例全绿 |
| L3 | `link-envinit --check` 逐字节对比 `src/envinit-bootstrap.{js,d.ts}` 与框架源（同一个 `stripSourceMap`），不再只比 `VERSION` | **变异验证**：往 vendored `.js` 追加一行注释（`VERSION` 不变）→ `--check` exit 1；重跑 `link-envinit.mjs` → ok |
| L4 | `PROVISIONING.md` §6 写明三个基准：族根跟随 `AVANTF_HOME`、legacy tools/models **不跟随**、旧私有根跟随数据家 | 读码 |
| 小注 | `modelBootstrap.ts` 头注释与新不变量（底座是 devDependency、由框架预装、按文件 URL 装载）对齐；CHANGELOG `[Unreleased]` 记录本轮 | 读码 |

**回归（修复后）**：`pnpm release:check --allow-uncut` → **RELEASE GATE PASSED（8/8）**；
`pnpm typecheck` / `pnpm typecheck:dsh` 绿；`pnpm test` 全绿（contract 47 /
provision 29(+2 skipped) / convert 37 / retrieval-core 85 / **core 480** / **plugin 92（默认集）** /
mcp 8 / cli 14）；`pnpm test:dsh` 21；`pnpm build:dsh` 绿（含新增的 `test:dsh` 步骤、三档 mount profile、
envinit 产物断言）；`pnpm pack:plugin --mount` → **PACK OK**（两个变体，24 s）。
core 的 480 = 479 + 工作区在 21:34 给 `test/loader.spec.ts` 加的 `managedRoots` 那条用例，与本轮修复无关。

---

## 6. 小注（未改，知情即可）

- `packages/provision/lib/` 里残留 `compat.*` / `runtimeDeps.*`：`tsc` 不清理、`pnpm clean` 会清；
  `exports` 只声明 `"."`，所以它们**不可达**，不是活引用。（后续已手动删除。）
- 我跑 `pack:plugin` 留下的 `dist/avantf-dsh-mem-1.0.2.tgz` 是 gitignored 的正常产物。

---

## 7. 后续：模型项被真机启动否掉（2026-09-21，§1 清单随之变更）

§1 描述的清单里有 `mem:model` / `mem:rerank`（`model-cache`，后台）。第一次真机启动后撤回，原因是
**框架的 `model-cache` 布局与 `@huggingface/transformers@4.x` 读的布局不同构**，不只是"这次 mirror 不通"：

- 框架 provider 写 `huggingface_hub` 形状：`models--<org>--<name>/{blobs,refs,snapshots/<sha>}/…`；
- 运行时按 `<cacheDir>/<repo_id>/<filename>` 查文件：`buildResourcePaths()` 对 `main` 修订算出的 cache key
  就是 `<repo>/<file>`（`src/utils/cache/FileCache.js` 是唯一的 FS cache，整个包里没有任何 `models--` 代码）。

【实测】把一份完整 hub 布局放进**只有它**的临时 `cacheDir` → `pipeline()` 仍走网络并 `fetch failed`（10.5 s）；
同一时刻 `<cacheDir>/<org>/<name>/` 布局离线 **233 ms** 加载成功。

后果：声明该 item 只会下一份运行时永不读的副本，运行时再自己下一份（双下载、双磁盘），mirror 不可达时
每次启动留一条 `mem:model is failed`。**已撤回 `mem:model` / `mem:rerank`**：模型由引擎自己从
`semantic.cache_dir`（仍由 `managedRoots` 指向族根 `<home>/models`）加载并按 `semantic.auto_download`
获取；`ResourcePlan` 只剩 `pandoc`，`envinit.spec.ts` 断言"只注册 binary-archive、清单只有 `mem:pandoc`"。

> **第二次改判（框架 0.1.2，本节记录保持原样）**：上面的撤回是**框架布局**的问题，不是"模型不该是 item"。
> 框架 0.1.2 给 `model-cache` 加了中立的**落盘布局**维度（`spec.layout: hub | flat`），`flat` 把文件落到
> `<root>/<repo>/<file>`——正是运行时读的形状。于是 `mem:model` 重新成为 item（`flat` + 显式文件列表 +
> 镜像 `spec.endpoint`，后台派发，拿不到即降级），语义预热改为在该 item 的 `onSettled` 之后进行，
> 模型缓存/镜像也不再由终端用户的 `config.yaml` 决定（`semantic.cache_dir` / `semantic.mirror` 被忽略并
> 告警，只留 `AVANTF_MEM_MODEL_CACHE` / `AVANTF_MEM_MODEL_MIRROR` 环境逃生口）。

> **事后范围说明（框架发布后补记，上述记录保持原样）**：本审查写于框架发布**之前**，当时
> `@avantf/dsh-envinit` 只在兄弟 checkout 里（`0.0.0`/`private`），所以文中"peer 区间 `^0.0.0`"、peer 为
> `^0.1.0`，以及"从 `../dsh-envinit` 就地解析"都是当时的事实。框架随后发布到 registry（0.1.1，2026-09-21，
> `dist-tags latest=0.1.1`；0.1.0 因整包删除永久不可复用），插件随之改为消费 registry 安装副本：peer 与
> dev 区间都是 `^0.1.1`，本仓构建与运行都从 `packages/plugin/node_modules/@avantf/dsh-envinit` 取
> bootstrap，隐式发现兄弟 checkout 已删除，`DSH_ENVINIT=<checkout>` 只是显式的就地联调开关。本条只做范围
> 标注，正文不据此改写。
>
> **再补注（同日稍晚）**：`0.1.1` 随后也被整包删除，registry 上只剩 `0.1.2`（含 `model-cache` 的
> `flat` 布局）；本仓 peer 与 dev 区间已升到 `^0.1.2`，`packages/plugin/node_modules/@avantf/dsh-envinit`
> 是 registry 安装副本。上段记的 `^0.1.1` 是当时的现行值。
>
> **再再补注（框架 0.1.3 发布后补记，上述记录保持原样）**：`0.1.2` 随后也被整包删除，registry 上可装的
> 是 `0.1.3`（同样含 `model-cache` 的 `flat` 布局）；本仓 peer 与 dev 区间已升到 `^0.1.3`，并重新 vendor
> 了 `packages/plugin/src/envinit-bootstrap.{js,d.ts}`（0.1.3）。上两段记的 `^0.1.1` / `^0.1.2` 仍是各自
> 当时的现行值。

**续（同日）：框架升到 0.1.0，插件的 peer 区间没跟上。** 改名后重跑门禁才暴露：checkout 已是
`@avantf/dsh-envinit@0.1.0`（release 提交、去掉 `private`），插件仍写 `^0.0.0` → bootstrap 在启动时拒绝
就地解析到的副本，转 private/registry（404），框架整条链路降级为 legacy sweep。§1 记的 `^0.0.0` 因此只
是当时的事实；现在 peer 为 `^0.1.0`，并且 `copy-envinit-bootstrap.mjs` 增加了"bootstrap 版本 ∈ 声明的
区间"这条构建期断言（用框架自己的 `satisfiesRange`），补上了"两边一起动时不报错"的缺口。

**框架侧建议（O3）**：若要让框架接管模型，provider 需要一个"扁平布局"能力（把版本目录按
`<repo>/<file>` 暴露，或允许 `target.root` 声明 `<org>/<name>` 形状），否则运行时契约与框架契约对不上。
另（O4）：`unknown-error — fetch failed` 把裸网络错误（连接超时）与真正的未知错误混在一起，
`resolveRevision` 只包了 HTTP 非 2xx——建议一并归到 `fetch/failed` 并带上 errno，否则运维在日志里
分不清"mirror 不通"与"provider 有 bug"。
