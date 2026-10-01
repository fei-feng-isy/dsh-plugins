# 发布手册（RELEASING）

> 面向：给 `avantf-mem` 打版本 tag、发布 npm 包、或把插件装进一个 DSH profile 的人。
> 相关：`docs/INSTALL.md`（安装）、`docs/DSH_INTEGRATION.md`（宿主集成）、`AGENTS.md`（架构不变量）、
> `docs/PROVENANCE_REVIEW.md` / `docs/PERFORMANCE_*_REVIEW.md`（改动依据）。

## 1. 一条命令：`pnpm release:check`

```bash
pnpm release:check                  # 打 tag 时用（严格）
pnpm release:check --allow-uncut     # 切版本节之前的预跑：同一批门禁，只是不要求 CHANGELOG 已切
```

它按顺序跑，**任何一步失败即整体失败**：

| 步骤 | 覆盖 | 备注 |
|---|---|---|
| preflight（元数据） | 版本只记在可发布包的 manifest 里、**私有包不带版本**（开发树 8 个私有包；发布树仍 4 个：contract / retrieval-core / core / plugin——convert 与 provision 都被内联，不单独发布）、CHANGELOG 的**第一个**版本节就是当前版本、`[Unreleased]` 已清空、插件声明了 DSH peer、**可发布的只有 plugin** | 打 tag 前真正会忘的两件事；包清单从 `packages/` 目录派生，发布树少两个包也不会崩 |
| `pnpm install --frozen-lockfile` | 锁文件与 CI 一致 | CI 用的是同一条命令 |
| `pnpm build` | 7 个引擎包（contract/retrieval-core/core/convert/provision/cli/mcp） | |
| `pnpm typecheck` | 引擎包的 **src + test** | 测试类型也是门禁（见 AGENTS.md） |
| `pnpm test` | 检出里所有包的测试（开发树 8 个） | 发布树没有测试源码，这一步自然消失；`packages/plugin` 的默认运行只含 **harness-free** 的 10 个 spec（见下） |
| `pnpm test:dsh` | 插件里**需要 DSH peers 才能加载**的两个 spec（`test/provision.spec.ts` / `test/envinit.spec.ts`，都经 `src/provision.ts` 拿到 `@deepseek-ai/dsh-tools` 的**值导入**） | **仅本地**：CI 的树里没有 `@deepseek-ai/*`，加载即失败，所以 `vitest.config.ts` 把这两个排除在默认运行之外；`build:dsh` 会跑它 |
| `pnpm typecheck:dsh` | 插件的 src + test（对着已安装的全局 dsh 的类型检查） | **仅本地**：CI 没有 dsh |
| `pnpm build:dsh` | 插件 `tsc + tsdown`，随后 `pnpm test:dsh`、**mount smoke**（真实 Cordis 上下文 + 降级挂载）；先跑 `link-dsh` 从已安装的 dsh 软链邻居包、`link-envinit` 从安装副本 vendor 底座 bootstrap，构建后 `assert-envinit-artifacts` 断言 bootstrap 已内联；client preset 用仓库自带的 pin 住的副本 | **仅本地** |

第 5–8 步（链接 / `test:dsh` / `typecheck:dsh` / `build:dsh`）**只对着已安装的全局 `dsh`**
（`npm i -g @deepseek-ai/dsh`）。编译**不需要 harness 源码**：tsdown 的 client preset 是仓库自带的 pin
住的整份副本 `packages/plugin/vendor/dsh-client-preset/`（8 个文件 / 2334 行，取自带 revision 的
harness，逐字节拷贝；`ORIGIN.md` 记了来源与重新对齐步骤），`tsdown.config.ts` 按字面相对路径 import
它，不经过任何 checkout 解析，也没有 env 开关。因此 `DSHHARNESS=/nonexistent pnpm build:dsh` 也能成功。
副本只在与 harness 对应文件逐字节相等时才可信，所以本地恰好有 checkout 时 `link-dsh` / `release:check`
会做逐个字节比较：漂移就打出文件与两侧 revision，并指向 `ORIGIN.md`（`link-dsh` `WARNING`、
release-check `note:`，不是硬失败——checkout 领先于 pin 是重新对齐前的正常状态）；也可单独跑
`node scripts/check-preset-drift.mjs`（有漂移时 exit 1）。**没有 checkout 时这个比较什么都不打印**，
因为那只是可选核对、不是编译依赖。把副本改成「按需精简」是不允许的：它定义浏览器半边的 ABI
（module loader factory、`PLATFORM_MODULES`、构建环境 defines、CSS 管线），而浏览器半边没有自动化
覆盖（mount smoke 只测宿主半边），删改会静默产出加载不起来的包。

