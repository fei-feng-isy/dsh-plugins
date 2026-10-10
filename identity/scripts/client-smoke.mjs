#!/usr/bin/env node
/**
 * Smoke-test the built browser half without a browser, by running its CJS factory in a `vm` sandbox
 * with hand-written `window`, `document` and `require` stand-ins.
 *
 * It proves what a bundle failure would otherwise hide until someone opened the settings page: the
 * artifact self-registers under this package id; it exports the client plugin shape (`name`,
 * `inject`, `apply`); `apply` registers exactly one `settings.section` entry under the id `identity`;
 * and mounting its Remote contribution is attempted (the namespace lookup uses `ctx.get`, never a
 * dotted `inject`, which is what would kill the web boot).
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

console.log('avantf-identity client smoke')

const registered = []
const mountCalls = []
const styleTags = []
const document = {
  head: { appendChild: (node) => { styleTags.push(node) } },
  getElementById: (id) => styleTags.find((node) => node.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '', setAttribute: () => undefined }),
}

const requireStub = (name) => {
  // React is only touched when a component renders, which this smoke does not do; a minimal
  // namespace is enough for the module body to evaluate.
  if (name === 'react' || name === 'react/jsx-runtime') {
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
  if (name === 'react-dom') return { flushSync: (fn) => fn() }
  throw new Error(`client-smoke: unexpected require("${name}") — it should have been external and shell-provided`)
}

let loaded
const window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }

const logged = []
const sandboxConsole = {
  log: (...args) => { logged.push(args.map(String).join(' ')); console.log(...args) },
  error: (...args) => { logged.push(args.map(String).join(' ')); console.error(...args) },
  warn: (...args) => { logged.push(args.map(String).join(' ')); console.warn(...args) },
}

const source = readFileSync(bundlePath, 'utf8')
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
check('registers under this package id', loaded?.id === '@avantf/dsh-identity', String(loaded?.id))

const exports = loaded?.factory?.(requireStub) ?? {}
check('exports a name', exports.name === 'avantf-identity', String(exports.name))
check('exports inject as an array', Array.isArray(exports.inject), JSON.stringify(exports.inject))
check(
  'inject never names its own Remote namespace',
  Array.isArray(exports.inject) && !exports.inject.some((entry) => typeof entry === 'string' && entry.startsWith('remote.')),
  JSON.stringify(exports.inject),
)
check('exports apply', typeof exports.apply === 'function')

if (typeof exports.apply === 'function') {
  const ctx = {
    logger: { info: () => undefined, error: () => undefined, warn: () => undefined },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => undefined },
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
    'the mounted contribution carries this package',
    mountCalls[0]?.package === '@avantf/dsh-identity',
    JSON.stringify(mountCalls[0]?.package),
  )
  check(
    'the mounted face publishes every settings method',
    ['status', 'listPresets', 'readProfile', 'writeProfileFile', 'applyPreset', 'saveAsPreset', 'readPreset', 'writePresetFile', 'deletePreset']
      .every((method) => mountCalls[0]?.descriptors?.some((entry) => entry.method === method)),
    JSON.stringify(mountCalls[0]?.descriptors?.map((entry) => entry.method)),
  )
  check('registers exactly one settings section', registered.length === 1, `got ${String(registered.length)}`)
  const section = registered[0]
  check('the section is a settings.section occupant', section?.name === 'settings.section', String(section?.name))
  check('the section id is the new `identity`', section?.id === 'identity', String(section?.id))
  check('the section orders after agent-presets (20)', typeof section?.order === 'number' && section.order > 20, String(section?.order))
  check('the section resolves its label lazily', typeof section?.label === 'function')
  check('the section names its i18n namespace', typeof section?.locale === 'string' && section.locale.length > 0, String(section?.locale))
  check('no stylesheet is injected before a render', styleTags.length === 0, `got ${String(styleTags.length)}`)
}

// The artifact itself must not reach for a browser dialog. `window.prompt` is not implemented in an
// Electron renderer at all, and the harness's own client code never calls confirm/alert either — the
// page owns its dialogs. A regex on the bundle is the cheapest way to keep it that way.
const browserDialog = /window\.(confirm|prompt|alert)\b|\balert\s*\(/.exec(source)
check('the bundle contains no browser dialog call', browserDialog === null, browserDialog?.[0] ?? '')

// The UI copy says 身份. esbuild writes non-ASCII as `\uXXXX` escapes (ASCII charset), so a check against
// the raw source would never match and would pass vacuously — decode first, and keep a POSITIVE control
// next to the negative one so a charset change can never turn this pair into silence again.
const decoded = source.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
check('the decoded bundle really carries the Chinese copy (positive control)', decoded.includes('身份'), '解码后没有找到「身份」——说明这条检查失效了')
check('no `身份文件` copy is left in the bundle', !decoded.includes('身份文件'))
// The apply notice was cut; with its key gone, no Chinese「应用」is left in the copy at all.
check('no `应用` copy is left in the bundle', !decoded.includes('应用'))

if (failures.length > 0) {
  console.error(`\nCLIENT SMOKE FAILED (${String(failures.length)})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nCLIENT SMOKE OK')
process.exit(0)
