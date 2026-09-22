/**
 * `provision lint` — the offline, purely static manifest check.
 * @module lint
 */
import { ProvisionError } from './errors.js'
import { assertPackageName } from './package-name.js'
import { assertRange } from './semver.js'
import type { BuiltinKind } from './types.js'

/** The built-in kinds whose names are reserved. */
export const BUILTIN_KINDS: readonly string[] = ['npm-package', 'binary-archive', 'model-cache'] satisfies readonly BuiltinKind[]

/** Item policy keys the core reads. */
export const IMPLEMENTED_POLICY_KEYS: readonly string[] = ['mirrors']

/** Item policy keys the surface declares but this build does not read. */
export const UNIMPLEMENTED_POLICY_KEYS: readonly string[] = ['concurrency', 'timeoutMs', 'platforms']

/** Provision-policy keys the surface declares but this build does not read. */
export const UNIMPLEMENTED_PROVISION_POLICY_KEYS: readonly string[] = [
  'packumentMirrors',
  'quotaBytes',
  'trashGraceMs',
  'gc',
  'preloaded',
]

/** The fields a manifest may carry; anything else is `ignored-field` at runtime. */
export const MANIFEST_FIELDS: readonly string[] = ['plugin', 'items', 'requires']

/** The fields an item may carry. */
export const ITEM_FIELDS: readonly string[] = [
  'id',
  'kind',
  'spec',
  'target',
  'onMissing',
  'startup',
  'needs',
  'policy',
  'schemaVersion',
]

/** The manifest keys this build does not know; empty when the surface matches exactly. */
export function unknownFields(value: unknown, known: readonly string[]): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.keys(value).filter(key => !known.includes(key))
}

export interface LintFinding {
  /** A rule id, stable enough to assert on (`lint/id-prefix`, …). */
  readonly rule: string
  readonly itemId?: string
  readonly message: string
}

