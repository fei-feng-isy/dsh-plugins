# AGENTS.md

整个工作区的约定。一个仓库、**三个可发布包**：

| 目录 | 包 | 是什么 |
| --- | --- | --- |
| `base/plugin-base` | `@avantf/dsh-plugin-base` | DSH 插件的底座：启动期资源预装（声明式 provisioner）+ 宿主兼容门禁 + 共享 kit，运行期零依赖 |
| `mem/packages/plugin` | `@avantf/dsh-mem` | DSH 的记忆/知识插件：可长期检索的记忆 + 文档知识库（8 个模型工具、两个主窗口标签页） |
| `mission/packages/plugin` | `@avantf/dsh-mission` | DSH 的任务树插件：把一件能连验收标准一起交出去的事交给引擎，由它后台逐级派给一次性执行者 |

其余工作区包（`@avantf/mem-*`、`@avantf/mission-core`、CLI/MCP）都是 `private: true`，会被内联进使用它的
那个插件。每个子树的领域设计仍写在自己的 `DESIGN.md` / `docs/` 里。

本文只放**三个包 / 三棵树都成立**的公共约束；**各树专有的约定**写在各树的开发 README——
`base/README.md`、`mem/README.md`、`mission/README.md`（三份**随包发布的** README 是 npm 页面，面向用户，
不写仓库内部内容）。

## 发布面

- **可发布集合恰好是这三个包**；`scripts/release-check.mjs` 会在这件事不成立时失败。
- **发布顺序 base → 插件**：插件的**普通运行期依赖**必须已在 registry 上（可 `--allow-missing-base` 试跑）；
  `publishConfig.access` 是 `public`。
- **base 是插件的普通 `dependencies`**（同一个宽区间 `>=0.3.0 <1.0.0`，两棵树**逐字相同**，禁 `~`/精确版本），
  所以**装插件就自动带上底座**、用户不需要知道有 base。dsh 给每个 profile 写 `autoInstallPeers: false`，
  peer 不会被补装，所以这里**不能用 peer 表达"宿主提供"**。**一份副本由「两棵树同区间」保证**：实测
  pnpm isolated / pnpm hoisted（dsh profile 自己的设置）/ npm flat 下，只要两棵树区间相同，base 物理副本
  都恰好 1 份，两个消费者解析到同一路径；**区间一旦不同就会出现第二份**——所以 `release-check` 把
  "两树区间逐字相同"当**硬断言**（不同即失败），不是 WARNING。`devDependencies` 里保留同一条区间只为让
  本仓 `pnpm install` 链到 workspace 的 `base/`；宿主安装时解析的是发布出去的那条 `dependencies` range。
- **只有一份 `zod`**：由**宿主**提供——三棵树都声明 **required peer** `>=4.4.3 <5`（下限已实测跑通）；本仓
  自己解析的那份来自根 catalog（改 catalog、不改发布区间），免得副本分叉 schema 类型身份；`release:check`
  断言两棵插件树这一点。
- **dsh 侧 peer 是「每条 minor 线一个 `||` 子句」的链**：现状
  `^0.1.5-rc.2 || ^0.1.7-rc.2 || ^0.2.0-rc.2`（**真实下限 `0.1.5-rc.2`**，`check:old-dsh` 就跑它）。启动门按
  `peerDependencies` 判兼容、不兼容就**禁用那一行**（不是告警），判定用 `includePrerelease: true`，故 caret
  覆盖整条 minor 线——**新出现一条 minor 线（如 `0.3.0-rc.x`）就补一条 `|| ^0.3.0-rc.x`**；`pnpm check:dsh-lines`
  会指出漏了哪条线。补声明前先按 `check:old-dsh` 与本机门禁实测能跑，再发 patch。
- **发布直接从 dev 仓做**（RC 投影已废除）：RC 原本的三件事（排除发布工具、版本盖章、生成 README）改为
  **发布前断言**，在 dev 树里必须成立才允许 `publish`。
