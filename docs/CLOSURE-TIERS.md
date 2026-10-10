# 收口两档：`check:fast` / `check:release`

2026-10-03 起，"每次派发完成后的收口"不再是一条全量序列，而是两档。命令由
`scripts/check-tier.mjs` 提供（根 `package.json` 的 `check:fast` / `check:release`），
它是**唯一**决定"收口"包含哪些步骤的地方。

## 命令

```bash
# 快档 —— 日常每个派发任务结束后（默认档）
pnpm check:fast <base|mem|mission|root>   # 只覆盖被改到的那棵树
pnpm check:fast                           # 不给树名：从 git status 自动判（无树改动 → root）

# 发版档 —— 只在发版前 / 改了发布面或 base/**
pnpm check:release                        # 三个包的严格门禁 + root release:check + prepublish:assert
pnpm check:release --parallel             # 可选：三个严格门禁并发（见「并行安全性」）
```

## 两档的覆盖 / 不覆盖

| 步骤 | 快档 `check:fast <tree>` | 发版档 `check:release` |
| --- | --- | --- |
| 构建 | 该树 build；**base 只构一次**（多树时 hoisted） | 各包严格门禁内部构建（见「残留的重复」） |
| 类型检查 | 该树 src + tests | 同左（含在严格门禁里） |
| 该树全套测试 | **一次**（mem = engine 包 + plugin 的 peer specs；mission = core + plugin） | 一次（含在严格门禁里） |
| 构建产物断言 | 跑（mem 的 `assert-envinit-artifacts` / `assert-client-portable`；mission 的 `client-smoke`） | 跑（在各自 `build:dsh` 里） |
| `pnpm guard` | 跑 | 不跑（CI 层；与制品/发布面无关） |
| 四个自测 | 跑（`gates` / `toolchain` / `check-dsh-lines` / `version`） | 不跑（同上；CI 层） |
| `prepublish:assert` | 跑 | 跑 |
| `pack` + 产物字节断言 | **不跑** | 跑（三个包） |
| `old-dsh` 下限门（`0.1.5-rc.2`） | **不跑** | 跑（base / mem / mission） |
| mount smoke（真 Cordis） | **不跑** | 跑（mem + mission；在各自严格门禁里） |
| 根 `release:check`（可发布集合/base 依赖区间/一份 zod/registry 上已有兼容 base） | **不跑** | 跑 |

一句话：**快档证明"这棵树的源码编译、类型自洽、测试通过"；发版档才证明"产物能挂、在下限 dsh
上能跑、发布面自洽"。** 快档不放水的地方是：它跑的是该树**完整**的测试套件（不是抽样），而且
`guard`/自测/发布面断言照跑。

## 去重（这次提速的主要来源）

- 一条流程里"跑测试"**只发生一次**：不再"先 `pnpm test`，再让 `release:check` 又跑一遍"。
- 快档里 base **只构建一次**：`mem` / `mission` 的快档步骤调用该树自己的构建入口
  （不重建 base），而不是 `build:dsh`（后者会重建 base 并跑 mount smoke）。
- 发版档不再额外跑 `pnpm test` / `build:dsh mem` / `build:dsh mission`：严格门禁自带测试与
  mount smoke。

### 残留的重复（根脚本改不掉，如实记录）

三棵树各自的 `release:check` 是**各树自己的黑盒**，里面仍会重建 base：
`mem` 的严格门禁 `pnpm --filter @avantf/dsh-plugin-base run build`（`build:dsh` 里再一次）、
`mission` 的 `build:base`（`build:dsh` 里再一次）、`base` 自己的一次。根脚本不修改三棵树
（manifest / 脚本都不动），所以做不到"整个发版档里 base 只构建一次"；能去掉的重复已经在
`check-tier.mjs` 里去掉了（不额外跑 `test` / `build:dsh` / 三份 root 步骤）。

## 并行安全性判定

**结论：`check-old-dsh` 这一条腿在三棵树之间是隔离的、可并行；但把三个 `release:check` 整体并行
仍不安全，所以发版档默认串行，`--parallel` 是给已实测干净的机器/CI 的可选项。**

读 `scripts/check-old-dsh.mjs` 的依据：

