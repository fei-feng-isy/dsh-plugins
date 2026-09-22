/**
 * A zero-dependency semver subset: comparators, `||` and `*`.
 * @module semver
 */
import { ProvisionError } from './errors.js'

export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Dot-separated prerelease identifiers; empty for a release. */
  readonly prerelease: readonly (string | number)[]
}

type Operator = '=' | '>' | '>=' | '<' | '<='
interface Comparator {
  readonly op: Operator
  readonly version: Version
}
/** One `||` branch: every comparator must hold. An empty list means "matches any version" (`*`). */
type Alternative = readonly Comparator[]
export type Range = readonly Alternative[]

const NUMERIC = /^\d+$/

/** Parse one strict `1.2.3[-pre][+build]` version; a `v` prefix is tolerated. */
export function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (match === null) return undefined
  const prerelease = match[4] === undefined || match[4] === '' ? [] : match[4].split('.').map(part => (NUMERIC.test(part) ? Number(part) : part))
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease }
}

/** Field-wise compare; a release outranks any prerelease of the same tuple. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  return comparePrerelease(a.prerelease, b.prerelease)
}

function comparePrerelease(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (typeof left === 'number' && typeof right === 'number') {
      if (left !== right) return left - right
    } else if (typeof left === 'number') return -1
    else if (typeof right === 'number') return 1
    else if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** One parsed version token: the digits present plus an optional prerelease. */
interface PartialVersion {
  readonly major: number
  readonly minor: number | undefined
  readonly patch: number | undefined
  readonly prerelease: readonly (string | number)[]
  /** How many of major/minor/patch were written (1..3). */
  readonly parts: 1 | 2 | 3
}

function parsePartial(text: string): PartialVersion | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = match[2] === undefined ? undefined : Number(match[2])
  const patch = match[3] === undefined ? undefined : Number(match[3])
  const parts: 1 | 2 | 3 = patch !== undefined ? 3 : minor !== undefined ? 2 : 1
  const prerelease = match[4] === undefined || match[4] === '' ? [] : match[4].split('.').map(part => (NUMERIC.test(part) ? Number(part) : part))
  return { major, minor, patch, prerelease, parts }
}

function versionOf(partial: PartialVersion, minor: number, patch: number): Version {
  return { major: partial.major, minor, patch, prerelease: partial.prerelease }
}

/** Parse a supported range; throws `invalid-option` for anything outside the subset. */
export function parseRange(range: string): Range {
  const text = range.trim()
  if (text === '') throw new ProvisionError('invalid-option', `版本区间为空：${JSON.stringify(range)}`)
  const branches = text.split('||')
  if (branches.some(branch => branch.trim() === '')) {
    throw new ProvisionError('invalid-option', `版本区间含空备选（会匹配一切）：${JSON.stringify(range)}`)
  }
  return branches.map(branch => parseAlternative(branch.trim()))
}

function parseAlternative(branch: string): Alternative {
  if (branch === '*') return []
  if (/\s-\s/.test(branch)) {
    throw new ProvisionError('invalid-option', `不支持连字符区间，请写成 ">=a <=b"：${JSON.stringify(branch)}`)
  }
  const tokens = branch.split(/[\s,]+/).filter(token => token !== '')
  if (tokens.length === 0) throw new ProvisionError('invalid-option', `版本区间含空备选：${JSON.stringify(branch)}`)
  return tokens.flatMap(token => comparatorsOf(token))
}

function comparatorsOf(token: string): Comparator[] {
  if (token.includes(':')) {
    throw new ProvisionError('invalid-option', `不支持的协议/别名：${JSON.stringify(token)}`)
  }
  const match = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token)
  /* c8 ignore next -- the regex always matches */
  if (match === null) throw new ProvisionError('invalid-option', `无法解析的区间 token：${JSON.stringify(token)}`)
  const operator = match[1] ?? ''
  const rest = match[2] ?? ''
  if (rest === '') {
    // An operator token with no version attached.
    throw new ProvisionError('invalid-option', `运算符后缺少版本（要求紧邻）：${JSON.stringify(token)}`)
  }
  const partial = parsePartial(rest)
  if (partial === undefined) {
    // `1.0.0-next.1` is a legal prerelease; `x`/`X`/`*` are rejected here.
    if (/[xX*]/.test(rest)) {
      throw new ProvisionError('invalid-option', `不支持 x/* 通配，请用 "~1.2" 或 "1.2"：${JSON.stringify(token)}`)
    }
    throw new ProvisionError('invalid-option', `无法解析的版本（dist-tag 不支持）：${JSON.stringify(token)}`)
  }
  const minor = partial.minor ?? 0
  const patch = partial.patch ?? 0
  const version = versionOf(partial, minor, patch)
  switch (operator) {
    case '^':
      return caret(partial, version)
    case '~':
      return tilde(partial, version)
    case '>':
      // A partial `>1.2` becomes `>=1.3.0`.
      return partial.parts === 3 ? [{ op: '>', version }] : [{ op: '>=', version: bumpPartial(partial, true) }]
    case '<=':
      // A partial `<=1.2` becomes `<1.3.0`.
      return partial.parts === 3 ? [{ op: '<=', version }] : [{ op: '<', version: bumpPartial(partial, false) }]
    case '>=':
    case '<':
      return [{ op: operator, version }]
    case '':
    case '=':
      return exact(partial, version)
    /* c8 ignore next -- the regex only captures the operators above */
    default:
      throw new ProvisionError('invalid-option', `不支持的运算符：${JSON.stringify(operator)}`)
  }
}

