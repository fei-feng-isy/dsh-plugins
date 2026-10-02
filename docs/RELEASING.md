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

## 怎么发

```bash
# 1) 切版本：每组只改那一个 manifest（base 组会一并同步 baked VERSION）
pnpm version:set base  <x.y.z>
pnpm version:set mem   <x.y.z>
pnpm version:set mission <x.y.z>
pnpm version:check                  # 每组版本只记在一处；base manifest 与 baked VERSION 一致

# 2) 严格门禁（全量）：可发布集合 / peer / 一份 zod / registry 上已有兼容 base
pnpm release:check
# 每包自己的门禁：链接 → 编译 → 类型检查 → 测试 → pack（mem/mission 还含真 Cordis mount smoke）
pnpm release:check:base
pnpm release:check:mem
pnpm release:check:mission

# 3) 发布前断言（各包的 prepublishOnly 也会自动跑；这里可先手工过一遍）
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
