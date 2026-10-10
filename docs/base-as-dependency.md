# base 改为普通依赖：装插件就自动带上底座（2026-10-10）

> 本文件是**实施规格**（派单方写给执行者）。范围：两个插件 manifest + 发布面门禁与其单测 +
> 根 `AGENTS.md` / `docs/RELEASING.md` + 两份 README。**不含**版本号与 CHANGELOG（由派单方在发版时切）。

## 1. 要求（用户口径）

**安装记忆 / 任务插件时，用户不应该知道还有 base。** base 作为插件的普通依赖自动装好即可。

旧的书面规则（`AGENTS.md` 发布面："对 base 的引用只放 required peer + 同区间 devDependencies，
**绝不放 `dependencies`**"）与门禁里的对应断言要**移除**；它给出的理由（"运行期依赖会让安装器把
base 放进插件内部 → 多份副本 → 跨副本身份分叉"）**经实测不成立**。

## 2. 实测证据（派单方已跑，三种安装器）

两个探针包（模拟 mem / mission）都声明 `dependencies: { "@avantf/dsh-plugin-base": <区间> }`，
装进同一个 profile，实测：

| 安装器 / 布局 | base 物理副本数 | 两个探针解析到的路径 |
| --- | --- | --- |
| pnpm 默认（isolated） | **1**（`.pnpm/@avantf+dsh-plugin-base@…` 单条目） | 同一个 `.pnpm/…/node_modules/@avantf/dsh-plugin-base` |
| pnpm + `nodeLinker: hoisted`（**dsh profile 的设置**，`dsh-app-boot/lib/index.js:566-567` 自己写的） | **1** | 根 `node_modules/@avantf/dsh-plugin-base` |
| npm（flat） | **1** | 根 `node_modules/@avantf/dsh-plugin-base`（两个探针 `createRequire(...).resolve()` 到同一路径） |

结论：**只要两个插件声明同一区间，各安装器都只装一份**。多份副本只在"两个插件区间不同"时才会出现，
所以新规则要把"两插件区间相同"从 WARNING 升级为**硬断言**。

另外：`autoInstallPeers: false` 也是 dsh 自己写进 profile 的，所以"靠 peer 自动补装"这条路在 dsh
里根本走不通；要"装插件自动带 base"，**base 必须是 `dependencies`**。

## 3. 要改的地方（逐处）

### 3.1 两个插件 manifest

`mem/packages/plugin/package.json`、`mission/packages/plugin/package.json`：

- 把 `@avantf/dsh-plugin-base` 从 `peerDependencies`（以及 `devDependencies` 的同区间条目）**移到
  `dependencies`**，区间两棵树**逐字相同**且保持宽：`>=0.3.0 <1.0.0`（宽是硬要求：一次 base 发版
  要能修好共享代码；禁 `~`、禁精确版本）。
- **不动** `zod` 与 `@deepseek-ai/*` 的 required peer 接线（宿主提供的单实例框架，规则仍然成立）。
- 不新增 `optionalDependencies` / `peerDependenciesMeta`。

### 3.2 发布面门禁

- `scripts/lib/gates.mjs`：`baseDependencyProblems()` 改成新不变量——
  ① base 必须在 `dependencies`（**在 `peerDependencies` 里不算数**：dsh 的 profile 不会补装 peer）；
  ② 区间宽（沿用既有 `/^[~=]|^\d+\.\d+\.\d+$/` 判定）；③ base 出现在 `optionalDependencies` 或
  `peerDependenciesMeta[BASE].optional === true` → 失败；④ 两棵插件树的 base 区间必须**逐字相同** → 不同即失败。
  **`requiredPeerProblems()`（zod 与框架 peer）保持原样**，一行都别松。
  注意 `gates.mjs:104` 那条"host-provided dependency 必须是 peer"的通用断言：它服务的是 `zod` /
  `@deepseek-ai/*`，**不要**让它继续把 base 也判进去（base 不再走它）。
- `scripts/release-check.mjs`：第三节（标题与注释在 `:15` / `:22` / `:251` / `:259`，禁止段在 `:283-292`）
  与文件头说明同步改写为新规则；**保留**"发布顺序 base → 插件"的 registry 探针（插件的 dependency
  区间必须能被 registry 上某个已发布 base 满足，否则 `pnpm add` 插件会失败），也保留 base 自身契约断言
  （`base` 无运行期依赖、宽 `zod` peer）。
- `scripts/gates.test.mjs`：`N15`（`:194`，"a host-provided dependency must stay a REQUIRED peer"）
  与 `baseDependencyProblems` 的单测（`:153-170`）按新语义重写，并补**变异用例**：两插件区间不同 →
  必须失败；base 放 `optionalDependencies` → 失败；base 只放 `peerDependencies` → 失败（不会自动装）。

### 3.3 文档

