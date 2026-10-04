# AGENTS.md

整个工作区的约定。一个仓库、**三个可发布包**：

| 目录 | 包 | 是什么 |
| --- | --- | --- |
| `base/plugin-base` | `@avantf/dsh-plugin-base` | DSH 插件的底座：启动期资源预装（声明式 provisioner）+ 宿主兼容门禁 + 共享 kit，运行期零依赖 |
| `mem/packages/plugin` | `@avantf/dsh-mem` | DSH 的记忆/知识插件：可长期检索的记忆 + 文档知识库（8 个模型工具、两个主窗口标签页） |
| `mission/packages/plugin` | `@avantf/dsh-mission` | DSH 的任务树插件：把一件能连验收标准一起交出去的事交给引擎，由它后台逐级派给一次性执行者 |

其余工作区包（`@avantf/mem-*`、`@avantf/mission-core`、CLI/MCP）都是 `private: true`，会被内联进使用它的
那个插件。每个子树的领域设计仍写在自己的 `DESIGN.md` / `docs/` 里。

## 发布面

- **可发布集合恰好是这三个包**；`scripts/release-check.mjs` 会在这件事不成立时失败。
- **发布顺序 base → 插件**：插件的 required peer 必须已在 registry 上（可 `--allow-missing-base` 试跑）；
  已发布的 manifest 里永不出现 `link:`/`file:`；`publishConfig.access` 是 `public`。
- base 只放 **required peer**（`>=0.3.0 <1.0.0`）+ 同区间 `devDependencies`，**绝不放 `dependencies`**
  （那会装出多份副本，跨副本的 registry 与类型身份会分叉）。
- **只有一份 `zod`**：由**宿主**提供——base 与 `@avantf/dsh-mem` 声明 **required peer** `>=4.4.3 <5`
  （下限已实测跑通）；本仓自己解析的那份来自根 catalog（改 catalog、不改发布区间），免得副本分叉 schema
  类型身份。**三棵树都把 zod 声明为 required peer**，`release:check` 断言两棵插件树这一点（区间文本不同只 WARNING）；
  mission 的 `zod` 曾标 optional，实测 `domain.ts`/`wire.ts` 是**运行期值 import**（53 处 `z.`），
  与 mem 同理由，**已改 required**（`>=4.4.3 <5`，与 mem 逐字相同）。
- **dsh 侧 peer 是"每条 minor 线一个 `||` 子句"的链**：现状
  `^0.1.5-rc.2 || ^0.1.7-rc.2 || ^0.2.0-rc.2`（**真实下限 `0.1.5-rc.2`**，`check:old-dsh` 就跑它）。启动门按
  `peerDependencies` 判兼容、不兼容就**禁用那一行**（不是告警），判定用 `includePrerelease: true`，故 caret
  覆盖整条 minor 线——**新出现一条 minor 线（如 `0.3.0-rc.x`）就补一条 `|| ^0.3.0-rc.x`**；`pnpm check:dsh-lines`
  会指出漏了哪条线。补声明前先按 `check:old-dsh` 与本机门禁实测能跑，再发 patch。

## 家族的三条硬约束

1. **被 provision 的代码既不打包、也不静态 import。** 插件对 base 的唯一静态引用，是 vendor 进
   `packages/plugin/src/envinit-bootstrap.js` 并**内联**进产物的零依赖 bootstrap；一句静态的
   `import ... from '@avantf/dsh-plugin-base'` 就会让 base 缺席时插件模块加载失败，而那正是插件绝不能
   有的失败。
2. **base 由宿主提供、按 file URL 动态加载。** 启动时 bootstrap 用
   `createRequire(import.meta.url).resolve('@avantf/dsh-plugin-base/package.json')` 解析它、动态 `import()`、
   用内联的 `supportedRange` 校验版本；缺失或超出区间 → 一条 `envinit: WARNING`，插件照常挂载。
3. **发布有序、路径干净。** 先 base，后插件；已发布的 manifest 里永远不出现 `link:`/`file:`。

## base 缺失、或运行时 base **更旧**时的降级

