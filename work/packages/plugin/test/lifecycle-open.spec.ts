/**
 * Start-up that outlives its own fiber.
 *
 * `apply` kicks off `host.start()` without awaiting it (only the first caller that
 * needs the tree awaits `whenReady()`), so a fast unmount can dispose the fiber while
 * `open()` is still between awaits. Cordis clears `fiber.uid` first and every later
 * context read then throws `INACTIVE_EFFECT` — "cannot get required service ... in
 * inactive context" — which is what turned an ordinary plugin unload into a fatal
 * boot failure in a live profile: the rejection is unhandled, so dsh's fail-loud
 * handler owns it and exits the process.
 *
 * This spec mounts the REAL plugin in a REAL Cordis context over stubbed DSH services,
 * holds `storageDomain.open` open, unmounts the plugin mid-flight, and then releases
 * it. It asserts the difference between "a plugin that unloads" and "a boot that
 * dies":
 *
 * 1. `whenReady()` resolves — nothing for the unhandled-rejection handler to see;
 * 2. the domain this `open()` acquired is closed, because `stop()` ran before
 *    `this.domain` was assigned and therefore closed nothing;
 * 3. nothing was armed for the tree that no longer exists.
 *
 * The second case covers the other ordering: the storage open itself rejects after
 * the unmount (a unit closed under an in-flight open). Same trap, reached before the
 * guard can run, so the failure has to be absorbed where the promise is created.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AvantfWorkHost } from '../src/host.js'

// Same isolation `test/mount.ts` uses: a throwaway family root, so this spec never
// touches the real `~/.avantf`. The gate itself runs (the base is installed); what
// this file is about is the host lifecycle.
process.env['AVANTF_HOME'] = mkdtempSync(join(tmpdir(), 'avantf-work-open-home-'))

const { apply, inject, name } = await import('../src/index.js')

/** One storage-domain handle: whether it was closed. */
interface Domain {
  closed: boolean
}

/** What one stubbed mount gives back to a case. */
interface Harness {
  ctx: Context
  domains: Domain[]
  /** Release every `storageDomain.open` held by `holdOpen`. */
  releases: (() => void)[]
  /** Whether the plugin armed its sweep timer. */
  sweepArmed: () => boolean
}

/** A service stub that answers only for the surfaces the plugin actually touches. */
function stubContext(options: { holdOpen?: boolean; failOpen?: boolean } = {}): Harness {
  const records = new Map<string, unknown>()
  const domains: Domain[] = []
  const releases: (() => void)[] = []
  const armed = { value: false }
  const ctx = new Context()

  ctx.provide('agents', { get: () => undefined })
  ctx.provide('subagents', {
    startContinuable: () => Promise.resolve({ childId: 'child', messageId: 'm1' }),
    sendMessage: () => Promise.resolve('m1'),
    interrupt: () => undefined,
  })
  // Faithful enough for the GATE too: it registers a throwaway `__dshCompatProbe` and asserts
  // `tools.get()` reports it back (a stub that always answered `undefined` would make the gate refuse
  // a host the plugin actually runs on), then withdraws it.
  const tools = new Map<string, unknown>()
  ctx.provide('tools', {
    get: (toolName: string) => tools.get(toolName),
    register: (definition: { name?: string }) => {
      if (typeof definition?.name === 'string') tools.set(definition.name, definition)
      return () => {
        if (typeof definition?.name === 'string') tools.delete(definition.name)
      }
    },
  })
  ctx.provide('commands', { register: () => () => undefined })
  ctx.provide('systemPrompt', {
    section: () => () => undefined,
    context: () => () => undefined,
    getSectionOrder: () => 2400,
    getContextOrder: () => 120,
  })
  ctx.provide('typert', { register: () => () => undefined })
  ctx.provide('storageDomain', {
    open: (spec: { name: string }) => {
      // The domain identity is the contract the profile wires its routes against.
      expect(spec.name).toBe('avantf_work')
      const domain: Domain = { closed: false }
      domains.push(domain)
      const handle = {
        table: () => ({
          get: (id: string) => records.get(id),
          entries: () => records.entries(),
          put: (id: string, value: unknown) => {
            records.set(id, value)
            return Promise.resolve()
          },
          delete: (id: string) => Promise.resolve(records.delete(id)),
          get size() {
            return records.size
          },
        }),
        close: () => {
          domain.closed = true
          return Promise.resolve()
        },
      }
      // `holdOpen` and `failOpen` both defer the outcome to the case, which is what
      // makes "the outcome lands AFTER the unmount" orderable: an immediately settled
      // promise would be decided while the fiber is still alive, which is the ordinary
      // failure path and not what this spec is about.
      if (options.holdOpen !== true && options.failOpen !== true) return Promise.resolve(handle)
      return new Promise((resolve, reject) => {
        releases.push(() => {
          if (options.failOpen === true) reject(new Error('storage backend is closed'))
          // The stub medium is intentionally smaller than the real domain handle;
          // the plugin only reaches the table and close.
          else resolve(handle as never)
        })
      })
    },
  })
  // The sweep rides `ctx.interval`, so a flagged call is how "a live engine was
  // armed" becomes observable without waiting out a 60 s timer.
  ctx.provide('timer', {
    interval: () => {
      armed.value = true
      return () => undefined
    },
  })
  ctx.mixin('timer', ['interval'])

  return { ctx, domains, releases, sweepArmed: () => armed.value }
}