| 状态 | 位置 | 是否跨树共享 |
| --- | --- | --- |
| peer 链接目标 | `join(repo,'packages','plugin','node_modules','@deepseek-ai')`，`repo` 是该 group 的树 | **树内**，互不相干 |
| closure 缓存 | `cacheRootFor(floor, group) = $TMPDIR/avantf-old-dsh-<group>-<floor>` | **按 `(group, floor)` 隔离**（代码注释记录：只按 floor 键曾让并行组互删） |
| fake global root | `<cache>/root`，每组自己的，`rmSync` 只删自己 | 隔离 |
| `npm_config_prefix` | 进程环境变量 | 不落盘共享 |
| 恢复步骤 | relink + rebuild 只碰本树 | 树内 |

真正共享的是**门禁内部**另外两处写：

1. **`base/plugin-base/dist`**：`mem` 与 `mission` 的门禁都会在构建插件前重建 base
   （`--filter @avantf/dsh-plugin-base run build` / `build:base`），`base` 自己的门禁也构建它。
   多个 `tsc` 同时写同一个 `outDir`，而插件侧的 `tsc` 又会在同一时刻读 `base/dist/*.d.ts`；
   `tsc` 的 emit 不是原子写。
2. **workspace 级 `pnpm install`**：`mem` 的严格门禁第一步就是
   `pnpm install --frozen-lockfile --ignore-scripts`，与另一棵树的 build/link 并发时会动同一个
   根 `node_modules`。

因此默认串行。每个门的日志按树分开写：`logs/check-release-<tree>.log`（`*.log` 已被
`.gitignore` 忽略）；失败时会打印该日志的末尾。

实测探针：`pnpm check:release --parallel`（三棵树的门禁真并发，各自写
`logs/check-release-<tree>.log`）跑通了一次，**130.8s**（同一状态下串行 199.3s）。这说明
`check-old-dsh` 的按组隔离确实成立；但它**不能**证明上面两处共享写没有竞态——一次绿跑只说明这次
没撞上，`tsc` 的非原子 emit 与 `pnpm install` 的重链仍是构造性的共享写。发版门禁的代价是"偶发
假红"，比 69s 更贵，所以默认串行；把三棵树的 base 重建与 mem 的 workspace install 从门禁里去掉
之后（需要改三棵树各自的 `release:check`，本任务不允许），`--parallel` 才适合做默认。

## 什么时候**必须**跑发版档

- 改动 `base/**`（AGENTS：两棵插件树都要回归，且要 mount smoke）。
- 改**发布面**：任何 manifest、`peerDependencies` 区间、`files`、README 首行、版本号
  （`version:set`）。
- 改**门禁/工具链脚本**：根 `scripts/**`、`base/plugin-base/scripts/**`、`mem/scripts/**`、
  `mission/scripts/**` 里的 gate，或 CI workflow。
- **发版前**（`pnpm publish` 之前）。
- 其余日常改动（一棵树的源码/测试/文案）：**快档**。

## 实测数字

环境：12 核，Node v22.23.2，pnpm 12.4.1，dsh `0.2.0-rc.2`，`old-dsh` closure 已缓存
（floor `0.1.5-rc.2`）。2026-10-03。

**同一状态对比**：下面所有数字来自"当天机器已热身"（同一批构建/测试缓存）的连续测量，修前与修后
可直接对比。首次冷启动的同一序列是 372.6s（表末附）。

### 修前：单项墙钟（秒，热身）

| 命令 | 秒 | 占比 |
| --- | ---: | ---: |
| `mem release:check` | 107.5 | 35.8% |
| `mission release:check` | 62.8 | 20.9% |
| `mem test` | 54.1 | 18.0% |
| `base release:check` | 27.7 | 9.2% |
| `build:dsh`（两个插件，各重建 base） | 19.4 | 6.5% |
| `mission test` | 16.6 | 5.5% |
| `base test` | 7.1 | 2.4% |
| 根 `release:check` | 1.9 | 0.6% |
| `guard` + 四个自测 + `prepublish:assert` | 3.1 | 1.0% |
| **合计（= 修前一次全量收口）** | **300.3** | 100% |

**占比最大的前三项**：`mem release:check`、`mission release:check`、`mem test` —— 全部由
mem 的测试套件主导（它在收口里被跑了**两遍**：一遍 `pnpm test`，一遍 `release:check`）。

（首轮（未热身）的同一张表：372.6s —— `mem release:check` 136.3 / `mission release:check` 76.5 /
`mem test` 71.0 / `base release:check` 35.4 / `build:dsh` 22.6 / `mission test` 17.8 /
`base test` 8.0 / 根 `release:check` 1.7 / 根步骤 3.3。冷热差异主要来自构建/测试缓存，不影响
占比排序与结论。）

### 场景①：一棵树（mem）的一句文案改动