**判定是非对称的**（`e8e6ad5` 起，见 `base/plugin-base/docs/INTERFACE.md` §3）：`loaded < required`
（运行时 base **更旧**）→ `incompatible`，按本表降级；`loaded > required`（宿主 base **更新**）→ `ok` + 一条
WARNING，**照常使用全部能力、不降级**（世代是纯增量，旧插件要用的成员一定还在）；`cannot-tell` 只告警。

| 能力 | base 不可用（或**更旧**）时 |
| --- | --- |
| 提示词文件层 | 用插件**内置的默认正文**（那是插件自己的内容，不是 kit 的副本） |
| 兼容门禁 | 一条 `compat:` WARNING，门禁跳过。裁决语义不变：只有**被证实**的不兼容才拒载，"说不清"只是备注，版本差异只是警告 |
| 资源 provision | 旧的 `@avantf/mem-provision` / legacy tools 目录 |
| 工具 / service / Remote / UI | 不受影响 —— 插件完整挂载 |

## 家族的统一失败口径：环境故障降级，绝不杀宿主

**实测的三层 loader 行为**（2026-10-02，依据见第四轮审查的 X1 与 `mission/docs/startup-failures-2026-09-20.md`）：

1. 插件行 `apply` **抛错**、或返回一个被 `await`/`return` 的 rejected promise → **只该行 FAILED、宿主照常起**
   （0.1.7/0.2.0 线；`Entry._init()` 既不 await 也不 rethrow，`boot()` 只对 bootstrap include 与全局 required 名单抛错）；
2. `apply` 里留下的**未处理 rejection** → `installFailLoud` 接管 → **exit 1**，**所有**受支持版本；
3. **0.1.5 线**（真实下限）任何未激活行都会让 boot 抛错——那一代没有 required 名单。

**因此家族口径**：环境故障（存储域打不开、资源缺失…）→ **降级挂载**：插件照常挂载、日志一条响亮的 ERROR/WARN、
工具面回答"未就绪 + 原因"、`/mem` · `/mission` 命令报告同一原因；**绝不留下未处理 rejection、绝不 terminate 宿主**。
这是唯一在三种 loader 行为下都安全的策略（mem 一直如此；mission 在 X1 修复后 `host.start()` 也"永不 reject"，工具面走
`notReady`）。在 `apply` 里做异步初始化时：**要么 await/return、要么把 rejection 收进自己的降级状态**——
**绝不用 `void promise` 悬着**（那正是 mission 曾经"注释说行失败、实际进程 fatal"的形态）。

## 新增插件怎么用 base

- **装载**：唯一静态引用是 vendor 并**内联**的零依赖 bootstrap；用 `@avantf/dsh-plugin-base/bootstrap` 的
  `loadFramework()` 解析 → 校验版本 → 动态 import。**源码里绝不静态 import 本包**。
- **取用**：`PromptFiles` / `createPluginLogger` / `familyHome` / `resolveDataHome` / `strictCodec` / 宿主门禁
  （`provision` / `verdictOf` / `gatherEvidence` / `compatReport`）等，都从**加载到的那个模块**上取，不复制、
  不内联。
- **接口世代**：`checkInterface(required, module)` + `readInterfaceRequirement(url)` 比对"构建时所对"与
  "运行时加载到"的世代；构建期把自己的世代 bake 进 `lib/interface-version.json`。
- **降级义务**：base 缺席、或运行时 base **更旧**（`loaded < required`）→ 插件仍**完整挂载**（自带默认提示词
  正文、门禁跳过、legacy 路径），`incompatible` 只放弃 base 的共享能力；**base 更新**（`loaded > required`）→
  `ok` + 一条 WARNING、能力全用、**不降级**；`cannot-tell` 只告警。**绝不拒载**（逐项见上一节的降级表）。
- **要动四处**（构建入口是**发现式**的：新目录自带 `build:dsh` 即可 `pnpm build:dsh <目录名>`，`scripts/`
  一个字不用改）：① 根 `pnpm-workspace.yaml` 的 `packages:`；② `scripts/release-check.mjs` 的可发布集合；
  ③ 插件 manifest（required peer + 同区间 dev、`build:dsh`、`scripts/mount-smoke.mjs`、`files` 带
  `lib/interface-version.json`）；④ 依赖版本写进根 catalog（`pnpm guard` 自动适用，不用登记）。

