# 发布（根工作区）

三个**可发布包**，按顺序 **base → 插件** 发布（插件把 base 声明为 required peer，base 不在
registry 上时插件装不上）：

| 顺序 | 包 | 目录 |
| --- | --- | --- |
| 1 | `@avantf/dsh-plugin-base` | `base/plugin-base` |
| 2 | `@avantf/dsh-mem` | `mem/packages/plugin` |
| 3 | `@avantf/dsh-mission` | `mission/packages/plugin` |

**自 2026-10-03 起直接从本仓发布**：不再投影到 `../dsh-plugins-rc`，也不再有"发布树"这一步
（第五轮复审 §1.5/§7.11，用户拍板：RC 只贡献 drift 风险，dev 直接 publish）。

## 为什么退役 RC

RC（`../dsh-plugins-rc`）当初存在的唯一理由是产生三处差异：

1. **排除 RC 工具链**——发布仓是生成出来的，它自己不再生成任何东西；
2. **版本盖章**——`--version <组>=<v>` 把版本写进该组**唯一**记录版本的那份 manifest；
3. **生成根 README**——开发仓当时没有根 README。

到 2026-10-03，实测 `../dsh-plugins-rc` 仍是 `work/` 时代的快照（workspace 里写
`work/packages/*`、根 scripts 还是 `release:check:work`、发过仓里不存在的
`@avantf/dsh-work@0.2.0`）——"保留但不用"是最差的一档。于是这三处差异被降为**发布前在开发树里
必须成立**的断言（`scripts/prepublish-assert.mjs`，见下）；投影机制本身（`release:tree` /
`sync:rc` 与 `scripts/make-release-tree.mjs`、`scripts/sync-release-repo.sh`）已从仓库删除。

`../dsh-plugins-rc` 目录**已废弃、不再投影**：不要从它发布，也不要再往里同步。它不在本仓，
本仓不再有代码引用它。

## 收口分两档（2026-10-03）

"每次派发完成后跑什么"与"发版前跑什么"现在是两条命令，由 `scripts/check-tier.mjs` 统一定义
（完整对照表、实测数字与并行安全性判定见 `CLOSURE-TIERS.md`）：

| 档 | 命令 | 什么时候 |
| --- | --- | --- |
| **快档** | `pnpm check:fast <base\|mem\|mission\|root>`（不给树名则从 git 自动判） | 日常每个派发任务结束后（默认档） |
| **发版档** | `pnpm check:release` | 发版前；改 `base/**`、发布面/接口、门禁脚本或版本号 |

- **快档**：只覆盖被改到的那棵树 —— build + typecheck + 该树**一次**全套测试，再加
  `guard` + 四个自测 + `prepublish:assert`。**不跑** `old-dsh` / pack / mount smoke /
  根 `release:check`。它证明"这棵树的源码编译、类型自洽、测试通过"，**不证明**"产物能挂、在
  dsh 下限上能跑、发布面自洽"。
- **发版档**：三个包的严格门禁（含 pack 与 `old-dsh` 下限门）+ 两棵树的 mount smoke
  （在各自严格门禁里）+ 根 `release:check` + `prepublish:assert`。
- 两档都去重：一条流程里测试只跑一次，base 在快档里只构建一次。发版档仍会看到各树严格门禁
  内部重建 base——那是三棵树各自的黑盒门禁，根脚本不修改三棵树，去不掉（见 `CLOSURE-TIERS.md`）。

## 怎么发

