/**
 * The 知识域 picker's options and mode, plus the write-form's source-optionality.
 *
 * The picker must offer the configured allowlist TOGETHER WITH the domains already in the library,
 * or a historical name (the kind the allowlist exists to prevent going forward) stops being
 * selectable and the store then refuses it. Rendering itself is exercised through the pure helper,
 * matching the paging spec's approach: this package's tests stay free of React and of the DSH
 * client runtime.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkNewDomain, domainOptions, domainPickerMode } from '../src/client/domains.js'

const CLIENT_SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

describe('domainOptions', () => {
  it('offers the empty choice first, then the configured and existing domains', () => {
    expect(domainOptions({ domains: ['design', 'api', 'Android'], restricted: true }, '请选择知识域')).toEqual([
      { value: '', label: '请选择知识域' },
      { value: 'design', label: 'design' },
      { value: 'api', label: 'api' },
      { value: 'Android', label: 'Android' },
    ])
  })

  it('has only the empty choice when there is no catalog yet', () => {
    expect(domainOptions(null, '全部')).toEqual([{ value: '', label: '全部' }])
  })
})

describe('domainPickerMode', () => {
  it('is a closed select while the allowlist is active', () => {
    expect(domainPickerMode({ domains: ['design'], restricted: true })).toBe('select')
  })

  it('stays a free input when the allowlist is explicitly empty (no restriction)', () => {
    expect(domainPickerMode({ domains: [], restricted: false })).toBe('input')
  })

  it('stays a free input until the host catalog arrives', () => {
    expect(domainPickerMode(null)).toBe('input')
  })
})

describe('checkNewDomain (the 「+」 draft)', () => {
  it('trims and accepts a genuinely new name', () => {
    expect(checkNewDomain(' legal ', ['design', 'api'])).toEqual({ kind: 'new', name: 'legal' })
  })

  it('rejects an empty draft', () => {
    expect(checkNewDomain('   ', ['design'])).toEqual({ kind: 'empty' })
  })

  it('rejects a path separator: the name would not be the directory name', () => {
    expect(checkNewDomain('a/b', [])).toMatchObject({ kind: 'invalid' })
    expect(checkNewDomain('a\\b', [])).toMatchObject({ kind: 'invalid' })
  })

  it('treats a name the picker already offers as a selection, not a write', () => {
    expect(checkNewDomain('design', ['design'])).toEqual({ kind: 'existing', name: 'design' })
  })
})

describe('知识页 write form', () => {
  it('asks the host for the domain catalog through the UI-only remote method', () => {
    expect(CLIENT_SOURCE).toContain('remote.kbDomains({})')
  })

  it('offers 「+」 on the write form only, through its own UI-only remote method', () => {
    // The write form hands `DomainField` the persister; the query filter does not, so 「+」 cannot
    // appear where adding a domain makes no sense.
    expect(CLIENT_SOURCE).toContain('onAdd: addDomain')
    expect(CLIENT_SOURCE).toContain('remote.kbAddDomain({ domain })')
  })

  it('renders no explanatory sentence under the select', () => {
    // The domain control sits in a row of sibling filters, and a hint line under the select made
    // that row taller than its neighbours. The 「+」 is the only affordance, and it is on the label.
    expect(CLIENT_SOURCE).not.toContain('新增领域请改配置')
    expect(CLIENT_SOURCE).not.toContain('改配置 knowledge.domains')
  })

  it('no longer marks the source field required', () => {
    expect(CLIENT_SOURCE).toContain("label: '来源（source）'")
    expect(CLIENT_SOURCE).not.toContain("'来源（source）*'")
    // `canIngest` gates the 入库 button; an empty source must be allowed (it defaults to `default`).
    expect(CLIENT_SOURCE).not.toContain('iSource.trim().length > 0')
  })

  it('sends an empty source as absent, so the contract can default it', () => {
    expect(CLIENT_SOURCE).toContain('const source = iSource.trim() || undefined')
  })

  it('stacks the 入库 form as a gapped column, not flush block rows', () => {
    // `.item` is a plain block card: without a column gap the field row, the mode toggle, the
    // source box and the action row touch each other. The class pair is the whole fix, so a future
    // edit that drops `css.form` would silently bring the crowding back.
    expect(CLIENT_SOURCE).toContain('${css.item} ${css.form}')
    const css = readFileSync(new URL('../src/client/pages.module.css', import.meta.url), 'utf8')
    expect(/\.form \{[\s\S]*?flex-direction: column;[\s\S]*?gap: 8px;/.test(css)).toBe(true)
  })
})