- **用户安装面**：两个插件随包声明组合包（`dsh.bundle.patch` → 随包的 `cordis.patch.yml`），`dsh plugin add`
  会把它选进 profile 的 `dsh.profile.bundles`、由 patch 插入挂载行（组合包与手写行**二选一**）；**安装请钉
  版本号**——pnpm ≥ 10 的 `minimumReleaseAge` 会避开刚发布的版本，解析到的旧版本可能不认当前宿主、被安装
  门禁拒绝并回滚那一单。安装 / 升级 / 卸载的用户说明在各包**发布 README**，装机面全貌见
  `docs/desktop-compatibility.md`。

## 家族的三条硬约束

1. **被 provision 的代码既不打包、也不静态 import。** 插件对 base 的唯一静态引用，是 vendor 进
   `packages/plugin/src/envinit-bootstrap.js` 并**内联**进产物的零依赖 bootstrap；一句静态的
   `import ... from '@avantf/dsh-plugin-base'` 就会让 base 缺席时插件模块加载失败，而那正是插件绝不能
   有的失败。
2. **base 随插件自动装、按 file URL 动态加载。** 启动时 bootstrap 用
   `createRequire(import.meta.url).resolve('@avantf/dsh-plugin-base/package.json')` 从**插件自己的依赖树**
   解析它、动态 `import()`、用内联的 `supportedRange` 校验版本；缺失或超出区间 → 一条 `envinit: WARNING`，
   插件照常挂载。
3. **发布有序、路径干净。** 细则见「发布面」（先 base 后插件；已发布 manifest 里永不出现 `link:`/`file:`）。

## base 缺失、或运行时 base **更旧**时的降级

**判定是非对称的**（细节见 `base/plugin-base/docs/INTERFACE.md` §3）：`loaded < required`（运行时 base **更旧**）
→ `incompatible`，按本表降级；`loaded > required`（宿主 base **更新**）→ `ok` + 一条 WARNING，**照常使用全部
能力、不降级**（世代是纯增量，旧插件要用的成员一定还在）；`cannot-tell` 只告警。

| 能力 | base 不可用（或**更旧**）时 |
| --- | --- |
| 提示词文件层 | 用插件**内置的默认正文**（那是插件自己的内容，不是 kit 的副本） |
| 兼容门禁 | 一条 `compat:` WARNING，门禁跳过。裁决语义不变：只有**被证实**的不兼容才拒载，"说不清"只是备注，版本差异只是警告 |
| 资源 provision | 旧的 `@avantf/mem-provision` / legacy tools 目录 |
| 工具 / service / Remote / UI | 不受影响 —— 插件完整挂载 |

## 家族的统一失败口径：环境故障降级，绝不杀宿主

**实测的三种 loader 行为**（详见 `mission/docs/startup-failures-2026-09-20.md`）：① `apply` 抛错、或返回被
`await`/`return` 的 rejected promise → **只该行 FAILED、宿主照常起**（0.1.7/0.2.0 线）；② `apply` 里留下的
**未处理 rejection** → `installFailLoud` 接管 → **exit 1**（所有受支持版本）；③ **0.1.5 线**（真实下限）任何
未激活行都会让 boot 抛错——那一代没有 required 名单。

**因此家族口径**：环境故障（存储域打不开、资源缺失…）→ **降级挂载**：插件照常挂载、日志一条响亮的
ERROR/WARN、工具面回答"未就绪 + 原因"、`/mem` · `/mission` 命令报告同一原因；**绝不留下未处理 rejection、
绝不 terminate 宿主**。在 `apply` 里做异步初始化时：**要么 await/return、要么把 rejection 收进自己的降级
状态**——**绝不用 `void promise` 悬着**（那正是 mission 曾经"注释说行失败、实际进程 fatal"的形态）。

## 新增插件怎么用 base

- **装载**：唯一静态引用是 vendor 并**内联**的零依赖 bootstrap；用 `@avantf/dsh-plugin-base/bootstrap` 的
  `loadFramework()` 解析 → 校验版本 → 动态 import。**源码里绝不静态 import 本包**。
- **取用**：`PromptFiles` / `familyHome` / `resolveDataHome` / 兼容门禁（`provision` / `verdictOf` /
  `gatherEvidence` / `compatReport` / `verifyRegisteredFaces`）/ `checkInterface` 等，都从**加载到的那个模块**
  上取，不复制、不内联。`.` 是显式列举的稳定子集（成员归置与 `./internal` 的规矩见 `base/README.md`）。