**为什么后三步只能在本地跑**：插件依赖 `@deepseek-ai/dsh-tools` / `dsh-typert-protocol` /
`dsh-system-prompt`，这些包的传递依赖并非全部发布到 npm（`packages/plugin/node_modules/@deepseek-ai`
是 `scripts/link-dsh.mjs` 从已安装的全局 dsh 软链出来的），所以 CI 只能跑到
"harness-free 的单元"（工具 schema 推导、Remote 信封解码、prompt 段落文本）。**边界画在"值导入"上**：
`import type` 被擦除、CI 安全，而 `src/provision.ts` 的 `defineTool` 是值导入——
`test/provision.spec.ts` 与 `test/envinit.spec.ts` 因此**在 CI 的树里连加载都做不到**，
`packages/plugin/vitest.config.ts` 把它们排除在默认运行之外（那份常量是唯一的清单），
由 `pnpm test:dsh`（`build:dsh` 的一步）在本机跑。**插件最重要的性质——它
真的能在一个 DSH 宿主里 mount 起来——只有本地门禁守着**，因此打 tag 必须在跑过 `release:check` 的
那台机器上做，并把它输出的 `RELEASE GATE PASSED` 贴进 release notes 或发布 issue。

**对旧宿主（区间下限）的跨版本门**：上面所有 LOCAL 步骤都只对着**这台机器**装的 dsh，所以"这份产物在更旧的
宿主上还能不能跑"从新机器上看不出来——它要等到某个运维真的装了旧版才暴露，而那是最贵的发现时机。
`check:old-dsh` 把这件事变成一条命令：从插件自己的 dsh peer 区间取**下限**（当前 `0.1.5-rc.2`），在临时目录
装一份**全部钉在该版本**的闭包（`cordis` / `schemastery` 钉在本机当前链接的版本，好让 A/B 只差 dsh 包本身），
用 `npm_config_prefix` 让 `link-dsh` 指向它，然后跑该包的 LOCAL 步骤——`link-dsh` → `typecheck:dsh` →
`build:dsh`（含 `test:dsh` 与 mount smoke）——最后**无论成败都恢复现场**（重新 link 已安装的 dsh 并重建产物，
避免把产物留在"对下限编译"的状态）。闭包缓存在 `$TMPDIR/avantf-old-dsh-<group>-<floor>`（缓存键含**组名**：
base / mem / mission 在同一个下限上各有自己的闭包与假 global root，并发跑也不会互相删；`<group>` 就是
`base|mem|mission`），重复跑不重新下载。
实现是**工作区共用**的（`scripts/check-old-dsh.mjs <base|mem|mission>`），并且已经是 base / mem / mission 三个
`release:check` 的**最后一步**——它要重新链接并重建，所以必须排在 `pack` 之后。

```bash
pnpm check:old-dsh                              # 等价于 node ../scripts/check-old-dsh.mjs mem
pnpm check:old-dsh --list                       # 只打印下限与各 peer 区间
pnpm check:old-dsh --fresh                      # 重装缓存的闭包
pnpm check:old-dsh --floor 0.1.5-rc.2           # 显式指定下限（也可用来看某个更高版本，如 0.1.7-rc.2）
# 另外两组：node ../scripts/check-old-dsh.mjs base | mission
```