| | 墙钟（秒） | 说明 |
| --- | ---: | --- |
| 修前 | 300.3 | 任何改动都走全量收口 |
| 修后 `pnpm check:fast mem` | **83.6** | base 构一次 + mem build/typecheck/测试一次 + 根步骤 |

**省 216.7s（72%）**，且覆盖不缩水：仍是该树完整的测试套件 + `guard` + 四个自测 + 发布面断言。

另外两棵树的快档（同一状态）：`pnpm check:fast base` 14.9s，`pnpm check:fast mission` 36.2s
（`pnpm check:fast root` 3.2s）。修前对它们同样是 300.3s 的全量收口。

### 场景②：发版前完整档

| | 墙钟（秒） | 说明 |
| --- | ---: | --- |
| 修前 | 300.3 | 三个 `release:check` + 单独的 `pnpm test` / `build:dsh` / 根步骤 |
| 修后 `pnpm check:release` | **199.3** | 三个严格门禁（串行）+ 根 `release:check` + `prepublish:assert` |

**省 101.0s（34%）**：正好是去掉的重复项 —— `pnpm test`（77.8s，三棵树测试又跑一遍）、
`build:dsh`（19.4s）、根 `guard` + 自测（约 3s）。发版档的防线一项没少（三个严格门禁里的 pack、
`old-dsh` 下限门、两个真 Cordis mount smoke 都在）。

## 变异验证（快档不是放水）

在**非测试代码** `mem/packages/core/src/db/dao/facts.ts` 里去掉 `FTS_SEARCH_SQL` 的
`NOT INDEXED`（这是被 `test/fts_plan.spec.ts` 钉死的计划形状）：

```bash
# 改坏
sed -i 's/JOIN facts fa NOT INDEXED ON/JOIN facts fa ON/' mem/packages/core/src/db/dao/facts.ts
pnpm check:fast mem      # 应红
# 还原
cp /tmp/facts.ts.orig mem/packages/core/src/db/dao/facts.ts
pnpm check:fast mem      # 应绿
```

结果：**改坏 → 快档红；还原 → 快档绿。**

改坏后 `pnpm check:fast mem` 在 44.7s 处退出 1，红在它必须红的那一步——mem 的测试：

```
❯ test/fts_plan.spec.ts (3 tests | 1 failed) 683ms
  × facts FTS leg plan (P1, 2026-10-03 performance review) > drives from the FTS table on a fresh session, before any statistics exist
AssertionError: no category filter (main leg + hint):
  SEARCH fa USING COVERING INDEX idx_facts_status_category (status=?)
  | SCAN f VIRTUAL TABLE INDEX 0:=M1 | USE TEMP B-TREE FOR ORDER BY:
  expected '…' not to match /SCAN f VIRTUAL TABLE INDEX 0:=M1/
  ❯ test/fts_plan.spec.ts:98:45
FAILED: test mem (engine + plugin suites, once) (exit 1)
check:fast FAILED at: test mem (engine + plugin suites, once)
```

还原（sha256 与改前一致）后 `pnpm check:fast mem` 全绿：`check:fast ok (mem)`，83.6s。
这证明快档**确实跑到**该树的完整测试套件，而不是"少跑几项所以快"。

## 未验证 / 边界

- **快档不覆盖**：pack 产物字节、`old-dsh` 下限（`0.1.5-rc.2`）、真 Cordis mount、根
  `release:check` 的 registry/发布面判定。这些只在发版档（或 CI 的 `mount-smoke` job）里跑。
  改 `base/**`、发布面/接口、门禁脚本或版本号时**必须**走发版档。
- **快档的步骤表是根脚本里手写的**（`scripts/check-tier.mjs` 的 `FAST`）：它镜像各树
  `release:check` 的 build/typecheck/test 部分，但若某棵树以后在 `release:check` 里**新增**一条
  自己的检查，快档不会自动跟上——发版档（调用各树自己的 `release:check`）仍是权威。
- **发版档里 base 仍被各树门禁重建多次**（见「残留的重复」）：不是"整个流程只构建一次"，根脚本
  无法消除，除非改三棵树。
- **并行只在发版档有**：快档是单棵树，无并发；`--parallel` 只被测过一次（绿），未做多轮压力测试，
  因此不做默认。
- **数字是这台机器（12 核）当天热身态的墙钟**，绝对值随负载/缓存变化；可比的是同一状态的
  "修前 vs 修后"与占比排序。
- 未在本任务里验证：Windows 上的分档（`check-tier.mjs` 走 `scripts/lib/win-spawn.mjs`，形状与
  其它根脚本一致，但未在 Windows 实机跑过）。
