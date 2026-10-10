/**
 * The browser half's WIRING, which is what no offline test covered.
 *
 * A real browser blanked the whole settings pane while its nav entry stayed: the page resolved
 * `ctx.get('configForms')` — the settings domain SERVICE — as if it were one namespace's form, so the
 * component's effect called `next.subscribe(...)` on an object without `subscribe` and React tore the
 * subtree down. A render test would not have caught it either: the throw lives in the EFFECT, which a
 * server render never runs.
 *
 * So the assertions below read the element's own props (the real closure the browser gets) and check the
 * one hop that was wrong — service → `service.get(rowId)`. They are deliberately written against the
 * mistake: handing the service straight in must NOT produce a form.
 */
import { describe, expect, it, vi } from 'vitest'

// A hooks dispatcher good enough to RUN the component, including re-renders: the failures this file
// guards against were a render crash on a partial wire result and the dialog flows, neither of which a
// server render ("no effects") or a registration smoke ever reaches. `useState` keeps its value across
// renders and its setter writes it back, so "click, then look at the next tree" is testable without a DOM.
const hooks = vi.hoisted(() => ({
  /** Prepared initial values in source order; past the end the component's own initializer wins. */
  queue: [] as unknown[],
  /** Live state, carried across renders within one test. */
  values: [] as unknown[],
  /** Every `t(key, params)` the page asked for, so interpolation can be asserted. */
  calls: [] as unknown[],
  cursor: 0,
}))

vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...(props as object), children } }),
  useState: (initial: unknown) => {
    const index = hooks.cursor
    hooks.cursor += 1
    if (index >= hooks.values.length) {
      hooks.values[index] = hooks.queue.length > index ? hooks.queue[index] : initial
    }
    const set = (next: unknown): void => {
      hooks.values[index] =
        typeof next === 'function' ? (next as (current: unknown) => unknown)(hooks.values[index]) : next
    }
    return [hooks.values[index], set]
  },
  useEffect: () => undefined,
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initial: unknown) => ({ current: initial }),
}))

vi.mock('react/jsx-runtime', () => ({
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  Fragment: 'Fragment',
}))

import { apply } from '../src/client/index.js'
import { resolveConfigForm, unwrapRemote, wrapRemote, type ConfigFormLike } from '../src/client/api.js'

/** Every string in a rendered tree, so an assertion can name what the page drew. */
function texts(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') {
    into.push(node)
    return into
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, into)
    return into
  }
  if (node !== null && typeof node === 'object') {
    const props = (node as { props?: { children?: unknown } }).props
    if (props !== undefined && 'children' in props) texts(props.children, into)
    return into
  }
  return into
}

interface Harness {
  readonly element: { props: Record<string, unknown> }
  readonly options: { id: string; order: number; name: string; locale: string; label: () => string }
}

/** A controller shaped like the settings domain's `ConfigForm`. */
function controller(enabled: boolean): ConfigFormLike & { subscribed: boolean } {
  const form = {
    subscribed: false,
    getSnapshot: () => ({ value: { enabled } }),
    subscribe: () => {
      form.subscribed = true
      return () => undefined
    },
    set: () => Promise.resolve(true),
  }
  return form
}

/** Mount the browser half against a fake client context and hand back the registered page. */
function mount(configForms: unknown, rawRemote?: unknown): Harness {
  hooks.values.length = 0
  hooks.calls.length = 0
  hooks.cursor = 0
  const registered = new Map<string, { options: Harness['options']; component: (props: { close: () => void }) => { props: Record<string, unknown> } }>()
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    logger: { error: () => undefined },
    locale: {
      register: () => () => undefined,
      bind: () => (key: string, params?: unknown) => {
        hooks.calls.push(params === undefined ? key : [key, params])
        return key
      },
      // The face's real member is `getSnapshot()`; the service IS the LocaleFace (`bind` + this pair).
      getSnapshot: () => ({ active: 'zh' }),
    },
    remote: { $mount: () => Promise.resolve() },
    get: (name: string) =>
      name === 'configForms' ? configForms : name === 'remote.avantfIdentity' ? rawRemote : undefined,
    slots: {
      inject: (_name: string, callback: () => unknown) => {
        callback()
      },
      register: (options: Harness['options'], component: never) => {
        registered.set(options.id, { options, component })
        return () => undefined
      },
    },
  }
  apply(ctx as never)
  const entry = registered.get('identity')
  if (entry === undefined) throw new Error('the browser half registered no "identity" settings page')
  hooks.cursor = 0
  return { element: entry.component({ close: () => undefined }) as Harness['element'], options: entry.options }
}

