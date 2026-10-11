/**
 * The page's DATA-FLOW contract, with the EFFECTS ACTUALLY RUN.
 *
 * `client.spec.ts` mocks `useEffect` to a no-op on purpose — it only drives the render tree — so the
 * effect that loads the three editors had no test at all.
 *
 * The measured defect: the props `index.ts` handed the page were rebuilt on every render, so `getRemote`
 * / `whenMounted` / `locale` were new identities each time, `refresh` was a new callback each time, and
 * the `[whenMounted, refresh]` load effect re-ran on EVERY render — one Remote read per render, without
 * bound, each one overwriting the drafts. Nothing serialized those reads, so an older response could land
 * last: the read issued while the files were still absent (or before the host answered the data home)
 * could blank the editors that a newer response had already filled, and only another read — a second
 * flip of the switch, which the toggle handler does ask for — brought the text back.
 *
 * The harness below memos `useCallback` by its dependency array (as React does) and re-runs only the
 * effects whose deps changed (as React does); without that the flow cannot be reproduced at all.
 */
import { describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  callbacks: [] as { deps: readonly unknown[] | undefined; callback: unknown }[],
  effects: [] as { key: number; deps?: readonly unknown[]; callback: unknown }[],
  lastEffects: [] as { key: number; deps: readonly unknown[] | undefined }[],
}))

/** React's own dependency comparison: same length, every entry `Object.is`-equal. */
function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...(props as object), children } }),
  useState: (initial: unknown) => {
    const index = hooks.cursor
    hooks.cursor += 1
    if (index >= hooks.values.length) hooks.values[index] = initial
    const set = (next: unknown): void => {
      hooks.values[index] =
        typeof next === 'function' ? (next as (current: unknown) => unknown)(hooks.values[index]) : next
    }
    return [hooks.values[index], set]
  },
  useEffect: (callback: unknown, deps?: readonly unknown[]) => {
    // The effect's SLOT (its order in this render) is what React compares: same render order, same effect.
    const key = hooks.effects.length
    hooks.effects.push({ key, deps, callback })
    const previous = hooks.lastEffects.find((entry) => entry.key === key)
    if (previous === undefined || !sameDeps(previous.deps, deps)) {
      if (typeof callback === 'function') (callback as () => void)()
    }
  },
  useCallback: (callback: unknown, deps: readonly unknown[]) => {
    const found = hooks.callbacks.find((entry) => sameDeps(entry.deps, deps))
    if (found !== undefined) return found.callback
    hooks.callbacks.push({ deps, callback })
    return callback
  },
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initial: unknown) => ({ current: initial }),
}))

vi.mock('react/jsx-runtime', () => ({
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  Fragment: 'Fragment',
}))

import { apply } from '../src/client/index.js'
import type { ConfigFormLike } from '../src/client/api.js'

/** A controller shaped like the settings domain's `ConfigForm`, remembering what it was set to. */
function controller(initial: boolean, onChange?: (next: boolean) => void): ConfigFormLike & { value: boolean } {
  const form = {
    value: initial,
    getSnapshot: () => ({ value: { enabled: form.value } }),
    subscribe: () => () => undefined,
    set: (_field: string, next: unknown) => {
      form.value = next === true
      onChange?.(form.value)
      return Promise.resolve(true)
    },
  }
  return form
}

/** Register the page against a fake client context; hand back the component the slot registered. */
function mountPage(rawRemote: unknown, form: ConfigFormLike): (props: unknown) => unknown {
  const registered = new Map<string, (props: unknown) => unknown>()
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    logger: { error: () => undefined },
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => key,
      getSnapshot: () => ({ active: 'zh' }),
    },
    remote: { $mount: () => Promise.resolve() },
    get: (name: string) =>
      name === 'configForms'
        ? { get: () => form }
        : name === 'remote.avantfIdentity' ? rawRemote : undefined,
    slots: {
      inject: (_name: string, callback: () => unknown) => { callback() },
      register: (options: { id: string }, component: (props: unknown) => unknown) => {
        registered.set(options.id, component)
        return () => undefined
      },
    },
  }
  apply(ctx as never)
  const component = registered.get('identity')
  if (component === undefined) throw new Error('no identity page was registered')
  return component
}