## 共享逻辑：归谁 + 怎么抽

**归属判据只有一句：这条知识必须能靠一次 base 发版修好吗？**

- **能 → base 拥有它**，插件在运行时从加载到的模块上取。今天从 base 取的有：兼容门禁（规则 / 探针 / 裁决 /
  报告 / 注册后复查）、envinit provisioner 与三个 provider 工厂、`PromptFiles`、家族与数据路径解析、
  Typert 符号工具、接口门禁。
- **不能 → 留在插件里**，但要在本文写明，并接受"改它需要一次**插件**发版"。已记录的本地知识：Typert
  `strict` codec 与端点 / 字段 / 结果符号那几行；插件自己的 logger（base 解析之前就要用）；各插件的 compat
  SPEC 与 envinit item 清单；各插件内置的默认提示词正文与 client 半边。
- **刻意的镜像（实测三份）**：家族 / 数据路径解析有三份——`base/plugin-base/src/kit/family.ts` 是正本；
  `@avantf/mem-contract`（`src/env.ts`）留一份**无依赖**副本（CLI / MCP 没有 DSH 宿主、从不加载 base）；
  `mem/packages/provision`（`src/config.ts`）还有一份**依赖自由**副本（provision 跑在 base 之前/之外）。
  跨树 pin 钉住正本 ↔ contract；provision 那份的 `~/` 分支由 `family_paths.spec.ts` 直接覆盖。
  改它 = 一次 base 发版**加**一次 mem 引擎改动（三份都要跟）。
- **两个插件绝不互相 import**（连相对路径也不行），共享一律走 `base/`。刻意不复用：两个内核
  （`@avantf/mem` / `@avantf/mission-core` 不共享领域模型）、两个 client 半边、各插件的 item 清单与 SPEC。

**抽到 base 的次序**（不然旧插件会被判不兼容；细节与完整清单见 `base/plugin-base/docs/INTERFACE.md`）：

1. **先升接口**：`INTERFACE_VERSION` +1、新增 `api/interface-vN.json`，新成员写进 `.` 的接口类型与两份名单
   （`UPDATE_INTERFACE_SNAPSHOT=1 pnpm -C base/plugin-base test public-surface` 重落快照）。接口与包版本是
   **两条轴**：换代只动接口编号，包版本按普通 semver 走。
2. **再实现**（放 base）并补**跨树行为测试**：从**已链接的 base** 取真实实现比对，mock 里断言不算。
3. **向前兼容是硬要求**：新成员必须**增量**——不改既有成员的形状与语义；顺序敏感的参数用具名对象
   （`resolveDataHome({ explicit, env, configured })`）；可观察文案归调用方（`compatReport` 的 `words`）。
   旧插件遇到**更新**的世代是 `ok` + 一条 WARNING、**不降级**；只有遇到**更旧**的世代才按降级表挂载。
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

## 发布 README 的内容要求

随包发布的 README 就是 npm 页面（`pack-plugin.mjs` 断言它随包、且首行是包名），只写**这个包本身**：

- **base**：包是什么 → 主要功能 → 怎么用（可以有基础示例）→ 源码怎么编译。
- **mem / mission**：插件是什么 → 主要功能 → **怎么接入 dsh** → 怎么用。
- **不要写**：谁在用它、发布顺序、这个包由哪些包合并而来、catalog / rc / 发布门禁这类仓库内部内容；
  也不要指向**不随包发布**的仓库文档（`docs/DESIGN.md`、`docs/INTERFACE.md`、`INSTALL.md` 等）。
- 计数按实测写（工具个数、提示词段数）；发布文档里出现过期数字属于缺陷。