describe('the settings page wiring', () => {
  it('registers one settings.section page at the identity id', () => {
    const { options } = mount({ get: () => controller(false) })
    expect(options.id).toBe('identity')
    expect(options.name).toBe('settings.section')
    expect(options.order).toBe(25)
    expect(options.label()).toBe('nav')
  })

  it('resolves the form through the service, with the profile row id', () => {
    const asked: string[] = []
    const form = controller(true)
    const { element } = mount({ get: (id: string) => { asked.push(id); return form } })
    const resolve = element.props['getConfigForm'] as () => ConfigFormLike | undefined
    const resolved = resolve()
    expect(asked).toEqual(['avantf-identity'])
    expect(resolved).toBe(form)
    expect(resolved?.getSnapshot().value?.enabled).toBe(true)
  })

  it('does NOT mistake the settings service itself for a form', () => {
    // Exactly the shape that blanked the pane in the browser: the service handed in where a form was
    // expected. It must resolve to "not ready", never to something whose `subscribe` is missing.
    const service = { describe: () => undefined, whileServed: () => () => undefined }
    const { element } = mount(service)
    const resolve = element.props['getConfigForm'] as () => ConfigFormLike | undefined
    expect(resolve()).toBeUndefined()
  })

  it('reports the Remote as absent rather than rendering nothing', () => {
    const { element } = mount({ get: () => controller(false) })
    const getRemote = element.props['getRemote'] as () => unknown
    expect(getRemote()).toBeUndefined()
    // The page's other wiring is present and callable, so its first render has real content to draw.
    expect(typeof element.props['t']).toBe('function')
    expect(typeof element.props['whenMounted']).toBe('function')
    expect(typeof element.props['locale']).toBe('function')
    expect(typeof element.props['close']).toBe('function')
  })
})

/** The last rendered component's identity, so a test can re-render after an interaction. */
let lastOuter: { type: (props: unknown) => unknown; props: unknown } | undefined

/** Run the component the way a renderer would (invoke `element.type`), under the mocked hooks. */
function renderPane(configForms: unknown, rawRemote?: unknown): unknown {
  hooks.cursor = 0
  const { element } = mount(configForms, rawRemote)
  lastOuter = element as unknown as { type: (props: unknown) => unknown; props: unknown }
  return lastOuter.type(lastOuter.props)
}

/** Render the same component again, as React would after a state update. */
function reRender(): unknown {
  if (lastOuter === undefined) throw new Error('reRender() before any renderPane()')
  hooks.cursor = 0
  return lastOuter.type(lastOuter.props)
}

/** The first button whose label (our identity `t`) is one of these. */
function buttonByLabel(node: unknown, label: string): { onClick?: () => void } | undefined {
  const button = findByType(node, 'button').find((candidate) =>
    texts((candidate['props'] as { children?: unknown } | undefined)?.children).includes(label),
  )
  return button?.['props'] as { onClick?: () => void } | undefined
}

/** Every node of one rendered type, so a test can assert on a control's own props. */
function findByType(node: unknown, type: string, into: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const child of node) findByType(child, type, into)
    return into
  }
  if (node !== null && typeof node === 'object') {
    const entry = node as { type?: unknown; props?: { children?: unknown } }
    if (entry.type === type) into.push(entry as Record<string, unknown>)
    if (entry.props !== undefined && 'children' in entry.props) findByType(entry.props.children, type, into)
  }
  return into
}

