# AGENTS.md

整个工作区的约定。一个仓库、**三个可发布包**：

| 目录 | 包 | 是什么 |
| --- | --- | --- |
| `base/plugin-base` | `@avantf/dsh-plugin-base` | DSH 插件的底座：启动期资源预装（声明式 provisioner）+ 宿主兼容门禁 + 共享 kit，运行期零依赖 |
| `mem/packages/plugin` | `@avantf/dsh-mem` | DSH 的记忆/知识插件：可长期检索的记忆 + 文档知识库（8 个模型工具、两个设置页） |
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
  类型身份。mission 的 zod 是 **optional** peer、零运行期使用。
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

## base 缺失（或接口世代不同）时的降级

| 能力 | base 不可用时 |
| --- | --- |
| 提示词文件层 | 用插件**内置的默认正文**（那是插件自己的内容，不是 kit 的副本） |
| 兼容门禁 | 一条 `compat:` WARNING，门禁跳过。裁决语义不变：只有**被证实**的不兼容才拒载，"说不清"只是备注，版本差异只是警告 |
| 资源 provision | 旧的 `@avantf/mem-provision` / legacy tools 目录 |
| 工具 / service / Remote / UI | 不受影响 —— 插件完整挂载 |

## 新增插件怎么用 base

- **装载**：唯一静态引用是 vendor 并**内联**的零依赖 bootstrap；用 `@avantf/dsh-plugin-base/bootstrap` 的
  `loadFramework()` 解析 → 校验版本 → 动态 import。**源码里绝不静态 import 本包**。
- **取用**：`PromptFiles` / `createPluginLogger` / `familyHome` / `resolveDataHome` / `strictCodec` / 宿主门禁
  （`provision` / `verdictOf` / `gatherEvidence` / `compatReport`）等，都从**加载到的那个模块**上取，不复制、
  不内联。
- **接口世代**：`checkInterface(required, module)` + `readInterfaceRequirement(url)` 比对"构建时所对"与
  "运行时加载到"的世代；构建期把自己的世代 bake 进 `lib/interface-version.json`。
- **降级义务**：base 缺席或世代不匹配 → 插件仍**完整挂载**（自带默认提示词正文、门禁跳过、legacy 路径）；
  `incompatible` 只放弃 base 的共享能力、`cannot-tell` 只告警，**绝不拒载**（逐项见上一节的降级表）。
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
- **一处刻意的镜像**：家族 / 数据路径解析有两份——`base/plugin-base/src/kit/family.ts` 是正本，
  `@avantf/mem-contract` 留一份**无依赖**副本（CLI / MCP 没有 DSH 宿主、从不加载 base），跨树测试钉住两份；
  改它 = 一次 base 发版**加**一次 mem 引擎改动。
- **两个插件绝不互相 import**（连相对路径也不行），共享一律走 `base/`。刻意不复用：两个内核
  （`@avantf/mem` / `@avantf/mission-core` 不共享领域模型）、两个 client 半边、各插件的 item 清单与 SPEC。

**抽到 base 的次序**（不然旧插件会被判不兼容；细节与完整清单见 `base/plugin-base/docs/INTERFACE.md`）：

1. **先升接口**：`INTERFACE_VERSION` +1、新增 `api/interface-vN.json`，新成员写进 `.` 的接口类型与两份名单
   （`UPDATE_INTERFACE_SNAPSHOT=1 pnpm -C base/plugin-base test public-surface` 重落快照）。接口与包版本是
   **两条轴**：换代只动接口编号，包版本按普通 semver 走。