改提示层、加工具、动门禁时值得顺手跑一次：**区间是声明，这条命令是证据**。另外 `test/provision.spec.ts` 的
"healthy host" 用例改成显式构造"与构建目标一致的宿主"（`declared = runtime`）：src 运行时读不到
`lib/dsh-build.json`（烘焙落在 `lib/`），`declared` 会回退到区间**下限**，"healthy" 于是隐含假设"本机装的 dsh
恰好等于下限"——那只在区间刚为该版本抬过时成立，换台机器就把这条用例变红，而红的原因不是插件有问题。

### 1.1 一次发布的完整顺序（2026-09-21 发 0.1.1 实跑，可直接复刻）

**前置**：① 底座 `@avantf/dsh-plugin-base` 已发布，且插件的 peer 区间接受
registry 上那一版（`scripts/copy-envinit-bootstrap.mjs` 会在构建期用底座自己的 `satisfiesRange` 比对，
区间没跟上就构建立刻红）；② 工作区没有 `link:`/`file:`。**发布顺序是底座 FIRST、插件在后**：`release-check`
在发布插件前会确认 registry 上已有落在插件 peer 区间内的底座版本。

```bash
# 0) 起点干净、与远端一致
git status --short && git pull --ff-only origin master

# 1) 本轮的功能/修复各自先提交（发布提交只装版本与 CHANGELOG）
git add -A && git commit

# 2) 版本 + CHANGELOG：版本只改一处 —— 本包自己的 package.json（组内其余 manifest 不带版本号）：
pnpm version:set mem X.Y.Z
#    CHANGELOG.md 把 [Unreleased] 的条目移进新节 `## [X.Y.Z] - YYYY-MM-DD`，顶部留一个空的 [Unreleased]
#    （preflight 检查：版本只记在 packages/plugin 的 manifest 里、私有包不带版本 + 第一个版本节 == 包版本
#      + [Unreleased] 无 `### ` 条目）

# 3) 门禁（严格，不带 --allow-uncut）+ 打包冒烟
pnpm release:check                 # 必须打印 RELEASE GATE PASSED (X.Y.Z)
pnpm pack:plugin --mount           # 必须 PACK OK；产物 dist/avantf-dsh-mem-X.Y.Z.tgz

# 4) 发布提交 + tag + 推开发仓（tag 带组前缀：三个包共用一个仓库，vX.Y.Z 会互相撞）
git add -A && git commit -m "chore(release): X.Y.Z"
git tag -a mem-vX.Y.Z -m "avantf-mem X.Y.Z"
git push origin master --follow-tags

# 5) 同步发布树（整仓投影；版本默认取开发树，第 2 步已经改好；--gate 别放这一步，见 §2 的原生依赖说明）
pnpm sync:rc --yes --commit
# 发布树装出原生模块，再单独跑它自己的门禁（含三个包的门禁与 pack --mount）
( cd ../dsh-plugins-rc && (pnpm install --frozen-lockfile || pnpm rebuild) \
    && pnpm release:check:base && pnpm release:check:mem && pnpm release:check:mission )
# 发布树的 tag 同样带组前缀（base-vX.Y.Z / mem-vX.Y.Z / mission-vX.Y.Z）
git -C ../dsh-plugins-rc tag -a mem-vX.Y.Z -m "avantf-mem X.Y.Z"
git -C ../dsh-plugins-rc push --follow-tags

# 6) 只发一个包：先在发布树 pack 出 tarball，再用 npm 发它（分工与原因见 §2 的发布前提 1）
( cd ../dsh-plugins-rc && pnpm -C mem pack:plugin )
npm publish "$PWD/../dsh-plugins-rc/mem/dist/avantf-dsh-mem-X.Y.Z.tgz" --access public \
  --registry https://registry.npmjs.org/