describe('the pane renders whatever the wire delivered', () => {
  /** Hook slots in source order: status, drafts, baseline, form, enabled, busy, notice, error, newPresetId, confirming, naming. */
  const slots = (status: unknown, enabled = false): unknown[] => [
    status,
    { IDENTITY: '', SOUL: '', RULES: '' },
    { IDENTITY: '', SOUL: '', RULES: '' },
    undefined,
    enabled,
    false,
    undefined,
    undefined,
    '',
  ]

  it('survives a status whose list fields did not arrive, and names them in the pane', () => {
    // The real failure: a render reached `status.drop.join(...)` with `drop` absent, threw, and React
    // tore the whole subtree down — the settings pane went blank with nothing to read.
    hooks.queue = slots({
      profile: 'web',
      dataHome: '/tmp/x',
      fileCount: 0,
      totalBytes: 0,
      maxBytes: 65536,
      locale: 'zh',
      localeSource: 'client',
    }, true)
    const drawn = texts(renderPane({ get: () => controller(false) }))
    expect(drawn).toContain('missingFields')
    expect(drawn.join('|')).toContain('drop')
    for (const present of ['fileIdentity', 'fileSoul', 'fileRules']) expect(drawn, present).toContain(present)
  })

  it('renders the switch, and none of the copy that was cut', () => {
    hooks.queue = slots(undefined, true)
    const drawn = texts(renderPane({ get: () => controller(false) }))
    expect(drawn).toContain('switch')
    // Removed on request, in order: the lead paragraph, the two switch hints, the status card, both old
    // card titles, the fallback sentence, and the refresh/close/edit buttons.
    for (const gone of [
      'lead', 'switchOn', 'switchOff', 'status', 'profile', 'dataHome', 'files', 'presets',
      'fallback', 'reload', 'close', 'edit', 'presetEditTitle', 'presetHint', 'presetLocale', 'localeFallback',
    ]) {
      expect(drawn, gone).not.toContain(gone)
    }
    // The page title survives; the card's own `身份` label does not (it was removed with the card chrome).
    expect(drawn).toContain('title')
    expect(drawn).not.toContain('identity')
    // Neither does the per-file byte count that used to sit next to each file name ("0 bytes" here).
    expect(drawn.join('|')).not.toContain('bytes')
    expect(drawn).not.toContain('missingFields')
  })

  it('hides both cards while the switch is off', () => {
    const status = {
      profile: 'web',
      dataHome: '/tmp/x',
      fileCount: 0,
      totalBytes: 0,
      maxBytes: 65536,
      drop: ['harness:identity'],
      files: [],
      presets: [{ id: 'coder', locales: ['zh'], active: true }],
      locale: 'zh',
      localeSource: 'client',
    }

    hooks.queue = slots(status, false)
    const off = texts(renderPane({ get: () => controller(false) }))
    expect(off).toContain('switch')
    for (const hidden of ['fileIdentity', 'fileSoul', 'fileRules', 'save', 'saveAs', 'del']) {
      expect(off, hidden).not.toContain(hidden)
    }

    hooks.queue = slots(status, true)
    expect(findByType(renderPane({ get: () => controller(false) }), 'select')).toHaveLength(1)
  })

  it('renders one dropdown of preset ids, with the active preset selected', () => {
    hooks.queue = slots({
      profile: 'web',
      dataHome: '/tmp/x',
      fileCount: 1,
      totalBytes: 12,
      maxBytes: 65536,
      drop: ['harness:identity'],
      files: [{ name: 'IDENTITY', file: 'IDENTITY.md', path: '/p', present: true, bytes: 12 }],
      presets: [
        { id: 'assistant', locales: ['en', 'zh'], active: true },
        { id: 'coder', locales: ['zh'], active: false },
      ],
      locale: 'zh',
      localeSource: 'client',
    }, true)
    const tree = renderPane({ get: () => controller(false) })
    const drawn = texts(tree)
    expect(drawn).not.toContain('missingFields')
    // No card label, no `自定义` placeholder option: the options are the presets, exactly.
    expect(drawn).not.toContain('identity')
    expect(drawn).not.toContain('custom')
    const selects = findByType(tree, 'select')
    expect(selects).toHaveLength(1)
    expect(selects[0]?.['props']).toMatchObject({ value: 'assistant' })
    // The select carries the grow style, so a long preset id is not clipped by the control's own width.
    expect(selects[0]?.['props']).toMatchObject({ style: expect.objectContaining({ flex: '1 1 auto' }) })
    expect(typeof (selects[0]?.['props'] as { onChange?: unknown }).onChange).toBe('function')
    const options = texts((selects[0]?.['props'] as { children?: unknown }).children)
    expect(options.join('|')).toContain('assistant')
    expect(options.join('|')).toContain('coder')
    // The locale list is no longer glued to each option.
    expect(options.join('|')).not.toContain('en, zh')
    // The dropdown is the whole selector: no separate edit button beside it, one delete button.
    expect(drawn).not.toContain('edit')
    expect(buttonByLabel(tree, 'del')).toBeDefined()
  })

  it('leaves the dropdown empty when the effective identity is hand-written or the library is empty', () => {
    // No active preset (the files were written by hand): the select has presets but none selected, and
    // there is no `自定义` placeholder any more.
    hooks.queue = slots({
      profile: 'web',
      dataHome: '/tmp/x',
      fileCount: 0,
      totalBytes: 0,
      maxBytes: 65536,
      drop: ['harness:identity'],
      files: [],
      presets: [{ id: 'assistant', locales: ['zh'], active: false }],
      locale: 'zh',
      localeSource: 'client',
    }, true)
    const handWritten = findByType(renderPane({ get: () => controller(false) }), 'select')
    expect(handWritten[0]?.['props']).toMatchObject({ value: '' })

    // Every preset deleted: the select simply has no options.
    hooks.queue = slots({
      profile: 'web',
      dataHome: '/tmp/x',
      fileCount: 0,
      totalBytes: 0,
      maxBytes: 65536,
      drop: ['harness:identity'],
      files: [],
      presets: [],
      locale: 'zh',
      localeSource: 'client',
    }, true)
    const empty = findByType(renderPane({ get: () => controller(false) }), 'select')
    expect(empty).toHaveLength(1)
    expect(texts((empty[0]?.['props'] as { children?: unknown }).children)).toEqual([])
  })

  /** One status with the given presets, so each dialog test starts from the same page. */
  const withPresets = (presets: readonly { id: string; locales: string[]; active: boolean }[]): unknown[] =>
    slots({
      profile: 'web',
      dataHome: '/tmp/x',
      fileCount: 0,
      totalBytes: 0,
      maxBytes: 65536,
      drop: ['harness:identity'],
      files: [],
      presets,
      locale: 'zh',
      localeSource: 'client',
    }, true)

  it('asks for confirmation in the page, then applies in the language dsh is showing', async () => {
    // Two live failures pinned together: the browser confirm replaced by an in-page dialog, and the
    // locale face read by its real member (`getSnapshot`) rather than a `snapshot()` that does not exist.
    const applied: { id?: string; locale?: string }[] = []
    const raw = {
      applyPreset: (args: { id?: string; locale?: string }) => {
        applied.push(args)
        return Promise.resolve({ ok: true, value: { ok: true } })
      },
    }
    hooks.queue = withPresets([{ id: 'coder', locales: ['en', 'zh'], active: false }])
    const tree = renderPane({ get: () => controller(false) }, raw)
    await Promise.resolve()
    await Promise.resolve()

    const select = findByType(tree, 'select')[0]
    ;(select?.['props'] as { onChange?: (event: unknown) => void }).onChange?.({ target: { value: 'coder' } })
    expect(applied).toEqual([])

    const confirming = reRender()
    expect(texts(confirming)).toContain('confirmApply')
    // The dialog title carries the preset id through the locale face's own `{id}` interpolation.
    expect(hooks.calls).toContainEqual(['confirmApply', { id: 'coder' }])
    buttonByLabel(confirming, 'ok')?.onClick?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(applied).toEqual([{ id: 'coder', locale: 'zh' }])
    // Applying shows no notice any more: the `应用: coder` line is gone (the dropdown is the indicator).
    expect(texts(reRender()).join('|')).not.toContain('apply')
  })

  it('confirms before deleting the selected preset', async () => {
    const deleted: { id?: string }[] = []
    const raw = {
      deletePreset: (args: { id?: string }) => {
        deleted.push(args)
        return Promise.resolve({ ok: true, value: { ok: true } })
      },
    }
    hooks.queue = withPresets([{ id: 'coder', locales: ['zh'], active: true }])
    const tree = renderPane({ get: () => controller(false) }, raw)
    await Promise.resolve()
    await Promise.resolve()

    buttonByLabel(tree, 'del')?.onClick?.()
    expect(deleted).toEqual([])
    const confirming = reRender()
    expect(texts(confirming)).toContain('confirmDelete')
    buttonByLabel(confirming, 'ok')?.onClick?.()
    await Promise.resolve()
    expect(deleted).toEqual([{ id: 'coder' }])
  })

  it('asks for a new preset name in a dialog, not in the page or a browser prompt', async () => {
    const saved: { id?: string; locale?: string }[] = []
    const raw = {
      saveAsPreset: (args: { id?: string; locale?: string }) => {
        saved.push(args)
        return Promise.resolve({ ok: true, value: { ok: true } })
      },
    }
    hooks.queue = withPresets([{ id: 'coder', locales: ['zh'], active: true }])
    const tree = renderPane({ get: () => controller(false) }, raw)
    await Promise.resolve()
    await Promise.resolve()

    // The name field is NOT on the page before the button is pressed (the switch card's checkbox is the
    // only input, so the name field is addressed by its placeholder).
    const nameFields = (node: unknown): Record<string, unknown>[] =>
      findByType(node, 'input').filter((field) => (field['props'] as { placeholder?: unknown }).placeholder === 'newPresetId')
    expect(nameFields(tree)).toHaveLength(0)
    buttonByLabel(tree, 'saveAs')?.onClick?.()

    const naming = reRender()
    const fields = nameFields(naming)
    expect(fields).toHaveLength(1)
    ;(fields[0]?.['props'] as { onChange?: (event: unknown) => void }).onChange?.({ target: { value: 'my-preset' } })
    buttonByLabel(reRender(), 'ok')?.onClick?.()
    await Promise.resolve()
    expect(saved).toEqual([{ id: 'my-preset', locale: 'zh' }])
    // Saving as shows no notice either: the new id appears in the dropdown instead.
    expect(texts(reRender()).join('|')).not.toContain('saveAs: ')
  })
})