**CHANGELOG 的取材范围**（2026-10-03 用户定）：只写**用户可观察的插件行为**（对外 API / CLI / 模型工具 / 面板 / 发布面 /
升级行为）。**仓库内部与开发流程不进 CHANGELOG** —— 门禁脚本、CI job、检查档位（`check:fast`/`check:release`）、
审查文档、测试基建、重构与死代码清理都不算插件功能，用户看不见它们（`docs/CLOSURE-TIERS.md`、`RELEASING.md`
这类属于开发文档，也不进）。判据一句话：**用户装了这个包之后，行为会不会变？**

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
| `pnpm release:check` | 可发布集合恰好那三个、peer 是 required 且够宽、只有一份 zod、无 `link:`/`file:`、registry 上已有兼容的 base，**且那个已发布 base 内置的接口世代不低于两棵插件 bake 的世代**（版本区间 ≠ 接口世代；见 R1） |
| `pnpm proof:base-swap[:mount]` | 产物里没有静态 base import / 内联 kit；**被替换的** base 仍能提供提示词读写、根解析与接口门禁 |
| `pnpm release:check:<base\|mem\|mission>` | 该包自己的门禁：链接 → 编译 → 类型检查 → 测试 → pack，`old-dsh` **最后**跑（要重新链接并重建）；mem 的 build 必须先于 typecheck（`typecheck` 通过产出的 `lib/*.d.ts` 读依赖） |
| `pnpm check:old-dsh <base\|mem\|mission>` | 在该包声明的 dsh peer **下限**上重跑 LOCAL 步骤（含 `test:dsh` 与 mount smoke），完事恢复现场；`release:check` 已内置这一步 |
| `pnpm check:dsh-lines` | dsh **已发布**的版本里有没有我们的 peer 覆盖不到的（同一份 semver + `includePrerelease: true`）；有新 minor 线或 dist-tag 落到未覆盖线就退出 1，并给出该补的 `\|\|` 条款 |

**改动 `base/**` 之后两个插件都要回归**（base 自己的测试不会走到挂载），**并检查根 `scripts/prove-base-swap.mjs`**——
它同样钉住接口判定语义。2026-10-02 的非对称化造成过**三处**滞后的期望，全部已修：两棵插件树的
`interface.spec.ts`/`envinit.spec.ts`（`c2d44e0`），以及本脚本（`2880a59`——此后它**双向**断言：
更新的世代 → base 保留、runtime 交回；更旧的世代 → 判 `incompatible`、扣留并出 "shared capabilities are NOT used"
WARNING）。**改 `checkInterface` 的判定语义时，这三处一起看：**

```bash
pnpm build:dsh mem && node mem/scripts/mount-smoke.mjs
pnpm build:dsh mission && node mission/scripts/mount-smoke.mjs    # 或 pnpm -C mission release:check
```

**验证分工**：**执行者只做针对性验证** —— 改动涉及的构建/类型检查 + **只跑新增或改动的那几个测试文件**；
**收口由派单方统一跑**，但要**分档**（2026-10-03 用户反馈"每次收口太慢"，见 Q1）。执行者验证一遍、派单方再验一遍
是重复劳动；派单时要把这条写进验收，并要求执行者报告"实际跑了什么 / 每个测试证明了哪条要求 / 有哪些没能验证"。

**收口分两档**（命令由 `scripts/` 提供，见 `docs/RELEASING.md`；两条档位命令**去重**：一条流程里测试只跑一次、
base 只构建一次）：

| 档 | 什么时候用 | 覆盖 |
|---|---|---|
| **快档** | **日常每个派发任务结束后**（默认档） | **只跑被改动的那棵树**：build + typecheck + 该树**一次**全套测试 + `guard` + 四个自测 + `prepublish:assert`。**不跑** old-dsh / pack / mount smoke / root `release:check` |
| **发版档** | 只在发版前，或**改了 `base/**`**（要求两棵树回归 + mount smoke + `proof:base-swap`）、改了发布面/接口/门禁脚本/版本号时 | 三个包的严格门禁（含 pack 与 **old-dsh 下限门**）+ 两棵树 mount smoke + root `gate`/`release:check` |

