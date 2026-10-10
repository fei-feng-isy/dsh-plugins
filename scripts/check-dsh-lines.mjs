#!/usr/bin/env node
/**
 * 监测：dsh 已经发布的版本里，有没有我们的 dsh peer 声明**覆盖不到**的。
 *
 * WHY THIS EXISTS. dsh ≥ 0.2.0-rc.2 在 boot 时按插件的 `peerDependencies` 判兼容，判不兼容就把那一行
 * **禁用**（不是告警）——而 semver 的预发布规则意味着新开一条 minor 线时，旧声明一定覆盖不到它。等发现
 * 已经太晚：那是在用户重启 GUI、插件整行消失的时候。这条命令把发现提前到"dsh 刚发新版"这一刻。
 *
 * HOW IT JUDGES. 用**装在本机的那份 dsh 自带的 semver**，并按 dsh 的门禁原样传
 * `{ includePrerelease: true }`（`dsh-app-boot` 的 peer 检查就是这么判的）。关键后果：caret 的上界会变成
 * `<X.Y+1.0-0`，所以 `^0.2.0-rc.2` **覆盖整条 0.2.x 线**（`0.2.1-rc.1`、`0.2.9-rc.3`、0.2.x 正式版都算），
 * 只有**跨 minor 线**才会漏。别用本仓 base 的 `satisfiesRange` 来对这件事下结论：它走默认规则（不带
 * includePrerelease），比 dsh 的门禁更严，会给出"漏了"的假警报（那个规则是给安装期 peer 检查用的）。
 *
 * 判定**按树分别做**（M8）：dsh 启动门按行禁用，只被 mem 覆盖、mission 缺声明的线，对 mission 已经坏了。
 * 旧的"任一树覆盖即算覆盖"（并集）让这种单树漏永远打印 ok。现在 exit 1 有两种形状（见 gates.mjs 的
 * `judgeDshLines`）：① `missingLines`——**有树覆盖、另一棵树漏**的线（并集掩盖的正是它，且不分高低）；
 * ② `higherUncovered`——**比"每棵树都覆盖"的最高线更高、没有任何树覆盖**的线；另外任一 dist-tag 只要有
 * 一棵树覆盖不到也 exit 1。没有任何树覆盖、且低于最高全覆线的历史线（例如 0.0.x）仍只是备注。
 * 纯判定在 `scripts/lib/gates.mjs` 的 `judgeDshLines` 里，可用构造输入复跑。
 *
 * Usage:
 *   node scripts/check-dsh-lines.mjs [--registry <url>] [--json]
 *   node scripts/check-dsh-lines.mjs --fixture <file> --json   # judge a JSON fixture, no network
 *       fixture: { declared?: { <tree>: [ranges] }, versions: [...], tags: { <tag>: <version> } }
 *       (`declared` overrides the manifests — how scripts/gates.test.mjs replays the per-tree rule)
 *
 * 退出码 1 表示：某个 dist-tag（latest / next …）指向的版本有**任一**声明树覆盖不到，或存在上述两种线
 * 之一——都意味着"dsh 一升级，那棵树的插件行就会被启动门禁用"。低于已覆盖线的历史未覆盖线（例如
 * 0.0.x）只是备注。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { judgeDshLines } from './lib/gates.mjs'
import { execToolSync } from './lib/win-spawn.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 声明 dsh peer 的插件树；base 自己不声明（它由插件加载）。 */
const MANIFESTS = ['mem/packages/plugin/package.json', 'mission/packages/plugin/package.json', 'identity/packages/plugin/package.json']
const PACKAGE = '@deepseek-ai/dsh'

/**
 * Every `npm` call below goes through `scripts/lib/win-spawn.mjs`.
 *
 * WHY. On win32 `npm` is a `.cmd` shim and Node refuses to spawn one without a shell (CVE-2024-27980),
 * so `npm root -g` here failed with EINVAL and the whole gate died with "cannot run `npm root -g`".
 * Naming the file (`npm.cmd`) does NOT fix it — measured on Windows node v25.2.1: the no-shell spawn
 * of a `.cmd` is still EINVAL, `{ shell: true }` works but emits DEP0190, and `cmd.exe /c npm.cmd …`
 * works with no warning. The helper owns that choice; this file no longer keeps its own copy.
 */