describe('the transport envelope', () => {
  it('peels exactly one layer, and never eats a payload that carries its own ok', () => {
    const view = { profile: 'web', drop: ['harness:identity'] }
    // The measured answer of a real Remote call: the payload is nested under `value`.
    expect(unwrapRemote({ ok: true, value: view })).toBe(view)
    // A bare payload passes through untouched.
    expect(unwrapRemote(view)).toBe(view)
    // This plugin's write result HAS an `ok` of its own and no `value`: a two-layer unwrap would eat it.
    const write = { ok: true, files: ['IDENTITY.md'] }
    expect(unwrapRemote(write)).toBe(write)
    expect(() => unwrapRemote({ ok: false, error: 'host refused' })).toThrowError(/host refused/)
  })

  it('wraps the namespace so every call answers a payload', async () => {
    const view = { profile: 'web' }
    const arity: Record<string, number> = {}
    const raw = {
      status: (...args: unknown[]) => { arity['status'] = args.length; return Promise.resolve({ ok: true, value: view }) },
      // A no-argument method: the transport builds `args` from the values it is handed, and the gateway
      // rejects a payload for a parameter the descriptor does not declare, so this MUST stay arity 0.
      readProfile: (...args: unknown[]) => { arity['readProfile'] = args.length; return Promise.resolve({ ok: true, value: { files: [] } }) },
      writeProfileFile: () => Promise.resolve({ ok: true, value: { ok: true, files: ['IDENTITY.md'] } }),
      notARemoteMethod: () => Promise.resolve('x'),
    }
    const wrapped = wrapRemote(raw as never) as unknown as Record<string, (args?: unknown) => Promise<unknown>>
    expect(await wrapped['status']!({ locale: 'zh' })).toBe(view)
    expect(await wrapped['readProfile']!()).toEqual({ files: [] })
    expect(arity['status']).toBe(1)
    expect(arity['readProfile']).toBe(0)
    expect(await wrapped['writeProfileFile']!({})).toEqual({ ok: true, files: ['IDENTITY.md'] })
    expect(wrapped['notARemoteMethod']).toBeUndefined()
    expect(wrapRemote(undefined)).toBeUndefined()
  })
})

describe('resolveConfigForm', () => {
  it('is total: no service, no get, a throwing get, or a junk answer all mean "not ready"', () => {
    expect(resolveConfigForm(undefined, 'avantf-identity')).toBeUndefined()
    expect(resolveConfigForm(null, 'avantf-identity')).toBeUndefined()
    expect(resolveConfigForm({}, 'avantf-identity')).toBeUndefined()
    expect(resolveConfigForm({ get: () => { throw new Error('boom') } }, 'avantf-identity')).toBeUndefined()
    expect(resolveConfigForm({ get: () => ({}) }, 'avantf-identity')).toBeUndefined()
    expect(resolveConfigForm({ get: () => ({ getSnapshot: () => ({}) }) }, 'avantf-identity')).toBeUndefined()
  })

  it('accepts a real controller', () => {
    const form = controller(false)
    expect(resolveConfigForm({ get: () => form }, 'avantf-identity')).toBe(form)
  })
})