**纪律**：不要"每次收口都跑发版档"——那正是收口变慢的原因（三棵树串行跑完整门禁 + 测试/构建重复）。
快档的取舍也要写清：它**不证明**"产物能挂载""在 dsh 下限上能跑""发布面自洽"，这些只在发版档覆盖。

**测试替身要镜像契约，不是镜像实现**：假 service、假时钟必须按**真实接口**的形状与语义写，能用真实包做跨包
钉死就用真实包。照着实现里的猜测写假替身，会让形状/时序错误在测试里完全隐形——2026-10-02 两次实测都栽在这上面：
懒查把 `filterEvents` 的过滤器传成元组（真实契约是 `{kind:'time'|'text'}` 对象；假实现照抄了错形状，于是"所有历史
任务都查不到"而测试全绿）；排队等待用例依赖真实经过的毫秒（必须推进时钟才可信）。

**分布敏感 / 碰撞敏感的行为，fixture 必须复刻真实语料的"形状"**（2026-10-04 自指排名事故的教训）：只复刻
"1 条正确答案 + 1 条干扰项"，会把**依赖性于语料分布**的行为测成假绿 ✗。凡结果取决于语料**长度分布**或**字面碰撞**
的行为，fixture 必须包含：① 与真实库同量级的长度分布（该事故里真实库 **80 条 active、中位 313 字符**；
"短事实 + 一堆长文本"才是真实形状）；② **含关键碎片字面串**的无关条目（该事故里干扰项正文恰好包含改写查询的
三元组 `用户是` ⇒ 抢走唯一词法命中）；③ 一条**反事实断言**（把那个碎片删掉 → 结果应回正），把它作为 fixture 的
自检，证明钉的是真病理而不是巧合。任何"只在合成小语料上绿"的检索改动都不算验证通过。

**发布直接从 dev 仓做，不再投影 RC**（2026-10-03 裁决，见文末「架构裁决记录」）：旧的 `../dsh-plugins-rc`
停在 work/ 时代、已废弃；RC 原本提供的三件事（排除发布工具、版本盖章、生成 README）改为**发布前断言**，
在 dev 树里必须成立才允许 `publish`。

## 体量与枢纽文件（hub）

实测（2026-10-02，复审 R1 一轮七条车道收尾后；**枢纽口径** = `base/mem/mission` 下 `git ls-files` 的 `.ts/.tsx`，
排除 `test/`、`*.spec.*`、`*.test.*`）：全仓 461 个源文件、105666 行（`git ls-files` 的全部 `.ts/.tsx/.mjs`），
其中 **>800 行的 10 个** —— 问题不是"大文件多"，而是少数**枢纽**被反复改动。

**这一版与上一版的不同**：上一版写"它们全部比上次更大"，现在**不再成立**——`host.ts` 因抽出 `coldResume.ts`
（371 行）**首次下降**（2275 → 2089）；mem 插件的 `index.ts` 因抽出 `reconcile.ts` 跌破阈值出榜（831 → 786）；
但 `tree.ts`（1859 → 1926）与 `MissionTreeView.tsx`（1126 → 1129）仍在长。名单（行数 / 备注）：

| 文件 | 行数 | 备注 |
|---|---|---|
| `mission/packages/plugin/src/host.ts` | 2089 | 长期回长的枢纽；本轮**首次下降**（N8 抽出 `coldResume.ts`） |
| `mission/packages/core/src/tree.ts` | 1926 | 状态机 + 持久化 + 投影 |
| `mem/packages/core/src/store/memory.ts` | 1731 | 含实测性能结论的 SQL/索引形状，慎动 |
| `mem/packages/plugin/src/client/index.ts` | 1678 | hyperscript 内联 UI，可按页面拆 |
| `mem/packages/core/src/store/knowledge.ts` | 1616 | 同上（SQL 形状慎动） |
| `base/plugin-base/src/provisioner.ts` | 1155 | base 枢纽，最后动 |
| `mission/packages/plugin/src/client/MissionTreeView.tsx` | 1129 | 面板 UI（执行者会话跳转 + 懒查后越过 800） |
| `mem/packages/core/src/db/dao/facts.ts` | 992 | |
| `base/plugin-base/src/compat.ts` / `conformance.ts` | 937 / 877 | base 枢纽，最后动 |

