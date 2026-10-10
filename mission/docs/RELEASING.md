# 发布手册（mission 差异）

> 面向：给 `@avantf/dsh-mission` 打版本 tag、发布 npm 包的人。
>
> **这是差异手册，不是第二份发布手册。** 共享知识只在写一遍，本文只链不复述：家族发布顺序
> （base → 插件）、base 作为普通依赖的约定、版本载体规则、发布前断言（`pnpm prepublish:assert`，替代
> 已退役的 RC 投影）、上传后 202 与 "staged 待批准"的区别 —— 见根 [`AGENTS.md`](../../AGENTS.md)
> 与根 [`docs/RELEASING.md`](../../docs/RELEASING.md)；mem 手册
> [`mem/docs/RELEASING.md`](../../mem/docs/RELEASING.md) §1.1 是一次完整发布的实跑记录，
> 本文的命令与它同构，只是产物位置与门禁入口不同。
>
> 相关：`mission/README.md`（包本身）、`mission/docs/plugin-internals.md`（实现）。

## 0. 与 mem 的三处硬差异（先看这里）

| | mem | mission |
|---|---|---|
| CHANGELOG | 有 `mem/CHANGELOG.md`；preflight 检查"第一个版本节 == 包版本"且 `[Unreleased]` 已清空 | **没有 CHANGELOG**，`pnpm -C mission release:check` 也不检查它（只有根 `pnpm release:check` 管仓库级元数据：可发布集合、base 依赖区间、registry 上的 base） |
| pack 产物 | `mem/dist/avantf-dsh-mem-<ver>.tgz` | `mission/release/avantf-dsh-mission-<ver>.tgz` |
| 门禁入口 | `pnpm -C mem release:check`（带 CHANGELOG preflight） | `pnpm -C mission release:check`（typecheck → build → test → pack，见 §1） |

所以 mission 的一次发布**没有 CHANGELOG 步骤**：改一处版本（§4）→ 门禁全绿（§1）→ pack + `npm publish`（§3）。

## 1. 门禁：`pnpm -C mission release:check`

脚本先 `pnpm build:base`，再 `node scripts/release-check.mjs`；**顺序执行、任何一步失败即整体失败**：

| 步骤 | 内容 |
|---|---|
| `typecheck` | `scripts/typecheck.mjs`：link-dsh（`--no-bake`）+ link-envinit → `packages/core` 与 `packages/plugin` 的 src + tests 类型检查 |
| `build:dsh` | `scripts/build-plugin.mjs`：link-dsh（从**已安装** dsh）→ link-envinit（vendor base bootstrap）→ build workspace → build client half → **mount-smoke** |
| `test core` | `packages/core` vitest（实测 3 文件 / 110 用例） |
| `test plugin` | `packages/plugin` vitest（实测 28 文件 / 293 用例） |
| `client smoke` | `scripts/client-smoke.mjs`（浏览器半边的 bundle 契约） |
| `pack` | `scripts/pack-plugin.mjs` → `mission/release/avantf-dsh-mission-<ver>.tgz` |

mount-smoke 是这里唯一证明"插件真的能在宿主里起来"的一步；它只对着已安装的全局 dsh
（`npm i -g @deepseek-ai/dsh`），不用任何 harness 源码 checkout。

## 2. packer：`pnpm -C mission pack:plugin [--mount] [--keep] [--out <dir>]`

需要先 `pnpm build:dsh`（packer 从不构建）；`--mount` 还需要已安装的全局 dsh。

- 默认：把 tarball 打进 `mission/release/` 并跑全部 tarball 断言（manifest 无 `catalog:`/`workspace:`/
  `link:`/`file:`、README 首行、LICENSE、引擎内联、`lib/interface-version.json` 等），打印
  `pack:plugin ok → <dir>`。
- `--mount`：把**刚打出的 tarball**（不是构建树）解包进一个临时 scratch profile，软链已安装 dsh 的
  peers 与 `zod`，再用与门禁同一个 `scripts/mount-smoke.mjs`（`--runtime`）挂载解包后的包。两条启动
  路径都覆盖：底座**可解析**（`compat: ok`）与底座**不可解析**（`envinit: WARNING`，插件照常起来）。
  成功时多打一行 `✓ PACK OK — the packed tarball mounts in a scratch profile: <tarball 绝对路径>`；
  失败非零退出。