/** Assigned by `main()`; the helpers below run only from there. */
let registry

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/check-dsh-lines.mjs [--registry <url>] [--json] [--fixture <file>]')
    console.log('  --fixture <file>  judge a JSON fixture instead of the registry: { declared?, versions, tags }')
    console.log('                    (declared overrides the manifests; used by scripts/gates.test.mjs)')
    process.exit(0)
  }
  const asJson = argv.includes('--json')
  const registryIndex = argv.indexOf('--registry')
  registry = registryIndex >= 0 ? argv[registryIndex + 1] : undefined
  if (registryIndex >= 0 && (registry === undefined || registry.startsWith('--'))) fail('--registry needs a URL')
  const fixtureIndex = argv.indexOf('--fixture')
  const fixturePath = fixtureIndex >= 0 ? argv[fixtureIndex + 1] : undefined
  if (fixtureIndex >= 0 && (fixturePath === undefined || fixturePath.startsWith('--'))) fail('--fixture needs a file')
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--') && !['--registry', '--json', '--fixture', '--help', '-h'].includes(arg)) fail(`unknown option ${arg}`)
    if (!arg.startsWith('--') && !['--registry', '--fixture'].includes(argv[index - 1])) fail(`unexpected argument ${arg}`)
  }

  function fail(message) {
    console.error(`check-dsh-lines: ${message}`)
    process.exit(1)
  }

  /** 声明：每棵树里所有 `@deepseek-ai/dsh*` peer 区间的集合。 */
  function declaredRanges() {
    const ranges = new Map()
    for (const manifest of MANIFESTS) {
      const pkg = JSON.parse(readFileSync(join(workspace, manifest), 'utf8'))
      const found = new Set()
      for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
        if (name !== PACKAGE && !name.startsWith(`${PACKAGE}-`)) continue
        found.add(range)
      }
      if (found.size === 0) fail(`${pkg.name} declares no ${PACKAGE}* peer`)
      ranges.set(pkg.name, [...found])
    }
    return ranges
  }

  /** 本机 dsh 自带的那份 semver —— 与门禁同一份判定实现。 */
  function loadGateSemver() {
    const require = createRequire(import.meta.url)
    let globalRoot
    try {
      globalRoot = execToolSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    } catch (error) {
      fail(`cannot run \`npm root -g\` to find the installed dsh (${error.message})`)
    }
    const candidates = [
      join(globalRoot, PACKAGE, 'node_modules', 'semver'),
      join(workspace, 'node_modules', 'semver'),
    ]
    for (const candidate of candidates) {
      try {
        const semver = require(candidate)
        if (typeof semver.satisfies === 'function') return { semver, from: candidate }
      } catch {}
    }
    fail(`no semver to judge with (looked for the installed dsh's copy at ${candidates[0]})`)
  }

  function npmView(field) {
    const args = ['view', PACKAGE, field, '--json']
    if (registry !== undefined) args.push('--registry', registry)
    try {
      return JSON.parse(execToolSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
    } catch (error) {
      fail(`\`npm view ${PACKAGE} ${field}\` failed (${error.message.split('\n')[0]})`)
    }
  }

  /** 实际问的是哪个 registry —— 用户可能是镜像源，那会滞后于上游。 */
  function effectiveRegistry() {
    if (registry !== undefined) return registry
    try {
      return execToolSync('npm', ['config', 'get', 'registry'], { encoding: 'utf8' }).trim()
    } catch {
      return '(npm config get registry 失败)'
    }
  }

  const fixture = fixturePath === undefined ? undefined : JSON.parse(readFileSync(resolve(fixturePath), 'utf8'))
  const declared = fixture?.declared === undefined ? declaredRanges() : new Map(Object.entries(fixture.declared))
  const { semver, from } = loadGateSemver()
  // `npm view --json` 对单值/多值的形状不稳定：versions 可能是字符串，dist-tags 可能是 `[{latest: …}]`。
  let versions
  let tags
  if (fixture === undefined) {
    versions = [npmView('versions')].flat().filter((entry) => typeof entry === 'string')
    const rawTags = npmView('dist-tags')
    tags = (Array.isArray(rawTags) ? rawTags : [rawTags]).reduce((all, entry) => Object.assign(all, entry), {})
  } else {
    versions = [fixture.versions ?? []].flat().filter((entry) => typeof entry === 'string')
    tags = fixture.tags ?? {}
  }
  if (versions.length === 0) fail('the selected source returned no versions')
  const versionSource = fixture === undefined ? effectiveRegistry() : `fixture ${fixturePath}`

  // 判定在 scripts/lib/gates.mjs 里（纯函数，可用构造输入复跑）：按树分别判，任一树漏即算漏。
  const { trees, treeRanges, distinct, declaredDivergence, lines, tagRows, uncoveredTags, missingLines, higherUncovered } =
    judgeDshLines({ declared, versions, tags, semver })

  if (asJson) {
    console.log(JSON.stringify({
      declared: Object.fromEntries(declared), semverFrom: from, trees, declaredDivergence,
      tags: tagRows, lines, uncoveredTags, missingLines, higherUncovered,
    }, null, 2))
    process.exit(uncoveredTags.length > 0 || missingLines.length > 0 || higherUncovered.length > 0 ? 1 : 0)
  }

  console.log(`${PACKAGE} 声明：${distinct.join('  ||  ')}`)
  for (const tree of trees) console.log(`  ${tree}: ${(treeRanges[tree] ?? []).join('  ||  ')}`)
  console.log('判定：satisfies(version, range, { includePrerelease: true }) —— 与 dsh 启动门同一份实现，且**按树分别判**')
  console.log(`      （semver 取自 ${from}；版本列表取自 ${versionSource}）`)
  console.log(`已发布 ${versions.length} 个版本，分 ${lines.length} 条线：\n`)
  console.log('  线      代表版本          覆盖                备注')
  for (const entry of lines) {
    const tagNames = tagRows.filter((row) => semver.eq(row.version, entry.newest)).map((row) => row.tag)
    const notes = []
    if (tagNames.length > 0) notes.push(`dist-tag: ${tagNames.join(', ')}`)
    if (entry.missing.length > 0) notes.push(`缺: ${entry.missing.join(', ')}`)
    const covered = entry.covered.length === trees.length
      ? `✓ 全部(${trees.length})`
      : (entry.covered.length > 0 ? `部分: ${entry.covered.join(',')}` : '✗')
    console.log(`  ${entry.line.padEnd(7)}${entry.newest.padEnd(18)}${covered.padEnd(20)}${notes.join('; ')}`)
  }

  let bad = false
  if (declaredDivergence) {
    console.log('\n⚠ 两棵树声明的 dsh 区间不一致（并集掩盖单树漏的成因，保持同步）：')
    for (const tree of trees) console.log(`    ${tree}: ${(treeRanges[tree] ?? []).join('  ||  ')}`)
  }
  if (uncoveredTags.length > 0) {
    bad = true
    console.log('\n⚠ dist-tag 指向的版本有树覆盖不到（dsh 一升上去，那棵树整行就被启动门禁用）：')
    for (const row of uncoveredTags) console.log(`    ${row.tag} → ${row.version}（缺：${row.missing.join(', ')}）`)
  }
  if (missingLines.length > 0) {
    bad = true
    console.log('\n⚠ 有树覆盖、另一棵树漏的线（并集掩盖的正是这种单树漏；漏的那棵树在这条线上整行会被禁用）：')
    for (const entry of missingLines) {
      console.log(`    ${entry.line} 线（代表 ${entry.newest}，共 ${entry.count} 个版本；缺：${entry.missing.join(', ')}；已有：${entry.covered.join(', ')}）`)
    }
  }
  if (higherUncovered.length > 0) {
    bad = true
    console.log('\n⚠ 出现了比"每棵树都覆盖"的最高线更高的、没有任何树覆盖的线（dsh 一升上去，所有插件行都会被启动门禁用）：')
    for (const entry of higherUncovered) {
      console.log(`    ${entry.line} 线（代表 ${entry.newest}，共 ${entry.count} 个版本）`)
    }
  }
  const toFix = [...new Set([...missingLines, ...higherUncovered]
    .flatMap((entry) => entry.missing.map((tree) => `${tree}@${entry.newest}`)))]
    .map((key) => { const at = key.lastIndexOf('@'); return { tree: key.slice(0, at), newest: key.slice(at + 1) } })
  for (const { tree, newest } of toFix) {
    const suggested = [...(treeRanges[tree] ?? []), `^${newest}`].join(' || ')
    const group = tree.replace('@avantf/dsh-', '')
    console.log(`\n  建议：把 ${tree} 的 dsh peer 区间补成 '${suggested}'`)
    console.log(`  补之前先实测那条线能跑：node scripts/check-old-dsh.mjs ${group} --floor ${newest}`)
  }

  if (bad) {
    console.log('\ncheck-dsh-lines: 需要处理（见上）')
    process.exit(1)
  }
  console.log(`\ncheck-dsh-lines: ok —— 所有 dist-tag（${tagRows.map((row) => `${row.tag}=${row.version}`).join(', ')}）都被**每一棵**声明树覆盖，也没有更高的、有树覆盖不到的线。`)

}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