**规矩**：① **触及枢纽时，若正在加的关注点能干净分离，就顺手抽成独立模块**——`claims.ts` /
`continuation.ts` / `prompt.ts` / `hybrid.ts` / `dispatch.ts` / `coldResume.ts` / `reconcile.ts` / `dao/facts.ts`
都是这么来的，**不专门开重构线**；
② **不为"变小"做整体重构**：行为被测试、**被冻结的评测集数字**、提示词正文与 wire 格式钉死，一次性重构的
静默漂移风险大于收益；③ **`base/**` 的枢纽最后动**（改 base 要求两棵插件树都回归）。名单只作观察、
**不做门禁**：本仓没有行数限制，也不打算加。

## 边界与路径

- `AVANTF_HOME` 设的是**家族 / 受管根**（否则 `~/.avantf/env`；资源在 `<root>/tools`、`<root>/models`）。
- **数据根**按家族分层：⑤ 显式实参 → ④ `$AVANTF_HOME` → ② profile 里配置的 `dataHome`（配置值）→
  `~/.avantf`；用户数据与可编辑文本住在那里（`memory/`、`knowledge/`、`configs/*.yaml`、`prompts/*.md`）。
  `configs/common.yaml` 里那条 `dataHome` **不参与**：那个文件在数据根之内，解析根时还没读到它。
- 两个半边必须给出同一个答案：base kit 的 `resolveDataHome({ explicit, env, configured })` 与 mem 引擎
  那份是同一条规则，由 `mem/packages/plugin/test/family_pin.spec.ts` 跨树钉住；两个插件对**自己的** profile
  `dataHome` 也必须同层（都走配置层），由 `data_home.spec.ts` 钉住。
- 数据文件永不搬出 `~/.avantf/{memory,knowledge}`；用户**编辑**的一切都住在 `~/.avantf/configs/*.yaml`
  与 `~/.avantf/prompts/*.md`，绝不放在数据库旁边。

## 子树约定

- **mem**：`@avantf/mem-contract` 是工具 / 配置 schema 与 UI payload 的**唯一真源**（工具 schema、
  MCP inputSchema、CLI 参数、client 类型都由它派生）。两个存储（memory / knowledge）各自独立、共用一套
  检索编排：工具键 → 运行时的派发表只在 `core/src/dispatch.ts`，检索流程只在 `core/src/store/hybrid.ts`，
  **不许再分叉**。**融合必须让证据按可靠性定序**（2026-10-04 自指排名事故的教训）：确定性/高精度信号（意图表改写、
  精确词法命中、结构化字段）排在前，稠密相似度只能作补充；**绝不允许"某条腿的偶然头部"压过"另一条腿的压倒性证据"**
  ——各腿按自身最大值归一后**不可直接比较**（`store/floors.ts` 已注明融合分只能同查询内比较），所以"某腿拿了 1.0"
  不构成"最相关"的证明。实测事故：改写 `我是谁？→用户是谁` 引入三元组 `用户是`，被一条**无关长笔记**偶然命中，
  于是该候选（语义 0.76 + FTS 1.0）反压正确候选（语义 1.0 + FTS 0）✗。改融合或门槛时，必须同时给出
  "**并集不收窄**、**非自指查询逐字节不变**"的证据，并**先回答"这条候选是靠哪条腿、几分证据进来的"**。
  中文评测集（`core/test/eval_zh.spec.ts`，**41 条**：原 35 条 + 2026-10-04 自指问句哨兵 6 条——
  4 条表内 + 2 条表外 KNOWN GAP，见 `mem/docs/SELF_QUERY_RELEVANCE.md`）的汇总数字是**精确断言** —— 任何移动它的
  改动都要重新冻结并解释。`pnpm -C mem typecheck` 也检查 `test/`，且要在 `pnpm -C mem build` **之后**跑
  （包通过产出的 `lib/*.d.ts` 读依赖）；`pnpm -C mem typecheck:dsh` 覆盖插件的 src + specs，是本地门禁
  （CI 没有 harness）。读 zod 内部别猜：用 `def.shape` / `def.values` / `z.toJSONSchema(..., { io: 'input' })`，
  形状断言在 `contract.spec.ts` / `tool_schema.spec.ts`。**工具面就是 `TOOL_SPECS` 里的 8 个**（`mem_*` 3 +
  `kb_*` 5）；`kb_manage` 属 `KB_TOOL`（UI remote 与 CLI 用的内部引擎 API），**不在模型面**——按 `name:` 数会数成 9，
  挂载冒烟断言的就是 8。**`mem/CHANGELOG.md` 的 `[Unreleased]` 必须为空**（mem 严格门禁的 preflight 要求）：
  新条目写进**正在准备的版本段**——`[0.4.0]` 已于 **2026-10-03 发布**（历史段不动），**下一条用户可见改动起用 `[0.5.0]`**：
  门禁要求**首个版本段 == `packages/plugin/package.json` 的版本**，所以要么先 `pnpm version:set mem 0.5.0` 再写 `[0.5.0]`，
  要么把条目攥在手里、等切版本那天一起写（**不要**塞进已发布的 `[0.4.0]`）——这条已经咬过两次（2026-10-02 两次把条目
  落进 `[Unreleased]` 都让 `pnpm -C mem release:check` 变红）。