- `--out <dir>`：pack 目标目录（默认 `mission/release`）；`--mount` 挂的就是该目录里的那份 tarball。
- `--keep`：`--mount` 失败时保留 scratch profile 以便排查（成功时无副作用）；单独用会被拒绝
  ——它没有可保留的东西。
- **不支持的旗标一律非零退出**：`pnpm -C mission pack:plugin --bogus` 退出码 2，打印
  `pack-plugin: unknown option --bogus` 与用法。这曾经是个真缺陷：`--mount` 被**静默忽略**，
  输出与不带旗标完全相同，照 mem §1.1 复刻的人会以为 tarball 已经解包挂载验证过。现在没有
  "接受了却什么都不做"的旗标。

## 3. 发布配方（两步）

```bash
pnpm prepublish:assert                         # 根断言：可发布集合 / 版本载体 / README / 不夹带发布工具
pnpm -C mission release:check                  # §1，必须全绿
pnpm -C mission pack:plugin --mount            # 必须 PACK OK，产物 mission/release/avantf-dsh-mission-<ver>.tgz
npm publish "$PWD/mission/release/avantf-dsh-mission-<ver>.tgz" --access public \
  --registry https://registry.npmjs.org/
```

**发布直接从开发仓做，不再投影 `../dsh-plugins-rc`**（该目录已废弃）。`prepublish:assert` 是
`scripts/prepublish-assert.mjs` 的四条只读断言（可发布集合恰好三个 / 版本只盖一处 / README 首行是包名 /
产物不夹带发布工具），`mission/packages/plugin` 的 `prepublishOnly` 也已前置同一条。注意：`npm publish
<tarball>` 不跑生命周期脚本，所以这份配方里它是**手工**跑的；走 `pnpm publish` 时由钩子自动跑。

**为什么不能 `pnpm --filter @avantf/dsh-mission publish`**：按 `AGENTS.md`「版本：每组只记在一个
manifest 里」，私有的 `mission/package.json` / `mission/packages/core` **不带 version**，pnpm 在 publish
的打包装阶段解析不出 `workspace:*` 的目标版本，直接报 `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`。
`pnpm pack` 走 `scripts/lib/versions.mjs` 的 `withWorkspaceVersions`（打包那一刻把版本临时写进私有
manifest、`finally` 还原），所以**只有它产出的 tarball** 已把 `workspace:`/`catalog:` 落成真实范围；
`npm publish <tarball>` 不再跑生命周期脚本、也不需要 workspace 解析。registry / token / scope /
链路这四条发布前提见 mem 手册 §2。

## 4. 版本载体与 tag

- 版本只改一处：`pnpm version:set mission X.Y.Z` — 只写 `mission/packages/plugin/package.json`。
- `pnpm version:check` 校验"每组版本只记在它的可发布 manifest 里，私有 manifest 不带版本"。
- **不再有 rc 投影**：`../dsh-plugins-rc` 已废弃、不再往里同步，发布直接从本仓做。发布前在仓库根跑
  `pnpm prepublish:assert`（根 `scripts/prepublish-assert.mjs`）与 `pnpm release:check`；rc 原本提供的
  三件事（排除发布工具、版本盖章、生成 README）现在是发布前在开发树里必须成立的断言。
- tag 只在开发仓打、带组前缀：`mission-vX.Y.Z`（三个包共用一个仓库，裸 `vX.Y.Z` 会互相撞）。
- 家族发布顺序、base 作为普通依赖的约定、发布前断言见根 `AGENTS.md` 与根
  [`docs/RELEASING.md`](../../docs/RELEASING.md)。

## 5. 上传之后

`npm publish` 返回 `202 Accepted`（版本端点约 2–3 分钟后才可见）与 2FA 账号下的 "staged 待批准"
是两回事：前者只能等、**不要重复发布**；后者要用 `npm stage list` / `npm stage approve` 处理。
鉴别方式（含 debug log 里的 `PUT 202`、Bypass 2FA token）见
[`mem/docs/RELEASING.md`](../../mem/docs/RELEASING.md) §1.1 末尾。
