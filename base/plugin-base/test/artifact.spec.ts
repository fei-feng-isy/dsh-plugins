import { describe, expect, it } from 'vitest'
import { findFrameworkImports, findInliningBeacons, isBootstrapSpecifier } from '../src/artifact.js'

describe('artifact scanner', () => {
  it('finds static, dynamic, require and side-effect specifiers', () => {
    const text = [
      `import { createProvisioner } from '@avantf/dsh-plugin-base'`,
      `import '@avantf/dsh-plugin-base/bootstrap'`,
      `const mod = await import("@avantf/dsh-plugin-base/bootstrap")`,
      `const other = require('@avantf/dsh-plugin-base/sub')`,
    ].join('\n')
    const found = findFrameworkImports(text)
    expect(found.map(entry => [entry.kind, entry.specifier])).toEqual([
      ['static', '@avantf/dsh-plugin-base'],
      ['side-effect', '@avantf/dsh-plugin-base/bootstrap'],
      ['dynamic', '@avantf/dsh-plugin-base/bootstrap'],
      ['require', '@avantf/dsh-plugin-base/sub'],
    ])
    expect(found.map(entry => entry.bootstrap)).toEqual([false, true, true, false])
  })

  it('does not mistake the inlined bootstrap constants for module specifiers', () => {
    const inlined = [
      `const PACKAGE = '@avantf/dsh-plugin-base';`,
      'const url = `${registry}/${PACKAGE}`;',
      `options.logger?.warn('bootstrap: ' + PACKAGE)`,
    ].join('\n')
    expect(findFrameworkImports(inlined)).toEqual([])
  })

  it('ignores unrelated specifiers that merely contain the name', () => {
    const text = `import x from 'not-@avantf/dsh-plugin-base'\nimport y from '@avantf/dsh-plugin-base-clone'`
    expect(findFrameworkImports(text)).toEqual([])
  })

  it('classifies the bootstrap subpath and its children', () => {
    expect(isBootstrapSpecifier('@avantf/dsh-plugin-base/bootstrap')).toBe(true)
    expect(isBootstrapSpecifier('@avantf/dsh-plugin-base/bootstrap/inner.js')).toBe(true)
    expect(isBootstrapSpecifier('@avantf/dsh-plugin-base')).toBe(false)
  })

  it('spots an inlined framework by its control-plane literals', () => {
    const inlined = `const a = '.status.lock'; const b = '.layout.json'; const c = '.quarantine'`
    expect(findInliningBeacons(inlined)).toHaveLength(3)
    expect(findInliningBeacons(`const a = '.envinit'`)).toEqual(['.envinit'])
    expect(findInliningBeacons(`console.log('nothing framework specific')`)).toEqual([])
  })
})