- **接口世代**：`checkInterface(required, module)` + `readInterfaceRequirement(url)` 比对"构建时所对"与
  "运行时加载到"的世代；构建期把自己的世代 bake 进 `lib/interface-version.json`。
- **降级义务**：非对称判定与逐项降级见上文「降级」一节——任何情况下**绝不拒载**。
- **要动四处**（构建入口是**发现式**的：新目录自带 `build:dsh` 即可 `pnpm build:dsh <目录名>`，`scripts/`
  一个字不用改）：① 根 `pnpm-workspace.yaml` 的 `packages:`；② `scripts/release-check.mjs` 的可发布集合；
  ③ 插件 manifest（base 放 `dependencies` + 同区间 dev、`build:dsh`、`scripts/mount-smoke.mjs`、`files` 带
  `lib/interface-version.json`）；④ 依赖版本写进根 catalog（`pnpm guard` 自动适用，不用登记）。

## 共享逻辑：归谁 + 怎么抽

**归属判据只有一句：这条知识必须能靠一次 base 发版修好吗？**

- **能 → base 拥有它**，插件在运行时从加载到的模块上取。今天从 base 取的有：兼容门禁（`gatherEvidence` /
  `verdictOf` / `compatReport` / `provision` / `verifyRegisteredFaces`）、envinit provisioner 与三个 provider
  工厂（archive / model / npm）、`PromptFiles`、家族与数据路径解析、接口门禁（`checkInterface` /
  `readInterfaceRequirement`）。
- **不能 → 留在插件里**，但要在本文写明，并接受"改它需要一次**插件**发版"。已记录的本地知识：Typert
  `strict` codec 与端点 / 字段 / 结果符号那几行（wire 面在模块加载时拼装，两棵树各留本地镜像）；插件自己的
  logger（base 解析之前就要用）；各插件的 compat SPEC 与 envinit item 清单；各插件内置的默认提示词正文与
  client 半边。
- **刻意的镜像**：两个路径约定各有三份、正本都是 `base/plugin-base/src/kit/family.ts`——
  **家族根**（`familyHome`）：`@avantf/mem-contract`（`src/family.ts`，**无依赖**——CLI / MCP 没有 DSH
  宿主、从不加载 base）与 `mem/packages/provision`（`src/config.ts`，**依赖自由**——provision 跑在
  base 之前/之外）；跨树 pin 钉正本 ↔ contract，provision 那份的 `~/` 分支由 `family_paths.spec.ts`
  直接覆盖；改它 = 一次 base 发版 + 一次 mem 引擎改动。**数据根**（`resolveDataHome`）另挂两份：
  mem 引擎（`core/src/config/paths.ts`）与 mission 的 base-less 兜底（`plugin/src/prompt.ts`），
  分别由 `mem/packages/plugin/test/family_pin.spec.ts` 与 mission 的 `prompt_files.spec.ts` 对
  linked base 钉住；改它 = base、mem、mission 三处都要跟。
- **两个插件绝不互相 import**（连相对路径也不行），共享一律走 `base/`。刻意不复用：两个内核
  （`@avantf/mem` / `@avantf/mission-core` 不共享领域模型）、两个 client 半边、各插件的 item 清单与 SPEC。

**抽到 base 的次序**（不然旧插件会被判不兼容；细节与完整清单见 `base/plugin-base/docs/INTERFACE.md`）：

1. **先升接口**：`INTERFACE_VERSION` +1，并重落接口快照与两份名单（世代编号、快照文件与命令见
   `base/README.md`）。接口与包版本是**两条轴**：换代只动接口编号，包版本按普通 semver 走。
2. **再实现**（放 base）并补**跨树行为测试**：从**已链接的 base** 取真实实现比对，mock 里断言不算。
3. **向前兼容是硬要求**：新成员必须**增量**——不改既有成员的形状与语义；顺序敏感的参数用具名对象
   （`resolveDataHome({ explicit, env, configured })`）；可观察文案归调用方（`compatReport` 的 `words`）。
   一次增面绝不能让谁降级、更不能让谁拒载；发布按正常顺序，插件方便时重建以消费新能力。

## 版本：每组只记在一个 manifest 里