export interface LintResult {
  readonly ok: boolean
  readonly findings: readonly LintFinding[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Does any `||` branch contain a bare `*` token (or consist only of `*`)? */
export function hasStarBranch(range: string): boolean {
  return range
    .split('||')
    .some(branch => branch.split(/[\s,]+/).filter(token => token !== '').includes('*') || branch.trim() === '*')
}

/** A third-party kind must be namespaced (`@scope/…` or `plugin:…`). */
export function isNamespacedKind(kind: string): boolean {
  return /^@[^/]+\/.+/.test(kind) || /^plugin:.+/.test(kind)
}

function checkSpec(kind: string, spec: unknown, itemId: string, findings: LintFinding[]): void {
  if (kind === 'npm-package') {
    if (!isRecord(spec)) {
      findings.push({ rule: 'lint/spec-shape', itemId, message: 'npm-package 的 spec 必须是 {name, range}' })
      return
    }
    const name = str(spec['name'])
    if (name === undefined) {
      findings.push({ rule: 'lint/spec-shape', itemId, message: 'npm-package 缺少 spec.name' })
    } else {
      try {
        assertPackageName(name)
      } catch (error) {
        findings.push({ rule: 'lint/spec-shape', itemId, message: error instanceof ProvisionError ? error.message : `非法的包名：${name}` })
      }
    }
    const range = str(spec['range'])
    if (range === undefined) {
      findings.push({ rule: 'lint/spec-shape', itemId, message: 'npm-package 缺少 spec.range' })
    } else if (hasStarBranch(range)) {
      findings.push({
        rule: 'lint/range-star',
        itemId,
        message: '清单区间不得含 `*`（会匹配一切：既可能跨大版本，也会让"未知版本"通过校验）',
      })
    } else {
      try {
        assertRange(range)
      } catch (error) {
        findings.push({
          rule: 'lint/range-subset',
          itemId,
          message: error instanceof ProvisionError ? error.message : `无法解析区间 ${range}`,
        })
      }
    }
    return
  }
  if (kind === 'binary-archive') {
    if (!isRecord(spec) || str(spec['id']) === undefined || str(spec['version']) === undefined || !isRecord(spec['packs'])) {
      findings.push({ rule: 'lint/spec-shape', itemId, message: 'binary-archive 的 spec 必须是 {id, version, packs}' })
    }
    return
  }
  if (kind === 'model-cache') {
    if (!isRecord(spec) || str(spec['repo']) === undefined) {
      findings.push({ rule: 'lint/spec-shape', itemId, message: 'model-cache 的 spec 必须是 {repo, revision?}' })
    }
  }
}

/** Lint a manifest value (already parsed JSON, or a typed object). */
export function lintManifest(manifest: unknown): LintResult {
  const findings: LintFinding[] = []

  if (!isRecord(manifest)) {
    return { ok: false, findings: [{ rule: 'lint/manifest-shape', message: 'manifest 必须是对象' }] }
  }
  for (const key of unknownFields(manifest, MANIFEST_FIELDS)) {
    findings.push({ rule: 'lint/unknown-field', message: `manifest 携带框架不认识的字段：${key}` })
  }
  const plugin = str(manifest['plugin'])
  if (plugin === undefined) findings.push({ rule: 'lint/plugin-missing', message: 'Manifest.plugin 缺失' })
  const items = manifest['items']
  if (!Array.isArray(items)) {
    findings.push({ rule: 'lint/manifest-shape', message: 'Manifest.items 必须是数组' })
    return { ok: findings.length === 0, findings }
  }

  const ids = new Set<string>()
  const needsOf = new Map<string, readonly string[]>()

  for (const raw of items) {
    if (!isRecord(raw)) {
      findings.push({ rule: 'lint/item-shape', message: 'item 必须是对象' })
      continue
    }
    const id = str(raw['id'])
    if (id === undefined) {
      findings.push({ rule: 'lint/item-shape', message: 'item.id 缺失' })
      continue
    }
    for (const key of unknownFields(raw, ITEM_FIELDS)) {
      findings.push({ rule: 'lint/unknown-field', itemId: id, message: `item 携带框架不认识的字段：${key}` })
    }
    if (ids.has(id)) findings.push({ rule: 'lint/id-duplicate', itemId: id, message: `item id 重复：${id}` })
    ids.add(id)

    if (plugin !== undefined && !id.startsWith(`${plugin}:`)) {
      findings.push({ rule: 'lint/id-prefix', itemId: id, message: `item id 必须以 "${plugin}:" 前缀化` })
    }

    const kind = str(raw['kind'])
    if (kind === undefined) {
      findings.push({ rule: 'lint/item-shape', itemId: id, message: 'item.kind 缺失' })
    } else {
      if (!BUILTIN_KINDS.includes(kind) && !isNamespacedKind(kind)) {
        findings.push({ rule: 'lint/kind-namespace', itemId: id, message: `自定义 kind "${kind}" 必须带 @scope/ 或 plugin: 前缀` })
      }
      checkSpec(kind, raw['spec'], id, findings)
    }

    if (typeof raw['schemaVersion'] !== 'number') {
      findings.push({ rule: 'lint/item-shape', itemId: id, message: 'item.schemaVersion 必须是数字' })
    }

    const target = raw['target']
    if (!isRecord(target)) {
      findings.push({ rule: 'lint/target-root', itemId: id, message: 'item.target 必须是 {root}' })
    } else {
      const root = target['root']
      if (typeof root !== 'string' || root === '') {
        findings.push({ rule: 'lint/target-root', itemId: id, message: 'item.target.root 缺失' })
      } else if (root.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(root) || root.replaceAll('\\', '/').split('/').includes('..')) {
        findings.push({ rule: 'lint/target-root', itemId: id, message: `target.root 必须是 home 下的相对路径：${root}` })
      }
      for (const forbidden of ['version', 'layout']) {
        if (forbidden in target) {
          findings.push({ rule: 'lint/target-forbidden', itemId: id, message: `target 不得携带 ${forbidden}` })
        }
      }
    }

    const onMissing = raw['onMissing']
    if (onMissing !== undefined) {
      if (!isRecord(onMissing)) {
        findings.push({ rule: 'lint/on-missing', itemId: id, message: 'onMissing 必须是对象' })
      } else {
        const atStartup = onMissing['atStartup']
        if (atStartup !== undefined && atStartup !== 'degrade' && atStartup !== 'refuse') {
          findings.push({ rule: 'lint/on-missing', itemId: id, message: `onMissing.atStartup 非法：${String(atStartup)}` })
        }
        const atUse = onMissing['atUse']
        if (atUse !== undefined && atUse !== 'degrade' && atUse !== 'error') {
          findings.push({ rule: 'lint/on-missing', itemId: id, message: `onMissing.atUse 非法：${String(atUse)}` })
        }
      }
    }

    const startup = raw['startup']
    if (startup !== undefined && startup !== 'blocking' && startup !== 'background') {
      findings.push({ rule: 'lint/startup', itemId: id, message: `item.startup 非法：${String(startup)}（只能是 blocking / background）` })
    }

    const policy = raw['policy']
    if (policy !== undefined && isRecord(policy)) {
      for (const key of Object.keys(policy)) {
        if (IMPLEMENTED_POLICY_KEYS.includes(key)) continue
        if (UNIMPLEMENTED_POLICY_KEYS.includes(key)) {
          findings.push({ rule: 'lint/policy-unimplemented', itemId: id, message: `policy.${key} 本实现不读取，设置它不会生效` })
          continue
        }
        if (!isNamespacedKind(key)) {
          findings.push({ rule: 'lint/policy-key', itemId: id, message: `policy 的 provider 私有键必须带前缀：${key}` })
        }
      }
    }

    const needs = raw['needs']
    if (needs !== undefined) {
      if (!Array.isArray(needs) || needs.some(need => typeof need !== 'string')) {
        findings.push({ rule: 'lint/needs-shape', itemId: id, message: 'needs 必须是字符串数组' })
      } else {
        needsOf.set(id, needs as readonly string[])
      }
    }
  }

  // Check needs for existence, cross-plugin references and cycles.
  for (const [id, needs] of needsOf) {
    for (const need of needs) {
      if (!ids.has(need)) {
        if (plugin !== undefined && need.includes(':') && !need.startsWith(`${plugin}:`)) {
          findings.push({ rule: 'lint/needs-cross-plugin', itemId: id, message: `needs 不得跨插件引用：${need}` })
        } else {
          findings.push({ rule: 'lint/needs-missing', itemId: id, message: `needs 引用了不存在的 id：${need}` })
        }
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, path: readonly string[]): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      findings.push({ rule: 'lint/needs-cycle', itemId: id, message: `needs 成环：${[...path, id].join(' → ')}` })
      return
    }
    visiting.add(id)
    for (const need of needsOf.get(id) ?? []) if (ids.has(need)) visit(need, [...path, id])
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of needsOf.keys()) visit(id, [])

  return { ok: findings.length === 0, findings }
}

/** Lint a manifest file's text; a JSON parse failure is itself a finding. */
export function lintManifestText(text: string): LintResult {
  try {
    return lintManifest(JSON.parse(text))
  } catch (error) {
    return {
      ok: false,
      findings: [{ rule: 'lint/json', message: `manifest 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }],
    }
  }
}