function exact(partial: PartialVersion, version: Version): Comparator[] {
  if (partial.parts === 3) return [{ op: '=', version }]
  if (partial.parts === 2) {
    return [
      { op: '>=', version },
      { op: '<', version: { major: partial.major, minor: (partial.minor ?? 0) + 1, patch: 0, prerelease: [] } },
    ]
  }
  return [
    { op: '>=', version },
    { op: '<', version: { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] } },
  ]
}

function caret(partial: PartialVersion, version: Version): Comparator[] {
  const { major } = partial
  const minor = partial.minor ?? 0
  const patch = partial.patch ?? 0
  let upper: Version
  if (major > 0 || partial.parts === 1) {
    upper = { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  } else if (minor > 0 || partial.parts === 2) {
    upper = { major: 0, minor: minor + 1, patch: 0, prerelease: [] }
  } else {
    upper = { major: 0, minor: 0, patch: patch + 1, prerelease: [] }
  }
  return [
    { op: '>=', version },
    { op: '<', version: upper },
  ]
}

function tilde(partial: PartialVersion, version: Version): Comparator[] {
  const { major } = partial
  const minor = partial.minor ?? 0
  const upper: Version =
    partial.parts === 1
      ? { major: major + 1, minor: 0, patch: 0, prerelease: [] }
      : { major, minor: minor + 1, patch: 0, prerelease: [] }
  return [
    { op: '>=', version },
    { op: '<', version: upper },
  ]
}

/** The next release boundary a partial `>`/`<=` desugars to: `>1.2` → 1.3.0, `<=1` → 2.0.0. */
function bumpPartial(partial: PartialVersion, keepPrerelease: boolean): Version {
  const prerelease = keepPrerelease ? partial.prerelease : []
  if (partial.parts === 2) return { major: partial.major, minor: (partial.minor ?? 0) + 1, patch: 0, prerelease }
  return { major: partial.major + 1, minor: 0, patch: 0, prerelease }
}

function matchesComparator(version: Version, comparator: Comparator): boolean {
  const order = compareVersions(version, comparator.version)
  switch (comparator.op) {
    case '=':
      return order === 0
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    case '<':
      return order < 0
    case '<=':
      return order <= 0
  }
}

/** Does `version` satisfy `range`? A prerelease matches only a same-tuple prerelease comparator. */
export function satisfies(version: Version, range: Range): boolean {
  return range.some(alternative => {
    if (!alternative.every(comparator => matchesComparator(version, comparator))) return false
    if (version.prerelease.length === 0) return true
    return alternative.some(
      comparator =>
        comparator.version.prerelease.length > 0 &&
        comparator.version.major === version.major &&
        comparator.version.minor === version.minor &&
        comparator.version.patch === version.patch,
    )
  })
}

/** Convenience string × string form; throws `invalid-option` when the range is out of subset. */
export function satisfiesRange(versionText: string, range: string | undefined): boolean {
  const version = parseVersion(versionText)
  if (version === undefined) return false
  if (range === undefined) return true
  if (range.trim() === '*') return true
  return satisfies(version, parseRange(range))
}

/** Throw when `range` is outside the subset. */
export function assertRange(range: string): void {
  parseRange(range)
}

/** Highest release satisfying `range`, or `undefined`; unparseable candidates are ignored. */
export function selectVersion(
  versions: readonly string[],
  range: string,
  filter?: (version: Version) => boolean,
): string | undefined {
  const parsed = versions
    .map(text => ({ text, version: parseVersion(text) }))
    .filter((row): row is { text: string; version: Version } => row.version !== undefined)
    .filter(row => (filter === undefined ? true : filter(row.version)))
  if (range.trim() === '*') {
    return parsed.sort((a, b) => compareVersions(b.version, a.version))[0]?.text
  }
  const parsedRange = parseRange(range)
  return parsed
    .filter(row => satisfies(row.version, parsedRange))
    .sort((a, b) => compareVersions(b.version, a.version))[0]?.text
}