| 组 | 版本记录在 | 组内其余 manifest |
|---|---|---|
| `base` | `base/plugin-base/package.json` | 无；另有一份 **baked 常量** `src/bootstrap.ts` 的 `VERSION`（零依赖 bootstrap 不能在运行期读 manifest） |
| `mem` | `mem/packages/plugin/package.json` | `mem/package.json` + `packages/{core,contract,convert,provision,retrieval-core,cli,mcp}` |
| `mission` | `mission/packages/plugin/package.json` | `mission/package.json` + `mission/packages/core` |

```bash
pnpm version:set <group> <x.y.z>   # 只改该组那一个 manifest；base 组会一并同步 baked VERSION
pnpm version:check                 # 打印三组版本；私有 manifest 长出 version、或 base 两处不一致就报错
pnpm version:prune                 # 删掉私有 manifest 上多余的 version
```

**版本号说什么**：接口变 → `INTERFACE_VERSION` +1（与包版本解耦）；业务流程 / 可观察行为变 → minor；纯修复 →
patch。`workspace:*` 指到的私有包，版本只在 `pnpm pack` 那一刻临时写进、`finally` 还原。

## 发布 README 与 CHANGELOG 的内容要求

随包发布的 README 就是 npm 页面（`pack-plugin.mjs` 断言它随包、且首行是包名），只写**这个包本身**：

- **base**：包是什么 → 主要功能 → 怎么用（含示例）→ 接口要点。
- **mem / mission**：插件是什么 → 主要功能 → **怎么接入 dsh** → 怎么用；以功能、使用与示例为主，
  **不写实现细节与仓库内部内容**。
- **不要写**：谁在用它、发布顺序、这个包由哪些包合并而来、catalog / rc / 发布门禁这类仓库内部内容；
  也不要指向**不随包发布**的仓库文档（`docs/DESIGN.md`、`docs/INTERFACE.md`、`INSTALL.md` 等）。
- 计数按实测写（工具个数、提示词段数）；发布文档里出现过期数字属于缺陷。

**CHANGELOG 只写用户可观察的插件行为**（对外 API / CLI / 模型工具 / 面板 / 发布面 / 升级行为）。仓库内部与
开发流程不进——门禁脚本、CI job、测试基建、审查与重构都不算插件功能，用户看不见它们。判据一句话：
**用户装了这个包之后，行为会不会变？**

## 构建与门禁

```bash
pnpm build:dsh            # 全部插件（按目录名字典序）；每个都会先构建 base
pnpm build:dsh mem|mission   # 只构建某个插件（含挂载冒烟）
pnpm build:dsh base       # 只构建 base（tsc）
```

| 命令 | 它证明什么 |
| --- | --- |
| `pnpm version:check` | 每组版本只记在它的可发布 manifest 里；base 的 manifest 与 baked `VERSION` 一致 |
| `pnpm guard` | 每棵树只够得到 base 与自己的包（不许 import 别棵树；相对路径不许出树——唯一例外是工作区共用的 `scripts/lib/`；产物里不许按值 import base；其余 `@avantf/*` 必须是本树自己的） |
| `pnpm release:check` | 可发布集合恰好那三个、base 是普通依赖且区间够宽、两棵插件树区间逐字相同、只有一份 zod、无 `link:`/`file:`、registry 上已有兼容的 base，**且那个已发布 base 内置的接口世代不低于两棵插件 bake 的世代**（版本区间 ≠ 接口世代） |
| `pnpm proof:base-swap[:mount]` | 产物里没有静态 base import / 内联 kit；**被替换的** base 仍能提供提示词读写、根解析与接口门禁 |
| `pnpm release:check:<base\|mem\|mission>` | 该包自己的门禁：链接 → 编译 → 类型检查 → 测试 → pack，`old-dsh` **最后**跑（要重新链接并重建）；mem 的 build 必须先于 typecheck（`typecheck` 通过产出的 `lib/*.d.ts` 读依赖） |
| `pnpm check:old-dsh <base\|mem\|mission>` | 在该包声明的 dsh peer **下限**上重跑 LOCAL 步骤（含 `test:dsh` 与 mount smoke），完事恢复现场；`release:check` 已内置这一步 |
| `pnpm check:dsh-lines` | dsh **已发布**的版本里有没有我们的 peer 覆盖不到的（同一份 semver + `includePrerelease: true`）；有新 minor 线或 dist-tag 落到未覆盖线就退出 1，并给出该补的 `\|\|` 条款 |

