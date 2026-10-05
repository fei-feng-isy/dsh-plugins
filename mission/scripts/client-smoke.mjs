#!/usr/bin/env node
/**
 * Smoke-test the built browser half without a browser, by running its CJS factory in a `vm` sandbox
 * with hand-written `window`, `document` and `require` stand-ins.
 *
 * It proves four things a bundle failure would otherwise hide until someone opened the tab: the
 * artifact self-registers under this package id; it exports the client plugin shape (`name`,
 * `inject`, `apply`); `apply` registers exactly one `conversation.view` entry with the id and order
 * the tab ordering needs; and mounting its Remote contribution is attempted (the namespace lookup
 * uses `ctx.get`, never a dotted `inject`, which is what would kill the web boot).
 *
 * It does NOT render React — that needs the real shell's module table — so the point is to fail
 * loudly on a broken or mis-wired artifact before a restart.
 *
 *   node scripts/client-smoke.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(repo, 'packages', 'plugin', 'lib', 'client.js')

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

if (!existsSync(bundlePath)) {
  console.error(`client-smoke: missing ${bundlePath}; run scripts/build-client.mjs first`)
  process.exit(1)
}

console.log('avantf-mission client smoke')

// ── the shell stand-ins ──────────────────────────────────────────────────────
const registered = []
const mountCalls = []

const styleTags = []
const document = {
  head: { appendChild: (node) => { styleTags.push(node) } },
  getElementById: (id) => styleTags.find((node) => node.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '', setAttribute: () => undefined }),
}

const requireStub = (name) => {
  // React is only touched when a component renders, which this smoke does not do;
  // a minimal namespace is enough for the module body to evaluate.
  if (name === 'react' || name === 'react/jsx-runtime') {
    // `memo` is evaluated at MODULE scope (wrapping a component), so the stand-in must carry it even
    // though nothing renders here; the hooks below are only reached during a render, which this smoke
    // does not do. Kept in one object so a new module-scope react API fails loudly here, not in the app.
    return {
      createElement: () => null, jsx: () => null, jsxs: () => null, Fragment: null,
      memo: (component) => component,
      useState: () => [undefined, () => undefined],
      useRef: () => ({ current: undefined }),
      useId: () => 'id',
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useEffect: () => undefined,
    }
  }
  // `react-dom` arrives through the virtualizer, which flushes measurements with
  // `flushSync`. It is in the shell's platform module list, so at runtime the real
  // module is there; here a callable stand-in is enough.
  if (name === 'react-dom') {
    return { flushSync: (fn) => fn() }
  }
  throw new Error(`client-smoke: unexpected require("${name}") — it should have been external and shell-provided`)
}

let loaded
const window = {
  __ModuleLoader__: {
    load: (spec) => { loaded = spec },
  },
}

/** Every line the bundle logged, so a wiring decision can be asserted not guessed. */
const logged = []
const sandboxConsole = {
  log: (...args) => { logged.push(args.map(String).join(' ')); console.log(...args) },
  error: (...args) => { logged.push(args.map(String).join(' ')); console.error(...args) },
  warn: (...args) => { logged.push(args.map(String).join(' ')); console.warn(...args) },
}

const source = readFileSync(bundlePath, 'utf8')
// The sandbox mirrors the browser's globals, not a Node subset: the client half's
// auto-refresh falls back to the platform's own `setInterval` when no `timer`
// service is mounted (this deployment mounts none), so a sandbox without it would
// exercise a rung the real page never uses.
const sandbox = {
  window,
  document,
  require: requireStub,
  console: sandboxConsole,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Symbol,
  Object,
  Array,
  JSON,
  Error,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('self-registers through __ModuleLoader__', loaded !== undefined)
check('registers under this package id', loaded?.id === '@avantf/dsh-mission', String(loaded?.id))

const exports = loaded?.factory?.(requireStub) ?? {}
check('exports a name', exports.name === 'avantf-mission', String(exports.name))
check('exports inject as an array', Array.isArray(exports.inject), JSON.stringify(exports.inject))
check(
  'inject never names its own Remote namespace',
  Array.isArray(exports.inject) && !exports.inject.some((entry) => typeof entry === 'string' && entry.startsWith('remote.')),
  JSON.stringify(exports.inject),
)
check('exports apply', typeof exports.apply === 'function')

// ── apply against a stub client context ──────────────────────────────────────
if (typeof exports.apply === 'function') {
  const effects = []
  const ctx = {
    logger: { info: () => undefined, error: () => undefined, warn: () => undefined },
    effect: (fn) => { effects.push(fn); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => undefined },
    locale: { register: () => () => undefined, bind: () => (key) => key },
    remote: {
      $mount: (contribution) => {
        mountCalls.push(contribution)
        return Promise.resolve(() => undefined)
      },
    },
    get: () => undefined,
    slots: {
      inject: (key, callback) => { callback(); return () => undefined },
      register: (options) => { registered.push(options); return () => undefined },
    },
  }

  exports.apply(ctx)

  check('mounts its Remote contribution once', mountCalls.length === 1, `got ${String(mountCalls.length)}`)
  check(
    'auto-refresh is engine-driven, with the browser timers only as the fallback',
    logged.some((line) => line.includes('auto-refresh: engine change stream, browser timer fallback')),
    JSON.stringify(logged.filter((line) => line.includes('auto-refresh'))),
  )
  check(
    'the mounted contribution carries this package',
    mountCalls[0]?.package === '@avantf/dsh-mission',
    JSON.stringify(mountCalls[0]?.package),
  )
  // The engine pushes its changes down this stream; without it in the mounted face the
  // view silently falls back to the timer, which is the failure mode this guards.
  const watch = mountCalls[0]?.descriptors?.find((entry) => entry.method === 'watch')
  check(
    'the mounted face exposes the engine change stream',
    watch?.mode === 'stream',
    JSON.stringify({ method: watch?.method, mode: watch?.mode }),
  )
  check('registers exactly one view', registered.length === 1, `got ${String(registered.length)}`)
  const view = registered[0]
  check('the view is the conversation.view seat', view?.name === 'conversation.view', String(view?.name))
  check('the view id is mission-facing', view?.id === 'missions', String(view?.id))
  check(
    'the view orders after trajectory (order 10)',
    typeof view?.order === 'number' && view.order > 10,
    String(view?.order),
  )
  check('the view resolves its label lazily', typeof view?.label === 'function')
  check('no stylesheet is injected before a render', styleTags.length === 0, `got ${String(styleTags.length)}`)
  // The list is windowed through the same library the trajectory table uses; if it
  // ever stopped being inlined, the browser bundle would need a module the shell does
  // not seed and the view would fail to load.
  const bundle = readFileSync(bundlePath, 'utf8')
  check(
    'the windowing library is inlined in the bundle',
    bundle.includes('measureElement') && bundle.includes('ResizeObserver'),
  )
}

if (failures.length > 0) {
  console.error(`\nCLIENT SMOKE FAILED (${String(failures.length)})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nCLIENT SMOKE OK')
// `apply()` starts the tab-status keepalive with the sandbox's real `setInterval` (no `timer`
// service is provided here), so the process would otherwise stay alive forever and hang
// `pnpm check:fast mission` / `release:check`. The script's work is done at this point.
process.exit(0)