- 根 `AGENTS.md`：发布面那两条（`:17-21` 附近，"对 base 的引用只放 required peer … 绝不放 `dependencies`"）
  删除并改写为新规则 + 一句为什么（**一份副本由"两插件同区间"保证**，三种安装器实测都只装一份）；
  `:80` 附近"插件 manifest（required peer + 同区间 dev…）"里的 base 部分同步改。
- `docs/RELEASING.md:3`："插件把 base 声明为 required peer" → 改为"插件把 base 声明为**同区间的普通依赖**
  （装插件即自动带底座）"。
- **两份 README**（随包发布的 npm 页面，只写这个包本身）：
  - 删掉"装这两个包 … 底座 … 必须显式装"那一段与 `dsh plugin --profile … add @avantf/dsh-plugin-base@<version>`
    那一行，改成**只装插件**（一句话说明底座随依赖自动装好，用户不需要管）。
  - `mem/packages/plugin/README.md:215` 与 `mission/packages/plugin/README.md:239-240` 的"（**安装时随插件
    一起装**）"现在是**事实**，改成自动语气的表述；两处不要留下与安装段矛盾的说法。
  - **保留**"版本号建议写死 + 宿主的安装门禁会拒绝并把 profile 回滚"这条既有提醒（那是针对插件本身）。
  - README 里不写仓库内部内容（门禁、rc、发布顺序都不许出现）。
- 全仓再 grep 一遍旧说法，别留下自相矛盾的地方（`grep -rn "required peer" scripts/ docs/ AGENTS.md
  mem/packages/plugin/README.md mission/packages/plugin/README.md base/plugin-base/docs/ mem/DESIGN.md
  mission/docs/`）；`zod` / 框架 peer 的"required peer"表述**保留**。

## 4. 验收（必须给证据）

1. **门禁语义**：`node scripts/gates.test.mjs`（或该套件的入口）全绿；四个变异用例（区间不同 /
   optional / 仅 peer / 漏 dependencies）都被抓住。
2. **一份副本不变量（实测）**：用**打包后的真实产物**（base + 新 mem + 新 mission tarball）在 scratch
   profile 里安装：pnpm 默认、pnpm `hoisted`、npm 三种布局各测一次，断言
   **base 物理副本恰好 1 份**、且两个消费者 `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')`
   指到同一路径。
3. **端到端（用户视角）**：在 scratch profile 里 `dsh plugin --profile <TMP> add <新 mem tarball>`（等价：
   `pnpm add` + `dsh --profile <TMP> --dump-config`）→ 断言 **profile 的 `package.json` 只点名了插件**、
   而 `node_modules/@avantf/dsh-plugin-base` 自动存在；再断言该 profile 能挂载（`mount-smoke` 或
   `--dump-config` 里插件行就位）。
4. **不回归**：`pnpm -C mem build/typecheck` 与 `pnpm -C mission build/typecheck` 绿；两树**只跑新增/改动的
   测试文件**（门禁与 README 相关的定向用例）；`zod` / `@deepseek-ai/*` 的 peer 接线未被改动（`git diff`
   里只能看到 base 相关行）。
5. **收口由派单方跑**：`pnpm check:release`（含两树 mount smoke、old-dsh 下限、pack、prepublish 断言）
   与 `pnpm check:fast mem|mission` 由派单方执行；执行者**不要**跑它们。

## 5. 边界

- **不改版本号、不改 CHANGELOG**（派单方在发版时切：这是可观察的安装行为变化）。
- **不改 base 自身**（`base/plugin-base/**` 一行不动）。
- 不引入 `optionalDependencies`、不改 `zod`/框架 peer、不动 `preinstall`/运行时安装逻辑
  （插件**绝不允许**在启动时去动包管理器）。
- 执行者按本仓验证分工：只做改动涉及的构建/类型检查 + 针对性的测试文件，并报告"实际跑了什么 /
  每个测试证明了哪条要求 / 有哪些没能验证"。

## 6. 参考坐标

- `scripts/lib/gates.mjs`（`baseDependencyProblems` / `requiredPeerProblems`，`:104` 通用 peer 断言）
- `scripts/release-check.mjs`（文件头 `:10-30`、第三节 `:251-299`、registry 探针 `:410`）
- `scripts/gates.test.mjs`（`N15` `:194`、base 单测 `:153-170`）
- `scripts/lib/pack-plugin.mjs:439`（**框架 peer** 的断言，**保持不动**）
- `AGENTS.md`（发布面 `:17-21`、新增插件清单 `:80`）
- `docs/RELEASING.md:3`
- `mem/packages/plugin/package.json` / `mission/packages/plugin/package.json`
- `mem/packages/plugin/README.md`（安装段 `:44-56`、`:210-218`）
  / `mission/packages/plugin/README.md`（安装段 `:95-105`、`:236-243`）