**改 `base/**` 后两棵树都要回归**（base 自己的测试不会走到挂载），**并检查根 `scripts/prove-base-swap.mjs`**——
它双向断言接口判定语义（更新的世代 → base 保留、runtime 交回；更旧的世代 → 判 `incompatible`、扣留并出
"shared capabilities are NOT used" WARNING）。**改 `checkInterface` 的判定语义时，三处一起看**：两棵树的
`interface.spec.ts`/`envinit.spec.ts` 与 `prove-base-swap.mjs`。

**验证分工**：**执行者只做针对性验证**——改动涉及的构建/类型检查 + **只跑新增或改动的那几个测试文件**，并
报告"实际跑了什么 / 每个测试证明了哪条要求 / 有哪些没能验证"；**收口由派单方分档统一跑**，不重复验证。

**收口分两档**（命令由 `scripts/check-tier.mjs` 提供，见 `docs/RELEASING.md`；两档**去重**：一条流程里测试
只跑一次、base 只构建一次）：

| 档 | 什么时候用 | 覆盖 |
|---|---|---|
| **快档** `pnpm check:fast [树名]` | **日常每个派发任务结束后**（默认档；不给树名从 git 自动判） | **只被改动的那棵树**：build + typecheck + 该树**一次**全套测试 + `guard` + 四个自测 + `prepublish:assert`。**不跑** old-dsh / pack / mount smoke / 根 `release:check` |
| **发版档** `pnpm check:release` | 只在发版前，或**改了 `base/**`**（要求两棵树回归 + mount smoke + `proof:base-swap`）、改了发布面/接口/门禁脚本/版本号时 | 三个包的严格门禁（含 pack 与 **old-dsh 下限门**、两棵树 mount smoke）+ 根 `release:check` + `prepublish:assert` |

**纪律**：不要"每次收口都跑发版档"。快档**不证明**"产物能挂载""在 dsh 下限上能跑""发布面自洽"——这些只在
发版档覆盖。

**测试替身要镜像契约，不是镜像实现**：假 service、假时钟按**真实接口**的形状与语义写，能用真实包跨包钉死
就用真实包。照实现猜测写假替身会让形状/时序错误在测试里隐形（实测教训：`filterEvents` 的过滤器真实契约是
`{kind:'time'|'text'}` 对象；排队等待用例必须推进时钟才可信）。

**分布敏感 / 碰撞敏感的行为，fixture 必须复刻真实语料的"形状"**：只复刻"1 条正确答案 + 1 条干扰项"会把
依赖语料**长度分布**或**字面碰撞**的行为测成假绿。fixture 必须含：① 与真实库同量级的长度分布（真实形状 =
"短事实 + 一堆长文本"，事故库中位 313 字符）；② **含关键碎片字面串**的无关条目（如改写查询引入的三元组
`用户是` 抢走唯一词法命中）；③ 一条**反事实断言**（把那个碎片删掉 → 结果应回正）作为 fixture 自检。
任何"只在合成小语料上绿"的检索改动都不算验证通过。

**读 schema 库（zod）内部别猜**：用 `def.shape` / `def.values` / `z.toJSONSchema(..., { io: 'input' })` 这类
公开形状读取，别读私有实现（三棵树都适用；mem 侧的形状断言在 `contract.spec.ts` / `tool_schema.spec.ts`）。

## 体量与枢纽文件（hub）

**口径**：`base/mem/mission` 下 `git ls-files` 的 `.ts/.tsx`，排除 `test/` 与 spec。超过 800 行的就是各树的
枢纽——问题不是"大文件多"，而是少数**枢纽**被反复改动。**各树的枢纽清单与其取舍写在各树 README**：
`base/README.md`、`mem/README.md`、`mission/README.md`。