# 7) 按 REGISTRY 反向确认，不要只信 CLI 的 ✅
curl -sS https://registry.npmjs.org/@avantf%2Fdsh-mem \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['dist-tags'], sorted(d['versions']))"
```

**第 7 步不是形式**：2FA 账号上 publish 可能被登记成**待批准的 staged 版本**——CLI 照样打印
`✅ Published package`，而版本端点先返回 404、再发同版本报 `409 Cannot publish over previously staged
version`。判定以 `dist-tags.latest` 与版本列表为准；staged 时等一会/在 npmjs.com 批准
（`npm stage list` → `npm stage approve <stageId> --otp=<code>`）；要无人值守，用勾了 **Bypass 2FA** 的
granular token（§2 的发布前提 2）。

**版本端点 404 有两种，别混淆**：① 上面这种 **staged 待批准**（`npm stage list` 能列出来）；②
**registry 已收下、正在异步处理**（发布后扫描）——此时 `npm publish` 的请求返回的是
`HTTP 202 Accepted`，CLI 打印 `Your package is being processed and may take a few minutes to become
available.`，而 `npm stage list` 会说没有 staged 版本。②只能等（2026-09-24 发 0.2.0 实测：3 分钟后
仍不可见），**不要重复发布**；鉴别看 `~/.npm/_logs/*-debug-0.log` 里的 `http fetch PUT 202 …`。

**上线后**：profile 里重启一次 `dsh web`（host 半边只在 boot 时加载），浏览器硬刷新或清该 origin 的站点
数据（client 半边按模块 id 缓存 bundle；模块 id 在改名/换版本时不会自己失效）。

## 2. 版本策略

- 开发树里的 8 个包（`@avantf/mem-contract` / `mem-core` / `mem` / `mem-convert` / `mem-provision` / `mem-cli` / `mem-mcp` / `dsh-mem`）
  **共用同一个版本号**：插件是引擎的薄壳（且把引擎内联进自己的 `lib/index.js`），版本各走各的只会制造
  "这是哪一版的引擎"的问题。`release:check` 的 preflight 会拦下不一致（清单从目录派生）。
- **发布树是 `dsh-plugins` 的整仓投影**（含 `packages/cli` 与 `packages/mcp`、含测试与文档）：
  投影只是把同一个仓库形态搬进 rc，所以 rc 里能跑与开发树相同的门禁；唯一不进 rc 的是 RC 工具链自己
  （`scripts/make-release-tree.mjs`、`scripts/sync-release-repo.sh`）。真正发布出去的仍然只有一个自包含插件包
  `@avantf/dsh-mem`（外加底座 peer），引擎与开发入口都是 `private: true`。
- **只发布 `@avantf/dsh-mem` 一个包**。另外 7 个在 manifest 里是 `private: true`（workspace-only），
  `pnpm -r publish` 碰不到它们；preflight 会断言"可发布的只有 plugin"，所以既不会误发引擎，
  也不会出现"插件悄悄变成 private 而没人发现"。DSH 用户装的是这一个插件包**加上**它的 peer 底座
  `@avantf/dsh-plugin-base`（npm 这类会自动装 peer；pnpm 关掉 `autoInstallPeers` 时要显式装），不需要装
  引擎包 `@avantf/mem*`。家族里可发布的还有底座与任务插件两个包，它们各在自己的目录/仓库发布（见 §1.1 前置）。
- semver：破坏性变更进 major，向后兼容的新增进 minor，修 bug 进 patch。候选版用 `X.Y.Z-rc.N`。
- **CHANGELOG 就是 release notes**：`## [Unreleased]` 里积累，打 tag 时把它改名为 `## [X.Y.Z] - YYYY-MM-DD`
  并在顶部留一个空的 `[Unreleased]`。`release:check` 会检查"第一个版本节 == 包版本"且 `[Unreleased]` 已清空。
- 打 tag：`git tag -a mem-vX.Y.Z -m "..." && git push origin master --follow-tags`（开发仓与发布仓都带
  组前缀 `base-` / `mem-` / `mission-`：三个包共用一个仓库，`vX.Y.Z` 会互相撞）。tag 之前必须先 `pnpm release:check`
  （见 §1 的原因）。
- npm 发布是独立动作，且**只发一个包**，分两步：**先 `pnpm pack:plugin` 产出 tarball，再用 `npm publish`
  发它**：
  ```bash
  pnpm -C mem pack:plugin        # 产出 mem/dist/avantf-dsh-mem-<ver>.tgz（含挂载冒烟与自包含断言）
  npm publish "$PWD/mem/dist/avantf-dsh-mem-<ver>.tgz" --access public \
    --registry https://registry.npmjs.org/
  ```
  **为什么不能直接 `pnpm --filter @avantf/dsh-mem publish`**：本仓的私有 manifest 按根 `AGENTS.md`
  「版本：每组只记在一个 manifest 里」的约定**不带 version**，pnpm 在 publish 的打包装阶段解析不出
  `workspace:*` 指向的版本，直接报 `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL: Cannot resolve
  workspace protocol of dependency "@avantf/mem" because this dependency is not installed`。
  `pnpm pack` 走 `scripts/lib/versions.mjs` 的 `withWorkspaceVersions`（打包那一刻把版本临时写进私有
  manifest、`finally` 还原），所以**只有它产出的 tarball** 已经把 `workspace:`/`catalog:` 落成真实范围；
  `npm publish <tgz>` 不再跑生命周期脚本、也不需要 workspace 解析。（2026-09-24 发 0.2.0 时踩到；
  版本载体约定引入后，旧的 `pnpm --filter … publish` 配方即失效。）
  **四条必须知道的发布前提**（2026-09-14 首次发布时都踩到了）：
  1. **registry 必须显式给**：开发/构建机上 `~/.npmrc` 的默认 registry 常是 `registry.npmmirror.com`
     （只读镜像），不带 `--registry` 的 `pnpm publish` 会打在镜像上并失败。
  2. **token 必须能绕过 2FA**：npm 的 granular access token 要在创建时勾选 **Bypass 2FA**
     （或者发布时用 `--otp=<6 位码>` 交互式发布），否则报
     `403 … Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`。
     把 token 放在 `~/.npmrc`（`//registry.npmjs.org/:_authToken=…`）或用 `NPM_TOKEN` 环境变量 +
     `.npmrc` 引用；用 `npm whoami --registry https://registry.npmjs.org/` 先确认身份。
  3. **作用域 `@avantf` 必须在 npm 上存在且属于发布账号**：否则 `PUT … - 404 Scope not found`
     （错误全文：`404 Not Found - PUT https://registry.npmjs.org/@avantf%2fdsh-mem - Scope not found`）。
     修法：在 npmjs.com → 头像 → **Add Organization** 建一个名为 `avantf` 的 org（公开包免费），
     之后同一账号即可发布 `@avantf/*`；或用账号自己的 scope（那要同步改包名、README、`cordis.patch.yml`
     的挂载名、profile 依赖与本文档）。
  4. **发布是一次 284 kB 的上传，链路不稳时会 `ECONNRESET` 或直接挂住**（本机实测：同一地址时而返回
     真实错误、时而超时 20s）。挂了就重试；反复失败就走代理（`HTTPS_PROXY=` / `~/.npmrc` 的
     `https-proxy=`），或把 `dist/avantf-dsh-mem-<ver>.tgz` 拿到能连 npmjs 的机器上
     `npm publish <绝对路径>/avantf-dsh-mem-<ver>.tgz --access public --registry https://registry.npmjs.org/`
     （tarball 的 manifest 已由 pnpm 把 `catalog:` 落成真实范围，直接用 npm 发也不会漏）。
     注意 `npm publish <相对路径>` 会被当成包名（报 `EALLOWGIT`），必须用 `./` 前缀或绝对路径。
     **判定发布成功的可靠依据**：npm 打印 `+ <pkg>@<ver>`，或 `~/.npm/_logs/*-debug-0.log` 里出现
     `http fetch PUT 200|201 https://registry.npmjs.org/…`。回读（`npm view` / jsDelivr / npmmirror）
     可能因为链路挂起或缓存滞后而失败——**不能据此认为发布没成功**（2026-09-14 首发即如此：
     PUT 200 但 `npm view` 挂住、jsDelivr 与镜像都还是 404）。
  发布前先 `pnpm pack:plugin`（或让 `release:check` 的最后一步带着 `--mount` 跑一遍），它断言这份
  tarball 自包含 —— 引擎已内联、`@avantf/*` 一个都不在依赖里。**同时确认 peer 范围与真实宿主一致**：
  `packages/plugin/package.json` 的 `@deepseek-ai/dsh-*` 范围就是"支持的宿主窗口"，换宿主版本必须
  重新跑一遍本地门禁再改这个窗口（它是**声明**，不是声明以外的任何保证）。

  **家族侧不再是 tarball 里的依赖**（本轮迁移）：家族底座 `@avantf/dsh-plugin-base` 是插件的
  **peerDependency**（peer 区间 `>=0.3.0 <1.0.0`；插件另在 `devDependencies` 里声明同一条 `>=0.3.0 <1.0.0`，
  `pnpm install` 即装上）——**绝不内联、也绝不随包发布**，`scripts/link-envinit.mjs`（`pnpm build:dsh`
  自动跑）从**安装副本** vendor 它零依赖的 `bootstrap`。底座**一个包**里装着启动期环境初始化框架与启动兼容
  门禁（从前独立的 `@avantf/dsh-envinit` / `@avantf/dsh-compat` 已并入它，两个旧包不再发新版本），所以没有
  `mem:compat` item、没有下载、也没有受管 compat 根；共享业务逻辑在运行时从底座那份取用，所以修共享代码
  只需发一次底座、不必重建插件产物（唯一例外是 `typert` `strict` wire codec 与少量字面描述符约定，改它们
  需要发插件）。发布顺序因此是：**先发底座、再发插件**——底座版本往前走时先发底座。
  要就地联调底座，用 `DSH_ENVINIT=<checkout> pnpm build:dsh`（不是工作区 `overrides`）；无论怎样，
  **打包/投影前工作区里都不能留 `link:`/`file:`**（`pack-plugin.mjs` 拒绝仍带这类 specifier 的 tarball，
  根 `scripts/make-release-tree.mjs` 拒绝投影这样的工作区）。
  底座的 zod peer 已放宽到 `>=4.4.3 <5`；`zod` 在**根** `pnpm-workspace.yaml` 的 catalog 里统一成一份
  （合并后是 `4.6.5`，跟随已安装 dsh 的版本），发布底座时不要把它改回只接受单一小版本。

**发布树要先装一次依赖**（2026-09-21 发 0.1.1 实测；2026-10-01 起不再涉及 SQLite 绑定）：`release:check`
的第一步是 `pnpm install --frozen-lockfile --ignore-scripts`，它只证明锁文件一致，**不会构建原生模块**。
一棵全新的 `dsh-plugins-rc` 上，mount smoke 会因为可选的 `nodejieba` / `hnswlib-node` 缺 binding 而走降级
路径——存储层已经没有原生模块，所以**不会**再因此判 FAIL；症状还可能被 mount-smoke 自身的错误行掩盖。
先装全再跑门禁：

```bash
cd ../dsh-plugins-rc
pnpm install --frozen-lockfile     # 注意：不带 --ignore-scripts
# node_modules 已存在时 install 会短路（"Lockfile is up to date"），此时用：
pnpm rebuild
pnpm release:check:base && pnpm release:check:mem && pnpm release:check:mission
```

## 3. 数据、升级与回滚

- 数据都在 `~/.avantf`（`AVANTF_HOME` 可覆盖）。**升级前先备份**：
  ```bash
  cp -a ~/.avantf ~/.avantf.bak-$(date +%F)
  ```
- **迁移是单向的**：每个 step 只实现 `up`（就地修数据），在打开库时自动执行；每个 step 与它的
  `PRAGMA user_version` 提升、审计行写入在**同一个事务**里，所以不会"半升级"。已应用的步骤记录在
  `schema_migrations`。
- **降级会被拒绝**：库的 `user_version` 高于当前代码已知的最大值时，打开会抛 `SchemaDowngradeError`
  （提示升级或从备份恢复），并且**在碰文件之前**就抛。这是刻意的——旧代码跑新 schema 是未定义行为。
  回滚的唯一正路是恢复 §3 的备份。
- 升级后**一次性代价**（不同版本各不相同，发布说明里要写清）：
  - v6（derived-state 溯源）：**所有带向量的 active 事实**一次性进入冲突检查队列（迁移刻意不回填
    `conflict_checked`，因为"活索引能否服务这行向量"数据库答不了）。`mem_admin trust_diagnose` 的
    `conflict_pending` 会显示落后量，用 `contradict_check` / `admin maintenance` / CLI 分批排空。
  - v8：对 `facts_fts` 做一次 `'rebuild'`（老库若在 FTS 触发器存在之前就有数据，FTS 腿本来是空的；
    这是把那份数据重新纳入检索）。
- 建议的升级自检（几分钟）：`mem_admin trust_diagnose`（`entities_stale` / `conflict_pending` 是否在下降）、
  `mem_admin vectors_diagnose`（`stale` / `space_stale`）、一次 `mem_recall search` 与一次 `kb_query`、
  以及 `admin maintenance`（它会各跑一趟有界的实体扫帚与冲突 drain）。

## 4. release notes 必须带上的已知限制

这些是**已记录、已接受**的边界，不能只留在 DESIGN 里：

- **2 字中文查询**：被 tagger 判为动词的 2 字词（`缓存`、`维护`…）没有任何腿可用（FTS 是 trigram，
  实体腿只收值得留的 tag）——已 pin 成缺口，见 DESIGN §20.18。
- **HRR probe 腿对 cap 不透明**：它的候选按共享实体数（或回退时的 recency）裁剪，所以"裁剪不会重缩放
  幸存者"对它不成立（DESIGN §20.17，双测覆盖）。
- **评测 `must_exclude` 0.657**：k=2 时尾位常是共享实体的相关事实（刻意去掉 min-max 的"最弱项归零"
  这个事实阈值后的取舍，DESIGN §20.17）。
- **未实现**：`quota` 配额、`kb_answer`（Plan A 不在插件内生成答案）、`faiss`/`pgvector`/`qdrant`
  （会**显式告警**的适配器接口）。
- **冲突队列的排空入口**是显式动作（`contradict_check` / `admin maintenance` / CLI）；心跳只跑实体扫帚。
- **单用户、无隔离**（by design）：一个共享库，不要拿它做多租户。
- **启动延迟的主因在宿主**：`dsh web` 的前端 combo 重组（55 个 bundle 反复重组 + 逐字符数换行）占了
  大部分；我们只修掉了自己那段同步分词，宿主侧三项改法见 DESIGN §20.14（未落地）。
- 尚未做过：长跑/浸泡测试、恶意输入模糊测试（摄入边界有专门测试，但不是模糊测试）。

## 5. 发布前人工确认（清单）

> 逐步命令见 **§1.1**；下面是"命令之外还要亲眼确认"的部分。

1. `pnpm release:check` → 全 PASS，且 preflight 没有告警；把输出留档。
2. 在一份**上一版的实盘库副本**上真跑一次升级：`upgrade → admin maintenance → contradict_check → search/kb_query`，
   确认 `trust_diagnose` / `vectors_diagnose` 的落后量在下降（§3）。
3. 在 DSH profile 里重启一次 `dsh web`：确认 8 个工具在（`mount-smoke` 会打印）、两页能打开、3 段 prompt 与 2 个条件 context 出现、日志无 error；
   **并确认一次"坏 dataHome"下的降级挂载**（工具返回 `memory unavailable: …` 而宿主照常起来）。
4. CHANGELOG 已改名并带日期；`[Unreleased]` 为空；版本与本检出里所有包一致（开发树 8 个 / 发布树 4 个）。
5. release notes 复制了 §4 的限制。
6. `git tag -a mem-vX.Y.Z` + push；npm 只发 `@avantf/dsh-mem`（命令见 §2），发之前确认 peer 窗口与真实
   宿主一致，并确认 preflight 里"可发布的只有 plugin"这条是 PASS。