/**
 * Render once, as a renderer would: `index.ts` returns the section ELEMENT (its `createElement` is the
 * mocked one), so the tree comes from invoking that element's own `type`. Effects run inside the section
 * render, as React commits them.
 * @returns the rendered tree and the props the page was given.
 */
function renderOnce(component: (props: unknown) => unknown): { tree: unknown; props: Record<string, unknown> } {
  hooks.cursor = 0
  hooks.effects = []
  const element = component({ close: () => undefined }) as { type: (props: unknown) => unknown; props: Record<string, unknown> }
  const tree = element.type(element.props)
  hooks.lastEffects = hooks.effects.map((effect) => ({ key: effect.key, deps: effect.deps }))
  return { tree, props: element.props }
}

/** The tree only. */
function render(component: (props: unknown) => unknown): unknown {
  return renderOnce(component).tree
}

/** Let the pending microtasks of an async `refresh()` settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** Every `textarea`'s `value`, in render order. */
function textareaValues(node: unknown, into: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) textareaValues(child, into)
    return into
  }
  if (node !== null && typeof node === 'object') {
    const entry = node as { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
    if (entry.type === 'textarea') into.push(entry.props?.['value'])
    if (entry.props !== undefined && 'children' in entry.props) textareaValues(entry.props.children, into)
  }
  return into
}

/** The switch, so a test can flip it the way a click does. */
function checkbox(node: unknown): { onChange?: (event: unknown) => void } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = checkbox(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node !== null && typeof node === 'object') {
    const entry = node as { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
    if (entry.type === 'input' && entry.props?.['type'] === 'checkbox') return entry.props as { onChange?: (event: unknown) => void }
    if (entry.props !== undefined && 'children' in entry.props) return checkbox(entry.props.children)
  }
  return undefined
}

/** The first button whose label (`t` returns the key in this harness) is one of these. */
function buttonByLabel(node: unknown, label: string): { onClick?: () => void } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = buttonByLabel(child, label)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node !== null && typeof node === 'object') {
    const entry = node as { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
    // The label is a single localised string child, so match through `texts` rather than on an array.
    if (entry.type === 'button' && entry.props !== undefined && texts(entry.props.children).includes(label)) {
      return entry.props as { onClick?: () => void }
    }
    if (entry.props !== undefined && 'children' in entry.props) return buttonByLabel(entry.props.children, label)
  }
  return undefined
}

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

const FILES = [  { name: 'IDENTITY', file: 'IDENTITY.md', text: 'IDENTITY-BODY', present: true, bytes: 13 },
  { name: 'SOUL', file: 'SOUL.md', text: 'SOUL-BODY', present: true, bytes: 9 },
  { name: 'RULES', file: 'RULES.md', text: 'RULES-BODY', present: true, bytes: 10 },
]
const STATUS = { enabled: true, profile: 'web', dataHome: '/x', identityDir: '/x', presetsDir: '/x', fileCount: 3, totalBytes: 32, maxBytes: 65536, interpolate: false, replaceScope: 'session', drop: [], fallbackToNative: false, activePreset: '', activeLocale: '', hasLocalEdit: false, locale: 'zh', localeSource: 'client', files: [], presets: [] }

/** A Remote answering the given number of reads with nothing, then with the files. */
function remoteReadsEveryTime(files: readonly unknown[]): { raw: Record<string, unknown>; reads: () => number } {
  let reads = 0
  const raw = {
    status: () => Promise.resolve({ ok: true, value: STATUS }),
    readProfile: () => {
      reads += 1
      return Promise.resolve({ ok: true, value: { profile: 'web', identityDir: '/x', totalBytes: 32, files } })
    },
    writeProfileFile: () => Promise.resolve({ ok: true, value: { ok: true } }),
  }
  return { raw, reads: () => reads }
}