/** The surface a case needs to drive one mount, including the fiber it owns. */
interface Mount extends Harness {
  /** The plugin's own fiber: disposing it is the unmount under test. */
  app: { dispose: () => Promise<void> }
  host: AvantfWorkHost
}

/**
 * Mount the real plugin under an enclosing app fiber, with `open()` still in flight.
 *
 * The enclosing fiber is not decoration: dsh mounts each loader entry as a fiber, and
 * disposing THAT fiber is the unmount this spec is about. The plugin is mounted from
 * inside it so its `ctx` is the fiber-scoped context `apply` really sees.
 */
async function mountHeld(options: { holdOpen?: boolean; failOpen?: boolean } = { holdOpen: true }): Promise<Mount> {
  const harness = stubContext(options)
  const app = await harness.ctx.plugin(async (ctx: Context) => {
    await ctx.plugin({ name, inject, apply }, {})
  })
  const host = harness.ctx.get('avantfWork') as unknown as AvantfWorkHost
  expect(host).toBeDefined()
  // `apply` kicked `start()` off without awaiting it — the boot does not wait for
  // open(), which is the whole reason a fast unmount lands inside it.
  expect(harness.domains).toHaveLength(1)
  return { ...harness, app, host }
}

describe('start-up that outlives its fiber', () => {
  it('aborts cleanly when the fiber was disposed mid-open, closing the domain it acquired', async () => {
    const mount = await mountHeld()
    const { host, domains, releases, sweepArmed } = mount

    // The unmount. Cordis clears the plugin fiber's uid before this resolves, which is
    // the state `open()` wakes up into.
    await mount.app.dispose()

    // Release the storage open the plugin is still waiting on.
    for (const release of releases.splice(0)) release()

    // 1. No rejection. In a live profile this promise is unhandled, so a rejection
    //    here is dsh's `fatal load failure`.
    await expect(host.whenReady()).resolves.toBeUndefined()

    // 2. The domain acquired by THIS open is closed. `stop()` ran before
    //    `this.domain` was assigned, so without the abort path the handle leaks and
    //    the `avantf_work` name stays reserved for the process lifetime.
    expect(domains[0]?.closed).toBe(true)

    // 3. Nothing was armed for a tree that no longer exists: a live sweep would read
    //    `ctx.agents` and `ctx.interval` on the dead fiber.
    expect(sweepArmed()).toBe(false)
  })

  it('absorbs an open that fails after the unmount instead of failing the process', async () => {
    // The storage open rejects after the unmount (a unit closed under an in-flight
    // open). The rejection lands before the guard can be reached, so it has to be
    // handled where the promise is created — inside `start()`.
    const mount = await mountHeld({ failOpen: true })
    const lines: string[] = []
    const realError = console.error.bind(console)
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); realError(...args) }
    try {
      await mount.app.dispose()
      for (const release of mount.releases.splice(0)) release()
      await expect(mount.host.whenReady()).resolves.toBeUndefined()
      // Reported, not silent: an open that failed for some OTHER reason must stay
      // visible even when the plugin is on its way out.
      expect(lines.join('\n')).toContain('start-up did not finish before unmount')
      expect(lines.join('\n')).toContain('storage backend is closed')
    } finally {
      console.error = realError
    }
  })
})