2. **再实现**（放 base）并补**跨树行为测试**：从**已链接的 base** 取真实实现比对，mock 里断言不算。
3. **向前兼容是硬要求**：新成员必须**增量**——不改既有成员的形状与语义；顺序敏感的参数用具名对象
   （`resolveDataHome({ explicit, env, configured })`）；可观察文案归调用方（`compatReport` 的 `words`）。
   旧插件遇到新世代只会降级挂载，一次增面绝不能让谁拒载；发布按正常顺序，插件方便时重建以消费新能力。

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
| `pnpm release:check` | 可发布集合恰好那三个、peer 是 required 且够宽、只有一份 zod、无 `link:`/`file:`、registry 上已有兼容的 base |
| `pnpm proof:base-swap[:mount]` | 产物里没有静态 base import / 内联 kit；**被替换的** base 仍能提供提示词读写、根解析与接口门禁 |
| `pnpm release:check:<base\|mem\|mission>` | 该包自己的门禁：链接 → 编译 → 类型检查 → 测试 → pack，`old-dsh` **最后**跑（要重新链接并重建）；mem 的 build 必须先于 typecheck（`typecheck` 通过产出的 `lib/*.d.ts` 读依赖） |
| `pnpm check:old-dsh <base\|mem\|mission>` | 在该包声明的 dsh peer **下限**上重跑 LOCAL 步骤（含 `test:dsh` 与 mount smoke），完事恢复现场；`release:check` 已内置这一步 |
| `pnpm check:dsh-lines` | dsh **已发布**的版本里有没有我们的 peer 覆盖不到的（同一份 semver + `includePrerelease: true`）；有新 minor 线或 dist-tag 落到未覆盖线就退出 1，并给出该补的 `\|\|` 条款 |

**改动 `base/**` 之后两个插件都要回归**（base 自己的测试不会走到挂载）：

```bash
pnpm build:dsh mem && node mem/scripts/mount-smoke.mjs
pnpm build:dsh mission && node mission/scripts/mount-smoke.mjs    # 或 pnpm -C mission release:check
```

**RC 投影只在发版时做**（`../dsh-plugins-rc`，整仓投影 + 产物级门禁）：日常开发不投影，不发版不投影。

## 体量与枢纽文件（hub）

实测（2026-10-02，六条车道收尾后）：436 个源文件、95693 行，其中 **>800 行且非测试脚手架的 11 个** —— 问题
不是"大文件多"，而是少数**枢纽**被反复改动。**注意：它们本轮全部比上次更大**——抽缝的收益是"抑制增长"，
不是"变小"（`tree.ts` 抽走 `dispatch.ts` 之后仍净增，因为同一波次加进来的功能更多）。名单（行数 / 备注）：

| 文件 | 行数 | 备注 |
|---|---|---|
| `mission/packages/plugin/src/host.ts` | 1998 | 唯一**持续回长**的枢纽，每个新特性都插一脚 |
| `mem/packages/core/src/store/memory.ts` | 1723 | 含实测性能结论的 SQL/索引形状，慎动 |
| `mission/packages/core/src/tree.ts` | 1690 | 状态机 + 持久化 + 投影 |
| `mem/packages/plugin/src/client/index.ts` | 1678 | hyperscript 内联 UI，可按页面拆 |
| `mem/packages/core/src/store/knowledge.ts` | 1609 | 同上（SQL 形状慎动） |
| `base/plugin-base/src/provisioner.ts` | 1101 | base 枢纽，最后动 |
| `mem/packages/core/src/db/dao/facts.ts` | 992 | |
| `base/plugin-base/src/compat.ts` / `conformance.ts` | 937 / 877 | base 枢纽，最后动 |
| `mission/packages/plugin/src/client/MissionTreeView.tsx` | 891 | 面板 UI（加执行者会话跳转后越过 800） |
| `mem/packages/plugin/src/index.ts` | 831 | 插件装配入口 |

**规矩**：① **触及枢纽时，若正在加的关注点能干净分离，就顺手抽成独立模块**——`claims.ts` /
`continuation.ts` / `prompt.ts` / `hybrid.ts` / `dao/facts.ts` 都是这么来的，**不专门开重构线**；
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
  **不许再分叉**。中文评测集（`core/test/eval_zh.spec.ts`，35 条）的汇总数字是**精确断言** —— 任何移动它的
  改动都要重新冻结并解释。`pnpm -C mem typecheck` 也检查 `test/`，且要在 `pnpm -C mem build` **之后**跑
  （包通过产出的 `lib/*.d.ts` 读依赖）；`pnpm -C mem typecheck:dsh` 覆盖插件的 src + specs，是本地门禁
  （CI 没有 harness）。读 zod 内部别猜：用 `def.shape` / `def.values` / `z.toJSONSchema(..., { io: 'input' })`，
  形状断言在 `contract.spec.ts` / `tool_schema.spec.ts`。**工具面就是 `TOOL_SPECS` 里的 8 个**（`mem_*` 3 +
  `kb_*` 5）；`kb_manage` 属 `KB_TOOL`（UI remote 与 CLI 用的内部引擎 API），**不在模型面**——按 `name:` 数会数成 9，
  挂载冒烟断言的就是 8。
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