- **mission**：任务树状态机在 `mission/packages/core`（**刻意不带 Node 类型**），`mission/packages/plugin` 是薄壳；
  它的领域模型与 mem 不共享任何东西。**调度语义（v1）**：**容量是派发闸门，不是受理闸门** ——
  `create_mission`/`decompose_mission` 永不因容量失败，节点进 `ready` 即排队；候选不满足
  `Σ running.weight + candidate.weight ≤ capacity` 就**跳过**（不扣 `attempts`/`failures`、无冷却、不记 `stalls`，
  与 unit 租约同纪律）。`capacity` = 配置 → `os.availableParallelism()` → `os.cpus().length` → 4，再
  `max(1, 派生 − 1)`（预留 1 核），在**宿主边界**算完注入 core；`weight`（默认 **1**）= "这台机器上大约占几核"，
  子任务**不继承**父估值。排队 = **work-conserving + 老化预留**（等太久就停止接纳新节点、让在跑的排空；
  `weight > capacity` 者独占整机），顺序按**入队时间**而非 weight；等容量的节点在投影里显示 `waitingFor`。
  平台探针（`ResourceProbe`）：**`null` = 本平台无此信号，绝不等于"空闲"**，只能让调度更保守；压力信号与
  子进程归属的适配器留给 v2。

## 架构裁决记录（第五轮架构审查，2026-10-03）

复审原文（不入库）：`docs/review/2026-10-03-architecture-review.md`。裁决与落地：