describe('the identity page reads the host files into the editors', () => {
  it('loads the editors when the switch is turned on, past a first read that saw nothing', async () => {
    // The measured sequence: the page's first read lands while the effective identity is still absent
    // (or before the data home resolved), so the editors start empty. Turning the switch on must show
    // what the host has NOW — the host's files are the only source these editors have.
    let hasFiles = false
    let reads = 0
    const raw = {
      status: () => Promise.resolve({ ok: true, value: STATUS }),
      readProfile: () => {
        reads += 1
        return Promise.resolve({
          ok: true,
          value: { profile: 'web', identityDir: '/x', totalBytes: 32, files: hasFiles ? FILES : [] },
        })
      },
      writeProfileFile: () => Promise.resolve({ ok: true, value: { ok: true } }),
    }
    hooks.values = []
    hooks.callbacks = []
    hooks.lastEffects = []
    let onFlip: (() => void) | undefined
    onFlip = () => { hasFiles = true }
    const form = controller(false, () => { onFlip?.() })
    const page = mountPage(raw, form)

    // First render + effects: the mount effect reads the host and gets nothing.
    render(page)
    await settle()
    expect(reads).toBeGreaterThanOrEqual(1)
    expect(textareaValues(render(page))).toEqual([])

    // Flip the switch on, the way the checkbox does.
    const box = checkbox(render(page))
    expect(box?.onChange).toBeTypeOf('function')
    box?.onChange?.({ target: { checked: true } })
    await settle()
    render(page)

    // The fix's observable claim: the editors hold the host's text, with no second flip needed.
    expect(textareaValues(render(page))).toEqual(['IDENTITY-BODY', 'SOUL-BODY', 'RULES-BODY'])
  })

  it('does not rebuild the page props on every render', async () => {
    // The loop: a fresh props object per render makes `getRemote` / `whenMounted` / `locale` fresh
    // identities, so `refresh` is fresh and the `[whenMounted, refresh]` effect re-runs forever.
    const { raw } = remoteReadsEveryTime(FILES)
    hooks.values = []
    hooks.callbacks = []
    hooks.lastEffects = []
    const form = controller(true)
    const page = mountPage(raw, form)

    // Two renders, capturing the props the page was given each time: `getRemote` / `whenMounted` are
    // the props under test, and if `index.ts` built the props once both renders name the same objects.
    const first = renderOnce(page).props
    const second = renderOnce(page).props
    await settle()
    expect(first['getRemote']).toBe(second['getRemote'])
    expect(first['whenMounted']).toBe(second['whenMounted'])
    expect(first['locale']).toBe(second['locale'])
  })

  it('does not re-read the host on every render (no per-render loop)', async () => {
    const { raw, reads } = remoteReadsEveryTime(FILES)
    hooks.values = []
    hooks.callbacks = []
    hooks.lastEffects = []
    const page = mountPage(raw, controller(true))

    // Settle the page: the mount read, plus the read the switch's own transition asks for.
    render(page)
    await settle()
    render(page)
    await settle()
    const settled = reads()

    // Renders alone must never read again. Before the fix this grew by one per render, without bound —
    // the page kept re-rendering and re-reading itself forever.
    for (let i = 0; i < 4; i += 1) {
      render(page)
      await settle()
    }
    expect(reads()).toBe(settled)
    expect(settled).toBeLessThanOrEqual(2)
  })

  it('asks the host to seed this profile when the switch is turned on, and only then', async () => {
    // The host's first run materializes the preset LIBRARY only, so a profile that was never given files
    // has no identity to enable. The page's enable action is what asks the host to materialize one.
    const seeded: unknown[] = []
    const raw = {
      status: () => Promise.resolve({ ok: true, value: STATUS }),
      readProfile: () => Promise.resolve({ ok: true, value: { profile: 'web', identityDir: '/x', totalBytes: 0, files: [] } }),
      ensureProfile: (args: unknown) => {
        seeded.push(args)
        return Promise.resolve({ ok: true, value: { ok: true, files: ['IDENTITY.md'] } })
      },
    }
    hooks.values = []
    hooks.callbacks = []
    hooks.lastEffects = []
    const page = mountPage(raw, controller(false))
    render(page)
    await settle()

    checkbox(render(page))?.onChange?.({ target: { checked: true } })
    await settle()
    expect(seeded).toEqual([{ locale: 'zh' }])

    // Turning it OFF must not ask again.
    checkbox(render(page))?.onChange?.({ target: { checked: false } })
    await settle()
    expect(seeded).toEqual([{ locale: 'zh' }])
  })

  it('reports a host that cannot seed rather than leaving the switch silently empty', async () => {
    const raw = {
      status: () => Promise.resolve({ ok: true, value: STATUS }),
      readProfile: () => Promise.resolve({ ok: true, value: { profile: 'web', identityDir: '/x', totalBytes: 0, files: [] } }),
      ensureProfile: () => Promise.resolve({ ok: true, value: { ok: false, error: 'no preset is available' } }),
    }
    hooks.values = []
    hooks.callbacks = []
    hooks.lastEffects = []
    const page = mountPage(raw, controller(false))
    render(page)
    await settle()
    checkbox(render(page))?.onChange?.({ target: { checked: true } })
    await settle()
    expect(texts(render(page))).toContain('no preset is available')
  })

  it('offers restoring the preset text only when you have your own version', async () => {
    const reset: unknown[] = []
    const own = {
      ...STATUS,
      activePreset: 'assistant',
      hasLocalEdit: true,
      presets: [{ id: 'assistant', locales: ['zh'], active: true }],
    }
    const raw = {
      status: () => Promise.resolve({ ok: true, value: own }),
      readProfile: () => Promise.resolve({ ok: true, value: { profile: 'web', identityDir: '/x', totalBytes: 0, files: [] } }),
      resetToPreset: (args: unknown) => {
        reset.push(args)
        return Promise.resolve({ ok: true, value: { ok: true } })
      },
    }
    hooks.values = []
    hooks.callbacks = []
    hooks.lastEffects = []
    const page = mountPage(raw, controller(true))
    render(page)
    await settle()

    const restore = buttonByLabel(render(page), 'restore')
    expect(restore).toBeDefined()
    restore?.onClick?.()
    const dialog = render(page)
    expect(texts(dialog)).toContain('confirmReset')
    buttonByLabel(dialog, 'ok')?.onClick?.()
    await settle()
    expect(reset).toEqual([{ id: 'assistant', locale: 'zh' }])

    // With no local version there is nothing to restore, so the control is not offered.
    hooks.values = []
    hooks.callbacks = []
    hooks.lastEffects = []
    const untouched = mountPage(
      { ...raw, status: () => Promise.resolve({ ok: true, value: { ...own, hasLocalEdit: false } }) },
      controller(true),
    )
    render(untouched)
    await settle()
    expect(buttonByLabel(render(untouched), 'restore')).toBeUndefined()
  })

  it('flips the master switch even when the Remote namespace never mounted', async () => {
    // The switch is the HOST's config form, not this plugin's Remote: a failed typert mount must not turn
    // the one control on the page into a dead checkbox (the page says "unavailable" instead).
    let flipped: boolean | undefined
    const form = controller(false, (next) => { flipped = next })
    hooks.values = []
    hooks.callbacks = []
    hooks.lastEffects = []
    const page = mountPage(undefined, form)
    render(page)
    await settle()
    checkbox(render(page))?.onChange?.({ target: { checked: true } })
    await settle()
    expect(flipped).toBe(true)
  })
})