```bash
# 1) 切版本：每组只改那一个 manifest（base 组会一并同步 baked VERSION）
pnpm version:set base  <x.y.z>
pnpm version:set mem   <x.y.z>
pnpm version:set mission <x.y.z>
pnpm version:check                  # 每组版本只记在一处；base manifest 与 baked VERSION 一致

# 1b) 动了 base 组的版本时：重新 vendor 两棵插件的 src/envinit-bootstrap.{js,d.ts} 并**一起提交**。
#     它内嵌 base 的 VERSION、会随产物内联（家族硬约束 1），任一门禁 / build:dsh 会自动刷新它，
#     所以"版本提交"之后工作区会多出这两份派生物——漏提交就会让入库的树与 tarball 不一致
#     （0.4.1 发版时踩过一次，见 93c2a5b）。
pnpm build:dsh base && pnpm build:dsh mem && pnpm build:dsh mission

# 2) 发版档（三个严格门禁 + 两棵树 mount smoke + 根发布面 + 发布前断言）
pnpm check:release
# 需要单独重跑某一包时，仍可用它自己的门禁（链接 → 编译 → 类型检查 → 测试 → pack，
# mem/mission 还含真 Cordis mount smoke）：
pnpm release:check:base
pnpm release:check:mem
pnpm release:check:mission

# 3) 需要时单独跑发布前断言（发版档已包含；各包的 prepublishOnly 也会自动跑）
node scripts/prepublish-assert.mjs
#   打包之后还可以断言"真实产物字节"里没有发布工具链、README 是这一包的：
node scripts/prepublish-assert.mjs --tarball dist/avantf-dsh-mem-<x.y.z>.tgz

# 4) 从本仓发布，严格按 base → 插件的顺序
pnpm -C base/plugin-base publish --access public
pnpm -C mem/packages/plugin publish --access public
pnpm -C mission/packages/plugin publish --access public
```

mem 发版前还要把 `mem/CHANGELOG.md` 的版本段切好（mem 自己的严格门禁会检查，
`[Unreleased]` 必须为空）。每个包 publish 时都会触发它的 `prepublishOnly`。

## 发布前断言（替代 RC 的三处差异）

`scripts/prepublish-assert.mjs` 只读、不构建、不打包、不发版、不联网，断言四条：

| 断言 | 替代的 RC 差异 | 拦住什么 |
| --- | --- | --- |
| 可发布集合恰好是三个（base + 两个插件），其余 workspace 包必须 `private: true`，根 manifest 必须 private | 排除 RC 工具链 | 内部引擎包误发、根工作区/发布工具链被发出去 |
| 每组版本只记在**一份** manifest 里、是合法 semver、私有 manifest 不重复记它、base 的 baked `VERSION` 与 manifest 一致 | 版本盖章 | 版本没盖、盖错、base 两处版本分叉 |
| 每个可发布包都有自己的 `README.md`，首行是 `# <包名>` | 生成 README | README 没随包、复制/改名串了包页 |
| 没有任何可发布包通过 `files` 装进（或指向）本仓的发布工具链；`files` 不许逃出包目录 | 排除 RC 工具链 | 产物里出现发布专用工具 |

用法：

```bash
node scripts/prepublish-assert.mjs                              # 整张发布面
node scripts/prepublish-assert.mjs --package @avantf/dsh-mem    # 顺带确认这是三个之一
node scripts/prepublish-assert.mjs --tarball <path.tgz>         # 追加"真实产物字节"断言
```

要把这张断言接进发布流程，在每个可发布包的 `prepublishOnly` 前面加一条（相对路径按包目录）：

```jsonc
// base/plugin-base/package.json
"prepublishOnly": "node ../../scripts/prepublish-assert.mjs --package @avantf/dsh-plugin-base && pnpm release:check"

// mem/packages/plugin/package.json
"prepublishOnly": "node ../../../scripts/prepublish-assert.mjs --package @avantf/dsh-mem && node ../../scripts/pack-plugin.mjs"

// mission/packages/plugin/package.json
"prepublishOnly": "node ../../../scripts/prepublish-assert.mjs --package @avantf/dsh-mission && node ../../scripts/pack-plugin.mjs"
```

## 根 script 说明

`release:tree` 与 `sync:rc` 两个根 script、以及 `scripts/make-release-tree.mjs` /
`scripts/sync-release-repo.sh` **已退役**。如果根 `package.json` 里还列着这两个 script 条目，
删掉它们——它们指向的文件已不在仓库里。
