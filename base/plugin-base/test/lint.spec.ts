import { describe, expect, it } from 'vitest'
import { lintManifest, lintManifestText } from '../src/lint.js'

function manifest(items: unknown[], plugin = 'mem'): unknown {
  return { plugin, items }
}

function rulesOf(value: unknown): readonly string[] {
  return lintManifest(value).findings.map(finding => finding.rule)
}

const npmItem = {
  id: 'mem:compat',
  kind: 'npm-package',
  spec: { name: '@avantf/dsh-plugin-base', range: '^0.1.0' },
  target: { root: 'runtime' },
  schemaVersion: 1,
}

describe('provision lint（静态规则）', () => {
  it('合法清单通过', () => {
    const result = lintManifest(
      manifest([
        npmItem,
        { id: 'mem:pandoc', kind: 'binary-archive', spec: { id: 'pandoc', version: '3.11', packs: {} }, target: { root: 'tools' }, needs: ['mem:compat'], schemaVersion: 1 },
        { id: 'mem:model', kind: 'model-cache', spec: { repo: 'BAAI/bge-small-zh-v1.5' }, target: { root: 'models' }, schemaVersion: 1, onMissing: { atStartup: 'degrade', atUse: 'error' } },
      ]),
    )
    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('id 前缀与 plugin 一致性', () => {
    expect(rulesOf(manifest([{ ...npmItem, id: 'compat' }]))).toContain('lint/id-prefix')
    expect(rulesOf({ items: [npmItem] })).toContain('lint/plugin-missing')
    expect(rulesOf(manifest([npmItem, npmItem]))).toContain('lint/id-duplicate')
  })

  it('自定义 kind 必须命名空间化', () => {
    expect(rulesOf(manifest([{ ...npmItem, kind: 'my-kind', spec: {} }]))).toContain('lint/kind-namespace')
    expect(rulesOf(manifest([{ ...npmItem, kind: '@acme/tool', spec: {} }]))).not.toContain('lint/kind-namespace')
    expect(rulesOf(manifest([{ ...npmItem, kind: 'plugin:tool', spec: {} }]))).not.toContain('lint/kind-namespace')
  })

  it('区间必须落在子集内，裸 * 一律拒绝', () => {
    expect(rulesOf(manifest([{ ...npmItem, spec: { name: 'x', range: '>= 1.0.0' } }]))).toContain('lint/range-subset')
    expect(rulesOf(manifest([{ ...npmItem, spec: { name: 'x', range: '1.2.x' } }]))).toContain('lint/range-subset')
    expect(rulesOf(manifest([{ ...npmItem, spec: { name: 'x', range: '*' } }]))).toContain('lint/range-star')
    expect(rulesOf(manifest([{ ...npmItem, spec: { name: 'x', range: '^0.1.0 ||' } }]))).toContain('lint/range-subset')
  })

  it('target 不得绝对/跳出 home/带 version 或 layout', () => {
    expect(rulesOf(manifest([{ ...npmItem, target: { root: '/abs' } }]))).toContain('lint/target-root')
    expect(rulesOf(manifest([{ ...npmItem, target: { root: '../out' } }]))).toContain('lint/target-root')
    expect(rulesOf(manifest([{ ...npmItem, target: { root: 'runtime', version: '1.0.0' } }]))).toContain('lint/target-forbidden')
    expect(rulesOf(manifest([{ ...npmItem, target: { root: 'runtime', layout: 'v1' } }]))).toContain('lint/target-forbidden')
  })

  it('onMissing 取值非法', () => {
    expect(rulesOf(manifest([{ ...npmItem, onMissing: { atStartup: 'ignore' } }]))).toContain('lint/on-missing')
    expect(rulesOf(manifest([{ ...npmItem, onMissing: { atUse: 'refuse' } }]))).toContain('lint/on-missing')
  })

  it('needs：不存在、跨插件、成环', () => {
    expect(rulesOf(manifest([{ ...npmItem, needs: ['mem:nope'] }]))).toContain('lint/needs-missing')
    expect(rulesOf(manifest([{ ...npmItem, needs: ['job:other'] }]))).toContain('lint/needs-cross-plugin')
    const cycle = manifest([
      { ...npmItem, id: 'mem:a', needs: ['mem:b'] },
      { ...npmItem, id: 'mem:b', needs: ['mem:a'] },
    ])
    expect(rulesOf(cycle)).toContain('lint/needs-cycle')
  })

  it('policy 私有键必须带前缀', () => {
    expect(rulesOf(manifest([{ ...npmItem, policy: { mirrors: {} } }]))).toEqual([])
    expect(rulesOf(manifest([{ ...npmItem, policy: { secretSauce: 1 } }]))).toContain('lint/policy-key')
    expect(rulesOf(manifest([{ ...npmItem, policy: { 'plugin:acme': 1 } }]))).not.toContain('lint/policy-key')
  })

  it('policy.timeoutMs 已实现（不再报 unimplemented），concurrency/platforms 仍然未实现', () => {
    expect(rulesOf(manifest([{ ...npmItem, policy: { timeoutMs: 0 } }]))).not.toContain('lint/policy-unimplemented')
    expect(rulesOf(manifest([{ ...npmItem, policy: { concurrency: 2 } }]))).toContain('lint/policy-unimplemented')
    expect(rulesOf(manifest([{ ...npmItem, policy: { platforms: ['linux-x64'] } }]))).toContain('lint/policy-unimplemented')
  })

  it('spec 形状错误与非法 JSON', () => {
    expect(rulesOf(manifest([{ ...npmItem, spec: { name: 'x' } }]))).toContain('lint/spec-shape')
    expect(rulesOf(manifest([{ ...npmItem, kind: 'binary-archive', spec: { id: 'x' } }]))).toContain('lint/spec-shape')
    expect(rulesOf(manifest([{ ...npmItem, kind: 'model-cache', spec: {} }]))).toContain('lint/spec-shape')
    expect(lintManifestText('{ not json').findings[0]?.rule).toBe('lint/json')
  })

  it('未知字段被拒绝（ignored-field 在构建期是硬失败）', () => {
    expect(rulesOf(manifest([{ ...npmItem, maxRetries: 3 }]))).toContain('lint/unknown-field')
    expect(rulesOf({ plugin: 'mem', items: [npmItem], unknownTopLevel: true })).toContain('lint/unknown-field')
    expect(rulesOf(manifest([npmItem]))).not.toContain('lint/unknown-field')
  })

  it('startup 是已知字段，取值只能是 blocking / background', () => {
    expect(rulesOf(manifest([{ ...npmItem, startup: 'background' }]))).not.toContain('lint/unknown-field')
    expect(rulesOf(manifest([{ ...npmItem, startup: 'blocking' }]))).toEqual([])
    expect(rulesOf(manifest([{ ...npmItem, startup: 'later' }]))).toContain('lint/startup')
  })

  it('不判 provider 是否存在（那是运行期的事）', () => {
    const result = lintManifest(manifest([{ ...npmItem, kind: '@ghost/pkg', spec: {} }]))
    expect(result.ok).toBe(true)
  })
})