**规矩（跨树通用）**：① **触及枢纽时，若正在加的关注点能干净分离，就顺手抽成独立模块**（`claims.ts` /
`continuation.ts` / `prompt.ts` / `hybrid.ts` / `dispatch.ts` / `coldResume.ts` / `reconcile.ts` /
`dao/facts.ts` 都是这么来的），**不专门开重构线**；② **不为"变小"做整体重构**——行为被测试、**被冻结的评测集
数字**、提示词正文与 wire 格式钉死，一次性重构的静默漂移风险大于收益；③ 名单只作观察、**不做门禁**：本仓没有
行数限制，也不打算加。

## 边界与路径

- `AVANTF_HOME` 设的是**家族 / 受管根**（否则 `~/.avantf/env`；资源在 `<root>/tools`、`<root>/models`）。
- **数据根**按家族分层：⑤ 显式实参 → ④ `$AVANTF_HOME` → ② profile 里配置的 `dataHome`（配置值）→
  `~/.avantf`；用户数据与可编辑文本住在那里（`memory/`、`knowledge/`、`configs/*.yaml`、`prompts/*.md`）。
  `configs/common.yaml` 里那条 `dataHome` **不参与**：那个文件在数据根之内，解析根时还没读到它。
- 两个半边必须给出同一个答案：base kit 的 `resolveDataHome({ explicit, env, configured })` 与 mem 引擎
  那份是同一条规则，由 `mem/packages/plugin/test/family_pin.spec.ts` 跨树钉住；两个插件对**自己的** profile
  `dataHome` 也必须同层（配置值走 ② 层、绝不当显式实参传），mem 侧由 `data_home.spec.ts`、mission 侧由
  `prompt_files.spec.ts` 钉住。
- 数据文件永不搬出 `~/.avantf/{memory,knowledge}`；用户**编辑**的一切都住在 `~/.avantf/configs/*.yaml`
  与 `~/.avantf/prompts/*.md`，绝不放在数据库旁边。
- **家族共享提示词目录**：`<数据根>/prompts/` 由家族各插件共用、按**文件名前缀**归属（mem `mem-*`、
  mission `mission-*`），每个插件只碰自己清单里的文件，目录里其它 `.md` 不读、不写、不删；**文件全文就是
  提示词**（无 frontmatter），启动时读一次，缺失或为空时写入内置默认，base 缺席时用插件内置的默认正文。
  各插件的文件清单与软检查见 `mem/README.md` / `mission/README.md`。

## 各树约定

各树**专有**的开发约定只在各树的开发 README 里（本文不重复，避免两处真相）：

- `base/README.md` —— 接口世代与 `api/interface-vN.json` 快照流程、kit 成员归置、`base/**` 枢纽"最后动"、
  base 自身的门禁与契约。
- `mem/README.md` —— 契约唯一真源、检索编排不许分叉、融合定序与证据要求、嵌入空间迁移与表示指纹、
  `eval_zh` 冻结数字、类型检查顺序、工具面 8 个、`mem/CHANGELOG.md` 段落规则、mem 枢纽清单。
- `mission/README.md` —— 调度语义 v1、worker 清理四步与 `keepWorkers` 保留、mission 枢纽清单。

## 架构裁决记录（第五轮架构审查，2026-10-03）

复审原文不入库。以下为当时**明确「不做」**的裁决，不要重开：

- client 信封拆解进 base `./client` 子路径——会打破"改共用代码只发一版 base"这条唯一判据。
- mem UI 打包管线向 mission 的 esbuild+CSS-in-TS 收敛——**第三块面板出现前定论**。
- 复审列的「顺手做」一组（host 抽 Remote 投影、mem client 按面板拆、`tree.ts` 两刀、`gateway.ts` /
  `store/legs.ts`、`db/vectors.ts` 搬家、`plugin/src/provision.ts` 改名）——**触及即抽，不专门开工**。
- `Manifest.requires.providers` 的第四方装载故事（`loadProvider`）——**等第一个真实的仓外 provider**。
- `facts.ts` 按查询形状拆、`provisioner.ts` 拆闭包、`compat.ts` 拆五段、两棵树持久化统一、kit 成员清退——
  都有"**不变量必须同住 / 编排不变量最密**"的理由，拆分收益为负。
- provision 与 base envinit 两套栈：**冻结并存**（provision 是 sha256 + 双 rename，弱于 base 的族根锁 / pid
  权威 / 慢持有告警）——**不半拆**（半拆会让 CLI 失去自动装 pandoc）。