| 复审项 | 裁决 |
|---|---|
| §1.4/§7.9 base 的 `.` 是 `export *` 的副产品（50 个冻结值里 **14 个零消费者**、`createPluginLogger` 全仓零引用、4 个 typert 符号按设计无运行期消费者；一个世代号盖三种变化速率） | **收窄**：`.` 只留插件真取用的稳定子集、零消费者移进 `./internal`、`export *` 改**显式列举**，并与 prompts namespace 校验**合并成一次接口换代（v3）** |
| §1.5/§7.11 RC 投影停在 work/ 时代（"保留但不用"是最差一档） | **废除 RC，直接从 dev 仓发布**；RC 原本的三件事（排除发布工具、版本盖章、生成 README）降为**发布前断言**；`../dsh-plugins-rc` 已废弃 |
| §1.7/§7.6 CI 不跑 `build:dsh`，而"插件能挂载"是家族最核心的承诺 | **提进强制层**：CI 独立 job `mount-smoke`（两树 `build:dsh` + 断言 `MOUNT SMOKE OK`，先打印 dsh 版本便于分诊漂移）→ 已落地 `f67ff72` |
| §1.2/§2 `@avantf/mem-core` 名字与角色相反 | **改名 `@avantf/mem-retrieval`**（private、机械替换、不发版；跑一次含 eval 复核的全量门禁） |
| §1.3② mem 的 Remote 方法**无 wire 版本标记**（mission 已付过 404 学费） | **补**：照抄 mission 的版本标记 + skew 门禁模式 |
| §1.7 `remote_wire.spec` 的 vacuity 名单漏 `classifySource`/`browseDir`（守卫把缺口写成期望） | **补**，并尽量改成**从描述符表派生**，消除名单漂移这一类问题 |
| §1.6② `<dataHome>/prompts` 靠 `mem-*`/`mission-*` 前缀区分却**零机器检查** | **并入 v3 换代**：前缀成为 `PromptFiles({namespace})` 的字段、由 base 校验（不传 namespace 的旧调用方必须行为不变） |
| §3/§7.3 mission 的 zod `default().catch()` 与 core `normalizeLoaded` 各编码一遍默认值，**无跨层 pin** | **补**跨层 pin（同一份脏记录过两条路径，逐字段断言同答案） |
| §3/§7.5 core `prompt.ts` 被 `tree.ts` 反向 import（层次倒置，非循环） | **拆出 `trouble.ts`**（`statusLabel`/`isTroubledNode`），消倒置 |
| §1.6/§7.7 mission 本地 `resolveDataHome` 兜底（第四份实现）注释承诺同答案但**无 pin** | **补 pin**（显式实参 / `AVANTF_HOME` / 配置层 / 默认四种输入） |
| §2/§7.13 `registerSemanticBackend`/`registerVectorStore` 只有测试调用、无 `registerReranker`、发布面不 re-export | **补齐**（兑现 DESIGN §5"三者皆可注册"）：补 `registerReranker` + 注册面 re-export 到插件公开面 |
| §2/§7.12 cli/mcp 是 README 标 ✅ 的交付物却无安装路径 | **只修披露**：里程碑表如实标"需 repo checkout（private）"；不发布、不进可发布集合 |
| §1.1/§7.10 provision 与 base envinit 两套栈并存、加固不同步 | **冻结 + 文档化弱保证边界**（sha256 + 双 rename < base 的族根锁/pid 权威/慢持有告警）；不半拆（半拆会让 CLI 失去自动装 pandoc） |

**裁决为"不做"**（复审同意或本仓纪律，**不要重开**）：

- §1.3④ client 信封拆解进 base `./client` 子路径 → 复审"不推荐轻动"（会打破"改共用代码只发一版 base"这条唯一判据）。
- §1.3① mem UI 打包管线是否向 mission 的 esbuild+CSS-in-TS 收敛 → **第三块面板出现前定论**。
- §7.8「顺手做」那一组（host 抽 Remote 投影、mem client 按面板拆、`tree.ts` 两刀、`gateway.ts`/`store/legs.ts`、`db/vectors.ts` 搬家、`plugin/src/provision.ts` 改名）→ 复审自己写"**不专门开工**"，与本文「不为变小做整体重构」一致：**触及即抽**。
- §1.4 `Manifest.requires.providers` 的第四方装载故事（`loadProvider`）→ **等第一个真实的仓外 provider**。
- 复审的「明确不做」：`facts.ts` 按查询形状拆、`provisioner.ts` 拆闭包、`compat.ts` 拆五段、两棵树持久化统一、kit 成员清退 —— 都有"**不变量必须同住 / 编排不变量最密**"的理由，拆分的收益为负。

**本轮由实际故障确立的两条家族规则**（背景见 U1–U5）：

1. **worker 清理是四步生命周期**：标记归档 → 释放会话记录 → **取消归档** → **清投影缓存残留**。
   宿主会替已 dispose 的会话保留投影缓存（无驱逐 API），不清就会在"子代理"列表里留下幽灵条目
   （实测：磁盘会话记录 0、归档登记 0，而投影缓存 70 → 界面显示 70 个）。
2. **worker 计数保留策略**：每个属主会话保留**最新 10 个已完成的** worker（配置 `keepWorkers`，默认 **10**）；
   **正在执行的不占名额、永不被清理**；`keepWorkers = 0` 关闭自动保留；`/clean archive all` 仍是显式"手动全清"。
