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
 * Usage:
 *   node scripts/check-dsh-lines.mjs [--registry <url>] [--json]
 *
 * 退出码 1 表示：某个 dist-tag（latest / next …）指向的版本覆盖不到，或存在**比已覆盖的最高线更高**的未覆盖
 * 线——两者都意味着"dsh 一升级，插件行就会被禁用"。低于已覆盖线的历史未覆盖线（例如 0.0.x）只是备注。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 声明 dsh peer 的两棵树；base 自己不声明（它由插件加载）。 */
const MANIFESTS = ['mem/packages/plugin/package.json', 'work/packages/plugin/package.json']
const PACKAGE = '@deepseek-ai/dsh'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/check-dsh-lines.mjs [--registry <url>] [--json]')
  process.exit(0)
}
const asJson = argv.includes('--json')
const registryIndex = argv.indexOf('--registry')
const registry = registryIndex >= 0 ? argv[registryIndex + 1] : undefined
if (registryIndex >= 0 && (registry === undefined || registry.startsWith('--'))) fail('--registry needs a URL')
for (const [index, arg] of argv.entries()) {
  if (arg.startsWith('--') && !['--registry', '--json', '--help', '-h'].includes(arg)) fail(`unknown option ${arg}`)
  if (!arg.startsWith('--') && argv[index - 1] !== '--registry') fail(`unexpected argument ${arg}`)
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
    globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
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
    return JSON.parse(execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  } catch (error) {
    fail(`\`npm view ${PACKAGE} ${field}\` failed (${error.message.split('\n')[0]})`)
  }
}

/** 实际问的是哪个 registry —— 用户可能是镜像源，那会滞后于上游。 */
function effectiveRegistry() {
  if (registry !== undefined) return registry
  try {
    return execFileSync('npm', ['config', 'get', 'registry'], { encoding: 'utf8' }).trim()
  } catch {
    return '(npm config get registry 失败)'
  }
}

const declared = declaredRanges()
const { semver, from } = loadGateSemver()
// `npm view --json` 对单值/多值的形状不稳定：versions 可能是字符串，dist-tags 可能是 `[{latest: …}]`。
const versions = [npmView('versions')].flat().filter((entry) => typeof entry === 'string')
const rawTags = npmView('dist-tags')
const tags = (Array.isArray(rawTags) ? rawTags : [rawTags]).reduce((all, entry) => Object.assign(all, entry), {})
if (versions.length === 0) fail('the registry returned no versions')

/** 一个版本是否被**任一**棵树的声明覆盖（两棵树不一致时也仍然只报"谁漏了"）。 */
const coveredBy = (version) => [...declared.entries()]
  .filter(([, ranges]) => ranges.some((range) => semver.satisfies(version, range, { includePrerelease: true })))
  .map(([name]) => name)

/** 按 major.minor 分线，线内取最高版本做代表。 */
const lines = new Map()
for (const version of versions) {
  const parsed = semver.parse(version)
  if (parsed === null) continue
  const line = `${parsed.major}.${parsed.minor}`
  const current = lines.get(line)
  if (current === undefined || semver.gt(version, current.newest)) lines.set(line, { line, newest: version, count: (current?.count ?? 0) + 1 })
  else lines.set(line, { ...current, count: current.count + 1 })
}
const ordered = [...lines.values()]
  .map((entry) => ({ ...entry, covered: coveredBy(entry.newest) }))
  .sort((a, b) => semver.compare(`${a.line}.0`, `${b.line}.0`))

const highestCovered = [...ordered].reverse().find((entry) => entry.covered.length > 0)
const tagRows = Object.entries(tags).map(([tag, version]) => ({ tag, version, covered: coveredBy(version) }))
const uncoveredTags = tagRows.filter((row) => row.covered.length === 0)
const higherUncovered = ordered.filter((entry) => entry.covered.length === 0
  && (highestCovered === undefined || semver.gt(entry.newest, highestCovered.newest)))

if (asJson) {
  console.log(JSON.stringify({ declared: Object.fromEntries(declared), semverFrom: from, tags: tagRows, lines: ordered, uncoveredTags, higherUncovered }, null, 2))
  process.exit(uncoveredTags.length > 0 || higherUncovered.length > 0 ? 1 : 0)
}

const distinct = [...new Set([...declared.values()].flat())]
console.log(`${PACKAGE} 声明：${distinct.join('  ||  ')}`)
console.log(`  mem:  ${(declared.get('@avantf/dsh-mem') ?? []).join('  ||  ')}`)
console.log(`  work: ${(declared.get('@avantf/dsh-work') ?? []).join('  ||  ')}`)
console.log('判定：satisfies(version, range, { includePrerelease: true }) —— 与 dsh 启动门同一份实现')
console.log(`      （semver 取自 ${from}；版本列表取自 ${effectiveRegistry()}）`)
console.log(`已发布 ${versions.length} 个版本，分 ${ordered.length} 条线：\n`)
console.log('  线      代表版本          覆盖        备注')
for (const entry of ordered) {
  const tagNames = tagRows.filter((row) => semver.eq(row.version, entry.newest)).map((row) => row.tag)
  const notes = []
  if (tagNames.length > 0) notes.push(`dist-tag: ${tagNames.join(', ')}`)
  if (entry.covered.length === 0) notes.push('未覆盖')
  console.log(`  ${entry.line.padEnd(7)}${entry.newest.padEnd(18)}${(entry.covered.length > 0 ? '✓' : '✗').padEnd(11)}${notes.join('; ')}`)
}

let bad = false
if (uncoveredTags.length > 0) {
  bad = true
  console.log('\n⚠ dist-tag 指向的版本覆盖不到：')
  for (const row of uncoveredTags) console.log(`    ${row.tag} → ${row.version}`)
}
if (higherUncovered.length > 0) {
  bad = true
  console.log('\n⚠ 出现了比已覆盖最高线更高的未覆盖线（dsh 一升上去，插件行就会被启动门禁用）：')
  for (const entry of higherUncovered) console.log(`    ${entry.line} 线（代表 ${entry.newest}，共 ${entry.count} 个版本）`)
  const newest = higherUncovered[higherUncovered.length - 1]
  const suggested = `${distinct.join(' || ')} || ^${newest.newest}`
  console.log(`\n  建议：把 dsh peer 区间补成 '${suggested}'`)
  console.log(`  补之前先实测那条线能跑：node scripts/check-old-dsh.mjs mem --floor ${newest.newest}`)
}

if (bad) {
  console.log('\ncheck-dsh-lines: 需要处理（见上）')
  process.exit(1)
}
console.log(`\ncheck-dsh-lines: ok —— 所有 dist-tag（${tagRows.map((row) => `${row.tag}=${row.version}`).join(', ')}）都被声明覆盖，也没有更高的未覆盖线。`)
